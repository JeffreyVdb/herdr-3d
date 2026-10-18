package notify

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

type auditRow struct {
	cmd  string
	args any
	err  error
}

type rig struct {
	svc   *Service
	ch    *FakeChannel
	clock *FakeClock
	store *FakeStore

	mu     sync.Mutex
	audits []auditRow
}

func (r *rig) rows() []auditRow {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]auditRow(nil), r.audits...)
}

// newRig is a service on a fake channel and clock, switched on (unless
// off), its loop running.
func newRig(t *testing.T, on bool) *rig { return newRigWith(t, on, nil) }

// newRigWith is newRig with its options (and stored settings) tweaked.
func newRigWith(t *testing.T, on bool, tweak func(*Options, *Settings)) *rig {
	t.Helper()
	r := &rig{ch: NewFakeChannel(true), clock: NewFakeClock(t0), store: NewFakeStore()}
	st := DefaultSettings()
	st.Enabled = on
	opts := Options{Store: r.store, Channel: r.ch, Clock: r.clock, Limits: NoLimits(), // #106: limitsRig's tests have them
		Audit: func(_ context.Context, cmd string, args any, err error) {
			r.mu.Lock()
			r.audits = append(r.audits, auditRow{cmd, args, err})
			r.mu.Unlock()
		}}
	if tweak != nil {
		tweak(&opts, &st)
	}
	if on || st != DefaultSettings() {
		r.store.set = &st
	}
	svc, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	r.svc = svc
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return r
}

func working(id string) Observation {
	return Observation{Worker: Worker{ID: id, Status: "working", StatusSince: 1}, Name: "Pixel"}
}

func doneObs(id string, since int64) Observation {
	return Observation{Worker: Worker{ID: id, Status: "done", StatusSince: since}, Name: "Pixel", Line: "Opened PR #12"}
}

func blocked(id string, since int64) Observation {
	return Observation{Worker: Worker{ID: id, Status: "blocked", StatusSince: since}, Name: "Pixel", Line: "Allow edit?"}
}

// settle waits until the loop took what was observed (it arms a timer, or
// nothing is left).
func (r *rig) waitTimer(t *testing.T, n int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !r.clock.WaitFor(ctx, n) {
		t.Fatalf("no timer armed (want %d, have %d)", n, r.clock.Waiting())
	}
}

func TestNeedsYouNotifiesAtOnce(t *testing.T) {
	r := newRig(t, true)
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("needs you was not sent")
	}
	n := r.ch.Sent()[0]
	if n.Name != "Pixel" || n.Reason != ReasonNeedsYou || n.Line != "Allow edit?" {
		t.Fatalf("sent %+v", n)
	}
	if got := n.Text(); got != "Pixel · Needs you\nAllow edit?" {
		t.Fatalf("text %q", got)
	}
	r.svc.Observe(blocked("a", 10)) // the same episode
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	if r.ch.WaitSent(2, 200*time.Millisecond) {
		t.Fatalf("one episode sent twice: %+v", r.ch.Sent())
	}
	rows := r.rows()
	if len(rows) != 1 || rows[0].cmd != AuditSend || rows[0].err != nil {
		t.Fatalf("audit %+v", rows)
	}
	if a := rows[0].args.(sendAudit); a.ID != "a" || a.Kind != "needs_you" || a.Attempts != 1 {
		t.Fatalf("audit args %+v", a)
	}
}

func TestDoneSettlesFiveSeconds(t *testing.T) {
	r := newRig(t, true)
	r.svc.Observe(working("a"))
	r.svc.Observe(doneObs("a", 10))
	r.waitTimer(t, 1)
	r.clock.Advance(4900 * time.Millisecond)
	if len(r.ch.Sent()) != 0 {
		t.Fatal("done sent before it settled")
	}
	r.waitTimer(t, 1)
	r.clock.Advance(100 * time.Millisecond)
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("done was not sent after 5 s")
	}
	if n := r.ch.Sent()[0]; n.Reason != ReasonFinished || n.Line != "Opened PR #12" {
		t.Fatalf("sent %+v", n)
	}
}

