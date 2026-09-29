package server_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
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

// fakeObs is an observer the test feeds frames.
type fakeObs struct {
	pane       string
	cols, rows int
	frames     chan herdr.Frame
	done       chan struct{}
	once       sync.Once
}

func (o *fakeObs) Next() (herdr.Frame, error) {
	select {
	case f, ok := <-o.frames:
		if !ok {
			return herdr.Frame{}, io.EOF
		}
		return f, nil
	case <-o.done:
		return herdr.Frame{}, errors.New("closed")
	}
}

func (o *fakeObs) Close() error { o.once.Do(func() { close(o.done) }); return nil }

func (o *fakeObs) closed() bool {
	select {
	case <-o.done:
		return true
	default:
		return false
	}
}

func (o *fakeObs) push(t *testing.T, full bool, data string) {
	t.Helper()
	select {
	case o.frames <- herdr.Frame{Full: full, Width: o.cols, Height: o.rows, Data: []byte(data)}:
	case <-o.done:
		t.Fatal("pushing to a closed observer")
	case <-time.After(5 * time.Second):
		t.Fatal("observer not read")
	}
}

// end makes the observer exit (EOF).
func (o *fakeObs) end() { close(o.frames) }

// fakeTerm is server.TermHerdr: observers the test drives, screens it
// sets, and a record of everything typed.
type fakeTerm struct {
	mu        sync.Mutex
	calls     []string
	obs       []*fakeObs
	observeFn func(n int) error // fails the n-th Observe (0-based) when it returns an error
	screens   map[string]string
	onKeys    func(pane string, keys []string)
	onPrompt  func(pane, how string)
	submit    []error // SubmitPrompt results in turn
	textGate  chan struct{}
}

func newFakeTerm() *fakeTerm { return &fakeTerm{screens: map[string]string{}} }

func (f *fakeTerm) record(format string, args ...any) {
	f.mu.Lock()
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
	f.mu.Unlock()
}

func (f *fakeTerm) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeTerm) Observe(_ context.Context, session, pane string, cols, rows int) (herdr.FrameStream, error) {
	f.mu.Lock()
	n := len(f.obs)
	fn := f.observeFn
	f.mu.Unlock()
	f.record("observe %s %s %dx%d", session, pane, cols, rows)
	if fn != nil {
		if err := fn(n); err != nil {
			f.mu.Lock()
			f.obs = append(f.obs, nil)
			f.mu.Unlock()
			return nil, err
		}
	}
	o := &fakeObs{pane: pane, cols: cols, rows: rows, frames: make(chan herdr.Frame), done: make(chan struct{})}
	f.mu.Lock()
	f.obs = append(f.obs, o)
	f.mu.Unlock()
	return o, nil
}

// observer waits for the n-th observer (0-based) to start.
func (f *fakeTerm) observer(t *testing.T, n int) *fakeObs {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		if len(f.obs) > n {
			o := f.obs[n]
			f.mu.Unlock()
			return o
		}
		f.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("observer %d did not start (calls %q)", n, f.Calls())
		}
		time.Sleep(time.Millisecond)
	}
}

func (f *fakeTerm) observers() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.obs)
}

func (f *fakeTerm) ReadPane(_ context.Context, session, pane string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s, ok := f.screens[pane]
	if !ok {
		return "", errors.New("pane not found")
	}
	return s, nil
}

func (f *fakeTerm) setScreen(pane, s string) {
	f.mu.Lock()
	f.screens[pane] = s
	f.mu.Unlock()
}

func (f *fakeTerm) SendKeys(_ context.Context, session, pane string, keys ...string) error {
	f.record("keys %s %s", pane, strings.Join(keys, " "))
	f.mu.Lock()
	on := f.onKeys
	f.mu.Unlock()
	if on != nil {
		on(pane, keys)
	}
	return nil
}

func (f *fakeTerm) SendText(_ context.Context, session, pane, text string) error {
	f.mu.Lock()
	gate := f.textGate
	f.mu.Unlock()
	if gate != nil && strings.HasPrefix(text, "slow") {
		<-gate
	}
	f.record("text %s %q", pane, text)
	return nil
}

func (f *fakeTerm) SendSequence(_ context.Context, session, pane, key string) error {
	f.record("seq %s %s", pane, key)
	return nil
}

