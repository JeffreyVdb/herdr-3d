package notify

import (
	"context"
	"encoding/json"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf16"
)

// answerer is the hub's Answer in a test: it records the answers; refuse
// says at once, lane when the lane ends (nil: answered).
type answerer struct {
	mu      sync.Mutex
	got     []Answer
	refuse  error
	lane    error
	pending chan func()
}

func (a *answerer) answer(_ context.Context, x Answer, done func(error)) error {
	a.mu.Lock()
	refuse, lane := a.refuse, a.lane
	if refuse == nil {
		a.got = append(a.got, x)
	}
	a.mu.Unlock()
	if refuse != nil {
		return refuse
	}
	go done(lane)
	return nil
}

func (a *answerer) all() []Answer {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Answer(nil), a.got...)
}

func newCardRig(t *testing.T, a *answerer) *rig {
	t.Helper()
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		o.Answer = a.answer
		o.Prompt = (&prompter{}).prompt
		st.Replies = true
	})
	waitListening(t, r.ch)
	return r
}

func dbAsk(id string, multi, other bool) *Ask {
	return &Ask{ToolUseID: id, Since: 50, Questions: []AskQuestion{{HasOptions: true, Header: "Database", Question: "Which database?",
		Multi: multi, Other: other, Options: []AskOption{
			{Label: "Postgres", Description: "Relational, the default"},
			{Label: "SQLite", Description: "One file", Preview: "CREATE TABLE t (id INTEGER);"},
			{Label: "Redis"}}}}}
}

func asking(id string, a *Ask) Observation {
	return Observation{Worker: Worker{ID: id, Status: "working", StatusSince: 1, Ask: a}, Name: "Pixel"}
}

// cardsFor has worker id ask a (after a sighting without it) and waits for
// n cards after its notification.
func (r *rig) cardsFor(t *testing.T, id string, o Observation, n int) []Ref {
	t.Helper()
	before := len(r.ch.Cards())
	r.svc.Observe(working(id))
	r.svc.Observe(o)
	if !r.ch.WaitFor(func() bool { return len(r.ch.Cards()) >= before+n }, 5*time.Second) {
		t.Fatalf("%d cards, want %d", len(r.ch.Cards())-before, n)
	}
	return r.ch.Cards()[before:]
}

var tapN int

func (r *rig) tap(t *testing.T, msg Ref, data string) string {
	t.Helper()
	tapN++
	id := "tap" + strconv.Itoa(tapN)
	if !r.ch.Tap(id, msg, data) {
		t.Fatal("the tap was not read")
	}
	return id
}

// tapAnswer waits for tap id's answer.
func (r *rig) tapAnswer(t *testing.T, id string) string {
	t.Helper()
	var text string
	ok := r.ch.WaitFor(func() bool {
		for _, a := range r.ch.TapAnswers() {
			if a.ID == id {
				text = a.Text
				return true
			}
		}
		return false
	}, 5*time.Second)
	if !ok {
		t.Fatalf("tap %s not answered", id)
	}
	return text
}

func button(t *testing.T, c Card, prefix string) Button {
	t.Helper()
	for _, row := range c.Buttons {
		for _, b := range row {
			if strings.HasPrefix(b.Text, prefix) {
				return b
			}
		}
	}
	t.Fatalf("no button %q in %+v", prefix, c.Buttons)
	return Button{}
}

func (r *rig) waitCard(t *testing.T, ref Ref, want string) Card {
	t.Helper()
	if !r.ch.WaitFor(func() bool { return strings.Contains(r.ch.Card(ref).Text, want) }, 5*time.Second) {
		t.Fatalf("card %v: %q, want %q in it", ref, r.ch.Card(ref).Text, want)
	}
	return r.ch.Card(ref)
}

func (r *rig) waitAnswers(t *testing.T, a *answerer, n int) []Answer {
	t.Helper()
	if !r.ch.WaitFor(func() bool { return len(a.all()) >= n }, 5*time.Second) {
		t.Fatalf("%d answers, want %d", len(a.all()), n)
	}
	return a.all()
}

func rowsOf(r *rig, cmd string) []auditRow {
	var out []auditRow
	for _, a := range r.rows() {
		if a.cmd == cmd {
			out = append(out, a)
		}
	}
	return out
}

