package server_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #9 LLM handoffs against the literal handoffs' bridge (w1 Claude, w2
// Codex, real transcript files), the configured LLM a FakeLLM behind its
// own roles (the follow-up roles must never be called) and the reducer a
// fake whose payload carries a fake secret and a marker: neither may reach
// a log, an audit row, an ack, an error or a job row.

const (
	llmSecret     = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" // a GitHub token's shape
	llmMarker     = "TRANSCRIPT-MARKER-91c2"
	llmBodyMarker = "BODY-MARKER-5e7d"
	llmFocus      = "focus on the CI failure; the key is " + llmSecret + " FOCUS-MARKER-0b44"
)

// llmDoc is a handoff of the agreed shape, with a marker in its body.
const llmDoc = "# Fix the flaky login test\n\n## Goal and current state\nMake e2e/auth.spec.ts pass. " + llmBodyMarker + "\n\n" +
	"## Decisions\nWait for the form.\n\n## Verification\n20 local runs passed.\n\n## Open questions\nNone.\n\n" +
	"## Next steps\nRun CI.\n\n## Suggested skills\nNone.\n"

type llmRoles struct {
	mu    sync.Mutex
	state ai.State
	fp    string
	llm   *ai.FakeLLM
}

func (r *llmRoles) State(ai.Role) ai.State { r.mu.Lock(); defer r.mu.Unlock(); return r.state }
func (r *llmRoles) Fingerprint(ai.Role) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fp
}
func (r *llmRoles) LLM() ai.LLM { return r.llm }
func (r *llmRoles) View() ai.View {
	return ai.View{LLM: ai.LLMView{State: r.State(ai.RoleLLM), BaseURL: "https://llm.example:8443/v1/secret-path?x=1", Model: "gpt-handoff"}}
}
func (r *llmRoles) setFP(fp string) { r.mu.Lock(); r.fp = fp; r.mu.Unlock() }

// fakeReduce is the reducer: a payload of the snapshot it was asked for.
type fakeReduce struct {
	mu    sync.Mutex
	calls []handoffllm.Input
	err   error
}

func (f *fakeReduce) reduce(_ context.Context, in handoffllm.Input) (handoffllm.Payload, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, in)
	if f.err != nil {
		return handoffllm.Payload{}, f.err
	}
	text := "[1 user] Fix the flaky login test. " + llmMarker + " token " + llmSecret + "\n[2 assistant] Done.\n"
	return handoffllm.Payload{Text: text, Bytes: len(text), EstTokens: handoffllm.EstimateTokens(text),
		Coverage: handoffllm.Coverage{Messages: 9, Kept: 4, Compaction: "none", Gaps: []string{"older tool output left out"},
			Omitted: []handoffllm.Range{{From: 2, To: 6, Why: "older assistant detail"}}},
		Artifacts:  []handoffllm.Artifact{{Kind: "file", Ref: "e2e/auth.spec.ts", Verified: true}, {Kind: "commit", Ref: "abc1234"}},
		Redactions: map[string]int{"github_token": 2}}, nil
}

type llmBridge struct {
	*hoBridge
	llm    *llmRoles
	reduce *fakeReduce
	logs   *lockedBuffer
}

