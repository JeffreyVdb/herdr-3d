// Package telegram is the Telegram Bot API behind internal/notify's Channel
// (#11): the bot token in a 0600 file of its own (or a file the bridge
// environment names), sendMessage to the paired person, and pairing by a
// one-time code read with getUpdates. #13: the paired person's replies are
// read by the same getUpdates loop, the one reader of the bot's updates
// (two would make Telegram answer 409), polled only while a pairing waits
// or replies are on; a reply typed into its worker gets a 👍 reaction, one
// that is not an answer as a reply to it. No inbound port, no webhook. Only
// internal/app imports it
// (TestNotifyCoreIsProviderNeutral): the hub, the store and the protocol
// know notify's interfaces only. The token never leaves this package: not
// in a ChannelState, an error, a log line or a message (Scrub).
package telegram

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
)

// Defaults.
const (
	// DefaultPollTimeout is getUpdates' long-poll timeout.
	DefaultPollTimeout = 25 * time.Second
	// DefaultPairTTL is how long a pairing code is good for.
	DefaultPairTTL = 10 * time.Minute
	// codeAlphabet has no 0/O, 1/I/L: read off a screen, typed on a phone.
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLen      = 8
	nameMax      = 64
	// pairBackoffCap bounds the wait between failed polls.
	pairBackoffCap = 30 * time.Second
	// confirmTimeout bounds the poll that confirms what was read, before
	// the loop goes idle or stops.
	confirmTimeout = 2 * time.Second
	// confirmEmoji is the reaction on a reply typed into its worker.
	confirmEmoji = "👍"
)

// PairedText is what the bot says to the person who just paired.
const PairedText = "Paired with herdr-3d. You will get a message here when a worker needs you or finishes (Settings → Telegram)."

// Options configure a Channel.
type Options struct {
	// File is telegram.json ("": kept in memory, for tests).
	File string
	// KeyFile, when set, is the file the bridge environment gives the token
	// in (HERDR_WORLD_TELEGRAM_KEY_FILE): it wins, and cannot be changed
	// from the settings.
	KeyFile string
	// BaseURL is the Bot API's (default DefaultBaseURL; tests: httptest).
	BaseURL string
	// Client makes the calls (default: a client of its own; each call is
	// bounded by its context).
	Client      *http.Client
	Clock       notify.Clock  // default notify.RealClock
	PollTimeout time.Duration // default DefaultPollTimeout (whole seconds)
	PairTTL     time.Duration // default DefaultPairTTL
	Rand        io.Reader     // default crypto/rand
	Log         *slog.Logger
}

// pairState is the pairing that waits.
type pairState struct {
	gen     int
	code    string // ABCDEFGH (shown as ABCD-EFGH)
	expires time.Time
	state   string
	msg     string
}

// Channel is the Telegram notify.Channel. Safe for concurrent use.
type Channel struct {
	opts   Options
	api    api
	file   fileStore
	change chan struct{}
	wake   chan struct{}

	mu       sync.Mutex
	stored   Stored
	envToken string
	pair     *pairState
	ended    *notify.Pairing // how the last pairing ended (expired), until the next
	gen      int
	// #13: replies are read (the service's switch); the hooks Run was
	// given; interrupt cancels the poll (or its backoff) under way, so the
	// loop looks again at what to poll for.
	listen    bool
	hooks     notify.Hooks
	interrupt context.CancelFunc
}

var _ notify.Channel = (*Channel)(nil)

