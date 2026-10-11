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

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #90 follow-up questions against the fake herdr floor and laptop, real
// transcript files the usage tracker reads (the fixtures of
// internal/transcript/testdata) and the AI integration's fakes: w1 is a
// Claude agent (session wrapSess), w2 a Codex one (wrapCodex).

// fuRoles plays the AI integration: both roles ready unless set otherwise.
type fuRoles struct {
	mu    sync.Mutex
	state map[ai.Role]ai.State
	cls   *ai.FakeClassifier
	llm   *ai.FakeLLM
}

func newFuRoles() *fuRoles {
	r := &fuRoles{state: map[ai.Role]ai.State{ai.RoleClassifier: ai.StateReady, ai.RoleLLM: ai.StateReady},
		cls: &ai.FakeClassifier{}, llm: &ai.FakeLLM{Text: fuExtracted}}
	// The probe's scores: high for a message with questions, low for one
	// without.
	r.cls.Func = func(_ context.Context, state map[string]any, _ string) (float64, error) {
		if strings.Contains(state["last_agent_message"].(string), "?") {
			return 0.96, nil
		}
		return 0.02, nil
	}
	return r
}

func (r *fuRoles) State(x ai.Role) ai.State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state[x]
}
func (r *fuRoles) set(x ai.Role, s ai.State) {
	r.mu.Lock()
	r.state[x] = s
	r.mu.Unlock()
}
func (r *fuRoles) Fingerprint(x ai.Role) string { return string(x) + "-fp" }
func (r *fuRoles) Classifier() ai.Classifier    { return r.cls }
func (r *fuRoles) LLM() ai.LLM                  { return r.llm }
func (r *fuRoles) calls() (int, int)            { return len(r.cls.Calls()), len(r.llm.Calls()) }

const fuExtracted = `{"questions":[{"question":"Does the legacy importer still need the v1 format?","kind":"yes_no"},
	{"question":"Ship this already, or wait for the e2e-live run?","kind":"choice","options":["Ship now","Wait for e2e-live"]}]}`

const fuQuestionsText = "I refactored the session loader and all 42 tests pass.\n\n## Open questions for you\n" +
	"- Does the legacy importer still need the v1 format?\n" +
	"- Do you want to ship this already, or wait for the e2e-live run?"

type fuBridge struct {
	*hireBridge
	term          *fakeTerm
	roles         *fuRoles
	dir           string
	claude, codex string
	ids           map[string]string
}

// startFuBridge starts the bridge with w1 (Claude) and w2 (Codex) on db and
// transcripts under dir ("" each: new ones, empty sessions); on is the
// environment's toggle (nil: the stored one), w1Role w1's run role.
func startFuBridge(t *testing.T, db, dir string, roles *fuRoles, on *bool, w1Role string) *fuBridge {
	t.Helper()
	return startFuBridgeWith(t, db, dir, roles, on, w1Role, nil)
}

// startFuBridgeWith is startFuBridge with more options (tweak, after the
// follow-up ones).
func startFuBridgeWith(t *testing.T, db, dir string, roles *fuRoles, on *bool, w1Role string, tweak func(*server.Options)) *fuBridge {
	t.Helper()
	fresh := dir == ""
	if fresh {
		dir = t.TempDir()
	}
	fb := &fuBridge{term: newFakeTerm(), roles: roles, dir: dir,
		claude: filepath.Join(dir, "claude", "-home-u-w1", wrapSess+".jsonl"),
		codex:  filepath.Join(dir, "codex", "2026", "10", "01", "rollout-2026-10-01T09-00-00-"+wrapCodex+".jsonl")}
	if fresh {
		writeTranscript(t, fb.claude, wrapUser("Hi."))
		writeTranscript(t, fb.codex, `{"timestamp":"2026-10-01T09:00:00.000Z","type":"session_meta","payload":{"id":"`+wrapCodex+`","cwd":"`+wrapWT2+`"}}`+"\n")
	}
	w1 := linkedWorker("w1", "h3d/pixel-a1b2c3")
	w1.AgentSession, w1.Harness, w1.Status, w1.Role = wrapSess, world.HarnessClaude, "idle", w1Role
	w2 := withKind(linkedWorker("w2", "h3d/mochi-d4e5f6"), "codex")
	w2.AgentSession, w2.Harness, w2.Status = wrapCodex, world.HarnessCodex, "idle"
	fb.hireBridge = startHireBridgeAt(t, db, func(o *server.Options) {
		o.Term = fb.term
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: filepath.Join(dir, "claude"), CodexSessions: filepath.Join(dir, "codex")},
			Interval: 15 * time.Millisecond}
		o.FollowupRoles = roles
		o.FollowupsEnabled = on
		o.FollowupDebounce = 40 * time.Millisecond
		if tweak != nil {
			tweak(o)
		}
	}, w1, w2)
	fb.term.onTyped = func(pane string) { fb.fl.takeTurn(wsOf(pane)) }
	ws := workersOf(fb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 2 }), "s")
	fb.ids = map[string]string{}
	for k, w := range ws {
		fb.ids[k] = w.ID
	}
	return fb
}

