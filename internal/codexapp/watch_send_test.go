package codexapp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

// #156: the join's history, and the watcher's two sends.

func TestWatcherJoinCarriesTheHistory(t *testing.T) {
	f := newFakeServer(t)
	f.thread["status"] = map[string]any{"type": "active", "activeFlags": []any{}}
	f.thread["turns"] = []any{
		map[string]any{"id": "t1", "status": "completed", "items": []any{
			map[string]any{"type": "userMessage", "id": "u1", "clientId": "c1", "content": []any{map[string]any{"type": "text", "text": "MOCK:ask-free"}}},
			map[string]any{"type": "agentMessage", "id": "call_3", "text": "Any context?", "delivery": "async",
				"questions": []any{map[string]any{"title": "Any context?", "options": nil}}},
			map[string]any{"type": "commandExecution", "id": "x", "command": "ls"},
		}},
		map[string]any{"id": "t2", "status": "inProgress", "items": []any{}},
	}
	r := newRecorder()
	watch(t, f, r, nil)
	j := r.wait(t, EvJoined)
	th := j.Thread
	if len(th.Turns) != 2 || th.ActiveTurn() != "t2" {
		t.Fatalf("thread %+v", th)
	}
	q := NewQuestions("th1")
	q.Hydrate(th.Turns)
	if b := q.Batch("call_3"); b == nil || b.Turn != "t1" || b.Questions[0].Title != "Any context?" {
		t.Fatalf("batch %+v", b)
	}
	if u := th.Turns[0].Items[0]; u.ClientID != "c1" || u.UserText() != "MOCK:ask-free" {
		t.Fatalf("user item %+v", u)
	}
	for _, m := range f.messages() {
		if p, _ := m["params"].(map[string]any); m["method"] == "thread/turns/list" && p["cursor"] != nil {
			t.Fatal("paged without a cursor")
		}
	}
}

// #158: thread/resume gives the newest turn, running or interrupted, with
// the legacy history builder's item-N ids; the join reads those turns again
// with thread/turns/list, where an async question is under its call_id,
// and keeps the rest.
func TestWatcherJoinReadsLegacyTurnsAgain(t *testing.T) {
	question := []any{map[string]any{"title": "Which fixture color?", "options": []any{"Green", "Blue"}}}
	turn := func(id, status, user, batch string) map[string]any {
		return map[string]any{"id": id, "status": status, "items": []any{
			map[string]any{"type": "userMessage", "id": user, "clientId": "c1", "content": []any{map[string]any{"type": "text", "text": "MOCK:ask-options"}}},
			map[string]any{"type": "agentMessage", "id": batch, "text": "…", "delivery": "async", "questions": question},
		}}
	}
	for _, status := range []string{"inProgress", "interrupted"} {
		f := newFakeServer(t)
		f.thread["status"] = map[string]any{"type": "active", "activeFlags": []any{}}
		f.thread["turns"] = []any{turn("t1", "completed", "u0", "call_1"), turn("t2", status, "item-1", "item-2")}
		var asked map[string]any
		f.respond = func(method string, p map[string]any) (any, any, bool) {
			if method != "thread/turns/list" {
				return nil, map[string]any{"code": -32601, "message": "unexpected"}, false
			}
			asked = p
			return map[string]any{"data": []any{turn("t2", status, "01a1-u", "call_3")}}, nil, false
		}
		r := newRecorder()
		watch(t, f, r, nil)
		th := r.wait(t, EvJoined).Thread
		q := NewQuestions("th1")
		q.Hydrate(th.Turns)
		if q.Batch("call_3") == nil || q.Batch("item-2") != nil || q.Batch("call_1") == nil || len(th.Turns) != 2 {
			t.Fatalf("%s: turns %+v, batches %+v", status, th.Turns, q.Batches())
		}
		b, _ := json.Marshal(asked)
		if string(b) != `{"itemsView":"full","limit":1,"sortDirection":"desc","threadId":"th1"}` {
			t.Fatalf("thread/turns/list %s", b)
		}
	}

	// The list has nothing for it: the turn as thread/resume gave it.
	f := newFakeServer(t)
	f.thread["turns"] = []any{turn("t2", "interrupted", "item-1", "item-2")}
	r := newRecorder()
	watch(t, f, r, nil)
	if th := r.wait(t, EvJoined).Thread; len(th.Turns) != 1 || th.Turns[0].Items[1].ID != "item-2" {
		t.Fatalf("turns %+v", th.Turns)
	}
}

// A paginated thread: one page of older turns, newest first from the
// cursor, put in front of those thread/resume returned.
func TestWatcherReadsOnePageOfOlderTurns(t *testing.T) {
	f := newFakeServer(t)
	f.thread["turns"] = []any{map[string]any{"id": "t3", "status": "completed", "items": []any{}}}
	f.older = map[string]any{"rolloutOrdinal": 118}
	var asked map[string]any
	f.respond = func(method string, p map[string]any) (any, any, bool) {
		if method != "thread/turns/list" {
			return nil, map[string]any{"code": -32601, "message": "unexpected"}, false
		}
		asked = p
		return map[string]any{"data": []any{
			map[string]any{"id": "t3", "status": "completed", "items": []any{}},
			map[string]any{"id": "t2", "status": "completed", "items": []any{}},
			map[string]any{"id": "t1", "status": "completed", "items": []any{}},
		}}, nil, false
	}
	r := newRecorder()
	watch(t, f, r, nil)
	j := r.wait(t, EvJoined)
	var ids []string
	for _, tu := range j.Thread.Turns {
		ids = append(ids, tu.ID)
	}
	if len(ids) != 3 || ids[0] != "t1" || ids[1] != "t2" || ids[2] != "t3" || j.Thread.Partial {
		t.Fatalf("turns %v (partial %v)", ids, j.Thread.Partial)
	}
	b, _ := json.Marshal(asked)
	if string(b) != `{"cursor":{"rolloutOrdinal":118},"itemsView":"full","limit":50,"sortDirection":"desc","threadId":"th1"}` {
		t.Fatalf("thread/turns/list %s", b)
	}
}

