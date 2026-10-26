package server_test

// #176: the seated laptop's controller, against a fake herdr controller.

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// fakeCtl is a herdr controller: an observer's frames, and the commands
// it was given.
type fakeCtl struct {
	*fakeObs
	term     *ctlTerm
	mu       sync.Mutex
	cmds     []string
	released bool
}

func (c *fakeCtl) cmd(format string, args ...any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.released {
		return herdr.ErrControlClosed
	}
	c.cmds = append(c.cmds, fmt.Sprintf(format, args...))
	c.term.record("ctl %s %s", c.pane, fmt.Sprintf(format, args...))
	return nil
}

func (c *fakeCtl) Resize(cols, rows, cw, ch int) error {
	return c.cmd("resize %dx%d %dx%d", cols, rows, cw, ch)
}

func (c *fakeCtl) Scroll(up bool, lines, col, row, mods int) error {
	dir := "down"
	if up {
		dir = "up"
	}
	return c.cmd("scroll %s %d at %d,%d mods %d", dir, lines, col, row, mods)
}

func (c *fakeCtl) Live() error               { return c.cmd("live") }
func (c *fakeCtl) Input(text string) error   { return c.cmd("input:%s", text) }
func (c *fakeCtl) InputBytes(b []byte) error { return c.cmd("input:%s", string(b)) }

func (c *fakeCtl) RestoreOnRelease(cols, rows int) { _ = c.cmd("restore %dx%d", cols, rows) }

// Close is the release: it takes the term's closeDelay (a controller slow to
// exit), then the stream is done.
func (c *fakeCtl) Close() error {
	c.mu.Lock()
	first := !c.released
	c.released = true
	c.mu.Unlock()
	if first {
		c.term.mu.Lock()
		delay := c.term.closeDelay
		c.term.mu.Unlock()
		time.Sleep(delay)
		c.term.record("release %s", c.pane)
	}
	return c.fakeObs.Close()
}

func (c *fakeCtl) commands() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.cmds)
}

func (c *fakeCtl) isReleased() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.released
}

// refuse ends the stream as herdr refuses a second owner.
func (c *fakeCtl) refuse(t *testing.T, reason string) {
	t.Helper()
	select {
	case c.frames <- herdr.Frame{Closed: true, Reason: reason}:
	case <-time.After(5 * time.Second):
		t.Fatal("controller not read")
	}
}

const refusal = "terminal attach failed: terminal term_1 already has an attached client; retry with --takeover"

// ctlTerm is a laptop herdr that can own panes.
type ctlTerm struct {
	*fakeTerm
	ctls       []*fakeCtl
	closeDelay time.Duration
	scroll     map[string]herdr.PaneScroll
	controlFn  func(n int) error
}

func (f *ctlTerm) ControlTerminal(_ context.Context, session, pane string, cols, rows int) (herdr.ControlStream, error) {
	f.record("control %s %s %dx%d", session, pane, cols, rows)
	f.mu.Lock()
	n, fn := len(f.ctls), f.controlFn
	f.mu.Unlock()
	if fn != nil {
		if err := fn(n); err != nil {
			f.mu.Lock()
			f.ctls = append(f.ctls, nil)
			f.mu.Unlock()
			return nil, err
		}
	}
	c := &fakeCtl{fakeObs: &fakeObs{pane: pane, cols: cols, rows: rows, frames: make(chan herdr.Frame), done: make(chan struct{})}, term: f}
	f.mu.Lock()
	f.ctls = append(f.ctls, c)
	f.mu.Unlock()
	return c, nil
}

// ctl waits for the n-th controller (0-based).
func (f *ctlTerm) ctl(t *testing.T, n int) *fakeCtl {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		if len(f.ctls) > n {
			c := f.ctls[n]
			f.mu.Unlock()
			return c
		}
		f.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("controller %d did not start (calls %q)", n, f.Calls())
		}
		time.Sleep(time.Millisecond)
	}
}

