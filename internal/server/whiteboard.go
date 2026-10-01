package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/drops"
	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/whiteboard"
)

// M13 whiteboard (#15). The board's bytes (scene JSON, image files, the PNG
// render) go over HTTP on the bridge's socket, like the logos and /upload: a
// WebSocket message is capped at 256 KiB, a scene at 16 MiB. h3d-helper
// proxies the browser's routes behind its token check; POST
// /whiteboard/{floor}/pin is for the office CLI on this host (M14) and is
// not proxied. The commands without bytes (whiteboard.get, .clear, .pin of
// a note, drops.list) are WebSocket commands. Every change is audited and
// announced with whiteboard.updated. docs/protocol.md "Whiteboard".

const (
	whiteboardClient  = "http" // the audit log's client for an HTTP change
	whiteboardTimeout = 60 * time.Second
	// maxSaveBody is a save's multipart body: the scene, the render and
	// their part headers.
	maxSaveBody = whiteboard.MaxScene + whiteboard.MaxRender + 64<<10
	maxAuthor   = 64
)

// ---- hub -------------------------------------------------------------------

func stateOf(floor string, h whiteboard.Head) proto.WhiteboardState {
	pins := make([]proto.WhiteboardPin, 0, len(h.StalePins))
	for _, p := range h.StalePins {
		pins = append(pins, proto.WhiteboardPin{ID: p.ID, Kind: p.Kind, Author: p.Author, Note: p.Note, File: p.File, Version: p.Version, At: p.At})
	}
	return proto.WhiteboardState{Floor: floor, Version: h.Version, Author: h.Author, At: h.At, RenderVersion: h.RenderVersion, Render: h.Render, Stale: h.Stale(), StalePins: pins}
}

