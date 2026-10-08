package kaneo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
)

// DefaultTimeout bounds one call (a board read is several).
const DefaultTimeout = 15 * time.Second

// maxAnswerBytes caps one answer: a board page holds up to 100 tasks whose
// descriptions may each be 64 KiB, and a task's detail its whole
// description.
const maxAnswerBytes = 16 << 20

// Options are a client's transport and per-call timeout.
type Options struct {
	HTTP    *http.Client  // nil: a client of http.DefaultTransport
	Timeout time.Duration // of each call; 0: DefaultTimeout
}

// Client calls one Kaneo instance's API with one key. Every call is bounded
// by its own timeout and by ctx; it never follows a redirect (the key would
// go along) and none of its errors holds the key or the Authorization
// header.
type Client struct {
	base    string
	key     string
	hc      *http.Client
	timeout time.Duration
}

// New makes the client of the API base apiBase (anything ParseURL takes;
// it is normalized again) with key.
func New(apiBase, key string, opts Options) (*Client, error) {
	ep, err := ParseURL(apiBase)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(key) == "" {
		return nil, provider.Errorf(provider.ErrBadInput, "the Kaneo API key is empty")
	}
	hc := opts.HTTP
	if hc == nil {
		hc = &http.Client{Transport: http.DefaultTransport}
	}
	c := *hc
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	return &Client{base: ep.APIBase, key: key, hc: &c, timeout: opts.Timeout}, nil
}

// APIBase is the API base the client calls (no key: safe to show and to
// key a cache with).
func (c *Client) APIBase() string { return c.base }

// get reads path (relative to the API base, already escaped) with query q
// into out.
func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	return c.call(ctx, http.MethodGet, path, q, nil, out)
}

// call sends one request and decodes a 2xx answer into out (nil: ignored).
// A non-2xx answer is the error kind of its status (statusErr).
func (c *Client) call(ctx context.Context, method, path string, q url.Values, body, out any) error {
	what := method + " " + path
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return provider.Errorf(provider.ErrBadInput, "Kaneo: %s: the request cannot be encoded", what)
		}
		rd = bytes.NewReader(b)
	}
	u := c.base + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	cctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, method, u, rd)
	if err != nil {
		return provider.Errorf(provider.ErrBadInput, "Kaneo: %s: not a usable address", what)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.hc.Do(req)
	if err != nil {
		return c.transportErr(ctx, cctx, what, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxAnswerBytes+1))
	if err != nil {
		return c.transportErr(ctx, cctx, what, err)
	}
	if len(b) > maxAnswerBytes {
		return provider.Failed("Kaneo: %s: the answer is too large", what)
	}
	if err := c.statusErr(what, resp, b); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(b, out); err != nil {
		return provider.Failed("Kaneo: %s: unreadable answer", what)
	}
	return nil
}

// ErrUnreachable marks a call that never reached Kaneo (DNS, a refused
// connection, TLS): a provider.ErrFailed whose cause the caller can tell
// apart from Kaneo's own failures (errors.Is; the network error is there for
// errors.As too). Its message is the call's, never the cause's.
var ErrUnreachable = errors.New("unreachable")

// callError is an error kind with a message and, for a canceled or timed
// out call, the context's error, for an unreachable one ErrUnreachable and
// the network error (errors.Is finds both).
type callError struct {
	kind  error
	msg   string
	cause error
}

func (e *callError) Error() string { return e.msg }
func (e *callError) Unwrap() []error {
	if e.cause == nil {
		return []error{e.kind}
	}
	return []error{e.kind, e.cause}
}

