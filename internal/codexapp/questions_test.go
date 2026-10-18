package codexapp

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
)

// asyncItem is the agentMessage Codex 0.160.1 sends for an async question
// batch (TestCodexShareQuestions/05-idle-question-live-item).
func asyncItem(id string, qs ...AsyncQuestion) Item {
	return Item{Type: ItemAgentMessage, ID: id, Text: "…", Delivery: DeliveryAsync, Questions: qs}
}

var (
	colorQ   = AsyncQuestion{Title: "Which fixture color?", Options: []string{"Green", "Blue"}}
	contextQ = AsyncQuestion{Title: "Any context for the fixture?"}
)

func userItem(id, clientID, text string) Item {
	return Item{Type: ItemUserMessage, ID: id, ClientID: clientID, Content: []UserInput{{Type: "text", Text: text}}}
}

func states(t *testing.T, q *Questions, batch string) []QuestionState {
	t.Helper()
	b := q.Batch(batch)
	if b == nil {
		t.Fatalf("no batch %s", batch)
	}
	var out []QuestionState
	for _, x := range b.Questions {
		out = append(out, x.State)
	}
	return out
}

func TestItemDecodesTheLiveQuestion(t *testing.T) {
	raw := `{"type":"agentMessage","id":"call_3","text":"Which fixture color?\n- Green\n- Blue\n\nAny context for the fixture?",
	  "delivery":"async","questions":[{"title":"Which fixture color?","options":["Green","Blue"]},{"title":"Any context for the fixture?","options":null}],"content":null}`
	var it Item
	if err := json.Unmarshal([]byte(raw), &it); err != nil {
		t.Fatal(err)
	}
	b, ok := BatchOf("turn-1", it)
	if !ok || b.ID != "call_3" || b.Turn != "turn-1" || len(b.Questions) != 2 || b.Questions[1].Options != nil ||
		b.Questions[0].Options[1] != "Blue" || b.Questions[0].State != QPending {
		t.Fatalf("batch = %+v, %v", b, ok)
	}
	for _, it := range []Item{
		{Type: ItemAgentMessage, ID: "msg_1", Text: "hello"},                                            // an ordinary message
		{Type: ItemAgentMessage, ID: "call_4", Delivery: DeliveryAsync},                                 // async, no questions
		{Type: ItemUserMessage, ID: "u", Questions: []AsyncQuestion{contextQ}},                          // not an agent message
		{Type: ItemAgentMessage, ID: "", Delivery: DeliveryAsync, Questions: []AsyncQuestion{contextQ}}, // no id
	} {
		if b, ok := BatchOf("t", it); ok {
			t.Errorf("%+v is a batch: %+v", it, b)
		}
	}
}

// The {"accepted":true} tool result only schedules the question: nothing
// but an envelope naming (call_id, index) answers it. Turn completion and
// unrelated input change nothing.
func TestQuestionsSurviveTheAcknowledgement(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ, contextQ), OriginLive)
	// The function call output and the end of the turn are not items the
	// reconciler reads; an unrelated steer is.
	q.Observe("t1", userItem("u1", "", "MOCK:say unrelated-from-bridge"), OriginLive)
	q.Observe("t1", Item{Type: "functionCallOutput", ID: "call_3"}, OriginLive)
	if got := states(t, q, "call_3"); got[0] != QPending || got[1] != QPending {
		t.Fatalf("states = %v", got)
	}
	// The terminal answers the second one.
	env := ReplyEnvelope(Answer{MessageID: "call_3", Index: 1, Question: contextQ.Title, Answer: "typed"})
	if !q.Observe("t1", userItem("u2", "9b0a4f98-28da-4ce4-92d0-6a5ad06370ff", env), OriginLive) {
		t.Fatal("the envelope changed nothing")
	}
	b := q.Batch("call_3")
	if b.Questions[0].State != QPending || b.Questions[1].State != QAnswered || b.Questions[1].Answer != "typed" ||
		b.Questions[1].AnsweredBy != AnsweredByOther {
		t.Fatalf("batch = %+v", b.Questions)
	}
	if !q.Unanswered("t1") {
		t.Fatal("the first question no longer counts as unanswered")
	}
}

