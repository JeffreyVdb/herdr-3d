package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #156: a shared Codex worker's async questions, against a fake floor and
// a fake join (fakeCodexWatch).

const asyncThread = "01a11172-ac09-7aa0-ab6b-84485199ada3"

var (
	colorQ   = codexapp.AsyncQuestion{Title: "Which fixture color?", Options: []string{"Green", "Blue"}}
	contextQ = codexapp.AsyncQuestion{Title: "Any context for the fixture?"}
)

// asyncWorker hires a shared worker at desk 1 (pane w1:p1), lets herdr
// report its thread, and waits until the bridge joined it. Its transcript
// is never opened.
func asyncWorker(t *testing.T) (*sharedBridge, proto.HireResult) {
	t.Helper()
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = asyncThread })
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Attached })
	return sb, a
}

// codexWorker waits until w1's codex view satisfies ok and returns it.
func (sb *sharedBridge) codexWorker(t *testing.T, ok func(*proto.WorkerCodex) bool) proto.WorkerCodex {
	t.Helper()
	w := workersOf(sb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && ok(x.Codex)
	}), "s")["w1"]
	return *w.Codex
}

// watch is the bridge's current join.
func (sb *sharedBridge) watch() *fakeCodexWatch {
	sb.host.mu.Lock()
	defer sb.host.mu.Unlock()
	return sb.host.watches[len(sb.host.watches)-1]
}

// emit delivers events from the current join.
func (sb *sharedBridge) emit(evs ...codexapp.Event) {
	w := sb.watch()
	for _, e := range evs {
		w.o.OnEvent(e)
	}
}

func (sb *sharedBridge) sent() []fakeSend {
	sb.host.mu.Lock()
	defer sb.host.mu.Unlock()
	return slices.Clone(sb.host.sends)
}

func note(method string, params map[string]any) codexapp.Event {
	params["threadId"] = asyncThread
	b, _ := json.Marshal(params)
	return codexapp.Event{Kind: codexapp.EvNotification, Method: method, Params: b}
}

func turnStarted(turn string) codexapp.Event {
	return note("turn/started", map[string]any{"turn": map[string]any{"id": turn, "status": "inProgress", "items": []any{}}})
}

func turnCompleted(turn string) codexapp.Event {
	return note("turn/completed", map[string]any{"turn": map[string]any{"id": turn, "status": "completed", "items": []any{}}})
}

func itemDone(turn string, it codexapp.Item) codexapp.Event {
	return note("item/completed", map[string]any{"turnId": turn, "item": it, "completedAtMs": 1})
}

func asyncItem(id string, qs ...codexapp.AsyncQuestion) codexapp.Item {
	return codexapp.Item{Type: codexapp.ItemAgentMessage, ID: id, Text: "…", Delivery: codexapp.DeliveryAsync, Questions: qs}
}

func userItem(id, cid, text string) codexapp.Item {
	return codexapp.Item{Type: codexapp.ItemUserMessage, ID: id, ClientID: cid, Content: []codexapp.UserInput{{Type: "text", Text: text}}}
}

func joined(th *codexapp.Thread) codexapp.Event {
	th.ID = asyncThread
	return codexapp.Event{Kind: codexapp.EvJoined, Thread: th}
}

func batchOf(c proto.WorkerCodex, id string) *proto.CodexBatch {
	for i := range c.Questions {
		if c.Questions[i].Batch == id {
			return &c.Questions[i]
		}
	}
	return nil
}

// stateIs waits until question i of batch is in state.
func (sb *sharedBridge) stateIs(t *testing.T, batch string, i int, state string) proto.WorkerCodex {
	t.Helper()
	return sb.codexWorker(t, func(c *proto.WorkerCodex) bool {
		b := batchOf(*c, batch)
		return b != nil && len(b.Questions) > i && b.Questions[i].State == state
	})
}

func answerArgs(id, batch string, answers ...proto.AsyncAnswerArg) proto.WorkerAnswerAsyncArgs {
	return proto.WorkerAnswerAsyncArgs{ID: id, Thread: asyncThread, Batch: batch, Answers: answers}
}

func ans(i int, text string) proto.AsyncAnswerArg {
	return proto.AsyncAnswerArg{Index: &i, Answer: text}
}

// Asked while the transcript is closed: seen live, published, and kept
// through the tool's {"accepted":true}, the turn's end and unrelated input.
func TestAsyncQuestionSurvivesTheAcknowledgement(t *testing.T) {
	t.Parallel()
	sb, _ := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)))
	c := sb.stateIs(t, "call_3", 1, proto.AsyncPending)
	b := batchOf(c, "call_3")
	if c.Turn != "t1" || b.Turn != "t1" || len(b.Seen) != 1 || b.Seen[0] != codexapp.OriginLive || b.At == 0 ||
		b.Questions[0].Title != colorQ.Title || !slices.Equal(b.Questions[0].Options, colorQ.Options) || b.Questions[1].Options != nil {
		t.Fatalf("codex = %+v", c)
	}
	sb.emit(itemDone("t1", codexapp.Item{Type: "functionCallOutput", ID: "call_3", Text: `{"accepted":true}`}),
		itemDone("t1", userItem("u1", "", "MOCK:say unrelated")), turnCompleted("t1"))
	c = sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Turn == "" })
	if b := batchOf(c, "call_3"); b == nil || b.Questions[0].State != proto.AsyncPending || b.Questions[1].State != proto.AsyncPending {
		t.Fatalf("after the turn = %+v", c.Questions)
	}
}

