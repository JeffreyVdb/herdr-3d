package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/codexchild"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #25: a Codex worker's subagents, end to end: the usage tracker reads its
// root rollout and finds and reads its child rollouts, the Codex source
// turns them into evidence, the hub publishes the children. The fixture is
// a real nested run (internal/codexchild/testdata/c2): the depth-2 child
// attaches to the depth-1 one, both completed.
func TestCodexSubagentsEndToEnd(t *testing.T) {
	t.Parallel()
	const session = "01a14e2b-d7d0-7c01-8a79-2cb6ba62938e"
	const outer, inner = "01a14e2b-e4bc-7472-8aac-009f651c0987", "01a14e2b-ef35-7e53-adfb-e8adb97f831f"
	dir := t.TempDir()
	files, _ := filepath.Glob(filepath.Join("..", "codexchild", "testdata", "c2", "rollout-*.jsonl"))
	for _, p := range files {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		writeTranscript(t, filepath.Join(dir, "2026", "10", "18", filepath.Base(p)), string(b))
	}
	src := codexchild.New(codexchild.Options{})
	w1 := agentW("w1", "codex", "working")
	w1.AgentSession, w1.Harness = session, world.HarnessCodex
	tb := startTermBridge(t, func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{CodexSessions: dir}, Interval: 20 * time.Millisecond,
			CodexChildren: func(s string) server.ChildReader { return src.Listener(s) }}
		o.ChildSources = []childagents.Source{src}
	}, w1)
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := idOf(t, snap, "w1")
	rows := map[string]proto.Child{}
	for _, ch := range snap.World.Children {
		rows[ch.NativeID] = ch
	}
	for rows[outer].State != proto.ChildCompleted || rows[inner].State != proto.ChildCompleted {
		ev := c.until(proto.EvChildUpsert)
		rows[ev.Child.NativeID] = *ev.Child
	}
	o, i := rows[outer], rows[inner]
	if len(rows) != 2 || o.WorkerID != id || o.Parent != proto.ParentRoot || o.Name != "Volta" || o.Provider != proto.ChildCodex ||
		i.Parent != proto.ParentChild || i.ParentID != o.ID || i.Name != "Pasteur" || !strings.HasPrefix(i.ID, "ch_") ||
		i.Transcript != proto.TranscriptAvailable || i.Source != proto.ChildFromRollout {
		t.Fatalf("rows = %+v", rows)
	}
}

// childTable is a shared server's child threads for a fake join's reads.
type childTable struct {
	mu      sync.Mutex
	threads map[string]codexapp.Thread
}

func (c *childTable) set(id, parent, status string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	src, _ := json.Marshal(map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": parent, "depth": 1,
		"agent_path": "/root/worker", "agent_nickname": "Nick-" + id}}})
	th := codexapp.Thread{ID: id, ParentThreadID: parent, Source: src, AgentNickname: "Nick-" + id}
	th.Status.Type = status
	c.threads[id] = th
}

func (c *childTable) ReadThread(_ context.Context, id string) (*codexapp.Thread, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	th, ok := c.threads[id]
	if !ok {
		return nil, &codexapp.RPCError{Code: -32600, Message: "thread not loaded: " + id}
	}
	return &th, nil
}

func (c *childTable) LastTurn(context.Context, string) (*codexapp.Turn, error) { return nil, nil }

func (c *childTable) Descendants(context.Context, string) (codexapp.Descendants, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := codexapp.Descendants{Filtered: true}
	for _, th := range c.threads {
		d.Threads = append(d.Threads, th)
	}
	return d, nil
}

// #27: a shared worker's children through the bridge's join of its thread,
// end to end through the hub: its child thread's notifications reach the
// observer (the root's handling unchanged), its rows are the worker's with
// the server's state, a lost join makes a running one unknown and the next
// join's recovery makes it running again.
func TestCodexServerChildrenEndToEnd(t *testing.T) {
	t.Parallel()
	const child = "01a152fd-4fe5-7b00-957a-0084d67c7446"
	src := codexchild.New(codexchild.Options{Settle: 20 * time.Millisecond})
	host := newFakeCodexHost()
	table := &childTable{threads: map[string]codexapp.Thread{}}
	host.reader = table
	sb := startSharedBridgeWith(t, "", host, true, "", func(o *server.Options) {
		o.ChildSources = []childagents.Source{src}
		o.CodexChildren = src
	})
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = asyncThread })
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return c.Attached })
	c := sb.connect(proto.Hello{})
	c.snapshot()
	until := func(state string) proto.Child {
		t.Helper()
		for {
			ev := c.until(proto.EvChildUpsert)
			if ev.Child.NativeID == child && ev.Child.State == state {
				return *ev.Child
			}
		}
	}
	table.set(child, asyncThread, codexapp.ThreadActive)
	childNote := func(method string, params map[string]any) codexapp.Event {
		b, _ := json.Marshal(params)
		return codexapp.Event{Kind: codexapp.EvNotification, Method: method, Params: b}
	}
	sb.emit(itemDone("t1", codexapp.Item{Type: "agentMessage", ID: "m0"}),
		note("item/completed", map[string]any{"turnId": "t1", "completedAtMs": 5000, "item": map[string]any{"type": "subAgentActivity",
			"id": "call_spawn", "kind": "started", "agentThreadId": child, "agentPath": "/root/worker"}}),
		childNote("turn/started", map[string]any{"threadId": child, "turn": map[string]any{"id": "ct1", "status": "inProgress"}}))
	row := until(proto.ChildRunning)
	for row.Name == "" { // its metadata comes from a read after the spawn
		row = until(proto.ChildRunning)
	}
	if row.WorkerID != a.ID || row.Parent != proto.ParentRoot || row.Source != proto.ChildFromAppServer || row.Name != "Nick-"+child || row.Description != "worker" || row.Provider != proto.ChildCodex {
		t.Fatalf("row %+v", row)
	}
	sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected})
	lost := until(proto.ChildUnknown)
	if lost.ID != row.ID || lost.Source != proto.ChildFromAppServer {
		t.Fatalf("lost %+v", lost)
	}
	sb.emit(joined(&codexapp.Thread{}))
	if back := until(proto.ChildRunning); back.ID != row.ID {
		t.Fatalf("recovered %+v", back)
	}
	sb.emit(childNote("thread/status/changed", map[string]any{"threadId": child, "status": map[string]any{"type": "idle"}}),
		childNote("turn/completed", map[string]any{"threadId": child, "turn": map[string]any{"id": "ct1", "status": "interrupted", "completedAt": 6}}))
	if end := until(proto.ChildInterrupted); end.EndedAt != 6000 {
		t.Fatalf("end %+v", end)
	}
}