// New opens the file (a malformed one is an error, never overwritten).
func New(opts Options) (*Channel, error) {
	if opts.BaseURL == "" {
		opts.BaseURL = DefaultBaseURL
	}
	if opts.Client == nil {
		opts.Client = &http.Client{}
	}
	if opts.Clock == nil {
		opts.Clock = notify.RealClock{}
	}
	if opts.PollTimeout < time.Second {
		opts.PollTimeout = DefaultPollTimeout
	}
	if opts.PairTTL <= 0 {
		opts.PairTTL = DefaultPairTTL
	}
	if opts.Rand == nil {
		opts.Rand = rand.Reader
	}
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	c := &Channel{opts: opts, api: api{base: strings.TrimRight(opts.BaseURL, "/"), client: opts.Client},
		file: fileStore{opts.File}, change: make(chan struct{}, 1), wake: make(chan struct{}, 1)}
	st, err := c.file.load()
	if err != nil {
		return nil, err
	}
	c.stored = st
	if opts.KeyFile != "" {
		if b, err := os.ReadFile(opts.KeyFile); err == nil {
			c.envToken = strings.TrimSpace(string(b))
		} else {
			opts.Log.Warn("telegram: the token file cannot be read", "file", opts.KeyFile)
		}
	}
	return c, nil
}

func (c *Channel) signal() {
	select {
	case c.change <- struct{}{}:
	default:
	}
}

func (c *Channel) Changes() <-chan struct{} { return c.change }

func (c *Channel) tokenLocked() string {
	if c.opts.KeyFile != "" {
		return c.envToken
	}
	return c.stored.Token
}

// pairedLocked: a recipient paired with this token's bot.
func (c *Channel) pairedLocked() bool {
	t := c.tokenLocked()
	return t != "" && c.stored.UserID != 0 && c.stored.BotID == botID(t)
}

func hint(token string) string {
	if len(token) < 12 {
		return ""
	}
	return token[len(token)-4:]
}

func (c *Channel) State() notify.ChannelState {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.tokenLocked()
	st := notify.ChannelState{Provider: "telegram", KeySet: t != "", KeyHint: hint(t), KeyEnv: c.opts.KeyFile != ""}
	if t != "" && c.stored.BotID == botID(t) {
		st.Bot = c.stored.Bot
	}
	if c.pairedLocked() {
		st.Paired = &notify.Recipient{Name: c.stored.UserName, At: c.stored.PairedAt}
	}
	switch p := c.pair; {
	case p != nil:
		st.Pairing = &notify.Pairing{State: p.state, Code: p.code[:4] + "-" + p.code[4:], ExpiresAt: p.expires.UnixMilli(), Message: p.msg}
	case c.ended != nil:
		e := *c.ended
		st.Pairing = &e
	}
	return st
}

func (c *Channel) Ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.pairedLocked()
}

func (c *Channel) Fingerprint() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := c.tokenLocked()
	if t == "" {
		return ""
	}
	h := sha256.Sum256([]byte(t + "|" + strconv.FormatInt(c.stored.UserID, 10)))
	return hex.EncodeToString(h[:8])
}

// recipient is the token and the paired person's id, or why there is none.
func (c *Channel) recipient() (string, int64, error) {
	c.mu.Lock()
	t, uid, ok := c.tokenLocked(), c.stored.UserID, c.pairedLocked()
	c.mu.Unlock()
	switch {
	case t == "":
		return "", 0, &notify.SendError{Code: notify.CodeNotConfigured, Msg: "no bot token is set"}
	case !ok:
		return "", 0, &notify.SendError{Code: notify.CodeNotPaired, Msg: "no Telegram account is paired"}
	}
	return t, uid, nil
}

// Send delivers n to the paired person.
func (c *Channel) Send(ctx context.Context, n notify.Notification) (notify.Ref, error) {
	t, uid, err := c.recipient()
	if err != nil {
		return notify.Ref{}, err
	}
	return c.api.send(ctx, t, uid, n.Text(), n.Quiet)
}

// Confirm reacts 👍 to a reply typed into its worker (#13).
func (c *Channel) Confirm(ctx context.Context, msg notify.Ref) error {
	t, _, err := c.recipient()
	if err != nil {
		return err
	}
	return c.api.react(ctx, t, msg.Chat, msg.Message, confirmEmoji)
}

// Answer sends text as a reply to the paired person's message (#13).
func (c *Channel) Answer(ctx context.Context, msg notify.Ref, text string) error {
	t, _, err := c.recipient()
	if err != nil {
		return err
	}
	return c.api.answer(ctx, t, msg.Chat, msg.Message, text)
}

