package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #83: wrap up, then send home, against the fake herdr floor, git and laptop
// and real transcript files the usage tracker reads: w1 is a Claude agent in
// a linked worktree the bridge made (session wrapSess), w2 a Codex one in
// another (session wrapCodex), w3 a plain shell.

const (
	wrapSess  = "7a7b7c7d-8383-4838-8838-838383838383"
	wrapCodex = "01a0f600-aaaa-7bbb-8ccc-dddddddddddd"
	wrapWT1   = "/home/u/.herdr/worktrees/repo/h3d-pixel-a1b2c3"
	wrapWT2   = "/home/u/.herdr/worktrees/repo/h3d-mochi-d4e5f6"
	cleanup   = "Stop every server, background process, pane and freelancer you started in this session. Don't touch anything else."
)

type wrapBridge struct {
	*hireBridge
	term          *fakeTerm
	dir           string // the transcripts' root
	claude, codex string // w1's and w2's transcript files
	ids           map[string]string
	armedAs       *proto.WrapUp // the last arm's upsert
	heldCheck     chan struct{} // holdCleanCheck: a check is held
}

func wrapWorkers() []world.WorkerObs {
	w1 := linkedWorker("w1", "h3d/pixel-a1b2c3")
	w1.AgentSession, w1.Harness, w1.Status = wrapSess, world.HarnessClaude, "idle"
	w2 := withKind(linkedWorker("w2", "h3d/mochi-d4e5f6"), "codex")
	w2.AgentSession, w2.Harness, w2.Status = wrapCodex, world.HarnessCodex, "idle"
	return []world.WorkerObs{w1, w2, worker("w3", "notes", "", "unknown")}
}

// startWrapBridge starts the bridge on db and transcripts under dir (""
// each: new ones).
func startWrapBridge(t *testing.T, db, dir string, tweak func(*server.Options)) *wrapBridge {
	t.Helper()
	fresh := dir == ""
	if fresh {
		dir = t.TempDir()
	}
	wb := &wrapBridge{term: newFakeTerm(), dir: dir, claude: filepath.Join(dir, "claude", "-home-u-w1", wrapSess+".jsonl"),
		codex: filepath.Join(dir, "codex", "2026", "10", "01", "rollout-2026-10-01T09-00-00-"+wrapCodex+".jsonl")}
	if fresh {
		writeTranscript(t, wb.claude, wrapUser("Fix the flaky test.")+wrapSay("m0", "Fixed and pushed.", "end_turn"))
		writeTranscript(t, wb.codex, `{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"`+wrapCodex+`","cwd":"`+wrapWT2+`"}}`+"\n")
	}
	wb.hireBridge = startHireBridgeAt(t, db, func(o *server.Options) {
		o.Term = wb.term
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: filepath.Join(dir, "claude"), CodexSessions: filepath.Join(dir, "codex")},
			Interval: 15 * time.Millisecond}
		o.WrapUpDebounce = 40 * time.Millisecond
		o.PromptRetryWait = 300 * time.Millisecond
		if tweak != nil {
			tweak(o)
		}
	}, wrapWorkers()...)
	for ws, wt := range map[string]string{"w1": wrapWT1, "w2": wrapWT2} {
		wb.git.repos[wt] = wt
		wb.fl.setProcs(ws+":p1", running(map[string]string{"w1": "claude", "w2": "codex"}[ws], ""))
	}
	ws := workersOf(wb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 3 }), "s")
	wb.ids = map[string]string{}
	for k, w := range ws {
		wb.ids[k] = w.ID
	}
	ctx := context.Background()
	for k, b := range map[string]string{"w1": "h3d/pixel-a1b2c3", "w2": "h3d/mochi-d4e5f6"} {
		if !fresh {
			break // recorded already
		}
		if err := wb.st.RecordHireBranch(ctx, store.HireBranch{WorkerID: wb.ids[k], Session: "s", RepoRoot: "/home/u/repo",
			Branch: b, BaseSHA: wb.git.sha}); err != nil {
			t.Fatal(err)
		}
	}
	return wb
}

