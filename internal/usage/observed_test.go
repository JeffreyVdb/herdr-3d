package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func codexRollout(t *testing.T, body string) (*Session, string) {
	t.Helper()
	dir := t.TempDir()
	rollout := filepath.Join(dir, "2026", "10", "19", "rollout-x-"+codexID+".jsonl")
	writeFile(t, rollout, body)
	return NewSession(Codex, codexID, Roots{CodexSessions: dir}, DefaultPricing()), rollout
}

// H3D-2: Codex's model and effort come from the latest turn_context (the
// top-level effort, else the collaboration mode's reasoning effort); a turn
// that states none leaves the effort unknown, never the last turn's.
func TestCodexObservedEffort(t *testing.T) {
	fixture, err := os.ReadFile("testdata/codex-turn-context.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	s, rollout := codexRollout(t, string(fixture))
	if u := poll(t, s, t0); u.Model != "gpt-6.1-sol" || u.Effort != "medium" {
		t.Fatalf("fixture: model %q effort %q", u.Model, u.Effort)
	}
	// Nested only: the fallback.
	appendFile(t, rollout, `{"type":"turn_context","payload":{"model":"gpt-6.1-sol","collaboration_mode":{"settings":{"reasoning_effort":"HIGH"}}}}`+"\n")
	if u := poll(t, s, t0.Add(time.Second)); u.Effort != "high" {
		t.Fatalf("nested effort = %q", u.Effort)
	}
	// Top-level wins over the nested one.
	appendFile(t, rollout, `{"type":"turn_context","payload":{"model":"gpt-6.1-luna","effort":"low","collaboration_mode":{"settings":{"reasoning_effort":"high"}}}}`+"\n")
	if u := poll(t, s, t0.Add(2*time.Second)); u.Model != "gpt-6.1-luna" || u.Effort != "low" {
		t.Fatalf("both: model %q effort %q", u.Model, u.Effort)
	}
	// A turn that states no effort, and one whose value is not an effort level.
	appendFile(t, rollout, `{"type":"turn_context","payload":{"model":"gpt-6.1-luna"}}`+"\n")
	if u := poll(t, s, t0.Add(3*time.Second)); u.Model != "gpt-6.1-luna" || u.Effort != "" {
		t.Fatalf("none: model %q effort %q", u.Model, u.Effort)
	}
	appendFile(t, rollout, `{"type":"turn_context","payload":{"model":"gpt-6.1-luna","effort":"very high!"}}`+"\n")
	if u := poll(t, s, t0.Add(4*time.Second)); u.Effort != "" {
		t.Fatalf("bad effort = %q", u.Effort)
	}
}

func claudeMain(t *testing.T, body string) (*Session, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "p", claudeID+".jsonl")
	writeFile(t, path, body)
	return NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing()), path
}

// withEffort adds Claude Code's top-level effort field to an assistant line.
func withEffort(line, effort string) string {
	return strings.Replace(line, `{"type":"assistant",`, `{"type":"assistant","effort":"`+effort+`","perTurnEffort":"`+effort+`",`, 1)
}

// H3D-2: Claude's effort is the main thread's last assistant line that
// records one; a line without it (an older Claude Code, a sidechain's)
// leaves it unknown or as it was.
func TestClaudeObservedEffort(t *testing.T) {
	s, path := claudeMain(t, assistant("m1", "claude-opus-5-5", "", 10, 1, 0, 0))
	if u := poll(t, s, t0); u.Model != "claude-opus-5-5" || u.Effort != "" {
		t.Fatalf("no effort recorded: model %q effort %q", u.Model, u.Effort)
	}
	appendFile(t, path, withEffort(assistant("m2", "claude-opus-5-5[1m]", "", 10, 1, 0, 0), "xhigh"))
	if u := poll(t, s, t0.Add(time.Second)); u.Model != "claude-opus-5-5[1m]" || u.Effort != "xhigh" {
		t.Fatalf("recorded: model %q effort %q", u.Model, u.Effort)
	}
	appendFile(t, path, withEffort(assistant("m3", "claude-opus-5-5", "", 10, 1, 0, 0), "medium"))
	if u := poll(t, s, t0.Add(2*time.Second)); u.Effort != "medium" {
		t.Fatalf("changed: effort %q", u.Effort)
	}
	// A sidechain line in the main file does not move it.
	side := withEffort(assistant("m4", "claude-haiku-5-5", "", 10, 1, 0, 0), "low")
	appendFile(t, path, strings.Replace(side, `{"type":"assistant",`, `{"type":"assistant","isSidechain":true,`, 1))
	if u := poll(t, s, t0.Add(3*time.Second)); u.Effort != "medium" {
		t.Fatalf("after a sidechain line: effort %q", u.Effort)
	}
}

func TestCleanModel(t *testing.T) {
	for in, want := range map[string]string{
		"gpt-6.1-sol": "gpt-6.1-sol", "claude-opus-5-5[1m]": "claude-opus-5-5", " claude-opus-5-5 ": "claude-opus-5-5",
		"<synthetic>": "", "": "", "[1m]": "", "bad\x1bid": "", strings.Repeat("m", 81): "",
	} {
		if got := CleanModel(in); got != want {
			t.Errorf("CleanModel(%q) = %q, want %q", in, got, want)
		}
	}
}
