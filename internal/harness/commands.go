package harness

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Command probes run in the worker's checkout, not a private cwd: project
// skills and .claude/commands are per project.

// ClaudeCommands lists the slash commands and skills Claude Code offers in
// dir, from the same initialize reply as Claude's models (supportedCommands()
// in the SDK).
//
// Kinds: a row marked builtin is a command. Claude does not say where an
// unmarked row comes from, so it is custom when its name matches a legacy
// command file (*.md under .claude/commands in dir or an ancestor up to the
// git root or /, or under the user's commands dir), else a skill. Plugin
// commands, synced skills and MCP prompts are therefore reported as skills.
func ClaudeCommands(ctx context.Context, bin, dir string) ([]proto.CommandEntry, error) {
	if bin == "" {
		bin = "claude"
	}
	cmds, err := probeIn(ctx, bin, dir, claudeArgs, func(s *stream) ([]claudeCommand, error) {
		var reply struct {
			Commands *[]claudeCommand `json:"commands"`
		}
		if err := s.claudeInit(&reply); err != nil {
			return nil, err
		}
		if reply.Commands == nil { // an older harness: unknown, not empty
			return nil, errors.New("Claude Code's initialize reply has no commands")
		}
		return *reply.Commands, nil
	})
	if err != nil {
		return nil, err
	}
	return claudeEntries(cmds, commandFiles(dir, probeEnv())), nil
}

// claudeCommand is the SDK's SlashCommand (aliases are not offered).
type claudeCommand struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	ArgumentHint string `json:"argumentHint"`
	Builtin      bool   `json:"builtin"`
}

// claudeEntries keeps one row per name, the builtin one when a name has
// several (the one /name runs), else the first.
func claudeEntries(cmds []claudeCommand, custom map[string]bool) []proto.CommandEntry {
	out := []proto.CommandEntry{}
	at := map[string]int{}
	for _, c := range cmds {
		name := strings.TrimPrefix(c.Name, "/")
		if name == "" {
			continue
		}
		kind := proto.CommandKindSkill
		switch {
		case c.Builtin:
			kind = proto.CommandKindBuiltin
		case custom[name]:
			kind = proto.CommandKindCustom
		}
		e := proto.CommandEntry{Name: name, Description: c.Description, ArgumentHint: c.ArgumentHint, Kind: kind}
		if i, ok := at[name]; ok {
			if c.Builtin && out[i].Kind != proto.CommandKindBuiltin {
				out[i] = e
			}
			continue
		}
		at[name] = len(out)
		out = append(out, e)
	}
	return out
}

// maxCommandFiles bounds the files looked at in one commands dir.
const maxCommandFiles = 10000

// commandFiles are the names of Claude's legacy command files seen from dir
// with the probe's environment env: .claude/commands of dir and each
// ancestor up to the git root (a dir holding .git, also a worktree's .git
// file) or /, and the user's commands dir. A nested file is namespaced by its
// dirs: sub/deeper/x.md is "sub:deeper:x" (checked against Claude Code
// 2.1.289).
func commandFiles(dir string, env []string) map[string]bool {
	names := map[string]bool{}
	var roots []string
	for d := filepath.Clean(dir); ; {
		roots = append(roots, filepath.Join(d, ".claude", "commands"))
		if _, err := os.Lstat(filepath.Join(d, ".git")); err == nil {
			break
		}
		parent := filepath.Dir(d)
		if parent == d {
			break
		}
		d = parent
	}
	if user := claudeConfigDir(env); user != "" {
		roots = append(roots, filepath.Join(user, "commands"))
	}
	for _, root := range roots {
		seen := 0
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable: skip it
			}
			if seen++; seen > maxCommandFiles {
				return fs.SkipAll
			}
			if d.IsDir() || !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			if d.Type()&fs.ModeSymlink != 0 {
				if fi, err := os.Stat(path); err != nil || !fi.Mode().IsRegular() {
					return nil
				}
			}
			rel, err := filepath.Rel(root, strings.TrimSuffix(path, ".md"))
			if err == nil {
				names[strings.ReplaceAll(filepath.ToSlash(rel), "/", ":")] = true
			}
			return nil
		})
	}
	return names
}