func (f *fakeTerm) SubmitPrompt(_ context.Context, session, pane, text string) error {
	f.record("submit %s %q", pane, text)
	f.mu.Lock()
	var err error
	if len(f.submit) > 0 {
		err, f.submit = f.submit[0], f.submit[1:]
	}
	on := f.onPrompt
	f.mu.Unlock()
	if on != nil && err == nil {
		on(pane, "submit")
	}
	return err
}

func (f *fakeTerm) QueuePrompt(_ context.Context, session, pane, text string) error {
	f.record("queue %s %q", pane, text)
	return nil
}

// termBridge is a bridge with a running floor "s" and a fake laptop
// herdr.
type termBridge struct {
	*bridge
	term    *fakeTerm
	workers []world.WorkerObs
}

func startTermBridge(t *testing.T, tweak func(*server.Options), workers ...world.WorkerObs) *termBridge {
	t.Helper()
	ft := newFakeTerm()
	opts := server.Options{Term: ft, FirstFrame: 2 * time.Second, ObserverBackoff: 5 * time.Millisecond,
		QuestionPoll: 20 * time.Millisecond, AnswerTimeout: time.Second, PromptRetryWait: 300 * time.Millisecond,
		PaneSize: func(_ context.Context, socket, pane string) (int, int, bool) {
			if socket != "sock-s" {
				return 0, 0, false
			}
			return 132, 43, true
		}}
	if tweak != nil {
		tweak(&opts)
	}
	tb := &termBridge{bridge: startBridge(t, "", opts), term: ft, workers: workers}
	tb.publishFloor(true)
	// Wait until the hub has the floor, so later snapshots show it.
	probe := tb.connect(proto.Hello{Client: "probe"})
	if len(probe.snapshot().World.Floors) == 0 {
		probe.until(proto.EvFloorUpsert)
	}
	probe.conn.CloseNow()
	return tb
}

func (tb *termBridge) publishFloor(running bool) {
	tb.publish(world.FloorObs{Session: "s", Running: running, Gen: world.NextGen(), Socket: "sock-s", Workers: slices.Clone(tb.workers)})
}

func (tb *termBridge) setStatus(ws, status string) {
	for i := range tb.workers {
		if tb.workers[i].WorkspaceID == ws {
			tb.workers[i].Status = status
		}
	}
	tb.publishFloor(true)
}

func idOf(t *testing.T, snap proto.Snapshot, ws string) string {
	t.Helper()
	for _, w := range snap.World.Workers {
		if w.WorkspaceID == ws {
			return w.ID
		}
	}
	t.Fatalf("no worker %s", ws)
	return ""
}

type frameMsg struct {
	proto.TerminalFrame
	raw []byte
}

// frame reads until the next terminal.frame (skipping events), failing on
// anything else connection-scoped.
func (c *client) frame() frameMsg {
	c.t.Helper()
	for {
		m := c.next()
		switch m.env.T {
		case proto.TTerminalFrame:
			var f frameMsg
			if err := json.Unmarshal(m.raw, &f.TerminalFrame); err != nil {
				c.t.Fatal(err)
			}
			if m.env.Seq != 0 || strings.Contains(string(m.raw), `"seq"`) {
				c.t.Fatalf("a frame with a seq: %s", m.raw)
			}
			f.raw = m.raw
			return f
		case proto.TTerminalClosed, proto.TAck, proto.TError:
			c.t.Fatalf("waiting for a frame, got %s", m.raw)
		}
	}
}

func (c *client) closed() proto.TerminalClosed {
	c.t.Helper()
	for {
		m := c.next()
		switch m.env.T {
		case proto.TTerminalClosed:
			var cl proto.TerminalClosed
			_ = json.Unmarshal(m.raw, &cl)
			return cl
		case proto.TTerminalFrame, proto.TAck, proto.TError:
			c.t.Fatalf("waiting for terminal.closed, got %s", m.raw)
		}
	}
}

func decoded(t *testing.T, f frameMsg) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(f.Data)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func shell(ws string) world.WorkerObs { return worker(ws, "shell-"+ws, "", "unknown") }