// emitWhiteboard sends whiteboard.updated (hub goroutine). Its shape is not
// proto.Event's (its floor is a name), so it is sequenced here.
func (h *Hub) emitWhiteboard(st proto.WhiteboardState) {
	h.seq++
	msg := mustJSON(proto.WhiteboardUpdated{T: proto.EvWhiteboardUpdated, Seq: h.seq, WhiteboardState: st})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// whiteboardDone audits a board change and announces it when it happened
// (any goroutine; it waits for the hub).
func (h *Hub) whiteboardDone(ctx context.Context, client, cmd string, args any, floor string, head *whiteboard.Head, err error) {
	a, _ := json.Marshal(args)
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if derr := h.doWait(actx, func() {
		if err == nil && head != nil {
			h.emitWhiteboard(stateOf(floor, *head))
		}
		if aerr := h.st.Audit(actx, client, cmd, a, err); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
	}); derr != nil {
		h.log.Warn("whiteboard change not announced", "cmd", cmd, "floor", floor, "err", derr)
	}
}

// writableFloor checks that floor is a floor the hub watches: boards are
// only written for those (a read only needs a valid name).
func (h *Hub) writableFloor(ctx context.Context, floor string) error {
	if !whiteboard.ValidFloor(floor) {
		return fmt.Errorf("%w: %q", errUnknownSession, floor)
	}
	known, err := query(ctx, h, func() error { _, err := h.floorFor(floor); return err })
	if err != nil {
		return err
	}
	return known
}

// whiteboardCode is the protocol code of a whiteboard or drops error ("" when
// it is none of theirs).
func whiteboardCode(err error) string {
	var conflict *whiteboard.ConflictError
	switch {
	case errors.As(err, &conflict):
		return proto.ErrWhiteboardConflict
	case errors.Is(err, whiteboard.ErrInvalidFloor):
		return proto.ErrNotFound
	case errors.Is(err, whiteboard.ErrHashMismatch):
		return proto.ErrWhiteboardHash
	case errors.Is(err, whiteboard.ErrMissingFile):
		return proto.ErrWhiteboardMissingFile
	case errors.Is(err, whiteboard.ErrTooLarge):
		return proto.ErrWhiteboardTooLarge
	case errors.Is(err, whiteboard.ErrUnsupported):
		return proto.ErrWhiteboardUnsupported
	case errors.Is(err, whiteboard.ErrInvalid):
		return proto.ErrWhiteboardInvalid
	case errors.Is(err, whiteboard.ErrNotFound):
		return proto.ErrNotFound
	case errors.Is(err, drops.ErrNoRoot):
		return proto.ErrDropsUnavailable
	}
	return ""
}

func (h *Hub) whiteboards() (*whiteboard.Store, error) {
	if h.opts.Whiteboards == nil {
		return nil, &codedError{proto.ErrUnsupported, errors.New("this bridge keeps no whiteboards")}
	}
	return h.opts.Whiteboards, nil
}

// wbErr gives a store error its protocol code for a command's reply.
func wbErr(err error) error {
	if code := whiteboardCode(err); code != "" {
		return &codedError{code, err}
	}
	return err
}

// startWhiteboardGet answers whiteboard.get: the board's state (its content
// is GET /whiteboard/{floor}).
func (h *Hub) startWhiteboardGet(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WhiteboardArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	st, err := h.whiteboards()
	if err != nil {
		return err
	}
	if !whiteboard.ValidFloor(a.Floor) {
		return fmt.Errorf("%w: %q", errUnknownSession, a.Floor)
	}
	h.startAsync(ctx, c, cmd, func(context.Context) (any, error) {
		head, err := st.Head(a.Floor)
		if err != nil {
			return nil, wbErr(err)
		}
		return stateOf(a.Floor, head), nil
	})
	return nil
}

// startWhiteboardClear answers whiteboard.clear: a new, empty version (the
// history stays), after the user confirmed.
func (h *Hub) startWhiteboardClear(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WhiteboardClearArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	st, err := h.whiteboards()
	if err != nil {
		return err
	}
	if _, err := h.floorFor(a.Floor); err != nil {
		return err
	}
	if !a.Confirm {
		return &codedError{proto.ErrConfirmationRequired, errors.New("clearing the whiteboard needs confirm: true")}
	}
	author := a.Author
	if author == "" {
		author = c.name
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		head, err := st.Clear(a.Floor, author)
		err = wbErr(err)
		h.whiteboardReply(ctx, c, cmd, a.Floor, &head, err, map[string]any{"floor": a.Floor, "version": head.Version})
	}()
	return nil
}

// whiteboardReply announces, audits and answers a board change made by a
// command, in that order (the ack after the event).
func (h *Hub) whiteboardReply(ctx context.Context, c *Client, cmd proto.Command, floor string, head *whiteboard.Head, err error, data any) {
	if derr := h.doWait(ctx, func() {
		if err == nil {
			h.emitWhiteboard(stateOf(floor, *head))
		}
		h.audit(ctx, c, cmd, err)
		h.reply(c, cmd, data, err)
	}); derr != nil {
		h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
	}
}

// startWhiteboardPin answers whiteboard.pin: an agent's note.
func (h *Hub) startWhiteboardPin(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WhiteboardPinArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	st, err := h.whiteboards()
	if err != nil {
		return err
	}
	if _, err := h.floorFor(a.Floor); err != nil {
		return err
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		res, err := st.Pin(a.Floor, whiteboard.Pin{Author: a.Author, Note: a.Note, RequestID: a.RequestID})
		err = wbErr(err)
		var data any
		if err == nil {
			data = pinResult(a.Floor, res)
		}
		head := res.Head
		if res.Repeated {
			_ = h.doWait(ctx, func() { h.audit(ctx, c, cmd, err); h.reply(c, cmd, data, err) }) // a retry: nothing changed
			return
		}
		h.whiteboardReply(ctx, c, cmd, a.Floor, &head, err, data)
	}()
	return nil
}

func pinResult(floor string, res whiteboard.PinResult) proto.WhiteboardPinResult {
	out := proto.WhiteboardPinResult{WhiteboardState: stateOf(floor, res.Head), Repeated: res.Repeated, Elements: []string{}}
	for _, raw := range res.Elements {
		var e struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &e) == nil {
			out.Elements = append(out.Elements, e.ID)
		}
	}
	return out
}