// A (re)join recovers batches from the thread's history, deduplicated
// against what was seen live; an envelope there (the terminal's) answers
// its question.
func TestAsyncQuestionRecoveredOnRejoin(t *testing.T) {
	t.Parallel()
	sb, _ := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	history := &codexapp.Thread{Turns: []codexapp.Turn{
		{ID: "t1", Status: "completed", Items: []codexapp.Item{asyncItem("call_3", colorQ),
			userItem("u2", "9b0a4f98-28da-4ce4-92d0-6a5ad06370ff",
				codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_3", Question: colorQ.Title, Answer: "Blue"}))}},
		{ID: "t2", Status: "inProgress", Items: []codexapp.Item{asyncItem("call_8", contextQ)}},
	}}
	history.Status.Type = "active"
	sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected, Err: errors.New("lost")}, joined(history))
	c := sb.stateIs(t, "call_3", 0, proto.AsyncAnswered)
	if len(c.Questions) != 2 || c.Turn != "t2" {
		t.Fatalf("questions = %+v (turn %q)", c.Questions, c.Turn)
	}
	b3, b8 := batchOf(c, "call_3"), batchOf(c, "call_8")
	if !slices.Equal(b3.Seen, []string{codexapp.OriginLive, codexapp.OriginHistory}) || b3.Questions[0].Answer != "Blue" ||
		b3.Questions[0].AnsweredBy != codexapp.AnsweredByOther || b8.Seen[0] != codexapp.OriginHistory ||
		b8.Questions[0].State != proto.AsyncPending {
		t.Fatalf("questions = %+v", c.Questions)
	}
	// The same history again (another reconnect) changes nothing.
	sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected}, joined(history))
	time.Sleep(50 * time.Millisecond)
	if c := sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Attached }); len(c.Questions) != 2 {
		t.Fatalf("questions after a second rejoin = %+v", c.Questions)
	}
}

// Active turn: the envelope is steered into it with the bridge's client id;
// the ack says sent, and only the envelope coming back says answered.
func TestAsyncAnswerSteersTheActiveTurn(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "ans", answerArgs(a.ID, "call_3", ans(0, "Green")))
	res := ackData[proto.AsyncAnswerResult](t, m)
	if res.State != proto.AsyncSent || res.Via != "turn/steer" || res.Turn != "t1" || res.Fallback || res.Unconfirmed {
		t.Fatalf("ack = %+v", res)
	}
	sends := sb.sent()
	want := codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_3", Question: colorQ.Title, Answer: "Green"})
	if len(sends) != 1 || sends[0].method != "turn/steer" || sends[0].turn != "t1" || sends[0].text != want ||
		!codexapp.IsBridgeClientID(sends[0].cid) {
		t.Fatalf("sends = %+v", sends)
	}
	c := sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	if batchOf(c, "call_3").Questions[1].State != proto.AsyncPending {
		t.Fatalf("questions = %+v", c.Questions)
	}
	// Sent again (a double click, a second laptop): stale, nothing sent.
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Blue")), proto.ErrStale)
	// The steered input is delivered: its user message comes back.
	sb.emit(itemDone("t1", userItem("u3", sends[0].cid, want)))
	c = sb.stateIs(t, "call_3", 0, proto.AsyncAnswered)
	if q := batchOf(c, "call_3").Questions[0]; q.AnsweredBy != codexapp.AnsweredByBridge || q.Answer != "Green" {
		t.Fatalf("answered = %+v", q)
	}
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends", n)
	}
}

// Idle: a turn is started with the envelope; both questions of a batch in
// one envelope.
func TestAsyncAnswerStartsATurnWhenIdle(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)), turnCompleted("t1"))
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return len(c.Questions) == 1 && c.Turn == "" })
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "ans", answerArgs(a.ID, "call_3", ans(1, "two\nlines"), ans(0, "Blue")))
	res := ackData[proto.AsyncAnswerResult](t, m)
	if res.Via != "turn/start" || res.Turn != "t-started" || res.Fallback {
		t.Fatalf("ack = %+v", res)
	}
	sends := sb.sent()
	answers, ok := codexapp.ParseReply(sends[0].text)
	if len(sends) != 1 || sends[0].method != "turn/start" || !ok || len(answers) != 2 || answers[0].Index != 1 ||
		answers[0].Answer != "two\nlines" || answers[1].Answer != "Blue" {
		t.Fatalf("sends = %+v", sends)
	}
	sb.stateIs(t, "call_3", 1, proto.AsyncSent)
}

