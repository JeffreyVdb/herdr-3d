package handoffllm

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the reducer's golden files")

// reduceFile reduces a whole fixture (the snapshot ends at its end).
func reduceFile(t *testing.T, harness, path string, budget int, secrets ...string) (Payload, error) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return Reduce(context.Background(), Input{Harness: harness, Path: path, File: fi, Through: fi.Size(), Budget: budget, Secrets: secrets})
}

// goldenOf is what a golden file pins: the Text, then the coverage,
// artifacts and redactions.
func goldenOf(p Payload) string {
	meta := struct {
		Bytes, EstTokens int
		Coverage         Coverage
		Artifacts        []Artifact
		Redactions       map[string]int
	}{p.Bytes, p.EstTokens, p.Coverage, p.Artifacts, p.Redactions}
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		panic(err)
	}
	return p.Text + "\n\n-------- coverage --------\n" + string(b) + "\n"
}

func checkGolden(t *testing.T, name string, p Payload) {
	t.Helper()
	path := filepath.Join("testdata", name+".golden")
	got := goldenOf(p)
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -update)", err)
	}
	if got != string(want) {
		t.Errorf("%s differs from %s (run go test -update and review the diff):\n%s", name, path, got)
	}
}

func has(t *testing.T, text string, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if !strings.Contains(text, s) {
			t.Errorf("Text lacks %q", s)
		}
	}
}

func hasNot(t *testing.T, text string, subs ...string) {
	t.Helper()
	for _, s := range subs {
		if strings.Contains(text, s) {
			t.Errorf("Text holds %q", s)
		}
	}
}

func artifact(p Payload, kind, ref string) (Artifact, bool) {
	for _, a := range p.Artifacts {
		if a.Kind == kind && a.Ref == ref {
			return a, true
		}
	}
	return Artifact{}, false
}