// Claude transcript lines, as Claude Code writes them.
func wrapUser(text string) string {
	b, _ := json.Marshal(map[string]any{"type": "user", "isSidechain": false, "message": map[string]any{"role": "user", "content": text}})
	return string(b) + "\n"
}

func wrapSay(id, text, stop string) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "isSidechain": false, "message": map[string]any{"id": id,
		"role": "assistant", "content": []any{map[string]any{"type": "text", "text": text}}, "stop_reason": stop,
		"usage": map[string]any{"input_tokens": 1, "output_tokens": 1}}})
	return string(b) + "\n"
}

const wrapTurnEnd = `{"type":"system","subtype":"turn_duration","durationMs":1200,"isSidechain":false}` + "\n"

func wrapCodexLine(typ string, payload any) string {
	b, _ := json.Marshal(map[string]any{"timestamp": "2026-10-01T09:00:01.000Z", "type": typ, "payload": payload})
	return string(b) + "\n"
}

func appendTo(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

var nonceRe = regexp.MustCompile(`H3D-WRAPUP ([0-9a-f]{16}) CLEAN`)

// prompted is the text of the wrap-up prompt the bridge sent to pane, and its
// nonce.
func (wb *wrapBridge) prompted(t *testing.T, pane string) (text, nonce string) {
	t.Helper()
	for _, c := range slices.Backward(wb.term.Calls()) {
		for _, how := range []string{"submit ", "queue "} {
			if q, ok := strings.CutPrefix(c, how+pane+" "); ok {
				var s string
				if err := json.Unmarshal([]byte(q), &s); err == nil {
					if m := nonceRe.FindStringSubmatch(s); m != nil {
						return s, m[1]
					}
				}
			}
		}
	}
	t.Fatalf("no wrap-up prompt to %s in %q", pane, wb.term.Calls())
	return "", ""
}

// arm sends worker.wrapup for ws and returns the nonce it prompted with
// (the armed upsert came before the ack).
func (wb *wrapBridge) arm(t *testing.T, c *client, ws, worktree string) string {
	t.Helper()
	evs, m := c.command(proto.CmdWorkerWrapUp, "wrap-"+ws, proto.WorkerWrapUpArgs{ID: wb.ids[ws], Prompt: cleanup, Worktree: worktree})
	if m.env.T != proto.TAck {
		t.Fatalf("worker.wrapup: %s", m.raw)
	}
	wb.armedAs = nil
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == wb.ids[ws] && ev.Worker.WrapUp != nil && ev.Worker.WrapUp.State == proto.WrapUpArmed {
			wb.armedAs = ev.Worker.WrapUp
		}
	}
	if wb.armedAs == nil {
		t.Fatalf("no armed upsert before the ack: %+v", evs)
	}
	text, nonce := wb.prompted(t, ws+":p1")
	if !strings.HasPrefix(text, cleanup+"\n\nWhen you are done, end your final message with exactly one line:\nH3D-WRAPUP "+nonce+" CLEAN\n") ||
		!strings.HasSuffix(text, "\nH3D-WRAPUP "+nonce+" BLOCKED: <one-line reason>") {
		t.Fatalf("prompt = %q", text)
	}
	return nonce
}

// reply writes w1's turn after the prompt: the prompt's user line (the
// footer echoed) and the final message.
func (wb *wrapBridge) reply(t *testing.T, prompt, final string) {
	t.Helper()
	appendTo(t, wb.claude, wrapUser(prompt)+wrapSay(fmt.Sprintf("m%d", time.Now().UnixNano()), final, "end_turn")+wrapTurnEnd)
}

func wrapUpOf(c *client, id string, ok func(*proto.WrapUp) bool) *proto.Worker {
	c.t.Helper()
	return upsertFor(c, id, func(w *proto.Worker) bool { return ok(w.WrapUp) })
}

