package notify

// #13: a reply to a notification, from your phone, typed into the worker
// it was about. The Channel reads the recipient's messages (only theirs:
// their private chat, typed by them) while replies are on, and hands each
// over without waiting (inbound). The replier, a goroutine of its own,
// checks it (a reply, text, not too old or too long, a notification it
// still knows, the rate limits), has the hub type it (Options.Prompt: the
// game's worker.prompt path and lane), and confirms it once the lane typed
// it (Confirm: a 👍) or answers why not (Answer). Every answer is one of
// the fixed sentences below: never what was typed, never a secret. Each
// reply is audited (AuditReply) by its lengths, never its text.

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"
)

// Bounds of the replies.
const (
	// MaxReplyRunes is the longest text typed into a worker (Telegram's own
	// limit for a message; within the hub's 16 KiB).
	MaxReplyRunes = 4096
	// ReplyMaxAge: a reply older than this when it is read (sent while the
	// bridge was away) is not typed: it is answered, so you know.
	ReplyMaxAge = 2 * time.Minute
	// MessageMaxAge: a notification older than this is not replied to (the
	// store forgets it too, and keeps the newest 500).
	MessageMaxAge = 7 * 24 * time.Hour
	// ReplyQueue is how many replies wait for the replier; more are dropped.
	ReplyQueue = 64
	// ReplyPerWorker replies to one worker, and ReplyTotal in all, within
	// ReplyWindow; more are refused.
	ReplyPerWorker = 6
	ReplyTotal     = 20
	ReplyWindow    = time.Minute
	// AnswerMax answers (hints, refusals) within AnswerWindow; more are not
	// sent, so a flood of messages never makes the bot flood back.
	AnswerMax    = 10
	AnswerWindow = time.Minute
)

// Why a reply's prompt was refused (ReplyError.Kind; the audit's outcome).
const (
	ReplyAsk      = "ask"           // the worker has a question (#57)
	ReplyGone     = "gone"          // no such worker any more
	ReplyState    = "invalid_state" // asleep, no agent, blocked
	ReplyBusy     = "busy"          // its input lane is full
	ReplyBadText  = "bad_text"      // it cannot be typed
	ReplyHandoff  = "handoff"       // /handoff: the game's
	ReplyFailed   = "failed"        // herdr failed it, or the bridge
	ReplyClosed   = "closed"        // #14: the ask or follow-up answered was answered, replaced or ended meanwhile
	replySent     = "sent"
	replyNotReply = "not_a_reply"
	replyNoText   = "no_text"
	replyRelayed  = "relayed"
	replyStale    = "stale"
	replyTooLong  = "too_long"
	replyUnknown  = "unknown"
	replyLimited  = "rate_limited"
	replyTyped    = "typed_answer" // #14: a card's typed answer
	// ReplyUnresolved (#88): a menu card's keys went, and the worker still
	// waits on it after the hub's AnswerTimeout (a card's outcome, not a
	// refusal).
	ReplyUnresolved = "unresolved"
)

// ReplyError is a refused reply's prompt: Kind is one of Reply*.
type ReplyError struct {
	Kind string
	Err  error
}

func (e *ReplyError) Error() string {
	if e.Err != nil {
		return e.Kind + ": " + e.Err.Error()
	}
	return e.Kind
}

func (e *ReplyError) Unwrap() error { return e.Err }

// The bot's answers.
const (
	ReplyHintText    = "To send text to a worker, reply to its notification (swipe left on it, or long-press it and tap Reply)."
	ReplyAskText     = "This worker has a question, tap an answer or answer in the game"
	ReplyUnknownText = "I no longer know which worker this was, reply to a newer notification"
)

var answers = map[string]string{
	replyNotReply: ReplyHintText,
	replyNoText:   "Only text is sent to a worker. " + ReplyHintText,
	replyRelayed:  "Not sent: only text you type yourself goes to a worker, not a forward or a message through another bot.",
	replyStale:    "Not sent: it arrived while the bridge was away. Reply again if it still applies.",
	replyUnknown:  ReplyUnknownText,
	replyLimited:  "Not sent: too many replies in a minute. Wait a little and reply again.",
	ReplyAsk:      ReplyAskText,
	ReplyGone:     "Not sent: that worker is gone.",
	ReplyState:    "Not sent: that worker cannot take a prompt now (its floor is asleep, it runs no agent, or it is blocked). Open it in the game.",
	ReplyBusy:     "Not sent: that worker already has a lot of input waiting. Try again in a moment.",
	ReplyBadText:  "Not sent: that text cannot be typed into this worker.",
	ReplyHandoff:  "Not sent: ask for a handoff in the game.",
	ReplyFailed:   "Not sent: the bridge could not type it into the worker.",
	ReplyClosed:   "Not sent: the question was answered in the game, or the agent moved on.",
}

