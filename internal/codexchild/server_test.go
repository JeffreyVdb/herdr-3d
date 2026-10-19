package codexchild

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// fakeReader is a shared server's observational reads (codexapp's
// ChildReader) over a table of threads the test changes.
type fakeReader struct {
	mu       sync.Mutex
	threads  map[string]*codexapp.Thread
	last     map[string]*codexapp.Turn // LastTurn's answer (nil: none)
	refuse   map[string]bool           // LastTurn refused (ephemeral, legacy unloaded)
	filtered bool
	fail     error // every call fails (a closed connection)
	calls    []string
}

func newFakeReader() *fakeReader {
	return &fakeReader{threads: map[string]*codexapp.Thread{}, last: map[string]*codexapp.Turn{}, refuse: map[string]bool{}, filtered: true}
}

func (f *fakeReader) child(id, parent, status string, depth int) *codexapp.Thread {
	f.mu.Lock()
	defer f.mu.Unlock()
	src, _ := json.Marshal(map[string]any{"subAgent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": parent,
		"depth": depth, "agent_path": "/root/" + id, "agent_nickname": "Nick-" + id}}})
	t := &codexapp.Thread{ID: id, ParentThreadID: parent, Source: src, ThreadSource: "subagent", AgentNickname: "Nick-" + id, CreatedAt: 100}
	t.Status.Type = status
	f.threads[id] = t
	return t
}

func (f *fakeReader) setStatus(id, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.threads[id].Status.Type = status
}

func (f *fakeReader) log(c string) error {
	f.calls = append(f.calls, c)
	return f.fail
}

func (f *fakeReader) ReadThread(_ context.Context, id string) (*codexapp.Thread, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.log("read " + id); err != nil {
		return nil, err
	}
	t := f.threads[id]
	if t == nil {
		return nil, &codexapp.RPCError{Code: -32600, Message: "thread not loaded: " + id}
	}
	c := *t
	return &c, nil
}

func (f *fakeReader) LastTurn(_ context.Context, id string) (*codexapp.Turn, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.log("last " + id); err != nil {
		return nil, err
	}
	if f.refuse[id] {
		return nil, &codexapp.RPCError{Code: -32600, Message: "ephemeral threads do not support thread/turns/list"}
	}
	return f.last[id], nil
}

func (f *fakeReader) Descendants(_ context.Context, root string) (codexapp.Descendants, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.log("descendants " + root); err != nil {
		return codexapp.Descendants{}, err
	}
	var out codexapp.Descendants
	out.Filtered = f.filtered
	ids := make([]string, 0, len(f.threads))
	for id := range f.threads {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	for _, id := range ids {
		if t := f.threads[id]; t.ParentThreadID != "" && !t.Ephemeral {
			out.Threads = append(out.Threads, *t)
		}
	}
	return out, nil
}

func (f *fakeReader) count(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if len(c) >= len(prefix) && c[:len(prefix)] == prefix {
			n++
		}
	}
	return n
}

const root = "root-thread"

// srig is a shared worker's session: the source's server half fed by a
// fake join, its evidence applied to a registry.
type srig struct {
	t   *testing.T
	src *Source
	reg *childagents.Registry
	r   *fakeReader
	evs []childagents.Evidence
}

func newSrig(t *testing.T) *srig {
	s := &srig{t: t, src: New(Options{Settle: 20 * time.Millisecond, Retry: 30 * time.Millisecond}), reg: childagents.New(), r: newFakeReader()}
	s.reg.Worker("w", root)
	return s
}

// settle waits until the observer is quiet, then applies the evidence.
func (s *srig) settle() {
	s.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !s.src.quiet(root) {
		if time.Now().After(deadline) {
			s.t.Fatal("the observer never went quiet")
		}
		time.Sleep(2 * time.Millisecond)
	}
	for _, e := range s.src.take() {
		s.evs = append(s.evs, e)
		if _, err := s.reg.Apply(e); err != nil {
			s.t.Fatalf("evidence %+v dropped: %v", e, err)
		}
	}
}

func (s *srig) join() {
	s.src.Joined(root, s.r)
	s.settle()
}

