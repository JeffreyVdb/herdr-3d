package server_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

const (
	askSess   = "0a0b0c0d-5757-4575-8575-575757575751"
	codexSess = "01a0f1e6-d26a-7543-9ca9-a0add46b0f03"
)

// askBridge is a term bridge whose workers' transcripts are read: w1 a
// Claude agent (session askSess), w2 a Codex one (codexSess).
type askBridge struct {
	*termBridge
	claude, codex string // their transcript files
}

func startAskBridge(t *testing.T, status string) *askBridge {
	t.Helper()
	return startAskBridgeWith(t, status, nil)
}

// startAskBridgeWith is startAskBridge with a tweak of the options.
func startAskBridgeWith(t *testing.T, status string, tweak func(*server.Options)) *askBridge {
	t.Helper()
	dir := t.TempDir()
	w1 := agentW("w1", "claude", status)
	w1.AgentSession, w1.Harness = askSess, world.HarnessClaude
	w2 := agentW("w2", "codex", status)
	w2.AgentSession, w2.Harness = codexSess, world.HarnessCodex
	ab := &askBridge{claude: filepath.Join(dir, "claude", "-home-u-w1", askSess+".jsonl"),
		codex: filepath.Join(dir, "codex", "2026", "09", "30", "rollout-2026-09-30T12-40-31-"+codexSess+".jsonl")}
	writeTranscript(t, ab.claude, "")
	writeTranscript(t, ab.codex, `{"timestamp":"2026-09-30T10:40:31.000Z","type":"session_meta","payload":{"id":"`+codexSess+`","cwd":"/home/u/w2","cli_version":"0.159.2"}}`+"\n")
	ab.termBridge = startTermBridge(t, func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: filepath.Join(dir, "claude"), CodexSessions: filepath.Join(dir, "codex")},
			Interval: 20 * time.Millisecond}
		o.AskStepTimeout, o.AskResolveTimeout = 400*time.Millisecond, 2*time.Second
		if tweak != nil {
			tweak(o)
		}
	}, w1, w2)
	return ab
}

func askOf(c *client, id string, ok func(*proto.Ask) bool) *proto.Worker {
	c.t.Helper()
	return upsertFor(c, id, func(w *proto.Worker) bool { return ok(w.Ask) })
}

func pendingID(id string) func(*proto.Ask) bool {
	return func(a *proto.Ask) bool { return a != nil && a.ToolUseID == id }
}

func noAsk(a *proto.Ask) bool { return a == nil }

// dialog plays an agent's dialog on the fake terminal: a screen per state,
// the next state per key (or typed text), and what a state does on entry
// (the transcript recording the answer).
type dialog struct {
	mu    sync.Mutex
	tb    *termBridge
	pane  string
	state string
	next  map[string]map[string]string // state → key or "text" → state
	shown map[string]string            // state → screen
	enter map[string]func()
}

func playDialog(tb *termBridge, pane, start string, shown map[string]string, next map[string]map[string]string, enter map[string]func()) *dialog {
	d := &dialog{tb: tb, pane: pane, state: start, next: next, shown: shown, enter: enter}
	tb.term.setScreen(pane, shown[start])
	step := func(key string) {
		d.mu.Lock()
		to, ok := d.next[d.state][key]
		if ok {
			d.state = to
		}
		d.mu.Unlock()
		if !ok {
			return // a key the dialog ignores
		}
		tb.term.setScreen(pane, shown[to])
		if f := enter[to]; f != nil {
			f()
		}
	}
	tb.term.onKeys = func(p string, keys []string) {
		if p == pane {
			for _, k := range keys {
				step(k)
			}
		}
	}
	tb.term.onText = func(p, text string) {
		if p == pane {
			step("text:" + text)
		}
	}
	return d
}

var cursorRe = regexp.MustCompile(`^(\s*)(?:[❯›]\s)?(\s*)(\d{1,2})\.`)

// withCursor is a captured screen with its cursor (❯ Claude, › Codex) moved to
// numbered row n of the dialog's last menu.
func withCursor(screen, mark string, n int) string {
	lines := strings.Split(screen, "\n")
	last := 0
	for i, l := range lines {
		if strings.Contains(l, "Question ") || strings.Contains(l, "☐") || strings.Contains(l, "☒") {
			last = i
		}
	}
	for i := last; i < len(lines); i++ {
		l := lines[i]
		m := cursorRe.FindStringSubmatchIndex(l)
		if m == nil {
			continue
		}
		num := l[m[6]:m[7]]
		body := l[m[6]:]
		indent := strings.Repeat(" ", len([]rune(l[:m[6]]))-2)
		if num == itoa(n) {
			lines[i] = indent + mark + " " + body
		} else {
			lines[i] = indent + "  " + body
		}
	}
	return strings.Join(lines, "\n")
}