// The completion race: the bridge saw the turn running, the server had
// ended it, and refused the steer (nothing delivered). A turn is started
// instead, exactly once.
func TestAsyncAnswerFallsBackOnceWhenTheTurnEnded(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.host.steer = func(turn, _, _ string) (string, error) {
		return "", &codexapp.RPCError{Code: -32600, Message: "expected active turn id `" + turn + "` but found none"}
	}
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "ans", answerArgs(a.ID, "call_3", ans(0, "late")))
	res := ackData[proto.AsyncAnswerResult](t, m)
	if res.Via != "turn/start" || !res.Fallback || res.Turn != "t-started" {
		t.Fatalf("ack = %+v", res)
	}
	sends := sb.sent()
	if len(sends) != 2 || sends[0].method != "turn/steer" || sends[1].method != "turn/start" || sends[0].text != sends[1].text {
		t.Fatalf("sends = %+v", sends)
	}
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)

	// Both refused: input_failed, pending again with the reason, nothing
	// more sent; a later answer may try again.
	sb.host.start = func(string, string) (string, error) {
		return "", &codexapp.RPCError{Code: -32600, Message: "thread is busy"}
	}
	sb.emit(itemDone("t1", asyncItem("call_5", contextQ)))
	sb.stateIs(t, "call_5", 0, proto.AsyncPending)
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_5", ans(0, "x")), proto.ErrInputFailed)
	c := sb.stateIs(t, "call_5", 0, proto.AsyncPending)
	if q := batchOf(c, "call_5").Questions[0]; !strings.Contains(q.Error, "thread is busy") {
		t.Fatalf("question = %+v", q)
	}
	if n := len(sb.sent()); n != 4 {
		t.Fatalf("%d sends, want 4", n)
	}
}

// No response: whether the server took it is unknown. It is sent,
// unconfirmed, and never sent again by itself (a second delivery would
// answer twice); no fallback either.
func TestAsyncAnswerWithoutResponseIsNotResent(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.host.steer = func(string, string, string) (string, error) {
		return "", errors.Join(codexapp.ErrNoResponse, errors.New("context deadline exceeded"))
	}
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "ans", answerArgs(a.ID, "call_3", ans(0, "x")))
	if res := ackData[proto.AsyncAnswerResult](t, m); !res.Unconfirmed || res.State != proto.AsyncSent || res.Fallback {
		t.Fatalf("ack = %+v", res)
	}
	c := sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	if !batchOf(c, "call_3").Questions[0].Unconfirmed {
		t.Fatalf("question = %+v", batchOf(c, "call_3").Questions[0])
	}
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends", n)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "x")), proto.ErrStale)
}

// Identity: the thread named, the batch, its question's state, the answer.
func TestAsyncAnswerStaleIdentity(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)), itemDone("t1", asyncItem("call_4", contextQ)))
	sb.stateIs(t, "call_4", 0, proto.AsyncPending)
	sb.emit(itemDone("t1", userItem("u", "", codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_4", Answer: "terminal"}))))
	sb.stateIs(t, "call_4", 0, proto.AsyncAnswered)
	sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3", Indexes: []int{1}})
	sb.stateIs(t, "call_3", 1, proto.AsyncDismissed)

	wrong := answerArgs(a.ID, "call_3", ans(0, "Green"))
	wrong.Thread = "01a11172-ac09-7aa0-ab6b-000000000009"
	for name, c := range map[string]struct {
		args any
		code string
	}{
		"wrong thread":   {wrong, proto.ErrStale},
		"unknown batch":  {answerArgs(a.ID, "call_9", ans(0, "Green")), proto.ErrStale},
		"answered":       {answerArgs(a.ID, "call_4", ans(0, "again")), proto.ErrStale},
		"dismissed":      {answerArgs(a.ID, "call_3", ans(1, "x")), proto.ErrStale},
		"not an option":  {answerArgs(a.ID, "call_3", ans(0, "Red")), proto.ErrBadRequest},
		"no such index":  {answerArgs(a.ID, "call_3", ans(2, "x")), proto.ErrBadRequest},
		"blank":          {answerArgs(a.ID, "call_3", ans(0, " ")), proto.ErrBadRequest},
		"control":        {answerArgs(a.ID, "call_3", ans(1, "a\x1bb")), proto.ErrBadRequest},
		"no index":       {answerArgs(a.ID, "call_3", proto.AsyncAnswerArg{Answer: "Green"}), proto.ErrBadRequest},
		"no answers":     {answerArgs(a.ID, "call_3"), proto.ErrBadRequest},
		"bad batch id":   {answerArgs(a.ID, "call 3", ans(0, "Green")), proto.ErrBadRequest},
		"unknown worker": {answerArgs("nobody", "call_3", ans(0, "Green")), proto.ErrUnknownWorker},
	} {
		t.Run(name, func(t *testing.T) { sb.c.mustError(proto.CmdWorkerAnswerAsync, c.args, c.code) })
	}
	if n := len(sb.sent()); n != 0 {
		t.Fatalf("%d sends", n)
	}
	// Not attached (the connection is lost): refused, never queued blind.
	sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected, Err: errors.New("lost")})
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return !c.Attached })
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrInvalidState)
	// A /new in the terminal: another thread, the old one's questions go.
	const next = "01a11172-ac09-7aa0-ab6b-000000000002"
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = next })
	c := sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Thread == next })
	if len(c.Questions) != 0 {
		t.Fatalf("questions of the old thread = %+v", c.Questions)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	if n := len(sb.sent()); n != 0 {
		t.Fatalf("%d sends", n)
	}
}

