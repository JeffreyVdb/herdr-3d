package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #224 agent handoffs against the wrap-up bridge (w1 Claude, w2 Codex, w3 a
// shell; real transcript files the usage tracker reads) with a handoff
// directory, a command catalog that lists the handoff skill and the
// translator's skill spelling. The fake agent is the test: it appends the
// transcript lines and writes the reserved file.

type agBridge struct {
	*wrapBridge
	hdir string
	cat  *skillCatalog
}

// skillCatalog plays harness.Catalog: the handoff skill unless missing,
// the built-ins only (partial) when failing.
type skillCatalog struct {
	mu      sync.Mutex
	missing bool
	partial bool
}

func (f *skillCatalog) Commands(_ context.Context, harness, dir string) (*proto.WorkerCommands, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.partial {
		return &proto.WorkerCommands{Commands: []proto.CommandEntry{{Name: "status", Kind: proto.CommandKindBuiltin}}, Partial: true}, nil
	}
	cmds := []proto.CommandEntry{{Name: "review", Kind: proto.CommandKindSkill}}
	if !f.missing {
		cmds = append(cmds, proto.CommandEntry{Name: "handoff", Kind: proto.CommandKindSkill})
	}
	return &proto.WorkerCommands{Commands: cmds}, nil
}

// startAgentBridge starts the bridge on db, transcripts under dir and the
// handoff directory hdir ("" each: new ones).
func startAgentBridge(t *testing.T, db, dir, hdir string, tweak func(*server.Options)) *agBridge {
	t.Helper()
	if db == "" {
		db = filepath.Join(t.TempDir(), "world.db")
	}
	if hdir == "" {
		hdir = filepath.Join(t.TempDir(), "handoff")
	}
	ab := &agBridge{hdir: hdir, cat: &skillCatalog{}}
	svc := hoService(t, hdir, db)
	ab.wrapBridge = startWrapBridge(t, db, dir, func(o *server.Options) {
		o.Handoffs = svc
		o.Commands = ab.cat
		o.Prompts = &fakePrompts{}
		o.AgentHandoffGrace = 400 * time.Millisecond
		if tweak != nil {
			tweak(o)
		}
	})
	return ab
}

var agentMarkerRe = regexp.MustCompile(`\(H3D-HANDOFF ([0-9a-f]{16})\)$`)

// requested is the handoff request the bridge sent to pane: its text, the
// reserved path and the nonce; ok false when none was sent.
func (ab *agBridge) requested(pane string) (text, path, nonce string, n int) {
	for _, c := range ab.term.Calls() {
		for _, how := range []string{"type ", "submit ", "queue "} {
			if q, ok := strings.CutPrefix(c, how+pane+" "); ok {
				var s string
				if json.Unmarshal([]byte(q), &s) == nil {
					if m := agentMarkerRe.FindStringSubmatch(s); m != nil {
						n++
						text, nonce = s, m[1]
						_, rest, _ := strings.Cut(s, "write it to ")
						path, _, _ = strings.Cut(rest, ".tmp first")
					}
				}
			}
		}
	}
	return text, path, nonce, n
}

func (ab *agBridge) mustRequest(t *testing.T, pane string) (text, path, nonce string) {
	t.Helper()
	var n int
	eventually(t, "the handoff request to "+pane, func() bool {
		text, path, nonce, n = ab.requested(pane)
		return n > 0
	})
	if n != 1 {
		t.Fatalf("%d requests sent to %s", n, pane)
	}
	return text, path, nonce
}

// claudeTurn is Claude Code's record of the request: the slash command as
// its tags (the arguments verbatim), the skill's text as a meta line, a
// tool call and its result, the final message and the turn's end.
func claudeTurn(text, final string) string {
	name, args, _ := strings.Cut(text, " ")
	line := func(v any) string { b, _ := json.Marshal(v); return string(b) + "\n" }
	return line(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user",
		"content": "<command-message>" + strings.TrimPrefix(name, "/") + "</command-message>\n<command-name>" + name +
			"</command-name>\n<command-args>" + args + "</command-args>"}}) +
		line(map[string]any{"type": "user", "isMeta": true, "isSidechain": false, "message": map[string]any{"role": "user",
			"content": []any{map[string]any{"type": "text", "text": "Base directory for this skill: /s\n\nARGUMENTS: " + args}}}}) +
		line(map[string]any{"type": "assistant", "isSidechain": false, "message": map[string]any{"id": "m-tool", "role": "assistant",
			"content": []any{map[string]any{"type": "tool_use", "id": "t1", "name": "Write", "input": map[string]any{}}}, "stop_reason": "tool_use"}}) +
		line(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user",
			"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}}}}) +
		wrapSay("m-final", final, "end_turn") + wrapTurnEnd
}