// #158: a history is Partial when the thread has older turns than the
// join read: the page of older turns had more after it, or failed.
func TestWatcherHistoryPartial(t *testing.T) {
	for _, c := range []struct {
		name    string
		older   any
		page    any // thread/turns/list's result, nil: an error
		partial bool
	}{
		{"not paginated", nil, nil, false},
		{"older page read to the start", map[string]any{"rolloutOrdinal": 3}, map[string]any{"data": []any{}, "nextCursor": nil}, false},
		{"more after the page", map[string]any{"rolloutOrdinal": 300}, map[string]any{"data": []any{},
			"nextCursor": `{"rolloutOrdinal":16}`}, true},
		{"the page failed", map[string]any{"rolloutOrdinal": 300}, nil, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeServer(t)
			f.thread["turns"] = []any{map[string]any{"id": "t9", "status": "completed", "items": []any{}}}
			f.older = c.older
			f.respond = func(string, map[string]any) (any, any, bool) {
				if c.page == nil {
					return nil, map[string]any{"code": -32603, "message": "no"}, false
				}
				return c.page, nil, false
			}
			r := newRecorder()
			watch(t, f, r, nil)
			if th := r.wait(t, EvJoined).Thread; th.Partial != c.partial {
				t.Fatalf("partial = %v, want %v", th.Partial, c.partial)
			}
		})
	}
}

func TestWatcherSends(t *testing.T) {
	f := newFakeServer(t)
	got := map[string]map[string]any{}
	f.respond = func(method string, p map[string]any) (any, any, bool) {
		got[method] = p
		switch method {
		case "turn/steer":
			if p["expectedTurnId"] != "t2" {
				return nil, map[string]any{"code": -32600, "message": "expected active turn id `" + p["expectedTurnId"].(string) + "` but found `t2`"}, false
			}
			return map[string]any{"turnId": "t2"}, nil, false
		case "turn/start":
			return map[string]any{"turn": map[string]any{"id": "t9", "status": "inProgress", "items": []any{}}}, nil, false
		}
		return nil, nil, true // silent
	}
	r := newRecorder()
	w := watch(t, f, r, func(o *Options) { o.CallTimeout = 300 * time.Millisecond })
	ctx := context.Background()
	if _, err := w.Steer(ctx, "t2", "x", "c"); !errors.Is(err, ErrNotAttached) && w.State() != StateJoined {
		// Before the join it is refused without a request; once joined it
		// goes out. Either is fine here: the join races the call.
		t.Fatalf("steer before the join: %v", err)
	}
	r.wait(t, EvJoined)
	cid := NewClientID()
	turn, err := w.Steer(ctx, "t2", "hello", cid)
	if err != nil || turn != "t2" {
		t.Fatalf("steer = %q, %v", turn, err)
	}
	b, _ := json.Marshal(got["turn/steer"])
	if string(b) != `{"clientUserMessageId":"`+cid+`","expectedTurnId":"t2","input":[{"text":"hello","text_elements":[],"type":"text"}],"threadId":"th1"}` {
		t.Fatalf("turn/steer params %s", b)
	}
	if _, err := w.Steer(ctx, "t1", "hello", cid); !Refused(err) || errors.Is(err, ErrNoResponse) {
		t.Fatalf("stale steer: %v", err)
	}
	turn, err = w.StartTurn(ctx, "idle", cid)
	if err != nil || turn != "t9" {
		t.Fatalf("start = %q, %v", turn, err)
	}
	b, _ = json.Marshal(got["turn/start"])
	if string(b) != `{"clientUserMessageId":"`+cid+`","input":[{"text":"idle","text_elements":[],"type":"text"}],"threadId":"th1"}` {
		t.Fatalf("turn/start params %s: no override may ride along", b)
	}
	// No response: the outcome is unknown, and it is not a refusal.
	f.respond = func(string, map[string]any) (any, any, bool) { return nil, nil, true }
	if _, err := w.StartTurn(ctx, "lost", cid); !errors.Is(err, ErrNoResponse) || Refused(err) {
		t.Fatalf("lost response: %v", err)
	}
	w.Close()
	if _, err := w.StartTurn(ctx, "after", cid); !errors.Is(err, ErrNotAttached) {
		t.Fatalf("after close: %v", err)
	}
}

func TestClientIDs(t *testing.T) {
	a, b := NewClientID(), NewClientID()
	if a == b || !IsBridgeClientID(a) || IsBridgeClientID("9b0a4f98-28da-4ce4-92d0-6a5ad06370ff") || IsBridgeClientID("") {
		t.Fatalf("client ids %q %q", a, b)
	}
}