func (s *srig) note(method string, params any) {
	s.push(method, params)
	s.settle()
}

// push queues a notification without waiting: the next ones arrive within
// the settle, as a burst from the server does.
func (s *srig) push(method string, params any) {
	b, _ := json.Marshal(params)
	s.src.Notify(root, method, b)
}

func (s *srig) activity(parent, kind, child, id string, at int64) {
	s.note("item/completed", map[string]any{"threadId": parent, "turnId": "t", "completedAtMs": at,
		"item": map[string]any{"type": "subAgentActivity", "id": id, "kind": kind, "agentThreadId": child, "agentPath": "/root/" + child}})
}

func (s *srig) status(thread, st string) {
	s.note("thread/status/changed", map[string]any{"threadId": thread, "status": map[string]any{"type": st}})
}

func (s *srig) turn(method, thread, status string, at int64) {
	s.note(method, map[string]any{"threadId": thread, "turn": map[string]any{"id": "turn-" + thread, "status": status, "startedAt": at, "completedAt": at}})
}

func (s *srig) row(native string) proto.Child {
	s.t.Helper()
	for _, c := range s.reg.Children("w") {
		if c.NativeID == native {
			return c
		}
	}
	s.t.Fatalf("no row of %s: %+v", native, s.reg.Children("w"))
	return proto.Child{}
}

func (s *srig) state(native, want, source string) {
	s.t.Helper()
	c := s.row(native)
	if c.State != want || (source != "" && c.Source != source) {
		s.t.Fatalf("%s: state %s (%s), want %s (%s)", native, c.State, c.Source, want, source)
	}
}

func (s *srig) stateSeq(native string) []string {
	var out []string
	for _, e := range s.evs {
		if e.NativeID == native && e.State != "" && (len(out) == 0 || out[len(out)-1] != e.State) {
			out = append(out, e.State)
		}
	}
	return out
}

// Spawn, wait, follow-up, interrupt: each resolves to its own child by its
// thread id; the parent's turn and a wait's status are never the child's.
func TestServerLifecycle(t *testing.T) {
	s := newSrig(t)
	s.join()
	// The probe's order: the fresh child's idle (pending init) first, then
	// the parent's started, the child active.
	s.r.child("c1", root, codexapp.ThreadIdle, 1)
	s.status("c1", codexapp.ThreadIdle)
	if cs := s.reg.Children("w"); len(cs) != 0 {
		t.Fatalf("a fresh child shown from its pending init: %+v", cs[0])
	}
	s.activity(root, "started", "c1", "call_spawn1", 5000)
	c := s.row("c1")
	if c.State != proto.ChildRunning || c.Source != proto.ChildFromAppServer || c.Parent != proto.ParentRoot || c.Name != "Nick-c1" ||
		c.Description != "c1" || c.Transcript != proto.TranscriptPending {
		t.Fatalf("spawned: %+v", c)
	}
	if s.evs[len(s.evs)-1].DispatchID != "call_spawn1" {
		t.Errorf("dispatch %q", s.evs[len(s.evs)-1].DispatchID)
	}
	s.status("c1", codexapp.ThreadActive)
	// A timed-out wait completes; the parent's turn completes: the child
	// still runs.
	s.note("item/completed", map[string]any{"threadId": root, "turnId": "t", "item": map[string]any{"type": "collabAgentToolCall",
		"id": "w1", "tool": "wait", "status": "completed", "senderThreadId": root, "receiverThreadIds": []string{}}})
	s.turn("turn/completed", root, "completed", 6)
	s.state("c1", proto.ChildRunning, proto.ChildFromAppServer)
	// Its idle, then its own turn's end, then the parent's completed (one
	// burst: the probe's order).
	s.push("thread/status/changed", map[string]any{"threadId": "c1", "status": map[string]any{"type": "idle"}})
	s.push("turn/completed", map[string]any{"threadId": "c1", "turn": map[string]any{"id": "t1", "status": "completed", "completedAt": 7}})
	s.activity(root, "completed", "c1", "subagent-completed-x", 7100)
	s.state("c1", proto.ChildCompleted, proto.ChildFromAppServer)
	if s.r.count("last ") != 0 {
		t.Errorf("the end came with the events: no turn read wanted, got %v", s.r.calls)
	}
	// A follow-up: interacted says nothing; the child's next turn runs it
	// again (the same row, its end cleared).
	s.activity(root, "interacted", "c1", "call_f1", 8000)
	s.state("c1", proto.ChildCompleted, "")
	s.status("c1", codexapp.ThreadActive)
	if c := s.row("c1"); c.State != proto.ChildRunning || c.EndedAt != 0 {
		t.Fatalf("follow-up: %+v", c)
	}
	// interrupt_agent: the parent's interrupted.
	s.activity(root, "interrupted", "c1", "call_i1", 9000)
	if c := s.row("c1"); c.State != proto.ChildInterrupted || c.EndedAt != 9000 {
		t.Fatalf("interrupted: %+v", c)
	}
	if got := s.stateSeq("c1"); !slices.Equal(got, []string{proto.ChildRunning, proto.ChildCompleted, proto.ChildRunning, proto.ChildInterrupted}) {
		t.Errorf("states %v", got)
	}
	if s.evs[0].State != proto.ChildRunning {
		t.Errorf("first shown as %q", s.evs[0].State)
	}
	if n := len(s.reg.Children("w")); n != 1 {
		t.Errorf("%d rows", n)
	}
}