// tooLongText is the answer to a reply over MaxReplyRunes.
func tooLongText(n int) string {
	return fmt.Sprintf("Not sent: too long (%d characters). At most %d.", n, MaxReplyRunes)
}

// replyAudit is a notify.reply row's args: the worker, the text's lengths,
// how it went; never the text.
type replyAudit struct {
	ID        string `json:"id,omitempty"`
	TextBytes int    `json:"text_bytes"`
	TextRunes int    `json:"text_runes"`
	Outcome   string `json:"outcome"`
}

// window allows n events within per.
type window struct {
	n   int
	per time.Duration
	at  []time.Time
}

func (w *window) allow(now time.Time) bool {
	keep := w.at[:0]
	for _, t := range w.at {
		if now.Sub(t) < w.per {
			keep = append(keep, t)
		}
	}
	w.at = keep
	if len(w.at) >= w.n {
		return false
	}
	w.at = append(w.at, now)
	return true
}

// done is a reply's prompt that ended on the lane.
type done struct {
	r   Reply
	row replyAudit
	err error
}

// replies is the replier's: what waits for it, and its limits (the
// limits are its goroutine's alone).
type replies struct {
	mu      sync.Mutex
	in      []Reply
	ended   []done
	kick    chan struct{}
	dropped bool
	// #14: the cards' work, in order (taps, sightings, answers that
	// ended), and how many taps wait among it.
	jobs []func(context.Context)
	taps int

	total, answers window
	workers        map[string]*window
}

func newReplies() replies {
	return replies{kick: make(chan struct{}, 1), total: window{n: ReplyTotal, per: ReplyWindow},
		answers: window{n: AnswerMax, per: AnswerWindow}, workers: map[string]*window{}}
}

func (s *Service) poke() {
	select {
	case s.rp.kick <- struct{}{}:
	default:
	}
}

// inbound is the channel's Hooks.Reply: it never blocks. Past ReplyQueue
// waiting the reply is dropped.
func (s *Service) inbound(r Reply) {
	s.rp.mu.Lock()
	full := len(s.rp.in) >= ReplyQueue
	if !full {
		s.rp.in = append(s.rp.in, r)
	}
	warn := full && !s.rp.dropped
	s.rp.dropped = s.rp.dropped || full
	s.rp.mu.Unlock()
	if warn {
		s.opts.Log.Warn("notifications: replies dropped (the replier is behind)")
	}
	s.poke()
}