// newLLMBridge starts the bridge with LLM handoffs; on is the environment's
// switch (nil: the stored one, off).
func newLLMBridge(t *testing.T, on *bool, tweak func(*server.Options)) *llmBridge {
	t.Helper()
	lb := &llmBridge{llm: &llmRoles{state: ai.StateReady, fp: "llm-fp-1", llm: &ai.FakeLLM{Text: llmDoc}}, reduce: &fakeReduce{},
		logs: &lockedBuffer{}}
	dir := filepath.Join(t.TempDir(), "handoff")
	db := filepath.Join(t.TempDir(), "world.db")
	svc := hoService(t, dir, db)
	off := false
	fb := startFuBridgeWith(t, db, "", newFuRoles(), &off, "", func(o *server.Options) {
		o.Handoffs = svc
		o.DigestEnabled, o.PackupEnabled, o.ActivityModel = &off, &off, &off
		o.HandoffLLMRoles, o.HandoffReduce, o.HandoffLLMEnabled = lb.llm, lb.reduce.reduce, on
		o.Log = slog.New(slog.NewTextHandler(lb.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
		if tweak != nil {
			tweak(o)
		}
	})
	lb.hoBridge = &hoBridge{fuBridge: fb, dir: dir}
	return lb
}

// candidate gives w1 a completed reply and returns its candidate.
func (lb *llmBridge) candidate(t *testing.T, c *client) proto.HandoffCandidate {
	t.Helper()
	appendTo(t, lb.claude, wrapUser("Fix the flaky login test.")+claudeReply("msg_1", "u1", "Fixed: the test waits for the form.", "end_turn")+turnDone)
	return *handoffOf(c, lb.ids["w1"]).Handoff
}

func llmArgs(id string, cand proto.HandoffCandidate, op string) proto.WorkerHandoffArgs {
	return proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLLM, Session: cand.Session, Candidate: cand.ID, Revision: cand.Revision,
		Instruction: llmFocus, Op: op}
}

func llmJobState(states ...string) func(*proto.Worker) bool {
	return func(w *proto.Worker) bool {
		if w.LLMHandoff == nil {
			return false
		}
		for _, s := range states {
			if w.LLMHandoff.State == s {
				return true
			}
		}
		return false
	}
}

// noLeak checks nothing of the transcript, the instruction, the document or
// the secret is in the logs, the audit log, what the client heard, or the
// stored jobs.
func (lb *llmBridge) noLeak(t *testing.T, c *client) {
	t.Helper()
	log, err := lb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(log)
	jobs, _ := lb.st.LatestHandoffLLMJobs(context.Background())
	jb, _ := json.Marshal(jobs)
	for where, text := range map[string]string{"logs": lb.logs.String(), "audit": string(b), "wire": c.heard.String(), "jobs": string(jb)} {
		for _, bad := range []string{llmSecret, llmMarker, "FOCUS-MARKER-0b44", "focus on the CI failure", "secret-path"} {
			if strings.Contains(text, bad) {
				t.Fatalf("%s holds %q", where, bad)
			}
		}
		if where != "wire" && strings.Contains(text, llmBodyMarker) { // the client reads the filed body with handoff.get
			t.Fatalf("%s holds the document", where)
		}
	}
}

// The configured LLM writes it, whatever the worker's cache: previewed
// (recipient, sizes, coverage, redactions), sent once with the feature's
// bounds, the instruction scrubbed, filed with its provenance, then sent
// home; the worker is never prompted.
func TestLLMHandoffFilesWithProvenance(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), nil)
	c := lb.connect(proto.Hello{})
	s := c.snapshot()
	if s.World.HandoffLLM == nil || s.World.HandoffLLM.State != proto.HandoffLLMReady || s.World.HandoffLLM.PromptVersion != handoffllm.PromptVersion {
		t.Fatalf("%+v", s.World.HandoffLLM)
	}
	id := lb.ids["w1"]
	lb.fl.setProcs("w1:p1", running("claude", wrapSess))
	cand := lb.candidate(t, c)

	_, m := c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: id, Mode: proto.HandoffModeLLM, Candidate: cand.ID})
	pv := ackData[proto.WorkerHandoffPreviewResult](t, m)
	p := pv.LLM
	if p == nil || !p.Ready || p.Model != "gpt-handoff" || p.Host != "llm.example:8443" || !p.Reduced || p.PayloadBytes == 0 || p.EstTokens == 0 ||
		p.Coverage.Messages != 9 || p.Coverage.Kept != 4 || len(p.Coverage.Omitted) != 1 || p.Redactions["github_token"] != 2 ||
		p.Artifacts != 2 || p.Verified != 1 || p.BudgetBytes != handoffllm.DefaultInputBytes || len(p.Categories) == 0 || pv.Candidate == nil || pv.Candidate.ID != cand.ID {
		t.Fatalf("preview %s", m.raw)
	}
	if n := len(lb.llm.llm.Calls()); n != 0 {
		t.Fatalf("the preview called the LLM %d times", n)
	}

	args := llmArgs(id, cand, "op-llm")
	args.SendHome = true
	_, m = c.command(proto.CmdWorkerHandoff, "h", args)
	res := ackData[proto.WorkerHandoffJobResult](t, m)
	if res.Existing || res.Job.State != proto.LLMHandoffRunning || res.Job.Op != "op-llm" || res.Job.Model != "gpt-handoff" {
		t.Fatalf("ack %s", m.raw)
	}
	var added *proto.Event
	removed := false
	for !removed {
		ev := c.event()
		switch {
		case ev.T == proto.EvHandoffAdded:
			added = &ev
		case ev.T == proto.EvWorkerRemoved && ev.ID == id:
			if added == nil {
				t.Fatal("sent home before the handoff was filed")
			}
			removed = true
		}
	}
	if added.Handoff.Source != proto.HandoffSourceLLM || added.Handoff.Title != "Fix the flaky login test" {
		t.Fatalf("added %+v", added.Handoff)
	}

	calls := lb.llm.llm.Calls()
	if len(calls) != 1 {
		t.Fatalf("%d calls", len(calls))
	}
	req := calls[0]
	if !req.NoPartial || !req.NoUncertainRetry || !req.RedactKey || !req.BudgetWins || req.Timeout != handoffllm.Timeout ||
		req.MaxTokens != handoffllm.DefaultMaxTokens || req.JSON || len(req.Messages) != 2 || req.Messages[0].Content != handoffllm.SystemPrompt {
		t.Fatalf("request %+v", req)
	}
	user := req.Messages[1].Content
	if !strings.Contains(user, llmMarker) || !strings.Contains(user, "FOCUS-MARKER-0b44") || strings.Count(user, llmSecret) != 1 {
		t.Fatalf("the payload goes as given, the instruction scrubbed:\n%s", user)
	}
	if in := lb.reduce.calls[len(lb.reduce.calls)-1]; in.Harness != "claude" || in.Path != lb.claude || in.Through <= 0 || in.Budget != handoffllm.DefaultInputBytes {
		t.Fatalf("reduce %+v", in)
	}

	_, m = c.command(proto.CmdHandoffGet, "g", proto.HandoffGetArgs{ID: added.Handoff.ID})
	got := ackData[proto.HandoffGetResult](t, m)
	if got.LLM == nil || got.LLM.Model != "gpt-handoff" || got.LLM.Host != "llm.example:8443" || got.LLM.PromptVersion != handoffllm.PromptVersion ||
		!strings.HasPrefix(got.LLM.Snapshot, cand.ID+"@") || got.LLM.Coverage != "4 of 9 messages kept; 1 coverage gap" || got.LLM.Redactions["github_token"] != 3 || // 2 of the payload's, 1 of the instruction
		got.Body != llmDoc {
		t.Fatalf("get %s", m.raw)
	}
	raw, err := os.ReadFile(got.Handoff.Path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`source: "llm"`, `llm_model: "gpt-handoff"`, `llm_host: "llm.example:8443"`, `prompt_version: "` + handoffllm.PromptVersion + `"`, `op: "op-llm"`} {
		if !strings.Contains(string(raw), want) {
			t.Fatalf("front matter lacks %s:\n%s", want, raw)
		}
	}
	noPrompts(t, lb.hoBridge)

	eventually(t, "the audit row", func() bool { return auditRow(t, lb.bridge, proto.CmdWorkerHandoff).Done })
	row := auditRow(t, lb.bridge, proto.CmdWorkerHandoff)
	for _, want := range []string{`"outcome":"filed"`, `"model":"gpt-handoff"`, `"host":"llm.example:8443"`, `"github_token":`, `"prompt_version"`} {
		if !row.OK || !strings.Contains(row.Result, want) {
			t.Fatalf("audit %+v lacks %s", row, want)
		}
	}
	all, _ := lb.st.AuditLog(context.Background())
	for _, e := range all {
		if e.Cmd == proto.CmdWorkerHandoff && !strings.Contains(e.Args, `"instruction_bytes":`) {
			t.Fatalf("audit args %s", e.Args)
		}
	}
	lb.noLeak(t, c)
}

