package server_test

import (
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// fakePrompts plays harness.Prompts: "codex" has rules, which turn "/grill"
// into "$grill" and drop an "@"; it records each ask.
type fakePrompts struct {
	mu    sync.Mutex
	asks  []string // "harness dir text"
	err   error
	block chan struct{}
}

func (f *fakePrompts) Rewrites(harness string) bool { return harness == "codex" }

func (f *fakePrompts) Translate(ctx context.Context, harness, dir, text string) (string, error) {
	f.mu.Lock()
	f.asks = append(f.asks, harness+" "+dir+" "+text)
	err, block := f.err, f.block
	f.mu.Unlock()
	if block != nil {
		select {
		case <-block:
		case <-ctx.Done():
			return text, ctx.Err()
		}
	}
	if err != nil {
		return text, err
	}
	// A quoted mention loses its marker and both quotes, as the real rule does.
	text = strings.ReplaceAll(text, `@"a"`, "a")
	return strings.ReplaceAll(strings.ReplaceAll(text, "/grill", "$grill"), "@", ""), nil
}

func (f *fakePrompts) Asks() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.asks)
}

func promptsBridge(t *testing.T, fp *fakePrompts) *termBridge {
	t.Helper()
	return startTermBridge(t, func(o *server.Options) { o.Prompts = fp },
		agentW("w1", "claude", "idle"), agentW("w2", "codex", "idle"), agentW("w3", "codex", "working"), agentW("w4", "claude", "working"))
}

// #138: a Codex worker gets $skill and bare paths, direct (idle) and queued
// (working); a Claude worker gets its text as typed, and the translator is
// not even asked.
func TestPromptIsTranslatedForCodexOnly(t *testing.T) {
	fp := &fakePrompts{}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := func(ws string) string { return idOf(t, snap, ws) }
	const typed = "use /grill on @src/a.go"
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: typed})
	tb.term.onTyped = nil
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w4"), Text: typed})
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w2"), Text: typed})
	_, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w3"), Text: typed + " again"})
	if m, _ := ack.Data.(map[string]any); m["queued"] != true {
		t.Fatalf("working codex: ack %+v", ack.Data)
	}
	want := []string{
		"type w1:p1 " + strconv.Quote(typed),
		"type w4:p1 " + strconv.Quote(typed),
		`submit w2:p1 "use $grill on src/a.go"`,
		`queue w3:p1 "use $grill on src/a.go again"`,
	}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls =\n%q\nwant\n%q", got, want)
	}
	// Asked for the worker's agent kind and checkout, Codex only.
	wantAsks := []string{"codex /home/u/w2 " + typed, "codex /home/u/w3 " + typed + " again"}
	if got := fp.Asks(); !slices.Equal(got, wantAsks) {
		t.Fatalf("asks = %q, want %q", got, wantAsks)
	}
	// The audit log still has what was sent by length, never the text.
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if strings.Contains(e.Args, "grill") {
			t.Errorf("audit row keeps the text: %s", e.Args)
		}
	}
}

// #140: a prompt that runs a terminal-only built-in (the harness's table,
// asked with what was typed) says so in its ack, direct or queued; any other
// prompt's ack has no "terminal".
func TestTerminalOnlyPromptSaysSoInItsAck(t *testing.T) {
	fp := &fakePrompts{}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := func(ws string) string { return idOf(t, snap, ws) }
	terminal := func(ws, text string) any {
		t.Helper()
		_, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id(ws), Text: text})
		m, _ := ack.Data.(map[string]any)
		return m["terminal"]
	}
	if got := terminal("w1", "/usage"); got != true {
		t.Errorf("/usage to idle claude: terminal %v", got)
	}
	tb.term.onTyped = nil
	if got := terminal("w4", "/model"); got != true {
		t.Errorf("/model to working claude: terminal %v", got)
	}
	if got := terminal("w4", "/model opus"); got != nil {
		t.Errorf("/model opus: terminal %v", got)
	}
	if got := terminal("w2", "/usage"); got != nil {
		t.Errorf("/usage to codex: terminal %v", got)
	}
}

