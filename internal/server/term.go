package server

// M5 term: laptop screens. A terminal.watch runs one herdr observer for
// the watching connection and forwards its frames to that connection
// only: connection-scoped messages, no seq, never in the replay ring.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Defaults of the laptop screens.
const (
	DefaultMaxWatches   = 6  // per connection
	DefaultMaxObservers = 16 // host-wide
	DefaultWatchFps     = 4
	// A pane whose size herdr's layout does not give: herdr's headless
	// server makes its panes 120 × 40.
	defaultCols, defaultRows = 120, 40
	maxFps                   = 30
	// Diffs waiting to be sent to a watcher, merged into one frame: above
	// this the watch resyncs instead.
	maxPendingFrame = 512 << 10
	// DefaultFirstFrame is how long a new observer has for its first
	// (full) frame; after that silence is normal (frames come on change).
	DefaultFirstFrame = 5 * time.Second
	// DefaultObserverBackoff is the first wait before restarting an
	// observer that exited or stalled; it doubles each time.
	DefaultObserverBackoff = 250 * time.Millisecond
	// An observer is restarted at most observerRestarts times within
	// observerWindow; the next failure ends the watch (observer_failed).
	observerRestarts = 3
	observerWindow   = 30 * time.Second
	headroomPoll     = 50 * time.Millisecond
)

var (
	errResync        = errors.New("watch resync")
	errWatchStopped  = errors.New("watch stopped")
	errObserverEnded = errors.New("observer ended")
	errStalled       = errors.New("observer sent no frame")
)

// termWatches are the running watches (their own lock: frames are sent
// from the watches' goroutines, never through the hub goroutine).
type termWatches struct {
	mu    sync.Mutex
	byC   map[*Client]map[string]*watch // connection → worker id → watch
	count int
}

// watch is one connection watching one worker's pane.
type watch struct {
	c               *Client
	id, session     string
	pane            string
	cols, rows, fps int
	cancel          context.CancelFunc
	n               uint64 // frames sent (under termWatches.mu)
	stopped         bool   // unregistered (under termWatches.mu)
}

func (t *termWatches) get(c *Client, id string) *watch {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byC[c][id]
}

// add registers w, replacing (and returning) the connection's watch of the
// same worker.
func (t *termWatches) add(w *watch) (old *watch) {
	t.mu.Lock()
	defer t.mu.Unlock()
	m := t.byC[w.c]
	if m == nil {
		m = map[string]*watch{}
		t.byC[w.c] = m
	}
	if old = m[w.id]; old != nil {
		old.stopped = true
		t.count--
	}
	m[w.id] = w
	t.count++
	return old
}

// remove unregisters w if it is still registered; no frame of it is sent
// after that.
func (t *termWatches) remove(w *watch) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if w.stopped || t.byC[w.c][w.id] != w {
		return false
	}
	w.stopped = true
	delete(t.byC[w.c], w.id)
	if len(t.byC[w.c]) == 0 {
		delete(t.byC, w.c)
	}
	t.count--
	return true
}

// all returns every registered watch.
func (t *termWatches) all() []*watch {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []*watch
	for _, m := range t.byC {
		for _, w := range m {
			out = append(out, w)
		}
	}
	return out
}

func (t *termWatches) counts(c *Client) (conn, host int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.byC[c]), t.count
}

// send queues a frame of w to its connection without blocking, only while
// w is registered and the connection's send queue is at most half full:
// frames never push a connection into the slow-consumer disconnect.
func (t *termWatches) send(w *watch, frame func(n uint64) []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if w.stopped {
		return errWatchStopped
	}
	if !roomy(w.c) {
		return errResync
	}
	select {
	case w.c.send <- frame(w.n + 1):
		w.n++
		return nil
	default:
		return errResync
	}
}

// roomy reports whether a connection's send queue is at most half full.
func roomy(c *Client) bool { return len(c.send) <= cap(c.send)/2 }

