package hireintent_test

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
)

// The research's 50 labelled cases (docs/research/dictation-hiring-bench),
// each with the answer the live LLM gave (results-refined.json,
// results-holdout.json), replayed through the real parse and validation
// against the live catalog recorded with them.

type benchCase struct {
	ID       string             `json:"id"`
	Set      string             `json:"set"`
	Text     string             `json:"text"`
	History  []string           `json:"history"`
	Intent   string             `json:"intent"`
	Decision string             `json:"decision"`
	Task     string             `json:"task"`
	Answer   *hireintent.Answer `json:"answer"`
}

type bench struct {
	Catalog hireintent.Catalog `json:"catalog"`
	Cases   []benchCase        `json:"cases"`
}

func loadBench(t *testing.T) bench {
	t.Helper()
	b, err := os.ReadFile("testdata/bench.json")
	if err != nil {
		t.Fatal(err)
	}
	var out bench
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Cases) != 50 {
		t.Fatalf("%d cases, want 50", len(out.Cases))
	}
	return out
}

// label is the bench's decision for a result (main.go's decide order:
// selection, then task, then effort). Test code only: the product result
// carries fields and questions, never these labels.
func label(r hireintent.Result) string {
	switch {
	case r.Error != nil:
		return "error"
	case r.Intent != hireintent.IntentHire:
		return r.Intent
	case r.Hire.ReadyForReview:
		return "ready"
	}
	in := r.Hire
	asks := map[string]bool{}
	for _, q := range in.Questions {
		asks[q.Field] = true
	}
	switch {
	case asks[hireintent.AskModel] || asks[hireintent.AskSelection] || in.Effort.Provenance == hireintent.Invalid:
		return "clarify_selection"
	case asks[hireintent.AskTask]:
		return "clarify_task"
	case asks[hireintent.AskEffort]:
		return "clarify_effort"
	}
	return "?"
}

// answerLLM answers every call with a, and records the calls.
func answerLLM(a any) *ai.FakeLLM {
	b, _ := json.Marshal(a)
	return &ai.FakeLLM{Text: string(b)}
}

// historyAnswers are the answers for the sentence a follow-up case replies
// to (hand-written: the research sent the history in one call; here the
// pending proposal comes from interpreting it first).
var historyAnswers = map[string]map[string]any{
	"Hire a Claude Code agent on Claude Haiku 5.5 to fix the login bug.": {"intent": "hire", "harness": "claude",
		"model": "claude-haiku-5-5", "effort": nil, "task": "fix the login bug.", "multiple": false, "selection_unclear": false},
	"Hire a Codex worker on GPT-6.1-Sol at low effort to audit retries.": {"intent": "hire", "harness": "codex",
		"model": "gpt-6.1-sol", "effort": "low", "task": "audit retries.", "multiple": false, "selection_unclear": false},
	"Hire a worker using Codex on GPT-6.1-Sol. Task: investigate queue deadlocks.": {"intent": "hire", "harness": "codex",
		"model": "gpt-6.1-sol", "effort": nil, "task": "investigate queue deadlocks.", "multiple": false, "selection_unclear": false},
}

// fields is a proposal's provenance in short: "h=dictated:claude
// m=resolved:claude-haiku-5-5 e=missing t=dictated".
func fields(in *hireintent.Interpretation) string {
	f := func(name string, x hireintent.Field) string {
		s := name + "=" + x.Provenance
		if x.Value != "" {
			s += ":" + x.Value
		}
		if x.Provenance == hireintent.Invalid {
			s += ":" + x.Said
		}
		return s
	}
	return strings.Join([]string{f("h", in.Harness), f("m", in.Model), f("e", in.Effort), "t=" + in.Task.Provenance}, " ")
}

// wantFields are the provenances of every hire case.
var wantFields = map[string]string{
	"hire-claude":              "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:high t=dictated",
	"hire-codex":               "h=dictated:codex m=dictated:gpt-6.1-sol e=dictated:medium t=dictated",
	"polite-hire":              "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:low t=dictated",
	"delegate":                 "h=dictated:codex m=dictated:gpt-6.1-sol e=dictated:high t=dictated",
	"speech-correction":        "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:high t=dictated",
	"missing-effort":           "h=dictated:claude m=resolved:claude-haiku-5-5 e=missing t=dictated",
	"effort-in-task":           "h=dictated:claude m=resolved:claude-haiku-5-5 e=missing t=dictated",
	"followup-effort":          "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:high t=dictated",
	"followup-change":          "h=dictated:codex m=dictated:gpt-6.1-sol e=dictated:high t=dictated",
	"missing-task":             "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:high t=missing",
	"missing-selection":        "h=missing m=missing e=dictated:high t=dictated",
	"conflicting-example":      "h=dictated:claude m=invalid:GPT-5.5 Haiku e=dictated:high t=dictated",
	"unknown-model":            "h=dictated:claude m=missing e=dictated:high t=dictated",
	"invalid-effort":           "h=dictated:claude m=resolved:claude-haiku-5-5 e=invalid:banana t=dictated",
	"task-nested-command":      "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:high t=dictated",
	"long-task":                "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:medium t=dictated",
	"task-quoted-injection":    "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:high t=dictated",
	"spawn-agent-phrase":       "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:max t=dictated",
	"hire-agent-phrase":        "h=dictated:codex m=dictated:gpt-6.1-sol e=dictated:high t=dictated",
	"research-agent-phrase":    "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:medium t=dictated",
	"hire-worker-phrase":       "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:low t=dictated",
	"spawn-worker-phrase":      "h=dictated:codex m=dictated:gpt-6.1-sol e=dictated:ultra t=dictated",
	"bare-spawn-agent":         "h=missing m=missing e=missing t=missing",
	"research-missing-effort":  "h=dictated:claude m=resolved:claude-haiku-5-5 e=missing t=dictated",
	"ultra-followup":           "h=dictated:codex m=dictated:gpt-6.1-sol e=dictated:ultra t=dictated",
	"task-effort-word":         "h=dictated:claude m=resolved:claude-haiku-5-5 e=missing t=dictated",
	"unsupported-claude-ultra": "h=dictated:claude m=resolved:claude-haiku-5-5 e=invalid:ultra t=dictated",
	"natural-task-wrapper":     "h=dictated:claude m=resolved:claude-haiku-5-5 e=dictated:medium t=dictated",
	"extra-high":               "h=dictated:claude m=resolved:claude-haiku-5-5 e=resolved:xhigh t=dictated",
}

