package mcpinv

import (
	"cmp"
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Reader reads one key's configuration (a Failure when it failed as a
// whole); Checker runs one key's connection check.
type (
	Reader  func(ctx context.Context, key Key) (proto.MCPProvider, error)
	Checker func(ctx context.Context, key Key) (CheckResult, error)
)

// Defaults of a Service's Options.
const (
	DefaultFresh      = 15 * time.Second
	DefaultWait       = 10 * time.Second
	DefaultMinBackoff = 30 * time.Second
	DefaultMaxBackoff = 5 * time.Minute
	DefaultCheckEvery = 30 * time.Second
	DefaultMax        = 64
	DefaultConcurrent = 4
)

// Notes of answers that started nothing: the bridge was busy.
const (
	noteBusyRead  = "Other inventory reads are running; this one starts on a later refresh"
	noteBusyCheck = "Other connection checks or reads are running; try again in a moment"
)

// Options configure a Service.
type Options struct {
	Read  map[string]Reader  // by harness
	Check map[string]Checker // by harness
	Log   *slog.Logger
	Now   func() time.Time
	// Fresh is how long a read is answered without another; Wait how long
	// a request waits for a key's first read (then it is pending).
	Fresh, Wait time.Duration
	// A failed read is retried after MinBackoff, doubling up to MaxBackoff.
	MinBackoff, MaxBackoff time.Duration
	// CheckEvery is the least time between two checks of a key.
	CheckEvery time.Duration
	// Max bounds the keys kept, those with a read or check in flight
	// included (the least recently used idle one is dropped first), and
	// the keys checked within CheckEvery.
	Max int
	// Concurrent bounds the reads and checks running at once.
	Concurrent int
}

// Service answers inventories and checks from a bridge-wide cache per Key:
// a fresh read at once; an older one at once while one read refreshes it
// in the background; a first read waited for, up to Wait (then pending: a
// later request gets it). Concurrent requests share one read per key. A
// read whose config or skills half fails keeps that half's last good read,
// marked stale, and the next read waits MinBackoff, doubling to
// MaxBackoff; with none, the half is failed, never an empty success.
// Checks are coalesced per key, at most one per CheckEvery (a request
// inside it answers the last, also after the key was dropped), never
// retried; the last check's statuses stay on the key's later answers. At
// most Max keys are kept and Concurrent reads and checks run: a request
// that cannot start one starts nothing and is answered pending (a read) or
// skipped (a check).
type Service struct {
	ctx     context.Context // the bridge's: a read outlives the request that started it
	o       Options
	wg      sync.WaitGroup
	mu      sync.Mutex
	keys    map[Key]*entry
	recent  map[Key]*checked // the checks of the last CheckEvery, kept apart from keys
	running int              // reads and checks in flight
	tick    uint64
}

type entry struct {
	good *proto.MCPProvider // the last read, each half its last good one (nil: none yet)
	// When each half of good was read (zero: never), and why its latest
	// read failed ("": it did not; good's half is then current).
	cfgAt, skillsAt     time.Time
	cfgFail, skillsFail string
	readAt              time.Time // when the last read that did not fail ended
	failures            int       // failed reads in a row
	retryAt             time.Time // no read before it (backoff)
	reading             chan struct{}

	check    *checked // the last check (kept while the key is)
	checking chan struct{}

	used uint64
}

type checked struct {
	res CheckResult
	at  time.Time
}

// New is a Service whose reads and checks run under ctx (Wait waits for
// them).
func New(ctx context.Context, o Options) *Service {
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&o.Fresh, DefaultFresh)
	def(&o.Wait, DefaultWait)
	def(&o.MinBackoff, DefaultMinBackoff)
	def(&o.MaxBackoff, DefaultMaxBackoff)
	def(&o.CheckEvery, DefaultCheckEvery)
	if o.Max <= 0 {
		o.Max = DefaultMax
	}
	if o.Concurrent <= 0 {
		o.Concurrent = DefaultConcurrent
	}
	return &Service{ctx: ctx, o: o, keys: map[Key]*entry{}, recent: map[Key]*checked{}}
}