// Two prompts to one worker are translated and sent in the order they came.
func TestTranslatedPromptsKeepTheirOrder(t *testing.T) {
	fp := &fakePrompts{block: make(chan struct{})}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w3")
	c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "a", Args: mustRaw(proto.WorkerPromptArgs{ID: id, Text: "/grill one"})})
	c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "b", Args: mustRaw(proto.WorkerPromptArgs{ID: id, Text: "/grill two"})})
	waitFor(t, "the first is being translated", func() bool { return len(fp.Asks()) == 1 })
	close(fp.block)
	for n := 0; n < 2; {
		if m := c.next(); m.env.T == proto.TAck {
			n++
		}
	}
	want := []string{`queue w3:p1 "$grill one"`, `queue w3:p1 "$grill two"`}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls = %q, want %q", got, want)
	}
}

// A lookup that fails never blocks a prompt: it goes as typed.
func TestPromptFailsOpen(t *testing.T) {
	fp := &fakePrompts{err: errors.New("catalog: timed out")}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w2")
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "use /grill on @a.go"})
	if got, want := tb.term.Calls(), []string{`submit w2:p1 "use /grill on @a.go"`}; !slices.Equal(got, want) {
		t.Fatalf("calls = %q, want %q", got, want)
	}
	// No translator at all: as typed too.
	tb2 := startTermBridge(t, nil, agentW("w2", "codex", "idle"))
	c2 := tb2.connect(proto.Hello{})
	c2.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: idOf(t, c2.snapshot(), "w2"), Text: "use /grill on @a.go"})
	if got, want := tb2.term.Calls(), []string{`submit w2:p1 "use /grill on @a.go"`}; !slices.Equal(got, want) {
		t.Fatalf("no translator: calls = %q, want %q", got, want)
	}
}

// The 16 KiB limit and the NUL rule apply to the translated text: a Codex
// text over the limit that translates under it goes; one that stays over is
// refused after translating, and nothing is sent. Claude's is not
// translated, so its limit is the typed one, at once.
func TestPromptLimitAppliesToTheTranslatedText(t *testing.T) {
	fp := &fakePrompts{}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	codex, claude := idOf(t, snap, "w2"), idOf(t, snap, "w1")

	shrinks := strings.Repeat("@ab ", 6000) // 24000 bytes, 18000 translated: still over
	if len(shrinks) <= herdr.MaxMessage {
		t.Fatal("test text is not over the limit")
	}
	fits := strings.Repeat("@a ", 6000) // 18000 bytes, 12000 translated
	if len(fits) <= herdr.MaxMessage || len(strings.ReplaceAll(fits, "@", "")) > herdr.MaxMessage {
		t.Fatal("test text does not shrink under the limit")
	}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: codex, Text: fits})
	if got := tb.term.Calls(); len(got) != 1 || got[0] != "submit w2:p1 "+strconv.Quote(strings.ReplaceAll(fits, "@", "")) {
		t.Fatalf("a text that fits once translated: %d calls", len(got))
	}
	n := len(tb.term.Calls())
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: codex, Text: shrinks}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: codex, Text: strings.Repeat("x", 4*herdr.MaxMessage+1)}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: codex, Text: "a\x00b"}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: claude, Text: fits}, proto.ErrBadRequest) // never translated
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: claude, Text: "x\x1b[2J"}, proto.ErrBadRequest)
	if got := len(tb.term.Calls()); got != n {
		t.Fatalf("a refused prompt reached herdr: %d calls, want %d", got, n)
	}
	// What the translator was asked: the two Codex texts it could shrink
	// (not the NUL one, not Claude's).
	if got := len(fp.Asks()); got != 2 {
		t.Fatalf("%d asks, want 2: %q", got, fp.Asks())
	}
}

// Dismissing a Codex dialog with a prompt: the prompt is the composer's, so
// it is translated like worker.prompt's.
func TestAnswerAskPromptIsTranslated(t *testing.T) {
	fp := &fakePrompts{}
	ab := startAskBridgeWith(t, "idle", func(o *server.Options) { o.Prompts = fp })
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w2")
	lines := strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")
	const three = "call_xQd1gbep11m9OuznwGJRfYFx"
	playDialog(ab.termBridge, "w2:p1", "q", map[string]string{"q": readScreen(t, "codex-ask-multi-first"), "gone": "• DONE\n"},
		map[string]map[string]string{"q": {"esc": "gone"}}, map[string]func(){"gone": func() { appendLine(t, ab.codex, lines[3]) }})
	appendLine(t, ab.codex, lines[2])
	askOf(c, id, pendingID(three))
	r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: three, Cancel: true, Prompt: "run /grill on @a.go"})
	if !r.Resolved || !r.Prompted {
		t.Fatalf("result %+v", r)
	}
	if calls := ab.term.Calls(); !slices.Equal(calls, []string{"keys w2:p1 esc", `submit w2:p1 "run $grill on a.go"`}) {
		t.Fatalf("calls %q", calls)
	}
}

