package server_test

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #211 hire.interpret against the fake floor and the AI integration's fake
// LLM: a proposal, never a hire.

type hiRoles struct {
	state ai.State
	llm   *ai.FakeLLM
	cls   *ai.FakeClassifier // nil: no classifier
}

func (r *hiRoles) State(ai.Role) ai.State { return r.state }
func (r *hiRoles) LLM() ai.LLM            { return r.llm }
func (r *hiRoles) Classifier() ai.Classifier {
	if r.cls == nil {
		return nil
	}
	return r.cls
}

// hiCatalog is the bridge's catalog in these tests (Options.HireOptions).
var hiCatalog = proto.HireOptions{
	Claude: proto.HarnessOptions{Models: []string{"claude-haiku-5-5"}, Efforts: []string{"low", "medium", "high"},
		ExtraEfforts: map[string][]string{"claude-haiku-5-5": {"xhigh", "max"}}, ModelLabels: map[string]string{"claude-haiku-5-5": "Haiku 5.5"}},
	Codex: proto.HarnessOptions{Models: []string{"gpt-6.1-sol"}, Efforts: []string{"low", "medium", "high"},
		ExtraEfforts: map[string][]string{"gpt-6.1-sol": {"ultra"}}},
}

const hiText = "Hire a Claude Code agent on Haiku 5.5 to fix the login bug."

func startHiBridge(t *testing.T, roles *hiRoles) *hireBridge {
	t.Helper()
	return startHireBridge(t, func(o *server.Options) {
		cat := hiCatalog
		o.HireOptions = &cat
		if roles != nil {
			o.HireIntentRoles = roles
		}
	}, linkedWorker("w1", "h3d/pixel-a1b2c3"))
}

func interpretCmd(t *testing.T, c *client, id string, args proto.HireInterpretArgs) proto.HireInterpretResult {
	t.Helper()
	evs, m := c.command(proto.CmdHireInterpret, id, args)
	for _, ev := range evs {
		if strings.HasPrefix(ev.T, "worker.") {
			t.Fatalf("hire.interpret emitted %s", ev.T)
		}
	}
	return ackData[proto.HireInterpretResult](t, m)
}

// A dictated hire and its follow-up are proposals: zero worker.hire, zero
// herdr calls, no worker, nothing kept by the bridge (the follow-up carries
// the pending proposal), the text only by its length in the audit.
func TestHireInterpretNeverHires(t *testing.T) {
	t.Parallel()
	llm := &ai.FakeLLM{Func: func(_ context.Context, req ai.Request) (string, error) {
		switch p := req.Messages[1].Content; {
		case strings.Contains(p, `"pending_hire"`):
			return `{"intent":"hire","harness":null,"model":null,"effort":"high","task":null,"multiple":false,"selection_unclear":false}`, nil
		case strings.Contains(p, `"command":"high"`): // the research's standalone-effort answer
			return `{"intent":"unclear","harness":null,"model":null,"effort":null,"task":null,"multiple":false,"selection_unclear":false}`, nil
		}
		return `{"intent":"hire","harness":"claude","model":"claude-haiku-5-5","effort":null,"task":"fix the login bug.","multiple":false,"selection_unclear":false}`, nil
	}}
	hb := startHiBridge(t, &hiRoles{state: ai.StateReady, llm: llm})
	c := hb.c
	before := len(workersOf(hb.world(func(proto.World) bool { return true }), "s"))

	res := interpretCmd(t, c, "i1", proto.HireInterpretArgs{Text: hiText})
	in := res.Hire
	if res.Error != nil || res.Intent != "hire" || in == nil || in.ReadyForReview || in.Model.Value != "claude-haiku-5-5" ||
		in.Effort.Provenance != hireintent.Missing || in.Questions[0].Text != hireintent.EffortQuestion ||
		strings.Join(in.Questions[0].Efforts, ",") != "low,medium,high,xhigh,max" {
		t.Fatalf("first: %+v", res)
	}
	// The payload is the bridge's catalog, not the client's.
	var payload struct {
		HireOptions proto.HireOptions `json:"hire_options"`
	}
	_ = json.Unmarshal([]byte(llm.Calls()[0].Messages[1].Content), &payload)
	if strings.Join(payload.HireOptions.Claude.Models, ",") != "claude-haiku-5-5" || payload.HireOptions.Codex.ExtraEfforts["gpt-6.1-sol"][0] != "ultra" {
		t.Fatalf("catalog sent %+v", payload.HireOptions)
	}

	res = interpretCmd(t, c, "i2", proto.HireInterpretArgs{Text: "high", Pending: in})
	if res.Hire == nil || !res.Hire.ReadyForReview || res.Hire.Task.Value != "fix the login bug." || res.Hire.Effort.Value != "high" {
		t.Fatalf("follow-up: %+v %+v", res.Hire, res.Hire.Questions)
	}
	// The same reply without the pending proposal: the bridge kept nothing.
	res = interpretCmd(t, c, "i3", proto.HireInterpretArgs{Text: "high"})
	if res.Intent != "unclear" || res.Hire != nil || res.Error != nil {
		t.Fatalf("isolated reply: %+v", res)
	}

	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr control calls: %q", calls)
	}
	if n := len(workersOf(hb.world(func(proto.World) bool { return true }), "s")); n != before || before != 1 {
		t.Fatalf("workers %d, want %d", n, before)
	}
	log, err := hb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range log {
		if e.Cmd == proto.CmdWorkerHire {
			t.Fatalf("worker.hire in the audit: %+v", e)
		}
		if e.Cmd != proto.CmdHireInterpret {
			continue
		}
		n++
		if strings.Contains(e.Args, "login") || strings.Contains(e.Result, "login") || !strings.Contains(e.Args, `"text_bytes"`) || !e.OK {
			t.Fatalf("audit row %+v", e)
		}
	}
	if n != 3 {
		t.Fatalf("%d audit rows", n)
	}
}