// An idle with no end on the parent's stream: the observer reads the last
// turn after Settle (a failed turn, a user's interrupt), else idle.
func TestServerIdleReadsTheLastTurn(t *testing.T) {
	for _, c := range []struct {
		turn *codexapp.Turn
		want string
	}{
		{&codexapp.Turn{ID: "x", Status: codexapp.TurnFailed}, proto.ChildInterrupted},
		{&codexapp.Turn{ID: "x", Status: codexapp.TurnCompleted}, proto.ChildCompleted},
		{&codexapp.Turn{ID: "x", Status: codexapp.TurnInProgress}, proto.ChildIdle},
		{nil, proto.ChildIdle},
	} {
		s := newSrig(t)
		s.join()
		s.r.child("c1", root, codexapp.ThreadActive, 1)
		s.activity(root, "started", "c1", "call_1", 1)
		s.r.last["c1"] = c.turn
		s.status("c1", codexapp.ThreadIdle)
		s.state("c1", c.want, proto.ChildFromAppServer)
		if s.r.count("last c1") != 1 {
			t.Errorf("turn reads %v", s.r.calls)
		}
	}
}

func TestServerConcurrentAndNested(t *testing.T) {
	s := newSrig(t)
	s.join()
	s.r.child("a", root, codexapp.ThreadActive, 1)
	s.r.child("b", root, codexapp.ThreadActive, 1)
	s.activity(root, "started", "a", "call_a", 1)
	s.activity(root, "started", "b", "call_b", 2)
	// b's own child: its spawn is on b's stream, which this connection may
	// not get; its status (a broadcast) names it first.
	s.r.child("bb", "b", codexapp.ThreadActive, 2)
	s.status("bb", codexapp.ThreadActive)
	s.activity(root, "completed", "a", "subagent-completed-a", 10)
	s.state("a", proto.ChildCompleted, "")
	s.state("b", proto.ChildRunning, "")
	s.state("bb", proto.ChildRunning, "")
	if c := s.row("bb"); c.Parent != proto.ParentChild || c.ParentID != s.row("b").ID {
		t.Fatalf("nested: %+v", c)
	}
	// Its spawn seen on b's stream later: the same row, gaining the dispatch.
	s.activity("b", "started", "bb", "call_bb", 3)
	if n := len(s.reg.Children("w")); n != 3 {
		t.Fatalf("%d rows", n)
	}
	// A thread that is no child (a guardian, a side thread): read once,
	// never a row.
	g := &codexapp.Thread{ID: "guardian", Source: json.RawMessage(`{"subAgent":{"other":"guardian"}}`)}
	g.Status.Type = codexapp.ThreadIdle
	s.r.mu.Lock()
	s.r.threads["guardian"] = g
	s.r.mu.Unlock()
	s.status("guardian", codexapp.ThreadActive)
	s.status("guardian", codexapp.ThreadIdle)
	if n := len(s.reg.Children("w")); n != 3 || s.r.count("read guardian") != 1 {
		t.Fatalf("%d rows, reads %v", n, s.r.calls)
	}
	// Another session's child (a parent chain that ends elsewhere).
	s.r.child("foreign", "other-root", codexapp.ThreadActive, 1)
	s.status("foreign", codexapp.ThreadActive)
	if n := len(s.reg.Children("w")); n != 3 {
		t.Fatalf("%d rows", n)
	}
}