// Listen switches reading replies on or off (#13).
func (c *Channel) Listen(on bool) {
	c.mu.Lock()
	changed := c.listen != on
	c.listen = on
	if changed {
		c.interruptLocked()
	}
	c.mu.Unlock()
	if changed {
		c.poke()
	}
}

// poke wakes an idle loop.
func (c *Channel) poke() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

// interruptLocked cancels the poll under way: the loop looks again.
func (c *Channel) interruptLocked() {
	if c.interrupt != nil {
		c.interrupt()
	}
}

func envLocked() error {
	return &notify.Error{Code: notify.CodeEnvLocked, Msg: "the bot token is set by the bridge environment (HERDR_WORLD_TELEGRAM_KEY_FILE)"}
}

// SetToken checks token with getMe and saves it. Another bot's token
// forgets the paired person (they paired with the other bot).
func (c *Channel) SetToken(ctx context.Context, token string) error {
	if c.opts.KeyFile != "" {
		return envLocked()
	}
	token = strings.TrimSpace(token)
	if !ValidToken(token) {
		return &notify.Error{Code: notify.CodeBadRequest, Msg: "that is not a bot token: @BotFather gives one like 123456789:AAH…"}
	}
	me, err := c.api.getMe(ctx, token)
	if err != nil {
		return err
	}
	if !me.IsBot {
		return &notify.Error{Code: notify.CodeBadRequest, Msg: "that token is not a bot's"}
	}
	c.mu.Lock()
	next := c.stored
	if next.BotID != botID(token) {
		next.UserID, next.UserName, next.PairedAt = 0, "", 0
	}
	next.Token, next.BotID, next.Bot = token, botID(token), clip(me.Username, nameMax)
	if err := c.file.save(next); err != nil {
		c.mu.Unlock()
		return fmt.Errorf("saving the Telegram settings failed: %w", err)
	}
	c.stored = next
	c.stopPairLocked()
	c.mu.Unlock()
	c.poke()
	c.signal()
	return nil
}

// ClearToken forgets the token, the bot and the paired person.
func (c *Channel) ClearToken() error {
	if c.opts.KeyFile != "" {
		return envLocked()
	}
	c.mu.Lock()
	if err := c.file.save(Stored{}); err != nil {
		c.mu.Unlock()
		return fmt.Errorf("saving the Telegram settings failed: %w", err)
	}
	c.stored = Stored{}
	c.stopPairLocked()
	c.ended = nil
	c.mu.Unlock()
	c.signal()
	return nil
}

// Unpair forgets the paired person (the token stays).
func (c *Channel) Unpair() error {
	c.mu.Lock()
	next := c.stored
	next.UserID, next.UserName, next.PairedAt = 0, "", 0
	if err := c.file.save(next); err != nil {
		c.mu.Unlock()
		return fmt.Errorf("saving the Telegram settings failed: %w", err)
	}
	c.stored = next
	c.interruptLocked() // #13: their replies are not read any more
	c.mu.Unlock()
	c.signal()
	return nil
}

func (c *Channel) newCode() (string, error) {
	b := make([]byte, codeLen)
	if _, err := io.ReadFull(c.opts.Rand, b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = codeAlphabet[int(b[i])%len(codeAlphabet)]
	}
	return string(b), nil
}