// Disabled, not ready or untested: refused, nothing sent, nothing reduced
// for the call.
func TestLLMHandoffSendsNothingUnlessReady(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, nil, nil) // the stored switch: off
	c := lb.connect(proto.Hello{})
	s := c.snapshot()
	if s.World.HandoffLLM.State != proto.HandoffLLMOff {
		t.Fatalf("%+v", s.World.HandoffLLM)
	}
	id := lb.ids["w1"]
	cand := lb.candidate(t, c)
	_, m := c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: id, Mode: proto.HandoffModeLLM})
	if pv := ackData[proto.WorkerHandoffPreviewResult](t, m); pv.LLM.Ready || !strings.Contains(pv.LLM.Unavailable, "switched off") {
		t.Fatalf("%s", m.raw)
	}
	c.mustError(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-off"), proto.ErrHandoffLLMUnavailable)

	// Tested and switched on: then the config changes: untested, refused.
	_, m = c.command(proto.CmdHandoffLLMTest, "t", nil)
	if r := ackData[proto.HandoffLLMTestResult](t, m); !r.OK {
		t.Fatalf("%s", m.raw)
	}
	c.mustAck(proto.CmdHandoffLLMSet, proto.HandoffLLMSetArgs{Enabled: yes()})
	lb.llm.setFP("llm-fp-2")
	_, m = c.command(proto.CmdHandoffLLMGet, "g", nil)
	if st := ackData[proto.HandoffLLMState](t, m); st.State != proto.HandoffLLMUntested {
		t.Fatalf("%s", m.raw)
	}
	c.mustError(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-untested"), proto.ErrHandoffLLMUnavailable)
	lb.llm.mu.Lock()
	lb.llm.state = ai.StateInvalid
	lb.llm.mu.Unlock()
	c.mustError(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-invalid"), proto.ErrHandoffLLMUnavailable)
	if n := len(lb.llm.llm.Calls()); n != 1 { // the test's
		t.Fatalf("%d LLM calls", n)
	}
	if jobs, _ := lb.st.LatestHandoffLLMJobs(context.Background()); len(jobs) != 0 {
		t.Fatalf("jobs %+v", jobs)
	}
	noPrompts(t, lb.hoBridge)
}

// Every failure of the call or the answer settles the job failed with its
// code: nothing filed, nobody sent home, no second call, nothing else asked.
func TestLLMHandoffFailures(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		text string
		err  error
		code string
	}{
		{"timeout", "", &ai.Error{Kind: ai.KindTimeout, Msg: "the model did not answer in time"}, "timeout"},
		{"auth", "", &ai.Error{Kind: ai.KindAuthFailed, Msg: "the key was rejected (HTTP 401)"}, "auth_failed"},
		{"rate limit", "", &ai.Error{Kind: ai.KindRateLimited, Msg: "the provider is rate limiting (HTTP 429)"}, "rate_limited"},
		{"provider", "", &ai.Error{Kind: ai.KindFailed, Msg: "the provider answered HTTP 500: echo " + llmMarker}, "provider_failed"},
		{"empty", "", &ai.Error{Kind: ai.KindEmpty, Msg: "the model returned no text"}, "empty_answer"},
		{"truncated", "", &ai.Error{Kind: ai.KindTruncated, Msg: "the answer was cut off"}, "truncated"},
		{"no title", "Here is your handoff " + llmBodyMarker + "\n## Decisions\nx", nil, proto.ErrHandoffLLMInvalid},
		{"no sections", "# Title " + llmBodyMarker + "\n\nprose only", nil, proto.ErrHandoffLLMInvalid},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			lb := newLLMBridge(t, yes(), nil)
			lb.llm.llm.Text, lb.llm.llm.Err = tc.text, tc.err
			c := lb.connect(proto.Hello{})
			c.snapshot()
			id := lb.ids["w1"]
			lb.fl.setProcs("w1:p1", running("claude", wrapSess))
			cand := lb.candidate(t, c)
			args := llmArgs(id, cand, "op-f")
			args.SendHome = true
			c.mustAck(proto.CmdWorkerHandoff, args)
			w := upsertFor(c, id, llmJobState(proto.LLMHandoffFailed))
			if w.LLMHandoff.Code != tc.code || w.LLMHandoff.Handoff != 0 || w.LLMHandoff.SendHomeResult != "" || !strings.Contains(w.LLMHandoff.Message, "nothing was filed") {
				t.Fatalf("job %+v", w.LLMHandoff)
			}
			if all, _ := lb.st.AllHandoffs(context.Background()); len(all) != 0 {
				t.Fatalf("filed %+v", all)
			}
			if n := len(lb.llm.llm.Calls()); n != 1 {
				t.Fatalf("%d calls", n)
			}
			if row := auditRow(t, lb.bridge, proto.CmdWorkerHandoff); row.OK || row.Error != tc.code || !strings.Contains(row.Result, `"outcome":"`+tc.code+`"`) {
				t.Fatalf("audit %+v", row)
			}
			if row := auditRow(t, lb.bridge, proto.CmdWorkerFire); row.Result != "" || row.Done {
				t.Fatalf("a send home: %+v", row)
			}
			if lb.workerGone(id) {
				t.Fatal("sent home")
			}
			noPrompts(t, lb.hoBridge)
			lb.noLeak(t, c)
		})
	}
}

