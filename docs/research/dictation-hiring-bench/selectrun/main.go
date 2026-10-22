// Live labelled matrix of #190's selection layer: the command bar's
// sentences (the issue's 12 variants, the tuning set, and held-out
// phrasings) through internal/hireintent with the configured LLM and
// classifier, the live catalog read read-only from the bridge (hello +
// snapshot), the user's hidden models simulated as the issue did (every
// Codex model but gpt-6.1-sol hidden, or none), the existing private AI
// config read-only. No worker.hire, no launch. Each case runs -repeat
// times.
//
// Besides the product's outcome it probes the classifier directly (Select)
// on each case's selection text (the sentence without its labelled task):
// "near", gpt-6.1-sol alone (the score a near miss gets, whether the
// sentence chooses it or not: where PickScore comes from), and "all", every
// visible model and effort at once (several calls of at most
// ai.MaxQuestions in parallel: the margins, and the batching's latency).
// Results go to -out, never into the repository (#211 decision row 11).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
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

// label is one labelled sentence.
type label struct {
	ID   string
	Set  string // "tuning" (the issue's 12) or "held-out"
	Text string
	// Hidden: "one-sol" (every Codex model but gpt-6.1-sol) or "none".
	Hidden string
	Task   string // the exact task
	// Model: the id to take, "ask" (asked: invalid) or "missing".
	Model   string
	Choices []string // with "ask": exactly these offered (nil: not checked)
	Effort  string   // the level, or "ask"
}

const screenshot = "Please spawn a GPT Sol agent on high reasoning to solve the issue with the frontend."
const frontend = "solve the issue with the frontend."