func TestAsyncAnswerNeedsASharedWorker(t *testing.T) {
	t.Parallel()
	sb := startSharedBridge(t, false) // a legacy Codex hire
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrInvalidState)
	sb.c.mustError(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3"},
		proto.ErrInvalidState)
}

func TestAsyncDismiss(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)))
	sb.stateIs(t, "call_3", 1, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3"})
	c := sb.stateIs(t, "call_3", 1, proto.AsyncDismissed)
	if batchOf(c, "call_3").Questions[0].State != proto.AsyncDismissed {
		t.Fatalf("questions = %+v", c.Questions)
	}
	sb.c.mustError(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3"},
		proto.ErrStale)
	sb.c.mustError(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_9"},
		proto.ErrStale)
	// Answered in the terminal anyway: answered wins.
	sb.emit(itemDone("t1", userItem("u", "", codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_3", Index: 1, Answer: "t"}))))
	sb.stateIs(t, "call_3", 1, proto.AsyncAnswered)
}

// Two answers for one question queued at once: the lane runs them in turn,
// the second finds it sending or sent and is stale. One send.
func TestAsyncAnswerSerializedOnTheLane(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	gate := make(chan struct{})
	sb.host.steer = func(turn, _, _ string) (string, error) {
		<-gate
		return turn, nil
	}
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	first := answerArgs(a.ID, "call_3", ans(0, "one"))
	b1, _ := json.Marshal(first)
	sb.c.send(proto.Command{T: proto.CmdWorkerAnswerAsync, ReqID: "one", Args: b1})
	sb.stateIs(t, "call_3", 0, proto.AsyncSending)
	b2, _ := json.Marshal(answerArgs(a.ID, "call_3", ans(0, "two")))
	sb.c.send(proto.Command{T: proto.CmdWorkerAnswerAsync, ReqID: "two", Args: b2})
	close(gate)
	codes := map[string]string{}
	for len(codes) < 2 {
		m := sb.c.next()
		if m.env.ReqID == "one" || m.env.ReqID == "two" {
			var e proto.Error
			_ = json.Unmarshal(m.raw, &e)
			codes[m.env.ReqID] = m.env.T + " " + e.Code
		}
	}
	if codes["one"] != proto.TAck+" " || codes["two"] != proto.TError+" "+proto.ErrStale {
		t.Fatalf("replies = %v", codes)
	}
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends", n)
	}
}

// Two answers for one question queued while it is pending, behind other
// input: the first is steered, and its turn ends before it is delivered
// (sent and undelivered). The second was submitted before that, so it is
// stale, not a retry: one send.
func TestAsyncAnswerQueuedTwiceIsNotARetry(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	gate := make(chan struct{})
	sb.term.mu.Lock()
	sb.term.textGate = gate
	sb.term.mu.Unlock()
	sb.host.steer = func(turn, _, _ string) (string, error) {
		sb.emit(turnCompleted(turn))
		sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Turn == "" })
		return turn, nil
	}
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	raw, _ := json.Marshal(proto.WorkerKeysArgs{ID: a.ID, Input: []proto.InputItem{text("slow hold")}})
	sb.c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "hold", Args: raw})
	raw, _ = json.Marshal(answerArgs(a.ID, "call_3", ans(0, "duplicate")))
	sb.c.send(proto.Command{T: proto.CmdWorkerAnswerAsync, ReqID: "one", Args: raw})
	sb.c.send(proto.Command{T: proto.CmdWorkerAnswerAsync, ReqID: "two", Args: raw})
	sb.c.command(proto.CmdCodexServerGet, "barrier", struct{}{}) // both answers are queued
	close(gate)
	codes := map[string]string{}
	for len(codes) < 2 {
		m := sb.c.next()
		if m.env.ReqID == "one" || m.env.ReqID == "two" {
			var e proto.Error
			_ = json.Unmarshal(m.raw, &e)
			codes[m.env.ReqID] = m.env.T + " " + e.Code
		}
	}
	if codes["one"] != proto.TAck+" " || codes["two"] != proto.TError+" "+proto.ErrStale {
		t.Fatalf("replies = %v", codes)
	}
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends: %+v", n, sb.sent())
	}
	c := sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	if !batchOf(c, "call_3").Questions[0].Undelivered {
		t.Fatalf("questions = %+v", c.Questions)
	}
	// A retry submitted now is the user's: it is sent.
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "retry", answerArgs(a.ID, "call_3", ans(0, "duplicate")))
	if m.env.T != proto.TAck {
		t.Fatalf("retry = %s", m.raw)
	}
	if n := len(sb.sent()); n != 2 {
		t.Fatalf("%d sends after the retry", n)
	}
}

