package server_test

// #74: the fullscreen laptop. A fake herdr floor keeps the tabs' zoom state
// the way herdr 0.9.0 reports it: the panes' split rectangles never change,
// `zoomed` and the focused pane do.

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// fakeTab is one tab of the fake floor: a workspace's.
type fakeTab struct {
	panes       int
	zoomed      bool
	focused     string
	area, split herdr.Rect
}

type zoomFloor struct {
	mu    sync.Mutex
	tabs  map[string]*fakeTab // by workspace id
	calls []string
	fail  error
}

func newZoomFloor() *zoomFloor { return &zoomFloor{tabs: map[string]*fakeTab{}} }

// splitTab makes workspace ws a tab of two panes: the worker's pane on the
// left (67 × 49 of a 134 × 49 area), unzoomed, the other pane focused.
func (f *zoomFloor) splitTab(ws string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tabs[ws] = &fakeTab{panes: 2, focused: ws + ":p2", area: herdr.Rect{Width: 134, Height: 49}, split: herdr.Rect{Width: 67, Height: 49}}
}

func (f *zoomFloor) singleTab(ws string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tabs[ws] = &fakeTab{panes: 1, focused: ws + ":p1", area: herdr.Rect{Width: 134, Height: 49}, split: herdr.Rect{Width: 134, Height: 49}}
}

func (f *zoomFloor) with(ws string, fn func(*fakeTab)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f.tabs[ws])
}

func (f *zoomFloor) zoomed(ws string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tabs[ws].zoomed
}

func (f *zoomFloor) writes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// state is Options.PaneState: PaneState of the snapshot herdr would give.
func (f *zoomFloor) state(_ context.Context, socket, pane string) (herdr.PaneState, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ws, _, _ := strings.Cut(pane, ":")
	t := f.tabs[ws]
	if t == nil || socket != "sock-s" {
		return herdr.PaneState{}, false
	}
	l := herdr.LayoutInfo{TabID: ws + ":t1", Zoomed: t.zoomed, FocusedPaneID: t.focused, Area: t.area}
	for i := 1; i <= t.panes; i++ {
		l.Panes = append(l.Panes, herdr.LayoutPane{PaneID: ws + ":p" + string(rune('0'+i)), Rect: t.split})
	}
	return (&herdr.Snapshot{Layouts: []herdr.LayoutInfo{l}}).PaneState(pane)
}

// zoomTerm is a fakeTerm that can zoom.
type zoomTerm struct {
	*fakeTerm
	floor *zoomFloor
}

func (z *zoomTerm) SetZoom(_ context.Context, session, pane string, on bool) error {
	f := z.floor
	f.mu.Lock()
	defer f.mu.Unlock()
	mode := map[bool]string{true: "on", false: "off"}[on]
	f.calls = append(f.calls, mode+" "+pane)
	if f.fail != nil {
		return f.fail
	}
	ws, _, _ := strings.Cut(pane, ":")
	t := f.tabs[ws]
	if t.panes > 1 {
		t.zoomed = on
		if on {
			t.focused = pane
		}
	}
	return nil
}

func startZoomBridge(t *testing.T, floor *zoomFloor, workers ...string) *termBridge {
	t.Helper()
	ft := newFakeTerm()
	var tb *termBridge
	tb = startTermBridge(t, func(o *server.Options) {
		o.Term = &zoomTerm{fakeTerm: ft, floor: floor}
		o.PaneState = floor.state
		o.ZoomPoll = 15 * time.Millisecond
	}, shell("w1"), shell("w2"))
	tb.term = ft
	return tb
}

