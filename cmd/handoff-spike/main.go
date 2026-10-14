// Command handoff-spike is the #9 quality/size spike's harness (docs/research/
// handoff-summarizer.md). By default it is a dry run: it reduces each given
// Claude or Codex session JSONL with the bridge's reducer (internal/
// handoffllm.Reduce) up to the file's last complete line and prints, per
// file, the reduction's numbers only: payload bytes and estimated tokens, the
// whole prompt's bytes, coverage (messages kept, omitted ranges, gaps,
// compaction), redaction counts and the time it took. It prints no
// transcript text and sends nothing anywhere.
//
// Only with --send, and an endpoint, model and key file, does it call that
// OpenAI-compatible LLM once per file, through the bridge's own feature
// (internal/handoffllm.Service: the same prompt, bounds and validation), and
// add the answer's size, latency, validity and the provider's reported usage;
// --out writes each answer to a file there for the quality rubric. A call
// costs money: --send is for the person running the spike, deliberately.
//
//	handoff-spike [--budget 98304] [--json] FILE.jsonl ...
//	handoff-spike --send --base-url URL --model M --key-file F [--out DIR] [--focus TEXT] FILE.jsonl ...
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

// Row is one file's numbers.
type Row struct {
	File        string         `json:"file"`
	Harness     string         `json:"harness"`
	FileBytes   int64          `json:"file_bytes"`
	Error       string         `json:"error,omitempty"`
	ReduceMS    int64          `json:"reduce_ms"`
	Payload     int            `json:"payload_bytes"`
	EstTokens   int            `json:"est_tokens"`
	PromptBytes int            `json:"prompt_bytes"`
	PromptEst   int            `json:"prompt_est_tokens"`
	Messages    int            `json:"messages"`
	Kept        int            `json:"kept"`
	Omitted     int            `json:"omitted_ranges"`
	Gaps        int            `json:"gaps"`
	Compaction  string         `json:"compaction"`
	Complete    bool           `json:"complete"`
	Abandoned   int            `json:"abandoned"`
	Sidechains  int            `json:"sidechains"`
	Dedup       int            `json:"deduplicated"`
	Skipped     int            `json:"skipped"`
	Artifacts   int            `json:"artifacts"`
	Verified    int            `json:"verified"`
	Redactions  map[string]int `json:"redactions"`
	// --send only.
	Sent *Sent `json:"sent,omitempty"`
}

// Sent is a --send call's outcome: never the text (that goes to --out).
type Sent struct {
	Model       string          `json:"model"`
	LatencyMS   int64           `json:"latency_ms"`
	AnswerBytes int             `json:"answer_bytes"`
	Valid       bool            `json:"valid"`
	Reason      string          `json:"reason,omitempty"`
	Diag        *ai.Diagnostics `json:"diag,omitempty"`
	Out         string          `json:"out,omitempty"`
}

func run(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("handoff-spike", flag.ContinueOnError)
	fs.SetOutput(stderr)
	budget := fs.Int("budget", handoffllm.DefaultInputBytes, "transcript budget in bytes (the feature's input_bytes)")
	harness := fs.String("harness", "", "claude or codex (default: a file starting with Codex's session_meta, or under .codex or named rollout-*, is codex)")
	asJSON := fs.Bool("json", false, "one JSON object per file instead of a table")
	send := fs.Bool("send", false, "call the LLM once per file (costs money; needs --base-url, --model, --key-file)")
	base := fs.String("base-url", "", "--send: the OpenAI-compatible base URL")
	model := fs.String("model", "", "--send: the model")
	keyFile := fs.String("key-file", "", "--send: a file holding the API key")
	tokens := fs.Int("max-tokens", handoffllm.DefaultMaxTokens, "--send: the completion budget")
	focus := fs.String("focus", "", "--send: the handoff instruction")
	out := fs.String("out", "", "--send: write each answer to DIR/<file>.md")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() == 0 {
		fmt.Fprintln(stderr, "handoff-spike: give one or more session JSONL files")
		return 2
	}
	var gen *handoffllm.Service
	if *send {
		if *base == "" || *model == "" || *keyFile == "" {
			fmt.Fprintln(stderr, "handoff-spike: --send needs --base-url, --model and --key-file")
			return 2
		}
		var err error
		if gen, err = generator(*base, *model, *keyFile, *tokens); err != nil {
			fmt.Fprintln(stderr, "handoff-spike:", err)
			return 1
		}
	}
	ctx := context.Background()
	var rows []Row
	for _, f := range fs.Args() {
		r := reduceOne(ctx, f, *harness, *budget)
		if gen != nil && r.Error == "" {
			r.Sent = sendOne(ctx, gen, f, *harness, *budget, *focus, *out, *model)
		}
		rows = append(rows, r)
	}
	if *asJSON {
		enc := json.NewEncoder(stdout)
		for _, r := range rows {
			_ = enc.Encode(r)
		}
		return 0
	}
	table(stdout, rows)
	return 0
}

