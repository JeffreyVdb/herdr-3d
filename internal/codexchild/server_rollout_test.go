package codexchild

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// quiet waits until the session's observer is.
func (r *rig) quiet() {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !r.src.quiet(r.session) {
		if time.Now().After(deadline) {
			r.t.Fatal("the observer never went quiet")
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// The server that owns the conversation decides a child's state once a join
// was seen; its rollout still names it. The restart race: the tracker's
// first read of a killed child's rollout (no end record: running) is queued
// before the join's recovery (the restarted server: not loaded). One queue,
// so the server's word comes last, every time: unknown, never running.
func TestServerOverRolloutAfterRestart(t *testing.T) {
	for range 20 {
		r := newRig(t, "a")
		r.src.opts.Settle = 10 * time.Millisecond
		r.write(r.session, 14) // the spawn, not the child's completion
		r.write(aChild, 20)    // its turn under way
		r.now = r.now.Add(2 * time.Second)
		r.sess.Poll(r.now) // queued, not applied yet
		fr := newFakeReader()
		fr.child(aChild, r.session, codexapp.ThreadNotLoaded, 1)
		r.src.Joined(r.session, fr)
		r.quiet()
		r.apply()
		c := r.one(aChild)
		if c.State != proto.ChildUnknown || c.Source != proto.ChildFromAppServer {
			t.Fatalf("after the race: %+v", c)
		}
		if c.Transcript != proto.TranscriptAvailable || c.Name != "Rawls" || c.Parent != proto.ParentRoot {
			t.Fatalf("the rollout's fields: %+v", c)
		}
		// Its rollout's end, read later, is a fact the server does not
		// contradict (not loaded: not running).
		r.write(aChild, -1)
		r.write(r.session, -1)
		r.poll()
		if c := r.one(aChild); c.State != proto.ChildCompleted || c.Source != proto.ChildFromRollout {
			t.Fatalf("with its end: %+v", c)
		}
		r.noRemovals()
	}
}

// While joined, the server's live word beats the rollouts' (a follow-up
// running after a completed turn on disk), and its end is the state before
// the rollout has it; the rollouts never flip it back.
func TestServerLiveOverRollout(t *testing.T) {
	r := newRig(t, "a")
	r.src.opts.Settle = 10 * time.Millisecond
	r.all()
	r.poll()
	if c := r.one(aChild); c.State != proto.ChildCompleted || c.Source != proto.ChildFromRollout {
		t.Fatalf("from the files: %+v", c)
	}
	fr := newFakeReader()
	fr.child(aChild, r.session, codexapp.ThreadIdle, 1)
	r.src.Joined(r.session, fr)
	r.quiet()
	r.apply()
	// Loaded and idle, no end seen by the server: the rollouts' end.
	if c := r.one(aChild); c.State != proto.ChildCompleted || c.Source != proto.ChildFromRollout {
		t.Fatalf("joined, idle: %+v", c)
	}
	notify := func(method, params string) {
		r.src.Notify(r.session, method, json.RawMessage(params))
		r.quiet()
		r.apply()
	}
	notify("thread/status/changed", `{"threadId":"`+aChild+`","status":{"type":"active"}}`)
	if c := r.one(aChild); c.State != proto.ChildRunning || c.EndedAt != 0 || c.Source != proto.ChildFromAppServer {
		t.Fatalf("a follow-up: %+v", c)
	}
	r.poll() // the rollouts say completed still: no flip
	if c := r.one(aChild); c.State != proto.ChildRunning {
		t.Fatalf("flipped by the rollouts: %+v", c)
	}
	notify("item/completed", `{"threadId":"`+r.session+`","completedAtMs":99,"item":{"type":"subAgentActivity","id":"subagent-completed-z","kind":"completed","agentThreadId":"`+aChild+`","agentPath":"/root/count_lines"}}`)
	if c := r.one(aChild); c.State != proto.ChildCompleted || c.Source != proto.ChildFromAppServer || c.EndedAt != 99 {
		t.Fatalf("ended: %+v", c)
	}
	// The join lost: the end stays.
	r.src.Lost(r.session)
	r.apply()
	if c := r.one(aChild); c.State != proto.ChildCompleted {
		t.Fatalf("lost: %+v", c)
	}
	r.noRemovals()
}

// A session no join was seen of keeps #25's rollout rule exactly.
func TestNoJoinKeepsTheRolloutRule(t *testing.T) {
	r := newRig(t, "a")
	r.write(r.session, 14)
	r.write(aChild, 20)
	r.poll()
	if c := r.one(aChild); c.State != proto.ChildRunning || c.Source != proto.ChildFromRollout {
		t.Fatalf("%+v", c)
	}
	r.src.Lost(r.session) // a loss without a join changes nothing
	r.apply()
	if c := r.one(aChild); c.State != proto.ChildRunning {
		t.Fatalf("%+v", c)
	}
}

// A bridge's join while a child runs: the rollouts' running, then the
// server's, never an unknown between them (nothing is sent while the join
// recovers).
func TestJoinDoesNotFlickerARunningChild(t *testing.T) {
	r := newRig(t, "a")
	r.src.opts.Settle = 10 * time.Millisecond
	r.write(r.session, 14)
	r.write(aChild, 20)
	r.poll()
	fr := newFakeReader()
	fr.child(aChild, r.session, codexapp.ThreadActive, 1)
	r.src.Joined(r.session, fr)
	r.quiet()
	r.poll()
	r.apply()
	var states []string
	for _, e := range r.evs {
		if e.NativeID == aChild && e.State != "" && (len(states) == 0 || states[len(states)-1] != e.State) {
			states = append(states, e.State)
		}
	}
	if len(states) != 1 || states[0] != proto.ChildRunning {
		t.Fatalf("states %v", states)
	}
	if c := r.one(aChild); c.Source != proto.ChildFromAppServer {
		t.Fatalf("%+v", c)
	}
}
