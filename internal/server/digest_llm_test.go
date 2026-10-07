package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #118 phase 2: the floor overview summaries against the follow-up bridge
// (w1 a Claude agent, w2 a Codex one, both one-off workers), the real
// transcript fixtures the usage tracker reads, and a fake LLM.

// dgRoles plays the AI integration's LLM: ready unless set otherwise. Its
// View names the model and the endpoint (the audit's).
type dgRoles struct {
	mu    sync.Mutex
	state ai.State
	llm   *ai.FakeLLM
	// reason is what the model's catalog says of its reasoning (#174; nil:
	// nothing known).
	reason *ai.Reasoning
}

const (
	dgTaskLine = "Build the lounge wall screen"
	dgNowLine  = "Running the Go tests after the screen change"
)

func newDgRoles() *dgRoles {
	r := &dgRoles{state: ai.StateReady, llm: &ai.FakeLLM{}}
	r.llm.Func = func(_ context.Context, req ai.Request) (string, error) {
		if strings.Contains(req.Messages[0].Content, "label the task") {
			return `"` + dgTaskLine + `."`, nil
		}
		return "**" + dgNowLine + "**", nil
	}
	return r
}

func (r *dgRoles) State(ai.Role) ai.State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state
}
func (r *dgRoles) set(s ai.State)             { r.mu.Lock(); r.state = s; r.mu.Unlock() }
func (r *dgRoles) Fingerprint(ai.Role) string { return "llm-fp" }
func (r *dgRoles) LLM() ai.LLM                { return r.llm }
func (r *dgRoles) KnownReasoning() ai.Reasoning {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.reason == nil {
		return ai.UnknownReasoning()
	}
	return *r.reason
}
func (r *dgRoles) ModelReasoning(context.Context) ai.Reasoning { return r.KnownReasoning() }
func (r *dgRoles) View() ai.View {
	return ai.View{LLM: ai.LLMView{BaseURL: "https://llm.example:8443/v1", Model: "mimo-v2.6-flash"}}
}

// calls are the LLM's requests of a kind ("task" or "now").
func (r *dgRoles) calls(kind string) []ai.Request {
	var out []ai.Request
	for _, c := range r.llm.Calls() {
		if strings.Contains(c.Messages[0].Content, "label the task") == (kind == digest.KindTask) {
			out = append(out, c)
		}
	}
	return out
}

// startDgBridge is the follow-up bridge with the summaries: env is the
// environment's toggle, gap the per-worker gap (0: an hour).
func startDgBridge(t *testing.T, db, dir string, roles *dgRoles, env *bool, gap time.Duration) *fuBridge {
	t.Helper()
	if gap == 0 {
		gap = time.Hour
	}
	return startFuBridgeWith(t, db, dir, newFuRoles(), nil, "", func(o *server.Options) {
		o.DigestRoles, o.DigestEnabled = roles, env
		o.DigestSettle, o.DigestGap = 40*time.Millisecond, gap
	})
}

// dgTurn appends a fixture's turn without its recap line (a recap newer
// than the model's line would show instead).
func (fb *fuBridge) dgTurn(t *testing.T, harness, fixture string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "transcript", "testdata", harness, fixture))
	if err != nil {
		t.Fatal(err)
	}
	var keep []string
	for _, l := range strings.SplitAfter(string(b), "\n") {
		if !strings.Contains(l, "away_summary") {
			keep = append(keep, l)
		}
	}
	path := fb.claude
	if harness == "codex" {
		path = fb.codex
	}
	appendTo(t, path, strings.Join(keep, ""))
}

// upsertIn is upsertFor that looks at the events a command's ack came
// after first (a line can be written before the ack goes).
func upsertIn(c *client, evs []proto.Event, id string, ok func(*proto.Worker) bool) *proto.Worker {
	c.t.Helper()
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ok(ev.Worker) {
			return ev.Worker
		}
	}
	return upsertFor(c, id, ok)
}

// upsertsIn waits for an upsert of each id that ok accepts, in any order,
// the events a command's ack came after first.
func upsertsIn(c *client, evs []proto.Event, ok func(*proto.Worker) bool, ids ...string) map[string]*proto.Worker {
	c.t.Helper()
	got := map[string]*proto.Worker{}
	take := func(ev proto.Event) {
		if ev.T != proto.EvWorkerUpsert || !ok(ev.Worker) {
			return
		}
		for _, id := range ids {
			if ev.Worker.ID == id {
				got[id] = ev.Worker
			}
		}
	}
	for _, ev := range evs {
		take(ev)
	}
	for len(got) < len(ids) {
		take(c.event())
	}
	return got
}