var labels = []label{
	// The issue's 12 (tuning).
	{"screenshot", "tuning", screenshot, "one-sol", frontend, "gpt-6.1-sol", nil, "high"},
	{"soul", "tuning", strings.Replace(screenshot, "GPT Sol", "GPT soul", 1), "one-sol", frontend, "gpt-6.1-sol", nil, "high"},
	{"x-high", "tuning", strings.Replace(screenshot, "on high", "on X high", 1), "one-sol", frontend, "gpt-6.1-sol", nil, "xhigh"},
	{"xhigh", "tuning", strings.Replace(screenshot, "on high", "on xhigh", 1), "one-sol", frontend, "gpt-6.1-sol", nil, "xhigh"},
	{"extra-high", "tuning", strings.Replace(screenshot, "on high", "on extra high", 1), "one-sol", frontend, "gpt-6.1-sol", nil, "xhigh"},
	{"exact-x-high", "tuning", strings.Replace(strings.Replace(screenshot, "GPT Sol", "gpt-6.1-sol", 1), "on high", "on X high", 1), "one-sol", frontend, "gpt-6.1-sol", nil, "xhigh"},
	{"model-omitted", "tuning", "Please spawn an agent on high reasoning to solve the issue with the frontend.", "one-sol", frontend, "missing", nil, "high"},
	{"effort-omitted", "tuning", "Please spawn a GPT Sol agent to solve the issue with the frontend.", "one-sol", frontend, "gpt-6.1-sol", nil, "ask"},
	{"unknown-banana", "tuning", strings.Replace(screenshot, "GPT Sol", "GPT Banana", 1), "one-sol", frontend, "ask", nil, "high"},
	{"task-only", "tuning", "Please spawn an agent to make the Sol model run at X high in the frontend.", "one-sol", "make the Sol model run at X high in the frontend.", "missing", nil, "ask"},
	{"several-sols", "tuning", screenshot, "none", frontend, "ask", []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"}, "high"},
	{"contradiction", "tuning", strings.Replace(screenshot, "a GPT Sol", "a Claude Code GPT Sol", 1), "one-sol", frontend, "ask", nil, "high"},
	// Held out: phrasings not tuned on.
	{"codex-soul-extra-high", "held-out", "Can you hire a Codex agent using GPT Soul with extra-high effort to refactor the login form?", "one-sol", "refactor the login form?", "gpt-6.1-sol", nil, "xhigh"},
	{"sol-x-high-two-sentences", "held-out", "Spawn a Sol agent with x-high effort. Task: fix the flaky elevator test. Then report back.", "one-sol", "fix the flaky elevator test. Then report back.", "gpt-6.1-sol", nil, "xhigh"},
	{"hidden-version", "held-out", "Hire a GPT 6 Sol worker with high effort to audit the retry logic.", "one-sol", "audit the retry logic.", "ask", nil, "high"},
	{"hidden-luna", "held-out", "Hire a GPT Luna agent on high reasoning to tidy the CSS tokens.", "one-sol", "tidy the CSS tokens.", "ask", nil, "high"},
	{"opus-max", "held-out", "Start a new agent on Opus 5.5 at max effort to write the release notes.", "one-sol", "write the release notes.", "claude-opus-5-5", nil, "max"},
	{"models-in-task", "held-out", "Please hire an agent with high effort to compare GPT Sol and Opus on the parser.", "one-sol", "compare GPT Sol and Opus on the parser.", "missing", nil, "high"},
	{"sol-ultra", "held-out", "Hire a GPT Sol agent on ultra reasoning to profile the city renderer.", "one-sol", "profile the city renderer.", "gpt-6.1-sol", nil, "ultra"},
	{"claude-soul", "held-out", "Hire a Claude agent on GPT soul at high effort to fix the tests.", "one-sol", "fix the tests.", "ask", nil, "high"},
	{"versioned-several", "held-out", "Hire a GPT 6.1 Sol agent with medium effort to write the changelog.", "none", "write the changelog.", "gpt-6.1-sol", nil, "medium"},
	{"sole-medium", "held-out", "Spin up a GPT sole agent at medium effort to update the changelog.", "one-sol", "update the changelog.", "gpt-6.1-sol", nil, "medium"},
}

// call is one classifier call the product made.
type call struct {
	Questions []string           `json:"questions"`
	Scores    map[string]float64 `json:"scores,omitempty"`
	MS        int64              `json:"ms"`
	Error     string             `json:"error,omitempty"`
}

// recorder is the AI service with the LLM's budget replaced when set, its
// answers and the classifier's calls recorded.
type recorder struct {
	*ai.Service
	maxTokens int
	reasoning string

	mu      sync.Mutex
	answers []string
	llmMS   []int64
	calls   []call
}

func (r *recorder) LLM() ai.LLM               { return llmRec{r} }
func (r *recorder) Classifier() ai.Classifier { return clsRec{r} }

type llmRec struct{ r *recorder }

func (l llmRec) Complete(ctx context.Context, req ai.Request) (string, error) {
	if l.r.maxTokens > 0 {
		req.MaxTokens = l.r.maxTokens
	}
	if l.r.reasoning != "" {
		req.ReasoningEffort = l.r.reasoning
	}
	t := time.Now()
	s, err := l.r.Service.LLM().Complete(ctx, req)
	l.r.mu.Lock()
	l.r.answers = append(l.r.answers, s)
	l.r.llmMS = append(l.r.llmMS, time.Since(t).Milliseconds())
	l.r.mu.Unlock()
	return s, err
}

type clsRec struct{ r *recorder }

func (c clsRec) Classify(ctx context.Context, state map[string]any, q string) (float64, error) {
	return c.r.Service.Classifier().Classify(ctx, state, q)
}

func (c clsRec) ClassifyMany(ctx context.Context, state map[string]any, qs map[string]string) (map[string]float64, error) {
	t := time.Now()
	got, err := c.r.Service.Classifier().ClassifyMany(ctx, state, qs)
	k := call{Questions: slices.Sorted(func(yield func(string) bool) {
		for q := range qs {
			if !yield(q) {
				return
			}
		}
	}), Scores: got, MS: time.Since(t).Milliseconds()}
	if err != nil {
		k.Error = string(ai.KindOf(err))
	}
	c.r.mu.Lock()
	c.r.calls = append(c.r.calls, k)
	c.r.mu.Unlock()
	return got, err
}

// probe is a direct Select.
type probe struct {
	Outcome string             `json:"outcome"`
	Scores  map[string]float64 `json:"scores"`
	Calls   int                `json:"calls"`
	MS      int64              `json:"ms"`
	Error   string             `json:"error,omitempty"`
}

type row struct {
	ID        string   `json:"id"`
	Set       string   `json:"set"`
	Repeat    int      `json:"repeat"`
	Pass      bool     `json:"pass"`
	Why       string   `json:"why,omitempty"`
	Fields    string   `json:"fields,omitempty"`
	Choices   []string `json:"choices,omitempty"`
	Ready     bool     `json:"ready"`
	Error     string   `json:"error,omitempty"`
	LLMModel  *string  `json:"llm_model"`
	LLMEffort *string  `json:"llm_effort"`
	TotalMS   int64    `json:"total_ms"`
	LLMMS     int64    `json:"llm_ms"`
	Calls     []call   `json:"classifier_calls,omitempty"`
	Near      probe    `json:"probe_near"`
	All       probe    `json:"probe_all"`
}

func main() {
	home, _ := os.UserHomeDir()
	config := flag.String("config", filepath.Join(home, ".local/state/herdr-world/ai.json"), "existing config, read-only")
	socket := flag.String("socket", "/run/user/1000/herdr-world/bridge.sock", "read-only catalog source")
	out := flag.String("out", filepath.Join(os.TempDir(), "select-run.json"), "results (not committed)")
	repeat := flag.Int("repeat", 3, "runs of each case")
	maxTokens := flag.Int("max-tokens", 0, "the LLM's completion budget (0: the product's)")
	reasoning := flag.String("reasoning", "", "the LLM's reasoning effort (\"\": the product's)")
	noProbe := flag.Bool("no-probe", false, "skip the direct classifier probes")
	flag.Parse()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	c, err := proto.Dial(ctx, *socket)
	must(err)
	_, err = c.Hello(ctx, proto.Hello{Client: "select-run-readonly"})
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
	conv := func(h proto.HarnessOptions) hireintent.HarnessCatalog {
		return hireintent.HarnessCatalog{Models: h.Models, Efforts: h.Efforts, ExtraEfforts: h.ExtraEfforts, ModelLabels: h.ModelLabels}
	}
	cat := hireintent.Catalog{Claude: conv(opts.Claude), Codex: conv(opts.Codex)}
	oneSol := hireintent.Hidden{"codex": slices.DeleteFunc(slices.Clone(cat.Codex.Models), func(m string) bool { return m == "gpt-6.1-sol" })}

	svc, err := ai.New(ai.Options{File: *config})
	must(err)
	v := svc.View()
	fmt.Printf("LLM %s (%s), classifier %s (%s); budget %d, reasoning %q; constants PickScore %.2f PickMargin %.2f\n", v.LLM.Model, svc.State(ai.RoleLLM),
		v.Classifier.Model, svc.State(ai.RoleClassifier), *maxTokens, *reasoning, hireintent.PickScore, hireintent.PickMargin)

	var rows []row
	var mu sync.Mutex
	slots := make(chan struct{}, ai.DefaultConcurrency)
	var wg sync.WaitGroup
	for rep := range *repeat {
		for _, l := range labels {
			wg.Add(1)
			go func() {
				defer wg.Done()
				slots <- struct{}{}
				defer func() { <-slots }()
				r := runCase(ctx, svc, *maxTokens, *reasoning, cat, oneSol, l, rep, !*noProbe)
				mu.Lock()
				rows = append(rows, r)
				mu.Unlock()
				fmt.Printf("%-26s #%d pass=%-5v %-60s near=%.2f %dms %s\n", l.ID, rep, r.Pass, r.Fields, r.Near.Scores["model:codex/gpt-6.1-sol"], r.TotalMS, r.Why)
			}()
		}
	}
	wg.Wait()
	slices.SortFunc(rows, func(a, b row) int {
		return strings.Compare(fmt.Sprint(a.Set, a.ID, a.Repeat), fmt.Sprint(b.Set, b.ID, b.Repeat))
	})

	pass := map[string][2]int{}
	var total, llm, cls, all []int64
	var batches []int
	truncated := 0
	for _, r := range rows {
		p := pass[r.Set]
		p[1]++
		if r.Pass {
			p[0]++
		}
		pass[r.Set] = p
		if r.Error == "truncated" {
			truncated++
		}
		total = append(total, r.TotalMS)
		llm = append(llm, r.LLMMS)
		for _, k := range r.Calls {
			cls = append(cls, k.MS)
		}
		if r.All.Calls > 0 {
			all = append(all, r.All.MS)
			batches = append(batches, r.All.Calls)
		}
	}
	summary := map[string]any{"pass": pass, "truncated": truncated, "max_tokens": *maxTokens, "reasoning": *reasoning,
		"total_ms": pcts(total), "llm_ms": pcts(llm), "classifier_call_ms": pcts(cls), "probe_all_ms": pcts(all), "probe_all_batches": batches,
		"pick_score": hireintent.PickScore, "pick_margin": hireintent.PickMargin}
	fmt.Printf("summary %v\n", summary)
	b, err := json.MarshalIndent(map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "llm": v.LLM.Model, "classifier": v.Classifier.Model,
		"summary": summary, "rows": rows}, "", "  ")
	must(err)
	must(os.WriteFile(*out, append(b, '\n'), 0o644))
}

