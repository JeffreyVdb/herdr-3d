package server

// #176: the seated laptop owns its pane. A terminal.watch with control runs
// herdr's terminal controller (`terminal session control`, never
// --takeover) instead of an observer: the same frames, through the same
// pump and caps, and the real PTY at the client's size. terminal.resize
// resizes it, terminal.scroll scrolls herdr's history (the offset comes
// back as terminal.history), and any input to the worker first brings the
// view back to the live bottom. herdr refusing the controller (another
// client owns the pane) makes the watch a read-only observer for good,
// which terminal.control says. Every way a watch ends releases the pane.

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TermController is what the hub needs from herdr to own a pane:
// *herdr.Control. A Term that is not one never controls (a control watch
// observes, as before #176).
type TermController interface {
	ControlTerminal(ctx context.Context, session, pane string, cols, rows int) (herdr.ControlStream, error)
}

const (
	// DefaultHistoryPoll is how often a controlled view above the live bottom
	// has its offset read again (new output moves it further up).
	DefaultHistoryPoll = time.Second
	// historySettle is how long after a scroll the offset is read: herdr has
	// applied the scroll by then.
	historySettle = 80 * time.Millisecond
	// After a scroll the offset is read historyBurst times, historyBurstGap
	// apart (a wheel's lines may land over several of herdr's ticks).
	historyBurst    = 4
	historyBurstGap = 150 * time.Millisecond
	// historyCallTimeout bounds one pane.get.
	historyCallTimeout = 2 * time.Second
)

// ctlWatch is a control watch's state, under termWatches.mu.
type ctlWatch struct {
	// mode is "" until the controller's first frame, then proto.ControlOwned,
	// or proto.ControlReadOnly (with reason) once it fell back; modeSent is
	// the mode last queued to the connection.
	mode, reason, modeSent string
	cols, rows             int // the size of the frames from now on (the mode message's)
	stream                 herdr.ControlStream
	// The PTY size the client asked for, and its cell size in pixels.
	want         [2]int
	cellW, cellH int
	// restore is the pane's size before the watch's first controller
	// attached (the session's snapshot), set back before each release: with no
	// herdr TUI attached herdr leaves the PTY at the controller's last size.
	restore  [2]int
	hist     herdr.PaneScroll // as last read
	histSent bool             // hist was queued to the connection
	poke     chan struct{}    // (cap 1) read the offset soon
}

// ctlProc is one running controller, until it is released and reaped.
type ctlProc struct {
	w    *watch
	done chan struct{}
}

func (h *Hub) controller() TermController {
	c, _ := h.opts.Term.(TermController)
	return c
}

// controls reports whether the connection has a control watch of another
// worker (at most one per connection).
func (t *termWatches) controls(c *Client, except string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for id, w := range t.byC[c] {
		if id != except && w.control && !w.stopped && strings.HasPrefix(id, "mp:") == strings.HasPrefix(except, "mp:") {
			return true
		}
	}
	return false
}