// turn appends a fixture's turn to w1's (claude) or w2's (codex)
// transcript.
func (fb *fuBridge) turn(t *testing.T, harness, fixture string) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "transcript", "testdata", harness, fixture))
	if err != nil {
		t.Fatal(err)
	}
	path := fb.claude
	if harness == "codex" {
		path = fb.codex
	}
	appendTo(t, path, string(b))
}

func followupOf(c *client, id string) *proto.Worker {
	c.t.Helper()
	return upsertFor(c, id, func(w *proto.Worker) bool { return w.Followup != nil })
}

// quiet waits long enough for a turn to have been looked at (many usage
// rounds and debounces).
func fuQuiet() { time.Sleep(400 * time.Millisecond) }

func on() *bool { v := true; return &v }

// A Claude turn ending in open questions: the worker gets its follow-up;
// answering sends exactly one prompt with the answers and clears it; a stale
// turn is refused.
func TestFollowupClaudeFlagAndAnswer(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	fb := startFuBridge(t, "", "", roles, on(), "")
	c := fb.connect(proto.Hello{})
	s := c.snapshot()
	if f := s.World.Followups; f == nil || f.State != proto.FollowupsReady || !f.Enabled || f.Threshold != followup.DefaultThreshold {
		t.Fatalf("snapshot followups = %+v", f)
	}
	id := fb.ids["w1"]
	fb.turn(t, "claude", "followup_questions.jsonl")
	w := followupOf(c, id)
	f := w.Followup
	if f.Source != proto.FollowupModel || f.Score != 0.96 || len(f.Questions) != 2 || f.TurnID == "" || f.Tail != "" {
		t.Fatalf("followup = %+v", f)
	}
	if q := f.Questions[1]; q.ID != "q2" || q.Kind != proto.FollowupChoice || len(q.Options) != 2 {
		t.Fatalf("question 2 = %+v", q)
	}
	calls := roles.cls.Calls()
	if len(calls) != 1 || calls[0].State["last_agent_message"] != fuQuestionsText || calls[0].Question != followup.GateQuestion {
		t.Fatalf("classifier calls = %+v", calls)
	}
	if n := len(roles.llm.Calls()); n != 1 {
		t.Fatalf("%d LLM calls", n)
	}
	// Stale: another turn's id.
	_, m := c.command(proto.CmdWorkerAnswerFollowup, "a0", proto.WorkerAnswerFollowupArgs{ID: id, TurnID: "0123456789abcdef",
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "No"}}})
	if m.env.T != proto.TError || !strings.Contains(string(m.raw), `"code":"stale"`) {
		t.Fatalf("stale answer: %s", m.raw)
	}
	// Bad: a yes/no question answered otherwise.
	_, m = c.command(proto.CmdWorkerAnswerFollowup, "a1", proto.WorkerAnswerFollowupArgs{ID: id, TurnID: f.TurnID,
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "Maybe"}}})
	if !strings.Contains(string(m.raw), `"code":"bad_request"`) {
		t.Fatalf("bad answer: %s", m.raw)
	}
	evs, m := c.command(proto.CmdWorkerAnswerFollowup, "a2", proto.WorkerAnswerFollowupArgs{ID: id, TurnID: f.TurnID,
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "No"}, {ID: "q2", Value: "Wait for e2e-live", Note: "Ping me when it is green."}}})
	if m.env.T != proto.TAck {
		t.Fatalf("answer: %s", m.raw)
	}
	want := "Answers to your open questions:\n" +
		"1. Does the legacy importer still need the v1 format? → No\n" +
		"2. Ship this already, or wait for the e2e-live run? → Wait for e2e-live Ping me when it is green."
	var typed []string
	for _, call := range fb.term.Calls() {
		if strings.HasPrefix(call, "type w1:p1 ") {
			typed = append(typed, call)
		}
	}
	if b, _ := json.Marshal(want); len(typed) != 1 || typed[0] != "type w1:p1 "+string(b) {
		t.Fatalf("typed = %q, want one %q", typed, want)
	}
	cleared := false
	for _, ev := range evs {
		cleared = cleared || (ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.Followup == nil)
	}
	if !cleared {
		upsertFor(c, id, func(w *proto.Worker) bool { return w.Followup == nil })
	}
	// The audit log has the lengths, never the answers.
	row := auditRow(t, fb.bridge, proto.CmdWorkerAnswerFollowup)
	if log, _ := fb.st.AuditLog(context.Background()); strings.Contains(log[len(log)-1].Args, "e2e-live") || !row.OK {
		t.Fatalf("audit = %+v %s", row, log[len(log)-1].Args)
	}
	_, m = c.command(proto.CmdWorkerAnswerFollowup, "a3", proto.WorkerAnswerFollowupArgs{ID: id, TurnID: f.TurnID,
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "No"}}})
	if !strings.Contains(string(m.raw), `"code":"stale"`) {
		t.Fatalf("answered twice: %s", m.raw)
	}
}