// workerGone: herdr was asked to close w1 (a send home).
func (lb *llmBridge) workerGone(string) bool { return slices.Contains(lb.fl.Calls(), "close w1") }

// blockLLM makes the LLM wait for release (or its context); it says when the
// call is out.
func blockLLM(lb *llmBridge) (out <-chan struct{}, release func()) {
	o, r := make(chan struct{}), make(chan struct{})
	var once sync.Once
	lb.llm.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		once.Do(func() { close(o) })
		select {
		case <-r:
			return llmDoc, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	var ronce sync.Once
	return o, func() { ronce.Do(func() { close(r) }) }
}

// A repeated submit of an op answers its job and calls nothing again; the
// op with other arguments is refused; one job at a time over the bridge;
// worker.handoff_cancel cancels a running job, then dismisses it.
func TestLLMHandoffIdempotencyBusyAndCancel(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), nil)
	out, release := blockLLM(lb)
	defer release()
	c := lb.connect(proto.Hello{})
	c.snapshot()
	id := lb.ids["w1"]
	cand := lb.candidate(t, c)
	c.mustAck(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-1"))
	<-out
	_, m := c.command(proto.CmdWorkerHandoff, "again", llmArgs(id, cand, "op-1"))
	if r := ackData[proto.WorkerHandoffJobResult](t, m); !r.Existing || r.Job.Op != "op-1" || r.Job.State != proto.LLMHandoffRunning {
		t.Fatalf("%s", m.raw)
	}
	other := llmArgs(id, cand, "op-1")
	other.Instruction = "something else"
	c.mustError(proto.CmdWorkerHandoff, other, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-2"), proto.ErrBusy)
	_, m = c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: id, Mode: proto.HandoffModeLLM})
	if pv := ackData[proto.WorkerHandoffPreviewResult](t, m); pv.LLM.Ready || !strings.Contains(pv.LLM.Unavailable, "one at a time") {
		t.Fatalf("%s", m.raw)
	}
	c.mustAck(proto.CmdWorkerHandoffCancel, proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-1"})
	w := upsertFor(c, id, llmJobState(proto.LLMHandoffCancelled))
	if w.LLMHandoff.Code != "cancelled" {
		t.Fatalf("%+v", w.LLMHandoff)
	}
	if n := len(lb.llm.llm.Calls()); n != 1 {
		t.Fatalf("%d calls", n)
	}
	// Its op still answers the cancelled job; a new op is a new request.
	_, m = c.command(proto.CmdWorkerHandoff, "again2", llmArgs(id, cand, "op-1"))
	if r := ackData[proto.WorkerHandoffJobResult](t, m); !r.Existing || r.Job.State != proto.LLMHandoffCancelled {
		t.Fatalf("%s", m.raw)
	}
	evs, _ := c.mustAck(proto.CmdWorkerHandoffCancel, proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-1"})
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.LLMHandoff == nil
	}) {
		t.Fatalf("not dismissed: %+v", evs)
	}
	if all, _ := lb.st.AllHandoffs(context.Background()); len(all) != 0 {
		t.Fatalf("filed %+v", all)
	}
	lb.noLeak(t, c)
}

