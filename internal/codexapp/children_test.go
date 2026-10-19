package codexapp

import (
	"context"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

// Frames of #27's live probe (codex-cli 0.163.0 and 0.162.1, a real model:
// docs/research/codex-server-subagents.md), cut to the fields read; the ids are
// Codex's own, the paths scrubbed.
const (
	probeRoot  = "01a152fd-2d6a-7a52-923e-7831ee9a079d"
	probeChild = "01a152fd-4fe5-7b00-957a-0084d67c7446"
)

func TestDecodeChildNote(t *testing.T) {
	cases := []struct {
		name, params string
		want         ChildNote
		children     []string
	}{
		{"started (0.163.0)", `{"item":{"type":"subAgentActivity","model":"gpt-6-luna","reasoningEffort":"low","id":"call_1ba954358f9d4dd481b50a73d891a945","kind":"started","agentThreadId":"01a152fd-4fe5-7b00-957a-0084d67c7446","agentPath":"/root/sleeper"},"threadId":"01a152fd-2d6a-7a52-923e-7831ee9a079d","turnId":"01a152fd-4439-7261-8846-57252b2fc2e5","completedAtMs":1792393695232}`,
			ChildNote{ThreadID: probeRoot, CompletedAtMs: 1792393695232, Item: AgentItem{Type: ItemSubAgentActivity, ID: "call_1ba954358f9d4dd481b50a73d891a945",
				Kind: ActivityStarted, AgentThreadID: probeChild, AgentPath: "/root/sleeper"}}, []string{probeChild}},
		{"interacted (followup_task)", `{"item":{"type":"subAgentActivity","model":null,"reasoningEffort":null,"id":"call_797a2af02f194e2faab4e3bcc0da07fa","kind":"interacted","agentThreadId":"01a152fd-4fe5-7b00-957a-0084d67c7446","agentPath":"/root/sleeper"},"threadId":"01a152fd-2d6a-7a52-923e-7831ee9a079d","turnId":"01a152fe-6bf9-7621-9eb9-fa1a6cecd7f8","startedAtMs":1792393787764}`,
			ChildNote{ThreadID: probeRoot, StartedAtMs: 1792393787764, Item: AgentItem{Type: ItemSubAgentActivity, ID: "call_797a2af02f194e2faab4e3bcc0da07fa",
				Kind: ActivityInteracted, AgentThreadID: probeChild, AgentPath: "/root/sleeper"}}, []string{probeChild}},
		{"completed (0.162.1: no model fields)", `{"item":{"type":"subAgentActivity","id":"subagent-completed-01a15302-69d2-7b43-ab39-f860d3c46bdc","kind":"completed","agentThreadId":"01a15302-69b3-7e41-947b-908c50af4b28","agentPath":"/root/sleeper"},"threadId":"01a15302-4c6c-7493-899d-5814dcaf1339","turnId":"01a15302-60e5-72a2-8cd3-b65cbaef4076","completedAtMs":1792394080921}`,
			ChildNote{ThreadID: "01a15302-4c6c-7493-899d-5814dcaf1339", CompletedAtMs: 1792394080921, Item: AgentItem{Type: ItemSubAgentActivity,
				ID: "subagent-completed-01a15302-69d2-7b43-ab39-f860d3c46bdc", Kind: ActivityCompleted, AgentThreadID: "01a15302-69b3-7e41-947b-908c50af4b28",
				AgentPath: "/root/sleeper"}}, []string{"01a15302-69b3-7e41-947b-908c50af4b28"}},
		{"a timed-out wait names no child", `{"item":{"type":"collabAgentToolCall","id":"call_4b15b7afbf794f5684951581a995c7a1","tool":"wait","status":"completed","senderThreadId":"01a152fd-2d6a-7a52-923e-7831ee9a079d","receiverThreadIds":[],"prompt":null,"model":null,"reasoningEffort":null,"agentsStates":{}},"threadId":"01a152fd-2d6a-7a52-923e-7831ee9a079d","turnId":"01a152fd-4439-7261-8846-57252b2fc2e5","completedAtMs":1792393758118}`,
			ChildNote{ThreadID: probeRoot, CompletedAtMs: 1792393758118, Item: AgentItem{Type: ItemCollabToolCall, ID: "call_4b15b7afbf794f5684951581a995c7a1",
				Tool: ToolWait, Status: "completed", SenderThreadID: probeRoot, ReceiverThreadIDs: []string{}}}, nil},
		// The schema's v1 shape (0.160.1 ThreadItem), not seen live: a
		// spawn naming its receiver.
		{"v1 spawnAgent (schema)", `{"item":{"type":"collabAgentToolCall","id":"exec-1","tool":"spawnAgent","status":"completed","senderThreadId":"r","receiverThreadIds":["c"],"agentsStates":{"c":{"status":"running","message":null}}},"threadId":"r","turnId":"t","completedAtMs":5}`,
			ChildNote{ThreadID: "r", CompletedAtMs: 5, Item: AgentItem{Type: ItemCollabToolCall, ID: "exec-1", Tool: ToolSpawnAgent, Status: "completed",
				SenderThreadID: "r", ReceiverThreadIDs: []string{"c"}}}, []string{"c"}},
		{"a child's status (broadcast)", `{"threadId":"01a152fd-4fe5-7b00-957a-0084d67c7446","status":{"type":"active","activeFlags":["waitingOnApproval"]}}`,
			func() ChildNote {
				n := ChildNote{ThreadID: probeChild}
				n.Status.Type = ThreadActive
				return n
			}(), nil},
		{"a child's turn", `{"threadId":"01a15302-69b3-7e41-947b-908c50af4b28","turn":{"id":"01a15302-69d2-7b43-ab39-f860d3c46bdc","rootTurnId":"01a15302-60e5-72a2-8cd3-b65cbaef4076","items":[],"itemsView":"summary","status":"completed","error":null,"startedAt":1792394029,"completedAt":1792394080,"durationMs":51387}}`,
			func() ChildNote {
				n := ChildNote{ThreadID: "01a15302-69b3-7e41-947b-908c50af4b28"}
				n.Turn.ID, n.Turn.Status, n.Turn.StartedAt, n.Turn.CompletedAt = "01a15302-69d2-7b43-ab39-f860d3c46bdc", TurnCompleted, 1792394029, 1792394080
				return n
			}(), nil},
		{"an unknown kind is a value", `{"threadId":"r","item":{"type":"subAgentActivity","id":"x","kind":"renamed","agentThreadId":"c"}}`,
			ChildNote{ThreadID: "r", Item: AgentItem{Type: ItemSubAgentActivity, ID: "x", Kind: "renamed", AgentThreadID: "c"}}, []string{"c"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := DecodeChildNote(json.RawMessage(c.params))
			if !ok {
				t.Fatal("not decoded")
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got  %+v\nwant %+v", got, c.want)
			}
			if ch := got.Item.Children(); !slices.Equal(ch, c.children) {
				t.Errorf("children %v, want %v", ch, c.children)
			}
		})
	}
	for _, bad := range []string{``, `[]`, `{"item":{}}`, `{"threadId":5}`, `null`} {
		if _, ok := DecodeChildNote(json.RawMessage(bad)); ok {
			t.Errorf("%q decoded", bad)
		}
	}
}

// probeChildRead is thread/read of a child after a server restart
// (notLoaded): its sessionId is its own id, not the root's.
const probeChildRead = `{"id":"01a152fd-4fe5-7b00-957a-0084d67c7446","sessionId":"01a152fd-4fe5-7b00-957a-0084d67c7446","forkedFromId":null,"parentThreadId":"01a152fd-2d6a-7a52-923e-7831ee9a079d","preview":"","ephemeral":false,"historyMode":"paginated","modelProvider":"openai","model":"gpt-6-luna","reasoningEffort":"low","createdAt":1792393695,"updatedAt":1792393791,"status":{"type":"notLoaded"},"path":"/scrubbed/rollout.jsonl","cwd":"/scrubbed","cliVersion":"0.163.0","source":{"subAgent":{"thread_spawn":{"parent_thread_id":"01a152fd-2d6a-7a52-923e-7831ee9a079d","depth":1,"agent_path":"/root/sleeper","agent_nickname":"Anscombe","agent_role":null}}},"canAcceptDirectInput":null,"threadSource":"subagent","agentNickname":"Anscombe","agentRole":null,"turns":[]}`

func TestThreadChildMetadata(t *testing.T) {
	var th Thread
	if err := json.Unmarshal([]byte(probeChildRead), &th); err != nil {
		t.Fatal(err)
	}
	sp, ok := th.Spawn()
	if !ok || sp != (Spawn{Parent: probeRoot, Depth: 1, Path: "/root/sleeper", Nickname: "Anscombe"}) {
		t.Errorf("spawn %+v %v", sp, ok)
	}
	if th.ParentID() != probeRoot || th.SessionID != probeChild || th.ThreadSource != "subagent" || th.AgentNickname != "Anscombe" ||
		th.Status.Type != ThreadNotLoaded || th.CreatedAt != 1792393695 || th.Ephemeral {
		t.Errorf("thread %+v", th)
	}
	// A thread/list row has threadSource null; the parent then comes from
	// the spawn source when parentThreadId is absent.
	var row Thread
	_ = json.Unmarshal([]byte(`{"id":"c","threadSource":null,"source":{"subAgent":{"thread_spawn":{"parent_thread_id":"p","depth":2}}}}`), &row)
	if row.ParentID() != "p" || row.ThreadSource != "" {
		t.Errorf("row %+v", row)
	}
	for _, src := range []string{`"cli"`, `"appServer"`, `{"custom":"atlas"}`, `{"subAgent":"review"}`, `{"subAgent":"compact"}`,
		`{"subAgent":{"other":"guardian"}}`, `{"subAgent":{"thread_spawn":null}}`, `{"future":{"x":1}}`, `null`, `7`} {
		var x Thread
		if err := json.Unmarshal([]byte(`{"id":"x","source":`+src+`}`), &x); err != nil {
			t.Fatalf("%s: %v", src, err)
		}
		if _, ok := x.Spawn(); ok {
			t.Errorf("%s reads as a spawned child", src)
		}
	}
}

// childServer answers the observational reads from a table of threads, as
// a server does: thread/list's ancestorThreadId only with the
// experimental capability.
func childServer(t *testing.T, threads []map[string]any, loaded []string) *fakeServer {
	f := newFakeServer(t)
	f.respond = func(method string, p map[string]any) (any, any, bool) {
		switch method {
		case "thread/read":
			for _, th := range threads {
				if th["id"] == p["threadId"] {
					return map[string]any{"thread": th}, nil, false
				}
			}
			return nil, map[string]any{"code": -32600, "message": "thread not loaded: " + p["threadId"].(string)}, false
		case "thread/loaded/list":
			return map[string]any{"data": loaded, "nextCursor": nil}, nil, false
		case "thread/list":
			if _, ok := p["ancestorThreadId"]; ok {
				if !f.experimental() {
					return nil, map[string]any{"code": -32600, "message": "thread/list.ancestorThreadId requires experimentalApi capability"}, false
				}
				var data []map[string]any
				for _, th := range threads {
					if th["parentThreadId"] != nil {
						data = append(data, th)
					}
				}
				return map[string]any{"data": data, "nextCursor": nil}, nil, false
			}
			// sourceKinds only: the persisted subagent threads (not the
			// live one, as the probe saw).
			var data []map[string]any
			for _, th := range threads {
				if th["parentThreadId"] != nil && th["persisted"] == true {
					data = append(data, th)
				}
			}
			return map[string]any{"data": data, "nextCursor": nil}, nil, false
		case "thread/turns/list":
			return map[string]any{"data": []any{map[string]any{"id": "t9", "status": "interrupted", "items": []any{}}}}, nil, false
		}
		return nil, map[string]any{"code": -32601, "message": "unexpected " + method}, false
	}
	return f
}

// experimental reports whether the last initialize asked for it.
func (f *fakeServer) experimental() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.got) - 1; i >= 0; i-- {
		if f.got[i]["method"] == "initialize" {
			caps, _ := f.got[i]["params"].(map[string]any)["capabilities"].(map[string]any)
			return caps["experimentalApi"] == true
		}
	}
	return false
}

