//go:build integration

package codexshare

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// worker is a Codex TUI attached to a worker-owned app-server, both started
// from one Herdr workspace, plus a bridge client subscribed to its thread.
type worker struct {
	sock   string
	server string // the pane that launched the server
	tui    string // the TUI's pane
	name   string // its Herdr agent name
	bridge *Client
	thread thread
}

// sharedWorker starts the candidate launch in workspace ws: the app-server
// from the initialized shell, then `codex --remote` through `herdr agent
// start`, one prompt so the thread is persisted, then the bridge joins.
func (f *fx) sharedWorker(ws, name string) *worker {
	f.t.Helper()
	w := &worker{name: name}
	w.server = f.pane(ws)
	w.sock = f.startServer(w.server, "srv-"+name)
	w.tui = f.pane(ws)
	f.startTUI(name, w.tui, "--remote", "unix://"+w.sock, "-C", f.root+"/"+ws)
	f.prompt(name, "MOCK:say worker-ready")
	w.bridge = f.client(w.sock, "h3d-bridge")
	w.thread = f.tuiThread(w.bridge)
	f.resume(w.bridge, w.thread.ID)
	return w
}

// prompt submits text through Herdr and waits for the turn to end (idle,
// done or blocked), failing on a stall or a timeout.
func (f *fx) prompt(agent, text string) Agent {
	f.t.Helper()
	a, err := f.h.AgentPrompt(f.ctx, agent, text, 90*time.Second, "idle", "done", "blocked")
	if err != nil {
		screen, _ := f.h.Read(f.ctx, agent, "visible", 0)
		f.t.Fatalf("prompt %q: %v\n%s", text, err, screen)
	}
	return a
}

// settle waits until Herdr sees the agent idle or done: the TUI has
// processed the last turn's end (its pending questions read as blocked).
func (f *fx) settle(agent string) {
	f.t.Helper()
	if a, err := f.h.AgentWait(f.ctx, agent, 20*time.Second, "idle", "done"); err != nil {
		screen, _ := f.h.Read(f.ctx, agent, "visible", 0)
		f.t.Fatalf("agent %s did not settle (%+v): %v\n%s", agent, a, err, screen)
	}
}

// promptWorking submits text and waits until Herdr sees the turn working.
func (f *fx) promptWorking(agent, text string) {
	f.t.Helper()
	if _, err := f.h.AgentPrompt(f.ctx, agent, text, 60*time.Second, "working"); err != nil {
		f.t.Fatalf("prompt %q: %v", text, err)
	}
}

func (f *fx) held(name string) {
	f.t.Helper()
	ctx, cancel := f.within(60 * time.Second)
	defer cancel()
	if err := f.mock.WaitHeld(ctx, name); err != nil {
		f.t.Fatal(err)
	}
}

var badgeRe = regexp.MustCompile(`\? (\d+) questions?`)

// badge is the queued-question count the TUI shows, 0 without a badge.
func badge(screen string) int {
	m := badgeRe.FindStringSubmatch(screen)
	if m == nil || !strings.Contains(screen, "Queued follow-up inputs") {
		return 0
	}
	n := 0
	for _, c := range m[1] {
		n = n*10 + int(c-'0')
	}
	return n
}

// replies are the reply-envelope requests the mock received.
func (f *fx) replies() []Request {
	var out []Request
	for _, r := range f.mock.Requests() {
		if r.Kind == KindReply {
			out = append(out, r)
		}
	}
	return out
}

func (f *fx) waitReplies(n int) []Request {
	f.t.Helper()
	ctx, cancel := f.within(60 * time.Second)
	defer cancel()
	if err := f.mock.WaitRequests(ctx, n, func(r Request) bool { return r.Kind == KindReply }); err != nil {
		f.t.Fatal(err)
	}
	return f.replies()
}