func wrapState(state string) func(*proto.WrapUp) bool {
	return func(u *proto.WrapUp) bool { return u != nil && u.State == state }
}

func noWrapUp(u *proto.WrapUp) bool { return u == nil }

// wrapUpIn finds the upsert among a command's events, else reads on.
func wrapUpIn(c *client, evs []proto.Event, id string, ok func(*proto.WrapUp) bool) *proto.Worker {
	c.t.Helper()
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ok(ev.Worker.WrapUp) {
			return ev.Worker
		}
	}
	return wrapUpOf(c, id, ok)
}

// doneRow waits for the last audit row of cmd to be done (a send home's
// ends after the worker is seen gone).
func doneRow(t *testing.T, b *bridge, cmd string) (row struct {
	OK, Done      bool
	Error, Result string
}) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); ; {
		if row = auditRow(t, b, cmd); row.Done || time.Now().After(end) {
			return row
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// removedSentHome reads until worker id is removed.
func removedSentHome(c *client, id string) proto.Event {
	c.t.Helper()
	for {
		if ev := c.event(); ev.T == proto.EvWorkerRemoved && ev.ID == id {
			return ev
		}
	}
}

// The e2e: armed with delete, the agent reports CLEAN in its transcript, the
// worker goes home through the send home's steps and its worktree is
// removed; nobody else is touched.
func TestWrapUpCleanSendsHome(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{Client: "wrap-test"})
	c.snapshot()
	id := wb.ids["w1"]
	nonce := wb.arm(t, c, "w1", proto.FireDelete)
	if u := wb.armedAs; u.Worktree != proto.FireDelete || u.ArmedAt <= 0 || u.Reason != "" {
		t.Fatalf("armed: %+v", u)
	}
	row := auditRow(t, wb.bridge, proto.CmdWorkerWrapUp)
	if !row.OK || !row.Done || !strings.Contains(row.Result, `"nonce":"`+nonce+`"`) || !strings.Contains(row.Result, `"worktree":"delete"`) {
		t.Fatalf("arm audit = %+v", row)
	}
	if log, _ := wb.st.AuditLog(context.Background()); strings.Contains(log[len(log)-1].Args, "Stop every server") {
		t.Fatalf("the prompt is in the audit log: %s", log[len(log)-1].Args)
	}
	if got, _ := wb.st.WrapUps(context.Background()); len(got) != 1 || got[0].Nonce != nonce || got[0].State != proto.WrapUpArmed ||
		got[0].Offset == 0 || got[0].Transcript != "claude/"+wrapSess {
		t.Fatalf("stored = %+v", got)
	}
	// Nothing goes before the result.
	time.Sleep(150 * time.Millisecond)
	if calls := wb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr before the verdict: %q", calls)
	}
	text, _ := wb.prompted(t, "w1:p1")
	wb.reply(t, text, "Stopped the dev server.\n\nH3D-WRAPUP "+nonce+" CLEAN")
	if ev := removedSentHome(c, id); ev.Reason != proto.RemovedSentHome {
		t.Fatalf("removed = %+v", ev)
	}
	if calls := wb.fl.Calls(); !slices.Equal(calls, []string{"exit w1:p1", "key w1:p1 enter", "remove-worktree w1"}) {
		t.Fatalf("herdr calls = %q", calls)
	}
	row = doneRow(t, wb.bridge, proto.CmdWorkerFire)
	if !row.OK || !row.Done || !strings.Contains(row.Result, `"wrapup":{"nonce":"`+nonce+`","verdict":"clean"}`) ||
		!strings.Contains(row.Result, `"worktree":"deleted"`) {
		t.Fatalf("fire audit = %+v", row)
	}
	if got, _ := wb.st.WrapUps(context.Background()); len(got) != 0 {
		t.Fatalf("stored after: %+v", got)
	}
	if ws := workersOf(wb.world(func(proto.World) bool { return true }), "s"); len(ws) != 2 || ws["w2"].WrapUp != nil {
		t.Fatalf("others: %+v", ws)
	}
}

