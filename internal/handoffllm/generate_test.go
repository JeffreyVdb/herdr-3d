package handoffllm_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
)

// GoodDoc is a handoff of the agreed shape.
const goodDoc = "# Fix the flaky login test\n\n## Goal and current state\nMake e2e/auth.spec.ts pass reliably.\n\n" +
	"## Decisions\nWait for the form.\n\n## Verification\n20 local runs passed.\n\n## Open questions\nNone.\n\n" +
	"## Next steps\nRun CI.\n\n## Suggested skills\nNone.\n"

type roles struct {
	mu    sync.Mutex
	state ai.State
	fp    string
	llm   *ai.FakeLLM
}

func newRoles(text string) *roles {
	return &roles{state: ai.StateReady, fp: "fp-1", llm: &ai.FakeLLM{Text: text}}
}

func (r *roles) State(ai.Role) ai.State { r.mu.Lock(); defer r.mu.Unlock(); return r.state }
func (r *roles) Fingerprint(ai.Role) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.fp
}
func (r *roles) LLM() ai.LLM          { return r.llm }
func (r *roles) setFP(fp string)      { r.mu.Lock(); r.fp = fp; r.mu.Unlock() }
func (r *roles) setState(st ai.State) { r.mu.Lock(); r.state = st; r.mu.Unlock() }

type memStore struct {
	mu  sync.Mutex
	set handoffllm.Settings
	ok  bool
}

func (m *memStore) LoadHandoffLLMSettings(context.Context) (handoffllm.Settings, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.set, m.ok, nil
}
func (m *memStore) SaveHandoffLLMSettings(_ context.Context, s handoffllm.Settings) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.set, m.ok = s, true
	return nil
}

func newSvc(t *testing.T, r *roles, st *memStore, env *bool, now func() time.Time) *handoffllm.Service {
	t.Helper()
	opts := handoffllm.Options{Roles: r, EnvEnabled: env, Now: now}
	if st != nil {
		opts.Store = st
	}
	s, err := handoffllm.New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func on() *bool { b := true; return &b }

func code(err error) string {
	var e *handoffllm.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

func enable(t *testing.T, s *handoffllm.Service) {
	t.Helper()
	if res, err := s.Test(context.Background()); err != nil || !res.OK {
		t.Fatalf("test: %+v %v", res, err)
	}
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: on()}); err != nil {
		t.Fatal(err)
	}
}

func msgs() []ai.Message {
	return []ai.Message{{Role: "system", Content: "s"}, {Role: "user", Content: "u"}}
}

func TestOffByDefaultAndConfiguringTheAIAloneSendsNothing(t *testing.T) {
	r := newRoles(goodDoc)
	s := newSvc(t, r, &memStore{}, nil, nil)
	if v := s.View(); v.Enabled || v.State != handoffllm.StateOff || v.InputBytes != handoffllm.DefaultInputBytes || v.MaxTokens != handoffllm.DefaultMaxTokens {
		t.Fatalf("%+v", v)
	}
	if _, err := s.Generate(context.Background(), msgs()); code(err) != handoffllm.CodeUnavailable {
		t.Fatalf("%v", err)
	}
	if n := len(r.llm.Calls()); n != 0 {
		t.Fatalf("%d calls while off", n)
	}
}

