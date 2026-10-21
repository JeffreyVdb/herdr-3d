// Package codexaccount finds the Codex accounts on the bridge host (#138).
// An account is a Codex profile: a Codex home folder with its own sign-in
// (docs/research/codex-accounts.md: one home per account, no switcher). The
// profiles are the bridge's own home ($CODEX_HOME, else ~/.codex), every
// ~/.codex-* folder with an auth.json in it, and the folders the user added;
// the user can name them and hide one (Settings). A profile's auth.json is
// only ever stat'ed: it is never opened.
//
// Lister is the seam the limits poller (and #139's hire on a profile) read
// the profiles through.
package codexaccount

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
)

// Limits of the settings.
const (
	// MaxAdded bounds the folders the user can add.
	MaxAdded = 16
	// MaxName bounds a profile's name, in characters.
	MaxName = 40
	// MaxPath bounds an added folder's path, in bytes.
	MaxPath = 4096
)

// Account is one Codex profile.
type Account struct {
	// Key names the profile for good: it comes from the folder's name
	// (~/.codex-work: "work"), so a rename does not change it.
	Key string
	// Name is what the user calls it (default: the Key).
	Name string
	// Home is the Codex home folder, absolute, symlinks resolved.
	Home string
	// Default is the bridge's own home ($CODEX_HOME, else ~/.codex).
	Default bool
	// Hidden profiles are not read and not shown on the meter.
	Hidden bool
	// Added is a folder the user added (it can be removed); the others
	// were found.
	Added bool
	// Exists is whether Home is a directory now. An added folder that
	// went away is listed (so it can be removed) but not read.
	Exists bool
	// SignedIn is whether Home has an auth.json (only its existence is
	// checked). Codex can keep the sign-in in the keyring instead, so a
	// reading with a plan also means signed in.
	SignedIn bool
}

// Lister lists the Codex profiles, the bridge's own first, then the found
// ones by folder, then the added ones in the order added; hidden ones
// included.
type Lister interface {
	Accounts(ctx context.Context) ([]Account, error)
}

// Override is what the user set for one profile, by its home folder.
type Override struct {
	Path   string `json:"path"`
	Name   string `json:"name,omitempty"`
	Hidden bool   `json:"hidden,omitempty"`
}

// Settings are the user's: the overrides and the added folders (absolute,
// cleaned, in the order added).
type Settings struct {
	Overrides []Override `json:"profiles"`
	Added     []string   `json:"added"`
}

// SettingsError is a change the service refuses, in words for the person
// who asked for it.
type SettingsError struct{ Msg string }

func (e *SettingsError) Error() string { return e.Msg }

// NotFoundError is a key no profile has.
type NotFoundError struct{ Key string }

func (e *NotFoundError) Error() string { return fmt.Sprintf("no Codex profile %q", e.Key) }

// Service detects the profiles and keeps the user's settings. Safe for
// concurrent use: the hub configures it, the limits poller lists.
type Service struct {
	userHome    string
	defaultHome string

	mu  sync.Mutex
	set Settings
}

// New makes a service for the user's home folder and the bridge's own Codex
// home (codex.DefaultHome, so the default profile is the one whose sessions
// the bridge reads).
func New(userHome, defaultHome string) *Service {
	return &Service{userHome: userHome, defaultHome: defaultHome, set: Settings{Added: []string{}}}
}

// Configure replaces the settings (as stored).
func (s *Service) Configure(set Settings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.set = clone(set)
}

// Settings are the settings as configured.
func (s *Service) Settings() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return clone(s.set)
}

func clone(set Settings) Settings {
	return Settings{Overrides: slices.Clone(set.Overrides), Added: append([]string{}, set.Added...)}
}

// Accounts detects the profiles now (a few stat calls and one read of the
// user's home folder) and applies the settings.
func (s *Service) Accounts(context.Context) ([]Account, error) {
	return list(s.userHome, s.defaultHome, s.Settings()), nil
}

// found is a home before the settings apply.
type found struct {
	home         string
	def, added   bool
	exists, auth bool
}