func llmDigest(w *proto.Worker) bool {
	return w.Digest != nil && w.Digest.NowSource == proto.DigestLLM && w.Digest.TaskSource == proto.DigestLLM
}

// Claude and Codex: once a client stands on the floor, each one-off
// worker's task line and, after its turn ended and settled, its now line
// come from the model (source llm). The now request holds the last steps'
// texts and tool calls, never a tool's output.
func TestDigestSummariesClaudeAndCodex(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, on(), 0)
	c := fb.connect(proto.Hello{})
	if d := c.snapshot().World.Digest; d == nil || d.State != proto.DigestReady || !d.Enabled || d.DailyCap != digest.DefaultDailyCap {
		t.Fatalf("snapshot digest = %+v", d)
	}
	// Nobody on the floor: nothing is sent.
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	fb.dgTurn(t, "codex", "digest_turns.jsonl")
	fuQuiet()
	if n := len(roles.llm.Calls()); n != 0 {
		t.Fatalf("%d calls with nobody on the floor", n)
	}
	evs, _ := c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	got := upsertsIn(c, evs, llmDigest, fb.ids["w1"], fb.ids["w2"])
	if d := *got[fb.ids["w1"]].Digest; d.Task != dgTaskLine || d.Now != dgNowLine || d.NowAt == 0 {
		t.Fatalf("w1 digest = %+v", d)
	}
	if d := *got[fb.ids["w2"]].Digest; d.Task != dgTaskLine || d.Now != dgNowLine {
		t.Fatalf("w2 digest = %+v", d)
	}
	var claudeNow, codexNow string
	for _, r := range roles.calls(digest.KindNow) {
		data := r.Messages[1].Content
		if strings.Contains(data, "lounge wall is free") {
			claudeNow = data
		}
		if strings.Contains(data, "Ported; running the tests.") {
			codexNow = data
		}
		if r.MaxTokens == 0 {
			t.Fatal("no MaxTokens")
		}
	}
	if !strings.Contains(claudeNow, "- tool Bash: go test ./...") || !strings.Contains(claudeNow, "Context: Task: "+dgTaskLine) {
		t.Fatalf("claude now input = %s", claudeNow)
	}
	if !strings.Contains(codexNow, "- tool exec_command: gh pr create --fill") || strings.Contains(codexNow, "example.test/pr/1") ||
		strings.Contains(codexNow, "importer.go") {
		t.Fatalf("codex now input = %s", codexNow)
	}
	tasks := roles.calls(digest.KindTask)
	if len(tasks) != 2 {
		t.Fatalf("task calls = %d", len(tasks))
	}
	// A reconnect's snapshot has the lines.
	ws := workersOf(fb.connect(proto.Hello{}).snapshot().World, "s")
	if d := ws["w1"].Digest; d == nil || d.NowSource != proto.DigestLLM || d.Now != dgNowLine {
		t.Fatalf("snapshot digest = %+v", d)
	}
	// The calls are audited: sizes, the model and the endpoint's host, never
	// the text.
	log, err := fb.bridge.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows int
	for _, e := range log {
		if e.Cmd != "digest.summarize" {
			continue
		}
		rows++
		var a map[string]any
		if err := json.Unmarshal([]byte(e.Args), &a); err != nil {
			t.Fatal(err)
		}
		if a["model"] != "mimo-v2.6-flash" || a["host"] != "llm.example:8443" || a["sent_bytes"].(float64) <= 0 || a["answer_bytes"].(float64) <= 0 || !e.OK || e.Client != "bridge" {
			t.Fatalf("audit row = %+v", e)
		}
		for _, x := range []string{"go test", "Ported", "Hi.", "lounge", "Running"} {
			if strings.Contains(e.Args, x) {
				t.Fatalf("audit row holds %q: %s", x, e.Args)
			}
		}
	}
	if rows != len(roles.llm.Calls()) {
		t.Fatalf("%d audit rows for %d calls", rows, len(roles.llm.Calls()))
	}
}

