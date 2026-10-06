//go:build integration

package codexshare

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
)

// #156: the bridge's answer path (codexapp.Watcher's turn/steer and
// turn/start, codexapp.Questions) against the real TUI and mock inference,
// and the race phase 1 left open: a steer the server accepted, then the
// turn ends before its next model request.

// asyncNote is the part of a join's notifications these probes read.
type asyncNote struct {
	ThreadID string        `json:"threadId"`
	TurnID   string        `json:"turnId"`
	Item     codexapp.Item `json:"item"`
	Turn     struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	} `json:"turn"`
}

func decodeNote(e codexapp.Event) asyncNote {
	var n asyncNote
	_ = json.Unmarshal(e.Params, &n)
	return n
}

func (e *eventLog) len() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.events)
}

// waitFrom waits for an event at index from or later that matches ok, and
// returns it with the index after it.
func (e *eventLog) waitFrom(t *testing.T, from int, d time.Duration, what string, ok func(codexapp.Event) bool) (codexapp.Event, int) {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		e.mu.Lock()
		for i := from; i < len(e.events); i++ {
			if ok(e.events[i]) {
				ev := e.events[i]
				e.mu.Unlock()
				return ev, i + 1
			}
		}
		e.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("no %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// feed gives q the join's items and turn ends from index from on, as the
// hub does.
func (e *eventLog) feed(q *codexapp.Questions, from int) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, ev := range e.events[from:] {
		n := decodeNote(ev)
		if ev.Kind != codexapp.EvNotification || n.ThreadID != q.Thread {
			continue
		}
		switch ev.Method {
		case "item/started", "item/completed":
			q.Observe(n.TurnID, n.Item, codexapp.OriginLive)
		case "turn/completed":
			q.TurnEnded(n.Turn.ID)
		}
	}
	return len(e.events)
}

// userItems lists the join's userMessage items from index from on.
func (e *eventLog) userItems(from int) []map[string]any {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []map[string]any
	for _, ev := range e.events[from:] {
		if ev.Kind != codexapp.EvNotification || !strings.HasPrefix(ev.Method, "item/") {
			continue
		}
		if n := decodeNote(ev); n.Item.Type == codexapp.ItemUserMessage {
			out = append(out, map[string]any{"method": ev.Method, "turn": n.TurnID, "id": n.Item.ID, "clientId": n.Item.ClientID,
				"text": oneLine(n.Item.UserText(), 200)})
		}
	}
	return out
}

func (e *eventLog) methodsFrom(from int) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.events[from:] {
		out = append(out, string(ev.Kind)+" "+ev.Method)
	}
	return out
}

func asyncBatch(e codexapp.Event) bool {
	if e.Kind != codexapp.EvNotification || e.Method != "item/completed" {
		return false
	}
	_, ok := codexapp.BatchOf("", decodeNote(e).Item)
	return ok
}

func turnDone(turn string) func(codexapp.Event) bool {
	return func(e codexapp.Event) bool {
		return e.Kind == codexapp.EvNotification && e.Method == "turn/completed" && decodeNote(e).Turn.ID == turn
	}
}

func userWith(cid string) func(codexapp.Event) bool {
	return func(e codexapp.Event) bool {
		if e.Kind != codexapp.EvNotification || !strings.HasPrefix(e.Method, "item/") {
			return false
		}
		it := decodeNote(e).Item
		return it.Type == codexapp.ItemUserMessage && it.ClientID == cid
	}
}

// historyUser finds the user message with clientId cid in the thread's
// history: its turn ("" when none has it).
func (f *fx) historyUser(c *Client, thread, cid string) (string, string) {
	f.t.Helper()
	var res struct {
		Thread struct {
			Turns []codexapp.Turn `json:"turns"`
		} `json:"thread"`
	}
	if err := c.Call(f.ctx, "thread/read", map[string]any{"threadId": thread, "includeTurns": true}, &res); err != nil {
		f.t.Fatal(err)
	}
	for _, tu := range res.Thread.Turns {
		for _, it := range tu.Items {
			if it.Type == codexapp.ItemUserMessage && it.ClientID == cid {
				return tu.ID, tu.Status
			}
		}
	}
	return "", ""
}