// startWatch validates terminal.watch and starts the watch; the ack comes
// once its observer runs, before its first frame (hub goroutine).
func (h *Hub) startWatch(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TerminalWatchArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	switch {
	case a.Fps < 0 || a.Fps > maxFps:
		return bad("fps must be 1-%d", maxFps)
	case a.Cols != 0 && (a.Cols < herdr.MinCols || a.Cols > herdr.MaxCols):
		return bad("cols must be %d-%d", herdr.MinCols, herdr.MaxCols)
	case a.Rows != 0 && (a.Rows < herdr.MinRows || a.Rows > herdr.MaxRows):
		return bad("rows must be %d-%d", herdr.MinRows, herdr.MaxRows)
	}
	wk, f, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	conn, host := h.term.counts(c)
	if old := h.term.get(c, a.ID); old != nil { // a re-watch replaces it
		conn, host = conn-1, host-1
	}
	switch {
	case conn >= h.opts.MaxWatches:
		return fmt.Errorf("%w: this connection already watches %d panes (--max-watches)", errCapacity, conn)
	case host >= h.opts.MaxObservers:
		return fmt.Errorf("%w: %d panes are watched already (--max-observers)", errCapacity, host)
	}
	w := &watch{c: c, id: a.ID, session: wk.Session, pane: wk.PaneID, cols: a.Cols, rows: a.Rows, fps: a.Fps}
	if w.fps == 0 {
		w.fps = DefaultWatchFps
	}
	wctx, cancel := context.WithCancel(ctx)
	w.cancel = cancel
	if old := h.term.add(w); old != nil {
		old.cancel()
	}
	socket := f.socket
	h.wg.Add(1)
	go h.runWatch(ctx, wctx, w, cmd, socket)
	return nil
}

// unwatch stops the connection's watch of a worker; a watch that is not
// there is a no-op.
func (h *Hub) unwatch(cmd proto.Command, c *Client) error {
	var a proto.WorkerArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if w := h.term.get(c, a.ID); w != nil && h.term.remove(w) {
		w.cancel()
	}
	return nil
}

// dropWatches stops every watch of a connection that went away.
func (h *Hub) dropWatches(c *Client) {
	for _, w := range h.term.all() {
		if w.c == c && h.term.remove(w) {
			w.cancel()
		}
	}
}

// syncWatches ends the watches whose worker went, fell asleep or changed
// its pane, with terminal.closed (hub goroutine, after each observation).
func (h *Hub) syncWatches() {
	for _, w := range h.term.all() {
		reason := ""
		wk := h.workers[w.id]
		switch {
		case wk == nil:
			reason = proto.ClosedWorkerRemoved
		case h.floors[wk.Session] == nil || !h.floors[wk.Session].running:
			reason = proto.ClosedAsleep
		case wk.PaneID != w.pane || wk.Session != w.session:
			reason = proto.ClosedPaneChanged
		}
		if reason != "" {
			h.closeWatch(w, reason)
		}
	}
}

// closeWatch ends a watch and tells its connection why (hub goroutine).
func (h *Hub) closeWatch(w *watch, reason string) {
	if !h.term.remove(w) {
		return
	}
	w.cancel()
	h.log.Debug("watch closed", "client", w.c.name, "worker", w.id, "reason", reason)
	h.deliver(w.c, mustJSON(proto.TerminalClosed{T: proto.TTerminalClosed, ID: w.id, Reason: reason}))
}

