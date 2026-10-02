package followup_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
)

// roles plays the AI integration: each role's state and config fingerprint,
// and the fakes.
type roles struct {
	state map[ai.Role]ai.State
	fp    map[ai.Role]string
	cls   *ai.FakeClassifier
	llm   *ai.FakeLLM
}

func newRoles() *roles {
	return &roles{
		state: map[ai.Role]ai.State{ai.RoleClassifier: ai.StateReady, ai.RoleLLM: ai.StateReady},
		fp:    map[ai.Role]string{ai.RoleClassifier: "c1", ai.RoleLLM: "l1"},
		cls:   &ai.FakeClassifier{},
		llm:   &ai.FakeLLM{},
	}
}

func (r *roles) State(x ai.Role) ai.State     { return r.state[x] }
func (r *roles) Fingerprint(x ai.Role) string { return r.fp[x] }
func (r *roles) Classifier() ai.Classifier    { return r.cls }
func (r *roles) LLM() ai.LLM                  { return r.llm }
func (r *roles) calls() (cls, llm int)        { return len(r.cls.Calls()), len(r.llm.Calls()) }
func (r *roles) scoreBy(f func(msg string) float64) {
	r.cls.Func = func(_ context.Context, state map[string]any, _ string) (float64, error) {
		return f(state["last_agent_message"].(string)), nil
	}
}

type memStore struct {
	enabled   bool
	threshold float64
	ok        bool
	saves     int
}

func (m *memStore) LoadFollowupSettings(context.Context) (bool, float64, bool, error) {
	return m.enabled, m.threshold, m.ok, nil
}

func (m *memStore) SaveFollowupSettings(_ context.Context, en bool, th float64) error {
	m.enabled, m.threshold, m.ok = en, th, true
	m.saves++
	return nil
}

const twoQuestions = `{"questions":[{"question":"Does X still need Y?","kind":"yes_no"},
	{"question":"Ship now or wait for the e2e-live run?","kind":"choice","options":["Ship now","Wait for e2e-live"]}]}`

func TestRunBelowThresholdCallsNoLLM(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.69
	res, err := followup.Run(context.Background(), r.cls, r.llm, "Done, PR merged.", 0.7)
	if err != nil || res.Flag || res.Questions != nil {
		t.Fatalf("Run = %+v, %v; want no flag", res, err)
	}
	if c, l := r.calls(); c != 1 || l != 0 {
		t.Fatalf("calls = %d classifier, %d llm; want 1, 0", c, l)
	}
	call := r.cls.Calls()[0]
	if call.Question != followup.GateQuestion || call.State["last_agent_message"] != "Done, PR merged." {
		t.Fatalf("classify call = %+v", call)
	}
}

func TestRunExtracts(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.96
	r.llm.Text = "Sure:\n```json\n" + twoQuestions + "\n```"
	res, err := followup.Run(context.Background(), r.cls, r.llm, followup.SampleQuestions, 0.7)
	if err != nil || !res.Flag || res.Source != followup.SourceModel || len(res.Questions) != 2 {
		t.Fatalf("Run = %+v, %v", res, err)
	}
	q := res.Questions[1]
	if q.ID != "q2" || q.Kind != followup.KindChoice || len(q.Options) != 2 || q.Options[1] != "Wait for e2e-live" {
		t.Fatalf("question 2 = %+v", q)
	}
	req := r.llm.Calls()[0]
	if !req.JSON || len(req.Messages) != 2 || !strings.Contains(req.Messages[1].Content, "Open questions for you") {
		t.Fatalf("LLM request = %+v", req)
	}
}

