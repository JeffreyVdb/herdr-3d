package notify

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// #106: the bucket lets Burst calls through at once, then one per Pace; a
// pause holds every call until it ends; off, nothing waits.
func TestLimiterPacing(t *testing.T) {
	clock := NewFakeClock(t0)
	lm := newLimiter(DefaultLimits(), clock)
	ctx := context.Background()
	for i := range 5 {
		if err := lm.wait(ctx); err != nil {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	var passed atomic.Int32
	go func() {
		for range 2 {
			if lm.wait(ctx) == nil {
				passed.Add(1)
			}
		}
	}()
	wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !clock.WaitFor(wctx, 1) {
		t.Fatal("the sixth call did not wait")
	}
	if passed.Load() != 0 {
		t.Fatal("the sixth call went at once")
	}
	clock.Advance(time.Second)
	if !clock.WaitFor(wctx, 1) || passed.Load() != 1 {
		t.Fatalf("%d passed after a second", passed.Load())
	}
	lm.pause(10 * time.Second)
	clock.Advance(time.Second) // the token is there, the pause is not over
	time.Sleep(20 * time.Millisecond)
	if passed.Load() != 1 {
		t.Fatal("a paused call went")
	}
	for passed.Load() != 2 {
		if !clock.WaitFor(wctx, 1) {
			t.Fatal("not waiting for the pause")
		}
		clock.Advance(time.Second)
		time.Sleep(5 * time.Millisecond)
	}
	if now := clock.Now(); now.Sub(t0) < 11*time.Second {
		t.Fatalf("went %v after the start", now.Sub(t0))
	}
	off := newLimiter(NoLimits(), clock)
	off.pause(time.Hour)
	for range 100 {
		if off.wait(ctx) != nil {
			t.Fatal("off waits")
		}
	}
}

// #106: one alert of a worker per Cooldown; Unsolicited messages within
// Window, a set of cards whole; WorkerCards card sets of a worker within
// Window; each refusal says when to try again and why.
func TestLimiterWindows(t *testing.T) {
	clock := NewFakeClock(t0)
	lm := newLimiter(DefaultLimits(), clock)
	if ok, _, _ := lm.admitAlert("w1"); !ok {
		t.Fatal("first alert refused")
	}
	if ok, at, cause := lm.admitAlert("w1"); ok || cause != causeCooldown || !at.Equal(t0.Add(time.Minute)) {
		t.Fatalf("second alert: %v %v %s", ok, at, cause)
	}
	for i := range 3 {
		if ok, _, _ := lm.admitCards("w1", 1); !ok {
			t.Fatalf("card set %d refused", i)
		}
		clock.Advance(time.Second)
	}
	if ok, at, cause := lm.admitCards("w1", 1); ok || cause != causeWorkerCards || !at.Equal(t0.Add(time.Minute)) {
		t.Fatalf("fourth card set: %v %v %s", ok, at, cause)
	}
	// 4 sent; w2's alert and an ask's 4 cards: 9; 2 more do not fit.
	if ok, _, _ := lm.admitAlert("w2"); !ok {
		t.Fatal("w2's alert refused")
	}
	if ok, _, _ := lm.admitCards("w2", 4); !ok {
		t.Fatal("w2's four cards refused")
	}
	if ok, at, cause := lm.admitCards("w3", 2); ok || cause != causeBudget || !at.Equal(t0.Add(time.Minute)) {
		t.Fatalf("w3's two cards: %v %v %s", ok, at, cause)
	}
	if ok, _, _ := lm.admitAlert("w3"); !ok {
		t.Fatal("the tenth message refused")
	}
	if ok, _, cause := lm.admitAlert("w4"); ok || cause != causeBudget {
		t.Fatalf("the eleventh: %v %s", ok, cause)
	}
	clock.Advance(time.Minute)
	if ok, _, _ := lm.admitCards("w3", 2); !ok {
		t.Fatal("w3's two cards refused a minute on")
	}
	// A set larger than the whole budget goes alone.
	big := newLimiter(Limits{Unsolicited: 2}.withDefaults(), clock)
	if ok, _, _ := big.admitCards("w1", 4); !ok {
		t.Fatal("a set larger than the budget refused when alone")
	}
	if ok, _, _ := big.admitAlert("w2"); ok {
		t.Fatal("an alert after it fits")
	}
}

// limitsRig is a card rig on the bridge's budget (DefaultLimits).
func limitsRig(t *testing.T, a *answerer) *rig {
	t.Helper()
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		o.Answer, o.Limits = a.answer, DefaultLimits()
		o.Prompt = (&prompter{}).prompt
		st.Replies = true
	})
	waitListening(t, r.ch)
	return r
}