func watchResult(t *testing.T, ack proto.Ack) proto.TerminalWatchResult {
	t.Helper()
	var res proto.TerminalWatchResult
	b, _ := json.Marshal(ack.Data)
	if err := json.Unmarshal(b, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func (c *client) state() proto.TerminalState {
	c.t.Helper()
	for {
		m := c.next()
		switch m.env.T {
		case proto.TTerminalState:
			var s proto.TerminalState
			if err := json.Unmarshal(m.raw, &s); err != nil {
				c.t.Fatal(err)
			}
			if m.env.Seq != 0 {
				c.t.Fatalf("a state with a seq: %s", m.raw)
			}
			return s
		case proto.TAck, proto.TError, proto.TTerminalClosed:
			c.t.Fatalf("waiting for a terminal.state, got %s", m.raw)
		}
	}
}

func zoomAudit(t *testing.T, tb *termBridge) (rows []string) {
	t.Helper()
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if e.Cmd == "pane.zoom" {
			if !e.OK {
				rows = append(rows, "failed "+e.Args)
			} else {
				rows = append(rows, e.Args)
			}
		}
	}
	return rows
}

func TestFullscreenWatchZoomsASplitPaneAndPutsItBack(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{Client: "seat"})
	id := idOf(t, c.snapshot(), "w1")

	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	res := watchResult(t, ack)
	if res.Cols != 134 || res.Rows != 49 || res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "zoomed", Applied: true}) {
		t.Fatalf("ack = %+v zoom %+v: the whole tab area, zoomed by the bridge", res, res.Zoom)
	}
	if o := tb.term.observer(t, 0); o.cols != 134 || o.rows != 49 {
		t.Fatalf("observer = %dx%d, want the zoomed tab's area", o.cols, o.rows)
	}
	if !floor.zoomed("w1") || !slices.Equal(floor.writes(), []string{"on w1:p1"}) {
		t.Fatalf("writes = %q", floor.writes())
	}

	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	waitFor(t, "the tab is put back", func() bool { return !floor.zoomed("w1") })
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1", "off w1:p1"}) {
		t.Fatalf("writes = %q", w)
	}
	rows := zoomAudit(t, tb)
	if len(rows) != 2 || !strings.Contains(rows[0], `"mode":"on"`) || !strings.Contains(rows[0], `"why":"watch"`) ||
		!strings.Contains(rows[1], `"mode":"off"`) || !strings.Contains(rows[1], `"why":"stand-up"`) ||
		!strings.Contains(rows[0], `"pane":"w1:p1"`) || !strings.Contains(rows[0], `"session":"s"`) {
		t.Fatalf("zoom audit rows = %q: one per write", rows)
	}
}

// A connection that drops stands up too.
func TestFullscreenWatchIsPutBackWhenTheConnectionDrops(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	c.conn.CloseNow()
	waitFor(t, "the tab is put back", func() bool { return !floor.zoomed("w1") })
}

// The bridge stopping stands up too.
func TestFullscreenWatchIsPutBackWhenTheBridgeStops(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	if !floor.zoomed("w1") {
		t.Fatal("not zoomed")
	}
	tb.stop()
	if floor.zoomed("w1") {
		t.Fatalf("still zoomed after the bridge stopped (writes %q)", floor.writes())
	}
}

func TestWatchWithoutFullscreenNeverZooms(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")

	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
	res := watchResult(t, ack)
	if res.Cols != 67 || res.Rows != 49 || res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "split"}) {
		t.Fatalf("ack = %+v zoom %+v: the split pane's own size", res, res.Zoom)
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	time.Sleep(60 * time.Millisecond)
	if w := floor.writes(); len(w) != 0 {
		t.Fatalf("writes = %q, want none without fullscreen", w)
	}
	// A client that does not follow is never sent a state, whatever changes.
	floor.with("w1", func(t *fakeTab) { t.zoomed, t.focused = true, "w1:p1" })
}

func TestFullscreenOfASinglePaneTabZoomsNothing(t *testing.T) {
	floor := newZoomFloor()
	floor.singleTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	res := watchResult(t, ack)
	if res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "single"}) || res.Cols != 134 {
		t.Fatalf("ack = %+v zoom %+v", res, res.Zoom)
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	time.Sleep(60 * time.Millisecond)
	if w := floor.writes(); len(w) != 0 {
		t.Fatalf("writes = %q", w)
	}
}

// A tab the human zoomed on the pane already is not the bridge's: no call
// at all, and it stays as it was.
func TestFullscreenKeepsATabTheHumanZoomed(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	floor.with("w1", func(t *fakeTab) { t.zoomed, t.focused = true, "w1:p1" })
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	res := watchResult(t, ack)
	if res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "zoomed"}) || res.Cols != 134 {
		t.Fatalf("ack = %+v zoom %+v: zoomed, not by the bridge", res, res.Zoom)
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	time.Sleep(60 * time.Millisecond)
	if w := floor.writes(); len(w) != 0 || !floor.zoomed("w1") {
		t.Fatalf("writes = %q, zoomed %v: a tab the bridge did not zoom is left alone", w, floor.zoomed("w1"))
	}
}