func TestQuestionsDeduplicateLiveAndHistory(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ), OriginLive)
	q.Observe("t1", asyncItem("call_3", colorQ), OriginLive) // item/started, then item/completed
	changed := q.Hydrate([]Turn{
		{ID: "t0", Items: []Item{userItem("u0", "", "MOCK:say hi")}},
		{ID: "t1", Items: []Item{userItem("u1", "", "MOCK:ask-options"), asyncItem("call_3", colorQ)}},
		{ID: "t2", Items: []Item{asyncItem("call_7", contextQ),
			userItem("u2", "", ReplyEnvelope(Answer{MessageID: "call_7", Question: contextQ.Title, Answer: "ctx"}))}},
	})
	if !changed {
		t.Fatal("hydration changed nothing")
	}
	all := q.Batches()
	if len(all) != 2 || all[0].ID != "call_3" || all[1].ID != "call_7" {
		t.Fatalf("batches = %+v", all)
	}
	if b := all[0]; len(b.Seen) != 2 || b.Seen[0] != OriginLive || b.Seen[1] != OriginHistory || b.Twin != "" || b.Conflict {
		t.Fatalf("call_3 = %+v", b)
	}
	if all[1].Seen[0] != OriginHistory || all[1].Questions[0].State != QAnswered {
		t.Fatalf("call_7 = %+v", all[1])
	}
	// Hydrating the same history again (a reconnect) changes nothing.
	if q.Hydrate([]Turn{{ID: "t1", Items: []Item{asyncItem("call_3", colorQ)}}}) {
		t.Fatal("a second hydration changed something")
	}
}

// Live and history that disagree are never merged or dropped: the same id
// with other questions is a conflict (not answerable), the same questions
// under another id in the same turn are twins.
func TestQuestionsKeepDisagreementsExplicit(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ), OriginLive)
	q.Hydrate([]Turn{{ID: "t1", Items: []Item{asyncItem("call_3", contextQ)}}})
	if b := q.Batch("call_3"); !b.Conflict || b.Questions[0].Title != colorQ.Title {
		t.Fatalf("conflict = %+v", b)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "Green"}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("answering a conflict: %v", err)
	}
	q.Observe("t2", asyncItem("call_5", contextQ), OriginLive)
	q.Hydrate([]Turn{{ID: "t2", Items: []Item{asyncItem("item-9", contextQ)}}})
	if a, b := q.Batch("call_5"), q.Batch("item-9"); a.Twin != "item-9" || b.Twin != "call_5" {
		t.Fatalf("twins = %+v / %+v", a, b)
	}
}

func TestQuestionsKeepBatchesDistinct(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ), OriginLive)
	q.Observe("t1", asyncItem("call_5", colorQ), OriginLive) // the same question asked again: a batch of its own
	env := ReplyEnvelope(Answer{MessageID: "call_5", Question: colorQ.Title, Answer: "Blue"})
	q.Observe("t1", userItem("u", "", env), OriginLive)
	if a, b := states(t, q, "call_3"), states(t, q, "call_5"); a[0] != QPending || b[0] != QAnswered {
		t.Fatalf("call_3 %v, call_5 %v", a, b)
	}
	// An answer for an index the batch does not have, or a batch never seen,
	// answers nothing.
	q.Observe("t1", userItem("u", "", ReplyEnvelope(Answer{MessageID: "call_3", Index: 4, Answer: "x"})), OriginLive)
	if states(t, q, "call_3")[0] != QPending {
		t.Fatal("an out-of-range index answered the question")
	}
}

// An envelope read before its batch (an older page of history) still
// answers it once the batch shows up.
func TestQuestionsAnswerABatchSeenLater(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t2", userItem("u", "", ReplyEnvelope(Answer{MessageID: "call_1", Question: contextQ.Title, Answer: "early"})), OriginLive)
	q.Hydrate([]Turn{{ID: "t1", Items: []Item{asyncItem("call_1", contextQ)}}})
	if b := q.Batch("call_1"); b.Questions[0].State != QAnswered || b.Questions[0].Answer != "early" {
		t.Fatalf("batch = %+v", b.Questions)
	}
}

