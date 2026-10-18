package telegram

import (
	"context"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
)

// cardRig is a paired channel against the fake, run by a notify.Service
// with notifications and replies on, its answers recorded.
type cardRig struct {
	*rig
	svc *notify.Service

	mu      sync.Mutex
	answers []notify.Answer
	lane    error
}

func newCardRig(t *testing.T) *cardRig {
	t.Helper()
	r := pairedRigRun(t, true, false) // the service runs the channel
	st := notify.NewFakeStore()
	set := notify.DefaultSettings()
	set.Enabled, set.Replies = true, true
	if err := st.SaveNotifySettings(context.Background(), set); err != nil {
		t.Fatal(err)
	}
	cr := &cardRig{rig: r}
	svc, err := notify.New(context.Background(), notify.Options{Store: st, Channel: r.ch, Clock: r.clock,
		Prompt: func(context.Context, string, string, func(error)) error { t.Error("typed as a prompt"); return nil },
		Answer: func(_ context.Context, a notify.Answer, done func(error)) error {
			cr.mu.Lock()
			cr.answers = append(cr.answers, a)
			lane := cr.lane
			cr.mu.Unlock()
			go done(lane)
			return nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	cr.svc = svc
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
	return cr
}

func (cr *cardRig) got() []notify.Answer {
	cr.mu.Lock()
	defer cr.mu.Unlock()
	return append([]notify.Answer(nil), cr.answers...)
}

// asked has worker id ask (a sighting without it first) and waits for its
// notification and n cards; it returns the cards' message ids.
func (cr *cardRig) asked(t *testing.T, id string, w notify.Worker, n int) []int64 {
	t.Helper()
	before := len(cr.tg.requests("sendMessage"))
	cr.svc.Observe(notify.Observation{Worker: notify.Worker{ID: id, Status: "working", StatusSince: 1}, Name: "Pixel"})
	w.ID = id
	cr.svc.Observe(notify.Observation{Worker: w, Name: "Pixel"})
	waitFor(t, "the notification and its cards", func() bool { return len(cr.tg.requests("sendMessage")) >= before+1+n })
	var ids []int64
	for i := range n {
		ids = append(ids, int64(before+2+i)) // the fake numbers its messages from 1
	}
	return ids
}

// data is the data of message msg's button whose label starts with prefix.
func (cr *cardRig) data(t *testing.T, msg int64, prefix string) string {
	t.Helper()
	_, labels := cr.tg.shownText(msg)
	for _, l := range labels {
		if strings.HasPrefix(l, prefix) {
			return l[strings.LastIndex(l, "=")+1:]
		}
	}
	t.Fatalf("message %d has no button %q: %q", msg, prefix, labels)
	return ""
}

// tapAnswered waits for the tap's answerCallbackQuery and returns its text.
func (cr *cardRig) tapAnswered(t *testing.T, id string) string {
	t.Helper()
	var text string
	waitFor(t, "the tap's answer", func() bool {
		for _, rq := range cr.tg.requests("answerCallbackQuery") {
			if rq.body["callback_query_id"] == id {
				text, _ = rq.body["text"].(string)
				return true
			}
		}
		return false
	})
	return text
}

func (cr *cardRig) waitText(t *testing.T, msg int64, want string) []string {
	t.Helper()
	var labels []string
	waitFor(t, "the card's "+want, func() bool {
		var text string
		text, labels = cr.tg.shownText(msg)
		return strings.Contains(text, want)
	})
	return labels
}

func dbAsk(id string, multi, other bool) *notify.Ask {
	return &notify.Ask{ToolUseID: id, Since: 50, Questions: []notify.AskQuestion{{HasOptions: true, Header: "Database",
		Question: "Which database?", Multi: multi, Other: other, Options: []notify.AskOption{
			{Label: "Postgres", Description: "Relational"}, {Label: "SQLite", Description: "One file"}, {Label: "Redis"}}}}}
}

// #14 acceptance over HTTP: "Which database?" with 3 options: a quiet card
// with 3 option buttons and Cancel (tiny data, no id of the bridge's); one
// tap is answered at once and answers the ask with choice 2; the card is
// edited to the answer, no button left. Every poll asks for the taps.
func TestCardTapOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_1", false, false)}, 1)
	m := cr.tg.requests("sendMessage")[1].body
	if m["disable_notification"] != true || m["parse_mode"] != nil {
		t.Fatalf("card %+v", m)
	}
	text, labels := cr.tg.shownText(ids[0])
	if !strings.Contains(text, "Which database?") || !strings.Contains(text, "2. SQLite\nOne file") || len(labels) != 4 ||
		!strings.HasPrefix(labels[3], "Cancel=") {
		t.Fatalf("card %q %q", text, labels)
	}
	for _, l := range labels {
		if d := l[strings.LastIndex(l, "=")+1:]; len(d) > notify.MaxButtonData || strings.Contains(d, "toolu") || strings.Contains(d, "w-a") {
			t.Fatalf("data %q", d)
		}
	}
	tap := cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "2."))
	if got := cr.tapAnswered(t, tap); got != "Sending…" {
		t.Fatalf("tap answered %q", got)
	}
	waitFor(t, "the answer", func() bool { return len(cr.got()) == 1 })
	if a := cr.got()[0]; !reflect.DeepEqual(a, notify.Answer{WorkerID: "w-a", ToolUseID: "toolu_1",
		Ask: []notify.AskAnswer{{Question: 0, Choices: []int{2}}}}) {
		t.Fatalf("answer %+v", a)
	}
	if labels := cr.waitText(t, ids[0], "✓ Answered: SQLite"); len(labels) != 0 {
		t.Fatalf("buttons left %q", labels)
	}
	for _, g := range cr.tg.requests("getUpdates") {
		if au, _ := g.body["allowed_updates"].([]any); !slices.Contains(au, any("callback_query")) || !slices.Contains(au, any("message")) {
			t.Fatalf("allowed_updates %+v", g.body["allowed_updates"])
		}
	}
}