// A late answer is never filed under another LLM config or agent session.
func TestLLMHandoffStaleAnswersAreNotFiled(t *testing.T) {
	t.Parallel()
	t.Run("config", func(t *testing.T) {
		t.Parallel()
		lb := newLLMBridge(t, yes(), nil)
		out, release := blockLLM(lb)
		c := lb.connect(proto.Hello{})
		c.snapshot()
		id := lb.ids["w1"]
		cand := lb.candidate(t, c)
		c.mustAck(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-c"))
		<-out
		lb.llm.setFP("llm-fp-other") // another key, model or endpoint
		release()
		w := upsertFor(c, id, llmJobState(proto.LLMHandoffFailed))
		if w.LLMHandoff.Code != proto.ErrHandoffLLMStale || !strings.Contains(w.LLMHandoff.Message, "settings changed") {
			t.Fatalf("%+v", w.LLMHandoff)
		}
		if all, _ := lb.st.AllHandoffs(context.Background()); len(all) != 0 {
			t.Fatalf("filed %+v", all)
		}
	})
	t.Run("session", func(t *testing.T) {
		t.Parallel()
		lb := newLLMBridge(t, yes(), nil)
		out, release := blockLLM(lb)
		defer release()
		c := lb.connect(proto.Hello{})
		c.snapshot()
		id := lb.ids["w1"]
		cand := lb.candidate(t, c)
		c.mustAck(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-s"))
		<-out
		lb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "another-session" })
		w := upsertFor(c, id, llmJobState(proto.LLMHandoffFailed))
		if w.LLMHandoff.Code != proto.ErrHandoffLLMStale || !strings.Contains(w.LLMHandoff.Message, "agent session changed") {
			t.Fatalf("%+v", w.LLMHandoff)
		}
		if all, _ := lb.st.AllHandoffs(context.Background()); len(all) != 0 {
			t.Fatalf("filed %+v", all)
		}
	})
}