func (f *ctlTerm) controllers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.ctls)
}

func (f *ctlTerm) setScroll(pane string, s herdr.PaneScroll) {
	f.mu.Lock()
	f.scroll[pane] = s
	f.mu.Unlock()
}

func (f *ctlTerm) paneScroll(_ context.Context, socket, pane string) (herdr.PaneScroll, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.scroll[pane]
	return s, ok && socket == "sock-s"
}

// startCtlBridge is a term bridge whose herdr can own panes.
func startCtlBridge(t *testing.T, tweak func(*server.Options), workers ...world.WorkerObs) (*termBridge, *ctlTerm) {
	t.Helper()
	var ct *ctlTerm
	tb := startTermBridge(t, func(o *server.Options) {
		ct = &ctlTerm{fakeTerm: o.Term.(*fakeTerm), scroll: map[string]herdr.PaneScroll{}}
		o.Term = ct
		o.PaneScroll = ct.paneScroll
		o.HistoryPoll = 30 * time.Millisecond
		if tweak != nil {
			tweak(o)
		}
	}, workers...)
	return tb, ct
}

// ctlMsg reads until the next message of type typ (terminal.control or
// terminal.history), failing on a frame, an ack or an error first.
func ctlMsg[T any](c *client, typ string) T {
	c.t.Helper()
	for {
		m := c.next()
		switch m.env.T {
		case typ:
			var v T
			if err := json.Unmarshal(m.raw, &v); err != nil {
				c.t.Fatal(err)
			}
			return v
		case proto.TTerminalFrame, proto.TAck, proto.TError, proto.TTerminalClosed:
			c.t.Fatalf("waiting for %s, got %s", typ, m.raw)
		}
	}
}

// lastHistory is the last terminal.history the client heard (also one the
// command helpers read past).
func lastHistory(t *testing.T, c *client) proto.TerminalHistory {
	t.Helper()
	var last proto.TerminalHistory
	for _, line := range strings.Split(c.heard.String(), "\n") {
		var h proto.TerminalHistory
		if json.Unmarshal([]byte(line), &h) == nil && h.T == proto.TTerminalHistory {
			last = h
		}
	}
	return last
}

func watchAck(t *testing.T, ack proto.Ack) proto.TerminalWatchResult {
	t.Helper()
	var res proto.TerminalWatchResult
	b, _ := json.Marshal(ack.Data)
	_ = json.Unmarshal(b, &res)
	return res
}