// Codex: its rollout's final message flags w2.
func TestFollowupCodex(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	fb := startFuBridge(t, "", "", roles, on(), "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.turn(t, "codex", "followup_questions.jsonl")
	w := followupOf(c, fb.ids["w2"])
	if len(w.Followup.Questions) != 2 || roles.cls.Calls()[0].State["last_agent_message"] != fuQuestionsText {
		t.Fatalf("followup = %+v", w.Followup)
	}
}

// A plain summary: classified, no LLM call, no flag. A freelancer's turn
// with questions: no call at all.
func TestFollowupNoFlag(t *testing.T) {
	t.Parallel()
	t.Run("summary", func(t *testing.T) {
		roles := newFuRoles()
		fb := startFuBridge(t, "", "", roles, on(), "")
		fb.turn(t, "claude", "followup_summary.jsonl")
		fb.turn(t, "codex", "followup_summary.jsonl")
		waitFor(t, "two classifications", func() bool { c, _ := roles.calls(); return c == 2 })
		fuQuiet()
		if c, l := roles.calls(); c != 2 || l != 0 {
			t.Fatalf("calls = %d, %d; want 2 classifications, no LLM", c, l)
		}
		fb.noFollowups(t)
	})
	t.Run("freelancer", func(t *testing.T) {
		roles := newFuRoles()
		fb := startFuBridge(t, "", "", roles, on(), "review")
		fb.turn(t, "claude", "followup_freelancer.jsonl")
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls = %d, %d for a freelancer", c, l)
		}
		fb.noFollowups(t)
	})
}

func (fb *fuBridge) noFollowups(t *testing.T) {
	t.Helper()
	for k, w := range workersOf(fb.world(func(proto.World) bool { return true }), "s") {
		if w.Followup != nil {
			t.Fatalf("%s has a follow-up: %+v", k, w.Followup)
		}
	}
}

