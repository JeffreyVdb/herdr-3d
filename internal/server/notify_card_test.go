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

// The token-like secrets of a permission menu (#88): one in the command it
// is for, one in its question, one in a choice's quoted command.
const (
	menuCmdSecret = "ghp_CommandLine0123456789"
	menuQSecret   = "ghp_QuestionLine0123456789"
	menuLblSecret = "hunter2-in-a-label"
)

// secretPermission is Claude's permission prompt with a secret in its
// command, its question and a choice.
func secretPermission(t *testing.T) string {
	s := readScreen(t, "claude-permission-bash")
	s = strings.ReplaceAll(s, "touch h3d-perm-probe.txt", "curl -u admin:"+menuCmdSecret+" https://example.test")
	s = strings.Replace(s, "Do you want to proceed?", "Do you want to proceed with "+menuQSecret+"?", 1)
	return strings.Replace(s, "2. Yes, and always allow access to /tmp/h3d-m5term/claude-a2be86 from this project",
		"2. Yes, and don't ask again for `mysql -p"+menuLblSecret+"` commands", 1)
}

// menuCardOf has worker ws blocked on screen and waits for its
// notification and its menu's card.
func (rb *replyBridge) menuCardOf(t *testing.T, ws, screen string) notify.Ref {
	t.Helper()
	n, cards := len(rb.ch.Sent()), len(rb.ch.Cards())
	rb.term.setScreen(ws+":p1", screen)
	rb.setStatus(ws, "blocked")
	rb.sentFor(t, ws, n)
	return cardOf(t, rb.ch, cards+1)
}

// #88 acceptance through the hub: a worker blocked on Claude's permission
// prompt gets its notification, then one card: what it asks (a fixed
// line, not its question) and its choices, scrubbed, a button each,
// nothing of the command it is for. A tap answers
// as worker.answer does (the choice's digit on the worker's lane); the
// card says so. A trust menu (no digits) is answered with arrows and
// Enter, as the game's would be. Audited by indices, without a text.
func TestCardMenuThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	rb.term.onKeys = func(string, []string) { go rb.setStatus("w1", "working") }
	ref := rb.menuCardOf(t, "w1", secretPermission(t))
	c := rb.ch.Card(ref)
	for _, want := range []string{"Permission\nIt asks for your permission.", "1. Yes", "2. Yes, and don't ask again for `…` commands", "3. No"} {
		if !strings.Contains(c.Text, want) {
			t.Fatalf("card %q lacks %q", c.Text, want)
		}
	}
	shown := c.Text
	for _, row := range c.Buttons {
		for _, b := range row {
			shown += "\n" + b.Text + "\n" + b.Data
		}
	}
	for _, n := range rb.ch.Sent() {
		shown += "\n" + n.Line
	}
	for _, secret := range []string{menuCmdSecret, menuQSecret, menuLblSecret, "curl", "example.test"} {
		if strings.Contains(shown, secret) {
			t.Fatalf("%q left the bridge: %q", secret, shown)
		}
	}
	if len(c.Buttons) != 3 {
		t.Fatalf("buttons %+v", c.Buttons)
	}
	rb.ch.Tap("t1", ref, buttonData(t, c, "1."))
	if end := waitCardText(t, rb.ch, ref, "✓ Answered: Yes"); len(end.Buttons) != 0 {
		t.Fatalf("buttons left %+v", end.Buttons)
	}
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 1"}) {
		t.Fatalf("calls %q", calls)
	}

	// The trust dialog: no digits, so down and Enter for choice 2.
	time.Sleep(2 * time.Millisecond) // status_since is in ms: a new one
	ref = rb.menuCardOf(t, "w1", readScreen(t, "claude-trust"))
	c = rb.ch.Card(ref)
	if !strings.Contains(c.Text, "Trust folder\nIt asks whether to trust a folder.") || strings.Contains(c.Text, "Quick safety check") || len(c.Buttons) != 2 || strings.Contains(c.Text, "/tmp/h3d-m5term") {
		t.Fatalf("trust card %+v", c)
	}
	rb.ch.Tap("t2", ref, buttonData(t, c, "2."))
	waitCardText(t, rb.ch, ref, "✓ Answered: Yes, I trust this folder")
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 1", "keys w1:p1 down enter"}) {
		t.Fatalf("calls %q", calls)
	}
	if a := rb.ch.TapAnswers(); len(a) != 2 || a[0].ID != "t1" || a[1].ID != "t2" {
		t.Fatalf("tap answers %+v", a)
	}
	ans := waitNotifyRows(t, rb.st, notify.AuditAnswer, 2)
	var row struct {
		Kind    string `json:"kind"`
		Choices int    `json:"choices"`
		Outcome string `json:"outcome"`
	}
	if err := json.Unmarshal([]byte(ans[1].Args), &row); err != nil || !ans[1].OK || row.Kind != "menu" || row.Choices != 1 || row.Outcome != "sent" {
		t.Fatalf("audit %+v", ans[1])
	}
	log, err := rb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if e.Cmd == proto.CmdWorkerAnswer || strings.Contains(e.Args+e.Result, "trust") || strings.Contains(e.Args+e.Result, "proceed") {
			t.Errorf("audit row %+v", e)
		}
	}

	// An ask's dialog read off the screen (a choice, not a permission):
	// its notification only.
	n := len(rb.ch.Sent())
	cards := len(rb.ch.Cards())
	time.Sleep(2 * time.Millisecond)
	rb.term.setScreen("w2:p1", readScreen(t, "claude-question"))
	rb.setStatus("w2", "blocked")
	rb.sentFor(t, "w2", n)
	upsertFor(rb.c, rb.ids["w2"], func(w *proto.Worker) bool { return w.Question != nil })
	time.Sleep(50 * time.Millisecond)
	if len(rb.ch.Cards()) != cards {
		t.Fatalf("a card for a choice menu: %+v", rb.ch.Card(rb.ch.Cards()[cards]))
	}
}

