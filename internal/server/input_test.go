package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func text(s string) proto.InputItem { return proto.InputItem{Text: &s} }
func key(k string) proto.InputItem  { return proto.InputItem{Key: &k} }

func agentW(ws, kind, status string) world.WorkerObs {
	w := worker(ws, "agent-"+ws, "sess-"+ws, status)
	w.AgentKind = kind
	return w
}

func TestKeysAreBatchedInOrder(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{
		text("echo "), text("h3d-✓ --help"), key("enter"), key("ctrl+c"), key("delete"), key("home"), text("x"),
		key("up"), key("f12"), text("1")}})
	want := []string{`text w1:p1 "echo h3d-✓ --help"`, "keys w1:p1 enter ctrl+c", "seq w1:p1 delete", "seq w1:p1 home",
		`text w1:p1 "x"`, "keys w1:p1 up f12", `text w1:p1 "1"`}
	if got := tb.term.Calls(); !slices.Equal(got, want) {
		t.Fatalf("calls =\n%q\nwant\n%q", got, want)
	}

	long := strings.Repeat("x", 4<<10)
	for _, input := range map[string][]proto.InputItem{
		"no items":             {},
		"65 items":             slices.Repeat([]proto.InputItem{key("up")}, 65),
		"both":                 {{Text: ptr("a"), Key: ptr("enter")}},
		"neither":              {{}},
		"unknown key":          {key("insert")},
		"a flag as a key":      {key("--help")},
		"two keys in one":      {key("ctrl+c up")},
		"a digit key":          {key("1")},
		"newline in text":      {text("ls\n")},
		"escape in text":       {text("\x1b[3~")},
		"empty text":           {text("")},
		"a 4097 byte text":     {text(long + "x")},
		"over 8 KiB in all":    {text(long), text(long), text("x")},
		"a C1 control in text": {text("a\u0085b")},
	} {
		c.mustError(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: input}, proto.ErrBadRequest)
	}
	c.mustError(proto.CmdWorkerKeys, map[string]any{"id": id, "input": []any{map[string]any{"text": "a", "paste": true}}},
		proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: "nobody", Input: []proto.InputItem{key("enter")}}, proto.ErrUnknownWorker)
	if n := len(tb.term.Calls()); n != len(want) {
		t.Fatalf("a refused command typed something: %q", tb.term.Calls()[len(want):])
	}
	// Two 4 KiB texts at the limit are fine.
	c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{text(long), text(long)}})

	// An asleep floor, a worker without a pane.
	tb.publishFloor(false)
	c.until(proto.EvFloorUpsert)
	c.mustError(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{key("enter")}}, proto.ErrInvalidState)
	tb.workers[0].PaneID = ""
	tb.publishFloor(true)
	c.until(proto.EvWorkerUpsert)
	c.mustError(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{key("enter")}}, proto.ErrInvalidState)
}

// Input to one worker is serialized: a second worker.keys waits for the
// first, however long herdr takes.
func TestInputToAWorkerIsSerialized(t *testing.T) {
	tb := startTermBridge(t, nil, shell("w1"), shell("w2"))
	gate := make(chan struct{})
	tb.term.textGate = gate
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id1, id2 := idOf(t, snap, "w1"), idOf(t, snap, "w2")
	send := func(req, id string, items ...proto.InputItem) {
		raw, _ := json.Marshal(proto.WorkerKeysArgs{ID: id, Input: items})
		c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: req, Args: raw})
	}
	send("a", id1, text("slow first"), key("enter"))
	send("b", id1, text("second"), key("enter"))
	send("c", id2, text("other worker"))
	// The other worker's input does not wait.
	waitFor(t, "w2 typed", func() bool { return slices.Contains(tb.term.Calls(), `text w2:p1 "other worker"`) })
	if calls := tb.term.Calls(); slices.Contains(calls, `text w1:p1 "second"`) {
		t.Fatalf("the second command went first: %q", calls)
	}
	close(gate)
	var acks []string
	for len(acks) < 3 {
		if m := c.next(); m.env.T == proto.TAck {
			acks = append(acks, m.env.ReqID)
		}
	}
	var w1 []string
	for _, call := range tb.term.Calls() {
		if strings.Contains(call, "w1:p1") {
			w1 = append(w1, call)
		}
	}
	if want := []string{`text w1:p1 "slow first"`, "keys w1:p1 enter", `text w1:p1 "second"`, "keys w1:p1 enter"}; !slices.Equal(w1, want) {
		t.Fatalf("w1 got %q", w1)
	}
	if i, j := slices.Index(acks, "a"), slices.Index(acks, "b"); i > j {
		t.Fatalf("acks %q", acks)
	}
}