func TestWatchStreamsFramesToTheWatcherOnly(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"), shell("w2"))
	c := tb.connect(proto.Hello{Client: "watcher"})
	other := tb.connect(proto.Hello{Client: "other"})
	snap := c.snapshot()
	other.snapshot()
	id := idOf(t, snap, "w1")

	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30})
	var res proto.TerminalWatchResult
	b, _ := json.Marshal(ack.Data)
	_ = json.Unmarshal(b, &res)
	if res != (proto.TerminalWatchResult{Pane: "w1:p1", Cols: 132, Rows: 43}) {
		t.Fatalf("ack = %s (the pane's own size by default)", b)
	}
	o := tb.term.observer(t, 0)
	if o.pane != "w1:p1" || o.cols != 132 || o.rows != 43 {
		t.Fatalf("observer = %+v", o)
	}
	o.push(t, true, "\x1b[2Jhello")
	f := c.frame()
	if f.T != proto.TTerminalFrame || f.ID != id || f.Pane != "w1:p1" || f.N != 1 || !f.Full || f.Cols != 132 || f.Rows != 43 ||
		decoded(t, f) != "\x1b[2Jhello" {
		t.Fatalf("frame = %s", f.raw)
	}
	time.Sleep(40 * time.Millisecond)
	o.push(t, false, " world")
	if f := c.frame(); f.N != 2 || f.Full || decoded(t, f) != " world" {
		t.Fatalf("diff = %s", f.raw)
	}

	// The other connection saw none of it: its next message is the ack of
	// its own command.
	other.mustAck(proto.CmdBuildingCreate, proto.BuildingCreateArgs{Name: "Office"})

	// Watching again restarts the watch with a fresh full frame.
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Cols: 80, Rows: 24})
	o2 := tb.term.observer(t, 1)
	waitFor(t, "the old observer stops", o.closed)
	if o2.cols != 80 || o2.rows != 24 {
		t.Fatalf("second observer = %+v", o2)
	}
	o2.push(t, true, "again")
	if f := c.frame(); f.N != 1 || !f.Full || decoded(t, f) != "again" || f.Cols != 80 {
		t.Fatalf("after a re-watch: %s", f.raw)
	}
	// Unwatch: the observer stops, no terminal.closed, unwatching again is
	// fine.
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	waitFor(t, "the observer stops", o2.closed)
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: "nobody"})

	// Bad args, unknown workers and a worker without a pane.
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 31}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Cols: 39}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Rows: 101}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalWatch, map[string]any{"id": id, "zoom": 2}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: "nobody"}, proto.ErrUnknownWorker)
	tb.workers[1].PaneID = ""
	tb.publishFloor(true)
	c.until(proto.EvWorkerUpsert)
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: idOf(t, snap, "w2")}, proto.ErrInvalidState)
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

// Diffs arriving faster than fps are concatenated; a full frame replaces
// what is pending.
func TestWatchThrottlesToFps(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 2})
	o := tb.term.observer(t, 0)
	start := time.Now()
	o.push(t, true, "A")
	if f := c.frame(); decoded(t, f) != "A" || !f.Full {
		t.Fatalf("first = %s", f.raw)
	}
	o.push(t, false, "b")
	o.push(t, false, "c")
	o.push(t, false, "d")
	f := c.frame()
	if took := time.Since(start); took < 400*time.Millisecond {
		t.Fatalf("second frame after %s at 2 fps", took)
	}
	if f.N != 2 || f.Full || decoded(t, f) != "bcd" {
		t.Fatalf("merged diffs = %s", f.raw)
	}
	o.push(t, false, "e")
	o.push(t, true, "F")
	o.push(t, false, "g")
	if f := c.frame(); f.N != 3 || !f.Full || decoded(t, f) != "Fg" {
		t.Fatalf("full replacing pending = %s", f.raw)
	}
}

// directClient is a hub client read by the test itself (no WebSocket), so
// its queue fills up when the test stops reading.
type directClient struct {
	t      *testing.T
	hub    *server.Hub
	c      *server.Client
	mu     sync.Mutex
	kicked error
	n      int
}

func (b *bridge) direct(t *testing.T) *directClient {
	d := &directClient{t: t, hub: b.hub}
	d.c = b.hub.NewClient("direct", func(err error) { d.mu.Lock(); d.kicked = err; d.mu.Unlock() })
	if err := b.hub.Join(context.Background(), d.c, proto.Hello{Proto: 1, Client: "direct"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.hub.Leave(d.c) })
	return d
}

