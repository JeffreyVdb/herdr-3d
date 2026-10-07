//go:build integration

package codexshare

import (
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TestCodexShareBridgeQuestions (#158): async questions on a shared worker
// the bridge hired, answered through the bridge's own protocol and from the
// terminal, active and idle, with retries, duplicates and the bridge
// restarted. Each step records the bridge's ack and worker.codex view, the
// TUI's screen (its queued-question badge) and the mock's requests.
func TestCodexShareBridgeQuestions(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-a")
	f.installHerdrHook()
	b := f.startBridge(bridgeOptions{})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	f.record("switch-on.json", string(c.setShared(true)))

	w := c.hire("w", "bare-a", 0)
	if w.res.Codex == nil || w.res.Codex.Mode != proto.CodexModeShared {
		t.Fatalf("hire with the switch on: %+v", w.res.Codex)
	}
	c.prompt("first", w.id, "MOCK:say worker-ready")
	f.settle(w.pane)
	v := c.attached("joined", w.id)
	thread := v.Thread
	f.snap("tui-ready", w.pane)

	t.Run("1 active turn: the transcript answers one question, cleared on delivery", func(t *testing.T) {
		before := len(f.mock.Requests())
		c.prompt("ask-both", w.id, "MOCK:ask-both hold=a1")
		f.held("a1")
		batch := c.batchWith("1-batch-pending", w.id, 2)
		screen := f.waitScreen("1-tui-two-pending", w.pane, 15*time.Second, func(s string) bool { return badge(s) == 2 })
		_ = screen
		c.waitWorker("1-async-blocked", w.id, 15*time.Second, func(w proto.Worker) bool {
			return w.Codex != nil && w.Codex.AsyncBlocked && w.Codex.Turn != ""
		})
		raw := c.answer(w.id, thread, batch.Batch, 0, "Green")
		f.record("1-answer-ack.json", string(raw))
		var res proto.AsyncAnswerResult
		if !isAck(raw) {
			t.Fatalf("answer: %s", raw)
		}
		_ = res
		c.waitQuestion("1-sent", w.id, batch.Batch, 0, 10*time.Second, func(q proto.CodexQuestion) bool { return q.State == proto.AsyncSent })
		time.Sleep(2 * time.Second)
		if n := badge(f.snap("1-tui-after-send-not-yet-delivered", w.pane)); n != 2 {
			t.Errorf("badge right after the bridge's send = %d, want 2 (delivered with the next model request)", n)
		}
		f.mock.HoldNext(KindReply, "a1-reply")
		if err := f.mock.Release("a1"); err != nil {
			t.Fatal(err)
		}
		f.held("a1-reply")
		f.waitScreen("1-tui-after-delivery-turn-active", w.pane, 15*time.Second, func(s string) bool { return badge(s) == 1 })
		q := c.waitQuestion("1-answered", w.id, batch.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		if q.AnsweredBy != "bridge" {
			t.Errorf("answered_by = %q, want bridge", q.AnsweredBy)
		}
		if other := c.question(w.id, batch.Batch, 1); other.State != proto.AsyncPending {
			t.Errorf("the other question is %s, want pending", other.State)
		}
		if err := f.mock.Release("a1-reply"); err != nil {
			t.Fatal(err)
		}
		f.settle(w.pane)
		replies := f.replyRequests(before)
		f.recordJSON("1-mock-requests", summarize(f.mock.Requests()[before:]))
		if len(replies) != 1 || answersIn(replies[0], batch.Batch, 0) != 1 || !strings.Contains(replies[0].UserText, "Green") {
			t.Errorf("the model got %d reply requests (%+v), want one carrying one answer", len(replies), summarize(replies))
		}
	})
}
