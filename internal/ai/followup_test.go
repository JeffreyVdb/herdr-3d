package ai_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
)

// Exercise catalog parsing, extraction and the actual outbound HTTP body.
// A provider rejecting unadvertised efforts must still yield real questions.
func TestFollowupCatalogEfforts(t *testing.T) {
	for _, tc := range []struct {
		name, model, metadata, effort, retry string
	}{
		{"mandatory omitted", "deepseek/deepseek-r1", `"reasoning":{"mandatory":true},"supported_parameters":["reasoning","max_tokens"]`, "", ""},
		{"mandatory omitted without parameters", "deepseek/deepseek-r1", `"reasoning":{"mandatory":true}`, "", ""},
		{"optional omitted", "optional", `"reasoning":{"mandatory":false}`, "", ""},
		{"explicit excludes low", "deepseek/deepseek-v4-flash", `"reasoning":{"supported_efforts":["xhigh","high","none"]}`, "", "none"},
		{"null", "all", `"reasoning":{"supported_efforts":null}`, "low", "none"},
		{"mandatory null", "mandatory-all", `"reasoning":{"mandatory":true,"supported_efforts":null}`, "low", "minimal"},
		{"unknown", "bare", `"object":"model"`, "", ""},
		{"luna", "openai/gpt-6-luna", `"reasoning":{"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium"}`, "low", "none"},
		{"deepseek flash", "deepseek/deepseek-v4.1-flash-1017", `"reasoning":{"supported_efforts":["max","high","low","none"],"default_effort":"high"}`, "low", "none"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, truncated := range []bool{false, true} {
				t.Run(map[bool]string{false: "success", true: "truncated"}[truncated], func(t *testing.T) {
					f := newReasoningLLM(t)
					f.catalog = `{"data":[{"id":"` + tc.model + `",` + tc.metadata + `}]}`
					extra := json.RawMessage(`{"reasoning":{"enabled":true,"exclude":true},"top_k":3}`)
					s := f.service(t, tc.model, extra)
					r := s.ModelReasoning(context.Background())
					calls := 0
					f.answer = func(body map[string]any) (int, string) {
						want := tc.effort
						if calls > 0 {
							want = tc.retry
						}
						calls++
						effort, sent := body["reasoning_effort"]
						if sent != (want != "") || (sent && effort != want) {
							t.Errorf("call %d: reasoning_effort=%v (sent %v), want %q", calls, effort, sent, want)
							return 400, `{"error":{"message":"unsupported effort"}}`
						}
						if want == "" {
							if reasoning, _ := body["reasoning"].(map[string]any); reasoning["enabled"] != true || reasoning["exclude"] != true {
								t.Errorf("model-specific reasoning lost: %v", body)
							}
						}
						if truncated && calls == 1 {
							return 200, `{"choices":[{"message":{"content":""},"finish_reason":"length"}]}`
						}
						return 200, `{"choices":[{"message":{"content":"{\"questions\":[{\"question\":\"Should I proceed?\",\"kind\":\"yes_no\"}]}"},"finish_reason":"stop"}]}`
					}
					qs, _, tried, err := followup.ExtractLLM(context.Background(), s.LLM(), "Should I proceed?", r)
					wantTried := []string{tc.effort}
					if truncated && tc.retry != "" {
						wantTried = append(wantTried, tc.retry)
					}
					if !reflect.DeepEqual(tried, wantTried) || calls != len(wantTried) {
						t.Errorf("tried=%q calls=%d, want %q", tried, calls, wantTried)
					}
					if truncated && tc.retry == "" {
						if ai.KindOf(err) != ai.KindTruncated {
							t.Fatalf("want truncated without effort retry: %v", err)
						}
					} else if err != nil || len(qs) != 1 || qs[0].Question != "Should I proceed?" {
						t.Fatalf("questions=%+v error=%v", qs, err)
					}
				})
			}
		})
	}
}

// Summary settings consume the same parsed capabilities as follow-up
// extraction: no unsupported effort choices, and provider configuration kept.
func TestSummaryCatalogWithoutEffortSelection(t *testing.T) {
	f := newReasoningLLM(t)
	f.catalog = `{"data":[{"id":"deepseek/deepseek-r1","reasoning":{"mandatory":true},"supported_parameters":["reasoning","max_tokens"]}]}`
	s := f.service(t, "deepseek/deepseek-r1", json.RawMessage(`{"reasoning":{"exclude":true}}`))
	d, err := digest.New(context.Background(), digest.Options{Roles: s})
	if err != nil {
		t.Fatal(err)
	}
	for _, effort := range []string{"low", "none", "minimal"} {
		if err := d.Apply(context.Background(), digest.Update{ReasoningEffort: &effort}); err == nil {
			t.Errorf("accepted effort %q without a selector", effort)
		}
	}
	if r := d.View().Reasoning; r.Support != ai.SupportYes || !r.Listed || len(r.Efforts) != 0 {
		t.Fatalf("settings must offer no efforts: %+v", r)
	}
	if res, err := d.Test(context.Background()); err != nil || !res.OK {
		t.Fatalf("provider-default summaries: %+v %v", res, err)
	}
	b := f.last()
	if _, sent := b["reasoning_effort"]; sent {
		t.Fatalf("summary sent an unsupported effort: %v", b)
	}
	if reasoning, _ := b["reasoning"].(map[string]any); reasoning["exclude"] != true {
		t.Fatalf("summary lost model-specific reasoning: %v", b)
	}
}
