package helper

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/upload"
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
	// BundleFS, if set, is used instead of the Bundle directory (the game
	// embedded in the binary).
	BundleFS fs.FS
	// MusicDir, if set, holds the radio's tracks (music/<genre>/<id>.ogg). A file
	// there is served for GET /music/...; anything else falls through to the game.
	MusicDir string
	Dev      *url.URL
	Log      *slog.Logger
	// M7: POST /api/open. Open opens an https URL of OpenHosts in the user's
	// browser (default SystemOpen; OpenHosts default DefaultOpenHosts).
	Open      Opener
	OpenHosts []string
}

// Server is the helper's HTTP front: the game, /ws to the bridge, /healthz.
type Server struct {
	cfg       ServerConfig
	hosts     map[string]bool
	origins   map[string]bool
	openHosts map[string]bool
}

// NewServer returns a server for cfg.
func NewServer(cfg ServerConfig) *Server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Open == nil {
		cfg.Open = SystemOpen
	}
	if cfg.OpenHosts == nil {
		cfg.OpenHosts = DefaultOpenHosts
	}
	port := strconv.Itoa(cfg.Port)
	s := &Server{cfg: cfg, hosts: map[string]bool{}, origins: map[string]bool{}, openHosts: map[string]bool{}}
	for _, h := range cfg.OpenHosts {
		s.openHosts[strings.ToLower(h)] = true
	}
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
// Host header (no DNS rebinding); /ws and /api/open also need a same-origin
// Origin and the token; /logo, POST /upload and POST /screen/frame/{id} need the token, and an Origin, when the browser
// sends one, must be the helper's own.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.Handle("GET /ws", s.checkWS(s.bridgeProxy()))
	// M3d building logos: GET, PUT and DELETE /logo/{building} go to the
	// bridge. They come before the site fallback below, and anything else
	// under /logo/ is refused rather than handed to the game or Vite.
	logos := s.logoProxy()
	mux.Handle("GET /logo/{id}", s.checkLogo(logos))
	mux.Handle("PUT /logo/{id}", s.checkLogo(s.limitLogo(logos)))
	mux.Handle("DELETE /logo/{id}", s.checkLogo(logos))
	mux.HandleFunc("/logo/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "GET, HEAD, PUT, DELETE")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	// #51 images for prompts: POST /upload goes to the bridge, guarded like
	// /logo, and wins over the site fallback. Other methods are refused.
	mux.Handle("POST /upload", s.checkLogo(s.limitUpload(s.uploadProxy())))
	mux.HandleFunc("/upload", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	// M13 screen share: the JPEG the game answers a frame request with goes
	// to the bridge, guarded like /upload. Anything else under /screen/ is
	// refused rather than handed to the game.
	mux.Handle("POST /screen/frame/{id}", s.checkLogo(s.limitFrame(s.frameProxy())))
	mux.HandleFunc("/screen/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	// M13 whiteboard: the board's routes and a drop's bytes go to the bridge,
	// guarded like /logo. POST /whiteboard/{floor}/pin is the office CLI's
	// (on the bridge's host) and is refused here, like anything else under
	// /whiteboard/ and /drops/.
	s.whiteboardRoutes(mux)
	mux.Handle("POST /api/open", s.open())
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	var site http.Handler
	if s.cfg.Dev != nil {
		site = s.devProxy()
	} else {
		site = s.bundle()
	}
	if s.cfg.MusicDir != "" {
		mux.Handle("GET /music/", s.music(site))
	}
	mux.Handle("/", site)
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
	if r.URL.Path == "/upload" || strings.HasPrefix(r.URL.Path, "/screen/") || isWhiteboardPath(r.URL.Path) { // the game reads its error code
		uploadError(w, http.StatusForbidden, "forbidden", "the helper refused the request ("+why+")")
		return
	}
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
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".ogg":         "audio/ogg",
	".opus":        "audio/ogg",
	".map":         "application/json",
	".wasm":        "application/wasm",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".jpg":         "image/jpeg",
	".webp":        "image/webp",
	".ktx2":        "image/ktx2",
	".glb":         "model/gltf-binary",
	".gltf":        "model/gltf+json",
	".bin":         "application/octet-stream",
	".woff2":       "font/woff2",
	".ico":         "image/x-icon",
	".txt":         "text/plain; charset=utf-8",
}

// bundle serves the built game. Unknown extensionless paths get index.html
// (single-page app); Vite's hashed /assets/ are cached for good, the rest
// is revalidated.
func (s *Server) bundle() http.Handler {
	var root http.FileSystem = http.Dir(s.cfg.Bundle)
	if s.cfg.BundleFS != nil {
		root = http.FS(s.cfg.BundleFS)
	}
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

// music serves the radio's tracks from MusicDir, which is kept outside the
// game (about 100 MB, never in a release). Range requests work, so the
// player can stream and seek. A path with no such file goes to next: the
// game's own copy in dev builds, else a 404.
func (s *Server) music(next http.Handler) http.Handler {
	root := http.Dir(s.cfg.MusicDir)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := path.Clean("/" + strings.TrimPrefix(r.URL.Path, "/music/"))
		f, fi := openFile(root, p)
		if f == nil {
			next.ServeHTTP(w, r)
			return
		}
		defer f.Close()
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		if ct, ok := contentTypes[strings.ToLower(path.Ext(p))]; ok {
			h.Set("Content-Type", ct)
		}
		h.Set("Cache-Control", "no-cache") // revalidate: a re-fetched track keeps its name
		http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
	})
}

// openFile opens a regular file under root, or returns nil.
func openFile(root http.FileSystem, name string) (http.File, fs.FileInfo) {
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
			return fmt.Errorf("no game bundle at %s (index.html missing): use a release build of h3d-helper (it embeds the game), or build one with `make embed-game helper-darwin`, or pass -bundle / -dev-upstream", dir)
		}
		return err
	}
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%s/index.html is not a file", dir)
	}
	return nil
}

