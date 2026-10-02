package server

import (
	"cmp"
	"context"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
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
	// FindCodex finds the session of a Codex agent herdr knows none of:
	// the newest rollout recorded in cwd whose id skip does not refuse
	// ("": none). Default: a codex.Finder on Roots.CodexSessions.
	FindCodex func(cwd string, skip func(id string) bool) (string, error)
	// Images are the transcripts' images (M16): the cache they are filed
	// in and the roots their paths may be under (nil: inline images are
	// described but cannot be fetched, no path is read).
	Images *transcript.Images
}

// Usage timings.
const (
	DefaultUsageInterval = 2 * time.Second
	DefaultUsageThrottle = 5 * time.Second
	// WatchedUsageInterval is how often the transcripts are checked while a connection watches one.
	WatchedUsageInterval = time.Second
)

// usageWorker is what the tracker needs of a worker.
type usageWorker struct {
	id, harness, session string
	shown                bool // it has a usage now
	// floor is its session; codexCwd the cwd of a Codex agent herdr knows
	// no session of, to find its rollout by (else "").
	floor, codexCwd string
	watched         bool   // M16: a connection watches its transcript
	cwd             string // M16: its directory, a root of its transcript's path images
	asking          bool   // #57: it has an ask now
	status          string // #98: herdr's status, and when its last idle or done began
	idleAt          int64
	wrap            *wrapWatch // #83: its armed wrap-up
	typed           []typedSum // #95: the prompts the bridge typed into it lately
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
	found    map[string]foundCodex // worker id → the Codex session found for it by its cwd
	// M16 transcript: the logs of the watched workers' transcripts (fed
	// by their sessions' tails), and the last round's verdicts for them.
	logs     map[string]*txLog
	txOffers map[string]txOffer
	// #57: the asks read from every worker's transcript, what was last
	// published of them, and this round's changes.
	asks     map[string]*transcript.AskTracker
	askShown map[string]askShown
	askUps   []askUpdate
	// #83: every session's line fan-out (its ask and wrap-up trackers), and
	// this round's looks at the armed wrap-ups.
	lines   map[string]*txLines
	wrapUps []wrapUpdate
	// #95: the workers a typed prompt reached as a paste this round.
	pasted []string
	// #90: what was last offered of every worker's ended turn, this
	// round's changes, and whether the hub still has turns to look at.
	fuOffered map[string]followupOffered
	followUps []followupUpdate
	fuPending bool
	// #98: what was last offered of every worker's activity, this round's
	// changes, and the bridge's clock (the trackers' holds).
	actOffered map[string]activityOffered
	actUps     []activityUpdate
	now        func() time.Time
}

// foundCodex is a Codex session found by a worker's cwd, and when.
type foundCodex struct {
	cwd, id string
	at      time.Time
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
	if cfg.FindCodex == nil {
		f := &codex.Finder{Root: cfg.Roots.CodexSessions}
		cfg.FindCodex = func(cwd string, skip func(string) bool) (string, error) {
			if f.Root == "" {
				return "", nil
			}
			return f.Find(cwd, skip)
		}
	}
	return &usageTracker{cfg: cfg, keys: map[string]string{}, sessions: map[string]*usage.Session{},
		throttle: usageThrottle{every: cfg.Throttle, shown: map[string]proto.Usage{}, at: map[string]time.Time{}},
		found:    map[string]foundCodex{}, logs: map[string]*txLog{},
		asks: map[string]*transcript.AskTracker{}, askShown: map[string]askShown{}, lines: map[string]*txLines{},
		fuOffered: map[string]followupOffered{}, actOffered: map[string]activityOffered{}, now: time.Now}
}

// trackUsage runs the tracker until ctx is done.
func (h *Hub) trackUsage(ctx context.Context) {
	defer h.wg.Done()
	tr := newUsageTracker(*h.opts.Usage)
	tr.now = h.opts.Now
	defer tr.closeLogs()
	timer := time.NewTimer(tr.cfg.Interval)
	defer timer.Stop()
	for {
		tr.round(ctx, h)
		// A watched transcript is read every second, not every two: a pasted screenshot is in the view within 3 s.
		wait := tr.cfg.Interval
		if len(tr.txOffers) > 0 {
			wait = min(wait, WatchedUsageInterval)
		}
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timer.Reset(wait)
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		case <-h.usageKick: // a new transcript watch
		}
	}
}

func (tr *usageTracker) closeLogs() {
	for id, l := range tr.logs {
		l.log.Close()
		delete(tr.logs, id)
	}
}

