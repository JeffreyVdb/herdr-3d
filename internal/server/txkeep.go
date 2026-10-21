package server

import (
	"cmp"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// #149: the transcript logs kept for return visits. A log whose watch ended
// stays in the tracker's logs (or kidLogs) with its idle time set, still the
// tap of its session's one tail, so it stays current while nobody watches;
// a watch of it again gets it as it is, already built. It goes when it no
// longer indexes the worker's transcript (another agent session, another
// directory, its file truncated, replaced or gone), when the worker goes,
// or when the bounds (UsageConfig.IdleLogTTL, MaxIdleLogs, IdleLogBudget)
// evict it, the least recently watched first. Nothing of it is offered
// while it is not watched.

// Why a kept log went (the debug log's reason).
const (
	keptTTL         = "ttl"
	keptCount       = "count"
	keptFootprint   = "footprint"
	keptInvalidated = "invalidated"
	keptGone        = "gone" // its worker went (or the tracker stops)
)

// logEvent is what became of a log watched now or lately, for the debug
// log: ids and sizes, never content.
type logEvent struct {
	what      string // built, retained, reused, evicted
	worker    string
	child     bool
	reason    string        // evicted: why
	idle      time.Duration // retained for this long (reused, evicted)
	footprint int64         // its index, estimated (not built)
	items     int
	bytes     int64 // built: the file read before its tail's lines
	// reused, built: the watches that reused a kept log and that built one, since the start.
	reused, built int
}

// sameCwd reports whether the log's path images resolve as they would for a
// worker in cwd now: opened there, or watched since (it goes when its watch
// ends then).
func (l *txLog) sameCwd(cwd string, watched bool) bool {
	return l.cwd == cwd || (watched && l.idle.IsZero())
}

// retain keeps a log whose watch ended (once: its idle time is when).
func (tr *usageTracker) retain(l *txLog, id string, child bool, now time.Time) {
	if !l.idle.IsZero() {
		return
	}
	l.idle = now
	tr.logEvents = append(tr.logEvents, logEvent{what: "retained", worker: id, child: child, footprint: l.log.Footprint(),
		items: l.log.Len()})
}

// reuse hands a kept log to a watch again: false when it no longer indexes
// its file as it is now (its tail may not have seen the change yet).
func (tr *usageTracker) reuse(l *txLog, id string, child bool, now time.Time) bool {
	if l.log.Stale() != nil {
		return false
	}
	idle := now.Sub(l.idle)
	l.idle = time.Time{}
	tr.reused++
	tr.logEvents = append(tr.logEvents, logEvent{what: "reused", worker: id, child: child, idle: idle, footprint: l.log.Footprint(),
		items: l.log.Len(), reused: tr.reused, built: tr.built})
	return true
}

// noteBuilt counts a watch's log built from its file.
func (tr *usageTracker) noteBuilt(id string, child bool, bytes int64) {
	tr.built++
	tr.logEvents = append(tr.logEvents, logEvent{what: "built", worker: id, child: child, bytes: bytes, reused: tr.reused,
		built: tr.built})
}

// evicted notes a kept log going.
func (tr *usageTracker) evicted(l *txLog, id string, child bool, reason string, now time.Time) {
	if l.idle.IsZero() {
		return // watched: its watch hears of it
	}
	tr.logEvents = append(tr.logEvents, logEvent{what: "evicted", worker: id, child: child, reason: reason, idle: now.Sub(l.idle),
		footprint: l.log.Footprint(), items: l.log.Len()})
}

// dropLog closes worker id's own log and stops its session's tail feeding
// it (s: the worker's session, nil when it went).
func (tr *usageTracker) dropLog(id string, l *txLog, s *usage.Session, reason string, now time.Time) {
	tr.evicted(l, id, false, reason, now)
	l.log.Close()
	delete(tr.logs, id)
	if s != nil {
		s.SetTap(nil)
	}
}

// dropKidLog closes the log of worker id's child key and stops the
// session's tail of it feeding it, as dropLog.
func (tr *usageTracker) dropKidLog(id, key string, l *txLog, s *usage.Session, reason string, now time.Time) {
	tr.evicted(l, id, true, reason, now)
	l.log.Close()
	m := tr.kidLogs[id]
	delete(m, key)
	if len(m) == 0 {
		delete(tr.kidLogs, id)
	}
	if s == nil {
		return
	}
	for _, o := range m {
		if o.native == l.native {
			return // another row of the same child: its tap
		}
	}
	s.SetChildTap(l.native, nil)
}

// evictLogs drops the kept logs past the bounds: each kept longer than the
// TTL, then the least recently watched while there are more than
// MaxIdleLogs or their footprints are over IdleLogBudget. Watched logs are
// neither counted nor evicted.
func (tr *usageTracker) evictLogs(now time.Time) {
	type kept struct {
		id, key string // key: a child's target ("": the worker's own)
		l       *txLog
		fp      int64
	}
	var ks []kept
	for id, l := range tr.logs {
		if !l.idle.IsZero() {
			ks = append(ks, kept{id: id, l: l})
		}
	}
	for id, m := range tr.kidLogs {
		for key, l := range m {
			if !l.idle.IsZero() {
				ks = append(ks, kept{id: id, key: key, l: l})
			}
		}
	}
	slices.SortFunc(ks, func(a, b kept) int {
		return cmp.Or(a.l.idle.Compare(b.l.idle), cmp.Compare(a.id, b.id), cmp.Compare(a.key, b.key))
	})
	drop := func(k kept, reason string) {
		if k.key == "" {
			tr.dropLog(k.id, k.l, tr.sessions[k.id], reason, now)
			return
		}
		tr.dropKidLog(k.id, k.key, k.l, tr.sessions[k.id], reason, now)
	}
	var total int64
	live := ks[:0]
	for _, k := range ks {
		if now.Sub(k.l.idle) >= tr.cfg.IdleLogTTL {
			drop(k, keptTTL)
			continue
		}
		k.fp = k.l.log.Footprint()
		total += k.fp
		live = append(live, k)
	}
	for len(live) > tr.cfg.MaxIdleLogs {
		drop(live[0], keptCount)
		total -= live[0].fp
		live = live[1:]
	}
	for len(live) > 0 && total > tr.cfg.IdleLogBudget {
		drop(live[0], keptFootprint)
		total -= live[0].fp
		live = live[1:]
	}
}

// logKeptLog logs what became of a watched or kept transcript log at debug
// (#149): the reused and built counts give the hit rate.
func (h *Hub) logKeptLog(e logEvent) {
	args := []any{"worker", e.worker, "child", e.child}
	switch e.what {
	case "built":
		args = append(args, "bytes", e.bytes, "reused", e.reused, "built", e.built)
	case "reused":
		args = append(args, "idle_ms", e.idle.Milliseconds(), "footprint", e.footprint, "items", e.items, "reused", e.reused,
			"built", e.built)
	case "retained":
		args = append(args, "footprint", e.footprint, "items", e.items)
	case "evicted":
		args = append(args, "reason", e.reason, "idle_ms", e.idle.Milliseconds(), "footprint", e.footprint, "items", e.items)
	}
	h.log.Debug("transcript log "+e.what, args...)
}