// B7: herdr shows a worker with an async question as blocked, and refuses
// `agent prompt`. Its prompt goes through the app-server instead (steered
// into the running turn); its screen is not a question to answer with keys.
// An approval open on the server is a real block: refused, as before.
func TestPromptReachesAWorkerBlockedByAnAsyncQuestion(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.term.mu.Lock()
	sb.term.screens["w1:p1"] = "• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer\n\n› Ask Codex to do anything\n"
	sb.term.mu.Unlock()
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	sb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "blocked" })
	sb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].Status == "blocked" })
	time.Sleep(100 * time.Millisecond) // the question reader's first read
	if q := workersOf(sb.world(func(proto.World) bool { return true }), "s")["w1"].Question; q != nil {
		t.Fatalf("an async question read as a blocking one: %+v", q)
	}
	_, m := sb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: a.ID, Text: "keep going, and also check the docs"})
	res := ackData[proto.PromptResult](t, m)
	if !res.Queued || res.Via != "app_server" {
		t.Fatalf("ack = %+v", res)
	}
	sends := sb.sent()
	if len(sends) != 1 || sends[0].method != "turn/steer" || sends[0].turn != "t1" || sends[0].text != "keep going, and also check the docs" {
		t.Fatalf("sends = %+v", sends)
	}
	for _, c := range sb.fl.Calls() {
		if strings.Contains(c, "prompt") {
			t.Fatalf("herdr was asked to prompt: %s", c)
		}
	}
	// A prompt does not answer the question.
	if c := sb.stateIs(t, "call_3", 0, proto.AsyncPending); len(c.Questions) != 1 {
		t.Fatalf("questions = %+v", c.Questions)
	}

	// An approval waits on the server: blocked for real.
	sb.emit(codexapp.Event{Kind: codexapp.EvServerRequest, Method: "item/commandExecution/requestApproval", RequestID: json.RawMessage("77")})
	time.Sleep(50 * time.Millisecond)
	sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: a.ID, Text: "again"}, proto.ErrInvalidState)
	sb.emit(note("serverRequest/resolved", map[string]any{"requestId": 77}))
	time.Sleep(50 * time.Millisecond)
	if _, m := sb.c.command(proto.CmdWorkerPrompt, "p2", proto.WorkerPromptArgs{ID: a.ID, Text: "again"}); m.env.T != proto.TAck {
		t.Fatalf("after the approval: %s", m.raw)
	}
	// Answered: herdr's blocked is no longer the question's.
	sb.emit(itemDone("t1", userItem("u", "", codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_3", Answer: "x"}))))
	sb.stateIs(t, "call_3", 0, proto.AsyncAnswered)
	sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: a.ID, Text: "again"}, proto.ErrInvalidState)
}

// A join that gave up after its retries is tried again after CodexRejoin
// (nothing else would: the transcript may never be opened); one refused
// for good is not.
func TestSharedCodexRejoinsAfterGivingUp(t *testing.T) {
	t.Parallel()
	sb, _ := asyncWorker(t)
	watches := func() int {
		sb.host.mu.Lock()
		defer sb.host.mu.Unlock()
		return len(sb.host.watches)
	}
	sb.emit(codexapp.Event{Kind: codexapp.EvFailed, Err: errors.New("gave up after 8 attempts: dial: no such file")})
	for end := time.Now().Add(2 * time.Second); watches() < 2; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("not joined again")
		}
	}
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Attached })
	sb.emit(codexapp.Event{Kind: codexapp.EvFailed, Err: codexapp.ErrUnsupported})
	time.Sleep(400 * time.Millisecond) // past CodexRejoin
	if n := watches(); n != 2 {
		t.Fatalf("a join refused for good was tried again: %d joins", n)
	}
}

// An answer steered into a turn that ended before delivering it (an
// interrupt before the next model request drops it,
// TestCodexShareAsyncAnswers) is undelivered: sent, never re-sent by
// itself, and the user may send it again. One that came back stays
// answered.
func TestAsyncAnswerUndeliveredMayBeSentAgain(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ, contextQ)))
	sb.stateIs(t, "call_3", 1, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "dropped")))
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(1, "delivered")))
	sends := sb.sent()
	sb.emit(itemDone("t1", userItem("u", sends[1].cid, sends[1].text)), turnCompleted("t1"))
	c := sb.codexWorker(t, func(c *proto.WorkerCodex) bool {
		b := batchOf(*c, "call_3")
		return b != nil && b.Questions[0].Undelivered
	})
	if q := batchOf(c, "call_3").Questions; q[0].State != proto.AsyncSent || q[1].State != proto.AsyncAnswered || q[1].Undelivered {
		t.Fatalf("questions = %+v", q)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(sb.sent()); n != 2 {
		t.Fatalf("re-sent by itself: %d sends", n)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(1, "again")), proto.ErrStale)
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "again", answerArgs(a.ID, "call_3", ans(0, "again")))
	if res := ackData[proto.AsyncAnswerResult](t, m); res.Via != "turn/start" {
		t.Fatalf("ack = %+v", res)
	}
	c = sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	if batchOf(c, "call_3").Questions[0].Undelivered {
		t.Fatalf("still undelivered after the second send: %+v", batchOf(c, "call_3").Questions[0])
	}
	if n := len(sb.sent()); n != 3 {
		t.Fatalf("%d sends", n)
	}
}