// What the bridge builds itself is not rewritten, whatever the text holds:
// a follow-up's answers (their notes are free text) and a wrap-up's prompt.
func TestBridgeBuiltPromptsAreNotTranslated(t *testing.T) {
	t.Run("followup answers", func(t *testing.T) {
		fp := &fakePrompts{}
		fb := startFuBridgeWith(t, "", "", newFuRoles(), on(), "", func(o *server.Options) { o.Prompts = fp })
		c := fb.connect(proto.Hello{})
		c.snapshot()
		fb.turn(t, "codex", "followup_questions.jsonl")
		w := followupOf(c, fb.ids["w2"])
		c.mustAck(proto.CmdWorkerAnswerFollowup, proto.WorkerAnswerFollowupArgs{ID: fb.ids["w2"], TurnID: w.Followup.TurnID,
			Answers: []proto.FollowupAnswer{{ID: "q1", Value: "No"}, {ID: "q2", Value: "Wait for e2e-live", Note: "run /grill on @a.go"}}})
		var sent string
		for _, call := range fb.term.Calls() {
			if strings.HasPrefix(call, "submit w2:p1 ") {
				sent = call
			}
		}
		if !strings.Contains(sent, "run /grill on @a.go") {
			t.Fatalf("calls = %q: the answers were rewritten, or not sent", fb.term.Calls())
		}
		if asks := fp.Asks(); len(asks) != 0 {
			t.Fatalf("the translator was asked: %q", asks)
		}
	})
	t.Run("wrap-up", func(t *testing.T) {
		fp := &fakePrompts{}
		wb := startWrapBridge(t, "", "", func(o *server.Options) { o.Prompts = fp })
		c := wb.connect(proto.Hello{})
		c.snapshot()
		wb.arm(t, c, "w2", proto.FireKeep)
		wb.prompted(t, "w2:p1")
		if asks := fp.Asks(); len(asks) != 0 {
			t.Fatalf("the translator was asked: %q", asks)
		}
	})
}

// TerminalOnly plays harness.TerminalOnly for "/usage" and a bare "/model".
func (f *fakePrompts) TerminalOnly(harness, text string) bool {
	return harness == "claude" && (text == "/usage" || text == "/model")
}

func (f *fakePrompts) RetryKeys(harness, text string) []string {
	if harness == "codex" && strings.HasSuffix(strings.TrimRight(text, "."), "$grill") {
		return []string{"esc", "enter"}
	}
	return []string{"enter"}
}

// #138: a Codex prompt that ends in a $skill leaves its popup open, which
// takes the Enter (agent_prompt_stalled): the retry closes it first. Other
// stalled prompts get a lone Enter, as before.
func TestStalledPromptEndingInASkillPressesEscThenEnter(t *testing.T) {
	fp := &fakePrompts{}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w2")
	stalled := &herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000ms"}
	tb.term.onKeys = func(pane string, keys []string) { go tb.setStatus("w2", "working") }

	tb.term.submit = []error{stalled}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "use /grill."})
	if want := []string{`submit w2:p1 "use $grill."`, "keys w2:p1 esc enter"}; !slices.Equal(tb.term.Calls(), want) {
		t.Fatalf("calls = %q, want %q", tb.term.Calls(), want)
	}

	tb.setStatus("w2", "idle")
	c.until(proto.EvWorkerStatus)
	tb.term.submit = []error{stalled}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "run /grill now"})
	if calls := tb.term.Calls(); calls[len(calls)-1] != "keys w2:p1 enter" {
		t.Fatalf("calls = %q: a prompt not ending in a skill gets a lone Enter", calls)
	}
}

