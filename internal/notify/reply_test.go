package notify

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// prompter is the hub's Prompt in a test: it records what was typed into
// which worker; refuse says at once, lane when the lane ends (nil: typed).
type prompter struct {
	mu     sync.Mutex
	typed  []string // "id: text"
	refuse func(id string) error
	lane   func(id string) error
}

func (p *prompter) prompt(_ context.Context, id, text string, done func(error)) error {
	p.mu.Lock()
	refuse, lane := p.refuse, p.lane
	p.mu.Unlock()
	if refuse != nil {
		if err := refuse(id); err != nil {
			return err
		}
	}
	p.mu.Lock()
	p.typed = append(p.typed, id+": "+text)
	p.mu.Unlock()
	go func() {
		var err error
		if lane != nil {
			err = lane(id)
		}
		done(err)
	}()
	return nil
}

func (p *prompter) all() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.typed...)
}

// newReplyRig is a service with replies on (since the start), its prompts
// typed by p.
func newReplyRig(t *testing.T, p *prompter) *rig {
	t.Helper()
	r := newRigWith(t, true, func(o *Options, st *Settings) {
		o.Prompt = p.prompt
		st.Replies = true
	})
	waitListening(t, r.ch)
	return r
}

func waitListening(t *testing.T, ch *FakeChannel) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ch.Listening() {
		if time.Now().After(deadline) {
			t.Fatal("the channel does not listen")
		}
		time.Sleep(time.Millisecond)
	}
}

// notified has the service notify worker id (needs you) and returns the
// message it became.
func (r *rig) notified(t *testing.T, id string, since int64) Ref {
	t.Helper()
	n := len(r.ch.Sent())
	r.svc.Observe(working(id))
	r.svc.Observe(blocked(id, since))
	if !r.ch.WaitSent(n+1, 5*time.Second) {
		t.Fatalf("%s was not notified", id)
	}
	ref := Ref{FakeChatID, int64(n + 1)}
	// Saved once delivered: wait for the store.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if w, _, ok, _ := r.store.NotifyMessage(context.Background(), ref); ok && w == id {
			return ref
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s's notification not remembered", id)
		}
		time.Sleep(time.Millisecond)
	}
}

var msgID int64 = 1000

func (r *rig) reply(to Ref, text string) Reply {
	msgID++
	rp := Reply{Ref: Ref{FakeChatID, msgID}, To: to, Text: text, At: r.clock.Now()}
	r.ch.Deliver(rp)
	return rp
}

func replyRows(r *rig) []replyAudit {
	var out []replyAudit
	for _, a := range r.rows() {
		if a.cmd == AuditReply {
			out = append(out, a.args.(replyAudit))
		}
	}
	return out
}

// The round trip without HTTP: a notification's message is remembered, a
// reply to it is typed into its worker (two workers, two notifications),
// confirmed once typed, audited by its lengths.
func TestReplyRoundTrip(t *testing.T) {
	p := &prompter{}
	r := newReplyRig(t, p)
	a := r.notified(t, "w-a", 10)
	b := r.notified(t, "w-b", 20)
	ra := r.reply(a, "now add tests")
	rb := r.reply(b, "ship it ✓")
	if !r.ch.WaitReplied(2, 5*time.Second) {
		t.Fatalf("not confirmed: %+v %+v", r.ch.Confirmed(), r.ch.Answered())
	}
	typed := p.all()
	if len(typed) != 2 || typed[0] != "w-a: now add tests" || typed[1] != "w-b: ship it ✓" {
		t.Fatalf("typed %q", typed)
	}
	// The two lanes end in any order.
	if c := r.ch.Confirmed(); len(c) != 2 || !slices.Contains(c, ra.Ref) || !slices.Contains(c, rb.Ref) || len(r.ch.Answered()) != 0 {
		t.Fatalf("confirmed %+v, answered %+v", c, r.ch.Answered())
	}
	rows := replyRows(r)
	if len(rows) != 2 || !slices.Contains(rows, replyAudit{ID: "w-a", TextBytes: 13, TextRunes: 13, Outcome: "sent"}) ||
		!slices.Contains(rows, replyAudit{ID: "w-b", TextBytes: 11, TextRunes: 9, Outcome: "sent"}) {
		t.Fatalf("audit %+v", rows)
	}
	if s := fmt.Sprintf("%+v", r.rows()); strings.Contains(s, "add tests") || strings.Contains(s, "ship") {
		t.Fatalf("typed text audited: %s", s)
	}
}