// codexRequestTurn is Codex's record of it: the prompt as plain text, a
// shell call, the final answer.
func codexRequestTurn(text, final string) string {
	return wrapCodexLine("event_msg", map[string]any{"type": "task_started", "turn_id": "t9", "started_at": 1790859600}) +
		wrapCodexLine("response_item", map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}}}) +
		wrapCodexLine("response_item", map[string]any{"type": "function_call", "name": "exec_command", "arguments": "{}", "call_id": "c1"}) +
		wrapCodexLine("response_item", map[string]any{"type": "message", "id": "msg_f", "role": "assistant", "phase": "final_answer",
			"content": []any{map[string]any{"type": "output_text", "text": final}}}) +
		wrapCodexLine("event_msg", map[string]any{"type": "task_complete", "turn_id": "t9", "last_agent_message": final,
			"started_at": 1790859600, "completed_at": 1790859630})
}

// writeDoc writes the agent's document as the request asks: a .tmp, then
// renamed.
func writeDoc(t *testing.T, path, doc string) {
	t.Helper()
	if err := os.WriteFile(path+".tmp", []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		t.Fatal(err)
	}
}

func agentState(state string) func(*proto.Worker) bool {
	return func(w *proto.Worker) bool { return w.AgentHandoff != nil && w.AgentHandoff.State == state }
}

const agentDoc = "---\ndate: 1999-01-01\nsource: literal\n---\n# Loader handoff: streaming landed\n\nNext: the docs.\n"

// The dialog's request to a Claude worker: one prompt, typed, with the
// native "/handoff", the default instruction, the reserved path, the
// bridge's time and the marker; the agent's turn and file (file first) are
// filed as an agent handoff with the bridge's front matter; a repeated
// submit with the op sends nothing and files nothing twice.
func TestAgentHandoffClaude(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{Client: "ag"})
	c.snapshot()
	id := ab.ids["w1"]
	args := proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-a"}
	_, m := c.command(proto.CmdWorkerHandoff, "h1", args)
	res := ackData[proto.WorkerHandoffRequestResult](t, m)
	if res.Request.Op != "op-a" || res.Request.State != proto.AgentHandoffPending || res.Existing ||
		res.Request.Instruction != proto.DefaultHandoffInstruction {
		t.Fatalf("ack %s", m.raw)
	}
	text, path, nonce := ab.mustRequest(t, "w1:p1")
	if !strings.HasPrefix(text, "/handoff summarize the conversation\n\n") || filepath.Dir(path) != filepath.Join(ab.hdir, ".pending", "s") ||
		!strings.Contains(text, "rename that file to "+path+" once") || !strings.Contains(text, `source: "agent"`) ||
		!strings.Contains(text, `session: "`+wrapSess+`"`) || !strings.Contains(text, `harness: "claude"`) ||
		!regexp.MustCompile(`date: "\d{4}-\d\d-\d\dT`).MatchString(text) || !strings.Contains(text, "at most 80 characters") {
		t.Fatalf("prompt = %q", text)
	}
	if rows, _ := ab.st.HandoffRequests(context.Background(), store.HandoffRequestPending); len(rows) != 1 || rows[0].Nonce != nonce ||
		rows[0].Offset <= 0 || rows[0].Path != path || rows[0].Transcript != "claude/"+wrapSess {
		t.Fatalf("stored %+v", rows)
	}
	// A retry (a reconnect) answers the request; nothing is sent again.
	_, m = c.command(proto.CmdWorkerHandoff, "h2", args)
	if r := ackData[proto.WorkerHandoffRequestResult](t, m); !r.Existing || r.Request.State != proto.AgentHandoffPending {
		t.Fatalf("retry %s", m.raw)
	}
	// File first, then the turn.
	writeDoc(t, path, agentDoc)
	time.Sleep(100 * time.Millisecond)
	if w := ab.world(func(proto.World) bool { return true }); workersOf(w, "s")["w1"].AgentHandoff.State != proto.AgentHandoffPending {
		t.Fatal("filed before the turn ended")
	}
	appendTo(t, ab.claude, claudeTurn(text, "Wrote the handoff."))
	ev := eventWhere(c, func(ev proto.Event) bool { return ev.T == proto.EvHandoffAdded })
	h := ev.Handoff
	if h.Source != proto.HandoffSourceAgent || h.Title != "Loader handoff: streaming landed" || h.WorkerID != id || h.AgentSession != wrapSess {
		t.Fatalf("filed %+v", h)
	}
	w := upsertFor(c, id, agentState(proto.AgentHandoffFiled))
	if w.AgentHandoff.Handoff != h.ID || w.AgentHandoff.SendHomeResult != "" {
		t.Fatalf("view %+v", w.AgentHandoff)
	}
	b, _ := os.ReadFile(h.Path)
	fm, body := handoff.SplitFrontMatter(string(b))
	if body != "# Loader handoff: streaming landed\n\nNext: the docs.\n" || fm["source"] != "agent" || fm["op"] != "op-a" || fm["worker"] != w.Name {
		t.Fatalf("file:\n%s", b)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reserved file kept: %v", err)
	}
	_, m = c.command(proto.CmdWorkerHandoff, "h3", args)
	if r := ackData[proto.WorkerHandoffRequestResult](t, m); !r.Existing || r.Request.State != proto.AgentHandoffFiled || r.Request.Handoff != h.ID {
		t.Fatalf("retry after filing %s", m.raw)
	}
	if _, _, _, n := ab.requested("w1:p1"); n != 1 {
		t.Fatalf("%d prompts", n)
	}
	if all, _ := ab.st.AllHandoffs(context.Background()); len(all) != 1 {
		t.Fatalf("%d handoffs", len(all))
	}
	if r, _ := ab.st.HandoffRequestByOp(context.Background(), "op-a"); r.State != store.HandoffRequestFiled || r.HandoffID != h.ID {
		t.Fatalf("stored %+v", r)
	}
}

