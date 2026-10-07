//go:build integration

package codexshare

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TestCodexShareBridgeQuestions (#158): async questions on a shared worker
// the bridge hired, answered through the bridge's own protocol and from the
// terminal (the game's seated terminal: worker.keys), active and idle, with
// duplicates, the undelivered race and its retry, a dismissal, and the
// bridge restarted. Each step records the bridge's ack and worker.codex
// view, the TUI's screen (its queued-question badge) and the mock's
// requests; "one model-visible answer" is counted in the last model
// request's whole input, which is the conversation as the model sees it.
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
	c.settle(w)
	thread := c.attached("joined", w.id).Thread
	f.snap("tui-ready", w.pane)

	// What each answered question must be in the end: how many times the
	// model sees an answer to it.
	type want struct {
		batch string
		index int
		times int
	}
	var wants []want
	var batches []string
	var dismissed string

	// ask starts an asking turn whose next model request is held (the turn
	// stays active) and returns the bridge's new batch.
	ask := func(label, directive, hold string, n int) proto.CodexBatch {
		t.Helper()
		c.settle(w)
		c.prompt(label, w.id, "MOCK:"+directive+" hold="+hold)
		f.held(hold)
		batch := c.batchWith(label+"-batch", w.id, n, batches...)
		batches = append(batches, batch.Batch)
		f.waitScreen(label+"-tui", w.pane, 15*time.Second, func(s string) bool { return badge(s) == n })
		return batch
	}
	// deliver releases the held request and holds the reply request that
	// carries the answers, so the turn is provably still active when the
	// badge is read; then lets the turn end.
	deliver := func(label, hold string, badgeAfter int) {
		t.Helper()
		f.mock.HoldNext(KindReply, hold+"-reply")
		if err := f.mock.Release(hold); err != nil {
			t.Fatal(err)
		}
		f.held(hold + "-reply")
		f.waitScreen(label+"-tui-delivered-turn-active", w.pane, 15*time.Second, func(s string) bool { return badge(s) == badgeAfter })
		if err := f.mock.Release(hold + "-reply"); err != nil {
			t.Fatal(err)
		}
		c.settle(w)
	}
	// terminalAnswer answers the TUI's open question from the game's
	// seated terminal (worker.keys): shift+← opens Codex's question
	// editor, then the text and Enter.
	terminalAnswer := func(label, text string) {
		t.Helper()
		c.keys(w.id, "shift+left")
		f.waitScreen(label+"-terminal-editor", w.pane, 10*time.Second, func(s string) bool { return strings.Contains(s, "enter submit") })
		c.keys(w.id, "text:"+text)
		time.Sleep(time.Second)
		for range 3 {
			c.keys(w.id, "enter")
			time.Sleep(1500 * time.Millisecond)
			if s, _ := f.h.Read(f.ctx, w.pane, "visible", 0); !strings.Contains(s, "enter submit") {
				break
			}
		}
		f.snap(label+"-terminal-submitted", w.pane)
	}

	var b1 proto.CodexBatch
	t.Run("1 active turn: the transcript answers one question, cleared on delivery", func(t *testing.T) {
		before := len(f.mock.Requests())
		b1 = ask("1", "ask-both", "a1", 2)
		c.waitWorker("1-async-blocked", w.id, 15*time.Second, func(w proto.Worker) bool {
			return w.Codex != nil && w.Codex.AsyncBlocked && w.Codex.Turn != ""
		})
		raw := c.answer(w.id, thread, b1.Batch, 0, "Green")
		f.record("1-answer-ack.json", string(raw))
		if !isAck(raw) || !strings.Contains(string(raw), `"via":"turn/steer"`) {
			t.Fatalf("answer: %s", raw)
		}
		c.waitQuestion("1-sent", w.id, b1.Batch, 0, 10*time.Second, func(q proto.CodexQuestion) bool { return q.State == proto.AsyncSent })
		time.Sleep(2 * time.Second)
		if n := badge(f.snap("1-tui-after-send-not-yet-delivered", w.pane)); n != 2 {
			t.Errorf("badge right after the bridge's send = %d, want 2 (delivered with the next model request)", n)
		}
		deliver("1", "a1", 1)
		q := c.waitQuestion("1-answered", w.id, b1.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		if q.AnsweredBy != "bridge" {
			t.Errorf("answered_by = %q, want bridge", q.AnsweredBy)
		}
		replies := f.repliesSince(before, 1)
		f.recordJSON("1-mock-requests", summarize(f.mock.Requests()[before:]))
		if len(replies) != 1 || answersIn(string(replies[0].Body), b1.Batch, 0) != 1 || !strings.Contains(replies[0].UserText, "Green") {
			t.Errorf("the model got %d reply requests (%+v), want one carrying one answer", len(replies), summarize(replies))
		}
		wants = append(wants, want{b1.Batch, 0, 1})
	})

	t.Run("3 idle: the asking turn ended, only the bridge can answer", func(t *testing.T) {
		if b1.Batch == "" {
			t.Skip("no batch")
		}
		c.settle(w)
		v := c.view("3-idle-view", w.id)
		if q := c.question(w.id, b1.Batch, 1); q.State != proto.AsyncPending || v.Turn != "" || v.AsyncBlocked {
			t.Fatalf("after the asking turn ended: question %s, turn %q, async_blocked %v", q.State, v.Turn, v.AsyncBlocked)
		}
		screen := f.snap("3-tui-idle", w.pane)
		if badge(screen) != 0 {
			t.Errorf("the TUI still shows a badge after the asking turn ended")
		}
		c.keys(w.id, "shift+left")
		time.Sleep(time.Second)
		if screen := f.snap("3-tui-idle-shift-left", w.pane); strings.Contains(screen, "enter submit") {
			t.Errorf("the terminal opened a question editor after the asking turn ended")
		}
		c.keys(w.id, "esc")
		before := len(f.mock.Requests())
		raw := c.answer(w.id, thread, b1.Batch, 1, "context-from-the-transcript")
		f.record("3-answer-ack.json", string(raw))
		if !isAck(raw) || !strings.Contains(string(raw), `"via":"turn/start"`) {
			t.Fatalf("idle answer: %s", raw)
		}
		q := c.waitQuestion("3-answered", w.id, b1.Batch, 1, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		c.settle(w)
		screen = f.waitScreen("3-tui-answer-rendered", w.pane, 15*time.Second, func(s string) bool {
			return strings.Contains(s, "MOCK_REPLY_SEEN context-from-the-transcript")
		})
		if !strings.Contains(screen, "> "+QuestionContext) || strings.Contains(screen, "send_user_message_question_reply") {
			t.Errorf("the terminal did not render the bridge's idle answer as an answer")
		}
		if n := len(f.repliesSince(before, 1)); q.AnsweredBy != "bridge" || n != 1 {
			t.Errorf("answered_by %q, %d reply requests", q.AnsweredBy, n)
		}
		wants = append(wants, want{b1.Batch, 1, 1})
	})

	t.Run("2 active turn: the terminal answers, the bridge sees it answered by another client", func(t *testing.T) {
		before := len(f.mock.Requests())
		b2 := ask("2", "ask-free", "a2", 1)
		terminalAnswer("2", "typed-in-terminal")
		if q := c.question(w.id, b2.Batch, 0); q.State != proto.AsyncPending {
			t.Errorf("before delivery the bridge reads the terminal's queued answer as %s, want pending", q.State)
		}
		deliver("2", "a2", 0)
		q := c.waitQuestion("2-answered", w.id, b2.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		replies := f.repliesSince(before, 1)
		f.recordJSON("2-mock-requests", summarize(f.mock.Requests()[before:]))
		if q.AnsweredBy != "other" || q.Answer != "typed-in-terminal" {
			t.Errorf("terminal answer seen as %+v", q)
		}
		if len(replies) != 1 || !strings.Contains(replies[0].UserText, "typed-in-terminal") {
			t.Errorf("the model got %d reply requests, want the terminal's one", len(replies))
		}
		wants = append(wants, want{b2.Batch, 0, 1})
	})

	t.Run("5 two clients answer at once: one is sent, the other stale", func(t *testing.T) {
		before := len(f.mock.Requests())
		b5 := ask("5", "ask-options", "a5", 1)
		c2 := b.dial("game-2")
		c2.attached("5-second-client-view", w.id)
		var wg sync.WaitGroup
		raws := make([][]byte, 2)
		for i, cl := range []*bclient{c, c2} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				raws[i] = cl.answer(w.id, thread, b5.Batch, 0, []string{"Green", "Blue"}[i])
			}()
		}
		wg.Wait()
		f.record("5-concurrent-replies.txt", string(raws[0])+"\n"+string(raws[1])+"\n")
		acks := 0
		for _, r := range raws {
			if isAck(r) {
				acks++
			} else if errCode(r) != proto.ErrStale {
				t.Errorf("the losing answer: %s, want stale", r)
			}
		}
		if acks != 1 {
			t.Fatalf("%d of two concurrent answers were sent, want 1", acks)
		}
		again := c2.answer(w.id, thread, b5.Batch, 0, "Blue")
		f.record("5-third-answer-while-sent.json", string(again))
		if errCode(again) != proto.ErrStale {
			t.Errorf("a third answer while the first is on its way: %s, want stale", again)
		}
		deliver("5", "a5", 0)
		c.waitQuestion("5-answered", w.id, b5.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		late := c.answer(w.id, thread, b5.Batch, 0, "Blue")
		f.record("5-answer-after-answered.json", string(late))
		if errCode(late) != proto.ErrStale {
			t.Errorf("an answer to an answered question: %s, want stale", late)
		}
		replies := f.repliesSince(before, 1)
		f.recordJSON("5-mock-requests", summarize(f.mock.Requests()[before:]))
		if len(replies) != 1 || answersIn(string(replies[0].Body), b5.Batch, 0) != 1 {
			t.Errorf("the model got %d reply requests, want one", len(replies))
		}
		wants = append(wants, want{b5.Batch, 0, 1})
	})

	t.Run("5 the terminal and the transcript both answer one question", func(t *testing.T) {
		before := len(f.mock.Requests())
		b6 := ask("5b", "ask-free", "a6", 1)
		raw := c.answer(w.id, thread, b6.Batch, 0, "from-the-transcript")
		f.record("5b-bridge-answer-ack.json", string(raw))
		if !isAck(raw) {
			t.Fatalf("answer: %s", raw)
		}
		terminalAnswer("5b", "from-the-terminal")
		deliver("5b", "a6", 0)
		q := c.waitQuestion("5b-answered", w.id, b6.Batch, 0, 15*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		replies := f.repliesSince(before, 1)
		c.settle(w)
		f.recordJSON("5b-mock-requests", summarize(f.mock.Requests()[before:]))
		n := answersIn(f.lastModelRequest(), b6.Batch, 0)
		f.record("5b-both-answers.txt", fmt.Sprintf("bridge view: state %s answered_by %s answer %q\nreply requests: %d\nanswers to %s/0 in the model's last input: %d\n",
			q.State, q.AnsweredBy, q.Answer, len(replies), b6.Batch, n))
		// Known and documented (findings §2): the server does not
		// deduplicate, and the bridge cannot see the terminal's queued
		// answer before it is delivered. Both reach the model, and the
		// bridge shows the one delivered last.
		if n != 2 {
			t.Errorf("the model sees %d answers to a question both views answered, findings §2 says 2", n)
		}
		wants = append(wants, want{b6.Batch, 0, 2})
	})

	t.Run("6 the undelivered race, then the legitimate retry: one answer in all", func(t *testing.T) {
		before := len(f.mock.Requests())
		b7 := ask("6", "ask-options", "a7", 1)
		raw := c.answer(w.id, thread, b7.Batch, 0, "Blue")
		f.record("6-answer-ack.json", string(raw))
		if !isAck(raw) || !strings.Contains(string(raw), `"via":"turn/steer"`) {
			t.Fatalf("answer: %s", raw)
		}
		// Ctrl+C in the terminal (the game's seated terminal) before the
		// next model request: the steered answer is dropped.
		c.keys(w.id, "ctrl+c")
		q := c.waitQuestion("6-undelivered", w.id, b7.Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.Undelivered
		})
		c.settle(w)
		f.snap("6-tui-interrupted", w.pane)
		if q.State != proto.AsyncSent || len(f.replyRequests(before)) != 0 {
			t.Fatalf("after the interrupt: %+v, %d reply requests", q, len(f.replyRequests(before)))
		}
		_ = f.mock.Release("a7") // the interrupted request, if it still waits
		raw = c.answer(w.id, thread, b7.Batch, 0, "Blue")
		f.record("6-retry-ack.json", string(raw))
		if !isAck(raw) {
			t.Fatalf("the retry of an undelivered answer: %s", raw)
		}
		c.waitQuestion("6-answered", w.id, b7.Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		c.settle(w)
		again := c.answer(w.id, thread, b7.Batch, 0, "Blue")
		f.record("6-answer-after-answered.json", string(again))
		if errCode(again) != proto.ErrStale {
			t.Errorf("an answer to an answered question: %s, want stale", again)
		}
		replies := f.repliesSince(before, 1)
		f.recordJSON("6-mock-requests", summarize(f.mock.Requests()[before:]))
		if n := len(replies); n != 1 {
			t.Errorf("%d reply requests, want 1", n)
		}
		f.snap("6-tui-done", w.pane)
		wants = append(wants, want{b7.Batch, 0, 1})
	})

	t.Run("dismiss: put away in the bridge, nothing sent, Codex keeps it", func(t *testing.T) {
		c.settle(w)
		before := len(f.mock.Requests())
		c.prompt("d", w.id, "MOCK:ask-free")
		c.settle(w)
		bd := c.batchWith("d-batch", w.id, 1, batches...)
		batches, dismissed = append(batches, bd.Batch), bd.Batch
		c.ack(proto.CmdWorkerDismissAsync, proto.WorkerDismissAsyncArgs{ID: w.id, Thread: thread, Batch: bd.Batch}, 10*time.Second, nil)
		c.waitQuestion("d-dismissed", w.id, bd.Batch, 0, 10*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncDismissed
		})
		late := c.answer(w.id, thread, bd.Batch, 0, "after-dismiss")
		f.record("d-answer-after-dismiss.json", string(late))
		if errCode(late) != proto.ErrStale {
			t.Errorf("an answer to a dismissed question: %s, want stale", late)
		}
		if n := len(f.repliesSince(before, 0)); n != 0 {
			t.Errorf("dismissing sent %d replies", n)
		}
	})

	t.Run("7 the bridge goes away and comes back while a question is pending", func(t *testing.T) {
		if len(batches) == 0 {
			t.Skip("no batches")
		}
		b8 := ask("7", "ask-options", "a8", 1)
		beforeRestart := c.view("7-view-before", w.id)
		l, ok := b.launchOf(w.id)
		if !ok {
			t.Fatal("no launch record")
		}
		// The game's tab goes, then herdr-world itself.
		c.close()
		b.stop()
		pids := codexapp.MarkedPIDs(l.Token, "")
		f.record("7-server-while-bridge-gone.txt", fmt.Sprintf("marked processes: %v\nfiles: %v\n", pids, launchFiles(l)))
		if len(pids) == 0 {
			t.Fatal("stopping herdr-world stopped the worker's server")
		}
		if n := badge(f.snap("7-tui-bridge-gone", w.pane)); n != 1 {
			t.Errorf("badge with the bridge gone = %d, want 1", n)
		}
		// The turn finishes without the bridge, and the terminal works.
		if err := f.mock.Release("a8"); err != nil {
			t.Fatal(err)
		}
		f.settle(w.pane) // herdr's view: there is no bridge
		f.prompt(w.pane, "MOCK:say typed-while-the-bridge-was-gone")
		f.snap("7-tui-terminal-turn-bridge-gone", w.pane)

		b.restart()
		c = b.dial("game-after-restart")
		after := c.attached("7-rejoined", w.id)
		c.view("7-view-after", w.id)
		var ids, idsBefore []string
		for _, x := range after.Questions {
			ids = append(ids, x.Batch)
		}
		for _, x := range beforeRestart.Questions {
			idsBefore = append(idsBefore, x.Batch)
		}
		f.record("7-batches.txt", "before: "+strings.Join(idsBefore, " ")+"\nafter:  "+strings.Join(ids, " ")+"\n")
		if !slices.Equal(ids, idsBefore) {
			t.Errorf("batches after the restart %v, before %v", ids, idsBefore)
		}
		for _, x := range after.Questions {
			for i, q := range x.Questions {
				switch {
				case (x.Batch == b8.Batch || x.Batch == dismissed) && q.State != proto.AsyncPending:
					// A dismissal is the bridge's only: a restart shows it again.
					t.Errorf("the pending question %s/%d came back %s", x.Batch, i, q.State)
				case x.Batch != b8.Batch && x.Batch != dismissed && q.State != proto.AsyncAnswered:
					t.Errorf("answered question %s/%d came back %s", x.Batch, i, q.State)
				}
			}
		}
		before := len(f.mock.Requests())
		raw := c.answer(w.id, after.Thread, b8.Batch, 0, "Green")
		f.record("7-answer-after-restart-ack.json", string(raw))
		if !isAck(raw) {
			t.Fatalf("answer after the restart: %s", raw)
		}
		c.waitQuestion("7-answered", w.id, b8.Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		if n := len(f.repliesSince(before, 1)); n != 1 {
			t.Errorf("%d reply requests after the restart, want 1", n)
		}
		wants = append(wants, want{b8.Batch, 0, 1})
	})

	t.Run("4 distinct batches, and what the model saw of each answer", func(t *testing.T) {
		c.settle(w)
		c.prompt("end", w.id, "MOCK:say the-end")
		c.settle(w)
		last := f.lastModelRequest()
		var lines []string
		for _, x := range wants {
			n := answersIn(last, x.batch, x.index)
			lines = append(lines, fmt.Sprintf("%s/%d: %d answer(s) in the model's input (want %d)", x.batch, x.index, n, x.times))
			if n != x.times {
				t.Errorf("%s/%d: the model sees %d answers, want %d", x.batch, x.index, n, x.times)
			}
		}
		f.record("4-model-visible-answers.txt", strings.Join(lines, "\n")+"\n")
		seen := map[string]bool{}
		for _, id := range batches {
			if seen[id] {
				t.Errorf("batch id %s twice", id)
			}
			seen[id] = true
		}
		f.record("4-batches.txt", strconv.Itoa(len(batches))+" batches: "+strings.Join(batches, " ")+"\n")
		f.recordJSON("mock-requests", summarize(f.mock.Requests()))
		f.record("bridge-events.txt", strings.Join(c.eventLog(), "\n")+"\n")
		c.view("final-view", w.id)
		f.snap("final-tui", w.pane)
	})
}
