package packup_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/packup"
)

// Explicitly opt in: H3D_PACKUP_LIVE=/path/to/ai.json H3D_PACKUP_EFFORT=none
// go test ./internal/packup -run TestLiveExtraction -count=1 -v
// Only public samples go to the endpoints; settings are copied, never saved back.
func TestLiveExtraction(t *testing.T) {
	file := os.Getenv("H3D_PACKUP_LIVE")
	if file == "" {
		t.Skip("no live probe requested")
	}
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal("cannot read probe configuration")
	}
	copied := filepath.Join(t.TempDir(), "ai.json")
	if err := os.WriteFile(copied, data, 0600); err != nil {
		t.Fatal("cannot copy configuration")
	}
	svc, err := ai.New(ai.Options{File: copied})
	if err != nil {
		t.Fatal("cannot load probe configuration")
	}
	effort := os.Getenv("H3D_PACKUP_EFFORT")
	capability := svc.ModelReasoning(context.Background())
	if effort != "" && !capability.Allows(effort) {
		t.Fatal("probe effort unsupported")
	}
	params := packup.Params{ReasoningEffort: effort, MaxTokens: 600}
	// Three passes through the three core extractions, then the longer and German samples.
	var samples []packup.LabelledPrompt
	for range 3 {
		samples = append(samples, packup.Samples[:3]...)
	}
	for _, s := range packup.Samples[4:] {
		if s.Task != "" {
			samples = append(samples, s)
		}
	}
	samples = append(samples, packup.LabelledPrompt{Text: "Stop the dev server, end the polling loop, and add a 'Go home' button; then end your turn", Task: "Stop the dev server, end the polling loop, and add a 'Go home' button"})
	for i, sample := range samples {
		ctx, cancel := context.WithTimeout(context.Background(), packup.DetectTimeout)
		got, err := packup.RunWith(ctx, svc.Classifier(), svc.LLM(), sample.Text, .75, params)
		late := ctx.Err() != nil
		cancel()
		if err != nil {
			t.Errorf("sample %d classifier failed (%s), late=%v", i, ai.KindOf(err), late)
			continue
		}
		diag, _ := json.Marshal(got.Diag)
		t.Logf("sample %d score=%.2f matched=%v classifier=%dms extraction=%dms code=%s late=%v diag=%s", i, got.Score, got.Matched, got.ClassifierMS, got.ExtractionMS, got.ExtractCode, late, diag)
		if !got.Matched || late || strings.TrimRight(strings.ToLower(got.Task), ".!") != strings.TrimRight(strings.ToLower(sample.Task), ".!") {
			t.Errorf("sample %d failed timely task preservation", i)
		}
	}
}
