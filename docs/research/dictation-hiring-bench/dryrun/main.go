// Dry-run interpretation check of internal/hireintent (#211): the bench's 50
// labelled cases (#214: plus the e2e's sentences, `-extra e2e-phrases.json`)
// through the product package with the configured LLM, the
// live catalog read read-only from the bridge (hello + snapshot), and the
// existing private AI config read-only. No worker.hire, no launch: this is
// not a launch test. A follow-up case first interprets its history, so its
// reply merges into a real pending proposal, as the game will do it.
//
// #190: -max-tokens and -reasoning try another LLM budget or reasoning
// effort than the product's (hireintent.MaxTokens, none) on the same
// cases, to measure truncation; the product's request is otherwise sent as
// is. The classifier, when the AI config has it ready, takes part as in the
// product.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type sample struct {
	ID       string   `json:"id"`
	Text     string   `json:"text"`
	History  []string `json:"history,omitempty"`
	Intent   string   `json:"intent"`
	Decision string   `json:"decision"`
	Task     string   `json:"task,omitempty"`
}

type row struct {
	ID        string `json:"id"`
	Set       string `json:"set"`
	Expected  string `json:"expected"`
	Got       string `json:"got"`
	WantTask  string `json:"want_task,omitempty"`
	Task      string `json:"task,omitempty"`
	TaskExact bool   `json:"task_exact"`
	Pass      bool   `json:"pass"`
	// Fields are the proposal's provenances ("h=dictated:claude …").
	Fields    string `json:"fields,omitempty"`
	Error     string `json:"error,omitempty"` // the failure code
	LatencyMS int64  `json:"latency_ms"`      // the scored call
	Calls     int    `json:"calls"`
}

// metrics records the provider's model, usage and status of every call:
// never headers, request content or private config.
type metrics struct {
	mu    sync.Mutex
	calls []map[string]any
}

func (m *metrics) RoundTrip(req *http.Request) (*http.Response, error) {
	r, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		return r, err
	}
	b, e := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	r.Body.Close()
	r.Body = io.NopCloser(strings.NewReader(string(b)))
	if e == nil {
		var v map[string]any
		if json.Unmarshal(b, &v) == nil {
			m.mu.Lock()
			m.calls = append(m.calls, map[string]any{"model": v["model"], "usage": v["usage"], "status": r.StatusCode})
			m.mu.Unlock()
		}
	}
	return r, err
}

// label is the bench's decision for a result (the order of the research's
// decide: selection, task, effort).
func label(r hireintent.Result) string {
	switch {
	case r.Error != nil:
		return "error"
	case r.Intent != hireintent.IntentHire:
		return r.Intent
	case r.Hire.ReadyForReview:
		return "ready"
	}
	asks := map[string]bool{}
	for _, q := range r.Hire.Questions {
		asks[q.Field] = true
	}
	switch {
	case asks[hireintent.AskModel] || asks[hireintent.AskSelection] || r.Hire.Effort.Provenance == hireintent.Invalid:
		return "clarify_selection"
	case asks[hireintent.AskTask]:
		return "clarify_task"
	case asks[hireintent.AskEffort]:
		return "clarify_effort"
	}
	return "?"
}

func fields(in *hireintent.Interpretation) string {
	f := func(n string, x hireintent.Field) string {
		s := n + "=" + x.Provenance
		if x.Value != "" {
			s += ":" + x.Value
		}
		return s
	}
	return strings.Join([]string{f("h", in.Harness), f("m", in.Model), f("e", in.Effort), "t=" + in.Task.Provenance}, " ")
}

func catalogOf(o proto.HireOptions) hireintent.Catalog {
	conv := func(h proto.HarnessOptions) hireintent.HarnessCatalog {
		return hireintent.HarnessCatalog{Models: h.Models, Efforts: h.Efforts, ExtraEfforts: h.ExtraEfforts, ModelLabels: h.ModelLabels}
	}
	return hireintent.Catalog{Claude: conv(o.Claude), Codex: conv(o.Codex)}
}

