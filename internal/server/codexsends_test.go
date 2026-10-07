package server_test

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #158 R1 (review round 3): the invariant of the recorded sends. A send
// record goes only on positive evidence that its answer can no longer be
// delivered or already was: an envelope naming its question seen (live or
// in a join's history), the send refused, the thread changed, the worker
// sent home or no longer shared, a turn/start never confirmed whose
// envelope a join's history does not show, or its batch absent from a
// join's whole, resolved history. Absence from the bridge's bounded view
// (evicted, dismissed, a legacy id) is never evidence.

// sentAnswer is a shared worker whose answer to call_3 (colorQ) was
// steered, and accepted, into the running turn t1.
func sentAnswer(t *testing.T) (*sharedBridge, proto.HireResult) {
	t.Helper()
	sb, a := asyncWorker(t)
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")))
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	return sb, a
}

// newerBatches are n async batches of turn, asked after call_3, each with
// one free-text question.
func newerBatches(turn string, n int) []codexapp.Item {
	var out []codexapp.Item
	for i := range n {
		out = append(out, asyncItem(fmt.Sprintf("call_n%d", i), contextQ))
	}
	return out
}

// evict asks enough newer batches in t1 to evict call_3 from the view.
func (sb *sharedBridge) evict(t *testing.T, items []codexapp.Item) {
	t.Helper()
	for _, it := range items {
		sb.emit(itemDone("t1", it))
	}
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool {
		return batchOf(*c, items[len(items)-1].ID) != nil && batchOf(*c, "call_3") == nil
	})
}

// settle waits until the hub ran everything queued before it (its ops are
// run in order; a command is one).
func (sb *sharedBridge) settle(t *testing.T) {
	t.Helper()
	sb.c.mustError(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: "nobody", Thread: asyncThread, Batch: "settle"},
		proto.ErrUnknownWorker)
}

// recordedIs waits until a worker's recorded batches are want.
func (sb *sharedBridge) recordedIs(t *testing.T, id string, want []string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got := sb.recordedBatches(t, id)
		slices.Sort(got)
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("recorded sends of %s = %v, want %v", id, got, want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func activeThread(turns ...codexapp.Turn) *codexapp.Thread {
	th := &codexapp.Thread{Turns: turns}
	th.Status.Type = codexapp.ThreadActive
	return th
}

func runningTurn(id string, items ...codexapp.Item) codexapp.Turn {
	return codexapp.Turn{ID: id, Status: codexapp.TurnInProgress, Items: items}
}

func envelope(batch string, index int, answer string) string {
	return codexapp.ReplyEnvelope(codexapp.Answer{MessageID: batch, Index: index, Question: colorQ.Title, Answer: answer})
}

// The reviewer's round-3 path: the restarted bridge's join kept item-2
// (its re-read failed) after 31 older unanswered batches; the user
// dismisses item-2 and one more question evicts it. The record stays, and
// the canonical rejoin (CodexRejoin) restores call_3 as sent: a retry is
// stale, one envelope in all.
func TestAsyncAnswerKeptThroughAnEvictedLegacyBatch(t *testing.T) {
	sb, a := sentAnswer(t)
	var older []codexapp.Turn
	for i := range codexapp.MaxBatches - 1 {
		older = append(older, codexapp.Turn{ID: fmt.Sprintf("old-%d", i), Status: "completed",
			Items: []codexapp.Item{asyncItem(fmt.Sprintf("call_old_%d", i), contextQ)}})
	}
	sb = sb.restartWith(t, &codexapp.Thread{Turns: append(slices.Clone(older), runningTurn("t1", asyncItem("item-2", colorQ)))})
	sb.stateIs(t, "item-2", 0, proto.AsyncPending)
	sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "item-2"})
	sb.emit(itemDone("t1", asyncItem("call_4", contextQ)))
	c := sb.stateIs(t, "call_4", 0, proto.AsyncPending)
	if batchOf(c, "item-2") != nil {
		t.Fatalf("item-2 not evicted: %+v", c.Questions)
	}
	sb.settle(t)
	sb.recordedIs(t, a.ID, []string{"call_3"})

	sb.host.mu.Lock()
	sb.host.history = activeThread(append(slices.Clone(older),
		runningTurn("t1", asyncItem("call_3", colorQ), asyncItem("call_4", contextQ)))...)
	sb.host.mu.Unlock()
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends, want the one before the restart", n)
	}
}