// wantsControl reports whether the watch should run a controller next: it
// asked for one and has not fallen back to observing.
func (t *termWatches) wantsControl(w *watch) bool {
	if !w.control {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return w.ctl.mode != proto.ControlReadOnly
}

// ctlSize sets the size a control watch's controller starts at, unless the
// client asked for one already (a terminal.resize before the watch ran).
func (h *Hub) ctlSize(w *watch, cols, rows int) {
	h.term.mu.Lock()
	defer h.term.mu.Unlock()
	if w.ctl.want[0] == 0 {
		w.ctl.want = [2]int{cols, rows}
	}
}

// ctlGrid is the size and cell size the client asked for.
func (t *termWatches) ctlGrid(w *watch) (cols, rows, cellW, cellH int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return w.ctl.want[0], w.ctl.want[1], w.ctl.cellW, w.ctl.cellH
}

// startController starts a control watch's controller once its slot is free
// and the worker's controllers whose watches ended are gone (a new one would
// be refused for them), at the size the client asked for.
func (h *Hub) startController(ctx context.Context, w *watch) (herdr.ControlStream, error) {
	h.term.awaitReleased(ctx, w, observerSlotWait)
	if err := h.term.acquire(ctx, w.c, h.opts.MaxWatches, h.opts.MaxObservers, observerSlotWait); err != nil {
		return nil, err
	}
	h.term.mu.Lock()
	restore := w.ctl.restore
	h.term.mu.Unlock()
	if restore[0] == 0 {
		if st, ok := h.paneState(ctx, w.socket, w.pane); ok && st.Cols > 0 && st.Rows > 0 {
			restore = [2]int{min(max(st.Cols, herdr.MinCols), herdr.MaxCols), min(max(st.Rows, herdr.MinRows), herdr.MaxRows)}
			h.term.mu.Lock()
			w.ctl.restore = restore
			h.term.mu.Unlock()
		}
	}
	cols, rows, cw, ch := h.term.ctlGrid(w)
	cs, err := h.controller().ControlTerminal(ctx, w.session, w.pane, cols, rows)
	if err != nil {
		h.term.release(w.c)
		return nil, err
	}
	if cw > 0 || ch > 0 { // herdr's attach takes no cell size: a resize tells it
		_ = cs.Resize(cols, rows, cw, ch)
	}
	if restore[0] > 0 {
		cs.RestoreOnRelease(restore[0], restore[1])
	}
	w.cols, w.rows = cols, rows
	h.zoomSize(w, cols, rows)
	h.term.mu.Lock()
	w.ctl.stream = cs
	m := h.term.ctlProcs[w.id]
	if m == nil {
		m = map[*ctlProc]struct{}{}
		h.term.ctlProcs[w.id] = m
	}
	m[&ctlProc{w: w, done: make(chan struct{})}] = struct{}{}
	h.term.mu.Unlock()
	return cs, nil
}

// stopController releases a controller and waits for it to be reaped; the
// worker's next controller may start then.
func (h *Hub) stopController(w *watch, cs herdr.ControlStream) {
	h.term.mu.Lock()
	if w.ctl.stream == cs {
		w.ctl.stream = nil
	}
	h.term.mu.Unlock()
	if err := cs.Close(); err != nil {
		h.log.Warn("seated terminal not released", "client", w.c.name, "worker", w.id, "pane", w.pane, "err", err)
	}
	h.term.mu.Lock()
	defer h.term.mu.Unlock()
	for p := range h.term.ctlProcs[w.id] {
		if p.w == w {
			delete(h.term.ctlProcs[w.id], p)
			close(p.done)
		}
	}
	if len(h.term.ctlProcs[w.id]) == 0 {
		delete(h.term.ctlProcs, w.id)
	}
}

// awaitReleased waits, up to wait, for the controllers of w's worker whose
// watches ended to be released and reaped. Another live watch's controller
// is not waited for: herdr refuses the new one, which is the fallback.
func (t *termWatches) awaitReleased(ctx context.Context, w *watch, wait time.Duration) {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		var done chan struct{}
		t.mu.Lock()
		for p := range t.ctlProcs[w.id] {
			if p.w != w && (p.w.stopped || p.w.ctx.Err() != nil) {
				done = p.done
				break
			}
		}
		t.mu.Unlock()
		if done == nil {
			return
		}
		select {
		case <-done:
		case <-ctx.Done():
			return
		case <-timer.C:
			return
		}
	}
}

// controlOwned notes the controller's first full frame: the pane is the
// watch's (terminal.control goes out before that frame).
func (h *Hub) controlOwned(w *watch, cols, rows int) {
	h.term.mu.Lock()
	defer h.term.mu.Unlock()
	if w.ctl.mode == proto.ControlOwned && w.ctl.cols == cols && w.ctl.rows == rows {
		return
	}
	w.ctl.mode, w.ctl.reason, w.ctl.cols, w.ctl.rows = proto.ControlOwned, "", cols, rows
	w.ctl.modeSent = ""
}

// readOnly makes a control watch a read-only observer for good, at the
// pane's own size (an observer does not reflow, so the client's size would
// cut it off) and following it like a watch without one; terminal.control
// says so before its first frame.
func (h *Hub) readOnly(ctx context.Context, w *watch, why string) {
	h.log.Info("seated terminal read only", "client", w.c.name, "worker", w.id, "pane", w.pane, "why", why)
	cols, rows := defaultCols, defaultRows
	if st, ok := h.paneState(ctx, w.socket, w.pane); ok {
		cols, rows = min(max(st.Cols, herdr.MinCols), herdr.MaxCols), min(max(st.Rows, herdr.MinRows), herdr.MaxRows)
	}
	h.zoom.mu.Lock()
	w.autoCols, w.autoRows = true, true
	h.zoom.mu.Unlock()
	w.cols, w.rows = cols, rows
	h.zoomSize(w, cols, rows)
	h.term.mu.Lock()
	w.ctl.mode, w.ctl.reason, w.ctl.cols, w.ctl.rows, w.ctl.modeSent = proto.ControlReadOnly, why, cols, rows, ""
	w.ctl.hist, w.ctl.histSent = herdr.PaneScroll{}, false
	h.term.mu.Unlock()
}

