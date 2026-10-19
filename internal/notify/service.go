package notify

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
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
	// #14: a tap on a card, and an answer of the cards handed to the hub.
	AuditTap    = "notify.tap"
	AuditAnswer = "notify.answer"
	// #106: how a menu's card ended, and where its identity was from; an
	// alert or card set the send budget parked, and how it ended.
	AuditMenu  = "notify.menu"
	AuditLimit = "notify.limit"
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
	// Mode (H3D-1) is ModeEverything or ModeQuestions ("": everything).
	Mode string
}

// DefaultSettings: off, both events, with sound, no freelancers, no
// replies, everything that needs you.
func DefaultSettings() Settings { return Settings{NeedsYou: true, Done: true, Mode: ModeEverything} }

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
	// Answer (#14) answers a worker's ask or follow-up with what was tapped
	// on its cards, as the game does (the hub's worker.answer_ask or
	// worker.answer_followup: its checks, the worker's input lane). An error
	// refuses it at once; else done is called once, when the lane is done.
	// A *ReplyError says why (ReplyClosed: no longer the worker's). Nil: the
	// cards' answers are refused.
	Answer func(ctx context.Context, a Answer, done func(error)) error
	// Limits is the outbound budget (#106; zero fields: DefaultLimits').
	Limits Limits
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
	Replies bool `json:"replies"`
	// Mode (H3D-1): ModeEverything or ModeQuestions.
	Mode      string       `json:"mode"`
	Channel   ChannelState `json:"channel"`
	LastError *LastError   `json:"last_error,omitempty"`
	// Dropped counts the alerts and sightings dropped since the bridge
	// started (a full queue).
	Dropped int64 `json:"dropped,omitempty"`
}

// Update is a change of the settings: a nil field is kept.
type Update struct {
	Enabled, NeedsYou, Done, Quiet, Freelancers, Replies *bool
	// Mode (H3D-1): ModeEverything or ModeQuestions.
	Mode *string
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

// look is what the loop last told the replier of a worker: what it asks
// (questionKey), the blocked spell it is in (#106; 0: none), its menu's
// look ("": none) and (H3D-1) its menu's episode ("": its blocked
// spell's).
type look struct {
	key     string
	blocked int64
	menu    string
	ep      string
}

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
	bt buttons // #14: the replier's too
	// keys is what each worker asks now, as the loop last told the replier
	// (the loop's).
	keys map[string]look

	obsMu sync.Mutex
	obs   []Observation
	// back is the questions handed back to the loop (H3D-1: handBack).
	back    []Alert
	dropped atomic.Int64
	tr      *tracker // the loop's
	// H3D-1, the loop's: each worker's menu episodes by decision
	// (menuEpisode), and the menu episode of its that notified last.
	menuEps  map[string]map[string]menuEp
	rung     map[string]string
	running  atomic.Bool
	warnOnce sync.Once

	// #106: the send budget, and the alerts it parked (the loop's).
	lim    *limiter
	parked map[string]*parked
	// episodes is each worker's episode as the loop last saw it (#106: an
	// alert in the queue or between attempts goes only while it is on).
	epMu     sync.Mutex
	episodes map[string]string
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
		queue: make(chan job, opts.Queue), set: DefaultSettings(), tr: newTracker(opts.Settle), rp: newReplies(),
		bt: newButtons(), keys: map[string]look{}, lim: newLimiter(opts.Limits.withDefaults(), opts.Clock), parked: map[string]*parked{},
		episodes: map[string]string{}, menuEps: map[string]map[string]menuEp{}, rung: map[string]string{}}
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
		Replies: s.set.Replies, Mode: s.modeLocked(), Channel: ch, Dropped: s.dropped.Load()}
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
// channel ready, its event on (H3D-1: done never under Questions only).
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
		return s.set.Done && s.modeLocked() != ModeQuestions
	}
	return s.set.NeedsYou
}

// admits reports whether alert a may go now: allowed, and (H3D-1) a
// question under Questions only. Checked again wherever an alert waited (a
// parked one's release, each delivery), so a mode changed meanwhile holds.
func (s *Service) admits(a Alert) bool {
	return s.allowed(a.Kind) && (a.Question || !s.questionsOnly())
}

func (s *Service) modeLocked() string {
	if s.set.Mode == ModeQuestions {
		return ModeQuestions
	}
	return ModeEverything
}

