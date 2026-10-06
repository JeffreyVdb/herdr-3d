package codexapp

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testLaunch(t *testing.T) Launch {
	t.Helper()
	dir, err := os.MkdirTemp("", "cxl-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	l, err := NewLaunch(filepath.Join(dir, "codex"), "a58752ea6511", "/home/u/repo")
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestLaunchScript(t *testing.T) {
	l := testLaunch(t)
	want := "# herdr-3d (#155): this worker's own Codex app-server, started from its pane.\n" +
		"set -gx H3D_CODEX_SERVER " + l.Token + "\n" +
		"echo $fish_pid >'" + l.Dir + "/a58752ea6511.pid'\n" +
		"codex app-server -c 'projects={\"/home/u/repo\"={trust_level=\"trusted\"}}' --listen 'unix://" + l.Dir +
		"/a58752ea6511.sock' </dev/null >'" + l.Dir + "/a58752ea6511.log' 2>&1\n"
	if got := l.Render(); got != want {
		t.Fatalf("script =\n%s\nwant\n%s", got, want)
	}
	for _, bad := range []Launch{
		{Dir: l.Dir, Name: l.Name, Token: l.Token, Cwd: "/r/a b"},
		{Dir: l.Dir, Name: l.Name, Token: l.Token, Cwd: "/r/a'b"},
		{Dir: l.Dir, Name: "../x", Token: l.Token, Cwd: "/r"},
		{Dir: l.Dir, Name: l.Name, Token: "short", Cwd: "/r"},
		{Dir: "rel", Name: l.Name, Token: l.Token, Cwd: "/r"},
	} {
		if bad.Valid() == nil || bad.Write() == nil {
			t.Errorf("launch %+v accepted", bad)
		}
	}
}

func TestLaunchWriteAndRemove(t *testing.T) {
	l := testLaunch(t)
	if err := os.MkdirAll(l.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(l.Socket(), nil, 0o600); err != nil { // a stale socket
		t.Fatal(err)
	}
	if err := l.Write(); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(l.Dir); st.Mode().Perm() != 0o700 {
		t.Fatalf("run dir mode %v", st.Mode().Perm())
	}
	if st, _ := os.Stat(l.Script()); st.Mode().Perm() != 0o600 {
		t.Fatalf("script mode %v", st.Mode().Perm())
	}
	if _, err := os.Stat(l.Socket()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stale socket kept")
	}
	// Codex may make the listen path a link to a socket of its own.
	target := filepath.Join(filepath.Dir(l.Dir), "real.sock")
	ln, err := net.Listen("unix", target)
	if err != nil {
		t.Fatal(err)
	}
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	ln.Close()
	if err := os.Symlink(target, l.Socket()); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{l.PIDFile(), l.Log()} {
		_ = os.WriteFile(p, []byte("x"), 0o600)
	}
	other := filepath.Join(l.Dir, "other.sock")
	_ = os.WriteFile(other, nil, 0o600)
	if err := l.Remove(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{target, l.Socket(), l.PIDFile(), l.Script(), l.Log()} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s kept", p)
		}
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("another launch's file removed")
	}
}

// spawn starts `sh -c 'sleep 30; true' <args…>` with env added, so its
// command line holds args.
func spawn(t *testing.T, env []string, args ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sh", append([]string{"-c", "sleep 30; true"}, args...)...)
	cmd.Env = append(os.Environ(), env...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }() // reaped, so a stopped one is gone from /proc
	t.Cleanup(func() { _ = cmd.Process.Kill(); <-done })
	return cmd
}

// Only processes carrying the launch's exact marker are found and stopped.
func TestStopSignalsOnlyMarkedProcesses(t *testing.T) {
	l := testLaunch(t)
	other, _ := NewLaunch(l.Dir, "b00000000001", "/r")
	server := spawn(t, []string{MarkerVar + "=" + l.Token}, "app-server", "--listen", "unix://"+l.Socket())
	child := spawn(t, []string{MarkerVar + "=" + l.Token}, "mcp")
	stranger := spawn(t, nil, "app-server", "--listen", "unix://"+l.Socket())
	near := spawn(t, []string{MarkerVar + "=" + other.Token}, "app-server", "--listen", "unix://"+l.Socket())
	prefix := spawn(t, []string{MarkerVar + "=" + l.Token + "0"}, "x")
	time.Sleep(100 * time.Millisecond)

	s, err := FindServer(l)
	if err != nil || s.PID != server.Process.Pid {
		t.Fatalf("FindServer = %+v, %v (want %d)", s, err, server.Process.Pid)
	}
	if !Alive(l, s) || Alive(l, Server{PID: s.PID, Start: s.Start + 1}) || Alive(other, s) {
		t.Fatal("Alive is wrong")
	}
	got := MarkedPIDs(l.Token, "")
	if len(got) < 2 {
		t.Fatalf("marked %v", got)
	}
	if left := Stop(l, time.Second); len(left) != 0 {
		t.Fatalf("survivors %v", left)
	}
	time.Sleep(100 * time.Millisecond)
	for _, c := range []*exec.Cmd{server, child} {
		if alive(c.Process.Pid) {
			t.Errorf("marked process %d survived", c.Process.Pid)
		}
	}
	for _, c := range []*exec.Cmd{stranger, near, prefix} {
		if !alive(c.Process.Pid) {
			t.Errorf("unmarked process %d was signalled", c.Process.Pid)
		}
	}
	if Alive(l, s) {
		t.Fatal("stopped server alive")
	}
	if MarkedPIDs("not-a-token", "") != nil {
		t.Fatal("a malformed token matched")
	}
}

func alive(pid int) bool {
	raw, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	return err == nil && !strings.Contains(string(raw), ") Z ")
}

func TestEnvrcState(t *testing.T) {
	for out, want := range map[string]error{
		`{"state":{"foundRC":null,"loadedRC":null}}`:             nil,
		`{"state":{"foundRC":{"allowed":0,"path":"/r/.envrc"}}}`: nil,
		`{"state":{"foundRC":{"allowed":1,"path":"/r/.envrc"}}}`: ErrEnvrcBlocked,
		`{"state":{"foundRC":{"allowed":2,"path":"/r/.envrc"}}}`: ErrEnvrcBlocked,
	} {
		if err := EnvrcState([]byte(out)); !errors.Is(err, want) || (want == nil && err != nil) {
			t.Errorf("EnvrcState(%s) = %v, want %v", out, err, want)
		}
	}
	if EnvrcState([]byte(`{"state":{"foundRC":{"path":"/r/.envrc"}}}`)) == nil || EnvrcState([]byte(`nope`)) == nil {
		t.Fatal("unreadable state accepted")
	}
}

func TestPreflight(t *testing.T) {
	var calls [][]string
	reply := map[string]string{"--version": "codex-cli 0.160.1\n", "status": `{"state":{"foundRC":null}}`}
	p := Preflight{Codex: "/bin/codex", Direnv: "sh", Run: func(_ context.Context, dir string, argv ...string) ([]byte, error) {
		calls = append(calls, append([]string{dir}, argv...))
		return []byte(reply[argv[1]]), nil
	}}
	if err := p.Check(context.Background(), "/r"); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[0][1] != "/bin/codex" || calls[0][2] != "--version" ||
		strings.Join(calls[1], " ") != "/r sh status --json" {
		t.Fatalf("calls %q", calls)
	}
	reply["--version"] = "codex-cli 0.161.0"
	if err := p.Check(context.Background(), "/r"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("new codex: %v", err)
	}
	reply["--version"] = "codex-cli 0.160.2"
	reply["status"] = `{"state":{"foundRC":{"allowed":1,"path":"/r/.envrc"}}}`
	if err := p.Check(context.Background(), "/r"); !errors.Is(err, ErrEnvrcBlocked) {
		t.Fatalf("blocked envrc: %v", err)
	}
	p.Direnv = "no-such-direnv-h3d"
	if err := p.Check(context.Background(), "/r"); err != nil {
		t.Fatalf("no direnv: %v", err)
	}
}