// runCase interprets l once through the product, then probes.
func runCase(ctx context.Context, svc *ai.Service, maxTokens int, reasoning string, cat hireintent.Catalog, oneSol hireintent.Hidden, l label, rep int, probes bool) row {
	rec := &recorder{Service: svc, maxTokens: maxTokens, reasoning: reasoning}
	var hidden hireintent.Hidden
	if l.Hidden == "one-sol" {
		hidden = oneSol
	}
	t := time.Now()
	res := hireintent.Run(ctx, rec, hireintent.DefaultTimeout, hireintent.Request{Text: l.Text, Catalog: cat, Hidden: hidden})
	r := row{ID: l.ID, Set: l.Set, Repeat: rep, TotalMS: time.Since(t).Milliseconds(), Calls: rec.calls}
	if len(rec.llmMS) > 0 {
		r.LLMMS = rec.llmMS[0]
	}
	if len(rec.answers) > 0 {
		if a, err := hireintent.Parse(rec.answers[0]); err == nil {
			r.LLMModel, r.LLMEffort = a.Model, a.Effort
		}
	}
	r.Pass, r.Why = judge(l, res, &r)
	if probes {
		sel := l.Text
		if i := strings.LastIndex(sel, l.Task); i >= 0 {
			sel = sel[:i] + "\n" + sel[i+len(l.Task):]
		}
		vis := cat.Without(hidden)
		hc := vis.Codex
		r.Near = probeSelect(ctx, svc, sel, []hireintent.Choice{{Harness: "codex", Model: "gpt-6.1-sol", Label: hc.ModelLabels["gpt-6.1-sol"]}}, nil)
		var models []hireintent.Choice
		var efforts []string
		for _, h := range hireintent.Harnesses {
			hc, _ := vis.Harness(h)
			for _, id := range hc.Models {
				models = append(models, hireintent.Choice{Harness: h, Model: id, Label: hc.ModelLabels[id]})
				for _, e := range hc.EffortsFor(id) {
					if !slices.Contains(efforts, e) {
						efforts = append(efforts, e)
					}
				}
			}
		}
		r.All = probeSelect(ctx, svc, sel, models, efforts)
	}
	return r
}