// A tap on a menu the screen no longer shows (#88: the hub reads it again
// before any key): no key is sent and the card says no longer open; the
// new menu gets its own card.
func TestCardMenuStaleThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.QuestionPoll = time.Hour })
	rb.repliesOn(t)
	first := readScreen(t, "claude-permission-bash")
	ref := rb.menuCardOf(t, "w1", first)
	yes := buttonData(t, rb.ch.Card(ref), "1.")
	rb.term.setScreen("w1:p1", strings.ReplaceAll(first, "touch h3d-perm-probe.txt", "rm -rf important-project"))
	rb.ch.Tap("t1", ref, yes)
	if c := waitCardText(t, rb.ch, ref, notify.CardClosedText); len(c.Buttons) != 0 {
		t.Fatalf("buttons left %+v", c.Buttons)
	}
	if calls := rb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
	if next := cardOf(t, rb.ch, 2); next == ref || !strings.Contains(rb.ch.Card(next).Text, "It asks for your permission.") {
		t.Fatalf("new card %+v", rb.ch.Card(next))
	}
}

// Keys sent and the worker still blocked after AnswerTimeout (#88): the
// card says what was sent and to look in the game; audited as unresolved.
func TestCardMenuUnresolvedThroughTheHub(t *testing.T) {
	t.Parallel()
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.AnswerTimeout = time.Millisecond })
	rb.repliesOn(t)
	ref := rb.menuCardOf(t, "w1", readScreen(t, "claude-permission-bash"))
	rb.ch.Tap("t1", ref, buttonData(t, rb.ch.Card(ref), "3."))
	if c := waitCardText(t, rb.ch, ref, "✓ Sent: No\n"+notify.CardUnresolvedText); len(c.Buttons) != 0 {
		t.Fatalf("buttons left %+v", c.Buttons)
	}
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 3"}) {
		t.Fatalf("calls %q", calls)
	}
	ans := waitNotifyRows(t, rb.st, notify.AuditAnswer, 1)
	if !ans[0].OK || !strings.Contains(ans[0].Args, `"outcome":"unresolved"`) {
		t.Fatalf("audit %+v", ans[0])
	}
}