func TestQuestionsAnswerFlow(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ, contextQ), OriginLive)
	for name, c := range map[string]struct {
		batch   string
		replies []Reply
		want    error
	}{
		"unknown batch":  {"call_9", []Reply{{Index: 0, Text: "Green"}}, ErrUnknownBatch},
		"no reply":       {"call_3", nil, ErrBadAnswer},
		"index":          {"call_3", []Reply{{Index: 2, Text: "x"}}, ErrBadAnswer},
		"twice":          {"call_3", []Reply{{Index: 1, Text: "a"}, {Index: 1, Text: "b"}}, ErrBadAnswer},
		"not an option":  {"call_3", []Reply{{Index: 0, Text: "Red"}}, ErrBadAnswer},
		"blank":          {"call_3", []Reply{{Index: 1, Text: "  \n"}}, ErrBadAnswer},
		"option is case": {"call_3", []Reply{{Index: 0, Text: "green"}}, ErrBadAnswer},
	} {
		if _, err := q.Begin(c.batch, c.replies); !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
	answers, err := q.Begin("call_3", []Reply{{Index: 0, Text: "Green"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(answers) != 1 || answers[0] != (Answer{MessageID: "call_3", Index: 0, Question: colorQ.Title, Answer: "Green"}) {
		t.Fatalf("answers = %+v", answers)
	}
	// A second submission while the first is on its way is refused.
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "Blue"}}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("second submission: %v", err)
	}
	// A refusal (nothing delivered) puts it back, with the reason.
	q.Failed("call_3", []int{0}, "no active turn")
	if b := q.Batch("call_3").Questions[0]; b.State != QPending || b.Error != "no active turn" {
		t.Fatalf("after a refusal: %+v", b)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "Green"}}); err != nil {
		t.Fatal(err)
	}
	cid := NewClientID()
	q.Sent("call_3", []int{0}, "t1", false)
	if b := q.Batch("call_3").Questions[0]; b.State != QSent || b.Error != "" {
		t.Fatalf("after the send: %+v", b)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "Green"}}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("answering a sent question: %v", err)
	}
	// Its envelope, with the bridge's client id: answered by the bridge.
	q.Observe("t1", userItem("u", cid, ReplyEnvelope(answers...)), OriginLive)
	if b := q.Batch("call_3").Questions[0]; b.State != QAnswered || b.AnsweredBy != AnsweredByBridge {
		t.Fatalf("after its envelope: %+v", b)
	}
	// Late results never move an answered question back.
	q.Sent("call_3", []int{0}, "t1", false)
	q.Failed("call_3", []int{0}, "late")
	if b := q.Batch("call_3").Questions[0]; b.State != QAnswered || b.Error != "" {
		t.Fatalf("after late results: %+v", b)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "Green"}}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("answering an answered question: %v", err)
	}
	// Free text, kept as typed.
	if a, err := q.Begin("call_3", []Reply{{Index: 1, Text: " two\nlines "}}); err != nil || a[0].Answer != " two\nlines " {
		t.Fatalf("free text: %+v %v", a, err)
	}
}