// #14 acceptance: "Which database?" with three options on the phone: the
// options and their descriptions, a button each and Cancel; one tap answers
// it (choice 2, 1-based) and the card says so; audited without a text.
func TestCardSingleChoice(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_1", false, false)), 1)
	if n := r.ch.Sent(); len(n) != 1 || n[0].Reason != ReasonQuestion {
		t.Fatalf("notification %+v", n)
	}
	c := r.ch.Card(refs[0])
	for _, want := range []string{"Pixel · Question · Database", "Which database?", "1. Postgres", "Relational, the default", "2. SQLite", "One file", "Preview: CREATE TABLE", "3. Redis"} {
		if !strings.Contains(c.Text, want) {
			t.Errorf("card %q lacks %q", c.Text, want)
		}
	}
	if len(c.Buttons) != 4 || c.Buttons[3][0].Text != "Cancel" || len(c.Buttons[3]) != 1 {
		t.Fatalf("buttons %+v", c.Buttons)
	}
	for _, row := range c.Buttons {
		for _, b := range row {
			if len(b.Data) > MaxButtonData || strings.Contains(b.Data, "toolu") {
				t.Fatalf("data %q", b.Data)
			}
		}
	}
	id := r.tap(t, refs[0], button(t, c, "2.").Data)
	if got := r.tapAnswer(t, id); got != tapSendingText {
		t.Fatalf("tap answered %q", got)
	}
	got := r.waitAnswers(t, a, 1)
	want := Answer{WorkerID: "w1", ToolUseID: "toolu_1", Ask: []AskAnswer{{Question: 0, Choices: []int{2}}}}
	if !reflect.DeepEqual(got[0], want) {
		t.Fatalf("answer %+v, want %+v", got[0], want)
	}
	end := r.waitCard(t, refs[0], "✓ Answered: SQLite")
	if len(end.Buttons) != 0 || strings.Contains(end.Text, "Redis") {
		t.Fatalf("ended card %+v", end)
	}
	// The ask leaves the worker: the card is not edited again.
	edits := r.ch.Edits()
	r.svc.Observe(working("w1"))
	time.Sleep(50 * time.Millisecond)
	if r.ch.Edits() != edits {
		t.Fatalf("edited after its answer: %q", r.ch.Card(refs[0]).Text)
	}
	taps := rowsOf(r, AuditTap)
	ans := rowsOf(r, AuditAnswer)
	if len(taps) != 1 || len(ans) != 1 || ans[0].err != nil {
		t.Fatalf("audit %+v %+v", taps, ans)
	}
	if ta := taps[0].args.(tapAudit); ta.ID != "w1" || ta.Kind != kindAsk || *ta.Question != 0 || ta.Action != "option" || ta.Option != 2 || ta.Outcome != tapOK {
		t.Fatalf("tap row %+v", ta)
	}
	if aa := ans[0].args.(answerAudit); aa.ID != "w1" || aa.Questions != 1 || aa.Choices != 1 || aa.Outcome != replySent {
		t.Fatalf("answer row %+v", aa)
	}
}

// Multi-select: taps toggle (the card shows the picks), Done sends them;
// Done with none picked is refused.
func TestCardMultiToggleDone(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_m", true, false)), 1)
	c := r.ch.Card(refs[0])
	if !strings.Contains(c.Text, cardMultiText) || button(t, c, "☐ 1.").Text != "☐ 1. Postgres" {
		t.Fatalf("card %+v", c)
	}
	if got := r.tapAnswer(t, r.tap(t, refs[0], button(t, c, "Done").Data)); got != tapPickText {
		t.Fatalf("empty done: %q", got)
	}
	r.tap(t, refs[0], button(t, c, "☐ 1.").Data)
	r.tap(t, refs[0], button(t, c, "☐ 3.").Data)
	r.tap(t, refs[0], button(t, c, "☐ 2.").Data)
	id := r.tap(t, refs[0], button(t, c, "☐ 2.").Data) // and off again
	r.tapAnswer(t, id)
	if !r.ch.WaitFor(func() bool {
		c = r.ch.Card(refs[0])
		return len(c.Buttons) > 0 && strings.HasPrefix(c.Buttons[0][0].Text, "☑") && strings.HasPrefix(c.Buttons[1][0].Text, "☐") &&
			strings.HasPrefix(c.Buttons[2][0].Text, "☑")
	}, 5*time.Second) {
		t.Fatalf("toggles %+v", r.ch.Card(refs[0]).Buttons)
	}
	if len(a.all()) != 0 {
		t.Fatal("sent before Done")
	}
	r.tap(t, refs[0], button(t, c, "Done (2)").Data)
	got := r.waitAnswers(t, a, 1)
	if !reflect.DeepEqual(got[0].Ask, []AskAnswer{{Question: 0, Choices: []int{1, 3}}}) {
		t.Fatalf("answer %+v", got[0])
	}
	r.waitCard(t, refs[0], "✓ Answered: Postgres, Redis")
}

