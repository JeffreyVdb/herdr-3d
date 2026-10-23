package ai_test

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/packup"
)

func TestPackupRejectsPartialJSON(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	f.answer = func(map[string]any) (int, string) {
		return 200, `{"choices":[{"finish_reason":"length","message":{"content":"{\"remove\":[\" and end"}}]}`
	}
	res, err := packup.Run(context.Background(), &ai.FakeClassifier{Score: .82}, s.LLM(), "Please make a PR and end your turn", .75)
	if err != nil {
		t.Fatal(err)
	}
	if res.ExtractCode != "llm_truncated" {
		t.Fatalf("want llm_truncated, got %+v", res)
	}
}

// Exercise the real adapter with packup's request, not a fabricated ai.Request.
func TestPackupHTTPPolicyAndFailures(t *testing.T) {
	for _, tc := range []struct{ name, body, code string }{
		{"valid", `{"choices":[{"finish_reason":"stop","message":{"content":"{\"remove\":[\" and end your turn\"]}"}}],"usage":{"completion_tokens":70,"completion_tokens_details":{"reasoning_tokens":40}}}`, ""},
		{"empty exhausted", `{"choices":[{"finish_reason":"length","message":{"content":"","reasoning":"SECRET"}}],"usage":{"completion_tokens":600,"completion_tokens_details":{"reasoning_tokens":600}}}`, "llm_truncated"},
		{"empty", `{"choices":[{"finish_reason":"stop","message":{"content":""}}]}`, "llm_empty_answer"},
		{"schema", `{"choices":[{"finish_reason":"stop","message":{"content":"{\"remove\":42}"}}]}`, "bad_answer"},
		{"span", `{"choices":[{"finish_reason":"stop","message":{"content":"{\"remove\":[\"SECRET\"]}"}}]}`, "bad_part"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newReasoningLLM(t)
			s := f.service(t, "openai/gpt-6-luna", json.RawMessage(`{"reasoning":{"effort":"high"},"max_completion_tokens":80}`))
			f.answer = func(map[string]any) (int, string) { return 200, tc.body }
			got, err := packup.RunWith(context.Background(), &ai.FakeClassifier{Score: .99}, s.LLM(), "Please make a PR and end your turn", .85, packup.Params{ReasoningEffort: "none", MaxTokens: 2048})
			if err != nil || got.ExtractCode != tc.code {
				t.Fatalf("code %s err %v", got.ExtractCode, err)
			}
			if b := f.last(); b["reasoning_effort"] != "none" || b["max_completion_tokens"] != float64(2048) || b["max_tokens"] != nil || b["reasoning"] != nil {
				t.Fatalf("outbound policy: %v", b)
			}
			if got.Diag == nil || got.Diag.MaxTokens != 2048 || got.Diag.ReasoningEffort != "none" {
				t.Fatalf("missing effective request diagnostics: %+v", got.Diag)
			}
			safe, _ := json.Marshal(got.Diag)
			if strings.Contains(string(safe)+got.ExtractErr, "SECRET") {
				t.Fatal("provider text escaped")
			}
			if tc.code == "" && (!got.Matched || got.Task != "Please make a PR") {
				t.Fatalf("valid task: %+v", got)
			}
			if tc.code != "" && (got.Matched || got.Task != "" || len(got.Removed) > 0) {
				t.Fatal("failed check produced a cut")
			}
		})
	}
}

type packupHTTPRoles struct{ *ai.Service }

func (r packupHTTPRoles) State(role ai.Role) ai.State {
	if role == ai.RoleClassifier {
		return ai.StateReady
	}
	return r.Service.State(role)
}
func (r packupHTTPRoles) Classifier() ai.Classifier {
	return &ai.FakeClassifier{Func: func(_ context.Context, state map[string]any, _ string) (float64, error) {
		for _, sample := range packup.Samples {
			if sample.Text == state["prompt"] && !sample.Match {
				return .01, nil
			}
		}
		return .99, nil
	}}
}