// A filing that fails leaves no handoff and sends nobody home.
func TestLLMHandoffFilingFailure(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), nil)
	c := lb.connect(proto.Hello{})
	s := c.snapshot()
	id := lb.ids["w1"]
	cand := lb.candidate(t, c)
	floor := ""
	for _, w := range s.World.Workers {
		if w.ID == id {
			floor = w.Session
		}
	}
	// The floor's drawer is a file: nothing can be written there.
	if err := os.MkdirAll(lb.dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lb.dir, handoff.FloorDir(floor)), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	args := llmArgs(id, cand, "op-fs")
	args.SendHome = true
	c.mustAck(proto.CmdWorkerHandoff, args)
	w := upsertFor(c, id, llmJobState(proto.LLMHandoffFailed))
	if w.LLMHandoff.Code != proto.ErrHandoffFailed || w.LLMHandoff.SendHomeResult != "" {
		t.Fatalf("%+v", w.LLMHandoff)
	}
	if lb.workerGone(id) {
		t.Fatal("sent home")
	}
	lb.noLeak(t, c)
}

// A job out when the bridge stopped is failed at the restart, never sent
// again; its op still answers it.
func TestLLMHandoffRestartFailsTheJob(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), nil)
	c := lb.connect(proto.Hello{})
	c.snapshot()
	id := lb.ids["w1"]
	ctx := context.Background()
	now := time.Now().UnixMilli()
	if err := lb.st.AddHandoffLLMJob(ctx, store.HandoffLLMJob{Op: "op-r", WorkerID: id, Floor: "s", Candidate: "c", ArgsHash: "h",
		Config: "llm-fp-1", PromptVersion: handoffllm.PromptVersion, State: store.HandoffJobRunning, CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	lb.stop()
	lb2 := newLLMBridgeOn(t, lb)
	c2 := lb2.connect(proto.Hello{})
	s := c2.snapshot()
	var job *proto.LLMHandoff
	for _, w := range s.World.Workers {
		if w.ID == id {
			job = w.LLMHandoff
		}
	}
	if job == nil || job.State != proto.LLMHandoffFailed || job.Code != proto.ErrHandoffLLMInterrupted || !strings.Contains(job.Message, "not sent again") {
		t.Fatalf("%+v", job)
	}
	if n := len(lb2.llm.llm.Calls()); n != 0 {
		t.Fatalf("%d calls after the restart", n)
	}
}

// newLLMBridgeOn starts a bridge again on lb's database, transcripts and
// handoff directory.
func newLLMBridgeOn(t *testing.T, lb *llmBridge) *llmBridge {
	t.Helper()
	nb := &llmBridge{llm: &llmRoles{state: ai.StateReady, fp: "llm-fp-1", llm: &ai.FakeLLM{Text: llmDoc}}, reduce: &fakeReduce{}, logs: &lockedBuffer{}}
	svc := hoService(t, lb.dir, lb.db)
	off := false
	fb := startFuBridgeWith(t, lb.db, lb.fuBridge.dir, newFuRoles(), &off, "", func(o *server.Options) {
		o.Handoffs = svc
		o.DigestEnabled, o.PackupEnabled, o.ActivityModel = &off, &off, &off
		o.HandoffLLMRoles, o.HandoffReduce, o.HandoffLLMEnabled = nb.llm, nb.reduce.reduce, yes()
		o.Log = slog.New(slog.NewTextHandler(nb.logs, nil))
	})
	nb.hoBridge = &hoBridge{fuBridge: fb, dir: lb.dir}
	return nb
}

// The reducer's refusal is said in the preview and fails the job: nothing
// sent.
func TestLLMHandoffReducerRefusal(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), nil)
	lb.reduce.err = handoffllm.ErrTooLarge
	c := lb.connect(proto.Hello{})
	c.snapshot()
	id := lb.ids["w1"]
	cand := lb.candidate(t, c)
	_, m := c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: id, Mode: proto.HandoffModeLLM, Candidate: cand.ID})
	if pv := ackData[proto.WorkerHandoffPreviewResult](t, m); pv.LLM.Ready || pv.LLM.Reduced || !strings.Contains(pv.LLM.Unavailable, "do not fit") {
		t.Fatalf("%s", m.raw)
	}
	c.mustAck(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-big"))
	w := upsertFor(c, id, llmJobState(proto.LLMHandoffFailed))
	if w.LLMHandoff.Code != proto.ErrTooLarge || !strings.Contains(w.LLMHandoff.Message, "nothing was sent") {
		t.Fatalf("%+v", w.LLMHandoff)
	}
	if n := len(lb.llm.llm.Calls()); n != 0 {
		t.Fatalf("%d calls", n)
	}
}

