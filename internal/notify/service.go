package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Defaults and bounds.
const (
	// DefaultSettle is how long a done episode waits before it notifies (the
	// game's inbox pings wait as long).
	DefaultSettle = 5 * time.Second
	// DefaultQueue is how many alerts wait for the sender; more are dropped
	// (and audited).
	DefaultQueue = 32
	// MaxObserved is how many sightings wait for the loop; more are dropped
	// and counted (the hub never waits).
	MaxObserved = 4096
	// MaxAttempts bounds the deliveries of one alert.
	MaxAttempts = 4
	// SendTimeout bounds one delivery.
	SendTimeout = 15 * time.Second
	// backoffBase and backoffCap are the waits after a failed delivery
	// (doubling); maxRetryAfter the longest wait a rate limit may ask for
	// before the alert is given up.
	backoffBase   = time.Second
	backoffCap    = 30 * time.Second
	maxRetryAfter = 2 * time.Minute
	// testValidity is how long a passing notify.test allows enabling.
	testValidity = 30 * time.Minute
)

// States of the feature (View.State).
const (
	StateOff        = "off"        // switched off: nothing leaves the machine
	StateIncomplete = "incomplete" // on, but no token or no paired recipient: nothing is sent
	StateReady      = "ready"      // on and deliverable
	StateBlocked    = "blocked"    // on, but the last delivery was refused (the bot blocked, the token revoked)
)

// The bridge-originated audit rows.
const (
	AuditSend  = "notify.send"
	AuditPair  = "notify.pair"
	AuditReply = "notify.reply" // #13
)

// Settings are what the store keeps.
type Settings struct {
	Enabled bool
	// NeedsYou and Done: which events notify.
	NeedsYou, Done bool
	// Quiet: messages arrive without a sound.
	Quiet bool
	// Freelancers: a freelancer's done notifies too (the game inbox's
	// default: no).
	Freelancers bool
	// Replies (#13): a reply to a notification is typed into its worker.
	// Off by default, and apart from Enabled.
	Replies bool
}

// DefaultSettings: off, both events, with sound, no freelancers, no
// replies.
func DefaultSettings() Settings { return Settings{NeedsYou: true, Done: true} }

// Store keeps the settings (the bridge's database), and (#13) which worker
// each sent notification was about, bounded (the store forgets the oldest).
type Store interface {
	LoadNotifySettings(ctx context.Context) (Settings, bool, error)
	SaveNotifySettings(ctx context.Context, s Settings) error
	SaveNotifyMessage(ctx context.Context, msg Ref, worker string, at time.Time) error
	// NotifyMessage is the worker msg was about and when it was sent (ok
	// false: none, or forgotten).
	NotifyMessage(ctx context.Context, msg Ref) (worker string, at time.Time, ok bool, err error)
}

// Options configure a Service.
type Options struct {
	Store   Store
	Channel Channel
	// EnvEnabled is HERDR_WORLD_NOTIFY_ENABLED (nil: not set): while set it
	// wins over the stored switch and needs no test (the channel must still
	// be ready).
	EnvEnabled *bool
	Clock      Clock         // default RealClock
	Settle     time.Duration // default DefaultSettle
	Queue      int           // default DefaultQueue
	// Audit writes a bridge-originated audit row (AuditSend, AuditPair,
	// AuditReply): args hold no text, token, code or provider id.
	Audit func(ctx context.Context, cmd string, args any, err error)
	// Prompt (#13) types a reply's text into worker id as you would in the
	// game (the hub's worker.prompt: its checks, the worker's input lane).
	// An error refuses it at once; else done is called once, when the lane
	// typed it (nil) or failed. A *ReplyError says why (else ReplyFailed).
	// Nil: replies are refused.
	Prompt func(ctx context.Context, id, text string, done func(error)) error
	Log    *slog.Logger
}

// Events is which events notify.
type Events struct {
	NeedsYou bool `json:"needs_you"`
	Done     bool `json:"done"`
}

// LastError is the last delivery that failed (cleared by one that worked).
type LastError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	At      int64  `json:"at"` // unix ms
}

