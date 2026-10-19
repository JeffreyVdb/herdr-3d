package digest_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
)

// reasoner is roles that also know the model's reasoning, the way
// *ai.Service does from the catalog.
type reasoner struct {
	*roles
	rmu   sync.Mutex
	known ai.Reasoning // what a read has found
	read  ai.Reasoning // what the next read finds
	reads int
}

func newReasoner(text string, r ai.Reasoning) *reasoner {
	return &reasoner{roles: newRoles(text), read: r, known: ai.UnknownReasoning()}
}

func (r *reasoner) ModelReasoning(context.Context) ai.Reasoning {
	r.rmu.Lock()
	defer r.rmu.Unlock()
	r.reads++
	r.known = r.read
	return r.known
}

func (r *reasoner) KnownReasoning() ai.Reasoning {
	r.rmu.Lock()
	defer r.rmu.Unlock()
	return r.known
}

var luna = ai.Reasoning{Support: ai.SupportYes, Model: "gpt-6-luna", Efforts: []string{"none", "low", "medium", "high", "xhigh", "max"}, Listed: true, Default: "medium"}

func newSvc(t *testing.T, r digest.Roles, st digest.Store) *digest.Service {
	t.Helper()
	s, err := digest.New(context.Background(), digest.Options{Roles: r, Store: st, Now: func() time.Time { return noon }})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func str(s string) *string { return &s }
func num(n int) *int       { return &n }

// #174: the completion budget defaults to 1024 and is the feature's own
// setting; nothing is sent as an effort until one is chosen.
func TestDefaultBudgetAndNoEffort(t *testing.T) {
	r := newReasoner("Fixing the build", luna)
	s := enabled(t, r.roles, nil) // roles without a catalog: the reasoning is unknown
	if v := s.View(); v.MaxTokens != 1024 || v.ReasoningEffort != "" || v.EffortStale {
		t.Fatalf("view %+v", v)
	}
	if _, err := s.Summarize(context.Background(), nowInput("Running tests")); err != nil {
		t.Fatal(err)
	}
	calls := r.llm.Calls()
	if c := calls[len(calls)-1]; c.MaxTokens != 1024 || c.ReasoningEffort != "" || !c.NoPartial || c.Messages[1].Content == "" {
		t.Fatalf("request %+v", c)
	}
	if digest.DefaultMaxTokens != 1024 {
		t.Fatal("the default budget is 1024")
	}
}

// The effort and the budget are applied to every request, the test's too,
// and persist.
func TestEffortAndBudgetAppliedAndPersisted(t *testing.T) {
	r := newReasoner("Fixing the build", luna)
	st := &memStore{}
	s := newSvc(t, r, st)
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("none"), MaxTokens: num(2048)}); err != nil {
		t.Fatal(err)
	}
	if v := s.View(); v.ReasoningEffort != "none" || v.MaxTokens != 2048 || v.EffortStale || v.Reasoning.Support != ai.SupportYes {
		t.Fatalf("view %+v", v)
	}
	if res, err := s.Test(context.Background()); err != nil || !res.OK {
		t.Fatalf("%+v %v", res, err)
	}
	on := true
	if err := s.Set(context.Background(), &on, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Summarize(context.Background(), digest.Input{Kind: digest.KindTask, Prompt: "Fix the flaky login test"}); err != nil {
		t.Fatal(err)
	}
	for i, c := range r.llm.Calls() { // the test's two and the line's one
		if c.MaxTokens != 2048 || c.ReasoningEffort != "none" {
			t.Errorf("call %d: max %d, effort %q", i, c.MaxTokens, c.ReasoningEffort)
		}
	}
	s2 := newSvc(t, r, st)
	if v := s2.View(); v.ReasoningEffort != "none" || v.MaxTokens != 2048 {
		t.Fatalf("after a restart: %+v", v)
	}
	// Back to the provider's default: nothing is sent.
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("")}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Summarize(context.Background(), nowInput("Another input")); err != nil {
		t.Fatal(err)
	}
	calls := r.llm.Calls()
	if c := calls[len(calls)-1]; c.ReasoningEffort != "" || c.MaxTokens != 2048 {
		t.Fatalf("provider default: %+v", c)
	}
}