// No legacy id at all: 32 newer questions of the running turn evict the
// batch of a sent answer. The record stays and the evicted batch cannot be
// answered, through a rejoin and a restart (their history has it 33rd
// newest, so reading it evicts it again); its envelope, once delivered,
// removes the record though the view never shows the batch again.
func TestAsyncAnswerKeptThroughAnEvictedBatch(t *testing.T) {
	sb, a := sentAnswer(t)
	newer := newerBatches("t1", codexapp.MaxBatches)
	sb.evict(t, newer)
	sb.settle(t)
	sb.recordedIs(t, a.ID, []string{"call_3"})
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	// Seen live again (Codex does not repeat an item, but nothing else may
	// make it answerable): sent, as recorded.
	sb.emit(itemDone("t1", asyncItem("call_3", colorQ)))
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)

	history := runningTurn("t1", append([]codexapp.Item{asyncItem("call_3", colorQ)}, newer...)...)
	sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected}, joined(activeThread(history)))
	sb.settle(t)
	sb.recordedIs(t, a.ID, []string{"call_3"})
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)

	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{history}})
	sb.settle(t)
	if c := sb.codexWorker(t, func(*proto.WorkerCodex) bool { return true }); batchOf(c, "call_3") != nil {
		t.Fatalf("call_3 kept by the hydration: %+v", batchOf(c, "call_3"))
	}
	sb.recordedIs(t, a.ID, []string{"call_3"})
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends, want 1", n)
	}

	first := sb.sent()[0]
	sb.emit(itemDone("t1", userItem("u", first.cid, first.text)))
	sb.recordedIs(t, a.ID, nil)
}

// A dismissed question whose answer was sent: dismissed first, so evicted
// first. The record stays, and the restarted bridge (which forgot the
// dismissal) shows it sent; its envelope, once delivered, removes it.
func TestAsyncAnswerKeptThroughADismissedEvictedBatch(t *testing.T) {
	sb, a := sentAnswer(t)
	sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3"})
	sb.stateIs(t, "call_3", 0, proto.AsyncDismissed)
	sb.evict(t, newerBatches("t1", codexapp.MaxBatches))
	sb.settle(t)
	sb.recordedIs(t, a.ID, []string{"call_3"})

	sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{runningTurn("t1", asyncItem("call_3", colorQ))}})
	sb.stateIs(t, "call_3", 0, proto.AsyncSent)
	sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_3", ans(0, "Green")), proto.ErrStale)
	first := sb.sent()[0]
	sb.emit(itemDone("t1", userItem("u", first.cid, first.text)))
	sb.stateIs(t, "call_3", 0, proto.AsyncAnswered)
	sb.recordedIs(t, a.ID, nil)
	if n := len(sb.sent()); n != 1 {
		t.Fatalf("%d sends, want 1", n)
	}
}