// sendControl queues a control watch's terminal.control when its mode
// changed since it was last queued (under t.mu); false when there was no
// room for it (the frame waits too).
func (t *termWatches) sendControl(w *watch) bool {
	if !w.control || w.ctl.mode == "" || w.ctl.modeSent == w.ctl.mode+w.ctl.reason+fmt.Sprint(w.ctl.cols, w.ctl.rows) {
		return true
	}
	msg := mustJSON(proto.TerminalControl{T: proto.TTerminalControl, ID: w.id, Pane: w.pane, Mode: w.ctl.mode, Reason: w.ctl.reason,
		Cols: w.ctl.cols, Rows: w.ctl.rows})
	select {
	case w.c.send <- msg:
		w.ctl.modeSent = w.ctl.mode + w.ctl.reason + fmt.Sprint(w.ctl.cols, w.ctl.rows)
		return true
	default:
		return false
	}
}

// ownedStream is the running controller of the connection's control watch
// of worker id; errors say why there is none.
func (h *Hub) ownedStream(c *Client, id string) (*watch, herdr.ControlStream, error) {
	w := h.term.get(c, id)
	if w == nil || !w.control {
		return nil, nil, bad("this needs a terminal.watch of the worker with control")
	}
	h.term.mu.Lock()
	defer h.term.mu.Unlock()
	switch {
	case w.ctl.mode == proto.ControlReadOnly:
		return w, nil, fmt.Errorf("%w: another client controls this terminal: it is shown read only", errInvalidState)
	case w.ctl.stream == nil:
		return w, nil, fmt.Errorf("%w: the terminal's controller is starting", errInvalidState)
	}
	return w, w.ctl.stream, nil
}

// startResize answers terminal.resize (hub goroutine): the PTY of the
// connection's control watch of the worker to cols × rows. A controller that
// is starting starts at the new size.
func (h *Hub) startResize(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TerminalResizeArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	switch {
	case a.Cols < herdr.MinCols || a.Cols > herdr.MaxCols:
		return bad("cols must be %d-%d", herdr.MinCols, herdr.MaxCols)
	case a.Rows < herdr.MinRows || a.Rows > herdr.MaxRows:
		return bad("rows must be %d-%d", herdr.MinRows, herdr.MaxRows)
	case a.CellWidth < 0 || a.CellWidth > herdr.MaxCellPx || a.CellHeight < 0 || a.CellHeight > herdr.MaxCellPx:
		return bad("cell_width_px and cell_height_px must be 0-%d", herdr.MaxCellPx)
	}
	if _, _, _, err := h.terminalTarget(a.ID); err != nil {
		return err
	}
	w := h.term.get(c, a.ID)
	if w == nil || !w.control {
		return bad("terminal.resize needs a terminal.watch of the worker with control")
	}
	var (
		cs  herdr.ControlStream
		err error
	)
	h.term.mu.Lock()
	if w.ctl.mode == proto.ControlReadOnly {
		err = fmt.Errorf("%w: another client controls this terminal: it is shown read only", errInvalidState)
	} else {
		// A controller between processes starts at this size.
		w.ctl.want, w.ctl.cellW, w.ctl.cellH = [2]int{a.Cols, a.Rows}, a.CellWidth, a.CellHeight
		cs = w.ctl.stream
	}
	h.term.mu.Unlock()
	if err == nil {
		h.zoomSize(w, a.Cols, a.Rows)
		if cs != nil {
			if rerr := cs.Resize(a.Cols, a.Rows, a.CellWidth, a.CellHeight); rerr != nil {
				err = fmt.Errorf("%w: %v", errInputFailed, rerr)
			}
		}
	}
	h.audit(ctx, c, cmd, err)
	if err != nil {
		return err
	}
	h.reply(c, cmd, proto.TerminalResizeResult{Cols: a.Cols, Rows: a.Rows}, nil)
	return nil
}