// listening: replies are on and the channel can read them; since is when
// they were switched on (zero: on at the start).
func (s *Service) listening() (bool, time.Time) {
	if !s.opts.Channel.Ready() {
		return false, time.Time{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.set.Replies, s.since
}

// replier handles the replies and the prompts that ended, one at a time.
func (s *Service) replier(ctx context.Context) {
	var timer Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		// #106: and when the earliest parked card set may go.
		var wake <-chan time.Time
		if at, ok := due(s.bt.parked); ok {
			timer = s.opts.Clock.NewTimer(at.Sub(s.now()))
			wake = timer.C()
		}
		select {
		case <-ctx.Done():
			return
		case <-s.rp.kick:
		case <-wake:
		}
		if timer != nil {
			timer.Stop()
			timer = nil
		}
		s.releaseCards(ctx)
		for ctx.Err() == nil {
			s.rp.mu.Lock()
			in, ended, jobs := s.rp.in, s.rp.ended, s.rp.jobs
			s.rp.in, s.rp.ended, s.rp.jobs = nil, nil, nil
			s.rp.mu.Unlock()
			if len(in) == 0 && len(ended) == 0 && len(jobs) == 0 {
				break
			}
			for _, j := range jobs {
				j(ctx)
			}
			for _, d := range ended {
				s.ended(ctx, d)
			}
			for _, r := range in {
				s.reply(ctx, r)
			}
			// #14: the cards the batch changed, one edit each.
			s.flush(ctx)
		}
	}
}

// reply checks r and has it typed into its notification's worker.
func (s *Service) reply(ctx context.Context, r Reply) {
	on, since := s.listening()
	// Switched off or unpaired meanwhile, or not sent after replies were
	// switched on: not for a worker, and not answered. At is in whole
	// seconds: one sent in the second they were switched on is dropped too
	// (it may have been sent while they were off).
	if !on || (!since.IsZero() && !r.At.After(since)) {
		return
	}
	row := replyAudit{TextBytes: len(r.Text), TextRunes: utf8.RuneCountInString(r.Text)}
	now := s.now()
	refuse := func(outcome, text string) {
		row.Outcome = outcome
		s.audit(ctx, AuditReply, row, errors.New(outcome))
		s.answer(ctx, r.Ref, text)
	}
	switch {
	case r.Relayed:
		refuse(replyRelayed, answers[replyRelayed])
		return
	case !r.To.Valid():
		refuse(replyNotReply, answers[replyNotReply])
		return
	case r.Text == "":
		refuse(replyNoText, answers[replyNoText])
		return
	case now.Sub(r.At) > ReplyMaxAge:
		refuse(replyStale, answers[replyStale])
		return
	case row.TextRunes > MaxReplyRunes:
		refuse(replyTooLong, tooLongText(row.TextRunes))
		return
	}
	// #14: a reply to a card's prompt is its typed answer; one to an open
	// card is told to tap (never typed as a prompt).
	if a, ok := s.bt.prompts[r.To]; ok {
		s.typed(ctx, r, a, row)
		return
	}
	if a, ok := s.bt.cards[r.To]; ok {
		row.ID = a.s.worker
		refuse(ReplyAsk, answers[ReplyAsk])
		return
	}
	var id string
	var at time.Time
	var ok bool
	if st := s.opts.Store; st != nil {
		var err error
		if id, at, ok, err = st.NotifyMessage(ctx, r.To); err != nil {
			s.opts.Log.Error("notifications: a reply's notification could not be looked up", "err", err)
			refuse(ReplyFailed, answers[ReplyFailed])
			return
		}
	}
	if !ok || now.Sub(at) > MessageMaxAge {
		refuse(replyUnknown, answers[replyUnknown])
		return
	}
	row.ID = id
	w := s.rp.workers[id]
	if w == nil {
		s.prune(now)
		w = &window{n: ReplyPerWorker, per: ReplyWindow}
		s.rp.workers[id] = w
	}
	if !w.allow(now) || !s.rp.total.allow(now) {
		refuse(replyLimited, answers[replyLimited])
		return
	}
	if s.opts.Prompt == nil {
		refuse(ReplyFailed, answers[ReplyFailed])
		return
	}
	// Handed over only while it is still the recipient's under the switch
	// it was read under: switched off, unpaired or paired anew meanwhile,
	// it is dropped without a word.
	var err error
	if !s.opts.Channel.Hold(r, func() {
		err = s.opts.Prompt(ctx, id, r.Text, func(err error) {
			s.rp.mu.Lock()
			s.rp.ended = append(s.rp.ended, done{r, row, err})
			s.rp.mu.Unlock()
			s.poke()
		})
	}) {
		return
	}
	if err != nil {
		s.ended(ctx, done{r, row, err})
	}
}

// prune forgets the workers' windows that are empty, past a few hundred.
func (s *Service) prune(now time.Time) {
	if len(s.rp.workers) < 256 {
		return
	}
	for id, w := range s.rp.workers {
		if n := len(w.at); n == 0 || now.Sub(w.at[n-1]) >= ReplyWindow {
			delete(s.rp.workers, id)
		}
	}
}

// ended confirms a reply its lane typed, or answers why it did not.
func (s *Service) ended(ctx context.Context, d done) {
	if d.err == nil {
		d.row.Outcome = replySent
		s.audit(ctx, AuditReply, d.row, nil)
		s.opts.Log.Info("reply typed into its worker", "worker", d.row.ID)
		if err := s.call(ctx, func(ctx context.Context) error { return s.opts.Channel.Confirm(ctx, d.r.Ref) }); err != nil {
			s.opts.Log.Warn("notifications: a reply's confirmation was not delivered", "code", CodeOf(err))
		}
		return
	}
	kind := ReplyFailed
	var re *ReplyError
	if errors.As(d.err, &re) && answers[re.Kind] != "" {
		kind = re.Kind
	}
	// Not the hub's error: what herdr said may quote the pane.
	s.opts.Log.Info("reply not typed", "worker", d.row.ID, "outcome", kind)
	d.row.Outcome = kind
	s.audit(ctx, AuditReply, d.row, errors.New(kind))
	s.answer(ctx, d.r.Ref, answers[kind])
}

// answer sends one of the fixed answers to msg, at most AnswerMax within
// AnswerWindow.
func (s *Service) answer(ctx context.Context, msg Ref, text string) {
	if !s.rp.answers.allow(s.now()) {
		s.opts.Log.Debug("notifications: an answer to a reply was not sent (too many)")
		return
	}
	if err := s.call(ctx, func(ctx context.Context) error { return s.opts.Channel.Answer(ctx, msg, text) }); err != nil {
		s.opts.Log.Warn("notifications: an answer to a reply was not delivered", "code", CodeOf(err))
	}
}

// remember keeps which worker a sent notification was about.
func (s *Service) remember(ctx context.Context, ref Ref, worker string) {
	if !ref.Valid() || worker == "" || s.opts.Store == nil {
		return
	}
	if err := s.opts.Store.SaveNotifyMessage(ctx, ref, worker, s.now()); err != nil {
		s.opts.Log.Error("notifications: a sent notification's worker could not be saved", "err", err)
	}
}
