package telegram

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/notify"
)

const botUserID = 123456789 // the token's bot

// pairedRig is a rig with the token and Ada (42) paired before it started;
// listen: replies on from the start.
func pairedRig(t *testing.T, listen bool) *rig { return pairedRigRun(t, listen, true) }

// pairedRigRun is pairedRig whose channel's Run the test starts itself
// unless run (a notify.Service's Run: the one reader of the updates).
func pairedRigRun(t *testing.T, listen, run bool) *rig {
	t.Helper()
	file := t.TempDir() + "/telegram.json"
	if err := (fileStore{file}).save(Stored{Token: token, BotID: "123456789", Bot: "herdr3d_bot", UserID: 42, UserName: "Ada", PairedAt: 1}); err != nil {
		t.Fatal(err)
	}
	return newRigBefore(t, Options{File: file}, func(r *rig) {
		r.listenAtStart = listen
		r.tg.now = r.clock.Now
		r.ch.Listen(listen)
		r.noRun = !run
	})
}

// bot is the bot as the sender of a message replied to.
func bot() *user { return &user{ID: botUserID, IsBot: true, FirstName: "Herdr"} }

func ada() *user { return &user{ID: 42, FirstName: "Ada"} }

func replyTo(msg int64) *message {
	return &message{MessageID: msg, From: bot(), Chat: chat{ID: 42, Type: "private"}}
}

func waitReplies(t *testing.T, r *rig, n int) []notify.Reply {
	t.Helper()
	waitFor(t, "the replies", func() bool { return len(r.gotReplies()) >= n })
	return r.gotReplies()
}

// The paired person's messages, read while replies are on, are handed to
// the service with what they reply to: only theirs, in their private chat
// with the bot; anyone else's are dropped without a word.
func TestRepliesFromThePairedPersonOnly(t *testing.T) {
	r := pairedRig(t, true)
	ref, err := r.ch.Send(context.Background(), notify.Notification{WorkerID: "w-a", Name: "Pixel", Reason: notify.ReasonFinished})
	if err != nil || ref != (notify.Ref{Chat: 42, Message: 1}) {
		t.Fatalf("sent %+v %v", ref, err)
	}
	// Dropped: another person, a group (even Ada's), a bot, on behalf of a chat.
	r.tg.pushMsg(&message{From: &user{ID: 7}, Chat: chat{ID: 7, Type: "private"}, Text: "hi", ReplyTo: replyTo(1)})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: -100, Type: "group"}, Text: "hi", ReplyTo: replyTo(1)})
	r.tg.pushMsg(&message{From: &user{ID: 42, IsBot: true}, Chat: chat{ID: 42, Type: "private"}, Text: "hi", ReplyTo: replyTo(1)})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, SenderChat: &chat{ID: -5, Type: "channel"}, Text: "hi", ReplyTo: replyTo(1)})
	// Handed over: a reply, a forward, through a bot, not a reply, a reply to
	// Ada's own message, a photo.
	id := r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "now add tests", ReplyTo: replyTo(1)})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "fwd", ReplyTo: replyTo(1), ForwardOrigin: &struct{}{}})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "via", ReplyTo: replyTo(1), ViaBot: &user{ID: 9, IsBot: true}})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "loose"})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "self", ReplyTo: &message{MessageID: 3, From: ada()}})
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, ReplyTo: replyTo(1)})
	got := waitReplies(t, r, 6)
	if len(got) != 6 {
		t.Fatalf("replies %+v", got)
	}
	at := time.Unix(r.clock.Now().Unix(), 0)
	// Epoch 1: read after the one switch on.
	if want := (notify.Reply{Ref: notify.Ref{Chat: 42, Message: id}, To: ref, Text: "now add tests", At: at, Epoch: 1}); got[0] != want {
		t.Fatalf("reply %+v, want %+v", got[0], want)
	}
	if !got[1].Relayed || !got[2].Relayed || got[0].Relayed {
		t.Fatalf("relayed %+v", got[:3])
	}
	if got[3].To.Valid() || got[4].To.Valid() || got[3].Text != "loose" {
		t.Fatalf("not replies %+v", got[3:5])
	}
	if got[5].Text != "" || got[5].To != ref {
		t.Fatalf("photo %+v", got[5])
	}
	// Nothing was answered by the channel itself.
	if n := len(r.tg.requests("sendMessage")); n != 1 {
		t.Fatalf("%d messages sent", n)
	}
	// Confirm: a 👍 on the reply; Answer: a reply to it.
	if err := r.ch.Confirm(context.Background(), got[0].Ref); err != nil {
		t.Fatal(err)
	}
	rs := r.tg.requests("setMessageReaction")
	if len(rs) != 1 || rs[0].body["chat_id"].(float64) != 42 || rs[0].body["message_id"].(float64) != float64(id) {
		t.Fatalf("reaction %+v", rs)
	}
	if re := rs[0].body["reaction"].([]any); len(re) != 1 || re[0].(map[string]any)["emoji"] != "👍" || re[0].(map[string]any)["type"] != "emoji" {
		t.Fatalf("reaction %+v", rs[0].body)
	}
	if err := r.ch.Answer(context.Background(), got[3].Ref, notify.ReplyHintText+" "+token); err != nil {
		t.Fatal(err)
	}
	ms := r.tg.requests("sendMessage")
	m := ms[len(ms)-1].body
	rp, _ := m["reply_parameters"].(map[string]any)
	if m["chat_id"].(float64) != 42 || rp["message_id"].(float64) != float64(got[3].Ref.Message) || rp["allow_sending_without_reply"] != true ||
		!strings.HasPrefix(m["text"].(string), notify.ReplyHintText) || strings.Contains(m["text"].(string), "AAHdq") {
		t.Fatalf("answer %+v", m)
	}
}