// The human unzooms while seated: the laptop is told and the observer
// starts over at the pane's own size, the bridge does not zoom again, and
// standing up leaves the tab alone.
func TestHumanUnzoomWhileSeatedIsReportedAndNotUndone(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	o := tb.term.observer(t, 0)
	o.push(t, true, "full")
	c.frame()

	floor.with("w1", func(t *fakeTab) { t.zoomed = false })
	st := c.state()
	if st.ID != id || st.Pane != "w1:p1" || st.Cols != 67 || st.Rows != 49 || st.Zoom != (proto.ZoomInfo{State: "split"}) {
		t.Fatalf("state = %+v", st)
	}
	o2 := tb.term.observer(t, 1)
	waitFor(t, "the first observer stops", o.closed)
	if o2.cols != 67 || o2.rows != 49 {
		t.Fatalf("observer after the unzoom = %dx%d", o2.cols, o2.rows)
	}
	// The human zooms it back themselves, on the pane: the laptop hears of
	// that too, but it is not the bridge's zoom.
	floor.with("w1", func(t *fakeTab) { t.zoomed, t.focused = true, "w1:p1" })
	if st := c.state(); st.Zoom != (proto.ZoomInfo{State: "zoomed"}) || st.Cols != 134 {
		t.Fatalf("state after the human zoomed = %+v", st)
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	time.Sleep(60 * time.Millisecond)
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1"}) || !floor.zoomed("w1") {
		t.Fatalf("writes = %q, zoomed %v", w, floor.zoomed("w1"))
	}
}

// Focus moving to another pane while seated shows as a split.
func TestFocusMovingAwayIsReported(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	floor.with("w1", func(t *fakeTab) { t.focused = "w1:p2" })
	if st := c.state(); st.Zoom.State != "split" || st.Zoom.Applied || st.Cols != 67 {
		t.Fatalf("state = %+v", st)
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	waitFor(t, "the tab is put back", func() bool { return !floor.zoomed("w1") })
}

// An explicit size of the client is its own: the pane changing does not
// resize the observer.
func TestExplicitSizeIsNotResized(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Cols: 100, Rows: 30, Fullscreen: true})
	floor.with("w1", func(t *fakeTab) { t.zoomed = false })
	if st := c.state(); st.Cols != 100 || st.Rows != 30 || st.Zoom.State != "split" {
		t.Fatalf("state = %+v", st)
	}
	time.Sleep(80 * time.Millisecond)
	if n := tb.term.observers(); n != 1 {
		t.Fatalf("%d observers, want the one the client sized", n)
	}
}

func TestTwoFullscreenWatchersOfATabShareTheZoom(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	a := tb.connect(proto.Hello{Client: "a"})
	b := tb.connect(proto.Hello{Client: "b"})
	id := idOf(t, a.snapshot(), "w1")
	b.snapshot()
	a.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	_, ack := b.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	if res := watchResult(t, ack); res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "zoomed", Applied: true}) {
		t.Fatalf("second watcher ack zoom = %+v: the tab is the bridge's", res.Zoom)
	}
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1"}) {
		t.Fatalf("writes = %q: the second watch finds it zoomed", w)
	}
	a.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	time.Sleep(80 * time.Millisecond)
	if !floor.zoomed("w1") {
		t.Fatal("put back while another laptop still sits there")
	}
	b.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	waitFor(t, "the tab is put back", func() bool { return !floor.zoomed("w1") })
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1", "off w1:p1"}) {
		t.Fatalf("writes = %q", w)
	}
}

// A re-watch (the game does it after a gap) does not put the tab back and
// zoom it again.
func TestRewatchKeepsTheZoom(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	for range 3 {
		_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
		if res := watchResult(t, ack); res.Zoom == nil || !res.Zoom.Applied {
			t.Fatalf("ack zoom = %+v", res.Zoom)
		}
	}
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1"}) {
		t.Fatalf("writes = %q, want the one zoom", w)
	}
	// Watching again without fullscreen is standing up from it.
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
	waitFor(t, "the tab is put back", func() bool { return !floor.zoomed("w1") })
}

func TestFailedZoomNeverFailsTheWatch(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	floor.fail = errors.New("herdr: boom")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	res := watchResult(t, ack)
	if res.Cols != 67 || res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "split"}) {
		t.Fatalf("ack = %+v zoom %+v: the best known size", res, res.Zoom)
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	time.Sleep(60 * time.Millisecond)
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1"}) {
		t.Fatalf("writes = %q: nothing to put back", w)
	}
	if rows := zoomAudit(t, tb); len(rows) != 1 || !strings.HasPrefix(rows[0], "failed ") {
		t.Fatalf("audit = %q: the failed write has its row", rows)
	}
}

