// Research harness: filesystem discovery only; does not change repositories.
// Build once and invoke with scan roots; output contains aggregate counts/timings.
package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type scan struct {
	Repos   []string `json:"-"`
	Dirs    int      `json:"directories_read"`
	Entries int      `json:"entries_read"`
	Errors  int      `json:"errors"`
	Markers int      `json:"git_files"`
}

// Discover recursively above checkouts. Do not follow symlinks or enter
// discovered checkouts, including their dependency trees and .git internals.
func discover(roots []string) scan {
	s := scan{}
	seen := map[string]bool{}
	var visit func(string)
	visit = func(dir string) {
		dir = filepath.Clean(dir)
		if seen[dir] {
			return
		}
		seen[dir] = true
		// Stat before ReadDir avoids enumerating a checkout's contents.
		if st, err := os.Lstat(filepath.Join(dir, ".git")); err == nil && (st.IsDir() || st.Mode().IsRegular()) {
			s.Repos = append(s.Repos, dir)
			if st.Mode().IsRegular() {
				s.Markers++
			}
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			s.Errors++
			return
		}
		s.Dirs++
		s.Entries += len(entries)
		for _, e := range entries {
			if e.IsDir() {
				visit(filepath.Join(dir, e.Name()))
			}
		}
	}
	for _, r := range roots {
		visit(r)
	}
	sort.Strings(s.Repos)
	return s
}

func metadata(repos []string, workers int) (int, int) {
	jobs := make(chan string)
	var wg sync.WaitGroup
	var mu sync.Mutex
	valid, origins := 0, 0
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for dir := range jobs {
				// Two local Git commands per candidate: validate, then resolve origin.
				out, err := git(dir, "rev-parse", "--show-toplevel")
				if err != nil || strings.TrimSpace(string(out)) != dir {
					continue
				}
				out, err = git(dir, "remote", "get-url", "origin")
				mu.Lock()
				valid++
				if err == nil && len(out) > 0 {
					origins++
				}
				mu.Unlock()
			}
		}()
	}
	for _, r := range repos {
		jobs <- r
	}
	close(jobs)
	wg.Wait()
	return valid, origins
}

func git(dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...).Output()
}

func main() {
	roots := os.Args[1:]
	if len(roots) == 0 {
		panic("provide absolute scan roots")
	}
	enc := json.NewEncoder(os.Stdout)
	var groups [][]string
	for _, r := range roots {
		groups = append(groups, []string{r})
	}
	groups = append(groups, roots)
	for _, rs := range groups {
		var times []float64
		var first float64
		var s scan
		for i := 0; i < 21; i++ {
			start := time.Now()
			s = discover(rs)
			ms := float64(time.Since(start).Microseconds()) / 1000
			if i == 0 {
				first = ms
			} else {
				times = append(times, ms)
			}
		}
		sort.Float64s(times)
		row := map[string]any{"roots": rs, "scan": s, "repos": len(s.Repos), "first_ms": first, "warm_median_ms": times[len(times)/2], "warm_p95_ms": times[(len(times)*95-1)/100]}
		for _, n := range []int{1, 4, 8} {
			var durations []float64
			var valid, origins int
			for i := 0; i < 5; i++ {
				start := time.Now()
				valid, origins = metadata(s.Repos, n)
				durations = append(durations, float64(time.Since(start).Microseconds())/1000)
			}
			sort.Float64s(durations)
			row["metadata_"+strconv.Itoa(n)+"_workers"] = map[string]any{"median_ms": durations[2], "max_ms": durations[4], "validated": valid, "with_origin": origins}
		}
		enc.Encode(row)
	}
}