// The cabinet's limits are the validator's.
func TestHandoffLLMLimitsMatchTheCabinet(t *testing.T) {
	if handoffllm.MaxTitle != handoff.MaxTitle || handoffllm.MaxBody != handoff.MaxBody {
		t.Fatal("handoffllm's limits drifted from internal/handoff's")
	}
}

// An agent handoff's instruction is audited by its length only.
func TestHandoffInstructionIsNeverAudited(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: ab.ids["w1"], Mode: proto.HandoffModeAgent, Op: "op-i", Instruction: llmFocus})
	ab.mustRequest(t, "w1:p1")
	log, _ := ab.st.AuditLog(context.Background())
	for _, e := range log {
		if strings.Contains(e.Args, "FOCUS-MARKER") || strings.Contains(e.Result, "FOCUS-MARKER") {
			t.Fatalf("audited %+v", e)
		}
	}
}

// proto mirrors internal/handoffllm (it cannot import it: handoffllm reads
// transcripts, which use proto): the same codes, states and fields.
func TestHandoffLLMProtocolMirrorsTheFeature(t *testing.T) {
	if proto.ErrHandoffLLMUnavailable != handoffllm.CodeUnavailable || proto.ErrHandoffLLMInvalid != handoffllm.CodeInvalid ||
		proto.HandoffLLMOff != handoffllm.StateOff || proto.HandoffLLMIncomplete != handoffllm.StateIncomplete ||
		proto.HandoffLLMUntested != handoffllm.StateUntested || proto.HandoffLLMReady != handoffllm.StateReady {
		t.Fatal("codes or states drifted")
	}
	keys := func(v any) []string {
		b, _ := json.Marshal(v)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		var out []string
		for k := range m {
			out = append(out, k)
		}
		slices.Sort(out)
		return out
	}
	full := handoffllm.View{Missing: []string{"llm"}}
	if a, b := keys(full), keys(proto.HandoffLLMState{Missing: []string{"llm"}}); !slices.Equal(a, b) {
		t.Fatalf("View %v, proto %v", a, b)
	}
	if a, b := keys(handoffllm.TestResult{Reason: "r", Title: "t", Diag: &ai.Diagnostics{}}), keys(proto.HandoffLLMTestResult{Reason: "r", Title: "t", Diag: &ai.Diagnostics{}}); !slices.Equal(a, b) {
		t.Fatalf("TestResult %v, proto %v", a, b)
	}
}

