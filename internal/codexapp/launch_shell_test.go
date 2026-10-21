package codexapp

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/shell"
)

// TestMain lets this test binary stand in for Codex: a `codex` symlink to it
// (see launcherRun) is the fake the launchers start.
func TestMain(m *testing.M) {
	if filepath.Base(os.Args[0]) == "codex" {
		if len(os.Args) == 2 && os.Args[1] == "app-server" {
			fakeStdioCodex()
			return
		}
		fakeCodex()
		return
	}
	os.Exit(m.Run())
}

// fakeCodex is `codex app-server … --listen unix://<sock>`: it listens, then
// reports what it was started with and sees, to $PROBE_OUT (written last, so
// its existence means the socket answers).
func fakeCodex() {
	var sock string
	for i, a := range os.Args {
		if a == "--listen" && i+1 < len(os.Args) {
			sock = strings.TrimPrefix(os.Args[i+1], "unix://")
		}
	}
	ln, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake codex:", err)
		os.Exit(2)
	}
	dump := "pid=" + strconv.Itoa(os.Getpid()) + "\n" +
		"ppid=" + strconv.Itoa(os.Getppid()) + "\n" +
		"marker=" + os.Getenv(MarkerVar) + "\n" +
		"via=" + os.Getenv("H3D_VIA") + "\n" +
		"pane=" + os.Getenv("HERDR_PANE_ID") + "\n" +
		"export=" + os.Getenv("H3D_PANE_SENTINEL") + "\n" +
		"codex_home=" + os.Getenv("CODEX_HOME") + "\n" +
		"path=" + os.Getenv("PATH") + "\n" +
		"args=" + strings.Join(os.Args[1:], "\x1f") + "\n"
	tmp := os.Getenv("PROBE_OUT") + ".tmp"
	if err := os.WriteFile(tmp, []byte(dump), 0o600); err != nil || os.Rename(tmp, os.Getenv("PROBE_OUT")) != nil {
		os.Exit(3)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		c.Close()
	}
}

func requireBash(t *testing.T) string {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not installed")
	}
	abs, _ := filepath.Abs(bash)
	return abs
}

// launched is one launcher run as the bridge runs it: `setsid -f <shell>
// <launcher>` with only the pane's exported environment.
type launched struct {
	l       Launch
	dir     string
	probe   map[string]string
	fishLog string
}

type launcherSetup struct {
	shell    shell.Kind
	bashrc   string            // ~/.bashrc of the test HOME
	fishrc   string            // $XDG_CONFIG_HOME/fish/config.fish
	fishDir  string            // directory with a real fish, on PATH (fish policy)
	extraEnv map[string]string // the pane's other exports
	env      []string          // #139: the launch's own (Launch.Env)
}