// questionsOnly: the mode is ModeQuestions (H3D-1).
func (s *Service) questionsOnly() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.modeLocked() == ModeQuestions
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
	if m := u.Mode; m != nil && *m != ModeEverything && *m != ModeQuestions {
		s.mu.Unlock()
		return &Error{CodeBadRequest, fmt.Sprintf("mode must be %q or %q", ModeEverything, ModeQuestions)}
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
	if u.Mode != nil {
		next.Mode = *u.Mode
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
		if !next.Replies {
			s.job(s.repliesOff) // #14: no tap is read any more
		}
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
		s.opts.Channel.Run(ctx, Hooks{Pair: s.paired, Reply: s.inbound, Tap: s.tapped, Listen: listen})
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
		at, ok := s.tr.next()
		if p, parked := due(s.parked); parked && (!ok || p.Before(at)) {
			at, ok = p, true
		}
		if ok {
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

// process takes the waiting sightings, the questions handed back and the
// settled done episodes.
func (s *Service) process() {
	s.obsMu.Lock()
	obs, back := s.obs, s.back
	s.obs, s.back = nil, nil
	s.obsMu.Unlock()
	now := s.now()
	freelancers, questions := s.freelancers(), s.questionsOnly()
	for _, o := range obs {
		id := o.Worker.ID
		var sg sighting
		if !o.Gone {
			sg = s.sight(o, freelancers, questions)
		}
		// #14: what the worker asks now, for its cards (a change only).
		// #88: a menu's with what its card shows. #106: and the blocked
		// spell it is in, and its menu's look (a redraw of one operation).
		var l look
		var menu *menuSeen
		if !o.Gone {
			l.key, menu, l.blocked = questionKey(o.Worker), menuOf(o), blockedSpell(o)
			if menu != nil {
				if sg.alert.About == aboutMenu {
					menu.ep = sg.key
				}
				l.menu, l.ep = fmt.Sprintf("%#v", *menu.menu), menu.ep
			}
		}
		changed := s.keys[id] != l
		if changed {
			if l == (look{}) {
				delete(s.keys, id)
			} else {
				s.keys[id] = l
			}
			key, blocked := l.key, l.blocked
			s.job(func(ctx context.Context) { s.seen(ctx, id, key, menu, blocked) })
		}
		if o.Gone {
			s.tr.gone(o.Worker.ID)
			delete(s.menuEps, id)
			delete(s.rung, id)
			s.publish(id)
			continue
		}
		if r := o.Worker.Report; r != nil && r.Resolved && r.InputRequired != nil {
			s.tr.reopen(id, episodeKey(KindNeedsYou, reportID(r))) // H3D-1: asked again, it is new
		}
		a := s.tr.observe(sg, now)
		s.publish(id)
		switch {
		case a != nil:
			s.alert(*a)
		case changed && sg.eligible && sg.alert.About == aboutMenu && s.rung[id] == sg.key:
			// H3D-1: a menu episode that notified, seen again in another
			// look (a status flip: another blocked spell) sends nothing
			// new; its card comes back, silent, if that spell has none.
			r := sg.alert
			s.job(func(ctx context.Context) { s.rang(ctx, r) })
		}
	}
	for _, a := range back {
		if a.Key == "" || s.tr.current(a.WorkerID) != a.Key {
			row := a.sendRow() // its episode ended while it waited, as deliver's
			row.Code = CodeObsolete
			s.audit(context.Background(), AuditSend, row, errors.New(CodeObsolete))
			continue
		}
		s.alert(a)
	}
	for _, a := range s.tr.due(now) {
		if s.admits(a) {
			s.alert(a)
		}
	}
	s.release(now)
}

// handBack has the loop take back a question that waited to go as its
// cards and can no longer (H3D-1: replies or the mode changed meanwhile):
// it goes as the settings say now (form), if its episode is still on.
func (s *Service) handBack(a Alert) {
	s.obsMu.Lock()
	s.back = append(s.back, a)
	s.obsMu.Unlock()
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// publish shares worker id's episode, as the tracker has it now, with the
// sender (#106).
func (s *Service) publish(id string) {
	cur := s.tr.current(id)
	s.epMu.Lock()
	if cur == "" {
		delete(s.episodes, id)
	} else {
		s.episodes[id] = cur
	}
	s.epMu.Unlock()
}

// current reports whether a's episode is its worker's, as the loop last
// saw it (#106).
func (s *Service) current(a Alert) bool {
	s.epMu.Lock()
	defer s.epMu.Unlock()
	return s.episodes[a.WorkerID] == a.Key
}

// alert sends a, or parks it while its worker's cooldown or the
// destination's budget is spent (#106: the latest of a worker's wins). A
// needs-you alert parked by the cooldown still opens its cards: they draw
// on the budget, not on the alert's cooldown. H3D-1: a Questions only
// question goes as its cards alone while it can have them (the first
// rings; the cards' budget, not the alert's cooldown), else as its text
// (form).
func (s *Service) alert(a Alert) {
	a = s.form(a)
	if !s.admits(a) {
		return
	}
	if a.About == aboutMenu {
		s.rung[a.WorkerID] = a.Key
	}
	if a.Ring {
		s.cardsOf(a)
		return
	}
	ok, at, cause := s.lim.admitAlert(a.WorkerID)
	if ok {
		s.enqueue(a)
		return
	}
	park(s.parked, a, at, cause)
	s.opts.Log.Debug("notifications: an alert waits for its budget", "worker", a.WorkerID, "kind", a.Kind, "cause", cause)
	if cause == causeCooldown && a.Kind == KindNeedsYou && a.Body == "" {
		s.cardsOf(a)
	}
}

// cardsOf has the replier open what an alert that went (or would have)
// comes with: an ask's or follow-up's cards, a menu's once its screen is
// read (#88). H3D-1: a Ring alert's (its cards are the message) only if
// they still may be when the replier gets to them (rings).
func (s *Service) cardsOf(a Alert) {
	switch {
	case a.Ask != nil || a.Followup != nil:
		s.job(func(ctx context.Context) { // #14
			if ok, _ := s.rings(a); ok {
				s.openCards(ctx, a)
			}
		})
	case a.Kind == KindNeedsYou:
		s.job(func(ctx context.Context) { // #88
			if ok, _ := s.rings(a); ok {
				s.rang(ctx, a)
			}
		})
	}
}

// goes decides whether alert a, formed before it waited, may go now as it
// is (H3D-1): it is asked at the last moment before each send of its
// message (its text or alert, each of its cards), after every wait. Not
// admitted now (switched off, its event off, the channel not ready, not a
// question under Questions only), it is dropped; formed otherwise now
// (replies or the mode changed), it goes back to the loop (back), the
// tracker's own alert only (tracked: the one question is formed again
// once; a card the replier opened of itself is dropped, its episode's
// alert goes).
func (s *Service) goes(a Alert) (ok, back bool) {
	f := s.form(a)
	switch {
	case !s.admits(f):
		return false, false
	case f.Ring != a.Ring || f.Question != a.Question || f.Body != a.Body:
		return false, a.tracked
	}
	return true, false
}

// rings reports whether alert a's cards may go as it was formed (any
// alert but a Ring one: true). H3D-1: a Ring alert's cards are the
// message (goes; back: handed back to the loop).
func (s *Service) rings(a Alert) (ok, back bool) {
	if !a.Ring {
		return true, false
	}
	if ok, back = s.goes(a); back {
		s.handBack(a)
	}
	return ok, back
}

// release sends the parked alerts whose slot came, if the worker is still
// in their episode (and its event on); else drops them (#106). H3D-1:
// formed again first, so a question goes as the settings say now (its
// cards, or its text with replies' ending as they are).
func (s *Service) release(now time.Time) {
	for id, p := range s.parked {
		if p.at.After(now) {
			continue
		}
		row := limitAudit{ID: id, Kind: "alert", Cause: p.cause, Coalesced: p.coalesced, Outcome: "dropped"}
		a := s.form(p.alert)
		if s.tr.current(id) == a.Key && s.admits(a) {
			if a.About == aboutMenu {
				s.rung[id] = a.Key
			}
			if a.Ring {
				s.cardsOf(a)
			} else {
				ok, at, cause := s.lim.admitAlert(id)
				if !ok {
					p.at, p.cause = at, cause
					continue
				}
				s.enqueue(a)
			}
			row.Outcome = "sent"
		}
		delete(s.parked, id)
		s.audit(context.Background(), AuditLimit, row, nil)
	}
}

// sight is what the tracker sees of an observation (questions: under
// Questions only, H3D-1).
func (s *Service) sight(o Observation, freelancers, questions bool) sighting {
	w := o.Worker
	v := Judge(w)
	latent := v
	if w.Asleep {
		w.Asleep = false
		latent = Judge(w)
	}
	menu := ""
	if validMenu(w) {
		menu = s.menuEpisode(w.ID, w.Menu)
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
	id, about, question := strconv.FormatInt(latent.Since, 10), aboutDone, false
	if sg.kind == KindNeedsYou {
		id, about, question = episode(w, latent, questions, menu)
		sg.live = live(w, latent, menu)
	}
	sg.key = episodeKey(sg.kind, id)
	sg.eligible = v.Candidate(freelancers) && s.allowed(sg.kind) && (question || !questions)
	sg.alert = Alert{WorkerID: o.Worker.ID, Kind: sg.kind, Reason: v.Reason, Name: o.Name, Line: o.Line, Since: latent.Since,
		Key: sg.key, About: about, Asks: question, Question: questions && question, tracked: true}
	switch about {
	case aboutAsk:
		sg.alert.Ask = w.Ask
	case aboutFollowup:
		sg.alert.Followup = w.Followup
	case aboutMenu:
		sg.alert.Menu = w.Menu
	case aboutReport:
		sg.alert.Report = w.Report.Request
	}
	return sg
}

// enqueue hands the sender an alert the budget let in.
func (s *Service) enqueue(a Alert) {
	select {
	case s.queue <- job{alert: a}:
	default:
		s.lim.dropAlert(a.WorkerID)
		s.dropped.Add(1)
		s.signal()
		s.audit(context.Background(), AuditSend, a.sendRow(), errors.New(CodeDropped))
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
// the text. H3D-1: why is the rule's reason and what the episode is about
// (about*); Cards is how many question cards went with it (0: none), Via
// how the message went (via*; "": an alert).
type sendAudit struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Reason   string `json:"reason,omitempty"`
	About    string `json:"about,omitempty"`
	Via      string `json:"via,omitempty"`
	Cards    int    `json:"cards,omitempty"`
	Attempts int    `json:"attempts,omitempty"`
	Status   int    `json:"status,omitempty"`
	Code     string `json:"code,omitempty"`
}

// sendRow is a's notify.send row, before it went.
func (a Alert) sendRow() sendAudit {
	row := sendAudit{ID: a.WorkerID, Kind: string(a.Kind), Reason: a.Reason, About: a.About}
	if a.Body != "" {
		row.Via = viaQuestion
	}
	return row
}

// retryAfter is a rate limit's wait in err (0: none).
func retryAfter(err error) time.Duration {
	var se *SendError
	if errors.As(err, &se) && se.Code == CodeRateLimited {
		return se.RetryAfter
	}
	return 0
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
// meanwhile, it is dropped unsent; (#106) its episode over before an
// attempt (it waited in the queue, for its pace or a rate limit), it is
// dropped too, and audited obsolete. Its budget slot counts from its last
// attempt, or is given back when there was none. H3D-1: whether it goes,
// and how, is decided after its pace, right before each attempt (goes).
func (s *Service) deliver(ctx context.Context, a Alert) {
	row := a.sendRow()
	defer func() {
		if row.Attempts > 0 {
			s.lim.sentAlert(a.WorkerID)
		} else {
			s.lim.dropAlert(a.WorkerID)
		}
	}()
	var err error
	var ref Ref
	for row.Attempts < MaxAttempts {
		if err = s.lim.wait(ctx); err != nil { // #106: the destination's pacing
			break
		}
		if !s.current(a) {
			s.opts.Log.Info("notification dropped: its episode ended before it went", "worker", a.WorkerID, "kind", a.Kind, "attempts", row.Attempts)
			row.Code = CodeObsolete
			s.audit(ctx, AuditSend, row, errors.New(CodeObsolete))
			return
		}
		// H3D-1: the last moment before it goes: a question whose form
		// changed while it waited (the mode, replies) goes back to the loop.
		if ok, back := s.goes(a); !ok {
			if back {
				s.handBack(a)
			}
			return
		}
		// The rest of a card set goes quiet: its first card rang.
		n := Notification{WorkerID: a.WorkerID, Name: a.Name, Reason: a.head(), Line: a.Line, Body: a.Body, Quiet: s.quiet() || a.From > 0}
		row.Attempts++
		sctx, cancel := context.WithTimeout(ctx, SendTimeout)
		ref, err = s.opts.Channel.Send(sctx, n)
		cancel()
		if err == nil || ctx.Err() != nil {
			break
		}
		var se *SendError
		if !errors.As(err, &se) || !se.Retryable() || row.Attempts >= MaxAttempts {
			s.lim.pause(retryAfter(err))
			break
		}
		wait := Backoff(row.Attempts)
		if se.RetryAfter > 0 {
			s.lim.pause(se.RetryAfter)
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
		if a.Kind == KindNeedsYou && a.Body == "" {
			// H3D-1: its row, once its cards had their turn (the replier's,
			// in order).
			s.cardsOf(a)
			sent := row
			s.job(func(ctx context.Context) {
				sent.Cards = s.carded(a)
				s.audit(ctx, AuditSend, sent, nil)
			})
			return
		}
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
