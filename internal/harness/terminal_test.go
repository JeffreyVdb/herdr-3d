package harness

import (
	"encoding/json"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func TestTerminalOnly(t *testing.T) {
	for _, c := range []struct {
		kind, text string
		want       bool
	}{
		// Claude: modal dialogs, whatever follows the name.
		{"claude", "/usage", true},
		{"claude", "/cost", true},
		{"claude", "/stats", true},
		{"claude", "/status", true},
		{"claude", "/config", true},
		{"claude", "/mcp", true},
		{"claude", "/help", true},
		{"claude", "/help me", true},
		{"claude", "  /usage  \n", true},
		// /model: the picker only when bare; with a model it is inline.
		{"claude", "/model", true},
		{"claude", "/model   ", true},
		{"claude", "/model opus", false},
		{"claude", "/model\nopus", false},
		// R2: the name ends at its first whitespace, of any kind; all of
		// what follows is the argument.
		{"claude", "/model\t opus", false},
		{"claude", "/model \topus", false},
		{"claude", "/model\topus", false},
		{"claude", "/model\r\nopus", false},
		{"claude", "/model\u00a0opus", false},
		{"claude", "/model\u3000opus", false},
		{"claude", "/model\t \n", true},
		{"claude", "/usage\tnow", true},
		// Inline or prose: not terminal-only.
		{"claude", "/context", false},
		{"claude", "/compact", false},
		{"claude", "please run /usage", false},
		{"claude", "/usage-report", false},
		{"claude", "/usages", false},
		{"claude", "/Usage", false},
		{"claude", "usage", false},
		{"claude", "", false},
		{"claude", "/", false},
		// Codex: nothing of these reaches the rollout.
		{"codex", "/status", true},
		{"codex", "/diff", true},
		{"codex", "/pwd", true},
		{"codex", "/ps", true},
		{"codex", "/mcp", true},
		{"codex", "/mcp verbose", true},
		{"codex", "/review the diff", false},
		{"codex", "/model", false},
		{"codex", "/usage", false},
		// A skill is $name to Codex: a typed "$status" is not the built-in.
		{"codex", "$status", false},
		// Another harness: none.
		{"other", "/usage", false},
		{"", "/status", false},
	} {
		if got := TerminalOnly(c.kind, c.text); got != c.want {
			t.Errorf("TerminalOnly(%q, %q) = %v, want %v", c.kind, c.text, got, c.want)
		}
	}
}

func TestClaudeBuiltinsAreMarkedTerminalOnly(t *testing.T) {
	got := claudeEntries([]claudeCommand{
		{Name: "usage", Builtin: true},
		{Name: "model", Builtin: true, ArgumentHint: "[model]"},
		{Name: "context", Builtin: true},
		{Name: "status"}, // a skill named like a built-in: not the dialog
		{Name: "help", Builtin: true},
	}, nil)
	want := map[string]string{"usage": proto.TerminalAlways, "model": proto.TerminalBare, "context": "", "status": "", "help": proto.TerminalAlways}
	for _, e := range got {
		if e.Terminal != want[e.Name] {
			t.Errorf("%s (%s): terminal %q, want %q", e.Name, e.Kind, e.Terminal, want[e.Name])
		}
	}
}

func TestCodexBuiltinsAreMarkedTerminalOnly(t *testing.T) {
	want := map[string]string{"status": proto.TerminalAlways, "diff": proto.TerminalAlways, "pwd": proto.TerminalAlways, "ps": proto.TerminalAlways, "mcp": proto.TerminalAlways}
	for _, e := range CodexBuiltins() {
		if e.Terminal != want[e.Name] {
			t.Errorf("%s: terminal %q, want %q", e.Name, e.Terminal, want[e.Name])
		}
	}
	// A skill named like one is $name: not marked.
	var list codexSkillsList
	if err := json.Unmarshal([]byte(`{"data":[{"cwd":"/w","skills":[{"name":"status","description":"","enabled":true}]}]}`), &list); err != nil {
		t.Fatal(err)
	}
	rows, err := codexEntries(list, "/w", nil)
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Name != "status" || rows[0].Kind != proto.CommandKindSkill || rows[0].Terminal != "" {
		t.Fatalf("skill row %+v", rows[0])
	}
}
