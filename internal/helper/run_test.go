package helper

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// TestRunEndToEnd is the whole helper against a real bridge: a fake ssh
// forwards the socket, the game URL carries the token, /ws reaches the
// bridge, and shutdown takes ssh with it.
func TestRunEndToEnd(t *testing.T) {
	dir := shortDir(t)
	ctl := filepath.Join(dir, "ctl")
	if err := os.WriteFile(ctl, []byte("forward"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(fakeSSHEnv, ctl)
	bridgeSock := filepath.Join(dir, "remote", "bridge.sock")
	startBridge(t, bridgeSock)

	tun := &Tunnel{SSH: os.Args[0], Host: "dev@example", Remote: bridgeSock, Local: filepath.Join(dir, "local.sock")}
	opened := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	var runErr error
	stopped := make(chan struct{})
	go func() {
		runErr = Run(ctx, Config{
			Listen: "127.0.0.1:0", Tunnel: tun, Bundle: writeBundle(t), Log: quietLog(),
			Open: func(_ context.Context, u string) error { opened <- u; return nil },
		})
		close(stopped)
	}()
	t.Cleanup(func() { cancel(); <-stopped })

	var game string
	select {
	case game = <-opened:
	case <-time.After(10 * time.Second):
		t.Fatal("game window never opened")
	}
	u, err := url.Parse(game)
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(u.Fragment, "token=") || len(u.Fragment) != len("token=")+64 {
		t.Fatalf("game URL = %q", game)
	}
	token := strings.TrimPrefix(u.Fragment, "token=")
	waitFor(t, "tunnel up", func() bool { return tun.Status().State == StateUp })

	resp, err := http.Get("http://" + u.Host + "/healthz")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %v %v", resp, err)
	}
	resp.Body.Close()

	wctx, wcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer wcancel()
	h := http.Header{"Origin": {"http://" + u.Host}}
	c, _, err := websocket.Dial(wctx, "ws://"+u.Host+"/ws?token="+token, &websocket.DialOptions{HTTPHeader: h})
	if err != nil {
		t.Fatal(err)
	}
	expectWorld(t, c)
	c.CloseNow()

	pid := tun.Status().PID
	cancel()
	if <-stopped; runErr != nil {
		t.Fatal(runErr)
	}
	if alive(pid) {
		t.Fatalf("ssh %d outlived the helper", pid)
	}
}
