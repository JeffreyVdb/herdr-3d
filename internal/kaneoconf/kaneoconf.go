// Package kaneoconf is the bridge-wide Kaneo connection (#184): the
// instance, its API key in a 0600 file of its own, the default workspace,
// the test that gates a save, and the configuration generation every
// floor's board names. It knows no HTTP: every call to Kaneo goes through
// the Connector interface, which the app adapts internal/kaneo to (tests
// use FakeConnector). The key never leaves it in a View, an error message,
// a log line or an event: only key_set does.
//
// It imports nothing of the bridge but provider (the error kinds), so the
// hub, the protocol and the store stay provider-neutral
// (TestKaneoSettingsIsProviderNeutral).
package kaneoconf

import (
	"context"
	"errors"
)

// Instance is where a Kaneo deployment answers: its API base (ending in
// /api, never doubled) and the web origin its task pages live under.
type Instance struct {
	APIBase   string `json:"api_base"`
	WebOrigin string `json:"web_origin"`
}

// Workspace is a Kaneo workspace (Kaneo's auth API calls it an
// organization).
type Workspace struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug,omitempty"`
}

// Project is a Kaneo project of a workspace.
type Project struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Name        string `json:"name"`
	Slug        string `json:"slug,omitempty"`
	Archived    bool   `json:"archived,omitempty"`
}

// TestResult is what a connection test learned.
type TestResult struct {
	Workspaces []Workspace
	// User is the key owner's display name, when the instance said
	// (optional).
	User string
}

// Connector is everything the settings need of a Kaneo instance. Every
// call is a read (HTTP GET): a test never changes anything on Kaneo. The
// errors are provider's kinds (provider.ErrUnauthorized for a 401, which
// may be an exhausted key quota, provider.ErrForbidden, provider.ErrNotFound,
// provider.ErrBadInput, *provider.RateLimitError, provider.ErrFailed); a
// network failure wraps ErrUnreachable (or a net.Error). No error message
// holds the key.
type Connector interface {
	// Resolve normalizes a user-entered instance URL (its origin, or its
	// API base) into an Instance; provider.ErrBadInput when it is not one
	// (no http(s), credentials, a query, plain http to a host that is not
	// loopback).
	Resolve(raw string) (Instance, error)
	// Test checks key against the instance: the workspaces it reaches
	// (an authenticated list, never a public health check).
	Test(ctx context.Context, in Instance, key string) (TestResult, error)
	// Workspaces lists the workspaces key reaches.
	Workspaces(ctx context.Context, in Instance, key string) ([]Workspace, error)
	// Projects lists a workspace's projects (archived ones left out).
	Projects(ctx context.Context, in Instance, key, workspaceID string) ([]Project, error)
	// Project reads one project, for the check that it belongs to a
	// workspace (provider.ErrNotFound when it is gone).
	Project(ctx context.Context, in Instance, key, projectID string) (Project, error)
}

// ErrUnreachable marks a call that never reached Kaneo (DNS, refused, TLS):
// the app's adapter wraps it into its network failures.
var ErrUnreachable = errors.New("unreachable")

// Kind is the class of an Error, which is also its protocol error code.
type Kind string

// Error kinds.
const (
	KindUnsupported   Kind = "unsupported"    // the bridge has no Kaneo client
	KindNotConfigured Kind = "not_configured" // no saved connection
	KindBadURL        Kind = "bad_url"
	KindKeyRequired   Kind = "key_required"  // a new instance needs its key typed
	KindTestRequired  Kind = "test_required" // kaneo.set of what no test passed
	KindBadInput      Kind = "bad_request"
	KindNotFound      Kind = "not_found"
	KindUnauthorized  Kind = "unauthorized" // 401: a bad or revoked key, or its quota
	KindForbidden     Kind = "forbidden"    // 403: no access to that workspace or project
	KindUnreachable   Kind = "unreachable"
	KindTimeout       Kind = "timeout"
	KindRateLimited   Kind = "rate_limited"
	KindFailed        Kind = "provider_failed"
)

// Error is a failure of the settings or of a call to Kaneo, its message
// fit to show (never the key).
type Error struct {
	Kind Kind
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func newErr(k Kind, msg string) *Error { return &Error{Kind: k, Msg: msg} }

// KindOf is err's kind; "" when it is not an Error.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return ""
}