// Switched off, not ready, a role invalid: zero calls on turn end, and
// nothing changes.
func TestFollowupOffMakesNoCall(t *testing.T) {
	t.Parallel()
	t.Run("off", func(t *testing.T) {
		roles := newFuRoles() // the models ready: configured, not switched on
		fb := startFuBridge(t, "", "", roles, nil, "")
		c := fb.connect(proto.Hello{})
		if f := c.snapshot().World.Followups; f.State != proto.FollowupsOff || f.Enabled {
			t.Fatalf("followups = %+v", f)
		}
		fb.turn(t, "claude", "followup_questions.jsonl")
		fb.turn(t, "codex", "followup_questions.jsonl")
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls while off: %d, %d", c, l)
		}
		fb.noFollowups(t)
	})
	t.Run("role invalid", func(t *testing.T) {
		roles := newFuRoles()
		roles.set(ai.RoleClassifier, ai.StateInvalid)
		fb := startFuBridge(t, "", "", roles, on(), "")
		c := fb.connect(proto.Hello{})
		if f := c.snapshot().World.Followups; f.State != proto.FollowupsIncomplete || len(f.Missing) != 1 || f.Missing[0] != "classifier" {
			t.Fatalf("followups = %+v", f)
		}
		fb.turn(t, "claude", "followup_questions.jsonl")
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls with a role invalid: %d, %d", c, l)
		}
		fb.noFollowups(t)
	})
}

// A pending ask or a blocked worker: the classifier is not called.
func TestFollowupSkipsAskAndBlocked(t *testing.T) {
	t.Parallel()
	t.Run("ask", func(t *testing.T) {
		roles := newFuRoles()
		fb := startFuBridge(t, "", "", roles, on(), "")
		c := fb.connect(proto.Hello{})
		c.snapshot()
		ask := `{"type":"assistant","isSidechain":false,"message":{"id":"m_ask","role":"assistant","content":[{"type":"tool_use",` +
			`"id":"toolu_01Ask","name":"AskUserQuestion","input":{"questions":[{"header":"Drink","question":"Tea or coffee?",` +
			`"multiSelect":false,"options":[{"label":"Tea"},{"label":"Coffee"}]}]}}],"stop_reason":"tool_use"}}` + "\n"
		appendTo(t, fb.claude, ask+wrapSay("m_q", "Which one do you want?", "end_turn")+wrapTurnEnd)
		upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Ask != nil })
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls with an ask pending: %d, %d", c, l)
		}
	})
	t.Run("blocked", func(t *testing.T) {
		roles := newFuRoles()
		fb := startFuBridge(t, "", "", roles, on(), "")
		fb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "blocked" })
		fb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].Status == "blocked" })
		fb.turn(t, "claude", "followup_questions.jsonl")
		fuQuiet()
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls while blocked: %d, %d", c, l)
		}
	})
}

// The LLM failing still flags the worker, with one open item and the
// message's tail.
func TestFollowupFallback(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	roles.llm.Text = "no json here"
	fb := startFuBridge(t, "", "", roles, on(), "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.turn(t, "claude", "followup_questions.jsonl")
	f := followupOf(c, fb.ids["w1"]).Followup
	if f.Source != proto.FollowupFallback || len(f.Questions) != 1 || f.Questions[0].Kind != proto.FollowupOpen || f.Tail != fuQuestionsText {
		t.Fatalf("followup = %+v", f)
	}
	// The free answer goes as it is.
	_, m := c.command(proto.CmdWorkerAnswerFollowup, "a", proto.WorkerAnswerFollowupArgs{ID: fb.ids["w1"], TurnID: f.TurnID,
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "Keep v1. Ship it."}}})
	if m.env.T != proto.TAck {
		t.Fatalf("answer: %s", m.raw)
	}
	if calls := fb.term.Calls(); !strings.Contains(strings.Join(calls, "\n"), `type w1:p1 "Keep v1. Ship it."`) {
		t.Fatalf("calls = %q", calls)
	}
}

