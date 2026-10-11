package server_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #174: a failed task line is asked again with a bounded backoff, the
// overview says what became of it, and the failures are forgiven by a manual
// retry, a changed setting, a new prompt. Claude (w1) and Codex (w2).

// shortRetry is a retry policy of n attempts, d apart, for the tests.
func shortRetry(max int, d time.Duration) func(int) (time.Duration, bool) {
	return func(n int) (time.Duration, bool) { return d, n < max }
}

func startDgRetryBridge(t *testing.T, roles *dgRoles, gap time.Duration, retry func(int) (time.Duration, bool)) *fuBridge {
	t.Helper()
	if gap == 0 {
		gap = time.Hour
	}
	return startFuBridgeWith(t, "", "", newFuRoles(), nil, "", func(o *server.Options) {
		o.DigestRoles, o.DigestEnabled = roles, on()
		o.DigestSettle, o.DigestGap, o.DigestRetry = 40*time.Millisecond, gap, retry
	})
}

func isTaskRequest(r ai.Request) bool {
	return strings.Contains(r.Messages[0].Content, "label the task")
}

// failFirst makes the first call of each input of a kind (by what is sent)
// fail as the provider did in the ticket, after reporting its diagnostics.
func failFirst(roles *dgRoles, kind string, err error) {
	base := roles.llm.Func
	var mu sync.Mutex
	seen := map[string]int{}
	roles.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		if isTaskRequest(req) == (kind == digest.KindTask) {
			mu.Lock()
			seen[req.Messages[1].Content]++
			n := seen[req.Messages[1].Content]
			mu.Unlock()
			if n == 1 {
				eighty := 80
				req.Report(ai.Diagnostics{Status: 200, FinishReason: "length", CompletionTokens: &eighty, ReasoningTokens: &eighty, Content: ai.ContentEmpty})
				return "", err
			}
		}
		return base(ctx, req)
	}
}

func taskStatus(state string) func(*proto.Worker) bool {
	return func(w *proto.Worker) bool {
		return w.Digest != nil && w.Digest.TaskStatus != nil && w.Digest.TaskStatus.State == state
	}
}

// The ticket's scenario: the first task call answers bad_response (a 200 with
// no text), later ones succeed: the TASK line becomes the model's, on its own,
// after a bounded retry, for a Claude and a Codex worker alike. A line not
// yet written says why, and the failed call's diagnostics are audited.
func TestDigestTaskRecoversAfterAFailedFirstCall(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	failFirst(roles, digest.KindTask, &ai.Error{Kind: ai.KindBadResponse, Msg: "the answer has no text"})
	fb := startDgRetryBridge(t, roles, 0, shortRetry(3, 60*time.Millisecond))
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	fb.dgTurn(t, "codex", "digest_turns.jsonl")
	ids := []string{fb.ids["w1"], fb.ids["w2"]}

	// The failure is visible, with its reason and when the next attempt goes.
	failed := upsertsIn(c, nil, taskStatus(proto.LineRetrying), ids...)
	for id, w := range failed {
		st := w.Digest.TaskStatus
		if st.Reason != "bad_response" || st.Attempts != 1 || st.RetryAt == 0 || w.Digest.TaskSource == proto.DigestLLM || w.Digest.Task == "" {
			t.Fatalf("%s: digest %+v status %+v", id, w.Digest, st)
		}
	}
	// And then the line is the model's, the status gone.
	got := upsertsIn(c, nil, func(w *proto.Worker) bool {
		return w.Digest != nil && w.Digest.TaskSource == proto.DigestLLM && w.Digest.TaskStatus == nil
	}, ids...)
	for _, w := range got {
		if w.Digest.Task != dgTaskLine {
			t.Fatalf("digest %+v", w.Digest)
		}
	}
	fuQuiet()
	if n := len(roles.calls(digest.KindTask)); n != 4 {
		t.Fatalf("task calls = %d: two attempts per worker", n)
	}
	// The audit: the failed call has its kind and its diagnostics, no text.
	log, err := fb.bridge.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var failedRows, okRows int
	for _, e := range log {
		if e.Cmd != "digest.summarize" {
			continue
		}
		var a struct {
			Kind      string
			MaxTokens int `json:"max_tokens"`
			Diag      *ai.Diagnostics
		}
		if err := json.Unmarshal([]byte(e.Args), &a); err != nil {
			t.Fatal(err)
		}
		if a.MaxTokens != digest.DefaultMaxTokens {
			t.Fatalf("audit row max_tokens = %d: %s", a.MaxTokens, e.Args)
		}
		if e.OK {
			okRows++
			continue
		}
		failedRows++
		if e.Error != "bad_response" || a.Kind != digest.KindTask || a.Diag == nil || a.Diag.FinishReason != "length" || *a.Diag.ReasoningTokens != 80 || a.Diag.Content != ai.ContentEmpty {
			t.Fatalf("failed audit row = %+v", e)
		}
		for _, x := range []string{"the answer has no text", "lounge", "Hi."} {
			if strings.Contains(e.Args, x) {
				t.Fatalf("audit row holds %q: %s", x, e.Args)
			}
		}
	}
	if failedRows != 2 || okRows < 4 {
		t.Fatalf("audit rows: %d failed, %d ok", failedRows, okRows)
	}
}

