package helper

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/whiteboard"
)

// M13 whiteboard: what the helper lets through to the bridge's whiteboard
// routes. The bridge counts the bytes and gives the exact verdict; these
// only keep a runaway body out of the tunnel.
const (
	maxWhiteboardSave = whiteboard.MaxScene + whiteboard.MaxRender + 128<<10
	maxWhiteboardFile = whiteboard.MaxFile + 4<<10
)

func isWhiteboardPath(p string) bool {
	return strings.HasPrefix(p, "/whiteboard/") || strings.HasPrefix(p, "/drops/")
}

func (s *Server) whiteboardRoutes(mux *http.ServeMux) {
	board := func(rest func(*http.Request) string, keep ...string) http.Handler {
		return s.bridgeRoute(func(r *http.Request) string {
			return "/whiteboard/" + r.PathValue("floor") + rest(r)
		}, keep)
	}
	mux.Handle("GET /whiteboard/{floor}", s.checkLogo(board(func(*http.Request) string { return "" }, "version")))
	mux.Handle("POST /whiteboard/{floor}/save", s.checkLogo(s.limitBody(maxWhiteboardSave, board(func(*http.Request) string { return "/save" }, "base", "author"))))
	mux.Handle("GET /whiteboard/{floor}/render.png", s.checkLogo(board(func(*http.Request) string { return "/render.png" }, "v")))
	file := board(func(r *http.Request) string { return "/files/" + r.PathValue("id") })
	mux.Handle("GET /whiteboard/{floor}/files/{id}", s.checkLogo(file))
	mux.Handle("PUT /whiteboard/{floor}/files/{id}", s.checkLogo(s.limitBody(maxWhiteboardFile, file)))
	mux.Handle("GET /drops/file", s.checkLogo(s.bridgeRoute(func(*http.Request) string { return "/drops/file" }, []string{"path", "thumb"})))
	refuse := func(w http.ResponseWriter, r *http.Request) {
		uploadError(w, http.StatusNotFound, "not_found", "no such route on the helper")
	}
	mux.HandleFunc("/whiteboard/", refuse)
	mux.HandleFunc("/drops/", refuse)
}

// limitBody refuses a body over n bytes, by Content-Length at once and by
// counting while it streams. It never truncates.
func (s *Server) limitBody(n int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > n {
			uploadError(w, http.StatusRequestEntityTooLarge, "whiteboard_too_large", "the body is too large")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, n)
		next.ServeHTTP(w, r)
	})
}

// bridgeRoute forwards a request to the bridge at the path pathOf gives,
// with only the query parameters in keep: the token, Origin, Cookie and
// Authorization stay here.
func (s *Server) bridgeRoute(pathOf func(*http.Request) string, keep []string) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			q := url.Values{}
			for _, k := range keep {
				if v, ok := pr.In.URL.Query()[k]; ok && len(v) > 0 {
					q.Set(k, v[0])
				}
			}
			p := pathOf(pr.In)
			pr.Out.URL = &url.URL{Scheme: "http", Host: proxyHost(pr.In), Path: p, RawQuery: q.Encode()}
			pr.Out.Host = "herdr-world"
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
		},
		Transport: &http.Transport{
			DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return s.cfg.Bridge.Dial(ctx) },
			ResponseHeaderTimeout: 90 * time.Second, // a save writes up to 32 MiB
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			if errors.Is(err, ErrBridgeChanged) {
				s.refuseChanged(w, r)
				return
			}
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				uploadError(w, http.StatusRequestEntityTooLarge, "whiteboard_too_large", "the body is too large")
				return
			}
			st := s.cfg.Bridge.Status()
			s.cfg.Log.Warn("bridge unreachable", "tunnel", st.State, "err", err)
			uploadError(w, http.StatusBadGateway, "bridge_unreachable", "the bridge is not reachable (tunnel "+st.State+")")
		},
	}
}