// Other…: a reply prompt; the reply to it fills other and sends. A reply to
// the card itself is told to tap, never typed into the worker.
func TestCardOtherTyped(t *testing.T) {
	a := &answerer{}
	p := &prompter{}
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		o.Answer, o.Prompt = a.answer, p.prompt
		st.Replies = true
	})
	waitListening(t, r.ch)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_o", false, true)), 1)
	c := r.ch.Card(refs[0])
	if got := r.tapAnswer(t, r.tap(t, refs[0], button(t, c, "Other…").Data)); got != tapTypeText {
		t.Fatalf("other: %q", got)
	}
	if !r.ch.WaitFor(func() bool { return len(r.ch.Prompts()) == 1 }, 5*time.Second) {
		t.Fatal("no prompt")
	}
	pr := r.ch.Prompts()[0]
	if pr.To != refs[0] || pr.Placeholder != "Database" {
		t.Fatalf("prompt %+v", pr)
	}
	r.clock.Advance(time.Second)
	hint := r.reply(refs[0], "MySQL")
	if ans := waitAnswered(t, r, 1); ans.To != hint.Ref || ans.Text != ReplyAskText {
		t.Fatalf("reply to the card: %+v", ans)
	}
	bad := r.reply(pr.Ref, "two\nlines")
	if ans := waitAnswered(t, r, 2); ans.To != bad.Ref || ans.Text != typedLineText {
		t.Fatalf("two lines: %+v", ans)
	}
	ok := r.reply(pr.Ref, "  MySQL 8  ")
	got := r.waitAnswers(t, a, 1)
	if len(got[0].Ask) != 1 || got[0].Ask[0].Other == nil || *got[0].Ask[0].Other != "MySQL 8" || len(got[0].Ask[0].Choices) != 0 {
		t.Fatalf("answer %+v", got[0])
	}
	if !r.ch.WaitFor(func() bool { return len(r.ch.Confirmed()) == 1 }, 5*time.Second) || r.ch.Confirmed()[0] != ok.Ref {
		t.Fatalf("confirmed %+v", r.ch.Confirmed())
	}
	r.waitCard(t, refs[0], "✓ Answered: “MySQL 8”")
	if typed := p.all(); len(typed) != 0 {
		t.Fatalf("typed as prompts: %q", typed)
	}
	for _, row := range r.rows() {
		if b, _ := json.Marshal(row.args); strings.Contains(string(b), "MySQL") {
			t.Fatalf("typed text audited: %s %s", row.cmd, b)
		}
	}
}

// A secret question: one card that says to answer it in the game, no
// question, no option, no button; answered in the game, it says so.
func TestCardSecretNeverRelayed(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ask := &Ask{ToolUseID: "toolu_s", Since: 50, Questions: []AskQuestion{{HasOptions: true, Secret: true}, {HasOptions: true}}}
	refs := r.cardsFor(t, "w1", asking("w1", ask), 1)
	time.Sleep(50 * time.Millisecond)
	if len(r.ch.Cards()) != 1 {
		t.Fatalf("%d cards", len(r.ch.Cards()))
	}
	c := r.ch.Card(refs[0])
	if c.Text != "Pixel · Question\n"+CardSecretText || len(c.Buttons) != 0 || !strings.Contains(c.Text, "Answer this one in the game") {
		t.Fatalf("card %+v", c)
	}
	r.svc.Observe(working("w1"))
	r.waitCard(t, refs[0], CardInGameText)
}