// View is the feature as clients see it (notify.get, notify.update,
// World.notify): never a token.
type View struct {
	Enabled bool   `json:"enabled"`
	State   string `json:"state"`
	// Missing lists what the channel lacks ("token", "recipient").
	Missing []string `json:"missing,omitempty"`
	// Env lists the fields the bridge environment sets ("enabled", "token").
	Env []string `json:"env"`
	// Tested: a passing notify.test covers the token and recipient in use.
	Tested      bool   `json:"tested"`
	Events      Events `json:"events"`
	Quiet       bool   `json:"quiet"`
	Freelancers bool   `json:"freelancers"`
	// Replies (#13): a reply to a notification is typed into its worker.
	Replies   bool         `json:"replies"`
	Channel   ChannelState `json:"channel"`
	LastError *LastError   `json:"last_error,omitempty"`
	// Dropped counts the alerts and sightings dropped since the bridge
	// started (a full queue).
	Dropped int64 `json:"dropped,omitempty"`
}

// Update is a change of the settings: a nil field is kept.
type Update struct {
	Enabled, NeedsYou, Done, Quiet, Freelancers, Replies *bool
}

// TestResult is notify.test's answer.
type TestResult struct {
	OK        bool  `json:"ok"`
	LatencyMS int64 `json:"latency_ms"`
}

// Observation is one look at a worker (the hub's, after a worker event).
type Observation struct {
	Worker Worker
	// Name is its display name, Line the message's line (scrubbed; "" for a
	// secret ask).
	Name, Line string
	// Gone: the worker left.
	Gone bool
}

type passedTest struct {
	fp string
	at time.Time
}

type job struct{ alert Alert }

// Service holds the settings and sends the notifications. Observe never
// blocks; Run does the work. Safe for concurrent use.
type Service struct {
	opts   Options
	change chan struct{}
	kick   chan struct{}
	queue  chan job

	// applying serialises Apply: the channel listens as the settings it
	// committed last say (#13).
	applying sync.Mutex
	mu       sync.Mutex
	set      Settings
	passed   *passedTest
	last     *LastError
	// since is when replies were switched on (zero: on at the start).
	since time.Time

	rp replies // #13: the replier's

	obsMu    sync.Mutex
	obs      []Observation
	dropped  atomic.Int64
	tr       *tracker // the loop's
	running  atomic.Bool
	warnOnce sync.Once
}

// New loads the settings.
func New(ctx context.Context, opts Options) (*Service, error) {
	if opts.Channel == nil {
		return nil, errors.New("notify: no channel")
	}
	if opts.Clock == nil {
		opts.Clock = RealClock{}
	}
	if opts.Settle <= 0 {
		opts.Settle = DefaultSettle
	}
	if opts.Queue <= 0 {
		opts.Queue = DefaultQueue
	}
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	s := &Service{opts: opts, change: make(chan struct{}, 1), kick: make(chan struct{}, 1),
		queue: make(chan job, opts.Queue), set: DefaultSettings(), tr: newTracker(opts.Settle), rp: newReplies()}
	if opts.Store != nil {
		st, ok, err := opts.Store.LoadNotifySettings(ctx)
		if err != nil {
			return nil, err
		}
		if ok {
			s.set = st
		}
	}
	opts.Channel.Listen(s.set.Replies) // #13
	return s, nil
}

// Changes signals (coalesced) that the View changed.
func (s *Service) Changes() <-chan struct{} { return s.change }

func (s *Service) signal() {
	select {
	case s.change <- struct{}{}:
	default:
	}
}

func (s *Service) now() time.Time { return s.opts.Clock.Now() }

func (s *Service) enabledLocked() bool {
	if e := s.opts.EnvEnabled; e != nil {
		return *e
	}
	return s.set.Enabled
}

func (s *Service) testedLocked(fp string) bool {
	p := s.passed
	return p != nil && p.fp == fp && s.now().Sub(p.at) <= testValidity
}

// View is the current state.
func (s *Service) View() View {
	ch := s.opts.Channel.State()
	ready := s.opts.Channel.Ready()
	fp := s.opts.Channel.Fingerprint()
	s.mu.Lock()
	defer s.mu.Unlock()
	v := View{Enabled: s.enabledLocked(), Env: []string{}, Tested: ready && s.testedLocked(fp),
		Events: Events{NeedsYou: s.set.NeedsYou, Done: s.set.Done}, Quiet: s.set.Quiet, Freelancers: s.set.Freelancers,
		Replies: s.set.Replies, Channel: ch, Dropped: s.dropped.Load()}
	if s.opts.EnvEnabled != nil {
		v.Env = append(v.Env, "enabled")
	}
	if ch.KeyEnv {
		v.Env = append(v.Env, "token")
	}
	if !ch.KeySet {
		v.Missing = append(v.Missing, "token")
	}
	if ch.Paired == nil {
		v.Missing = append(v.Missing, "recipient")
	}
	if s.last != nil {
		l := *s.last
		v.LastError = &l
	}
	switch {
	case !v.Enabled:
		v.State = StateOff
	case !ready:
		v.State = StateIncomplete
	case s.last != nil && (s.last.Code == CodeBlocked || s.last.Code == CodeUnauthorized):
		v.State = StateBlocked
	default:
		v.State = StateReady
	}
	return v
}

