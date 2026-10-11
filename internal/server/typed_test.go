package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #95: a prompt to Claude is typed (TypePrompt), never pasted with agent
// prompt: once the agent is idle or done, then watched to start; to a
// working Claude it is typed for Claude to queue. Codex keeps agent
// prompt.
func TestPromptTypedToClaude(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"), agentW("w2", "claude", "working"),
		agentW("w3", "codex", "idle"), agentW("w4", "claude", "unknown"), agentW("w5", "claude", "done"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := func(ws string) string { return idOf(t, snap, ws) }
	result := func(ack proto.Ack) proto.PromptResult {
		b, _ := json.Marshal(ack.Data)
		var r proto.PromptResult
		_ = json.Unmarshal(b, &r)
		return r
	}

	// Idle and done: typed (the bridge does not normalize: Control does),
	// acked by the agent starting.
	long := "/write-code https://github.com/JeffreyVdb/herdr-3d/issues/95\r\n\tTeam:\r\n" + strings.Repeat("- a line of the team\n", 60)
	if _, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: long}); result(ack) != (proto.PromptResult{}) {
		t.Fatalf("idle: %+v", result(ack))
	}
	if _, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w5"), Text: "next"}); result(ack) != (proto.PromptResult{}) {
		t.Fatalf("done: %+v", result(ack))
	}
	// Working: typed for Claude to queue, without waiting.
	tb.term.onTyped = nil
	if _, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w2"), Text: "then the docs"}); !result(ack).Queued {
		t.Fatalf("working: %+v", result(ack))
	}
	// Codex: agent prompt, as before.
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w3"), Text: "\tcodex\r\n"})
	want := []string{"type w1:p1 " + strconv.Quote(long), `type w5:p1 "next"`, `type w2:p1 "then the docs"`, `submit w3:p1 "\tcodex\r\n"`}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls =\n%q\nwant\n%q", got, want)
	}

	// Not ready (herdr does not know its state yet): waited for, up to
	// PromptReadyWait; typed once it is idle.
	n := len(tb.term.Calls())
	start := time.Now()
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w4"), Text: "hi"}, proto.ErrPromptFailed)
	if took := time.Since(start); took < 300*time.Millisecond || len(tb.term.Calls()) != n {
		t.Fatalf("not ready: gave up after %s, calls %q", took, tb.term.Calls()[n:])
	}
	tb.term.onTyped = func(pane string) { tb.takeTurn(pane) }
	go func() { time.Sleep(100 * time.Millisecond); tb.setStatus("w4", "idle") }()
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w4"), Text: "hi"})
	if got := tb.term.Calls()[n:]; !slices.Equal(got, []string{`type w4:p1 "hi"`}) {
		t.Fatalf("calls = %q", got)
	}

	// What cannot be typed is refused before anything is typed: control
	// characters other than line ends and tabs, blank text, and text over
	// the cap as typed (a tab is four spaces).
	n = len(tb.term.Calls())
	for name, text := range map[string]string{
		"escape":    "go \x1b[3~",
		"bell":      "go \a",
		"C1":        "go \u009b",
		"backspace": "go\b",
		"blank":     " \r\n\t",
		"tabs":      strings.Repeat("\t", herdr.MaxMessage/4) + "x",
	} {
		c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: text}, proto.ErrBadRequest)
		_ = name
	}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: strings.Repeat("\t", herdr.MaxMessage/4-1) + "x"})
	if got := tb.term.Calls()[n:]; len(got) != 1 {
		t.Fatalf("calls = %q", got)
	}
	// Codex takes what agent prompt takes, as before.
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w3"), Text: "go \x1b[3~"})
}

