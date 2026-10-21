//go:build integration

package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// controllers counts the `terminal session control` processes of session
// that are alive.
func controllers(t *testing.T, session string) int {
	t.Helper()
	entries, err := os.ReadDir("/proc")
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		args := strings.Split(string(bytes.TrimRight(cmdline, "\x00")), "\x00")
		if slices.Contains(args, session) && slices.Contains(args, "control") && slices.Contains(args, "terminal") {
			if slices.Contains(args, "--takeover") {
				t.Fatalf("a controller with --takeover: %q", args)
			}
			n++
		}
	}
	return n
}

func waitControllers(t *testing.T, session string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for controllers(t, session) != want {
		if time.Now().After(deadline) {
			t.Fatalf("%d controllers, want %d", controllers(t, session), want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestIntegrationSeatControl (#176): the seated laptop owns a plain shell's
// pane against a real herdr in a throwaway session: the PTY gets the
// client's size and every resize, a wheel scrolls herdr's history (pane
// get's offset, relayed as terminal.history), back to the live bottom by
// command and by typing, a second connection is refused control and
// observes read only, and the release puts the pane back to its size and
// leaves no controller or observer running.
func TestIntegrationSeatControl(t *testing.T) {
	s := startThrowaway(t)
	t.Logf("throwaway session %s", s.name)
	var created struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", t.TempDir(), "--label", "seat", "--no-focus"), &created); err != nil {
		t.Fatal(err)
	}
	pane := created.Result.RootPane.PaneID

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: filepath.Join(t.TempDir(), "world.db"), Herdr: &herdr.Client{Bin: s.bin}, Only: only,
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
	connect := func(client string) (*bridgeConn, *proto.Conn) {
		t.Helper()
		dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
		conn, err := proto.Dial(dctx, sock)
		dcancel()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Hello(ctx, proto.Hello{Client: client}); err != nil {
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
		return &bridgeConn{t: t, conn: conn, st: st}, conn
	}
	a, connA := connect("integration-seat")
	defer connA.CloseNow()
	w := a.workerOf("seat", 10*time.Second)

	// The shell's screen, read only, through herdr (never through the bridge).
	screen := func() string { return string(s.run("--session", s.name, "pane", "read", pane, "--source", "visible")) }
	typeLine := func(b *bridgeConn, line string) {
		t.Helper()
		b.ack(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: w.ID, Input: []proto.InputItem{{Text: ptrTo(line)}, {Key: ptrTo("enter")}}}, 10*time.Second, nil)
	}
	// size is the PTY's size as the shell sees it (`stty size`, rows cols).
	sizeN := 0
	size := func(b *bridgeConn) string {
		t.Helper()
		sizeN++
		tag := "SZ" + strconv.Itoa(sizeN)
		typeLine(b, "echo "+tag+"=$(stty size | tr ' ' x)")
		re := regexp.MustCompile(tag + `=(\d+x\d+)`)
		deadline := time.Now().Add(10 * time.Second)
		for {
			if m := re.FindStringSubmatch(screen()); m != nil {
				return m[1]
			}
			if time.Now().After(deadline) {
				t.Fatalf("no %s on the screen:\n%s", tag, screen())
			}
			time.Sleep(50 * time.Millisecond)
		}
	}
	scroll := func() herdr.PaneScroll {
		t.Helper()
		sc, ok, err := (&herdr.Client{Bin: s.bin}).PaneScroll(ctx, socketOf(t, s), pane)
		if err != nil || !ok {
			t.Fatalf("pane.get: %v, %v", ok, err)
		}
		return sc
	}
	history := func(b *bridgeConn, what string, ok func(proto.TerminalHistory) bool) proto.TerminalHistory {
		t.Helper()
		var h proto.TerminalHistory
		b.st.next(what, 10*time.Second, func(env proto.Envelope, raw []byte) bool {
			return env.T == proto.TTerminalHistory && json.Unmarshal(raw, &h) == nil && h.ID == w.ID && ok(h)
		})
		return h
	}
	control := func(b *bridgeConn) proto.TerminalControl {
		t.Helper()
		var m proto.TerminalControl
		b.st.next("terminal.control", 10*time.Second, func(env proto.Envelope, raw []byte) bool {
			return env.T == proto.TTerminalControl && json.Unmarshal(raw, &m) == nil && m.ID == w.ID
		})
		return m
	}

	// 0. Before: the pane's own size (no herdr TUI: herdr's headless one).
	before := size(a)
	t.Logf("PTY before control: %s", before)

	// 1. Control at 100 × 30: the PTY has that size.
	var res proto.TerminalWatchResult
	a.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w.ID, Fps: 10, Cols: 100, Rows: 30, Control: true}, 10*time.Second, &res)
	if !res.Control || res.Cols != 100 || res.Rows != 30 {
		t.Fatalf("watch ack = %+v", res)
	}
	if m := control(a); m.Mode != proto.ControlOwned || m.Cols != 100 || m.Rows != 30 {
		t.Fatalf("control = %+v", m)
	}
	if f := a.st.frame(w.ID, 10*time.Second); !f.Full || f.Cols != 100 || f.Rows != 30 {
		t.Fatalf("first frame = %+v", f)
	}
	waitControllers(t, s.name, 1)
	if got := size(a); got != "30x100" {
		t.Fatalf("PTY while controlled = %s, want 30x100", got)
	}

	// 2. A resize reaches the PTY, with a full frame at the new size.
	a.ack(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: w.ID, Cols: 120, Rows: 35, CellWidth: 9, CellHeight: 18}, 10*time.Second, nil)
	for {
		if f := a.st.frame(w.ID, 10*time.Second); f.Full && f.Cols == 120 && f.Rows == 35 {
			break
		}
	}
	if got := size(a); got != "35x120" {
		t.Fatalf("PTY after the resize = %s, want 35x120", got)
	}

	// 3. History: a wheel moves herdr's view; its offset comes back.
	typeLine(a, "seq 1 300")
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(screen(), "300") {
		if time.Now().After(deadline) {
			t.Fatalf("seq did not run:\n%s", screen())
		}
		time.Sleep(50 * time.Millisecond)
	}
	// herdr counts the new history a moment after it shows (pane.get's max).
	deadline = time.Now().Add(10 * time.Second)
	for scroll().Max < 250 {
		if time.Now().After(deadline) {
			t.Fatalf("pane.get never counted the history: %+v", scroll())
		}
		time.Sleep(50 * time.Millisecond)
	}
	a.ack(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: w.ID, Direction: "up", Lines: 20}, 10*time.Second, nil)
	h := history(a, "the offset after the wheel", func(h proto.TerminalHistory) bool { return h.Offset > 0 })
	// 20 lines up (a prompt line printed meanwhile pins it one more).
	if h.Offset < 20 || h.Offset > 22 || h.Max < 250 || h.Rows != 35 {
		t.Fatalf("history = %+v", h)
	}
	if sc := scroll(); sc.Offset != h.Offset {
		t.Fatalf("pane.get = %+v, history %+v", sc, h)
	}
	// Output while scrolled up: the view stays where it is (the offset grows).
	s.run("--session", s.name, "pane", "send-text", pane, "seq 1 5")
	s.run("--session", s.name, "pane", "send-keys", pane, "enter")
	if h := history(a, "the offset after new output", func(h proto.TerminalHistory) bool { return h.Offset > 22 }); h.Offset < 25 {
		t.Fatalf("history after output = %+v", h)
	}
	// Back to the live bottom by command.
	a.ack(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: w.ID, Bottom: true}, 10*time.Second, nil)
	history(a, "the live bottom", func(h proto.TerminalHistory) bool { return h.Offset == 0 })
	if sc := scroll(); sc.Offset != 0 {
		t.Fatalf("pane.get after bottom = %+v", sc)
	}
	// And by typing (herdr's send-keys alone would leave the view where it is).
	a.ack(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: w.ID, Direction: "up", Lines: 10}, 10*time.Second, nil)
	history(a, "scrolled up again", func(h proto.TerminalHistory) bool { return h.Offset >= 10 })
	a.ack(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: w.ID, Input: []proto.InputItem{{Key: ptrTo("space")}, {Key: ptrTo("backspace")}}}, 10*time.Second, nil)
	deadline = time.Now().Add(5 * time.Second)
	for scroll().Offset != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("typing left the view at %+v", scroll())
		}
		time.Sleep(50 * time.Millisecond)
	}

	// 4. A second connection: herdr refuses it control, it observes read only.
	b, connB := connect("integration-seat-2")
	b.workerOf("seat", 10*time.Second)
	var resB proto.TerminalWatchResult
	b.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w.ID, Fps: 10, Cols: 90, Rows: 25, Control: true}, 10*time.Second, &resB)
	if m := control(b); m.Mode != proto.ControlReadOnly || m.Reason != proto.ReadOnlyBusy {
		t.Fatalf("second connection's control = %+v", m)
	}
	if f := b.st.frame(w.ID, 10*time.Second); !f.Full {
		t.Fatalf("read-only frame = %+v", f)
	}
	b.refuse(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: w.ID, Cols: 90, Rows: 25}, proto.ErrInvalidState)
	waitControllers(t, s.name, 1)
	waitObservers(t, s.name, 1)
	if got := size(b); got != "35x120" {
		t.Fatalf("the read-only watch changed the PTY: %s", got)
	}

	// 5. Standing up (an observer watch, as the laptop then shows it) releases
	// the pane: herdr has no TUI here, so the bridge puts the pane's size back.
	a.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w.ID, Fps: 4}, 10*time.Second, nil)
	waitControllers(t, s.name, 0)
	after := size(a)
	t.Logf("PTY after the release: %s (before %s)", after, before)
	if after == "35x120" {
		t.Fatal("the release left the PTY at the controller's size")
	}
	var br, bc, ar, ac int
	if _, err := fmtSscan(before, &br, &bc); err != nil {
		t.Fatal(err)
	}
	if _, err := fmtSscan(after, &ar, &ac); err != nil {
		t.Fatal(err)
	}
	if abs(ar-br) > 2 || abs(ac-bc) > 3 {
		t.Fatalf("PTY after the release %s, before %s", after, before)
	}

	// 6. Sitting again and leaving every way: nothing left running.
	for i := range 5 {
		a.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w.ID, Fps: 10, Cols: 100, Rows: 30, Control: true}, 10*time.Second, nil)
		if m := control(a); m.Mode != proto.ControlOwned {
			t.Fatalf("sit %d: control = %+v (refused for its own predecessor?)", i, m)
		}
		a.ack(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: w.ID}, 10*time.Second, nil)
	}
	a.ack(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w.ID, Cols: 100, Rows: 30, Control: true}, 10*time.Second, nil)
	waitControllers(t, s.name, 1)
	connA.CloseNow()
	connB.CloseNow()
	waitControllers(t, s.name, 0)
	waitObservers(t, s.name, 0)
	stopBridge()
	if n := controllers(t, s.name); n != 0 {
		t.Fatalf("%d controllers outlived the bridge", n)
	}
}

// socketOf is the throwaway session's socket (`session list`).
func socketOf(t *testing.T, s *throwaway) string {
	t.Helper()
	for _, sess := range listSessions(t, &herdr.Client{Bin: s.bin}) {
		if sess.Name == s.name {
			return sess.SocketPath
		}
	}
	t.Fatalf("session %s is not listed", s.name)
	return ""
}

func fmtSscan(rc string, r, c *int) (int, error) {
	rs, cs, _ := strings.Cut(rc, "x")
	var err error
	if *r, err = strconv.Atoi(rs); err != nil {
		return 0, err
	}
	if *c, err = strconv.Atoi(cs); err != nil {
		return 1, err
	}
	return 2, nil
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
