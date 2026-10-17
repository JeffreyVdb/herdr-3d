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

// replyBridge is the ask bridge (w1 Claude, w2 Codex, working) with a fake
// notification channel, switched on, on a fake clock.
type replyBridge struct {
	*askBridge
	ch    *notify.FakeChannel
	clock *notify.FakeClock
	c     *client
	ids   map[string]string
	msg   int64
}

func startReplyBridge(t *testing.T) *replyBridge {
	t.Helper()
	return startReplyBridgeWith(t, nil)
}

func startReplyBridgeWith(t *testing.T, tweak func(*server.Options)) *replyBridge {
	t.Helper()
	on := true
	rb := &replyBridge{ch: notify.NewFakeChannel(true), clock: notify.NewFakeClock(time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)), msg: 500}
	rb.askBridge = startAskBridgeWith(t, "working", func(o *server.Options) {
		o.NotifyChannel, o.NotifyEnabled, o.NotifyClock = rb.ch, &on, rb.clock
		if tweak != nil {
			tweak(o)
		}
	})
	rb.c = rb.connect(proto.Hello{Client: "phone-owner"})
	snap := rb.c.snapshot()
	rb.ids = map[string]string{"w1": idOf(t, snap, "w1"), "w2": idOf(t, snap, "w2")}
	return rb
}

// repliesOn switches replies on with notify.set.
func (rb *replyBridge) repliesOn(t *testing.T) {
	t.Helper()
	on := true
	_, ack := rb.c.mustAck(proto.CmdNotifySet, proto.NotifySetArgs{Replies: &on})
	b, _ := json.Marshal(ack.Data)
	var v notify.View
	if err := json.Unmarshal(b, &v); err != nil || !v.Replies {
		t.Fatalf("notify.set replies: %s", b)
	}
	if !rb.ch.Listening() {
		t.Fatal("the channel does not listen")
	}
	// A reply of the second they were switched on is dropped (it may have
	// been sent while they were off).
	rb.clock.Advance(time.Second)
}

// finished has workspace ws finish and waits for its notification (after
// the settle), and for its message to be remembered (its notify.send row
// is written after); it returns the message.
func (rb *replyBridge) finished(t *testing.T, ws string) notify.Ref {
	t.Helper()
	n := len(rb.ch.Sent())
	rb.setStatus(ws, "done")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !rb.clock.WaitFor(ctx, 1) {
		t.Fatalf("%s's done is not settling", ws)
	}
	rb.clock.Advance(notify.DefaultSettle)
	return rb.sentFor(t, ws, n)
}

// sentFor waits for message n+1 to be about ws, and remembered.
func (rb *replyBridge) sentFor(t *testing.T, ws string, n int) notify.Ref {
	t.Helper()
	if !rb.ch.WaitSent(n+1, 5*time.Second) {
		t.Fatalf("%s was not notified", ws)
	}
	if got := rb.ch.Sent()[n]; got.WorkerID != rb.ids[ws] {
		t.Fatalf("message %d is about %q, want %s", n+1, got.WorkerID, ws)
	}
	waitNotifyRows(t, rb.st, notify.AuditSend, n+1)
	return notify.Ref{Chat: notify.FakeChatID, Message: int64(n + 1)}
}

func (rb *replyBridge) reply(to notify.Ref, text string) notify.Ref {
	rb.msg++
	ref := notify.Ref{Chat: notify.FakeChatID, Message: rb.msg}
	rb.ch.Deliver(notify.Reply{Ref: ref, To: to, Text: text, At: rb.clock.Now()})
	return ref
}

func (rb *replyBridge) answer(t *testing.T, n int) notify.FakeAnswer {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for len(rb.ch.Answered()) < n {
		if time.Now().After(deadline) {
			t.Fatalf("%d answers, want %d (confirmed %+v)", len(rb.ch.Answered()), n, rb.ch.Confirmed())
		}
		time.Sleep(2 * time.Millisecond)
	}
	return rb.ch.Answered()[n-1]
}