func (d *directClient) read() (proto.Envelope, []byte) {
	d.t.Helper()
	select {
	case raw := <-d.c.Send():
		var env proto.Envelope
		_ = json.Unmarshal(raw, &env)
		return env, raw
	case <-time.After(5 * time.Second):
		d.t.Fatal("nothing to read")
		return proto.Envelope{}, nil
	}
}

func (d *directClient) command(typ string, args any) []byte {
	d.t.Helper()
	d.n++
	raw, _ := json.Marshal(args)
	req := fmt.Sprintf("%s-%d", typ, d.n)
	if err := d.hub.Command(context.Background(), d.c, proto.Command{T: typ, ReqID: req, Args: raw}); err != nil {
		d.t.Fatal(err)
	}
	for {
		env, raw := d.read()
		if env.ReqID == req {
			return raw
		}
	}
}

func (d *directClient) drain() (frames []proto.TerminalFrame) {
	for {
		select {
		case raw := <-d.c.Send():
			var f proto.TerminalFrame
			if json.Unmarshal(raw, &f) == nil && f.T == proto.TTerminalFrame {
				frames = append(frames, f)
			}
		default:
			return frames
		}
	}
}

func (d *directClient) wasKicked() error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.kicked
}

// A watcher whose queue is over half full is never disconnected as a slow
// consumer for its frames: the watch drops what is pending and resyncs
// (a new observer, a full frame) once there is room again. Diffs piling
// up past 512 KiB resync the same way.
func TestWatchResyncsInsteadOfOverflowing(t *testing.T) {
	tb := startTermBridge(t, func(o *server.Options) { o.Queue = 16 }, shell("w1"))
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
	for id == "" { // the floor came after the join
		var ev proto.Event
		if _, raw := d.read(); json.Unmarshal(raw, &ev) == nil && ev.T == proto.EvWorkerUpsert {
			id = ev.Worker.ID
		}
	}
	if ack := d.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 30}); !strings.Contains(string(ack), `"ack"`) {
		t.Fatalf("watch: %s", ack)
	}
	o := tb.term.observer(t, 0)
	o.push(t, true, "full")
	// Not reading: frames fill the queue to half, then the watch resyncs.
	for i := 0; tb.term.observers() == 1 && !o.closed(); i++ {
		time.Sleep(35 * time.Millisecond)
		select {
		case o.frames <- herdr.Frame{Width: 120, Height: 40, Data: []byte(fmt.Sprintf("d%d", i))}:
		case <-o.done:
		}
		if i > 200 {
			t.Fatal("the watch never resynced")
		}
	}
	waitFor(t, "the first observer stops", o.closed)
	time.Sleep(50 * time.Millisecond)
	if n := tb.term.observers(); n != 1 {
		t.Fatalf("%d observers while the queue is full: it waits for room first", n)
	}
	if err := d.wasKicked(); err != nil {
		t.Fatalf("kicked: %v", err)
	}
	frames := d.drain()
	if len(frames) < 8 || len(frames) > 9 || !frames[0].Full {
		t.Fatalf("%d frames queued (queue 16)", len(frames))
	}
	// Room again: a new observer and a fresh full frame, numbered on.
	o2 := tb.term.observer(t, 1)
	o2.push(t, true, "fresh")
	var f proto.TerminalFrame
	for f.T != proto.TTerminalFrame {
		_, raw := d.read()
		_ = json.Unmarshal(raw, &f)
	}
	if !f.Full || f.N != uint64(len(frames)+1) {
		t.Fatalf("after the resync: %+v", f)
	}

	// Over 512 KiB of diffs inside one frame interval: resync. (The
	// first diff may go out with the full frame before it.)
	d.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fps: 1})
	o3 := tb.term.observer(t, 2)
	o3.push(t, true, "x")
	chunk := strings.Repeat("y", 100<<10)
	for i := 0; i < 7 && !o3.closed(); i++ {
		select {
		case o3.frames <- herdr.Frame{Width: 120, Height: 40, Data: []byte(chunk)}:
		case <-o3.done:
		}
	}
	waitFor(t, "the observer resyncs", o3.closed)
	tb.term.observer(t, 3)
	if err := d.wasKicked(); err != nil {
		t.Fatalf("kicked: %v", err)
	}
}