// Replies off: no poll at all. Switched on: the first poll forgets what
// came before (the newest update only). Off again: a poll under way is
// not routed.
func TestRepliesSwitchedOnAndOff(t *testing.T) {
	r := pairedRig(t, false)
	time.Sleep(100 * time.Millisecond)
	if n := len(r.tg.requests("getUpdates")); n != 0 {
		t.Fatalf("%d polls with replies off", n)
	}
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "old 1", ReplyTo: replyTo(1)})
	last := r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "old 2", ReplyTo: replyTo(1)})
	r.ch.Listen(true)
	waitFor(t, "two polls", func() bool { return len(r.tg.requests("getUpdates")) >= 2 })
	gets := r.tg.requests("getUpdates")
	if gets[0].body["offset"].(float64) != -1 || gets[1].body["offset"].(float64) != float64(last+1) {
		t.Fatalf("polls %+v %+v", gets[0].body, gets[1].body)
	}
	// The newest is handed over (the service drops it: sent before).
	if got := waitReplies(t, r, 1); got[0].Text != "old 2" {
		t.Fatalf("replies %+v", got)
	}
	// A poll held under way while replies go off: what it brings is dropped.
	inFlight, release := make(chan struct{}), make(chan struct{})
	r.tg.mu.Lock()
	n := r.tg.gets
	r.tg.holdGet = func(k int) {
		if k == n+1 {
			close(inFlight)
			<-release
		}
	}
	r.tg.mu.Unlock()
	<-inFlight
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "late", ReplyTo: replyTo(1)})
	r.ch.Listen(false)
	close(release)
	time.Sleep(100 * time.Millisecond)
	if got := r.gotReplies(); len(got) != 1 {
		t.Fatalf("routed after off: %+v", got)
	}
	k := len(r.tg.requests("getUpdates"))
	time.Sleep(150 * time.Millisecond)
	if m := len(r.tg.requests("getUpdates")); m != k {
		t.Fatalf("polling with replies off: %d → %d", k, m)
	}
	// Unpaired with replies on: no poll either.
	r.ch.Listen(true)
	waitFor(t, "the poll", func() bool { return len(r.tg.requests("getUpdates")) > k })
	if err := r.ch.Unpair(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	k = len(r.tg.requests("getUpdates"))
	time.Sleep(150 * time.Millisecond)
	if m := len(r.tg.requests("getUpdates")); m != k {
		t.Fatalf("polling unpaired: %d → %d", k, m)
	}
}

