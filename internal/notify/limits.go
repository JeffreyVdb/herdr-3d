package notify

// #106: the outbound anti-spam budget, per destination (the paired chat:
// one per channel). Two layers. The provider's pacing: every call to the
// channel but a tap's answer and the settings' test message (a message, a
// card, an edit, a button change, a reply prompt, an answer to a reply, a
// reaction, a retry) takes a token of a bucket of Burst refilled one per
// Pace, and a rate limit's retry_after pauses the whole destination. The
// recipient's: an alert or a new card is a message nobody asked for, at
// most Unsolicited of them within Window, at most one alert of a worker
// within Cooldown and WorkerCards of its new card sets within Window. What
// does not fit is parked, one alert and one card set per worker, the
// latest wins (coalesced), and sent once it fits if it is still what the
// worker is at; else dropped (never a backlog of old states). A slot
// counts from when its message is sent, not let in: let in and not sent
// yet (queued, paced, paused by a rate limit), it is taken for as long,
// and given back if the message never goes; a send that fails keeps its
// slot, from when it failed.

import (
	"context"
	"sync"
	"time"
)

// Limits are the budget's: a zero field takes DefaultLimits', a negative
// one is off.
type Limits struct {
	// Burst calls at once, then one per Pace (Telegram: about one message a
	// second in a private chat; a burst lets an ask's alert and its four
	// cards go together).
	Burst int
	Pace  time.Duration
	// Unsolicited new messages (alerts, new cards) within Window: ours,
	// stricter than Telegram's.
	Unsolicited int
	Window      time.Duration
	// Cooldown is the least time between two alerts of one worker (either
	// kind); WorkerCards the most new card sets of one worker within
	// Window.
	Cooldown    time.Duration
	WorkerCards int
}

// DefaultLimits are the bridge's.
func DefaultLimits() Limits {
	return Limits{Burst: 5, Pace: time.Second, Unsolicited: 10, Window: time.Minute, Cooldown: time.Minute, WorkerCards: 3}
}

// NoLimits switches the budget off (tests of everything else).
func NoLimits() Limits { return Limits{-1, -1, -1, -1, -1, -1} }

func (l Limits) withDefaults() Limits {
	d := DefaultLimits()
	if l.Burst == 0 {
		l.Burst = d.Burst
	}
	if l.Pace == 0 {
		l.Pace = d.Pace
	}
	if l.Unsolicited == 0 {
		l.Unsolicited = d.Unsolicited
	}
	if l.Window == 0 {
		l.Window = d.Window
	}
	if l.Cooldown == 0 {
		l.Cooldown = d.Cooldown
	}
	if l.WorkerCards == 0 {
		l.WorkerCards = d.WorkerCards
	}
	return l
}

// recheck is when to try again a message that waits on slots taken by
// messages not sent yet (when they go is not known).
const recheck = time.Second

// Why something was parked (a notify.limit row's cause).
const (
	causeCooldown    = "cooldown"
	causeBudget      = "budget"
	causeWorkerCards = "worker_cards"
)

// limiter is the budget's state, shared by the loop, the sender and the
// replier.
type limiter struct {
	mu     sync.Mutex
	l      Limits
	clock  Clock
	tokens float64
	filled time.Time // when tokens was last refilled
	paused time.Time // a rate limit's retry_after, until then
	// sent are the unsolicited messages' send times; held how many more
	// were let in and are not sent yet (they take a slot each).
	sent []time.Time
	held int
	// alerted is each worker's last alert's send time, alerts its alerts
	// let in and not sent yet; cards its card sets' times (their first
	// card's), sets its sets let in with no card sent yet.
	alerted map[string]time.Time
	alerts  map[string]int
	cards   map[string][]time.Time
	sets    map[string]int
}

func newLimiter(l Limits, clock Clock) *limiter {
	return &limiter{l: l, clock: clock, tokens: float64(l.Burst), filled: clock.Now(), alerted: map[string]time.Time{},
		alerts: map[string]int{}, cards: map[string][]time.Time{}, sets: map[string]int{}}
}