// A lost join invalidates every live claim (unknown), keeps the ends, and
// the next join's recovery re-establishes them, children spawned before
// that connection included.
func TestServerLossAndRecovery(t *testing.T) {
	s := newSrig(t)
	s.join()
	s.r.child("run", root, codexapp.ThreadActive, 1)
	s.r.child("done", root, codexapp.ThreadActive, 1)
	s.activity(root, "started", "run", "call_r", 1)
	s.activity(root, "started", "done", "call_d", 2)
	s.activity(root, "completed", "done", "subagent-completed-d", 3)
	s.src.Lost(root)
	s.settle()
	s.state("run", proto.ChildUnknown, proto.ChildFromAppServer)
	s.state("done", proto.ChildCompleted, "")
	// Notifications after the loss are no one's.
	s.src.Notify(root, "thread/status/changed", json.RawMessage(`{"threadId":"run","status":{"type":"active"}}`))
	s.settle()
	s.state("run", proto.ChildUnknown, "")
	// Reconnected: still running; a third spawned meanwhile.
	s.r.setStatus("done", codexapp.ThreadIdle)
	s.r.child("new", root, codexapp.ThreadActive, 1)
	s.join()
	s.state("run", proto.ChildRunning, proto.ChildFromAppServer)
	s.state("done", proto.ChildCompleted, "")
	s.state("new", proto.ChildRunning, "")
	if got := s.stateSeq("run"); !slices.Equal(got, []string{proto.ChildRunning, proto.ChildUnknown, proto.ChildRunning}) {
		t.Errorf("run: %v", got)
	}
	// A dead server restarted: every child is notLoaded; the running one
	// (killed, its rollout never ended) is unknown, never running.
	s.src.Lost(root)
	for _, id := range []string{"run", "done", "new"} {
		s.r.setStatus(id, codexapp.ThreadNotLoaded)
	}
	s.join()
	s.state("run", proto.ChildUnknown, proto.ChildFromAppServer)
	s.state("done", proto.ChildCompleted, "")
	if s.r.count("last ") != 0 {
		t.Errorf("recovery read turns: %v", s.r.calls)
	}
}

// A failed recovery leaves the join's claims untrusted (nothing is
// guessed) and is tried again after Retry.
func TestServerRecoveryFails(t *testing.T) {
	s := newSrig(t)
	s.join()
	s.r.child("c", root, codexapp.ThreadActive, 1)
	s.activity(root, "started", "c", "call_c", 1)
	s.src.Lost(root)
	s.r.mu.Lock()
	s.r.fail = errors.New("closed")
	s.r.mu.Unlock()
	s.src.Joined(root, s.r)
	time.Sleep(100 * time.Millisecond)
	for _, e := range s.src.take() {
		_, _ = s.reg.Apply(e)
	}
	s.state("c", proto.ChildUnknown, proto.ChildFromAppServer)
	s.r.mu.Lock()
	s.r.fail = nil
	s.r.mu.Unlock()
	s.settle()
	s.state("c", proto.ChildRunning, proto.ChildFromAppServer)
}

// Until a join's recovery is done, the connection before it's claims are
// gone and its own not read: a running child is unknown, not running.
func TestServerRejoinTrustsOnlyItsRecovery(t *testing.T) {
	s := newSrig(t)
	s.join()
	s.r.child("c", root, codexapp.ThreadActive, 1)
	s.activity(root, "started", "c", "call_c", 1)
	s.src.Lost(root)
	s.r.setStatus("c", codexapp.ThreadNotLoaded) // a restarted server
	s.join()
	if got := s.stateSeq("c"); !slices.Equal(got, []string{proto.ChildRunning, proto.ChildUnknown}) {
		t.Fatalf("states %v", got)
	}
}