// The limit is on the translated text, so the bound before translating must
// not refuse a text whose translation fits: a quoted mention shrinks to a
// quarter of itself (@"a" is a). Worker.prompt takes what fits at the bound,
// and refuses, without translating, what is beyond it.
func TestPromptSourceBoundNeverRefusesWhatFitsTranslated(t *testing.T) {
	fp := &fakePrompts{}
	tb := promptsBridge(t, fp)
	c := tb.connect(proto.Hello{})
	codex := idOf(t, c.snapshot(), "w2")

	quoted := strings.Repeat(`@"a" `, 7000)                           // 35000 bytes, 14000 translated
	atBound := strings.Repeat(`@"a"`, 4*herdr.MaxMessage/len(`@"a"`)) // exactly 4 x the limit, a quarter of it translated
	if len(quoted) <= 2*herdr.MaxMessage || len(atBound) != 4*herdr.MaxMessage {
		t.Fatalf("test texts: %d, %d bytes", len(quoted), len(atBound))
	}
	for _, text := range []string{quoted, atBound} {
		c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: codex, Text: text})
	}
	want := []string{
		"submit w2:p1 " + strconv.Quote(strings.Repeat("a ", 7000)),
		"submit w2:p1 " + strconv.Quote(strings.Repeat("a", herdr.MaxMessage)),
	}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls: %d, want the two translated texts", len(got))
	}
	// One byte beyond the bound: refused, and the translator is not asked.
	asks := len(fp.Asks())
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: codex, Text: atBound + "a"}, proto.ErrBadRequest)
	if got := len(fp.Asks()); got != asks || len(tb.term.Calls()) != len(want) {
		t.Fatalf("a text beyond the bound was translated or sent: %d asks (was %d), calls %q", got, asks, tb.term.Calls())
	}
}

// codexAsk is a Codex worker (w2) with a request_user_input dialog that a
// Cancel dismisses with esc.
func codexAsk(t *testing.T, fp *fakePrompts) (*askBridge, *client, string, string) {
	t.Helper()
	ab := startAskBridgeWith(t, "idle", func(o *server.Options) { o.Prompts = fp })
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w2")
	lines := strings.SplitAfter(fixture(t, "codex", "ask.jsonl"), "\n")
	const three = "call_xQd1gbep11m9OuznwGJRfYFx"
	playDialog(ab.termBridge, "w2:p1", "q", map[string]string{"q": readScreen(t, "codex-ask-multi-first"), "gone": "• DONE\n"},
		map[string]map[string]string{"q": {"esc": "gone"}}, map[string]func(){"gone": func() { appendLine(t, ab.codex, lines[3]) }})
	appendLine(t, ab.codex, lines[2])
	askOf(c, id, pendingID(three))
	return ab, c, id, three
}

// worker.answer_ask applies the same limit to the translated prompt as
// worker.prompt: a source over 16 KiB that translates under it is sent; one
// that does not fit translated, or is beyond the source bound, is refused
// before the dialog is touched.
func TestAnswerAskPromptLimitAppliesToTheTranslatedText(t *testing.T) {
	for name, text := range map[string]string{
		"4000 quoted mentions":   strings.Repeat(`@"a" `, 4000),
		"7000 quoted mentions":   strings.Repeat(`@"a" `, 7000),
		"exactly the bound":      strings.Repeat(`@"a"`, 4*herdr.MaxMessage/len(`@"a"`)),
		"over 16 KiB, shrinking": strings.Repeat("@a ", 6000),
	} {
		t.Run(name, func(t *testing.T) {
			fp := &fakePrompts{}
			ab, c, id, three := codexAsk(t, fp)
			r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: three, Cancel: true, Prompt: text})
			if !r.Resolved || !r.Prompted {
				t.Fatalf("result %+v", r)
			}
			sent, _ := fp.Translate(context.Background(), "codex", "", text)
			calls := ab.term.Calls()
			if len(calls) != 2 || calls[0] != "keys w2:p1 esc" || calls[1] != "submit w2:p1 "+strconv.Quote(sent) {
				t.Fatalf("%d calls, want esc then the translated text", len(calls))
			}
		})
	}
	for name, text := range map[string]string{
		"beyond the bound":          strings.Repeat("x", 4*herdr.MaxMessage+1),
		"too long once translated":  strings.Repeat("xxxx ", 5000),
		"beyond the bound, shrinks": strings.Repeat(`@"a" `, 14000),
	} {
		t.Run("refused: "+name, func(t *testing.T) {
			fp := &fakePrompts{}
			ab, c, id, three := codexAsk(t, fp)
			c.mustError(proto.CmdWorkerAnswerAsk, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: three, Cancel: true, Prompt: text}, proto.ErrBadRequest)
			if calls := ab.term.Calls(); len(calls) != 0 {
				t.Fatalf("a refused prompt touched the dialog: %q", calls)
			}
		})
	}
}

