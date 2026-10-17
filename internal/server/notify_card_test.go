package server_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// cardOf waits for the n-th card (from 1) of the fake channel.
func cardOf(t *testing.T, ch *notify.FakeChannel, n int) notify.Ref {
	t.Helper()
	if !ch.WaitFor(func() bool { return len(ch.Cards()) >= n }, 5*time.Second) {
		t.Fatalf("%d cards, want %d", len(ch.Cards()), n)
	}
	return ch.Cards()[n-1]
}

// buttonData is the data of a card's button whose label starts with prefix.
func buttonData(t *testing.T, c notify.Card, prefix string) string {
	t.Helper()
	for _, row := range c.Buttons {
		for _, b := range row {
			if strings.HasPrefix(b.Text, prefix) {
				return b.Data
			}
		}
	}
	t.Fatalf("no button %q in %+v", prefix, c.Buttons)
	return ""
}

func waitCardText(t *testing.T, ch *notify.FakeChannel, ref notify.Ref, want string) notify.Card {
	t.Helper()
	if !ch.WaitFor(func() bool { return strings.Contains(ch.Card(ref).Text, want) }, 5*time.Second) {
		t.Fatalf("card %q, want %q in it", ch.Card(ref).Text, want)
	}
	return ch.Card(ref)
}

// #14 acceptance through the hub: "Tea or coffee?" on the phone, its
// options with their descriptions, a button each, Other… and Cancel; one tap
// answers the ask as worker.answer_ask does (its digit on the worker's
// lane), the transcript records it and the card says so. Audited by
// indices, without a text.
func TestCardTapAnswersTheAsk(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	const tu = "toolu_01FuqDRbauxtx9cAAmN3o8ex"
	playDialog(rb.termBridge, "w1:p1", "q", map[string]string{"q": readScreen(t, "claude-ask-single"), "done": "● DONE\n"},
		map[string]map[string]string{"q": {"2": "done"}},
		map[string]func(){"done": func() {
			appendLine(t, rb.claude, strings.Replace(fixtureLine(t, "claude", "ask.jsonl", 2), "toolu_014F63f4HMf8ayZ7AhNMC8Uh", tu, 1))
		}})
	n := len(rb.ch.Sent())
	appendLine(t, rb.claude, fixture(t, "claude", "ask_pending.jsonl"))
	askOf(rb.c, rb.ids["w1"], pendingID(tu))
	rb.sentFor(t, "w1", n)
	ref := cardOf(t, rb.ch, 1)
	c := rb.ch.Card(ref)
	for _, want := range []string{"Tea or coffee?", "1. Tea\nHot tea", "2. Coffee\nHot coffee"} {
		if !strings.Contains(c.Text, want) {
			t.Fatalf("card %q lacks %q", c.Text, want)
		}
	}
	if len(c.Buttons) != 3 || c.Buttons[2][0].Text != "Other…" || c.Buttons[2][1].Text != "Cancel" {
		t.Fatalf("buttons %+v", c.Buttons)
	}
	rb.ch.Tap("t1", ref, buttonData(t, c, "2."))
	askOf(rb.c, rb.ids["w1"], noAsk)
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 2"}) {
		t.Fatalf("calls %q", calls)
	}
	end := waitCardText(t, rb.ch, ref, "✓ Answered: Coffee")
	if len(end.Buttons) != 0 {
		t.Fatalf("buttons left %+v", end.Buttons)
	}
	if a := rb.ch.TapAnswers(); len(a) != 1 || a[0].ID != "t1" {
		t.Fatalf("tap answers %+v", a)
	}
	ans := waitNotifyRows(t, rb.st, notify.AuditAnswer, 1)
	var row struct {
		ID      string `json:"id"`
		Kind    string `json:"kind"`
		Choices int    `json:"choices"`
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal([]byte(ans[0].Args), &row); err != nil || !ans[0].OK || row.ID != rb.ids["w1"] || row.Kind != "ask" ||
		row.Choices != 1 || row.Outcome != "sent" {
		t.Fatalf("audit %+v", ans[0])
	}
	if taps := waitNotifyRows(t, rb.st, notify.AuditTap, 1); !taps[0].OK || strings.Contains(taps[0].Args, "Coffee") {
		t.Fatalf("tap audit %+v", taps[0])
	}
	log, err := rb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if e.Cmd == proto.CmdWorkerAnswerAsk || strings.Contains(e.Args+e.Result, "Coffee") {
			t.Errorf("audit row %+v", e)
		}
	}
}

