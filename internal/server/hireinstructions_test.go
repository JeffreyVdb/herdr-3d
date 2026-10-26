package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// floorLineOf is the floor line of floor (#58), as run.start's prompt has it.
func floorLineOf(floor string) string {
	return "Also tag every herdr workspace you create with the token h3d_floor=" + floor + ", " +
		"in the same herdr workspace report-metadata call as its other h3d_ tokens: it puts that agent on your floor."
}

// agentLineOf is the agent line (H3D-2): the harness, model and effort tokens.
const agentLineOf = "Also tag every herdr workspace you create with the tokens h3d_harness, h3d_model and h3d_effort, " +
	"the harness, model id and effort you start that agent with, in the same herdr workspace report-metadata call as the floor token: " +
	"use h3d_harness=claude for Claude Code and h3d_harness=codex for Codex. The floor shows them as that agent's model line."

// herdrLines are #95's herdr hiring instructions for floor: run.start's
// placement line, floor line and agent line, a blank line between them.
func herdrLines(floor string) string {
	return placementLine + "\n\n" + floorLineOf(floor) + "\n\n" + agentLineOf
}

// #95: the snapshot says the bridge adds the herdr hiring instructions, and
// hire.prepare's ack carries them for its floor (a virtual floor its own id,
// a client from before floor ids its session's).
func TestHirePrepareHerdrInstructions(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	c := hb.c
	if w := hb.connect(proto.Hello{}).snapshot().World; !w.HerdrInstructions {
		t.Fatal("snapshot has no herdr_instructions")
	}
	_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "s"})
	web := ack.Data.(map[string]any)["id"].(string)
	for _, tc := range []struct {
		args  proto.HirePrepareArgs
		floor string
	}{
		{proto.HirePrepareArgs{Floor: web}, web},
		{proto.HirePrepareArgs{Floor: "s"}, "s"},
		{proto.HirePrepareArgs{Session: "s"}, "s"},
	} {
		_, m := c.command(proto.CmdHirePrepare, "p", tc.args)
		if res := ackData[proto.HirePrepareResult](t, m); res.HerdrInstructions != herdrLines(tc.floor) {
			t.Fatalf("prepare %+v: herdr_instructions = %q", tc.args, res.HerdrInstructions)
		}
	}
}

// #95: worker.hire with herdr_instructions sends the prompt, a blank line
// and the herdr hiring instructions for the floor it hires on: a virtual
// floor's own id, two virtual floors of one session apart, the real floor's
// session, and the session for a client from before floor ids. Exactly
// hire.prepare's lines. Without the flag the prompt goes as it is.
func TestHireHerdrInstructions(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	c := hb.c
	floor := func(name string) string {
		_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: name, BaseSession: "s"})
		return ack.Data.(map[string]any)["id"].(string)
	}
	a, b := floor("A"), floor("B")
	const task = "For each pull request, spawn a subagent.\n"
	n := 0
	hire := func(floor, session string, flag bool) string {
		t.Helper()
		n++
		args := hireArgs(n)
		args.Session, args.Floor, args.Prompt, args.HerdrInstructions = session, floor, task, flag
		_, m := c.command(proto.CmdWorkerHire, "h"+strconv.Itoa(n), args)
		res := ackData[proto.HireResult](t, m)
		if res.Prompted == nil || !*res.Prompted {
			t.Fatalf("ack = %s", m.raw)
		}
		return sentPrompt(t, hb, res.WorkspaceID+":p1")
	}
	for _, tc := range []struct{ floor, session, want string }{
		{a, "", a},
		{b, "", b},
		{"s", "", "s"},
		{"", "s", "s"},
	} {
		got := hire(tc.floor, tc.session, true)
		if got != task+"\n\n"+herdrLines(tc.want) {
			t.Fatalf("floor %q session %q: prompt =\n%q", tc.floor, tc.session, got)
		}
		_, m := c.command(proto.CmdHirePrepare, "p", proto.HirePrepareArgs{Floor: tc.floor, Session: tc.session})
		if lines := ackData[proto.HirePrepareResult](t, m).HerdrInstructions; len(got) != len(task)+2+len(lines) {
			t.Fatalf("prompt is %d bytes, the task %d and hire.prepare's lines %d", len(got), len(task), len(lines))
		}
	}
	if got := hire(a, "", false); got != task {
		t.Fatalf("no flag: prompt = %q", got)
	}
}

