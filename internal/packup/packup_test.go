package packup_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/packup"
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

// spans is the LLM's answer listing parts to remove.
func spans(s ...string) string {
	b, _ := json.Marshal(map[string][]string{"remove": s})
	return string(b)
}

// The ticket's examples: each cut to its task, and what was cut in UTF-16
// units of the prompt.
func TestRunCutsTheExamples(t *testing.T) {
	for _, tc := range []struct {
		prompt, span, task string
	}{
		{"Please make a PR and end your turn", " and end your turn", "Please make a PR"},
		{"Please make a PR and stop working", " and stop working", "Please make a PR"},
		{"Do the action, leave the office and clean up the worktree", ", leave the office and clean up the worktree", "Do the action"},
	} {
		t.Run(tc.prompt, func(t *testing.T) {
			r := newRoles()
			r.cls.Score = 0.97
			r.llm.Text = "Here:\n```json\n" + spans(tc.span) + "\n```"
			res, err := packup.Run(context.Background(), r.cls, r.llm, tc.prompt, 0.85)
			if err != nil || !res.Matched || res.Task != tc.task || res.ExtractErr != "" {
				t.Fatalf("Run = %+v, %v; want task %q", res, err, tc.task)
			}
			start := strings.Index(tc.prompt, tc.span)
			if len(res.Removed) != 1 || res.Removed[0] != (packup.Range{Start: start, End: start + len(tc.span)}) {
				t.Fatalf("removed = %+v", res.Removed)
			}
			call := r.cls.Calls()[0]
			if call.Question != packup.GateQuestion || call.State["prompt"] != tc.prompt {
				t.Fatalf("classify call = %+v", call)
			}
			req := r.llm.Calls()[0]
			if !req.JSON || len(req.Messages) != 2 || !strings.HasSuffix(req.Messages[1].Content, tc.prompt) {
				t.Fatalf("LLM request = %+v", req)
			}
		})
	}
}

func TestRunBelowThresholdCallsNoLLM(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.84
	res, err := packup.Run(context.Background(), r.cls, r.llm, "Please make a PR", 0.85)
	if err != nil || res.Matched || res.Task != "" || res.Score != 0.84 {
		t.Fatalf("Run = %+v, %v; want no match", res, err)
	}
	if c, l := r.calls(); c != 1 || l != 0 {
		t.Fatalf("calls = %d classifier, %d llm; want 1, 0", c, l)
	}
}

// Whatever the LLM answers that is not a valid cut is no match: the prompt
// goes as written.
func TestRunInvalidExtractionIsNoMatch(t *testing.T) {
	const prompt = "Please make a PR and end your turn"
	for name, llm := range map[string]*ai.FakeLLM{
		"tampered span": {Text: spans(" and finish your turn")},
		"reworded":      {Text: spans("and End your turn.")},
		"out of order":  {Text: spans("end your turn", "Please")},
		"nothing":       {Text: spans()},
		"blank span":    {Text: spans("  ")},
		"no list":       {Text: `{"task":"Please make a PR"}`},
		"bad json":      {Text: `{"remove": [" and end`},
		"no json":       {Text: "Remove: and end your turn"},
		"too many":      {Text: spans("P", "l", "e", "a", "s", "e", " ", "m", "a")},
		"failure":       {Err: &ai.Error{Kind: ai.KindFailed, Msg: "the provider failed"}},
		"timeout":       {Err: &ai.Error{Kind: ai.KindTimeout, Msg: "the LLM timed out"}},
	} {
		t.Run(name, func(t *testing.T) {
			cls := &ai.FakeClassifier{Score: 0.95}
			res, err := packup.Run(context.Background(), cls, llm, prompt, 0.85)
			if err != nil || res.Matched || res.Task != "" || res.Removed != nil || res.ExtractErr == "" {
				t.Fatalf("Run = %+v, %v; want no match", res, err)
			}
		})
	}
}

