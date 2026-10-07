// Package provider holds what the issue tracker (internal/tracker) and the
// code host (internal/codehost) interfaces share: people, comments, the
// rate reading and the error kinds a provider answers with. It knows no
// provider: the bridge above the interfaces maps these errors to protocol
// error codes.
package provider

import (
	"errors"
	"fmt"
	"time"
)

// Person is an author or an assignee.
type Person struct {
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

// Comment is a comment on an issue or a change request; times are unix ms.
type Comment struct {
	ID        string `json:"id"`
	Author    Person `json:"author"`
	Body      string `json:"body"`
	CreatedAt int64  `json:"created_at"`
}

// Rate is what a provider's rate limit has left: the reading of its last
// call. Cost and Limit are for the bridge's own back-off, not the wire.
type Rate struct {
	Remaining int   `json:"remaining"`
	ResetAt   int64 `json:"reset_at"` // unix ms
	Cost      int   `json:"-"`
	Limit     int   `json:"-"`
}

// Errors a provider answers with, wrapped with a short message that never
// holds a token. Check with errors.Is.
var (
	// ErrNotFound: the id is not on this provider (or was deleted).
	ErrNotFound = errors.New("not found")
	// ErrUnsupported: the provider cannot do this.
	ErrUnsupported = errors.New("unsupported")
	// ErrFailed: the provider call failed (network, auth, a refusal).
	ErrFailed = errors.New("provider failed")
	// ErrStale: what the caller acted on moved (a change request's head).
	ErrStale = errors.New("stale")
	// ErrChecksNotGreen and ErrNotMergeable refuse a merge.
	ErrChecksNotGreen = errors.New("checks not green")
	ErrNotMergeable   = errors.New("not mergeable")
	// ErrBadInput: the provider refused an argument (a column it does not
	// have, a base branch that is gone).
	ErrBadInput = errors.New("bad input")
	// ErrPartial: a call of several writes failed after one of them
	// landed, so the provider's state changed anyway. It goes with the
	// failure's own kind (see Partial): the caller still refreshes.
	ErrPartial = errors.New("partial")
	// ErrUnauthorized: the provider refused the credentials (HTTP 401). It
	// can be an exhausted key quota as well as a bad key: re-test after a
	// cooldown rather than treating the key as permanently invalid.
	ErrUnauthorized = errors.New("unauthorized")
	// ErrForbidden: the credentials are valid but may not reach this
	// workspace, project or item (HTTP 403).
	ErrForbidden = errors.New("forbidden")
)

// RateLimitError is a rate limit: the provider will answer again at
// ResetAt (zero when it did not say: a secondary limit).
type RateLimitError struct {
	ResetAt time.Time
	Msg     string
}

func (e *RateLimitError) Error() string {
	if e.Msg != "" {
		return e.Msg
	}
	return "rate limited"
}

// Failed is an ErrFailed with a message.
func Failed(format string, args ...any) error { return Errorf(ErrFailed, format, args...) }

// Partial marks err, which came after a write that landed, as an
// ErrPartial; errors.Is still finds err's own kind.
func Partial(err error) error { return &partialError{err: err} }

type partialError struct{ err error }

func (e *partialError) Error() string   { return e.err.Error() }
func (e *partialError) Unwrap() []error { return []error{ErrPartial, e.err} }

// Errorf wraps kind with a message (kind's own text is not repeated).
func Errorf(kind error, format string, args ...any) error {
	return &kindError{kind: kind, msg: fmt.Sprintf(format, args...)}
}

type kindError struct {
	kind error
	msg  string
}

func (e *kindError) Error() string { return e.msg }
func (e *kindError) Unwrap() error { return e.kind }
