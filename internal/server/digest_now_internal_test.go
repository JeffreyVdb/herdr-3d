package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// #198: the now line follows the worker's recent steps, not only its turn
// ends: a first view during a long first turn gets one, a long turn gets a
// newer one once the worker's gap is over, the same steps are never sent
// twice, and failures back off and stop.

// dgMid is a tracker's digest in the middle of a turn: steps read, ended
// turns as given, no prompt (no task line to write), the recent steps' texts.
func dgMid(ended int, recent ...string) *transcript.Digest {
	d := &transcript.Digest{Steps: len(recent), Ended: ended}
	for _, r := range recent {
		d.Recent = append(d.Recent, transcript.DigestStep{Texts: []string{r}, Tools: []transcript.DigestTool{{Name: "Bash", Summary: "go test ./..."}}})
	}
	return d
}

// nowCalls are the LLM's now requests.
func nowCalls(llm *ai.FakeLLM) []ai.Request {
	var out []ai.Request
	for _, c := range llm.Calls() {
		if !strings.Contains(c.Messages[0].Content, "label the task") {
			out = append(out, c)
		}
	}
	return out
}

// view puts a new client on floor "s" (standsOn, as board.watch does).
func view(ctx context.Context, h *Hub) *Client {
	c := &Client{send: make(chan []byte, 1024)}
	h.clients[c] = struct{}{}
	h.standsOn(ctx, c, "s")
	return c
}

// fire runs the pump as an armed wake does when its time came (the fake
// clock moves no timer).
func fire(ctx context.Context, h *Hub) {
	h.dgs.wake = time.Time{}
	h.pumpDigest(ctx)
}

// noOp fails when the hub was handed an operation (a call went).
func noOp(t *testing.T, h *Hub) {
	t.Helper()
	select {
	case <-h.ops:
		t.Fatal("a call went")
	case <-time.After(30 * time.Millisecond):
	}
	if h.dgs.inflight {
		t.Fatal("a call is in flight")
	}
}

// The issue's probe: a coder's first turn is still running (no turn ended)
// while nobody is on its floor; 17 minutes on, the first look writes its task
// line and then its now line, from the recent steps. A worker with no usable
// step keeps the honest fallback.
func TestDigestNowFirstViewDuringLongTurn(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, false)
	d := dgMid(0, "Reading the lift code", "Running the lift tests")
	d.Prompt, d.PromptHash = "Fix the lift doors.", "h1"
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: d})
	h.workers["q"] = &proto.Worker{ID: "q", Session: "s", Role: "code"}
	h.digestSeen(ctx, digestUpdate{id: "q", epoch: 2, digest: &transcript.Digest{Steps: 2, Recent: []transcript.DigestStep{{}, {}}}})
	noOp(t, h)
	if n := len(llm.Calls()); n != 0 {
		t.Fatalf("%d calls with nobody on the floor", n)
	}
	clock = clock.Add(17 * time.Minute)
	view(ctx, h)
	runOp(t, h) // the task line
	runOp(t, h) // the now line
	got := h.workers["w"].Digest
	if got == nil || got.NowSource != proto.DigestLLM || got.Now != "Reading the lift code" || got.NowAt != clock.UnixMilli() || got.NowStatus != nil {
		t.Fatalf("first view after 17 minutes: digest = %+v", got)
	}
	if c := nowCalls(llm); len(c) != 1 || !strings.Contains(c[0].Messages[1].Content, "Running the lift tests") {
		t.Fatalf("now calls = %+v", c)
	}
	noOp(t, h)
	if q := h.workers["q"].Digest; q == nil || q.NowSource != proto.DigestTitle || q.NowStatus != nil {
		t.Fatalf("no usable step: digest = %+v", q)
	}
}

// While the floor stays viewed, newer steps of the same long turn are
// summarized once the worker's gap is over, with no turn end and no settle;
// before it, nothing goes and the pump is woken for it. After a turn end the
// settle still applies.
func TestDigestNowLongTurnRefreshesAfterGap(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, true)
	h.opts.DigestSettle, h.opts.DigestGap = 2*time.Second, time.Minute
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	runOp(t, h)
	first := clock
	// New steps within the gap: no call, a wake at its end.
	clock = clock.Add(10 * time.Second)
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code", "Editing the door timer")})
	noOp(t, h)
	if want := first.Add(time.Minute); !h.dgs.wake.Equal(want) {
		t.Fatalf("wake = %v, want the gap's end %v", h.dgs.wake, want)
	}
	// The gap is over: the newer steps go at once (still no turn end).
	clock = first.Add(time.Minute)
	fire(ctx, h)
	runOp(t, h)
	c := nowCalls(llm)
	if len(c) != 2 || !strings.Contains(c[1].Messages[1].Content, "Editing the door timer") {
		t.Fatalf("now calls = %d", len(c))
	}
	if d := h.workers["w"].Digest; d.NowAt != clock.UnixMilli() {
		t.Fatalf("now_at = %d, want %d", d.NowAt, clock.UnixMilli())
	}
	// A turn ends after the next gap: its final message waits for the settle.
	clock = clock.Add(2 * time.Minute)
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(1, "Reading the lift code", "Editing the door timer", "Done: the doors close.")})
	noOp(t, h)
	if want := clock.Add(2 * time.Second); !h.dgs.wake.Equal(want) {
		t.Fatalf("wake = %v, want the settle's end %v", h.dgs.wake, want)
	}
	clock = clock.Add(2 * time.Second)
	fire(ctx, h)
	runOp(t, h)
	if c := nowCalls(llm); len(c) != 3 || !strings.Contains(c[2].Messages[1].Content, "Done: the doors close.") {
		t.Fatalf("now calls after the turn end = %d", len(c))
	}
}