// TestCodexShareQuestions: async questions answered from the bridge (idle
// turn/start, active turn/steer) and from the terminal, with the TUI's
// queued-question badge read off the screen at each step.
func TestCodexShareQuestions(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a")
	w := f.sharedWorker("ws-a", "worker")
	c, th := w.bridge, w.thread.ID

	t.Run("idle answer from the bridge", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		a := f.prompt(w.name, "MOCK:ask-both")
		q := f.waitItem(c, 30*time.Second, func(e itemEvent) bool { return e.Item.Delivery == "async" && len(e.Item.Questions) == 2 })
		f.recordJSON("idle-question-live-item", q)
		// Herdr saw the pending question as blocked ("Action Required").
		f.recordJSON("idle-question-herdr-state-at-prompt-return", a)
		f.waitTurnCompleted(c, q.TurnID, 60*time.Second)
		// The asking turn's end clears the TUI's pending questions: the
		// question stays in the transcript, the badge goes.
		screen := f.waitScreen("idle-after-asking-turn-ended", w.tui, 10*time.Second, func(s string) bool {
			i := strings.Index(s, "MOCK_ASKED")
			return i >= 0 && strings.Contains(s[i:], "Worked for")
		})
		if badge(screen) != 0 {
			t.Errorf("badge %d after the asking turn ended (observed 0)", badge(screen))
		}
		ag, _, _ := f.h.AgentGet(f.ctx, w.name)
		f.recordJSON("idle-herdr-state-after-turn-end", ag)
		// The terminal has nothing left to answer natively.
		_ = f.h.SendKeys(f.ctx, w.tui, "shift+left")
		time.Sleep(time.Second)
		f.snap("idle-terminal-shift-left", w.tui)
		_ = f.h.SendKeys(f.ctx, w.tui, "esc")

		f.mock.HoldNext(KindReply, "idle-reply")
		turn := f.startTurn(c, th, ReplyEnvelope(Answer{MessageID: q.Item.ID, Question: QuestionColor, Answer: "Green"}))
		f.held("idle-reply")
		f.waitScreen("idle-answer-turn-active", w.tui, 10*time.Second, func(s string) bool { return strings.Contains(s, "> "+QuestionColor) })
		_ = f.mock.Release("idle-reply")
		f.waitTurnCompleted(c, turn, 60*time.Second)
		screen = f.waitScreen("idle-answer-rendered", w.tui, 10*time.Second, func(s string) bool {
			return strings.Contains(s, "MOCK_REPLY_SEEN Green")
		})
		if strings.Contains(screen, "send_user_message_question_reply") || badge(screen) != 0 {
			t.Errorf("the TUI showed the raw envelope or a badge")
		}
		turn = f.startTurn(c, th, ReplyEnvelope(Answer{MessageID: q.Item.ID, Index: 1, Question: QuestionContext, Answer: "idle-context"}))
		f.waitTurnCompleted(c, turn, 60*time.Second)
		screen = f.waitScreen("idle-second-answer-rendered", w.tui, 10*time.Second, func(s string) bool {
			return strings.Contains(s, "MOCK_REPLY_SEEN idle-context")
		})
		if !strings.Contains(screen, "> "+QuestionContext) {
			t.Errorf("second idle answer not rendered as an answer")
		}
		r := f.replies()
		if len(r) != 2 || !strings.Contains(r[0].UserText, `\"request_user_input_async\",\"`+q.Item.ID+`\",0]`) {
			t.Errorf("model got %+v", r)
		}
	})

	t.Run("active answer from the bridge clears that question only once delivered", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		before := len(f.replies())
		f.promptWorking(w.name, "MOCK:ask-both hold=active")
		f.held("active")
		q := f.waitItem(c, 30*time.Second, func(e itemEvent) bool {
			return e.Item.Delivery == "async" && len(e.Item.Questions) == 2
		})
		f.recordJSON("active-question-live-item", q)
		screen := f.waitScreen("active-two-pending", w.tui, 10*time.Second, func(s string) bool { return badge(s) == 2 })
		_ = screen
		// Answer only the first (options) question during the active turn.
		if err := f.steer(c, th, q.TurnID, ReplyEnvelope(Answer{MessageID: q.Item.ID, Index: 0, Question: QuestionColor, Answer: "Blue"})); err != nil {
			t.Fatalf("turn/steer: %v", err)
		}
		time.Sleep(2 * time.Second)
		screen = f.snap("active-after-steer-not-yet-delivered", w.tui)
		if badge(screen) != 2 {
			t.Errorf("badge right after turn/steer = %d, want 2 (the steer waits for the next model request)", badge(screen))
		}
		// The steered reply reaches the model; hold that request so the
		// turn stays active and only the association can clear the badge.
		f.mock.HoldNext(KindReply, "active-reply")
		if err := f.mock.Release("active"); err != nil {
			t.Fatal(err)
		}
		f.held("active-reply")
		f.waitScreen("active-after-delivery-turn-still-working", w.tui, 10*time.Second, func(s string) bool { return badge(s) == 1 })
		if got := f.read(c, th).Status.Type; got != "active" {
			t.Errorf("thread status %q while the reply request is held, want active", got)
		}
		// Answer the remaining free-text question in the terminal.
		if err := f.h.SendKeys(f.ctx, w.tui, "shift+left"); err != nil {
			t.Fatal(err)
		}
		f.waitScreen("terminal-question-open", w.tui, 10*time.Second, func(s string) bool { return strings.Contains(s, QuestionContext) })
		if err := f.h.SendText(f.ctx, w.tui, "typed-in-terminal"); err != nil {
			t.Fatal(err)
		}
		f.terminalSubmit(w.tui, "typed-in-terminal")
		if err := f.mock.Release("active-reply"); err != nil {
			t.Fatal(err)
		}
		r := f.waitReplies(before + 2)
		f.recordJSON("active-replies-as-the-model-got-them", r[before:])
		f.prompt(w.name, "MOCK:say after-active")
		f.snap("active-done", w.tui)
		if !strings.Contains(r[before].UserText, `\"`+q.Item.ID+`\",0]`) || !strings.Contains(r[before+1].UserText, "typed-in-terminal") ||
			!strings.Contains(r[before+1].UserText, `\"`+q.Item.ID+`\",1]`) {
			t.Errorf("the two answers did not both reach the model with their question ids")
		}
	})

	t.Run("double submit", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		before := len(f.replies())
		f.prompt(w.name, "MOCK:ask-options")
		q := f.questionItem(c, QuestionColor)
		for range 2 {
			env := ReplyEnvelope(Answer{MessageID: q.Item.ID, Question: QuestionColor, Answer: "Green-twice"})
			f.waitTurnCompleted(c, f.startTurn(c, th, env), 60*time.Second)
		}
		r := f.waitReplies(before + 2)
		screen := f.snap("double-submit", w.tui)
		f.record("double-submit-count.txt", strings.Repeat("reply reached the model\n", len(r)-before))
		if len(r)-before != 2 || strings.Count(screen, "MOCK_REPLY_SEEN Green-twice") != 2 {
			t.Errorf("double submit: %d replies reached the model (no server-side dedup expected)", len(r)-before)
		}

		// Terminal and bridge both answer one question in one active turn.
		before = len(f.replies())
		f.promptWorking(w.name, "MOCK:ask-free hold=both")
		f.held("both")
		q = f.questionItem(c, QuestionContext)
		if err := f.steer(c, th, q.TurnID, ReplyEnvelope(Answer{MessageID: q.Item.ID, Question: QuestionContext, Answer: "from-bridge"})); err != nil {
			t.Fatal(err)
		}
		_ = f.h.SendKeys(f.ctx, w.tui, "shift+left")
		f.waitScreen("both-terminal-question-open", w.tui, 10*time.Second, func(s string) bool { return strings.Contains(s, QuestionContext) })
		_ = f.h.SendText(f.ctx, w.tui, "from-terminal")
		f.terminalSubmit(w.tui, "from-terminal")
		f.snap("both-answered-before-delivery", w.tui)
		_ = f.mock.Release("both")
		f.waitReplies(before + 1)
		time.Sleep(3 * time.Second)
		r = f.replies()
		f.recordJSON("both-replies-as-the-model-got-them", r[before:])
		f.snap("both-done", w.tui)
	})

	t.Run("unrelated input during the turn", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		before := len(f.replies())
		f.promptWorking(w.name, "MOCK:ask-free hold=unrelated")
		f.held("unrelated")
		q := f.questionItem(c, QuestionContext)
		f.waitScreen("unrelated-before", w.tui, 10*time.Second, func(s string) bool { return badge(s) == 1 })
		if err := f.steer(c, th, q.TurnID, "MOCK:say unrelated-from-bridge"); err != nil {
			t.Fatal(err)
		}
		f.mock.HoldNext(KindTurn, "unrelated-delivered")
		_ = f.mock.Release("unrelated")
		f.held("unrelated-delivered")
		time.Sleep(2 * time.Second)
		screen := f.snap("unrelated-delivered-turn-active", w.tui)
		f.record("unrelated-badge.txt", "badge after unrelated input was delivered, turn active: "+strconv.Itoa(badge(screen))+"\n")
		_ = f.mock.Release("unrelated-delivered")
		f.waitTurnCompleted(c, q.TurnID, 60*time.Second)
		f.snap("unrelated-done", w.tui)
		if len(f.replies()) != before {
			t.Errorf("unrelated input was taken as a reply")
		}
	})

	t.Run("a collapsed question's countdown", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		before := len(f.mock.Requests())
		f.promptWorking(w.name, "MOCK:ask-free hold=countdown")
		f.held("countdown")
		q := f.questionItem(c, QuestionContext)
		f.waitScreen("countdown-start", w.tui, 10*time.Second, func(s string) bool { return badge(s) == 1 })
		time.Sleep(20 * time.Second)
		f.snap("countdown-late", w.tui)
		time.Sleep(15 * time.Second)
		screen := f.snap("countdown-expired", w.tui)
		f.record("countdown-badge.txt", "badge 35s after the question: "+strconv.Itoa(badge(screen))+"\n")
		_ = f.mock.Release("countdown")
		f.waitTurnCompleted(c, q.TurnID, 60*time.Second)
		f.recordJSON("countdown-requests", summarize(f.mock.Requests()[before:]))
		f.snap("countdown-done", w.tui)
	})

	f.recordJSON("mock-requests", summarize(f.mock.Requests()))
}

// terminalSubmit presses Enter in the TUI's open question editor holding
// text (after the paste burst settles) and waits for the editor to close.
func (f *fx) terminalSubmit(pane, text string) {
	f.t.Helper()
	time.Sleep(time.Second)
	f.snap("terminal-answer-typed", pane)
	for range 3 {
		if err := f.h.SendKeys(f.ctx, pane, "enter"); err != nil {
			f.t.Fatal(err)
		}
		time.Sleep(1500 * time.Millisecond)
		if s, _ := f.h.Read(f.ctx, pane, "visible", 0); !strings.Contains(s, "enter submit") {
			break
		}
	}
	f.snap("terminal-answer-submitted", pane)
}

// summarize drops request bodies for evidence.
func summarize(reqs []Request) []map[string]any {
	var out []map[string]any
	for _, r := range reqs {
		out = append(out, map[string]any{"seq": r.Seq, "kind": r.Kind, "directive": r.Directive, "user": oneLine(r.UserText, 300), "call": r.CallID})
	}
	return out
}