func answerAsk(t *testing.T, c *client, args proto.WorkerAnswerAskArgs) proto.AnswerAskResult {
	t.Helper()
	_, ack := c.mustAck(proto.CmdWorkerAnswerAsk, args)
	b, _ := json.Marshal(ack.Data)
	var r proto.AnswerAskResult
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func str(s string) *string { return &s }

// askNow is a worker's ask as a new connection's snapshot has it.
func (ab *askBridge) askNow(t *testing.T, id string) *proto.Ask {
	t.Helper()
	c := ab.connect(proto.Hello{})
	defer c.conn.CloseNow()
	for _, w := range c.snapshot().World.Workers {
		if w.ID == id {
			return w.Ask
		}
	}
	t.Fatalf("no worker %s", id)
	return nil
}

// AC1: an ask in the transcript is on the worker, snapshots included,
// whatever herdr says (idle here, as for a hire's named session), and goes
// in the upsert where its result is read; a prompt meanwhile is refused.
func TestAskFromTheTranscript(t *testing.T) {
	ab := startAskBridge(t, "idle")
	c := ab.connect(proto.Hello{})
	snap := c.snapshot()
	id := idOf(t, snap, "w1")

	appendLine(t, ab.claude, fixture(t, "claude", "ask_pending.jsonl"))
	w := askOf(c, id, pendingID("toolu_01FuqDRbauxtx9cAAmN3o8ex"))
	a := w.Ask
	if w.Status != "idle" || a.Source != proto.AskSourceTranscript || a.Agent != proto.AskClaude || len(a.Questions) != 1 ||
		a.Questions[0].Question != "Tea or coffee?" || a.Since != time.Date(2026, 9, 30, 11, 8, 43, 807e6, time.UTC).UnixMilli() {
		t.Fatalf("worker %+v, ask %+v", w, a)
	}
	for _, sw := range ab.connect(proto.Hello{}).snapshot().World.Workers {
		if sw.ID == id && (sw.Ask == nil || sw.Ask.ToolUseID != a.ToolUseID) {
			t.Fatalf("snapshot worker %+v", sw)
		}
	}
	// A status change keeps it.
	ab.setStatus("w1", "done")
	for {
		if ev := c.event(); (ev.T == proto.EvWorkerStatus && ev.ID == id) || (ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.Ask == nil) {
			if ev.T == proto.EvWorkerUpsert {
				t.Fatalf("the ask went with the status: %+v", ev.Worker)
			}
			break
		}
	}
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "hello"}, proto.ErrInvalidState)

	// Its result: the ask goes.
	appendLine(t, ab.claude, strings.Replace(fixtureLine(t, "claude", "ask.jsonl", 2), "toolu_014F63f4HMf8ayZ7AhNMC8Uh", a.ToolUseID, 1))
	askOf(c, id, noAsk)
	if calls := ab.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
}

