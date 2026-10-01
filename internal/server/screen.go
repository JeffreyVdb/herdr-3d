package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/screenshare"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// M13 (#15) screen share. The TV shows the shared screen inside the game,
// on the Mac; the bridge never sees it except for one frame per screen.grab:
// it asks the sharing game (screen.frame_request on its connection), the
// game POSTs the JPEG to /screen/frame/{req_id} (over HTTP, like /upload: a
// WebSocket message is capped at 256 KiB), the bridge checks it, stores it
// under the screen directory for its TTL, audits the grab and has the game
// show who looked. docs/protocol.md "Screen share".

// Defaults of the screen options.
const (
	// DefaultScreenTimeout bounds a grab's wait for its frame. The target
	// round trip is under 2 s; past 5 s something is wrong (a hidden tab
	// whose timers are throttled, a dead tunnel) and the grab says so.
	DefaultScreenTimeout = 5 * time.Second
	maxPendingFrames     = 4 // grabs waiting for a frame at once
	maxRequester         = 64
	maxFrameMessage      = 200 // bytes of a game's reason kept for the log and the error
	frameReadTimeout     = 10 * time.Second
)

// screenState is the hub's screen share bookkeeping (hub goroutine only).
type screenState struct {
	frames  *screenshare.Frames
	err     error                  // why there is no frame store
	games   map[*Client]*shareInfo // clients that sent screen.share: the games
	pending map[string]*framePending
	order   uint64 // to know which game started sharing last
	view    proto.ScreenState
}

// shareInfo is what one game reported.
type shareInfo struct {
	sharing bool
	surface string
	order   uint64 // when it started sharing
}

// framePending is one grab waiting for its frame.
type framePending struct {
	id      string
	c       *Client // the sharing game it was asked of
	surface string
	res     chan frameResult // buffered: the one answer
	done    bool
	expire  *time.Timer // ends it after Options.ScreenTimeout, whoever waits
}

type frameResult struct {
	b    []byte
	info screenshare.Info
	err  error
}

// initScreen opens the frame store (Options.ScreenDir); without it, a grab
// fails with internal and says why.
func (h *Hub) initScreen() {
	h.screen.games = map[*Client]*shareInfo{}
	h.screen.pending = map[string]*framePending{}
	if h.opts.ScreenTimeout <= 0 {
		h.opts.ScreenTimeout = DefaultScreenTimeout
	}
	if h.opts.ScreenDir == "" {
		h.screen.err = screenshare.ErrNoRuntimeDir
		return
	}
	f, err := screenshare.Open(h.opts.ScreenDir, screenshare.Options{TTL: h.opts.ScreenTTL, Now: h.opts.Now, Log: h.log})
	if err != nil {
		h.log.Error("screen frame directory unavailable: screen.grab will fail", "dir", h.opts.ScreenDir, "err", err)
		h.screen.err = fmt.Errorf("screen frame directory %s: %w", h.opts.ScreenDir, err)
		return
	}
	h.screen.frames = f
}

// runScreenJanitor removes expired frames until ctx is done (Run).
func (h *Hub) runScreenJanitor(ctx context.Context) {
	defer h.wg.Done()
	h.screen.frames.Run(ctx, h.opts.ScreenSweep)
}

// screenView is the snapshot's screen state.
func (h *Hub) screenView() *proto.ScreenState {
	v := h.screen.view
	return &v
}

// publishScreen emits screen.state when what a client sees changed: sharing
// if any game shares, and the surface of the one that started last.
func (h *Hub) publishScreen() {
	var v proto.ScreenState
	if s := h.sharer(); s != nil {
		v = proto.ScreenState{Sharing: true, Surface: h.screen.games[s].surface}
	}
	if v == h.screen.view {
		return
	}
	h.screen.view = v
	h.emit(proto.Event{T: proto.EvScreenState, ScreenState: &v})
}

// sharer is the game a grab asks: the one that started sharing last.
func (h *Hub) sharer() *Client {
	var best *Client
	var at uint64
	for c, g := range h.screen.games {
		if g.sharing && (best == nil || g.order > at) {
			best, at = c, g.order
		}
	}
	return best
}

// failFrames ends every grab waiting on c's frame.
func (h *Hub) failFrames(c *Client, err error) {
	for _, p := range h.screen.pending {
		if p.c == c {
			h.finishFrame(p, frameResult{err: err})
		}
	}
}

