// Research harness: live configured AI calls, read-only bridge catalog, dry-run hires.
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
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type Sample struct {
	ID       string   `json:"id"`
	Text     string   `json:"text"`
	History  []string `json:"history,omitempty"`
	Intent   string   `json:"intent"`
	Decision string   `json:"decision"`
	Task     string   `json:"task,omitempty"`
}
type Parsed struct {
	Intent           string  `json:"intent"`
	Harness          *string `json:"harness"`
	Model            *string `json:"model"`
	Effort           *string `json:"effort"`
	Task             *string `json:"task"`
	Multiple         bool    `json:"multiple"`
	SelectionUnclear bool    `json:"selection_unclear"`
}
type Result struct {
	Sample          Sample             `json:"sample"`
	Scores          map[string]float64 `json:"scores,omitempty"`
	JevIntent       string             `json:"jev_intent"`
	JevMS           int64              `json:"jev_ms"`
	JevError        string             `json:"jev_error,omitempty"`
	Parsed          *Parsed            `json:"parsed,omitempty"`
	LLMMS           int64              `json:"llm_ms"`
	LLMError        string             `json:"llm_error,omitempty"`
	LLMDecision     string             `json:"llm_decision"`
	HybridDecision  string             `json:"hybrid_decision"`
	TaskExact       bool               `json:"task_exact"`
	TaskSourceValid bool               `json:"task_source_valid"`
}

// Record metadata only, never headers, request content or private config.
type Metrics struct {
	mu    sync.Mutex
	Calls []map[string]any
}

func (m *Metrics) RoundTrip(req *http.Request) (*http.Response, error) {
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
			m.Calls = append(m.Calls, map[string]any{"model": v["model"], "usage": v["usage"], "status": r.StatusCode})
			m.mu.Unlock()
		}
	}
	return r, err
}

var questions = map[string]string{
	"hire":        `Does the user's current command explicitly request creating a NEW coding agent or worker now? Polite requests (can you hire), hire/spawn/launch/start/delegate to a NEW agent count. Bare tasks, references to existing workers, questions ABOUT hiring, quoted examples, historical statements, negation, conditional/hypothetical suggestions and task-internal instructions do not count. With pending_hire history, an explicit clarification of the requested missing hiring field counts as continuing that hire; cancellation does not.`,
	"unsupported": `Does the user's current command clearly request a game action other than hiring a NEW coding agent (such as navigating floors, opening settings, firing a worker, prompting an existing worker, or starting a run)? Consider only outer game commands, not verbs inside a hired agent's task. Bare tasks, unclear intentions and questions about commands do not count.`,
}

