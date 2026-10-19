package codexchild

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// A reconnect's word on a child: {the end the bridge showed before the
// loss} × {what happened while no join saw it}. An end with nothing newer
// stays as it was (state and time); the end of a newer turn replaces it
// (completed ↔ interrupted, at its turn's time); a running follow-up is
// running. Only a child with an end shown before the loss has its last
// turn read, once, and only when not running. One observer goroutine
// reads in order, so no cell depends on goroutine order.
func TestServerReconnectMatrix(t *testing.T) {
	type want struct {
		state string
		at    int64
		reads int // LastTurn reads of the child at the rejoin
	}
	cached := []struct {
		name string
		end  func(s *srig)  // with the child running, its end before the loss (none: still running)
		last *codexapp.Turn // the server's last turn of it then
	}{
		{"none", func(*srig) {}, &codexapp.Turn{ID: "t1", Status: codexapp.TurnInProgress}},
		// The parent's completed names the child's turn.
		{"completed", func(s *srig) { s.activity(root, "completed", "c", "subagent-completed-t1", 2100) },
			&codexapp.Turn{ID: "t1", Status: codexapp.TurnCompleted, CompletedAt: 2}},
		// The child's own turn/completed names it (its seconds).
		{"interrupted", func(s *srig) { s.turn("turn/completed", "c", codexapp.TurnInterrupted, 2) },
			&codexapp.Turn{ID: "turn-c", Status: codexapp.TurnInterrupted, CompletedAt: 2}},
		// The parent's interrupt only: the turn not named.
		{"interrupted unnamed", func(s *srig) { s.activity(root, "interrupted", "c", "call_i", 2100) },
			&codexapp.Turn{ID: "t1", Status: codexapp.TurnInterrupted, CompletedAt: 2}},
	}
	follow := func(st string) func(s *srig) {
		return func(s *srig) {
			s.r.threads["c"].Status.Type = codexapp.ThreadIdle
			s.r.last["c"] = &codexapp.Turn{ID: "t2", Status: st, CompletedAt: 5}
		}
	}
	lost := []struct {
		name string
		do   func(s *srig) // under s.r.mu
	}{
		{"nothing", func(*srig) {}},
		{"follow-up completed", follow(codexapp.TurnCompleted)},
		{"follow-up interrupted", follow(codexapp.TurnInterrupted)},
		{"follow-up running", func(s *srig) {
			s.r.threads["c"].Status.Type = codexapp.ThreadActive
			s.r.last["c"] = &codexapp.Turn{ID: "t2", Status: codexapp.TurnInProgress}
		}},
		// Restarted: nothing loaded; the store keeps the last turn.
		{"server restarted", func(s *srig) { s.r.threads["c"].Status.Type = codexapp.ThreadNotLoaded }},
		// Ephemeral and unloaded (never listed, its read and turns refused):
		// whatever ran meanwhile is not known.
		{"unreadable", func(s *srig) {
			delete(s.r.threads, "c")
			s.r.refuse["c"] = true
			s.r.last["c"] = &codexapp.Turn{ID: "t2", Status: codexapp.TurnInterrupted, CompletedAt: 5}
		}},
	}
	running, completed, interrupted, idle, unknown := proto.ChildRunning, proto.ChildCompleted, proto.ChildInterrupted, proto.ChildIdle, proto.ChildUnknown
	wants := map[string][]want{ // by cached end, in lost's order
		// No end shown: no read; the turn it ran ended meanwhile is idle
		// (the rollouts' end when they have one), a killed or unreadable
		// one unknown (#27's rule before R1, unchanged).
		"none": {{running, 0, 0}, {idle, 0, 0}, {idle, 0, 0}, {running, 0, 0}, {unknown, 0, 0}, {unknown, 0, 0}},
		"completed": {{completed, 2100, 1}, {completed, 5000, 1}, {interrupted, 5000, 1}, {running, 0, 0},
			{completed, 2100, 1}, {completed, 2100, 1}},
		"interrupted": {{interrupted, 2000, 1}, {completed, 5000, 1}, {interrupted, 5000, 1}, {running, 0, 0},
			{interrupted, 2000, 1}, {interrupted, 2000, 1}},
		// Not named: its last turn is taken for it when it ended the same
		// way no later than a second after it.
		"interrupted unnamed": {{interrupted, 2100, 1}, {completed, 5000, 1}, {interrupted, 5000, 1}, {running, 0, 0},
			{interrupted, 2100, 1}, {interrupted, 2100, 1}},
	}
	for _, c := range cached {
		for i, l := range lost {
			w := wants[c.name][i]
			t.Run(fmt.Sprintf("%s/%s", c.name, l.name), func(t *testing.T) {
				s := newSrig(t)
				s.join()
				s.r.child("c", root, codexapp.ThreadActive, 1)
				s.activity(root, "started", "c", "call_c", 1000)
				c.end(s)
				s.r.mu.Lock()
				if c.name != "none" {
					s.r.threads["c"].Status.Type = codexapp.ThreadIdle
				}
				s.r.last["c"] = c.last
				s.r.mu.Unlock()
				before := s.row("c")
				s.src.Lost(root)
				s.settle()
				s.r.mu.Lock()
				l.do(s)
				s.r.mu.Unlock()
				reads := s.r.count("last c")
				sent := len(s.evs)
				s.join()
				got := s.row("c")
				if got.State != w.state || got.EndedAt != w.at || got.Source != proto.ChildFromAppServer {
					t.Fatalf("got %s at %d (%s), want %s at %d; before the loss %s at %d", got.State, got.EndedAt, got.Source,
						w.state, w.at, before.State, before.EndedAt)
				}
				if n := s.r.count("last c") - reads; n != w.reads {
					t.Errorf("%d turn reads at the rejoin, want %d: %v", n, w.reads, s.r.calls)
				}
				// Nothing half-verified is sent while the join recovers: only
				// the final state, if any.
				for _, e := range s.evs[sent:] {
					if e.NativeID == "c" && e.State != "" && e.State != w.state {
						t.Errorf("sent %s during the rejoin, want only %s", e.State, w.state)
					}
				}
			})
		}
	}
}