// AC2/AC5: two questions, the second a multi-select, answered with the
// keys the dialog takes (2 picks Blue and moves on, 1 ticks Logs, → to
// the review, Enter), resolved once the transcript has the result.
func TestAnswerAskTwoQuestions(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	const tu = "toolu_01U8ZrKFNvqFNsavBe7a22df"
	playDialog(ab.termBridge, "w1:p1", "q1", map[string]string{
		"q1": readScreen(t, "claude-ask-two"), "q2": readScreen(t, "claude-ask-two-q2"), "q2-logs": readScreen(t, "claude-ask-two-q2-toggle"),
		"review": readScreen(t, "claude-ask-two-review"), "done": "● DONE\n",
	}, map[string]map[string]string{
		"q1": {"2": "q2"}, "q2": {"1": "q2-logs"}, "q2-logs": {"right": "review"}, "review": {"enter": "done"},
	}, map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 6)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 5))
	askOf(c, id, pendingID(tu))

	// Stale, bad and impossible answers first: nothing typed.
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: "toolu_other", Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}, {Question: 1, Choices: []int{1}}}}, proto.ErrStale)
	for name, as := range map[string][]proto.AskAnswerArg{
		"one missing":          {{Question: 0, Choices: []int{1}}},
		"twice the same":       {{Question: 0, Choices: []int{1}}, {Question: 0, Choices: []int{2}}},
		"two on single-select": {{Question: 0, Choices: []int{1, 2}}, {Question: 1, Choices: []int{1}}},
		"no such option":       {{Question: 0, Choices: []int{3}}, {Question: 1, Choices: []int{1}}},
		"nothing picked":       {{Question: 0}, {Question: 1, Choices: []int{1}}},
		"a choice and text":    {{Question: 0, Choices: []int{1}, Other: str("x")}, {Question: 1, Choices: []int{1}}},
		"a control character":  {{Question: 0, Other: str("a\x1b[2J")}, {Question: 1, Choices: []int{1}}},
		"a newline":            {{Question: 0, Other: str("a\nb")}, {Question: 1, Choices: []int{1}}},
		"blank text":           {{Question: 0, Other: str("  ")}, {Question: 1, Choices: []int{1}}},
	} {
		t.Run(name, func(t *testing.T) {
			c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: as}, proto.ErrBadRequest)
		})
	}
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Prompt: "x", Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}, {Question: 1, Choices: []int{1}}}}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: "nobody", ToolUseID: tu, Cancel: true}, proto.ErrUnknownWorker)
	if calls := ab.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}

	r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 1, Choices: []int{1}}, {Question: 0, Choices: []int{2}}}})
	if !r.Resolved || !slices.Equal(r.Sent, []string{"2", "1", "right", "enter"}) {
		t.Fatalf("result %+v", r)
	}
	if want := []string{"keys w1:p1 2", "keys w1:p1 1", "keys w1:p1 right", "keys w1:p1 enter"}; !slices.Equal(ab.term.Calls(), want) {
		t.Fatalf("calls %q", ab.term.Calls())
	}
	if a := ab.askNow(t, id); a != nil {
		t.Fatalf("still asking %+v", a)
	}
	// Answered: stale now.
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}, {Question: 1, Choices: []int{1}}}}, proto.ErrStale)
}

// AC5: a single-select question's typed answer (its digit focuses "Type
// something.", the text, Enter) and a multi-select one with Other (ticks,
// arrows to its row, the text, Enter to tick it, Tab to Submit, Enter,
// then the review). The audit keeps the text's length, never the text.
func TestAnswerAskOther(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")

	const single = "toolu_012vhFKJwCHqKoQ1THGwjkLk"
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{
		"q": withCursor(readScreen(t, "claude-ask-other-selected"), "❯", 1), "type": readScreen(t, "claude-ask-other-selected"),
		"typed": readScreen(t, "claude-ask-other-typed"), "done": "● Sparkling water it is.\n",
	}, map[string]map[string]string{"q": {"3": "type"}, "type": {"text:Sparkling water": "typed"}, "typed": {"enter": "done"}},
		map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 8)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 7))
	askOf(c, id, pendingID(single))
	r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single, Answers: []proto.AskAnswerArg{{Question: 0, Other: str("Sparkling water")}}})
	if !r.Resolved || !slices.Equal(r.Sent, []string{"3", "text", "enter"}) {
		t.Fatalf("result %+v", r)
	}
	if a := ab.askNow(t, id); a != nil {
		t.Fatalf("still asking %+v", a)
	}

	// Multi-select with Other, from a fresh dialog: the typed row starts unticked.
	const multi = "toolu_01Bv5Gi7N62h8M1EKWjquU1S"
	base := readScreen(t, "claude-ask-multi-other-digit1") // Logs ticked, the cursor on 1
	typedUnticked := strings.Replace(withCursor(readScreen(t, "claude-ask-multi-other-focused-text"), "❯", 4), "[✔] Custom dashboards", "[ ] Custom dashboards", 1)
	ab.term.mu.Lock()
	ab.term.calls = nil
	ab.term.mu.Unlock()
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{
		"q": readScreen(t, "claude-ask-multi-other"), "logs": base, "c2": withCursor(base, "❯", 2), "c3": withCursor(base, "❯", 3),
		"c4": strings.Replace(withCursor(base, "❯", 4), "[ ] Type something", "[ ] Type something", 1), "typed": typedUnticked,
		"ticked": withCursor(readScreen(t, "claude-ask-multi-other-focused-text"), "❯", 4), "submit": readScreen(t, "claude-ask-multi-other-submit-row"),
		"review": readScreen(t, "claude-ask-multi-other-review"), "done": "● DONE\n",
	}, map[string]map[string]string{
		"q": {"1": "logs"}, "logs": {"down": "c2"}, "c2": {"down": "c3"}, "c3": {"down": "c4"}, "c4": {"text:Custom dashboards": "typed"},
		"typed": {"enter": "ticked"}, "ticked": {"tab": "submit"}, "submit": {"enter": "review"}, "review": {"enter": "done"},
	}, map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask_multi_other.jsonl", 1)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask_multi_other.jsonl", 0))
	askOf(c, id, pendingID(multi))
	r = answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: multi, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}, Other: str("Custom dashboards")}}})
	if want := []string{"1", "down", "down", "down", "text", "enter", "tab", "enter", "enter"}; !r.Resolved || !slices.Equal(r.Sent, want) {
		t.Fatalf("result %+v, want sent %q", r, want)
	}
	for _, call := range ab.term.Calls() {
		if strings.HasPrefix(call, "keys ") && len(strings.Fields(call)) > 3 {
			t.Errorf("several keys in one call: %q", call) // a batch of digits was dropped live
		}
	}
	log, err := ab.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := 0
	for _, e := range log {
		if e.Cmd != proto.CmdWorkerAnswerAsk {
			continue
		}
		found++
		if strings.Contains(e.Args+e.Result, "Custom dashboards") || strings.Contains(e.Args+e.Result, "Sparkling") {
			t.Errorf("the audit kept the text: %s %s", e.Args, e.Result)
		}
		if !strings.Contains(e.Args, `"other_bytes":`) {
			t.Errorf("audit args %s", e.Args)
		}
	}
	if found != 2 {
		t.Errorf("%d audit rows", found)
	}
}