// #13 acceptance: "Finished: X" on the phone, a reply "now add tests", and
// the worker's transcript shows it as the next prompt: typed into that
// worker through worker.prompt's path (Claude: typed; Codex: submitted),
// a 👍 on the reply, audited without the text.
func TestReplyTypedIntoItsWorker(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	// Replies off (the default): nothing is read.
	if rb.ch.Listening() || rb.ch.Deliver(notify.Reply{Ref: notify.Ref{Chat: 7, Message: 1}, To: notify.Ref{Chat: 7, Message: 1}, Text: "x"}) {
		t.Fatal("replies read while off")
	}
	rb.repliesOn(t)
	m1 := rb.finished(t, "w1")
	m2 := rb.finished(t, "w2")
	if n := rb.ch.Sent()[0]; n.Reason != notify.ReasonFinished {
		t.Fatalf("sent %+v", n)
	}
	r2 := rb.reply(m2, "ship it")
	r1 := rb.reply(m1, "now add tests")
	waitFor(t, "both confirmed", func() bool { return len(rb.ch.Confirmed()) == 2 })
	if c := rb.ch.Confirmed(); !slices.Contains(c, r1) || !slices.Contains(c, r2) || len(rb.ch.Answered()) != 0 {
		t.Fatalf("confirmed %+v, answered %+v", c, rb.ch.Answered())
	}
	calls := rb.term.Calls()
	if !slices.Contains(calls, `type w1:p1 "now add tests"`) || !slices.Contains(calls, `submit w2:p1 "ship it"`) {
		t.Fatalf("calls %q", calls)
	}
	rows := waitNotifyRows(t, rb.st, notify.AuditReply, 2)
	for _, r := range rows {
		var a struct {
			ID        string `json:"id"`
			TextBytes int    `json:"text_bytes"`
			Outcome   string `json:"outcome"`
		}
		if err := json.Unmarshal([]byte(r.Args), &a); err != nil || r.Client != "bridge" || !r.OK || a.Outcome != "sent" ||
			(a.ID != rb.ids["w1"] && a.ID != rb.ids["w2"]) || a.TextBytes == 0 {
			t.Fatalf("audit %+v", r)
		}
	}
	// No other row has the text: not worker.prompt's either.
	log, err := rb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if row := e.Cmd + " " + e.Args + " " + e.Error + " " + e.Result; strings.Contains(row, "add tests") || strings.Contains(row, "ship it") {
			t.Errorf("typed text in the audit log: %s", row)
		}
		if e.Cmd == proto.CmdWorkerPrompt {
			t.Errorf("a worker.prompt row for a reply: %+v", e)
		}
	}
}

// While the worker has an ask its dialog would take the text: refused
// with the ticket's sentence, nothing typed.
func TestReplyRefusedWhileAsking(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	n := len(rb.ch.Sent())
	appendLine(t, rb.claude, fixture(t, "claude", "ask_pending.jsonl"))
	askOf(rb.c, rb.ids["w1"], pendingID("toolu_01FuqDRbauxtx9cAAmN3o8ex"))
	ref := rb.sentFor(t, "w1", n)
	if got := rb.ch.Sent()[n]; got.Reason != notify.ReasonQuestion {
		t.Fatalf("sent %+v", got)
	}
	r := rb.reply(ref, "tea")
	if a := rb.answer(t, 1); a.To != r || a.Text != "This worker has a question, tap an answer or answer in the game" {
		t.Fatalf("answer %+v", a)
	}
	if calls := rb.term.Calls(); len(calls) != 0 || len(rb.ch.Confirmed()) != 0 {
		t.Fatalf("typed %q", calls)
	}
	rows := waitNotifyRows(t, rb.st, notify.AuditReply, 1)
	if rows[0].OK || rows[0].Error != notify.ReplyAsk || strings.Contains(rows[0].Args, "tea") {
		t.Fatalf("audit %+v", rows[0])
	}
}

// A notification's worker that is gone, and a worker whose input lane is
// full: said in the chat.
func TestReplyFailuresSaidInTheChat(t *testing.T) {
	t.Parallel()
	rb := startReplyBridge(t)
	rb.repliesOn(t)
	ctx := context.Background()
	// Gone: a notification about a worker the bridge no longer has.
	if err := rb.st.SaveNotifyMessage(ctx, notify.FakeChatID, 99, "nobody", rb.clock.Now()); err != nil {
		t.Fatal(err)
	}
	rb.reply(notify.Ref{Chat: notify.FakeChatID, Message: 99}, "hello")
	if a := rb.answer(t, 1); !strings.Contains(a.Text, "gone") {
		t.Fatalf("gone: %+v", a)
	}
	// Lane full: one worker.keys held in herdr, 32 more waiting.
	m1 := rb.finished(t, "w1")
	gate := make(chan struct{})
	defer close(gate) // Release herdr before bridge cleanup, even on a failed assertion.
	started := make(chan struct{}, 1)
	rb.term.mu.Lock()
	rb.term.textGate = gate
	rb.term.textStarted = started
	rb.term.mu.Unlock()
	send := func(i int) {
		raw, _ := json.Marshal(proto.WorkerKeysArgs{ID: rb.ids["w1"], Input: []proto.InputItem{text("slow")}})
		rb.c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "k" + itoa(i), Args: raw})
	}
	send(0)
	// Wait until the first command leaves the queue and blocks in herdr.
	// Otherwise the burst can fill the queue before the lane starts.
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the first input did not reach herdr")
	}
	for i := range 32 {
		send(i + 1)
	}
	// A reply on the same connection proves all 32 commands were queued.
	rb.c.mustAck(proto.CmdNotifyGet, struct{}{})
	rb.reply(m1, "now add tests")
	if a := rb.answer(t, 2); !strings.Contains(a.Text, "a lot of input waiting") {
		t.Fatalf("busy: %+v", a)
	}
	for _, c := range rb.term.Calls() {
		if strings.Contains(c, "now add tests") || strings.Contains(c, "hello") {
			t.Fatalf("typed %q", c)
		}
	}
}