// transportErr is a failed round trip: canceled (ctx is the caller's), timed
// out (cctx is the call's own) or unreachable. url.Error repeats the URL:
// only its cause is kept.
func (c *Client) transportErr(ctx, cctx context.Context, what string, err error) error {
	var ne net.Error
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		return &callError{kind: provider.ErrFailed, msg: "Kaneo: " + what + ": canceled", cause: context.Canceled}
	case errors.Is(cctx.Err(), context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return &callError{kind: provider.ErrFailed, msg: "Kaneo: " + what + ": no answer in time", cause: context.DeadlineExceeded}
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		err = ue.Err
	}
	return &callError{kind: provider.ErrFailed, msg: "Kaneo: " + what + ": cannot be reached: " + clip(c.scrub(err.Error())),
		cause: fmt.Errorf("%w: %w", ErrUnreachable, err)}
}

// statusErr maps an answer's status to an error kind (nil for 2xx), with
// Kaneo's own words (a text/plain body, or a JSON message) clipped and
// scrubbed.
func (c *Client) statusErr(what string, resp *http.Response, body []byte) error {
	s := resp.StatusCode
	if s >= 200 && s < 300 {
		return nil
	}
	msg := fmt.Sprintf("Kaneo: %s: HTTP %d%s", what, s, c.detail(body))
	switch {
	case s == http.StatusUnauthorized:
		return provider.Errorf(provider.ErrUnauthorized,
			"Kaneo refused the credentials (%s): a wrong, expired or revoked key, or its request quota is used up for now", msg)
	case s == http.StatusForbidden:
		return provider.Errorf(provider.ErrForbidden, "%s: the key may not reach this workspace, project or task", msg)
	case s == http.StatusNotFound:
		return provider.Errorf(provider.ErrNotFound, "%s", msg)
	case s == http.StatusConflict:
		return provider.Errorf(provider.ErrStale, "%s", msg)
	case s == http.StatusBadRequest || s == http.StatusUnprocessableEntity:
		return provider.Errorf(provider.ErrBadInput, "%s", msg)
	case s == http.StatusTooManyRequests:
		return &provider.RateLimitError{ResetAt: retryAfter(resp.Header.Get("Retry-After"), time.Now()), Msg: msg}
	case s >= 300 && s < 400:
		return provider.Failed("Kaneo: %s: redirects (HTTP %d): use the instance's final address", what, s)
	}
	return provider.Failed("%s", msg)
}

// detail is ": <message>" from an error body: Kaneo's errors are plain
// text; an unexpected one is JSON {"message"}. "" when there is none.
func (c *Client) detail(body []byte) string {
	msg := string(body)
	var e struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil {
		msg = e.Message
		if msg == "" {
			msg = e.Error
		}
	}
	msg = clip(c.scrub(msg))
	if msg == "" {
		return ""
	}
	return ": " + msg
}

// retryAfter is when a Retry-After header (seconds or an HTTP date) says to
// come back; zero when it says nothing usable.
func retryAfter(h string, now time.Time) time.Time {
	h = strings.TrimSpace(h)
	if h == "" {
		return time.Time{}
	}
	if s, err := strconv.Atoi(h); err == nil && s >= 0 {
		return now.Add(time.Duration(s) * time.Second)
	}
	if t, err := http.ParseTime(h); err == nil {
		return t
	}
	return time.Time{}
}

var bearerRe = regexp.MustCompile(`(?i)\b(bearer\s+)\S+`)

// scrub removes the key and any bearer token from s.
func (c *Client) scrub(s string) string {
	if c.key != "" {
		s = strings.ReplaceAll(s, c.key, "[key]")
	}
	return bearerRe.ReplaceAllString(s, "${1}[key]")
}

// clip cuts s to 160 bytes on a rune boundary, one line.
func clip(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	n := 160
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n] + "…"
}

// esc escapes an id for a path segment.
func esc(id string) string { return url.PathEscape(id) }

// notFoundOn400 reads a 400 of a read by id alone as "not found": Kaneo
// answers an unknown task or project (or one whose workspace it cannot
// determine) with 400, and such a read has no other argument to refuse.
func notFoundOn400(err error) error {
	if err == nil || !errors.Is(err, provider.ErrBadInput) {
		return err
	}
	return provider.Errorf(provider.ErrNotFound, "%s", err.Error())
}