func lastAnswer(t *testing.T, r *rig, n int) FakeAnswer {
	t.Helper()
	if !r.ch.WaitReplied(n, 5*time.Second) {
		t.Fatalf("%d answers, want %d: %+v", len(r.ch.Answered()), n, r.ch.Answered())
	}
	as := r.ch.Answered()
	return as[len(as)-1]
}

// What is not typed is answered, with a fixed sentence, as a reply to the
// message: nothing reaches a worker.
func TestReplyRefusals(t *testing.T) {
	p := &prompter{}
	r := newReplyRig(t, p)
	a := r.notified(t, "w-a", 10)
	n := 0
	for _, c := range []struct {
		name    string
		reply   Reply
		want    string
		outcome string
	}{
		{"not a reply", Reply{Text: "now add tests"}, ReplyHintText, "not_a_reply"},
		{"no text (a photo)", Reply{To: a}, ReplyHintText, "no_text"},
		{"a forward", Reply{To: a, Text: "rm -rf", Relayed: true}, "only text you type yourself", "relayed"},
		{"too long", Reply{To: a, Text: strings.Repeat("é", MaxReplyRunes+1)}, fmt.Sprintf("too long (%d characters)", MaxReplyRunes+1), "too_long"},
		{"a message the bridge never sent", Reply{To: Ref{FakeChatID, 999}, Text: "hi"}, ReplyUnknownText, "unknown"},
		{"another chat's message 1", Reply{To: Ref{FakeChatID + 1, a.Message}, Text: "hi"}, ReplyUnknownText, "unknown"},
	} {
		msgID++
		c.reply.Ref, c.reply.At = Ref{FakeChatID, msgID}, r.clock.Now()
		r.ch.Deliver(c.reply)
		n++
		got := lastAnswer(t, r, n)
		if got.To != c.reply.Ref || !strings.Contains(got.Text, c.want) {
			t.Errorf("%s: answered %+v, want %q", c.name, got, c.want)
		}
		if strings.Contains(got.Text, "rm -rf") || strings.Contains(got.Text, "éé") {
			t.Errorf("%s: the text echoed: %q", c.name, got.Text)
		}
		if rows := replyRows(r); rows[len(rows)-1].Outcome != c.outcome {
			t.Errorf("%s: audited %+v", c.name, rows[len(rows)-1])
		}
	}
	if typed := p.all(); len(typed) != 0 {
		t.Fatalf("typed %q", typed)
	}
	// Sent while the bridge was away, longer ago than ReplyMaxAge.
	old := Reply{Ref: Ref{FakeChatID, 5000}, To: a, Text: "old", At: r.clock.Now().Add(-ReplyMaxAge - time.Second)}
	r.ch.Deliver(old)
	if got := lastAnswer(t, r, n+1); got.To != old.Ref || !strings.Contains(got.Text, "while the bridge was away") {
		t.Fatalf("stale: %+v", got)
	}
	// A notification older than MessageMaxAge is forgotten.
	r.clock.Advance(MessageMaxAge + time.Second)
	r.reply(a, "late")
	if got := lastAnswer(t, r, n+2); got.Text != ReplyUnknownText {
		t.Fatalf("expired: %+v", got)
	}
	if typed := p.all(); len(typed) != 0 {
		t.Fatalf("typed %q", typed)
	}
}

