package server

import (
	"context"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// UsageConfig configures reading the workers' agent transcripts for their
// usage (Options.Usage).
type UsageConfig struct {
	Roots usage.Roots
	// Pricing prices the tokens (default usage.DefaultPricing()).
	Pricing *usage.Pricing
	// Interval is how often the transcripts are checked (default
	// DefaultUsageInterval); Throttle the least time between two
	// worker.usage events of one worker (default DefaultUsageThrottle).
	Interval, Throttle time.Duration
}

// Usage timings.
const (
	DefaultUsageInterval = 2 * time.Second
	DefaultUsageThrottle = 5 * time.Second
)

// usageWorker is what the tracker needs of a worker.
type usageWorker struct {
	id, harness, session string
	shown                bool // it has a usage now
}

// usageUpdate is a worker's new usage, or (nil) its usage gone.
type usageUpdate struct {
	id    string
	usage *proto.Usage
}

// usageTracker maps workers to their agent sessions' transcripts and
// reads them on every round, off the hub goroutine.
type usageTracker struct {
	cfg      UsageConfig
	keys     map[string]string         // worker id → harness/agent session
	sessions map[string]*usage.Session // worker id → its session (nil: none to read)
	throttle usageThrottle
}

func newUsageTracker(cfg UsageConfig) *usageTracker {
	if cfg.Pricing == nil {
		cfg.Pricing = usage.DefaultPricing()
	}
	if cfg.Interval <= 0 {
		cfg.Interval = DefaultUsageInterval
	}
	if cfg.Throttle <= 0 {
		cfg.Throttle = DefaultUsageThrottle
	}
	return &usageTracker{cfg: cfg, keys: map[string]string{}, sessions: map[string]*usage.Session{},
		throttle: usageThrottle{every: cfg.Throttle, shown: map[string]proto.Usage{}, at: map[string]time.Time{}}}
}

// trackUsage runs the tracker until ctx is done.
func (h *Hub) trackUsage(ctx context.Context) {
	defer h.wg.Done()
	tr := newUsageTracker(*h.opts.Usage)
	tick := time.NewTicker(tr.cfg.Interval)
	defer tick.Stop()
	for {
		tr.round(ctx, h)
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// round reads every worker's transcripts once and applies what changed.
func (tr *usageTracker) round(ctx context.Context, h *Hub) {
	ws, err := query(ctx, h, h.usageWorkers)
	if err != nil {
		return
	}
	ups := tr.poll(ws, h.opts.Now())
	if len(ups) > 0 {
		_ = h.doWait(ctx, func() {
			for _, u := range ups {
				h.setUsage(u.id, u.usage)
			}
		})
	}
}

// poll reads the workers' sessions and returns the updates to publish.
func (tr *usageTracker) poll(ws []usageWorker, now time.Time) []usageUpdate {
	var ups []usageUpdate
	seen := map[string]bool{}
	for _, w := range ws {
		seen[w.id] = true
		if key := w.harness + "/" + w.session; tr.keys[w.id] != key {
			tr.keys[w.id] = key
			tr.sessions[w.id] = nil
			if w.session != "" {
				tr.sessions[w.id] = usage.NewSession(w.harness, w.session, tr.cfg.Roots, tr.cfg.Pricing)
			}
		}
		s := tr.sessions[w.id]
		if s == nil {
			if w.shown { // no agent session any more: no usage
				ups = append(ups, usageUpdate{id: w.id})
			}
			tr.throttle.forget(w.id)
			continue
		}
		u, ok := s.Poll(now)
		if !ok {
			continue
		}
		if pub, emit := tr.throttle.offer(w.id, u, now); emit {
			ups = append(ups, usageUpdate{id: w.id, usage: &pub})
		}
	}
	for id := range tr.keys {
		if !seen[id] {
			delete(tr.keys, id)
			delete(tr.sessions, id)
			tr.throttle.forget(id)
		}
	}
	return ups
}

// usageWorkers lists the workers for the tracker (on the hub goroutine)
// and forgets the usage of workers that are gone.
func (h *Hub) usageWorkers() []usageWorker {
	ws := make([]usageWorker, 0, len(h.workers))
	for id, w := range h.workers {
		harness := w.Harness
		if harness == "" {
			harness = w.AgentKind
		}
		ws = append(ws, usageWorker{id: id, harness: harness, session: w.AgentSession, shown: w.Usage != nil})
	}
	for id := range h.usage {
		if h.workers[id] == nil {
			delete(h.usage, id)
		}
	}
	return ws
}

// setUsage publishes a worker's new usage (worker.usage), or its usage
// gone (nil: worker.upsert without it).
func (h *Hub) setUsage(id string, u *proto.Usage) {
	w := h.workers[id]
	if w == nil {
		return
	}
	if u == nil && w.Usage == nil {
		return
	}
	next := *w
	next.Usage = u
	h.workers[id] = &next
	if u == nil {
		delete(h.usage, id)
		h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
		return
	}
	h.usage[id] = u
	h.emit(proto.Event{T: proto.EvWorkerUsage, ID: id, Session: w.Session, Usage: u})
}

// usageThrottle lets a worker's usage out only when it changed, and at
// most once per every.
type usageThrottle struct {
	every time.Duration
	shown map[string]proto.Usage // as last let out, without UpdatedAt
	at    map[string]time.Time
}

// offer returns u stamped with now when it should be published.
func (t *usageThrottle) offer(id string, u proto.Usage, now time.Time) (proto.Usage, bool) {
	u.UpdatedAt = 0
	if old, ok := t.shown[id]; ok && sameUsage(old, u) {
		return u, false
	}
	if last, ok := t.at[id]; ok && now.Sub(last) < t.every && !now.Before(last) {
		return u, false
	}
	t.shown[id], t.at[id] = u, now
	u.UpdatedAt = now.UnixMilli()
	return u, true
}

func (t *usageThrottle) forget(id string) {
	delete(t.shown, id)
	delete(t.at, id)
}

func sameUsage(a, b proto.Usage) bool {
	pa, pb := a.ContextPct, b.ContextPct
	a.ContextPct, b.ContextPct = nil, nil
	return a == b && (pa == nil) == (pb == nil) && (pa == nil || *pa == *pb)
}