// Answered in the game first: the phone's card is edited to say so, its
// buttons gone; a tap on it then answers nothing.
func TestCardAnsweredInTheGameFirst(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	const tu = "toolu_01FuqDRbauxtx9cAAmN3o8ex"
	playDialog(rb.termBridge, "w1:p1", "q", map[string]string{"q": readScreen(t, "claude-ask-single"), "done": "● DONE\n"},
		map[string]map[string]string{"q": {"1": "done"}},
		map[string]func(){"done": func() {
			appendLine(t, rb.claude, strings.Replace(fixtureLine(t, "claude", "ask.jsonl", 2), "toolu_014F63f4HMf8ayZ7AhNMC8Uh", tu, 1))
		}})
	appendLine(t, rb.claude, fixture(t, "claude", "ask_pending.jsonl"))
	askOf(rb.c, rb.ids["w1"], pendingID(tu))
	ref := cardOf(t, rb.ch, 1)
	tea := buttonData(t, rb.ch.Card(ref), "1.")
	if r := answerAsk(t, rb.c, proto.WorkerAnswerAskArgs{ID: rb.ids["w1"], ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}}); !r.Resolved {
		t.Fatalf("result %+v", r)
	}
	if c := waitCardText(t, rb.ch, ref, notify.CardInGameText); len(c.Buttons) != 0 {
		t.Fatalf("buttons left %+v", c)
	}
	calls := len(rb.term.Calls())
	rb.ch.Tap("late", ref, tea)
	if !rb.ch.WaitFor(func() bool { return len(rb.ch.TapAnswers()) == 1 }, 5*time.Second) || rb.ch.TapAnswers()[0].Text != "No longer open" {
		t.Fatalf("tap answers %+v", rb.ch.TapAnswers())
	}
	time.Sleep(50 * time.Millisecond)
	if len(rb.term.Calls()) != calls {
		t.Fatalf("typed %q", rb.term.Calls())
	}
}

// A secret ask: one card, none of its texts, no button (the hub gives the
// notifications none of a secret ask's texts).
func TestCardSecretAskThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	n := len(rb.ch.Sent())
	// Codex's ask, its question made secret (isSecret).
	appendLine(t, rb.codex, strings.Replace(fixture(t, "codex", "ask_pending.jsonl"), `\"id\":\"long\",`, `\"id\":\"long\",\"isSecret\":true,`, 1))
	w := askOf(rb.c, rb.ids["w2"], func(a *proto.Ask) bool { return a != nil })
	if !w.Ask.Questions[0].Secret {
		t.Fatalf("not secret: %+v", w.Ask.Questions[0])
	}
	rb.sentFor(t, "w2", n)
	ref := cardOf(t, rb.ch, 1)
	c := rb.ch.Card(ref)
	if !strings.Contains(c.Text, "Answer this one in the game") || len(c.Buttons) != 0 {
		t.Fatalf("card %+v", c)
	}
	for _, q := range w.Ask.Questions {
		for _, o := range q.Options {
			if strings.Contains(c.Text, o.Label) {
				t.Fatalf("an option in the card %q", c.Text)
			}
		}
		if strings.Contains(c.Text, q.Question) || strings.Contains(c.Text, q.Header) {
			t.Fatalf("the question in the card %q", c.Text)
		}
	}
}

// Follow-ups through the hub: a yes_no and a choice question are buttons;
// once both are tapped the answers go as worker.answer_followup's one
// prompt.
func TestCardFollowupThroughTheHub(t *testing.T) {
	t.Parallel()
	ch := notify.NewFakeChannel(true)
	clock := notify.NewFakeClock(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC))
	enabled := true
	fb := startFuBridgeWith(t, "", "", newFuRoles(), on(), "", func(o *server.Options) {
		o.NotifyChannel, o.NotifyEnabled, o.NotifyClock = ch, &enabled, clock
	})
	c := fb.connect(proto.Hello{})
	c.snapshot()
	replies := true
	c.mustAck(proto.CmdNotifySet, proto.NotifySetArgs{Replies: &replies})
	id := fb.ids["w1"]
	fb.turn(t, "claude", "followup_questions.jsonl")
	f := followupOf(c, id).Followup
	q1, q2 := cardOf(t, ch, 1), cardOf(t, ch, 2)
	c1, c2 := ch.Card(q1), ch.Card(q2)
	if !strings.Contains(c1.Text, "Follow-up 1 of 2") || !strings.Contains(c1.Text, f.Questions[0].Question) || buttonData(t, c1, "No") == "" {
		t.Fatalf("card 1 %+v", c1)
	}
	ch.Tap("t1", q1, buttonData(t, c1, "No"))
	ch.Tap("t2", q2, buttonData(t, c2, "2."))
	upsertFor(c, id, func(w *proto.Worker) bool { return w.Followup == nil })
	want := "Answers to your open questions:\n" +
		"1. Does the legacy importer still need the v1 format? → No\n" +
		"2. Ship this already, or wait for the e2e-live run? → Wait for e2e-live"
	b, _ := json.Marshal(want)
	if !slices.Contains(fb.term.Calls(), "type w1:p1 "+string(b)) {
		t.Fatalf("calls %q", fb.term.Calls())
	}
	waitCardText(t, ch, q2, "✓ Answered: Wait for e2e-live")
}