func list(userHome, defaultHome string, set Settings) []Account {
	var homes []found
	seen := map[string]bool{}
	take := func(path string, def, added bool) {
		home := canonical(path)
		if home == "" || seen[home] {
			return
		}
		seen[home] = true
		f := found{home: home, def: def, added: added}
		if st, err := os.Stat(home); err == nil && st.IsDir() {
			f.exists = true
			_, err := os.Stat(filepath.Join(home, "auth.json"))
			f.auth = err == nil
		}
		homes = append(homes, f)
	}
	if defaultHome != "" {
		take(defaultHome, true, false)
	}
	for _, path := range siblings(userHome) {
		take(path, false, false)
	}
	for _, path := range set.Added {
		take(path, false, true)
	}
	over := map[string]Override{}
	for _, o := range set.Overrides {
		over[canonical(o.Path)] = o
	}
	out := make([]Account, 0, len(homes))
	keys := map[string]bool{}
	for _, f := range homes {
		key := uniqueKey(keyOf(f.home), keys)
		a := Account{Key: key, Name: key, Home: f.home, Default: f.def, Added: f.added, Exists: f.exists, SignedIn: f.auth}
		if o, ok := over[f.home]; ok {
			if o.Name != "" {
				a.Name = o.Name
			}
			a.Hidden = o.Hidden && !f.def
		}
		out = append(out, a)
	}
	// A stored name another profile now has by default (a folder that
	// appeared later) gives way: names stay unique.
	names := map[string]int{}
	for _, a := range out {
		names[strings.ToLower(a.Name)]++
	}
	for i, a := range out {
		if a.Name != a.Key && names[strings.ToLower(a.Name)] > 1 {
			names[strings.ToLower(a.Name)]--
			out[i].Name = a.Key
		}
	}
	return out
}

// siblings are the ~/.codex-* folders with an auth.json, by name.
func siblings(userHome string) []string {
	if userHome == "" {
		return nil
	}
	ents, err := os.ReadDir(userHome)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range ents {
		if !strings.HasPrefix(e.Name(), ".codex-") || len(e.Name()) == len(".codex-") {
			continue
		}
		path := filepath.Join(userHome, e.Name())
		if st, err := os.Stat(path); err != nil || !st.IsDir() { // a symlinked folder counts
			continue
		}
		if _, err := os.Stat(filepath.Join(path, "auth.json")); err != nil {
			continue
		}
		out = append(out, path)
	}
	slices.Sort(out)
	return out
}

// canonical is path absolute and cleaned, with symlinks resolved when it
// exists.
func canonical(path string) string {
	if path == "" {
		return ""
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(abs); err == nil {
		return real
	}
	return abs
}

var keyJunk = regexp.MustCompile(`[^a-z0-9_-]+`)

// keyOf is a profile's key from its folder's name: ~/.codex is "codex",
// ~/.codex-work "work", /data/team-codex "team-codex".
func keyOf(home string) string {
	name := strings.ToLower(strings.TrimLeft(filepath.Base(home), "."))
	if rest, ok := strings.CutPrefix(name, "codex-"); ok && rest != "" {
		name = rest
	}
	name = strings.Trim(keyJunk.ReplaceAllString(name, "-"), "-")
	if len(name) > 32 {
		name = strings.TrimRight(name[:32], "-")
	}
	if name == "" {
		return "profile"
	}
	return name
}

// uniqueKey is key, or key-2, key-3… when it is taken (in listing order:
// the default, the found folders, the added ones).
func uniqueKey(key string, taken map[string]bool) string {
	k := key
	for n := 2; taken[k]; n++ {
		k = fmt.Sprintf("%s-%d", key, n)
	}
	taken[k] = true
	return k
}

// Display is path for people: under the user's home folder it starts with
// ~.
func (s *Service) Display(path string) string {
	if s.userHome == "" {
		return path
	}
	home := canonical(s.userHome)
	for _, h := range []string{filepath.Clean(s.userHome), home} {
		if path == h {
			return "~"
		}
		if rest, ok := strings.CutPrefix(path, h+string(filepath.Separator)); ok {
			return "~/" + rest
		}
	}
	return path
}

// find is the profile with key in list.
func find(list []Account, key string) (Account, bool) {
	for _, a := range list {
		if a.Key == key {
			return a, true
		}
	}
	return Account{}, false
}

// override returns the settings with the override of home changed by fn.
func override(set Settings, home string, fn func(*Override)) Settings {
	set = clone(set)
	for i, o := range set.Overrides {
		if canonical(o.Path) == home {
			fn(&set.Overrides[i])
			if set.Overrides[i].Name == "" && !set.Overrides[i].Hidden {
				set.Overrides = slices.Delete(set.Overrides, i, i+1)
			}
			return set
		}
	}
	o := Override{Path: home}
	fn(&o)
	if o.Name != "" || o.Hidden {
		set.Overrides = append(set.Overrides, o)
	}
	return set
}

// Rename names the profile key (trimmed, 1 to MaxName characters, no other
// profile's name in any case; its own key clears the name). It returns the
// settings that do it, without applying them (Configure does, once they
// are stored).
func (s *Service) Rename(ctx context.Context, key, name string) (Settings, error) {
	set := s.Settings()
	all := list(s.userHome, s.defaultHome, set)
	a, ok := find(all, key)
	if !ok {
		return set, &NotFoundError{key}
	}
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return set, &SettingsError{"Type a name for the profile."}
	case utf8.RuneCountInString(name) > MaxName:
		return set, &SettingsError{fmt.Sprintf("A profile name has at most %d characters.", MaxName)}
	case strings.ContainsFunc(name, func(r rune) bool { return r < 0x20 || r == 0x7f }):
		return set, &SettingsError{"A profile name cannot have a line break or a tab in it."}
	}
	for _, o := range all {
		if o.Key != key && (strings.EqualFold(o.Name, name) || strings.EqualFold(o.Key, name)) {
			return set, &SettingsError{fmt.Sprintf("Another profile is called %q.", o.Name)}
		}
	}
	if name == a.Key {
		name = ""
	}
	return override(set, a.Home, func(o *Override) { o.Name = name }), nil
}