// What a person types never reaches the audit log: its lengths and the
// key names do.
func TestInputIsAuditedWithoutTheText(t *testing.T) {
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{Client: "auditor"})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{text("hunter2 secret"), key("enter")}})
	c.mustError(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{text("secret\n"), key("secret-key")}},
		proto.ErrBadRequest)
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "the secret plan ✓"})
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "secret\x00"}, proto.ErrBadRequest)
	c.send(json.RawMessage(`{"t":"worker.keys","req_id":"x","args":{"id":"` + id + `","input":"secret"}}`))
	c.next()
	log, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, e := range log {
		row := e.Cmd + " " + e.Args + " " + e.Error + " " + e.Result
		if strings.Contains(row, "secret") || strings.Contains(row, "hunter2") {
			t.Errorf("typed text in the audit log: %s", row)
		}
		rows = append(rows, row)
	}
	if len(rows) != 5 || !strings.Contains(rows[0], `"input":[{"text_bytes":14},{"key":"enter"}]`) ||
		!strings.Contains(rows[1], `{"key":"(not a key, 10 bytes)"}`) || !strings.Contains(rows[2], `"text_bytes":19,"text_runes":17`) ||
		!strings.Contains(rows[4], `"redacted":true`) {
		t.Fatalf("audit rows:\n%s", strings.Join(rows, "\n"))
	}
}

func TestPrompt(t *testing.T) {
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"), shell("w2"), agentW("w3", "codex", "working"),
		agentW("w4", "claude", "blocked"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := func(ws string) string { return idOf(t, snap, ws) }
	var res proto.PromptResult
	ackData := func(ack proto.Ack) proto.PromptResult {
		b, _ := json.Marshal(ack.Data)
		var r proto.PromptResult
		_ = json.Unmarshal(b, &r)
		return r
	}

	// Idle: submitted, and herdr waited for it to start working.
	_, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: "--help me\nplease"})
	if res = ackData(ack); res != (proto.PromptResult{}) {
		t.Fatalf("idle: %+v", res)
	}
	// Working: queued for the next turn, without waiting.
	_, ack = c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w3"), Text: "next, the docs"})
	if res = ackData(ack); !res.Queued || res.Retried {
		t.Fatalf("working: %+v", res)
	}
	if want := []string{`submit w1:p1 "--help me\nplease"`, `queue w3:p1 "next, the docs"`}; !slices.Equal(tb.term.Calls(), want) {
		t.Fatalf("calls = %q", tb.term.Calls())
	}
	// A plain shell, a blocked agent, bad text.
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w2"), Text: "ls"}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w4"), Text: "go on"}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: ""}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: strings.Repeat("x", 16<<10+1)}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: "nobody", Text: "hi"}, proto.ErrUnknownWorker)
	c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: strings.Repeat("x", 16<<10)})

	// herdr failing the prompt otherwise is prompt_failed.
	tb.term.submit = []error{&herdr.APIError{Code: "timeout", Message: "timed out"}}
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id("w1"), Text: "hi"}, proto.ErrPromptFailed)
}

// The known herdr paste quirk: the text is in the agent's input but Enter
// was dropped (agent_prompt_stalled). One more Enter; submitted once the
// worker is working, else prompt_failed.
func TestPromptRetriesADroppedEnter(t *testing.T) {
	tb := startTermBridge(t, nil, agentW("w1", "claude", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	stalled := &herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000ms"}

	tb.term.submit = []error{stalled}
	tb.term.onKeys = func(pane string, keys []string) {
		if slices.Equal(keys, []string{"enter"}) {
			go tb.setStatus("w1", "working")
		}
	}
	_, ack := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "fix it"})
	if b, _ := json.Marshal(ack.Data); string(b) != `{"queued":false,"retried":true}` {
		t.Fatalf("ack = %s", b)
	}
	if want := []string{`submit w1:p1 "fix it"`, "keys w1:p1 enter"}; !slices.Equal(tb.term.Calls(), want) {
		t.Fatalf("calls = %q", tb.term.Calls())
	}

	// Enter again does not help either: prompt_failed, after one Enter.
	tb.setStatus("w1", "idle")
	c.until(proto.EvWorkerStatus)
	tb.term.onKeys = nil
	tb.term.submit = []error{stalled}
	start := time.Now()
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "fix it"}, proto.ErrPromptFailed)
	if took := time.Since(start); took < 300*time.Millisecond {
		t.Fatalf("gave up after %s, want PromptRetryWait", took)
	}
	if calls := tb.term.Calls(); len(calls) != 4 || calls[3] != "keys w1:p1 enter" {
		t.Fatalf("calls = %q", calls)
	}
}