// PinWhiteboard pins an agent's image or note on a floor's board, audits it
// as client's and announces it: the office CLI's (M14) way in, and POST
// /whiteboard/{floor}/pin's.
func (h *Hub) PinWhiteboard(ctx context.Context, client, floor string, p whiteboard.Pin) (proto.WhiteboardPinResult, error) {
	st, err := h.whiteboards()
	if err != nil {
		return proto.WhiteboardPinResult{}, err
	}
	args := map[string]any{"floor": floor, "author": p.Author, "kind": whiteboard.PinNote, "bytes": len(p.Note), "request_id": p.RequestID}
	if len(p.Image) > 0 {
		args["kind"], args["bytes"] = whiteboard.PinImage, len(p.Image)
	}
	if err := h.writableFloor(ctx, floor); err != nil {
		h.whiteboardDone(ctx, client, proto.CmdWhiteboardPin, args, floor, nil, err)
		return proto.WhiteboardPinResult{}, err
	}
	res, err := st.Pin(floor, p)
	err = wbErr(err)
	args["version"] = res.Head.Version
	head := &res.Head
	if err != nil || res.Repeated {
		head = nil
	}
	h.whiteboardDone(ctx, client, proto.CmdWhiteboardPin, args, floor, head, err)
	if err != nil {
		return proto.WhiteboardPinResult{}, err
	}
	return pinResult(floor, res), nil
}

// startDropsList answers drops.list: the newest files in Drop Zone's data
// directory, read only.
func (h *Hub) startDropsList(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.DropsListArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Limit < 0 || a.Limit > drops.MaxLimit {
		return &badArgsError{fmt.Errorf("limit is 1-%d", drops.MaxLimit)}
	}
	root := h.opts.DropsRoot
	h.startAsync(ctx, c, cmd, func(context.Context) (any, error) {
		list, err := drops.List(root, a.Limit)
		if err != nil {
			if !errors.Is(err, drops.ErrNoRoot) {
				h.log.Warn("drops not readable", "root", root, "err", err)
				err = fmt.Errorf("%w: %v", drops.ErrNoRoot, err)
			}
			return nil, wbErr(err)
		}
		out := proto.DropsList{Drops: make([]proto.Drop, 0, len(list))}
		for _, d := range list {
			out.Drops = append(out.Drops, proto.Drop(d))
		}
		return out, nil
	})
	return nil
}

// ---- HTTP ------------------------------------------------------------------

func (s *Server) whiteboardRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /whiteboard/{floor}", s.getWhiteboard)
	mux.HandleFunc("POST /whiteboard/{floor}/save", s.saveWhiteboard)
	mux.HandleFunc("GET /whiteboard/{floor}/render.png", s.getWhiteboardRender)
	mux.HandleFunc("GET /whiteboard/{floor}/files/{id}", s.getWhiteboardFile)
	mux.HandleFunc("PUT /whiteboard/{floor}/files/{id}", s.putWhiteboardFile)
	mux.HandleFunc("POST /whiteboard/{floor}/pin", s.pinWhiteboard)
	mux.HandleFunc("GET /drops/file", s.getDropFile)
}

// wbFail answers a whiteboard or drops error with its status and code.
func wbFail(w http.ResponseWriter, err error) {
	var conflict *whiteboard.ConflictError
	if errors.As(err, &conflict) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"t": proto.TError, "code": proto.ErrWhiteboardConflict, "message": err.Error(), "version": conflict.Current})
		return
	}
	code := whiteboardCode(err)
	if code == "" {
		code = errorCode(err) // the hub's: bad args, an unknown floor, a coded error
	}
	status := map[string]int{
		proto.ErrNotFound: http.StatusNotFound, proto.ErrUnknownSession: http.StatusNotFound,
		proto.ErrWhiteboardHash: http.StatusUnprocessableEntity, proto.ErrWhiteboardMissingFile: http.StatusUnprocessableEntity,
		proto.ErrWhiteboardTooLarge: http.StatusRequestEntityTooLarge, proto.ErrWhiteboardUnsupported: http.StatusUnsupportedMediaType,
		proto.ErrWhiteboardInvalid: http.StatusBadRequest, proto.ErrBadRequest: http.StatusBadRequest,
		proto.ErrDropsUnavailable: http.StatusServiceUnavailable, proto.ErrUnsupported: http.StatusNotImplemented,
	}[code]
	if status == 0 {
		logoError(w, http.StatusInternalServerError, proto.ErrInternal, "internal error")
		return
	}
	logoError(w, status, code, err.Error())
}