// Multi-select over HTTP: each tap toggles (the card is edited to show it),
// Done sends the picks.
func TestCardMultiOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_m", true, false)}, 1)
	cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "☐ 1."))
	waitFor(t, "the toggle", func() bool {
		_, labels := cr.tg.shownText(ids[0])
		return len(labels) > 0 && strings.HasPrefix(labels[0], "☑ 1. Postgres")
	})
	cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "☐ 3."))
	waitFor(t, "the second toggle", func() bool {
		_, labels := cr.tg.shownText(ids[0])
		return len(labels) > 2 && strings.HasPrefix(labels[2], "☑ 3.")
	})
	cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "Done (2)"))
	waitFor(t, "the answer", func() bool { return len(cr.got()) == 1 })
	if a := cr.got()[0].Ask; !reflect.DeepEqual(a, []notify.AskAnswer{{Question: 0, Choices: []int{1, 3}}}) {
		t.Fatalf("answer %+v", a)
	}
	cr.waitText(t, ids[0], "✓ Answered: Postgres, Redis")
}

// Other… over HTTP: a force reply as a reply to the card; the reply to it
// fills other (a 👍 on it), never typed as a prompt.
func TestCardOtherOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_o", false, true)}, 1)
	n := len(cr.tg.requests("sendMessage"))
	cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "Other…"))
	waitFor(t, "the prompt", func() bool { return len(cr.tg.requests("sendMessage")) == n+1 })
	p := cr.tg.requests("sendMessage")[n].body
	rm, _ := p["reply_markup"].(map[string]any)
	rp, _ := p["reply_parameters"].(map[string]any)
	if rm["force_reply"] != true || rm["input_field_placeholder"] != "Database" || rp["message_id"].(float64) != float64(ids[0]) {
		t.Fatalf("prompt %+v", p)
	}
	prompt := int64(n + 1)
	r := cr.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "MySQL", ReplyTo: replyTo(prompt)})
	waitFor(t, "the answer", func() bool { return len(cr.got()) == 1 })
	if a := cr.got()[0].Ask; len(a) != 1 || a[0].Other == nil || *a[0].Other != "MySQL" || a[0].Choices != nil {
		t.Fatalf("answer %+v", a)
	}
	waitFor(t, "the 👍", func() bool { return len(cr.tg.requests("setMessageReaction")) == 1 })
	if m := cr.tg.requests("setMessageReaction")[0].body; m["message_id"].(float64) != float64(r) {
		t.Fatalf("reaction %+v", m)
	}
	cr.waitText(t, ids[0], "✓ Answered: “MySQL”")
}