// StartPairing checks the token (getMe: the bot's username for the
// instructions) and shows a new code; Run polls for it until it arrives,
// expires or is cancelled.
func (c *Channel) StartPairing(ctx context.Context) error {
	c.mu.Lock()
	t := c.tokenLocked()
	c.mu.Unlock()
	if t == "" {
		return &notify.Error{Code: notify.CodeNotConfigured, Msg: "set the bot token first"}
	}
	me, err := c.api.getMe(ctx, t)
	if err != nil {
		return err
	}
	code, err := c.newCode()
	if err != nil {
		return fmt.Errorf("no pairing code: %w", err)
	}
	c.mu.Lock()
	if c.tokenLocked() != t {
		c.mu.Unlock()
		return &notify.Error{Code: notify.CodeBadRequest, Msg: "the token changed meanwhile: try again"}
	}
	if c.stored.BotID != botID(t) || c.stored.Bot != me.Username {
		next := c.stored
		if next.BotID != botID(t) {
			next.UserID, next.UserName, next.PairedAt = 0, "", 0
		}
		next.BotID, next.Bot = botID(t), clip(me.Username, nameMax)
		if err := c.file.save(next); err == nil {
			c.stored = next
		}
	}
	c.stopPairLocked()
	c.interruptLocked() // a poll under way does not look for this code
	c.gen++
	c.pair = &pairState{gen: c.gen, code: code, expires: c.opts.Clock.Now().Add(c.opts.PairTTL), state: notify.PairWaiting}
	c.ended = nil
	c.mu.Unlock()
	c.poke()
	c.signal()
	return nil
}

// CancelPairing stops waiting for the code.
func (c *Channel) CancelPairing() error {
	c.mu.Lock()
	c.stopPairLocked()
	c.ended = nil
	c.mu.Unlock()
	c.signal()
	return nil
}

func (c *Channel) stopPairLocked() {
	if c.pair != nil {
		c.interruptLocked()
	}
	c.pair = nil
}

// Run is the one reader of the bot's updates: it polls while a pairing
// waits or (#13) replies are read for a paired person, and makes no call to
// Telegram otherwise. Each update goes to the pairing (its code) or to
// Hooks.Reply (the paired person's message); every other one is dropped
// without a word.
func (c *Channel) Run(ctx context.Context, h notify.Hooks) {
	c.mu.Lock()
	c.hooks = h
	c.mu.Unlock()
	// Replies on at the start: what came while the bridge was away is read
	// (the service answers what is too old). Every other start from idle
	// forgets it.
	l := &reader{c: c, keep: h.Listen, idle: true}
	defer l.confirm(ctx)
	for ctx.Err() == nil {
		if l.step(ctx) {
			continue
		}
		select {
		case <-ctx.Done():
		case <-c.wake:
		}
	}
}

// reader is Run's: the offset, and the pairing it polls for.
type reader struct {
	c *Channel
	// token is the one offset and confirmed are of; offset is the next
	// update wanted, confirmed the offset Telegram was last asked from
	// (what is below it is forgotten there).
	token             string
	offset, confirmed int64
	// idle: nothing was polled since the last wait; keep: the next poll
	// from idle keeps what came before (else offset -1); skip: the next poll
	// forgets it.
	idle, keep, skip bool
	fails            int
	// cur is the pairing polled for, res its result so far.
	cur *pairState
	res notify.PairResult
}

