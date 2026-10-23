package mcpinv

import (
	"context"
	"log/slog"
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
	// Max bounds the keys kept (least recently used dropped first).
	Max int
}

// Service answers inventories and checks from a bridge-wide cache per Key:
// a fresh read at once; an older one at once while one read refreshes it
// in the background; a first read waited for, up to Wait (then pending: a
// later request gets it). Concurrent requests share one read per key. A
// failed read keeps the last good one, marked stale, and the next waits
// MinBackoff, doubling to MaxBackoff; with none, the answer is failed,
// never an empty success. Checks are coalesced per key, at most one per
// CheckEvery (a request inside it answers the last), never retried; the
// last check's statuses stay on the key's later answers.
type Service struct {
	ctx  context.Context // the bridge's: a read outlives the request that started it
	o    Options
	wg   sync.WaitGroup
	mu   sync.Mutex
	keys map[Key]*entry
	tick uint64
}

type entry struct {
	good     *proto.MCPProvider // the last good read (nil: none yet)
	readAt   time.Time          // when it ended
	failed   bool               // the latest read failed (good is stale)
	failNote string
	failures int       // failed reads in a row
	retryAt  time.Time // no read before it (backoff)
	reading  chan struct{}

	check    *checked
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
	return &Service{ctx: ctx, o: o, keys: map[Key]*entry{}}
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
	if e.checking == nil && (e.check == nil || s.o.Now().Sub(e.check.at) >= s.o.CheckEvery) {
		s.startCheck(key, e)
	}
	if wait := e.checking; wait != nil {
		s.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
		}
		s.mu.Lock()
	}
	s.waitFirst(ctx, e)
	return s.answer(e)
}

// entry is key's entry, its read started when due (s.mu held).
func (s *Service) entry(key Key) *entry {
	e := s.keys[key]
	if e == nil {
		e = &entry{}
		s.keys[key] = e
	}
	s.tick++
	e.used = s.tick
	now := s.o.Now()
	if e.reading == nil && !now.Before(e.retryAt) && (e.good == nil || now.Sub(e.readAt) > s.o.Fresh) {
		s.startRead(key, e)
	}
	s.evict(key)
	return e
}

// waitFirst waits up to Wait for a first read in flight (s.mu held; it is
// released while waiting).
func (s *Service) waitFirst(ctx context.Context, e *entry) {
	if e.good != nil || e.reading == nil {
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

// answer is e's provider now (s.mu held).
func (s *Service) answer(e *entry) proto.MCPProvider {
	var p proto.MCPProvider
	switch {
	case e.good != nil:
		p = clone(*e.good)
		at := stamp(e.readAt)
		p.Config.ReadAt, p.Skills.ReadAt = at, at
		if e.failed {
			p.Config.Stale, p.Skills.Stale = true, true
			p.Config.Note = joinNotes("Showing the last good read: "+e.failNote, p.Config.Note)
		}
	case e.failed:
		p = emptyProvider()
		p.Config = proto.MCPRead{State: proto.MCPStateFailed, Note: e.failNote}
		p.Skills.State, p.Skills.Note = proto.MCPStateFailed, e.failNote
	default:
		p = emptyProvider()
		p.Config = proto.MCPRead{State: proto.MCPStatePending, Note: "Reading the configuration"}
		p.Skills.State = proto.MCPStatePending
	}
	if e.check != nil {
		applyCheck(&p, e.check.res, e.check.at)
	}
	return p
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
		if err != nil {
			e.failed, e.failNote = true, failureNote(err, "Read failed")
			e.failures++
			e.retryAt = now.Add(s.backoff(e.failures))
			s.o.Log.Warn("mcp inventory read failed", "harness", key.Harness, "cwd", key.Cwd, "home", key.Home,
				"kept", e.good != nil, "retry_in", e.retryAt.Sub(now), "err", err)
		} else {
			p = clone(p)
			e.good, e.readAt, e.failed, e.failNote, e.failures, e.retryAt = &p, now, false, "", 0, time.Time{}
		}
		e.reading = nil
		close(done)
		s.evict(key)
	}()
}

// startCheck starts key's check (s.mu held). It runs under the service's
// context: a request that leaves does not end a check others may join.
func (s *Service) startCheck(key Key, e *entry) {
	check := s.o.Check[key.Harness]
	done := make(chan struct{})
	e.checking = done
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
		e.check, e.checking = &checked{res: res, at: s.o.Now()}, nil
		close(done)
		s.evict(key)
	}()
}

// evict drops the least recently used keys beyond Max, except keep and
// keys with a read or check in flight (s.mu held).
func (s *Service) evict(keep Key) {
	for len(s.keys) > s.o.Max {
		var oldest *Key
		var used uint64
		for k, e := range s.keys {
			if k != keep && e.reading == nil && e.checking == nil && (oldest == nil || e.used < used) {
				oldest, used = &k, e.used
			}
		}
		if oldest == nil {
			return
		}
		delete(s.keys, *oldest)
	}
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
