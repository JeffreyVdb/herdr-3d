package ai_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// reasoningLLM plays an OpenRouter-like endpoint: a catalog with reasoning
// metadata, and chat answers taken from answer (the body it was sent, its
// status and its JSON).
type reasoningLLM struct {
	*httptest.Server
	mu       sync.Mutex
	bodies   []map[string]any
	catalog  string
	noModels bool
	models   atomic.Int32
	answer   func(body map[string]any) (int, string)
}

const lunaCatalog = `{"data":[
 {"id":"openai/gpt-6-luna","supported_parameters":["reasoning","include_reasoning","reasoning_effort","max_tokens"],
  "reasoning":{"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium","default_enabled":true,"mandatory":false}},
 {"id":"plain/chat","supported_parameters":["temperature","max_tokens"]},
 {"id":"bare"}]}`

func newReasoningLLM(t *testing.T) *reasoningLLM {
	f := &reasoningLLM{catalog: lunaCatalog}
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"choices":[{"finish_reason":"stop","message":{"content":"Fix the login test"}}],"usage":{"prompt_tokens":40,"completion_tokens":9,"total_tokens":49}}`
	}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/models":
			f.models.Add(1)
			if f.noModels {
				http.NotFound(w, r)
				return
			}
			io.WriteString(w, f.catalog)
		case "/chat/completions":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.bodies = append(f.bodies, body)
			f.mu.Unlock()
			status, out := f.answer(body)
			w.WriteHeader(status)
			io.WriteString(w, out)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func (f *reasoningLLM) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bodies[len(f.bodies)-1]
}

// readyLLM is a service whose LLM is this endpoint with the model, saved
// (the test call's own body is forgotten).
func (f *reasoningLLM) service(t *testing.T, model string, extra json.RawMessage) *ai.Service {
	t.Helper()
	s := newSvc(t, nil, ai.Options{})
	fl := ai.Fields{BaseURL: str(f.URL), Key: str(llmKey), Model: str(model), ExtraBody: extra}
	f.mu.Lock()
	save := f.answer
	f.mu.Unlock()
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\": true}"}}]}`
	}
	if _, err := s.Test(context.Background(), ai.RoleLLM, fl); err != nil {
		t.Fatal(err)
	}
	if err := s.Set(ai.RoleLLM, fl); err != nil {
		t.Fatal(err)
	}
	f.answer = save
	f.mu.Lock()
	f.bodies = nil
	f.mu.Unlock()
	return s
}

func complete(s *ai.Service, req ai.Request) (string, error) {
	if req.Messages == nil {
		req.Messages = []ai.Message{{Role: "user", Content: "hi"}}
	}
	return s.LLM().Complete(context.Background(), req)
}

// #174: the effort and the budget reach the request body exactly; "provider
// default" sends nothing; a request's own extra_body reasoning control gives
// way to the setting, and is kept when none is set.
func TestReasoningEffortAndBudgetReachTheRequestBody(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", json.RawMessage(`{"reasoning":{"effort":"high"},"top_k":3}`))

	if _, err := complete(s, ai.Request{MaxTokens: 1024}); err != nil {
		t.Fatal(err)
	}
	b := f.last()
	if _, ok := b["reasoning_effort"]; ok || b["max_tokens"] != float64(1024) {
		t.Fatalf("provider default sends no effort control of ours: %v", b)
	}
	if r, _ := b["reasoning"].(map[string]any); r["effort"] != "high" || b["top_k"] != float64(3) {
		t.Fatalf("the extra_body is the user's when no effort is set: %v", b)
	}

	if _, err := complete(s, ai.Request{MaxTokens: 2048, ReasoningEffort: "none"}); err != nil {
		t.Fatal(err)
	}
	b = f.last()
	if b["reasoning_effort"] != "none" || b["max_tokens"] != float64(2048) || b["top_k"] != float64(3) {
		t.Fatalf("effort and budget: %v", b)
	}
	if _, ok := b["reasoning"]; ok {
		t.Fatalf("one effort control only: %v", b)
	}
}