// AC4: the dialog not where it should be is input_failed, with nothing
// pressed; answered in the terminal meanwhile (the transcript records it
// before the next key) is stale, and no more keys go.
func TestAnswerAskChecksTheScreen(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	const tu = "toolu_01U8ZrKFNvqFNsavBe7a22df"
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 5))
	askOf(c, id, pendingID(tu))
	both := []proto.AskAnswerArg{{Question: 0, Choices: []int{2}}, {Question: 1, Choices: []int{1}}}

	// Another dialog on the screen (a permission prompt): nothing pressed.
	ab.term.setScreen("w1:p1", readScreen(t, "claude-permission-bash"))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: both}, proto.ErrInputFailed)
	// The dialog on its second question already: nothing pressed either.
	ab.term.setScreen("w1:p1", readScreen(t, "claude-ask-two-q2"))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: both}, proto.ErrInputFailed)
	if calls := ab.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}

	// The first key lands, then the terminal answers it all: stale, one key sent.
	playDialog(ab.termBridge, "w1:p1", "q1", map[string]string{"q1": readScreen(t, "claude-ask-two"), "q2": "● answered elsewhere\n"},
		map[string]map[string]string{"q1": {"2": "q2"}}, map[string]func(){"q2": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 6)) }})
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: both}, proto.ErrStale)
	if calls := ab.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 2"}) {
		t.Fatalf("calls %q", calls)
	}
	if a := ab.askNow(t, id); a != nil {
		t.Fatalf("still asking %+v", a)
	}
}

// Esc, then the prompt once the transcript has the rejection and herdr
// sees the agent idle (#95: typed into Claude).
func TestAnswerAskCancelWithAPrompt(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	const tu = "toolu_01UYJ8PfzgPp69vD6PS9cA2K"
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{"q": readScreen(t, "claude-ask-esc"), "gone": "  ⎿  User declined to answer questions\n"},
		map[string]map[string]string{"q": {"esc": "gone"}}, map[string]func(){"gone": func() {
			appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 12)+fixtureLine(t, "claude", "ask.jsonl", 13))
			go func() { time.Sleep(100 * time.Millisecond); ab.setStatus("w1", "idle") }() // herdr a moment later
		}})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 11))
	askOf(c, id, pendingID(tu))
	r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true, Prompt: "Let's talk about it first."})
	if !r.Resolved || !r.Prompted || !slices.Equal(r.Sent, []string{"esc"}) {
		t.Fatalf("result %+v", r)
	}
	if calls := ab.term.Calls(); !slices.Equal(calls, []string{"keys w1:p1 esc", `type w1:p1 "Let's talk about it first."`}) {
		t.Fatalf("calls %q", calls)
	}
}