// The hub's refusals, at once or from the lane, say why in the chat; the
// ask's is the ticket's sentence.
func TestReplyPromptRefused(t *testing.T) {
	p := &prompter{}
	r := newReplyRig(t, p)
	a := r.notified(t, "w-a", 10)
	for i, c := range []struct {
		refuse, lane error
		want, kind   string
	}{
		{refuse: &ReplyError{Kind: ReplyAsk}, want: "This worker has a question, tap an answer or answer in the game", kind: ReplyAsk},
		{refuse: &ReplyError{Kind: ReplyGone}, want: "that worker is gone", kind: ReplyGone},
		{refuse: &ReplyError{Kind: ReplyBusy}, want: "a lot of input waiting", kind: ReplyBusy},
		{lane: &ReplyError{Kind: ReplyFailed, Err: errors.New("herdr: pane quoted now add tests")}, want: "could not type it", kind: ReplyFailed},
		{lane: &ReplyError{Kind: ReplyAsk}, want: ReplyAskText, kind: ReplyAsk},
		{lane: errors.New("something else"), want: "could not type it", kind: ReplyFailed},
	} {
		p.mu.Lock()
		p.refuse = func(string) error { return c.refuse }
		p.lane = func(string) error { return c.lane }
		p.mu.Unlock()
		rp := r.reply(a, "now add tests")
		got := lastAnswer(t, r, i+1)
		if got.To != rp.Ref || !strings.Contains(got.Text, c.want) || strings.Contains(got.Text, "add tests") {
			t.Errorf("%d: answered %+v, want %q", i, got, c.want)
		}
		if rows := replyRows(r); rows[len(rows)-1].Outcome != c.kind || rows[len(rows)-1].ID != "w-a" {
			t.Errorf("%d: audited %+v", i, rows[len(rows)-1])
		}
	}
	if len(r.ch.Confirmed()) != 0 {
		t.Fatalf("confirmed %+v", r.ch.Confirmed())
	}
}

// At most ReplyPerWorker replies to one worker within a minute: more are
// refused; and the bot's answers are bounded too.
func TestReplyRateLimited(t *testing.T) {
	p := &prompter{}
	r := newReplyRig(t, p)
	a := r.notified(t, "w-a", 10)
	for range ReplyPerWorker {
		r.reply(a, "go")
	}
	if !r.ch.WaitReplied(ReplyPerWorker, 5*time.Second) {
		t.Fatal("not confirmed")
	}
	r.reply(a, "one more")
	if got := lastAnswer(t, r, ReplyPerWorker+1); !strings.Contains(got.Text, "too many replies") {
		t.Fatalf("answered %+v", got)
	}
	if n := len(p.all()); n != ReplyPerWorker {
		t.Fatalf("%d typed", n)
	}
	// A minute later it goes again.
	r.clock.Advance(ReplyWindow)
	r.reply(a, "again")
	if !r.ch.WaitReplied(ReplyPerWorker+2, 5*time.Second) || len(p.all()) != ReplyPerWorker+1 {
		t.Fatalf("typed %q", p.all())
	}
	// A flood of messages that are not replies: answered AnswerMax times.
	before := len(r.ch.Answered())
	for range AnswerMax * 3 {
		r.reply(Ref{}, "spam")
	}
	r.reply(a, "marker") // handled after the flood: typed and confirmed
	deadline := time.Now().Add(5 * time.Second)
	for len(r.ch.Confirmed()) < ReplyPerWorker+2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if n := len(r.ch.Answered()) - before; n != AnswerMax {
		t.Fatalf("%d answers to the flood, want %d", n, AnswerMax)
	}
}

