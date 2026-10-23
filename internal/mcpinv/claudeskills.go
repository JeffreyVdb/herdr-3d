package mcpinv

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Bounds of the skill folders a Claude read looks at.
const (
	maxSkillDirs   = 1000     // entries of one skills dir
	maxSkills      = 2000     // skills of one read
	maxSkillHeader = 64 << 10 // bytes of a SKILL.md read for its front matter
)

// skillRoot is one skills dir and what its skills are.
type skillRoot struct {
	dir, source, plugin string
}

// skills are the SKILL.md skills Claude Code would find for cwd: the
// managed dir's, the user's, .claude/skills of cwd and each ancestor up to
// the repository root (a dir holding .git), and the enabled plugins'. Only
// <root>/<name>/SKILL.md counts: built-in commands, legacy commands and MCP
// prompts are never skills here.
func (r *claudeRead) skills(plugins []plugin) proto.MCPSkills {
	out := proto.MCPSkills{State: proto.MCPStateOK, Note: noteSkills, Items: []proto.MCPSkill{}, Errors: []proto.MCPSkillError{}}
	var roots []skillRoot
	if r.f.Managed != "" {
		roots = append(roots, skillRoot{dir: filepath.Join(r.f.Managed, ".claude", "skills"), source: proto.MCPSourceAdmin})
	}
	roots = append(roots, skillRoot{dir: filepath.Join(r.f.Dir, "skills"), source: proto.MCPSourceUser})
	if r.cwd != "" {
		for d := filepath.Clean(r.cwd); ; {
			roots = append(roots, skillRoot{dir: filepath.Join(d, ".claude", "skills"), source: proto.MCPSourceProject})
			if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
				break
			}
			parent := filepath.Dir(d)
			if parent == d {
				break
			}
			d = parent
		}
	}
	for _, p := range plugins {
		roots = append(roots, skillRoot{dir: filepath.Join(p.root, "skills"), source: proto.MCPSourcePlugin, plugin: p.name})
	}
	seen := map[string]bool{}
	for _, root := range roots {
		entries, err := os.ReadDir(root.dir)
		if err != nil {
			if !os.IsNotExist(err) {
				out.Errors = append(out.Errors, proto.MCPSkillError{Where: Display(r.f.Home, root.dir), Message: "Unreadable skills folder"})
			}
			continue
		}
		if len(entries) > maxSkillDirs {
			entries = entries[:maxSkillDirs]
			out.State = proto.MCPStatePartial
		}
		for _, e := range entries {
			dir := filepath.Join(root.dir, e.Name())
			if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
				continue
			}
			if len(out.Items) >= maxSkills {
				out.State = proto.MCPStatePartial
				return out
			}
			skill, ok, bad := readSkill(dir, root)
			where := Display(r.f.Home, dir)
			if bad != "" {
				out.Errors = append(out.Errors, proto.MCPSkillError{Where: where, Message: bad})
				continue
			}
			if !ok {
				continue
			}
			skill.Where = where
			if root.plugin != "" {
				skill.Name = root.plugin + ":" + skill.Name
			} else if r.overrides[skill.Name] == "off" { // plugin skills are not overridden
				skill.Enabled = ptr(false)
			}
			if key := skill.Source + "\x00" + skill.Name; !seen[key] {
				seen[key] = true
				out.Items = append(out.Items, skill)
			}
		}
	}
	return out
}

// readSkill reads dir/SKILL.md's front matter. ok is false when dir has no
// SKILL.md; bad is a category when it has one that cannot be used.
func readSkill(dir string, root skillRoot) (skill proto.MCPSkill, ok bool, bad string) {
	f, err := os.Open(filepath.Join(dir, "SKILL.md"))
	if os.IsNotExist(err) {
		return skill, false, ""
	}
	if err != nil {
		return skill, false, "Unreadable SKILL.md"
	}
	defer f.Close()
	head := make([]byte, maxSkillHeader)
	n, _ := f.Read(head)
	front := frontMatter(head[:n])
	name := cleanName(front["name"])
	if name == "" {
		name = cleanName(filepath.Base(dir))
	}
	if name == "" {
		return skill, false, "Unusable skill name"
	}
	inv := proto.MCPInvocationBoth
	user, model := !isFalse(front["user-invocable"]), !isTrue(front["disable-model-invocation"])
	switch {
	case user && !model:
		inv = proto.MCPInvocationUserOnly
	case !user && model:
		inv = proto.MCPInvocationModelOnly
	case !user && !model:
		inv = proto.MCPInvocationUnknown
	}
	return proto.MCPSkill{Name: name, Description: cleanText(front["description"]), Source: root.source, Plugin: root.plugin,
		Enabled: ptr(true), Invocation: inv}, true, ""
}

func isTrue(v string) bool  { b, err := strconv.ParseBool(v); return err == nil && b }
func isFalse(v string) bool { b, err := strconv.ParseBool(v); return err == nil && !b }

// frontMatter reads the top-level scalar keys of a Markdown file's YAML
// front matter (between "---" lines at its start): quoted or plain values,
// and folded or literal blocks (">", "|") joined by spaces. Anything else is
// skipped: only name, description and the two invocation flags are used.
func frontMatter(b []byte) map[string]string {
	out := map[string]string{}
	s := bufio.NewScanner(bytes.NewReader(b))
	s.Buffer(make([]byte, 0, 4096), maxSkillHeader)
	if !s.Scan() || strings.TrimSpace(s.Text()) != "---" {
		return out
	}
	key, block := "", false
	for s.Scan() {
		line := s.Text()
		if strings.TrimSpace(line) == "---" {
			break
		}
		if block {
			if line == "" || line[0] == ' ' || line[0] == '\t' {
				out[key] = strings.TrimSpace(out[key] + " " + strings.TrimSpace(line))
				continue
			}
			block = false
		}
		if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' {
			continue
		}
		k, v, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		key, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch {
		case v == ">" || v == "|" || v == ">-" || v == "|-" || v == ">+" || v == "|+":
			out[key], block = "", true
		case len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"'):
			if u, err := strconv.Unquote(v); err == nil {
				v = u
			} else {
				v = v[1 : len(v)-1]
			}
			out[key] = v
		case len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'':
			out[key] = strings.ReplaceAll(v[1:len(v)-1], "''", "'")
		default:
			if i := strings.Index(v, " #"); i >= 0 {
				v = strings.TrimSpace(v[:i])
			}
			out[key] = v
		}
	}
	return out
}