func TestRunClassifierFailureIsAnError(t *testing.T) {
	r := newRoles()
	r.cls.Err = &ai.Error{Kind: ai.KindTimeout, Msg: "the classifier timed out"}
	if _, err := packup.Run(context.Background(), r.cls, r.llm, "Make a PR and go home", 0.85); ai.KindOf(err) != ai.KindTimeout {
		t.Fatalf("err = %v", err)
	}
	if _, l := r.calls(); l != 0 {
		t.Fatal("the LLM was called after the gate failed")
	}
}

// Nothing left once the leaving part is cut: a match with no task (the game
// opens the send-home dialog).
func TestRunEmptyRemainder(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.99
	r.llm.Text = spans("Go home", " and clean up the worktree.")
	res, err := packup.Run(context.Background(), r.cls, r.llm, "Go home and clean up the worktree.", 0.85)
	if err != nil || !res.Matched || res.Task != "" || len(res.Removed) != 1 || res.Removed[0] != (packup.Range{Start: 0, End: 34}) {
		t.Fatalf("Run = %+v, %v", res, err)
	}
}

// The joins are tidied (spaces, a dangling separator); the task's own words
// never change.
func TestRunTidiesTheJoins(t *testing.T) {
	for _, tc := range []struct {
		prompt string
		spans  []string
		task   string
	}{
		{"Fix the test, then go home.", []string{"then go home"}, "Fix the test."},
		{"Fix the test, then go home.", []string{", then go home"}, "Fix the test."},
		{"Go home after you fix the test", []string{"Go home after you"}, "fix the test"},
		{"Fix A,   go home,   and fix B", []string{"go home,"}, "Fix A, and fix B"},
		{"Fix A.\nThen go home.\nAlso fix B.", []string{"Then go home."}, "Fix A.\n\nAlso fix B."},
		{"Fix A; leave; clean up", []string{" leave;", " clean up"}, "Fix A"},
		{"Ünïcode 🎉 fix, then go home", []string{", then go home"}, "Ünïcode 🎉 fix"},
	} {
		r := newRoles()
		r.cls.Score = 0.9
		r.llm.Text = spans(tc.spans...)
		res, err := packup.Run(context.Background(), r.cls, r.llm, tc.prompt, 0.85)
		if err != nil || !res.Matched || res.Task != tc.task {
			t.Errorf("%q: Run = %+v, %v; want task %q", tc.prompt, res, err, tc.task)
		}
	}
}

// Removed is in UTF-16 code units: an emoji is two.
func TestRemovedIsUTF16(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.9
	r.llm.Text = spans(" then go home")
	prompt := "Ship 🎉 é then go home"
	res, err := packup.Run(context.Background(), r.cls, r.llm, prompt, 0.85)
	if err != nil || !res.Matched {
		t.Fatalf("Run = %+v, %v", res, err)
	}
	// "Ship " 5, "🎉" 2, " é" 2: the span starts at 9 and is 13 long.
	if res.Removed[0] != (packup.Range{Start: 9, End: 22}) || res.Task != "Ship 🎉 é" {
		t.Fatalf("removed = %+v, task %q", res.Removed, res.Task)
	}
}