// A Codex prompt ending in a $skill that stalled: when the worker started
// meanwhile (it was only slow), the retry's Esc is not pressed: it would
// abort the turn that is running. When it did not, esc, enter go as before.
func TestStalledPromptRetryKeysAreSkippedOnceTheWorkerStarted(t *testing.T) {
	stalled := &herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000ms"}
	for name, statuses := range map[string][]string{
		"working":                {"working"},
		"started and done again": {"working", "idle"},
		"blocked":                {"blocked"},
	} {
		t.Run("late start: "+name, func(t *testing.T) {
			fp := &fakePrompts{}
			tb := promptsBridge(t, fp)
			c := tb.connect(proto.Hello{})
			id := idOf(t, c.snapshot(), "w2")
			watch := tb.connect(proto.Hello{})
			watch.snapshot()
			tb.term.submit = []error{stalled}
			tb.term.onStalled = func(string) { // herdr's start comes after its timeout
				for _, st := range statuses {
					tb.setStatus("w2", st)
					watch.until(proto.EvWorkerStatus)
				}
			}
			_, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "use /grill."})
			if want := []string{`submit w2:p1 "use $grill."`}; !slices.Equal(tb.term.Calls(), want) {
				t.Fatalf("calls = %q, want %q: no key after a late start", tb.term.Calls(), want)
			}
			if m, _ := ack.Data.(map[string]any); m["retried"] == true {
				t.Fatalf("ack %+v: nothing was pressed again", ack.Data)
			}
		})
	}
	t.Run("no late start", func(t *testing.T) {
		fp := &fakePrompts{}
		tb := promptsBridge(t, fp)
		c := tb.connect(proto.Hello{})
		id := idOf(t, c.snapshot(), "w2")
		tb.term.submit = []error{stalled}
		tb.term.onKeys = func(pane string, keys []string) { go tb.setStatus("w2", "working") }
		c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "use /grill."})
		if want := []string{`submit w2:p1 "use $grill."`, "keys w2:p1 esc enter"}; !slices.Equal(tb.term.Calls(), want) {
			t.Fatalf("calls = %q, want %q", tb.term.Calls(), want)
		}
	})
}

// The same guard on the dismiss-and-prompt route.
func TestAnswerAskStalledPromptRetryKeysAreSkippedOnceTheWorkerStarted(t *testing.T) {
	stalled := &herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000ms"}
	t.Run("late start", func(t *testing.T) {
		fp := &fakePrompts{}
		ab, c, id, three := codexAsk(t, fp)
		ab.term.submit = []error{stalled}
		watch := ab.connect(proto.Hello{})
		watch.snapshot()
		ab.term.onStalled = func(string) {
			ab.setStatus("w2", "working")
			for { // a status event, or an upsert (the ask went)
				ev := watch.event()
				if (ev.T == proto.EvWorkerStatus && ev.Status == "working") || (ev.T == proto.EvWorkerUpsert && ev.Worker.Status == "working") {
					break
				}
			}
		}
		r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: three, Cancel: true, Prompt: "run /grill"})
		if !r.Prompted {
			t.Fatalf("result %+v: it started, so it was prompted", r)
		}
		if want := []string{"keys w2:p1 esc", `submit w2:p1 "run $grill"`}; !slices.Equal(ab.term.Calls(), want) {
			t.Fatalf("calls = %q, want %q: no retry keys after a late start", ab.term.Calls(), want)
		}
	})
	t.Run("no late start", func(t *testing.T) {
		fp := &fakePrompts{}
		ab, c, id, three := codexAsk(t, fp)
		ab.term.submit = []error{stalled}
		r := answerAsk(t, c, proto.WorkerAnswerAskArgs{ID: id, ToolUseID: three, Cancel: true, Prompt: "run /grill"})
		if !r.Prompted {
			t.Fatalf("result %+v", r)
		}
		if want := []string{"keys w2:p1 esc", `submit w2:p1 "run $grill"`, "keys w2:p1 esc enter"}; !slices.Equal(ab.term.Calls(), want) {
			t.Fatalf("calls = %q, want %q", ab.term.Calls(), want)
		}
	})
}