// #157: worker.codex.async_blocked is the predicate a prompt goes through
// the app-server on (attached, the running turn asked a question Codex still
// holds, no server request open), and every flip of it is a worker.upsert:
// a question asked, an approval opened and resolved, the envelope seen, the
// turn's end, the join lost. A dismissal hides a question in the bridge
// only: Codex still holds it, so the flag stays.
func TestAsyncBlockedFlagFollowsThePredicate(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	flag := func(want bool) proto.WorkerCodex {
		t.Helper()
		return *upsertFor(sb.c, a.ID, func(w *proto.Worker) bool { return w.Codex != nil && w.Codex.AsyncBlocked == want }).Codex
	}
	sb.emit(turnStarted("t1"))
	if c := sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Turn == "t1" }); c.AsyncBlocked {
		t.Fatalf("a turn without a question: %+v", c)
	}
	sb.emit(itemDone("t1", asyncItem("call_3", contextQ)))
	flag(true)
	sb.emit(codexapp.Event{Kind: codexapp.EvServerRequest, Method: "item/commandExecution/requestApproval", RequestID: json.RawMessage("77")})
	flag(false) // an approval waits on the terminal: a real block
	sb.emit(note("serverRequest/resolved", map[string]any{"requestId": 77}))
	flag(true)
	sb.emit(itemDone("t1", userItem("u1", "", codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_3", Answer: "x"}))))
	if c := flag(false); batchOf(c, "call_3").Questions[0].State != proto.AsyncAnswered {
		t.Fatalf("answered: %+v", c.Questions)
	}
	sb.emit(itemDone("t1", asyncItem("call_4", contextQ)))
	flag(true)
	sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_4"})
	if c := sb.stateIs(t, "call_4", 0, proto.AsyncDismissed); !c.AsyncBlocked {
		t.Fatalf("dismissed here, still Codex's: %+v", c)
	}
	sb.emit(turnCompleted("t1"))
	if c := flag(false); c.Turn != "" {
		t.Fatalf("after the turn: %+v", c)
	}
	// The next turn's question; then the join is lost.
	sb.emit(turnStarted("t2"), itemDone("t2", asyncItem("call_5", colorQ)))
	flag(true)
	sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected, Err: errors.New("lost")})
	if c := flag(false); c.Attached {
		t.Fatalf("detached: %+v", c)
	}
}

// #157: a /new in the terminal is another thread: the old one's questions
// go, and with them async_blocked (an upsert).
func TestAsyncBlockedFlagGoesWithTheThread(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	upsertFor(sb.c, a.ID, func(w *proto.Worker) bool { return w.Codex != nil && w.Codex.AsyncBlocked })
	const next = "01a11172-ac09-7aa0-ab6b-84485199adb4"
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = next })
	c := upsertFor(sb.c, a.ID, func(w *proto.Worker) bool { return w.Codex != nil && w.Codex.Thread == next }).Codex
	if c.AsyncBlocked || len(c.Questions) != 0 {
		t.Fatalf("another thread: %+v", c)
	}
}

// restartWith stops the bridge and starts it again on the same store and
// floor, the join reading history; it waits until the bridge joined.
func (sb *sharedBridge) restartWith(t *testing.T, history *codexapp.Thread) *sharedBridge {
	t.Helper()
	sb.fl.mu.Lock()
	workers := slices.Clone(sb.fl.workers)
	sb.fl.mu.Unlock()
	sb.stop()
	history.Status.Type = "active"
	if history.ActiveTurn() == "" {
		history.Status.Type = "idle"
	}
	sb.host.mu.Lock()
	sb.host.history = history
	sb.host.mu.Unlock()
	next := startSharedBridgeAt(t, sb.db, sb.host, false, workers...)
	next.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Attached })
	return next
}