func TestReduceGolden(t *testing.T) {
	cases := []struct {
		name, fixture, harness string
		budget                 int
		check                  func(t *testing.T, p Payload)
	}{
		{"claude_branch", "claude_branch", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "Goal: add a --dry-run flag", "Rewind: don't delete anything", "[tool] Edit: /work/fixture/deploy.sh -> ok")
			hasNot(t, p.Text, "Also delete the old logs", "Deleting logs/", "Subagent task", "deploy.sh, build.sh", "SYNTHETICSIGNATURE")
			c := p.Coverage
			if c.Abandoned != 2 || c.Sidechains != 2 || c.Messages != 5 || !c.Complete {
				t.Errorf("coverage %+v", c)
			}
			if a, ok := artifact(p, "file", "/work/fixture/deploy.sh"); !ok || !a.Verified {
				t.Errorf("deploy.sh artifact %+v %v", a, ok)
			}
		}},
		{"claude_streamed", "claude_streamed", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			if strings.Count(p.Text, "Running the suite.") != 1 || strings.Count(p.Text, "[tool] Bash: go test ./...") != 2 {
				t.Errorf("streamed message not merged once:\n%s", p.Text)
			}
			has(t, p.Text, "--- FAIL: TestParse", "ok example.com/p 0.02s")
			if p.Coverage.Deduplicated != 4 || p.Coverage.Messages != 5 {
				t.Errorf("coverage %+v", p.Coverage)
			}
			if a, _ := artifact(p, "test", "go test ./..."); !a.Verified {
				t.Errorf("the last test run passed: %+v", p.Artifacts)
			}
		}},
		{"claude_evidence", "claude_evidence", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "Exit code 2", "error: undefined: cfg", "[1 image omitted]", "[fix/build 3f2a9c1] fix: define cfg",
				"https://github.com/example/app/pull/42", "12 passed, 0 failed", "[redacted:secret_assignment]", "[redacted:url_credentials]")
			hasNot(t, p.Text, "compiling module", "=== RUN", "SYNTHETICPNG", "iVBORw0KGgo", "hunter2hunter2", "S3cr3tPw", "Synthetic reminder")
			for _, w := range []Artifact{{"file", "src/app.go", true}, {"commit", "3f2a9c1", true}, {"pr", "https://github.com/example/app/pull/42", true},
				{"test", "make build && make test", true}} {
				if a, ok := artifact(p, w.Kind, w.Ref); !ok || a.Verified != w.Verified {
					t.Errorf("artifact %+v: got %+v %v", w, a, ok)
				}
			}
		}},
		{"claude_correction", "claude_correction", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			if !p.Coverage.Complete || p.Coverage.Kept != p.Coverage.Messages {
				t.Errorf("coverage %+v", p.Coverage)
			}
		}},
		{"claude_correction_tight", "claude_correction", harnessClaude, 1400, func(t *testing.T, p Payload) {
			has(t, p.Text, "Goal: write a CSV exporter", "Correction: use semicolons", "And quote every field.",
				"Exporter done: semicolon-separated", "=== omitted #")
			if p.Coverage.Complete || len(p.Coverage.Omitted) == 0 || p.Bytes > 1400 {
				t.Errorf("coverage %+v bytes %d", p.Coverage, p.Bytes)
			}
		}},
		{"claude_compaction", "claude_compaction", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "user (before compaction)", "Goal: migrate the settings page", "=== #2 compaction summary",
				"Now wire the submit handler.")
			hasNot(t, p.Text, "Migrated the text fields.", "Conversation compacted")
			if strings.Count(p.Text, "Keep the validation messages exactly") != 1 {
				t.Error("the identical prompt before the summary was not deduplicated")
			}
			c := p.Coverage
			if c.Compaction != CompactionClaudeSummary || len(c.Gaps) != 0 || c.Deduplicated != 1 || c.Abandoned != 0 {
				t.Errorf("coverage %+v", c)
			}
		}},
		{"claude_compaction_tight", "claude_compaction", harnessClaude, 520, func(t *testing.T, p Payload) {
			has(t, p.Text, "Now wire the submit handler.", "Submit handler wired")
			if p.Bytes > 520 {
				t.Errorf("bytes %d", p.Bytes)
			}
		}},
		{"claude_compaction_missing", "claude_compaction_missing", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "Goal: migrate the settings page", "Migrated the text fields.", "note: conversation compacted here")
			if c := p.Coverage; c.Compaction != CompactionMissing || len(c.Gaps) != 1 || c.Complete {
				t.Errorf("coverage %+v", c)
			}
		}},
		{"claude_legacy", "claude_legacy", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "Add a README section", "[tool] Write: README.md -> ok", "README now documents configuration.")
			if a, _ := artifact(p, "file", "README.md"); !a.Verified {
				t.Errorf("artifacts %+v", p.Artifacts)
			}
		}},
		{"codex_dedup", "codex_dedup", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			if strings.Count(p.Text, "Rename the config flag") != 1 || strings.Count(p.Text, "Searching for --verbose.") != 1 {
				t.Errorf("event copies not deduplicated:\n%s", p.Text)
			}
			has(t, p.Text, "assistant (final reply)", "Renamed --verbose to --debug in main.go.", "[tool] apply_patch: main.go -> ok", "M main.go")
			hasNot(t, p.Text, "AGENTS.md", "permissions", "SYNTHETICENCRYPTED", "Synthetic agents")
			if p.Coverage.Deduplicated != 2 || p.Coverage.Messages != 3 {
				t.Errorf("coverage %+v", p.Coverage)
			}
			if a, _ := artifact(p, "file", "main.go"); !a.Verified {
				t.Errorf("artifacts %+v", p.Artifacts)
			}
		}},
		{"codex_fork", "codex_fork", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			hasNot(t, p.Text, "Parent task", "Parent reply")
			has(t, p.Text, "Fork: try the TTL variant", "TTL cache implemented")
			if len(p.Coverage.Gaps) != 1 || p.Coverage.Messages != 2 {
				t.Errorf("coverage %+v", p.Coverage)
			}
		}},
		{"codex_compacted_retained", "codex_compacted_retained", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "Ported the lexer.", "user (kept across compaction)", "Also: benchmark it against the old one.")
			hasNot(t, p.Text, "SYNTHETICCOMPACTION", "permissions")
			if strings.Count(p.Text, "Goal: port the parser to Go.") != 1 {
				t.Error("the retained copy of a prompt read earlier was not deduplicated")
			}
			if c := p.Coverage; c.Compaction != CompactionCodexRetained || len(c.Gaps) != 0 || c.Deduplicated != 1 || !c.Complete {
				t.Errorf("coverage %+v", c)
			}
		}},
		{"codex_compacted_opaque", "codex_compacted_opaque", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "Goal: add retries", "Added exponential backoff", "RetryAttempts is now a client option")
			if c := p.Coverage; c.Compaction != CompactionOpaque || len(c.Gaps) != 1 || c.Complete {
				t.Errorf("coverage %+v", c)
			}
		}},
		{"codex_compacted_missing", "codex_compacted_missing", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			if c := p.Coverage; c.Compaction != CompactionMissing || len(c.Gaps) != 2 {
				t.Errorf("coverage %+v", c)
			}
		}},
		{"codex_legacy", "codex_legacy", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "assistant (final reply)", "cargo test passes", "test result: FAILED. 1 passed; 1 failed", "-> error")
			if a, ok := artifact(p, "test", `{"command": ["bash", "-lc", "cargo test"]}`); !ok || !a.Verified {
				t.Errorf("artifacts %+v", p.Artifacts)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, err := reduceFile(t, c.harness, filepath.Join("testdata", c.fixture+".jsonl"), c.budget)
			if err != nil {
				t.Fatal(err)
			}
			if p.Bytes != len(p.Text) || p.Bytes > c.budget || p.EstTokens != EstimateTokens(p.Text) {
				t.Errorf("bytes %d, len %d, budget %d, tokens %d", p.Bytes, len(p.Text), c.budget, p.EstTokens)
			}
			c.check(t, p)
			checkGolden(t, c.name, p)
			again, err := reduceFile(t, c.harness, filepath.Join("testdata", c.fixture+".jsonl"), c.budget)
			if err != nil || goldenOf(again) != goldenOf(p) {
				t.Errorf("not deterministic: %v", err)
			}
		})
	}
}