// With the real reducer: a secret in the transcript is scrubbed before it
// is sent, and neither it nor the transcript's text reaches a log, an audit
// row, the wire or a job row; the preview's redaction counts say so.
func TestLLMHandoffRealReducerScrubsTheTranscript(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), func(o *server.Options) { o.HandoffReduce = nil })
	c := lb.connect(proto.Hello{})
	c.snapshot()
	id := lb.ids["w1"]
	// Rows with their ancestry, as Claude Code writes them (the reducer follows the active branch).
	row := func(m map[string]any) string { b, _ := json.Marshal(m); return string(b) + "\n" }
	appendTo(t, lb.claude,
		row(map[string]any{"type": "user", "uuid": "p1", "parentUuid": nil, "sessionId": wrapSess, "isSidechain": false,
			"message": map[string]any{"role": "user", "content": "Fix the flaky login test. " + llmMarker + " my token is " + llmSecret}})+
			row(map[string]any{"type": "assistant", "uuid": "a1", "parentUuid": "p1", "sessionId": wrapSess, "isSidechain": false, "requestId": "req_1",
				"message": map[string]any{"id": "msg_1", "role": "assistant", "content": []map[string]any{{"type": "text", "text": "Fixed: the test waits for the form."}}, "stop_reason": "end_turn"}})+
			row(map[string]any{"type": "system", "subtype": "turn_duration", "durationMs": 5, "uuid": "d1", "parentUuid": "a1", "sessionId": wrapSess, "isSidechain": false}))
	cand := *handoffOf(c, id).Handoff
	_, m := c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: id, Mode: proto.HandoffModeLLM, Candidate: cand.ID})
	pv := ackData[proto.WorkerHandoffPreviewResult](t, m)
	if !pv.LLM.Ready || !pv.LLM.Reduced || pv.LLM.Redactions["github_token"] < 1 || pv.LLM.Coverage.Messages < 2 {
		t.Fatalf("preview %s", m.raw)
	}
	c.mustAck(proto.CmdWorkerHandoff, llmArgs(id, cand, "op-real"))
	upsertFor(c, id, llmJobState(proto.LLMHandoffFiled))
	req := lb.llm.llm.Calls()[0]
	user := req.Messages[1].Content
	if strings.Contains(user, llmSecret) || !strings.Contains(user, "[redacted:github_token]") || !strings.Contains(user, llmMarker) {
		t.Fatalf("sent:\n%s", user)
	}
	lb.noLeak(t, c)
}