// A model that never answers is asked a bounded number of times, no more, and
// the overview says it gave up; digest.retry starts the count again, and a
// new prompt does too.
func TestDigestTaskAttemptsAreBoundedAndManuallyRetried(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	var mu sync.Mutex
	broken := true
	base := roles.llm.Func
	roles.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		mu.Lock()
		b := broken
		mu.Unlock()
		if b && isTaskRequest(req) {
			return "", &ai.Error{Kind: ai.KindTruncated, Msg: "cut off"}
		}
		return base(ctx, req)
	}
	fb := startDgRetryBridge(t, roles, 0, shortRetry(3, 30*time.Millisecond))
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	w := upsertFor(c, fb.ids["w1"], taskStatus(proto.LineFailed))
	if st := w.Digest.TaskStatus; st.Reason != "truncated" || st.Attempts != 3 || st.RetryAt != 0 {
		t.Fatalf("status %+v", st)
	}
	fuQuiet()
	if n := len(roles.calls(digest.KindTask)); n != 3 {
		t.Fatalf("task calls = %d, want the 3 attempts and no storm", n)
	}

	// Nothing to retry for an unknown worker; the right one is tried again.
	c.mustError(proto.CmdDigestRetry, proto.DigestRetryArgs{ID: "nope"}, proto.ErrUnknownWorker)
	mu.Lock()
	broken = false
	mu.Unlock()
	_, ack := c.mustAck(proto.CmdDigestRetry, proto.DigestRetryArgs{ID: fb.ids["w1"]})
	if got := mustJSONString(t, ack.Data); got != `{"retried":1}` {
		t.Fatalf("retry ack = %s", got)
	}
	w = upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool {
		return w.Digest != nil && w.Digest.TaskSource == proto.DigestLLM && w.Digest.TaskStatus == nil
	})
	if w.Digest.Task != dgTaskLine {
		t.Fatalf("digest %+v", w.Digest)
	}
	if _, ack := c.mustAck(proto.CmdDigestRetry, proto.DigestRetryArgs{}); mustJSONString(t, ack.Data) != `{"retried":0}` {
		t.Fatalf("nothing failed any more: %v", ack.Data)
	}

	// A new prompt starts its own count: /clear, break the model, three more.
	mu.Lock()
	broken = true
	mu.Unlock()
	before := len(roles.calls(digest.KindTask))
	appendTo(t, fb.claude, `{"type":"system","subtype":"local_command","content":"","commandRun":{"command":"clear","args":""}}`+"\n"+wrapUser("Fix the elevator doors."))
	upsertFor(c, fb.ids["w1"], taskStatus(proto.LineFailed))
	if n := len(roles.calls(digest.KindTask)) - before; n != 3 {
		t.Fatalf("attempts of the new prompt = %d", n)
	}
}