// The Enter after a typed prompt is dropped (Claude just started): one
// more Enter; acked once the worker started, else prompt_failed.
func TestPromptTypedRetriesADroppedEnter(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	tb.term.onTyped = nil
	tb.term.onKeys = func(pane string, keys []string) {
		if slices.Equal(keys, []string{"enter"}) {
			tb.takeTurn(pane)
		}
	}
	_, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "fix it"})
	if b, _ := json.Marshal(ack.Data); string(b) != `{"queued":false,"retried":true}` {
		t.Fatalf("ack = %s", b)
	}
	if want := []string{`type w1:p1 "fix it"`, "keys w1:p1 enter"}; !slices.Equal(tb.term.Calls(), want) {
		t.Fatalf("calls = %q", tb.term.Calls())
	}
	// Enter again does not help either.
	tb.term.onKeys = nil
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "fix it"}, proto.ErrPromptFailed)
	if calls := tb.term.Calls(); len(calls) != 4 || calls[3] != "keys w1:p1 enter" {
		t.Fatalf("calls = %q", calls)
	}
}

// A typed prompt is several herdr calls: it holds the worker's input lane,
// so a laptop's keys cannot land between two of its chunks.
func TestPromptTypedHoldsTheLane(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	gate, typing := make(chan struct{}), make(chan struct{})
	tb.term.onPrompt = func(pane, how string) { close(typing); <-gate }
	b, _ := json.Marshal(proto.WorkerPromptArgs{ID: id, Text: "a long prompt"})
	c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "p", Args: b})
	<-typing
	b, _ = json.Marshal(proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{text("x")}})
	c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "k", Args: b})
	time.Sleep(100 * time.Millisecond)
	if calls := tb.term.Calls(); !slices.Equal(calls, []string{`type w1:p1 "a long prompt"`}) {
		t.Fatalf("calls while typing = %q", calls)
	}
	close(gate)
	for acks := 0; acks < 2; {
		if m := c.next(); m.env.T == proto.TAck {
			acks++
		} else if m.env.T == proto.TError {
			t.Fatalf("error: %s", m.raw)
		}
	}
	if calls := tb.term.Calls(); !slices.Equal(calls, []string{`type w1:p1 "a long prompt"`, `text w1:p1 "x"`}) {
		t.Fatalf("calls = %q", calls)
	}
}

// #95 R1: a typed prompt that fails once it began typing leaves part of
// it in Claude's input box. It is erased at once, on the lane (before any
// other input), so a retry is not appended to it; an error that typed
// nothing erases nothing.
func TestPartlyTypedPromptIsErased(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	tb.term.typeErrs = []error{&herdr.PartlyTypedError{Erase: 42, Err: errors.New("typing part 2 of 3: exit status 1")}}
	_, m := c.command(proto.CmdWorkerPrompt, "p1", proto.WorkerPromptArgs{ID: id, Text: "/write-code my secret plan"})
	if m.env.T != proto.TError || !strings.Contains(string(m.raw), proto.ErrPromptFailed) || strings.Contains(string(m.raw), "secret") {
		t.Fatalf("reply = %s", m.raw)
	}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "/write-code my secret plan"})
	want := []string{`type w1:p1 "/write-code my secret plan"`, "erase w1:p1 42", `type w1:p1 "/write-code my secret plan"`}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls =\n%q\nwant\n%q", got, want)
	}

	// Refused before typing (nothing in the box): nothing to erase.
	n := len(tb.term.Calls())
	tb.term.typeErrs = []error{fmt.Errorf("%w: invalid prompt to type", herdr.ErrNotAllowed)}
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "go"}, proto.ErrPromptFailed)
	if got := tb.term.Calls()[n:]; !slices.Equal(got, []string{`type w1:p1 "go"`}) {
		t.Fatalf("calls = %q", got)
	}
}

// When the erase fails too, the worker's input is dirty: the next prompt
// erases first, and is refused (nothing typed) while that fails.
func TestPartlyTypedPromptNotErasedBlocksTheNext(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	down := errors.New("herdr control send-keys: exit status 1")
	tb.term.typeErrs = []error{&herdr.PartlyTypedError{Erase: 7, Err: errors.New("typing part 2 of 2: exit status 1")}}
	tb.term.eraseErrs = []error{down, down}
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "first"}, proto.ErrPromptFailed)
	_, m := c.command(proto.CmdWorkerPrompt, "p2", proto.WorkerPromptArgs{ID: id, Text: "second"})
	if m.env.T != proto.TError || !strings.Contains(string(m.raw), proto.ErrPromptFailed) ||
		!strings.Contains(string(m.raw), "part of an earlier prompt") {
		t.Fatalf("reply = %s", m.raw)
	}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "third"})
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "fourth"})
	want := []string{`type w1:p1 "first"`, "erase w1:p1 7", "erase w1:p1 7", "erase w1:p1 7", `type w1:p1 "third"`, `type w1:p1 "fourth"`}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls =\n%q\nwant\n%q", got, want)
	}
}

