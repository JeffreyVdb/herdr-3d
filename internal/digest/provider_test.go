package digest_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
)

// #174: the feature against an OpenAI-compatible endpoint that spends the
// completion budget on reasoning the way the ticket's model does: a
// reasoning effort other than "none" uses reasoningTokens of it first, and a
// budget that runs out answers HTTP 200 with no text and finish_reason
// "length". The real ai service sits in between (the catalog, the request
// body, the diagnostics).
type reasoningProvider struct {
	*httptest.Server
	mu     sync.Mutex
	bodies []map[string]any
}

const reasoningTokens = 300 // what the model thinks for a line, when it thinks

func newReasoningProvider(t *testing.T) *reasoningProvider {
	p := &reasoningProvider{}
	p.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/models":
			io.WriteString(w, `{"data":[{"id":"openai/gpt-6-luna","supported_parameters":["reasoning","reasoning_effort","max_tokens"],
				"reasoning":{"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium","mandatory":false}}]}`)
		case "/chat/completions":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			p.mu.Lock()
			p.bodies = append(p.bodies, body)
			p.mu.Unlock()
			budget, _ := body["max_tokens"].(float64)
			think := reasoningTokens
			if body["reasoning_effort"] == "none" || body["response_format"] != nil { // the connection test is trivial: no thinking
				think = 0
			}
			const visible = 34
			text := "Fix the flaky login test"
			if body["response_format"] != nil {
				text = `{"ok": true}`
			}
			resp := map[string]any{}
			switch {
			case int(budget) > 0 && int(budget) < think+visible:
				used := int(budget)
				resp = map[string]any{"choices": []any{map[string]any{"finish_reason": "length", "message": map[string]any{"content": ""}}},
					"usage": map[string]any{"prompt_tokens": 600, "completion_tokens": used, "total_tokens": 600 + used,
						"completion_tokens_details": map[string]any{"reasoning_tokens": min(used, think)}}}
			default:
				resp = map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": text}}},
					"usage": map[string]any{"prompt_tokens": 600, "completion_tokens": think + visible, "total_tokens": 600 + think + visible,
						"completion_tokens_details": map[string]any{"reasoning_tokens": think}}}
			}
			json.NewEncoder(w).Encode(resp)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(p.Close)
	return p
}

func (p *reasoningProvider) last() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.bodies[len(p.bodies)-1]
}

func (p *reasoningProvider) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.bodies)
}

// providerService is the feature over the real ai service, whose LLM is the
// provider (its connection test, which asks for JSON, is answered plainly).
func providerService(t *testing.T) (*digest.Service, *reasoningProvider) {
	t.Helper()
	p := newReasoningProvider(t)
	svc, err := ai.New(ai.Options{File: filepath.Join(t.TempDir(), "ai.json")})
	if err != nil {
		t.Fatal(err)
	}
	f := ai.Fields{BaseURL: str(p.URL), Model: str("openai/gpt-6-luna"), Key: str("sk-not-a-real-key-0123456789")}
	if _, err := svc.Test(context.Background(), ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	if err := svc.Set(ai.RoleLLM, f); err != nil {
		t.Fatal(err)
	}
	s, err := digest.New(context.Background(), digest.Options{Roles: svc, Now: func() time.Time { return noon }})
	if err != nil {
		t.Fatal(err)
	}
	if res, err := s.Test(context.Background()); err != nil || !res.OK {
		t.Fatalf("test = %+v, %v", res, err)
	}
	on := true
	if err := s.Set(context.Background(), &on, nil); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.bodies = nil
	p.mu.Unlock()
	return s, p
}

var (
	taskIn = digest.Input{Kind: digest.KindTask, Prompt: "Please investigate. The transcript view no longer shows diffs. Please create a ticket."}
	nowIn  = digest.Input{Kind: digest.KindNow, Context: "Task: Fix the flaky login test", Steps: digest.SampleSteps}
)

// The old budget of 80 tokens is eaten by the thinking: a 200 with no text,
// reported as truncated with how the budget went. The new default of 1024
// writes both lines (task and now) with the model's own reasoning on.
func TestDefaultBudgetSurvivesAReasoningModel(t *testing.T) {
	s, p := providerService(t)
	ctx := context.Background()

	if err := s.Apply(ctx, digest.Update{MaxTokens: num(80)}); err != nil {
		t.Fatal(err)
	}
	for _, in := range []digest.Input{taskIn, nowIn} {
		res, err := s.Summarize(ctx, in)
		if ai.KindOf(err) != ai.KindTruncated || res.Line != "" {
			t.Fatalf("%s at 80 tokens: %q %v", in.Kind, res.Line, err)
		}
		d := res.Diag
		if d == nil || d.Status != 200 || d.FinishReason != "length" || d.Content != ai.ContentEmpty || *d.CompletionTokens != 80 || *d.ReasoningTokens != 80 {
			t.Fatalf("diagnostics %+v", d)
		}
	}
	if b := p.last(); b["max_tokens"] != float64(80) {
		t.Fatalf("body %v", b)
	}

	// Back to the default: 1024 leaves room for the thinking and the line.
	if err := s.Apply(ctx, digest.Update{MaxTokens: num(digest.DefaultMaxTokens)}); err != nil {
		t.Fatal(err)
	}
	for _, in := range []digest.Input{taskIn, nowIn} {
		res, err := s.Summarize(ctx, in)
		if err != nil || res.Line == "" {
			t.Fatalf("%s at the default: %q %v", in.Kind, res.Line, err)
		}
		d := res.Diag
		if d.FinishReason != "stop" || d.Content != ai.ContentNonempty || *d.ReasoningTokens != reasoningTokens || *d.CompletionTokens >= digest.DefaultMaxTokens {
			t.Fatalf("diagnostics %+v", d)
		}
	}
	if b := p.last(); b["max_tokens"] != float64(1024) || b["reasoning_effort"] != nil || b["reasoning"] != nil {
		t.Fatalf("the provider's default effort sends none: %v", b)
	}
}

// With the effort at "none" even a small budget is enough, and the effort is
// the one control in the body; an effort the catalog does not list is refused
// before any call; one that went stale is not sent.
func TestEffortNoneAtASmallBudgetAndUnlistedEffortsRefused(t *testing.T) {
	s, p := providerService(t)
	ctx := context.Background()
	if err := s.Apply(ctx, digest.Update{ReasoningEffort: str("none"), MaxTokens: num(80)}); err != nil {
		t.Fatal(err)
	}
	if res, err := s.Summarize(ctx, taskIn); err != nil || res.Line == "" || res.Diag == nil || *res.Diag.ReasoningTokens != 0 {
		t.Fatalf("%+v %v", res, err)
	}
	if b := p.last(); b["reasoning_effort"] != "none" || b["max_tokens"] != float64(80) || b["reasoning"] != nil {
		t.Fatalf("body %v", b)
	}
	before := p.count()
	if err := s.Apply(ctx, digest.Update{ReasoningEffort: str("minimal")}); err == nil {
		t.Fatal("Luna's catalog does not list minimal")
	}
	if v := s.View(); v.ReasoningEffort != "none" || v.Reasoning.Support != ai.SupportYes || v.Reasoning.Default != "medium" || v.EffortStale {
		t.Fatalf("view %+v", v)
	}
	if p.count() != before {
		t.Fatal("a refused setting made a call")
	}
}
