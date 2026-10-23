package mcpinv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Secret-shaped fixture values: none of them may reach a Snapshot.
var secrets = []string{"sk-live-SECRETENV", "Bearer SECRETHEADER", "https://user:SECRETPASS@mcp.example.com/path?token=SECRETQUERY",
	"/opt/secret-command", "--secret-arg", "SECRETPLUGINENV", "/opt/project-secret", "SECRETMANAGED"}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeText(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func stdio(cmd string) map[string]any {
	return map[string]any{"type": "stdio", "command": cmd, "args": []string{"--secret-arg"}, "env": map[string]string{"TOKEN": "sk-live-SECRETENV"}}
}

func remote(kind string) map[string]any {
	return map[string]any{"type": kind, "url": "https://user:SECRETPASS@mcp.example.com/path?token=SECRETQUERY",
		"headers": map[string]string{"Authorization": "Bearer SECRETHEADER"}}
}

// claudeFixture is a home with a user config, a checkout (in a git repo, one
// level below its root) and an enabled plugin.
func claudeFixture(t *testing.T) (ClaudeFiles, string) {
	t.Helper()
	home := t.TempDir()
	repo := filepath.Join(home, "repos", "x")
	cwd := filepath.Join(repo, "sub")
	if err := os.MkdirAll(filepath.Join(repo, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	f := DefaultClaudeFiles("", home)
	f.Managed = filepath.Join(home, "etc-claude-code")
	writeJSON(t, f.JSON, map[string]any{
		"mcpServers": map[string]any{"github": remote("http"), "shadowed": stdio("/opt/secret-command"), "legacy-sse": remote("sse"),
			"untyped": map[string]any{"command": "x"}, "ws": map[string]any{"type": "ws", "url": "wss://x"}, "bad\nname": stdio("x")},
		"projects": map[string]any{
			cwd: map[string]any{
				"mcpServers":            map[string]any{"shadowed": remote("http"), "local-only": stdio("/opt/secret-command")},
				"disabledMcpServers":    []string{"github"},
				"enabledMcpjsonServers": []string{"approved"}, "disabledMcpjsonServers": []string{"rejected"},
				"hasTrustDialogAccepted": true,
			},
			"/elsewhere": map[string]any{"mcpServers": map[string]any{"other-project": stdio("x")}},
		},
	})
	writeJSON(t, filepath.Join(cwd, ".mcp.json"), map[string]any{"mcpServers": map[string]any{
		"approved": stdio("/opt/project-secret"), "pending": stdio("/opt/project-secret"), "rejected": stdio("/opt/project-secret")}})
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{
		"enabledPlugins": map[string]any{"tools@market": true, "off@market": false, "inline@market": true},
		"skillOverrides": map[string]any{"hidden": "off", "tools-skill": "off"}})
	tools, inline, off := filepath.Join(f.Dir, "plugins", "cache", "tools"), filepath.Join(f.Dir, "plugins", "cache", "inline"), filepath.Join(f.Dir, "plugins", "cache", "off")
	writeJSON(t, filepath.Join(f.Dir, "plugins", "installed_plugins.json"), map[string]any{"version": 2, "plugins": map[string]any{
		"tools@market":  []any{map[string]any{"scope": "user", "installPath": tools}},
		"inline@market": []any{map[string]any{"scope": "project", "projectPath": "/elsewhere", "installPath": "/nope"}, map[string]any{"scope": "user", "installPath": inline}},
		"off@market":    []any{map[string]any{"scope": "user", "installPath": off}},
	}})
	writeJSON(t, filepath.Join(tools, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"db": map[string]any{"command": "x", "env": map[string]string{"K": "SECRETPLUGINENV"}}}})
	writeJSON(t, filepath.Join(inline, ".claude-plugin", "plugin.json"), map[string]any{"name": "inline", "mcpServers": map[string]any{"web": remote("http")}})
	writeJSON(t, filepath.Join(off, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"never": stdio("x")}})

	writeText(t, filepath.Join(f.Dir, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: >\n  Ship it\n  to prod\nuser-invocable: true\n---\nbody\n")
	writeText(t, filepath.Join(f.Dir, "skills", "hidden", "SKILL.md"), "---\ndescription: \"Hidden one\"\n---\n")
	writeText(t, filepath.Join(f.Dir, "skills", "manual", "SKILL.md"), "---\nname: manual\ndisable-model-invocation: true\ndescription: 'It''s manual'\n---\n")
	writeText(t, filepath.Join(f.Dir, "skills", "notaskill", "README.md"), "no SKILL.md here")
	writeText(t, filepath.Join(f.Dir, "commands", "legacy.md"), "a legacy command, never a skill")
	writeText(t, filepath.Join(cwd, ".claude", "skills", "near", "SKILL.md"), "---\nname: near\nuser-invocable: false\n---\n")
	writeText(t, filepath.Join(repo, ".claude", "skills", "root", "SKILL.md"), "---\nname: root\ndescription: at the repo root\n---\n")
	writeText(t, filepath.Join(home, "repos", ".claude", "skills", "above", "SKILL.md"), "---\nname: above\n---\n")
	writeText(t, filepath.Join(tools, "skills", "tools-skill", "SKILL.md"), "---\nname: tools-skill\ndescription: from a plugin\n---\n")
	writeText(t, filepath.Join(off, "skills", "never", "SKILL.md"), "---\nname: never\n---\n")
	return f, cwd
}

type row struct{ name, source, plugin, transport, approval, status string }

func rows(p proto.MCPProvider) []row {
	var out []row
	for _, s := range p.Servers {
		out = append(out, row{s.Name, s.Source, s.Plugin, s.Transport, s.Approval, s.Status})
	}
	return out
}

func TestReadClaude(t *testing.T) {
	f, cwd := claudeFixture(t)
	p := ReadClaude(f, cwd)
	want := []row{
		{"local-only", "local", "", "stdio", "n/a", "not_checked"},
		{"shadowed", "local", "", "http", "n/a", "not_checked"},
		{"approved", "project", "", "stdio", "approved", "not_checked"},
		{"pending", "project", "", "stdio", "pending", "approval_required"},
		{"rejected", "project", "", "stdio", "rejected", "disabled"},
		{"github", "user", "", "http", "n/a", "disabled"},
		{"legacy-sse", "user", "", "sse", "n/a", "not_checked"},
		{"untyped", "user", "", "stdio", "n/a", "not_checked"},
		{"ws", "user", "", "unknown", "n/a", "not_checked"},
		{"plugin:inline:web", "plugin", "inline", "http", "n/a", "not_checked"},
		{"plugin:tools:db", "plugin", "tools", "stdio", "n/a", "not_checked"},
	}
	if got := rows(p); !reflect.DeepEqual(got, want) {
		t.Fatalf("servers =\n%v\nwant\n%v", got, want)
	}
	if p.Config.State != proto.MCPStateOK || !strings.Contains(p.Config.Note, "claude.ai connectors") || !p.Available {
		t.Fatalf("config = %+v", p.Config)
	}
	for _, s := range p.Servers {
		if s.StatusScope != proto.MCPScopeConfig || s.Enabled == nil || *s.Enabled != (s.Status != proto.MCPStatusDisabled) {
			t.Fatalf("server %+v", s)
		}
	}

	type skill struct{ name, source, plugin, inv string }
	var skills []skill
	for _, s := range p.Skills.Items {
		skills = append(skills, skill{s.Name, s.Source, s.Plugin, s.Invocation})
	}
	wantSkills := []skill{{"deploy", "user", "", "both"}, {"hidden", "user", "", "both"}, {"manual", "user", "", "user_only"},
		{"near", "project", "", "model_only"}, {"root", "project", "", "both"}, {"tools:tools-skill", "plugin", "tools", "both"}}
	if !reflect.DeepEqual(skills, wantSkills) {
		t.Fatalf("skills = %v", skills)
	}
	byName := map[string]proto.MCPSkill{}
	for _, s := range p.Skills.Items {
		byName[s.Name] = s
	}
	if d := byName["deploy"]; d.Description != "Ship it to prod" || d.Where != "~/.claude/skills/deploy" || !*d.Enabled {
		t.Fatalf("deploy = %+v", d)
	}
	if h := byName["hidden"]; *h.Enabled || h.Description != "Hidden one" {
		t.Fatalf("an overridden skill is disabled: %+v", h)
	}
	if m := byName["manual"]; m.Description != "It's manual" {
		t.Fatalf("manual = %+v", m)
	}
	if ts := byName["tools:tools-skill"]; !*ts.Enabled { // plugin skills are not overridden
		t.Fatalf("plugin skill = %+v", ts)
	}
	if p.Skills.Complete || p.Skills.State != proto.MCPStateOK || p.Skills.Note == "" {
		t.Fatalf("skills = %+v", p.Skills)
	}
	assertSafe(t, p)

	if got, ok := ClaudeUnapproved(f, cwd); !ok || !slices.Equal(got, []string{"pending", "rejected"}) {
		t.Fatalf("unapproved = %v %v", got, ok)
	}
}

// assertSafe fails when v's JSON holds a fixture secret.
func assertSafe(t *testing.T, v any) {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range secrets {
		if strings.Contains(string(b), s) || strings.Contains(string(b), strings.TrimPrefix(s, "Bearer ")) {
			t.Fatalf("%q in %s", s, b)
		}
	}
	for _, s := range []string{"SECRET", "mcp.example.com", "secret-command", "token="} {
		if strings.Contains(string(b), s) {
			t.Fatalf("%q in %s", s, b)
		}
	}
}

// User scope reads no project layer: no local or project servers, no
// project skills.
func TestReadClaudeUserScope(t *testing.T) {
	f, _ := claudeFixture(t)
	p := ReadClaude(f, "")
	for _, s := range p.Servers {
		if s.Source == proto.MCPSourceLocal || s.Source == proto.MCPSourceProject || s.Status == proto.MCPStatusDisabled {
			t.Fatalf("user scope has %+v", s)
		}
	}
	for _, s := range p.Skills.Items {
		if s.Source == proto.MCPSourceProject {
			t.Fatalf("user scope has %+v", s)
		}
	}
	if got, ok := ClaudeUnapproved(f, ""); !ok || got != nil {
		t.Fatalf("unapproved = %v", got)
	}
}

// A file that cannot be parsed makes the read partial with a note naming
// it (its display path), never an empty success.
func TestReadClaudePartial(t *testing.T) {
	f, cwd := claudeFixture(t)
	writeText(t, filepath.Join(cwd, ".mcp.json"), "{not json")
	writeText(t, filepath.Join(f.Dir, "settings.json"), "[")
	p := ReadClaude(f, cwd)
	if p.Config.State != proto.MCPStatePartial || !strings.Contains(p.Config.Note, "Could not parse ~/repos/x/sub/.mcp.json") ||
		!strings.Contains(p.Config.Note, "Could not parse ~/.claude/settings.json") {
		t.Fatalf("config = %+v", p.Config)
	}
	if len(p.Servers) == 0 {
		t.Fatal("a partial read keeps what it read")
	}
	if _, ok := ClaudeUnapproved(f, cwd); ok {
		t.Fatal("an unreadable .mcp.json leaves the unapproved servers unknown")
	}

	writeText(t, f.JSON, "{")
	if p := ReadClaude(f, cwd); p.Config.State != proto.MCPStatePartial || !strings.Contains(p.Config.Note, "~/.claude.json") {
		t.Fatalf("global config = %+v", p.Config)
	}
}

// managed-mcp.json decides alone: the others are blocked.
func TestReadClaudeManaged(t *testing.T) {
	f, cwd := claudeFixture(t)
	writeJSON(t, filepath.Join(f.Managed, "managed-mcp.json"), map[string]any{"mcpServers": map[string]any{"corp": remote("http"), "github": stdio("SECRETMANAGED")}})
	p := ReadClaude(f, cwd)
	for _, s := range p.Servers {
		managed := s.Source == proto.MCPSourceManaged
		if managed != (s.Status != proto.MCPStatusBlocked) {
			t.Fatalf("server %+v", s)
		}
		if s.Name == "github" && !managed {
			t.Fatalf("managed defines github: %+v", s)
		}
	}
	if !strings.Contains(p.Config.Note, "managed-mcp.json") {
		t.Fatalf("note = %q", p.Config.Note)
	}
	assertSafe(t, p)
}

// $CLAUDE_CONFIG_DIR holds .claude.json itself.
func TestDefaultClaudeFiles(t *testing.T) {
	if f := DefaultClaudeFiles("", "/home/u"); f.Dir != "/home/u/.claude" || f.JSON != "/home/u/.claude.json" {
		t.Fatalf("default = %+v", f)
	}
	if f := DefaultClaudeFiles("/cfg", "/home/u"); f.Dir != "/cfg" || f.JSON != "/cfg/.claude.json" {
		t.Fatalf("config dir = %+v", f)
	}
}

func TestFrontMatter(t *testing.T) {
	got := frontMatter([]byte("---\nname: x # comment\ndescription: |\n  one\n\n  two\nmetadata:\n  nested: no\nuser-invocable: \"false\"\n---\nname: body\n"))
	want := map[string]string{"name": "x", "description": "one two", "metadata": "", "user-invocable": "false"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("front = %v", got)
	}
	if len(frontMatter([]byte("no front matter\nname: x"))) != 0 {
		t.Fatal("no front matter")
	}
}
