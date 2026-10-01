// Package ai is the bridge's generic access to the AI models it can call
// (#92). Two roles, each with one provider config:
//
//   - the classifier (Jev, by TypeSafe): a score in [0,1] for a yes/no
//     question about a piece of state;
//   - the LLM (any OpenAI-compatible endpoint): a text completion, JSON mode
//     where the endpoint has it.
//
// The package knows nothing about any feature. A feature takes the Classifier
// or LLM interface (Service.Classifier, Service.LLM), supplies its own state,
// question or messages, and gets the shared bounds for free: a timeout, at
// most one retry, a global concurrency limit and the role's state (a role
// that is not ready, or whose key was rejected, makes no call at all).
//
// Nothing is sent by configuring a role. The only calls this package makes on
// its own are the model-list loads (Service.Models) and the explicit tests
// (Service.Test). Keys live in one 0600 file, never leave the bridge, and are
// scrubbed from every error (Scrub).
//
// It imports only the standard library (TestAIIsFeatureAgnostic).
package ai

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

// Role is one of the two models.
type Role string

const (
	RoleClassifier Role = "classifier"
	RoleLLM        Role = "llm"
)

// Valid reports whether r is a known role.
func (r Role) Valid() bool { return r == RoleClassifier || r == RoleLLM }

// State is where a role stands.
type State string

const (
	StateOff        State = "off"        // nothing configured
	StateIncomplete State = "incomplete" // a part is missing
	StateInvalid    State = "invalid"    // the last validation, test or runtime call failed
	StateReady      State = "ready"
)

// Classifier answers a yes/no question about a piece of state with a score
// in [0,1]. Features take this interface, never a vendor client.
type Classifier interface {
	Classify(ctx context.Context, state map[string]any, question string) (float64, error)
}

// LLM completes a chat. Features take this interface, never a vendor client.
type LLM interface {
	Complete(ctx context.Context, req Request) (string, error)
}

// Message is one chat message ("system", "user" or "assistant").
type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// Request is one completion.
type Request struct {
	Messages    []Message
	Temperature *float64 // nil: the endpoint's default
	MaxTokens   int      // 0: the endpoint's default
	// JSON asks for a JSON object (response_format json_object). An endpoint
	// that rejects it is called again without it, once, and remembered; the
	// text then holds the object among other text (FirstJSONObject).
	JSON bool
}

// Kind classifies an error. The values are also the protocol's error codes.
type Kind string

const (
	KindAuthFailed      Kind = "auth_failed"        // 401 / 403: the key was rejected
	KindNoModels        Kind = "no_models_endpoint" // the endpoint has no /models
	KindUnreachable     Kind = "unreachable"        // connect, TLS, DNS, redirect
	KindTimeout         Kind = "timeout"
	KindBadResponse     Kind = "bad_response"
	KindRateLimited     Kind = "rate_limited"
	KindFailed          Kind = "provider_failed" // any other failure of the provider
	KindNotReady        Kind = "not_ready"       // the role is off, incomplete or invalid: no call was made
	KindIncomplete      Kind = "incomplete"      // a test or a model list needs a part that is missing
	KindTestRequired    Kind = "test_required"   // ai.set of a config no test passed
	KindEnvLocked       Kind = "env_locked"      // a field the bridge environment sets
	KindBadConfig       Kind = "bad_config"      // a malformed base URL or extra_body
	KindUnsupportedRole Kind = "bad_role"
)

// Error is an error of this package. Its message never holds a key.
type Error struct {
	Kind   Kind
	Msg    string
	status int // the provider's HTTP status, when the error came from one
}

func (e *Error) Error() string { return e.Msg }

// Is matches by kind: errors.Is(err, &ai.Error{Kind: ai.KindAuthFailed}).
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Kind == e.Kind
}

// ErrNotReady is what a consumer gets from a role that is not ready.
var ErrNotReady = &Error{Kind: KindNotReady, Msg: "the AI model is not ready"}

// KindOf is err's kind, "" for an error that is not an *Error.
func KindOf(err error) Kind {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return ""
}

func newErr(k Kind, msg string) *Error { return &Error{Kind: k, Msg: msg} }

var (
	bearerRe = regexp.MustCompile(`(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]{4,}`)
	// Keys as the common providers print them back ("Incorrect API key
	// provided: sk-…").
	skRe = regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{6,}|tgp_[A-Za-z0-9_-]{6,}|[A-Za-z0-9_-]{32,})`)
)

// Scrub removes the given secrets, bearer tokens and anything shaped like an
// API key from s, the way the gh token is removed from githubcli errors.
func Scrub(s string, secrets ...string) string {
	for _, k := range secrets {
		if len(k) >= 4 {
			s = strings.ReplaceAll(s, k, "[key]")
		}
	}
	s = bearerRe.ReplaceAllString(s, "${1}[key]")
	return skRe.ReplaceAllString(s, "[key]")
}

// FirstJSONObject finds the first complete JSON object in text (the answer of
// an endpoint that ignored response_format may wrap it in prose or a code
// fence). ok is false when there is none.
func FirstJSONObject(text string) (obj string, ok bool) {
	for i := 0; i < len(text); i++ {
		if text[i] != '{' {
			continue
		}
		if end := objectEnd(text, i); end > 0 && json.Valid([]byte(text[i:end])) {
			return text[i:end], true
		}
	}
	return "", false
}

// objectEnd is the index after the object starting at text[i], 0 if it never
// closes.
func objectEnd(text string, i int) int {
	depth, inStr, esc := 0, false, false
	for j := i; j < len(text); j++ {
		c := text[j]
		switch {
		case inStr:
			switch {
			case esc:
				esc = false
			case c == '\\':
				esc = true
			case c == '"':
				inStr = false
			}
		case c == '"':
			inStr = true
		case c == '{':
			depth++
		case c == '}':
			depth--
			if depth == 0 {
				return j + 1
			}
		}
	}
	return 0
}