func TestBenchReplay(t *testing.T) {
	b := loadBench(t)
	for _, c := range b.Cases {
		t.Run(c.ID, func(t *testing.T) {
			ctx := context.Background()
			var pending *hireintent.Interpretation
			for _, h := range c.History {
				a, ok := historyAnswers[h]
				if !ok {
					t.Fatalf("no history answer for %q", h)
				}
				r := hireintent.Interpret(ctx, answerLLM(a), hireintent.Request{Text: h, Pending: pending, Catalog: b.Catalog})
				if r.Hire == nil {
					t.Fatalf("history %q: %+v", h, r)
				}
				pending = r.Hire
			}
			llm := answerLLM(c.Answer)
			r := hireintent.Interpret(ctx, llm, hireintent.Request{Text: c.Text, Pending: pending, Catalog: b.Catalog})
			if got := label(r); got != c.Decision {
				t.Fatalf("decision %s, want %s: %+v", got, c.Decision, r)
			}
			if r.Text != c.Text {
				t.Fatalf("text %q", r.Text)
			}
			checkRequest(t, llm, c, b.Catalog)
			if c.Decision == "unsupported" || c.Decision == "unclear" {
				if r.Hire != nil || r.Intent != c.Decision {
					t.Fatalf("a non-hire carries a proposal: %+v", r)
				}
				return
			}
			in := r.Hire
			if got := fields(in); got != wantFields[c.ID] {
				t.Fatalf("fields\n%s\nwant\n%s", got, wantFields[c.ID])
			}
			wantSources := append(slices.Clone(c.History), c.Text)
			if !slices.Equal(in.Sources, wantSources) {
				t.Fatalf("sources %q", in.Sources)
			}
			if c.Task == "" {
				if in.Task.Provenance != hireintent.Missing || in.Task.Span != nil {
					t.Fatalf("task %+v, want missing", in.Task)
				}
				return
			}
			if in.Task.Value != c.Task {
				t.Fatalf("task %q, want %q", in.Task.Value, c.Task)
			}
			if got := spanText(t, in.Sources, in.Task.Span); got != c.Task {
				t.Fatalf("span %+v is %q", in.Task.Span, got)
			}
		})
	}
}

// checkRequest checks the one call is the research's: the prompt, the
// payload's keys, JSON mode, the budget, no partial answers, no reasoning
// effort or temperature of its own.
func checkRequest(t *testing.T, llm *ai.FakeLLM, c benchCase, cat hireintent.Catalog) {
	t.Helper()
	calls := llm.Calls()
	if strings.TrimSpace(c.Text) == "" {
		if len(calls) != 0 {
			t.Fatalf("%d calls for nothing said", len(calls))
		}
		return
	}
	if len(calls) != 1 {
		t.Fatalf("%d calls", len(calls))
	}
	req := calls[0]
	if !req.JSON || req.MaxTokens != hireintent.MaxTokens || !req.NoPartial || req.ReasoningEffort != "" || req.Temperature != nil || req.BudgetWins {
		t.Fatalf("request %+v", req)
	}
	if len(req.Messages) != 2 || req.Messages[0].Role != "system" || req.Messages[0].Content != hireintent.Prompt || req.Messages[1].Role != "user" {
		t.Fatalf("messages %+v", req.Messages)
	}
	var payload struct {
		Command     string             `json:"command"`
		PendingHire []string           `json:"pending_hire"`
		HireOptions hireintent.Catalog `json:"hire_options"`
	}
	d := json.NewDecoder(strings.NewReader(req.Messages[1].Content))
	d.DisallowUnknownFields()
	if err := d.Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload.Command != c.Text || !slices.Equal(payload.PendingHire, c.History) || !reflect.DeepEqual(payload.HireOptions, cat) {
		t.Fatalf("payload %s", req.Messages[1].Content)
	}
}

// spanText is the text of sp in sources (UTF-16 offsets).
func spanText(t *testing.T, sources []string, sp *hireintent.Span) string {
	t.Helper()
	if sp == nil || sp.Source < 0 || sp.Source >= len(sources) {
		t.Fatalf("span %+v", sp)
	}
	u := utf16Of(sources[sp.Source])
	if sp.Start < 0 || sp.End > len(u) || sp.Start > sp.End {
		t.Fatalf("span %+v outside %d units", sp, len(u))
	}
	return string(utf16Decode(u[sp.Start:sp.End]))
}

func utf16Of(s string) []uint16 { return utf16.Encode([]rune(s)) }

func utf16Decode(u []uint16) []rune { return utf16.Decode(u) }
