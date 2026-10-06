package codexapp

import (
	"encoding/json"
	"errors"
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
