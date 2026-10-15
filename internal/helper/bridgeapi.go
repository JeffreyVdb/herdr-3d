package helper

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

// #57: the helper's bridge list, for Settings → Bridges and ⌘P → Switch bridge.
//
//	GET    /api/bridges                the list, each entry with its state now
//	POST   /api/bridges                add {name, kind, host?, remote_socket?, socket?}
//	PUT    /api/bridges/{id}           change an entry (the same fields; its id stays)
//	DELETE /api/bridges/{id}           remove one (not the one in use: 409)
//	POST   /api/bridges/{id}/activate  put one in use
//
// Every answer that succeeds is the list, as GET gives it; a refusal is the
// protocol's error object ({"t":"error","code","message"}), its message
// written for the Settings form. They are guarded like /api/open: the Host,
// the token in X-H3D-Token (never in a URL), and the page's own Origin. A GET
// may come without an Origin, as /logo's: a browser leaves it out of a
// same-origin GET; the token header still makes a cross-site read impossible
// (it is not a simple request, and the helper answers no CORS preflight).

const maxBridgeBody = 4 << 10

func isBridgesPath(p string) bool {
	return p == "/api/bridges" || strings.HasPrefix(p, "/api/bridges/")
}

func (s *Server) bridgeRoutes(mux *http.ServeMux) {
	if s.cfg.Bridges == nil {
		mux.HandleFunc("/api/bridges", func(w http.ResponseWriter, _ *http.Request) {
			uploadError(w, http.StatusNotFound, "not_found", "this helper has no bridge list")
		})
		return
	}
	mux.Handle("GET /api/bridges", s.checkAPI(false, http.HandlerFunc(s.listBridges)))
	mux.Handle("POST /api/bridges", s.checkAPI(true, s.bridgeBody(func(_ *http.Request, e BridgeEntry) error {
		_, err := s.cfg.Bridges.Add(e)
		return err
	})))
	mux.Handle("PUT /api/bridges/{id}", s.checkAPI(true, s.bridgeBody(func(r *http.Request, e BridgeEntry) error {
		_, err := s.cfg.Bridges.Update(r.PathValue("id"), e)
		return err
	})))
	mux.Handle("DELETE /api/bridges/{id}", s.checkAPI(true, s.bridgeChange(func(r *http.Request) error { return s.cfg.Bridges.Remove(r.PathValue("id")) })))
	mux.Handle("POST /api/bridges/{id}/activate", s.checkAPI(true, s.bridgeChange(func(r *http.Request) error { return s.cfg.Bridges.Activate(r.PathValue("id")) })))
	notAllowed := func(allow string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Allow", allow)
			uploadError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		}
	}
	mux.HandleFunc("/api/bridges", notAllowed("GET, POST"))
	mux.HandleFunc("/api/bridges/{id}", notAllowed("PUT, DELETE"))
	mux.HandleFunc("/api/bridges/{id}/activate", notAllowed("POST"))
	mux.HandleFunc("/api/bridges/", func(w http.ResponseWriter, _ *http.Request) {
		uploadError(w, http.StatusNotFound, "not_found", "no such route on the helper")
	})
}

// checkAPI is /api/open's guard: the token in X-H3D-Token and the helper's
// own Origin (needOrigin: always present; else only checked when present).
func (s *Server) checkAPI(needOrigin bool, next http.Handler) http.Handler {
	want := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); (needOrigin || o != "") && !s.origins[o] {
			s.forbid(w, r, "origin not allowed")
			return
		}
		if got := []byte(r.Header.Get(OpenTokenHeader)); len(want) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
			s.forbid(w, r, "bad token")
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

// bridgesBody is what GET and every change answer.
type bridgesBody struct {
	Active  string       `json:"active"`
	Bridges []BridgeInfo `json:"bridges"`
}

func (s *Server) listBridges(w http.ResponseWriter, _ *http.Request) {
	active, list := s.cfg.Bridges.List()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(bridgesBody{Active: active, Bridges: list})
}

// bridgeChange runs change and answers the list, or its refusal.
func (s *Server) bridgeChange(change func(*http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := change(r); err != nil {
			var be *BridgeError
			if errors.As(err, &be) {
				uploadError(w, be.Status, be.Code, be.Message)
			} else {
				uploadError(w, http.StatusInternalServerError, "internal", err.Error())
			}
			return
		}
		s.listBridges(w, r)
	})
}

// bridgeBody reads an entry's fields (JSON, at most 4 KiB, nothing else) for change.
func (s *Server) bridgeBody(change func(*http.Request, BridgeEntry) error) http.Handler {
	return s.bridgeChange(func(r *http.Request) error {
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(ct), "application/json") {
			return bridgeErr(http.StatusUnsupportedMediaType, "bad_request", "content type must be application/json")
		}
		var body struct {
			Name         string `json:"name"`
			Kind         string `json:"kind"`
			Host         string `json:"host"`
			RemoteSocket string `json:"remote_socket"`
			Socket       string `json:"socket"`
		}
		dec := json.NewDecoder(io.LimitReader(r.Body, maxBridgeBody))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			return bridgeErr(http.StatusBadRequest, "bad_request", `want {"name", "kind": "ssh" or "local", "host", "remote_socket", "socket"}`)
		}
		return change(r, BridgeEntry{Name: body.Name, Kind: body.Kind, Host: strings.TrimSpace(body.Host), RemoteSocket: strings.TrimSpace(body.RemoteSocket), Socket: strings.TrimSpace(body.Socket)})
	})
}