// SetHidden hides or shows the profile key; the bridge's own cannot be
// hidden.
func (s *Service) SetHidden(ctx context.Context, key string, hidden bool) (Settings, error) {
	set := s.Settings()
	a, ok := find(list(s.userHome, s.defaultHome, set), key)
	if !ok {
		return set, &NotFoundError{key}
	}
	if a.Default && hidden {
		return set, &SettingsError{"The bridge's own Codex profile cannot be hidden."}
	}
	return override(set, a.Home, func(o *Override) { o.Hidden = hidden }), nil
}

// Add adds a folder: an absolute path or ~/…, an existing directory, not a
// profile already, at most MaxAdded of them.
func (s *Service) Add(ctx context.Context, path string) (Settings, error) {
	set := s.Settings()
	p := strings.TrimSpace(path)
	switch {
	case p == "":
		return set, &SettingsError{"Type the folder's path on the bridge host."}
	case strings.ContainsAny(p, "\x00\n\r"):
		return set, &SettingsError{"A folder path cannot have a line break in it."}
	case len(p) > MaxPath:
		return set, &SettingsError{fmt.Sprintf("That path is longer than %d characters.", MaxPath)}
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		if s.userHome == "" {
			return set, &SettingsError{"The bridge has no home folder to expand ~ in: use an absolute path."}
		}
		p = filepath.Join(s.userHome, strings.TrimPrefix(p, "~"))
	}
	if !filepath.IsAbs(p) {
		return set, &SettingsError{"Use an absolute path on the bridge host, starting with / or ~/."}
	}
	p = filepath.Clean(p)
	if len(set.Added) >= MaxAdded {
		return set, &SettingsError{fmt.Sprintf("At most %d folders can be added; remove one first.", MaxAdded)}
	}
	st, err := os.Stat(p)
	switch {
	case err != nil && os.IsNotExist(err):
		return set, &SettingsError{"There is no folder there on the bridge host."}
	case err != nil:
		return set, &SettingsError{"The bridge cannot look at that folder (" + strings.TrimPrefix(err.Error(), "stat "+p+": ") + ")."}
	case !st.IsDir():
		return set, &SettingsError{"That is a file, not a folder."}
	}
	home := canonical(p)
	for _, a := range list(s.userHome, s.defaultHome, set) {
		if a.Home == home {
			return set, &SettingsError{fmt.Sprintf("That folder is already the profile %q.", a.Name)}
		}
	}
	set.Added = append(set.Added, p)
	return set, nil
}

// Remove removes an added folder (and what was set for it); a found one
// can only be hidden.
func (s *Service) Remove(ctx context.Context, key string) (Settings, error) {
	set := s.Settings()
	a, ok := find(list(s.userHome, s.defaultHome, set), key)
	if !ok {
		return set, &NotFoundError{key}
	}
	if !a.Added {
		return set, &SettingsError{"A profile the bridge found cannot be removed, only hidden."}
	}
	set.Added = slices.DeleteFunc(set.Added, func(p string) bool { return canonical(p) == a.Home })
	return override(set, a.Home, func(o *Override) { o.Name, o.Hidden = "", false }), nil
}

// Clean drops what stored settings cannot mean (a relative or empty path,
// an added folder twice, more than MaxAdded), so settings written by hand
// do no harm.
func Clean(set Settings) Settings {
	out := Settings{Added: []string{}}
	seen := map[string]bool{}
	for _, p := range set.Added {
		if p == "" || !filepath.IsAbs(p) || len(p) > MaxPath || seen[filepath.Clean(p)] || len(out.Added) >= MaxAdded {
			continue
		}
		seen[filepath.Clean(p)] = true
		out.Added = append(out.Added, filepath.Clean(p))
	}
	for _, o := range set.Overrides {
		name := strings.TrimSpace(o.Name)
		if utf8.RuneCountInString(name) > MaxName {
			name = ""
		}
		if o.Path == "" || !filepath.IsAbs(o.Path) || (name == "" && !o.Hidden) {
			continue
		}
		out.Overrides = append(out.Overrides, Override{Path: filepath.Clean(o.Path), Name: name, Hidden: o.Hidden})
	}
	return out
}