// A secret ask: one card, no question or option, no button.
func TestCardSecretOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	ask := &notify.Ask{ToolUseID: "toolu_s", Since: 50, Questions: []notify.AskQuestion{{HasOptions: true, Secret: true}}}
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: ask}, 1)
	m := cr.tg.requests("sendMessage")[1].body
	if m["text"] != "Pixel · Question\n"+notify.CardSecretText || m["reply_markup"] != nil {
		t.Fatalf("card %+v", m)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(cr.tg.requests("sendMessage")); n != 2 || ids[0] != 2 {
		t.Fatalf("%d messages", n)
	}
}

// Answered in the game first: the card is edited to say so, its buttons
// gone. A tap on it after (stale: read before the edit) is answered "no
// longer open" and answers nothing; taking away buttons it no longer has
// is no error (Telegram's "message is not modified").
func TestCardAnsweredInTheGameOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_g", false, false)}, 1)
	stale := cr.data(t, ids[0], "1.")
	cr.svc.Observe(notify.Observation{Worker: notify.Worker{ID: "w-a", Status: "working", StatusSince: 3}, Name: "Pixel"})
	if labels := cr.waitText(t, ids[0], notify.CardInGameText); len(labels) != 0 {
		t.Fatalf("buttons left %q", labels)
	}
	tap := cr.tg.pushTap(ada(), 42, ids[0], stale)
	if got := cr.tapAnswered(t, tap); got != "No longer open" {
		t.Fatalf("stale tap answered %q", got)
	}
	waitFor(t, "the buttons taken", func() bool { return len(cr.tg.requests("editMessageReplyMarkup")) == 1 })
	time.Sleep(50 * time.Millisecond)
	if len(cr.got()) != 0 || strings.Contains(cr.log.String(), "level=WARN") {
		t.Fatalf("answers %+v, log %s", cr.got(), cr.log.String())
	}
}

// Follow-ups over HTTP: yes_no and choice are buttons, open a reply
// prompt; one answer once all three are answered.
func TestCardFollowupOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	fu := &notify.Followup{TurnID: "turn-1", At: 60, Questions: []notify.FollowupQuestion{
		{ID: "q1", Question: "Ship it?", Kind: "yes_no"},
		{ID: "q2", Question: "Which branch?", Kind: "choice", Options: 2, Choices: []string{"main", "next"}},
		{ID: "q3", Question: "Anything else?", Kind: "open"}}}
	ids := cr.asked(t, "w-a", notify.Worker{Status: "done", Followup: fu}, 3)
	if _, labels := cr.tg.shownText(ids[2]); len(labels) != 1 || !strings.HasPrefix(labels[0], "Answer…=") {
		t.Fatalf("open %q", labels)
	}
	cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "Yes"))
	cr.tg.pushTap(ada(), 42, ids[1], cr.data(t, ids[1], "1."))
	n := len(cr.tg.requests("sendMessage"))
	cr.tg.pushTap(ada(), 42, ids[2], cr.data(t, ids[2], "Answer…"))
	waitFor(t, "the prompt", func() bool { return len(cr.tg.requests("sendMessage")) == n+1 })
	cr.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "Tag it", ReplyTo: replyTo(int64(n + 1))})
	waitFor(t, "the answer", func() bool { return len(cr.got()) == 1 })
	want := notify.Answer{WorkerID: "w-a", TurnID: "turn-1", Followup: []notify.FollowupAnswer{{ID: "q1", Value: "Yes"}, {ID: "q2", Value: "main"}, {ID: "q3", Value: "Tag it"}}}
	if a := cr.got()[0]; !reflect.DeepEqual(a, want) {
		t.Fatalf("answer %+v", a)
	}
	cr.waitText(t, ids[0], "✓ Answered: Yes")
	cr.waitText(t, ids[2], "✓ Answered: “Tag it”")
}

// Someone else's tap, or one on another chat, is answered without a word
// and never handed over; a tap on a card the bridge does not know (a
// restart) is answered "no longer open", its buttons taken away.
func TestCardTapsOfOthers(t *testing.T) {
	cr := newCardRig(t)
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_x", false, false)}, 1)
	d := cr.data(t, ids[0], "1.")
	stranger := cr.tg.pushTap(&user{ID: 7, FirstName: "Eve"}, 7, ids[0], d)
	bot := cr.tg.pushTap(&user{ID: 42, IsBot: true}, 42, ids[0], d)
	group := cr.tg.pushTap(ada(), -100, ids[0], d)
	for _, id := range []string{stranger, bot, group} {
		if got := cr.tapAnswered(t, id); got != "" {
			t.Fatalf("tap %s answered %q", id, got)
		}
	}
	old := cr.tg.pushTap(ada(), 42, 99, "0badc0de:o1")
	if got := cr.tapAnswered(t, old); got != "No longer open" {
		t.Fatalf("old tap answered %q", got)
	}
	waitFor(t, "its buttons taken", func() bool { return len(cr.tg.requests("editMessageReplyMarkup")) == 1 })
	time.Sleep(50 * time.Millisecond)
	if len(cr.got()) != 0 {
		t.Fatalf("answers %+v", cr.got())
	}
	if _, labels := cr.tg.shownText(ids[0]); len(labels) != 4 {
		t.Fatalf("the card changed: %q", labels)
	}
}