// Two answers admitted while a question is pending send it once, even
// when the first goes undelivered before the second is begun: only an
// answer admitted after that is the user's retry.
func TestQuestionsAdmittedAnswerIsStaleOnceAnotherBegan(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", contextQ, contextQ), OriginLive)
	one, err := q.Admit("call_3", []Reply{{Index: 0, Text: "a"}})
	if err != nil {
		t.Fatal(err)
	}
	two, err := q.Admit("call_3", []Reply{{Index: 0, Text: "a"}})
	if err != nil {
		t.Fatal(err)
	}
	other, err := q.Admit("call_3", []Reply{{Index: 1, Text: "b"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.BeginAdmitted(one); err != nil {
		t.Fatal(err)
	}
	q.Sent("call_3", []int{0}, "t1", false)
	q.TurnEnded("t1")
	if x := q.Batch("call_3").Questions[0]; x.State != QSent || !x.Undelivered {
		t.Fatalf("dropped answer = %+v", x)
	}
	if _, err := q.BeginAdmitted(two); !errors.Is(err, ErrNotPending) {
		t.Fatalf("a duplicate admitted before the send: %v", err)
	}
	// Another question of the batch is not affected.
	if _, err := q.BeginAdmitted(other); err != nil {
		t.Fatalf("another question: %v", err)
	}
	// Refused (nothing delivered) and pending again: still stale.
	q.Failed("call_3", []int{1}, "no active turn")
	if _, err := q.BeginAdmitted(other); !errors.Is(err, ErrNotPending) {
		t.Fatalf("an answer begun twice: %v", err)
	}
	// Admitted after the answer went undelivered: the user's retry.
	retry, err := q.Admit("call_3", []Reply{{Index: 0, Text: "a"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.BeginAdmitted(retry); err != nil {
		t.Fatalf("a retry: %v", err)
	}
	// A ticket of other questions (the thread's were reset) is stale.
	if _, err := NewQuestions("th").BeginAdmitted(retry); !errors.Is(err, ErrNotPending) {
		t.Fatalf("another reconciler: %v", err)
	}
}

// A ticket with its texts replaced (#108: protected) keeps its admission:
// a duplicate admitted before the first was begun stays stale.
func TestTicketWithTextsKeepsItsAdmission(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", contextQ), OriginLive)
	one, _ := q.Admit("call_3", []Reply{{Index: 0, Text: "a"}})
	two, _ := q.Admit("call_3", []Reply{{Index: 0, Text: "a"}})
	if _, err := one.WithTexts([]string{"a", "b"}); !errors.Is(err, ErrBadAnswer) {
		t.Fatalf("two texts for one answer: %v", err)
	}
	one, err := one.WithTexts([]string{"a with [secret in file /x]"})
	if err != nil {
		t.Fatal(err)
	}
	two, _ = two.WithTexts([]string{"a with [secret in file /y]"})
	answers, err := q.BeginAdmitted(one)
	if err != nil || len(answers) != 1 || answers[0].Answer != "a with [secret in file /x]" {
		t.Fatalf("%+v %v", answers, err)
	}
	q.Sent("call_3", []int{0}, "t1", false)
	q.TurnEnded("t1")
	if _, err := q.BeginAdmitted(two); !errors.Is(err, ErrNotPending) {
		t.Fatalf("a duplicate admitted before the send: %v", err)
	}
	// The new texts are checked as any: a blank one is refused.
	retry, err := q.Admit("call_3", []Reply{{Index: 0, Text: "a"}})
	if err != nil {
		t.Fatal(err)
	}
	retry, _ = retry.WithTexts([]string{" "})
	if _, err := q.BeginAdmitted(retry); !errors.Is(err, ErrBadAnswer) {
		t.Fatalf("a blank text: %v", err)
	}
}

func TestQuestionsUnconfirmedSendStaysSent(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", contextQ), OriginLive)
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "x"}}); err != nil {
		t.Fatal(err)
	}
	q.Sent("call_3", []int{0}, "", true)
	if b := q.Batch("call_3").Questions[0]; b.State != QSent || !b.Unconfirmed {
		t.Fatalf("unconfirmed: %+v", b)
	}
}

func TestQuestionsDismiss(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ, contextQ), OriginLive)
	if err := q.Dismiss("call_9", nil); !errors.Is(err, ErrUnknownBatch) {
		t.Fatalf("unknown: %v", err)
	}
	if err := q.Dismiss("call_3", []int{1}); err != nil {
		t.Fatal(err)
	}
	if got := states(t, q, "call_3"); got[0] != QPending || got[1] != QDismissed {
		t.Fatalf("states = %v", got)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 1, Text: "x"}}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("answering a dismissed question: %v", err)
	}
	if err := q.Dismiss("call_3", []int{1}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("dismissing twice: %v", err)
	}
	// The terminal can still answer it: answered wins.
	q.Observe("t1", userItem("u", "", ReplyEnvelope(Answer{MessageID: "call_3", Index: 1, Answer: "late"})), OriginLive)
	if got := states(t, q, "call_3"); got[1] != QAnswered {
		t.Fatalf("states = %v", got)
	}
	// No indexes: every question that can be.
	if err := q.Dismiss("call_3", nil); err != nil {
		t.Fatal(err)
	}
	if got := states(t, q, "call_3"); got[0] != QDismissed || got[1] != QAnswered {
		t.Fatalf("states = %v", got)
	}
	if q.Unanswered("t1") != true {
		t.Fatal("a dismissed question is still unanswered for Codex")
	}
}

