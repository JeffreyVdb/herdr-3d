// Package notify is the bridge's notifications (#11): a message on your
// phone when a worker needs you or finishes. It holds what is the same for
// every way a message can go: the inbox rule (rule.go, the game's, pinned by
// shared vectors), the episodes and the done settle (tracker.go), the
// settings with their test gate and environment override, the bounded queue
// and its backoff (service.go), and the narrow interfaces a provider fills:
// Destination (one message) and Channel (its credentials and the pairing of
// its recipient). The Telegram Bot API is internal/notify/telegram's; the
// app wires it in. This package knows no HTTP (TestNotifyCoreIsProviderNeutral):
// nothing here reaches the network but through a Channel.
package notify

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"
)

// Notification is one message.
type Notification struct {
	// Name is the worker's display name; Reason why it notifies (Reason*).
	Name, Reason string
	// Line is one line of what the worker did or asks (scrubbed by the
	// bridge; "" for none: a secret ask's).
	Line string
	// Quiet: delivered without a sound.
	Quiet bool
	// Test: the settings' test message (Name and Reason empty).
	Test bool
}

// LineMax is the most runes a notification's line keeps ("…" included).
const LineMax = 200

// TestText is the test message.
const TestText = "herdr-3d: notifications reach you here. You will get a message when a worker needs you or finishes."

// Text is the message as plain text: the worker and the reason, then the
// line.
func (n Notification) Text() string {
	if n.Test {
		return TestText
	}
	s := n.Name + " · " + n.Reason
	if l := OneLine(n.Line, LineMax); l != "" {
		s += "\n" + l
	}
	return s
}

// OneLine is s on one line (whitespace runs one space), at most max runes
// with an ellipsis.
func OneLine(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimRight(string(r[:max-1]), " ") + "…"
}

// Destination delivers one message to the paired recipient.
type Destination interface {
	// Send delivers n; a *SendError says why it did not (its message holds
	// no secret).
	Send(ctx context.Context, n Notification) error
}

// Channel is a Destination with its configuration: a token, and a
// recipient paired by a one-time code. Implementations keep the token to
// themselves: it is never in a ChannelState, an error or a log line.
type Channel interface {
	Destination
	// State is the channel as clients see it.
	State() ChannelState
	// Ready: a token and a paired recipient (Send can deliver).
	Ready() bool
	// Fingerprint names the token and the recipient in use: a passing test
	// covers exactly them.
	Fingerprint() string
	// SetToken checks a token with the provider and saves it (a token of
	// another bot unpairs).
	SetToken(ctx context.Context, token string) error
	ClearToken() error
	// StartPairing shows a new one-time code and waits for it (Run's work);
	// CancelPairing stops waiting; Unpair forgets the recipient.
	StartPairing(ctx context.Context) error
	CancelPairing() error
	Unpair() error
	// Changes signals (coalesced) that State changed.
	Changes() <-chan struct{}
	// Run does the channel's background work (the pairing's polling, only
	// while pairing) until ctx is done; pair is told how each pairing ended.
	Run(ctx context.Context, pair func(PairResult))
}

// ChannelState is a channel as the protocol shows it: never the token.
type ChannelState struct {
	Provider string `json:"provider"`
	KeySet   bool   `json:"key_set"`
	// KeyHint is the token's last four characters.
	KeyHint string `json:"key_hint,omitempty"`
	// Bot is the bot's username (no @), once the provider said it.
	Bot string `json:"bot,omitempty"`
	// KeyEnv: the bridge environment sets the token (it cannot be changed
	// here).
	KeyEnv  bool       `json:"key_env,omitempty"`
	Paired  *Recipient `json:"paired,omitempty"`
	Pairing *Pairing   `json:"pairing,omitempty"`
}

// Recipient is the paired person, as far as the UI needs: a first name and
// when (never the provider's id).
type Recipient struct {
	Name string `json:"name,omitempty"`
	At   int64  `json:"at"` // unix ms
}

// Pairing states.
const (
	PairWaiting  = "waiting"  // the code is shown; the bridge waits for it
	PairConflict = "conflict" // another program reads the bot's updates: retrying
	PairError    = "error"    // the provider failed: retrying
	PairExpired  = "expired"  // the code expired unused
)

// Pairing is a pairing in progress (or how the last one ended).
type Pairing struct {
	State string `json:"state"`
	// Code is the one-time code to send (absent once expired).
	Code      string `json:"code,omitempty"`
	ExpiresAt int64  `json:"expires_at,omitempty"` // unix ms
	Message   string `json:"message,omitempty"`
}

// Pair outcomes (PairResult.Outcome).
const (
	PairedOK      = "paired"
	PairCancelled = "cancelled"
	PairTimedOut  = "expired"
)

// PairResult is how a pairing ended, for the audit: no code, no id.
type PairResult struct {
	Outcome string
	// Ignored counts the updates dropped while it waited (other senders,
	// other texts).
	Ignored int
	// Errors counts the failed polls; Status is the last one's HTTP status.
	Errors int
	Status int
}

// Error codes (the protocol's).
const (
	CodeTestRequired  = "test_required"  // enabling without a passing notify.test
	CodeEnvLocked     = "env_locked"     // the bridge environment sets it
	CodeBadRequest    = "bad_request"    //
	CodeNotConfigured = "not_configured" // no token
	CodeNotPaired     = "not_paired"     // no recipient
	CodeUnauthorized  = "unauthorized"   // the provider refused the token
	CodeBlocked       = "blocked"        // the recipient blocked the bot, or never started it
	CodeRateLimited   = "rate_limited"
	CodeUnreachable   = "unreachable"
	CodeTimeout       = "timeout"
	CodeConflict      = "conflict" // another poller or a webhook
	CodeFailed        = "provider_failed"
	CodeDropped       = "dropped" // the queue was full
)

// Error is a failure of a settings command, its message fit to show.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

// SendError is a failed delivery (or another call to the provider): its
// code, the HTTP status, how long the provider asked to wait. Msg holds no
// secret.
type SendError struct {
	Code       string
	Status     int
	RetryAfter time.Duration
	Msg        string
}

func (e *SendError) Error() string { return e.Msg }

// Retryable: worth another attempt (rate limited, a network failure, a
// timeout, the provider's 5xx).
func (e *SendError) Retryable() bool {
	switch e.Code {
	case CodeRateLimited, CodeUnreachable, CodeTimeout:
		return true
	case CodeFailed:
		return e.Status == 0 || e.Status >= 500
	}
	return false
}

// CodeOf is err's protocol code ("" when it is none of this package's).
func CodeOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	var se *SendError
	if errors.As(err, &se) {
		return se.Code
	}
	return ""
}