func TestSwitchingOnNeedsAPassingTestOfTheConfigInUse(t *testing.T) {
	r := newRoles(goodDoc)
	now := time.Unix(1_800_000_000, 0)
	clock := func() time.Time { return now }
	st := &memStore{}
	s := newSvc(t, r, st, nil, clock)
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: on()}); code(err) != handoffllm.CodeTestRequired {
		t.Fatalf("on without a test: %v", err)
	}
	r.setState(ai.StateIncomplete)
	if _, err := s.Test(context.Background()); code(err) != handoffllm.CodeIncomplete {
		t.Fatalf("a test without the LLM: %v", err)
	}
	r.setState(ai.StateReady)
	res, err := s.Test(context.Background())
	if err != nil || !res.OK || res.Title != "Fix the flaky login test" {
		t.Fatalf("%+v %v", res, err)
	}
	// The test's request is the feature's: its bounds, no real transcript.
	req := r.llm.Calls()[0]
	if !req.NoPartial || !req.NoUncertainRetry || !req.RedactKey || !req.BudgetWins || req.Timeout != handoffllm.Timeout || req.MaxTokens != handoffllm.DefaultMaxTokens {
		t.Fatalf("%+v", req)
	}
	// Past 30 minutes the pass no longer allows switching on.
	now = now.Add(31 * time.Minute)
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: on()}); code(err) != handoffllm.CodeTestRequired {
		t.Fatalf("a stale test: %v", err)
	}
	// A pass of another config does not either.
	if _, err := s.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	tokens := 2048
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: on(), MaxTokens: &tokens}); code(err) != handoffllm.CodeTestRequired {
		t.Fatalf("on with a budget the test did not run with: %v", err)
	}
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: on()}); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); v.State != handoffllm.StateReady || !st.set.Enabled || st.set.Bound == "" {
		t.Fatalf("%+v %+v", v, st.set)
	}
}

func TestAChangedConfigSendsNothingUntilTestedAgain(t *testing.T) {
	r := newRoles(goodDoc)
	st := &memStore{}
	s := newSvc(t, r, st, nil, nil)
	enable(t, s)
	before := len(r.llm.Calls())
	r.setFP("fp-2") // another key, model or endpoint
	if v := s.View(); v.State != handoffllm.StateUntested || !v.Enabled {
		t.Fatalf("%+v", v)
	}
	if _, err := s.Generate(context.Background(), msgs()); code(err) != handoffllm.CodeUnavailable {
		t.Fatalf("%v", err)
	}
	if len(r.llm.Calls()) != before {
		t.Fatal("a call went under an untested config")
	}
	// A passing test of the new config binds the switch to it again.
	if res, err := s.Test(context.Background()); err != nil || !res.OK {
		t.Fatal(err)
	}
	if v := s.View(); v.State != handoffllm.StateReady {
		t.Fatalf("%+v", v)
	}
	// The binding survives a restart.
	s2 := newSvc(t, r, st, nil, nil)
	if v := s2.View(); v.State != handoffllm.StateReady {
		t.Fatalf("after a restart %+v", v)
	}
	// So does a changed budget: untested until a test of it passes.
	tokens := 2048
	if err := s.Apply(context.Background(), handoffllm.Update{MaxTokens: &tokens}); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); v.State != handoffllm.StateUntested {
		t.Fatalf("%+v", v)
	}
}

func TestTheEnvironmentSwitchNeedsNoTestButTheLLM(t *testing.T) {
	r := newRoles(goodDoc)
	s := newSvc(t, r, nil, on(), nil)
	if v := s.View(); v.State != handoffllm.StateReady || len(v.Env) != 1 {
		t.Fatalf("%+v", v)
	}
	off := false
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: &off}); code(err) != handoffllm.CodeEnvLocked {
		t.Fatalf("%v", err)
	}
	r.setState(ai.StateInvalid)
	if v := s.View(); v.State != handoffllm.StateIncomplete {
		t.Fatalf("%+v", v)
	}
	if _, err := s.Generate(context.Background(), msgs()); code(err) != handoffllm.CodeUnavailable {
		t.Fatalf("%v", err)
	}
}

func TestOneHandoffAtATime(t *testing.T) {
	r := newRoles("")
	gate := make(chan struct{})
	r.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		if strings.Contains(req.Messages[1].Content, "sample") {
			return goodDoc, nil
		}
		<-gate
		return goodDoc, nil
	}
	s := newSvc(t, r, nil, on(), nil)
	done := make(chan error)
	go func() { _, err := s.Generate(context.Background(), msgs()); done <- err }()
	for len(r.llm.Calls()) == 0 {
		time.Sleep(time.Millisecond)
	}
	if _, err := s.Generate(context.Background(), msgs()); !errors.Is(err, handoffllm.ErrBusy) {
		t.Fatalf("%v", err)
	}
	close(gate)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestSwitchingOffCancelsTheCallThatIsOut(t *testing.T) {
	r := newRoles(goodDoc)
	s := newSvc(t, r, &memStore{}, nil, nil)
	enable(t, s)
	started := make(chan struct{})
	r.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		close(started)
		<-ctx.Done()
		return "", ctx.Err()
	}
	done := make(chan error)
	go func() { _, err := s.Generate(context.Background(), msgs()); done <- err }()
	<-started
	off := false
	if err := s.Apply(context.Background(), handoffllm.Update{Enabled: &off}); err != nil {
		t.Fatal(err)
	}
	if err := <-done; code(err) != handoffllm.CodeUnavailable {
		t.Fatalf("%v", err)
	}
}

