package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

// Response caps: a model list can be long (hundreds of models), an answer is
// short.
const (
	maxListBytes   = 8 << 20
	maxAnswerBytes = 1 << 20
)

// reply is a provider's HTTP answer, read to its cap.
type reply struct {
	status int
	body   []byte
}

// do sends one request with a Bearer key (none when key is "") and reads the
// answer. It never follows a redirect (the key would go along), and every
// error it returns is scrubbed of the key and of the URL's query.
func do(ctx context.Context, hc *http.Client, method, url, key string, body any, limit int64) (*reply, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, newErr(KindBadConfig, "the request cannot be encoded: "+Scrub(err.Error(), key))
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, newErr(KindBadConfig, "the address is not usable")
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, transportErr(ctx, err, key)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, transportErr(ctx, err, key)
	}
	if int64(len(b)) > limit {
		return nil, newErr(KindBadResponse, "the answer is too large")
	}
	return &reply{status: resp.StatusCode, body: b}, nil
}

// transportErr turns a failed round trip into a typed, scrubbed error.
func transportErr(ctx context.Context, err error, key string) error {
	var ne net.Error
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded), errors.As(err, &ne) && ne.Timeout():
		return newErr(KindTimeout, "the model did not answer in time")
	case errors.Is(ctx.Err(), context.Canceled):
		return ctx.Err()
	case errors.Is(err, http.ErrUseLastResponse):
		return newErr(KindUnreachable, "the endpoint redirects: use its final address")
	}
	msg := err.Error()
	// url.Error repeats the URL (which may name the host and path): keep the
	// cause only.
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) && ue.Unwrap() != nil {
		msg = ue.Unwrap().Error()
	}
	return newErr(KindUnreachable, "the endpoint cannot be reached: "+clip(Scrub(msg, key), 160))
}

// statusErr maps a non-2xx answer to an error; nil for 2xx. The provider's
// own words are clipped and scrubbed.
func statusErr(r *reply, key string) error {
	switch {
	case r.status >= 200 && r.status < 300:
		return nil
	case r.status == http.StatusUnauthorized || r.status == http.StatusForbidden:
		return newErr(KindAuthFailed, fmt.Sprintf("the key was rejected (HTTP %d)", r.status))
	case r.status == http.StatusTooManyRequests:
		return newErr(KindRateLimited, "the provider is rate limiting (HTTP 429)")
	case r.status >= 300 && r.status < 400:
		return newErr(KindUnreachable, fmt.Sprintf("the endpoint redirects (HTTP %d): use its final address", r.status))
	}
	e := newErr(KindFailed, fmt.Sprintf("the provider answered HTTP %d%s", r.status, detail(r.body, key)))
	e.status = r.status
	return e
}

// detail is ": <message>" from an error body, "" when it has none.
func detail(body []byte, key string) string {
	var e struct {
		Error   json.RawMessage `json:"error"`
		Message string          `json:"message"`
		Detail  string          `json:"detail"`
	}
	msg := ""
	if json.Unmarshal(body, &e) == nil {
		msg = firstNonEmpty(e.Message, e.Detail)
		if msg == "" && len(e.Error) > 0 {
			var s string
			var o struct {
				Message string `json:"message"`
			}
			if json.Unmarshal(e.Error, &s) == nil {
				msg = s
			} else if json.Unmarshal(e.Error, &o) == nil {
				msg = o.Message
			}
		}
	}
	if msg == "" {
		return ""
	}
	return ": " + clip(Scrub(msg, key), 160)
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// clip cuts s to n bytes on a rune boundary.
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n] + "…"
}

// transient reports whether a second try is worth it: a network failure, a
// timeout or a 5xx. An auth failure, a rate limit or a malformed answer is not.
func transient(err error) bool {
	var e *Error
	if !errors.As(err, &e) {
		return false
	}
	return e.Kind == KindTimeout || e.Kind == KindUnreachable || e.Kind == KindFailed && e.status >= 500
}
