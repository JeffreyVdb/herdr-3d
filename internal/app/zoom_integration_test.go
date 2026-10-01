//go:build integration

package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// ttyClient attaches herdr's TUI to a session in a pseudo-terminal of
// rows × cols for secs seconds (python3's pty; the bridge's own tests have no
// pty library), so the session has a client and a zoom resizes the pane.
const ttyClient = `
import os, pty, sys, fcntl, termios, struct, time, signal, select
session, rows, cols, secs = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), float(sys.argv[4])
env = {k: v for k, v in os.environ.items() if not k.startswith(("HERDR_", "CLAUDE"))}
env["TERM"] = "xterm-256color"
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[5], [sys.argv[5], "--session", session], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
os.kill(pid, signal.SIGWINCH)
end = time.time() + secs
def stop(*_):
    try: os.kill(pid, signal.SIGTERM)
    finally: sys.exit(0)
signal.signal(signal.SIGTERM, stop)
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            if not os.read(fd, 65536): break
        except OSError: break
stop()
`

// layoutOf is the throwaway session's first tab layout, from `api snapshot`.
func (s *throwaway) layoutOf(pane string) (herdr.PaneState, bool) {
	s.t.Helper()
	var resp struct {
		Result struct {
			Snapshot herdr.Snapshot `json:"snapshot"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "api", "snapshot"), &resp); err != nil {
		s.t.Fatal(err)
	}
	return resp.Result.Snapshot.PaneState(pane)
}

func (s *throwaway) waitState(what string, within time.Duration, pane string, ok func(herdr.PaneState) bool) herdr.PaneState {
	s.t.Helper()
	deadline := time.Now().Add(within)
	for {
		st, found := s.layoutOf(pane)
		if found && ok(st) {
			return st
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("pane %s never %s (last %+v)", pane, what, st)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestIntegrationFullscreenLaptop (#74): a split pane's laptop watched with
// fullscreen against a real herdr: zoomed while seated, put back on
// standing up, headless (no client: the zoom flag flips and nothing grows)
// and with a TUI attached (the pane gets the tab's area); a tab the human
// zoomed is never put back.
func TestIntegrationFullscreenLaptop(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is not installed (the TUI client needs a pty)")
	}
	s := startThrowaway(t)
	t.Logf("throwaway session %s", s.name)

	var created struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", t.TempDir(), "--label", "split", "--no-focus"), &created); err != nil {
		t.Fatal(err)
	}
	pane := created.Result.RootPane.PaneID
	s.run("--session", s.name, "pane", "split", pane, "--direction", "right", "--no-focus")
	s.run("--session", s.name, "pane", "zoom", pane, "--off") // the throwaway's own tab: known unzoomed

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$")
	db := filepath.Join(t.TempDir(), "world.db")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: db, Herdr: &herdr.Client{Bin: s.bin}, Only: only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelInfo})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: s.bin, Only: only},
		})
	}()
	stopped := false
	stopBridge := func() {
		if !stopped {
			stopped = true
			cancel()
			if err := <-served; err != nil {
				t.Errorf("Serve: %v", err)
			}
		}
	}
	t.Cleanup(stopBridge)
	<-ready
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := proto.Dial(dctx, sock)
	dcancel()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration-fullscreen"}); err != nil {
		t.Fatal(err)
	}
	st := &stream{t: t, msgs: make(chan []byte, 4096)}
	go func() {
		defer close(st.msgs)
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			st.msgs <- raw
		}
	}()
	b := &bridgeConn{t: t, conn: conn, st: st}
	w := b.workerOf("split", 10*time.Second)

	watch := func(fullscreen bool) proto.TerminalWatchResult {
		t.Helper()
		var res proto.TerminalWatchResult
		b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w.ID, Fullscreen: fullscreen}, 20*time.Second, &res)
		return res
	}
	unwatch := func() {
		t.Helper()
		b.ack(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: w.ID}, 10*time.Second, nil)
		waitObservers(t, s.name, 0)
	}

	// 1. No fullscreen: the split pane at its own size, nothing written.
	res := watch(false)
	if res.Zoom == nil || res.Zoom.State != proto.ZoomSplit || res.Zoom.Applied {
		t.Fatalf("watch without fullscreen: %+v zoom %+v", res, res.Zoom)
	}
	unwatch()
	if st, _ := s.layoutOf(pane); st.Zoomed {
		t.Fatal("a watch without fullscreen zoomed the tab")
	}

	// 2. Headless: zoomed while seated and put back after. The zoom flag
	// flips; the tab's area is herdr's 120 × 40, so the bridge says so.
	res = watch(true)
	if res.Zoom == nil || res.Zoom.State != proto.ZoomZoomed || !res.Zoom.Applied || !res.Zoom.Headless || res.Cols != 120 || res.Rows != 40 {
		t.Fatalf("headless fullscreen watch: %+v zoom %+v", res, res.Zoom)
	}
	if st, _ := s.layoutOf(pane); !st.Zoomed || !st.Focused {
		t.Fatalf("headless: state %+v, want zoomed on the pane", st)
	}
	unwatch()
	s.waitState("unzoomed after standing up", 10*time.Second, pane, func(p herdr.PaneState) bool { return !p.Zoomed })

	// 3. With a TUI attached the pane gets the tab's content area.
	tty := exec.Command(py, "-c", ttyClient, s.name, "50", "140", "90", s.bin)
	tty.Env = s.env
	if err := tty.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tty.Process.Signal(os.Interrupt); _ = tty.Wait() })
	attached := s.waitState("laid out for the TUI", 20*time.Second, pane, func(p herdr.PaneState) bool { return !p.Headless })
	t.Logf("split pane with a TUI: %dx%d", attached.Cols, attached.Rows)

	res = watch(true)
	if res.Zoom == nil || res.Zoom.State != proto.ZoomZoomed || !res.Zoom.Applied || res.Zoom.Headless {
		t.Fatalf("fullscreen watch with a TUI: %+v zoom %+v", res, res.Zoom)
	}
	if res.Cols <= attached.Cols || res.Rows < attached.Rows {
		t.Fatalf("zoomed watch is %dx%d, the split pane was %dx%d: want the whole tab area", res.Cols, res.Rows, attached.Cols, attached.Rows)
	}
	t.Logf("fullscreen watch: %dx%d", res.Cols, res.Rows)
	f := st.frame(w.ID, 10*time.Second)
	if f.Cols != res.Cols || f.Rows != res.Rows {
		t.Fatalf("first frame is %dx%d, the ack said %dx%d", f.Cols, f.Rows, res.Cols, res.Rows)
	}
	// The human unzooms: the laptop hears of it and nothing zooms again.
	s.run("--session", s.name, "pane", "zoom", pane, "--off")
	var state proto.TerminalState
	st.next("a terminal.state", 10*time.Second, func(env proto.Envelope, raw []byte) bool {
		return env.T == proto.TTerminalState && json.Unmarshal(raw, &state) == nil
	})
	if state.Zoom.State != proto.ZoomSplit || state.Zoom.Applied || state.Cols != attached.Cols {
		t.Fatalf("state after the human unzoomed = %+v, want the split at %d columns", state, attached.Cols)
	}
	unwatch()
	if p, _ := s.layoutOf(pane); p.Zoomed {
		t.Fatal("standing up zoomed a tab the human had unzoomed")
	}

	// 4. A tab the human zoomed is never put back.
	s.run("--session", s.name, "pane", "zoom", pane, "--on")
	res = watch(true)
	if res.Zoom == nil || res.Zoom.State != proto.ZoomZoomed || res.Zoom.Applied {
		t.Fatalf("watch of a human-zoomed tab: %+v zoom %+v", res, res.Zoom)
	}
	unwatch()
	time.Sleep(500 * time.Millisecond)
	if p, _ := s.layoutOf(pane); !p.Zoomed {
		t.Fatal("standing up put back a zoom the bridge did not make")
	}

	// 5. One audit row per write: the zoom of step 2 and its putting back,
	// and the zoom of step 3 (the human unzoomed that one, so no more).
	stopBridge()
	adb, err := store.Open(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer adb.Close()
	log, err := adb.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var modes []string
	for _, e := range log {
		if e.Cmd == "pane.zoom" {
			var a struct{ Mode, Why string }
			_ = json.Unmarshal([]byte(e.Args), &a)
			modes = append(modes, a.Mode+"/"+a.Why)
			if !e.OK {
				t.Errorf("zoom write failed: %+v", e)
			}
		}
	}
	if !slices.Equal(modes, []string{"on/watch", "off/stand-up", "on/watch"}) {
		t.Fatalf("zoom audit rows = %q", modes)
	}
}