// wait takes a token of the destination's bucket, waiting for one (or a
// pause's end) on the clock; ctx's error if it ends first.
func (lm *limiter) wait(ctx context.Context) error {
	if lm.l.Burst < 0 || lm.l.Pace <= 0 {
		return ctx.Err()
	}
	for {
		lm.mu.Lock()
		now := lm.clock.Now()
		lm.tokens = min(float64(lm.l.Burst), lm.tokens+float64(now.Sub(lm.filled))/float64(lm.l.Pace))
		lm.filled = now
		var d time.Duration
		switch {
		case now.Before(lm.paused):
			d = lm.paused.Sub(now)
		case lm.tokens >= 1:
			lm.tokens--
			lm.mu.Unlock()
			return nil
		default:
			d = time.Duration((1 - lm.tokens) * float64(lm.l.Pace))
		}
		lm.mu.Unlock()
		if err := Sleep(ctx, lm.clock, max(d, time.Millisecond)); err != nil {
			return err
		}
	}
}

// refund gives back a token wait took for a call that was not made
// (H3D-1: the message may no longer go as it waited; goes).
func (lm *limiter) refund() {
	if lm.l.Burst < 0 || lm.l.Pace <= 0 {
		return
	}
	lm.mu.Lock()
	lm.tokens = min(float64(lm.l.Burst), lm.tokens+1)
	lm.mu.Unlock()
}

// pause holds every paced call for d (a rate limit's retry_after).
func (lm *limiter) pause(d time.Duration) {
	if lm.l.Burst < 0 || d <= 0 {
		return
	}
	lm.mu.Lock()
	if until := lm.clock.Now().Add(d); until.After(lm.paused) {
		lm.paused = until
	}
	lm.mu.Unlock()
}

// recent is ts without the times older than Window before now.
func (lm *limiter) recent(ts []time.Time, now time.Time) []time.Time {
	keep := ts[:0]
	for _, t := range ts {
		if now.Sub(t) < lm.l.Window {
			keep = append(keep, t)
		}
	}
	return keep
}

// room is when n more unsolicited messages fit (now: they do).
func (lm *limiter) room(n int, now time.Time) time.Time {
	if lm.l.Unsolicited < 0 || lm.l.Window < 0 {
		return now
	}
	lm.sent = lm.recent(lm.sent, now)
	used := len(lm.sent) + lm.held
	if used == 0 || used+n <= lm.l.Unsolicited {
		return now // a set larger than the budget goes alone
	}
	k := used + n - lm.l.Unsolicited // the sends that must leave the window
	switch {
	case k > len(lm.sent) && lm.held > 0:
		return now.Add(recheck)
	case k > len(lm.sent):
		k = len(lm.sent)
	}
	return lm.sent[k-1].Add(lm.l.Window)
}

// give is m[id] less one (forgotten at none).
func give(m map[string]int, id string) {
	if m[id] > 1 {
		m[id]--
	} else {
		delete(m, id)
	}
}

// prune forgets the workers whose times are past, beyond a few hundred.
func (lm *limiter) prune(now time.Time) {
	if len(lm.alerted) > 256 {
		for id, t := range lm.alerted {
			if now.Sub(t) >= lm.l.Cooldown && lm.alerts[id] == 0 {
				delete(lm.alerted, id)
			}
		}
	}
	if len(lm.cards) > 256 {
		for id, ts := range lm.cards {
			if len(lm.recent(ts, now)) == 0 {
				delete(lm.cards, id)
			}
		}
	}
}