// #174: a call that opts in (BudgetWins: the digest summaries) sends its own
// budget, in the field the extra_body names (never both): a stale extra_body
// value does not shadow the setting.
func TestBudgetWinsCallerSendsItsBudget(t *testing.T) {
	for _, c := range []struct {
		name, extra string
		budget      int
		field, gone string
	}{
		{"max_completion_tokens 1024", `{"max_completion_tokens":80}`, 1024, "max_completion_tokens", "max_tokens"},
		{"max_completion_tokens 2048", `{"max_completion_tokens":80}`, 2048, "max_completion_tokens", "max_tokens"},
		{"max_tokens", `{"max_tokens":80}`, 1024, "max_tokens", "max_completion_tokens"},
		{"both named", `{"max_tokens":80,"max_completion_tokens":80}`, 1024, "max_completion_tokens", "max_tokens"},
		{"neither", `{"top_k":3}`, 1024, "max_tokens", "max_completion_tokens"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newReasoningLLM(t)
			s := f.service(t, "openai/gpt-6-luna", json.RawMessage(c.extra))
			if _, err := complete(s, ai.Request{MaxTokens: c.budget, BudgetWins: true}); err != nil {
				t.Fatal(err)
			}
			if b := f.last(); b[c.field] != float64(c.budget) || b[c.gone] != nil {
				t.Fatalf("want %s=%d only: %v", c.field, c.budget, b)
			}
		})
	}
}

// #174: every other caller (follow-up 1200, pack up 600, the connection
// test's 64, classification) keeps the extra_body's budget over its own, as
// before: the request's MaxTokens applies only when the extra_body names none.
func TestDefaultCallerDefersToExtraBodyBudget(t *testing.T) {
	for _, c := range []struct {
		name, extra string
		budget      int
		field, gone string
		want        float64
	}{
		{"probe, max_completion_tokens", `{"max_completion_tokens":1024}`, 64, "max_completion_tokens", "max_tokens", 1024},
		{"probe, max_tokens", `{"max_tokens":1024}`, 64, "max_tokens", "max_completion_tokens", 1024},
		{"follow-up", `{"max_completion_tokens":4000}`, 1200, "max_completion_tokens", "max_tokens", 4000},
		{"pack up", `{"max_tokens":3000}`, 600, "max_tokens", "max_completion_tokens", 3000},
		{"both named", `{"max_tokens":80,"max_completion_tokens":90}`, 64, "max_completion_tokens", "max_tokens", 90},
		{"neither", `{"top_k":3}`, 600, "max_tokens", "max_completion_tokens", 600},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newReasoningLLM(t)
			s := f.service(t, "openai/gpt-6-luna", json.RawMessage(c.extra))
			if _, err := complete(s, ai.Request{MaxTokens: c.budget}); err != nil {
				t.Fatal(err)
			}
			if b := f.last(); b[c.field] != c.want || b[c.gone] != nil {
				t.Fatalf("want %s=%v only: %v", c.field, c.want, b)
			}
		})
	}
}

// A request that sets no bound leaves the extra_body's own, opted in or not.
func TestExtraBodyBudgetStandsWithoutRequestBudget(t *testing.T) {
	for _, wins := range []bool{false, true} {
		f := newReasoningLLM(t)
		s := f.service(t, "openai/gpt-6-luna", json.RawMessage(`{"max_completion_tokens":500}`))
		if _, err := complete(s, ai.Request{BudgetWins: wins}); err != nil {
			t.Fatal(err)
		}
		if b := f.last(); b["max_completion_tokens"] != float64(500) || b["max_tokens"] != nil {
			t.Fatalf("BudgetWins %v: %v", wins, b)
		}
	}
}