// The composer's exact "/handoff <instruction>" to a Codex worker: the
// native "$handoff" with the instruction, through the same request; the
// turn ends first and the file follows (idle first), and it is filed; the
// worker is sent home after filing as asked by... nobody (the composer has
// no send home). A second "/handoff" while it runs answers it.
func TestAgentHandoffCodexComposer(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w2"]
	_, m := c.command(proto.CmdWorkerPrompt, "p1", proto.WorkerPromptArgs{ID: id, Text: "  /handoff focus on the flaky test\n", Op: "op-c"})
	pr := ackData[proto.PromptResult](t, m)
	if pr.Handoff == nil || pr.Handoff.Op != "op-c" || pr.Handoff.Instruction != "focus on the flaky test" || pr.Existing {
		t.Fatalf("ack %s", m.raw)
	}
	text, path, _ := ab.mustRequest(t, "w2:p1")
	if !strings.HasPrefix(text, "$handoff focus on the flaky test\n\n") || !strings.Contains(text, `harness: "codex"`) {
		t.Fatalf("prompt = %q", text)
	}
	_, m = c.command(proto.CmdWorkerPrompt, "p2", proto.WorkerPromptArgs{ID: id, Text: "/handoff"})
	if pr := ackData[proto.PromptResult](t, m); pr.Handoff == nil || pr.Handoff.Op != "op-c" || !pr.Existing {
		t.Fatalf("second /handoff %s", m.raw)
	}
	appendTo(t, ab.codex, codexRequestTurn(text, "Saved it."))
	time.Sleep(150 * time.Millisecond) // the turn ended, herdr idle: the file has its grace
	writeDoc(t, path, "# Flaky test notes\n\nRetry loop removed.\n")
	ev := eventWhere(c, func(ev proto.Event) bool { return ev.T == proto.EvHandoffAdded })
	if ev.Handoff.Source != proto.HandoffSourceAgent || ev.Handoff.Harness != "codex" || ev.Handoff.Title != "Flaky test notes" {
		t.Fatalf("filed %+v", ev.Handoff)
	}
	if _, _, _, n := ab.requested("w2:p1"); n != 1 {
		t.Fatalf("%d prompts", n)
	}
}

// Only an exact top-level "/handoff" is the request: prose, a quoted
// example, a path and a longer name are prompts as typed.
func TestAgentHandoffNotIntercepted(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	for i, text := range []string{"please run /handoff later", "`/handoff` is the command", "/handoff/notes.md is a path",
		"/handoffs list", "\"/handoff\" quoted"} {
		_, m := c.command(proto.CmdWorkerPrompt, "p"+string(rune('a'+i)), proto.WorkerPromptArgs{ID: id, Text: text})
		if pr := ackData[proto.PromptResult](t, m); pr.Handoff != nil {
			t.Fatalf("%q became a request: %s", text, m.raw)
		}
	}
	if _, _, _, n := ab.requested("w1:p1"); n != 0 {
		t.Fatal("a request was sent")
	}
	if rows, _ := ab.st.HandoffRequests(context.Background(), store.HandoffRequestPending); len(rows) != 0 {
		t.Fatalf("stored %+v", rows)
	}
}