// admitAlert lets an alert of worker's in, its slots held until it is
// sent (sentAlert) or never is (dropAlert): ok, or when it may be tried
// again and why not now.
func (lm *limiter) admitAlert(worker string) (bool, time.Time, string) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	now := lm.clock.Now()
	lm.prune(now)
	if lm.l.Cooldown > 0 {
		if lm.alerts[worker] > 0 {
			return false, now.Add(recheck), causeCooldown
		}
		if last, ok := lm.alerted[worker]; ok && now.Sub(last) < lm.l.Cooldown {
			return false, last.Add(lm.l.Cooldown), causeCooldown
		}
	}
	if at := lm.room(1, now); at.After(now) {
		return false, at, causeBudget
	}
	lm.alerts[worker]++
	lm.held++
	return true, now, ""
}

// sentAlert takes an alert of worker's as sent now (or failed: tried);
// dropAlert gives its slots back (never tried).
func (lm *limiter) sentAlert(worker string) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	now := lm.clock.Now()
	give(lm.alerts, worker)
	lm.alerted[worker] = now
	lm.held = max(lm.held-1, 0)
	lm.sent = append(lm.sent, now)
}

func (lm *limiter) dropAlert(worker string) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	give(lm.alerts, worker)
	lm.held = max(lm.held-1, 0)
}

// admitCards lets a card set of worker's in (n cards), its slots held
// until its cards are sent (sentCards) or never are (dropCards): ok, or
// when it may be tried again and why not now.
func (lm *limiter) admitCards(worker string, n int) (bool, time.Time, string) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	now := lm.clock.Now()
	lm.prune(now)
	if lm.l.WorkerCards > 0 && lm.l.Window > 0 {
		ts := lm.recent(lm.cards[worker], now)
		lm.cards[worker] = ts
		if used := len(ts) + lm.sets[worker]; used >= lm.l.WorkerCards {
			if k := used - lm.l.WorkerCards + 1; k <= len(ts) {
				return false, ts[k-1].Add(lm.l.Window), causeWorkerCards
			}
			return false, now.Add(recheck), causeWorkerCards
		}
	}
	if at := lm.room(n, now); at.After(now) {
		return false, at, causeBudget
	}
	if lm.l.WorkerCards > 0 {
		lm.sets[worker]++
	}
	lm.held += n
	return true, now, ""
}

// sentCards takes n cards of worker's set as sent now (or failed: tried),
// the set with its first; dropCards gives n cards' slots back (never
// tried), the set's too if none went.
func (lm *limiter) sentCards(worker string, n int) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	now := lm.clock.Now()
	if lm.sets[worker] > 0 {
		give(lm.sets, worker)
		lm.cards[worker] = append(lm.cards[worker], now)
	}
	lm.held = max(lm.held-n, 0)
	for range n {
		lm.sent = append(lm.sent, now)
	}
}

func (lm *limiter) dropCards(worker string, n int) {
	lm.mu.Lock()
	defer lm.mu.Unlock()
	give(lm.sets, worker)
	lm.held = max(lm.held-n, 0)
}

// limitAudit is a notify.limit row's args (#106): a worker's alert or card
// set that was parked, why, how many later states it stood for, and how it
// ended (sent, or dropped: no longer what the worker was at); never a
// text.
type limitAudit struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"` // alert, cards
	Cause     string `json:"cause"`
	Coalesced int    `json:"coalesced,omitempty"`
	Outcome   string `json:"outcome"` // sent, dropped
}

// parked is an alert or a card set waiting for its slot.
type parked struct {
	alert     Alert
	at        time.Time
	cause     string
	coalesced int
}

// park keeps a as m's worker's parked one: the latest wins, counting the
// one it replaces.
func park(m map[string]*parked, a Alert, at time.Time, cause string) {
	if p := m[a.WorkerID]; p != nil {
		p.alert, p.at, p.cause = a, at, cause
		p.coalesced++
		return
	}
	m[a.WorkerID] = &parked{alert: a, at: at, cause: cause}
}

// due is the earliest release of m's (ok false: none).
func due(m map[string]*parked) (time.Time, bool) {
	var at time.Time
	ok := false
	for _, p := range m {
		if !ok || p.at.Before(at) {
			at, ok = p.at, true
		}
	}
	return at, ok
}