func spawned(id, parent string, persisted bool, status string) map[string]any {
	return map[string]any{"id": id, "parentThreadId": parent, "persisted": persisted, "status": map[string]any{"type": status},
		"source": map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": parent, "depth": 1}}}}
}

func joined(t *testing.T, f *fakeServer, stable bool) *Watcher {
	t.Helper()
	w, err := Watch(Options{Socket: f.sock, Thread: "th1", StableAPI: stable, OnEvent: func(Event) {}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	deadline := time.Now().Add(5 * time.Second)
	for w.State() != StateJoined {
		if time.Now().After(deadline) {
			t.Fatal("not joined")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return w
}

func ids(ts []Thread) []string {
	var out []string
	for _, t := range ts {
		out = append(out, t.ID)
	}
	slices.Sort(out)
	return out
}

func TestDescendants(t *testing.T) {
	threads := []map[string]any{
		{"id": "th1", "status": map[string]any{"type": "idle"}, "source": "appServer"},
		spawned("live", "th1", false, "active"),
		spawned("old", "th1", true, "notLoaded"),
		spawned("nested", "live", false, "active"),
		spawned("foreign", "other-root", true, "notLoaded"),
		{"id": "guardian", "status": map[string]any{"type": "idle"}, "source": map[string]any{"subAgent": map[string]any{"other": "guardian"}}},
	}
	loaded := []string{"th1", "live", "nested", "guardian"}
	ctx := context.Background()

	t.Run("filtered", func(t *testing.T) {
		f := childServer(t, threads, loaded)
		w := joined(t, f, false)
		d, err := w.Descendants(ctx, "th1")
		if err != nil {
			t.Fatal(err)
		}
		// The server's own filter (the fake lists every child it has).
		if !d.Filtered || !slices.Contains(ids(d.Threads), "old") {
			t.Errorf("%+v", d)
		}
	})
	t.Run("the experimental filter refused: loaded and listed, by parent chain", func(t *testing.T) {
		f := childServer(t, threads, loaded)
		w := joined(t, f, true)
		d, err := w.Descendants(ctx, "th1")
		if err != nil {
			t.Fatal(err)
		}
		if d.Filtered || !slices.Equal(ids(d.Threads), []string{"live", "nested", "old"}) {
			t.Errorf("filtered %v, threads %v", d.Filtered, ids(d.Threads))
		}
		for _, th := range d.Threads {
			if th.ID == "live" && th.Status.Type != ThreadActive {
				t.Errorf("live child's status %q", th.Status.Type)
			}
		}
	})
}

// TestChildReadsSendNoOverride: the reads name the thread and paging only:
// nothing that could change a thread's settings, no resume, no turn.
func TestChildReadsSendNoOverride(t *testing.T) {
	f := childServer(t, []map[string]any{spawned("c", "th1", true, "notLoaded")}, []string{"th1"})
	w := joined(t, f, true)
	ctx := context.Background()
	if _, err := w.ReadThread(ctx, "c"); err != nil {
		t.Fatal(err)
	}
	if tn, err := w.LastTurn(ctx, "c"); err != nil || tn == nil || tn.Status != TurnInterrupted {
		t.Fatalf("%+v %v", tn, err)
	}
	if _, err := w.Descendants(ctx, "th1"); err != nil {
		t.Fatal(err)
	}
	allowed := map[string][]string{
		"thread/read":        {"threadId"},
		"thread/turns/list":  {"itemsView", "limit", "sortDirection", "threadId"},
		"thread/list":        {"ancestorThreadId", "cursor", "limit", "sourceKinds"},
		"thread/loaded/list": {"cursor"},
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range f.got {
		method, _ := m["method"].(string)
		switch method {
		case "initialize", "initialized", "thread/unsubscribe":
			continue
		case "thread/resume":
			if p := m["params"].(map[string]any); len(p) != 1 || p["threadId"] != "th1" {
				t.Errorf("a resume other than the root's join: %v", p)
			}
			continue
		}
		keys, ok := allowed[method]
		if !ok {
			t.Errorf("unexpected request %s", method)
			continue
		}
		for k := range m["params"].(map[string]any) {
			if !slices.Contains(keys, k) {
				t.Errorf("%s sent %q", method, k)
			}
		}
		if method == "thread/turns/list" && m["params"].(map[string]any)["itemsView"] != "notLoaded" {
			t.Errorf("turns/list loads items: %v", m["params"])
		}
		if strings.HasPrefix(method, "turn/") {
			t.Errorf("a turn request: %s", method)
		}
	}
}