// Wait waits for the reads and checks in flight.
func (s *Service) Wait() { s.wg.Wait() }

// Inventory is key's provider as the cache has it, reading it when due.
func (s *Service) Inventory(ctx context.Context, key Key) proto.MCPProvider {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entry(key)
	s.waitFirst(ctx, e)
	return s.answer(e)
}

// Check runs key's connection check, or joins the one in flight, or
// (inside CheckEvery of the last) answers the last; then the provider.
func (s *Service) Check(ctx context.Context, key Key) proto.MCPProvider {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entry(key)
	s.prune()
	busy := e == nil
	if e != nil && e.checking == nil && s.recent[key] == nil {
		if s.running < s.o.Concurrent && len(s.recent) < s.o.Max {
			s.startCheck(key, e)
		} else {
			busy = true
		}
	}
	if wait := e.waitCheck(); wait != nil {
		s.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
		}
		s.mu.Lock()
	}
	s.waitFirst(ctx, e)
	p := s.answer(e)
	if busy { // nothing started: not a check, so it is not the last one either
		p.Check = proto.MCPCheck{State: proto.MCPCheckSkipped, Note: noteBusyCheck}
	}
	return p
}

func (e *entry) waitCheck() chan struct{} {
	if e == nil {
		return nil
	}
	return e.checking
}

// entry is key's entry, its read started when due and Concurrent allows
// (s.mu held); nil when Max keys are kept and each has work in flight.
func (s *Service) entry(key Key) *entry {
	e := s.keys[key]
	if e == nil {
		if len(s.keys) >= s.o.Max && !s.evict(key) {
			return nil
		}
		e = &entry{check: s.recent[key]}
		s.keys[key] = e
	}
	s.tick++
	e.used = s.tick
	now := s.o.Now()
	if e.reading == nil && !now.Before(e.retryAt) && (e.good == nil || now.Sub(e.readAt) > s.o.Fresh) && s.running < s.o.Concurrent {
		s.startRead(key, e)
	}
	return e
}

// waitFirst waits up to Wait for a first read in flight (s.mu held; it is
// released while waiting).
func (s *Service) waitFirst(ctx context.Context, e *entry) {
	if e == nil || e.good != nil || e.reading == nil {
		return
	}
	wait := e.reading
	s.mu.Unlock()
	t := time.NewTimer(s.o.Wait)
	select {
	case <-wait:
	case <-t.C:
	case <-ctx.Done():
	}
	t.Stop()
	s.mu.Lock()
}

// answer is e's provider now (s.mu held); e nil: pending, nothing started.
func (s *Service) answer(e *entry) proto.MCPProvider {
	if e == nil || e.good == nil {
		p := emptyProvider()
		p.Config = proto.MCPRead{State: proto.MCPStatePending, Note: "Reading the configuration"}
		if e == nil || e.reading == nil {
			p.Config.Note = noteBusyRead
		}
		p.Skills.State = proto.MCPStatePending
		if e != nil && e.check != nil {
			applyCheck(&p, e.check.res, e.check.at)
		}
		return p
	}
	p := clone(*e.good)
	p.Config.ReadAt, p.Skills.ReadAt = stamp(e.cfgAt), stamp(e.skillsAt)
	if e.cfgFail != "" {
		p.Config.Stale = true
		p.Config.Note = joinNotes(lastFailed(e.cfgFail, e.cfgAt), p.Config.Note)
	}
	if e.skillsFail != "" {
		p.Skills.Stale = true
		p.Skills.Note = joinNotes(lastFailed(e.skillsFail, e.skillsAt), p.Skills.Note)
	}
	if e.check != nil {
		applyCheck(&p, e.check.res, e.check.at)
	}
	return p
}

// lastFailed is the note of a half whose latest read failed for why and
// that shows the read of at.
func lastFailed(why string, at time.Time) string {
	return "Last read failed: " + why + "; showing the read from " + at.UTC().Format("2006-01-02 15:04:05 UTC")
}