// AC6: Codex: a digit per question; Other is the arrows to "None of the
// above", Enter (its notes), the text, Enter.
func TestAnswerAskCodex(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w2")
	lines := strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")

	const three = "call_xQd1gbep11m9OuznwGJRfYFx"
	playDialog(ab.termBridge, "w2:p1", "q1", map[string]string{"q1": readScreen(t, "codex-ask-multi-first"), "q2": readScreen(t, "codex-ask-multi-second"),
		"q3": readScreen(t, "codex-ask-multi-third"), "done": "• DONE\n"},
		map[string]map[string]string{"q1": {"1": "q2"}, "q2": {"2": "q3"}, "q3": {"1": "done"}},
		map[string]func(){"done": func() { appendLine(t, ab.codex, lines[3]) }})
	appendLine(t, ab.codex, lines[2])
	askOf(c, id, pendingID(three))
	r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: three, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}, {Question: 1, Choices: []int{2}}, {Question: 2, Choices: []int{1}}}})
	if !r.Resolved || !slices.Equal(r.Sent, []string{"1", "2", "1"}) {
		t.Fatalf("result %+v", r)
	}
	if a := ab.askNow(t, id); a != nil {
		t.Fatalf("still asking %+v", a)
	}
	// No multi-select on Codex.
	const other = "call_fLK98VtFQnWLvYRk0fcH9SZH"
	appendLine(t, ab.codex, lines[4])
	askOf(c, id, pendingID(other))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: other, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1, 2}}}}, proto.ErrBadRequest)

	pending := readScreen(t, "codex-ask-other-pending")
	playDialog(ab.termBridge, "w2:p1", "c1", map[string]string{"c1": pending, "c2": withCursor(pending, "›", 2), "c3": withCursor(pending, "›", 3),
		"notes": readScreen(t, "codex-ask-other-notes"), "typed": readScreen(t, "codex-ask-other-typed"), "done": "• DONE\n"},
		map[string]map[string]string{"c1": {"down": "c2"}, "c2": {"down": "c3"}, "c3": {"enter": "notes"}, "notes": {"text:Use a local file instead.": "typed"},
			"typed": {"enter": "done"}},
		map[string]func(){"done": func() { appendLine(t, ab.codex, lines[5]) }})
	r = answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: other, Answers: []proto.AskAnswerArg{{Question: 0, Other: str("Use a local file instead.")}}})
	if !r.Resolved || !slices.Equal(r.Sent, []string{"down", "down", "enter", "text", "enter"}) {
		t.Fatalf("result %+v", r)
	}
	if a := ab.askNow(t, id); a != nil {
		t.Fatalf("still asking %+v", a)
	}
}

// AC4: Dismiss presses Esc only on the ask's own dialog. The transcript
// still has the old ask while the terminal shows another question: stale,
// nothing pressed (Claude and Codex).
func TestAnswerAskCancelChecksTheDialog(t *testing.T) {
	ab := startAskBridge(t, "idle")
	c := ab.connect(proto.Hello{})
	snap := c.snapshot()
	id, codex := idOf(t, snap, "w1"), idOf(t, snap, "w2")
	const tu = "toolu_01FuqDRbauxtx9cAAmN3o8ex"
	appendLine(t, ab.claude, fixture(t, "claude", "ask_pending.jsonl")) // Tea or coffee?
	askOf(c, id, pendingID(tu))
	playDialog(ab.termBridge, "w1:p1", "other", map[string]string{"other": readScreen(t, "claude-ask-chat"), "gone": "❯ \n"},
		map[string]map[string]string{"other": {"esc": "gone"}}, nil) // Which approach?
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true}, proto.ErrStale)
	// Same question, other options: not it either.
	ab.term.setScreen("w1:p1", strings.Replace(strings.Replace(readScreen(t, "claude-ask-single"), "1. Tea", "1. Chai", 1), "2. Coffee", "2. Mocha", 1))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true}, proto.ErrStale)

	const three = "call_xQd1gbep11m9OuznwGJRfYFx"
	appendLine(t, ab.codex, strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")[2]) // Which color? (1/3)
	askOf(c, codex, pendingID(three))
	ab.term.setScreen("w2:p1", readScreen(t, "codex-ask-single")) // Which color should the fixture use? (1/1)
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: codex, ToolUseID: three, Cancel: true}, proto.ErrStale)
	if calls := ab.term.Calls(); len(calls) != 0 {
		t.Fatalf("pressed %q", calls)
	}
	// Its own dialog: Esc.
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{"q": readScreen(t, "claude-ask-single"), "gone": "❯ \n"},
		map[string]map[string]string{"q": {"esc": "gone"}}, nil)
	if r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true}); !slices.Equal(r.Sent, []string{"esc"}) {
		t.Fatalf("result %+v", r)
	}
}