// A tap the service refuses (its queue full) is answered here without a
// word, once, and is no pairing's stray update.
func TestCardTapRefused(t *testing.T) {
	r := pairedRigRun(t, true, false)
	var mu sync.Mutex
	var handed []string
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		r.ch.Run(ctx, notify.Hooks{Tap: func(tp notify.Tap) bool {
			mu.Lock()
			handed = append(handed, tp.ID)
			mu.Unlock()
			return false
		}, Listen: true})
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	id := r.tg.pushTap(ada(), 42, 1, "0badc0de:o1")
	waitFor(t, "the tap's answer", func() bool { return len(r.tg.requests("answerCallbackQuery")) == 1 })
	rq := r.tg.requests("answerCallbackQuery")[0]
	if text, _ := rq.body["text"].(string); rq.body["callback_query_id"] != id || text != "" {
		t.Fatalf("answer %+v", rq.body)
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(handed, []string{id}) {
		t.Fatalf("handed over %q", handed)
	}
}

// Replies off: the open cards say so (no more taps are read).
func TestCardRepliesOffOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_f", false, false)}, 1)
	off := false
	if err := cr.svc.Apply(context.Background(), notify.Update{Replies: &off}); err != nil {
		t.Fatal(err)
	}
	if labels := cr.waitText(t, ids[0], notify.CardOffText); len(labels) != 0 {
		t.Fatalf("buttons left %q", labels)
	}
}

// A rate-limited edit waits what Telegram asks, once, then goes.
func TestCardEditRateLimited(t *testing.T) {
	cr := newCardRig(t)
	cr.tg.mu.Lock()
	cr.tg.failEdit = func(n int) (int, string) {
		if n == 0 {
			return 429, `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 2","parameters":{"retry_after":2}}`
		}
		return 0, ""
	}
	cr.tg.mu.Unlock()
	ids := cr.asked(t, "w-a", notify.Worker{Status: "working", Ask: dbAsk("toolu_l", false, false)}, 1)
	cr.tg.pushTap(ada(), 42, ids[0], cr.data(t, ids[0], "Cancel"))
	waitFor(t, "the first edit", func() bool { return len(cr.tg.requests("editMessageText")) == 1 })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !cr.clock.WaitFor(ctx, 1) {
		t.Fatal("no wait armed")
	}
	cr.clock.Advance(2 * time.Second)
	cr.waitText(t, ids[0], notify.CardCancelText)
}

// blockedOn has worker id turn blocked, its notification go, then its
// screen's menu m (#88: read a moment later), and waits for m's card; it
// returns the card's message id.
func (cr *cardRig) blockedOn(t *testing.T, id string, m *notify.Menu) int64 {
	t.Helper()
	before := len(cr.tg.requests("sendMessage"))
	cr.svc.Observe(notify.Observation{Worker: notify.Worker{ID: id, Status: "working", StatusSince: 1}, Name: "Pixel"})
	w := notify.Worker{ID: id, Status: "blocked", StatusSince: 100}
	cr.svc.Observe(notify.Observation{Worker: w, Name: "Pixel"})
	waitFor(t, "the notification", func() bool { return len(cr.tg.requests("sendMessage")) == before+1 })
	w.Menu = m
	cr.svc.Observe(notify.Observation{Worker: w, Name: "Pixel"})
	waitFor(t, "the menu's card", func() bool { return len(cr.tg.requests("sendMessage")) == before+2 })
	return int64(before + 2)
}

func codexMenu(hash string) *notify.Menu {
	return &notify.Menu{Hash: hash, Kind: "permission", Choices: []notify.MenuChoice{
		{N: 1, Label: "Yes, proceed (y)"}, {N: 2, Label: "Yes, and don't ask again for commands that start with `…` (p)"},
		{N: 3, Label: "No, and tell Codex what to do differently (esc)"}}}
}