// finishFrame hands a grab its answer, once.
func (h *Hub) finishFrame(p *framePending, r frameResult) {
	if p.done {
		return
	}
	p.done = true
	p.expire.Stop()
	delete(h.screen.pending, p.id)
	p.res <- r
}

// dropFrame forgets a grab its caller gave up on (hub goroutine).
func (h *Hub) dropFrame(p *framePending) {
	if h.screen.pending[p.id] == p {
		p.expire.Stop()
		delete(h.screen.pending, p.id)
	}
}

// dropScreen forgets a game that left (Leave): it no longer shares, and the
// grabs waiting on it fail at once.
func (h *Hub) dropScreen(c *Client) {
	if _, ok := h.screen.games[c]; !ok {
		return
	}
	delete(h.screen.games, c)
	h.failFrames(c, &codedError{proto.ErrNoClient, errors.New("the sharing game disconnected before it sent the frame")})
	h.publishScreen()
}

var validSurface = map[string]bool{"": true, proto.SurfaceBrowser: true, proto.SurfaceWindow: true, proto.SurfaceMonitor: true}

// startScreenShare answers screen.share: the game shares, or not.
func (h *Hub) startScreenShare(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ScreenShareArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !validSurface[a.Surface] {
		return &badArgsError{fmt.Errorf("surface must be browser, window or monitor, got %q", a.Surface)}
	}
	g := h.screen.games[c]
	if g == nil {
		g = &shareInfo{}
		h.screen.games[c] = g
	}
	if a.Sharing && !g.sharing {
		h.screen.order++
		g.order = h.screen.order
	}
	g.sharing = a.Sharing
	g.surface = ""
	if a.Sharing {
		g.surface = a.Surface
	} else {
		h.failFrames(c, &codedError{proto.ErrNotSharing, errors.New("screen sharing stopped before the frame was sent")})
	}
	h.publishScreen()
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

// startScreenFrame answers screen.frame: the game cannot send the frame it
// was asked for, and says why.
func (h *Hub) startScreenFrame(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ScreenFrameArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Error == "" {
		return &badArgsError{errors.New("screen.frame needs an error: the frame itself goes to POST /screen/frame/{req_id}")}
	}
	p := h.screen.pending[a.ReqID]
	if p == nil || p.c != c {
		return fmt.Errorf("%w: no frame request %q is waiting for this connection", store.ErrNotFound, a.ReqID)
	}
	why := cleanText(a.Message, maxFrameMessage)
	if why == "" {
		why = cleanText(a.Error, maxFrameMessage)
	}
	h.finishFrame(p, frameResult{err: &codedError{proto.ErrFrameUnavailable, fmt.Errorf("the game could not take a frame: %s", why)}})
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

// startScreenGrab answers screen.grab off the hub goroutine (GrabScreen
// audits it).
func (h *Hub) startScreenGrab(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.ScreenGrabArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		res, err := h.GrabScreen(ctx, c.name, a)
		var data any
		if err == nil {
			data = res
		}
		if derr := h.doWait(ctx, func() { h.reply(c, cmd, data, err) }); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

// GrabScreen takes one frame of the shared screen for a.Requester on
// a.Floor: it asks the sharing game, waits up to Options.ScreenTimeout,
// checks and stores the JPEG and returns where it is. The game shows a toast
// naming the requester, and the grab is audited (as client `by`), refused or
// not. This is screen.grab, and the entry point of M14's office CLI.
// Errors: bad_request, unknown_session, no_client, not_sharing, busy,
// frame_timeout, frame_invalid, frame_too_large, frame_unavailable, internal.
func (h *Hub) GrabScreen(ctx context.Context, by string, a proto.ScreenGrabArgs) (proto.ScreenGrabResult, error) {
	res, err := h.grabScreen(ctx, a)
	args, _ := json.Marshal(map[string]any{"floor": a.Floor, "requester": a.Requester, "bytes": res.Bytes, "w": res.W, "h": res.H, "surface": res.Surface})
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if aerr := h.st.Audit(actx, by, proto.CmdScreenGrab, args, err); aerr != nil {
		h.log.Error("audit log write failed", "err", aerr)
	}
	if err != nil {
		h.log.Info("screen grab refused", "floor", a.Floor, "requester", a.Requester, "code", errorCode(err), "err", err)
	} else {
		h.log.Info("screen grabbed", "floor", a.Floor, "requester", a.Requester, "bytes", res.Bytes, "w", res.W, "h", res.H)
	}
	return res, err
}

func (h *Hub) grabScreen(ctx context.Context, a proto.ScreenGrabArgs) (proto.ScreenGrabResult, error) {
	if err := checkRequester(a.Requester); err != nil {
		return proto.ScreenGrabResult{}, err
	}
	if a.Floor == "" {
		return proto.ScreenGrabResult{}, &badArgsError{errors.New("floor is required")}
	}
	type asked struct {
		p   *framePending
		err error
	}
	// The registration may run after the caller stopped waiting for it
	// (query returns on ctx while fn is queued): it then asks nothing, and
	// a request it did register expires on its own (requestFrame), so an
	// abandoned grab never holds a slot.
	q, err := query(ctx, h, func() asked {
		if err := ctx.Err(); err != nil {
			return asked{nil, err}
		}
		p, err := h.requestFrame(a)
		return asked{p, err}
	})
	if err == nil {
		err = q.err
	}
	if err != nil {
		return proto.ScreenGrabResult{}, err
	}
	p := q.p
	defer func() {
		_ = h.do(context.Background(), func(context.Context) { h.dropFrame(p) })
	}()
	timer := time.NewTimer(h.opts.ScreenTimeout)
	defer timer.Stop()
	var r frameResult
	select {
	case r = <-p.res:
	case <-timer.C:
		return proto.ScreenGrabResult{}, &codedError{proto.ErrFrameTimeout, fmt.Errorf("the game sent no frame within %s", h.opts.ScreenTimeout)}
	case <-ctx.Done():
		return proto.ScreenGrabResult{}, ctx.Err()
	}
	if r.err != nil {
		return proto.ScreenGrabResult{}, r.err
	}
	at := h.opts.Now()
	path, err := h.screen.frames.Save(p.id, r.b)
	if err != nil {
		h.log.Error("storing a screen frame failed", "dir", h.screen.frames.Dir(), "err", err)
		return proto.ScreenGrabResult{}, errors.New("internal: the frame could not be stored")
	}
	// The toast: the game whose screen it is learns who looked.
	_ = h.do(context.Background(), func(context.Context) {
		if _, ok := h.clients[p.c]; ok {
			h.deliver(p.c, mustJSON(proto.ScreenGrabbed{T: proto.TScreenGrabbed, Requester: a.Requester, Floor: a.Floor, At: at.UnixMilli()}))
		}
	})
	return proto.ScreenGrabResult{
		Path: path, Bytes: r.info.Bytes, W: r.info.W, H: r.info.H, Surface: p.surface,
		At: at.UnixMilli(), Expires: at.Add(h.screen.frames.TTL()).UnixMilli(),
	}, nil
}

// requestFrame registers a grab and asks the sharing game (hub goroutine).
// The request ends with frame_timeout after Options.ScreenTimeout even if
// nobody waits for its answer any more.
func (h *Hub) requestFrame(a proto.ScreenGrabArgs) (*framePending, error) {
	if h.screen.frames == nil {
		return nil, fmt.Errorf("internal: %w", h.screen.err)
	}
	if _, err := h.floorFor(a.Floor); err != nil {
		return nil, err
	}
	if len(h.screen.games) == 0 {
		return nil, &codedError{proto.ErrNoClient, errors.New("no game is connected, so there is no screen to look at")}
	}
	c := h.sharer()
	if c == nil {
		return nil, &codedError{proto.ErrNotSharing, errors.New("screen sharing is off: ask the human to press Share screen")}
	}
	if len(h.screen.pending) >= maxPendingFrames {
		return nil, fmt.Errorf("%w: %d screen grabs are already waiting", errBusy, maxPendingFrames)
	}
	p := &framePending{id: randHex(16), c: c, surface: h.screen.games[c].surface, res: make(chan frameResult, 1)}
	timeout := h.opts.ScreenTimeout
	p.expire = time.AfterFunc(timeout, func() {
		_ = h.do(context.Background(), func(context.Context) {
			if h.screen.pending[p.id] == p {
				h.finishFrame(p, frameResult{err: &codedError{proto.ErrFrameTimeout, fmt.Errorf("the game sent no frame within %s", timeout)}})
			}
		})
	})
	h.screen.pending[p.id] = p
	h.deliver(c, mustJSON(proto.ScreenFrameRequest{T: proto.TScreenFrameRequest, ReqID: p.id}))
	return p, nil
}

// frameWaiting reports whether a grab waits for frame id.
func (h *Hub) frameWaiting(ctx context.Context, id string) (bool, error) {
	return query(ctx, h, func() bool { return h.screen.pending[id] != nil })
}

// deliverFrame hands frame id its answer; false when no grab waits for it
// (anymore: it timed out, or the game stopped sharing).
func (h *Hub) deliverFrame(ctx context.Context, id string, r frameResult) (bool, error) {
	return query(ctx, h, func() bool {
		p := h.screen.pending[id]
		if p == nil {
			return false
		}
		h.finishFrame(p, r)
		return true
	})
}

// checkRequester: the worker name the toast shows, 1–64 bytes of UTF-8,
// no control or format characters (no bidi overrides) and no U+FFFD (what
// JSON makes of invalid UTF-8), no outer spaces.
func checkRequester(s string) error {
	switch {
	case s == "":
		return &badArgsError{errors.New("requester is required")}
	case len(s) > maxRequester:
		return &badArgsError{fmt.Errorf("requester is over %d bytes", maxRequester)}
	case !utf8.ValidString(s):
		return &badArgsError{errors.New("requester is not UTF-8")}
	case strings.TrimSpace(s) != s:
		return &badArgsError{errors.New("requester has leading or trailing space")}
	case strings.IndexFunc(s, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == utf8.RuneError }) >= 0:
		return &badArgsError{errors.New("requester has control characters")}
	}
	return nil
}

// cleanText keeps a game's reason printable and short.
func cleanText(s string, n int) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == utf8.RuneError {
			return -1
		}
		return r
	}, s)
	for len(s) > n {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	return strings.TrimSpace(s)
}