// Codex, keep: the result from its rollout; the workspace closes, the
// worktree stays.
func TestWrapUpCodexKeep(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w2"]
	nonce := wb.arm(t, c, "w2", proto.FireKeep)
	text, _ := wb.prompted(t, "w2:p1")
	appendTo(t, wb.codex, wrapCodexLine("event_msg", map[string]any{"type": "task_started"})+
		wrapCodexLine("response_item", map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}}})+
		wrapCodexLine("response_item", map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text",
			"text": "Closed the pane.\n\nH3D-WRAPUP " + nonce + " CLEAN"}}})+
		wrapCodexLine("event_msg", map[string]any{"type": "task_complete", "last_agent_message": "H3D-WRAPUP " + nonce + " CLEAN"}))
	removedSentHome(c, id)
	if calls := wb.fl.Calls(); !slices.Equal(calls, []string{"exit w2:p1", "key w2:p1 enter", "close w2"}) {
		t.Fatalf("herdr calls = %q", calls)
	}
}

// The decision table: what the transcript says, what follows.
func TestWrapUpDecisions(t *testing.T) {
	cases := []struct {
		name  string
		final func(nonce string) string
		state string // "": disarmed
		why   string
	}{
		{"blocked", func(n string) string { return "H3D-WRAPUP " + n + " BLOCKED: port 4173 is not mine" }, proto.WrapUpNeedsYou, "port 4173 is not mine"},
		{"no marker", func(string) string { return "Stopped it all." }, proto.WrapUpNeedsYou, "did not report a wrap-up result"},
		{"wrong nonce", func(string) string { return "H3D-WRAPUP 0123456789abcdef CLEAN" }, proto.WrapUpNeedsYou, "did not report a wrap-up result"},
		{"quoted", func(n string) string { return "`H3D-WRAPUP " + n + " CLEAN`" }, proto.WrapUpNeedsYou, "did not report a wrap-up result"},
		{"followed by text", func(n string) string { return "H3D-WRAPUP " + n + " CLEAN\nAnything else?" }, proto.WrapUpNeedsYou, "did not report a wrap-up result"},
		{"two markers", func(n string) string { return "H3D-WRAPUP " + n + " CLEAN\nH3D-WRAPUP " + n + " CLEAN" }, proto.WrapUpNeedsYou, "did not report a wrap-up result"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wb := startWrapBridge(t, "", "", nil)
			c := wb.connect(proto.Hello{})
			c.snapshot()
			id := wb.ids["w1"]
			nonce := wb.arm(t, c, "w1", proto.FireDelete)
			text, _ := wb.prompted(t, "w1:p1")
			wb.reply(t, text, tc.final(nonce))
			w := wrapUpOf(c, id, wrapState(tc.state))
			if w.WrapUp.Reason != tc.why || w.WrapUp.Worktree != proto.FireDelete {
				t.Fatalf("needs you: %+v", w.WrapUp)
			}
			// Disarmed for good: a later CLEAN with that nonce does nothing.
			appendTo(t, wb.claude, wrapUser("ok?")+wrapSay("late", "H3D-WRAPUP "+nonce+" CLEAN", "end_turn")+wrapTurnEnd)
			time.Sleep(200 * time.Millisecond)
			if calls := wb.fl.Calls(); len(calls) != 0 {
				t.Fatalf("herdr after needs_you: %q", calls)
			}
			if got, _ := wb.st.WrapUps(context.Background()); len(got) != 1 || got[0].State != proto.WrapUpNeedsYou || got[0].Reason != tc.why {
				t.Fatalf("stored = %+v", got)
			}
			// A plain reply does not re-arm (nor clear it); "Wrap up again" does, with a fresh nonce.
			c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "Kill the preview server, it is yours."})
			if w := workersOf(wb.world(func(proto.World) bool { return true }), "s")["w1"]; w.WrapUp == nil || w.WrapUp.State != proto.WrapUpNeedsYou {
				t.Fatalf("after a reply: %+v", w.WrapUp)
			}
			again := wb.arm(t, c, "w1", proto.FireDelete)
			if again == nonce {
				t.Fatal("re-armed with the old nonce")
			}
			text, _ = wb.prompted(t, "w1:p1")
			wb.reply(t, text, "H3D-WRAPUP "+again+" CLEAN")
			removedSentHome(c, id)
		})
	}
}