// What is refused before anything is sent: a missing skill (its own code),
// skills that could not be listed, a worker at work, a shell, a bad op or
// instruction.
func TestAgentHandoffRefusals(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	ab.cat.mu.Lock()
	ab.cat.missing = true
	ab.cat.mu.Unlock()
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-1"}, proto.ErrHandoffSkillMissing)
	w := ab.agentWorker(id, agentState(proto.AgentHandoffFailed))
	if !strings.Contains(w.AgentHandoff.Reason, `lists no "handoff" skill`) {
		t.Fatalf("reason %q", w.AgentHandoff.Reason)
	}
	ab.cat.mu.Lock()
	ab.cat.missing, ab.cat.partial = false, true
	ab.cat.mu.Unlock()
	_, m := c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: id, Text: "/handoff"})
	if !strings.Contains(string(m.raw), `"code":"handoff_skill_missing"`) || !strings.Contains(string(m.raw), "could not be listed") {
		t.Fatalf("partial catalog: %s", m.raw)
	}
	ab.cat.mu.Lock()
	ab.cat.partial = false
	ab.cat.mu.Unlock()
	ab.fl.update("w1", func(w *world.WorkerObs) { w.Status = "working" })
	upsertFor(c, id, func(w *proto.Worker) bool { return w.Status == "working" })
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-2"}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: ab.ids["w3"], Mode: proto.HandoffModeAgent, Op: "op-3"}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "../x"}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-4",
		Instruction: strings.Repeat("x", proto.MaxHandoffInstruction+1)}, proto.ErrBadRequest)
	if _, _, _, n := ab.requested("w1:p1"); n != 0 {
		t.Fatal("a request was sent")
	}
	if files, _ := filepath.Glob(filepath.Join(ab.hdir, ".pending", "*", "*")); len(files) != 0 {
		t.Fatalf("reserved %v", files)
	}
}

// agentWorker waits for worker id to be as ok says in the world.
func (ab *agBridge) agentWorker(id string, ok func(*proto.Worker) bool) *proto.Worker {
	var got *proto.Worker
	ab.world(func(w proto.World) bool {
		for _, x := range workersOf(w, "s") {
			if x.ID == id && ok(&x) {
				got = &x
				return true
			}
		}
		return false
	})
	return got
}

// failedWith waits for the request of id to fail and checks why; nothing
// is filed and nobody is sent home.
func (ab *agBridge) failedWith(t *testing.T, c *client, id, why string) *proto.Worker {
	t.Helper()
	w := ab.agentWorker(id, agentState(proto.AgentHandoffFailed))
	if !strings.Contains(w.AgentHandoff.Reason, why) {
		t.Fatalf("reason %q, want %q", w.AgentHandoff.Reason, why)
	}
	if all, _ := ab.st.AllHandoffs(context.Background()); len(all) != 0 {
		t.Fatalf("filed %+v", all)
	}
	if slices.ContainsFunc(ab.fl.Calls(), func(s string) bool { return strings.HasPrefix(s, "close") }) {
		t.Fatalf("sent home: %q", ab.fl.Calls())
	}
	return w
}