func (s *Server) screenRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /screen/frame/{id}", s.postFrame)
}

// postFrame takes the JPEG a game sends for a frame request. Nothing is
// accepted without a grab waiting for that id (128 random bits the bridge
// sent only to the sharing game); a frame that is too large or not a JPEG
// fails the grab at once, with the same error.
func (s *Server) postFrame(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !screenshare.ValidID(id) {
		logoError(w, http.StatusBadRequest, proto.ErrBadRequest, "a frame request id is 32 hex digits")
		return
	}
	waiting, err := s.hub.frameWaiting(r.Context(), id)
	if err != nil {
		logoError(w, http.StatusServiceUnavailable, proto.ErrInternal, "the bridge is shutting down")
		return
	}
	if !waiting {
		s.log.Info("screen frame refused", "id", id, "why", "no grab waits for it")
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "no screen grab is waiting for this frame (it timed out or was answered)")
		return
	}
	fail := func(status int, code string, err error) {
		s.log.Info("screen frame refused", "id", id, "code", code, "err", err)
		_, _ = s.hub.deliverFrame(context.WithoutCancel(r.Context()), id, frameResult{err: &codedError{code, err}})
		logoError(w, status, code, err.Error())
	}
	if r.ContentLength > screenshare.MaxBytes {
		fail(http.StatusRequestEntityTooLarge, proto.ErrFrameTooLarge, fmt.Errorf("%w: %d bytes, at most %d", screenshare.ErrTooLarge, r.ContentLength, screenshare.MaxBytes))
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(frameReadTimeout))
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, screenshare.MaxBytes))
	var tooBig *http.MaxBytesError
	switch {
	case errors.As(err, &tooBig):
		fail(http.StatusRequestEntityTooLarge, proto.ErrFrameTooLarge, fmt.Errorf("%w: over %d bytes", screenshare.ErrTooLarge, screenshare.MaxBytes))
		return
	case err != nil:
		fail(http.StatusBadRequest, proto.ErrFrameInvalid, fmt.Errorf("%w: the upload was cut off", screenshare.ErrInvalid))
		return
	}
	info, err := screenshare.Check(b)
	switch {
	case errors.Is(err, screenshare.ErrTooLarge):
		fail(http.StatusRequestEntityTooLarge, proto.ErrFrameTooLarge, err)
		return
	case err != nil:
		fail(http.StatusUnprocessableEntity, proto.ErrFrameInvalid, err)
		return
	}
	ok, err := s.hub.deliverFrame(context.WithoutCancel(r.Context()), id, frameResult{b: b, info: info})
	if err != nil || !ok {
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "no screen grab is waiting for this frame (it timed out or was answered)")
		return
	}
	logoOK(w, map[string]int{"bytes": info.Bytes, "w": info.W, "h": info.H})
}
