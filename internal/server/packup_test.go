package server_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/packup"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #110 pack up on request against the fake herdr floor and laptop and the
// AI integration's fakes.

// pkRoles plays the AI integration: both roles ready unless set otherwise.
// The classifier scores a prompt high when it says "end your turn", the LLM
// cuts that part.
type pkRoles struct {
	mu    sync.Mutex
	state map[ai.Role]ai.State
	cls   *ai.FakeClassifier
	llm   *ai.FakeLLM
}

func newPkRoles() *pkRoles {
	r := &pkRoles{state: map[ai.Role]ai.State{ai.RoleClassifier: ai.StateReady, ai.RoleLLM: ai.StateReady},
		cls: &ai.FakeClassifier{}, llm: &ai.FakeLLM{Text: `{"remove":[" and end your turn"]}`}}
	r.cls.Func = func(_ context.Context, state map[string]any, _ string) (float64, error) {
		if strings.Contains(state["prompt"].(string), "end your turn") {
			return 0.97, nil
		}
		return 0.03, nil
	}
	return r
}

func (r *pkRoles) State(x ai.Role) ai.State {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.state[x]
}
func (r *pkRoles) set(x ai.Role, s ai.State) {
	r.mu.Lock()
	r.state[x] = s
	r.mu.Unlock()
}
func (r *pkRoles) Fingerprint(x ai.Role) string { return string(x) + "-fp" }
func (r *pkRoles) Classifier() ai.Classifier    { return r.cls }
func (r *pkRoles) LLM() ai.LLM                  { return r.llm }
func (r *pkRoles) calls() (int, int)            { return len(r.cls.Calls()), len(r.llm.Calls()) }

const pkPrompt = "Please make a PR and end your turn"

// startPkBridge starts the bridge with w1 (Claude, run role w1Role), w2
// (Codex) and w3 (a plain shell); on is the environment's toggle (nil: the
// stored one).
func startPkBridge(t *testing.T, roles *pkRoles, on *bool, w1Role string, tweak func(*server.Options)) (*hireBridge, map[string]string) {
	t.Helper()
	w1 := linkedWorker("w1", "h3d/pixel-a1b2c3")
	w1.AgentSession, w1.Harness, w1.Status, w1.Role = wrapSess, world.HarnessClaude, "idle", w1Role
	w2 := withKind(linkedWorker("w2", "h3d/mochi-d4e5f6"), "codex")
	w2.AgentSession, w2.Harness, w2.Status = wrapCodex, world.HarnessCodex, "idle"
	hb := startHireBridgeAt(t, "", func(o *server.Options) {
		o.Term = newFakeTerm()
		o.PackupRoles = roles
		o.PackupEnabled = on
		if tweak != nil {
			tweak(o)
		}
	}, w1, w2, worker("w3", "notes", "", "unknown"))
	ids := map[string]string{}
	for k, w := range workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 3 }), "s") {
		ids[k] = w.ID
	}
	return hb, ids
}