// AC2: the terminal records what was sent, whatever the dialog held: an
// Other ticked before is unticked when the answer has none (its digit);
// Other text typed before is emptied (ctrl+e, ctrl+u) before the answer's
// is typed; on a single-select question the arrows go to such a row (its
// digit would submit the old text).
func TestAnswerAskReconcilesOther(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	const multi = "toolu_01Bv5Gi7N62h8M1EKWjquU1S"
	focused := readScreen(t, "claude-ask-multi-other-focused-text") // Logs and "Custom dashboards" ticked
	start := withCursor(focused, "❯", 1)
	review := readScreen(t, "claude-ask-multi-other-review")
	reset := func() {
		ab.term.mu.Lock()
		ab.term.calls = nil
		ab.term.mu.Unlock()
	}

	// Named options only: Other unticked (its text stays, as live).
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{
		"q": start, "unticked": strings.Replace(start, "[✔] Custom dashboards", "[ ] Custom dashboards", 1),
		"review": strings.Replace(review, "→ Logs, Custom dashboards", "→ Logs", 1), "done": "● DONE\n",
	}, map[string]map[string]string{"q": {"4": "unticked"}, "unticked": {"right": "review"}, "review": {"enter": "done"}},
		map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask_multi_other.jsonl", 1)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask_multi_other.jsonl", 0))
	askOf(c, id, pendingID(multi))
	r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: multi, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}})
	if want := []string{"4", "right", "enter"}; !r.Resolved || !slices.Equal(r.Sent, want) {
		t.Fatalf("result %+v, want sent %q", r, want)
	}

	// Other text of its own: emptied, then typed (typing ticks it).
	reset()
	emptied := withCursor(readScreen(t, "claude-ask-multi-other-digit1"), "❯", 4) // Logs ticked, "[ ] Type something"
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{
		"q": start, "c2": withCursor(focused, "❯", 2), "c3": withCursor(focused, "❯", 3), "c4": focused, "emptied": emptied,
		"typed": strings.Replace(focused, "Custom dashboards", "Grafana", 1), "submit": readScreen(t, "claude-ask-multi-other-submit-row"),
		"review": strings.Replace(review, "Custom dashboards", "Grafana", 1), "done": "● DONE\n",
	}, map[string]map[string]string{
		"q": {"down": "c2"}, "c2": {"down": "c3"}, "c3": {"down": "c4"}, "c4": {"ctrl+u": "emptied"}, "emptied": {"text:Grafana": "typed"},
		"typed": {"tab": "submit"}, "submit": {"enter": "review"}, "review": {"enter": "done"},
	}, map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask_multi_other.jsonl", 1)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask_multi_other.jsonl", 0))
	askOf(c, id, pendingID(multi))
	r = answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: multi, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}, Other: str("Grafana")}}})
	if want := []string{"down", "down", "down", "ctrl+e", "ctrl+u", "text", "tab", "enter", "enter"}; !r.Resolved || !slices.Equal(r.Sent, want) {
		t.Fatalf("result %+v, want sent %q", r, want)
	}

	// Single-select, "Sparkling water" typed and left: arrows, emptied, typed, Enter.
	reset()
	const single = "toolu_012vhFKJwCHqKoQ1THGwjkLk"
	typed := readScreen(t, "claude-ask-other-typed") // the cursor on "3. Sparkling water"
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{
		"q": withCursor(typed, "❯", 1), "c2": withCursor(typed, "❯", 2), "c3": typed, "emptied": readScreen(t, "claude-ask-other-selected"),
		"juice": strings.Replace(typed, "Sparkling water", "Juice", 1), "done": "● Juice it is.\n",
	}, map[string]map[string]string{
		"q": {"down": "c2", "3": "done"}, "c2": {"down": "c3"}, "c3": {"ctrl+u": "emptied"}, "emptied": {"text:Juice": "juice"}, "juice": {"enter": "done"},
	}, map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 8)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 7))
	askOf(c, id, pendingID(single))
	r = answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single, Answers: []proto.AskAnswerArg{{Question: 0, Other: str("Juice")}}})
	if want := []string{"down", "down", "ctrl+e", "ctrl+u", "text", "enter"}; !r.Resolved || !slices.Equal(r.Sent, want) {
		t.Fatalf("result %+v, want sent %q", r, want)
	}

	// The cursor left on that row edits its text (a digit would be typed there, seen live): up first, then the digit.
	reset()
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{"q": typed, "c2": withCursor(typed, "❯", 2), "done": "● Tea it is.\n"},
		map[string]map[string]string{"q": {"up": "c2"}, "c2": {"1": "done"}},
		map[string]func(){"done": func() { appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 8)) }})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 7))
	askOf(c, id, pendingID(single))
	r = answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}})
	if want := []string{"up", "1"}; !r.Resolved || !slices.Equal(r.Sent, want) {
		t.Fatalf("result %+v, want sent %q", r, want)
	}
}