// #158 R1: herdr-world restarts while its steered answer waits in the
// running turn (Codex delivers it with the turn's next model request; the
// history does not show it yet). The answer it recorded keeps the question
// sent: a retry is stale, nothing is sent twice. When the turn ends
// without it, it is undelivered and may be sent once more.
func TestAsyncAnswerSentSurvivesARestart(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")))
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	recorded, err := sb.st.CodexAsyncSends(context.Background())
	if err != nil || len(recorded[a.ID]) != 1 || recorded[a.ID][0].Turn != "t1" || !recorded[a.ID][0].Confirmed ||
		recorded[a.ID][0].ClientID != sb.sent()[0].cid {
		t.Fatalf("recorded sends = %+v, %v", recorded, err)
	}

	// The same running turn, its history without the queued answer.
	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
		{ID: "t1", Status: codexapp.TurnInProgress, Items: []codexapp.Item{asyncItem("call_3", colorQ, contextQ)}}}})
	c := sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	if q := batchOf(c, "call_3").Questions; q[0].Undelivered || q[1].State != proto.AsyncPending || c.Turn != "t1" {
		t.Fatalf("after the restart = %+v (turn %q)", q, c.Turn)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends, want the one before the restart", n)
	}
	// The turn ends without delivering it: undelivered, one resend.
	sb.emit(turnCompleted("t1"))
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool {
		b := batchOf(*c, "call_3")
		return b != nil && b.Questions[0].Undelivered
	})
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "again", answerArgs(a.ID, "call_3", ans(0, "Green")))
	if res := ackData[proto.AsyncAnswerResult](t, m); res.Via != "turn/start" {
		t.Fatalf("resend ack = %+v", res)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	sends := sb.sent()
	if len(sends) != 2 {
		t.Fatalf("%d sends, want 2", len(sends))
	}
	// Delivered: answered by the bridge, and its record goes.
	sb.emit(itemDone("t-started", userItem("u", sends[1].cid, sends[1].text)))
	sb.stateIs(t, "call_3", 0, proto.AsyncAnswered)
	deadline := time.Now().Add(2 * time.Second)
	for {
		recorded, _ = sb.st.CodexAsyncSends(context.Background())
		if len(recorded[a.ID]) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("an answered question's send is still recorded: %+v", recorded)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// #158 R1: the turn the answer was steered into ended while herdr-world
// was gone, without it: undelivered after the restart, one resend allowed.
// An answer that was delivered meanwhile is answered, and goes.
func TestAsyncAnswerUndeliveredAcrossARestart(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)), itemDone("t1", asyncItem("call_4", contextQ)))
	sb.stateIs(t, "call_4", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "dropped")))
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_4", ans(0, "delivered")))
	sends := sb.sent()

	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
		{ID: "t1", Status: "interrupted", Items: []codexapp.Item{asyncItem("call_3", contextQ), asyncItem("call_4", contextQ),
			userItem("u", sends[1].cid, sends[1].text)}}}})
	c := sb.stateIs(t, "call_4", 0, proto.AsyncAnswered)
	if q := batchOf(c, "call_3").Questions[0]; q.State != proto.AsyncSent || !q.Undelivered {
		t.Fatalf("after the restart call_3 = %+v", q)
	}
	if q := batchOf(c, "call_4").Questions[0]; q.AnsweredBy != codexapp.AnsweredByBridge {
		t.Fatalf("call_4 = %+v", q)
	}
	recorded, _ := sb.st.CodexAsyncSends(context.Background())
	if len(recorded[a.ID]) != 1 || recorded[a.ID][0].Batch != "call_3" {
		t.Fatalf("recorded = %+v", recorded)
	}
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "again")))
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "again")), proto.ErrStale)
	if n := len(sb.sent()); n != 3 {
		t.Fatalf("%d sends, want 3", n)
	}
}

// #158 R1: a send recorded before its response came (herdr-world stopped
// in between) counts as sent into the turn it was steered into.
func TestAsyncAnswerRecordedBeforeTheResponse(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	release := make(chan struct{})
	seen := make(chan struct{})
	sb.host.mu.Lock()
	sb.host.steer = func(turn, _, _ string) (string, error) {
		close(seen)
		<-release
		return turn, nil
	}
	sb.host.mu.Unlock()
	answered := make(chan struct{})
	go func() {
		defer close(answered)
		sb.c.command(proto.CmdWorkerAnswerAsync, "ans", answerArgs(a.ID, "call_3", ans(0, "x")))
	}()
	<-seen
	recorded, err := sb.st.CodexAsyncSends(context.Background())
	if err != nil || len(recorded[a.ID]) != 1 || recorded[a.ID][0].Turn != "t1" || recorded[a.ID][0].Confirmed {
		t.Fatalf("recorded while the steer is in flight = %+v, %v", recorded, err)
	}
	close(release)
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	<-answered // its ack is read before the restart closes the connection
	// The answer's response never recorded; and a worker that is gone.
	if err := sb.st.RecordCodexAsyncSends(context.Background(), []store.CodexAsyncSend{{WorkerID: a.ID, Thread: asyncThread,
		Batch: "call_3", ClientID: "herdr_3d-00", Turn: "t1"}, {WorkerID: "gone", Thread: asyncThread, Batch: "call_1",
		ClientID: "herdr_3d-01", Turn: "t0", Confirmed: true}}); err != nil {
		t.Fatal(err)
	}
	sb.host.mu.Lock()
	sb.host.steer = nil
	sb.host.mu.Unlock()
	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
		{ID: "t1", Status: codexapp.TurnInProgress, Items: []codexapp.Item{asyncItem("call_3", contextQ)}}}})
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "x")), proto.ErrStale)
	if recorded, _ := sb.st.CodexAsyncSends(context.Background()); len(recorded["gone"]) != 0 || len(recorded[a.ID]) != 1 {
		t.Fatalf("recorded after the restart = %+v", recorded)
	}
}