func TestRunFallsBack(t *testing.T) {
	for name, llm := range map[string]*ai.FakeLLM{
		"error":        {Err: &ai.Error{Kind: ai.KindTimeout, Msg: "the LLM timed out"}},
		"invalid json": {Text: `{"questions": [`},
		"no json":      {Text: "There are two questions."},
		"too many":     {Text: manyQuestions(9)},
		"too long":     {Text: fmt.Sprintf(`{"questions":[{"question":%q,"kind":"open"}]}`, strings.Repeat("a", 301))},
		"none":         {Text: `{"questions":[]}`},
		"bad kind":     {Text: `{"questions":[{"question":"Which?","kind":"multi"}]}`},
		"one option":   {Text: `{"questions":[{"question":"Which?","kind":"choice","options":["A"]}]}`},
		"long option":  {Text: fmt.Sprintf(`{"questions":[{"question":"Which?","kind":"choice","options":["A",%q]}]}`, strings.Repeat("b", 121))},
	} {
		t.Run(name, func(t *testing.T) {
			cls := &ai.FakeClassifier{Score: 0.9}
			res, err := followup.Run(context.Background(), cls, llm, "Should I go on?", 0.7)
			if err != nil || !res.Flag || res.Source != followup.SourceFallback || res.ExtractErr == "" {
				t.Fatalf("Run = %+v, %v; want the fallback", res, err)
			}
			if len(res.Questions) != 1 || res.Questions[0].Kind != followup.KindOpen || res.Questions[0].Question != followup.FallbackQuestion {
				t.Fatalf("questions = %+v", res.Questions)
			}
		})
	}
}

func manyQuestions(n int) string {
	var qs []string
	for i := range n {
		qs = append(qs, fmt.Sprintf(`{"question":"Q%d?","kind":"open"}`, i))
	}
	return `{"questions":[` + strings.Join(qs, ",") + `]}`
}