// floorOf reads the floor in the path; it answers 404 itself.
func floorOf(w http.ResponseWriter, r *http.Request) (string, bool) {
	f := r.PathValue("floor")
	if !whiteboard.ValidFloor(f) {
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "no such floor")
		return "", false
	}
	return f, true
}

func (s *Server) wbStore(w http.ResponseWriter) (*whiteboard.Store, bool) {
	st, err := s.hub.whiteboards()
	if err != nil {
		wbFail(w, err)
		return nil, false
	}
	return st, true
}

// author is the ?author= of a change: printable, at most maxAuthor bytes.
func author(r *http.Request) string {
	a := r.URL.Query().Get("author")
	if len(a) > maxAuthor {
		a = a[:maxAuthor]
	}
	return strings.ToValidUTF8(a, "")
}

// GET /whiteboard/{floor}[?version=N]: the board (or a kept older version):
// its state, scene and the manifest of its files.
func (s *Server) getWhiteboard(w http.ResponseWriter, r *http.Request) {
	floor, ok := floorOf(w, r)
	if !ok {
		return
	}
	st, ok := s.wbStore(w)
	if !ok {
		return
	}
	b, err := st.Get(floor)
	if err != nil {
		wbFail(w, err)
		return
	}
	sn := b.Snapshot
	if v := r.URL.Query().Get("version"); v != "" {
		n, perr := strconv.ParseInt(v, 10, 64)
		if perr != nil || n < 1 {
			logoError(w, http.StatusBadRequest, proto.ErrBadRequest, "version is a positive integer")
			return
		}
		if sn, err = st.Version(floor, n); err != nil {
			wbFail(w, err)
			return
		}
	}
	history := make([]map[string]any, 0, len(b.Retained))
	for _, rv := range b.Retained {
		history = append(history, map[string]any{"version": rv.Version, "author": rv.Author, "at": rv.At})
	}
	logoOK(w, map[string]any{
		"state": stateOf(floor, b.Head), "version": sn.Version, "scene": sn.Scene, "files": sn.Files,
		"excalidraw_version": whiteboard.ExcalidrawVersion, "history": history,
	})
}

// POST /whiteboard/{floor}/save?base=N&author=…: a new version. The body is
// multipart/form-data with a "scene" part (JSON {"elements","appState"}) and
// a "render" part (the PNG export); the files the scene uses were PUT
// before. 409 whiteboard_conflict (with "version") when base is not current.
func (s *Server) saveWhiteboard(w http.ResponseWriter, r *http.Request) {
	floor, ok := floorOf(w, r)
	if !ok {
		return
	}
	st, ok := s.wbStore(w)
	if !ok {
		return
	}
	base, perr := strconv.ParseInt(r.URL.Query().Get("base"), 10, 64)
	who := author(r)
	args := map[string]any{"floor": floor, "base": base, "author": who}
	fail := func(err error) {
		s.hub.whiteboardDone(r.Context(), whiteboardClient, "whiteboard.save", args, floor, nil, err)
		wbFail(w, err)
	}
	if perr != nil || base < 0 {
		fail(&badArgsError{errors.New("base is the version the save is based on (0 for a new board)")})
		return
	}
	if err := s.hub.writableFloor(r.Context(), floor); err != nil {
		fail(err)
		return
	}
	if r.ContentLength > maxSaveBody {
		fail(fmt.Errorf("%w: a save is at most %d bytes", whiteboard.ErrTooLarge, maxSaveBody))
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(whiteboardTimeout))
	scene, render, err := readSave(w, r)
	if err != nil {
		fail(err)
		return
	}
	args["scene_bytes"], args["render_bytes"] = len(scene), len(render)
	head, err := st.Save(floor, whiteboard.SaveInput{Base: base, Author: who, Scene: scene, Render: render})
	if err != nil {
		var conflict *whiteboard.ConflictError
		if !errors.As(err, &conflict) && whiteboardCode(err) == "" {
			s.log.Error("whiteboard save failed", "floor", floor, "err", err)
		}
		fail(err)
		return
	}
	args["version"] = head.Version
	s.hub.whiteboardDone(r.Context(), whiteboardClient, "whiteboard.save", args, floor, &head, nil)
	s.log.Info("whiteboard saved", "floor", floor, "version", head.Version, "author", head.Author)
	logoOK(w, stateOf(floor, head))
}