// runWatch runs a watch's observer until the watch ends, restarting it to
// resync and, with backoff, when it exits or stalls. hctx is the hub's
// context (replies), ctx the watch's.
func (h *Hub) runWatch(hctx, ctx context.Context, w *watch, cmd proto.Command, socket string) {
	defer h.wg.Done()
	defer w.cancel()
	if w.cols == 0 || w.rows == 0 {
		cols, rows := defaultCols, defaultRows
		if h.opts.PaneSize != nil {
			if c, r, ok := h.opts.PaneSize(ctx, socket, w.pane); ok {
				cols, rows = min(max(c, herdr.MinCols), herdr.MaxCols), min(max(r, herdr.MinRows), herdr.MaxRows)
			}
		}
		if w.cols == 0 {
			w.cols = cols
		}
		if w.rows == 0 {
			w.rows = rows
		}
	}
	var fails []time.Time
	acked := false
	for {
		obs, err := h.opts.Term.Observe(ctx, w.session, w.pane, w.cols, w.rows)
		if !acked {
			acked = true
			if err != nil && ctx.Err() == nil {
				h.term.remove(w)
				h.finishWatchCmd(hctx, w, cmd, fmt.Errorf("starting the observer failed: %w", err))
				return
			}
			h.finishWatchCmd(hctx, w, cmd, nil)
		}
		if err == nil {
			err = h.pump(ctx, w, obs)
			obs.Close()
		}
		if ctx.Err() != nil || errors.Is(err, errWatchStopped) {
			return
		}
		if errors.Is(err, errResync) {
			h.log.Debug("watch resync", "client", w.c.name, "worker", w.id)
			if !h.awaitRoom(ctx, w) {
				return
			}
			continue
		}
		now := time.Now()
		for len(fails) > 0 && now.Sub(fails[0]) > observerWindow {
			fails = fails[1:]
		}
		fails = append(fails, now)
		if len(fails) > observerRestarts {
			h.log.Warn("observer failed", "client", w.c.name, "worker", w.id, "pane", w.pane, "err", err)
			_ = h.doWait(hctx, func() { h.closeWatch(w, proto.ClosedObserverFailed) })
			return
		}
		h.log.Debug("observer restarting", "worker", w.id, "pane", w.pane, "err", err, "try", len(fails))
		sleepCtx(ctx, h.opts.ObserverBackoff<<(len(fails)-1))
		if ctx.Err() != nil {
			return
		}
	}
}

// finishWatchCmd audits terminal.watch and answers it.
func (h *Hub) finishWatchCmd(hctx context.Context, w *watch, cmd proto.Command, err error) {
	var data any
	if err == nil {
		data = proto.TerminalWatchResult{Pane: w.pane, Cols: w.cols, Rows: w.rows}
	}
	if derr := h.doWait(hctx, func() {
		h.audit(hctx, w.c, cmd, err)
		h.reply(w.c, cmd, data, err)
	}); derr != nil {
		h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
	}
}

// awaitRoom waits until the watch's connection has room again for frames
// (a resync starts with a full one).
func (h *Hub) awaitRoom(ctx context.Context, w *watch) bool {
	for !roomy(w.c) {
		sleepCtx(ctx, headroomPoll)
		if ctx.Err() != nil {
			return false
		}
	}
	return ctx.Err() == nil
}

// watchQueue is what a watch's observer sent that its connection has not
// been sent yet: one frame of at most maxPendingFrame bytes, the diffs
// merged in order (ANSI diffs compose), a full frame replacing what is
// pending. The observer's reader puts into it without ever waiting for the
// connection, so its output is read continuously; past the bound the
// queue overflows (it keeps nothing more) and the watch resyncs.
type watchQueue struct {
	mu         sync.Mutex
	data       []byte
	full       bool // data starts with a full frame
	pending    bool
	gotFull    bool // a first full frame came
	overflow   bool
	cols, rows int
	ready      chan struct{} // (cap 1) something was put
}

func newWatchQueue() *watchQueue { return &watchQueue{ready: make(chan struct{}, 1)} }