// An observer that exits or sends nothing is restarted with backoff, at
// most 3 times in 30 s; then the watch ends with observer_failed.
func TestWatchRestartsObserversWithBackoff(t *testing.T) {
	tb := startTermBridge(t, func(o *server.Options) {
		o.FirstFrame = 50 * time.Millisecond
		o.ObserverBackoff = 20 * time.Millisecond
	},
		shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
	var starts []time.Time
	o := tb.term.observer(t, 0)
	starts = append(starts, time.Now())
	o.push(t, true, "one")
	c.frame()
	o.end() // exits
	o = tb.term.observer(t, 1)
	starts = append(starts, time.Now())
	o.push(t, true, "two")
	if f := c.frame(); !f.Full || decoded(t, f) != "two" || f.N != 2 {
		t.Fatalf("after a restart: %s", f.raw)
	}
	// This one never sends a frame: stalled.
	o.end()
	tb.term.observer(t, 2)
	starts = append(starts, time.Now())
	tb.term.observer(t, 3) // the stall is noticed after FirstFrame
	starts = append(starts, time.Now())
	if cl := c.closed(); cl.ID != id || cl.Reason != proto.ClosedObserverFailed {
		t.Fatalf("closed = %+v", cl)
	}
	if n := tb.term.observers(); n != 4 {
		t.Fatalf("%d observers, want 1 + 3 restarts", n)
	}
	for i, want := range []time.Duration{20 * time.Millisecond, 40 * time.Millisecond, 80 * time.Millisecond} {
		if gap := starts[i+1].Sub(starts[i]); gap < want {
			t.Errorf("restart %d after %s, want at least %s", i+1, gap, want)
		}
	}
	for i := range 4 {
		waitFor(t, "every observer stopped", tb.term.observer(t, i).closed)
	}
	// The watch is gone: it can be started again.
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
	tb.term.observer(t, 4)
}

// A watch ends with terminal.closed when its worker leaves, its floor
// falls asleep or its pane changes; closing the connection stops the rest.
func TestWatchEndsWithItsWorker(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"), shell("w2"), shell("w3"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	ids := []string{idOf(t, snap, "w1"), idOf(t, snap, "w2"), idOf(t, snap, "w3")}
	for i, id := range ids {
		c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
		tb.term.observer(t, i).push(t, true, "x")
		c.frame()
	}
	// w2's primary pane changes.
	tb.workers[1].PaneID = "w2:p2"
	tb.publishFloor(true)
	if cl := c.closed(); cl.ID != ids[1] || cl.Reason != proto.ClosedPaneChanged {
		t.Fatalf("pane change: %+v", cl)
	}
	// w1's workspace closes.
	tb.workers = tb.workers[1:]
	tb.publishFloor(true)
	if cl := c.closed(); cl.ID != ids[0] || cl.Reason != proto.ClosedWorkerRemoved {
		t.Fatalf("worker gone: %+v", cl)
	}
	// The floor falls asleep.
	tb.publishFloor(false)
	if cl := c.closed(); cl.ID != ids[2] || cl.Reason != proto.ClosedAsleep {
		t.Fatalf("asleep: %+v", cl)
	}
	for i := range 3 {
		waitFor(t, "every observer stopped", tb.term.observer(t, i).closed)
	}
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: ids[2]}, proto.ErrInvalidState)

	// A connection that goes away mid-watch stops its observer.
	tb.publishFloor(true)
	c2 := tb.connect(proto.Hello{})
	c2.snapshot()
	c2.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: ids[2]})
	o := tb.term.observer(t, 3)
	c2.conn.CloseNow()
	waitFor(t, "the observer stops with the connection", o.closed)

	// And a bridge shutdown stops them all.
	c3 := tb.connect(proto.Hello{})
	c3.snapshot()
	c3.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: ids[2]})
	o = tb.term.observer(t, 4)
	tb.stop()
	if !o.closed() {
		t.Fatal("an observer outlived the bridge")
	}
}