// AC4: the last key is checked too: a dialog still showing its question
// (or its review) after it is input_failed, not a sent answer.
func TestAnswerAskChecksTheLastKey(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	snap := c.snapshot()
	id, codex := idOf(t, snap, "w1"), idOf(t, snap, "w2")

	const tu = "toolu_01FuqDRbauxtx9cAAmN3o8ex"
	appendLine(t, ab.claude, fixture(t, "claude", "ask_pending.jsonl"))
	askOf(c, id, pendingID(tu))
	ab.term.setScreen("w1:p1", readScreen(t, "claude-ask-single")) // the digit ignored
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}}, proto.ErrInputFailed)

	const two = "toolu_01U8ZrKFNvqFNsavBe7a22df"
	playDialog(ab.termBridge, "w1:p1", "q1", map[string]string{
		"q1": readScreen(t, "claude-ask-two"), "q2": readScreen(t, "claude-ask-two-q2"), "q2-logs": readScreen(t, "claude-ask-two-q2-toggle"),
		"review": readScreen(t, "claude-ask-two-review"),
	}, map[string]map[string]string{"q1": {"2": "q2"}, "q2": {"1": "q2-logs"}, "q2-logs": {"right": "review"}}, nil) // Enter on the review ignored
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 5))
	askOf(c, id, pendingID(two))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: two, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{2}}, {Question: 1, Choices: []int{1}}}}, proto.ErrInputFailed)

	// Codex's notes open (in the terminal): a digit would go into them, none pressed.
	const other = "call_fLK98VtFQnWLvYRk0fcH9SZH"
	codexLines := strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")
	appendLine(t, ab.codex, codexLines[4])
	askOf(c, codex, pendingID(other))
	ab.term.setScreen("w2:p1", readScreen(t, "codex-ask-other-notes"))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: codex, ToolUseID: other, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}}, proto.ErrInputFailed)
	for _, call := range ab.term.Calls() {
		if strings.Contains(call, "w2:p1") {
			t.Fatalf("pressed %q", call)
		}
	}
	appendLine(t, ab.codex, codexLines[5]) // answered: the next ask is the three questions'

	const three = "call_xQd1gbep11m9OuznwGJRfYFx"
	playDialog(ab.termBridge, "w2:p1", "q1", map[string]string{"q1": readScreen(t, "codex-ask-multi-first"), "q2": readScreen(t, "codex-ask-multi-second"),
		"q3": readScreen(t, "codex-ask-multi-third")}, map[string]map[string]string{"q1": {"1": "q2"}, "q2": {"2": "q3"}}, nil) // the last digit ignored
	appendLine(t, ab.codex, strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")[2])
	askOf(c, codex, pendingID(three))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: codex, ToolUseID: three, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}, {Question: 1, Choices: []int{2}}, {Question: 2, Choices: []int{1}}}}, proto.ErrInputFailed)
}

// input_failed reaches the audit log and the server's log: its message
// names steps by number, never a question's, option's or typed text.
func TestAnswerAskErrorsKeepNoContent(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	const single = "toolu_012vhFKJwCHqKoQ1THGwjkLk"
	line := fixtureLine(t, "claude", "ask.jsonl", 7)
	for from, to := range map[string]string{"What should we drink?": "Should we use secret-ACCOUNT-123?", `"Tea"`: `"secret-OPTION-456"`} {
		if !strings.Contains(line, from) {
			t.Fatalf("fixture has no %s", from)
		}
		line = strings.ReplaceAll(line, from, to)
	}
	appendLine(t, ab.claude, line)
	askOf(c, id, pendingID(single))
	// An unrelated screen: fails before any key.
	ab.term.setScreen("w1:p1", "unrelated screen")
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{1}}}}, proto.ErrInputFailed)
	// The dialog, which never shows the typed text: fails after it.
	shown := strings.NewReplacer("What should we drink?", "Should we use secret-ACCOUNT-123?", "1. Tea", "1. secret-OPTION-456").Replace(readScreen(t, "claude-ask-other-selected"))
	ab.term.setScreen("w1:p1", withCursor(shown, "❯", 1))
	ab.term.onKeys = func(p string, keys []string) {
		if p == "w1:p1" && slices.Equal(keys, []string{"3"}) {
			ab.term.setScreen(p, shown)
		}
	}
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single, Answers: []proto.AskAnswerArg{{Question: 0, Other: str("secret-OTHER-789")}}}, proto.ErrInputFailed)
	log, err := ab.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var errs []string
	for _, a := range log {
		if a.Cmd != proto.CmdWorkerAnswerAsk {
			continue
		}
		errs = append(errs, a.Error)
		if !strings.Contains(a.Error, "input failed") {
			t.Errorf("audit error %q", a.Error)
		}
		for _, s := range []string{"secret-", "drink", "Tea"} {
			if strings.Contains(a.Args+a.Result+a.Error, s) {
				t.Errorf("the audit kept %q: %s %s %s", s, a.Args, a.Result, a.Error)
			}
		}
	}
	if len(errs) != 2 || !strings.Contains(errs[1], "keys sent: 3 text") {
		t.Errorf("audit errors %q", errs)
	}
}