// harnessOf is the file's harness: the flag's, else what its first line
// says (Codex rollouts start with session_meta), else the path's.
func harnessOf(path, flagged string) string {
	if flagged != "" {
		return flagged
	}
	if f, err := os.Open(path); err == nil {
		head := make([]byte, 4096)
		n, _ := io.ReadFull(f, head)
		f.Close()
		first, _, _ := bytes.Cut(head[:n], []byte("\n"))
		if bytes.Contains(first, []byte(`"session_meta"`)) {
			return "codex"
		}
	}
	if strings.Contains(path, string(filepath.Separator)+".codex"+string(filepath.Separator)) || strings.HasPrefix(filepath.Base(path), "rollout-") {
		return "codex"
	}
	return "claude"
}

// snapshot is a file's reduction input: up to its last complete line.
func snapshot(path, harness string, budget int) (handoffllm.Input, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return handoffllm.Input{}, 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return handoffllm.Input{}, 0, err
	}
	var off, through int64
	buf := make([]byte, 1<<20)
	for {
		n, err := f.Read(buf)
		if i := bytes.LastIndexByte(buf[:n], '\n'); i >= 0 {
			through = off + int64(i) + 1
		}
		off += int64(n)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return handoffllm.Input{}, 0, err
		}
	}
	return handoffllm.Input{Harness: harness, Path: path, File: fi, Through: through, Budget: budget}, fi.Size(), nil
}

func reduceOne(ctx context.Context, path, flagged string, budget int) Row {
	h := harnessOf(path, flagged)
	r := Row{File: path, Harness: h, Redactions: map[string]int{}}
	in, size, err := snapshot(path, h, budget)
	r.FileBytes = size
	if err != nil {
		r.Error = err.Error()
		return r
	}
	start := time.Now()
	p, err := handoffllm.Reduce(ctx, in)
	r.ReduceMS = time.Since(start).Milliseconds()
	if err != nil {
		r.Error = err.Error()
		return r
	}
	c := p.Coverage
	r.Payload, r.EstTokens = p.Bytes, p.EstTokens
	r.Messages, r.Kept, r.Omitted, r.Gaps, r.Compaction, r.Complete = c.Messages, c.Kept, len(c.Omitted), len(c.Gaps), c.Compaction, c.Complete
	r.Abandoned, r.Sidechains, r.Dedup, r.Skipped = c.Abandoned, c.Sidechains, c.Deduplicated, c.Skipped
	for _, a := range p.Artifacts {
		r.Artifacts++
		if a.Verified {
			r.Verified++
		}
	}
	r.Redactions = p.Redactions
	if pr, err := handoffllm.Build(facts(in), p, ""); err == nil {
		r.PromptBytes = pr.Bytes
		r.PromptEst = handoffllm.EstimateTokens(pr.Messages[0].Content) + handoffllm.EstimateTokens(pr.Messages[1].Content)
	}
	return r
}