// step polls once, if there is something to poll for (false: nothing; the
// loop waits).
func (l *reader) step(ctx context.Context) bool {
	c := l.c
	now := c.opts.Clock.Now()
	c.mu.Lock()
	var ended []notify.PairResult
	if l.cur != nil && c.pair != l.cur {
		// Ended elsewhere: cancelled (a pairing superseded by a new one is
		// not reported).
		if c.pair == nil {
			r := l.res
			r.Outcome = notify.PairCancelled
			ended = append(ended, r)
		}
		l.cur = nil
	}
	if p := c.pair; p != nil && !now.Before(p.expires) {
		c.pair = nil
		c.ended = &notify.Pairing{State: notify.PairExpired, Message: "The code expired before it arrived: start pairing again."}
		r := l.res
		if l.cur != p {
			r = notify.PairResult{}
		}
		r.Outcome = notify.PairTimedOut
		ended = append(ended, r)
		l.cur = nil
	}
	p := c.pair
	if p != nil && l.cur != p {
		l.cur, l.res = p, notify.PairResult{}
	}
	t := c.tokenLocked()
	listen := c.listen && c.pairedLocked()
	if t != l.token {
		// Another bot's updates (or none): its offset is not this one's.
		l.token, l.offset, l.confirmed, l.idle = t, 0, 0, true
	}
	if t == "" || (p == nil && !listen) {
		c.mu.Unlock()
		l.confirm(ctx)
		l.report(ended)
		l.idle, l.keep = true, false
		return false
	}
	if l.idle {
		l.idle, l.skip = false, !l.keep
		l.keep = false
	}
	pctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c.interrupt = cancel
	timeout := c.opts.PollTimeout
	if p != nil {
		timeout = min(timeout, p.expires.Sub(now))
	}
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.interrupt = nil
		c.mu.Unlock()
	}()
	l.report(ended)
	offset, secs := l.offset, max(int(timeout.Seconds()), 1)
	if l.skip {
		// What came before is not for this: the newest update only, which
		// confirms (forgets) the rest; the next poll confirms it too. That
		// one is read like any other: a pairing's code is new, and the
		// service drops a reply sent before replies were switched on.
		offset, secs = -1, 0
	}
	ups, err := c.api.updates(pctx, t, offset, secs)
	if pctx.Err() != nil {
		return true // stopped, or interrupted: look again
	}
	if err != nil {
		l.failed(pctx, p, err, now)
		return true
	}
	if l.fails > 0 {
		c.opts.Log.Info("telegram: reading the bot's updates works again")
	}
	l.fails, l.skip = 0, false
	if offset > 0 {
		l.confirmed = max(l.confirmed, offset)
	}
	if p != nil {
		c.setPairState(p, notify.PairWaiting, "")
	}
	l.dispatch(ctx, t, p, ups)
	return true
}

// failed shows a failed poll in the pairing (when one waits) and backs off.
func (l *reader) failed(ctx context.Context, p *pairState, err error, now time.Time) {
	c := l.c
	l.fails++
	if l.fails == 1 {
		c.opts.Log.Warn("telegram: reading the bot's updates failed", "code", notify.CodeOf(err), "status", statusOf(err))
	}
	wait := min(notify.Backoff(l.fails)*2, pairBackoffCap)
	if p != nil && l.cur == p {
		l.res.Errors++
		l.res.Status = statusOf(err)
		state, msg := notify.PairError, "Telegram failed: retrying."
		if notify.CodeOf(err) == notify.CodeConflict {
			state, msg = notify.PairConflict, err.Error()+": retrying."
		} else if notify.CodeOf(err) == notify.CodeUnauthorized {
			msg = err.Error() + "."
		}
		c.setPairState(p, state, msg)
		wait = min(wait, max(p.expires.Sub(now), time.Millisecond))
	}
	_ = notify.Sleep(ctx, c.opts.Clock, wait)
}

// dispatch hands each update of a batch to the pairing or to the replies.
func (l *reader) dispatch(ctx context.Context, t string, p *pairState, ups []update) {
	c := l.c
	// A batch answered after the deadline is too late for the code, however
	// long the poll took to come back.
	if p != nil && c.expired(p) {
		p = nil
	}
	for _, u := range ups {
		l.offset = max(l.offset, u.UpdateID+1)
		m := u.Message
		if p != nil && m != nil && m.From != nil && !m.From.IsBot && m.Chat.Type == "private" && normalize(m.Text) == p.code {
			switch c.paired(ctx, p, t, *m.From) {
			case notify.PairedOK:
				// Confirm what was read, so the code is not read again.
				l.confirm(ctx)
				r := l.res
				r.Outcome = notify.PairedOK
				l.report([]notify.PairResult{r})
				l.cur = nil
			case notify.PairCancelled:
				// Not saved: the pairing ends (the next step reports it).
				c.mu.Lock()
				if c.pair == p {
					c.pair = nil
				}
				c.mu.Unlock()
			}
			p = nil
			continue
		}
		if r, ok := c.replyOf(m); ok {
			c.hooks.Reply(r)
			continue
		}
		if p != nil {
			l.res.Ignored++
		}
	}
}