func TestEffortAndBudgetAreValidated(t *testing.T) {
	r := newReasoner("x", luna)
	s := newSvc(t, r, nil)
	for _, u := range []digest.Update{
		{MaxTokens: num(10)},
		{MaxTokens: num(digest.MaxMaxTokens + 1)},
		{ReasoningEffort: str("bogus")},
		{ReasoningEffort: str("minimal")}, // Luna's catalog does not list it
	} {
		var de *digest.Error
		if err := s.Apply(context.Background(), u); !errors.As(err, &de) || de.Code != digest.CodeBadRequest {
			t.Errorf("%+v: %v", u, err)
		}
	}
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("minimal")}); err == nil || !strings.Contains(err.Error(), "none, low, medium, high, xhigh, max") {
		t.Errorf("the refusal names what the model takes: %v", err)
	}
	if v := s.View(); v.ReasoningEffort != "" || v.MaxTokens != 1024 {
		t.Fatalf("a refused change changes nothing: %+v", v)
	}
	// A model without reasoning takes no effort, but the budget is fine.
	r.read = ai.Reasoning{Support: ai.SupportNo, Efforts: []string{}}
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("low")}); err == nil || !strings.Contains(err.Error(), "no reasoning") {
		t.Errorf("no reasoning: %v", err)
	}
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str(""), MaxTokens: num(64)}); err != nil {
		t.Errorf("the default is always allowed: %v", err)
	}
	// Mandatory reasoning refuses none; an unknown catalog tries what the gateway knows.
	r.read = ai.Reasoning{Support: ai.SupportYes, Efforts: []string{"low", "medium", "high"}, Listed: true, Mandatory: true}
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("none")}); err == nil || !strings.Contains(err.Error(), "cannot be turned off") {
		t.Errorf("mandatory: %v", err)
	}
	r.read = ai.UnknownReasoning()
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("none")}); err != nil {
		t.Errorf("unknown model: %v", err)
	}
}

// A saved effort the model does not take (the model changed, the catalog
// did) is surfaced and not sent.
func TestStaleEffortIsSurfacedAndNotSent(t *testing.T) {
	r := newReasoner("Fixing the build", luna)
	s := newSvc(t, r, nil)
	if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("xhigh")}); err != nil {
		t.Fatal(err)
	}
	if s.View().EffortStale {
		t.Fatal("stale at once")
	}
	r.read = ai.Reasoning{Support: ai.SupportYes, Efforts: []string{"low", "high"}, Listed: true} // another model now
	r.ModelReasoning(context.Background())
	if v := s.View(); !v.EffortStale || v.ReasoningEffort != "xhigh" {
		t.Fatalf("view %+v", v)
	}
	if res, err := s.Test(context.Background()); err != nil || !res.OK {
		t.Fatal(res, err)
	}
	on := true
	if err := s.Set(context.Background(), &on, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Summarize(context.Background(), nowInput("Running tests")); err != nil {
		t.Fatal(err)
	}
	calls := r.llm.Calls()
	if c := calls[len(calls)-1]; c.ReasoningEffort != "" {
		t.Fatalf("a stale effort was sent: %q", c.ReasoningEffort)
	}
	// A model without reasoning at all: the same.
	r.read = ai.Reasoning{Support: ai.SupportNo, Efforts: []string{}}
	r.ModelReasoning(context.Background())
	if !s.View().EffortStale {
		t.Fatal("not stale for a model without reasoning")
	}
	// Reasoning support alone does not keep a saved effort valid.
	r.read = ai.Reasoning{Support: ai.SupportYes, Efforts: []string{}, Listed: true, Mandatory: true}
	r.ModelReasoning(context.Background())
	if !s.View().EffortStale {
		t.Fatal("not stale for a model without effort selection")
	}
	if _, err := s.Summarize(context.Background(), nowInput("A model without effort selection")); err != nil {
		t.Fatal(err)
	}
	calls = r.llm.Calls()
	if c := calls[len(calls)-1]; c.ReasoningEffort != "" {
		t.Fatalf("effort sent without a selector: %q", c.ReasoningEffort)
	}
}