// put merges a frame in; a diff before any full frame applies to nothing
// and is dropped.
func (q *watchQueue) put(f herdr.Frame) {
	q.mu.Lock()
	switch {
	case q.overflow:
		q.mu.Unlock()
		return
	case f.Full:
		q.gotFull = true
		q.data, q.full = append(q.data[:0], f.Data...), true
	case !q.gotFull:
		q.mu.Unlock()
		return
	default:
		q.data = append(q.data, f.Data...)
	}
	q.pending, q.cols, q.rows = true, f.Width, f.Height
	if len(q.data) > maxPendingFrame {
		q.overflow, q.data = true, nil
	}
	q.mu.Unlock()
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

// take empties the queue: the pending frame (ok false: none), errResync
// once it overflowed.
func (q *watchQueue) take() (data []byte, full bool, cols, rows int, ok bool, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.overflow {
		return nil, false, 0, 0, false, errResync
	}
	if !q.pending {
		return nil, false, 0, 0, false, nil
	}
	data, full, cols, rows = q.data, q.full, q.cols, q.rows
	q.data, q.full, q.pending = nil, false, false
	return data, full, cols, rows, true, nil
}

func (q *watchQueue) state() (gotFull, overflow bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.gotFull, q.overflow
}

// pump forwards an observer's frames to the watch's connection, at most
// fps a second, through its watchQueue. It returns when the observer ends
// (errObserverEnded, errStalled), the watch ends, or it must resync
// (errResync: the queue overflowed or the connection has no room).
func (h *Hub) pump(ctx context.Context, w *watch, obs herdr.FrameStream) error {
	q := newWatchQueue()
	ended := make(chan error, 1)
	go func() { // until obs is closed
		for {
			f, err := obs.Next()
			switch {
			case err != nil && errors.Is(err, io.EOF):
				err = errObserverEnded
			case err == nil && f.Closed:
				err = fmt.Errorf("%w: %s", errObserverEnded, f.Reason)
			}
			if err != nil {
				ended <- err
				return
			}
			q.put(f)
		}
	}()
	interval := time.Second / time.Duration(w.fps)
	first := time.NewTimer(h.opts.FirstFrame)
	defer first.Stop()
	flushAt := time.NewTimer(time.Hour)
	flushAt.Stop()
	defer flushAt.Stop()
	var (
		arm  bool
		last time.Time
	)
	flush := func() error {
		pend, full, cols, rows, ok, err := q.take()
		if err != nil || !ok {
			return err
		}
		data := base64.StdEncoding.EncodeToString(pend)
		if err := h.term.send(w, func(n uint64) []byte {
			return mustJSON(proto.TerminalFrame{T: proto.TTerminalFrame, ID: w.id, Pane: w.pane, N: n, Full: full,
				Cols: cols, Rows: rows, Data: data})
		}); err != nil {
			return err
		}
		last = time.Now()
		return nil
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-ended:
			return err
		case <-first.C:
			if gotFull, _ := q.state(); !gotFull {
				return errStalled
			}
		case <-flushAt.C:
			arm = false
			if err := flush(); err != nil {
				return err
			}
		case <-q.ready:
			if _, overflow := q.state(); overflow {
				return errResync
			}
			if wait := interval - time.Since(last); wait <= 0 {
				if err := flush(); err != nil {
					return err
				}
			} else if !arm {
				flushAt.Reset(wait)
				arm = true
			}
		}
	}
}

// termDefaults fills in the laptops' options.
func termDefaults(o *Options) {
	if o.MaxWatches <= 0 {
		o.MaxWatches = DefaultMaxWatches
	}
	if o.MaxObservers <= 0 {
		o.MaxObservers = DefaultMaxObservers
	}
	if o.FirstFrame <= 0 {
		o.FirstFrame = DefaultFirstFrame
	}
	if o.ObserverBackoff <= 0 {
		o.ObserverBackoff = DefaultObserverBackoff
	}
	if o.QuestionPoll <= 0 {
		o.QuestionPoll = DefaultQuestionPoll
	}
	if o.AnswerTimeout <= 0 {
		o.AnswerTimeout = DefaultAnswerTimeout
	}
	if o.PromptRetryWait <= 0 {
		o.PromptRetryWait = DefaultPromptRetryWait
	}
}

func (h *Hub) initTerm() {
	h.term.byC = map[*Client]map[string]*watch{}
	h.lanes = map[string]*inputLane{}
	h.questions = map[string]questionState{}
	h.asking = map[string]bool{}
}

// afterObserve follows a change of the workers: watches whose worker went
// end, blocked workers get their screen read (hub goroutine).
func (h *Hub) afterObserve(ctx context.Context) {
	h.syncWatches()
	h.askQuestions(ctx)
}

// startUnwatch answers terminal.unwatch.
func (h *Hub) startUnwatch(ctx context.Context, c *Client, cmd proto.Command) error {
	if err := h.unwatch(cmd, c); err != nil {
		return err
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}