// TestReducePinnedContentNeverLost: at every budget, the reduction either
// fits and holds every user message and the final reply whole, or refuses
// with ErrTooLarge.
func TestReducePinnedContentNeverLost(t *testing.T) {
	fixtures := map[string]string{
		"claude_correction": harnessClaude, "claude_evidence": harnessClaude, "claude_branch": harnessClaude,
		"claude_streamed": harnessClaude, "codex_dedup": harnessCodex, "codex_compacted_retained": harnessCodex,
	}
	for name, harness := range fixtures {
		path := filepath.Join("testdata", name+".jsonl")
		full, err := reduceFile(t, harness, path, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		pinned := pinnedBlocks(full.Text)
		fits := false
		for budget := 50; budget <= full.Bytes+10; budget += 37 {
			p, err := reduceFile(t, harness, path, budget)
			if errors.Is(err, ErrTooLarge) {
				if fits {
					t.Errorf("%s: fits at a smaller budget but not at %d", name, budget)
				}
				continue
			}
			if err != nil {
				t.Fatalf("%s at %d: %v", name, budget, err)
			}
			fits = true
			if p.Bytes > budget {
				t.Errorf("%s at %d: %d bytes", name, budget, p.Bytes)
			}
			for _, b := range pinned {
				if !strings.Contains(p.Text, b) {
					t.Errorf("%s at %d: pinned message lost: %q", name, budget, b)
				}
			}
			if len(p.Coverage.Omitted) == 0 && p.Text != full.Text {
				t.Errorf("%s at %d: Text reduced without an omitted range", name, budget)
			}
		}
		if !fits {
			t.Errorf("%s: never fits", name)
		}
	}
}

// pinnedBlocks are the user messages' and the final reply's text in a Text.
func pinnedBlocks(text string) []string {
	var out []string
	for _, block := range strings.Split(text, "\n\n=== ") {
		header, body, _ := strings.Cut(block, " ===\n")
		if strings.Contains(header, " user") || strings.Contains(header, "(final reply)") {
			body, _, _ = strings.Cut(body, "\n[tool")
			out = append(out, strings.TrimSpace(body))
		}
	}
	return out
}