func TestCodexShareAsyncAnswers(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a")
	w := f.sharedWorker("ws-a", "worker")
	th := w.thread.ID
	watcher, ev := watch(t, w.sock, th)
	ev.wait(t, codexapp.EvJoined, 20*time.Second)
	q := codexapp.NewQuestions(th)
	ctx := func(d time.Duration) context.Context {
		c, cancel := context.WithTimeout(f.ctx, d)
		t.Cleanup(cancel)
		return c
	}

	t.Run("steered answer: answered once delivered, with the bridge's client id", func(t *testing.T) {
		f.settle(w.name)
		from := ev.len()
		f.promptWorking(w.name, "MOCK:ask-free hold=a1")
		f.held("a1")
		qe, _ := ev.waitFrom(t, from, 30*time.Second, "async batch", asyncBatch)
		n := decodeNote(qe)
		f.recordJSON("a-question-item", n)
		ev.feed(q, from)
		cid := codexapp.NewClientID()
		answers, err := q.Begin(n.Item.ID, []codexapp.Reply{{Index: 0, Text: "from-the-bridge"}})
		if err != nil {
			t.Fatal(err)
		}
		steerAt := ev.len()
		turn, err := watcher.Steer(ctx(10*time.Second), n.TurnID, codexapp.ReplyEnvelope(answers...), cid)
		if err != nil {
			t.Fatalf("turn/steer: %v", err)
		}
		q.Sent(n.Item.ID, []int{0}, turn, false)
		f.record("a-steer-result.txt", "turn/steer returned turnId "+turn+" (asking turn "+n.TurnID+")\n")
		time.Sleep(2 * time.Second)
		// Is the steered input an item before its delivery?
		f.recordJSON("a-user-items-before-delivery", ev.userItems(steerAt))
		f.snap("a-after-steer", w.tui)
		f.mock.HoldNext(KindReply, "a1-reply")
		_ = f.mock.Release("a1")
		f.held("a1-reply")
		_, after := ev.waitFrom(t, steerAt, 30*time.Second, "the steered user message", userWith(cid))
		f.recordJSON("a-user-items-after-delivery", ev.userItems(steerAt))
		_ = f.mock.Release("a1-reply")
		ev.waitFrom(t, after, 60*time.Second, "turn/completed", turnDone(n.TurnID))
		ev.feed(q, from)
		b := q.Batch(n.Item.ID)
		f.recordJSON("a-question-state", b)
		if x := b.Questions[0]; x.State != codexapp.QAnswered || x.AnsweredBy != codexapp.AnsweredByBridge || x.Answer != "from-the-bridge" {
			t.Errorf("question = %+v", x)
		}
		f.snap("a-done", w.tui)
	})

	t.Run("stale and idle steers are refused, nothing delivered", func(t *testing.T) {
		f.settle(w.name)
		before := len(f.mock.Requests())
		_, err := watcher.Steer(ctx(10*time.Second), "01a11111-0000-7000-8000-000000000000", "MOCK:say stale-steer", codexapp.NewClientID())
		var rpc *codexapp.RPCError
		f.record("b-steer-idle-error.txt", rpcText(err)+"\n")
		if !errors.As(err, &rpc) || !codexapp.Refused(err) {
			t.Errorf("idle steer: %v, want a refusal", err)
		}
		time.Sleep(2 * time.Second)
		if n := len(f.mock.Requests()) - before; n != 0 {
			t.Errorf("a refused steer made %d model requests", n)
		}
		// A stale id while another turn runs.
		f.promptWorking(w.name, "MOCK:hold b-busy")
		f.held("b-busy")
		_, err = watcher.Steer(ctx(10*time.Second), "01a11111-0000-7000-8000-000000000000", "MOCK:say stale-steer", codexapp.NewClientID())
		f.record("b-steer-stale-error.txt", rpcText(err)+"\n")
		if !codexapp.Refused(err) {
			t.Errorf("stale steer: %v, want a refusal", err)
		}
		// turn/start while a turn runs.
		cid := codexapp.NewClientID()
		from := ev.len()
		turn, err := watcher.StartTurn(ctx(10*time.Second), "MOCK:say started-while-active", cid)
		f.record("b-start-while-active.txt", "turn "+turn+" err "+rpcText(err)+"\n")
		_ = f.mock.Release("b-busy")
		f.settle(w.name)
		time.Sleep(3 * time.Second)
		f.recordJSON("b-user-items", ev.userItems(from))
		f.recordJSON("b-requests", summarize(f.mock.Requests()[before:]))
		f.snap("b-done", w.tui)
	})

	t.Run("race: a steer accepted, then the turn ends before the next model request", func(t *testing.T) {
		f.settle(w.name)
		from := ev.len()
		before := len(f.mock.Requests())
		f.promptWorking(w.name, "MOCK:ask-free hold=race")
		f.held("race")
		qe, _ := ev.waitFrom(t, from, 30*time.Second, "async batch", asyncBatch)
		n := decodeNote(qe)
		ev.feed(q, from)
		answers, err := q.Begin(n.Item.ID, []codexapp.Reply{{Index: 0, Text: "raced"}})
		if err != nil {
			t.Fatal(err)
		}
		cid := codexapp.NewClientID()
		steerAt := ev.len()
		reached, err := watcher.Steer(ctx(10*time.Second), n.TurnID, codexapp.ReplyEnvelope(answers...), cid)
		if err != nil {
			t.Fatalf("turn/steer: %v", err)
		}
		q.Sent(n.Item.ID, []int{0}, reached, false)
		// The turn ends before the model is asked again: interrupted while
		// its model request is held.
		if err := w.bridge.Call(f.ctx, "turn/interrupt", map[string]any{"threadId": th, "turnId": n.TurnID}, nil); err != nil {
			t.Fatalf("turn/interrupt: %v", err)
		}
		done, _ := ev.waitFrom(t, steerAt, 30*time.Second, "turn/completed", turnDone(n.TurnID))
		f.recordJSON("c-turn-completed", decodeNote(done).Turn)
		_ = f.mock.Release("race")
		f.settle(w.name)
		time.Sleep(3 * time.Second)
		f.recordJSON("c-user-items-after-turn-end", ev.userItems(steerAt))
		inTurn, status := f.historyUser(w.bridge, th, cid)
		f.record("c-history-after-turn-end.txt", "the steered user message is in turn "+quoteOrNone(inTurn)+" ("+status+")\n")
		f.recordJSON("c-requests-after-turn-end", summarize(f.mock.Requests()[before:]))
		f.snap("c-after-turn-end", w.tui)

		// The next turn: is the steered input carried into it?
		next := len(f.mock.Requests())
		f.prompt(w.name, "MOCK:say after-race")
		time.Sleep(2 * time.Second)
		carried := false
		for _, r := range f.mock.Requests()[next:] {
			if strings.Contains(string(r.Body), `\"`+n.Item.ID+`\",0]`) {
				carried = true
			}
		}
		inTurn2, status2 := f.historyUser(w.bridge, th, cid)
		f.record("c-next-turn.txt", "next turn's model requests carry the envelope: "+boolText(carried)+
			"\nthe steered user message is in turn "+quoteOrNone(inTurn2)+" ("+status2+")\n")
		f.recordJSON("c-requests-next-turn", summarize(f.mock.Requests()[next:]))
		f.recordJSON("c-user-items-next-turn", ev.userItems(steerAt))
		f.snap("c-next-turn", w.tui)
		ev.feed(q, from)
		b := q.Batch(n.Item.ID)
		f.recordJSON("c-question-state", b)
		// The encoding: answered only with its user message in the thread;
		// dropped, it is sent and undelivered.
		x := b.Questions[0]
		if got, want := x.State == codexapp.QAnswered, inTurn2 != ""; got != want {
			t.Fatalf("state %s but the user message %s in the history", x.State, map[bool]string{true: "is", false: "is not"}[want])
		}
		if x.State != codexapp.QSent || !x.Undelivered {
			t.Fatalf("observed delivery changed: the question is %+v", x)
		}
		// The user sends it again: a turn of its own, answered.
		answers, err = q.Begin(n.Item.ID, []codexapp.Reply{{Index: 0, Text: "raced-again"}})
		if err != nil {
			t.Fatalf("re-answering an undelivered question: %v", err)
		}
		cid = codexapp.NewClientID()
		again := ev.len()
		reached, err = watcher.StartTurn(ctx(10*time.Second), codexapp.ReplyEnvelope(answers...), cid)
		if err != nil {
			t.Fatalf("turn/start: %v", err)
		}
		q.Sent(n.Item.ID, []int{0}, reached, false)
		_, after := ev.waitFrom(t, again, 30*time.Second, "the re-sent user message", userWith(cid))
		ev.waitFrom(t, after, 60*time.Second, "turn/completed", turnDone(reached))
		ev.feed(q, again)
		f.recordJSON("c-resent-question-state", q.Batch(n.Item.ID))
		if x := q.Batch(n.Item.ID).Questions[0]; x.State != codexapp.QAnswered || x.AnsweredBy != codexapp.AnsweredByBridge {
			t.Errorf("after the second send: %+v", x)
		}
		f.snap("c-resent-answer", w.tui)
	})

	t.Run("a new join recovers the questions from the history", func(t *testing.T) {
		_, ev2 := watch(t, w.sock, th)
		j := ev2.wait(t, codexapp.EvJoined, 20*time.Second)
		fresh := codexapp.NewQuestions(th)
		fresh.Hydrate(j.Thread.Turns)
		var got []map[string]any
		for _, b := range fresh.Batches() {
			got = append(got, map[string]any{"batch": b.ID, "turn": b.Turn, "seen": b.Seen, "state": b.Questions[0].State,
				"by": b.Questions[0].AnsweredBy})
		}
		f.recordJSON("d-hydrated", got)
		live := q.Batches()
		if len(got) != len(live) {
			t.Fatalf("hydrated %d batches, live %d", len(got), len(live))
		}
		for i, b := range fresh.Batches() {
			if b.ID != live[i].ID || (live[i].Questions[0].State == codexapp.QAnswered) != (b.Questions[0].State == codexapp.QAnswered) {
				t.Errorf("batch %d: hydrated %+v, live %+v", i, b, live[i])
			}
		}
	})

	f.recordJSON("mock-requests", summarize(f.mock.Requests()))
}

func rpcText(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

func quoteOrNone(s string) string {
	if s == "" {
		return "<none>"
	}
	return s
}
