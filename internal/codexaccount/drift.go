package codexaccount

// #167: a profile that shares its setup with the default home (Share on)
// links config.toml, AGENTS.md, AGENTS.override.md and rules/ to the
// default's and has its own hooks.json with the default's commands. The
// drift check reads what is there now (a few lstat and readlink calls, the
// two hooks.json files, both skills/ folders, and the MCP server names of a
// config.toml that replaced its link: mcpservers.go): it names files, MCP
// server names and skill names, never a value of a config.toml.

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
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
	if exists(filepath.Join(defHome, hooksFile)) {
		switch {
		case !exists(filepath.Join(home, hooksFile)):
			add(DriftHooksMissing, hooksFile, hooksFile+" is missing")
		case !sameHooks(filepath.Join(defHome, hooksFile), filepath.Join(home, hooksFile)):
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

// maxRead bounds a hooks.json or config.toml the drift check reads.
const maxRead = 1 << 20

// readRegular is the content of path when it is a regular file (or a link
// to one) of at most maxRead bytes. Anything else is not read: a FIFO is
// opened without blocking and refused, so a read never waits on one.
func readRegular(path string) ([]byte, bool) {
	if st, err := os.Stat(path); err != nil || !st.Mode().IsRegular() || st.Size() > maxRead {
		return nil, false
	}
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || !st.Mode().IsRegular() {
		return nil, false
	}
	b, err := io.ReadAll(io.LimitReader(f, maxRead+1))
	if err != nil || len(b) > maxRead {
		return nil, false
	}
	return b, true
}

// hooksOf is the hooks a hooks.json defines, as one comparable string: its
// "hooks" table parsed and written again, so only the JSON's formatting
// (spacing, key order) is set aside; every event, group, handler and its
// order, type and command (as written, to the byte) count. ok is false: no
// such file, or not the shape Codex reads.
func hooksOf(path string) (string, bool) {
	b, ok := readRegular(path)
	if !ok {
		return "", false
	}
	var shape struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Type    string `json:"type"`
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if json.Unmarshal(b, &shape) != nil {
		return "", false
	}
	var raw struct {
		Hooks any `json:"hooks"`
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	if d.Decode(&raw) != nil {
		return "", false
	}
	out, err := json.Marshal(raw.Hooks)
	return string(out), err == nil
}

// missingServers are the MCP servers def declares and mine does not (none
// when either cannot be scanned).
func missingServers(def, mine string) []string {
	have, ok1 := mcpServers(mine)
	want, ok2 := mcpServers(def)
	if !ok1 || !ok2 {
		return nil
	}
	var out []string
	for _, n := range want {
		if !slices.Contains(have, n) {
			out = append(out, n)
		}
	}
	return out
}

// isNotExist is an error that says the path is not there.
func isNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