// claudeConfigDir is Claude Code's config dir under env: $CLAUDE_CONFIG_DIR,
// else ~/.claude ("" if there is no home).
func claudeConfigDir(env []string) string {
	home := ""
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		switch k {
		case "CLAUDE_CONFIG_DIR":
			if v != "" {
				return v
			}
		case "HOME":
			home = v
		}
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".claude")
}

// CodexCommands lists the enabled skills Codex offers in dir (app-server
// skills/list for that cwd), each of kind skill, then Codex's static
// built-in commands. Load errors of single skills are logged to log (if
// not nil); the skills that loaded are still listed.
//
// forceReload is never sent: a freshly started app-server has no skills
// cache to bypass, and the bridge has no invalidation path of its own.
func CodexCommands(ctx context.Context, log *slog.Logger, bin, dir string) ([]proto.CommandEntry, error) {
	if bin == "" {
		bin = "codex"
	}
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("skills/list needs an absolute cwd, got %q", dir)
	}
	list, err := probeIn(ctx, bin, dir, []string{"app-server"}, func(s *stream) (codexSkillsList, error) {
		if err := s.codexInit(); err != nil {
			return codexSkillsList{}, err
		}
		var list codexSkillsList
		err := s.rpc(2, "skills/list", map[string]any{"cwds": []string{dir}}, &list)
		return list, err
	})
	if err != nil {
		return nil, err
	}
	return codexEntries(list, dir, log)
}

// codexSkillsList is app-server's SkillsListResponse (the fields used).
type codexSkillsList struct {
	Data *[]struct {
		Cwd    string `json:"cwd"`
		Skills []struct {
			Name             string  `json:"name"`
			Description      string  `json:"description"`
			ShortDescription *string `json:"shortDescription"`
			Interface        *struct {
				ShortDescription *string `json:"shortDescription"`
			} `json:"interface"`
			Enabled bool `json:"enabled"`
		} `json:"skills"`
		Errors []struct {
			Path    string `json:"path"`
			Message string `json:"message"`
		} `json:"errors"`
	} `json:"data"`
}

// codexEntries picks dir's group of a skills/list response (or its only
// one), drops disabled skills and appends the built-ins. A skill named like
// a built-in keeps its row: it is invoked as $name, not /name.
func codexEntries(list codexSkillsList, dir string, log *slog.Logger) ([]proto.CommandEntry, error) {
	if list.Data == nil {
		return nil, errors.New("skills/list returned no data")
	}
	groups := *list.Data
	g := -1
	for i, entry := range groups {
		if filepath.Clean(entry.Cwd) == filepath.Clean(dir) {
			g = i
			break
		}
	}
	if g < 0 && len(groups) == 1 {
		g = 0
	}
	if g < 0 {
		return nil, fmt.Errorf("skills/list returned no skills for %s", dir)
	}
	group := groups[g]
	if log != nil {
		for _, e := range group.Errors {
			log.Debug("codex skill failed to load", "cwd", dir, "path", e.Path, "err", e.Message)
		}
	}
	out := []proto.CommandEntry{}
	seen := map[[2]string]bool{}
	add := func(e proto.CommandEntry) {
		if key := [2]string{e.Name, e.Kind}; !seen[key] {
			seen[key] = true
			out = append(out, e)
		}
	}
	for _, s := range group.Skills {
		if !s.Enabled || s.Name == "" {
			continue
		}
		desc := s.Description
		if s.ShortDescription != nil && *s.ShortDescription != "" {
			desc = *s.ShortDescription
		}
		if s.Interface != nil && s.Interface.ShortDescription != nil && *s.Interface.ShortDescription != "" {
			desc = *s.Interface.ShortDescription
		}
		add(proto.CommandEntry{Name: s.Name, Description: desc, Kind: proto.CommandKindSkill})
	}
	for _, b := range CodexBuiltins() {
		add(b)
	}
	return out, nil
}