func readScreen(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "screens", name+".txt"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func upsertFor(c *client, id string, ok func(*proto.Worker) bool) *proto.Worker {
	c.t.Helper()
	for {
		ev := c.event()
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ok(ev.Worker) {
			return ev.Worker
		}
	}
}

// A blocked worker gets its screen's question (read now, then every
// QuestionPoll while it stays blocked); it goes when the worker is no
// longer blocked. worker.answer re-reads the screen, refuses a stale
// hash, presses the choice's keys and waits for the worker to move on.
func TestQuestionsAndAnswers(t *testing.T) {
	tb := startTermBridge(t, nil, agentW("w1", "claude", "working"), agentW("w2", "claude", "working"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id, id2 := idOf(t, snap, "w1"), idOf(t, snap, "w2")
	tb.term.setScreen("w1:p1", readScreen(t, "claude-permission-bash"))

	tb.setStatus("w1", "blocked")
	if ev := c.until(proto.EvWorkerStatus); ev.Status != "blocked" {
		t.Fatalf("status = %+v", ev)
	}
	w := upsertFor(c, id, func(w *proto.Worker) bool { return w.Question != nil })
	q := w.Question
	if q.Kind != proto.QuestionPermission || q.Text != "Do you want to proceed?" || len(q.Choices) != 3 || q.Selected != 1 {
		t.Fatalf("question = %+v", q)
	}
	// In snapshots too.
	c2 := tb.connect(proto.Hello{})
	for _, sw := range c2.snapshot().World.Workers {
		if sw.ID == id && (sw.Question == nil || sw.Question.Hash != q.Hash) {
			t.Fatalf("snapshot worker = %+v", sw)
		}
	}
	// The screen changes while it stays blocked: a new question.
	tb.term.setScreen("w1:p1", readScreen(t, "claude-question"))
	w = upsertFor(c, id, func(w *proto.Worker) bool { return w.Question != nil && w.Question.Hash != q.Hash })
	q = w.Question
	if q.Kind != proto.QuestionChoice || q.Text != "Tea or coffee?" {
		t.Fatalf("second question = %+v", q)
	}

	// An old hash is stale, and so is an answer to a worker no longer
	// blocked; bad args are bad.
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: "0123456789abcdef", Choice: 1}, proto.ErrStale)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Choice: 5}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Choice: 1, Cancel: true}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: q.Hash}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: "XYZ", Choice: 1}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Choice: 10}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id2, Hash: q.Hash, Choice: 1}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: "nobody", Hash: q.Hash, Choice: 1}, proto.ErrUnknownWorker)
	if calls := tb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed: %q", calls)
	}

	// Choice 2: its digit; the worker goes on working, the question goes.
	tb.term.onKeys = func(pane string, keys []string) { go tb.setStatus("w1", "working") }
	answered := func(args proto.WorkerAnswerArgs, sent []string, resolved bool) []proto.Event {
		t.Helper()
		evs, ack := c.mustAck(proto.CmdWorkerAnswer, args)
		b, _ := json.Marshal(ack.Data)
		var r proto.AnswerResult
		if json.Unmarshal(b, &r) != nil || !slices.Equal(r.Sent, sent) || r.Resolved != resolved {
			t.Fatalf("answer = %s, want sent %q resolved %v", b, sent, resolved)
		}
		return evs
	}
	// The worker left blocked before the ack: its upsert (without the
	// question) came first.
	evs := answered(proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Choice: 2}, []string{"2"}, true)
	if i := slices.IndexFunc(evs, func(ev proto.Event) bool { return ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id }); i < 0 ||
		evs[i].Worker.Status != "working" || evs[i].Worker.Question != nil {
		t.Fatalf("events before the answer's ack: %+v", evs)
	}

	// The trust dialog: arrows and Enter. Cancel: Esc. Not resolved in
	// time: resolved false.
	tb.term.onKeys = nil
	tb.term.setScreen("w1:p1", readScreen(t, "claude-trust"))
	tb.setStatus("w1", "blocked")
	q = upsertFor(c, id, func(w *proto.Worker) bool { return w.Question != nil }).Question
	if q.Kind != proto.QuestionTrust || q.Choices[1].Label != "Yes, I trust this folder" {
		t.Fatalf("trust = %+v", q)
	}
	answered(proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Choice: 2}, []string{"down", "enter"}, false)
	answered(proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Cancel: true}, []string{"esc"}, false)
	if want := []string{"keys w1:p1 2", "keys w1:p1 down enter", "keys w1:p1 esc"}; !slices.Equal(tb.term.Calls(), want) {
		t.Fatalf("calls = %q", tb.term.Calls())
	}
	// A screen that cannot be read: no question, and an answer fails.
	tb.term.setScreen("w1:p1", "")
	tb.term.mu.Lock()
	delete(tb.term.screens, "w1:p1")
	tb.term.mu.Unlock()
	upsertFor(c, id, func(w *proto.Worker) bool { return w.Question == nil })
	c.mustError(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: id, Hash: q.Hash, Choice: 1}, proto.ErrInputFailed)
}

// Without a laptop herdr the commands fail and no screen is read.
func TestLaptopsNotConfigured(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	b.floor("s", true, agentW("w1", "claude", "blocked"))
	c := b.connect(proto.Hello{})
	snap := c.snapshot()
	if len(snap.World.Workers) == 0 {
		c.until(proto.EvWorkerUpsert)
		snap = b.connect(proto.Hello{}).snapshot()
	}
	id := idOf(t, snap, "w1")
	c.mustError(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id}, proto.ErrInternal)
	c.mustError(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{key("enter")}}, proto.ErrInternal)
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "hi"}, proto.ErrInternal)
}
