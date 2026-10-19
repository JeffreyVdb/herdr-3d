package schedsuggest_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// TestLiveGolden runs the golden cases (testdata/golden.json) through the
// configured classifier and LLM, each at its own time and zone: a case with
// want_due must come out within its tolerance of it, every other one with
// no suggestion (the gate, the LLM's none, or the validation). It costs
// inference, so it runs only with H3D_SCHEDSUGGEST_LIVE set to the bridge's
// ai.json (read only). Each call is made once, as the bridge makes it; the
// key is never printed.
//
//	H3D_SCHEDSUGGEST_LIVE=~/.local/state/herdr-world/ai.json \
//	  go test ./internal/schedsuggest -run Live -v -count=1
func TestLiveGolden(t *testing.T) {
	file := os.Getenv("H3D_SCHEDSUGGEST_LIVE")
	if file == "" {
		t.Skip("H3D_SCHEDSUGGEST_LIVE is not set: no live call")
	}
	svc, err := ai.New(ai.Options{File: file, LLMTimeout: 3 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range loadGolden(t) {
		t.Run(c.Name, func(t *testing.T) {
			now := mustTime(t, c.Now)
			ss := newService(t, svc, c.Zone, func() time.Time { return now })
			start := time.Now()
			res, err := ss.Detect(context.Background(), c.text(t))
			if err != nil {
				t.Fatalf("error %s: %v", ai.KindOf(err), err)
			}
			took := time.Since(start)
			if res.Draft == nil {
				t.Logf("score %.2f, flagged %v, none (%s) in %.1fs, efforts %v", res.Score, res.Flag, res.Why, took.Seconds(), res.Efforts)
				if c.WantDue != "" {
					t.Errorf("want a suggestion due %s", c.WantDue)
				}
				return
			}
			d := res.Draft
			t.Logf("score %.2f, due %s, title %q, prompt %d bytes, in %.1fs, efforts %v", res.Score, d.DueAt.Format(time.RFC3339), d.Title, len(d.Prompt), took.Seconds(), res.Efforts)
			if c.WantDue == "" {
				t.Errorf("want none, got a suggestion due %s", d.DueAt.Format(time.RFC3339))
				return
			}
			want := mustTime(t, c.WantDue)
			if off := d.DueAt.Sub(want).Abs(); off > time.Duration(c.Tolerate)*time.Minute {
				t.Errorf("due %s is %s off %s (tolerance %d min)", d.DueAt.Format(time.RFC3339), off, c.WantDue, c.Tolerate)
			}
		})
	}
}
