//go:build integration

package codexshare

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
)

// hfx is a headless fixture (#27): the fixture's mock and isolated
// CODEX_HOME with a worker-style app-server started directly, no Herdr
// session and no TUI. A driver Client stands in for the terminal: the
// server does not tell its clients apart, and a driver's turns are
// scripted exactly. Used where the protocol is the subject (child threads);
// the TUI suites cover the terminal itself.
type hfx struct {
	t     *testing.T
	ctx   context.Context
	root  string
	home  string
	ws    string
	sock  string
	owner string
	mock  *Mock
	srv   *exec.Cmd
	ev    string
}

func newHeadless(t *testing.T) *hfx {
	t.Helper()
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("codex is not installed")
	}
	out, err := exec.Command("codex", "--version").Output()
	if err != nil {
		t.Skipf("codex --version: %v", err)
	}
	if err := CheckFixtureCodex(string(out)); err != nil {
		t.Skipf("UNVERIFIED CODEX, not a pass: %v", err)
	}
	t.Logf("fixture codex: %s", out)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	t.Cleanup(cancel)
	root, err := os.MkdirTemp("", "h3d27-")
	if err != nil {
		t.Fatal(err)
	}
	f := &hfx{t: t, ctx: ctx, root: root, home: filepath.Join(root, "home"), ws: filepath.Join(root, "ws"),
		sock: filepath.Join(root, "s.sock"), owner: NewOwner()}
	t.Cleanup(func() {
		f.stopServer(syscall.SIGKILL)
		if left := KillOwned(f.owner); len(left) != 0 {
			t.Errorf("processes %v survived SIGKILL", left)
		}
		_ = os.RemoveAll(root)
	})
	if dir := os.Getenv("H3D_CODEXSHARE_EVIDENCE"); dir != "" {
		f.ev = filepath.Join(dir, t.Name())
		_ = os.RemoveAll(f.ev)
		_ = os.MkdirAll(f.ev, 0o755)
	}
	for _, d := range []string{f.home, f.ws} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if f.mock, err = StartMock(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.mock.Close)
	f.mock.SetDelay(300 * time.Millisecond)
	if err := WriteHome(f.home, HomeOptions{MockURL: f.mock.URL(), Trusted: []string{f.ws}}); err != nil {
		t.Fatal(err)
	}
	f.startServer()
	return f
}

// startServer starts the app-server on f.sock (again after a stop).
func (f *hfx) startServer() {
	f.t.Helper()
	_ = os.Remove(f.sock)
	cmd := exec.Command("codex", "app-server", "--listen", "unix://"+f.sock, "-c", codexapp.ServerFeatures)
	cmd.Dir = f.ws
	cmd.Env = CleanEnv(os.Environ(), "CODEX_HOME="+f.home, OwnerVar+"="+f.owner)
	log, err := os.OpenFile(filepath.Join(f.root, "server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		f.t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		f.t.Fatal(err)
	}
	go func() { _ = cmd.Wait(); log.Close() }()
	f.srv = cmd
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if c, err := Dial(f.ctx, f.sock); err == nil {
			c.Close()
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	f.t.Fatalf("app-server socket %s never answered", f.sock)
}

// stopServer signals the server's process group and waits for it to go.
func (f *hfx) stopServer(sig syscall.Signal) {
	if f.srv == nil || f.srv.Process == nil {
		return
	}
	_ = syscall.Kill(-f.srv.Process.Pid, sig)
	for i := 0; i < 100; i++ {
		if syscall.Kill(f.srv.Process.Pid, 0) != nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	f.srv = nil
}

// client dials and initializes a client named name.
func (f *hfx) client(name string) *Client {
	f.t.Helper()
	c, err := Dial(f.ctx, f.sock)
	if err != nil {
		f.t.Fatal(err)
	}
	f.t.Cleanup(c.Close)
	if _, err := c.Initialize(f.ctx, name); err != nil {
		f.t.Fatal(err)
	}
	return c
}

// startThread starts a persistent root thread on c, as the terminal does.
func (f *hfx) startThread(c *Client) string {
	f.t.Helper()
	var res struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := c.Call(f.ctx, "thread/start", map[string]any{"cwd": f.ws}, &res); err != nil {
		f.t.Fatal(err)
	}
	return res.Thread.ID
}

// turn starts a turn with text on thread.
func (f *hfx) turn(c *Client, thread, text string) string {
	f.t.Helper()
	var res struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := c.Call(f.ctx, "turn/start", map[string]any{"threadId": thread, "input": []any{
		map[string]any{"type": "text", "text": text},
	}}, &res); err != nil {
		f.t.Fatal(err)
	}
	return res.Turn.ID
}

// dump records every message c received as evidence (JSONL).
func (f *hfx) dump(name string, c *Client) {
	if f.ev == "" {
		return
	}
	var b []byte
	for _, m := range c.Notifications("") {
		line, _ := json.Marshal(m)
		b = append(append(b, line...), '\n')
	}
	_ = os.WriteFile(filepath.Join(f.ev, name+".jsonl"), b, 0o644)
}