// Unchanged steps cost nothing more: other viewers, a reconnect, repeated
// pumps, or only the task line changing (the context, not the activity).
// Several viewers at once make one call.
func TestDigestNowUnchangedStepsNoCall(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, false)
	h.opts.DigestGap = time.Minute
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	view(ctx, h)
	view(ctx, h) // a second viewer while the call is out
	h.pumpDigest(ctx)
	runOp(t, h)
	noOp(t, h)
	clock = clock.Add(time.Hour)
	view(ctx, h)
	h.pumpDigest(ctx)
	// The task line flips (the context of the input), the steps do not.
	h.workers["w"].Digest.Task = "Fix the lift doors"
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	noOp(t, h)
	if n := len(nowCalls(llm)); n != 1 {
		t.Fatalf("now calls = %d for one input", n)
	}
}

// Steps that come while a call is out are summarized after it, once the gap
// is over; the line of the older steps shows meanwhile.
func TestDigestNowActivityDuringCall(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, true)
	h.opts.DigestGap = time.Minute
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	if !h.dgs.inflight {
		t.Fatal("no call out")
	}
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code", "Editing the door timer")})
	runOp(t, h)
	if d := h.workers["w"].Digest; d.NowSource != proto.DigestLLM {
		t.Fatalf("digest = %+v", d)
	}
	noOp(t, h)
	if want := clock.Add(time.Minute); !h.dgs.wake.Equal(want) {
		t.Fatalf("wake = %v, want %v", h.dgs.wake, want)
	}
	clock = clock.Add(time.Minute)
	fire(ctx, h)
	runOp(t, h)
	if c := nowCalls(llm); len(c) != 2 || !strings.Contains(c[1].Messages[1].Content, "Editing the door timer") {
		t.Fatalf("now calls = %d", len(c))
	}
}

// Once the last viewer leaves nothing more goes; coming back writes the line
// of the latest steps, replacing the older one, without a turn end.
func TestDigestNowViewerLeavesAndReturns(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, false)
	h.opts.DigestGap = time.Minute
	c := view(ctx, h)
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	runOp(t, h)
	old := h.workers["w"].Digest.NowAt
	h.standsOn(ctx, c, "")
	for i := 0; i < 3; i++ {
		clock = clock.Add(5 * time.Minute)
		h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code", strings.Repeat("Editing ", i+1))})
		h.pumpDigest(ctx)
	}
	noOp(t, h)
	if n := len(nowCalls(llm)); n != 1 {
		t.Fatalf("now calls with nobody on the floor = %d", n)
	}
	view(ctx, h)
	runOp(t, h)
	cs := nowCalls(llm)
	if len(cs) != 2 || !strings.Contains(cs[1].Messages[1].Content, "Editing Editing Editing") {
		t.Fatalf("now calls on return = %d", len(cs))
	}
	if d := h.workers["w"].Digest; d.NowAt <= old || d.NowAt != clock.UnixMilli() {
		t.Fatalf("now_at %d, was %d", d.NowAt, old)
	}
}