// Replies off (the default): the channel does not listen, nothing is
// routed. Switched on: what came before is dropped without a word. Off
// again: a reply already read is not routed.
func TestRepliesSwitch(t *testing.T) {
	p := &prompter{}
	r := newRigWith(t, true, func(o *Options, _ *Settings) { o.Prompt = p.prompt })
	a := r.notified(t, "w-a", 10)
	if r.ch.Listening() || r.svc.View().Replies {
		t.Fatal("replies on by default")
	}
	if r.ch.Deliver(Reply{Ref: Ref{FakeChatID, 1}, To: a, Text: "x", At: r.clock.Now()}) {
		t.Fatal("delivered while not listening")
	}
	// Sent while off, read once on (the channel's newest update): dropped.
	before := r.clock.Now()
	r.clock.Advance(3 * time.Second)
	on, off := true, false
	if err := r.svc.Apply(context.Background(), Update{Replies: &on}); err != nil {
		t.Fatal(err)
	}
	waitListening(t, r.ch) // the channel's Run may not have started yet
	if !r.svc.View().Replies || !r.store.set.Replies {
		t.Fatal("not on")
	}
	r.ch.Deliver(Reply{Ref: Ref{FakeChatID, 2}, To: a, Text: "from before", At: before})
	r.clock.Advance(time.Second) // a reply of the second they were switched on is dropped too
	rp := r.reply(a, "after")
	if !r.ch.WaitReplied(1, 5*time.Second) {
		t.Fatal("the reply after was not confirmed")
	}
	if typed := p.all(); len(typed) != 1 || typed[0] != "w-a: after" || r.ch.Confirmed()[0] != rp.Ref || len(r.ch.Answered()) != 0 {
		t.Fatalf("typed %q, answered %+v", typed, r.ch.Answered())
	}
	// Off: a reply the channel already handed over is dropped.
	r.svc.inbound(Reply{Ref: Ref{FakeChatID, 3}, To: a, Text: "in flight", At: r.clock.Now()})
	if err := r.svc.Apply(context.Background(), Update{Replies: &off}); err != nil {
		t.Fatal(err)
	}
	r.svc.reply(context.Background(), Reply{Ref: Ref{FakeChatID, 4}, To: a, Text: "late", At: r.clock.Now()})
	time.Sleep(50 * time.Millisecond)
	if typed := p.all(); len(typed) > 2 || (len(typed) == 2 && typed[1] != "w-a: in flight") {
		t.Fatalf("typed %q", typed)
	}
	if r.ch.Listening() {
		t.Fatal("still listening")
	}
	// Unpaired: switching on is refused; on and then unpaired, nothing routes.
	if err := r.svc.Apply(context.Background(), Update{Replies: &on}); err != nil {
		t.Fatal(err)
	}
	if err := r.svc.Unpair(); err != nil {
		t.Fatal(err)
	}
	n := len(p.all())
	r.svc.reply(context.Background(), Reply{Ref: Ref{FakeChatID, 5}, To: a, Text: "unpaired", At: r.clock.Now()})
	if len(p.all()) != n {
		t.Fatal("routed while unpaired")
	}
	if err := r.svc.Apply(context.Background(), Update{Replies: &off}); err != nil {
		t.Fatal(err)
	}
	if err := r.svc.Apply(context.Background(), Update{Replies: &on}); CodeOf(err) != CodeNotPaired {
		t.Fatalf("on while unpaired: %v", err)
	}
}

// A reply sent while replies were off, in the second they were switched
// on (Telegram dates are whole seconds), is dropped: only one dated after
// that second goes.
func TestReplySameSecondBacklog(t *testing.T) {
	ctx := context.Background()
	clock := NewFakeClock(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC))
	st := NewFakeStore()
	ch := NewFakeChannel(true)
	to := Ref{FakeChatID, 1}
	if err := st.SaveNotifyMessage(ctx, to, "w-a", clock.Now()); err != nil {
		t.Fatal(err)
	}
	p := &prompter{}
	svc, err := New(ctx, Options{Store: st, Channel: ch, Clock: clock, Prompt: p.prompt})
	if err != nil {
		t.Fatal(err)
	}
	sec := clock.Now()
	clock.Advance(500 * time.Millisecond)
	on := true
	if err := svc.Apply(ctx, Update{Replies: &on}); err != nil {
		t.Fatal(err)
	}
	svc.reply(ctx, ch.Stamp(Reply{Ref: Ref{FakeChatID, 2}, To: to, Text: "sent while off", At: sec}))
	if typed := p.all(); len(typed) != 0 {
		t.Fatalf("typed %q", typed)
	}
	svc.reply(ctx, ch.Stamp(Reply{Ref: Ref{FakeChatID, 3}, To: to, Text: "after", At: sec.Add(time.Second)}))
	if typed := p.all(); len(typed) != 1 || typed[0] != "w-a: after" {
		t.Fatalf("typed %q", typed)
	}
}