// runLauncher writes the launch's launcher and runs it under an isolated
// PATH (a fake codex, a fake fish that records an invocation and fails) and
// a test HOME, then waits for the fake codex to be listening.
func runLauncher(t *testing.T, su launcherSetup) launched {
	t.Helper()
	setsid, err := exec.LookPath("setsid")
	if err != nil {
		t.Skip("setsid is not installed")
	}
	root, err := os.MkdirTemp("", "cxs-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	home, bin := filepath.Join(root, "home"), filepath.Join(root, "bin")
	for _, d := range []string{home, bin, filepath.Join(home, ".config", "fish")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(self, filepath.Join(bin, "codex")); err != nil {
		t.Fatal(err)
	}
	fishLog := filepath.Join(root, "fish-invoked")
	if su.shell != shell.Fish {
		// Nothing may start fish: the fake one records and fails.
		fake := "#!/bin/sh\necho invoked >>" + fishLog + "\nexit 99\n"
		if err := os.WriteFile(filepath.Join(bin, "fish"), []byte(fake), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if su.bashrc != "" {
		if err := os.WriteFile(filepath.Join(home, ".bashrc"), []byte(su.bashrc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if su.fishrc != "" {
		if err := os.WriteFile(filepath.Join(home, ".config", "fish", "config.fish"), []byte(su.fishrc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	l, err := NewLaunchFor(su.shell, filepath.Join(root, "run"), "a58752ea6511", "/home/u/repo")
	if err != nil {
		t.Fatal(err)
	}
	l.Env = su.env
	if err := l.Write(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { Stop(l, time.Second) })

	probe := filepath.Join(root, "probe")
	path := bin
	if su.fishDir != "" {
		path += ":" + su.fishDir
	}
	env := []string{"HOME=" + home, "PATH=" + path, "PROBE_OUT=" + probe, "HERDR_PANE_ID=w1:p1",
		"H3D_PANE_SENTINEL=pane-export", "XDG_CONFIG_HOME=" + filepath.Join(home, ".config"),
		MarkerVar + "=stale-inherited-marker", "SHELL=/usr/bin/fish"}
	for k, v := range su.extraEnv {
		env = append(env, k+"="+v)
	}
	var argv []string
	if su.shell == shell.Fish {
		if su.fishDir == "" {
			t.Skip("fish is not installed")
		}
		argv = []string{"-f", "fish", l.Script()} // as typed into the pane: `setsid -f fish <launcher>`
	} else {
		argv = []string{"-f", requireBash(t), l.Script()}
	}
	cmd := exec.Command(setsid, argv...)
	cmd.Env = env // stdin, stdout and stderr are /dev/null, as the typed command redirects them
	if err := cmd.Run(); err != nil {
		t.Fatalf("setsid: %v", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		if _, err := os.Stat(probe); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fake codex never listened (log %q)", readFile(l.Log()))
		}
		time.Sleep(25 * time.Millisecond)
	}
	got := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(readFile(probe)))
	for sc.Scan() {
		k, v, _ := strings.Cut(sc.Text(), "=")
		got[k] = v
	}
	return launched{l: l, dir: root, probe: got, fishLog: fishLog}
}

func readFile(p string) string {
	b, _ := os.ReadFile(p)
	return string(b)
}

// sessionOf is /proc/<pid>/stat field 6.
func sessionOf(t *testing.T, pid int) int {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(raw[strings.LastIndexByte(string(raw), ')')+1:]))
	sid, _ := strconv.Atoi(f[3])
	return sid
}

const bashGuard = "[[ $- != *i* ]] && return\n"

// A plain launcher run (no startup files) works with fish absent: the
// marker, pid, socket, the pane's exports and a detached lifetime.
func TestBashLauncherOwnership(t *testing.T) {
	r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: bashGuard})
	l := r.l

	if _, err := os.Stat(r.fishLog); err == nil {
		t.Fatal("bash policy invoked fish")
	}
	if r.probe["marker"] != l.Token {
		t.Fatalf("codex ownership marker = %q, want the launch token (an inherited marker must not win)", r.probe["marker"])
	}
	if r.probe["pane"] != "w1:p1" || r.probe["export"] != "pane-export" || !strings.HasPrefix(r.probe["path"], filepath.Join(r.dir, "bin")) {
		t.Fatalf("the pane's exports did not reach the server: %v", r.probe)
	}
	for _, want := range []string{"app-server", "-c", `projects={"/home/u/repo"={trust_level="trusted"}}`, "features.instant_interrupt=false",
		"--listen", "unix://" + l.Socket()} {
		if !strings.Contains(r.probe["args"], want) {
			t.Errorf("codex args %q lack %q", r.probe["args"], want)
		}
	}
	// The pid file holds the launcher process: a live process of this user
	// whose own environment carries the marker, leading its own session.
	pid, err := strconv.Atoi(strings.TrimSpace(readFile(l.PIDFile())))
	if err != nil || pid <= 1 {
		t.Fatalf("pid file = %q", readFile(l.PIDFile()))
	}
	if !alive(pid) || !marked(pid, l.Token) {
		t.Fatalf("pid %d is not a live process carrying the marker", pid)
	}
	if sid := sessionOf(t, pid); sid != pid {
		t.Fatalf("launcher pid %d is in session %d: not detached (setsid)", pid, sid)
	}
	// The server is found as the codex process; stopping the launch ends it.
	s, err := FindServer(l)
	if err != nil {
		t.Fatal(err)
	}
	if want, _ := strconv.Atoi(r.probe["pid"]); s.PID != want {
		t.Fatalf("FindServer = pid %d, want the codex process %d", s.PID, want)
	}
	if c, err := net.Dial("unix", l.Socket()); err != nil {
		t.Fatalf("socket: %v", err)
	} else {
		c.Close()
	}
	if left := Stop(l, 2*time.Second); len(left) != 0 {
		t.Fatalf("survivors %v", left)
	}
	if err := l.Remove(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{l.Script(), l.PIDFile(), l.Socket(), l.Log()} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s kept", p)
		}
	}
	if strings.TrimSpace(readFile(l.Log())) != "" {
		t.Errorf("interactive-shell noise reached the log: %q", readFile(l.Log()))
	}
}

// The user's `codex` function in ~/.bashrc applies to the server launch, as
// the pane's own shell would apply it, behind the usual interactive guard.
func TestBashLauncherAppliesCodexFunction(t *testing.T) {
	sentinel := filepath.Join(t.TempDir(), "function-ran")
	rc := bashGuard + "echo noise from bashrc\n" +
		"codex() { echo ran >" + sentinel + "; H3D_VIA=function command codex \"$@\"; }\n"
	r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: rc})
	if readFile(sentinel) != "ran\n" || r.probe["via"] != "function" {
		t.Fatalf("the .bashrc codex function did not run: sentinel %q, via %q", readFile(sentinel), r.probe["via"])
	}
	// The function is a child of the launcher (not exec'd away): the marked
	// supervisor is the pid file's and the codex process is another.
	pid, _ := strconv.Atoi(strings.TrimSpace(readFile(r.l.PIDFile())))
	cpid, _ := strconv.Atoi(r.probe["pid"])
	if pid == cpid || !marked(pid, r.l.Token) || !marked(cpid, r.l.Token) {
		t.Fatalf("supervisor %d / codex %d not both marked and distinct", pid, cpid)
	}
	if s, err := FindServer(r.l); err != nil || s.PID != cpid {
		t.Fatalf("FindServer = %+v, %v; want the codex process %d, not the launcher", s, err, cpid)
	}
	if left := Stop(r.l, 2*time.Second); len(left) != 0 {
		t.Fatalf("survivors %v", left)
	}
	time.Sleep(200 * time.Millisecond)
	if alive(pid) {
		t.Errorf("the launcher outlived its server")
	}
}

// An alias works too (aliases expand in the interactive launcher), and a
// bashrc exec'ing codex through a function keeps the pid contract.
func TestBashLauncherAppliesAlias(t *testing.T) {
	r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: bashGuard + "alias codex='H3D_VIA=alias command codex'\n"})
	if r.probe["via"] != "alias" {
		t.Fatalf("the .bashrc codex alias did not apply: via %q", r.probe["via"])
	}
}

func TestBashLauncherExecFunctionKeepsPID(t *testing.T) {
	r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: bashGuard + "codex() { H3D_VIA=exec exec codex \"$@\"; }\n"})
	pid, _ := strconv.Atoi(strings.TrimSpace(readFile(r.l.PIDFile())))
	if want, _ := strconv.Atoi(r.probe["pid"]); pid != want || r.probe["via"] != "exec" || !marked(pid, r.l.Token) {
		t.Fatalf("pid file %d, codex %s, via %q", pid, r.probe["pid"], r.probe["via"])
	}
}