func TestPackupRejectsUnsupportedEffortAndKeepsProviderDefault(t *testing.T) {
	for _, model := range []string{"plain/chat", "selectorless", "openai/gpt-6-luna", "bare"} {
		t.Run(model, func(t *testing.T) {
			f := newReasoningLLM(t)
			f.catalog = strings.TrimSuffix(lunaCatalog, "]}") + `,{"id":"selectorless","reasoning":{"default_effort":"medium"}}]}`
			s := f.service(t, model, json.RawMessage(`{"reasoning":{"effort":"high"}}`))
			p, err := packup.New(context.Background(), packup.Options{Roles: packupHTTPRoles{s}})
			if err != nil {
				t.Fatal(err)
			}
			high := "high"
			err = p.Apply(context.Background(), packup.Update{ReasoningEffort: &high})
			if (err != nil) != (model == "plain/chat" || model == "selectorless") {
				t.Fatalf("effort validation: %v", err)
			}
			def := ""
			if err := p.Apply(context.Background(), packup.Update{ReasoningEffort: &def}); err != nil {
				t.Fatal(err)
			}
			f.answer = func(map[string]any) (int, string) {
				return 200, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"remove\":[\" and end your turn\"]}"}}]}`
			}
			_, err = packup.Run(context.Background(), &ai.FakeClassifier{Score: 1}, s.LLM(), "Please make a PR and end your turn", .85)
			if err != nil {
				t.Fatal(err)
			}
			b := f.last()
			if b["reasoning_effort"] != nil || b["reasoning"].(map[string]any)["effort"] != "high" {
				t.Fatalf("default must keep endpoint configuration: %v", b)
			}
		})
	}
}

func TestPackupJSONModeCompatibilityFallback(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	f.answer = func(b map[string]any) (int, string) {
		if b["response_format"] != nil {
			return 400, `{"error":{"message":"response_format unsupported"}}`
		}
		return 200, `{"choices":[{"finish_reason":"stop","message":{"content":"{\"remove\":[\" and end your turn\"]}"}}]}`
	}
	got, err := packup.Run(context.Background(), &ai.FakeClassifier{Score: 1}, s.LLM(), "Please make a PR and end your turn", .85)
	if err != nil || !got.Matched || got.Diag.Status != 200 {
		t.Fatalf("fallback: %+v %v", got, err)
	}
}

func TestPackupDeadlineIncludesSharedCallContention(t *testing.T) {
	f := newReasoningLLM(t)
	s := f.service(t, "openai/gpt-6-luna", nil)
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	f.answer = func(map[string]any) (int, string) {
		entered <- struct{}{}
		<-release
		return 200, `{"choices":[{"message":{"content":"ok"}}]}`
	}
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = s.LLM().Complete(context.Background(), ai.Request{}) }()
	}
	defer func() { close(release); wg.Wait() }()
	for range 2 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("calls never occupied both slots")
		}
	}
	on := true
	p, err := packup.New(context.Background(), packup.Options{Roles: packupHTTPRoles{s}, EnvEnabled: &on, Timeout: 10 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	result, err := p.Test(context.Background(), nil)
	if err != nil || result.OK || p.View().Tested {
		t.Fatalf("contended test: %+v %v", result, err)
	}
	if result.Samples[0].Stage != "timing" {
		t.Fatalf("stage %+v", result.Samples[0])
	}
	got, err := p.Detect(context.Background(), "Please make a PR and end your turn")
	if err == nil || got != nil {
		t.Fatalf("contended detection: %+v %v", got, err)
	}
}

func TestPackupTestAndDetectUseSavedHTTPPolicy(t *testing.T) {
	f := newReasoningLLM(t)
	aiService := f.service(t, "openai/gpt-6-luna", json.RawMessage(`{"max_tokens":80,"reasoning":{"effort":"none"}}`))
	f.answer = func(b map[string]any) (int, string) {
		messages := b["messages"].([]any)
		prompt := strings.TrimPrefix(messages[1].(map[string]any)["content"].(string), "The prompt:\n\n")
		for _, sample := range packup.Samples {
			if sample.Text == prompt && sample.Task != "" {
				content, _ := json.Marshal(map[string][]string{"remove": {strings.TrimPrefix(prompt, sample.Task)}})
				answer, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": string(content)}}}})
				return 200, string(answer)
			}
		}
		return 200, `{"choices":[{"message":{"content":"{}"}}]}`
	}
	p, err := packup.New(context.Background(), packup.Options{Roles: packupHTTPRoles{aiService}})
	if err != nil {
		t.Fatal(err)
	}
	effort, budget := "high", 2048
	if err := p.Apply(context.Background(), packup.Update{ReasoningEffort: &effort, MaxTokens: &budget}); err != nil {
		t.Fatal(err)
	}
	result, err := p.Test(context.Background(), nil)
	if err != nil || !result.OK || result.Verified != 6 {
		t.Fatalf("test: %+v %v", result, err)
	}
	on := true
	if err := p.Set(context.Background(), &on, nil); err != nil {
		t.Fatal(err)
	}
	got, err := p.Detect(context.Background(), packup.Samples[0].Text)
	if err != nil || !got.Matched {
		t.Fatalf("detect: %+v %v", got, err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.bodies) != 7 {
		t.Fatalf("expected six test extractions plus Detect, got %d", len(f.bodies))
	}
	for _, b := range f.bodies {
		if b["reasoning_effort"] != "high" || b["max_tokens"] != float64(2048) || b["reasoning"] != nil {
			t.Fatalf("policy mismatch: %v", b)
		}
	}
}