// Every way a record can go, and every way it must not: one row per path
// of the audit (docs/research/codex-shared-tui.md §12.1a). Each row starts
// from call_3's answer steered into the running turn t1, and gives the
// batches recorded after it.
func TestAsyncSendRecordInvariant(t *testing.T) {
	bridgeEnvelope := func(sb *sharedBridge) codexapp.Item {
		s := sb.sent()[0]
		return userItem("u", s.cid, s.text)
	}
	rows := []struct {
		name string
		run  func(t *testing.T, sb *sharedBridge, a proto.HireResult) *sharedBridge
		want []string
	}{
		// Positive evidence: the record goes.
		{"answered live", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.emit(itemDone("t1", bridgeEnvelope(sb)))
			return sb
		}, nil},
		{"answered live after its batch was evicted", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.evict(t, newerBatches("t1", codexapp.MaxBatches))
			sb.emit(itemDone("t1", bridgeEnvelope(sb)))
			return sb
		}, nil},
		{"answered by the terminal", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.emit(itemDone("t1", userItem("u", "", envelope("call_3", 0, "Blue"))))
			return sb
		}, nil},
		{"answered in a join's history", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.emit(codexapp.Event{Kind: codexapp.EvDisconnected},
				joined(activeThread(runningTurn("t1", asyncItem("call_3", colorQ), bridgeEnvelope(sb)))))
			return sb
		}, nil},
		{"answered in an unresolved history (item-N ids)", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
				runningTurn("t1", asyncItem("item-2", colorQ), userItem("item-3", "", envelope("call_3", 0, "Green")))}})
		}, nil},
		{"answered in a history that evicts its batch", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			items := append([]codexapp.Item{asyncItem("call_3", colorQ)}, newerBatches("t1", codexapp.MaxBatches)...)
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
				runningTurn("t1", append(items, userItem("u", "", envelope("call_3", 0, "Green")))...)}})
		}, nil},
		{"a refused answer", func(t *testing.T, sb *sharedBridge, a proto.HireResult) *sharedBridge {
			sb.emit(itemDone("t1", asyncItem("call_4", contextQ)))
			sb.stateIs(t, "call_4", 0, proto.AsyncPending)
			sb.host.mu.Lock()
			sb.host.steer = func(string, string, string) (string, error) {
				return "", &codexapp.RPCError{Code: -32600, Message: "no"}
			}
			sb.host.start = func(string, string) (string, error) { return "", &codexapp.RPCError{Code: -32600, Message: "no"} }
			sb.host.mu.Unlock()
			sb.c.mustError(proto.CmdWorkerAnswerAsync, answerArgs(a.ID, "call_4", ans(0, "x")), proto.ErrInputFailed)
			return sb
		}, []string{"call_3"}},
		{"the thread changed", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "01a11172-ac09-7aa0-ab6b-84485199ada4" })
			return sb
		}, nil},
		{"sent home", func(t *testing.T, sb *sharedBridge, a proto.HireResult) *sharedBridge {
			sb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: a.ID})
			return sb
		}, nil},
		{"a worker no longer shared at load", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			if err := sb.st.RecordCodexAsyncSends(context.Background(), []store.CodexAsyncSend{{WorkerID: "gone",
				Thread: asyncThread, Batch: "call_1", ClientID: "herdr_3d-01", Turn: "t0", Confirmed: true}}); err != nil {
				t.Fatal(err)
			}
			sb = sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{runningTurn("t1", asyncItem("call_3", colorQ))}})
			sb.recordedIs(t, "gone", nil)
			return sb
		}, []string{"call_3"}},
		{"a turn/start never confirmed, not in the history", func(t *testing.T, sb *sharedBridge, a proto.HireResult) *sharedBridge {
			if err := sb.st.RecordCodexAsyncSends(context.Background(), []store.CodexAsyncSend{{WorkerID: a.ID,
				Thread: asyncThread, Batch: "call_4", ClientID: "herdr_3d-02"}}); err != nil {
				t.Fatal(err)
			}
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{
				runningTurn("t1", asyncItem("call_3", colorQ), asyncItem("call_4", contextQ))}})
		}, []string{"call_3"}},
		{"its batch absent from a whole, resolved history", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{runningTurn("t2", asyncItem("call_9", contextQ))}})
		}, nil},

		// No evidence: the record stays.
		{"evicted by newer questions", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.evict(t, newerBatches("t1", codexapp.MaxBatches))
			return sb
		}, []string{"call_3"}},
		{"dismissed", func(t *testing.T, sb *sharedBridge, a proto.HireResult) *sharedBridge {
			sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3"})
			return sb
		}, []string{"call_3"}},
		{"dismissed, then evicted", func(t *testing.T, sb *sharedBridge, a proto.HireResult) *sharedBridge {
			sb.c.mustAck(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: a.ID, Thread: asyncThread, Batch: "call_3"})
			sb.evict(t, newerBatches("t1", codexapp.MaxBatches))
			return sb
		}, []string{"call_3"}},
		{"an unrelated live item", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.emit(itemDone("t1", userItem("u", "", "hello")), itemDone("t1", asyncItem("call_4", contextQ)))
			return sb
		}, []string{"call_3"}},
		{"its turn ended without it (undelivered)", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			sb.emit(turnCompleted("t1"))
			return sb
		}, []string{"call_3"}},
		{"a restart while it waits", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{runningTurn("t1", asyncItem("call_3", colorQ))}})
		}, []string{"call_3"}},
		{"an unresolved history (item-N ids)", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{runningTurn("t1", asyncItem("item-2", colorQ))}})
		}, []string{"call_3"}},
		{"a partial history without its batch", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			return sb.restartWith(t, &codexapp.Thread{Partial: true, Turns: []codexapp.Turn{runningTurn("t2", asyncItem("call_9", contextQ))}})
		}, []string{"call_3"}},
		{"evicted while a join reads the history", func(t *testing.T, sb *sharedBridge, _ proto.HireResult) *sharedBridge {
			items := append([]codexapp.Item{asyncItem("call_3", colorQ)}, newerBatches("t1", codexapp.MaxBatches)...)
			return sb.restartWith(t, &codexapp.Thread{Turns: []codexapp.Turn{runningTurn("t1", items...)}})
		}, []string{"call_3"}},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			sb, a := sentAnswer(t)
			sb = r.run(t, sb, a)
			sb.settle(t)
			sb.recordedIs(t, a.ID, r.want)
		})
	}
}