func TestControlWatchOwnsThePane(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, nil, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")

	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30, Cols: 150, Rows: 45, Control: true})
	if res := watchAck(t, ack); res != (proto.TerminalWatchResult{Pane: "w1:p1", Cols: 150, Rows: 45, Control: true}) {
		t.Fatalf("ack = %+v", res)
	}
	k := ct.ctl(t, 0)
	if k.cols != 150 || k.rows != 45 || ct.observers() != 0 {
		t.Fatalf("controller %dx%d, %d observers", k.cols, k.rows, ct.observers())
	}
	// Its first frame says the pane is ours, then comes.
	k.push(t, true, "\x1b[2Jhello")
	if m := ctlMsg[proto.TerminalControl](c, proto.TTerminalControl); m != (proto.TerminalControl{T: proto.TTerminalControl, ID: id, Pane: "w1:p1",
		Mode: proto.ControlOwned, Cols: 150, Rows: 45}) {
		t.Fatalf("control = %+v", m)
	}
	if f := c.frame(); !f.Full || f.N != 1 || f.Cols != 150 || decoded(t, f) != "\x1b[2Jhello" {
		t.Fatalf("frame = %s", f.raw)
	}

	// The real PTY's size.
	_, ack = c.mustAck(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: id, Cols: 160, Rows: 50, CellWidth: 9, CellHeight: 18})
	if b, _ := json.Marshal(ack.Data); string(b) != `{"cols":160,"rows":50}` {
		t.Fatalf("resize ack = %s", b)
	}
	for _, bad := range []proto.TerminalResizeArgs{{ID: id, Cols: 39, Rows: 20}, {ID: id, Cols: 301, Rows: 20}, {ID: id, Cols: 80, Rows: 9},
		{ID: id, Cols: 80, Rows: 101}, {ID: id, Cols: 80, Rows: 24, CellWidth: 257}, {ID: id, Cols: 80, Rows: 24, CellHeight: -1}} {
		c.mustError(proto.CmdTerminalResize, bad, proto.ErrBadRequest)
	}
	c.mustError(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: "nobody", Cols: 80, Rows: 24}, proto.ErrUnknownWorker)

	// The history: a wheel, its offset, back to the live bottom.
	ct.setScroll("w1:p1", herdr.PaneScroll{Offset: 0, Max: 79, ViewportRows: 50})
	if m := ctlMsg[proto.TerminalHistory](c, proto.TTerminalHistory); m.Offset != 0 || m.Max != 79 || m.Rows != 50 {
		t.Fatalf("history = %+v", m)
	}
	c.mustAck(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 3, Column: 10, Row: 5, Modifiers: 2})
	ct.setScroll("w1:p1", herdr.PaneScroll{Offset: 3, Max: 79, ViewportRows: 50})
	if m := ctlMsg[proto.TerminalHistory](c, proto.TTerminalHistory); m != (proto.TerminalHistory{T: proto.TTerminalHistory, ID: id, Pane: "w1:p1",
		Offset: 3, Max: 79, Rows: 50}) {
		t.Fatalf("history = %+v", m)
	}
	// New output while scrolled up: herdr keeps the view where it is, so the
	// offset grows; the bridge reads it again while it is above 0.
	ct.setScroll("w1:p1", herdr.PaneScroll{Offset: 13, Max: 89, ViewportRows: 50})
	if m := ctlMsg[proto.TerminalHistory](c, proto.TTerminalHistory); m.Offset != 13 || m.Max != 89 {
		t.Fatalf("history after output = %+v", m)
	}
	c.mustAck(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: id, Bottom: true})
	for _, bad := range []any{
		proto.TerminalScrollArgs{ID: id},
		proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 1, Bottom: true},
		proto.TerminalScrollArgs{ID: id, Direction: "left", Lines: 1},
		proto.TerminalScrollArgs{ID: id, Direction: "up"},
		proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 1001},
		proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 1, Column: 300},
		proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 1, Row: 100},
		proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 1, Modifiers: 8},
		map[string]any{"id": id, "bottom": true, "text": "x"},
	} {
		c.mustError(proto.CmdTerminalScroll, bad, proto.ErrBadRequest)
	}

	// Typing brings the view back to the live bottom first, and says so.
	ct.setScroll("w1:p1", herdr.PaneScroll{Offset: 7, Max: 89, ViewportRows: 50})
	if m := ctlMsg[proto.TerminalHistory](c, proto.TTerminalHistory); m.Offset != 7 {
		t.Fatalf("history = %+v", m)
	}
	ct.setScroll("w1:p1", herdr.PaneScroll{Offset: 0, Max: 89, ViewportRows: 50}) // what herdr has once the input reset the view
	c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{{Key: ptr("enter")}}})
	if last := lastHistory(t, c); last.Offset != 0 {
		t.Fatalf("history after typing = %+v", last)
	}
	calls := ct.Calls()
	live, keys := slices.Index(calls, "ctl w1:p1 live"), slices.Index(calls, "keys w1:p1 enter")
	if want := []string{"restore 132x43", "resize 160x50 9x18", "scroll up 3 at 10,5 mods 2", "live", "live"}; !slices.Equal(k.commands(), want) {
		t.Fatalf("controller commands = %q, want %q (calls %q)", k.commands(), want, calls)
	}
	if live < 0 || keys < 0 || live > keys {
		t.Fatalf("the live bottom must come before the keys: %q", calls)
	}

	// An observer watch (another worker's laptop) takes none of it.
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30})
	waitFor(t, "the controller is released", k.isReleased)
	c.mustError(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: id, Cols: 80, Rows: 24}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: id, Bottom: true}, proto.ErrBadRequest)

	// Resize and scroll are audited, with their (content-free) arguments.
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, e := range log {
		if e.Cmd == proto.CmdTerminalResize || e.Cmd == proto.CmdTerminalScroll {
			rows = append(rows, e.Cmd+" "+string(e.Args))
		}
	}
	if len(rows) < 3 || !strings.Contains(strings.Join(rows, "\n"), `"cols":160`) {
		t.Fatalf("audit rows = %q", rows)
	}
}