func TestDoneCancelledWhenItLeaves(t *testing.T) {
	r := newRig(t, true)
	r.svc.Observe(working("a"))
	r.svc.Observe(doneObs("a", 10))
	r.waitTimer(t, 1)
	r.clock.Advance(2 * time.Second)
	r.svc.Observe(working("a"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for r.clock.Waiting() != 0 && ctx.Err() == nil {
		time.Sleep(time.Millisecond)
	}
	r.clock.Advance(time.Minute)
	if r.ch.WaitSent(1, 200*time.Millisecond) {
		t.Fatalf("a done that left was sent: %+v", r.ch.Sent())
	}
}

func TestNoBurstOnStart(t *testing.T) {
	r := newRig(t, true)
	// What the bridge sees first is known: workers already waiting on you.
	r.svc.Observe(blocked("a", 10))
	r.svc.Observe(doneObs("b", 10))
	r.clock.Advance(time.Minute)
	if r.ch.WaitSent(1, 200*time.Millisecond) {
		t.Fatalf("stale alerts on start: %+v", r.ch.Sent())
	}
	if r.clock.Waiting() != 0 {
		t.Fatal("a known done is settling")
	}
}

func TestDisabledSendsNothing(t *testing.T) {
	r := newRig(t, false)
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	r.svc.Observe(working("b"))
	r.svc.Observe(doneObs("b", 10))
	r.clock.Advance(time.Minute)
	if r.ch.WaitSent(1, 200*time.Millisecond) {
		t.Fatalf("disabled but sent: %+v", r.ch.Sent())
	}
	// Switched on later: what happened meanwhile is known, not sent.
	st := DefaultSettings()
	st.Enabled = true
	r.store.set = &st
	r.svc.mu.Lock()
	r.svc.set = st
	r.svc.mu.Unlock()
	r.svc.Observe(blocked("a", 10))
	if r.ch.WaitSent(1, 200*time.Millisecond) {
		t.Fatal("an episode of while it was off was sent")
	}
	r.svc.Observe(blocked("a", 20))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("a new episode after switching on was not sent")
	}
}

func TestEventsOffAndFreelancers(t *testing.T) {
	r := newRig(t, true)
	off := false
	if err := r.svc.Apply(context.Background(), Update{Done: &off}); err != nil {
		t.Fatal(err)
	}
	r.svc.Observe(working("a"))
	r.svc.Observe(doneObs("a", 10))
	// A freelancer's done: not listed by default.
	fl := doneObs("f", 10)
	fl.Worker.Role = "code"
	r.svc.Observe(working("f"))
	r.svc.Observe(fl)
	r.clock.Advance(time.Minute)
	if r.ch.WaitSent(1, 200*time.Millisecond) {
		t.Fatalf("an event switched off was sent: %+v", r.ch.Sent())
	}
	on := true
	if err := r.svc.Apply(context.Background(), Update{Done: &on, Freelancers: &on}); err != nil {
		t.Fatal(err)
	}
	fl.Worker.StatusSince = 20
	r.svc.Observe(fl)
	r.waitTimer(t, 1)
	r.clock.Advance(5 * time.Second)
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("a freelancer's done was not sent with freelancers on")
	}
}

func TestAsleepFloorNeverNotifiesAndKeepsItsEpisodes(t *testing.T) {
	r := newRig(t, true)
	r.svc.Observe(working("a"))
	asleep := blocked("a", 10)
	asleep.Worker.Asleep = true
	r.svc.Observe(asleep)
	r.svc.Observe(blocked("a", 10)) // it wakes, the same episode
	if r.ch.WaitSent(1, 200*time.Millisecond) {
		t.Fatalf("an asleep floor's episode was sent: %+v", r.ch.Sent())
	}
}