// #83 review: CLEAN as an example in a code fence still open (a shorter or
// another character's run does not close it) is no result: it needs you, and
// nothing is closed or removed.
func TestWrapUpFencedExampleNeverFires(t *testing.T) {
	for name, example := range map[string]string{
		"shorter": "I could not stop the server. Example only:\n````text\n```\n",
		"mixed":   "I could not stop the server. Example only:\n```text\n~~~\n",
	} {
		t.Run(name, func(t *testing.T) {
			wb := startWrapBridge(t, "", "", nil)
			c := wb.connect(proto.Hello{})
			c.snapshot()
			id := wb.ids["w1"]
			nonce := wb.arm(t, c, "w1", proto.FireDelete)
			text, _ := wb.prompted(t, "w1:p1")
			wb.reply(t, text, example+"H3D-WRAPUP "+nonce+" CLEAN")
			w := wrapUpOf(c, id, wrapState(proto.WrapUpNeedsYou))
			if w.WrapUp.Reason != "did not report a wrap-up result" {
				t.Fatalf("needs you: %+v", w.WrapUp)
			}
			time.Sleep(200 * time.Millisecond)
			if calls := wb.fl.Calls(); len(calls) != 0 {
				t.Fatalf("herdr calls = %q", calls)
			}
			if ws := workersOf(wb.world(func(proto.World) bool { return true }), "s"); ws["w1"].ID != id {
				t.Fatalf("w1 left: %+v", ws)
			}
		})
	}
}

// A person prompting (or typing) while armed takes over: disarmed, nothing
// needs you. So does a prompt typed in herdr itself, seen in the transcript.
func TestWrapUpTakeover(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	nonce := wb.arm(t, c, "w1", proto.FireDelete)
	evs, _ := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "Wait, keep the dev server."})
	wrapUpIn(c, evs, id, noWrapUp)
	text, _ := wb.prompted(t, "w1:p1")
	wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
	time.Sleep(200 * time.Millisecond)
	if calls := wb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr after a takeover: %q", calls)
	}
	if got, _ := wb.st.WrapUps(context.Background()); len(got) != 0 {
		t.Fatalf("stored = %+v", got)
	}

	nonce = wb.arm(t, c, "w1", proto.FireDelete)
	evs, _ = c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{key("esc")}})
	wrapUpIn(c, evs, id, noWrapUp)

	nonce = wb.arm(t, c, "w1", proto.FireDelete)
	text, _ = wb.prompted(t, "w1:p1")
	appendTo(t, wb.claude, wrapUser(text)+wrapUser("Actually, stop.")+wrapSay("m9", "H3D-WRAPUP "+nonce+" CLEAN", "end_turn")+wrapTurnEnd)
	wrapUpOf(c, id, noWrapUp)
	time.Sleep(150 * time.Millisecond)
	if calls := wb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr after a takeover in herdr: %q", calls)
	}
}