// allowed reports whether an alert of kind may go now: switched on, the
// channel ready, its event on.
func (s *Service) allowed(k Kind) bool {
	if !s.opts.Channel.Ready() {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.enabledLocked() {
		return false
	}
	if k == KindDone {
		return s.set.Done
	}
	return s.set.NeedsYou
}

func (s *Service) freelancers() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.set.Freelancers
}

func (s *Service) quiet() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.set.Quiet
}

// Apply changes the settings (nil: kept). Switching on needs a token, a
// paired recipient and a passing notify.test of both (not under the
// environment's switch, which cannot be changed here).
func (s *Service) Apply(ctx context.Context, u Update) error {
	s.applying.Lock()
	defer s.applying.Unlock()
	ch := s.opts.Channel.State()
	ready := s.opts.Channel.Ready()
	fp := s.opts.Channel.Fingerprint()
	s.mu.Lock()
	next := s.set
	if u.Enabled != nil {
		if e := s.opts.EnvEnabled; e != nil {
			if *u.Enabled != *e {
				s.mu.Unlock()
				return &Error{CodeEnvLocked, "notifications are switched by the bridge environment (HERDR_WORLD_NOTIFY_ENABLED)"}
			}
		} else {
			if *u.Enabled && !s.set.Enabled {
				switch {
				case !ch.KeySet:
					s.mu.Unlock()
					return &Error{CodeNotConfigured, "set the bot token first"}
				case !ready:
					s.mu.Unlock()
					return &Error{CodeNotPaired, "pair your Telegram account first"}
				case !s.testedLocked(fp):
					s.mu.Unlock()
					return &Error{CodeTestRequired, "send a test message first: it must reach you with this bot and account"}
				}
			}
			next.Enabled = *u.Enabled
		}
	}
	// #13: replies need a token and a paired account (no test: nothing is
	// sent to switch them on).
	if u.Replies != nil && *u.Replies && !s.set.Replies {
		switch {
		case !ch.KeySet:
			s.mu.Unlock()
			return &Error{CodeNotConfigured, "set the bot token first"}
		case !ready:
			s.mu.Unlock()
			return &Error{CodeNotPaired, "pair your Telegram account first"}
		}
	}
	for _, f := range []struct {
		v   *bool
		dst *bool
	}{{u.NeedsYou, &next.NeedsYou}, {u.Done, &next.Done}, {u.Quiet, &next.Quiet}, {u.Freelancers, &next.Freelancers},
		{u.Replies, &next.Replies}} {
		if f.v != nil {
			*f.dst = *f.v
		}
	}
	if s.opts.Store != nil {
		if err := s.opts.Store.SaveNotifySettings(ctx, next); err != nil {
			s.mu.Unlock()
			return fmt.Errorf("the settings could not be saved: %w", err)
		}
	}
	listen := next.Replies != s.set.Replies
	if listen && next.Replies {
		s.since = s.now()
	}
	s.set = next
	s.mu.Unlock()
	if listen {
		s.opts.Channel.Listen(next.Replies)
	}
	s.signal()
	return nil
}

// Test sends the test message to the paired recipient now (a user action:
// whatever the switch). A delivery allows switching on for 30 minutes,
// while the token and recipient stay the same.
func (s *Service) Test(ctx context.Context) (*TestResult, error) {
	ch := s.opts.Channel
	if !ch.State().KeySet {
		return nil, &Error{CodeNotConfigured, "set the bot token first"}
	}
	if !ch.Ready() {
		return nil, &Error{CodeNotPaired, "pair your Telegram account first"}
	}
	fp := ch.Fingerprint()
	start := s.now()
	sctx, cancel := context.WithTimeout(ctx, SendTimeout)
	_, err := ch.Send(sctx, Notification{Test: true, Quiet: s.quiet()})
	cancel()
	s.record(err)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.passed = &passedTest{fp: fp, at: s.now()}
	s.mu.Unlock()
	s.signal()
	return &TestResult{OK: true, LatencyMS: max(s.now().Sub(start).Milliseconds(), 0)}, nil
}