func probeSelect(ctx context.Context, svc *ai.Service, sel string, models []hireintent.Choice, efforts []string) probe {
	t := time.Now()
	got, err := hireintent.Select(ctx, svc.Classifier(), sel, models, efforts)
	p := probe{Outcome: got.Model.Outcome, Calls: got.Calls, MS: time.Since(t).Milliseconds(), Scores: map[string]float64{}}
	if err != nil {
		p.Error = string(ai.KindOf(err))
	}
	for k, v := range got.Model.Scores {
		p.Scores["model:"+k] = v
	}
	for k, v := range got.Effort.Scores {
		p.Scores["effort:"+k] = v
	}
	return p
}

// judge reports whether res is what l labels.
func judge(l label, res hireintent.Result, r *row) (bool, string) {
	if res.Error != nil {
		r.Error = res.Error.Code
		return false, "error " + res.Error.Code
	}
	if res.Hire == nil {
		return false, "intent " + res.Intent
	}
	in := res.Hire
	r.Ready = in.ReadyForReview
	r.Fields = fmt.Sprintf("h=%s:%s m=%s:%s e=%s:%s", in.Harness.Provenance, in.Harness.Value, in.Model.Provenance, in.Model.Value, in.Effort.Provenance, in.Effort.Value)
	for _, q := range in.Questions {
		if q.Field == hireintent.AskModel {
			for _, c := range q.Choices {
				r.Choices = append(r.Choices, c.Model)
			}
		}
	}
	var why []string
	switch l.Model {
	case "ask":
		if in.Model.Provenance != hireintent.Invalid {
			why = append(why, "model not asked")
		} else if l.Choices != nil && !slices.Equal(r.Choices, l.Choices) {
			why = append(why, "choices")
		}
	case "missing":
		if in.Model.Provenance != hireintent.Missing {
			why = append(why, "model not missing")
		}
	default:
		if in.Model.Value != l.Model {
			why = append(why, "model")
		}
	}
	if l.Effort == "ask" {
		if in.Effort.Valid() {
			why = append(why, "effort not asked")
		}
	} else if in.Effort.Value != l.Effort {
		why = append(why, "effort")
	}
	if in.Task.Value != l.Task {
		why = append(why, "task")
	}
	if want := l.Model != "ask" && l.Model != "missing" && l.Effort != "ask"; in.ReadyForReview != want {
		why = append(why, "ready")
	}
	return len(why) == 0, strings.Join(why, ",")
}

func pcts(xs []int64) map[string]int64 {
	if len(xs) == 0 {
		return nil
	}
	s := slices.Clone(xs)
	slices.Sort(s)
	at := func(p float64) int64 { return s[min(len(s)-1, int(p*float64(len(s))))] }
	return map[string]int64{"n": int64(len(s)), "p50": at(0.5), "p90": at(0.9), "max": s[len(s)-1]}
}

func must(err error) {
	if err != nil {
		panic(ai.Scrub(err.Error()))
	}
}