func joinNotes(notes ...string) string {
	var out []string
	for _, n := range notes {
		if n != "" {
			out = append(out, n)
		}
	}
	return strings.Join(out, ". ")
}

// backoff is the wait after n failed reads in a row.
func (s *Service) backoff(n int) time.Duration {
	d := s.o.MinBackoff
	for i := 1; i < n && d < s.o.MaxBackoff; i++ {
		d *= 2
	}
	return min(d, s.o.MaxBackoff)
}

// startRead starts key's read (s.mu held).
func (s *Service) startRead(key Key, e *entry) {
	read := s.o.Read[key.Harness]
	done := make(chan struct{})
	e.reading = done
	s.running++
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		var p proto.MCPProvider
		var err error
		if read == nil {
			err = &Failure{Note: "No inventory for this harness"}
		} else {
			p, err = read(s.ctx, key)
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		now := s.o.Now()
		if failed := e.store(p, err, now); failed != "" {
			e.failures++
			e.retryAt = now.Add(s.backoff(e.failures))
			s.o.Log.Warn("mcp inventory read failed", "harness", key.Harness, "cwd", key.Cwd, "home", key.Home,
				"retry_in", e.retryAt.Sub(now), "why", failed, "err", err)
		} else {
			e.readAt, e.failures, e.retryAt = now, 0, time.Time{}
		}
		e.reading = nil
		s.running--
		close(done)
	}()
}

// rank orders a half's read states by what they show: a later read of a
// lower rank than the kept one failed and does not replace it. States
// without a rank (unavailable, unsupported) are facts and always replace.
func rank(state string) (int, bool) {
	switch state {
	case proto.MCPStateOK:
		return 2, true
	case proto.MCPStatePartial:
		return 1, true
	case proto.MCPStateFailed:
		return 0, true
	}
	return 0, false
}

// store puts a read that ended at now on e, half by half: a half that
// failed (a failed state; partial where the kept half is ok) keeps the
// kept half, its time and rows, marked stale; with none it is shown as
// read. A whole failure (err) fails both halves. failed is why, "" when
// no half failed.
func (e *entry) store(p proto.MCPProvider, err error, now time.Time) (failed string) {
	if err != nil {
		note := failureNote(err, "Read failed")
		p = emptyProvider()
		p.Config = proto.MCPRead{State: proto.MCPStateFailed, Note: note}
		p.Skills.State, p.Skills.Note = proto.MCPStateFailed, note
		if e.good != nil {
			p.Available, p.Version, p.Reason = e.good.Available, e.good.Version, e.good.Reason
		}
	}
	p = clone(p)
	// keep is whether the kept half, of state old, stays over a read of new.
	keep := func(old, new string) bool {
		o, oRanked := rank(old)
		n, nRanked := rank(new)
		return e.good != nil && oRanked && nRanked && n < o
	}
	var why []string
	switch {
	case e.good != nil && keep(e.good.Config.State, p.Config.State):
		e.cfgFail = cmp.Or(p.Config.Note, "Read failed")
		p.Config, p.Servers = e.good.Config, e.good.Servers
		why = append(why, e.cfgFail)
	case p.Config.State == proto.MCPStateFailed:
		e.cfgFail, e.cfgAt = "", time.Time{}
		why = append(why, cmp.Or(p.Config.Note, "Read failed"))
	default:
		e.cfgFail, e.cfgAt = "", now
	}
	switch {
	case e.good != nil && keep(e.good.Skills.State, p.Skills.State):
		e.skillsFail = cmp.Or(p.Skills.Note, "Read failed")
		p.Skills = e.good.Skills
		why = append(why, e.skillsFail)
	case p.Skills.State == proto.MCPStateFailed:
		e.skillsFail, e.skillsAt = "", time.Time{}
		why = append(why, cmp.Or(p.Skills.Note, "Read failed"))
	default:
		e.skillsFail, e.skillsAt = "", now
	}
	e.good = &p
	return joinNotes(slices.Compact(why)...)
}