func TestQuestionsAreBounded(t *testing.T) {
	q := NewQuestions("th")
	for i := range MaxBatches + 5 {
		q.Observe("t", asyncItem("call_"+string(rune('a'+i%26))+string(rune('a'+i/26)), contextQ), OriginLive)
	}
	if n := len(q.Batches()); n != MaxBatches {
		t.Fatalf("%d batches kept", n)
	}
	if q.Batch("call_aa") != nil {
		t.Fatal("the oldest batch was kept")
	}
}

// A turn that ends without the bridge's user message dropped its answer
// (interrupted before the next model request): the question is sent and
// undelivered, and may be answered again; nothing re-sends it by itself.
func TestQuestionsUndelivered(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", contextQ, contextQ), OriginLive)
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "a"}, {Index: 1, Text: "b"}}); err != nil {
		t.Fatal(err)
	}
	q.Sent("call_3", []int{0, 1}, "t1", false)
	// Index 1 is delivered (its user message comes before the turn ends).
	q.Observe("t1", userItem("u", NewClientID(), ReplyEnvelope(Answer{MessageID: "call_3", Index: 1, Answer: "b"})), OriginLive)
	if q.TurnEnded("t0") || !q.TurnEnded("t1") {
		t.Fatal("TurnEnded reported the wrong change")
	}
	b := q.Batch("call_3")
	if x := b.Questions[0]; x.State != QSent || !x.Undelivered {
		t.Fatalf("dropped answer = %+v", x)
	}
	if x := b.Questions[1]; x.State != QAnswered || x.Undelivered {
		t.Fatalf("delivered answer = %+v", x)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 1, Text: "b"}}); !errors.Is(err, ErrNotPending) {
		t.Fatalf("re-answering an answered question: %v", err)
	}
	if _, err := q.Begin("call_3", []Reply{{Index: 0, Text: "again"}}); err != nil {
		t.Fatalf("re-answering an undelivered question: %v", err)
	}
	if x := q.Batch("call_3").Questions[0]; x.State != QSending || x.Undelivered {
		t.Fatalf("re-sent = %+v", x)
	}
	// Accepted into a turn that has already ended: undelivered at once.
	q.Sent("call_3", []int{0}, "t1", false)
	if x := q.Batch("call_3").Questions[0]; !x.Undelivered {
		t.Fatalf("sent into an ended turn = %+v", x)
	}
	// An unconfirmed send is never undelivered (its turn is unknown).
	q.Observe("t2", asyncItem("call_5", contextQ), OriginLive)
	q.Begin("call_5", []Reply{{Index: 0, Text: "x"}})
	q.Sent("call_5", []int{0}, "", true)
	q.TurnEnded("t2")
	if x := q.Batch("call_5").Questions[0]; x.Undelivered {
		t.Fatalf("unconfirmed = %+v", x)
	}
	// The history: the turn it went to ended without it.
	h := NewQuestions("th")
	h.Observe("t4", asyncItem("call_7", contextQ), OriginLive)
	h.Begin("call_7", []Reply{{Index: 0, Text: "x"}})
	h.Sent("call_7", []int{0}, "t4", false)
	h.Hydrate([]Turn{{ID: "t4", Status: "interrupted", Items: []Item{asyncItem("call_7", contextQ)}}})
	if x := h.Batch("call_7").Questions[0]; !x.Undelivered {
		t.Fatalf("after hydration = %+v", x)
	}
}

