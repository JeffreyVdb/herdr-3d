//go:build integration

package codexshare

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// probeCmd is the harmless command the mock has the model run: it prints
// the fixture's sentinels as the execution host sees them.
const probeCmd = `printf 'H3DENV direnv=%s pane=%s wrapper=%s fish=%s herdrpane=%s cwd=%s tool=%s fishfn=%s\n' ` +
	`"$H3D_DIRENV_SENTINEL" "$H3D_PANE_SENTINEL" "$H3D_WRAPPER_SENTINEL" "$H3D_FISH_SENTINEL" "$HERDR_PANE_ID" "$PWD" ` +
	`"$(h3d-tool 2>/dev/null || echo missing)" "$(type h3d_fish_fn >/dev/null 2>&1 && echo yes || echo no)"`

var probeRe = regexp.MustCompile(`H3DENV ([^\n\\]*)`)
var shellRe = regexp.MustCompile(`<shell>([^<]*)</shell>`)

// probe has the agent's model run probeCmd through exec_command and returns
// what it printed, plus the shell Codex told the model it uses.
func (f *fx) probe(label, agent string) map[string]string {
	f.t.Helper()
	f.settle(agent)
	n := len(f.mock.Requests())
	f.prompt(agent, "MOCK:shell "+probeCmd)
	var out map[string]string
	for _, r := range f.mock.Requests()[n:] {
		if m := probeRe.FindStringSubmatch(r.Output); r.Kind == KindTool && m != nil {
			out = map[string]string{}
			for _, kv := range strings.Fields(m[1]) {
				k, v, _ := strings.Cut(kv, "=")
				out[k] = v
			}
		}
	}
	if out == nil {
		f.t.Fatalf("%s: the probe's output never reached the model", label)
	}
	for _, r := range f.mock.Requests() {
		if m := shellRe.FindStringSubmatch(string(r.Body)); m != nil {
			out["model-shell"] = m[1]
		}
	}
	f.recordJSON("probe-"+label, out)
	return out
}

// mcpDumps returns and clears the env-dump MCP servers' records.
func (f *fx) mcpDumps(label string) []EnvDump {
	f.t.Helper()
	time.Sleep(time.Second)
	d, err := ReadEnvDumps(f.mcpDir)
	if err != nil {
		f.t.Fatal(err)
	}
	sort.Slice(d, func(i, j int) bool { return d[i].PID < d[j].PID })
	f.recordJSON("mcp-"+label, d)
	files, _ := filepath.Glob(filepath.Join(f.mcpDir, "mcp-*.json"))
	for _, p := range files {
		_ = os.Remove(p)
	}
	return d
}

// expectWorkspace checks a probe saw workspace ws's environment.
func expectWorkspace(t *testing.T, label string, p map[string]string, ws string, wrapper bool) {
	t.Helper()
	want := map[string]string{"direnv": "direnv-" + ws, "pane": "pane-" + ws, "fish": "fish-config"}
	if strings.HasPrefix(ws, "blocked") {
		want["direnv"] = ""
	}
	if wrapper {
		want["wrapper"] = "wrapper"
	}
	for k, v := range want {
		if p[k] != v {
			t.Errorf("%s: %s = %q, want %q", label, k, p[k], v)
		}
	}
	if !strings.HasSuffix(p["cwd"], "/"+ws) {
		t.Errorf("%s: cwd %q", label, p["cwd"])
	}
	if !strings.HasPrefix(p["tool"], "h3d-tool:") {
		t.Errorf("%s: h3d-tool not on the tool PATH (%q)", label, p["tool"])
	}
}

