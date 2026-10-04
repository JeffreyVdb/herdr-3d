package harness

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"syscall"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// writeFile writes an empty file at path, making its dirs.
func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("---\ndescription: x\n---\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// realDir is a fresh temp dir without symlinks in its path (the fake CLI
// reports its cwd as the kernel sees it).
func realDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

// traceLines are the fake CLI's process metadata and the lines it read.
func traceLines(t *testing.T, trace string) (meta struct {
	PID  int      `json:"pid"`
	Args []string `json:"args"`
	Cwd  string   `json:"cwd"`
}, lines []string) {
	t.Helper()
	data, err := os.ReadFile(trace)
	if err != nil {
		t.Fatal(err)
	}
	lines = strings.Split(strings.TrimSpace(string(data)), "\n")
	if err := json.Unmarshal([]byte(lines[0]), &meta); err != nil {
		t.Fatal(err)
	}
	return meta, lines[1:]
}

func TestClaudeCommands(t *testing.T) {
	// A repo with a command above its git root, one at its root, one nested,
	// and the checkout a package below the root.
	top := realDir(t)
	repo := filepath.Join(top, "repo")
	checkout := filepath.Join(repo, "pkg")
	writeFile(t, filepath.Join(top, ".claude", "commands", "above.md"))
	writeFile(t, filepath.Join(repo, ".git", "HEAD"))
	writeFile(t, filepath.Join(repo, ".claude", "commands", "anccmd.md"))
	writeFile(t, filepath.Join(checkout, ".claude", "commands", "topcmd.md"))
	writeFile(t, filepath.Join(checkout, ".claude", "commands", "sub", "nested.md"))
	writeFile(t, filepath.Join(checkout, ".claude", "skills", "handoff", "SKILL.md"))
	home := realDir(t)
	writeFile(t, filepath.Join(home, ".claude", "commands", "usercmd.md"))
	t.Setenv("HOME", home)
	// The probe's environment has no CLAUDE_* variables, so its user dir is
	// ~/.claude whatever the bridge's environment says.
	other := realDir(t)
	writeFile(t, filepath.Join(other, "commands", "handoff.md"))
	t.Setenv("CLAUDE_CONFIG_DIR", other)

	bin, trace := fakeBin(t, "claude")
	got, err := ClaudeCommands(context.Background(), bin, checkout)
	if err != nil {
		t.Fatal(err)
	}
	want := []proto.CommandEntry{
		{Name: "compact", Description: "Free up context", ArgumentHint: "<optional custom summarization instructions>", Kind: "command"},
		{Name: "usage", Description: "Show session cost", Kind: "command"},
		{Name: "review", Description: "Review a pull request", Kind: "command"},
		{Name: "handoff", Description: "Compact into a handoff document (user)", ArgumentHint: "What next?", Kind: "skill"},
		{Name: "topcmd", Description: "top cmd (project)", ArgumentHint: "<fixture>", Kind: "custom"},
		{Name: "sub:nested", Description: "nested cmd (project)", Kind: "custom"},
		{Name: "anccmd", Description: "ancestor cmd (project)", Kind: "custom"},
		{Name: "above", Description: "above the git root", Kind: "skill"},
		{Name: "usercmd", Description: "user cmd (user)", Kind: "custom"},
		{Name: "caveman:caveman-commit", Description: "(caveman) commit messages", Kind: "skill"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commands =\n%+v\nwant\n%+v", got, want)
	}
	meta, lines := traceLines(t, trace)
	if meta.Cwd != checkout {
		t.Errorf("probe cwd = %q, want the checkout %q", meta.Cwd, checkout)
	}
	if !slices.Equal(meta.Args, claudeArgs) || slices.Contains(meta.Args, "--setting-sources") || slices.Contains(meta.Args, "--disable-slash-commands") {
		t.Errorf("Claude argv = %q", meta.Args)
	}
	if len(lines) != 1 || !strings.Contains(lines[0], `"subtype":"initialize"`) {
		t.Errorf("requests = %q: only initialize, never a turn", lines)
	}
	if err := syscall.Kill(meta.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("probe still exists: %v", err)
	}
	if _, err := os.Stat(checkout); err != nil {
		t.Errorf("the checkout is not the probe's to remove: %v", err)
	}
}

func TestClaudeCommandsFailures(t *testing.T) {
	for _, scenario := range []string{"claude-nocommands", "claude-error", "malformed", "oversize"} {
		t.Run(scenario, func(t *testing.T) {
			bin, _ := fakeBin(t, scenario)
			if got, err := ClaudeCommands(context.Background(), bin, t.TempDir()); err == nil {
				t.Fatalf("accepted %+v", got)
			}
		})
	}
}

func TestClaudeConfigDir(t *testing.T) {
	for _, c := range []struct {
		env  []string
		want string
	}{
		{[]string{"HOME=/h", "CLAUDE_CONFIG_DIR=/c"}, "/c"},
		{[]string{"CLAUDE_CONFIG_DIR=", "HOME=/h"}, "/h/.claude"},
		{[]string{"PATH=/bin"}, ""},
	} {
		if got := claudeConfigDir(c.env); got != c.want {
			t.Errorf("claudeConfigDir(%q) = %q, want %q", c.env, got, c.want)
		}
	}
}

func TestCodexCommands(t *testing.T) {
	checkout := realDir(t)
	bin, trace := fakeBin(t, "codex-skills")
	got, err := CodexCommands(context.Background(), nil, bin, checkout)
	if err != nil {
		t.Fatal(err)
	}
	want := []proto.CommandEntry{
		{Name: "ask-matt", Description: "Find the right skill", Kind: "skill"},
		{Name: "legacy", Description: "legacy short", Kind: "skill"},
		{Name: "humanizer:humanizer", Description: "Remove AI writing patterns", Kind: "skill"},
		{Name: "handoff", Description: "first root", Kind: "skill"},
		{Name: "review", Description: "a skill named like a built-in", Kind: "skill"},
	}
	want = append(want, CodexBuiltins()...)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commands =\n%+v\nwant\n%+v", got, want)
	}
	meta, lines := traceLines(t, trace)
	if meta.Cwd != checkout || !slices.Equal(meta.Args, []string{"app-server"}) {
		t.Errorf("probe = %+v", meta)
	}
	if len(lines) != 3 { // initialize, initialized, skills/list
		t.Errorf("requests = %q", lines)
	}
	if err := syscall.Kill(meta.PID, 0); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("probe still exists: %v", err)
	}
}