// settle waits until the service is idle: nothing sent, shown or queued
// for a while.
func (r *rig) settle(t *testing.T) {
	t.Helper()
	state := func() string {
		r.svc.rp.mu.Lock()
		jobs := len(r.svc.rp.jobs)
		r.svc.rp.mu.Unlock()
		r.svc.obsMu.Lock()
		obs := len(r.svc.obs)
		r.svc.obsMu.Unlock()
		return fmt.Sprint(len(r.ch.Sent()), len(r.ch.Cards()), r.ch.Edits(), jobs, obs, len(r.svc.queue), r.clock.Waiting())
	}
	last, same := state(), 0
	for deadline := time.Now().Add(5 * time.Second); same < 3; {
		if time.Now().After(deadline) {
			t.Fatal("the service does not settle")
		}
		time.Sleep(5 * time.Millisecond)
		if s := state(); s == last {
			same++
		} else {
			last, same = s, 0
		}
	}
}

// pass moves the clock d on, a second at a time, the service settling
// after each.
func (r *rig) pass(t *testing.T, d time.Duration) {
	t.Helper()
	for step := min(d, time.Second); d > 0; d -= step {
		r.clock.Advance(min(step, d))
		r.settle(t)
	}
}

// messages are the messages sent (alerts and cards) of worker name's.
func (r *rig) messages(name string) (alerts, cards int) {
	for _, n := range r.ch.Sent() {
		if n.Name == name {
			alerts++
		}
	}
	for _, ref := range r.ch.Cards() {
		if strings.HasPrefix(r.ch.Card(ref).Text, name+" · ") {
			cards++
		}
	}
	return alerts, cards
}

func limitRows(r *rig) []limitAudit {
	var out []limitAudit
	for _, row := range rowsOf(r, AuditLimit) {
		out = append(out, row.args.(limitAudit))
	}
	return out
}

func named(o Observation, name string) Observation {
	o.Name = name
	return o
}

// #106 (the notify side of the issue's reproduction, ported): a worker's
// card open, then nine other operations of its blocked spell at one
// instant: WorkerCards cards in all (paced: the burst's five calls at
// once, one a second after), each replacing the one before, the last
// saying its next one follows; the rest coalesced, the latest parked. A
// minute on, that latest one's card, once; never the ones it replaced. One
// notify.limit row says so, without a text.
func TestBudgetDistinctOps(t *testing.T) {
	a := &answerer{}
	r := limitsRig(t, a)
	r.menuCard(t, "w1", 100, opMenu(fmt.Sprintf("%016x", 0), "op-0", "touch 0"))
	for i := 1; i < 10; i++ {
		r.svc.Observe(menuOn("w1", 100, opMenu(fmt.Sprintf("%016x", i), fmt.Sprintf("op-%d", i), fmt.Sprintf("touch %d", i))))
	}
	r.settle(t)
	if n := len(r.ch.Sent()) + len(r.ch.Cards()) + r.ch.Edits(); n > DefaultLimits().Burst {
		t.Fatalf("%d calls at one instant", n)
	}
	r.pass(t, 5*time.Second)
	if alerts, cards := r.messages("Pixel"); alerts != 1 || cards != 3 {
		t.Fatalf("%d alerts, %d cards", alerts, cards)
	}
	refs := r.ch.Cards()
	for _, ref := range refs[:2] {
		if c := r.ch.Card(ref); !strings.Contains(c.Text, CardReplacedText) || strings.Contains(c.Text, CardNextText) || len(c.Buttons) != 0 {
			t.Fatalf("card %+v", c)
		}
	}
	if c := r.ch.Card(refs[2]); !strings.Contains(c.Text, CardReplacedText+"\n"+CardNextText) {
		t.Fatalf("third card %+v", c)
	}
	r.pass(t, time.Minute-5*time.Second)
	if alerts, cards := r.messages("Pixel"); alerts != 1 || cards != 4 {
		t.Fatalf("a minute on: %d alerts, %d cards", alerts, cards)
	}
	last := r.ch.Card(r.ch.Cards()[3])
	if !strings.Contains(last.Text, "touch 9") || len(last.Buttons) != 3 {
		t.Fatalf("the latest card %+v", last)
	}
	for i := 3; i < 9; i++ {
		for _, ref := range r.ch.Cards() {
			if strings.Contains(r.ch.Card(ref).Text, fmt.Sprintf("touch %d\n", i)) {
				t.Fatalf("a card for op %d", i)
			}
		}
	}
	if rows := limitRows(r); len(rows) != 1 || rows[0] != (limitAudit{ID: "w1", Kind: "cards", Cause: causeWorkerCards, Coalesced: 6, Outcome: "sent"}) {
		t.Fatalf("limit rows %+v", rows)
	}
}

