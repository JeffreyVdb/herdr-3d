//go:build integration

package codexshare

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TestCodexShareBridgeRestartSent (#158 R1): herdr-world restarts after
// Codex accepted its steered answer and before the turn's next model
// request delivers it. The thread's history does not show a queued steer,
// so a bridge rebuilt from it alone would see the question pending and
// take the player's retry: a second envelope the model sees too (the
// server does not deduplicate). The bridge records its sends: after the
// restart the question is still sent, the retry stale, and the model sees
// one answer. When the turn ends without it while the bridge is gone, the
// question comes back sent and undelivered, and one resend goes.
func TestCodexShareBridgeRestartSent(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-a")
	f.installHerdrHook()
	b := f.startBridge(bridgeOptions{})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	c.setShared(true)
	w := c.hire("w", "bare-a", 0)
	if w.res.Codex == nil || w.res.Codex.Mode != proto.CodexModeShared {
		t.Fatalf("hire with the switch on: %+v", w.res.Codex)
	}
	c.prompt("first", w.id, "MOCK:say worker-ready")
	c.settle(w)
	thread := c.attached("joined", w.id).Thread
	var batches []string
	type want struct {
		batch string
		index int
	}
	var wants []want

	// ask starts an asking turn whose next model request is held, so the
	// turn stays active, and returns the bridge's new batch.
	ask := func(label, directive, hold string) proto.CodexBatch {
		t.Helper()
		c.settle(w)
		c.prompt(label, w.id, "MOCK:"+directive+" hold="+hold)
		f.held(hold)
		batch := c.batchWith(label+"-batch", w.id, 1, batches...)
		batches = append(batches, batch.Batch)
		f.waitScreen(label+"-tui-asked", w.pane, 15*time.Second, func(s string) bool { return badge(s) == 1 })
		return batch
	}
	// steer answers through the bridge while the turn runs: sent, via
	// turn/steer, not delivered (the next model request is held).
	steer := func(label, batch, text string) {
		t.Helper()
		raw := c.answer(w.id, thread, batch, 0, text)
		f.record(label+"-answer-ack.json", string(raw))
		if !isAck(raw) || !strings.Contains(string(raw), `"via":"turn/steer"`) {
			t.Fatalf("answer: %s", raw)
		}
		c.waitQuestion(label+"-sent", w.id, batch, 0, 10*time.Second, func(q proto.CodexQuestion) bool { return q.State == proto.AsyncSent })
	}
	// restart takes the game's connection and herdr-world away, runs gone
	// while herdr-world is gone, and brings both back.
	restart := func(label string, gone func()) proto.WorkerCodex {
		t.Helper()
		l, ok := b.launchOf(w.id)
		if !ok {
			t.Fatal("no launch record")
		}
		c.close()
		b.stop()
		if pids := codexapp.MarkedPIDs(l.Token, ""); len(pids) == 0 {
			t.Fatal("stopping herdr-world stopped the worker's server")
		}
		f.snap(label+"-tui-bridge-gone", w.pane)
		if gone != nil {
			gone()
		}
		b.restart()
		c = b.dial("game-after-" + label)
		return c.attached(label+"-rejoined", w.id)
	}

	// rawHistory records the thread as a new client reads it while
	// herdr-world is gone: thread/resume as the bridge's join asks for it,
	// and thread/read with its turns.
	rawHistory := func(label string) {
		t.Helper()
		l, _ := b.launchOf(w.id)
		pc := f.client(codexapp.Launch{Dir: l.RunDir, Name: l.Name}.Socket(), "probe")
		defer pc.Close()
		var resumed, read json.RawMessage
		if err := pc.Call(f.ctx, "thread/resume", map[string]any{"threadId": thread}, &resumed); err != nil {
			t.Fatalf("thread/resume: %v", err)
		}
		if err := pc.Call(f.ctx, "thread/read", map[string]any{"threadId": thread, "includeTurns": true}, &read); err != nil {
			t.Fatalf("thread/read: %v", err)
		}
		var listed json.RawMessage
		if err := pc.Call(f.ctx, "thread/turns/list", map[string]any{"threadId": thread, "sortDirection": "desc",
			"itemsView": "full", "limit": 2}, &listed); err != nil {
			t.Fatalf("thread/turns/list: %v", err)
		}
		f.record(label+"-thread-turns-list.json", string(listed))
		f.record(label+"-thread-resume.json", string(resumed))
		f.record(label+"-thread-read.json", string(read))
	}
	_ = rawHistory

	t.Run("sent, then herdr-world restarts before delivery: the retry is stale, one answer", func(t *testing.T) {
		before := len(f.mock.Requests())
		b1 := ask("1", "ask-options", "r1")
		steer("1", b1.Batch, "Green")
		restart("1", func() { rawHistory("1-raw-history-active") })
		q := c.waitQuestion("1-after-restart", w.id, b1.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State != proto.AsyncPending
		})
		c.view("1-view-after-restart", w.id)
		if q.State != proto.AsyncSent || q.Undelivered || q.Unconfirmed {
			t.Fatalf("after the restart the question is %+v, want sent (its answer still queued in the turn)", q)
		}
		for i, text := range []string{"Green", "Blue"} {
			raw := c.answer(w.id, thread, b1.Batch, 0, text)
			f.record(fmt.Sprintf("1-retry-%d-after-restart.json", i+1), string(raw))
			if errCode(raw) != proto.ErrStale {
				t.Errorf("a retry after the restart: %s, want stale", raw)
			}
		}
		if n := len(f.replyRequests(before)); n != 0 {
			t.Fatalf("%d reply requests before the held request was released", n)
		}
		// Delivery: the held request goes, the reply request carrying the
		// answer is held so the turn is still running when it is read.
		f.mock.HoldNext(KindReply, "r1-reply")
		if err := f.mock.Release("r1"); err != nil {
			t.Fatal(err)
		}
		f.held("r1-reply")
		f.waitScreen("1-tui-delivered-turn-active", w.pane, 15*time.Second, func(s string) bool { return badge(s) == 0 })
		if err := f.mock.Release("r1-reply"); err != nil {
			t.Fatal(err)
		}
		c.settle(w)
		q = c.waitQuestion("1-answered", w.id, b1.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		replies := f.repliesSince(before, 1)
		f.recordJSON("1-mock-requests", summarize(f.mock.Requests()[before:]))
		if q.AnsweredBy != "bridge" || q.Answer != "Green" {
			t.Errorf("answered as %+v", q)
		}
		if len(replies) != 1 || answersIn(string(replies[0].Body), b1.Batch, 0) != 1 {
			t.Errorf("the model got %d reply requests (%+v), want one carrying one answer", len(replies), summarize(replies))
		}
		wants = append(wants, want{b1.Batch, 0})
	})

	t.Run("sent, the turn ends while herdr-world is gone: undelivered, one resend", func(t *testing.T) {
		before := len(f.mock.Requests())
		b2 := ask("2", "ask-free", "r2")
		steer("2", b2.Batch, "the-first-answer")
		restart("2", func() {
			// Ctrl+C in the terminal before the next model request: the
			// steered answer is dropped with the turn.
			if err := f.h.SendKeys(f.ctx, w.pane, "ctrl+c"); err != nil {
				t.Fatal(err)
			}
			f.settle(w.pane)
			_ = f.mock.Release("r2") // the interrupted request, if it still waits
			f.snap("2-tui-interrupted-bridge-gone", w.pane)
			rawHistory("2-raw-history-interrupted")
		})
		q := c.waitQuestion("2-after-restart", w.id, b2.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State != proto.AsyncPending
		})
		c.view("2-view-after-restart", w.id)
		if q.State != proto.AsyncSent || !q.Undelivered {
			t.Fatalf("after the restart the question is %+v, want sent and undelivered", q)
		}
		if n := len(f.replyRequests(before)); n != 0 {
			t.Fatalf("%d reply requests: the interrupted turn delivered the answer", n)
		}
		raw := c.answer(w.id, thread, b2.Batch, 0, "the-resent-answer")
		f.record("2-resend-ack.json", string(raw))
		if !isAck(raw) || !strings.Contains(string(raw), `"via":"turn/start"`) {
			t.Fatalf("the resend: %s", raw)
		}
		again := c.answer(w.id, thread, b2.Batch, 0, "a-third")
		f.record("2-third-answer.json", string(again))
		if errCode(again) != proto.ErrStale {
			t.Errorf("a third answer: %s, want stale", again)
		}
		q = c.waitQuestion("2-answered", w.id, b2.Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		c.settle(w)
		replies := f.repliesSince(before, 1)
		f.recordJSON("2-mock-requests", summarize(f.mock.Requests()[before:]))
		if q.AnsweredBy != "bridge" || q.Answer != "the-resent-answer" || len(replies) != 1 {
			t.Errorf("answered as %+v, %d reply requests", q, len(replies))
		}
		f.snap("2-tui-answered", w.pane)
		wants = append(wants, want{b2.Batch, 0})
	})

	t.Run("what the model saw of each answer", func(t *testing.T) {
		c.settle(w)
		c.prompt("end", w.id, "MOCK:say the-end")
		c.settle(w)
		last := f.lastModelRequest()
		var lines []string
		for _, x := range wants {
			n := answersIn(last, x.batch, x.index)
			lines = append(lines, fmt.Sprintf("%s/%d: %d answer(s) in the model's input (want 1)", x.batch, x.index, n))
			if n != 1 {
				t.Errorf("%s/%d: the model sees %d answers, want 1", x.batch, x.index, n)
			}
		}
		if !strings.Contains(last, "the-first-answer") {
			lines = append(lines, "the dropped first answer to the second batch is not in the model's input")
		} else {
			t.Errorf("the dropped answer reached the model")
		}
		f.record("model-visible-answers.txt", strings.Join(lines, "\n")+"\n")
		f.recordJSON("mock-requests", summarize(f.mock.Requests()))
		f.record("bridge-events.txt", strings.Join(c.eventLog(), "\n")+"\n")
		c.view("final-view", w.id)
		f.snap("final-tui", w.pane)
	})
}
