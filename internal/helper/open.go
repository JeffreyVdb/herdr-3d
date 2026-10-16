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
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// DefaultOpenHosts are the hosts the game may ask the helper to open in the
// user's browser: the issue and pull request pages of the providers the bridge
// knows. A provider added later adds its host here. #184: a self-hosted one
// (Kaneo) is not listed: the bridge names its host on /healthz, through the
// tunnel (Status.OpenHosts), while it is configured there.
var DefaultOpenHosts = []string{"github.com"}

// Opener opens an http(s) URL in the user's browser (SystemOpen: the helper's own, for macOS and Linux).
type Opener func(ctx context.Context, url string) error

// SystemOpen is the Opener of the real helper: the platform's own way to open
// a URL in the user's default browser, `open <url>` on macOS and `xdg-open
// <url>` on Linux. Any other OS has no way from here, and it says which.
//
// Launch completion (#81). `open` returns at once, but `xdg-open` may stay in
// the foreground for as long as the application it launched lives (it execs
// or waits on a .desktop launcher when no browser is running), so a process
// that is still alive is not a failure and must not be killed with a timeout.
// So the opener waits a short grace window for the command to finish:
//   - exit 0 inside the window: opened;
//   - a non-zero exit, or no such executable, inside the window: an error with
//     the exit code and the first of its output (capped);
//   - still running at the end of the window: opened. It is left alone and
//     reaped in the background, so its late exit is not looked at: nobody is
//     waiting for an answer by then;
//   - the request's context ending first (the game went away): the wait ends
//     with that error and the launch in flight is left alone too, never killed.
//
// Pipes: stdout and stderr are one pipe the helper owns, read by one goroutine
// into a bounded buffer (the first 4 KiB kept) until every writer has closed
// it, so the exit status never waits for output and a descendant that outlives
// the opener never gets EPIPE.
//
// The command gets no stdin and inherits the helper's environment: xdg-open
// needs the desktop session's (WAYLAND_DISPLAY or DISPLAY, XDG_RUNTIME_DIR,
// DBUS_SESSION_BUS_ADDRESS, XDG_CURRENT_DESKTOP, PATH), and none is invented
// here (CONTRIBUTING.md, "Linux user service"). The URL is one argv element,
// never parsed by a shell.
var SystemOpen Opener = newSystemOpener(runtime.GOOS, exec.Command, openGrace)

const (
	// openGrace is how long the opener waits for the command to finish before
	// it counts a still-running one as launched.
	openGrace = 3 * time.Second
	// openDrainWait is how long a failed command's output is collected for,
	// after its exit, before the answer is built.
	openDrainWait = 150 * time.Millisecond
	// maxOpenDiag caps the command output kept in an error, and so in the 502
	// body; the capture buffer behind it is maxOpenCapture.
	maxOpenDiag    = 512
	maxOpenCapture = 4 << 10
)

// newSystemOpener returns the Opener for goos. command builds the *exec.Cmd
// (exec.Command in production, a stand-in in tests); grace is the wait above.
func newSystemOpener(goos string, command func(name string, arg ...string) *exec.Cmd, grace time.Duration) Opener {
	var name string
	switch goos {
	case "darwin":
		name = "open"
	case "linux":
		name = "xdg-open"
	default:
		return func(context.Context, string) error {
			return fmt.Errorf("opening a browser is not supported on %s (the helper does it on macOS and Linux)", goos)
		}
	}
	return func(ctx context.Context, u string) error {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		// The helper owns the output pipe. An *os.File handed to the command
		// goes straight to the child as its fd 1 and 2 (one pipe, in order) and
		// Go starts no copy goroutines, so cmd.Wait returns at the command's
		// exit, whoever else holds the pipe: the exit status can never be late
		// because a browser the command started kept it open.
		r, w, err := os.Pipe()
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		cmd := command(name, u)
		cmd.Stdout, cmd.Stderr = w, w
		err = cmd.Start()
		w.Close() // the parent's copy: only the command and its descendants write now
		if err != nil {
			r.Close()
			if errors.Is(err, exec.ErrNotFound) {
				return fmt.Errorf("%s: %w (install it, or put it on the helper's PATH)", name, err)
			}
			return fmt.Errorf("%s: %w", name, err)
		}
		// One reader keeps the first bytes and discards the rest until every
		// writer is gone, then closes r. It is never closed early: a descendant
		// writing later (a browser logging to its inherited stdout) must not
		// get EPIPE or SIGPIPE from the helper.
		out := &boundedBuffer{max: maxOpenCapture}
		drained := make(chan struct{})
		go func() {
			defer close(drained)
			defer r.Close()
			_, _ = io.Copy(out, r)
		}()
		done := make(chan error, 1) // buffered: the reaper never blocks on a caller that left
		go func() { done <- cmd.Wait() }()

		// failed is the answer for a command that exited non-zero: the output
		// already written is collected first, for a moment only, so a
		// descendant holding the pipe cannot delay the answer.
		failed := func(err error) error {
			t := time.NewTimer(openDrainWait)
			defer t.Stop()
			select {
			case <-drained:
			case <-t.C:
			case <-ctx.Done():
			}
			return fmt.Errorf("%s: %w: %s", name, err, out.diagnostics())
		}
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case err := <-done:
			if err == nil {
				return nil
			}
			return failed(err)
		case <-timer.C:
			select { // an exit that raced the timer still counts
			case err := <-done:
				if err != nil {
					return failed(err)
				}
			default:
			}
			return nil // still running: launched (a long-lived opener is not a failure)
		case <-ctx.Done():
			return fmt.Errorf("%s: gave up waiting: %w", name, ctx.Err())
		}
	}
}

// boundedBuffer keeps the first max bytes written and discards the rest,
// always reporting a full write so a chatty command never blocks on its pipe.
type boundedBuffer struct {
	mu  sync.Mutex
	buf []byte
	max int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if room := b.max - len(b.buf); room > 0 {
		b.buf = append(b.buf, p[:min(room, len(p))]...)
	}
	return len(p), nil
}

// diagnostics is the captured output, trimmed and cut to maxOpenDiag bytes.
func (b *boundedBuffer) diagnostics() string {
	b.mu.Lock()
	s := strings.TrimSpace(strings.ToValidUTF8(string(b.buf), "?"))
	b.mu.Unlock()
	if len(s) > maxOpenDiag {
		s = strings.ToValidUTF8(s[:maxOpenDiag], "") + "…"
	}
	if s == "" {
		return "(no output)"
	}
	return s
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
		u, err := checkOpenURL(body.URL, s.allowedOpenHosts())
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

// allowedOpenHosts is the built-in hosts and the ones the bridge trusts now
// (#184: its Kaneo instance's).
func (s *Server) allowedOpenHosts() map[string]bool {
	var extra []string
	if s.cfg.Bridge != nil {
		extra = s.cfg.Bridge.Status().OpenHosts
	}
	if len(extra) == 0 {
		return s.openHosts
	}
	hosts := make(map[string]bool, len(s.openHosts)+len(extra))
	for h := range s.openHosts {
		hosts[h] = true
	}
	for _, h := range extra {
		hosts[strings.ToLower(h)] = true
	}
	return hosts
}

func hostOf(raw string) string {
	if u, err := url.Parse(raw); err == nil {
		return u.Hostname()
	}
	return ""
}