func TestParseClipsAndNormalises(t *testing.T) {
	qs, err := followup.Parse(manyQuestions(8))
	if err != nil || len(qs) != 8 {
		t.Fatalf("8 questions: %d, %v", len(qs), err)
	}
	qs, err = followup.Parse(`{"questions":[{"question":"  Ship\n it   now? ","kind":"yes_no","options":["Yes","No"]},
		{"question":"` + strings.Repeat("é", 300) + `","kind":"open"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if qs[0].Question != "Ship it now?" || qs[0].Options != nil {
		t.Fatalf("yes_no = %+v: want the text folded and its options dropped", qs[0])
	}
	if len([]rune(qs[1].Question)) != 300 {
		t.Fatalf("300 characters (not bytes) are allowed")
	}
}

func TestRunClassifierErrorIsAnError(t *testing.T) {
	r := newRoles()
	r.cls.Err = ai.ErrNotReady
	if _, err := followup.Run(context.Background(), r.cls, r.llm, "Should I?", 0.7); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("err = %v", err)
	}
	if _, l := r.calls(); l != 0 {
		t.Fatal("the LLM was called after the gate failed")
	}
}

func TestRunTrimsToTheTail(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0
	long := strings.Repeat("x", followup.MaxMessageChars) + "END?"
	if _, err := followup.Run(context.Background(), r.cls, r.llm, long, 0.7); err != nil {
		t.Fatal(err)
	}
	got := r.cls.Calls()[0].State["last_agent_message"].(string)
	if len(got) != followup.MaxMessageChars || !strings.HasSuffix(got, "END?") {
		t.Fatalf("sent %d chars ending %q", len(got), got[len(got)-4:])
	}
}

func newService(t *testing.T, r *roles, st followup.Store, env *bool, now *time.Time) *followup.Service {
	t.Helper()
	s, err := followup.New(context.Background(), followup.Options{Roles: r, Store: st, EnvEnabled: env,
		Now: func() time.Time { return *now }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func ptr[T any](v T) *T { return &v }

// The test's samples score high and low, and the questions sample is
// extracted.
func passingRoles() *roles {
	r := newRoles()
	r.scoreBy(func(msg string) float64 {
		if strings.Contains(msg, "Open questions") {
			return 0.96
		}
		return 0.02
	})
	r.llm.Text = twoQuestions
	return r
}

func TestEnablingNeedsAPassingTest(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	r := passingRoles()
	st := &memStore{}
	s := newService(t, r, st, nil, &now)
	if v := s.View(); v.Enabled || v.State != followup.StateOff || v.Threshold != followup.DefaultThreshold || v.Tested {
		t.Fatalf("fresh view = %+v", v)
	}
	var fe *followup.Error
	if err := s.Set(ctx, ptr(true), nil); !errors.As(err, &fe) || fe.Code != followup.CodeTestRequired {
		t.Fatalf("enable untested = %v", err)
	}
	// Configuring the models alone sends nothing.
	if c, l := r.calls(); c+l != 0 {
		t.Fatalf("calls before the test: %d, %d", c, l)
	}
	res, err := s.Test(ctx, nil)
	if err != nil || !res.OK || len(res.Samples) != 2 {
		t.Fatalf("test = %+v, %v", res, err)
	}
	if q := res.Samples[0]; q.Score != 0.96 || !q.Flagged || len(q.Questions) != 2 || q.Source != followup.SourceModel {
		t.Fatalf("questions sample = %+v", q)
	}
	if d := res.Samples[1]; d.Score != 0.02 || d.Flagged || d.Questions != nil {
		t.Fatalf("done sample = %+v", d)
	}
	if !s.View().Tested {
		t.Fatal("a passing test is not shown")
	}
	// Another model since the test: the pass does not cover it.
	r.fp[ai.RoleLLM] = "l2"
	if err := s.Set(ctx, ptr(true), nil); !errors.As(err, &fe) || fe.Code != followup.CodeTestRequired {
		t.Fatalf("enable after a model change = %v", err)
	}
	r.fp[ai.RoleLLM] = "l1"
	if err := s.Set(ctx, ptr(true), ptr(0.8)); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); !v.Enabled || v.State != followup.StateReady || v.Threshold != 0.8 || !st.enabled || st.threshold != 0.8 {
		t.Fatalf("enabled view = %+v, store %+v", v, st)
	}
	// Stored: a restart keeps it.
	if v := newService(t, r, st, nil, &now).View(); !v.Enabled || v.Threshold != 0.8 {
		t.Fatalf("after a restart: %+v", v)
	}
	// Disabling needs nothing.
	if err := s.Set(ctx, ptr(false), nil); err != nil || s.View().State != followup.StateOff {
		t.Fatalf("disable: %v, %+v", err, s.View())
	}
	// A pass is good for 30 minutes.
	now = now.Add(31 * time.Minute)
	if err := s.Set(ctx, ptr(true), nil); !errors.As(err, &fe) || fe.Code != followup.CodeTestRequired {
		t.Fatalf("enable with an old pass = %v", err)
	}
}

func TestFailingTest(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	for name, tc := range map[string]struct {
		setup  func(r *roles)
		reason string
	}{
		"questions low": {func(r *roles) { r.scoreBy(func(string) float64 { return 0.3 }) }, "under the threshold"},
		"done high":     {func(r *roles) { r.scoreBy(func(string) float64 { return 0.9 }) }, "at or over"},
		"llm fails":     {func(r *roles) { r.llm.Text = "nope" }, "did not extract"},
	} {
		t.Run(name, func(t *testing.T) {
			r := passingRoles()
			tc.setup(r)
			s := newService(t, r, &memStore{}, nil, &now)
			res, err := s.Test(ctx, nil)
			if err != nil || res.OK || !strings.Contains(res.Reason, tc.reason) {
				t.Fatalf("test = %+v, %v", res, err)
			}
			if s.View().Tested {
				t.Fatal("a failing test counts")
			}
		})
	}
	// A failed call is an error.
	r := passingRoles()
	r.cls.Func = nil
	r.cls.Err = &ai.Error{Kind: ai.KindAuthFailed, Msg: "the key was rejected"}
	if _, err := newService(t, r, &memStore{}, nil, &now).Test(ctx, nil); ai.KindOf(err) != ai.KindAuthFailed {
		t.Fatalf("err = %v", err)
	}
}

func TestNotReadyMakesNoCall(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	r := passingRoles()
	s := newService(t, r, &memStore{}, nil, &now)
	// Off: the models are ready, nothing goes out.
	if _, err := s.Detect(ctx, followup.SampleQuestions); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("detect while off = %v", err)
	}
	if _, err := s.Test(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ctx, ptr(true), nil); err != nil {
		t.Fatal(err)
	}
	c0, l0 := r.calls()
	// A role going invalid at runtime pauses it.
	r.state[ai.RoleLLM] = ai.StateInvalid
	v := s.View()
	if v.State != followup.StateIncomplete || len(v.Missing) != 1 || v.Missing[0] != "llm" || v.Roles.LLM != "invalid" {
		t.Fatalf("view = %+v", v)
	}
	if _, err := s.Detect(ctx, followup.SampleQuestions); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("detect while incomplete = %v", err)
	}
	if c, l := r.calls(); c != c0 || l != l0 {
		t.Fatal("a call went out while a role was invalid")
	}
	var fe *followup.Error
	if _, err := s.Test(ctx, nil); !errors.As(err, &fe) || fe.Code != followup.CodeIncomplete {
		t.Fatalf("test while incomplete = %v", err)
	}
	r.state[ai.RoleLLM] = ai.StateReady
	res, err := s.Detect(ctx, followup.SampleQuestions)
	if err != nil || !res.Flag {
		t.Fatalf("detect when ready = %+v, %v", res, err)
	}
}

func TestEnvLocksTheToggle(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	r := passingRoles()
	s := newService(t, r, &memStore{}, ptr(true), &now)
	v := s.View()
	if !v.Enabled || v.State != followup.StateReady || len(v.Env) != 1 || v.Env[0] != "enabled" {
		t.Fatalf("view = %+v", v)
	}
	var fe *followup.Error
	if err := s.Set(ctx, ptr(false), nil); !errors.As(err, &fe) || fe.Code != followup.CodeEnvLocked {
		t.Fatalf("disable = %v", err)
	}
	if err := s.Set(ctx, nil, ptr(0.5)); err != nil || s.View().Threshold != 0.5 {
		t.Fatalf("threshold = %v", err)
	}
	if err := s.Set(ctx, nil, ptr(1.5)); !errors.As(err, &fe) || fe.Code != followup.CodeBadRequest {
		t.Fatalf("bad threshold = %v", err)
	}
	off := newService(t, r, &memStore{enabled: true, threshold: 0.7, ok: true}, ptr(false), &now)
	if off.View().State != followup.StateOff {
		t.Fatal("the environment's false does not win over the stored toggle")
	}
}

// Switched off, or a role gone invalid, while the classifier ran: a positive
// gate makes no LLM call and flags nothing.
func TestDetectRechecksBeforeTheLLM(t *testing.T) {
	for name, change := range map[string]func(s *followup.Service, r *roles){
		"disabled": func(s *followup.Service, _ *roles) {
			if err := s.Set(context.Background(), ptr(false), nil); err != nil {
				t.Fatal(err)
			}
		},
		"classifier invalid": func(_ *followup.Service, r *roles) { r.state[ai.RoleClassifier] = ai.StateInvalid },
		"llm invalid":        func(_ *followup.Service, r *roles) { r.state[ai.RoleLLM] = ai.StateInvalid },
	} {
		t.Run(name, func(t *testing.T) {
			now := time.Unix(1_790_000_000, 0)
			r := passingRoles()
			s := newService(t, r, &memStore{enabled: true, threshold: 0.7, ok: true}, nil, &now)
			r.cls.Func = func(context.Context, map[string]any, string) (float64, error) {
				change(s, r)
				return 0.96, nil
			}
			res, err := s.Detect(context.Background(), followup.SampleQuestions)
			if !errors.Is(err, ai.ErrNotReady) || res != nil {
				t.Fatalf("Detect = %+v, %v; want ai.ErrNotReady", res, err)
			}
			if c, l := r.calls(); c != 1 || l != 0 {
				t.Fatalf("calls = %d classifier, %d llm; want 1, 0", c, l)
			}
		})
	}
}
