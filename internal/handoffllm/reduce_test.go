package handoffllm

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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
		// A run that has not finished, a result with nothing in it, one that
		// says neither pass nor fail, and a call with no result are never
		// verified: the absence of a failure is not a success.
		{"claude_background", "claude_background", harnessClaude, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, "[tool] Bash: go test ./... -> running", "| Command running in background with ID: bsynth01",
				"[tool] Bash: make test-quiet -> no output", "[tool] Bash: pytest -q -> outcome unknown", "Tests are still running")
			hasNot(t, p.Text, "-> ok")
			for _, w := range []Artifact{{"test", "go test ./...", false}, {"test", "make test-quiet", false}, {"test", "pytest -q", false},
				{"file", "src/slow.go", false}} {
				if a, ok := artifact(p, w.Kind, w.Ref); !ok || a.Verified != w.Verified {
					t.Errorf("artifact %+v: got %+v %v", w, a, ok)
				}
			}
		}},
		{"codex_running", "codex_running", harnessCodex, 64 << 10, func(t *testing.T, p Payload) {
			has(t, p.Text, `[tool] exec_command: go test ./... -> running`, "| Process running with session ID 456",
				"[tool] exec_command: make test -> ok", "Tests are still running.")
			// A pass line in a run's partial output is not its outcome; the
			// harness's exit 0 is.
			for _, w := range []Artifact{{"test", "go test ./...", false}, {"test", "make test", true}} {
				if a, ok := artifact(p, w.Kind, w.Ref); !ok || a.Verified != w.Verified {
					t.Errorf("artifact %+v: got %+v %v", w, a, ok)
				}
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

// TestReadEvidenceOutcome: a result's outcome is positive only on terminal
// evidence of success; running, empty or silent results are unknown.
func TestReadEvidenceOutcome(t *testing.T) {
	cases := []struct {
		name, text   string
		failed       bool
		status       string
		ok, passed   bool
		keepsRunning bool
	}{
		{"exit 0", "Process exited with code 0\nOutput:\n", false, statusOK, true, true, false},
		{"pass line", "ok  \texample.com/p\t0.02s", false, statusOK, true, true, false},
		{"edit", "The file src/a.go has been updated successfully.", false, statusOK, true, false, false},
		{"commit", "[main 1a2b3c4] fix: x\n 1 file changed", false, statusOK, true, false, false},
		{"codex running", "Chunk ID: a\nWall time: 30.0 seconds\nProcess running with session ID 456\nOutput:\nok  \tp\t0.1s\n", false, statusRunning, false, false, true},
		{"claude background", "Command running in background with ID: b1. Output is being written to: /tmp/x", false, statusRunning, false, false, true},
		{"no output", "", false, statusNoOutput, false, false, false},
		{"silent", "collected 12 items", false, statusNoOutcome, false, false, false},
		{"harness error", "boom", true, statusError, false, false, false},
		{"exit 1", "Exit code 1\nok  \tp\t0.1s", false, "exit 1", false, false, false},
		{"failure line", "--- FAIL: TestX (0.00s)", false, statusFailed, false, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ev := readEvidence(c.text, c.failed)
			if ev.status != c.status || ev.ok() != c.ok || ev.testPassed() != c.passed {
				t.Errorf("status %q ok %v passed %v; want %q %v %v", ev.status, ev.ok(), ev.testPassed(), c.status, c.ok, c.passed)
			}
			if c.keepsRunning && !slices.ContainsFunc(ev.lines, func(l string) bool { return runningLine.MatchString(l) }) {
				t.Errorf("the running line was not kept: %q", ev.lines)
			}
		})
	}
}

// codexRun is a synthetic Codex transcript of one turn: an apply_patch
// edit of main.go and a shell command (go test, git commit, gh pr create),
// each with its output and an exec_command_end carrying its exit, the exit
// before the output when exitFirst.
func codexRun(t *testing.T, prompt, patchOut, cmdOut string, exit int, exitFirst bool) string {
	t.Helper()
	cmd := `go test ./... && git commit -am "fix" && gh pr create --fill`
	args, _ := json.Marshal(map[string]string{"cmd": cmd})
	rows := []map[string]any{
		{"type": "session_meta", "payload": map[string]any{"id": "00000000-0000-4000-8000-0000000000ee", "source": "cli"}},
		{"type": "response_item", "payload": map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": prompt}}}},
	}
	call := func(id string, item, out map[string]any) {
		end := map[string]any{"type": "event_msg", "payload": map[string]any{"type": "exec_command_end", "call_id": id, "exit_code": exit}}
		item["call_id"], out["call_id"] = id, id
		rows = append(rows, map[string]any{"type": "response_item", "payload": item})
		if exitFirst {
			rows = append(rows, end)
		}
		rows = append(rows, map[string]any{"type": "response_item", "payload": out})
		if !exitFirst {
			rows = append(rows, end)
		}
	}
	call("call_p",
		map[string]any{"type": "custom_tool_call", "name": "apply_patch", "input": "*** Begin Patch\n*** Update File: main.go\n@@\n-a\n+b\n*** End Patch\n"},
		map[string]any{"type": "custom_tool_call_output", "output": patchOut})
	call("call_c",
		map[string]any{"type": "function_call", "name": "exec_command", "arguments": string(args)},
		map[string]any{"type": "function_call_output", "output": cmdOut})
	rows = append(rows, map[string]any{"type": "response_item", "payload": map[string]any{"type": "message", "role": "assistant", "phase": "final_answer", "content": []any{map[string]any{"type": "output_text", "text": "Done: see the command output."}}}})
	var b []byte
	for _, r := range rows {
		l, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		b = append(append(b, l...), '\n')
	}
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

const (
	runCmd    = `go test ./... && git commit -am "fix" && gh pr create --fill`
	runCommit = "1a2b3c4"
	runPR     = "https://github.com/example/app/pull/42"
)

// TestReduceExitOrderSettlesAlike: a call's exit (Codex's exec_command_end)
// may come before or after its output; either way the call settles the same
// — its edit and test verified only on success, a failure in the output or
// a non-zero exit winning over any success — and the commits and pull
// requests its output shows are kept, verified.
func TestReduceExitOrderSettlesAlike(t *testing.T) {
	const (
		patched = "Success. Updated the following files:\nM main.go\n"
		shipped = "ok  \texample.com/app\t0.10s\n[main " + runCommit + "] fix\n 1 file changed\n" + runPR + "\n"
	)
	cases := []struct {
		name             string
		patchOut, cmdOut string
		exit             int
		ok               bool
	}{
		{"success", patched, shipped, 0, true},
		{"empty output, exit 0", "", "[main " + runCommit + "] fix\n" + runPR + "\n", 0, true},
		{"failure despite exit 0", "apply_patch verification failed: no such hunk", "--- FAIL: TestX (0.00s)\n[main " + runCommit + "] fix\n" + runPR + "\n", 0, false},
		{"success despite exit 1", patched, shipped, 1, false},
	}
	for _, c := range cases {
		var settled []Artifact
		for _, exitFirst := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/exitFirst=%v", c.name, exitFirst), func(t *testing.T) {
				p, err := reduceFile(t, harnessCodex, codexRun(t, "Fix it and open a PR.", c.patchOut, c.cmdOut, c.exit, exitFirst), 64<<10)
				if err != nil {
					t.Fatal(err)
				}
				for _, want := range []Artifact{
					{"file", "main.go", c.ok}, {"test", runCmd, c.ok},
					{"commit", runCommit, true}, {"pr", runPR, true},
				} {
					if a, ok := artifact(p, want.Kind, want.Ref); !ok || a.Verified != want.Verified {
						t.Errorf("%s %s: got %+v (found %v), want verified %v", want.Kind, want.Ref, a, ok, want.Verified)
					}
				}
				if settled != nil && !slices.Equal(p.Artifacts, settled) {
					t.Errorf("artifacts differ by event order:\n%+v\n%+v", settled, p.Artifacts)
				}
				settled = p.Artifacts
			})
		}
	}
}

// TestReduceExitFirstArtifactsSurviveBudget: when the budget leaves the
// tool evidence out of the Text, the commit and pull request the output
// showed are still artifacts (the facts the prompt is told), whichever of
// exit and output came first.
func TestReduceExitFirstArtifactsSurviveBudget(t *testing.T) {
	const budget = 16 << 10
	// Long enough that the pinned prompt and final reply leave no room for
	// the tool evidence, short enough that they fit (~1455-1480 repeats).
	prompt := "Fix it and open a PR." + strings.Repeat(" constraint", 1470)
	shipped := "ok  \texample.com/app\t0.10s\n[main " + runCommit + "] fix\n" + runPR + "\n"
	for _, exitFirst := range []bool{false, true} {
		t.Run(fmt.Sprintf("exitFirst=%v", exitFirst), func(t *testing.T) {
			p, err := reduceFile(t, harnessCodex, codexRun(t, prompt, "Success. Updated the following files:\nM main.go\n", shipped, 0, exitFirst), budget)
			if err != nil {
				t.Fatal(err)
			}
			hasNot(t, p.Text, runCommit, "/pull/42")
			if len(p.Coverage.Omitted) == 0 {
				t.Errorf("nothing omitted: %+v", p.Coverage)
			}
			for _, want := range []Artifact{{"file", "main.go", true}, {"test", runCmd, true}, {"commit", runCommit, true}, {"pr", runPR, true}} {
				if a, ok := artifact(p, want.Kind, want.Ref); !ok || !a.Verified {
					t.Errorf("lost verified %s %s: %+v", want.Kind, want.Ref, p.Artifacts)
				}
			}
		})
	}
}