// What was tested is what is enabled: a changed model, effort or budget needs
// a new test before the feature goes on, and changes the config key the
// retries are of.
func TestTestedAndConfigKeyFollowModelEffortAndBudget(t *testing.T) {
	r := newReasoner("Fixing the build", luna)
	s := newSvc(t, r, nil)
	if _, err := s.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !s.View().Tested {
		t.Fatal("not tested")
	}
	k0 := s.ConfigKey()
	steps := []struct {
		name string
		do   func()
	}{
		{"effort", func() {
			if err := s.Apply(context.Background(), digest.Update{ReasoningEffort: str("low")}); err != nil {
				t.Fatal(err)
			}
		}},
		{"budget", func() {
			if err := s.Apply(context.Background(), digest.Update{MaxTokens: num(4096)}); err != nil {
				t.Fatal(err)
			}
		}},
		{"model", func() { r.fp = "another-model-fp" }},
	}
	for _, st := range steps {
		if _, err := s.Test(context.Background()); err != nil {
			t.Fatal(err)
		}
		if !s.View().Tested {
			t.Fatalf("%s: not tested", st.name)
		}
		before := s.ConfigKey()
		st.do()
		if s.View().Tested {
			t.Errorf("%s changed, yet the test still covers it", st.name)
		}
		if s.ConfigKey() == before {
			t.Errorf("%s changed, the config key did not", st.name)
		}
	}
	// A passing test is a change of key too: the retries start again.
	before := s.ConfigKey()
	if _, err := s.Test(context.Background()); err != nil {
		t.Fatal(err)
	}
	if s.ConfigKey() == before || k0 == "" {
		t.Error("a passing test did not move the key")
	}
}

// A call whose answer was cut off, or had no text, fails with its kind and its
// diagnostics, is counted, and is never cached or shown.
func TestTruncatedAnswerIsAFailureWithDiagnostics(t *testing.T) {
	r := newReasoner("Fixing the build", luna)
	s := enabled(t, r.roles, nil)
	seven := 80
	r.llm.Func = func(_ context.Context, req ai.Request) (string, error) {
		req.Report(ai.Diagnostics{Status: 200, FinishReason: "length", PromptTokens: num(100), CompletionTokens: &seven, ReasoningTokens: &seven, Content: ai.ContentEmpty})
		return "", &ai.Error{Kind: ai.KindTruncated, Msg: "the model used its whole completion budget (80 of 80 tokens) before writing any text"}
	}
	before := s.View().CallsToday
	in := digest.Input{Kind: digest.KindTask, Prompt: "Please investigate. The login test is flaky."}
	res, err := s.Summarize(context.Background(), in)
	if ai.KindOf(err) != ai.KindTruncated || digest.Reason(err) != "truncated" {
		t.Fatalf("%v", err)
	}
	if res.Diag == nil || res.Diag.FinishReason != "length" || *res.Diag.ReasoningTokens != 80 || res.Diag.Content != ai.ContentEmpty || res.MaxTokens != 1024 || res.Line != "" {
		t.Fatalf("result %+v diag %+v", res, res.Diag)
	}
	if s.View().CallsToday != before+1 {
		t.Fatal("a failed call is still a call")
	}
	if _, ok := s.Cached(in); ok {
		t.Fatal("a failure was cached")
	}
	// The same input asks again (nothing cached); a good answer is then cached and free.
	r.llm.Func = nil
	r.llm.Text = "Investigate the flaky login test"
	if res, err := s.Summarize(context.Background(), in); err != nil || res.Line == "" || res.Cached {
		t.Fatalf("%+v %v", res, err)
	}
	if res, err := s.Summarize(context.Background(), in); err != nil || !res.Cached {
		t.Fatalf("%+v %v", res, err)
	}
	if digest.Reason(digest.ErrNoLine) != "no_line" || digest.Reason(errors.New("x")) != "failed" || digest.Reason(&ai.Error{Kind: ai.KindEmpty}) != "empty_answer" {
		t.Fatal("reasons")
	}
}

// A failed task line is asked again a bounded number of times, later each
// time.
func TestRetryDelayIsBounded(t *testing.T) {
	var last time.Duration
	n := 0
	for i := 1; ; i++ {
		d, ok := digest.RetryDelay(i)
		if !ok {
			break
		}
		if d <= last {
			t.Fatalf("delay %d = %v does not grow from %v", i, d, last)
		}
		last, n = d, n+1
	}
	if n != digest.MaxAttempts-1 || last > time.Hour {
		t.Fatalf("%d delays, the last %v", n, last)
	}
	if _, ok := digest.RetryDelay(0); ok {
		t.Fatal("delay 0")
	}
}