// The task is written once per prompt; the now line at most once per gap
// per worker; a /clear starts over (the model's now line goes, the next
// prompt's task is written).
func TestDigestOncePerPromptAndGap(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, on(), 0)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], llmDigest)
	// Another turn of the same prompt: within the gap, no second now line.
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	fuQuiet()
	if n, m := len(roles.calls(digest.KindTask)), len(roles.calls(digest.KindNow)); n != 1 || m != 1 {
		t.Fatalf("task calls %d, now calls %d", n, m)
	}
	// /clear and a new prompt: the model's now line goes, a new task line.
	appendTo(t, fb.claude, `{"type":"system","subtype":"local_command","content":"","commandRun":{"command":"clear","args":""}}`+"\n"+wrapUser("Fix the elevator doors."))
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool {
		return w.Digest != nil && w.Digest.NowSource == "" && w.Digest.TaskSource == proto.DigestLLM
	})
	if w.Digest.Now != "" {
		t.Fatalf("after /clear: %+v", w.Digest)
	}
	fuQuiet()
	if n := len(roles.calls(digest.KindTask)); n != 2 || !strings.Contains(roles.calls(digest.KindTask)[1].Messages[1].Content, "Fix the elevator doors.") {
		t.Fatalf("task calls after /clear = %d", n)
	}
}

// With a short gap, each settled turn end gets its own now line.
func TestDigestGapOver(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, on(), 150*time.Millisecond)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "codex", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w2"], llmDigest)
	appendTo(t, fb.codex, `{"timestamp":"2026-10-03T11:02:00.000Z","type":"response_item","payload":{"type":"message","id":"msg_dg_4","role":"assistant","content":[{"type":"output_text","text":"Merged."}]}}`+"\n"+
		`{"timestamp":"2026-10-03T11:02:01.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"x","last_agent_message":"Merged."}}`+"\n")
	deadline := time.Now().Add(5 * time.Second)
	for len(roles.calls(digest.KindNow)) < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("now calls = %d", len(roles.calls(digest.KindNow)))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(roles.calls(digest.KindNow)[1].Messages[1].Content, "Merged.") {
		t.Fatal("the second now line is not of the newer steps")
	}
}

// Off by default: no call, and the lines are phase 1's exactly. Switching on
// needs a passing digest.test (test_required before), both through the
// protocol, each change a digest.update.
func TestDigestOffByDefaultAndTestRequired(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, nil, 0)
	c := fb.connect(proto.Hello{})
	if d := c.snapshot().World.Digest; d == nil || d.State != proto.DigestOff || d.Enabled || d.Tested {
		t.Fatalf("snapshot digest = %+v", d)
	}
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.turn(t, "claude", "digest_turns.jsonl")
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.NowSource == proto.DigestRecap })
	want := proto.WorkerDigest{Task: "Floor overview on the lounge wall", TaskSource: proto.DigestAITitle,
		Now: "Built the floor overview screen; the tests pass. Next: a review.", NowSource: proto.DigestRecap, NowAt: 1791021900000}
	if *w.Digest != want {
		t.Fatalf("digest while off = %+v", *w.Digest)
	}
	fuQuiet()
	if n := len(roles.llm.Calls()); n != 0 {
		t.Fatalf("%d calls while off", n)
	}
	c.mustError(proto.CmdDigestSet, proto.DigestSetArgs{Enabled: on()}, digest.CodeTestRequired)
	evs, m := c.command(proto.CmdDigestTest, "t", struct{}{})
	res := ackData[proto.DigestTestResult](t, m)
	if !res.OK || len(res.Samples) != 2 || res.Samples[0].Line != dgTaskLine || res.Samples[1].Line != dgNowLine {
		t.Fatalf("test = %+v", res)
	}
	if len(evs) != 1 || evs[0].T != proto.EvDigestUpdate {
		t.Fatalf("test events = %+v", evs)
	}
	evs, ack := c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{Enabled: on()})
	if !strings.Contains(mustJSONString(t, ack.Data), `"state":"ready"`) {
		t.Fatalf("set ack = %+v", ack.Data)
	}
	// On: the prompt already read gets its task line.
	upsertIn(c, evs, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.TaskSource == proto.DigestLLM })
	fuQuiet()
	// Off again: phase 1's lines are back at once, nothing more is sent.
	off := false
	evs, _ = c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{Enabled: &off})
	w = upsertIn(c, evs, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.TaskSource == proto.DigestAITitle })
	if *w.Digest != want {
		t.Fatalf("digest after off = %+v", *w.Digest)
	}
}