// #95: the flag needs a task to add the lines to; the composed prompt is
// held to the prompt's rules (a task that fits alone and not with the lines
// is refused, before anything is made); Claude's typed prompt is checked
// whole too.
func TestHireHerdrInstructionsRules(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	c := hb.c
	for _, p := range []string{"", "  \n "} {
		args := hireArgs(0)
		args.Prompt, args.HerdrInstructions = p, true
		c.mustError(proto.CmdWorkerHire, args, proto.ErrBadRequest)
	}
	room := herdr.MaxPrompt - 2 - len(herdrLines("s"))
	for _, harness := range []string{"claude", "codex"} {
		args := hireArgs(0)
		if harness == "codex" {
			args.Harness, args.Model, args.Effort = "codex", "gpt-6-astra", "ultra"
		}
		args.Prompt, args.HerdrInstructions = strings.Repeat("x", room+1), true
		_, m := c.command(proto.CmdWorkerHire, "big-"+harness, args)
		if e := errorOf(m); e.Code != proto.ErrBadRequest {
			t.Fatalf("%s over the limit with the lines: %s", harness, m.raw)
		}
	}
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr calls = %q", calls)
	}
	args := hireArgs(0)
	args.Prompt, args.HerdrInstructions = strings.Repeat("x", room), true
	_, m := c.command(proto.CmdWorkerHire, "fits", args)
	res := ackData[proto.HireResult](t, m)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); len(got) != herdr.MaxPrompt {
		t.Fatalf("sent %d bytes", len(got))
	}
}

// #95: a Codex hire's typed text is translated (#39), never the lines the
// bridge adds: the translator only ever sees what the player typed.
func TestHireHerdrInstructionsTranslatesOnlyTheTask(t *testing.T) {
	t.Parallel()
	fp := &fakePrompts{}
	hb := startHireBridge(t, func(o *server.Options) { o.Prompts = fp })
	const typed = "run /grill on @a.go"
	args := hireArgs(0)
	args.Harness, args.Model, args.Effort = "codex", "gpt-6-astra", "ultra"
	args.Prompt, args.HerdrInstructions = typed, true
	_, m := hb.c.command(proto.CmdWorkerHire, "h", args)
	res := ackData[proto.HireResult](t, m)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != "run $grill on a.go\n\n"+herdrLines("s") {
		t.Fatalf("codex got %q", got)
	}
	if asks := cachedAsks(fp); !slices.Equal(asks, []string{"cached codex /home/u /home/u " + typed}) {
		t.Fatalf("asks = %q", asks)
	}
}

// #95: a preset keeps "Add herdr hiring instructions": off unless sent,
// replaced by an update (the whole spec), in every client's events and the
// snapshot after a restart; its prompt is only what was typed.
func TestHirePresetHerdrInstructions(t *testing.T) {
	t.Parallel()
	claude, _, _ := catalogTuples(t)
	hb := startHireBridge(t, nil)
	c := hb.c
	other := hb.connect(proto.Hello{Client: "other"})
	other.snapshot()
	spec := proto.HirePresetSpec{Name: "Dependabot", Prompt: "Merge all dependabot pull requests.", Harness: claude.Harness,
		Model: claude.Model, Effort: claude.Effort, HerdrInstructions: true}
	evs, ack := c.mustAck(proto.CmdHirePresetCreate, spec)
	raw, _ := json.Marshal(ack.Data)
	var made proto.HirePreset
	_ = json.Unmarshal(raw, &made)
	if !made.HerdrInstructions || made.Prompt != spec.Prompt || len(evs) != 1 || !evs[0].HirePreset.HerdrInstructions {
		t.Fatalf("created %s, events %+v", raw, evs)
	}
	if ev := other.until(proto.EvHirePresetUpsert); !ev.HirePreset.HerdrInstructions {
		t.Fatalf("other client: %+v", ev.HirePreset)
	}
	plain := spec
	plain.Name, plain.HerdrInstructions = "Plain", false
	_, ack = c.mustAck(proto.CmdHirePresetCreate, plain)
	if raw, _ := json.Marshal(ack.Data); strings.Contains(string(raw), "herdr_instructions") {
		t.Fatalf("an unticked preset = %s", raw)
	}
	// Unticking is a change (an event); the same spec again is none.
	off := spec
	off.HerdrInstructions = false
	evs, _ = c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: off})
	if len(evs) != 1 || evs[0].HirePreset.HerdrInstructions || evs[0].HirePreset.UpdatedAt <= made.UpdatedAt {
		t.Fatalf("untick events = %+v", evs)
	}
	if evs, _ = c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: off}); len(evs) != 0 {
		t.Fatalf("unchanged update emitted %+v", evs)
	}
	c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: spec})

	hb.stop()
	hb = startHireBridgeAt(t, hb.db, nil)
	got := hb.connect(proto.Hello{}).snapshot().World.HirePresets
	if len(got) != 2 || got[0].Name != "Dependabot" || !got[0].HerdrInstructions || got[0].Prompt != spec.Prompt || got[1].HerdrInstructions {
		t.Fatalf("after restart = %+v", got)
	}
}