// Typing cut short by the bridge stopping (its context done) is still
// erased, with a context of its own.
func TestPartlyTypedPromptErasedWhenTheBridgeStops(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	typing := make(chan struct{})
	tb.term.typing = func(ctx context.Context) error {
		close(typing)
		<-ctx.Done()
		return &herdr.PartlyTypedError{Erase: 3, Err: ctx.Err()}
	}
	b, _ := json.Marshal(proto.WorkerPromptArgs{ID: id, Text: "a long prompt"})
	c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "p", Args: b})
	<-typing
	tb.stop()
	if got := tb.term.Calls(); !slices.Equal(got, []string{`type w1:p1 "a long prompt"`, "erase w1:p1 3"}) {
		t.Fatalf("calls = %q", got)
	}
}

// A Claude hire's first prompt is typed once herdr sees the agent idle,
// then Enter is pressed until it works; a Codex hire's goes with agent
// prompt.
func TestHireTypesClaudePrompt(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	a := hireArgs(0)
	a.Prompt = "/write-code https://github.com/JeffreyVdb/herdr-3d/issues/95\n\nTeam:\n- coders: claude"
	_, m := hb.c.command(proto.CmdWorkerHire, "h1", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); calls[len(calls)-1] != "type w1:p1 "+strconv.Quote(a.Prompt) ||
		slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "prompt ") }) {
		t.Fatalf("herdr calls = %q", calls)
	}

	// The first Enter is dropped (just past the trust dialog): Enter again.
	hb.fl.typeDrops = 1
	hb.fl.onKey = func(pane string, key herdr.Key) {
		if key == herdr.KeyEnter {
			hb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.Status = "working" })
		}
	}
	a.DeskIndex = ptr(1)
	_, m = hb.c.command(proto.CmdWorkerHire, "h2", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); !slices.Equal(calls[len(calls)-2:], []string{"type w2:p1 " + strconv.Quote(a.Prompt), "key w2:p1 enter"}) {
		t.Fatalf("herdr calls = %q", calls)
	}

	// It never works: not prompted.
	hb.fl.typeDrops, hb.fl.onKey = 1, nil
	a.DeskIndex = ptr(2)
	_, m = hb.c.command(proto.CmdWorkerHire, "h3", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || *res.Prompted || !strings.Contains(res.PromptError, "did not start") {
		t.Fatalf("ack = %s", m.raw)
	}

	// The agent is never ready (its state unknown): nothing is typed.
	hb.fl.startStatus = "unknown"
	n := len(hb.fl.Calls())
	a.DeskIndex = ptr(3)
	_, m = hb.c.command(proto.CmdWorkerHire, "h4", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || *res.Prompted || !strings.Contains(res.PromptError, "not ready") {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls()[n:]; slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "type ") }) {
		t.Fatalf("typed into an agent that was not ready: %q", calls)
	}
	// Ready a moment later: typed then.
	n = len(hb.fl.Calls())
	a.DeskIndex = ptr(4)
	go func() {
		for !slices.ContainsFunc(hb.fl.Calls()[n:], func(c string) bool { return strings.HasPrefix(c, "start-agent ") }) {
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(100 * time.Millisecond)
		hb.fl.update("w5", func(w *world.WorkerObs) { w.Status = "idle" })
	}()
	_, m = hb.c.command(proto.CmdWorkerHire, "h5", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	hb.fl.startStatus = ""

	// What Claude cannot be typed is refused before anything is hired.
	n = len(hb.fl.Calls())
	a.DeskIndex = ptr(5)
	for _, p := range []string{"go \x1b[3~", "go \u0085", strings.Repeat("\t", herdr.MaxPrompt/4) + "x"} {
		a.Prompt = p
		hb.c.mustError(proto.CmdWorkerHire, a, proto.ErrBadRequest)
	}
	if calls := hb.fl.Calls()[n:]; len(calls) != 0 {
		t.Fatalf("herdr calls = %q", calls)
	}

	// Codex: agent prompt, with what it took before.
	a.Harness, a.Model, a.Effort, a.Prompt = "codex", "gpt-6-astra", "ultra", "go \x1b[3~\r\n\tok"
	_, m = hb.c.command(proto.CmdWorkerHire, "h6", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); calls[len(calls)-1] != "prompt w6:p1 "+strconv.Quote(a.Prompt) {
		t.Fatalf("herdr calls = %q", calls)
	}

	// Typing fails part way (#95 R1): what it typed is erased, on the
	// lane, before the hire answers; not prompted.
	a = hireArgs(6)
	a.Prompt = "/write-code it"
	hb.fl.typeErrs = []error{&herdr.PartlyTypedError{Erase: 5, Err: errors.New("typing part 2 of 2: exit status 1")}}
	n = len(hb.fl.Calls())
	_, m = hb.c.command(proto.CmdWorkerHire, "h7", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || *res.Prompted || strings.Contains(res.PromptError, "write-code") {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls()[n:]; !slices.Contains(calls, "erase w7:p1 5") {
		t.Fatalf("herdr calls = %q", calls)
	}
}

// syncBuf is a log sink tests read while the hub writes.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// A typed prompt that reaches the transcript as a paste anyway (Claude
// Code's paste threshold changed) is logged as a warning; a person's own
// paste is not.
func TestTypedPromptArrivingAsAPasteIsLogged(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-9595-4595-8595-959595959595"
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	writeTranscript(t, path, fixture(t, "claude", "message.jsonl"))
	w1 := agentW("w1", "claude", "idle")
	w1.AgentSession, w1.Harness = sess, world.HarnessClaude
	logs := &syncBuf{}
	tb := startTermBridge(t, func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir}, Interval: 15 * time.Millisecond}
		o.Log = slog.New(slog.NewTextHandler(logs, nil))
	}, w1)
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	warned := func() bool { return strings.Contains(logs.String(), "reached Claude Code as a paste") }
	waitRounds := func() { time.Sleep(150 * time.Millisecond) }

	// A person pastes in the terminal: no warning.
	appendLine(t, path, claudeUser(t, "0a0b0c0d-0000-4000-8000-000000000001",
		"\n\n<pasted_content id=\"ab12\">\nsomething they copied\n</pasted_content id=\"ab12\">\n"))
	waitRounds()
	if warned() {
		t.Fatalf("warned of a person's paste:\n%s", logs.String())
	}
	// Typed as it should be: no warning.
	prompt := "Line one\r\n\tline two, " + strings.Repeat("long ", 200)
	tb.term.onPrompt = func(string, string) {
		appendLine(t, path, claudeUser(t, "0a0b0c0d-0000-4000-8000-000000000002", "Line one\n    line two, "+strings.Repeat("long ", 200)))
	}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: prompt})
	waitRounds()
	if warned() {
		t.Fatalf("warned of a typed prompt:\n%s", logs.String())
	}
	// The same prompt arrives as a paste: warned, once, without its text.
	tb.term.onPrompt = func(string, string) {
		for i := range 2 { // the queued prompt's attachment and its user line
			appendLine(t, path, claudeUser(t, fmt.Sprintf("0a0b0c0d-0000-4000-8000-00000000001%d", i),
				"\n\n<pasted_content id=\"9fa6\">\nLine one\n    line two, "+strings.Repeat("long ", 200)+"\n</pasted_content id=\"9fa6\">\n"))
		}
	}
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: prompt})
	deadline := time.Now().Add(3 * time.Second)
	for !warned() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	waitRounds()
	if n := strings.Count(logs.String(), "reached Claude Code as a paste"); n != 1 || strings.Contains(logs.String(), "line two") ||
		!strings.Contains(logs.String(), "worker="+id) {
		t.Fatalf("%d warnings:\n%s", n, logs.String())
	}
}