func val(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
func decide(p *Parsed, opts proto.HireOptions) string {
	if p == nil {
		return "error"
	}
	if p.Intent != "hire" {
		if p.Intent == "unsupported" {
			return "unsupported"
		}
		return "unclear"
	}
	if p.Multiple {
		return "unsupported"
	}
	if p.SelectionUnclear {
		return "clarify_selection"
	}
	h := val(p.Harness)
	model := val(p.Model)
	if h == "" || model == "" {
		return "clarify_selection"
	}
	var o proto.HarnessOptions
	switch h {
	case "claude":
		o = opts.Claude
	case "codex":
		o = opts.Codex
	default:
		return "clarify_selection"
	}
	if !slices.Contains(o.Models, model) {
		return "clarify_selection"
	}
	if val(p.Task) == "" {
		return "clarify_task"
	}
	if p.Effort == nil || val(p.Effort) == "" {
		return "clarify_effort"
	}
	if !slices.Contains(o.Efforts, val(p.Effort)) && !slices.Contains(o.ExtraEfforts[model], val(p.Effort)) {
		return "clarify_selection"
	}
	return "ready"
}

func main() {
	home, _ := os.UserHomeDir()
	config := flag.String("config", filepath.Join(home, ".local/state/herdr-world/ai.json"), "existing config, read-only")
	socket := flag.String("socket", "/run/user/1000/herdr-world/bridge.sock", "read-only catalog source")
	out := flag.String("out", "docs/research/dictation-hiring-bench/results.json", "sanitized results")
	samples := flag.String("samples", "docs/research/dictation-hiring-bench/samples.json", "labeled commands")
	promptPath := flag.String("prompt", "docs/research/dictation-hiring-bench/prompt.txt", "system prompt file")
	routing := flag.String("routing", "v2", "hybrid routing policy: v1 strict dual gate; v2 positive gate and pending clarification bypass")
	flag.Parse()
	promptBytes, err := os.ReadFile(*promptPath)
	must(err)
	prompt := string(promptBytes)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	c, err := proto.Dial(ctx, *socket)
	must(err)
	defer c.CloseNow()
	_, err = c.Hello(ctx, proto.Hello{Client: "dictation-research-readonly"})
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
	m := &Metrics{}
	svc, err := ai.New(ai.Options{File: *config, HTTP: &http.Client{Transport: m}})
	must(err)
	v := svc.View()
	fmt.Printf("Configured models: Jev=%s LLM=%s\n", v.Classifier.Model, v.LLM.Model)
	b, err := os.ReadFile(*samples)
	must(err)
	var ss []Sample
	must(json.Unmarshal(b, &ss))
	rows := make([]Result, len(ss))
	slots := make(chan struct{}, 2)
	var wg sync.WaitGroup
	for i, s := range ss {
		wg.Add(1)
		go func(i int, s Sample) {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			r := Result{Sample: s, TaskExact: s.Task == ""}
			state := map[string]any{"command": s.Text}
			if len(s.History) > 0 {
				state["pending_hire"] = s.History
			}
			t := time.Now()
			scores, e := svc.Classifier().ClassifyMany(ctx, state, questions)
			r.Scores = scores
			r.JevMS = time.Since(t).Milliseconds()
			if e != nil {
				r.JevError = ai.Scrub(e.Error())
				r.JevIntent = "error"
			} else if scores["hire"] >= .9 && scores["unsupported"] <= .1 {
				r.JevIntent = "hire"
			} else if scores["unsupported"] >= .9 && scores["hire"] <= .1 {
				r.JevIntent = "unsupported"
			} else {
				r.JevIntent = "unclear"
			}
			state["hire_options"] = opts
			payload, _ := json.Marshal(state)
			t = time.Now()
			answer, e := svc.LLM().Complete(ctx, ai.Request{Messages: []ai.Message{{Role: "system", Content: prompt}, {Role: "user", Content: string(payload)}}, JSON: true, MaxTokens: 1400, NoPartial: true})
			r.LLMMS = time.Since(t).Milliseconds()
			if e != nil {
				r.LLMError = ai.Scrub(e.Error())
			} else {
				obj, ok := ai.FirstJSONObject(answer)
				if !ok {
					r.LLMError = "no JSON object"
				} else {
					p := new(Parsed)
					if e = json.Unmarshal([]byte(obj), p); e != nil {
						r.LLMError = "invalid parsed object"
					} else {
						r.Parsed = p
					}
				}
			}
			r.LLMDecision = decide(r.Parsed, opts)
			r.HybridDecision = r.JevIntent
			if *routing == "v2" && r.JevError == "" {
				if len(s.History) > 0 || scores["hire"] >= .9 {
					r.HybridDecision = r.LLMDecision
				} else if scores["unsupported"] >= .9 {
					r.HybridDecision = "unsupported"
				} else {
					r.HybridDecision = "unclear"
				}
			}
			if *routing == "v1" && r.JevIntent == "hire" {
				if r.Parsed != nil && r.Parsed.Intent == "hire" {
					r.HybridDecision = r.LLMDecision
				} else {
					r.HybridDecision = "unclear"
				}
			}
			if r.Parsed != nil && val(r.Parsed.Task) != "" {
				r.TaskSourceValid = strings.Contains(s.Text, val(r.Parsed.Task))
				for _, prior := range s.History {
					r.TaskSourceValid = r.TaskSourceValid || strings.Contains(prior, val(r.Parsed.Task))
				}
				if !r.TaskSourceValid && r.LLMDecision == "ready" {
					r.LLMDecision = "clarify_task"
				}
				if !r.TaskSourceValid && r.HybridDecision == "ready" {
					r.HybridDecision = "clarify_task"
				}
			}
			if r.Parsed != nil && s.Task != "" {
				r.TaskExact = val(r.Parsed.Task) == s.Task
			}
			rows[i] = r
			fmt.Printf("%s Jev=%s LLM=%s hybrid=%s expected=%s (%d/%dms)\n", s.ID, r.JevIntent, r.LLMDecision, r.HybridDecision, s.Decision, r.JevMS, r.LLMMS)
		}(i, s)
	}
	wg.Wait()
	data := map[string]any{"at": time.Now().UTC().Format(time.RFC3339), "classifier": v.Classifier.Model, "llm": v.LLM.Model, "catalog": opts, "system_prompt": prompt, "hybrid_routing": *routing, "jev_questions": questions, "thresholds": map[string]float64{"yes": .9, "no": .1}, "results": rows, "http_metadata": m.Calls, "scope": "Live configured providers via internal/ai; read-only live catalog; dry-run decisions. No UI, audio, Wispr capture, real worker.hire or launch."}
	b, err = json.MarshalIndent(data, "", "  ")
	must(err)
	must(os.WriteFile(*out, append(b, '\n'), 0644))
}
func must(err error) {
	if err != nil {
		panic(ai.Scrub(err.Error()))
	}
}