// maxLogoUpload is the bridge's limit on a logo upload (logo.MaxInput; the
// helper does not link the image code). The helper refuses more before it
// reaches the tunnel.
const maxLogoUpload = 1 << 20

// checkLogo guards /logo. The token (?token=, as for /ws) is always needed.
// Unlike /ws, a same-origin GET from a page carries no Origin header (browsers
// leave it out of same-origin GETs, images and fetches included), so an absent
// Origin passes, and a present one must be the helper's own. A PUT or DELETE
// is a non-GET request: a browser always sends Origin, and it is checked the
// same way; a client that sends none (curl) still needs the token.
func (s *Server) checkLogo(next http.Handler) http.Handler {
	want := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if o := r.Header.Get("Origin"); o != "" && !s.origins[o] {
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

// limitLogo refuses an upload over maxLogoUpload, by Content-Length at once
// and by counting while it streams. It never truncates.
func (s *Server) limitLogo(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > maxLogoUpload {
			logoTooLarge(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxLogoUpload)
		next.ServeHTTP(w, r)
	})
}

func logoTooLarge(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusRequestEntityTooLarge)
	_, _ = w.Write([]byte(`{"t":"error","code":"logo_too_large","message":"the file is over 1048576 bytes"}` + "\n"))
}

// logoProxy forwards /logo/{id} to the bridge through the tunnel. Only the
// building id and the ?h= hash go on: the token, Origin, Cookie and
// Authorization stay here.
func (s *Server) logoProxy() http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			q := url.Values{}
			if h := pr.In.URL.Query().Get("h"); h != "" {
				q.Set("h", h)
			}
			pr.Out.URL = &url.URL{Scheme: "http", Host: "herdr-world", Path: "/logo/" + pr.In.PathValue("id"), RawQuery: q.Encode()}
			pr.Out.Host = "herdr-world"
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
		},
		Transport: &http.Transport{
			DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return s.cfg.Bridge.Dial(ctx) },
			ResponseHeaderTimeout: 45 * time.Second, // a conversion waits up to 10 s for a slot and 10 s to run
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				logoTooLarge(w)
				return
			}
			st := s.cfg.Bridge.Status()
			s.cfg.Log.Warn("bridge unreachable", "tunnel", st.State, "err", err)
			http.Error(w, "bridge unreachable (tunnel "+st.State+")", http.StatusBadGateway)
		},
	}
}

// maxUploadBody is what the helper lets through on POST /upload: the bridge's
// cap (upload.MaxBytes) and a little slack, so that an image of exactly the cap
// is never cut off here. The bridge counts the bytes and gives the exact
// verdict; this only keeps a runaway body out of the tunnel.
const maxUploadBody = upload.MaxBytes + 4<<10

