package limits

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Defaults of Config.
const (
	DefaultInterval    = 2 * time.Minute  // between two reads while a client is connected
	DefaultManualMin   = 20 * time.Second // the least time between two manual refreshes
	DefaultBackoff     = 10 * time.Minute // between reads after DefaultFailures failures in a row
	DefaultNoPlanRetry = 30 * time.Minute // between reads of a provider with no plan (or no CLI)
	DefaultFailures    = 3
	DefaultTimeout     = 30 * time.Second // how long a probe waits for its answer
	DefaultGrace       = 10 * time.Second // how long a probe's process has to exit before it is killed
	DefaultTick        = time.Second      // how often the poller looks for a provider that is due
)

// Config configures a Poller. Zero values are the defaults.
type Config struct {
	// ClaudeBin and CodexBin are the executables ("" : claude, codex).
	ClaudeBin, CodexBin string
	// CodexSessions is the Codex rollout directory of the transcript
	// fallback of the bridge's own Codex home ("": none).
	CodexSessions string
	// Accounts lists the Codex profiles (#138): each visible one is read
	// with its own CODEX_HOME, one after the other, and its transcript
	// fallback reads its own <home>/sessions (the default profile's is
	// CodexSessions). nil: Codex is read once, in the bridge's environment
	// as it is, and its readings carry no account.
	Accounts codexaccount.Lister
	// Runner starts the probes (default ExecRunner), Env is the environment
	// they start from (default os.Environ, before probeEnv), Now the clock.
	Runner Runner
	Env    func() []string
	Now    func() time.Time
	Log    *slog.Logger

	Interval, ManualMin, Backoff, NoPlanRetry time.Duration
	// Failures is how many failures in a row put a provider on Backoff.
	Failures       int
	Timeout, Grace time.Duration
	Tick           time.Duration
}

func (c *Config) defaults() {
	if c.ClaudeBin == "" {
		c.ClaudeBin = "claude"
	}
	if c.CodexBin == "" {
		c.CodexBin = "codex"
	}
	if c.Runner == nil {
		c.Runner = ExecRunner{}
	}
	if c.Env == nil {
		c.Env = os.Environ
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Log == nil {
		c.Log = slog.Default()
	}
	for p, d := range map[*time.Duration]time.Duration{&c.Interval: DefaultInterval, &c.ManualMin: DefaultManualMin,
		&c.Backoff: DefaultBackoff, &c.NoPlanRetry: DefaultNoPlanRetry, &c.Timeout: DefaultTimeout, &c.Grace: DefaultGrace,
		&c.Tick: DefaultTick} {
		if *p <= 0 {
			*p = d
		}
	}
	if c.Failures <= 0 {
		c.Failures = DefaultFailures
	}
}

func (c *Config) timing() timing { return timing{Timeout: c.Timeout, Grace: c.Grace} }

// providerState is what the poller keeps of one reading: Claude's, or one
// Codex profile's.
type providerState struct {
	next     time.Time
	failures int
	// again is a manual refresh asked for after the read in flight began
	// (read clears it as it starts): that read may predate the request,
	// so when it ends the reading is due at once instead of at next.
	again bool
	last  *proto.Limits // the last fresh reading
	// home is the Codex profile's folder. Should its key name another
	// folder in a later list (codexaccount keys are a folder's alone, so
	// only by a fluke), the state starts afresh rather than carry over.
	home string
}

// target is one thing to read: Claude, or a Codex profile (acct nil: the
// bridge's environment as it is, Config.Accounts being nil).
type target struct {
	provider string
	acct     *codexaccount.Account
}

// key is the target's state key: the provider, and a Codex profile's key.
func (t target) key() string {
	if t.acct == nil {
		return t.provider
	}
	return t.provider + "/" + t.acct.Key
}

// home is a Codex profile's folder ("": not a profile).
func (t target) home() string {
	if t.acct == nil {
		return ""
	}
	return t.acct.Home
}

// Poller reads the Claude and Codex limits while somebody looks.
type Poller struct {
	cfg  Config
	kick chan struct{}

	mu         sync.Mutex
	state      map[string]*providerState // by target key
	lastManual time.Time
	// The Codex profiles as last listed (hidden ones included), and when
	// to list them again: every Interval, on a refresh, and on Relist.
	// relist counts the requests, listedAt is the count the list was taken
	// at: a request made while the profiles are being listed (the settings
	// may have changed after that list read them) lists them again.
	accounts []codexaccount.Account
	listed   bool
	listNext time.Time
	relist   uint64
	listedAt uint64
}

// providers in the order they are read and shown.
var providers = []string{proto.LimitsClaude, proto.LimitsCodex}

// New makes a Poller.
func New(cfg Config) *Poller {
	cfg.defaults()
	p := &Poller{cfg: cfg, kick: make(chan struct{}, 1), state: map[string]*providerState{}}
	for _, t := range p.targets() {
		p.state[t.key()] = &providerState{}
	}
	return p
}

// Run reads the limits of everything that is due, as long as active says a
// client is connected, and hands each reading to publish as it comes, until
// ctx is done. Codex profiles are listed only then too; accounts (may be
// nil) gets the list whenever it is not the one before.
func (p *Poller) Run(ctx context.Context, active func() bool, publish func(proto.Limits), accounts func([]codexaccount.Account)) {
	t := time.NewTicker(p.cfg.Tick)
	defer t.Stop()
	for {
		if active() {
			p.poll(ctx, p.cfg.Now(), active, func(_ int, l proto.Limits) { publish(l) }, accounts)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.kick:
		}
	}
}

// Refresh makes every reading due now and lists the Codex profiles again,
// unless the last refresh was less than ManualMin ago (queued is then
// false).
func (p *Poller) Refresh() (queued bool) {
	now := p.cfg.Now()
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.lastManual.IsZero() && now.Sub(p.lastManual) < p.cfg.ManualMin && !now.Before(p.lastManual) {
		return false
	}
	p.lastManual = now
	for _, st := range p.state {
		st.next, st.again = time.Time{}, true
	}
	p.relist++
	p.wake()
	return true
}

// Relist lists the Codex profiles again at the next poll (their settings
// changed): a profile shown again or added is read then, a hidden one is
// no longer. Not throttled; still only while a client is connected.
func (p *Poller) Relist() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.relist++
	p.wake()
}