// #88 over HTTP: a permission menu's card after the notification, quiet,
// a button per choice and no Cancel, its data with no hash; someone else's
// tap is answered without a word and never handed over; the paired
// person's is answered once and answers with the hash and the choice; the
// card is edited to the answer, no button left.
func TestCardMenuOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	msg := cr.blockedOn(t, "w-a", codexMenu("0123456789abcdef"))
	m := cr.tg.requests("sendMessage")[1].body
	if m["disable_notification"] != true || m["parse_mode"] != nil {
		t.Fatalf("card %+v", m)
	}
	text, labels := cr.tg.shownText(msg)
	if !strings.HasPrefix(text, "Pixel · Permission\nIt asks for your permission.\n\n"+notify.CardMenuAboutText) ||
		!strings.Contains(text, "2. Yes, and don't ask again for commands that start with `…` (p)") || len(labels) != 3 ||
		!strings.HasPrefix(labels[2], "3. No, and tell Codex what to do different…=") {
		t.Fatalf("card %q %q", text, labels)
	}
	for _, l := range labels {
		if d := l[strings.LastIndex(l, "=")+1:]; len(d) > notify.MaxButtonData || strings.Contains(d, "0123") || strings.Contains(d, "w-a") {
			t.Fatalf("data %q", d)
		}
	}
	d := cr.data(t, msg, "1.")
	stranger := cr.tg.pushTap(&user{ID: 7, FirstName: "Eve"}, 7, msg, d)
	if got := cr.tapAnswered(t, stranger); got != "" {
		t.Fatalf("stranger's tap answered %q", got)
	}
	tap := cr.tg.pushTap(ada(), 42, msg, d)
	if got := cr.tapAnswered(t, tap); got != "Sending…" {
		t.Fatalf("tap answered %q", got)
	}
	waitFor(t, "the answer", func() bool { return len(cr.got()) == 1 })
	if a := cr.got()[0]; !reflect.DeepEqual(a, notify.Answer{WorkerID: "w-a", Hash: "0123456789abcdef", Choice: 1}) {
		t.Fatalf("answer %+v", a)
	}
	if labels := cr.waitText(t, msg, "✓ Answered: Yes, proceed (y)"); len(labels) != 0 {
		t.Fatalf("buttons left %q", labels)
	}
	if n := len(cr.tg.requests("answerCallbackQuery")); n != 2 {
		t.Fatalf("%d tap answers", n)
	}
}

// #88 over HTTP: the menu changes on the screen (a new hash): the card
// says (#106) it was replaced, its buttons gone; the old card's tap is
// answered "no longer open" and answers nothing. Keys that leave the
// worker blocked: the new card says so.
func TestCardMenuStaleOverHTTP(t *testing.T) {
	cr := newCardRig(t)
	cr.mu.Lock()
	cr.lane = &notify.ReplyError{Kind: notify.ReplyUnresolved}
	cr.mu.Unlock()
	msg := cr.blockedOn(t, "w-a", codexMenu("aaaaaaaaaaaaaaaa"))
	stale := cr.data(t, msg, "1.")
	cr.svc.Observe(notify.Observation{Worker: notify.Worker{ID: "w-a", Status: "blocked", StatusSince: 100, Menu: codexMenu("bbbbbbbbbbbbbbbb")}, Name: "Pixel"})
	if labels := cr.waitText(t, msg, notify.CardReplacedText); len(labels) != 0 {
		t.Fatalf("buttons left %q", labels)
	}
	waitFor(t, "the new menu's card", func() bool { return len(cr.tg.requests("sendMessage")) == 3 })
	tap := cr.tg.pushTap(ada(), 42, msg, stale)
	if got := cr.tapAnswered(t, tap); got != "No longer open" {
		t.Fatalf("stale tap answered %q", got)
	}
	cr.tg.pushTap(ada(), 42, 3, cr.data(t, 3, "3."))
	if labels := cr.waitText(t, 3, "✓ Sent: No, and tell Codex what to do differently (esc)\n"+notify.CardUnresolvedText); len(labels) != 0 {
		t.Fatalf("buttons left %q", labels)
	}
	if a := cr.got(); len(a) != 1 || a[0].Hash != "bbbbbbbbbbbbbbbb" || a[0].Choice != 3 {
		t.Fatalf("answers %+v", a)
	}
}
