package helper

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// Bridge is the far end of the tunnel, as the server sees it.
type Bridge interface {
	Dial(ctx context.Context) (net.Conn, error)
	Status() Status
}

// NewToken returns a random token for one helper run.
func NewToken() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ServerConfig configures the helper's HTTP server.
type ServerConfig struct {
	// Port the server is reachable on: Host and Origin must be
	// 127.0.0.1:Port, localhost:Port or ListenHost:Port.
	Port       int
	ListenHost string
	Token      string
	Bridge     Bridge
	// Bundle is a built game (game/dist). Dev, if set, is a Vite dev server
	// that gets every request except /ws and /healthz instead.
	Bundle string
	Dev    *url.URL
	Log    *slog.Logger
}

// Server is the helper's HTTP front: the game, /ws to the bridge, /healthz.
type Server struct {
	cfg     ServerConfig
	hosts   map[string]bool
	origins map[string]bool
}

// NewServer returns a server for cfg.
func NewServer(cfg ServerConfig) *Server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	port := strconv.Itoa(cfg.Port)
	s := &Server{cfg: cfg, hosts: map[string]bool{}, origins: map[string]bool{}}
	for _, h := range []string{"127.0.0.1", "localhost", cfg.ListenHost} {
		if h == "" {
			continue
		}
		hp := net.JoinHostPort(h, port)
		s.hosts[hp] = true
		s.origins["http://"+hp] = true
	}
	return s
}

// Handler serves everything. Every request must name the helper in its
// Host header (no DNS rebinding); /ws also needs a same-origin Origin and
// the token.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.Handle("GET /ws", s.checkWS(s.bridgeProxy()))
	if s.cfg.Dev != nil {
		mux.Handle("/", s.devProxy())
	} else {
		mux.Handle("/", s.bundle())
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.hosts[r.Host] {
			s.forbid(w, r, "host not allowed")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *Server) forbid(w http.ResponseWriter, r *http.Request, why string) {
	s.cfg.Log.Warn("request refused", "why", why, "path", r.URL.Path, "host", r.Host, "origin", r.Header.Get("Origin"), "remote", r.RemoteAddr)
	http.Error(w, "forbidden: "+why, http.StatusForbidden)
}

func (s *Server) checkWS(next http.Handler) http.Handler {
	want := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.origins[r.Header.Get("Origin")] {
			s.forbid(w, r, "origin not allowed")
			return
		}
		if got := []byte(r.URL.Query().Get("token")); len(want) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
			s.forbid(w, r, "bad token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// bridgeProxy forwards /ws (the WebSocket upgrade included) to the bridge
// through the tunnel. The token stays here, and Origin is dropped: it was
// checked above and would not match the bridge's own Host.
func (s *Server) bridgeProxy() http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = &url.URL{Scheme: "http", Host: "herdr-world", Path: "/ws"}
			pr.Out.Host = "herdr-world"
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Cookie")
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return s.cfg.Bridge.Dial(ctx) },
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			st := s.cfg.Bridge.Status()
			s.cfg.Log.Warn("bridge unreachable", "tunnel", st.State, "err", err)
			http.Error(w, "bridge unreachable (tunnel "+st.State+")", http.StatusBadGateway)
		},
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	st := s.cfg.Bridge.Status()
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if st.State != StateUp {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"version": version.Version, "tunnel": st})
}

// devProxy hands requests to a Vite dev server (HMR WebSocket included),
// keeping the browser's Host so Vite sees the page's own origin.
func (s *Server) devProxy() http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(s.cfg.Dev)
			pr.Out.Host = pr.In.Host
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			s.cfg.Log.Warn("dev server unreachable", "upstream", s.cfg.Dev.String(), "err", err)
			http.Error(w, "dev server unreachable: "+s.cfg.Dev.String(), http.StatusBadGateway)
		},
	}
}

// contentTypes covers what a game bundle ships that Go's built-in table
// may not know (or may map differently per OS).
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".map":   "application/json",
	".wasm":  "application/wasm",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".webp":  "image/webp",
	".ktx2":  "image/ktx2",
	".glb":   "model/gltf-binary",
	".gltf":  "model/gltf+json",
	".bin":   "application/octet-stream",
	".woff2": "font/woff2",
	".ico":   "image/x-icon",
	".txt":   "text/plain; charset=utf-8",
}

// bundle serves the built game. Unknown extensionless paths get index.html
// (single-page app); Vite's hashed /assets/ are cached for good, the rest
// is revalidated.
func (s *Server) bundle() http.Handler {
	root := http.Dir(s.cfg.Bundle)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := path.Clean("/" + r.URL.Path)
		f, fi := openFile(root, p)
		if f == nil {
			if f, fi = openFile(root, path.Join(p, "index.html")); f != nil {
				p = path.Join(p, "index.html")
			} else if path.Ext(p) == "" {
				p = "/index.html"
				f, fi = openFile(root, p)
			}
		}
		if f == nil {
			http.NotFound(w, r)
			return
		}
		defer f.Close()
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		if ct, ok := contentTypes[strings.ToLower(path.Ext(p))]; ok {
			h.Set("Content-Type", ct)
		}
		if strings.HasPrefix(p, "/assets/") {
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			h.Set("Cache-Control", "no-cache")
		}
		http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
	})
}

// openFile opens a regular file under root, or returns nil.
func openFile(root http.Dir, name string) (http.File, fs.FileInfo) {
	f, err := root.Open(name)
	if err != nil {
		return nil, nil
	}
	fi, err := f.Stat()
	if err != nil || !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil
	}
	return f, fi
}

// CheckBundle reports whether dir holds a built game.
func CheckBundle(dir string) error {
	fi, err := os.Stat(filepath.Join(dir, "index.html"))
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no game bundle at %s (index.html missing): build it with `make game-build` and copy game/dist there, or pass -bundle / -dev-upstream", dir)
		}
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%s/index.html is not a file", dir)
	}
	return nil
}
