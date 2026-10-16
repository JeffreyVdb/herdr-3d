//go:build integration

// Integration fixture for #154: the real Codex TUI (a VerifiedCodex) in an
// isolated named Herdr session, a second app-server client, mock inference.
// Nothing here touches ~/.codex, the user's Herdr sessions or the shared
// daemon: every Codex runs with a throwaway CODEX_HOME, every Herdr call
// names the throwaway session, and every port is OS-leased on 127.0.0.1.
// Run with `make codex-shared-tui`. With H3D_CODEXSHARE_EVIDENCE=<dir> the
// screens and protocol messages the tests capture are written there.
package codexshare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/shell"
)

// ShellVar selects the shell policy the fixture's panes, Control and
// launchers run under: bash (the default) or fish (the explicit
// compatibility option, skipped when fish is not installed).
const ShellVar = "H3D_CODEXSHARE_SHELL"

// fixtureShell is the policy under test; it skips the test when its shell is
// not installed (never a failure, never the other shell).
func fixtureShell(t *testing.T) shell.Kind {
	t.Helper()
	kind, err := shell.Parse(os.Getenv(ShellVar))
	if err != nil {
		t.Fatalf("$%s: %v", ShellVar, err)
	}
	if _, err := shell.Resolve(kind); err != nil {
		t.Skipf("%s policy: %v", kind, err)
	}
	return kind
}