func mustJSONString(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// The environment's toggle switches it on without a test, read-only, but
// still needs the LLM ready: an invalid LLM sends nothing and shows the
// fallbacks.
func TestDigestEnvOverride(t *testing.T) {
	roles := newDgRoles()
	roles.set(ai.StateInvalid)
	fb := startDgBridge(t, "", "", roles, on(), 0)
	c := fb.connect(proto.Hello{})
	d := c.snapshot().World.Digest
	if d == nil || !d.Enabled || d.State != proto.DigestIncomplete || len(d.Env) != 1 || d.Env[0] != "enabled" {
		t.Fatalf("snapshot digest = %+v", d)
	}
	off := false
	c.mustError(proto.CmdDigestSet, proto.DigestSetArgs{Enabled: &off}, digest.CodeEnvLocked)
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.NowSource == proto.DigestTitle })
	fuQuiet()
	if n := len(roles.llm.Calls()); n != 0 {
		t.Fatalf("%d calls with the LLM invalid", n)
	}
}

// The daily cap: past it nothing more is sent, the lines written stay.
func TestDigestDailyCap(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, on(), time.Millisecond)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	cp := 2
	c.mustAck(proto.CmdDigestSet, proto.DigestSetArgs{DailyCap: &cp})
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], llmDigest) // its task and now: 2 calls
	fb.dgTurn(t, "codex", "digest_turns.jsonl")
	fuQuiet()
	if n := len(roles.llm.Calls()); n != 2 {
		t.Fatalf("%d calls with a cap of 2", n)
	}
	d := fb.connect(proto.Hello{}).snapshot().World
	if s := d.Digest; s.CallsToday != 2 || s.DailyCap != 2 || s.State != proto.DigestReady {
		t.Fatalf("digest state = %+v", s)
	}
	if w := workersOf(d, "s")["w1"]; !llmDigest(&w) {
		t.Fatalf("w1 lost its lines: %+v", w.Digest)
	}
}

// A restart spends nothing on inputs it wrote lines for: the cache is in
// the database, by the input's hash, and the lines show again.
func TestDigestCacheSurvivesRestart(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, on(), 0)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], llmDigest)
	fuQuiet()
	n := len(roles.llm.Calls())
	fb.stop()

	roles2 := newDgRoles()
	fb2 := startDgBridge(t, fb.db, fb.dir, roles2, on(), 0)
	c2 := fb2.connect(proto.Hello{})
	c2.snapshot()
	evs, _ := c2.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	upsertIn(c2, evs, fb2.ids["w1"], llmDigest)
	fuQuiet()
	if m := len(roles2.llm.Calls()); m != 0 || n == 0 {
		t.Fatalf("calls after a restart: %d (before: %d)", m, n)
	}
}

// A recap newer than the model's now line shows instead.
func TestDigestNewerRecapWins(t *testing.T) {
	roles := newDgRoles()
	fb := startDgBridge(t, "", "", roles, on(), 0)
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdBoardWatch, proto.BoardArgs{Session: "s"})
	fb.dgTurn(t, "claude", "digest_turns.jsonl")
	upsertFor(c, fb.ids["w1"], llmDigest)
	appendTo(t, fb.claude, `{"type":"system","subtype":"away_summary","content":"Waiting for the review.","timestamp":"2099-01-01T00:00:00.000Z","isSidechain":false}`+"\n")
	w := upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Digest != nil && w.Digest.NowSource == proto.DigestRecap })
	if w.Digest.Now != "Waiting for the review." || w.Digest.TaskSource != proto.DigestLLM {
		t.Fatalf("digest = %+v", w.Digest)
	}
}

// What is sent goes through the activity's scrub and ai's: the digest's own
// copy of the activity's patterns removes all it removes.
func TestDigestScrubCoversActivity(t *testing.T) {
	for _, s := range []string{
		"ghp_abcdefghijklmnop1234", "gho_abcdefgh12345678", "github_pat_11ABCDEFG_abcdefghijk", "AKIAABCDEFGHIJKLMNOP",
		"eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig", "https://bob:hunter2@example.com/x", "Authorization: Bearer abcdef0123456789",
		"sk-proj-abcdef123456", "tgp_abcdefgh", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
	} {
		if got, want := digest.Scrub("x "+s+" y"), activity.Scrub("x "+s+" y"); got != want {
			t.Errorf("digest.Scrub(%q) = %q, activity.Scrub = %q", s, got, want)
		}
	}
}