// startCheck starts key's check (s.mu held). It runs under the service's
// context: a request that leaves does not end a check others may join.
func (s *Service) startCheck(key Key, e *entry) {
	check := s.o.Check[key.Harness]
	done := make(chan struct{})
	e.checking = done
	s.running++
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		var res CheckResult
		var err error
		if check == nil {
			err = &Failure{Note: "No connection check for this harness"}
		} else {
			res, err = check(s.ctx, key)
		}
		if err != nil {
			s.o.Log.Warn("mcp connection check failed", "harness", key.Harness, "cwd", key.Cwd, "home", key.Home, "err", err)
			res = CheckResult{State: proto.MCPCheckFailed, Note: failureNote(err, "Check failed")}
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		c := &checked{res: res, at: s.o.Now()}
		e.check, e.checking, s.recent[key] = c, nil, c
		s.running--
		close(done)
	}()
}

// prune drops the checks older than CheckEvery (s.mu held).
func (s *Service) prune() {
	now := s.o.Now()
	for k, c := range s.recent {
		if now.Sub(c.at) >= s.o.CheckEvery {
			delete(s.recent, k)
		}
	}
}

// evict drops the least recently used key other than keep without a read
// or check in flight (s.mu held); false when there is none.
func (s *Service) evict(keep Key) bool {
	var oldest *Key
	var used uint64
	for k, e := range s.keys {
		if k != keep && e.reading == nil && e.checking == nil && (oldest == nil || e.used < used) {
			oldest, used = &k, e.used
		}
	}
	if oldest == nil {
		return false
	}
	delete(s.keys, *oldest)
	return true
}

// applyCheck puts a check's statuses on p's servers (status_scope probe):
// a server the check saw but the read did not is added; one it did not
// see keeps its config status, and so does a disabled, blocked or
// unapproved one the check knows nothing of.
func applyCheck(p *proto.MCPProvider, res CheckResult, at time.Time) {
	p.Check = proto.MCPCheck{State: res.State, At: stamp(at), Note: res.Note}
	if p.Version == "" {
		p.Version = res.Version
	}
	apply(p, res.Rows, proto.MCPScopeProbe, at, nil)
}

// WorkerObservation is what a running worker's own connection reports of
// its servers, at At.
type WorkerObservation struct {
	Worker proto.MCPWorker
	At     time.Time
	Rows   []Observed
}

// ApplyObservation puts a worker's statuses on p's servers (status_scope
// worker), where they are newer than what p has.
func ApplyObservation(p *proto.MCPProvider, o WorkerObservation) {
	apply(p, o.Rows, proto.MCPScopeWorker, o.At, &o.Worker)
}

func apply(p *proto.MCPProvider, rows []Observed, scope string, at time.Time, w *proto.MCPWorker) {
	if at.IsZero() {
		return // an observation of no time cannot be placed
	}
	index := map[string]int{}
	for i, s := range p.Servers {
		index[s.Name] = i
	}
	when := stamp(at)
	for _, o := range rows {
		i, ok := index[o.Name]
		if !ok {
			index[o.Name] = len(p.Servers)
			p.Servers = append(p.Servers, proto.MCPServer{Name: o.Name, Source: o.Source, Plugin: o.Plugin, Transport: o.Transport,
				Approval: proto.MCPApprovalNA, Status: o.Status, StatusScope: scope, StatusAt: when, Worker: w, Reason: o.Reason})
			continue
		}
		s := &p.Servers[i]
		if o.Status == proto.MCPStatusUnknown && s.StatusScope == proto.MCPScopeConfig && s.Status != proto.MCPStatusNotChecked {
			continue
		}
		if s.StatusAt != nil && *s.StatusAt > *when { // RFC 3339 in UTC sorts by time
			continue
		}
		s.Status, s.StatusScope, s.StatusAt, s.Worker, s.Reason = o.Status, scope, when, w, o.Reason
	}
}