// The same with the rollouts: the end the server showed before the loss
// (completed, at 99), then a follow-up written to the child's rollout and
// run on the server while no join saw it. A rejoin reads its last turn; a
// bridge's restart has no end of its own and takes the rollouts' (#25's
// rule, no read).
func TestServerReconnectOverRollout(t *testing.T) {
	const started, ended = "2026-10-18T08:38:00.000Z", "2026-10-18T08:38:05.500Z"
	record := func(typ string) string { // after the fixture's last (ordinal 29)
		ts, ord := started, "30"
		if typ != "task_started" {
			ts, ord = ended, "31"
		}
		return `{"timestamp":"` + ts + `","ordinal":` + ord + `,"type":"event_msg","payload":{"type":"` + typ + `","turn_id":"fu"}}`
	}
	endSec := ts(ended) / 1000
	for _, c := range []struct {
		name    string
		records []string // the follow-up's, in the child's rollout
		status  string   // the server's then
		last    *codexapp.Turn
		restart bool // the bridge restarted instead (a new source)
		state   string
		at      int64
		source  string
		reads   int
	}{
		{"nothing", nil, codexapp.ThreadIdle, &codexapp.Turn{ID: "z", Status: codexapp.TurnCompleted},
			false, proto.ChildCompleted, 99, proto.ChildFromAppServer, 1},
		{"follow-up interrupted", []string{record("task_started"), record("turn_aborted")}, codexapp.ThreadIdle,
			&codexapp.Turn{ID: "fu", Status: codexapp.TurnInterrupted, CompletedAt: endSec},
			false, proto.ChildInterrupted, endSec * 1000, proto.ChildFromAppServer, 1},
		{"follow-up completed", []string{record("task_started"), record("task_complete")}, codexapp.ThreadIdle,
			&codexapp.Turn{ID: "fu", Status: codexapp.TurnCompleted, CompletedAt: endSec},
			false, proto.ChildCompleted, endSec * 1000, proto.ChildFromAppServer, 1},
		// Killed during it: no end on disk, not loaded after the restart.
		// Its end superseded, it ends nothing (the row keeps the time of
		// the last end it showed: only a run clears it, #22).
		{"follow-up killed", []string{record("task_started")}, codexapp.ThreadNotLoaded,
			&codexapp.Turn{ID: "fu", Status: codexapp.TurnInProgress},
			false, proto.ChildUnknown, 0, proto.ChildFromAppServer, 1},
		{"bridge restarted", []string{record("task_started"), record("turn_aborted")}, codexapp.ThreadIdle,
			&codexapp.Turn{ID: "fu", Status: codexapp.TurnInterrupted, CompletedAt: endSec},
			true, proto.ChildInterrupted, ts(ended), proto.ChildFromRollout, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t, "a")
			r.src.opts.Settle = 10 * time.Millisecond
			r.all()
			r.poll()
			fr := newFakeReader()
			fr.child(aChild, r.session, codexapp.ThreadIdle, 1)
			r.src.Joined(r.session, fr)
			r.quiet()
			notify := func(method, params string) {
				r.src.Notify(r.session, method, json.RawMessage(params))
				r.quiet()
				r.apply()
			}
			notify("thread/status/changed", `{"threadId":"`+aChild+`","status":{"type":"active"}}`)
			notify("item/completed", `{"threadId":"`+r.session+`","completedAtMs":99,"item":{"type":"subAgentActivity","id":"subagent-completed-z","kind":"completed","agentThreadId":"`+aChild+`","agentPath":"/root/count_lines"}}`)
			if c := r.one(aChild); c.State != proto.ChildCompleted || c.EndedAt != 99 {
				t.Fatalf("before the loss: %+v", c)
			}
			r.src.Lost(r.session)
			r.apply()
			r.add(aChild, c.records...)
			fr.mu.Lock()
			fr.threads[aChild].Status.Type = c.status
			fr.last[aChild] = c.last
			fr.mu.Unlock()
			if c.restart {
				r.start()
				r.poll()
			} else {
				r.poll()
			}
			reads := fr.count("last ")
			r.src.Joined(r.session, fr)
			r.quiet()
			r.apply()
			r.poll()
			got, last := r.one(aChild), r.evs[len(r.evs)-1]
			if got.State != c.state || last.EndedAt != c.at || got.Source != c.source {
				t.Fatalf("got %s (%s), ended at %d, want %s at %d (%s)", got.State, got.Source, last.EndedAt, c.state, c.at, c.source)
			}
			if n := fr.count("last ") - reads; n != c.reads {
				t.Errorf("%d turn reads at the rejoin, want %d: %v", n, c.reads, fr.calls)
			}
			r.noRemovals()
		})
	}
}