func TestEnableGates(t *testing.T) {
	ctx := context.Background()
	r := newRig(t, false)
	on := true
	r.ch.SetState(ChannelState{Provider: "fake"})
	if err := r.svc.Apply(ctx, Update{Enabled: &on}); CodeOf(err) != CodeNotConfigured {
		t.Fatalf("no token: %v", err)
	}
	r.ch.SetState(ChannelState{Provider: "fake", KeySet: true, KeyHint: "abcd"})
	if err := r.svc.Apply(ctx, Update{Enabled: &on}); CodeOf(err) != CodeNotPaired {
		t.Fatalf("not paired: %v", err)
	}
	if _, err := r.svc.Test(ctx); CodeOf(err) != CodeNotPaired {
		t.Fatalf("test unpaired: %v", err)
	}
	r.ch.CompletePairing("Ada")
	if err := r.svc.Apply(ctx, Update{Enabled: &on}); CodeOf(err) != CodeTestRequired {
		t.Fatalf("untested: %v", err)
	}
	res, err := r.svc.Test(ctx)
	if err != nil || !res.OK {
		t.Fatalf("test: %v %v", res, err)
	}
	if got := r.ch.Sent(); len(got) != 1 || !got[0].Test {
		t.Fatalf("test sent %+v", got)
	}
	if !r.svc.View().Tested {
		t.Fatal("not tested after a passing test")
	}
	// Another recipient: the test no longer covers it.
	r.ch.CompletePairing("Bob")
	if err := r.svc.Apply(ctx, Update{Enabled: &on}); CodeOf(err) != CodeTestRequired {
		t.Fatalf("test of another recipient: %v", err)
	}
	if _, err := r.svc.Test(ctx); err != nil {
		t.Fatal(err)
	}
	// It expires.
	r.clock.Advance(31 * time.Minute)
	if err := r.svc.Apply(ctx, Update{Enabled: &on}); CodeOf(err) != CodeTestRequired {
		t.Fatalf("expired test: %v", err)
	}
	if _, err := r.svc.Test(ctx); err != nil {
		t.Fatal(err)
	}
	if err := r.svc.Apply(ctx, Update{Enabled: &on}); err != nil {
		t.Fatal(err)
	}
	if v := r.svc.View(); !v.Enabled || v.State != StateReady || r.store.set == nil || !r.store.set.Enabled {
		t.Fatalf("view %+v", v)
	}
}

func TestEnvLocked(t *testing.T) {
	on, off := true, false
	svc, err := New(context.Background(), Options{Channel: NewFakeChannel(false), EnvEnabled: &on, Clock: NewFakeClock(t0)})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Apply(context.Background(), Update{Enabled: &off}); CodeOf(err) != CodeEnvLocked {
		t.Fatalf("env: %v", err)
	}
	v := svc.View()
	if !v.Enabled || v.State != StateIncomplete || len(v.Env) != 1 || v.Env[0] != "enabled" {
		t.Fatalf("view %+v", v)
	}
	if len(v.Missing) != 2 {
		t.Fatalf("missing %v", v.Missing)
	}
}

func TestRateLimitHonoursRetryAfter(t *testing.T) {
	r := newRig(t, true)
	r.ch.SendErr = func(_ context.Context, n int) error {
		if n == 0 {
			return &SendError{Code: CodeRateLimited, Status: 429, RetryAfter: 3 * time.Second, Msg: "Too Many Requests: retry after 3"}
		}
		return nil
	}
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	if !r.ch.WaitSent(1, 5*time.Second) {
		t.Fatal("no first attempt")
	}
	r.waitTimer(t, 1)
	r.clock.Advance(2900 * time.Millisecond)
	if len(r.ch.Sent()) != 1 {
		t.Fatal("retried before retry_after")
	}
	r.clock.Advance(100 * time.Millisecond)
	if !r.ch.WaitSent(2, 5*time.Second) {
		t.Fatal("not retried after retry_after")
	}
	waitRows(t, r, 1)
	if a := r.rows()[0].args.(sendAudit); a.Attempts != 2 || r.rows()[0].err != nil {
		t.Fatalf("audit %+v %v", a, r.rows()[0].err)
	}
}