// A watch whose session is asleep has nothing to put back through.
func TestAsleepSessionIsNotZoomedBack(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	tb.publishFloor(false)
	if cl := c.closed(); cl.Reason != proto.ClosedAsleep {
		t.Fatalf("closed = %+v", cl)
	}
	time.Sleep(80 * time.Millisecond)
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1"}) {
		t.Fatalf("writes = %q: no zoom call to a stopped session", w)
	}
}

func TestTerminalZoomCommand(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	yes, no := true, false

	// Not watching, no "on", unknown workers.
	c.mustError(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id, On: &yes}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: "nobody", On: &yes}, proto.ErrUnknownWorker)
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id}) // no fullscreen
	c.mustError(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalZoom, map[string]any{"id": id, "on": "yes"}, proto.ErrBadRequest)
	c.mustError(proto.CmdTerminalZoom, map[string]any{"id": id, "on": true, "toggle": true}, proto.ErrBadRequest)
	o := tb.term.observer(t, 0)
	if o.cols != 67 {
		t.Fatalf("observer = %dx%d", o.cols, o.rows)
	}

	// On: zoomed by the bridge, the observer follows.
	_, ack := c.mustAck(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id, On: &yes})
	res := watchResult(t, ack)
	if res.Pane != "w1:p1" || res.Cols != 134 || res.Rows != 49 || res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "zoomed", Applied: true}) {
		t.Fatalf("zoom on = %+v zoom %+v", res, res.Zoom)
	}
	o2 := tb.term.observer(t, 1)
	if o2.cols != 134 || o2.rows != 49 {
		t.Fatalf("observer after the zoom = %dx%d", o2.cols, o2.rows)
	}
	o2.push(t, true, "wide")
	if f := c.frame(); f.Cols != 134 || !f.Full {
		t.Fatalf("frame = %s", f.raw)
	}

	// Off: back to the split, and the bridge owns nothing any more.
	_, ack = c.mustAck(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id, On: &no})
	res = watchResult(t, ack)
	if res.Cols != 67 || res.Zoom == nil || *res.Zoom != (proto.ZoomInfo{State: "split"}) || floor.zoomed("w1") {
		t.Fatalf("zoom off = %+v zoom %+v", res, res.Zoom)
	}
	tb.term.observer(t, 2)
	if w := floor.writes(); !slices.Equal(w, []string{"on w1:p1", "off w1:p1"}) {
		t.Fatalf("writes = %q", w)
	}
	// Zoomed off is an explicit act: it also puts back what the human
	// zoomed.
	floor.with("w1", func(t *fakeTab) { t.zoomed, t.focused = true, "w1:p1" })
	c.mustAck(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id, On: &no})
	if floor.zoomed("w1") {
		t.Fatal("terminal.zoom off left the human's zoom")
	}
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})

	rows := zoomAudit(t, tb)
	if len(rows) != 3 || !strings.Contains(rows[0], `"why":"command"`) {
		t.Fatalf("zoom audit = %q", rows)
	}
	log, _ := tb.st.AuditLog(context.Background())
	n := 0
	for _, e := range log {
		if e.Cmd == proto.CmdTerminalZoom {
			n++
		}
	}
	if n < 3 {
		t.Fatalf("%d terminal.zoom audit rows", n)
	}
}

// terminal.zoom on takes the zoom for the watch: standing up puts it back.
func TestTerminalZoomOnIsPutBackOnStandUp(t *testing.T) {
	floor := newZoomFloor()
	floor.splitTab("w1")
	tb := startZoomBridge(t, floor)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	yes := true
	c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id})
	c.mustAck(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id, On: &yes})
	c.mustAck(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: id})
	waitFor(t, "the tab is put back", func() bool { return !floor.zoomed("w1") })
}

// Without a Zoomer (or a PaneState) the bridge says so and never fails a
// watch.
func TestFullscreenWithoutZoomSupport(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, ack := c.mustAck(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Fullscreen: true})
	if res := watchResult(t, ack); res.Zoom != nil || res.Cols != 132 {
		t.Fatalf("ack = %+v zoom %+v", res, res.Zoom)
	}
	yes := true
	c.mustError(proto.CmdTerminalZoom, proto.TerminalZoomArgs{ID: id, On: &yes}, proto.ErrInternal)
}