// readSave reads a save's two parts, each capped (never cut off).
func readSave(w http.ResponseWriter, r *http.Request) (scene, render []byte, err error) {
	mt, params, perr := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if perr != nil || mt != "multipart/form-data" || params["boundary"] == "" {
		return nil, nil, fmt.Errorf("%w: a save is multipart/form-data with scene and render parts", whiteboard.ErrInvalid)
	}
	mr := multipart.NewReader(http.MaxBytesReader(w, r.Body, maxSaveBody), params["boundary"])
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, nil, bodyErr(err)
		}
		var dst *[]byte
		var limit int64
		switch p.FormName() {
		case "scene":
			dst, limit = &scene, whiteboard.MaxScene
		case "render":
			dst, limit = &render, whiteboard.MaxRender
		default:
			p.Close()
			return nil, nil, fmt.Errorf("%w: unknown part %q", whiteboard.ErrInvalid, clipText(p.FormName()))
		}
		b, err := io.ReadAll(io.LimitReader(p, limit+1))
		p.Close()
		if err != nil {
			return nil, nil, bodyErr(err)
		}
		if int64(len(b)) > limit {
			return nil, nil, fmt.Errorf("%w: the %s part is over %d bytes", whiteboard.ErrTooLarge, p.FormName(), limit)
		}
		*dst = b
	}
	if scene == nil || render == nil {
		return nil, nil, fmt.Errorf("%w: a save needs a scene and a render part", whiteboard.ErrInvalid)
	}
	return scene, render, nil
}

func bodyErr(err error) error {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return fmt.Errorf("%w: the body is over %d bytes", whiteboard.ErrTooLarge, tooBig.Limit)
	}
	return fmt.Errorf("%w: the body was cut off", whiteboard.ErrInvalid)
}

func clipText(s string) string {
	if len(s) > 40 {
		s = s[:40]
	}
	return strings.ToValidUTF8(s, "")
}

// imageHeaders are the headers of bytes the bridge serves as an image: their
// type sniffed, never run as a document.
func imageHeaders(w http.ResponseWriter, mimeType string, n int) {
	hd := w.Header()
	hd.Set("Content-Type", mimeType)
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	hd.Set("Content-Length", strconv.Itoa(n))
}

// GET /whiteboard/{floor}/render.png: the latest render; X-Render-Version
// names the version it shows.
func (s *Server) getWhiteboardRender(w http.ResponseWriter, r *http.Request) {
	floor, ok := floorOf(w, r)
	if !ok {
		return
	}
	st, ok := s.wbStore(w)
	if !ok {
		return
	}
	b, v, err := st.Render(floor)
	if err != nil {
		wbFail(w, err)
		return
	}
	// ?v= names the version the caller wants; a newer render is not filed
	// under an older URL.
	if want := r.URL.Query().Get("v"); want != "" && want != strconv.FormatInt(v, 10) {
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "the render has changed since that version")
		return
	}
	imageHeaders(w, "image/png", len(b))
	w.Header().Set("X-Render-Version", strconv.FormatInt(v, 10))
	if r.URL.Query().Get("v") != "" {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-store")
	}
	_, _ = w.Write(b)
}

// GET /whiteboard/{floor}/files/{id}: an image file. Its id is the sha256 of
// its bytes, so the URL never changes.
func (s *Server) getWhiteboardFile(w http.ResponseWriter, r *http.Request) {
	floor, ok := floorOf(w, r)
	if !ok {
		return
	}
	st, ok := s.wbStore(w)
	if !ok {
		return
	}
	b, mt, err := st.File(floor, r.PathValue("id"))
	if err != nil {
		wbFail(w, err)
		return
	}
	imageHeaders(w, mt, len(b))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	_, _ = w.Write(b)
}