// A history-writing bashrc must not rewrite the user's history file.
func TestBashLauncherLeavesHistoryAlone(t *testing.T) {
	hist := filepath.Join(t.TempDir(), "hist")
	if err := os.WriteFile(hist, []byte("keep me\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: bashGuard + "HISTFILE=" + hist + "\nshopt -s histappend\ncodex() { command codex \"$@\"; }\n"})
	Stop(r.l, 2*time.Second)
	time.Sleep(300 * time.Millisecond)
	if got := readFile(hist); got != "keep me\n" {
		t.Fatalf("history file rewritten: %q", got)
	}
}

// The launcher survives odd characters in the run directory: quoting holds
// from the pid file to the log (the bridge's own validation refuses such a
// directory earlier; this is the launcher's defence in depth).
func TestBashLauncherQuotesRunDirectory(t *testing.T) {
	bash := requireBash(t)
	root := t.TempDir()
	dir := filepath.Join(root, `a'b "c" $d `+"`e`"+` \f !g`)
	l, err := NewLaunchFor(shell.Bash, dir, "a58752ea6511", "/r")
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Write(); err != nil {
		t.Fatal(err)
	}
	// Run the launcher with a stand-in codex that records its --listen.
	bin := filepath.Join(root, "bin")
	_ = os.MkdirAll(bin, 0o755)
	out := filepath.Join(root, "out")
	stub := "#!/bin/sh\nprintf '%s\\n' \"$@\" >" + out + "\n"
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bash, l.Script())
	cmd.Env = []string{"HOME=" + root, "PATH=" + bin + ":/usr/bin:/bin"}
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("launcher: %v: %s", err, b)
	}
	if got := readFile(out); !strings.Contains(got, "unix://"+l.Socket()+"\n") {
		t.Fatalf("codex was not given the socket path intact:\n%s\nwant %s", got, l.Socket())
	}
	if got := strings.TrimSpace(readFile(l.PIDFile())); got == "" {
		t.Fatal("pid file not written at its quoted path")
	}
	if _, err := os.Stat(l.Log()); err != nil {
		t.Fatalf("log not created at its quoted path: %v", err)
	}
}