// limitUpload refuses a body over maxUploadBody, by Content-Length at once and
// by counting while it streams (a chunked or unlabelled body included). It
// never truncates.
func (s *Server) limitUpload(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > maxUploadBody {
			uploadTooLarge(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxUploadBody)
		next.ServeHTTP(w, r)
	})
}

// uploadError answers with the protocol's error object and a status, as the
// bridge does for /upload.
func uploadError(w http.ResponseWriter, status int, code, msg string) {
	b, _ := json.Marshal(map[string]string{"t": "error", "code": code, "message": msg})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(append(b, '\n'))
}

func uploadTooLarge(w http.ResponseWriter) {
	uploadError(w, http.StatusRequestEntityTooLarge, "upload_too_large", fmt.Sprintf("the image is over %d MiB", upload.MaxBytes>>20))
}

// uploadProxy forwards POST /upload to the bridge through the tunnel. Only
// ?label= and ?n= go on: the token, Origin, Cookie and Authorization stay
// here.
func (s *Server) uploadProxy() http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			q := url.Values{}
			for _, k := range []string{"label", "n"} {
				if v, ok := pr.In.URL.Query()[k]; ok && len(v) > 0 {
					q.Set(k, v[0])
				}
			}
			pr.Out.URL = &url.URL{Scheme: "http", Host: "herdr-world", Path: "/upload", RawQuery: q.Encode()}
			pr.Out.Host = "herdr-world"
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return s.cfg.Bridge.Dial(ctx) },
			// The bridge answers after Drop Zone did: its own limit is upload.DefaultTimeout.
			ResponseHeaderTimeout: upload.DefaultTimeout + 15*time.Second,
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				uploadTooLarge(w)
				return
			}
			st := s.cfg.Bridge.Status()
			s.cfg.Log.Warn("bridge unreachable", "tunnel", st.State, "err", err)
			uploadError(w, http.StatusBadGateway, "bridge_unreachable", "the bridge is not reachable (tunnel "+st.State+")")
		},
	}
}

// M13 screen share.

// maxFrameBody is what the helper lets through on POST /screen/frame/{id}:
// the bridge's cap (screenshare.MaxBytes; the helper does not link it) and a
// little slack. The bridge counts the bytes and checks the JPEG.
const maxFrameBody = 8<<20 + 4<<10

// frameIDRe is a frame request id as the bridge makes them.
var frameIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// limitFrame refuses a body over maxFrameBody (by Content-Length at once,
// and by counting while it streams) and an id that is not one.
func (s *Server) limitFrame(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !frameIDRe.MatchString(r.PathValue("id")) {
			uploadError(w, http.StatusBadRequest, "bad_request", "a frame request id is 32 hex digits")
			return
		}
		if r.ContentLength > maxFrameBody {
			frameTooLarge(w)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxFrameBody)
		next.ServeHTTP(w, r)
	})
}

func frameTooLarge(w http.ResponseWriter) {
	uploadError(w, http.StatusRequestEntityTooLarge, "frame_too_large", fmt.Sprintf("the frame is over %d MiB", maxFrameBody>>20))
}

// frameProxy forwards POST /screen/frame/{id} to the bridge through the
// tunnel. Only the path goes on: no query, and the token, Origin, Cookie and
// Authorization stay here.
func (s *Server) frameProxy() http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.Out.URL = &url.URL{Scheme: "http", Host: "herdr-world", Path: "/screen/frame/" + pr.In.PathValue("id")}
			pr.Out.Host = "herdr-world"
			pr.Out.Header.Del("Origin")
			pr.Out.Header.Del("Cookie")
			pr.Out.Header.Del("Authorization")
		},
		Transport: &http.Transport{
			DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return s.cfg.Bridge.Dial(ctx) },
			ResponseHeaderTimeout: 20 * time.Second, // the bridge reads for at most 10 s
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				frameTooLarge(w)
				return
			}
			st := s.cfg.Bridge.Status()
			s.cfg.Log.Warn("bridge unreachable", "tunnel", st.State, "err", err)
			uploadError(w, http.StatusBadGateway, "bridge_unreachable", "the bridge is not reachable (tunnel "+st.State+")")
		},
	}
}