// roles are the AI service's, with the LLM's request budget or reasoning
// effort replaced when set (#190, measurement only).
type roles struct {
	*ai.Service
	maxTokens int
	reasoning string
}

func (r roles) LLM() ai.LLM { return budgetLLM{r.Service.LLM(), r.maxTokens, r.reasoning} }

type budgetLLM struct {
	ai.LLM
	maxTokens int
	reasoning string
}

func (b budgetLLM) Complete(ctx context.Context, req ai.Request) (string, error) {
	if b.maxTokens > 0 {
		req.MaxTokens = b.maxTokens
	}
	if b.reasoning != "" {
		req.ReasoningEffort = b.reasoning
	}
	return b.LLM.Complete(ctx, req)
}

func main() {
	home, _ := os.UserHomeDir()
	dir := "docs/research/dictation-hiring-bench"
	config := flag.String("config", filepath.Join(home, ".local/state/herdr-world/ai.json"), "existing config, read-only")
	socket := flag.String("socket", "/run/user/1000/herdr-world/bridge.sock", "read-only catalog source")
	out := flag.String("out", filepath.Join(os.TempDir(), "dictation-dryrun.json"), "sanitized results (not committed: it holds the live catalog)")
	extra := flag.String("extra", "", "#214: one more labelled sample file in the bench's schema (set \"e2e\"), e.g. "+dir+"/e2e-phrases.json")
	maxTokens := flag.Int("max-tokens", 0, "#190: the LLM's completion budget for this run (0: the product's)")
	reasoning := flag.String("reasoning", "", "#190: the LLM's reasoning effort for this run (\"\": the product's, none sent)")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	c, err := proto.Dial(ctx, *socket)
	must(err)
	_, err = c.Hello(ctx, proto.Hello{Client: "dictation-dryrun-readonly"})
	must(err)
	var opts proto.HireOptions
	for {
		env, b, e := c.Read(ctx)
		must(e)
		if env.T == proto.TSnapshot {
			var sn proto.Snapshot
			must(json.Unmarshal(b, &sn))
			if sn.World.HireOptions == nil {
				panic("missing live hire options")
			}
			opts = *sn.World.HireOptions
			break
		}
	}
	c.CloseNow()
	cat := catalogOf(opts)

	m := &metrics{}
	svc, err := ai.New(ai.Options{File: *config, HTTP: &http.Client{Transport: m}})
	must(err)
	v := svc.View()
	fmt.Printf("Configured LLM: %s (state %s), classifier %s; budget %d, reasoning %q\n", v.LLM.Model, svc.State(ai.RoleLLM),
		svc.State(ai.RoleClassifier), *maxTokens, *reasoning)
	run := roles{svc, *maxTokens, *reasoning}

	var cases []sample
	sets := []string{}
	files := []struct{ file, set string }{{filepath.Join(dir, "samples.json"), "revised"}, {filepath.Join(dir, "holdout.json"), "fresh"}}
	if *extra != "" {
		files = append(files, struct{ file, set string }{*extra, "e2e"})
	}
	for _, f := range files {
		b, err := os.ReadFile(f.file)
		must(err)
		var ss []sample
		must(json.Unmarshal(b, &ss))
		cases = append(cases, ss...)
		for range ss {
			sets = append(sets, f.set)
		}
	}

	rows := make([]row, len(cases))
	slots := make(chan struct{}, ai.DefaultConcurrency)
	var wg sync.WaitGroup
	for i, s := range cases {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			r := row{ID: s.ID, Set: sets[i], Expected: s.Decision, WantTask: s.Task}
			var pending *hireintent.Interpretation
			for _, h := range s.History {
				res := hireintent.Run(ctx, run, hireintent.DefaultTimeout, hireintent.Request{Text: h, Pending: pending, Catalog: cat})
				r.Calls++
				if res.Hire == nil {
					r.Error = "history: " + label(res)
					rows[i] = r
					return
				}
				pending = res.Hire
			}
			t := time.Now()
			res := hireintent.Run(ctx, run, hireintent.DefaultTimeout, hireintent.Request{Text: s.Text, Pending: pending, Catalog: cat})
			r.LatencyMS = time.Since(t).Milliseconds()
			if strings.TrimSpace(s.Text) != "" {
				r.Calls++
			}
			r.Got = label(res)
			if res.Error != nil {
				r.Error = res.Error.Code
			}
			if res.Hire != nil {
				r.Fields = fields(res.Hire)
				r.Task = res.Hire.Task.Value
			}
			// The task is scored where a proposal is expected: an unsupported
			// or unclear result carries none by design (multi-worker's label
			// names the task the research's parser read).
			r.TaskExact = s.Task == "" || r.Task == s.Task || (res.Hire == nil && (s.Decision == "unsupported" || s.Decision == "unclear"))
			r.Pass = r.Got == s.Decision && r.TaskExact
			rows[i] = r
			fmt.Printf("%-32s got=%-17s want=%-17s task_exact=%v %dms\n", s.ID, r.Got, s.Decision, r.TaskExact, r.LatencyMS)
		}()
	}
	wg.Wait()

	pass := 0
	var lat []int64
	perSet := map[string][2]int{}
	// The hard rule: a case that must not be launch-ready (unclear,
	// unsupported, or any clarify_*: a missing effort among them) never
	// comes back ready for review.
	var launchReady []string
	for _, r := range rows {
		ps := perSet[r.Set]
		ps[1]++
		if r.Pass {
			pass++
			ps[0]++
		}
		perSet[r.Set] = ps
		if r.Expected != "ready" && r.Got == "ready" {
			launchReady = append(launchReady, r.ID)
		}
		if r.Calls > 0 {
			lat = append(lat, r.LatencyMS)
		}
	}
	slices.Sort(lat)
	pct := func(p float64) int64 {
		if len(lat) == 0 {
			return 0
		}
		return lat[min(len(lat)-1, int(p*float64(len(lat))))]
	}
	cost, calls := 0.0, len(m.calls)
	for _, call := range m.calls {
		if u, ok := call["usage"].(map[string]any); ok {
			if c, ok := u["cost"].(float64); ok {
				cost += c
			}
		}
	}
	sets2 := map[string]string{}
	for k, ps := range perSet {
		sets2[k] = fmt.Sprintf("%d/%d", ps[0], ps[1])
	}
	truncated := 0
	for _, r := range rows {
		if r.Error == "truncated" {
			truncated++
		}
	}
	summary := map[string]any{"max_tokens": *maxTokens, "reasoning": *reasoning, "truncated": truncated, "pass": pass, "total": len(rows), "llm": v.LLM.Model, "median_ms": pct(0.5), "p90_ms": pct(0.9), "p95_ms": pct(0.95),
		"provider_calls": calls, "provider_cost_usd": cost, "per_set": sets2, "launch_ready_violations": launchReady}
	fmt.Printf("dry-run interpretation check: %d/%d (outcome and exact task) %v, %d truncated, LLM %s, median %d ms, p90 %d ms, p95 %d ms, %d calls, reported cost $%.7f\n",
		pass, len(rows), sets2, truncated, v.LLM.Model, pct(0.5), pct(0.9), pct(0.95), calls, cost)
	fmt.Printf("not-ready cases (unclear, unsupported, clarify_*) that came back ready for review: %d %v\n", len(launchReady), launchReady)
	data := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "llm": v.LLM.Model, "catalog": opts, "summary": summary,
		"results": rows, "http_metadata": m.calls,
		"scope": "Dry-run interpretation check through internal/hireintent with the configured LLM via internal/ai; read-only live catalog (hello + snapshot); no worker.hire, no launch. Not a launch test."}
	b, err := json.MarshalIndent(data, "", "  ")
	must(err)
	must(os.WriteFile(*out, append(b, '\n'), 0o644))
}

func must(err error) {
	if err != nil {
		panic(ai.Scrub(err.Error()))
	}
}