// burst plays a worker's blocked spell whose screen changes every 2 s,
// frames times; distinct: another operation each time, else the same one
// redrawn. It returns the messages the worker got by the end, and the
// most within any minute.
func (r *rig) burst(t *testing.T, id, name string, frames int, distinct bool) (total, minute int) {
	t.Helper()
	r.svc.Observe(named(working(id), name))
	var at []time.Time
	seen := 0
	count := func() {
		alerts, cards := r.messages(name)
		for ; seen < alerts+cards; seen++ {
			at = append(at, r.clock.Now())
		}
	}
	for i := range frames {
		op := 0
		if distinct {
			op = i
		}
		r.svc.Observe(named(menuOn(id, 100, opMenu(fmt.Sprintf("%016x", i), fmt.Sprintf("%s-op-%d", id, op), fmt.Sprintf("rm -f $D/* (%ds)", 2*i))), name))
		r.settle(t)
		count()
		r.pass(t, 2*time.Second)
		count()
	}
	for i := range at {
		n := 0
		for j := i; j < len(at) && at[j].Sub(at[i]) < time.Minute; j++ {
			n++
		}
		minute = max(minute, n)
	}
	return len(at), minute
}

// #106 acceptance: both recorded bursts (28 screen changes in 52 s, 10 in
// 16 s, every 2 s) stay within the budget even when each change is another
// operation (a new hash each time: no identity saves them); one operation
// redrawn is one alert and one card.
func TestBudgetRecordedBursts(t *testing.T) {
	for _, tc := range []struct {
		frames   int
		distinct bool
		max      int
	}{{28, true, 4}, {10, true, 4}, {28, false, 2}, {10, false, 2}} {
		t.Run(fmt.Sprintf("%d frames, distinct %v", tc.frames, tc.distinct), func(t *testing.T) {
			r := limitsRig(t, &answerer{})
			total, minute := r.burst(t, "w1", "Blip", tc.frames, tc.distinct)
			t.Logf("%d messages, at most %d within a minute", total, minute)
			if minute > tc.max || minute > DefaultLimits().Unsolicited || (!tc.distinct && total != 2) {
				t.Fatalf("%d messages, %d within a minute", total, minute)
			}
		})
	}
}

// #106: six workers blocked at once: every one's alert goes first (paced),
// then cards up to the budget; the rest wait for it and go a minute on,
// none starved, never more than Unsolicited within the minute.
func TestBudgetConcurrentWorkers(t *testing.T) {
	r := limitsRig(t, &answerer{})
	for i := range 6 {
		id := fmt.Sprintf("w%d", i)
		r.svc.Observe(named(working(id), "N"+id))
		r.svc.Observe(named(menuOn(id, 100, opMenu(fmt.Sprintf("%016x", i), "op-"+id, "touch "+id)), "N"+id))
	}
	r.settle(t)
	r.pass(t, 10*time.Second)
	if n := len(r.ch.Sent()) + len(r.ch.Cards()); n != DefaultLimits().Unsolicited || len(r.ch.Sent()) != 6 {
		t.Fatalf("%d alerts, %d cards", len(r.ch.Sent()), len(r.ch.Cards()))
	}
	r.pass(t, time.Minute-10*time.Second)
	for i := range 6 {
		if alerts, cards := r.messages(fmt.Sprintf("Nw%d", i)); alerts != 1 || cards != 1 {
			t.Fatalf("w%d: %d alerts, %d cards", i, alerts, cards)
		}
	}
}

// #106: a worker blocked again 30 s after its first alert: no second alert
// within the minute, but the new menu's card goes at once (the cooldown is
// the alert's); the alert parked goes at the minute if it still waits, and
// is dropped if it does not.
func TestBudgetCooldownTwoSpells(t *testing.T) {
	r := limitsRig(t, &answerer{})
	r.svc.Observe(working("w1"))
	r.svc.Observe(menuOn("w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a")))
	r.settle(t)
	r.pass(t, 10*time.Second)
	r.svc.Observe(working("w1"))
	r.pass(t, 20*time.Second)
	r.svc.Observe(menuOn("w1", 200, opMenu("bbbbbbbbbbbbbbbb", "op-b", "touch b")))
	r.settle(t)
	if alerts, cards := r.messages("Pixel"); alerts != 1 || cards != 2 {
		t.Fatalf("%d alerts, %d cards", alerts, cards)
	}
	r.pass(t, 30*time.Second)
	if alerts, _ := r.messages("Pixel"); alerts != 2 {
		t.Fatalf("%d alerts a minute on", alerts)
	}
	// Again, answered before the minute: the parked alert is dropped.
	r.svc.Observe(working("w1"))
	r.pass(t, 5*time.Second)
	r.svc.Observe(menuOn("w1", 300, opMenu("cccccccccccccccc", "op-c", "touch c")))
	r.settle(t)
	r.svc.Observe(working("w1"))
	r.pass(t, time.Minute)
	if alerts, _ := r.messages("Pixel"); alerts != 2 {
		t.Fatalf("%d alerts: a parked one went after its spell ended", alerts)
	}
	rows := limitRows(r)
	if len(rows) != 2 || rows[0].Outcome != "sent" || rows[0].Cause != causeCooldown || rows[1].Outcome != "dropped" {
		t.Fatalf("limit rows %+v", rows)
	}
}