func TestFailuresAreTypedAndNeverEchoTheAnswer(t *testing.T) {
	marker := "BODY-MARKER-7f3a"
	cases := []struct {
		name string
		text string
		err  error
		want string
	}{
		{"timeout", "", &ai.Error{Kind: ai.KindTimeout, Msg: "the model did not answer in time"}, "timeout"},
		{"auth", "", &ai.Error{Kind: ai.KindAuthFailed, Msg: "the key was rejected"}, "auth_failed"},
		{"rate limit", "", &ai.Error{Kind: ai.KindRateLimited, Msg: "429"}, "rate_limited"},
		{"truncated", "", &ai.Error{Kind: ai.KindTruncated, Msg: "cut off"}, "truncated"},
		{"empty", "", &ai.Error{Kind: ai.KindEmpty, Msg: "no text"}, "empty_answer"},
		{"no title", "Some prose " + marker + "\n## Decisions\n", nil, handoffllm.CodeInvalid},
		{"missing sections", "# T " + marker + "\n\n## Decisions\nx\n", nil, handoffllm.CodeInvalid},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRoles(c.text)
			r.llm.Err = c.err
			s := newSvc(t, r, nil, on(), nil)
			res, err := s.Generate(context.Background(), msgs())
			if err == nil || handoffllm.Reason(err) != c.want || res.Doc != "" {
				t.Fatalf("%v → %q", err, handoffllm.Reason(err))
			}
			if strings.Contains(err.Error(), marker) {
				t.Fatalf("the error quotes the answer: %v", err)
			}
		})
	}
}

func TestTheOutputBudgetBoundsTheDocument(t *testing.T) {
	big := "# T\n\n## Goal and current state\n" + strings.Repeat("x", handoffllm.MinMaxTokens*8) + "\n## Decisions\n## Verification\n## Open questions\n## Next steps\n## Suggested skills\n"
	r := newRoles(big)
	s := newSvc(t, r, &memStore{}, on(), nil)
	tokens := handoffllm.MinMaxTokens
	if err := s.Apply(context.Background(), handoffllm.Update{MaxTokens: &tokens}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Generate(context.Background(), msgs()); code(err) != handoffllm.CodeInvalid {
		t.Fatalf("%v", err)
	}
	n := 5000
	r.llm.Text = goodDoc
	r.llm.Func = func(ctx context.Context, req ai.Request) (string, error) {
		req.Report(ai.Diagnostics{CompletionTokens: &n})
		return goodDoc, nil
	}
	if _, err := s.Generate(context.Background(), msgs()); code(err) != handoffllm.CodeInvalid {
		t.Fatalf("over the reported budget: %v", err)
	}
}

func TestSettingsAreBounded(t *testing.T) {
	s := newSvc(t, newRoles(goodDoc), &memStore{}, nil, nil)
	for _, u := range []handoffllm.Update{
		{InputBytes: ptr(handoffllm.MinInputBytes - 1)},
		{InputBytes: ptr(handoffllm.MaxInputBytes + 1)},
		{MaxTokens: ptr(handoffllm.MaxMaxTokens + 1)},
	} {
		if err := s.Apply(context.Background(), u); code(err) != handoffllm.CodeBadRequest {
			t.Fatalf("%+v: %v", u, err)
		}
	}
	e := "bogus"
	if err := s.Apply(context.Background(), handoffllm.Update{ReasoningEffort: &e}); code(err) != handoffllm.CodeBadRequest {
		t.Fatal(err)
	}
}

func ptr(n int) *int { return &n }
