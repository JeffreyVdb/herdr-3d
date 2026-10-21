package codexaccount

// #167: a profile that shares its setup with the default home (Share on)
// links config.toml, AGENTS.md, AGENTS.override.md and rules/ to the
// default's and has its own hooks.json with the default's commands. The
// drift check reads what is there now (a few lstat and readlink calls, the
// two hooks.json files, both skills/ folders, and the [mcp_servers.<name>]
// headers of a config.toml that replaced its link): it names files, MCP
// server names and skill names, never a value of a config.toml.

import (
	"bufio"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// The entries a shared profile links to the default home's, as shown
// (a folder ends in /), in this order; and its own hooks.json.
var linkedEntries = []string{"config.toml", "AGENTS.md", "AGENTS.override.md", "rules/"}

const hooksFile = "hooks.json"

// The kinds of drift (proto.CodexDrift.Kind).
const (
	DriftLinkMissing      = "link_missing"       // the default has it, the profile nothing
	DriftLinkElsewhere    = "link_elsewhere"     // a link to somewhere else
	DriftLinkReplaced     = "link_replaced"      // a regular file or folder where the link was (sed -i)
	DriftTargetMissing    = "target_missing"     // a link to the default's, which is gone
	DriftHooksMissing     = "hooks_missing"      // no hooks.json beside the default's
	DriftHooksDiffer      = "hooks_differ"       // hooks.json's commands differ from the default's
	DriftSkillOnlyProfile = "skill_only_profile" // a real skill folder only in the profile's skills/
	DriftSkillOnlyDefault = "skill_only_default" // a real skill folder in the default's skills/
)

// DriftItem is one way a shared profile differs from the default: Name is
// the entry (config.toml, rules/, hooks.json) or the skill, Text the plain
// words (a clause: "config.toml is no longer a link: a file replaced it").
type DriftItem struct {
	Kind string
	Name string
	Text string
}

// Drift is what differs (nil on an Account: nothing, or not checked).
type Drift struct{ Items []DriftItem }

// Equal reports whether a and b are the same, their drift compared by
// value.
func (a Account) Equal(b Account) bool {
	da, db := a.Drift, b.Drift
	a.Drift, b.Drift = nil, nil
	if a != b || (da == nil) != (db == nil) {
		return false
	}
	return da == nil || slices.Equal(da.Items, db.Items)
}

// entryPath is an entry's path in home (rules/ is the folder rules).
func entryPath(home, entry string) string {
	return filepath.Join(home, strings.TrimSuffix(entry, "/"))
}

// linksTo reports whether path is a symlink to want: its target, made
// absolute, is want, or both resolve to the same file. The share step and
// the drift check use this one rule.
func linksTo(path, want string) bool {
	t, err := os.Readlink(path)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(t) {
		t = filepath.Join(filepath.Dir(path), t)
	}
	t = filepath.Clean(t)
	if t == want {
		return true
	}
	rt, err1 := filepath.EvalSymlinks(t)
	rw, err2 := filepath.EvalSymlinks(want)
	return err1 == nil && err2 == nil && rt == rw
}

// exists reports whether path is there, following links.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// what is how a non-link entry is called in the words.
func what(fi fs.FileInfo) string {
	switch {
	case fi.Mode()&fs.ModeSymlink != 0:
		return "link"
	case fi.IsDir():
		return "folder"
	case fi.Mode().IsRegular():
		return "file"
	}
	return "special file"
}

// driftOf is how home (the profile name) differs from the default home
// defHome (defName): every item, in a fixed order (entries, hooks.json,
// skills by name), so the same state is the same list.
func driftOf(defHome, defName, home, name string) []DriftItem {
	var out []DriftItem
	add := func(kind, entry, text string) { out = append(out, DriftItem{Kind: kind, Name: entry, Text: text}) }
	for _, e := range linkedEntries {
		want, p := entryPath(defHome, e), entryPath(home, e)
		has := exists(want)
		fi, err := os.Lstat(p)
		switch {
		case err != nil:
			if has {
				add(DriftLinkMissing, e, e+" is not linked to "+defName+"'s")
			}
		case fi.Mode()&fs.ModeSymlink != 0:
			switch {
			case linksTo(p, want) && !has:
				add(DriftTargetMissing, e, e+" links to "+defName+"'s, which is gone")
			case !linksTo(p, want) && has:
				add(DriftLinkElsewhere, e, e+" links somewhere else, not to "+defName+"'s")
			}
		case has:
			text := e + " is no longer a link: a " + what(fi) + " replaced it"
			if e == "config.toml" {
				if gone := missingServers(want, p); len(gone) > 0 {
					text += " (MCP servers only on " + defName + ": " + strings.Join(gone, ", ") + ")"
				}
			}
			add(DriftLinkReplaced, e, text)
		}
	}
	if def, ok := hookCommands(filepath.Join(defHome, hooksFile)); ok || exists(filepath.Join(defHome, hooksFile)) {
		mine, mineOK := hookCommands(filepath.Join(home, hooksFile))
		switch {
		case !exists(filepath.Join(home, hooksFile)):
			add(DriftHooksMissing, hooksFile, hooksFile+" is missing")
		case !ok || !mineOK || !slices.Equal(def, mine):
			add(DriftHooksDiffer, hooksFile, hooksFile+" runs other commands than "+defName+"'s")
		}
	}
	defSkills, mySkills := realSkills(defHome), realSkills(home)
	for _, s := range defSkills {
		if !slices.Contains(mySkills, s) {
			add(DriftSkillOnlyDefault, s, "skill "+s+" is only on "+defName)
		}
	}
	for _, s := range mySkills {
		if !slices.Contains(defSkills, s) {
			add(DriftSkillOnlyProfile, s, "skill "+s+" is only on "+name)
		}
	}
	return out
}

// realSkills are the skills that are real folders in home's skills/ (not
// links, not .system or another dot folder), by name.
func realSkills(home string) []string {
	ents, err := os.ReadDir(filepath.Join(home, "skills"))
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if e.Type().IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, e.Name())
		}
	}
	slices.Sort(out)
	return out
}

// hookCommands are the commands a hooks.json runs, as "<event>: <command>",
// sorted (ok false: no such file, or not the shape Codex reads). Parsed,
// never compared as bytes.
func hookCommands(path string) ([]string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var f struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if json.Unmarshal(b, &f) != nil {
		return nil, false
	}
	out := []string{}
	for ev, groups := range f.Hooks {
		for _, g := range groups {
			for _, h := range g.Hooks {
				out = append(out, ev+": "+strings.Join(strings.Fields(h.Command), " "))
			}
		}
	}
	slices.Sort(out)
	return out, true
}

// serverHeader is a [mcp_servers.<name>] table header (or a sub-table of
// one); only the name is taken.
var serverHeader = regexp.MustCompile(`^\s*\[\s*mcp_servers\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))`)

// mcpServers are the MCP server names a config.toml declares, from its
// table headers alone (no TOML library, and no value is ever looked at),
// sorted.
func mcpServers(path string) []string {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		m := serverHeader.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		if n := m[1] + m[2] + m[3]; n != "" && !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	slices.Sort(out)
	return out
}

// missingServers are the MCP servers def declares and mine does not.
func missingServers(def, mine string) []string {
	have := mcpServers(mine)
	var out []string
	for _, n := range mcpServers(def) {
		if !slices.Contains(have, n) {
			out = append(out, n)
		}
	}
	return out
}

// isNotExist is an error that says the path is not there.
func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