// startScroll answers terminal.scroll (hub goroutine): a wheel over the
// connection's controlled terminal of the worker, or back to the live
// bottom; herdr decides whether the wheel moves its history or goes to the
// application. The new offset follows as terminal.history.
func (h *Hub) startScroll(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TerminalScrollArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	wheel := a.Direction != "" || a.Lines != 0
	switch {
	case a.Bottom == wheel:
		return bad("give either direction and lines, or bottom")
	case wheel && a.Direction != "up" && a.Direction != "down":
		return bad(`direction must be "up" or "down"`)
	case wheel && (a.Lines < 1 || a.Lines > herdr.MaxScrollLines):
		return bad("lines must be 1-%d", herdr.MaxScrollLines)
	case a.Column < 0 || a.Column >= herdr.MaxCols || a.Row < 0 || a.Row >= herdr.MaxRows:
		return bad("column must be 0-%d and row 0-%d", herdr.MaxCols-1, herdr.MaxRows-1)
	case a.Modifiers < 0 || a.Modifiers > 7:
		return bad("modifiers must be 0-7")
	}
	if _, _, _, err := h.terminalTarget(a.ID); err != nil {
		return err
	}
	w, cs, err := h.ownedStream(c, a.ID)
	if err == nil {
		var serr error
		if a.Bottom {
			serr = cs.Live()
		} else {
			serr = cs.Scroll(a.Direction == "up", a.Lines, a.Column, a.Row, a.Modifiers)
		}
		if serr != nil {
			err = fmt.Errorf("%w: %v", errInputFailed, serr)
		}
	}
	h.audit(ctx, c, cmd, err)
	if err != nil {
		return err
	}
	h.term.pokeHistory(w)
	h.reply(c, cmd, nil, nil)
	return nil
}

// pokeHistory has the watch's offset read soon.
func (t *termWatches) pokeHistory(w *watch) {
	select {
	case w.ctl.poke <- struct{}{}:
	default:
	}
}

// toLive brings every controlled view of worker id back to the live bottom
// before input reaches it (an empty terminal.input: herdr resets the
// scroll), as typing into a terminal does. A view known to be above it says
// so at once (terminal.history at 0), and its offset is read again. A full
// queue makes room for the reset (it supersedes the wheels), so only a
// controller that is closing refuses it: the input still goes, and that view
// keeps the offset it had until it is read again.
func (h *Hub) toLive(id string) {
	h.term.mu.Lock()
	var up []*watch
	for _, m := range h.term.byC {
		w := m[id]
		if w == nil || !w.control || w.stopped || w.ctl.stream == nil || w.ctl.mode != proto.ControlOwned {
			continue
		}
		if err := w.ctl.stream.Live(); err != nil {
			h.term.pokeHistory(w)
			continue
		}
		if w.ctl.hist.Offset > 0 {
			w.ctl.hist.Offset = 0
			w.ctl.histSent = false
		}
		up = append(up, w)
	}
	h.term.mu.Unlock()
	for _, w := range up {
		h.term.sendHistory(w)
		h.term.pokeHistory(w)
	}
}

// followHistory reads a control watch's history offset (pane.get) a few
// times after a scroll (herdr may not have applied it at the first read) and
// every HistoryPoll while the view is above the live bottom, and sends it
// when it changed, until the watch ends.
func (h *Hub) followHistory(ctx context.Context, w *watch) {
	read := h.opts.PaneScroll
	if read == nil {
		return
	}
	timer := time.NewTimer(h.opts.HistoryPoll)
	defer timer.Stop()
	burst := 0 // reads left after the last poke
	for {
		select {
		case <-ctx.Done():
			return
		case <-w.ctl.poke:
			burst = historyBurst
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(historySettle)
			continue
		case <-timer.C:
		}
		next := h.opts.HistoryPoll
		if burst > 0 {
			burst--
			next = historyBurstGap
		}
		timer.Reset(next)
		h.term.mu.Lock()
		owned := w.ctl.mode == proto.ControlOwned && w.ctl.stream != nil
		idle := w.ctl.hist.Offset == 0 && w.ctl.histSent && next == h.opts.HistoryPoll
		h.term.mu.Unlock()
		if !owned || idle {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, historyCallTimeout)
		sc, ok := read(cctx, w.socket, w.pane)
		cancel()
		if !ok {
			continue
		}
		h.term.mu.Lock()
		if sc != w.ctl.hist {
			w.ctl.hist, w.ctl.histSent = sc, false
		}
		h.term.mu.Unlock()
		h.term.sendHistory(w)
	}
}

// sendHistory queues the watch's terminal.history when it has not been
// sent, like terminal.state: without blocking, only while the watch is
// registered and the connection has room (the next read sends it again).
func (t *termWatches) sendHistory(w *watch) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if w.stopped || w.ctl.histSent || w.ctl.mode != proto.ControlOwned || !roomy(w.c) {
		return
	}
	select {
	case w.c.send <- mustJSON(proto.TerminalHistory{T: proto.TTerminalHistory, ID: w.id, Pane: w.pane,
		Offset: w.ctl.hist.Offset, Max: w.ctl.hist.Max, Rows: w.ctl.hist.ViewportRows}):
		w.ctl.histSent = true
	default:
	}
}