// round reads every worker's transcripts once and applies what changed.
func (tr *usageTracker) round(ctx context.Context, h *Hub) {
	ws, err := query(ctx, h, h.usageWorkers)
	if err != nil {
		return
	}
	ups := tr.poll(ws, h.opts.Now())
	for id, o := range tr.txOffers { // M16 transcript
		h.tx.offer(id, o)
	}
	asks := tr.askUps              // #57
	wraps := tr.wrapUps            // #83
	fus := tr.followUps            // #90
	acts := tr.actUps              // #98
	for _, id := range tr.pasted { // #95
		h.log.Warn("a prompt the bridge typed reached Claude Code as a paste: its paste threshold may have changed (#95)",
			"worker", id)
	}
	if len(ups) > 0 || len(asks) > 0 || len(wraps) > 0 || len(fus) > 0 || tr.fuPending || len(acts) > 0 {
		pending, err := query(ctx, h, func() bool {
			for _, u := range ups {
				h.setUsage(u.id, u.usage)
			}
			for _, a := range asks {
				h.setAsk(a.id, a.ask, a.resolved)
			}
			for _, u := range wraps {
				h.wrapUpSeen(ctx, u)
			}
			for _, u := range fus { // #90
				h.followupSeen(ctx, u)
			}
			for _, u := range acts { // #98
				h.activitySeen(u)
			}
			if len(acts) > 0 {
				h.pumpActivity(ctx)
			}
			return h.sweepFollowups(ctx)
		})
		if err == nil {
			tr.fuPending = pending
		}
	}
}

// poll reads the workers' sessions and returns the updates to publish.
func (tr *usageTracker) poll(ws []usageWorker, now time.Time) []usageUpdate {
	ws = tr.findCodex(ws, now)
	tr.askUps, tr.wrapUps, tr.pasted, tr.followUps, tr.actUps = nil, nil, nil, nil, nil
	var ups []usageUpdate
	seen := map[string]bool{}
	for _, w := range ws {
		seen[w.id] = true
		clear := false
		if key := w.harness + "/" + w.session; tr.keys[w.id] != key {
			tr.keys[w.id] = key
			tr.sessions[w.id] = nil
			delete(tr.asks, w.id)
			delete(tr.lines, w.id)
			if w.session != "" {
				tr.sessions[w.id] = usage.NewSession(w.harness, w.session, tr.cfg.Roots, tr.cfg.Pricing)
			}
			if s := tr.sessions[w.id]; s != nil { // #57: the ask, from the same lines, the file's first included
				l := &txLines{harness: w.harness, ask: transcript.NewAskTracker(w.harness), // #83: and a wrap-up's
					followup: transcript.NewFollowupTracker(w.harness),                               // #90: and the turn's final message
					activity: transcript.NewActivityTracker(w.harness, tr.cfg.Images, w.cwd, tr.now)} // #98: and what it does
				if w.harness == transcript.Claude { // #95: and typed prompts arriving as a paste
					l.paste = newPasteWatch()
				}
				if l.ask != nil {
					tr.asks[w.id] = l.ask
				}
				tr.lines[w.id] = l
				s.SetLines(l)
			}
			// Another agent session (or rollout): the usage shown was the
			// old one's and goes now, unless the new one's goes out
			// instead. The throttle still holds for the new one.
			clear = w.shown
			delete(tr.throttle.shown, w.id)
		}
		s := tr.sessions[w.id]
		tr.syncTranscript(w, s, tr.keys[w.id])
		tr.wrapBefore(w)                                     // #83
		if l := tr.lines[w.id]; l != nil && l.paste != nil { // #95
			l.paste.sums = w.typed
		}
		if s == nil {
			if w.shown { // no agent session any more: no usage
				ups = append(ups, usageUpdate{id: w.id})
			}
			tr.throttle.forget(w.id)
			tr.offerAsk(w)
			tr.offerWrapUp(w)
			tr.offerFollowup(w)      // #90
			tr.offerActivity(w, now) // #98
			continue
		}
		s.SetRescan(0)
		if w.watched {
			s.SetRescan(WatchedRescan)
		}
		if l := tr.lines[w.id]; l != nil && l.activity != nil { // #98: herdr's status before the round's lines
			l.activity.Status(w.status, w.idleAt)
		}
		u, ok := s.Poll(now)
		tr.syncTranscript(w, s, tr.keys[w.id])
		tr.offerAsk(w)
		tr.offerWrapUp(w)
		tr.offerFollowup(w)      // #90
		tr.offerActivity(w, now) // #98
		if ok {
			if pub, emit := tr.throttle.offer(w.id, u, now); emit {
				ups = append(ups, usageUpdate{id: w.id, usage: &pub})
				continue
			}
		}
		if clear {
			ups = append(ups, usageUpdate{id: w.id})
		}
	}
	for id := range tr.keys {
		if !seen[id] {
			delete(tr.keys, id)
			delete(tr.sessions, id)
			delete(tr.asks, id)
			delete(tr.askShown, id)
			delete(tr.lines, id)
			delete(tr.fuOffered, id)  // #90
			delete(tr.actOffered, id) // #98
			tr.throttle.forget(id)
		}
	}
	for id, l := range tr.logs {
		if !seen[id] {
			l.log.Close()
			delete(tr.logs, id)
		}
	}
	for id, l := range tr.lines { // #95
		if l.paste != nil && l.paste.takeHits() > 0 {
			tr.pasted = append(tr.pasted, id)
		}
	}
	tr.txOffers = tr.offers(ws)
	return ups
}

