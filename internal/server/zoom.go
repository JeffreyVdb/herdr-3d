package server

// #74: the fullscreen laptop. A watch started with fullscreen (or turned on
// by terminal.zoom) zooms its pane's tab in herdr so the pane has the whole
// tab area, and the bridge puts the tab back when the last such watch of
// the tab ends. The bridge puts back only what it zoomed itself.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Zoomer is what the hub needs from herdr to zoom: *herdr.Control. A Term
// that is not one never zooms.
type Zoomer interface {
	SetZoom(ctx context.Context, session, pane string, on bool) error
}

const (
	// DefaultZoomPoll is how often a followed watch looks at its pane's
	// tab again for the human zooming, unzooming or moving the focus.
	DefaultZoomPoll = 2 * time.Second
	// zoomCallTimeout bounds one zoom call and the read around it.
	zoomCallTimeout = 5 * time.Second
	// After a zoom the snapshot is read again up to zoomSettleTries times,
	// zoomSettleWait apart (half a second in all), until it shows the zoom.
	zoomSettleTries = 5
	zoomSettleWait  = 100 * time.Millisecond
)

// Why a zoom was written (the audit row's "why").
const (
	zoomWhyWatch   = "watch"     // terminal.watch with fullscreen
	zoomWhyCommand = "command"   // terminal.zoom
	zoomWhyRestore = "stand-up"  // the last fullscreen watch of the tab ended
	zoomWhyGone    = "shutdown"  // the bridge stopped with a tab zoomed
	zoomAuditCmd   = "pane.zoom" // the audit row of a herdr write
)

// zoomTabs are the tabs the bridge has a fullscreen watch on. Watches run
// outside the hub goroutine, so it has its own locks: mu guards the state
// and is never held across a herdr call (the hub goroutine takes it too),
// write is held across a zoom and the reads around it, so two watches of
// one tab never race their writes.
type zoomTabs struct {
	mu    sync.Mutex
	write sync.Mutex
	tabs  map[string]*zoomTab // session + "/" + tab id
}

// zoomTab is the bridge's claim on one tab.
type zoomTab struct {
	refs  map[*watch]struct{} // the fullscreen watches of the tab, over all connections
	owned bool                // the bridge zoomed the tab, and the human has not changed that since
}

// zoomWatch is a watch's part of zoomTabs, under zoomTabs.mu.
type zoomWatch struct {
	tab        string // the key of the tab it holds a ref of, "" when none
	following  bool   // it gets terminal.state messages (fullscreen at watch, or terminal.zoom)
	noPut      bool   // the session is asleep: no zoom call to put anything back
	last       proto.TerminalState
	lastSent   bool
	cols, rows int // the observer's size, as last set
}

func (h *Hub) zoomer() Zoomer {
	z, _ := h.opts.Term.(Zoomer)
	return z
}

// paneState reads a pane's size and tab state; ok false when the bridge
// has no way to or the pane is not there.
func (h *Hub) paneState(ctx context.Context, socket, pane string) (herdr.PaneState, bool) {
	switch {
	case h.opts.PaneState != nil:
		return h.opts.PaneState(ctx, socket, pane)
	case h.opts.PaneSize != nil:
		if c, r, ok := h.opts.PaneSize(ctx, socket, pane); ok {
			return herdr.PaneState{Cols: c, Rows: r}, true
		}
	}
	return herdr.PaneState{}, false
}

// zoomInfo is what a watch tells its client about the pane's tab. ok false
// when the state does not say (an old PaneState without a tab).
func (h *Hub) zoomInfo(w *watch, st herdr.PaneState) (proto.ZoomInfo, bool) {
	if st.TabID == "" {
		return proto.ZoomInfo{}, false
	}
	state := st.Zoom()
	h.zoom.mu.Lock()
	defer h.zoom.mu.Unlock()
	tab := h.zoom.tabs[zoomKey(w.session, st.TabID)]
	applied := tab != nil && tab.owned && state == herdr.ZoomZoomed
	if _, held := tab.refsOf(w); !held {
		applied = false
	}
	return proto.ZoomInfo{State: string(state), Applied: applied, Headless: st.Headless && state == herdr.ZoomZoomed}, true
}