// PUT /whiteboard/{floor}/files/{id}: stores an image file before a save
// uses it. The id must be the sha256 of the body; a file already stored is
// not written again ("stored": false).
func (s *Server) putWhiteboardFile(w http.ResponseWriter, r *http.Request) {
	floor, ok := floorOf(w, r)
	if !ok {
		return
	}
	st, ok := s.wbStore(w)
	if !ok {
		return
	}
	id := r.PathValue("id")
	args := map[string]any{"floor": floor, "id": clipText(id)}
	fail := func(err error) {
		s.hub.whiteboardDone(r.Context(), whiteboardClient, "whiteboard.file", args, floor, nil, err)
		wbFail(w, err)
	}
	if err := s.hub.writableFloor(r.Context(), floor); err != nil {
		fail(err)
		return
	}
	if r.ContentLength > whiteboard.MaxFile {
		fail(fmt.Errorf("%w: an image is at most %d bytes", whiteboard.ErrTooLarge, whiteboard.MaxFile))
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(whiteboardTimeout))
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, whiteboard.MaxFile))
	if err != nil {
		fail(bodyErr(err))
		return
	}
	args["size"] = len(b)
	stored, mt, err := st.PutFile(floor, id, b)
	if err != nil {
		fail(err)
		return
	}
	args["stored"] = stored
	if stored { // a file already there changes nothing: no audit row per retry
		s.hub.whiteboardDone(r.Context(), whiteboardClient, "whiteboard.file", args, floor, nil, nil)
	}
	logoOK(w, map[string]any{"id": id, "mime": mt, "size": len(b), "stored": stored})
}

// POST /whiteboard/{floor}/pin?author=…&request_id=…: an agent's pin, for
// the office CLI on the bridge's host (M14; h3d-helper does not proxy it).
// The body is an image (PNG, JPEG, GIF, WebP) or, with Content-Type
// text/plain, a note.
func (s *Server) pinWhiteboard(w http.ResponseWriter, r *http.Request) {
	floor, ok := floorOf(w, r)
	if !ok {
		return
	}
	if r.ContentLength > whiteboard.MaxFile {
		wbFail(w, fmt.Errorf("%w: a pin is at most %d bytes", whiteboard.ErrTooLarge, whiteboard.MaxFile))
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(whiteboardTimeout))
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, whiteboard.MaxFile))
	if err != nil {
		wbFail(w, bodyErr(err))
		return
	}
	p := whiteboard.Pin{Author: author(r), RequestID: r.URL.Query().Get("request_id")}
	if mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); mt == "text/plain" {
		if !utf8.Valid(b) {
			wbFail(w, fmt.Errorf("%w: a note must be UTF-8 text", whiteboard.ErrInvalid))
			return
		}
		p.Note = string(b)
	} else {
		p.Image = b
	}
	if p.Note == "" && len(bytes.TrimSpace(p.Image)) == 0 {
		wbFail(w, fmt.Errorf("%w: the pin is empty", whiteboard.ErrInvalid))
		return
	}
	res, err := s.hub.PinWhiteboard(r.Context(), whiteboardClient, floor, p)
	if err != nil {
		wbFail(w, err)
		return
	}
	logoOK(w, res)
}

// GET /drops/file?path=…[&thumb=1]: a drop's image bytes (or thumbnail),
// read only from Drop Zone's data directory.
func (s *Server) getDropFile(w http.ResponseWriter, r *http.Request) {
	root := s.hub.opts.DropsRoot
	if root == "" {
		wbFail(w, drops.ErrNoRoot)
		return
	}
	path := r.URL.Query().Get("path")
	var data []byte
	var mt string
	if r.URL.Query().Get("thumb") == "1" {
		s.dropThumbs <- struct{}{} // decoding is bounded: two at a time
		th, err := drops.Thumb(root, path)
		<-s.dropThumbs
		if err != nil {
			dropFail(w, err)
			return
		}
		data, mt = th.Data, th.Mime
	} else {
		b, info, err := drops.Read(root, path)
		if err != nil {
			dropFail(w, err)
			return
		}
		data, mt = b, info.Mime
	}
	imageHeaders(w, mt, len(data))
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(data)
}

func dropFail(w http.ResponseWriter, err error) {
	reason := imgcache.Reason(err)
	switch reason {
	case imgcache.ReasonTooLarge:
		logoError(w, http.StatusRequestEntityTooLarge, reason, "the file is too large to show")
	case imgcache.ReasonNotImage:
		logoError(w, http.StatusUnsupportedMediaType, reason, "the file is not a PNG, JPEG, GIF or WebP image")
	default:
		// Outside the data directory, missing, a link out: all the same to the caller.
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "no such drop ("+reason+")")
	}
}