// #83 review: a person stepping in while a CLEAN's tree check runs (before
// the send home starts) disarms it, and nothing is sent home: a
// worker.prompt (its user line in the transcript too), worker.keys, a prompt
// typed in herdr. A transcript that goes on decides again.
func TestWrapUpTakeoverDuringCleanCheck(t *testing.T) {
	cases := []struct {
		name string
		step func(t *testing.T, wb *wrapBridge, c *client, id, nonce string)
	}{
		{"worker.prompt", func(t *testing.T, wb *wrapBridge, c *client, id, _ string) {
			evs, _ := c.mustAck(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: "Wait, keep the dev server."})
			appendTo(t, wb.claude, wrapUser("Wait, keep the dev server."))
			wrapUpIn(c, evs, id, noWrapUp)
		}},
		{"worker.keys", func(t *testing.T, wb *wrapBridge, c *client, id, _ string) {
			evs, _ := c.mustAck(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: []proto.InputItem{key("esc")}})
			wrapUpIn(c, evs, id, noWrapUp)
		}},
		{"typed in herdr", func(t *testing.T, wb *wrapBridge, c *client, id, nonce string) {
			appendTo(t, wb.claude, wrapUser("Do not send this worker home. Explain the line H3D-WRAPUP "+nonce+" CLEAN instead."))
			wrapUpOf(c, id, noWrapUp)
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wb := startWrapBridge(t, "", "", nil)
			c := wb.connect(proto.Hello{})
			c.snapshot()
			id := wb.ids["w1"]
			nonce := wb.arm(t, c, "w1", proto.FireDelete)
			release := wb.holdCleanCheck(t)
			text, _ := wb.prompted(t, "w1:p1")
			wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
			wb.waitHeld(t)
			tc.step(t, wb, c, id, nonce)
			release()
			time.Sleep(300 * time.Millisecond)
			if calls := wb.fl.Calls(); len(calls) != 0 {
				t.Fatalf("herdr after a takeover during the check: %q", calls)
			}
			if got, _ := wb.st.WrapUps(context.Background()); len(got) != 0 {
				t.Fatalf("stored = %+v", got)
			}
			if w := workersOf(wb.world(func(proto.World) bool { return true }), "s")["w1"]; w.ID != id || w.WrapUp != nil {
				t.Fatalf("w1: %+v", w)
			}
			if log, _ := wb.st.AuditLog(context.Background()); slices.ContainsFunc(log, func(r store.AuditEntry) bool { return r.Cmd == proto.CmdWorkerFire }) {
				t.Fatal("a send home was audited")
			}
		})
	}
	t.Run("the turn goes on", func(t *testing.T) {
		wb := startWrapBridge(t, "", "", nil)
		c := wb.connect(proto.Hello{})
		c.snapshot()
		id := wb.ids["w1"]
		nonce := wb.arm(t, c, "w1", proto.FireDelete)
		release := wb.holdCleanCheck(t)
		text, _ := wb.prompted(t, "w1:p1")
		wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
		wb.waitHeld(t)
		appendTo(t, wb.claude, wrapSay("m-more", "One more thing: the preview server is still up.", "end_turn")+wrapTurnEnd)
		time.Sleep(150 * time.Millisecond) // read while the check runs
		release()
		w := wrapUpOf(c, id, wrapState(proto.WrapUpNeedsYou))
		if w.WrapUp.Reason != "did not report a wrap-up result" {
			t.Fatalf("needs you: %+v", w.WrapUp)
		}
		if calls := wb.fl.Calls(); len(calls) != 0 {
			t.Fatalf("herdr calls = %q", calls)
		}
	})
}

// holdCleanCheck blocks the next tree check (after arming: a CLEAN's) until
// the returned release is called; it returns once the check is held.
func (wb *wrapBridge) holdCleanCheck(t *testing.T) (release func()) {
	t.Helper()
	held, gate := make(chan struct{}, 1), make(chan struct{})
	var once sync.Once
	release = func() { once.Do(func() { close(gate) }) }
	t.Cleanup(release)
	wb.git.mu.Lock()
	wb.git.onStatus = func(string) {
		select {
		case held <- struct{}{}:
		default:
		}
		<-gate
	}
	wb.git.mu.Unlock()
	wb.heldCheck = held
	return release
}

// waitHeld waits for the CLEAN's check to be held.
func (wb *wrapBridge) waitHeld(t *testing.T) {
	t.Helper()
	select {
	case <-wb.heldCheck:
	case <-time.After(5 * time.Second):
		t.Fatal("the CLEAN's tree check never ran")
	}
}

