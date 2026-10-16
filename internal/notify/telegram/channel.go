// Package telegram is the Telegram Bot API behind internal/notify's Channel
// (#11): the bot token in a 0600 file of its own (or a file the bridge
// environment names), sendMessage to the paired person, and pairing by a
// one-time code read with getUpdates, polled only while a pairing waits. No
// inbound port, no webhook. Only internal/app imports it
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
	// DefaultPollTimeout is getUpdates' long-poll timeout while pairing.
	DefaultPollTimeout = 25 * time.Second
	// DefaultPairTTL is how long a pairing code is good for.
	DefaultPairTTL = 10 * time.Minute
	// codeAlphabet has no 0/O, 1/I/L: read off a screen, typed on a phone.
	codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
	codeLen      = 8
	nameMax      = 64
	// pairBackoffCap bounds the wait between failed polls.
	pairBackoffCap = 30 * time.Second
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
	cancel  context.CancelFunc
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

// Send delivers n to the paired person.
func (c *Channel) Send(ctx context.Context, n notify.Notification) error {
	c.mu.Lock()
	t, uid, ok := c.tokenLocked(), c.stored.UserID, c.pairedLocked()
	c.mu.Unlock()
	switch {
	case t == "":
		return &notify.SendError{Code: notify.CodeNotConfigured, Msg: "no bot token is set"}
	case !ok:
		return &notify.SendError{Code: notify.CodeNotPaired, Msg: "no Telegram account is paired"}
	}
	return c.api.send(ctx, t, uid, n.Text(), n.Quiet)
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
	c.gen++
	c.pair = &pairState{gen: c.gen, code: code, expires: c.opts.Clock.Now().Add(c.opts.PairTTL), state: notify.PairWaiting}
	c.ended = nil
	c.mu.Unlock()
	select {
	case c.wake <- struct{}{}:
	default:
	}
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
	if c.pair != nil && c.pair.cancel != nil {
		c.pair.cancel()
	}
	c.pair = nil
}

// Run polls for the pairing code while a pairing waits, and does nothing
// else: no call to Telegram leaves it otherwise.
func (c *Channel) Run(ctx context.Context, report func(notify.PairResult)) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		}
		for {
			c.mu.Lock()
			p := c.pair
			var pctx context.Context
			if p != nil {
				var cancel context.CancelFunc
				pctx, cancel = context.WithCancel(ctx)
				p.cancel = cancel
			}
			c.mu.Unlock()
			if p == nil {
				break
			}
			res := c.poll(pctx, p)
			p.cancel()
			c.mu.Lock()
			current := c.pair == p
			if current {
				c.pair = nil
				if res.Outcome == notify.PairTimedOut {
					c.ended = &notify.Pairing{State: notify.PairExpired, Message: "The code expired before it arrived: start pairing again."}
				}
			}
			superseded := c.pair != nil && c.pair != p
			c.mu.Unlock()
			if ctx.Err() != nil {
				return
			}
			if !superseded && report != nil {
				report(res)
			}
			c.signal()
		}
	}
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

// poll waits for p's code: every other message, and every sender but the
// one who sends the code, is dropped without a word.
func (c *Channel) poll(ctx context.Context, p *pairState) notify.PairResult {
	res := notify.PairResult{Outcome: notify.PairCancelled}
	c.mu.Lock()
	t := c.tokenLocked()
	c.mu.Unlock()
	// What came before the code is not for it: the newest update only, which
	// confirms (forgets) the rest; the next poll confirms it too. That one
	// is read like any other: the code is new, so a message holding it was
	// sent after it was shown.
	var offset int64
	ups, err := c.api.updates(ctx, t, -1, 0)
	if err != nil {
		res.Errors++
		res.Status = statusOf(err)
	}
	fails := 0
	for {
		// A batch answered after the deadline is too late, however long the
		// poll took to come back.
		if c.expired(p) {
			res.Outcome = notify.PairTimedOut
			return res
		}
		if outcome := c.match(ctx, p, t, ups, &offset, &res); outcome != "" {
			res.Outcome = outcome
			return res
		}
		if ctx.Err() != nil {
			return res
		}
		left := p.expires.Sub(c.opts.Clock.Now())
		if left <= 0 {
			res.Outcome = notify.PairTimedOut
			return res
		}
		timeout := int(min(c.opts.PollTimeout, left).Seconds())
		ups, err = c.api.updates(ctx, t, offset, max(timeout, 1))
		if ctx.Err() != nil {
			return res
		}
		if err != nil {
			ups = nil
			fails++
			res.Errors++
			res.Status = statusOf(err)
			state, msg := notify.PairError, "Telegram failed: retrying."
			if notify.CodeOf(err) == notify.CodeConflict {
				state, msg = notify.PairConflict, err.Error()+": retrying."
			} else if notify.CodeOf(err) == notify.CodeUnauthorized {
				msg = err.Error() + "."
			}
			c.setPairState(p, state, msg)
			wait := min(notify.Backoff(fails)*2, pairBackoffCap, max(left, time.Millisecond))
			if notify.Sleep(ctx, c.opts.Clock, wait) != nil {
				return res
			}
			continue
		}
		fails = 0
		c.setPairState(p, notify.PairWaiting, "")
	}
}

// expired: p's code is past its deadline and can no longer pair.
func (c *Channel) expired(p *pairState) bool {
	return !c.opts.Clock.Now().Before(p.expires)
}

// match reads a batch of updates for p's code: the pairing's outcome once it
// is over (paired, expired, or cancelled when superseded meanwhile), else "".
func (c *Channel) match(ctx context.Context, p *pairState, t string, ups []update, offset *int64, res *notify.PairResult) string {
	for _, u := range ups {
		*offset = max(*offset, u.UpdateID+1)
		m := u.Message
		if m == nil || m.From == nil || m.From.IsBot || m.Chat.Type != "private" || normalize(m.Text) != p.code {
			res.Ignored++
			continue
		}
		outcome := c.paired(ctx, p, t, *m.From)
		if outcome == notify.PairedOK {
			// Confirm what was read, so the code is not read again.
			_, _ = c.api.updates(ctx, t, *offset, 0)
		}
		return outcome
	}
	return ""
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
	if err := c.api.send(sctx, token, from.ID, PairedText, false); err != nil {
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