// blockingLookup holds NotifyMessage until released.
type blockingLookup struct {
	*FakeStore
	entered, release chan struct{}
}

func (s *blockingLookup) NotifyMessage(ctx context.Context, msg Ref) (string, time.Time, bool, error) {
	close(s.entered)
	<-s.release
	return s.FakeStore.NotifyMessage(ctx, msg)
}

// Switched off, unpaired, paired anew or the token cleared after a reply
// was read and before its hand-off: it is not typed, nor answered.
func TestReplyRevokedBeforeItsHandOff(t *testing.T) {
	for _, c := range []struct {
		name   string
		revoke func(*Service, *FakeChannel) error
		typed  bool
	}{
		{"kept", func(*Service, *FakeChannel) error { return nil }, true},
		{"off", func(s *Service, _ *FakeChannel) error {
			off := false
			return s.Apply(context.Background(), Update{Replies: &off})
		}, false},
		{"unpaired", func(s *Service, _ *FakeChannel) error { return s.Unpair() }, false},
		{"paired anew", func(_ *Service, ch *FakeChannel) error { ch.CompletePairing("Bob"); return nil }, false},
		{"token cleared", func(s *Service, _ *FakeChannel) error { return s.ClearToken() }, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			ctx := context.Background()
			base := NewFakeStore()
			set := DefaultSettings()
			set.Replies = true
			if err := base.SaveNotifySettings(ctx, set); err != nil {
				t.Fatal(err)
			}
			now := time.Now()
			to := Ref{FakeChatID, 1}
			if err := base.SaveNotifyMessage(ctx, to, "w-a", now); err != nil {
				t.Fatal(err)
			}
			st := &blockingLookup{base, make(chan struct{}), make(chan struct{})}
			ch := NewFakeChannel(true)
			p := &prompter{}
			svc, err := New(ctx, Options{Store: st, Channel: ch, Prompt: p.prompt})
			if err != nil {
				t.Fatal(err)
			}
			rp := ch.Stamp(Reply{Ref: Ref{FakeChatID, 2}, To: to, Text: "go", At: now})
			done := make(chan struct{})
			go func() {
				defer close(done)
				svc.reply(ctx, rp)
			}()
			<-st.entered
			if err := c.revoke(svc, ch); err != nil {
				t.Fatal(err)
			}
			close(st.release)
			<-done
			if typed := len(p.all()) == 1; typed != c.typed {
				t.Fatalf("typed %q", p.all())
			}
			if len(ch.Answered()) != 0 {
				t.Fatalf("answered %+v", ch.Answered())
			}
		})
	}
}

// listenGate holds Listen(true) until released.
type listenGate struct {
	*FakeChannel
	entered, release chan struct{}
}

func (c *listenGate) Listen(on bool) {
	if on {
		close(c.entered)
		<-c.release
	}
	c.FakeChannel.Listen(on)
}

// Overlapping notify.set commands: the channel listens as the settings
// committed last say.
func TestApplyListensAsCommitted(t *testing.T) {
	ctx := context.Background()
	ch := &listenGate{NewFakeChannel(true), make(chan struct{}), make(chan struct{})}
	svc, err := New(ctx, Options{Channel: ch})
	if err != nil {
		t.Fatal(err)
	}
	on, off := true, false
	first, second := make(chan error, 1), make(chan error, 1)
	go func() { first <- svc.Apply(ctx, Update{Replies: &on}) }()
	<-ch.entered
	go func() { second <- svc.Apply(ctx, Update{Replies: &off}) }()
	time.Sleep(20 * time.Millisecond) // the second one waits for the first
	close(ch.release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	ch.mu.Lock()
	listen := ch.listen
	ch.mu.Unlock()
	if v := svc.View(); listen != v.Replies || v.Replies {
		t.Fatalf("listening %v, replies %v", listen, v.Replies)
	}
}
