package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
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

// asSidechain marks an assistant line as a sidechain's.
func asSidechain(line string) string {
	return strings.Replace(line, `{"type":"assistant",`, `{"type":"assistant","isSidechain":true,`, 1)
}

// H3D-2: Claude's observed effort is the one the main thread's latest
// assistant line records; a line without it (an older Claude Code), or with
// one that is no level name, leaves it unknown, and a sidechain's line never
// moves it.
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
	appendFile(t, path, asSidechain(withEffort(assistant("m4", "claude-haiku-5-5", "", 10, 1, 0, 0), "low")))
	if u := poll(t, s, t0.Add(3*time.Second)); u.Effort != "medium" {
		t.Fatalf("after a sidechain line: effort %q", u.Effort)
	}
	// Nor does one without effort clear it.
	appendFile(t, path, asSidechain(assistant("m5", "claude-haiku-5-5", "", 10, 1, 0, 0)))
	if u := poll(t, s, t0.Add(4*time.Second)); u.Effort != "medium" {
		t.Fatalf("after a sidechain line without effort: effort %q", u.Effort)
	}
	// The latest main line decides: without effort it is unknown, then a line
	// that records one sets it again.
	appendFile(t, path, assistant("m6", "claude-opus-5-5", "", 10, 1, 0, 0))
	if u := poll(t, s, t0.Add(5*time.Second)); u.Effort != "" {
		t.Fatalf("latest line without effort: effort %q, want unknown", u.Effort)
	}
	appendFile(t, path, withEffort(assistant("m7", "claude-opus-5-5", "", 10, 1, 0, 0), "high"))
	if u := poll(t, s, t0.Add(6*time.Second)); u.Effort != "high" {
		t.Fatalf("recorded again: effort %q", u.Effort)
	}
	// One that is no level name leaves it unknown too.
	appendFile(t, path, withEffort(assistant("m8", "claude-opus-5-5", "", 10, 1, 0, 0), "Max Effort!"))
	if u := poll(t, s, t0.Add(7*time.Second)); u.Effort != "" {
		t.Fatalf("latest line with a bad effort: effort %q, want unknown", u.Effort)
	}
}

// H3D-2: the worker's model is the main thread's: a sidechain line in the main
// file moves neither it nor the effort, while its tokens stay counted and the
// context window, as ever, follows the file's last line.
func TestClaudeObservedModelIgnoresSidechains(t *testing.T) {
	s, path := claudeMain(t, withEffort(assistant("m1", "claude-opus-5-5", "", 10, 1, 0, 0), "high"))
	poll(t, s, t0)
	appendFile(t, path, asSidechain(withEffort(assistant("m2", "claude-haiku-5-5", "", 10, 1, 0, 0), "low")))
	u := poll(t, s, t0.Add(time.Second))
	if u.Model != "claude-opus-5-5" || u.Effort != "high" {
		t.Fatalf("after a sidechain line: model %q effort %q, want the main thread's", u.Model, u.Effort)
	}
	if u.Input != 20 || u.Output != 2 {
		t.Fatalf("the sidechain's tokens are not counted: input %d output %d", u.Input, u.Output)
	}

	// A main file with a sidechain's lines only says nothing about the worker.
	only, _ := claudeMain(t, asSidechain(assistant("m1", "claude-opus-5-5", "", 10, 1, 0, 0)))
	if u := poll(t, only, t0); u.Model != "" || u.Effort != "" || u.Input != 10 || u.Priced != proto.PricedKnown {
		t.Fatalf("sidechain lines only: model %q effort %q input %d priced %q", u.Model, u.Effort, u.Input, u.Priced)
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