// findCodex gives each Codex agent herdr knows no session of (it does not
// report one: only the sleep backfill tells herdr) the session of the
// newest rollout recorded in its cwd that no other worker of its floor
// has, as the backfill picks it; looked for again every usage.MissRescan.
// Only for its usage: herdr is never told, and the worker's agent_session
// stays empty.
func (tr *usageTracker) findCodex(ws []usageWorker, now time.Time) []usageWorker {
	taken := map[string]map[string]bool{} // floor → the sessions its workers have
	take := func(floor, id string) {
		if taken[floor] == nil {
			taken[floor] = map[string]bool{}
		}
		taken[floor][id] = true
	}
	var want []int
	for i, w := range ws {
		switch {
		case w.session != "":
			take(w.floor, w.session)
		case w.codexCwd != "":
			want = append(want, i)
		}
	}
	for id := range tr.found {
		if !slices.ContainsFunc(want, func(i int) bool { return ws[i].id == id }) {
			delete(tr.found, id)
		}
	}
	if len(want) == 0 {
		return ws
	}
	due := func(w usageWorker) bool {
		f, ok := tr.found[w.id]
		rescan := usage.MissRescan
		if w.watched { // M16: a watched Codex's /new shows soon
			rescan = WatchedRescan
		}
		return !ok || f.cwd != w.codexCwd || now.Sub(f.at) >= rescan || now.Before(f.at)
	}
	// Those not due keep what they have (first, so a lookup skips it), then the lookups; each in id order.
	slices.SortFunc(want, func(a, b int) int {
		if da, db := due(ws[a]), due(ws[b]); da != db {
			if da {
				return 1
			}
			return -1
		}
		return cmp.Compare(ws[a].id, ws[b].id)
	})
	out := slices.Clone(ws)
	for _, i := range want {
		w := &out[i]
		f := tr.found[w.id]
		if due(*w) || taken[w.floor][f.id] {
			id, err := tr.cfg.FindCodex(w.codexCwd, func(id string) bool { return taken[w.floor][id] })
			if err != nil && f.cwd == w.codexCwd && !taken[w.floor][f.id] {
				id = f.id // keep the last answer through a failed lookup
			}
			f = foundCodex{cwd: w.codexCwd, id: id, at: now}
			tr.found[w.id] = f
		}
		if f.id != "" {
			w.harness, w.session = usage.Codex, f.id
			take(w.floor, f.id)
		}
	}
	return out
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
		uw := usageWorker{id: id, harness: harness, session: w.AgentSession, shown: w.Usage != nil, floor: w.Session,
			watched: h.tx.watched(id), cwd: w.Cwd, asking: w.Ask != nil, wrap: h.wrapWatchOf(id), typed: h.typedSums(id),
			status: w.Status, idleAt: h.act.idleAt[id]}
		if w.AgentSession == "" && w.AgentKind == usage.Codex && w.Cwd != "" {
			uw.codexCwd = w.Cwd
		}
		ws = append(ws, uw)
	}
	for id := range h.usage {
		if h.workers[id] == nil {
			delete(h.usage, id)
		}
	}
	for id := range h.asks { // #57
		if h.workers[id] == nil {
			delete(h.asks, id)
			delete(h.askResolved, id)
		}
	}
	for id := range h.act.ws { // #98
		if h.workers[id] == nil {
			delete(h.act.ws, id)
		}
	}
	for id := range h.act.idleAt {
		if h.workers[id] == nil {
			delete(h.act.idleAt, id)
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
