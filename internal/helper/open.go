package helper

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// DefaultOpenHosts are the hosts the game may ask the helper to open in the
// user's browser: the issue and pull request pages of the providers the bridge
// knows. A provider added later adds its host here.
var DefaultOpenHosts = []string{"github.com"}

// Opener opens an http(s) URL in the user's browser.
type Opener func(ctx context.Context, url string) error

// SystemOpen is the Opener of a Mac helper: `open <url>` (the default browser).
// Elsewhere there is no browser to reach from here, and it says so.
func SystemOpen(ctx context.Context, u string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("opening a browser needs macOS")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, "open", u).CombinedOutput(); err != nil {
		return fmt.Errorf("open: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

const (
	maxOpenBody = 4 << 10
	maxOpenURL  = 2048
	// OpenTokenHeader carries the helper token on /api/open (never the URL: it would land in logs).
	OpenTokenHeader = "X-H3D-Token"
)

// checkOpenURL returns the URL to open, or why it is refused: https only, no
// credentials or port, a host of the allowlist, no control characters.
func checkOpenURL(raw string, hosts map[string]bool) (string, error) {
	if raw == "" || len(raw) > maxOpenURL {
		return "", errors.New("url must be 1-2048 bytes")
	}
	for _, r := range raw {
		if r < 0x20 || r == 0x7f {
			return "", errors.New("url has control characters")
		}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", errors.New("url does not parse")
	}
	if u.Scheme != "https" {
		return "", errors.New("only https urls are opened")
	}
	if u.User != nil || u.Port() != "" || u.Opaque != "" {
		return "", errors.New("url may not carry credentials or a port")
	}
	if !hosts[strings.ToLower(u.Hostname())] {
		return "", fmt.Errorf("host %q is not one the helper opens", u.Hostname())
	}
	return u.String(), nil
}

// open serves POST /api/open {"url": "https://github.com/…"}: same origin and
// token as /ws (the Host check is the handler's), an allowlisted https URL,
// then the Opener. 204 on success.
func (s *Server) open() http.Handler {
	want := []byte(s.cfg.Token)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.origins[r.Header.Get("Origin")] {
			s.forbid(w, r, "origin not allowed")
			return
		}
		if got := []byte(r.Header.Get(OpenTokenHeader)); len(want) == 0 || subtle.ConstantTimeCompare(got, want) != 1 {
			s.forbid(w, r, "bad token")
			return
		}
		if ct := r.Header.Get("Content-Type"); !strings.HasPrefix(strings.ToLower(ct), "application/json") {
			http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
			return
		}
		var body struct {
			URL string `json:"url"`
		}
		dec := json.NewDecoder(io.LimitReader(r.Body, maxOpenBody))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			http.Error(w, "bad request: want {\"url\": \"https://…\"}", http.StatusBadRequest)
			return
		}
		u, err := checkOpenURL(body.URL, s.openHosts)
		if err != nil {
			s.cfg.Log.Warn("open refused", "why", err.Error())
			http.Error(w, "refused: "+err.Error(), http.StatusBadRequest)
			return
		}
		if err := s.cfg.Open(r.Context(), u); err != nil {
			s.cfg.Log.Warn("open failed", "host", hostOf(u), "err", err)
			http.Error(w, "the helper could not open a browser: "+err.Error(), http.StatusBadGateway)
			return
		}
		s.cfg.Log.Info("opened in the browser", "host", hostOf(u))
		w.WriteHeader(http.StatusNoContent)
	})
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Hostname()
	}
	return ""
}