// #158 R1: the bridge restarts while its steered answer waits in the
// running turn. The live reconciler refuses a second answer; a fresh one
// hydrated from the same history sees the question pending (the queued
// steer is not a user message yet) and would admit it, unless the send the
// bridge recorded is restored.
func TestQuestionsRestoreASendAcrossARestart(t *testing.T) {
	history := []Turn{{ID: "t1", Status: TurnInProgress, Items: []Item{asyncItem("call_3", colorQ, contextQ)}}}
	reply := []Reply{{Index: 0, Text: "Green"}}
	live := NewQuestions("th")
	live.Hydrate(history)
	if _, err := live.Begin("call_3", reply); err != nil {
		t.Fatal(err)
	}
	live.Sent("call_3", []int{0}, "t1", false)
	if _, err := live.Check("call_3", reply); !errors.Is(err, ErrNotPending) {
		t.Fatalf("live reconciler: %v", err)
	}
	fresh := func() *Questions {
		q := NewQuestions("th")
		q.Hydrate(history)
		return q
	}
	if _, err := fresh().Check("call_3", reply); err != nil {
		t.Fatalf("a fresh reconciler refuses the answer by itself (%v): the restore is not what this tests", err)
	}

	// Steered into the turn still running: sent, a second answer stale.
	q := fresh()
	if !q.Restore(PriorSend{Batch: "call_3", Index: 0, Turn: "t1", Confirmed: true}, "t1") {
		t.Fatal("the send no longer matters")
	}
	if _, err := q.Check("call_3", reply); !errors.Is(err, ErrNotPending) {
		t.Fatalf("restored, running: %v", err)
	}
	if x := q.Batch("call_3").Questions[0]; x.State != QSent || x.Undelivered || x.Unconfirmed {
		t.Fatalf("restored, running = %+v", x)
	}
	if x := q.Batch("call_3").Questions[1]; x.State != QPending {
		t.Fatalf("the other question = %+v", x)
	}
	// Recorded before the response came (the bridge stopped in between):
	// the same while the turn it went to runs.
	q = fresh()
	q.Restore(PriorSend{Batch: "call_3", Index: 0, Turn: "t1"}, "t1")
	if _, err := q.Check("call_3", reply); !errors.Is(err, ErrNotPending) {
		t.Fatalf("restored before the response: %v", err)
	}
	// The turn ends afterwards without delivering it: undelivered, one
	// resend.
	q.TurnEnded("t1")
	if x := q.Batch("call_3").Questions[0]; !x.Undelivered {
		t.Fatalf("after the turn ended = %+v", x)
	}
	if _, err := q.Begin("call_3", reply); err != nil {
		t.Fatalf("resend: %v", err)
	}
	if _, err := q.Check("call_3", reply); !errors.Is(err, ErrNotPending) {
		t.Fatalf("a second resend: %v", err)
	}

	// The turn ended while the bridge was gone: undelivered, a resend
	// allowed.
	ended := []Turn{{ID: "t1", Status: "interrupted", Items: []Item{asyncItem("call_3", colorQ, contextQ)}}}
	q = NewQuestions("th")
	q.Hydrate(ended)
	q.Restore(PriorSend{Batch: "call_3", Index: 0, Turn: "t1", Confirmed: true}, "")
	if x := q.Batch("call_3").Questions[0]; x.State != QSent || !x.Undelivered {
		t.Fatalf("restored, turn ended = %+v", x)
	}
	if _, err := q.Check("call_3", reply); err != nil {
		t.Fatalf("resend after the turn ended: %v", err)
	}

	// Delivered meanwhile: the history's envelope wins.
	answered := []Turn{{ID: "t1", Status: TurnInProgress, Items: []Item{asyncItem("call_3", colorQ, contextQ),
		userItem("u", NewClientID(), ReplyEnvelope(Answer{MessageID: "call_3", Index: 0, Answer: "Green"}))}}}
	q = NewQuestions("th")
	q.Hydrate(answered)
	if q.Restore(PriorSend{Batch: "call_3", Index: 0, Turn: "t1", Confirmed: true}, "t1") {
		t.Fatal("an answered question's send still matters")
	}
	if x := q.Batch("call_3").Questions[0]; x.State != QAnswered || x.AnsweredBy != AnsweredByBridge {
		t.Fatalf("answered = %+v", x)
	}

	// Unconfirmed: sent and unconfirmed, never resent by itself.
	q = fresh()
	q.Restore(PriorSend{Batch: "call_3", Index: 0, Unconfirmed: true}, "t1")
	if x := q.Batch("call_3").Questions[0]; x.State != QSent || !x.Unconfirmed {
		t.Fatalf("unconfirmed = %+v", x)
	}
	q.TurnEnded("t1")
	if _, err := q.Check("call_3", reply); !errors.Is(err, ErrNotPending) {
		t.Fatalf("unconfirmed after the turn: %v", err)
	}

	// No response recorded, and the history lacks the envelope: a
	// turn/start (or a steer into a turn that ended since, then its
	// fallback turn/start) Codex may hold in a turn the terminal started at
	// the same instant, delivered with that turn's next model request. Sent
	// and unconfirmed: never resent by the bridge.
	for _, c := range []struct {
		name          string
		turn, running string
	}{{"turn/start, a turn running", "", "t2"}, {"turn/start, idle", "", ""},
		{"steer, its turn ended, another running", "t1", "t2"}, {"steer, its turn ended, idle", "t1", ""}} {
		q = NewQuestions("th")
		q.Hydrate(ended)
		if !q.Restore(PriorSend{Batch: "call_3", Index: 0, Turn: c.turn}, c.running) {
			t.Fatalf("%s: the send no longer matters", c.name)
		}
		if x := q.Batch("call_3").Questions[0]; x.State != QSent || !x.Unconfirmed || x.Undelivered {
			t.Fatalf("%s: before its response = %+v", c.name, x)
		}
		q.TurnEnded("t2")
		if _, err := q.Check("call_3", reply); !errors.Is(err, ErrNotPending) {
			t.Fatalf("%s: a resend: %v", c.name, err)
		}
	}

	// A batch the reconciler no longer has, a question out of range.
	if q.Restore(PriorSend{Batch: "call_9", Turn: "t1"}, "t1") || q.Restore(PriorSend{Batch: "call_3", Index: 5, Turn: "t1"}, "t1") {
		t.Fatal("a send to nothing still matters")
	}

	// The live reconciler (a rejoin, not a restart): nothing changes.
	if !live.Restore(PriorSend{Batch: "call_3", Index: 0, Turn: "t0", Confirmed: true}, "t1") {
		t.Fatal("the live send no longer matters")
	}
	if x := live.Batch("call_3").Questions[0]; x.State != QSent || x.Undelivered {
		t.Fatalf("live after restore = %+v", x)
	}
}