// TestCodexShareEnvironment compares where model tools and MCP children get
// their environment: today's terminal launch (Codex's embedded server), a
// worker-owned server started from the initialized pane, and the shared
// managed daemon. Sentinels: a direnv .envrc per workspace (allowed, or
// blocked), the pane's Herdr env, an exported fish config variable, the
// `codex` wrapper function's variable, and a tool on fish's PATH.
func TestCodexShareEnvironment(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a", "ws-b", "blocked-c")

	t.Run("today's herdr-3d launch runs an embedded server", func(t *testing.T) {
		pane := f.pane("ws-a")
		// internal/herdr controlShapes' Codex hire arguments.
		f.startTUI("base", pane, "-m", "mock", "-c", "model_reasoning_effort=low", "--dangerously-bypass-approvals-and-sandbox")
		p := f.probe("herdr3d-launch-ws-a", "base")
		expectWorkspace(t, "herdr-3d launch", p, "ws-a", true)
		if p["herdrpane"] != pane {
			t.Errorf("HERDR_PANE_ID %q, want %q", p["herdrpane"], pane)
		}
		if d := f.mcpDumps("herdr3d-launch"); len(d) == 0 || d[0].Env["H3D_DIRENV_SENTINEL"] != "direnv-ws-a" {
			t.Errorf("MCP child env %+v", d)
		}
		if st := f.daemonStatus(); strings.Contains(st, `"status":"running"`) {
			t.Errorf("the herdr-3d launch started the shared daemon: %s", st)
		}
		f.exitTUI(pane)
	})

	t.Run("plain codex auto-starts the shared daemon", func(t *testing.T) {
		pane := f.pane("ws-b")
		f.startTUI("plain", pane)
		p := f.probe("plain-codex-ws-b", "plain")
		st := f.daemonStatus()
		if !strings.Contains(st, `"status":"running"`) {
			t.Errorf("plain codex did not start the daemon: %s", st)
		}
		pid := f.daemonPID()
		f.recordJSON("plain-codex-daemon-process-env", map[string]any{"pid": pid, "env": ProcEnv(pid, "H3D_DIRENV_SENTINEL", "H3D_PANE_SENTINEL", "H3D_WRAPPER_SENTINEL", "HERDR_PANE_ID")})
		expectWorkspace(t, "plain codex (daemon it started)", p, "ws-b", true)
		f.mcpDumps("plain-codex")
		f.exitTUI(pane)
		time.Sleep(time.Second)
		f.record("daemon-after-plain-tui-exit.txt", f.daemonStatus())
		f.daemonStop()
	})

	t.Run("worker-owned servers from each pane, concurrently", func(t *testing.T) {
		panes := map[string]string{}
		for _, ws := range []string{"ws-a", "ws-b", "blocked-c"} {
			pane := f.pane(ws)
			panes[ws] = pane
			if strings.HasPrefix(ws, "blocked") {
				// How a blocked .envrc surfaces: only direnv's line at the prompt.
				out, _ := f.h.Read(f.ctx, pane, "recent-unwrapped", 20)
				f.record("blocked-pane-before-launch.txt", out)
			}
			// The candidate launch: the server from this pane's
			// initialized shell, then the TUI in the same pane.
			sock := f.startServer(pane, "own-"+ws)
			f.startTUI("own-"+ws, pane, "--remote", "unix://"+sock, "-C", filepath.Join(f.root, ws))
		}
		f.snap("blocked-pane-at-launch", panes["blocked-c"])
		if log, err := os.ReadFile(filepath.Join(f.root, "own-blocked-c.log")); err == nil {
			f.record("blocked-server-log.txt", string(log))
		}
		for _, ws := range []string{"ws-a", "ws-b", "blocked-c"} {
			p := f.probe("owned-"+ws, "own-"+ws)
			expectWorkspace(t, "owned "+ws, p, ws, true)
			if p["herdrpane"] != panes[ws] {
				t.Errorf("owned %s HERDR_PANE_ID %q, want %q", ws, p["herdrpane"], panes[ws])
			}
		}
		dumps := f.mcpDumps("owned")
		seen := map[string]bool{}
		for _, d := range dumps {
			seen[d.Env["H3D_PANE_SENTINEL"]+"/"+d.Env["H3D_DIRENV_SENTINEL"]] = true
		}
		for _, want := range []string{"pane-ws-a/direnv-ws-a", "pane-ws-b/direnv-ws-b", "pane-blocked-c/"} {
			if !seen[want] {
				t.Errorf("no MCP child with %s: %v", want, seen)
			}
		}

		// Restart ws-b's server from the same pane and resume the thread.
		c := f.client(filepath.Join(f.root, "own-ws-b.sock"), "h3d-env")
		th := f.tuiThread(c).ID
		c.Close()
		f.exitTUI(panes["ws-b"])
		for _, pid := range f.owned("app-server --listen unix://" + filepath.Join(f.root, "own-ws-b.sock")) {
			_ = syscall.Kill(pid, syscall.SIGTERM)
		}
		time.Sleep(time.Second)
		_ = os.Remove(filepath.Join(f.root, "own-ws-b.sock"))
		sock := f.startServer(panes["ws-b"], "own-ws-b")
		f.startTUI("own-ws-b", panes["ws-b"], "resume", th, "--remote", "unix://"+sock, "-C", filepath.Join(f.root, "ws-b"))
		p := f.probe("owned-ws-b-after-restart", "own-ws-b")
		expectWorkspace(t, "owned ws-b after restart", p, "ws-b", true)
		for _, ws := range []string{"ws-a", "ws-b", "blocked-c"} {
			f.exitTUI(panes[ws])
		}
		f.mcpDumps("owned-after-restart")
	})

	t.Run("plain setsid codex bypasses the wrapper function", func(t *testing.T) {
		pane := f.pane("ws-a")
		sock := filepath.Join(f.root, "raw-ws-a.sock")
		f.shell(pane, "setsid -f codex app-server --listen unix://"+sock+" </dev/null >"+f.root+"/raw.log 2>&1")
		f.waitSocket(sock)
		f.startTUI("raw", pane, "--remote", "unix://"+sock, "-C", filepath.Join(f.root, "ws-a"))
		p := f.probe("raw-setsid-ws-a", "raw")
		if p["wrapper"] != "" || p["direnv"] != "direnv-ws-a" {
			t.Errorf("raw setsid: wrapper %q direnv %q", p["wrapper"], p["direnv"])
		}
		f.exitTUI(pane)
		f.mcpDumps("raw")
	})

	t.Run("shared daemon started from one workspace serves both", func(t *testing.T) {
		t.Cleanup(f.daemonStop)
		paneA, paneB := f.pane("ws-a"), f.pane("ws-b")
		// Already running: whoever started it first fixed its environment.
		f.shell(paneA, "codex app-server daemon start")
		f.snap("daemon-start", paneA)
		f.startTUI("da", paneA, "--remote", "unix://", "-C", filepath.Join(f.root, "ws-a"))
		f.startTUI("db", paneB, "--remote", "unix://", "-C", filepath.Join(f.root, "ws-b"))
		pa, pb := f.probe("daemon-ws-a", "da"), f.probe("daemon-ws-b", "db")
		expectWorkspace(t, "daemon ws-a", pa, "ws-a", true)
		if pb["direnv"] != "direnv-ws-a" || pb["pane"] != "pane-ws-a" || pb["herdrpane"] != paneA || !strings.HasSuffix(pb["cwd"], "/ws-b") {
			t.Errorf("ws-b on ws-a's daemon: %v (expected ws-a's env with ws-b's cwd)", pb)
		}
		f.mcpDumps("daemon-started-from-ws-a")

		// A restart from ws-b moves every thread to ws-b's environment.
		f.exitTUI(paneB)
		f.shell(paneB, "codex app-server daemon restart")
		f.snap("daemon-restart", paneB)
		f.settle("da")
		f.snap("daemon-ws-a-tui-after-restart", paneA)
		pa = f.probe("daemon-ws-a-after-restart-from-ws-b", "da")
		if pa["direnv"] != "direnv-ws-b" || pa["pane"] != "pane-ws-b" {
			t.Errorf("ws-a after a restart from ws-b: %v", pa)
		}
		f.mcpDumps("daemon-restarted-from-ws-b")
		f.exitTUI(paneA)
	})
}

// daemon runs `codex app-server daemon <verb>` for the fixture's home only.
func (f *fx) daemon(verb string) string {
	cmd := exec.Command("codex", "app-server", "daemon", verb)
	cmd.Env = CleanEnv(os.Environ(), "CODEX_HOME="+f.home, OwnerVar+"="+f.owner)
	out, _ := cmd.CombinedOutput()
	return scrub(f, string(out))
}

func (f *fx) daemonStatus() string { return f.daemon("version") }

func (f *fx) daemonStop() { f.record("daemon-stop.txt", f.daemon("stop")) }

// daemonPID is the fixture home's managed daemon process.
func (f *fx) daemonPID() int {
	f.t.Helper()
	pids := f.owned(filepath.Join(f.home, "packages") + "/")
	for _, pid := range pids {
		raw, _ := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "cmdline"))
		if strings.Contains(string(raw), "app-server") {
			return pid
		}
	}
	f.t.Fatalf("no daemon process under %s", f.home)
	return 0
}