func (p *Poller) wake() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

// targets are what is read, in display order: Claude, then every visible
// Codex profile (the default first) that is there to be read. Called with
// p.mu held, or before the poller is shared.
func (p *Poller) targets() []target {
	out := []target{{provider: proto.LimitsClaude}}
	if p.cfg.Accounts == nil {
		return append(out, target{provider: proto.LimitsCodex})
	}
	for i := range p.accounts {
		a := &p.accounts[i]
		if a.Hidden || (!a.Exists && !a.Default) { // a missing added folder: listed, not read
			continue
		}
		out = append(out, target{provider: proto.LimitsCodex, acct: a})
	}
	return out
}

// listAccounts lists the Codex profiles when it is time to, and keeps a
// state for each target and none for anything else. It returns the list
// when it is not the one before.
func (p *Poller) listAccounts(ctx context.Context, now time.Time) ([]codexaccount.Account, bool) {
	if p.cfg.Accounts == nil {
		return nil, false
	}
	p.mu.Lock()
	gen := p.relist
	due := !p.listed || gen != p.listedAt || !now.Before(p.listNext)
	p.mu.Unlock()
	if !due {
		return nil, false
	}
	list, err := p.cfg.Accounts.Accounts(ctx)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.listedAt, p.listNext = gen, now.Add(p.cfg.Interval)
	if err != nil {
		p.cfg.Log.Warn("limits: cannot list the Codex profiles", "error", err)
		return nil, false
	}
	changed := !p.listed || !slices.Equal(list, p.accounts)
	p.accounts, p.listed = list, true
	keep := map[string]bool{}
	for _, t := range p.targets() {
		keep[t.key()] = true
		if st := p.state[t.key()]; st == nil || st.home != t.home() {
			p.state[t.key()] = &providerState{home: t.home()} // due at once
		}
	}
	for k := range p.state {
		if !keep[k] {
			delete(p.state, k)
		}
	}
	if !changed {
		return nil, false
	}
	return slices.Clone(list), true
}

// step reads what is due at now and returns the readings in display order.
func (p *Poller) step(ctx context.Context, now time.Time) []proto.Limits {
	var mu sync.Mutex
	got := map[int]proto.Limits{}
	n := p.poll(ctx, now, func() bool { return true }, func(i int, l proto.Limits) {
		mu.Lock()
		got[i] = l
		mu.Unlock()
	}, nil)
	var out []proto.Limits
	for i := range n {
		if l, ok := got[i]; ok {
			out = append(out, l)
		}
	}
	return out
}

// poll lists the Codex profiles when due (accounts gets a changed list),
// then reads what is due at now: Claude beside the Codex profiles, the
// profiles one after the other. Each reading goes to emit with its place in
// display order as soon as it is taken (none once ctx is done). A read
// still queued when active says nobody is connected any more is not
// started: it stays due, for when a client is back. It returns how many
// reads were due.
func (p *Poller) poll(ctx context.Context, now time.Time, active func() bool, emit func(int, proto.Limits), accounts func([]codexaccount.Account)) int {
	if list, changed := p.listAccounts(ctx, now); changed && accounts != nil {
		accounts(list)
	}
	var due []target
	p.mu.Lock()
	for _, t := range p.targets() {
		if st := p.state[t.key()]; st != nil && !now.Before(st.next) {
			// Not due again while this poll runs (the profiles are read in turn).
			st.next = now.Add(p.cfg.Timeout + p.cfg.Grace + time.Second)
			due = append(due, t)
		}
	}
	p.mu.Unlock()
	byProvider := map[string][]int{}
	for i, t := range due {
		byProvider[t.provider] = append(byProvider[t.provider], i)
	}
	var wg sync.WaitGroup
	for _, idx := range byProvider {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for n, i := range idx {
				if !active() {
					p.undue(due, idx[n:])
					return
				}
				l := p.read(ctx, due[i], now)
				if ctx.Err() != nil {
					return
				}
				emit(i, l)
			}
		}()
	}
	wg.Wait()
	return len(due)
}