func detect(t *testing.T, c *client, id, text string) proto.PackupDetectResult {
	t.Helper()
	_, ack := c.mustAck(proto.CmdPackupDetect, proto.PackupDetectArgs{ID: id, Text: text})
	var res proto.PackupDetectResult
	b, _ := json.Marshal(ack.Data)
	if err := json.Unmarshal(b, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

// Off, or a role not ready: packup.detect answers no match and no model is
// called.
func TestPackupDetectOffMakesNoCall(t *testing.T) {
	t.Parallel()
	t.Run("off", func(t *testing.T) {
		roles := newPkRoles() // the models ready: configured, not switched on
		hb, ids := startPkBridge(t, roles, nil, "", nil)
		c := hb.connect(proto.Hello{})
		if p := c.snapshot().World.Packup; p == nil || p.State != proto.PackupOff || p.Enabled || p.Threshold != packup.DefaultThreshold {
			t.Fatalf("packup = %+v", p)
		}
		if res := detect(t, c, ids["w1"], pkPrompt); res.Matched || res.Task != "" || res.Removed != nil {
			t.Fatalf("detect while off = %+v", res)
		}
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls while off: %d, %d", c, l)
		}
	})
	t.Run("role invalid", func(t *testing.T) {
		roles := newPkRoles()
		roles.set(ai.RoleLLM, ai.StateInvalid)
		hb, ids := startPkBridge(t, roles, on(), "", nil)
		c := hb.connect(proto.Hello{})
		if p := c.snapshot().World.Packup; p.State != proto.PackupIncomplete || len(p.Missing) != 1 || p.Missing[0] != "llm" {
			t.Fatalf("packup = %+v", p)
		}
		if res := detect(t, c, ids["w1"], pkPrompt); res.Matched {
			t.Fatalf("detect while incomplete = %+v", res)
		}
		if c, l := roles.calls(); c+l != 0 {
			t.Fatalf("calls with a role invalid: %d, %d", c, l)
		}
	})
}

// On: the leaving part is cut; a prompt that does not ask goes as written.
// The prompt is never in the audit log.
func TestPackupDetect(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, ids := startPkBridge(t, roles, on(), "", nil)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	res := detect(t, c, ids["w1"], pkPrompt)
	if !res.Matched || res.Task != "Please make a PR" || len(res.Removed) != 1 || res.Removed[0] != (proto.PackupRange{Start: 16, End: 34}) || res.Score != 0.97 {
		t.Fatalf("detect = %+v", res)
	}
	if res := detect(t, c, ids["w2"], "Please make a PR"); res.Matched || res.Score != 0.03 {
		t.Fatalf("detect of a plain prompt = %+v", res)
	}
	if c, l := roles.calls(); c != 2 || l != 1 {
		t.Fatalf("calls = %d, %d; want 2, 1", c, l)
	}
	log, _ := hb.st.AuditLog(context.Background())
	for _, e := range log {
		if e.Cmd == proto.CmdPackupDetect && (strings.Contains(e.Args, "PR") || !strings.Contains(e.Args, `"text_bytes":`)) {
			t.Fatalf("audit args = %s", e.Args)
		}
	}
	// Bad args are refused before any call.
	c.mustError(proto.CmdPackupDetect, proto.PackupDetectArgs{ID: ids["w1"], Text: "  "}, proto.ErrBadRequest)
	c.mustError(proto.CmdPackupDetect, proto.PackupDetectArgs{ID: "nope", Text: pkPrompt}, proto.ErrUnknownWorker)
	if c, _ := roles.calls(); c != 2 {
		t.Fatalf("classifier calls = %d", c)
	}
}

// Who: the wrap-up's workers only. A freelancer, a plain shell: no match,
// no call.
func TestPackupDetectSkips(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, ids := startPkBridge(t, roles, on(), "code", nil)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	for _, ws := range []string{"w1", "w3"} {
		if res := detect(t, c, ids[ws], pkPrompt); res.Matched {
			t.Fatalf("%s: detect = %+v", ws, res)
		}
	}
	if c, l := roles.calls(); c+l != 0 {
		t.Fatalf("calls = %d, %d", c, l)
	}
}

// A model failing or too slow: no match, within the timeout.
func TestPackupDetectFailsOpen(t *testing.T) {
	// Not parallel: it bounds the detection in wall-clock.
	roles := newPkRoles()
	block := make(chan struct{})
	defer close(block)
	roles.cls.Func = func(ctx context.Context, _ map[string]any, _ string) (float64, error) {
		select {
		case <-ctx.Done():
		case <-block:
		}
		return 0, &ai.Error{Kind: ai.KindTimeout, Msg: "the classifier timed out"}
	}
	hb, ids := startPkBridge(t, roles, on(), "", func(o *server.Options) { o.PackupTimeout = 80 * time.Millisecond })
	c := hb.connect(proto.Hello{})
	c.snapshot()
	start := time.Now()
	if res := detect(t, c, ids["w1"], pkPrompt); res.Matched {
		t.Fatalf("detect = %+v", res)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v", d)
	}
	roles.cls.Func = nil
	roles.cls.Score = 0.99
	roles.llm.Text = `{"remove":["not in the prompt"]}`
	if res := detect(t, c, ids["w1"], pkPrompt); res.Matched {
		t.Fatalf("detect with a tampered span = %+v", res)
	}
}

// The settings go through the protocol and publish packup.update.
func TestPackupSettings(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	roles.cls.Func = func(_ context.Context, state map[string]any, _ string) (float64, error) {
		for _, s := range packup.Samples {
			if s.Text == state["prompt"] && !s.Match {
				return 0.02, nil
			}
		}
		return 0.96, nil
	}
	roles.llm.Text = ""
	roles.llm.Func = func(_ context.Context, req ai.Request) (string, error) {
		p := strings.TrimPrefix(req.Messages[1].Content, "The prompt:\n\n")
		for _, s := range packup.Samples {
			if s.Text == p {
				b, _ := json.Marshal(map[string][]string{"remove": {strings.TrimPrefix(p, s.Task)}})
				return string(b), nil
			}
		}
		return "{}", nil
	}
	hb, _ := startPkBridge(t, roles, nil, "", nil)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	if _, m := c.command(proto.CmdPackupSet, "s1", proto.PackupSetArgs{Enabled: on()}); !strings.Contains(string(m.raw), `"code":"test_required"`) {
		t.Fatalf("enable untested: %s", m.raw)
	}
	evs, m := c.command(proto.CmdPackupTest, "t1", proto.PackupTestArgs{})
	var ack struct {
		Data proto.PackupTestResult `json:"data"`
	}
	_ = json.Unmarshal(m.raw, &ack)
	if m.env.T != proto.TAck || !ack.Data.OK || ack.Data.Total != len(packup.Samples) || ack.Data.Right != ack.Data.Total {
		t.Fatalf("test: %s", m.raw)
	}
	if len(evs) != 1 || evs[0].T != proto.EvPackupUpdate {
		t.Fatalf("events of the test: %+v", evs)
	}
	evs, m = c.command(proto.CmdPackupSet, "s2", proto.PackupSetArgs{Enabled: on(), Threshold: ptrTo(0.9)})
	if m.env.T != proto.TAck || len(evs) != 1 || evs[0].T != proto.EvPackupUpdate || !strings.Contains(string(m.raw), `"state":"ready"`) {
		t.Fatalf("enable: %s %+v", m.raw, evs)
	}
	if _, m := c.command(proto.CmdPackupGet, "g", nil); !strings.Contains(string(m.raw), `"threshold":0.9`) {
		t.Fatalf("get: %s", m.raw)
	}
	if p := hb.connect(proto.Hello{}).snapshot().World.Packup; !p.Enabled || p.State != proto.PackupReady || !p.Tested {
		t.Fatalf("snapshot = %+v", p)
	}
}

// The hand-off: "Send and go home" is worker.wrapup with the task and the
// cleanup request. The agent gets the task first, then the footer that
// makes a task that did not complete BLOCKED: the worker stays.
func TestPackupHandsOffToWrapUp(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	wb := startWrapBridge(t, "", "", func(o *server.Options) {
		o.PackupRoles = roles
		o.PackupEnabled = on()
	})
	c := wb.connect(proto.Hello{})
	c.snapshot()
	id := wb.ids["w1"]
	res := detect(t, c, id, pkPrompt)
	if !res.Matched || res.Task != "Please make a PR" {
		t.Fatalf("detect = %+v", res)
	}
	prompt := res.Task + "\n\n" + cleanup
	if _, m := c.command(proto.CmdWorkerWrapUp, "wrap", proto.WorkerWrapUpArgs{ID: id, Prompt: prompt, Worktree: proto.FireDeleteBranch}); m.env.T != proto.TAck {
		t.Fatalf("worker.wrapup: %s", m.raw)
	}
	text, nonce := wb.prompted(t, "w1:p1")
	if !strings.HasPrefix(text, "Please make a PR\n\n"+cleanup+"\n\nWhen you are done") ||
		!strings.Contains(text, "or, if the task did not complete, anything could not be stopped or needs a decision:\nH3D-WRAPUP "+nonce+" BLOCKED") {
		t.Fatalf("prompt = %q", text)
	}
	wb.reply(t, text, "CI is red, the PR is not open.\n\nH3D-WRAPUP "+nonce+" BLOCKED: the PR could not be opened")
	w := wrapUpOf(c, id, wrapState(proto.WrapUpNeedsYou))
	if w.WrapUp.Reason != "the PR could not be opened" {
		t.Fatalf("wrap-up = %+v", w.WrapUp)
	}
	if calls := wb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr calls = %q: the worker must stay", calls)
	}
}