// #174 regression (review of round 2): a reasoning model whose shared extra_body
// sets a budget big enough for its reasoning must still pass the connection
// test (a 64-token probe) and save, in either field name.
func TestConnectionTestHonoursExtraBodyBudgetForReasoningModels(t *testing.T) {
	for _, field := range []string{"max_tokens", "max_completion_tokens"} {
		t.Run(field, func(t *testing.T) {
			f := newReasoningLLM(t)
			var wire []any
			f.answer = func(body map[string]any) (int, string) {
				wire = append(wire, body[field])
				if b, _ := body[field].(float64); b < 334 { // the reasoning eats the budget
					return 200, `{"choices":[{"finish_reason":"length","message":{"content":""}}],"usage":{"completion_tokens":64,"completion_tokens_details":{"reasoning_tokens":64}}}`
				}
				return 200, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"ok\":true}"}}]}`
			}
			s := newSvc(t, nil, ai.Options{})
			fl := ai.Fields{BaseURL: str(f.URL), Key: str(llmKey), Model: str("reasoning-model"), ExtraBody: json.RawMessage(`{"` + field + `":1024}`)}
			if _, err := s.Test(context.Background(), ai.RoleLLM, fl); err != nil {
				t.Fatalf("the extra_body's budget was overridden by the probe's (wire %v): %v", wire, err)
			}
			if err := s.Set(ai.RoleLLM, fl); err != nil {
				t.Fatal(err)
			}
			for _, w := range wire {
				if w != float64(1024) {
					t.Fatalf("probe wire %v", wire)
				}
			}
		})
	}
}

// #174: a provider that echoes the configured key, or a key-shaped token, in
// its finish reasons gets none of it kept: only a known reason is, else "other".
func TestFinishReasonsNeverRetainProviderText(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"choices":[{"finish_reason":"` + llmKey + `","native_finish_reason":"Bearer sk-abcdefghijklmnopqrstuvwx","message":{"content":"Fix the login test"}}]}`
	}
	var d ai.Diagnostics
	if _, err := complete(s, ai.Request{Report: func(x ai.Diagnostics) { d = x }}); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(d)
	for _, bad := range []string{llmKey, "sk-", "Bearer"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("%q kept in %s", bad, b)
		}
	}
	if d.FinishReason != "other" || d.NativeFinishReason != "other" {
		t.Fatalf("%+v", d)
	}
	for in, want := range map[string]string{"STOP": "stop", "length": "length", "MAX_TOKENS": "max_tokens", "end_turn": "end_turn", "content_filter": "content_filter"} {
		f.answer = func(map[string]any) (int, string) {
			return 200, `{"choices":[{"finish_reason":"` + in + `","native_finish_reason":"` + in + `","message":{"content":"Fix"}}]}`
		}
		if _, err := complete(s, ai.Request{Report: func(x ai.Diagnostics) { d = x }}); err != nil {
			t.Fatal(err)
		}
		if d.FinishReason != want || d.NativeFinishReason != want {
			t.Fatalf("%s: %+v", in, d)
		}
	}
}

