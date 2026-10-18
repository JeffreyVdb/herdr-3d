// Package notify is the bridge's notifications (#11): a message on your
// phone when a worker needs you or finishes. It holds what is the same for
// every way a message can go: the inbox rule (rule.go, the game's, pinned by
// shared vectors), the episodes and the done settle (tracker.go), the
// settings with their test gate and environment override, the bounded queue
// and its backoff (service.go), and the narrow interfaces a provider fills:
// Destination (one message) and Channel (its credentials and the pairing of
// its recipient). The Telegram Bot API is internal/notify/telegram's; the
// app wires it in. This package knows no HTTP (TestNotifyCoreIsProviderNeutral):
// nothing here reaches the network but through a Channel. #13: a reply to a
// notification is typed into its worker (reply.go): the Channel hands the
// recipient's messages in and confirms or answers them; the hub types them.
// #14: an ask or a follow-up comes with a card per question, buttons to
// tap the answer (buttons.go); the hub answers it as the game does.
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
	// WorkerID is the worker it is about (#13: a reply to it is typed into
	// that worker; never in Text).
	WorkerID string
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

// Ref names a message at the provider (#13): the chat it is in and its id
// there (Telegram's are unique within a chat only). A zero Message is none.
type Ref struct {
	Chat, Message int64
}

// Valid: it names a message.
func (r Ref) Valid() bool { return r.Message != 0 }

// Destination delivers one message to the paired recipient.
type Destination interface {
	// Send delivers n and names the message it became (a zero Ref when the
	// provider did not say); a *SendError says why it did not (its message
	// holds no secret).
	Send(ctx context.Context, n Notification) (Ref, error)
}

// Reply is a message the paired recipient sent (#13). The Channel checked
// who sent it: their own private chat with the bot, typed by them; every
// other sender is dropped there without a word.
type Reply struct {
	// Ref is the message itself: what Confirm and Answer take.
	Ref Ref
	// To is the bot's message it replies to (not Valid: not a reply).
	To Ref
	// Text is what was typed ("": a message without text, a photo).
	Text string
	// At is when it was sent (the provider's clock).
	At time.Time
	// Relayed: not typed here by the recipient (forwarded, or sent through
	// another bot).
	Relayed bool
	// Epoch is the Channel's: the switch and the recipient it was read
	// under (Hold compares it).
	Epoch uint64
}

// Card is a message with buttons (#14): plain text, and rows of buttons.
type Card struct {
	Text    string
	Buttons [][]Button
	// Quiet: delivered without a sound.
	Quiet bool
}

// Button is one button of a card: its label, and the data a tap on it
// hands back (Tap.Data: a few bytes the service resolves, never an id of
// the bridge's).
type Button struct {
	Text, Data string
}

// MaxButtonData is the most bytes of a Button's Data (Telegram's
// callback_data).
const MaxButtonData = 64

// Tap is a button the recipient tapped (#14). The Channel checked who
// tapped it, as it checks a Reply's sender; every other tap is answered
// there without a word.
type Tap struct {
	// ID is the provider's id of the tap: AnswerTap takes it.
	ID string
	// Msg is the card whose button it was.
	Msg  Ref
	Data string
	// Epoch is the Channel's, as a Reply's.
	Epoch uint64
}

// Hooks are what a Channel's Run tells the service.
type Hooks struct {
	// Pair is told how each pairing ended.
	Pair func(PairResult)
	// Reply gets each message the recipient sent while replies are read
	// (Channel.Listen). It must not block.
	Reply func(Reply)
	// Tap gets each button the recipient tapped while replies are read
	// (#14). It must not block. False: not taken (its queue is full), and
	// the Channel answers it without a word, as it does every tap when Tap
	// is nil.
	Tap func(Tap) bool
	// Listen: replies were on when the bridge started, so what came while
	// it was away is read too (the service answers what is too old). Else
	// reading starts from what is sent next.
	Listen bool
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
	// Listen switches reading the recipient's replies on or off (#13): on,
	// and paired, Run reads them and hands each to Hooks.Reply; switched on,
	// what was sent before is never handed over. Off, none is handed over
	// from then on, even of a read already under way.
	Listen(on bool)
	// Hold runs fn (the reply's hand-off to its worker) while r is still
	// the recipient's under the switch it was read under: false, and fn not
	// run, once Listen switched off, the recipient was unpaired or another
	// paired, or the token changed since. Those wait for fn: once they
	// return, no reply read before is handed over.
	Hold(r Reply, fn func()) bool
	// Confirm marks a reply as typed into its worker (Telegram: a 👍
	// reaction); Answer answers a message with a short text of the
	// service's (a refusal, a hint), as a reply to it.
	Confirm(ctx context.Context, msg Ref) error
	Answer(ctx context.Context, msg Ref, text string) error
	// SendCard delivers a card to the paired recipient (#14); EditCard
	// replaces a card's text and buttons (no buttons: none left), and an
	// edit that changes nothing is no error; ClearButtons takes a message's
	// buttons away and keeps its text.
	SendCard(ctx context.Context, c Card) (Ref, error)
	EditCard(ctx context.Context, msg Ref, c Card) error
	ClearButtons(ctx context.Context, msg Ref) error
	// AnswerTap answers a tap (its spinner stops; text, if any, shows
	// briefly). AskText sends text as a reply to msg that opens the reply
	// field (Telegram: a force reply) with placeholder in it; the
	// recipient's reply to it is a Reply To it.
	AnswerTap(ctx context.Context, id, text string) error
	AskText(ctx context.Context, msg Ref, text, placeholder string) (Ref, error)
	// Run does the channel's background work until ctx is done: one reader
	// of the provider's updates, while a pairing waits or replies are read.
	Run(ctx context.Context, h Hooks)
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
	CodeDropped       = "dropped"  // the queue was full
	CodeObsolete      = "obsolete" // #106: its episode ended before it went
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
