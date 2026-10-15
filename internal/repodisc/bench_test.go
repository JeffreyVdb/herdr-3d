package repodisc

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
)

// TestBenchRoots measures the production scan (walk, git validation and
// origin lookup with DefaultWorkers, identity merging) on real folders:
// H3D_REPODISC_BENCH is a list of roots separated by ':' (skipped without
// it). Each root, then all of them together: one warm-up scan, then 20
// timed ones; it prints counts and the median, p95 and maximum. See
// docs/research/repository-scan-bench/README.md.
//
//	H3D_REPODISC_BENCH=/home/me/dev:/home/me/work go test -run TestBenchRoots -v ./internal/repodisc
func TestBenchRoots(t *testing.T) {
	env := os.Getenv("H3D_REPODISC_BENCH")
	if env == "" {
		t.Skip("H3D_REPODISC_BENCH is not set")
	}
	roots := filepath.SplitList(env)
	groups := [][]string{}
	for _, r := range roots {
		groups = append(groups, []string{r})
	}
	if len(roots) > 1 {
		groups = append(groups, roots)
	}
	g := &gitops.Git{Timeout: DefaultGitTimeout}
	for _, rs := range groups {
		var times []float64
		var out scanOut
		var cat *Catalog
		for i := range 21 {
			start := time.Now()
			out = scanRoots(context.Background(), g, rs, DefaultWorkers, nil, func(string, int, int) {})
			var all []Checkout
			for _, r := range rs {
				if err := out.roots[r].err; err != nil {
					t.Fatalf("%s: %v", r, err)
				}
				all = append(all, out.roots[r].checkouts...)
			}
			cat = NewCatalog(1, all)
			if i > 0 {
				times = append(times, float64(time.Since(start).Microseconds())/1000)
			}
		}
		slices.Sort(times)
		origins, files := 0, 0
		for _, r := range cat.Repos {
			for _, c := range r.Checkouts {
				if c.Origin != "" {
					origins++
				}
				if !c.Main {
					files++
				}
			}
		}
		row := map[string]any{
			"roots": strings.Join(rs, ":"), "workers": DefaultWorkers,
			"candidates": out.candidates, "valid_checkouts": cat.Checkouts(), "with_origin": origins, "linked_or_submodule": files,
			"repositories": cat.Len(), "grouping_dirs_read": out.dirs, "entries_read": out.entries,
			"median_ms": times[len(times)/2], "p95_ms": times[(len(times)*95-1)/100], "max_ms": times[len(times)-1],
		}
		b, _ := json.Marshal(row)
		t.Log(string(b))
	}
}