func TestServerErrorsBackOffThenGiveUp(t *testing.T) {
	r := newRig(t, true)
	r.ch.SendErr = func(context.Context, int) error {
		return &SendError{Code: CodeFailed, Status: 502, Msg: "Bad Gateway"}
	}
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	for i, wait := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		if !r.ch.WaitSent(i+1, 5*time.Second) {
			t.Fatalf("attempt %d missing", i+1)
		}
		r.waitTimer(t, 1)
		r.clock.Advance(wait - time.Millisecond)
		if len(r.ch.Sent()) != i+1 {
			t.Fatalf("attempt %d came before its backoff", i+2)
		}
		r.clock.Advance(time.Millisecond)
	}
	if !r.ch.WaitSent(MaxAttempts, 5*time.Second) {
		t.Fatal("not all attempts")
	}
	waitRows(t, r, 1)
	row := r.rows()[0]
	if a := row.args.(sendAudit); a.Attempts != MaxAttempts || a.Status != 502 || a.Code != CodeFailed || row.err == nil {
		t.Fatalf("audit %+v %v", a, row.err)
	}
	if v := r.svc.View(); v.LastError == nil || v.LastError.Code != CodeFailed {
		t.Fatalf("last error %+v", v.LastError)
	}
}

func TestBlockedIsAStateAndNotRetried(t *testing.T) {
	r := newRig(t, true)
	r.ch.SendErr = func(context.Context, int) error {
		return &SendError{Code: CodeBlocked, Status: 403, Msg: "Telegram refused: the bot was blocked by the user"}
	}
	r.svc.Observe(working("a"))
	r.svc.Observe(blocked("a", 10))
	waitRows(t, r, 1)
	if len(r.ch.Sent()) != 1 {
		t.Fatalf("a 403 was retried: %d", len(r.ch.Sent()))
	}
	if v := r.svc.View(); v.State != StateBlocked {
		t.Fatalf("state %q", v.State)
	}
}

func TestObserveNeverBlocks(t *testing.T) {
	r := newRig(t, true)
	hang := make(chan struct{})
	defer close(hang)
	r.ch.SendErr = func(ctx context.Context, _ int) error {
		select {
		case <-hang:
		case <-ctx.Done():
		}
		return errors.New("hung")
	}
	start := time.Now()
	for i := range 20_000 {
		r.svc.Observe(working("a"))
		r.svc.Observe(blocked("a", int64(i+1)))
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Observe took %v with the provider hanging", d)
	}
}

func waitRows(t *testing.T, r *rig, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(r.rows()) < n {
		if time.Now().After(deadline) {
			t.Fatalf("audit rows %d, want %d", len(r.rows()), n)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestPairAudited(t *testing.T) {
	r := newRig(t, true)
	if err := r.svc.StartPairing(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Run hands the channel its reporter: wait for it.
	deadline := time.Now().Add(5 * time.Second)
	for {
		r.ch.mu.Lock()
		ok := r.ch.hooks.Pair != nil
		r.ch.mu.Unlock()
		if ok || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	r.ch.CompletePairing("Ada")
	waitRows(t, r, 1)
	row := r.rows()[0]
	if row.cmd != AuditPair || row.err != nil || row.args.(pairAudit).Outcome != PairedOK {
		t.Fatalf("pair audit %+v", row)
	}
}

func TestTextClipsTheLine(t *testing.T) {
	long := ""
	for range 300 {
		long += "x"
	}
	n := Notification{Name: "Pixel", Reason: ReasonFinished, Line: "  a\n\tb  " + long}
	got := n.Text()
	if want := "Pixel · Finished\na b "; got[:len(want)] != want {
		t.Fatalf("text %q", got)
	}
	if r := []rune(got[len("Pixel · Finished\n"):]); len(r) != LineMax {
		t.Fatalf("line of %d runes", len(r))
	}
	if (Notification{Name: "Pixel", Reason: ReasonQuestion}).Text() != "Pixel · Question" {
		t.Fatal("an empty line adds a line")
	}
}