// The failures after the prompt: each keeps the worker (send home asked,
// never done), files nothing, and leaves the agent's file in the trash.
func TestAgentHandoffFailures(t *testing.T) {
	t.Parallel()
	start := func(t *testing.T, tweak func(*server.Options)) (*agBridge, *client, string, string, string) {
		ab := startAgentBridge(t, "", "", "", tweak)
		c := ab.connect(proto.Hello{})
		c.snapshot()
		id := ab.ids["w1"]
		_, m := c.command(proto.CmdWorkerHandoff, "h", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-f", SendHome: true})
		if m.env.T != proto.TAck {
			t.Fatalf("worker.handoff: %s", m.raw)
		}
		text, path, _ := ab.mustRequest(t, "w1:p1")
		return ab, c, id, text, path
	}
	t.Run("turn ended without the file", func(t *testing.T) {
		t.Parallel()
		ab, c, id, text, path := start(t, nil)
		appendTo(t, ab.claude, claudeTurn(text, "Saved it to /tmp/handoff.md."))
		ab.failedWith(t, c, id, "without the handoff at "+path)
	})
	t.Run("never renamed", func(t *testing.T) {
		t.Parallel()
		ab, c, id, text, path := start(t, nil)
		os.WriteFile(path+".tmp", []byte("# half"), 0o600)
		appendTo(t, ab.claude, claudeTurn(text, "Done."))
		ab.failedWith(t, c, id, "still at "+path+".tmp")
	})
	t.Run("took over", func(t *testing.T) {
		t.Parallel()
		ab, c, id, text, path := start(t, nil)
		c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{{Key: ptr("esc")}}})
		ab.failedWith(t, c, id, "a person took over")
		// The agent's turn and file after it: never filed, the file in the trash.
		writeDoc(t, path, agentDoc)
		appendTo(t, ab.claude, claudeTurn(text, "Done."))
		time.Sleep(600 * time.Millisecond)
		if all, _ := ab.st.AllHandoffs(context.Background()); len(all) != 0 {
			t.Fatalf("filed after a takeover: %+v", all)
		}
	})
	t.Run("a person's prompt in the transcript", func(t *testing.T) {
		t.Parallel()
		ab, c, id, text, path := start(t, nil)
		writeDoc(t, path, agentDoc)
		appendTo(t, ab.claude, claudeTurn(text, "Done.")+wrapUser("Actually, also fix the docs."))
		ab.failedWith(t, c, id, "a person took over")
		if trash, _ := filepath.Glob(filepath.Join(ab.hdir, ".trash", "s", "agent-op-f*.md")); len(trash) != 1 {
			t.Fatalf("trash %v", trash)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		t.Parallel()
		ab, c, id, _, _ := start(t, func(o *server.Options) { o.AgentHandoffTimeout = 300 * time.Millisecond })
		ab.failedWith(t, c, id, "no handoff within 300ms")
	})
	t.Run("session changed", func(t *testing.T) {
		t.Parallel()
		ab, c, id, _, _ := start(t, nil)
		ab.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "another-session" })
		ab.failedWith(t, c, id, "session changed")
	})
	t.Run("cancelled", func(t *testing.T) {
		t.Parallel()
		ab, c, id, _, _ := start(t, nil)
		_, m := c.command(proto.CmdWorkerHandoffCancel, "x", proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-f"})
		if v := ackData[proto.AgentHandoff](t, m); v.State != proto.AgentHandoffFailed || v.Reason != "cancelled" {
			t.Fatalf("cancel %s", m.raw)
		}
		ab.failedWith(t, c, id, "cancelled")
		// Dismissed: the worker shows none; a retry is a new op.
		c.mustAck(proto.CmdWorkerHandoffCancel, proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-f"})
		ab.agentWorker(id, func(w *proto.Worker) bool { return w.AgentHandoff == nil })
		_, m = c.command(proto.CmdWorkerHandoff, "again", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-f"})
		if r := ackData[proto.WorkerHandoffRequestResult](t, m); !r.Existing || r.Request.State != proto.AgentHandoffFailed {
			t.Fatalf("the failed op again %s", m.raw)
		}
		_, m = c.command(proto.CmdWorkerHandoff, "retry", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-g"})
		if r := ackData[proto.WorkerHandoffRequestResult](t, m); r.Existing || r.Request.State != proto.AgentHandoffPending {
			t.Fatalf("retry %s", m.raw)
		}
	})
}

// Filed with send home: the worker goes home through worker.fire's path,
// only after the handoff was filed.
func TestAgentHandoffSendHome(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	ab.fl.setProcs("w1:p1", running("claude", wrapSess))
	c.mustAck(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-h", SendHome: true})
	text, path, _ := ab.mustRequest(t, "w1:p1")
	appendTo(t, ab.claude, claudeTurn(text, "Done."))
	writeDoc(t, path, agentDoc)
	added := false
	for {
		ev := c.event()
		if ev.T == proto.EvHandoffAdded {
			added = true
		}
		if ev.T == proto.EvWorkerRemoved && ev.ID == id {
			if !added {
				t.Fatal("sent home before the handoff was filed")
			}
			break
		}
	}
	eventually(t, "the fire's audit row", func() bool {
		row := auditRow(t, ab.bridge, proto.CmdWorkerFire)
		return row.OK && row.Done && strings.Contains(row.Result, "keep")
	})
}

// A request whose prompt was sent resumes after a restart within its
// timeout (the transcript read again from its offset) and files; one out of
// time fails.
func TestAgentHandoffRestart(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	c.mustAck(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-r"})
	text, path, _ := ab.mustRequest(t, "w1:p1")
	ab.stop()
	writeDoc(t, path, agentDoc)
	appendTo(t, ab.claude, claudeTurn(text, "Done."))
	ab2 := startAgentBridge(t, ab.db, ab.dir, ab.hdir, nil)
	c2 := ab2.connect(proto.Hello{})
	c2.snapshot()
	w := upsertFor(c2, id, agentState(proto.AgentHandoffFiled))
	if all, _ := ab2.st.AllHandoffs(context.Background()); len(all) != 1 || all[0].ID != w.AgentHandoff.Handoff || all[0].Op != "op-r" {
		t.Fatalf("filed %+v", all)
	}
	if _, _, _, n := ab2.requested("w1:p1"); n != 0 {
		t.Fatal("sent again after the restart")
	}

	// Out of time across a restart: failed, the file to the trash.
	ab3 := startAgentBridge(t, "", "", "", nil)
	c3 := ab3.connect(proto.Hello{})
	c3.snapshot()
	c3.mustAck(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: ab3.ids["w1"], Mode: proto.HandoffModeAgent, Op: "op-t"})
	_, path3, _ := ab3.mustRequest(t, "w1:p1")
	ab3.stop()
	writeDoc(t, path3, agentDoc)
	ab4 := startAgentBridge(t, ab3.db, ab3.dir, ab3.hdir, func(o *server.Options) { o.AgentHandoffTimeout = time.Millisecond })
	w4 := workersOf(ab4.world(func(w proto.World) bool {
		a := workersOf(w, "s")["w1"].AgentHandoff
		return a != nil && a.State == proto.AgentHandoffFailed
	}), "s")["w1"]
	if !strings.Contains(w4.AgentHandoff.Reason, "restarted") {
		t.Fatalf("after restart %+v", w4.AgentHandoff)
	}
	if _, err := os.Lstat(path3); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending file kept: %v", err)
	}
}

// The preview of "Ask the agent": who receives it, whether it can be
// asked, and the cache estimate (unknown without evidence).
func TestAgentHandoffPreview(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	_, m := c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: ab.ids["w2"], Mode: proto.HandoffModeAgent})
	pv := ackData[proto.WorkerHandoffPreviewResult](t, m)
	if pv.Agent == nil || !pv.Agent.CanAsk || pv.Agent.Call != "$handoff" || pv.Agent.Harness != "codex" ||
		pv.Agent.Instruction != proto.DefaultHandoffInstruction || pv.Candidate != nil {
		t.Fatalf("preview %s", m.raw)
	}
	ab.fl.update("w1", func(w *world.WorkerObs) { w.Status = "working" })
	upsertFor(c, ab.ids["w1"], func(w *proto.Worker) bool { return w.Status == "working" })
	_, m = c.command(proto.CmdWorkerHandoffPreview, "p2", proto.WorkerHandoffPreviewArgs{Worker: ab.ids["w1"], Mode: proto.HandoffModeAgent})
	if pv := ackData[proto.WorkerHandoffPreviewResult](t, m); pv.Agent.CanAsk || !strings.Contains(pv.Agent.CannotAsk, "only an idle or done worker") ||
		pv.Agent.Call != "/handoff" {
		t.Fatalf("working preview %s", m.raw)
	}
}

// Answering the worker's question while it runs is a person taking over
// (worker.answer), and a wrap-up and a handoff request never run together.
func TestAgentHandoffAnswerAndWrapUp(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	c.mustAck(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-w"})
	ab.mustRequest(t, "w1:p1")
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: id, Prompt: cleanup, Worktree: proto.FireKeep}, proto.ErrBusy)
	ab.fl.update("w1", func(w *world.WorkerObs) { w.Status = "blocked" })
	ab.agentWorker(id, func(w *proto.Worker) bool { return w.Status == "blocked" })
	c.command(proto.CmdWorkerAnswer, "a", proto.WorkerAnswerArgs{ID: id, Hash: "0123456789abcdef", Choice: 1})
	ab.failedWith(t, c, id, "a person took over")

	// Armed wrap-up: no handoff request.
	ab.fl.update("w1", func(w *world.WorkerObs) { w.Status = "idle" })
	ab.agentWorker(id, func(w *proto.Worker) bool { return w.Status == "idle" })
	ab.arm(t, c, "w1", proto.FireKeep)
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Op: "op-x"}, proto.ErrBusy)
}