func TestWatchCaps(t *testing.T) {
	var ws []world.WorkerObs
	for i := 1; i <= 5; i++ {
		ws = append(ws, shell(fmt.Sprintf("w%d", i)))
	}
	tb := startTermBridge(t, func(o *server.Options) { o.MaxWatches = 2; o.MaxObservers = 3 }, ws...)
	c1, c2 := tb.connect(proto.Hello{}), tb.connect(proto.Hello{})
	snap := c1.snapshot()
	c2.snapshot()
	id := func(i int) string { return idOf(t, snap, fmt.Sprintf("w%d", i)) }
	c1.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(1)})
	c1.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(2)})
	c1.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(3)}, proto.ErrCapacity) // --max-watches
	c1.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(2)})                      // a re-watch is no new one
	c2.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(3)})
	c2.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(4)}, proto.ErrCapacity) // --max-observers
	c1.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id(1)})
	c2.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id(4)})

	// Every watch command is audited.
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range log {
		if strings.HasPrefix(e.Cmd, "terminal.") {
			n++
		}
	}
	if n != 8 {
		t.Fatalf("%d terminal.* audit rows, want 8", n)
	}
}

// slowStopTerm is a laptop herdr whose observers take a while to stop (as
// herdr's do: SIGTERM, SIGKILL after 1 s), counting those alive.
type slowStopTerm struct {
	*fakeTerm
	stop         time.Duration
	mu           sync.Mutex
	alive, peak  int
	stoppedTotal int
}

type slowStopObs struct {
	herdr.FrameStream
	term *slowStopTerm
}

func (s *slowStopTerm) Observe(ctx context.Context, session, pane string, cols, rows int) (herdr.FrameStream, error) {
	o, err := s.fakeTerm.Observe(ctx, session, pane, cols, rows)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.alive++
	s.peak = max(s.peak, s.alive)
	s.mu.Unlock()
	return &slowStopObs{FrameStream: o, term: s}, nil
}

func (o *slowStopObs) Close() error {
	time.Sleep(o.term.stop)
	err := o.FrameStream.Close()
	o.term.mu.Lock()
	o.term.alive--
	o.term.stoppedTotal++
	o.term.mu.Unlock()
	return err
}

func (s *slowStopTerm) counts() (peak, stopped int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.peak, s.stoppedTotal
}

// An observer that is stopping still holds its slot until it is reaped: a
// re-watch, or a watch right after an unwatch, waits for it instead of
// running more observers than --max-observers / --max-watches.
func TestStoppingObserversHoldTheirSlot(t *testing.T) {
	for _, caps := range []struct {
		name                   string
		maxWatches, maxObsvers int
	}{{"max-observers", 6, 1}, {"max-watches", 1, 16}} {
		t.Run(caps.name, func(t *testing.T) {
			var st *slowStopTerm
			tb := startTermBridge(t, func(o *server.Options) {
				st = &slowStopTerm{fakeTerm: o.Term.(*fakeTerm), stop: 150 * time.Millisecond}
				o.Term, o.MaxWatches, o.MaxObservers = st, caps.maxWatches, caps.maxObsvers
			}, shell("w1"), shell("w2"))
			c := tb.connect(proto.Hello{})
			snap := c.snapshot()
			id1, id2 := idOf(t, snap, "w1"), idOf(t, snap, "w2")
			c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id1})
			tb.term.observer(t, 0).push(t, true, "one")
			c.frame()

			// A re-watch: the old observer stops first.
			c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id1})
			if _, stopped := st.counts(); stopped != 1 {
				t.Fatalf("re-watch acked with %d observers stopped, want the old one reaped first", stopped)
			}
			tb.term.observer(t, 1).push(t, true, "again")
			if f := c.frame(); !f.Full || decoded(t, f) != "again" {
				t.Fatalf("after the re-watch: %+v", f)
			}
			// Unwatch, then watch another worker at once.
			c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id1})
			c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id2})
			tb.term.observer(t, 2).push(t, true, "two")
			if f := c.frame(); !f.Full || decoded(t, f) != "two" {
				t.Fatalf("after the unwatch: %+v", f)
			}
			if peak, _ := st.counts(); peak > 1 {
				t.Fatalf("%d observers alive at once, the cap is 1", peak)
			}
		})
	}
}

func TestWatchStartFailure(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"))
	tb.term.observeFn = func(n int) error {
		if n == 0 {
			return errors.New("no herdr")
		}
		return nil
	}
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id}, proto.ErrInternal)
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
}