// #106: an ask's four cards go with its alert, at once, under the budget.
func TestBudgetMultiQuestionAsk(t *testing.T) {
	a := &answerer{}
	r := limitsRig(t, a)
	ask := dbAsk("toolu_4", false, false)
	ask.Questions = append(ask.Questions, ask.Questions[0], ask.Questions[0], ask.Questions[0])
	refs := r.cardsFor(t, "w1", asking("w1", ask), 4)
	if len(refs) != 4 || len(r.ch.Sent()) != 1 {
		t.Fatalf("%d cards, %d alerts", len(refs), len(r.ch.Sent()))
	}
}

// #106: a rate limit's retry_after pauses the destination: the card due
// after the alert waits it out (the retry too), a tap's answer does not.
func TestBudgetRateLimitPausesTheDestination(t *testing.T) {
	a := &answerer{}
	r := limitsRig(t, a)
	ref := r.menuCard(t, "w0", 50, opMenu("0000000000000000", "op-0", "touch 0"))
	var fails atomic.Int32
	r.ch.mu.Lock()
	r.ch.SendErr = func(_ context.Context, n int) error {
		if fails.Add(1) == 1 {
			return &SendError{Code: CodeRateLimited, Status: 429, RetryAfter: 10 * time.Second}
		}
		return nil
	}
	r.ch.mu.Unlock()
	r.svc.Observe(working("w1"))
	r.svc.Observe(menuOn("w1", 100, opMenu("aaaaaaaaaaaaaaaa", "op-a", "touch a")))
	r.settle(t)
	if len(r.ch.Cards()) != 1 || len(r.ch.Sent()) != 2 {
		t.Fatalf("%d cards, %d sends", len(r.ch.Cards()), len(r.ch.Sent()))
	}
	id := r.tap(t, ref, button(t, r.ch.Card(ref), "3.").Data)
	if got := r.tapAnswer(t, id); got != tapSendingText {
		t.Fatalf("tap answered %q while paused", got)
	}
	r.pass(t, 9*time.Second)
	if len(r.ch.Cards()) != 1 || len(r.ch.Sent()) != 2 {
		t.Fatalf("within the pause: %d cards, %d sends", len(r.ch.Cards()), len(r.ch.Sent()))
	}
	r.pass(t, 2*time.Second)
	if alerts, cards := r.messages("Pixel"); alerts < 2 || cards != 2 {
		t.Fatalf("after the pause: %d alerts, %d cards", alerts, cards)
	}
}

// #106: a restart (a new service on the same store and channel) with
// workers blocked, their alerts and cards sent before: nothing is sent
// again, nothing waits.
func TestBudgetRestartReplaysNothing(t *testing.T) {
	r := limitsRig(t, &answerer{})
	for i := range 3 {
		id := fmt.Sprintf("w%d", i)
		r.svc.Observe(working(id))
		r.svc.Observe(menuOn(id, 100, opMenu(fmt.Sprintf("%016x", i), fmt.Sprintf("op-%d", i), "touch")))
		r.pass(t, 2*time.Second)
	}
	sent, cards := len(r.ch.Sent()), len(r.ch.Cards())
	if sent != 3 || cards != 3 {
		t.Fatalf("before: %d sends, %d cards", sent, cards)
	}
	svc, err := New(context.Background(), Options{Store: r.store, Channel: r.ch, Clock: r.clock, Answer: (&answerer{}).answer})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.Run(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	for i := range 3 {
		svc.Observe(menuOn(fmt.Sprintf("w%d", i), 100, opMenu(fmt.Sprintf("%016x", i), fmt.Sprintf("op-%d", i), "touch")))
	}
	time.Sleep(50 * time.Millisecond)
	r.clock.Advance(2 * time.Minute)
	time.Sleep(50 * time.Millisecond)
	if len(r.ch.Sent()) != sent || len(r.ch.Cards()) != cards || len(svc.parked) != 0 {
		t.Fatalf("%d sends, %d cards after the restart", len(r.ch.Sent())-sent, len(r.ch.Cards())-cards)
	}
}