// Replies on at the start (a restart): what came while the bridge was away
// is read from the oldest kept (the service answers what is too old).
func TestRepliesReadTheBacklogAfterARestart(t *testing.T) {
	dir := t.TempDir()
	file := dir + "/telegram.json"
	if err := (fileStore{file}).save(Stored{Token: token, BotID: "123456789", Bot: "herdr3d_bot", UserID: 42, UserName: "Ada", PairedAt: 1}); err != nil {
		t.Fatal(err)
	}
	r := newRigBefore(t, Options{File: file}, func(r *rig) {
		r.listenAtStart = true
		r.tg.now = r.clock.Now
		r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "while away 1", ReplyTo: replyTo(1)})
		r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "while away 2", ReplyTo: replyTo(1)})
		r.ch.Listen(true)
	})
	got := waitReplies(t, r, 2)
	if got[0].Text != "while away 1" || got[1].Text != "while away 2" {
		t.Fatalf("replies %+v", got)
	}
	if first := r.tg.requests("getUpdates")[0].body; first["offset"] != nil {
		t.Fatalf("first poll %+v (want from the oldest kept)", first)
	}
}

// One reader: a pairing that starts while replies are read, and pairs
// someone else, never adds a second getUpdates; the replies of who was
// paired stop with it.
func TestOneReaderOfUpdates(t *testing.T) {
	r := pairedRig(t, true)
	waitFor(t, "the reply poll", func() bool { return len(r.tg.requests("getUpdates")) >= 1 })
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "before", ReplyTo: replyTo(1)})
	waitReplies(t, r, 1)
	if err := r.ch.StartPairing(context.Background()); err != nil {
		t.Fatal(err)
	}
	code := strings.ReplaceAll(r.ch.State().Pairing.Code, "-", "")
	// Ada's reply during the pairing still goes; Bob sends the code.
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "during", ReplyTo: replyTo(1)})
	waitReplies(t, r, 2)
	r.tg.push(43, "private", code, false)
	waitFor(t, "Bob paired", func() bool { st := r.ch.State(); return st.Paired != nil && st.Paired.Name == "User43" })
	waitFor(t, "the result", func() bool { return len(r.pairResults()) == 1 })
	if res := r.pairResults()[0]; res.Outcome != notify.PairedOK {
		t.Fatalf("result %+v", res)
	}
	// Ada is not paired any more: her messages are dropped; Bob's go.
	r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "ada after", ReplyTo: replyTo(1)})
	r.tg.pushMsg(&message{From: &user{ID: 43}, Chat: chat{ID: 43, Type: "private"}, Text: "bob", ReplyTo: &message{MessageID: 1, From: bot()}})
	got := waitReplies(t, r, 3)
	if got[2].Text != "bob" || got[2].To != (notify.Ref{Chat: 43, Message: 1}) {
		t.Fatalf("replies %+v", got)
	}
	time.Sleep(50 * time.Millisecond)
	if len(r.gotReplies()) != 3 {
		t.Fatalf("replies %+v", r.gotReplies())
	}
	r.tg.mu.Lock()
	most := r.tg.maxPolling
	r.tg.mu.Unlock()
	if most != 1 {
		t.Fatalf("%d getUpdates at once", most)
	}
	// Ada's reply read before Bob paired is not handed over any more; Bob's is.
	if r.ch.Hold(got[1], func() {}) || !r.ch.Hold(got[2], func() {}) {
		t.Fatal("held across the new pairing")
	}
}