// Cancel answers cancel: true.
func TestCardCancel(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_c", false, false)), 1)
	r.tap(t, refs[0], button(t, r.ch.Card(refs[0]), "Cancel").Data)
	got := r.waitAnswers(t, a, 1)
	if !got[0].Cancel || got[0].Ask != nil || got[0].ToolUseID != "toolu_c" {
		t.Fatalf("answer %+v", got[0])
	}
	r.waitCard(t, refs[0], CardCancelText)
}

// Answered in the game first: the cards say so, no button left. A tap on
// one after that (or on a card the bridge does not know: a restart) is
// answered "no longer open", its buttons taken away, nothing sent.
func TestCardAnsweredInTheGame(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	ask := dbAsk("toolu_g", false, false)
	ask.Questions = append(ask.Questions, AskQuestion{HasOptions: true, Question: "Which cache?", Options: []AskOption{{Label: "None"}}})
	refs := r.cardsFor(t, "w1", asking("w1", ask), 2)
	old := r.ch.Card(refs[0])
	if !strings.Contains(old.Text, "Question 1 of 2") {
		t.Fatalf("card %q", old.Text)
	}
	// The first question answered: waits for the second.
	r.tap(t, refs[0], button(t, old, "1.").Data)
	r.waitCard(t, refs[0], CardWaitText)
	r.svc.Observe(working("w1"))
	for _, ref := range refs {
		if c := r.waitCard(t, ref, CardInGameText); len(c.Buttons) != 0 {
			t.Fatalf("buttons left %+v", c)
		}
	}
	id := r.tap(t, refs[1], button(t, old, "Cancel").Data)
	if got := r.tapAnswer(t, id); got != tapClosedText {
		t.Fatalf("stale tap: %q", got)
	}
	id = r.tap(t, Ref{FakeChatID, 77}, "deadbeef:o1")
	if got := r.tapAnswer(t, id); got != tapClosedText {
		t.Fatalf("unknown tap: %q", got)
	}
	if !r.ch.WaitFor(func() bool { return len(r.ch.Cleared()) == 2 }, 5*time.Second) {
		t.Fatalf("cleared %+v", r.ch.Cleared())
	}
	if len(a.all()) != 0 {
		t.Fatalf("sent %+v", a.all())
	}
}

// The hub finds the ask gone or replaced (stale): the cards say it is no
// longer open; a refusal says why.
func TestCardAnswerRefused(t *testing.T) {
	a := &answerer{lane: &ReplyError{Kind: ReplyClosed}}
	r := newCardRig(t, a)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_r", false, false)), 1)
	r.tap(t, refs[0], button(t, r.ch.Card(refs[0]), "1.").Data)
	r.waitCard(t, refs[0], CardClosedText)
	a.mu.Lock()
	a.lane, a.refuse = nil, &ReplyError{Kind: ReplyBusy}
	a.mu.Unlock()
	refs = r.cardsFor(t, "w2", asking("w2", dbAsk("toolu_r2", false, false)), 1)
	r.tap(t, refs[0], button(t, r.ch.Card(refs[0]), "1.").Data)
	r.waitCard(t, refs[0], answers[ReplyBusy])
	ans := rowsOf(r, AuditAnswer)
	if len(ans) != 2 || ans[0].err == nil || ans[0].err.Error() != ReplyClosed || ans[1].err.Error() != ReplyBusy {
		t.Fatalf("audit %+v", ans)
	}
}