// Typing a prompt, dismissing, or the worker at work again clears it.
func TestFollowupClears(t *testing.T) {
	t.Parallel()
	flag := func(t *testing.T) (*fuBridge, *client, *proto.Followup) {
		roles := newFuRoles()
		fb := startFuBridge(t, "", "", roles, on(), "")
		c := fb.connect(proto.Hello{})
		c.snapshot()
		fb.turn(t, "claude", "followup_questions.jsonl")
		return fb, c, followupOf(c, fb.ids["w1"]).Followup
	}
	cleared := func(c *client, id string) {
		c.t.Helper()
		upsertFor(c, id, func(w *proto.Worker) bool { return w.Followup == nil })
	}
	t.Run("prompt", func(t *testing.T) {
		fb, c, _ := flag(t)
		c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "p", Args: mustMarshal(t, proto.WorkerPromptArgs{ID: fb.ids["w1"], Text: "Never mind."})})
		cleared(c, fb.ids["w1"])
	})
	t.Run("keys", func(t *testing.T) {
		fb, c, _ := flag(t)
		k := "ctrl+c"
		c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "k", Args: mustMarshal(t, proto.WorkerKeysArgs{ID: fb.ids["w1"], Input: []proto.InputItem{{Key: &k}}})})
		cleared(c, fb.ids["w1"])
	})
	t.Run("dismiss", func(t *testing.T) {
		fb, c, f := flag(t)
		evs, m := c.command(proto.CmdWorkerDismissFollowup, "d", proto.WorkerDismissFollowupArgs{ID: fb.ids["w1"], TurnID: f.TurnID})
		if m.env.T != proto.TAck || len(evs) != 1 || evs[0].Worker.Followup != nil {
			t.Fatalf("dismiss: %s %+v", m.raw, evs)
		}
		_, m = c.command(proto.CmdWorkerDismissFollowup, "d2", proto.WorkerDismissFollowupArgs{ID: fb.ids["w1"], TurnID: f.TurnID})
		if !strings.Contains(string(m.raw), `"code":"stale"`) {
			t.Fatalf("dismissed twice: %s", m.raw)
		}
	})
	t.Run("working", func(t *testing.T) {
		fb, c, _ := flag(t)
		fb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "working" })
		cleared(c, fb.ids["w1"])
	})
}