func TestCodexCommandsFailures(t *testing.T) {
	bin, _ := fakeBin(t, "rpc-error")
	if _, err := CodexCommands(context.Background(), nil, bin, realDir(t)); err == nil {
		t.Error("a failed handshake accepted")
	}
	if _, err := CodexCommands(context.Background(), nil, bin, "relative/dir"); err == nil {
		t.Error("a relative cwd accepted")
	}
}

func TestCodexEntries(t *testing.T) {
	parse := func(s string) codexSkillsList {
		var l codexSkillsList
		if err := json.Unmarshal([]byte(s), &l); err != nil {
			t.Fatal(err)
		}
		return l
	}
	// The only group is ours even when app-server spells the cwd otherwise.
	got, err := codexEntries(parse(`{"data":[{"cwd":"/real/w","skills":[{"name":"a","description":"d","enabled":true}],"errors":[]}]}`), "/link/w", nil)
	if err != nil || got[0] != (proto.CommandEntry{Name: "a", Description: "d", Kind: "skill"}) || len(got) != 1+len(codexBuiltins) {
		t.Errorf("single group = %+v, %v", got, err)
	}
	// Errors alone: the built-ins.
	got, err = codexEntries(parse(`{"data":[{"cwd":"/w","skills":[],"errors":[{"path":"/p","message":"m"}]}]}`), "/w", nil)
	if err != nil || !reflect.DeepEqual(got, CodexBuiltins()) {
		t.Errorf("errors only = %+v, %v", got, err)
	}
	for _, bad := range []string{`{}`, `{"data":[]}`, `{"data":[{"cwd":"/a","skills":[]},{"cwd":"/b","skills":[]}]}`} {
		if got, err := codexEntries(parse(bad), "/w", nil); err == nil {
			t.Errorf("%s accepted: %+v", bad, got)
		}
	}
}

func TestCodexBuiltins(t *testing.T) {
	got := CodexBuiltins()
	names := map[string]bool{}
	for _, c := range got {
		if c.Kind != proto.CommandKindBuiltin || c.Description == "" || names[c.Name] || strings.HasPrefix(c.Name, "/") {
			t.Errorf("built-in %+v", c)
		}
		names[c.Name] = true
	}
	for _, name := range []string{"init", "compact", "recap", "diff", "status", "pwd", "mcp", "ps", "stop", "review", "rename", "goal", "plan"} {
		if !names[name] {
			t.Errorf("no /%s", name)
		}
	}
	for _, name := range []string{"model", "quit", "exit", "logout", "side", "btw", "skills", "resume", "new", "clear"} {
		if names[name] {
			t.Errorf("/%s is not sendable as a prompt", name)
		}
	}
	got[0].Name = "changed"
	if CodexBuiltins()[0].Name == "changed" {
		t.Error("CodexBuiltins shares its list")
	}
}