// A provider's error can echo the prompt (an HTTP 400 quoting it): the
// bridge log has the failure's kind or code, never the error's text.
func TestPackupDetectNeverLogsTheProvidersWords(t *testing.T) {
	t.Parallel()
	const secret = "Please fix the confidential payroll formula and end your turn"
	echo := &ai.Error{Kind: ai.KindFailed, Msg: "the provider answered HTTP 400: Rejected prompt: " + secret}
	roles := newPkRoles()
	roles.cls.Func = func(context.Context, map[string]any, string) (float64, error) { return 0, echo }
	var logs logBuf
	hb, ids := startPkBridge(t, roles, on(), "", func(o *server.Options) {
		o.Log = slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	c := hb.connect(proto.Hello{})
	c.snapshot()
	if res := detect(t, c, ids["w1"], secret); res.Matched {
		t.Fatalf("detect with the classifier failing = %+v", res)
	}
	roles.cls.Func = nil
	roles.cls.Score = 0.99
	roles.llm.Text, roles.llm.Err = "", echo
	if res := detect(t, c, ids["w1"], secret); res.Matched {
		t.Fatalf("detect with the LLM failing = %+v", res)
	}
	failed, noMatch := logs.lines("pack-up detection failed"), logs.lines("pack-up extraction was no match")
	if len(failed) != 1 || !strings.Contains(failed[0], "kind=provider_failed") ||
		len(noMatch) != 1 || !strings.Contains(noMatch[0], "why=llm_provider_failed") {
		t.Fatalf("logs:\n%s", logs.b.String())
	}
	for _, w := range []string{"payroll", "confidential", "Rejected", "HTTP 400"} {
		if strings.Contains(logs.b.String(), w) {
			t.Fatalf("%q in the bridge log:\n%s", w, logs.b.String())
		}
	}
}