// #158: a batch under a legacy id (item-N: thread/resume's, when reading
// the turn again failed or found nothing) is not answerable, and a join
// whose history still has one is unresolved. The next join's history
// replaces it: item-N ids are one join's.
func TestQuestionsLegacyIDsAreUnresolved(t *testing.T) {
	reply := []Reply{{Index: 0, Text: "Green"}}
	q := NewQuestions("th")
	legacy := []Turn{{ID: "t1", Status: TurnInProgress, Items: []Item{asyncItem("item-2", colorQ)}}}
	q.Hydrate(legacy)
	if !LegacyHistory(legacy) {
		t.Fatal("a legacy history: resolved")
	}
	if _, err := q.Check("item-2", reply); !errors.Is(err, ErrUnresolved) {
		t.Fatalf("answering item-2: %v", err)
	}
	if _, err := q.Begin("item-2", reply); !errors.Is(err, ErrUnresolved) {
		t.Fatalf("beginning item-2: %v", err)
	}
	if !q.Unanswered("t1") {
		t.Fatal("Codex still holds it: unanswered")
	}
	if err := q.Dismiss("item-2", nil); err != nil {
		t.Fatalf("dismissing it, in the bridge only: %v", err)
	}

	// The next join reads it under its call_id: the alias goes.
	canonical := []Turn{{ID: "t1", Status: TurnInProgress, Items: []Item{asyncItem("call_3", colorQ)}}}
	q.DropLegacy()
	q.Hydrate(canonical)
	if LegacyHistory(canonical) || q.Batch("item-2") != nil || len(q.Batches()) != 1 {
		t.Fatalf("after a canonical join: batches %+v", q.Batches())
	}
	if _, err := q.Check("call_3", reply); err != nil {
		t.Fatalf("call_3: %v", err)
	}

	// A twin of a live batch loses its twin with it.
	q = NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ), OriginLive)
	q.Hydrate([]Turn{{ID: "t1", Status: TurnInProgress, Items: []Item{asyncItem("item-2", colorQ)}}})
	if q.Batch("call_3").Twin != "item-2" {
		t.Fatalf("twins: %+v", q.Batches())
	}
	q.DropLegacy()
	if b := q.Batch("call_3"); b == nil || b.Twin != "" || q.Batch("item-2") != nil {
		t.Fatalf("after DropLegacy: %+v", q.Batches())
	}
}