// undue makes the targets due[idx] due again, now that they will not be
// read in this poll.
func (p *Poller) undue(due []target, idx []int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, i := range idx {
		if st := p.state[due[i].key()]; st != nil {
			st.next = time.Time{}
		}
	}
}

// read probes one target and works out what to show and when to look
// again.
func (p *Poller) read(ctx context.Context, t target, now time.Time) proto.Limits {
	p.mu.Lock()
	st := p.state[t.key()]
	if st == nil { // listed away meanwhile: kept apart until done
		st = &providerState{}
	}
	st.again = false
	p.mu.Unlock()
	var l proto.Limits
	var err error
	if t.provider == proto.LimitsClaude {
		l, err = p.cfg.probeClaude(ctx)
	} else {
		l, err = p.cfg.probeCodex(ctx, t.acct)
		if err != nil && t.acct != nil && t.acct.Exists && !t.acct.SignedIn && !errors.Is(err, errNotInstalled) && !errors.Is(err, errTimeout) {
			err = errNoPlan // a home with no auth.json that does not answer is not signed in
		}
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	defer func() { // a refresh that came in while the probe ran wants a read that began after it
		if st.again {
			st.next = time.Time{}
		}
	}()
	l = p.settle(ctx, t, st, l, err, now)
	l.Provider = t.provider
	if a := t.acct; a != nil {
		l.Account = &proto.LimitsAccount{Key: a.Key, Name: a.Name, Plan: l.Plan, Default: a.Default}
	}
	return l
}

// settle is what a probe's result shows, and when the target is due again.
// Called with p.mu held.
func (p *Poller) settle(ctx context.Context, t target, st *providerState, l proto.Limits, err error, now time.Time) proto.Limits {
	if l.Windows == nil {
		l.Windows = []proto.LimitWindow{}
	}
	codex := t.provider == proto.LimitsCodex
	switch {
	case err == nil:
		st.failures, st.next = 0, now.Add(p.cfg.Interval)
		l.Stale, l.Error = false, ""
		st.last = &l
		return l
	case errors.Is(err, errNoPlan):
		st.failures, st.next, st.last = 0, now.Add(p.cfg.NoPlanRetry), nil
		l.Windows, l.Error, l.Stale = []proto.LimitWindow{}, proto.LimitsNoPlan, false
		if l.At == 0 {
			l.At = now.UnixMilli()
		}
		return l
	case errors.Is(err, errNotInstalled):
		st.failures, st.next = 0, now.Add(p.cfg.NoPlanRetry)
		return p.failed(t, st, proto.LimitsNotInstalled, now, codex) // the rollouts may still say something
	}
	code := proto.LimitsFailed
	if errors.Is(err, errTimeout) {
		code = proto.LimitsTimeout
	}
	st.failures++
	st.next = now.Add(p.cfg.Interval)
	if st.failures >= p.cfg.Failures {
		st.next = now.Add(p.cfg.Backoff)
	}
	args := []any{"provider", t.provider, "error", err, "failures", st.failures, "next", st.next}
	if t.acct != nil {
		args = append(args, "profile", t.acct.Key)
	}
	p.cfg.Log.Log(ctx, logLevel(st.failures, p.cfg.Failures), "limits probe failed", args...)
	return p.failed(t, st, code, now, codex)
}

func logLevel(failures, limit int) slog.Level {
	if failures == limit {
		return slog.LevelWarn
	}
	return slog.LevelDebug
}

// sessions is the rollout directory of a Codex target's transcript
// fallback: the default profile's is the configured one, another's its own.
func (p *Poller) sessions(t target) string {
	if t.acct == nil || t.acct.Default {
		return p.cfg.CodexSessions
	}
	return filepath.Join(t.acct.Home, "sessions")
}

// failed is what shows when a probe did not answer: for Codex, the last
// rate_limits one of the profile's rollouts recorded (marked with its time)
// when it is newer than the reading before; else that reading, if any; else
// the error alone. Called with p.mu held.
func (p *Poller) failed(t target, st *providerState, code string, now time.Time, transcript bool) proto.Limits {
	last := st.last
	if transcript {
		if l, ok := fromTranscript(p.sessions(t)); ok && (last == nil || l.At > last.At) {
			l.Error = code
			return l
		}
	}
	if last != nil {
		l := *last
		l.Stale, l.Error = true, code
		return l
	}
	return proto.Limits{Provider: t.provider, Windows: []proto.LimitWindow{}, At: now.UnixMilli(), Stale: true, Error: code}
}