// facts are the spike's: no worker, no git state (unknown), the snapshot.
func facts(in handoffllm.Input) handoffllm.Facts {
	return handoffllm.Facts{Now: time.Now(), Worker: "spike", Harness: in.Harness, Candidate: "spike", Through: in.Through}
}

// generator is the feature's service on an in-memory AI integration whose
// LLM is the flags' (environment-owned: ready with no test), switched on.
func generator(base, model, keyFile string, tokens int) (*handoffllm.Service, error) {
	svc, err := ai.New(ai.Options{Env: ai.Overrides{LLMBaseURL: base, LLMModel: model, LLMKeyFile: keyFile}})
	if err != nil {
		return nil, err
	}
	if st := svc.State(ai.RoleLLM); st != ai.StateReady {
		return nil, fmt.Errorf("the LLM is %s: check the base URL, model and key file", st)
	}
	on := true
	gen, err := handoffllm.New(context.Background(), handoffllm.Options{Roles: svc, EnvEnabled: &on})
	if err != nil {
		return nil, err
	}
	if tokens != handoffllm.DefaultMaxTokens {
		if err := gen.Apply(context.Background(), handoffllm.Update{MaxTokens: &tokens}); err != nil {
			return nil, err
		}
	}
	return gen, nil
}

func sendOne(ctx context.Context, gen *handoffllm.Service, path, flagged string, budget int, focus, outDir, model string) *Sent {
	s := &Sent{Model: model}
	in, _, err := snapshot(path, harnessOf(path, flagged), budget)
	if err != nil {
		s.Reason = err.Error()
		return s
	}
	p, err := handoffllm.Reduce(ctx, in)
	if err != nil {
		s.Reason = err.Error()
		return s
	}
	pr, err := handoffllm.Build(facts(in), p, focus)
	if err != nil {
		s.Reason = err.Error()
		return s
	}
	res, err := gen.Generate(ctx, pr.Messages)
	s.LatencyMS, s.AnswerBytes, s.Diag = res.Elapsed.Milliseconds(), res.Answer, res.Diag
	if err != nil {
		s.Reason = handoffllm.Reason(err) + ": " + err.Error()
		return s
	}
	s.Valid = true
	if outDir != "" {
		name := filepath.Join(outDir, strings.TrimSuffix(filepath.Base(path), ".jsonl")+".md")
		if err := os.WriteFile(name, []byte(res.Doc), 0o600); err == nil {
			s.Out = name
		}
	}
	return s
}

func table(w io.Writer, rows []Row) {
	fmt.Fprintf(w, "%-8s %10s %8s %9s %9s %9s %7s %4s %10s %8s  %s\n", "harness", "file", "payload", "est_tok", "prompt", "kept", "omit", "gaps", "compaction", "ms", "redactions / error  file")
	for _, r := range rows {
		if r.Error != "" {
			fmt.Fprintf(w, "%-8s %10d %8s %9s %9s %9s %7s %4s %10s %8d  %s  %s\n", r.Harness, r.FileBytes, "-", "-", "-", "-", "-", "-", "-", r.ReduceMS, "error: "+r.Error, filepath.Base(r.File))
			continue
		}
		var red []string
		for k, n := range r.Redactions {
			red = append(red, fmt.Sprintf("%s=%d", k, n))
		}
		sort.Strings(red)
		fmt.Fprintf(w, "%-8s %10d %8d %9d %9d %4d/%-4d %7d %4d %10s %8d  %s  %s\n", r.Harness, r.FileBytes, r.Payload, r.EstTokens, r.PromptBytes,
			r.Kept, r.Messages, r.Omitted, r.Gaps, r.Compaction, r.ReduceMS, strings.Join(red, ","), filepath.Base(r.File))
		if s := r.Sent; s != nil {
			fmt.Fprintf(w, "         sent to %s: %d ms, %d bytes, valid %v %s\n", s.Model, s.LatencyMS, s.AnswerBytes, s.Valid, s.Reason)
		}
	}
}
