package limits

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"

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
	// fallback ("": none).
	CodexSessions string
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

// providerState is what the poller keeps of one provider.
type providerState struct {
	next     time.Time
	failures int
	// again is a manual refresh asked for after the read in flight began
	// (step clears it as a read starts): that read may predate the request,
	// so when it ends the provider is due at once instead of at next.
	again bool
	last  *proto.Limits // the last fresh reading
}

// Poller reads the Claude and Codex limits while somebody looks.
type Poller struct {
	cfg  Config
	kick chan struct{}

	mu         sync.Mutex
	state      map[string]*providerState
	lastManual time.Time
}

// providers in the order they are read and shown.
var providers = []string{proto.LimitsClaude, proto.LimitsCodex}

// New makes a Poller.
func New(cfg Config) *Poller {
	cfg.defaults()
	p := &Poller{cfg: cfg, kick: make(chan struct{}, 1), state: map[string]*providerState{}}
	for _, name := range providers {
		p.state[name] = &providerState{}
	}
	return p
}

// Run reads the limits of every provider that is due, as long as active
// says a client is connected, and hands each reading to publish, until ctx
// is done.
func (p *Poller) Run(ctx context.Context, active func() bool, publish func(proto.Limits)) {
	t := time.NewTicker(p.cfg.Tick)
	defer t.Stop()
	for {
		if active() {
			for _, l := range p.step(ctx, p.cfg.Now()) {
				publish(l)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-p.kick:
		}
	}
}

// Refresh makes every provider due now, unless the last refresh was less
// than ManualMin ago (queued is then false).
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
	select {
	case p.kick <- struct{}{}:
	default:
	}
	return true
}

// step reads the providers that are due at now, at the same time, and
// returns the readings in provider order.
func (p *Poller) step(ctx context.Context, now time.Time) []proto.Limits {
	var due []string
	p.mu.Lock()
	for _, name := range providers {
		if st := p.state[name]; !now.Before(st.next) {
			st.next = now.Add(p.cfg.Timeout + p.cfg.Grace + time.Second) // not due again while this read runs
			st.again = false
			due = append(due, name)
		}
	}
	p.mu.Unlock()
	if len(due) == 0 {
		return nil
	}
	out := make([]proto.Limits, len(due))
	var wg sync.WaitGroup
	for i, name := range due {
		wg.Add(1)
		go func() {
			defer wg.Done()
			out[i] = p.read(ctx, name, now)
		}()
	}
	wg.Wait()
	if ctx.Err() != nil {
		return nil
	}
	return out
}

// read probes one provider and works out what to show and when to look
// again.
func (p *Poller) read(ctx context.Context, name string, now time.Time) proto.Limits {
	var l proto.Limits
	var err error
	if name == proto.LimitsClaude {
		l, err = p.cfg.probeClaude(ctx)
	} else {
		l, err = p.cfg.probeCodex(ctx)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	st := p.state[name]
	defer func() { // a refresh that came in while the probe ran wants a read that began after it
		if st.again {
			st.next = time.Time{}
		}
	}()
	l.Provider = name
	if l.Windows == nil {
		l.Windows = []proto.LimitWindow{}
	}
	switch {
	case err == nil:
		st.failures, st.next = 0, now.Add(p.cfg.Interval)
		l.Stale, l.Error = false, ""
		st.last = &l
		return l
	case errors.Is(err, errNoPlan):
		st.failures, st.next, st.last = 0, now.Add(p.cfg.NoPlanRetry), nil
		l.Windows, l.Error, l.Stale = []proto.LimitWindow{}, proto.LimitsNoPlan, false
		return l
	case errors.Is(err, errNotInstalled):
		st.failures, st.next = 0, now.Add(p.cfg.NoPlanRetry)
		return p.failed(name, proto.LimitsNotInstalled, now, name == proto.LimitsCodex) // the rollouts may still say something
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
	p.cfg.Log.Log(ctx, logLevel(st.failures, p.cfg.Failures), "limits probe failed", "provider", name, "error", err,
		"failures", st.failures, "next", st.next)
	return p.failed(name, code, now, name == proto.LimitsCodex)
}

func logLevel(failures, limit int) slog.Level {
	if failures == limit {
		return slog.LevelWarn
	}
	return slog.LevelDebug
}

// failed is what shows when a probe did not answer: for Codex, the last
// rate_limits a rollout recorded (marked with its time) when it is newer
// than the reading before; else that reading, if any; else the error alone. Called with p.mu held.
func (p *Poller) failed(name, code string, now time.Time, transcript bool) proto.Limits {
	last := p.state[name].last
	if transcript {
		if l, ok := p.cfg.fromTranscript(); ok && (last == nil || l.At > last.At) {
			l.Error = code
			return l
		}
	}
	if last != nil {
		l := *last
		l.Stale, l.Error = true, code
		return l
	}
	return proto.Limits{Provider: name, Windows: []proto.LimitWindow{}, At: now.UnixMilli(), Stale: true, Error: code}
}
