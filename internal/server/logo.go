package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/logo"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// M3d building logos. Upload, clear and fetch are HTTP, not WebSocket
// commands: a WebSocket message is capped at 256 KiB and a logo may be 1 MiB.
// The routes sit on the bridge's socket like /ws; h3d-helper proxies them
// behind its token check. docs/protocol.md "Building logos".

const (
	uploadTimeout = 30 * time.Second // reading the body of a PUT
	logoClient    = "http"           // the audit log's client for a logo change
)

var buildingIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// SetBuildingLogo stores a normalised logo for a building and tells the
// clients (a building.upsert carrying the new hash). ErrNotFound: no such
// building.
func (h *Hub) SetBuildingLogo(ctx context.Context, id string, res logo.Result) error {
	args, _ := json.Marshal(map[string]any{"id": id, "hash": res.Hash, "bytes": len(res.PNG), "w": res.W, "h": res.H})
	return h.logoOp(ctx, "building.logo.set", args, func(ctx context.Context) error {
		return h.st.SetLogo(ctx, id, store.Logo{Hash: res.Hash, PNG: res.PNG, W: res.W, H: res.H})
	})
}

// ClearBuildingLogo removes a building's logo (none is not an error).
func (h *Hub) ClearBuildingLogo(ctx context.Context, id string) error {
	args, _ := json.Marshal(map[string]string{"id": id})
	return h.logoOp(ctx, "building.logo.clear", args, func(ctx context.Context) error {
		return h.st.ClearLogo(ctx, id)
	})
}

// BuildingLogo returns a building's logo; store.ErrNotFound without one.
func (h *Hub) BuildingLogo(ctx context.Context, id string) (store.Logo, error) {
	return h.st.LogoOf(ctx, id)
}

// HasBuilding reports whether the building exists.
func (h *Hub) HasBuilding(ctx context.Context, id string) (bool, error) {
	return h.st.HasBuilding(ctx, id)
}

// logoOp runs a logo change in the hub goroutine, like a command: apply it,
// read the buildings back, emit what changed, audit it.
func (h *Hub) logoOp(ctx context.Context, cmd string, args json.RawMessage, apply func(context.Context) error) error {
	errc := make(chan error, 1)
	if err := h.do(ctx, func(ctx context.Context) {
		err := apply(ctx)
		if err == nil {
			if err = h.reload(ctx); err == nil {
				h.syncLayout()
			}
		}
		if aerr := h.st.Audit(ctx, logoClient, cmd, args, err); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		errc <- err
	}); err != nil {
		return err
	}
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *Server) logoRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /logo/{id}", s.getLogo)
	mux.HandleFunc("PUT /logo/{id}", s.putLogo)
	mux.HandleFunc("DELETE /logo/{id}", s.deleteLogo)
}

// logoError answers with the protocol's error shape and an HTTP status.
func logoError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(proto.Error{T: proto.TError, Code: code, Message: msg})
}

func logoOK(w http.ResponseWriter, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(proto.Ack{T: proto.TAck, Data: data})
}

// logoFailure maps a pipeline or store error to its status and code.
func logoFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, logo.ErrTooLarge):
		logoError(w, http.StatusRequestEntityTooLarge, proto.ErrLogoTooLarge, err.Error())
	case errors.Is(err, logo.ErrUnsupported):
		logoError(w, http.StatusUnsupportedMediaType, proto.ErrLogoUnsupported, err.Error())
	case errors.Is(err, logo.ErrInvalid):
		logoError(w, http.StatusUnprocessableEntity, proto.ErrLogoInvalid, err.Error())
	case errors.Is(err, logo.ErrBusy):
		w.Header().Set("Retry-After", "5")
		logoError(w, http.StatusServiceUnavailable, proto.ErrLogoBusy, err.Error())
	case errors.Is(err, store.ErrNotFound):
		logoError(w, http.StatusNotFound, proto.ErrNotFound, err.Error())
	default:
		logoError(w, http.StatusInternalServerError, proto.ErrInternal, "internal error")
	}
}

// buildingID reads and checks the id in the path; it answers 404 itself.
func buildingID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("id")
	if !buildingIDRe.MatchString(id) {
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "no such building")
		return "", false
	}
	return id, true
}

func (s *Server) getLogo(w http.ResponseWriter, r *http.Request) {
	id, ok := buildingID(w, r)
	if !ok {
		return
	}
	l, err := s.hub.BuildingLogo(r.Context(), id)
	if err != nil {
		logoFailure(w, err)
		return
	}
	// ?h= names the bytes the caller wants. If the logo has been replaced
	// since, answer not_found instead of the new image: the caller would
	// file it under the old hash (and share it with every building that still
	// advertises that hash). The new hash comes with the building's next
	// building.upsert.
	if h := r.URL.Query().Get("h"); h != "" && h != l.Hash {
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "the logo has changed since that hash")
		return
	}
	hd := w.Header()
	hd.Set("Content-Type", "image/png")
	hd.Set("X-Content-Type-Options", "nosniff")
	hd.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	hd.Set("ETag", `"`+l.Hash+`"`)
	// The hash names the bytes: a URL that carries the current hash never
	// changes. A URL without one is revalidated.
	if r.URL.Query().Get("h") == l.Hash {
		hd.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		hd.Set("Cache-Control", "no-cache")
	}
	if inm := r.Header.Get("If-None-Match"); inm != "" && strings.Contains(inm, `"`+l.Hash+`"`) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	hd.Set("Content-Length", strconv.Itoa(len(l.PNG)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(l.PNG)
}

func (s *Server) putLogo(w http.ResponseWriter, r *http.Request) {
	id, ok := buildingID(w, r)
	if !ok {
		return
	}
	if r.ContentLength > logo.MaxInput {
		logoError(w, http.StatusRequestEntityTooLarge, proto.ErrLogoTooLarge, fmt.Sprintf("the file is over %d bytes", logo.MaxInput))
		return
	}
	exists, err := s.hub.HasBuilding(r.Context(), id)
	if err != nil {
		logoFailure(w, err)
		return
	}
	if !exists {
		logoError(w, http.StatusNotFound, proto.ErrNotFound, "no such building")
		return
	}
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(uploadTimeout))
	// The whole body or an error: an oversize upload is refused, never cut off.
	data, err := readBody(w, r)
	if err != nil {
		logoFailure(w, err)
		return
	}
	res, err := s.conv.Convert(r.Context(), data)
	if err != nil {
		if r.Context().Err() == nil {
			logoFailure(w, err)
		}
		return
	}
	if err := s.hub.SetBuildingLogo(r.Context(), id, res); err != nil {
		logoFailure(w, err)
		return
	}
	logoOK(w, map[string]any{"id": id, "logo": res.Hash, "w": res.W, "h": res.H, "bytes": len(res.PNG)})
}

func readBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, logo.MaxInput))
	if err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return nil, fmt.Errorf("%w: the file is over %d bytes", logo.ErrTooLarge, logo.MaxInput)
		}
		return nil, fmt.Errorf("%w: the upload was cut off", logo.ErrInvalid)
	}
	return data, nil
}

func (s *Server) deleteLogo(w http.ResponseWriter, r *http.Request) {
	id, ok := buildingID(w, r)
	if !ok {
		return
	}
	if err := s.hub.ClearBuildingLogo(r.Context(), id); err != nil {
		logoFailure(w, err)
		return
	}
	logoOK(w, map[string]any{"id": id})
}