// Failed now lines never loop: the same steps are not sent again by
// themselves; newer ones are, after the retry policy's delay (and the gap),
// until its attempts are used up; then a turn end, a manual retry or a reset
// starts the count again. The overview says what became of the line.
func TestDigestNowFailuresAreBounded(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, true)
	h.opts.DigestGap = time.Minute
	h.opts.DigestRetry = func(n int) (time.Duration, bool) { return 10 * time.Minute, n < 3 }
	broken := true
	llm.Func = func(context.Context, ai.Request) (string, error) {
		if broken {
			return "", &ai.Error{Kind: ai.KindTruncated, Msg: "cut off"}
		}
		return "Reading the lift code", nil
	}
	steps := []string{"Reading the lift code"}
	more := func() {
		steps = append(steps, "Step "+clock.Format("15:04"))
		h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, steps...)})
	}
	status := func() *proto.DigestLineStatus { return h.workers["w"].Digest.NowStatus }
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, steps...)})
	runOp(t, h)
	if s := status(); s == nil || s.State != proto.LineFailed || s.Reason != "truncated" || s.Attempts != 1 {
		t.Fatalf("after a failure: %+v", s)
	}
	// The same steps, later: nothing goes.
	failedAt := clock
	clock = failedAt.Add(5 * time.Minute)
	h.pumpDigest(ctx)
	noOp(t, h)
	// Newer steps within the retry delay: retrying, at the delay's end.
	more()
	noOp(t, h)
	if s := status(); s == nil || s.State != proto.LineRetrying || s.RetryAt != failedAt.Add(10*time.Minute).UnixMilli() || s.Attempts != 1 {
		t.Fatalf("newer steps in the delay: %+v", s)
	}
	clock = failedAt.Add(10 * time.Minute)
	fire(ctx, h)
	runOp(t, h) // attempt 2
	clock = clock.Add(time.Hour)
	more()
	runOp(t, h) // attempt 3: the last by itself
	if s := status(); s == nil || s.State != proto.LineFailed || s.Attempts != 3 {
		t.Fatalf("attempts used up: %+v", s)
	}
	clock = clock.Add(time.Hour)
	more()
	h.pumpDigest(ctx)
	noOp(t, h)
	if n := len(nowCalls(llm)); n != 3 {
		t.Fatalf("now calls = %d, want 3 and no more", n)
	}
	// A turn end starts the count again.
	h.opts.DigestSettle = 0
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(1, steps...)})
	runOp(t, h) // attempt 1 again
	if s := status(); s == nil || s.State != proto.LineFailed || s.Attempts != 1 {
		t.Fatalf("after a turn end: %+v", s)
	}
	// A manual retry sends the same steps again at once, and it works.
	broken = false
	if n := h.digestForgive("w"); n != 1 {
		t.Fatalf("forgiven = %d", n)
	}
	h.pumpDigest(ctx)
	runOp(t, h)
	if d := h.workers["w"].Digest; d.NowSource != proto.DigestLLM || d.NowStatus != nil {
		t.Fatalf("after the retry: %+v", d)
	}
	if n := len(nowCalls(llm)); n != 5 {
		t.Fatalf("now calls = %d", n)
	}
}

// A /clear (another reset) drops the model's line: nothing is summarized
// until the new session has steps of its own, and the gap still holds.
func TestDigestNowReset(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, llm := dgHubFor(t, &clock, true)
	h.opts.DigestGap = time.Minute
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	runOp(t, h)
	cleared := &transcript.Digest{Resets: 1}
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: cleared})
	noOp(t, h)
	if d := h.workers["w"].Digest; d != nil {
		t.Fatalf("after /clear: %+v", d)
	}
	d := dgMid(0, "Reading the stairs code")
	d.Resets = 1
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: d})
	noOp(t, h)
	if s := h.workers["w"].Digest.NowStatus; s == nil || s.State != proto.LinePending {
		t.Fatalf("status = %+v", s)
	}
	clock = clock.Add(time.Minute)
	fire(ctx, h)
	runOp(t, h)
	if c := nowCalls(llm); len(c) != 2 || !strings.Contains(c[1].Messages[1].Content, "stairs") {
		t.Fatalf("now calls = %d", len(c))
	}
}

// A call that could not go (busy) is no attempt: the steps stay due.
func TestDigestNowBusyIsNoAttempt(t *testing.T) {
	ctx := context.Background()
	clock := time.Date(2026, 10, 8, 10, 0, 0, 0, time.Local)
	h, _ := dgHubFor(t, &clock, true)
	h.digestSeen(ctx, digestUpdate{id: "w", epoch: 1, digest: dgMid(0, "Reading the lift code")})
	if !h.dgs.inflight {
		t.Fatal("no call out")
	}
	select {
	case <-h.ops: // the call's completion, dropped: it met a busy service instead
	case <-time.After(5 * time.Second):
		t.Fatal("no hub operation")
	}
	l := h.dgs.ws["w"]
	c := *h.dgs.flight
	h.digestDone(ctx, c, l.gen, digest.Result{}, digest.ErrBusy)
	if l.nowTried != "" || !l.callAt.IsZero() || l.nowFail != nil {
		t.Fatalf("after ErrBusy: %+v", *l)
	}
	if !h.dgs.inflight || h.dgs.flight == nil || h.dgs.flight.hash != l.nowKey {
		t.Fatal("the steps are not asked for again")
	}
	runOp(t, h)
	if l.nowTried != l.nowKey || l.now == "" {
		t.Fatalf("after the second go: %+v", *l)
	}
}