// hpCheck is hire_preset.check's ack for prompt.
func hpCheck(t *testing.T, c *client, prompt string) proto.HirePresetCheckResult {
	t.Helper()
	_, ack := c.mustAck(proto.CmdHirePresetCheck, proto.HirePresetCheckArgs{Prompt: prompt})
	var res proto.HirePresetCheckResult
	b, _ := json.Marshal(ack.Data)
	if err := json.Unmarshal(b, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

// checkQuestion is hire_preset.check's question: #127 counts a workspace
// recreated to resume another agent.
const checkQuestion = "Does this task tell the AI coding agent to start, spawn, hire, resume or hand work to other AI agents " +
	"(subagents, workers, coders, reviewers), including recreating a workspace to resume another agent, " +
	"instead of doing all of it itself?"

// #95: hire_preset.check asks the classifier whether a prompt hands work to
// other agents: delegates from 0.7 up. Below it, a classifier error, one
// that is not ready (no call) or none at all: delegates false, the preset
// saves as it is. The prompt is never audited, only its length.
func TestHirePresetCheck(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	score := 0.0
	roles.cls.Func = func(_ context.Context, state map[string]any, q string) (float64, error) {
		if q != checkQuestion || state["prompt"] == nil {
			return 0, errors.New("unexpected ask")
		}
		roles.mu.Lock()
		defer roles.mu.Unlock()
		if score < 0 {
			return 0, errors.New("provider says no")
		}
		return score, nil
	}
	setScore := func(s float64) {
		roles.mu.Lock()
		score = s
		roles.mu.Unlock()
	}
	hb := startHireBridge(t, func(o *server.Options) { o.HirePresetRoles = roles })
	c := hb.c
	const prompt = "For each pull request, spawn a subagent that merges it."
	setScore(0.93)
	if res := hpCheck(t, c, prompt); !res.Delegates || res.Score != 0.93 {
		t.Fatalf("0.93: %+v", res)
	}
	if calls := roles.cls.Calls(); len(calls) != 1 || calls[0].State["prompt"] != prompt {
		t.Fatalf("calls = %+v", calls)
	}
	setScore(0.7)
	if res := hpCheck(t, c, prompt); !res.Delegates {
		t.Fatalf("0.7: %+v", res)
	}
	setScore(0.69)
	if res := hpCheck(t, c, prompt); res.Delegates || res.Score != 0.69 {
		t.Fatalf("0.69: %+v", res)
	}
	setScore(-1)
	if res := hpCheck(t, c, prompt); res.Delegates || res.Score != 0 {
		t.Fatalf("error: %+v", res)
	}
	setScore(0.99)
	roles.set(ai.RoleClassifier, ai.StateInvalid)
	before := len(roles.cls.Calls())
	if res := hpCheck(t, c, prompt); res.Delegates {
		t.Fatalf("not ready: %+v", res)
	}
	if len(roles.cls.Calls()) != before {
		t.Fatal("the classifier was asked while not ready")
	}
	if row := auditRow(t, hb.bridge, proto.CmdHirePresetCheck); !row.OK || !row.Done {
		t.Fatalf("audit = %+v", row)
	}
	for _, p := range []string{"", "  ", strings.Repeat("x", herdr.MaxPrompt+1)} {
		c.mustError(proto.CmdHirePresetCheck, proto.HirePresetCheckArgs{Prompt: p}, proto.ErrBadRequest)
	}
	log, _ := hb.st.AuditLog(context.Background())
	for _, e := range log {
		if e.Cmd == proto.CmdHirePresetCheck && (strings.Contains(e.Args, "pull request") || !strings.Contains(e.Args, "prompt_bytes")) {
			t.Fatalf("audited args = %s", e.Args)
		}
	}

	// No AI integration at all: delegates false.
	bare := startHireBridge(t, nil)
	if res := hpCheck(t, bare.c, prompt); res.Delegates {
		t.Fatalf("no classifier: %+v", res)
	}
}

// #95: a classifier slower than the check's bound answers delegates false.
func TestHirePresetCheckTimesOut(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	roles.cls.Func = func(ctx context.Context, _ map[string]any, _ string) (float64, error) {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(5 * time.Second):
			return 0.99, nil
		}
	}
	hb := startHireBridge(t, func(o *server.Options) { o.HirePresetRoles, o.HirePresetCheckTimeout = roles, 50*time.Millisecond })
	start := time.Now()
	if res := hpCheck(t, hb.c, "Spawn workers."); res.Delegates {
		t.Fatalf("slow: %+v", res)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Fatalf("took %v", took)
	}
}

// #95: a hire on an asleep virtual floor wakes its session first and still
// gets the lines with the virtual floor's id.
func TestHireHerdrInstructionsOnAsleepVirtualFloor(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "", "idle"))
	sleepHireFloor(t, hb)
	args := hireArgs(0)
	args.Session, args.Floor, args.Prompt, args.HerdrInstructions = "", vWeb, "Spawn reviewers.", true
	_, m := hb.c.command(proto.CmdWorkerHire, "h", args)
	res := ackData[proto.HireResult](t, m)
	if !slices.Contains(hb.fl.Calls(), "start s") {
		t.Fatalf("herdr calls = %q", hb.fl.Calls())
	}
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != "Spawn reviewers.\n\n"+herdrLines(vWeb) {
		t.Fatalf("prompt = %q", got)
	}
}