// record keeps a delivery's outcome as the last error (nil clears it).
func (s *Service) record(err error) {
	s.mu.Lock()
	prev := s.last
	if err == nil {
		s.last = nil
	} else {
		code := CodeOf(err)
		if code == "" {
			code = CodeFailed
		}
		s.last = &LastError{Code: code, Message: err.Error(), At: s.now().UnixMilli()}
	}
	changed := (prev == nil) != (s.last == nil) || (prev != nil && s.last != nil && prev.Code != s.last.Code)
	s.mu.Unlock()
	if changed {
		s.signal()
	}
}

// The channel's commands, as the settings section uses them.

func (s *Service) SetToken(ctx context.Context, token string) error {
	return s.after(s.opts.Channel.SetToken(ctx, token))
}

func (s *Service) ClearToken() error { return s.after(s.opts.Channel.ClearToken()) }

func (s *Service) StartPairing(ctx context.Context) error {
	return s.after(s.opts.Channel.StartPairing(ctx))
}

func (s *Service) CancelPairing() error { return s.after(s.opts.Channel.CancelPairing()) }

func (s *Service) Unpair() error { return s.after(s.opts.Channel.Unpair()) }

// after forgets the last delivery's error once the channel changed (a new
// token or recipient deserves a new try).
func (s *Service) after(err error) error {
	if err == nil {
		s.mu.Lock()
		s.last = nil
		s.mu.Unlock()
		s.signal()
	}
	return err
}

// Observe hands the loop a look at a worker. It never blocks: past
// MaxObserved waiting it drops the sighting and counts it.
func (s *Service) Observe(o Observation) {
	s.obsMu.Lock()
	full := len(s.obs) >= MaxObserved
	if !full {
		s.obs = append(s.obs, o)
	}
	s.obsMu.Unlock()
	if full {
		s.dropped.Add(1)
		s.warnOnce.Do(func() { s.opts.Log.Warn("notifications: worker sightings dropped (the loop is behind)") })
		return
	}
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Run sends the notifications until ctx is done: the loop over the
// sightings and the done settles, the sender and the channel's own work.
func (s *Service) Run(ctx context.Context) {
	if !s.running.CompareAndSwap(false, true) {
		return
	}
	var wg sync.WaitGroup
	wg.Add(3)
	go func() {
		defer wg.Done()
		s.sender(ctx)
	}()
	go func() {
		defer wg.Done()
		s.replier(ctx)
	}()
	s.mu.Lock()
	listen := s.set.Replies
	s.mu.Unlock()
	go func() {
		defer wg.Done()
		s.opts.Channel.Run(ctx, Hooks{Pair: s.paired, Reply: s.inbound, Listen: listen})
	}()
	defer wg.Wait()
	var timer Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		s.process()
		if timer != nil {
			timer.Stop()
			timer = nil
		}
		var wake <-chan time.Time
		if at, ok := s.tr.next(); ok {
			timer = s.opts.Clock.NewTimer(at.Sub(s.now()))
			wake = timer.C()
		}
		select {
		case <-ctx.Done():
			return
		case <-s.kick:
		case <-wake:
		case <-s.opts.Channel.Changes():
			s.signal()
		}
	}
}

// process takes the waiting sightings and the settled done episodes.
func (s *Service) process() {
	s.obsMu.Lock()
	obs := s.obs
	s.obs = nil
	s.obsMu.Unlock()
	now := s.now()
	freelancers := s.freelancers()
	for _, o := range obs {
		if o.Gone {
			s.tr.gone(o.Worker.ID)
			continue
		}
		if a := s.tr.observe(s.sight(o, freelancers), now); a != nil {
			s.enqueue(*a)
		}
	}
	for _, a := range s.tr.due(now) {
		if s.allowed(a.Kind) {
			s.enqueue(a)
		}
	}
}