// The fish compatibility path: the same wrapper contract through fish's own
// startup file, behind the explicit option.
func TestFishLauncherAppliesWrapper(t *testing.T) {
	fish, err := exec.LookPath("fish")
	if err != nil {
		t.Skip("fish is not installed")
	}
	sentinel := filepath.Join(t.TempDir(), "function-ran")
	rc := "function codex\n  echo ran >" + sentinel + "\n  H3D_VIA=function command codex $argv\nend\n"
	r := runLauncher(t, launcherSetup{shell: shell.Fish, fishrc: rc, fishDir: filepath.Dir(fish)})
	if readFile(sentinel) != "ran\n" || r.probe["via"] != "function" {
		t.Fatalf("config.fish codex function did not run: sentinel %q via %q", readFile(sentinel), r.probe["via"])
	}
	if r.probe["marker"] != r.l.Token {
		t.Fatalf("marker = %q", r.probe["marker"])
	}
	if filepath.Ext(r.l.Script()) != ".fish" {
		t.Fatalf("fish launcher %s", r.l.Script())
	}
	if left := Stop(r.l, 2*time.Second); len(left) != 0 {
		t.Fatalf("survivors %v", left)
	}
}

// #139: a worker on a Codex profile: the launch's CODEX_HOME reaches the
// server over the pane's and over one ~/.bashrc (or config.fish) sets, and a
// launch without one leaves the pane's as it is.
func TestLauncherCodexHome(t *testing.T) {
	const profile = "/home/u/.codex-it's work"
	pane := map[string]string{"CODEX_HOME": "/home/u/.codex"}
	r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: "export CODEX_HOME=/from/bashrc\n" + bashGuard, extraEnv: pane,
		env: []string{"CODEX_HOME=" + profile}})
	if r.probe["codex_home"] != profile {
		t.Fatalf("bash: CODEX_HOME = %q, want %q", r.probe["codex_home"], profile)
	}
	if r := runLauncher(t, launcherSetup{shell: shell.Bash, bashrc: bashGuard, extraEnv: pane}); r.probe["codex_home"] != "/home/u/.codex" {
		t.Fatalf("bash without a profile: CODEX_HOME = %q", r.probe["codex_home"])
	}
	fish, err := exec.LookPath("fish")
	if err != nil {
		t.Skip("fish is not installed")
	}
	r = runLauncher(t, launcherSetup{shell: shell.Fish, fishrc: "set -gx CODEX_HOME /from/config.fish\n", fishDir: filepath.Dir(fish),
		extraEnv: pane, env: []string{"CODEX_HOME=" + profile}})
	if r.probe["codex_home"] != profile {
		t.Fatalf("fish: CODEX_HOME = %q, want %q", r.probe["codex_home"], profile)
	}
}

// Cleanup after a bridge upgrade: a launch v1.45.0 recorded has a .fish
// launcher, which a bash-default Launch (it is rebuilt from the stored
// record, without a shell) still removes, and so does a fish Launch the .sh.
func TestRemoveCleansEitherLauncherFormat(t *testing.T) {
	for _, tc := range []struct {
		name         string
		wrote, clean shell.Kind
	}{{"v1.45.0 fish launch, bash bridge", shell.Fish, shell.Bash}, {"bash launch, fish bridge", shell.Bash, shell.Fish},
		{"unset shell of a stored record", shell.Fish, ""}} {
		t.Run(tc.name, func(t *testing.T) {
			l := testLaunch(t)
			l.Shell = tc.wrote
			if err := l.Write(); err != nil {
				t.Fatal(err)
			}
			for _, p := range []string{l.PIDFile(), l.Log()} {
				_ = os.WriteFile(p, []byte("1\n"), 0o600)
			}
			stored := Launch{Dir: l.Dir, Name: l.Name, Token: l.Token, Cwd: l.Cwd, Shell: tc.clean}
			if err := stored.Remove(); err != nil {
				t.Fatal(err)
			}
			for _, p := range []string{l.Script(), l.PIDFile(), l.Log()} {
				if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("%s kept", p)
				}
			}
		})
	}
}

// Write replaces what an earlier launch of the same name left, in any format.
func TestWriteReplacesTheOtherFormat(t *testing.T) {
	l := testLaunch(t)
	l.Shell = shell.Fish
	if err := l.Write(); err != nil {
		t.Fatal(err)
	}
	old := l.Script()
	l.Shell = shell.Bash
	if err := l.Write(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale %s kept next to the new launcher", old)
	}
	if st, err := os.Stat(l.Script()); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("launcher: %v %v", st, err)
	}
}