// Follow-ups: yes_no and choice are buttons, open a reply prompt; one
// answer once all are answered.
func TestCardFollowup(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	fu := &Followup{TurnID: "turn-9", At: 60, Questions: []FollowupQuestion{
		{ID: "q1", Question: "Ship it?", Kind: "yes_no", Recommendation: "Yes, it is tested"},
		{ID: "q2", Label: "Q2", Question: "Which branch?", Kind: "choice", Options: 2, Choices: []string{"main", "next"}, Context: "next is the release"},
		{ID: "q3", Question: "Anything else?", Kind: "open"}}}
	refs := r.cardsFor(t, "w1", Observation{Worker: Worker{ID: "w1", Status: "done", StatusSince: 1, Followup: fu}, Name: "Pixel"}, 3)
	c1, c2, c3 := r.ch.Card(refs[0]), r.ch.Card(refs[1]), r.ch.Card(refs[2])
	if !strings.Contains(c1.Text, "Pixel · Follow-up 1 of 3\nShip it?") || !strings.Contains(c1.Text, "Recommended: Yes, it is tested") ||
		len(c1.Buttons) != 1 || c1.Buttons[0][0].Text != "Yes" || c1.Buttons[0][1].Text != "No" {
		t.Fatalf("yes_no %+v", c1)
	}
	if !strings.Contains(c2.Text, "Q2 Which branch?") || !strings.Contains(c2.Text, "next is the release") || button(t, c2, "2.").Text != "2. next" {
		t.Fatalf("choice %+v", c2)
	}
	if len(c3.Buttons) != 1 || c3.Buttons[0][0].Text != "Answer…" {
		t.Fatalf("open %+v", c3)
	}
	for _, c := range []Card{c1, c2, c3} {
		for _, row := range c.Buttons {
			for _, b := range row {
				if b.Text == "Cancel" {
					t.Fatalf("a follow-up with Cancel: %+v", c)
				}
			}
		}
	}
	r.tap(t, refs[0], button(t, c1, "No").Data)
	r.tap(t, refs[1], button(t, c2, "2.").Data)
	r.tap(t, refs[2], button(t, c3, "Answer…").Data)
	if !r.ch.WaitFor(func() bool { return len(r.ch.Prompts()) == 1 }, 5*time.Second) {
		t.Fatal("no prompt")
	}
	r.waitCard(t, refs[0], "✓ No\n"+CardWaitText)
	r.clock.Advance(time.Second)
	r.reply(r.ch.Prompts()[0].Ref, "Bump the version\nand tag it")
	got := r.waitAnswers(t, a, 1)
	want := Answer{WorkerID: "w1", TurnID: "turn-9", Followup: []FollowupAnswer{{"q1", "No"}, {"q2", "next"}, {"q3", "Bump the version\nand tag it"}}}
	if !reflect.DeepEqual(got[0], want) {
		t.Fatalf("answer %+v, want %+v", got[0], want)
	}
	r.waitCard(t, refs[1], "✓ Answered: next")
}

// Replies switched off: the open cards say so; a tap read before is not
// for a worker (answered, nothing sent). Off at the notification: no cards.
func TestCardRepliesOff(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	refs := r.cardsFor(t, "w1", asking("w1", dbAsk("toolu_x", false, false)), 1)
	c := r.ch.Card(refs[0])
	r.ch.mu.Lock()
	h, epoch := r.ch.hooks.Tap, r.ch.epoch
	r.ch.mu.Unlock()
	off := false
	if err := r.svc.Apply(context.Background(), Update{Replies: &off}); err != nil {
		t.Fatal(err)
	}
	r.waitCard(t, refs[0], CardOffText)
	h(Tap{ID: "late", Msg: refs[0], Data: button(t, c, "1.").Data, Epoch: epoch})
	if got := r.tapAnswer(t, "late"); got != tapOffText {
		t.Fatalf("late tap: %q", got)
	}
	r.svc.Observe(working("w2"))
	r.svc.Observe(asking("w2", dbAsk("toolu_y", false, false)))
	if !r.ch.WaitSent(2, 5*time.Second) {
		t.Fatal("no notification")
	}
	time.Sleep(50 * time.Millisecond)
	if len(r.ch.Cards()) != 1 || len(a.all()) != 0 {
		t.Fatalf("cards %d, answers %+v", len(r.ch.Cards()), a.all())
	}
	if rows := rowsOf(r, AuditTap); len(rows) != 1 || rows[0].args.(tapAudit).Outcome != tapOff {
		t.Fatalf("audit %+v", rows)
	}
}