// herdr refuses a controller for a pane another client owns: the watch
// observes read only, at the pane's size, says so, and never retries.
func TestControlWatchRefusedFallsBackToObserving(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, nil, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Cols: 150, Rows: 45, Control: true})
	ct.ctl(t, 0).refuse(t, refusal)
	o := ct.observer(t, 0)
	if o.cols != 132 || o.rows != 43 {
		t.Fatalf("the read-only observer is %dx%d, want the pane's 132x43", o.cols, o.rows)
	}
	o.push(t, true, "theirs")
	if m := ctlMsg[proto.TerminalControl](c, proto.TTerminalControl); m.Mode != proto.ControlReadOnly || m.Reason != proto.ReadOnlyBusy || m.Cols != 132 || m.Rows != 43 {
		t.Fatalf("control = %+v", m)
	}
	if f := c.frame(); !f.Full || decoded(t, f) != "theirs" || f.Cols != 132 {
		t.Fatalf("frame = %s", f.raw)
	}
	c.mustError(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: id, Cols: 80, Rows: 24}, proto.ErrInvalidState)
	c.mustError(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: id, Direction: "up", Lines: 1}, proto.ErrInvalidState)
	// The observer exiting restarts an observer, never a controller.
	o.end()
	o2 := ct.observer(t, 1)
	o2.push(t, true, "again")
	c.frame()
	if n := ct.controllers(); n != 1 {
		t.Fatalf("%d controllers: a refused one is not retried", n)
	}

	// A takeover by another client: read only too.
	tb2, ct2 := startCtlBridge(t, nil, shell("w1"))
	c2 := tb2.connect(proto.Hello{})
	id2 := idOf(t, c2.snapshot(), "w1")
	c2.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id2, Control: true})
	k := ct2.ctl(t, 0)
	k.push(t, true, "mine")
	if m := ctlMsg[proto.TerminalControl](c2, proto.TTerminalControl); m.Mode != proto.ControlOwned || m.Cols != 132 {
		t.Fatalf("control = %+v (the pane's size when the client names none)", m)
	}
	c2.frame()
	k.refuse(t, "terminal attach taken over")
	ct2.observer(t, 0).push(t, true, "theirs now")
	if m := ctlMsg[proto.TerminalControl](c2, proto.TTerminalControl); m.Mode != proto.ControlReadOnly || m.Reason != proto.ReadOnlyTakenOver {
		t.Fatalf("control after a takeover = %+v", m)
	}
}