// #158: sending a worker home forgets its recorded sends.
func TestAsyncAnswerSendsGoWithTheWorker(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", contextQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "x")))
	if recorded, _ := sb.st.CodexAsyncSends(context.Background()); len(recorded[a.ID]) != 1 {
		t.Fatalf("recorded = %+v", recorded)
	}
	sb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: a.ID})
	deadline := time.Now().Add(5 * time.Second)
	var recorded map[string][]store.CodexAsyncSend
	for {
		if recorded, _ = sb.st.CodexAsyncSends(context.Background()); len(recorded) == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sent home, still recorded: %+v", recorded)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// recordedBatches is the batches of a worker's recorded sends.
func (sb *sharedBridge) recordedBatches(t *testing.T, id string) []string {
	t.Helper()
	recorded, err := sb.st.CodexAsyncSends(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, x := range recorded[id] {
		out = append(out, x.Batch)
	}
	return out
}

// #158 R1 (review round 2): the bridge restarts while its steered answer
// waits in the running turn, and the join's reading of resume's legacy ids
// (item-N) fails, so its history has item-2, not call_3. The recorded send
// is kept (the batch is unknown only because its id is), item-2 cannot be
// answered, and once a join reads call_3 the question is sent again: a
// retry is stale, one envelope in all.
func TestAsyncAnswerKeptThroughAFailedLegacyRepair(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")))
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)

	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
		{ID: "t1", Status: codexapp.TurnInProgress, Items: []codexapp.Item{asyncItem("item-2", colorQ)}}}})
	sb.stateIs(t, "item-2", 0, proto.AsyncPending)
	if got := sb.recordedBatches(t, a.ID); !slices.Equal(got, []string{"call_3"}) {
		t.Fatalf("recorded after the failed repair = %v", got)
	}
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "legacy", answerArgs(a.ID, "item-2", ans(0, "Green")))
	var refusal proto.Error
	_ = json.Unmarshal(m.raw, &refusal)
	if refusal.Code != proto.ErrInvalidState || !strings.Contains(refusal.Message, "item-2") ||
		!strings.Contains(refusal.Message, "terminal") {
		t.Fatalf("answering item-2: %s", m.raw)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	// A live change meanwhile (pruneSends) keeps it too.
	sb.emit(itemDone("t1", asyncItem("call_4", contextQ)))
	sb.stateIs(t, "call_4", 0, proto.AsyncPending)
	if got := sb.recordedBatches(t, a.ID); !slices.Equal(got, []string{"call_3"}) {
		t.Fatalf("recorded after a live change = %v", got)
	}

	// A join reads the turn under its call ids; the worker still holds the
	// first steer.
	sb.emit(joined(&codexapp.Thread{Status: struct {
		Type string `json:"type"`
	}{codexapp.ThreadActive}, Turns: []codexapp.Turn{{ID: "t1", Status: codexapp.TurnInProgress,
		Items: []codexapp.Item{asyncItem("call_3", colorQ), asyncItem("call_4", contextQ)}}}}))
	c := sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	if batchOf(c, "item-2") != nil || batchOf(c, "call_3").Questions[0].Undelivered {
		t.Fatalf("after the canonical join = %+v", c.Questions)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends, want the one before the restart", n)
	}
}

// #158 R1: the same when thread/turns/list answered but had nothing for
// the newest turn (its older turns read, the newest still item-N): the
// record is kept and the bridge joins again after CodexRejoin, which reads
// call_3.
func TestAsyncAnswerKeptThroughAnUnmatchedLegacyRepair(t *testing.T) {
	t.Parallel()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")))
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	earlier := codexapp.Turn{ID: "t0", Status: "completed", Items: []codexapp.Item{asyncItem("call_1", contextQ),
		userItem("u0", "", codexapp.ReplyEnvelope(codexapp.Answer{MessageID: "call_1", Answer: "x"}))}}

	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{earlier,
		{ID: "t1", Status: codexapp.TurnInProgress, Items: []codexapp.Item{asyncItem("item-2", colorQ)}}}})
	sb.stateIs(t, "item-2", 0, proto.AsyncPending)
	if got := sb.recordedBatches(t, a.ID); !slices.Equal(got, []string{"call_3"}) {
		t.Fatalf("recorded after the unmatched repair = %v", got)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "item-2", ans(0, "Green")), proto.ErrInvalidState)

	// The next join (CodexRejoin) reads the turn under its call ids.
	watches := func() int {
		sb.host.mu.Lock()
		defer sb.host.mu.Unlock()
		return len(sb.host.watches)
	}
	before := watches()
	sb.host.mu.Lock()
	sb.host.history = &codexapp.Thread{Status: struct {
		Type string `json:"type"`
	}{codexapp.ThreadActive}, Turns: []codexapp.Turn{earlier,
		{ID: "t1", Status: codexapp.TurnInProgress, Items: []codexapp.Item{asyncItem("call_3", colorQ)}}}}
	sb.host.mu.Unlock()
	c := sb.codexWorker(t, func(c *proto.WorkerCodex) bool {
		b := batchOf(*c, "call_3")
		return c.Attached && b != nil && b.Questions[0].State == proto.AsyncSent
	})
	if watches() <= before || batchOf(c, "item-2") != nil {
		t.Fatalf("after the rejoin: %d joins (were %d), batches %+v", watches(), before, c.Questions)
	}
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends, want the one before the restart", n)
	}
	// Resolved: the bridge stays joined.
	n := watches()
	time.Sleep(400 * time.Millisecond) // past CodexRejoin
	if watches() != n {
		t.Fatalf("a resolved join was joined again: %d joins, were %d", watches(), n)
	}
}