// The replier behind: past ReplyQueue waiting a tap is refused, and the
// channel answers it, so every tap is answered exactly once.
func TestCardTapQueueFull(t *testing.T) {
	r := newRigWith(t, true, func(_ *Options, st *Settings) { st.Replies = true })
	waitListening(t, r.ch)
	entered, release := make(chan struct{}), make(chan struct{})
	r.svc.job(func(context.Context) { close(entered); <-release })
	<-entered
	for i := range ReplyQueue + 1 {
		if !r.ch.Tap("tap-"+strconv.Itoa(i), Ref{FakeChatID, 999}, "old:o1") {
			t.Fatal("tap not handed over")
		}
	}
	drained := make(chan struct{})
	r.svc.job(func(context.Context) { close(drained) })
	close(release)
	<-drained
	got := map[string]int{}
	for _, a := range r.ch.TapAnswers() {
		got[a.ID]++
	}
	for i := range ReplyQueue + 1 {
		if id := "tap-" + strconv.Itoa(i); got[id] != 1 {
			t.Fatalf("%s answered %d times (%d answers)", id, got[id], len(r.ch.TapAnswers()))
		}
	}
}

// A card stays within Telegram's bounds whatever the ask: its text, the
// data of its buttons; a long description and preview are cut.
func TestCardBounds(t *testing.T) {
	a := &answerer{}
	r := newCardRig(t, a)
	q := AskQuestion{HasOptions: true, Header: strings.Repeat("H", 64), Question: strings.Repeat("Why? 😀 ", 300), Multi: true, Other: true}
	for i := range 8 {
		q.Options = append(q.Options, AskOption{Label: strings.Repeat("L😀", 100), Description: strings.Repeat("d", 1000) + strconv.Itoa(i),
			Preview: strings.Repeat("p\n", 512)})
	}
	refs := r.cardsFor(t, "w1", asking("w1", &Ask{ToolUseID: "toolu_b", Since: 50, Questions: []AskQuestion{q, q, q, q}}), 4)
	for _, ref := range refs {
		c := r.ch.Card(ref)
		if n := len(utf16.Encode([]rune(c.Text))); n > CardTextMax {
			t.Fatalf("text of %d units", n)
		}
		if strings.Contains(c.Text, strings.Repeat("d", cardDescMax+1)) || strings.Contains(c.Text, strings.Repeat("p p ", cardPreviewMax/2)) {
			t.Fatal("a description or preview not cut")
		}
		if !strings.Contains(c.Text, "8. ") {
			t.Fatal("an option lost")
		}
		if len(c.Buttons) != 9 {
			t.Fatalf("%d rows", len(c.Buttons))
		}
		for _, row := range c.Buttons {
			for _, b := range row {
				if len(b.Data) > MaxButtonData || b.Data == "" || len([]rune(b.Text)) > buttonMax+8 {
					t.Fatalf("button %+v", b)
				}
			}
		}
	}
	// Five follow-up questions: no cards (its notification only).
	fu := &Followup{TurnID: "t5", At: 60}
	for i := range MaxCards + 1 {
		fu.Questions = append(fu.Questions, FollowupQuestion{ID: "q" + strconv.Itoa(i), Question: "?", Kind: "open"})
	}
	r.svc.Observe(working("w2"))
	r.svc.Observe(Observation{Worker: Worker{ID: "w2", Status: "done", StatusSince: 1, Followup: fu}, Name: "Pixel"})
	if !r.ch.WaitSent(2, 5*time.Second) {
		t.Fatal("no notification")
	}
	time.Sleep(50 * time.Millisecond)
	if len(r.ch.Cards()) != 4 {
		t.Fatalf("%d cards", len(r.ch.Cards()))
	}
}

func TestParseData(t *testing.T) {
	for d, ok := range map[string]bool{"ab12cd34:o1": true, "ab12cd34:o8": true, "ab12cd34:x": true, "ab12cd34:d": true, "ab12cd34:c": true,
		"ab12cd34:o0": false, "ab12cd34:o": false, "ab12cd34:xx": false, ":o1": false, "ab12cd34": false, "ab12cd34:z": false} {
		if _, _, _, got := parseData(d); got != ok {
			t.Errorf("%q: %v", d, got)
		}
	}
	if d := data("ab12cd34", actOption, 8); d != "ab12cd34:o8" {
		t.Fatal(d)
	}
}

// waitAnswered waits for the n-th answer to a reply.
func waitAnswered(t *testing.T, r *rig, n int) FakeAnswer {
	t.Helper()
	if !r.ch.WaitFor(func() bool { return len(r.ch.Answered()) >= n }, 5*time.Second) {
		t.Fatalf("%d answers, want %d", len(r.ch.Answered()), n)
	}
	return r.ch.Answered()[n-1]
}