// Blocked (or working) in herdr: the result waits; idle again, it is read.
func TestWrapUpWaitsWhileBlocked(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	nonce := wb.arm(t, c, "w1", proto.FireKeep)
	wb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "blocked" })
	text, _ := wb.prompted(t, "w1:p1")
	wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
	time.Sleep(250 * time.Millisecond)
	if calls := wb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr while blocked: %q", calls)
	}
	wb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "idle" })
	removedSentHome(c, id)
}

// No result in time: it needs you.
func TestWrapUpTimeout(t *testing.T) {
	wb := startWrapBridge(t, "", "", func(o *server.Options) { o.WrapUpTimeout = 300 * time.Millisecond })
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	wb.arm(t, c, "w1", proto.FireDelete)
	w := wrapUpOf(c, id, wrapState(proto.WrapUpNeedsYou))
	if w.WrapUp.Reason != "no wrap-up result within 300ms" {
		t.Fatalf("timed out: %+v", w.WrapUp)
	}
}

// Strict: the tree changes while the agent exits. A wrap-up's send home
// fails and the worker stays at its desk (needs you); it is never sent home
// with its worktree kept.
func TestWrapUpStrictDelete(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	nonce := wb.arm(t, c, "w1", proto.FireDelete)
	wb.fl.onKey = func(pane string, key herdr.Key) {
		if key == herdr.KeyEnter {
			wb.git.mu.Lock()
			wb.git.dirty[wrapWT1] = []string{"?? exit-hook.log"}
			wb.git.mu.Unlock()
		}
	}
	text, _ := wb.prompted(t, "w1:p1")
	wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
	w := wrapUpOf(c, id, wrapState(proto.WrapUpNeedsYou))
	if !strings.Contains(w.WrapUp.Reason, "the tree changed while") || !strings.Contains(w.WrapUp.Reason, "nothing was closed or removed") {
		t.Fatalf("needs you: %+v", w.WrapUp)
	}
	if calls := wb.fl.Calls(); slices.Contains(calls, "remove-worktree w1") || slices.Contains(calls, "close w1") {
		t.Fatalf("herdr calls = %q", calls)
	}
	if row := auditRow(t, wb.bridge, proto.CmdWorkerFire); row.OK || !strings.Contains(row.Error, "not clean") ||
		!strings.Contains(row.Result, `"wrapup":{"nonce":"`+nonce+`"`) {
		t.Fatalf("fire audit = %+v", row)
	}
	if ws := workersOf(wb.world(func(proto.World) bool { return true }), "s"); ws["w1"].ID != id {
		t.Fatalf("w1 left: %+v", ws)
	}
}

// After CLEAN the tree is checked again before anything: dirty now, nothing
// is touched and it needs you.
func TestWrapUpCleanChecksTheTree(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	nonce := wb.arm(t, c, "w1", proto.FireDeleteBranch)
	wb.git.mu.Lock()
	wb.git.unpushed[wrapWT1] = 1
	wb.git.mu.Unlock()
	text, _ := wb.prompted(t, "w1:p1")
	wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
	w := wrapUpOf(c, id, wrapState(proto.WrapUpNeedsYou))
	if !strings.Contains(w.WrapUp.Reason, "1 commit not on any remote") || w.WrapUp.Worktree != proto.FireDeleteBranch {
		t.Fatalf("needs you: %+v", w.WrapUp)
	}
	if calls := wb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr calls = %q", calls)
	}
}

// A bridge restart while armed resumes from the stored offset: the result
// written while it was down is read, and only that one.
func TestWrapUpResumesAfterRestart(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	nonce := wb.arm(t, c, "w1", proto.FireDelete)
	text, _ := wb.prompted(t, "w1:p1")
	wb.stop()
	wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
	wb2 := startWrapBridge(t, wb.db, wb.dir, nil)
	if wb2.ids["w1"] != id {
		t.Fatalf("w1 is %s after the restart, was %s", wb2.ids["w1"], id)
	}
	c2 := wb2.connect(proto.Hello{})
	c2.snapshot()
	removedSentHome(c2, id)
	if calls := wb2.fl.Calls(); !slices.Contains(calls, "remove-worktree w1") {
		t.Fatalf("herdr calls = %q", calls)
	}
}