func mustMarshal(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The same message after a restart: no second classification and no
// re-flag once dealt with; an open one comes back as it was.
func TestFollowupRestart(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	fb := startFuBridge(t, "", "", roles, on(), "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.turn(t, "claude", "followup_questions.jsonl")
	f := followupOf(c, fb.ids["w1"]).Followup
	fb.stop()

	// Open: restored, not classified again.
	fb2 := startFuBridge(t, fb.db, fb.dir, roles, on(), "")
	c2 := fb2.connect(proto.Hello{})
	c2.snapshot()
	w := followupOf(c2, fb2.ids["w1"])
	if w.Followup.TurnID != f.TurnID || len(w.Followup.Questions) != 2 {
		t.Fatalf("restored = %+v", w.Followup)
	}
	if c, l := roles.calls(); c != 1 || l != 1 {
		t.Fatalf("calls after a restart: %d, %d", c, l)
	}
	if _, m := c2.command(proto.CmdWorkerDismissFollowup, "d", proto.WorkerDismissFollowupArgs{ID: fb2.ids["w1"], TurnID: f.TurnID}); m.env.T != proto.TAck {
		t.Fatalf("dismiss: %s", m.raw)
	}
	fb2.stop()

	// Dismissed: not again.
	fb3 := startFuBridge(t, fb.db, fb.dir, roles, on(), "")
	fuQuiet()
	if c, l := roles.calls(); c != 1 || l != 1 {
		t.Fatalf("calls after the second restart: %d, %d", c, l)
	}
	fb3.noFollowups(t)
}

// followups.test must pass before followups.set can switch the feature on;
// both go through the protocol and publish followups.update.
func TestFollowupsSettings(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	fb := startFuBridge(t, "", "", roles, nil, "")
	// The usage tracker's first read is in before the commands, whose events
	// are counted.
	fb.world(func(w proto.World) bool {
		ws := workersOf(w, "s")
		return ws["w1"].Usage != nil && ws["w2"].Usage != nil
	})
	c := fb.connect(proto.Hello{})
	c.snapshot()
	enable := proto.FollowupsSetArgs{Enabled: on()}
	if _, m := c.command(proto.CmdFollowupsSet, "s1", enable); !strings.Contains(string(m.raw), `"code":"test_required"`) {
		t.Fatalf("enable untested: %s", m.raw)
	}
	evs, m := c.command(proto.CmdFollowupsTest, "t1", proto.FollowupsTestArgs{})
	var ack struct {
		Data proto.FollowupsTestResult `json:"data"`
	}
	_ = json.Unmarshal(m.raw, &ack)
	res := ack.Data
	if m.env.T != proto.TAck || !res.OK || len(res.Samples) != 2 ||
		res.Samples[0].Score != 0.96 || res.Samples[1].Score != 0.02 || len(res.Samples[0].Questions) != 2 {
		t.Fatalf("test: %s", m.raw)
	}
	if len(evs) != 1 || evs[0].T != proto.EvFollowupsUpdate || !evs[0].Followups.Tested {
		t.Fatalf("events of the test: %+v", evs)
	}
	evs, m = c.command(proto.CmdFollowupsSet, "s2", proto.FollowupsSetArgs{Enabled: on(), Threshold: ptrTo(0.8)})
	if m.env.T != proto.TAck || len(evs) != 1 || evs[0].Followups.State != proto.FollowupsReady || evs[0].Followups.Threshold != 0.8 {
		t.Fatalf("enable: %s %+v", m.raw, evs)
	}
	if _, m := c.command(proto.CmdFollowupsGet, "g", nil); !strings.Contains(string(m.raw), `"state":"ready"`) {
		t.Fatalf("get: %s", m.raw)
	}
}

func ptrTo[T any](v T) *T { return &v }

// herdr seeing the worker at work while its message is being looked at: the
// result is recorded, not shown, even when it is idle again by then with the
// same transcript tail.
func TestFollowupWorkingDropsTheLookUnderWay(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	entered, release := make(chan struct{}), make(chan struct{})
	roles.cls.Func = func(context.Context, map[string]any, string) (float64, error) {
		close(entered)
		<-release
		return 0.96, nil
	}
	fb := startFuBridge(t, "", "", roles, on(), "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.turn(t, "claude", "followup_questions.jsonl")
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the classifier was not called")
	}
	fb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "working" })
	fb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].Status == "working" })
	fb.fl.update("w1", func(w *world.WorkerObs) { w.Status = "idle" })
	fb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].Status == "idle" })
	close(release)
	fuQuiet()
	fb.noFollowups(t)
	if cls, llm := roles.calls(); cls != 1 || llm != 1 {
		t.Fatalf("calls = %d, %d; want the one look, not another", cls, llm)
	}
}

// A new prompt and turn in the transcript (too short for herdr to report it
// working) clear the shown follow-up: its turn_id is stale, and the newer
// message is looked at in its place.
func TestFollowupNewTurnClearsIt(t *testing.T) {
	t.Parallel()
	roles := newFuRoles()
	fb := startFuBridge(t, "", "", roles, on(), "")
	c := fb.connect(proto.Hello{})
	c.snapshot()
	fb.turn(t, "claude", "followup_questions.jsonl")
	f := followupOf(c, fb.ids["w1"]).Followup
	fb.turn(t, "claude", "followup_summary.jsonl")
	upsertFor(c, fb.ids["w1"], func(w *proto.Worker) bool { return w.Followup == nil })
	waitFor(t, "the summary classified", func() bool { cls, _ := roles.calls(); return cls == 2 })
	fuQuiet()
	fb.noFollowups(t)
	_, m := c.command(proto.CmdWorkerAnswerFollowup, "old", proto.WorkerAnswerFollowupArgs{ID: fb.ids["w1"], TurnID: f.TurnID,
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "No"}}})
	if !strings.Contains(string(m.raw), `"code":"stale"`) {
		t.Fatalf("the old turn's answer: %s", m.raw)
	}
	for _, call := range fb.term.Calls() {
		if strings.HasPrefix(call, "type w1:p1 ") {
			t.Fatalf("typed: %s", call)
		}
	}
}