// Review of #57: Dismiss on Claude's review presses Esc only when the
// review lists the ask's questions. A later ask with the same headers
// (Color, Extras) but other questions is stale, nothing pressed.
func TestAnswerAskCancelChecksTheReview(t *testing.T) {
	ab := startAskBridge(t, "idle")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	const tu = "toolu_01U8ZrKFNvqFNsavBe7a22df" // Which color? / Which extras?
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 5))
	askOf(c, id, pendingID(tu))
	other := strings.NewReplacer("Which color?", "Which color should production alerts use?",
		"Which extras?", "Which extras should the production dashboard expose?").Replace(readScreen(t, "claude-ask-two-review"))
	playDialog(ab.termBridge, "w1:p1", "other", map[string]string{"other": other, "gone": "❯ \n"},
		map[string]map[string]string{"other": {"esc": "gone"}}, nil)
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true}, proto.ErrStale)
	if calls := ab.term.Calls(); len(calls) != 0 {
		t.Fatalf("pressed %q", calls)
	}
	// Its own review: Esc.
	playDialog(ab.termBridge, "w1:p1", "review", map[string]string{"review": readScreen(t, "claude-ask-two-review"), "gone": "❯ \n"},
		map[string]map[string]string{"review": {"esc": "gone"}}, nil)
	if r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true}); !slices.Equal(r.Sent, []string{"esc"}) {
		t.Fatalf("result %+v", r)
	}
	// Answering: the other review after its questions is not submitted.
	playDialog(ab.termBridge, "w1:p1", "q1", map[string]string{
		"q1": readScreen(t, "claude-ask-two"), "q2": readScreen(t, "claude-ask-two-q2"), "q2-logs": readScreen(t, "claude-ask-two-q2-toggle"),
		"other": other, "gone": "❯ \n",
	}, map[string]map[string]string{"q1": {"2": "q2"}, "q2": {"1": "q2-logs"}, "q2-logs": {"right": "other"}, "other": {"enter": "gone"}}, nil)
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 0, Choices: []int{2}}, {Question: 1, Choices: []int{1}}}}, proto.ErrInputFailed)
	if calls := ab.term.Calls(); strings.HasSuffix(calls[len(calls)-1], "enter") {
		t.Fatalf("pressed %q", calls)
	}
}

// Review of #57: Codex's notes open already (in the terminal) on None of
// the above: Enter would submit what they hold. Other text there is
// input_failed, nothing pressed; empty, the answer's text goes in, then
// Enter; the answer's text already, Enter.
func TestAnswerAskCodexOtherWithNotesOpen(t *testing.T) {
	ab := startAskBridge(t, "blocked")
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w2")
	const tu = "call_fLK98VtFQnWLvYRk0fcH9SZH"
	lines := strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")
	typed := readScreen(t, "codex-ask-other-typed") // "Use a local file instead."
	playDialog(ab.termBridge, "w2:p1", "old", map[string]string{"old": typed, "gone": "• DONE\n"},
		map[string]map[string]string{"old": {"enter": "gone"}}, map[string]func(){"gone": func() { appendLine(t, ab.codex, lines[5]) }})
	appendLine(t, ab.codex, lines[4])
	askOf(c, id, pendingID(tu))
	c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 0, Other: str("Use the new production service.")}}}, proto.ErrInputFailed)
	if calls := ab.term.Calls(); len(calls) != 0 {
		t.Fatalf("pressed %q", calls)
	}

	for name, start := range map[string]string{"empty": "notes", "holding the text": "typed"} {
		playDialog(ab.termBridge, "w2:p1", start, map[string]string{"notes": readScreen(t, "codex-ask-other-notes"), "typed": typed, "done": "• DONE\n"},
			map[string]map[string]string{"notes": {"text:Use a local file instead.": "typed"}, "typed": {"enter": "done"}}, nil)
		r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Answers: []proto.AskAnswerArg{{Question: 0, Other: str("Use a local file instead.")}}})
		want := []string{"text", "enter"}
		if start == "typed" {
			want = want[1:]
		}
		if !slices.Equal(r.Sent, want) {
			t.Fatalf("%s: result %+v", name, r)
		}
	}
}