// Hold hands a reply over only under the switch and the recipient it was
// read under; switching off, unpairing or clearing the token wait for a
// hand-off under way, and refuse those read before.
func TestHoldUntilRevoked(t *testing.T) {
	read := func(r *rig) notify.Reply {
		r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "go", ReplyTo: replyTo(1)})
		got := waitReplies(t, r, len(r.gotReplies())+1)
		return got[len(got)-1]
	}
	r := pairedRig(t, true)
	rp := read(r)
	ran := false
	if !r.ch.Hold(rp, func() { ran = true }) || !ran {
		t.Fatal("a fresh reply not handed over")
	}
	// Off and on again: what was read before stays refused.
	r.ch.Listen(false)
	r.ch.Listen(true)
	if r.ch.Hold(rp, func() { t.Error("handed over after off and on") }) {
		t.Fatal("held after off and on")
	}
	for _, c := range []struct {
		name   string
		revoke func(*Channel) error
	}{
		{"off", func(ch *Channel) error { ch.Listen(false); return nil }},
		{"unpair", (*Channel).Unpair},
		{"clear the token", (*Channel).ClearToken},
	} {
		r := pairedRig(t, true)
		rp := read(r)
		entered, release, revoked := make(chan struct{}), make(chan struct{}), make(chan error, 1)
		go r.ch.Hold(rp, func() {
			close(entered)
			<-release
		})
		<-entered
		go func() { revoked <- c.revoke(r.ch) }()
		select {
		case <-revoked:
			t.Fatalf("%s: did not wait for the hand-off", c.name)
		case <-time.After(50 * time.Millisecond):
		}
		close(release)
		if err := <-revoked; err != nil {
			t.Fatal(err)
		}
		if r.ch.Hold(rp, func() { t.Errorf("%s: handed over after", c.name) }) {
			t.Fatalf("%s: held after", c.name)
		}
	}
}

// The whole path against the fake Bot API: a needs-you message, Ada's
// reply to it typed into its worker and 👍'd; refused while it asks, with
// the ticket's sentence as a reply to hers.
func TestReplyRoundTripOverHTTP(t *testing.T) {
	r := pairedRigRun(t, true, false) // the service runs the channel
	st := notify.NewFakeStore()
	set := notify.DefaultSettings()
	set.Enabled, set.Replies = true, true
	if err := st.SaveNotifySettings(context.Background(), set); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var typed []string
	var refuse error
	svc, err := notify.New(context.Background(), notify.Options{Store: st, Channel: r.ch, Clock: r.clock, Limits: notify.NoLimits(),
		Prompt: func(_ context.Context, id, text string, done func(error)) error {
			mu.Lock()
			defer mu.Unlock()
			if refuse != nil {
				return refuse
			}
			typed = append(typed, id+": "+text)
			go done(nil)
			return nil
		}})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		svc.Run(ctx)
	}()
	defer func() {
		cancel()
		<-done
	}()
	svc.Observe(notify.Observation{Worker: notify.Worker{ID: "w-a", Status: "working", StatusSince: 1}, Name: "Pixel"})
	svc.Observe(notify.Observation{Worker: notify.Worker{ID: "w-a", Status: "blocked", StatusSince: 2}, Name: "Pixel"})
	waitFor(t, "the notification", func() bool { return len(r.tg.requests("sendMessage")) == 1 })
	waitFor(t, "it remembered", func() bool {
		w, _, ok, _ := st.NotifyMessage(context.Background(), notify.Ref{Chat: 42, Message: 1})
		return ok && w == "w-a"
	})
	id := r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "now add tests", ReplyTo: replyTo(1)})
	waitFor(t, "the 👍", func() bool { return len(r.tg.requests("setMessageReaction")) == 1 })
	if rs := r.tg.requests("setMessageReaction")[0].body; rs["message_id"].(float64) != float64(id) {
		t.Fatalf("reaction %+v", rs)
	}
	mu.Lock()
	if len(typed) != 1 || typed[0] != "w-a: now add tests" {
		t.Fatalf("typed %q", typed)
	}
	refuse = &notify.ReplyError{Kind: notify.ReplyAsk}
	mu.Unlock()
	id = r.tg.pushMsg(&message{From: ada(), Chat: chat{ID: 42, Type: "private"}, Text: "tea", ReplyTo: replyTo(1)})
	waitFor(t, "the refusal", func() bool { return len(r.tg.requests("sendMessage")) == 2 })
	m := r.tg.requests("sendMessage")[1].body
	if rp, _ := m["reply_parameters"].(map[string]any); m["text"] != notify.ReplyAskText || rp["message_id"].(float64) != float64(id) {
		t.Fatalf("refusal %+v", m)
	}
	// Someone else's reply: no answer at all.
	r.tg.pushMsg(&message{From: &user{ID: 7}, Chat: chat{ID: 7, Type: "private"}, Text: "hi", ReplyTo: replyTo(1)})
	time.Sleep(100 * time.Millisecond)
	if n := len(r.tg.requests("sendMessage")); n != 2 {
		t.Fatalf("%d messages: a stranger was answered", n)
	}
}