// A call that could not go (the daily cap, the feature off) costs no attempt,
// and a changed setting or a passing test forgives the failures.
func TestDigestRetryRespectsCapOffAndSettings(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	failFirst(roles, digest.KindTask, &ai.Error{Kind: ai.KindEmpty, Msg: "no text"})
	fb := startDgRetryBridge(t, roles, 0, shortRetry(3, 80*time.Millisecond))
	c := fb.connect(proto.Hello{})
	c.snapshot()
	cp := 1
	c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{DailyCap: &cp})
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], taskStatus(proto.LineRetrying)) // the one call of the day failed
	// Due again, the day's budget is spent: it says so, and the attempt is not burnt.
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool {
		s := w.Digest.TaskStatus
		return s != nil && s.State == proto.LinePending && s.Reason == "daily_cap"
	})
	if w.Digest.TaskStatus.Attempts != 1 {
		t.Fatalf("status %+v", w.Digest.TaskStatus)
	}
	fuQuiet()
	if n := len(roles.calls(digest.KindTask)); n != 1 {
		t.Fatalf("calls past the cap: %d", n)
	}
	// A higher cap lets it go: the second attempt, the model's line.
	cp = 50
	c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{DailyCap: &cp})
	w = upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.TaskSource == proto.DigestLLM })
	if w.Digest.Task != dgTaskLine {
		t.Fatalf("digest %+v", w.Digest)
	}

	// Attempts used up (two); a changed budget forgives them and the line is written.
	roles2 := newDgRoles()
	failAlways := true
	var mu sync.Mutex
	base := roles2.llm.Func
	roles2.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		mu.Lock()
		f := failAlways
		mu.Unlock()
		if f && isTaskRequest(req) {
			return "", &ai.Error{Kind: ai.KindTruncated, Msg: "cut off"}
		}
		return base(ctx, req)
	}
	fb2 := startDgRetryBridge(t, roles2, 0, shortRetry(2, 30*time.Millisecond))
	c2 := fb2.connect(proto.Hello{})
	c2.snapshot()
	c2.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb2.dgTurn(t, "codex", "digest_turns.jsonl")
	upsertFor(c2, fb2.ids["w2"], taskStatus(proto.LineFailed))
	fuQuiet()
	if n := len(roles2.calls(digest.KindTask)); n != 4 { // two attempts each: w1's "Hi." and w2's prompt
		t.Fatalf("calls = %d", n)
	}
	mu.Lock()
	failAlways = false
	mu.Unlock()
	tokens := 2048
	evs, ack := c2.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{MaxTokens: &tokens})
	if got := mustJSONString(t, ack.Data); !strings.Contains(got, `"max_tokens":2048`) {
		t.Fatalf("ack %s", got)
	}
	w = upsertIn(c2, evs, fb2.ids["w2"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.TaskSource == proto.DigestLLM })
	if w.Digest.Task != dgTaskLine {
		t.Fatalf("a changed budget forgave nothing: %+v", w.Digest)
	}
	if last := roles2.calls(digest.KindTask); last[len(last)-1].MaxTokens != 2048 {
		t.Fatalf("the new budget was not sent: %d", last[len(last)-1].MaxTokens)
	}
}

// A now line that failed shows it (failed, with its reason) while a fallback
// is shown, and is asked for again after the next turn or a retry.
func TestDigestNowFailureAndRetry(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	failFirst(roles, digest.KindNow, &ai.Error{Kind: ai.KindTruncated, Msg: "cut off"})
	fb := startDgRetryBridge(t, roles, 0, nil)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool {
		return w.Digest != nil && w.Digest.NowStatus != nil && w.Digest.NowStatus.State == proto.LineFailed
	})
	if w.Digest.NowStatus.Reason != "truncated" || w.Digest.NowSource == proto.DigestLLM || w.Digest.TaskSource != proto.DigestLLM {
		t.Fatalf("digest %+v status %+v", w.Digest, w.Digest.NowStatus)
	}
	fuQuiet()
	if n := len(roles.calls(digest.KindNow)); n != 1 {
		t.Fatalf("now calls = %d: a failed now line waits for its turn", n)
	}
	_, ack := c.mustAck(proto.CmdDigestRetry, proto.DigestRetryArgs{})
	if got := mustJSONString(t, ack.Data); got != `{"retried":1}` {
		t.Fatalf("ack %s", got)
	}
	w = upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool {
		return w.Digest != nil && w.Digest.NowSource == proto.DigestLLM && w.Digest.NowStatus == nil
	})
	if w.Digest.Now != dgNowLine {
		t.Fatalf("digest %+v", w.Digest)
	}
}