// #174: HTTP 200, empty content, finish_reason length and the reasoning
// tokens the whole completion: truncated, not a malformed answer, with the
// call's diagnostics and none of its text.
func TestLengthWithEmptyContentIsTruncated(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"id":"gen-1","choices":[{"finish_reason":"length","native_finish_reason":"max_output_tokens","message":{"role":"assistant","content":"","reasoning":"SECRET REASONING"}}],
			"usage":{"prompt_tokens":120,"completion_tokens":80,"total_tokens":200,"completion_tokens_details":{"reasoning_tokens":80}}}`
	}
	var got []ai.Diagnostics
	_, err := complete(s, ai.Request{MaxTokens: 80, Report: func(d ai.Diagnostics) { got = append(got, d) }})
	if ai.KindOf(err) != ai.KindTruncated {
		t.Fatalf("kind %q: %v", ai.KindOf(err), err)
	}
	if !strings.Contains(err.Error(), "80 of 80 tokens") || !strings.Contains(err.Error(), "80 of them reasoning") || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("message: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("reports: %+v", got)
	}
	d := got[0]
	if d.Status != 200 || d.FinishReason != "length" || d.NativeFinishReason != "max_output_tokens" || d.Content != ai.ContentEmpty || d.ContentChars != 0 ||
		d.PromptTokens == nil || *d.PromptTokens != 120 || d.CompletionTokens == nil || *d.CompletionTokens != 80 ||
		d.TotalTokens == nil || *d.TotalTokens != 200 || d.ReasoningTokens == nil || *d.ReasoningTokens != 80 {
		t.Fatalf("diagnostics %+v", d)
	}
	if b, _ := json.Marshal(d); strings.Contains(string(b), "SECRET") {
		t.Fatalf("reasoning text in the diagnostics: %s", b)
	}
}

// A cut-off answer with some text is returned as text unless the request
// says no partial answers; one that was not cut off is returned either way.
func TestPartialAnswerOnlyWhenAllowed(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"choices":[{"finish_reason":"length","message":{"content":"Fix the lo"}}],"usage":{"completion_tokens":80}}`
	}
	if text, err := complete(s, ai.Request{MaxTokens: 80}); err != nil || text != "Fix the lo" {
		t.Fatalf("other callers keep their behaviour: %q %v", text, err)
	}
	var d ai.Diagnostics
	_, err := complete(s, ai.Request{MaxTokens: 80, NoPartial: true, Report: func(x ai.Diagnostics) { d = x }})
	if ai.KindOf(err) != ai.KindTruncated || d.Content != ai.ContentNonempty || d.ContentChars != 10 {
		t.Fatalf("%v %+v", err, d)
	}
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"choices":[{"finish_reason":"stop","message":{"content":"Fix the login test"}}]}`
	}
	if text, err := complete(s, ai.Request{NoPartial: true}); err != nil || text != "Fix the login test" {
		t.Fatalf("%q %v", text, err)
	}
}

// Empty, absent and non-string content that was not cut off is empty_answer;
// no choices stays bad_response.
func TestEmptyAnswerIsNotABadResponse(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	for _, body := range []string{
		`{"choices":[{"finish_reason":"stop","message":{"content":""}}]}`,
		`{"choices":[{"finish_reason":"content_filter","message":{"content":null}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{}}]}`,
		`{"choices":[{"finish_reason":"stop","message":{"content":"  \n"}}]}`,
	} {
		f.answer = func(map[string]any) (int, string) { return 200, body }
		if _, err := complete(s, ai.Request{}); ai.KindOf(err) != ai.KindEmpty {
			t.Errorf("%s: %q %v", body, ai.KindOf(err), err)
		}
	}
	f.answer = func(map[string]any) (int, string) { return 200, `{"choices":[]}` }
	if _, err := complete(s, ai.Request{}); ai.KindOf(err) != ai.KindBadResponse {
		t.Errorf("no choices: %v", err)
	}
	f.answer = func(map[string]any) (int, string) { return 200, `not json` }
	if _, err := complete(s, ai.Request{}); ai.KindOf(err) != ai.KindBadResponse {
		t.Errorf("not json: %v", err)
	}
}

// A provider that refuses the effort (HTTP 400) is a clear bad_config, never
// a silent failure; without an effort a 400 stays the provider's.
func TestARejectedEffortFailsClearly(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	f.answer = func(map[string]any) (int, string) {
		return 400, `{"error":{"code":400,"message":"reasoning_effort minimal is not supported for this model"}}`
	}
	_, err := complete(s, ai.Request{ReasoningEffort: "minimal"})
	if ai.KindOf(err) != ai.KindBadConfig || !strings.Contains(err.Error(), `"minimal"`) || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("%q %v", ai.KindOf(err), err)
	}
	if _, err := complete(s, ai.Request{}); ai.KindOf(err) != ai.KindFailed {
		t.Fatalf("%q %v", ai.KindOf(err), err)
	}
}

// The catalog's reasoning metadata comes with the model list, and the LLM in
// use's is read once, kept, and read again for another model.
func TestModelReasoningFromTheCatalog(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	res, err := s.Models(context.Background(), ai.RoleLLM, ai.Fields{})
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]ai.ModelInfo{}
	for _, m := range res.Models {
		byID[m.ID] = m
	}
	if r := byID["openai/gpt-6-luna"].Reasoning; r == nil || r.Support != ai.SupportYes || !r.Listed || r.Default != "medium" || r.Efforts[0] != "none" || r.Efforts[len(r.Efforts)-1] != "max" {
		t.Fatalf("luna: %+v", r)
	}
	if r := byID["plain/chat"].Reasoning; r == nil || r.Support != ai.SupportNo || len(r.Efforts) != 0 {
		t.Fatalf("plain: %+v", r)
	}
	if byID["bare"].Reasoning != nil {
		t.Fatalf("bare: %+v", byID["bare"].Reasoning)
	}

	if r := s.KnownReasoning(); r.Support != ai.SupportUnknown {
		t.Fatalf("nothing is called to answer KnownReasoning: %+v", r)
	}
	before := f.models.Load()
	r := s.ModelReasoning(context.Background())
	if r.Support != ai.SupportYes || r.Model != "openai/gpt-6-luna" || r.Allows("minimal") || !r.Allows("none") {
		t.Fatalf("%+v", r)
	}
	s.ModelReasoning(context.Background())
	if n := f.models.Load() - before; n != 1 {
		t.Fatalf("one catalog read, then the cache: %d", n)
	}
	if k := s.KnownReasoning(); k.Support != ai.SupportYes {
		t.Fatalf("%+v", k)
	}
	select {
	case <-s.Changes():
	default:
		t.Fatal("a learned catalog entry is a change: the settings are published again")
	}
}

func TestModelReasoningWhenTheCatalogSaysNothing(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "bare", nil)
	if r := s.ModelReasoning(context.Background()); r.Support != ai.SupportUnknown || len(r.Efforts) != 3 || r.Efforts[0] != "low" {
		t.Fatalf("an id-only entry: the generic set, unknown: %+v", r)
	}
	g := newReasoningLLM(t)
	g.noModels = true
	s2 := g.service(t, "m", nil)
	if r := s2.ModelReasoning(context.Background()); r.Support != ai.SupportUnknown || r.Listed {
		t.Fatalf("no /models: unknown, nothing is claimed: %+v", r)
	}
}