func (t *zoomTab) refsOf(w *watch) (struct{}, bool) {
	if t == nil {
		return struct{}{}, false
	}
	r, ok := t.refs[w]
	return r, ok
}

func zoomKey(session, tab string) string { return session + "/" + tab }

// zoomOn zooms the watch's tab on its pane (when it has several panes and
// is not zoomed on this one already) and holds a ref of the tab for the
// watch. The bridge owns the zoom only when the tab was not zoomed before:
// a tab the human zoomed on another pane is switched to this one but is
// not the bridge's to put back. A failed zoom is logged and audited, and
// the state is returned as it was: the watch goes on at the best known size.
func (h *Hub) zoomOn(ctx context.Context, w *watch, st herdr.PaneState, why string) herdr.PaneState {
	if st.TabID == "" {
		return st
	}
	h.zoom.write.Lock()
	defer h.zoom.write.Unlock()
	key := zoomKey(w.session, st.TabID)
	h.zoom.mu.Lock()
	tab := h.zoom.tabs[key]
	if tab == nil {
		tab = &zoomTab{refs: map[*watch]struct{}{}}
		h.zoom.tabs[key] = tab
	}
	tab.refs[w] = struct{}{}
	w.zoom.tab = key
	h.zoom.mu.Unlock()
	z := h.zoomer()
	if z == nil || st.PaneCount <= 1 || (st.Zoomed && st.Focused) {
		return st
	}
	cctx, cancel := context.WithTimeout(ctx, zoomCallTimeout)
	defer cancel()
	err := z.SetZoom(cctx, w.session, w.pane, true)
	h.auditZoom(ctx, w, true, why, err)
	if err != nil {
		h.log.Warn("zoom failed", "worker", w.id, "pane", w.pane, "err", err)
		return st
	}
	if !st.Zoomed {
		h.zoom.mu.Lock()
		tab.owned = true
		h.zoom.mu.Unlock()
	}
	for i := 0; ; i++ {
		now, ok := h.paneState(cctx, w.socket, w.pane)
		if ok && now.Zoomed && now.Focused {
			return now
		}
		if i >= zoomSettleTries || ctx.Err() != nil {
			if ok {
				return now
			}
			return st
		}
		sleepCtx(ctx, zoomSettleWait)
	}
}

// zoomOff puts the watch's tab back (terminal.zoom off), even when the
// human zoomed it: the player asked. The bridge then owns nothing of the
// tab. The watch keeps its ref, so that zooming again takes the tab anew.
func (h *Hub) zoomOff(ctx context.Context, w *watch, st herdr.PaneState) (herdr.PaneState, error) {
	h.zoom.write.Lock()
	defer h.zoom.write.Unlock()
	h.zoom.mu.Lock()
	if tab := h.zoom.tabs[w.zoom.tab]; tab != nil {
		tab.owned = false
	}
	h.zoom.mu.Unlock()
	z := h.zoomer()
	if z == nil || st.PaneCount <= 1 || !st.Zoomed {
		return st, nil
	}
	cctx, cancel := context.WithTimeout(ctx, zoomCallTimeout)
	defer cancel()
	err := z.SetZoom(cctx, w.session, w.pane, false)
	h.auditZoom(ctx, w, false, zoomWhyCommand, err)
	if err != nil {
		return st, err
	}
	if now, ok := h.paneState(cctx, w.socket, w.pane); ok {
		return now, nil
	}
	return st, nil
}

// zoomAdopt moves a replaced watch's ref to the watch that takes its place
// (a re-watch of the same worker), so the tab is not put back and zoomed
// again in between (hub goroutine).
func (h *Hub) zoomAdopt(old, w *watch) {
	h.zoom.mu.Lock()
	defer h.zoom.mu.Unlock()
	if old.zoom.tab == "" || !w.fullscreen {
		return
	}
	if tab := h.zoom.tabs[old.zoom.tab]; tab != nil {
		delete(tab.refs, old)
		tab.refs[w] = struct{}{}
		w.zoom.tab, old.zoom.tab = old.zoom.tab, ""
	}
}