// Retry is for a feature that is on: off, the bridge says there is nothing to
// retry.
func TestDigestRetryNeedsTheFeature(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	fb := startFuBridgeWith(t, "", "", newFuRoles(), nil, "", func(o *server.Options) {
		o.DigestRoles = roles
		o.DigestSettle, o.DigestGap = 40*time.Millisecond, time.Hour
	})
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustError(proto.CmdDigestRetry, proto.DigestRetryArgs{}, digest.CodeIncomplete)
}

// The effort and the budget set through the protocol reach the model's
// request; "" is the provider's default again; an effort the model's catalog
// does not list is refused.
func TestDigestReasoningSettingsThroughTheProtocol(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	roles.reason = &ai.Reasoning{Support: ai.SupportYes, Model: "gpt-6-luna", Efforts: []string{"none", "low", "medium", "high"}, Listed: true, Default: "medium"}
	fb := startDgBridge(t, "", "", roles, on(), 0)
	c := fb.connect(proto.Hello{})
	d := c.snapshot().World.Digest
	if d.MaxTokens != 1024 || d.ReasoningEffort != "" || d.Reasoning.Support != ai.SupportYes || d.EffortStale {
		t.Fatalf("snapshot digest = %+v", d)
	}
	for _, bad := range []proto.DigestSetArgs{
		{ReasoningEffort: strp("minimal")}, {ReasoningEffort: strp("bogus")}, {MaxTokens: intp(5)}, {MaxTokens: intp(1 << 20)},
	} {
		c.mustError(proto.CmdDigestSet, bad, proto.ErrBadRequest)
	}
	none, tokens := "none", 4000
	_, ack := c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{ReasoningEffort: &none, MaxTokens: &tokens})
	if got := mustJSONString(t, ack.Data); !strings.Contains(got, `"reasoning_effort":"none"`) || !strings.Contains(got, `"max_tokens":4000`) {
		t.Fatalf("ack %s", got)
	}
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], llmDigest)
	for _, r := range roles.llm.Calls() {
		if r.ReasoningEffort != "none" || r.MaxTokens != 4000 {
			t.Fatalf("request effort %q, max %d", r.ReasoningEffort, r.MaxTokens)
		}
	}
	// The provider's default again: nothing is sent.
	empty := ""
	c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{ReasoningEffort: &empty})
	fb.dgTurn(t, "codex", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w2"], llmDigest)
	calls := roles.llm.Calls()
	if last := calls[len(calls)-1]; last.ReasoningEffort != "" || last.MaxTokens != 4000 {
		t.Fatalf("request effort %q, max %d", last.ReasoningEffort, last.MaxTokens)
	}
}

func strp(s string) *string { return &s }
func intp(n int) *int       { return &n }

// An LLM that is not ready (an invalid key) makes no call and costs no
// attempt: once it is ready the line gets its first attempt.
func TestDigestNotReadyBurnsNoAttempt(t *testing.T) {
	t.Parallel()
	roles := newDgRoles()
	roles.set(ai.StateInvalid)
	fb := startDgRetryBridge(t, roles, 0, shortRetry(2, 30*time.Millisecond))
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.NowSource == proto.DigestTitle })
	if w.Digest.TaskStatus != nil || w.Digest.NowStatus != nil {
		t.Fatalf("not ready: no statuses: %+v", w.Digest)
	}
	fuQuiet()
	if n := len(roles.llm.Calls()); n != 0 {
		t.Fatalf("%d calls while not ready", n)
	}
}