// Restarted with the transcript gone: it needs you, nothing is sent home.
func TestWrapUpRestartTranscriptGone(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	wb.arm(t, c, "w1", proto.FireDelete)
	wb.stop()
	if err := os.Remove(wb.claude); err != nil {
		t.Fatal(err)
	}
	wb2 := startWrapBridge(t, wb.db, wb.dir, nil)
	w := workersOf(wb2.world(func(w proto.World) bool {
		u := workersOf(w, "s")["w1"].WrapUp
		return u != nil && u.State == proto.WrapUpNeedsYou
	}), "s")["w1"]
	if !strings.Contains(w.WrapUp.Reason, "transcript is gone") {
		t.Fatalf("after restart: %+v", w.WrapUp)
	}
	time.Sleep(100 * time.Millisecond)
	if calls := wb2.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr calls = %q", calls)
	}
}

// What worker.wrapup refuses, and worker.wrapup.cancel.
func TestWrapUpValidation(t *testing.T) {
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	w1, w3 := wb.ids["w1"], wb.ids["w3"]
	args := func(id, wt string) proto.WorkerWrapUpArgs {
		return proto.WorkerWrapUpArgs{ID: id, Prompt: cleanup, Worktree: wt}
	}
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: w1, Prompt: "  "}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: w1, Prompt: strings.Repeat("x", herdr.MaxMessage)}, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerWrapUp, args(w1, "burn"), proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerWrapUp, args("nobody", ""), proto.ErrUnknownWorker)
	c.mustError(proto.CmdWorkerWrapUp, args(w3, ""), proto.ErrInvalidState) // a shell: no transcript to read
	c.mustError(proto.CmdWorkerWrapUp, args(w3, proto.FireDelete), proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerWrapUpCancel, proto.WorkerArgs{ID: w1}, proto.ErrInvalidState)
	// Dirty: delete refused at arm time, keep fine.
	wb.git.mu.Lock()
	wb.git.dirty[wrapWT1] = []string{" M main.go"}
	wb.git.mu.Unlock()
	c.mustError(proto.CmdWorkerWrapUp, args(w1, proto.FireDelete), proto.ErrNotClean)
	if got, _ := wb.st.WrapUps(context.Background()); len(got) != 0 {
		t.Fatalf("stored after a refusal: %+v", got)
	}
	wb.git.mu.Lock()
	delete(wb.git.dirty, wrapWT1)
	wb.git.mu.Unlock()
	wb.arm(t, c, "w1", proto.FireKeep)
	c.mustError(proto.CmdWorkerWrapUp, args(w1, proto.FireKeep), proto.ErrBusy)
	evs, _ := c.mustAck(proto.CmdWorkerWrapUpCancel, proto.WorkerArgs{ID: w1})
	wrapUpIn(c, evs, w1, noWrapUp)
	if got, _ := wb.st.WrapUps(context.Background()); len(got) != 0 {
		t.Fatalf("stored after cancel: %+v", got)
	}
	// Blocked: its question first.
	wb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "blocked" })
	wb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].Status == "blocked" })
	c.mustError(proto.CmdWorkerWrapUp, args(w1, proto.FireKeep), proto.ErrInvalidState)
}

// Without transcripts read, there is no wrap-up.
func TestWrapUpNeedsTranscripts(t *testing.T) {
	wb := startWrapBridge(t, "", "", func(o *server.Options) { o.Usage = nil })
	c := wb.connect(proto.Hello{})
	c.snapshot()
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: wb.ids["w1"], Prompt: cleanup}, proto.ErrInternal)
}