// Ephemeral children are live only: no rollout (transcript unavailable,
// whatever the parent's rollout says), no listing, no turn reads; their row
// stays with the state the events gave.
func TestServerEphemeralChild(t *testing.T) {
	s := newSrig(t)
	s.join()
	th := s.r.child("eph", root, codexapp.ThreadActive, 1)
	th.Ephemeral = true
	s.r.refuse["eph"] = true
	s.activity(root, "started", "eph", "call_e", 1)
	if c := s.row("eph"); c.Transcript != proto.TranscriptUnavailable || c.State != proto.ChildRunning {
		t.Fatalf("%+v", c)
	}
	s.status("eph", codexapp.ThreadIdle) // no end event: the turn read is refused
	s.state("eph", proto.ChildIdle, proto.ChildFromAppServer)
	s.status("eph", codexapp.ThreadActive)
	s.activity(root, "completed", "eph", "subagent-completed-e", 9)
	s.state("eph", proto.ChildCompleted, "")
	// Unloaded (its last subscriber gone): the end stays.
	s.note("thread/closed", map[string]any{"threadId": "eph"})
	s.state("eph", proto.ChildCompleted, "")
	// A reconnect cannot list it and reads it as not loaded.
	s.src.Lost(root)
	s.r.mu.Lock()
	delete(s.r.threads, "eph")
	s.r.mu.Unlock()
	s.join()
	if c := s.row("eph"); c.State != proto.ChildCompleted || c.Transcript != proto.TranscriptUnavailable {
		t.Fatalf("%+v", c)
	}
}

// v1's collaboration calls: a completed spawn names its receiver, a
// completed close shuts it down; no other tool or status is a state.
func TestServerV1CollabCalls(t *testing.T) {
	s := newSrig(t)
	s.join()
	s.r.child("v1", root, codexapp.ThreadActive, 1)
	call := func(tool, status string, receivers ...string) {
		s.note("item/completed", map[string]any{"threadId": root, "item": map[string]any{"type": "collabAgentToolCall", "id": "exec-" + tool,
			"tool": tool, "status": status, "senderThreadId": root, "receiverThreadIds": receivers}})
	}
	call("spawnAgent", "inProgress", "v1")
	if n := len(s.reg.Children("w")); n != 0 {
		t.Fatalf("a spawn in progress shows its child: %d rows", n)
	}
	call("spawnAgent", "completed", "v1")
	s.state("v1", proto.ChildRunning, "")
	call("sendInput", "failed", "v1")
	call("wait", "completed", "v1")
	s.state("v1", proto.ChildRunning, "")
	call("closeAgent", "completed", "v1")
	s.state("v1", proto.ChildShutDown, "")
	if s.evs[0].DispatchID != "" && s.evs[len(s.evs)-1].DispatchID != "exec-spawnAgent" {
		t.Errorf("dispatch %q", s.evs[len(s.evs)-1].DispatchID)
	}
}

// Many notifications past the queue: the observer recovers again instead.
func TestServerOverflowRecovers(t *testing.T) {
	s := newSrig(t)
	s.join()
	s.r.child("c", root, codexapp.ThreadActive, 1)
	s.src.mu.Lock()
	o := s.src.books[root].srv.obs
	s.src.mu.Unlock()
	o.mu.Lock() // hold it, so the queue fills
	for i := range maxNotes + 1 {
		o.queue = append(o.queue, note{method: "thread/status/changed", params: json.RawMessage(fmt.Sprintf(`{"threadId":"x%d","status":{"type":"idle"}}`, i))})
	}
	o.mu.Unlock()
	s.src.Notify(root, "thread/status/changed", json.RawMessage(`{"threadId":"c","status":{"type":"active"}}`))
	s.settle()
	s.state("c", proto.ChildRunning, "")
	if s.r.count("descendants") != 2 {
		t.Errorf("recoveries %v", s.r.calls)
	}
}