// #158: a batch the view drops for room is never one whose answer is on its
// way (sending): the oldest other one goes.
func TestQuestionsKeepABatchWhileItsAnswerIsSending(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_0", contextQ), OriginLive)
	if _, err := q.Begin("call_0", []Reply{{Index: 0, Text: "x"}}); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= MaxBatches; i++ {
		q.Observe("t1", asyncItem(fmt.Sprintf("call_%d", i), contextQ), OriginLive)
	}
	if q.Batch("call_0") == nil || q.Batch("call_1") != nil || len(q.Batches()) != MaxBatches {
		t.Fatalf("batches: call_0 %v, call_1 %v, %d in all", q.Batch("call_0") != nil, q.Batch("call_1") != nil, len(q.Batches()))
	}
	// Sent: no longer protected (its record, the server's, outlives it).
	q.Sent("call_0", []int{0}, "t1", false)
	q.Observe("t1", asyncItem("call_x", contextQ), OriginLive)
	if q.Batch("call_0") != nil {
		t.Fatal("a sent batch kept past MaxBatches")
	}
}

// #158: what a join's history says on its own, whatever the view kept.
func TestHistoryHelpers(t *testing.T) {
	turns := []Turn{{ID: "t1", Items: []Item{asyncItem("call_3", colorQ),
		{Type: ItemUserMessage, ID: "item-4", Content: []UserInput{{Type: "text",
			Text: ReplyEnvelope(Answer{MessageID: "call_3", Index: 0, Answer: "Green"})}}}}}}
	if !InHistory(turns, "call_3") || InHistory(turns, "call_9") || !LegacyHistory(turns) {
		t.Fatal("InHistory / LegacyHistory")
	}
	if a := Answers(turns[0].Items[1]); len(a) != 1 || a[0].MessageID != "call_3" || a[0].Index != 0 {
		t.Fatalf("Answers = %+v", a)
	}
	if a := Answers(turns[0].Items[0]); a != nil {
		t.Fatalf("Answers of a batch = %+v", a)
	}
}

// #183: the reconciler and the transcript share one rule, and it is all or
// nothing: an envelope with an entry missing its question or answer (or with a
// null) answers nothing, not even its well-formed entries, exactly as the
// transcript shows it as the user's own text.
func TestQuestionsIgnoreAnIncompleteEnvelope(t *testing.T) {
	q := NewQuestions("th")
	q.Observe("t1", asyncItem("call_3", colorQ, contextQ), OriginLive)
	good := `{"questionItemId":"[\"request_user_input_async\",\"call_3\",0]","question":"Which fixture color?","answer":"Green"}`
	for name, entry := range map[string]string{
		"missing answer": `{"questionItemId":"[\"request_user_input_async\",\"call_3\",1]","question":"Any context for the fixture?"}`,
		"null question":  `{"questionItemId":"[\"request_user_input_async\",\"call_3\",1]","question":null,"answer":"x"}`,
		"null index":     `{"questionItemId":"[\"request_user_input_async\",\"call_3\",null]","question":"q","answer":"x"}`,
	} {
		env := "<send_user_message_question_reply>\n[" + good + "," + entry + "]\n</send_user_message_question_reply>"
		if q.Observe("t1", userItem("u-"+name, "", env), OriginLive) {
			t.Errorf("%s: the envelope changed something", name)
		}
		if got := states(t, q, "call_3"); got[0] != QPending || got[1] != QPending {
			t.Errorf("%s: states = %v", name, got)
		}
	}
	if len(Answers(userItem("u", "", "<send_user_message_question_reply>[{\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"call_3\\\",0]\"}]</send_user_message_question_reply>"))) != 0 {
		t.Error("Answers read an id-only entry")
	}
}
