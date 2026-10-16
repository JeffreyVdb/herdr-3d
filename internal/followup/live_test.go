package followup_test

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
)

// TestLiveGrillExtraction measures the extraction of SampleGrill against the
// configured LLM (#60, docs/decisions.md). It costs inference, so it runs
// only with H3D_FOLLOWUP_LIVE set to the bridge's ai.json (read only), and
// H3D_FOLLOWUP_LIVE_PLAN a list of effort:budget calls ("low:8192,none:8192";
// "default" sends no effort). One attempt per call, never retried; the key
// is never printed. H3D_FOLLOWUP_LIVE_SAVE=<file> keeps the last passing
// answer (testdata/grill-round2-llm.json is one).
//
//	H3D_FOLLOWUP_LIVE=~/.local/state/herdr-world/ai.json H3D_FOLLOWUP_LIVE_PLAN=low:8192 \
//	  go test ./internal/followup -run Live -v -count=1
func TestLiveGrillExtraction(t *testing.T) {
	file := os.Getenv("H3D_FOLLOWUP_LIVE")
	if file == "" {
		t.Skip("H3D_FOLLOWUP_LIVE is not set: no live call")
	}
	svc, err := ai.New(ai.Options{File: file, LLMTimeout: 3 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	r := svc.ModelReasoning(ctx)
	t.Logf("model %s: reasoning %s, efforts %v (listed %v), default %q", r.Model, r.Support, r.Efforts, r.Listed, r.Default)
	for i, step := range strings.Split(os.Getenv("H3D_FOLLOWUP_LIVE_PLAN"), ",") {
		effort, budget, _ := strings.Cut(strings.TrimSpace(step), ":")
		if effort == "default" {
			effort = ""
		}
		n, err := strconv.Atoi(budget)
		if err != nil {
			t.Fatalf("plan step %q: want effort:budget", step)
		}
		req := followup.Request(followup.SampleGrill, effort)
		req.MaxTokens, req.NoUncertainRetry = n, true
		var d ai.Diagnostics
		req.Report = func(x ai.Diagnostics) { d = x }
		start := time.Now()
		out, err := svc.LLM().Complete(ctx, req)
		took := time.Since(start)
		verdict := "pass"
		var got string
		if err != nil {
			verdict, got = "fail", fmt.Sprintf("error %s: %v", ai.KindOf(err), err)
		} else if qs, unlisted, perr := followup.Parse(out); perr != nil {
			verdict, got = "fail", "parse: "+perr.Error()
		} else {
			recs, opts := 0, 0
			for _, q := range qs {
				if q.Recommendation != nil {
					recs++
					if q.Recommendation.Option != nil {
						opts++
					}
				}
			}
			got = fmt.Sprintf("%d questions (%d unlisted), %d with a recommendation, %d naming an option, %d chars", len(qs), unlisted, recs, opts, len(out))
			if len(qs) != followup.SampleGrillQuestions || recs != len(qs) {
				verdict = "fail"
			} else if save := os.Getenv("H3D_FOLLOWUP_LIVE_SAVE"); save != "" {
				if err := os.WriteFile(save, []byte(out+"\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		t.Logf("call %d: effort %q budget %d: %s in %.1fs; finish %s, completion %s, reasoning %s, prompt %s; %s",
			i+1, effort, n, verdict, took.Seconds(), d.FinishReason, num(d.CompletionTokens), num(d.ReasoningTokens), num(d.PromptTokens), got)
	}
}

func num(p *int) string {
	if p == nil {
		return "?"
	}
	return strconv.Itoa(*p)
}