// A controller that exits without terminal.closed (EOF) is restarted with
// backoff; one that keeps failing leaves the watch read only.
func TestControlWatchRestartsThenObserves(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, func(o *server.Options) {
		o.FirstFrame = 50 * time.Millisecond
		o.ObserverBackoff = 10 * time.Millisecond
	}, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Control: true})
	k := ct.ctl(t, 0)
	k.push(t, true, "one")
	ctlMsg[proto.TerminalControl](c, proto.TTerminalControl)
	c.frame()
	k.end() // EOF: a transport failure
	k2 := ct.ctl(t, 1)
	waitFor(t, "the first is released", k.isReleased)
	k2.push(t, true, "two")
	if f := c.frame(); decoded(t, f) != "two" {
		t.Fatalf("after the restart: %s", f.raw)
	}
	// Now each one ends at once: the 4th failure within 30 s leaves the watch
	// read only.
	for i := 1; i <= 3; i++ {
		ct.ctl(t, i).end()
	}
	o := ct.observer(t, 0)
	o.push(t, true, "read only")
	if m := ctlMsg[proto.TerminalControl](c, proto.TTerminalControl); m.Mode != proto.ControlReadOnly || m.Reason != proto.ReadOnlyFailed {
		t.Fatalf("control = %+v", m)
	}
	if f := c.frame(); decoded(t, f) != "read only" {
		t.Fatalf("frame = %s", f.raw)
	}
	if n := ct.controllers(); n != 4 {
		t.Fatalf("%d controllers started, want 4", n)
	}
}

// Every way a watch ends releases its controller, and nothing else is ever
// sent to a released one.
func TestControlReleasedOnEveryPath(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, nil, shell("w1"), shell("w2"), shell("w3"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	ids := []string{idOf(t, snap, "w1"), idOf(t, snap, "w2"), idOf(t, snap, "w3")}
	n := 0
	sit := func(c *client, id string) *fakeCtl {
		t.Helper()
		c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Control: true})
		k := ct.ctl(t, n)
		n++
		return k
	}
	// Standing up: the seat's watch again without control.
	k := sit(c, ids[0])
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: ids[0], Fps: 4})
	waitFor(t, "released when standing up", k.isReleased)
	// Unwatch.
	k = sit(c, ids[0])
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: ids[0]})
	waitFor(t, "released on unwatch", k.isReleased)
	// A re-watch with control (a new controller replaces the old one).
	k = sit(c, ids[0])
	k2 := sit(c, ids[0])
	waitFor(t, "released on a re-watch", k.isReleased)
	if k2.isReleased() {
		t.Fatal("the new controller was released")
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: ids[0]})
	// The pane changes, the worker goes, the floor sleeps.
	k = sit(c, ids[1])
	tb.workers[1].PaneID = "w2:p2"
	tb.publishFloor(true)
	c.closed()
	waitFor(t, "released on a pane change", k.isReleased)
	k = sit(c, ids[2])
	tb.workers = tb.workers[:2]
	tb.publishFloor(true)
	c.closed()
	waitFor(t, "released when the worker goes", k.isReleased)
	k = sit(c, ids[0])
	tb.publishFloor(false)
	c.closed()
	waitFor(t, "released when the floor sleeps", k.isReleased)
	// The connection closes.
	tb.publishFloor(true)
	c2 := tb.connect(proto.Hello{})
	c2.snapshot()
	k = sit(c2, ids[0])
	c2.conn.CloseNow()
	waitFor(t, "released with the connection", k.isReleased)
	// The bridge stops.
	c3 := tb.connect(proto.Hello{})
	c3.snapshot()
	k = sit(c3, ids[0])
	tb.stop()
	if !k.isReleased() {
		t.Fatal("a controller outlived the bridge")
	}
	for i := range n {
		if !ct.ctl(t, i).isReleased() {
			t.Errorf("controller %d was never released", i)
		}
	}
}