// Image markers: the models see "[Image #n]", never the path; a span over
// one is invalid; one before a cut shifts it right in the prompt.
func TestImageMarkersAreProtected(t *testing.T) {
	const img = "[Image #1: /home/u/drops/2026-10/shot à 1.png]"
	prompt := "Match this " + img + " exactly, then go home"
	r := newRoles()
	r.cls.Score = 0.9
	r.llm.Text = spans(", then go home")
	res, err := packup.Run(context.Background(), r.cls, r.llm, prompt, 0.85)
	if err != nil || !res.Matched || res.Task != "Match this "+img+" exactly" {
		t.Fatalf("Run = %+v, %v", res, err)
	}
	start := len([]rune("Match this " + img + " exactly"))
	if res.Removed[0] != (packup.Range{Start: start, End: start + len(", then go home")}) {
		t.Fatalf("removed = %+v", res.Removed)
	}
	sent := r.cls.Calls()[0].State["prompt"].(string)
	llmSent := r.llm.Calls()[0].Messages[1].Content
	for _, s := range []string{sent, llmSent} {
		if strings.Contains(s, "/home/u") || !strings.Contains(s, "Match this [Image #1] exactly, then go home") {
			t.Fatalf("a model saw %q", s)
		}
	}
	for _, sp := range []string{"[Image #1] exactly, then go home", "#1] exactly", "[Image #1]"} {
		r.llm.Text = spans(sp)
		res, err := packup.Run(context.Background(), r.cls, r.llm, prompt, 0.85)
		if err != nil || res.Matched || !strings.Contains(res.ExtractErr, "image") {
			t.Errorf("span %q: Run = %+v, %v; want no match", sp, res, err)
		}
	}
	// The path itself is not in what the LLM saw: a span of it is not found.
	r.llm.Text = spans("/home/u/drops")
	if res, _ := packup.Run(context.Background(), r.cls, r.llm, prompt, 0.85); res.Matched {
		t.Fatalf("a span of a path matched: %+v", res)
	}
}

// A long prompt: only its tail goes, never starting inside an image marker.
func TestRunSendsTheTail(t *testing.T) {
	r := newRoles()
	r.cls.Score = 0.9
	r.llm.Text = spans(", then go home")
	long := strings.Repeat("x", 10_000) + " fix it, then go home"
	res, err := packup.Run(context.Background(), r.cls, r.llm, long, 0.85)
	if err != nil || !res.Matched || res.Task != strings.Repeat("x", 10_000)+" fix it" {
		t.Fatalf("Run: %v, matched %v", err, res.Matched)
	}
	sent := r.cls.Calls()[0].State["prompt"].(string)
	if len([]rune(sent)) != packup.MaxPromptChars || !strings.HasSuffix(sent, "then go home") {
		t.Fatalf("sent %d chars", len([]rune(sent)))
	}
	if res.Removed[0].Start != 10_007 {
		t.Fatalf("removed = %+v", res.Removed)
	}
	img := "[Image #2: /p/" + strings.Repeat("y", 40) + ".png]"
	cutIn := strings.Repeat("x", 10_000-packup.MaxPromptChars+5) + img + strings.Repeat("z", packup.MaxPromptChars-20)
	r2 := newRoles()
	if _, err := packup.Run(context.Background(), r2.cls, r2.llm, cutIn, 0.85); err != nil {
		t.Fatal(err)
	}
	if s := r2.cls.Calls()[0].State["prompt"].(string); strings.Contains(s, "y") || strings.Contains(s, "Image") || strings.Contains(s, "x") {
		t.Fatalf("the tail starts inside a marker: %.40q", s)
	}
}

type memStore struct {
	enabled   bool
	threshold float64
	ok        bool
}

func (m *memStore) LoadPackupSettings(context.Context) (bool, float64, bool, error) {
	return m.enabled, m.threshold, m.ok, nil
}

func (m *memStore) SavePackupSettings(_ context.Context, en bool, th float64) error {
	m.enabled, m.threshold, m.ok = en, th, true
	return nil
}

func ptr[T any](v T) *T { return &v }

// passingRoles score the samples by their labels and cut the core ones as
// expected.
func passingRoles() *roles {
	r := newRoles()
	labels := map[string]packup.LabelledPrompt{}
	for _, s := range packup.Samples {
		labels[s.Text] = s
	}
	r.cls.Func = func(_ context.Context, state map[string]any, _ string) (float64, error) {
		if s, ok := labels[state["prompt"].(string)]; ok && !s.Match {
			return 0.05, nil
		}
		return 0.96, nil
	}
	r.llm.Func = func(_ context.Context, req ai.Request) (string, error) {
		p := strings.TrimPrefix(req.Messages[1].Content, "The prompt:\n\n")
		if s, ok := labels[p]; ok && s.Task != "" {
			return spans(strings.TrimPrefix(p, s.Task)), nil
		}
		return spans(" and go home"), nil
	}
	return r
}