// sight is what the tracker sees of an observation.
func (s *Service) sight(o Observation, freelancers bool) sighting {
	w := o.Worker
	v := Judge(w)
	latent := v
	if w.Asleep {
		w.Asleep = false
		latent = Judge(w)
	}
	sg := sighting{id: o.Worker.ID}
	switch latent.Display {
	case DisplayNeedsYou:
		sg.kind = KindNeedsYou
	case DisplayDone:
		sg.kind = KindDone
	default:
		return sg
	}
	sg.key = episodeKey(sg.kind, latent.Since)
	sg.eligible = v.Candidate(freelancers) && s.allowed(sg.kind)
	sg.alert = Alert{WorkerID: o.Worker.ID, Kind: sg.kind, Reason: v.Reason, Name: o.Name, Line: o.Line}
	return sg
}

func (s *Service) enqueue(a Alert) {
	select {
	case s.queue <- job{alert: a}:
	default:
		s.dropped.Add(1)
		s.signal()
		s.audit(context.Background(), AuditSend, sendAudit{ID: a.WorkerID, Kind: string(a.Kind)}, errors.New(CodeDropped))
	}
}

func (s *Service) sender(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case j := <-s.queue:
			s.deliver(ctx, j.alert)
		}
	}
}

// sendAudit is a notify.send row's args: whom and why, how it went; never
// the text.
type sendAudit struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Attempts int    `json:"attempts,omitempty"`
	Status   int    `json:"status,omitempty"`
	Code     string `json:"code,omitempty"`
}

// Backoff is the wait after the n-th failed delivery (n from 1): 1 s,
// doubling, at most 30 s.
func Backoff(n int) time.Duration {
	d := backoffBase
	for i := 1; i < n && d < backoffCap; i++ {
		d *= 2
	}
	return min(d, backoffCap)
}

// deliver sends one alert: a few attempts, a rate limit's wait honoured,
// backoff after a network failure or a 5xx; then audited. Switched off
// meanwhile, it is dropped unsent.
func (s *Service) deliver(ctx context.Context, a Alert) {
	n := Notification{WorkerID: a.WorkerID, Name: a.Name, Reason: a.Reason, Line: a.Line, Quiet: s.quiet()}
	row := sendAudit{ID: a.WorkerID, Kind: string(a.Kind)}
	var err error
	var ref Ref
	for row.Attempts < MaxAttempts {
		if !s.allowed(a.Kind) {
			return
		}
		row.Attempts++
		sctx, cancel := context.WithTimeout(ctx, SendTimeout)
		ref, err = s.opts.Channel.Send(sctx, n)
		cancel()
		if err == nil || ctx.Err() != nil {
			break
		}
		var se *SendError
		if !errors.As(err, &se) || !se.Retryable() || row.Attempts >= MaxAttempts {
			break
		}
		wait := Backoff(row.Attempts)
		if se.RetryAfter > 0 {
			if se.RetryAfter > maxRetryAfter {
				break
			}
			wait = se.RetryAfter
		}
		if Sleep(ctx, s.opts.Clock, wait) != nil {
			break
		}
	}
	if ctx.Err() != nil && err != nil {
		return // shutting down
	}
	s.record(err)
	var aerr error
	if err != nil {
		var se *SendError
		if errors.As(err, &se) {
			row.Status = se.Status
		}
		row.Code = CodeOf(err)
		if row.Code == "" {
			row.Code = CodeFailed
		}
		aerr = errors.New(row.Code)
		s.opts.Log.Warn("notification not delivered", "worker", a.WorkerID, "kind", a.Kind, "attempts", row.Attempts, "code", row.Code, "status", row.Status)
	} else {
		s.opts.Log.Info("notification sent", "worker", a.WorkerID, "kind", a.Kind, "attempts", row.Attempts)
		s.remember(ctx, ref, a.WorkerID)
	}
	s.audit(ctx, AuditSend, row, aerr)
}

// pairAudit is a notify.pair row's args: how it ended; no code, no id.
type pairAudit struct {
	Outcome string `json:"outcome"`
	Ignored int    `json:"ignored,omitempty"`
	Errors  int    `json:"errors,omitempty"`
	Status  int    `json:"status,omitempty"`
}

func (s *Service) paired(r PairResult) {
	var err error
	if r.Outcome != PairedOK && r.Outcome != PairCancelled {
		err = errors.New(r.Outcome)
	}
	s.audit(context.Background(), AuditPair, pairAudit{r.Outcome, r.Ignored, r.Errors, r.Status}, err)
	s.signal()
}

func (s *Service) audit(ctx context.Context, cmd string, args any, err error) {
	if s.opts.Audit == nil {
		return
	}
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	s.opts.Audit(actx, cmd, args, err)
}