func TestMain(m *testing.M) {
	// The test binary stands in for the env-dump MCP server Codex starts.
	if dir := os.Getenv(EnvDumpVar); dir != "" {
		if err := ServeEnvDump(dir, os.Stdin, os.Stdout); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// fx is one test's world: a temp root, an isolated CODEX_HOME, the mock,
// the panes' shell configuration, workspaces and a throwaway Herdr session.
type fx struct {
	t      *testing.T
	sh     shell.Kind // the shell policy under test (ShellVar)
	ctx    context.Context
	codex  string // `codex --version`, one of VerifiedCodex
	root   string
	owner  string // OwnerVar's value in every process the fixture starts
	home   string
	xdg    string // XDG_CONFIG_HOME of the panes: the fixture's fish config
	shHome string // HOME of bash panes: the fixture's .bashrc
	data   string // XDG_DATA_HOME of the panes: direnv's allow list
	mcpDir string
	mock   *Mock
	h      *Herdr
	ev     string // evidence dir, "" when not recording
	marks  map[*Client]int
	n      int
}

type fxOptions struct {
	approval string
	sandbox  string
	top      string
	extra    string
	noMCP    bool
}

// requireTools skips without the fixture's tools or on a Codex the fixture
// is not verified with, and returns `codex --version` ("codex-cli 0.161.0").
func requireTools(t *testing.T) string {
	t.Helper()
	for _, bin := range []string{"codex", "herdr", "direnv", "setsid"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s is not installed", bin)
		}
	}
	out, err := exec.Command("codex", "--version").Output()
	if err != nil {
		t.Skipf("codex --version: %v", err)
	}
	if err := CheckFixtureCodex(string(out)); err != nil {
		t.Skipf("UNVERIFIED CODEX, not a pass: %v", err)
	}
	t.Logf("fixture codex: %s", strings.TrimSpace(string(out)))
	return strings.TrimSpace(string(out))
}

func newFx(t *testing.T, o fxOptions, workspaces ...string) *fx {
	codex := requireTools(t)
	sh := fixtureShell(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	t.Cleanup(cancel)
	// A short root: unix socket paths are limited to 108 bytes.
	root, err := os.MkdirTemp("", "h3d154-")
	if err != nil {
		t.Fatal(err)
	}
	f := &fx{t: t, sh: sh, ctx: ctx, codex: codex, root: root, owner: NewOwner(), home: filepath.Join(root, "home"), xdg: filepath.Join(root, "xdg"),
		data: filepath.Join(root, "data"), mcpDir: filepath.Join(root, "mcp")}
	t.Cleanup(func() {
		f.killOwned()
		_ = os.RemoveAll(root)
	})
	if dir := os.Getenv("H3D_CODEXSHARE_EVIDENCE"); dir != "" {
		f.ev = filepath.Join(dir, t.Name())
		_ = os.RemoveAll(f.ev)
		if err := os.MkdirAll(f.ev, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.shHome = filepath.Join(root, "shhome")
	for _, d := range []string{f.home, f.shHome, filepath.Join(f.xdg, "fish"), f.data, f.mcpDir, filepath.Join(root, "bin")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	f.mock, err = StartMock()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.mock.Close)
	// Model-like latency: Herdr reports a turn only once it saw it working.
	f.mock.SetDelay(1500 * time.Millisecond)

	// The panes' shell configuration: PATH gets the fixture's tool, an
	// exported config sentinel, direnv's hook (interactive, like the user's
	// config), a `codex` wrapper function that exports a sentinel (like a
	// real credential wrapper) and a shell-only function. Fish and bash get
	// the same, each in its own startup file.
	bashrc := strings.Join([]string{
		"[[ $- != *i* ]] && return",
		"export PATH=" + filepath.Join(root, "bin") + ":$PATH",
		"export H3D_SHELL_SENTINEL=shell-config",
		`eval "$(direnv hook bash)"`,
		`codex() { H3D_WRAPPER_SENTINEL=wrapper command codex "$@"; }`,
		"h3d_shell_fn() { echo shell-function-ran; }",
		`PS1='$ '`,
		"",
	}, "\n")
	f.write(filepath.Join(f.shHome, ".bashrc"), bashrc, 0o644)
	fish := strings.Join([]string{
		"set -g fish_greeting",
		"fish_add_path -g " + filepath.Join(root, "bin"),
		"set -gx H3D_SHELL_SENTINEL shell-config",
		"if status is-interactive",
		"    direnv hook fish | source",
		"end",
		"function codex --wraps codex",
		"    set -lx H3D_WRAPPER_SENTINEL wrapper",
		"    command codex $argv",
		"end",
		"function h3d_shell_fn",
		"    echo shell-function-ran",
		"end",
		"",
	}, "\n")
	f.write(filepath.Join(f.xdg, "fish", "config.fish"), fish, 0o644)
	f.write(filepath.Join(root, "bin", "h3d-tool"), "#!/bin/sh\necho \"h3d-tool:$0:direnv=$H3D_DIRENV_SENTINEL\"\n", 0o755)

	// A user skill, to check skills reach the model through the shared server.
	skill := filepath.Join(f.home, "skills", "h3d-fixture")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	f.write(filepath.Join(skill, "SKILL.md"), "---\nname: h3d-fixture\ndescription: Fixture skill for the #154 shared TUI checks.\n---\n\nH3D_SKILL_BODY: follow the fixture.\n", 0o644)

	var trusted []string
	for _, ws := range workspaces {
		trusted = append(trusted, f.workspace(ws))
	}
	extra := o.extra
	if !o.noMCP {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		extra += "\n[mcp_servers.envdump]\ncommand = " + TOMLString(exe) + "\n" +
			"env_vars = [\"H3D_DIRENV_SENTINEL\", \"H3D_PANE_SENTINEL\", \"H3D_WRAPPER_SENTINEL\", \"H3D_SHELL_SENTINEL\", \"HERDR_PANE_ID\", \"" + OwnerVar + "\"]\n" +
			"startup_timeout_sec = 20\n" +
			"[mcp_servers.envdump.env]\n" + EnvDumpVar + " = " + TOMLString(f.mcpDir) + "\n"
	}
	if err := WriteHome(f.home, HomeOptions{MockURL: f.mock.URL(), Trusted: trusted, ApprovalPolicy: o.approval, Sandbox: o.sandbox, Top: o.top, Extra: extra}); err != nil {
		t.Fatal(err)
	}
	// The session server's environment reaches its panes, so the marker
	// reaches everything they run: TUIs, app-servers, daemons, tools.
	set := []string{"CODEX_HOME=" + f.home, OwnerVar + "=" + f.owner}
	if sh == shell.Bash {
		set = append(set, "HOME="+f.shHome) // bash reads ~/.bashrc; fish reads XDG_CONFIG_HOME
	}
	f.h, err = StartHerdr(ctx, root, sh, os.Environ(), set...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.h.Close)
	t.Logf("herdr session %s, root %s, mock %s", f.h.Name, root, f.mock.URL())
	return f
}

func (f *fx) write(path, content string, mode os.FileMode) {
	f.t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		f.t.Fatal(err)
	}
}

// workspace makes root/<name> with a .envrc exporting a per-workspace
// sentinel. Names starting "blocked" are left unallowed; others are allowed
// in the fixture's own direnv allow list (XDG_DATA_HOME). Names starting
// "bare" get no .envrc (#158: the bridge's own preflight reads the user's
// allow list, not the fixture's).
func (f *fx) workspace(name string) string {
	f.t.Helper()
	dir := filepath.Join(f.root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		f.t.Fatal(err)
	}
	if strings.HasPrefix(name, "bare") {
		return dir
	}
	f.write(filepath.Join(dir, ".envrc"), "export H3D_DIRENV_SENTINEL=direnv-"+name+"\n", 0o644)
	if !strings.HasPrefix(name, "blocked") {
		cmd := exec.Command("direnv", "allow", dir)
		cmd.Env = CleanEnv(os.Environ(), "XDG_DATA_HOME="+f.data, "XDG_CONFIG_HOME="+f.xdg)
		if out, err := cmd.CombinedOutput(); err != nil {
			f.t.Fatalf("direnv allow: %v: %s", err, out)
		}
	}
	return dir
}

// paneEnv is what a fixture workspace's shell gets from Herdr.
func (f *fx) paneEnv(ws string) []string {
	return []string{"CODEX_HOME=" + f.home, "XDG_CONFIG_HOME=" + f.xdg, "XDG_DATA_HOME=" + f.data, "H3D_PANE_SENTINEL=pane-" + ws}
}

// pane creates a Herdr workspace in root/<ws> and waits for its shell prompt
// (and direnv's first export).
func (f *fx) pane(ws string) string {
	f.t.Helper()
	pane, err := f.h.CreateWorkspace(f.ctx, filepath.Join(f.root, ws), ws, f.paneEnv(ws)...)
	if err != nil {
		f.t.Fatal(err)
	}
	f.shell(pane, "true")
	return pane
}

// shell runs a command line in an idle pane and waits until it has
// finished: it prints a marker the typed command line itself does not
// contain (wait-output also sees the echoed command).
func (f *fx) shell(pane, command string) {
	f.t.Helper()
	f.n++
	id := strconv.Itoa(f.n)
	if err := f.h.PaneRun(f.ctx, pane, command+"; printf '%s-%s\\n' H3DDONE "+id); err != nil {
		f.t.Fatal(err)
	}
	if err := f.h.WaitOutput(f.ctx, pane, "H3DDONE-"+id, 60*time.Second); err != nil {
		screen, _ := f.h.Read(f.ctx, pane, "recent-unwrapped", 40)
		f.t.Fatalf("waiting for %q: %v\n%s", command, err, screen)
	}
}

// startServer starts a worker-owned app-server from the pane's initialized
// shell (the candidate launcher): a detached session leader running the
// policy's shell (bash -i, as codexapp.Launch does, or fish) so the `codex`
// wrapper function applies, listening on root/<name>.sock.
func (f *fx) startServer(pane, name string) string {
	f.t.Helper()
	sock := filepath.Join(f.root, name+".sock")
	log := filepath.Join(f.root, name+".log")
	// The production launch's feature override (codexapp.Launch.Render),
	// after --listen so f.owned's "app-server --listen unix://…" matches.
	if f.sh == shell.Fish {
		f.shell(pane, fmt.Sprintf("setsid -f fish -c 'codex app-server --listen unix://%s -c %s' </dev/null >%s 2>&1", sock, codexapp.ServerFeatures, log))
	} else {
		bash, err := shell.Resolve(shell.Bash)
		if err != nil {
			f.t.Fatal(err)
		}
		// The quotes inside stay in the supervisor's command line, so only the
		// codex process matches "app-server --listen unix://…" (as in the launcher).
		f.shell(pane, fmt.Sprintf(`setsid -f %s -i +H -c "codex app-server --listen 'unix://%s' -c '%s'" </dev/null >%s 2>&1`, bash, sock, codexapp.ServerFeatures, log))
	}
	f.waitSocket(sock)
	return sock
}

func (f *fx) waitSocket(sock string) {
	f.t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := Dial(f.ctx, sock); err == nil {
			c.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	f.t.Fatalf("app-server socket %s never answered", sock)
}

// serverPID finds the app-server process listening on sock.
func (f *fx) serverPID(sock string) int {
	f.t.Helper()
	pids := f.owned("app-server --listen unix://" + sock)
	if len(pids) == 0 {
		f.t.Fatalf("no app-server process for %s", sock)
	}
	return pids[len(pids)-1]
}

// owned lists the fixture's own processes (OwnerVar=f.owner) whose command
// line contains substr ("" for all of them).
func (f *fx) owned(substr string) []int {
	return OwnedPIDs(f.owner, substr)
}

// killOwned ends every process the test left (worker-owned app-servers,
// MCP children, temp-home daemons): only those carrying its owner marker.
func (f *fx) killOwned() {
	if left := KillOwned(f.owner); len(left) != 0 {
		f.t.Errorf("processes %v survived SIGKILL", left)
	}
}

// startTUI runs the real Codex TUI in pane through `herdr agent start`.
func (f *fx) startTUI(name, pane string, args ...string) Agent {
	f.t.Helper()
	a, err := f.h.AgentStart(f.ctx, name, pane, 60*time.Second, args...)
	if err != nil {
		screen, _ := f.h.Read(f.ctx, pane, "visible", 0)
		var he *HerdrError
		if errors.As(err, &he) && (he.Code == "timeout" || he.Code == "agent_name_not_found") && strings.Contains(screen, hooksReviewText) {
			// Herdr 0.9.3 can time out on hook review. The caller's
			// trustHooks step still answers it explicitly in this test home.
			a, _, err = f.h.AgentGet(f.ctx, pane)
		}
		if err != nil {
			f.t.Fatalf("agent start: %v\n%s", err, screen)
		}
	}
	f.snap("tui-started-"+name, pane)
	return a
}

// snap records the pane's visible screen as evidence and returns it.
func (f *fx) snap(label, pane string) string {
	f.t.Helper()
	screen, err := f.h.Read(f.ctx, pane, "visible", 0)
	if err != nil {
		f.t.Logf("read %s: %v", pane, err)
	}
	f.record(label+".screen.txt", screen)
	return screen
}

// record writes one evidence file (and logs it).
func (f *fx) record(name, content string) {
	f.n++
	f.t.Logf("── %s ──\n%s", name, content)
	if f.ev != "" {
		_ = os.WriteFile(filepath.Join(f.ev, fmt.Sprintf("%02d-%s", f.n, name)), []byte(scrub(f, content)), 0o644)
	}
}

// recordJSON writes v as indented JSON evidence.
func (f *fx) recordJSON(name string, v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	f.record(name+".json", string(b))
}

// scrub replaces the run's temp root and home in evidence.
func scrub(f *fx, s string) string {
	s = strings.ReplaceAll(s, f.root, "$ROOT")
	if h, err := os.UserHomeDir(); err == nil {
		s = strings.ReplaceAll(s, h, "$HOME")
	}
	return s
}

// client is a second app-server client on sock.
func (f *fx) client(sock, name string) *Client {
	f.t.Helper()
	c, err := Dial(f.ctx, sock)
	if err != nil {
		f.t.Fatal(err)
	}
	if _, err := c.Initialize(f.ctx, name); err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(c.Close)
	return c
}

// within returns a context bounded by d.
func (f *fx) within(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(f.ctx, d)
}

// waitScreen polls the visible screen until ok, recording it as label.
func (f *fx) waitScreen(label, pane string, d time.Duration, ok func(string) bool) string {
	f.t.Helper()
	deadline := time.Now().Add(d)
	var screen string
	for {
		screen, _ = f.h.Read(f.ctx, pane, "visible", 0)
		if ok(screen) || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	f.record(label+".screen.txt", screen)
	if !ok(screen) {
		f.t.Fatalf("screen %s never matched", label)
	}
	return screen
}