// zoomHuman notes that the human changed the tab (it is not zoomed any
// more): whatever happens next is theirs, not the bridge's to put back.
func (h *Hub) zoomHuman(w *watch) {
	h.zoom.mu.Lock()
	defer h.zoom.mu.Unlock()
	if tab := h.zoom.tabs[w.zoom.tab]; tab != nil {
		tab.owned = false
	}
}

// zoomAsleep marks that the watch's session stopped, so nothing is put
// back through its socket.
func (h *Hub) zoomAsleep(w *watch) {
	h.zoom.mu.Lock()
	w.zoom.noPut = true
	h.zoom.mu.Unlock()
}

// zoomRelease drops the watch's ref of its tab and, when it was the last
// and the bridge zoomed the tab and the tab is still zoomed, puts it back.
// ctx is not the watch's: it runs as the watch ends, also at shutdown.
func (h *Hub) zoomRelease(ctx context.Context, w *watch) {
	h.zoom.write.Lock()
	defer h.zoom.write.Unlock()
	h.zoom.mu.Lock()
	key := w.zoom.tab
	w.zoom.tab = ""
	tab := h.zoom.tabs[key]
	if key == "" || tab == nil {
		h.zoom.mu.Unlock()
		return
	}
	delete(tab.refs, w)
	if len(tab.refs) > 0 {
		h.zoom.mu.Unlock()
		return
	}
	delete(h.zoom.tabs, key)
	put := tab.owned && !w.zoom.noPut
	h.zoom.mu.Unlock()
	z := h.zoomer()
	if !put || z == nil {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, zoomCallTimeout)
	defer cancel()
	if st, ok := h.paneState(cctx, w.socket, w.pane); !ok || !st.Zoomed {
		return // the pane is gone, or the human unzoomed the tab
	}
	err := z.SetZoom(cctx, w.session, w.pane, false)
	h.auditZoom(ctx, w, false, zoomWhyRestore, err)
	if err != nil {
		h.log.Warn("putting the zoom back failed", "worker", w.id, "pane", w.pane, "err", err)
	}
}

// auditZoom writes the audit row of one zoom write.
func (h *Hub) auditZoom(ctx context.Context, w *watch, on bool, why string, err error) {
	args, _ := json.Marshal(struct {
		Session string `json:"session"`
		Pane    string `json:"pane"`
		Mode    string `json:"mode"`
		Why     string `json:"why"`
	}{w.session, w.pane, map[bool]string{true: "on", false: "off"}[on], why})
	if aerr := h.st.Audit(context.WithoutCancel(ctx), w.c.name, zoomAuditCmd, args, err); aerr != nil {
		h.log.Error("audit log write failed", "err", aerr)
	}
}

// zoomSize records the size a watch's observer starts at.
func (h *Hub) zoomSize(w *watch, cols, rows int) {
	h.zoom.mu.Lock()
	w.zoom.cols, w.zoom.rows = cols, rows
	h.zoom.mu.Unlock()
}

// followStart makes the connection hear of the watch's pane changing (once
// per watch), starting from what it was just told.
func (h *Hub) followStart(w *watch, info proto.ZoomInfo, cols, rows int) {
	h.zoom.mu.Lock()
	if w.zoom.following {
		h.zoom.mu.Unlock()
		return
	}
	w.zoom.following = true
	w.zoom.last = proto.TerminalState{T: proto.TTerminalState, ID: w.id, Pane: w.pane, Cols: cols, Rows: rows, Zoom: info}
	w.zoom.lastSent = true
	h.zoom.mu.Unlock()
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		h.followZoom(w.ctx, w)
	}()
}

// followZoom watches the state of a followed watch's pane until the watch
// ends: when its zoom, focus or size changes it tells the connection
// (terminal.state), and a size that came from the pane makes the observer
// start over at the new one. A tab the human unzoomed is no longer the
// bridge's to put back. It never zooms again.
func (h *Hub) followZoom(ctx context.Context, w *watch) {
	t := time.NewTicker(h.opts.ZoomPoll)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		cctx, cancel := context.WithTimeout(ctx, zoomCallTimeout)
		st, ok := h.paneState(cctx, w.socket, w.pane)
		cancel()
		if ok {
			h.zoomChanged(ctx, w, st)
		}
	}
}