// Without a ready LLM, or without the AI integration at all, every
// interpretation is a not_ready result with the text, and no call is made.
func TestHireInterpretNotReady(t *testing.T) {
	t.Parallel()
	t.Run("role not ready", func(t *testing.T) {
		roles := &hiRoles{state: ai.StateInvalid, llm: &ai.FakeLLM{}}
		hb := startHiBridge(t, roles)
		res := interpretCmd(t, hb.c, "n1", proto.HireInterpretArgs{Text: hiText})
		if res.Error == nil || res.Error.Code != "not_ready" || res.Hire != nil || res.Text != hiText || len(roles.llm.Calls()) != 0 {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("no AI integration", func(t *testing.T) {
		hb := startHiBridge(t, nil)
		res := interpretCmd(t, hb.c, "n2", proto.HireInterpretArgs{Text: hiText})
		if res.Error == nil || res.Error.Code != "not_ready" || res.Hire != nil || res.Text != hiText {
			t.Fatalf("%+v", res)
		}
	})
	t.Run("provider failure", func(t *testing.T) {
		roles := &hiRoles{state: ai.StateReady, llm: &ai.FakeLLM{Err: &ai.Error{Kind: ai.KindTimeout, Msg: "slow"}}}
		hb := startHiBridge(t, roles)
		res := interpretCmd(t, hb.c, "n3", proto.HireInterpretArgs{Text: hiText})
		if res.Error == nil || res.Error.Code != "timeout" || res.Hire != nil || res.Text != hiText {
			t.Fatalf("%+v", res)
		}
	})
}

// Bad text is a bad request; a pending proposal that does not hold is the
// result's error.
func TestHireInterpretArgs(t *testing.T) {
	t.Parallel()
	roles := &hiRoles{state: ai.StateReady, llm: &ai.FakeLLM{}}
	hb := startHiBridge(t, roles)
	hb.c.mustError(proto.CmdHireInterpret, proto.HireInterpretArgs{Text: "a\x00b"}, proto.ErrBadRequest)
	hb.c.mustError(proto.CmdHireInterpret, proto.HireInterpretArgs{Text: strings.Repeat("x", hireintent.MaxTextBytes+1)}, proto.ErrBadRequest)
	hb.c.mustError(proto.CmdHireInterpret, map[string]any{"text": "hire", "catalog": hiCatalog}, proto.ErrBadRequest)
	res := interpretCmd(t, hb.c, "p1", proto.HireInterpretArgs{Text: "high", Pending: &proto.HireInterpretation{Sources: []string{hiText},
		Task: hireintent.Task{Provenance: hireintent.Dictated, Value: "fix everything.", Span: &hireintent.Span{Start: 0, End: 3}}}})
	if res.Error == nil || res.Error.Code != hireintent.CodeBadPending || len(roles.llm.Calls()) != 0 {
		t.Fatalf("%+v", res)
	}
}

// #190: hidden_models narrows what hire.interpret reads to the models the
// user sees: the LLM's catalog, the family a word names, the question's
// choices. A follow-up is read again with the list sent with it. Unknown
// ids and harnesses are ignored, a malformed list is a bad request, and
// nothing outside the bridge's catalog is ever offered.
func TestHireInterpretHiddenModels(t *testing.T) {
	t.Parallel()
	cat := proto.HireOptions{
		Claude: hiCatalog.Claude,
		Codex: proto.HarnessOptions{Models: []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"}, Efforts: []string{"low", "medium", "high", "xhigh"},
			ModelLabels: map[string]string{"gpt-6.1-sol": "GPT-6.1-Sol", "gpt-6-sol": "GPT-6-Sol", "gpt-5.6-sol": "GPT-5.6-Sol"}},
	}
	const text = "Please spawn a GPT Sol agent on high reasoning to solve the issue with the frontend."
	model := "GPT Sol"
	llm := &ai.FakeLLM{Func: func(_ context.Context, req ai.Request) (string, error) {
		if strings.Contains(req.Messages[1].Content, `"pending_hire"`) {
			return `{"intent":"hire","harness":null,"model":null,"effort":"high","task":null,"multiple":false,"selection_unclear":false}`, nil
		}
		return `{"intent":"hire","harness":null,"model":"` + model + `","effort":"high","task":"solve the issue with the frontend.","multiple":false,"selection_unclear":false}`, nil
	}}
	roles := &hiRoles{state: ai.StateReady, llm: llm, cls: &ai.FakeClassifier{Score: 0.95}}
	hb := startHireBridge(t, func(o *server.Options) {
		o.HireOptions = &cat
		o.HireIntentRoles = roles
	}, linkedWorker("w1", "h3d/pixel-a1b2c3"))
	c := hb.c
	oneSol := hireintent.Hidden{"codex": {"gpt-6-sol", "gpt-5.6-sol", "gpt-9-nova"}, "gemini": {"g-1"}}
	choiceIDs := func(q hireintent.Question) string {
		var ids []string
		for _, ch := range q.Choices {
			ids = append(ids, ch.Model)
		}
		return strings.Join(ids, ",")
	}

	// Every Sol shown: "GPT Sol" names three, asked among exactly those.
	res := interpretCmd(t, c, "h1", proto.HireInterpretArgs{Text: text})
	if in := res.Hire; in == nil || in.ReadyForReview || in.Model.Provenance != hireintent.Invalid || choiceIDs(in.Questions[0]) != "gpt-6.1-sol,gpt-6-sol,gpt-5.6-sol" {
		t.Fatalf("all shown: %+v", res)
	}
	// One shown: that one, ready for review; the LLM read only it.
	res = interpretCmd(t, c, "h2", proto.HireInterpretArgs{Text: text, HiddenModels: oneSol})
	in := res.Hire
	if in == nil || !in.ReadyForReview || in.Model.Value != "gpt-6.1-sol" || in.Harness.Value != "codex" || in.Effort.Value != "high" || in.Task.Value != "solve the issue with the frontend." {
		t.Fatalf("one shown: %+v", res)
	}
	payload := llm.Calls()[len(llm.Calls())-1].Messages[1].Content
	if strings.Contains(payload, "gpt-6-sol") || strings.Contains(payload, "GPT-5.6-Sol") || !strings.Contains(payload, "gpt-6.1-sol") {
		t.Fatalf("the LLM read %s", payload)
	}
	// A near miss goes to the classifier (ready, picking).
	model = "GPT soul"
	if res := interpretCmd(t, c, "h3", proto.HireInterpretArgs{Text: text, HiddenModels: oneSol}); res.Hire == nil || !res.Hire.ReadyForReview ||
		res.Hire.Model.Value != "gpt-6.1-sol" || len(roles.cls.Calls()) != 1 {
		t.Fatalf("near miss: %+v, %d classifier calls", res, len(roles.cls.Calls()))
	}
	model = "GPT Sol"
	// The follow-up comes with another list: 6.1 hidden now, the pending
	// model is asked again among the Sols shown.
	res = interpretCmd(t, c, "h4", proto.HireInterpretArgs{Text: "high", Pending: in, HiddenModels: hireintent.Hidden{"codex": {"gpt-6.1-sol"}}})
	if f := res.Hire; f == nil || f.ReadyForReview || f.Model.Provenance != hireintent.Invalid || choiceIDs(f.Questions[0]) != "gpt-6-sol,gpt-5.6-sol" ||
		f.Model.Said != "GPT Sol" || f.Task.Value != in.Task.Value || *f.Task.Span != *in.Task.Span {
		t.Fatalf("follow-up: %+v %+v", res.Hire, res.Hire.Questions)
	}
	// Every Codex model hidden: Codex has nothing to hire.
	res = interpretCmd(t, c, "h5", proto.HireInterpretArgs{Text: text, HiddenModels: hireintent.Hidden{"codex": cat.Codex.Models}})
	if f := res.Hire; f == nil || f.ReadyForReview || choiceIDs(f.Questions[0]) != "claude-haiku-5-5" {
		t.Fatalf("all hidden: %+v", res)
	}
	// Malformed lists.
	c.mustError(proto.CmdHireInterpret, map[string]any{"text": text, "hidden_models": map[string]any{"codex": "gpt-6-sol"}}, proto.ErrBadRequest)
	c.mustError(proto.CmdHireInterpret, map[string]any{"text": text, "hidden_models": []string{"gpt-6-sol"}}, proto.ErrBadRequest)
	c.mustError(proto.CmdHireInterpret, proto.HireInterpretArgs{Text: text, HiddenModels: hireintent.Hidden{"codex": {""}}}, proto.ErrBadRequest)
	c.mustError(proto.CmdHireInterpret, proto.HireInterpretArgs{Text: text, HiddenModels: hireintent.Hidden{"codex": slices.Repeat([]string{"x"}, hireintent.MaxHiddenModels+1)}}, proto.ErrBadRequest)
	c.mustError(proto.CmdHireInterpret, proto.HireInterpretArgs{Text: text, HiddenModels: hireintent.Hidden{"codex": {strings.Repeat("x", hireintent.MaxHiddenIDBytes+1)}}}, proto.ErrBadRequest)
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr control calls: %q", calls)
	}
}