// confirm tells Telegram what was read (a poll from the offset, answered
// at once), before the loop goes idle or stops: else the next start reads
// it again.
func (l *reader) confirm(ctx context.Context) {
	if l.token == "" || l.offset <= l.confirmed {
		return
	}
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), confirmTimeout)
	defer cancel()
	if _, err := l.c.api.updates(cctx, l.token, l.offset, 0); err == nil {
		l.confirmed = l.offset
	}
}

func (l *reader) report(rs []notify.PairResult) {
	for _, r := range rs {
		if l.c.hooks.Pair != nil {
			l.c.hooks.Pair(r)
		}
	}
	if len(rs) > 0 {
		l.c.signal()
	}
}

// replyOf is m as a reply for the service (#13): only while replies are
// read, and only the paired person's own: their private chat with the bot,
// not a bot, not on behalf of a chat. Forwarded or sent through a bot, it
// is Relayed (refused there). A reply to anything but the bot's message is
// no reply (the hint).
func (c *Channel) replyOf(m *message) (notify.Reply, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if m == nil || !c.listen || !c.pairedLocked() || c.hooks.Reply == nil || m.From == nil || m.From.IsBot ||
		m.From.ID != c.stored.UserID || m.Chat.Type != "private" || m.SenderChat != nil || m.MessageID == 0 {
		return notify.Reply{}, false
	}
	r := notify.Reply{Ref: notify.Ref{Chat: m.Chat.ID, Message: m.MessageID}, Text: m.Text, At: time.Unix(m.Date, 0),
		Relayed: m.ForwardOrigin != nil || m.ViaBot != nil}
	if to := m.ReplyTo; to != nil && to.From != nil && to.From.IsBot && strconv.FormatInt(to.From.ID, 10) == c.stored.BotID {
		r.To = notify.Ref{Chat: m.Chat.ID, Message: to.MessageID}
	}
	return r, true
}

func (c *Channel) setPairState(p *pairState, state, msg string) {
	c.mu.Lock()
	changed := c.pair == p && (p.state != state || p.msg != msg)
	if changed {
		p.state, p.msg = state, msg
	}
	c.mu.Unlock()
	if changed {
		c.signal()
	}
}

// normalize is a code as typed: no spaces or dashes, upper case.
func normalize(s string) string {
	return strings.ToUpper(strings.NewReplacer(" ", "", "-", "", "\t", "", "\n", "").Replace(s))
}

// expired: p's code is past its deadline and can no longer pair.
func (c *Channel) expired(p *pairState) bool {
	return !c.opts.Clock.Now().Before(p.expires)
}

// paired stores who sent the code (from.id: the person, never the chat)
// and greets them, unless the code expired or was superseded meanwhile.
func (c *Channel) paired(ctx context.Context, p *pairState, token string, from user) string {
	c.mu.Lock()
	if c.pair != p || c.tokenLocked() != token {
		c.mu.Unlock()
		return notify.PairCancelled
	}
	if c.expired(p) {
		c.mu.Unlock()
		return notify.PairTimedOut
	}
	next := c.stored
	next.BotID = botID(token)
	next.UserID, next.UserName, next.PairedAt = from.ID, clip(strings.TrimSpace(from.FirstName), nameMax), c.opts.Clock.Now().UnixMilli()
	if err := c.file.save(next); err != nil {
		c.mu.Unlock()
		c.opts.Log.Error("telegram: the pairing could not be saved", "err", err)
		c.setPairState(p, notify.PairError, "The pairing could not be saved on the bridge.")
		return notify.PairCancelled
	}
	c.stored = next
	c.pair, c.ended = nil, nil // paired: the code is spent
	c.mu.Unlock()
	c.signal()
	sctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	if _, err := c.api.send(sctx, token, from.ID, PairedText, false); err != nil {
		c.opts.Log.Warn("telegram: the pairing greeting was not delivered", "code", notify.CodeOf(err))
	}
	return notify.PairedOK
}

func statusOf(err error) int {
	var se *notify.SendError
	if errors.As(err, &se) {
		return se.Status
	}
	return 0
}