// zoomChanged compares the pane's state to what the client was last told
// and sends the difference.
func (h *Hub) zoomChanged(ctx context.Context, w *watch, st herdr.PaneState) {
	if st.TabID != "" && !st.Zoomed {
		h.zoomHuman(w)
	}
	info, ok := h.zoomInfo(w, st)
	if !ok {
		return
	}
	cols, rows := h.observerSize(w, st)
	h.zoom.mu.Lock()
	resize := cols != w.zoom.cols || rows != w.zoom.rows
	msg := proto.TerminalState{T: proto.TTerminalState, ID: w.id, Pane: w.pane, Cols: cols, Rows: rows, Zoom: info}
	same := w.zoom.lastSent && w.zoom.last == msg
	w.zoom.last, w.zoom.lastSent = msg, true
	h.zoom.mu.Unlock()
	if resize { // the newest size only
		select {
		case <-w.resize:
		default:
		}
		select {
		case w.resize <- [2]int{cols, rows}:
		default:
		}
	}
	if !same {
		h.term.sendState(w, msg)
	}
}

// observerSize is the size the watch's observer should have for the pane's
// state: the pane's, where the client did not name its own.
func (h *Hub) observerSize(w *watch, st herdr.PaneState) (cols, rows int) {
	h.zoom.mu.Lock()
	cols, rows = w.zoom.cols, w.zoom.rows
	h.zoom.mu.Unlock()
	if w.autoCols && st.Cols > 0 {
		cols = min(max(st.Cols, herdr.MinCols), herdr.MaxCols)
	}
	if w.autoRows && st.Rows > 0 {
		rows = min(max(st.Rows, herdr.MinRows), herdr.MaxRows)
	}
	return cols, rows
}

// sendState queues a terminal.state of w to its connection, like a frame:
// without blocking, only while w is registered and the queue has room. A
// lost one is followed by the next change; the watch's size is never
// affected.
func (t *termWatches) sendState(w *watch, msg proto.TerminalState) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if w.stopped || !roomy(w.c) {
		return
	}
	select {
	case w.c.send <- mustJSON(msg):
	default:
	}
}

// startZoom answers terminal.zoom (hub goroutine): {id, on} for a worker
// the connection watches.
func (h *Hub) startZoom(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TerminalZoomArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.On == nil {
		return bad("on is required")
	}
	wk, _, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	w := h.term.get(c, a.ID)
	if w == nil || w.pane != wk.PaneID {
		return bad("terminal.zoom needs a terminal.watch of the worker first")
	}
	if h.zoomer() == nil || (h.opts.PaneState == nil) {
		return errors.New("zoom is not available on this bridge")
	}
	on := *a.On
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		data, err := h.runZoom(ctx, w, on)
		if derr := h.doWait(ctx, func() {
			h.audit(ctx, c, cmd, err)
			h.reply(c, cmd, data, err)
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

// runZoom does a terminal.zoom: zooms or unzooms, tells the observer the
// new size and returns the new state.
func (h *Hub) runZoom(ctx context.Context, w *watch, on bool) (any, error) {
	cctx, cancel := context.WithTimeout(ctx, 3*zoomCallTimeout)
	defer cancel()
	st, ok := h.paneState(cctx, w.socket, w.pane)
	if !ok {
		return nil, fmt.Errorf("%w: the pane is not there", errInputFailed)
	}
	if on {
		st = h.zoomOn(cctx, w, st, zoomWhyCommand)
		w.setFullscreen(h, true)
	} else {
		var err error
		if st, err = h.zoomOff(cctx, w, st); err != nil {
			return nil, fmt.Errorf("%w: %v", errInputFailed, err)
		}
		w.setFullscreen(h, false)
	}
	info, ok := h.zoomInfo(w, st)
	if !ok {
		return nil, fmt.Errorf("%w: the pane's tab is not known", errInputFailed)
	}
	cols, rows := h.observerSize(w, st)
	h.followStart(w, info, cols, rows)
	h.zoomChanged(ctx, w, st)
	return proto.TerminalWatchResult{Pane: w.pane, Cols: cols, Rows: rows, Zoom: &info}, nil
}

func (w *watch) setFullscreen(h *Hub, on bool) {
	h.zoom.mu.Lock()
	w.fullscreen = on
	h.zoom.mu.Unlock()
}