// One controller per connection, counted under the observer caps; a new
// controller of a worker waits for the one it replaces to be released
// (herdr would refuse it for its own predecessor).
func TestControlLimits(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, func(o *server.Options) { o.MaxObservers = 2 }, shell("w1"), shell("w2"), shell("w3"))
	c, other := tb.connect(proto.Hello{}), tb.connect(proto.Hello{})
	snap := c.snapshot()
	other.snapshot()
	w1, w2, w3 := idOf(t, snap, "w1"), idOf(t, snap, "w2"), idOf(t, snap, "w3")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w1, Control: true})
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w2, Control: true}, proto.ErrCapacity)
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w2})
	other.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w3, Control: true}, proto.ErrCapacity) // --max-observers
	// Standing up from w1 and sitting at w2: one controller again.
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w1})
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w2, Control: true})

	// A slow release: the next controller of the worker starts after it.
	ct.mu.Lock()
	ct.closeDelay = 150 * time.Millisecond
	ct.mu.Unlock()
	before := ct.controllers()
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: w2, Control: true})
	ct.ctl(t, before)
	calls := ct.Calls()
	last := func(s string) int {
		for i := len(calls) - 1; i >= 0; i-- {
			if calls[i] == s {
				return i
			}
		}
		return -1
	}
	rel, start := last("release w2:p1"), last("control s w2:p1 132x43")
	if rel < 0 || start < rel {
		t.Fatalf("the new controller started before the old one was released: %q", calls)
	}
}

// A controlled watch whose connection has no room resyncs in place: its
// controller goes on (no release, no new attach), the pending frames are
// dropped and a resize to the same size asks herdr for a full frame.
func TestControlWatchResyncsInPlace(t *testing.T) {
	t.Parallel()
	tb, ct := startCtlBridge(t, func(o *server.Options) { o.Queue = 16 }, shell("w1"))
	d := tb.direct(t)
	d.read() // welcome
	env, raw := d.read()
	var snap proto.Snapshot
	if env.T != proto.TSnapshot || json.Unmarshal(raw, &snap) != nil {
		t.Fatalf("snapshot = %s", raw)
	}
	id := ""
	for _, w := range snap.World.Workers {
		id = w.ID
	}
	for id == "" {
		var ev proto.Event
		if _, raw := d.read(); json.Unmarshal(raw, &ev) == nil && ev.T == proto.EvWorkerUpsert {
			id = ev.Worker.ID
		}
	}
	if ack := d.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30, Cols: 100, Rows: 30, Control: true}); !strings.Contains(string(ack), `"ack"`) {
		t.Fatalf("watch: %s", ack)
	}
	k := ct.ctl(t, 0)
	k.push(t, true, "full")
	for i := 0; len(k.commands()) < 2; i++ {
		time.Sleep(35 * time.Millisecond)
		select {
		case k.frames <- herdr.Frame{Width: 100, Height: 30, Data: []byte(fmt.Sprintf("d%d", i))}:
		case <-k.done:
		}
		if i == 30 {
			d.drain() // room again
		}
		if i > 200 {
			t.Fatal("the watch never resynced")
		}
	}
	if got := k.commands(); !slices.Equal(got, []string{"restore 132x43", "resize 100x30 0x0"}) {
		t.Fatalf("controller commands = %q", got)
	}
	if k.isReleased() || ct.controllers() != 1 {
		t.Fatal("a resync restarted the controller")
	}
	d.drain()
	// herdr's answer to the resize: a full frame, numbered on.
	k.push(t, true, "fresh")
	var f proto.TerminalFrame
	for f.T != proto.TTerminalFrame || !f.Full {
		_, raw := d.read()
		f = proto.TerminalFrame{}
		_ = json.Unmarshal(raw, &f)
	}
	if !f.Full || f.N < 2 {
		t.Fatalf("after the resync: %+v", f)
	}
	if err := d.wasKicked(); err != nil {
		t.Fatalf("kicked: %v", err)
	}
}

// A bridge whose herdr cannot own panes (an old Term) observes a control
// watch as before, and its ack says control is not on.
func TestControlWatchWithoutAController(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Cols: 150, Rows: 45, Control: true})
	if res := watchAck(t, ack); res.Control || res.Cols != 150 {
		t.Fatalf("ack = %+v", res)
	}
	if o := tb.term.observer(t, 0); o.cols != 150 {
		t.Fatalf("observer = %dx%d", o.cols, o.rows)
	}
	c.mustError(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: id, Cols: 80, Rows: 24}, proto.ErrBadRequest)
}