func newService(t *testing.T, r *roles, st packup.Store, env *bool, now *time.Time) *packup.Service {
	t.Helper()
	s, err := packup.New(context.Background(), packup.Options{Roles: r, Store: st, EnvEnabled: env, Now: func() time.Time { return *now }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestSamples(t *testing.T) {
	seen := map[string]bool{}
	var core, match, skip int
	for _, s := range packup.Samples {
		if seen[s.Text] {
			t.Errorf("sample %q twice", s.Text)
		}
		seen[s.Text] = true
		if s.Core {
			core++
			if s.Match && !strings.HasPrefix(s.Text, s.Task) {
				t.Errorf("core %q: its task %q is not where it starts", s.Text, s.Task)
			}
		}
		if s.Match {
			match++
		} else {
			skip++
		}
	}
	if len(packup.Samples) < 30 || core != 4 || match < 12 || skip < 12 {
		t.Fatalf("%d samples: %d core, %d match, %d skip", len(packup.Samples), core, match, skip)
	}
}

func TestEnablingNeedsAPassingTest(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	r := passingRoles()
	st := &memStore{}
	s := newService(t, r, st, nil, &now)
	if v := s.View(); v.Enabled || v.State != packup.StateOff || v.Threshold != packup.DefaultThreshold || v.Tested {
		t.Fatalf("fresh view = %+v", v)
	}
	var pe *packup.Error
	if err := s.Set(ctx, ptr(true), nil); !errors.As(err, &pe) || pe.Code != packup.CodeTestRequired {
		t.Fatalf("enable untested = %v", err)
	}
	if c, l := r.calls(); c+l != 0 {
		t.Fatalf("calls before the test: %d, %d", c, l)
	}
	res, err := s.Test(ctx, nil)
	if err != nil || !res.OK || len(res.Samples) != len(packup.Samples) || res.Right != res.Total || res.Total != len(packup.Samples) {
		t.Fatalf("test = %+v, %v", res, err)
	}
	if c, l := r.calls(); c != len(packup.Samples) || l != 3 {
		t.Fatalf("test calls = %d classifier, %d llm; want every sample, the 3 core matches", c, l)
	}
	if s0 := res.Samples[0]; !s0.Core || !s0.Matched || s0.Task != "Please make a PR" || !s0.Right || s0.Expect != "match" {
		t.Fatalf("first sample = %+v", s0)
	}
	if !s.View().Tested {
		t.Fatal("a passing test is not shown")
	}
	r.fp[ai.RoleClassifier] = "c2"
	if err := s.Set(ctx, ptr(true), nil); !errors.As(err, &pe) || pe.Code != packup.CodeTestRequired {
		t.Fatalf("enable after a model change = %v", err)
	}
	r.fp[ai.RoleClassifier] = "c1"
	if err := s.Set(ctx, ptr(true), ptr(0.9)); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); !v.Enabled || v.State != packup.StateReady || v.Threshold != 0.9 || !st.enabled || st.threshold != 0.9 {
		t.Fatalf("enabled view = %+v, store %+v", v, st)
	}
	if v := newService(t, r, st, nil, &now).View(); !v.Enabled || v.Threshold != 0.9 {
		t.Fatalf("after a restart: %+v", v)
	}
	if err := s.Set(ctx, ptr(false), nil); err != nil || s.View().State != packup.StateOff {
		t.Fatalf("disable: %v, %+v", err, s.View())
	}
	now = now.Add(31 * time.Minute)
	if err := s.Set(ctx, ptr(true), nil); !errors.As(err, &pe) || pe.Code != packup.CodeTestRequired {
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
		"negative high": {func(r *roles) {
			r.cls.Func = func(context.Context, map[string]any, string) (float64, error) { return 0.96, nil }
		}, "at or over"},
		"positive low": {func(r *roles) {
			r.cls.Func = func(context.Context, map[string]any, string) (float64, error) { return 0.3, nil }
		}, "under the threshold"},
		"llm fails": {func(r *roles) { r.llm.Func = nil; r.llm.Text = "nope" }, "did not cut"},
		"wrong cut": {func(r *roles) { r.llm.Func = nil; r.llm.Text = spans("Please") }, "not \"Please make a PR\""},
	} {
		t.Run(name, func(t *testing.T) {
			r := passingRoles()
			tc.setup(r)
			s := newService(t, r, &memStore{}, nil, &now)
			res, err := s.Test(ctx, nil)
			if err != nil || res.OK || !strings.Contains(res.Reason, tc.reason) {
				t.Fatalf("test = %+v, %v", res.Reason, err)
			}
			if s.View().Tested {
				t.Fatal("a failing test counts")
			}
		})
	}
	// Only the core samples gate it: one other on the wrong side is
	// reported, not failed.
	r := passingRoles()
	base := r.cls.Func
	r.cls.Func = func(ctx context.Context, st map[string]any, q string) (float64, error) {
		if st["prompt"] == "Mach einen PR und geh dann nach Hause." {
			return 0.4, nil
		}
		return base(ctx, st, q)
	}
	res, err := newService(t, r, &memStore{}, nil, &now).Test(ctx, nil)
	if err != nil || !res.OK || res.Right != res.Total-1 {
		t.Fatalf("test = %+v, %v", res, err)
	}
	// A failed call is an error.
	r = passingRoles()
	r.cls.Func = nil
	r.cls.Err = &ai.Error{Kind: ai.KindAuthFailed, Msg: "the key was rejected"}
	if _, err := newService(t, r, &memStore{}, nil, &now).Test(ctx, nil); ai.KindOf(err) != ai.KindAuthFailed {
		t.Fatalf("err = %v", err)
	}
}

func TestOffOrNotReadyMakesNoCall(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	r := passingRoles()
	s := newService(t, r, &memStore{}, nil, &now)
	if _, err := s.Detect(ctx, "Please make a PR and end your turn"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("detect while off = %v", err)
	}
	if c, l := r.calls(); c+l != 0 {
		t.Fatalf("calls while off: %d, %d", c, l)
	}
	if _, err := s.Test(ctx, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ctx, ptr(true), nil); err != nil {
		t.Fatal(err)
	}
	c0, l0 := r.calls()
	r.state[ai.RoleLLM] = ai.StateInvalid
	if v := s.View(); v.State != packup.StateIncomplete || len(v.Missing) != 1 || v.Missing[0] != "llm" {
		t.Fatalf("view = %+v", v)
	}
	if _, err := s.Detect(ctx, "Please make a PR and end your turn"); !errors.Is(err, ai.ErrNotReady) {
		t.Fatalf("detect while incomplete = %v", err)
	}
	if c, l := r.calls(); c != c0 || l != l0 {
		t.Fatal("a call went out while a role was invalid")
	}
	r.state[ai.RoleLLM] = ai.StateReady
	res, err := s.Detect(ctx, "Please make a PR and end your turn")
	if err != nil || !res.Matched || res.Task != "Please make a PR" {
		t.Fatalf("detect when ready = %+v, %v", res, err)
	}
}

// Switched off, or a role gone invalid, while the classifier ran: no LLM
// call, no match.
func TestDetectRechecksBeforeTheLLM(t *testing.T) {
	for name, change := range map[string]func(s *packup.Service, r *roles){
		"disabled": func(s *packup.Service, _ *roles) {
			if err := s.Set(context.Background(), ptr(false), nil); err != nil {
				t.Fatal(err)
			}
		},
		"llm invalid": func(_ *packup.Service, r *roles) { r.state[ai.RoleLLM] = ai.StateInvalid },
	} {
		t.Run(name, func(t *testing.T) {
			now := time.Unix(1_790_000_000, 0)
			r := passingRoles()
			s := newService(t, r, &memStore{enabled: true, threshold: 0.85, ok: true}, nil, &now)
			r.cls.Func = func(context.Context, map[string]any, string) (float64, error) {
				change(s, r)
				return 0.96, nil
			}
			res, err := s.Detect(context.Background(), "Please make a PR and end your turn")
			if !errors.Is(err, ai.ErrNotReady) || res != nil {
				t.Fatalf("Detect = %+v, %v; want ai.ErrNotReady", res, err)
			}
			if c, l := r.calls(); c != 1 || l != 0 {
				t.Fatalf("calls = %d classifier, %d llm; want 1, 0", c, l)
			}
		})
	}
}

// The whole detect is bounded: a model that does not answer in time is an
// error (the prompt goes as written), however slow it is.
func TestDetectTimesOut(t *testing.T) {
	now := time.Unix(1_790_000_000, 0)
	for name, slow := range map[string]func(r *roles){
		"classifier": func(r *roles) {
			r.cls.Func = func(ctx context.Context, _ map[string]any, _ string) (float64, error) {
				<-ctx.Done()
				return 0, &ai.Error{Kind: ai.KindTimeout, Msg: "the classifier timed out"}
			}
		},
		"llm": func(r *roles) {
			r.cls.Func = func(context.Context, map[string]any, string) (float64, error) { return 0.96, nil }
			r.llm.Func = func(ctx context.Context, _ ai.Request) (string, error) {
				<-ctx.Done()
				return "", &ai.Error{Kind: ai.KindTimeout, Msg: "the LLM timed out"}
			}
		},
		"llm ignoring its deadline": func(r *roles) {
			r.cls.Func = func(context.Context, map[string]any, string) (float64, error) { return 0.96, nil }
			r.llm.Func = func(ctx context.Context, _ ai.Request) (string, error) {
				<-ctx.Done()
				return spans(" and end your turn"), nil
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := passingRoles()
			slow(r)
			s, err := packup.New(context.Background(), packup.Options{Roles: r, Store: &memStore{enabled: true, threshold: 0.85, ok: true},
				Timeout: 30 * time.Millisecond, Now: func() time.Time { return now }})
			if err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			res, err := s.Detect(context.Background(), "Please make a PR and end your turn")
			if err == nil || res != nil {
				t.Fatalf("Detect = %+v, %v; want an error", res, err)
			}
			if d := time.Since(start); d > time.Second {
				t.Fatalf("took %v", d)
			}
		})
	}
	if packup.DetectTimeout != 1500*time.Millisecond {
		t.Fatalf("DetectTimeout = %v", packup.DetectTimeout)
	}
}

func TestEnvLocksTheToggle(t *testing.T) {
	ctx := context.Background()
	now := time.Unix(1_790_000_000, 0)
	r := passingRoles()
	s := newService(t, r, &memStore{}, ptr(true), &now)
	if v := s.View(); !v.Enabled || v.State != packup.StateReady || len(v.Env) != 1 || v.Env[0] != "enabled" {
		t.Fatalf("view = %+v", v)
	}
	var pe *packup.Error
	if err := s.Set(ctx, ptr(false), nil); !errors.As(err, &pe) || pe.Code != packup.CodeEnvLocked {
		t.Fatalf("disable = %v", err)
	}
	if err := s.Set(ctx, nil, ptr(0.5)); err != nil || s.View().Threshold != 0.5 {
		t.Fatalf("threshold = %v", err)
	}
	if err := s.Set(ctx, nil, ptr(1.5)); !errors.As(err, &pe) || pe.Code != packup.CodeBadRequest {
		t.Fatalf("bad threshold = %v", err)
	}
	if off := newService(t, r, &memStore{enabled: true, threshold: 0.85, ok: true}, ptr(false), &now); off.View().State != packup.StateOff {
		t.Fatal("the environment's false does not win over the stored toggle")
	}
}
