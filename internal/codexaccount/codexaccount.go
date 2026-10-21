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
	"crypto/sha256"
	"encoding/hex"
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
	// Key names the profile for good: it comes from its folder alone
	// (~/.codex-work: "work"; a folder elsewhere, one whose name had to be
	// changed, or one whose name ends in "-" and hex digits gets a hash of
	// its path too: /data/team "team-1a2b3c"), so neither a rename nor
	// other folders coming and going change it. Only two paths whose hashes
	// start alike take the whole hash, both of them.
	Key string
	// Name is what the user calls it (default: its folder's name as in the
	// Key, without a hash, when no other profile's folder has it and no
	// other profile has it as its key; else the Key).
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

// NotFoundError is a key no profile has, or (#139, Prepare) a profile
// whose folder is gone: Name is its name then.
type NotFoundError struct{ Key, Name string }

func (e *NotFoundError) Error() string {
	if e.Name != "" {
		return fmt.Sprintf("the folder of the Codex profile %q no longer exists", e.Name)
	}
	return fmt.Sprintf("no Codex profile %q", e.Key)
}

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
	defKey, userDir := "", ""
	if defaultHome != "" {
		defKey = keyOf(canonical(defaultHome))
	}
	if userHome != "" {
		userDir = canonical(userHome)
	}
	bases := map[string]int{}
	for _, f := range homes {
		bases[keyOf(f.home)]++
	}
	keys := make([]string, len(homes))
	count := map[string]int{}
	for i, f := range homes {
		keys[i] = keyFor(f.home, f.def, userDir, defKey, 6)
		count[keys[i]]++
	}
	// Two paths whose hashes start alike (the only keys that can meet):
	// both take the whole hash, whichever is listed first.
	taken := map[string]bool{}
	for i, f := range homes {
		if count[keys[i]] > 1 {
			keys[i] = keyFor(f.home, f.def, userDir, defKey, 2*sha256.Size)
		}
		taken[keys[i]] = true
	}
	out := make([]Account, 0, len(homes))
	stored := make([]bool, len(homes))
	for i, f := range homes {
		key := keys[i]
		// A key with a path hash is named by its folder alone while no
		// other profile's folder has that name and no other profile has it
		// as its key.
		name := key
		if base := keyOf(f.home); bases[base] == 1 && (base == key || !taken[base]) {
			name = base
		}
		a := Account{Key: key, Name: name, Home: f.home, Default: f.def, Added: f.added, Exists: f.exists, SignedIn: f.auth}
		if o, ok := over[f.home]; ok {
			if o.Name != "" {
				a.Name, stored[i] = o.Name, true
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
		if stored[i] && names[strings.ToLower(a.Name)] > 1 {
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

// keyFor is the key of home, from home alone, so that a folder keeps its
// key whatever else is listed or comes and goes: the folder's name (keyOf)
// for the default home and for ~/.codex-<key> (a name keyOf keeps as it is,
// not the default's key), as no two other folders can have them; for any
// other folder, the name, "-" and the first digits (6, or all 64) hex
// digits of the SHA-256 of the path. A name that itself ends in "-" and 6
// or more hex digits is hashed too, so a key with a hash is never another
// folder's name alone. userDir is the user's home folder, canonical.
func keyFor(home string, def bool, userDir, defKey string, digits int) string {
	key := keyOf(home)
	if !hashEnd.MatchString(key) && (def || userDir != "" && key != defKey && home == filepath.Join(userDir, ".codex-"+key)) {
		return key
	}
	sum := sha256.Sum256([]byte(home))
	return key + "-" + hex.EncodeToString(sum[:])[:digits]
}

// hashEnd is how a key with a path hash ends.
var hashEnd = regexp.MustCompile(`-[0-9a-f]{6,}$`)

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

// Prepare is the environment a Codex process runs with on the profile key
// ("": the default), as listed now (#139): CODEX_HOME is its home. Nothing
// is switched, so there is nothing to undo: release is a no-op, kept for
// the interface, never nil and safe to call on every path. The default's
// folder that is not there gives no env (Codex refuses a CODEX_HOME that
// is not; the limits probe's rule). An unknown key, or a profile whose
// folder is gone, is a *NotFoundError. A hidden profile still prepares:
// hidden only keeps it off the meter and out of the hire dialog.
func (s *Service) Prepare(ctx context.Context, key string) (env []string, release func(), err error) {
	release = func() {}
	all := list(s.userHome, s.defaultHome, s.Settings())
	a, ok := Account{}, false
	if key == "" {
		for _, x := range all {
			if x.Default {
				a, ok = x, true
			}
		}
	} else {
		a, ok = find(all, key)
	}
	switch {
	case !ok:
		return nil, release, &NotFoundError{Key: key}
	case a.Default && !a.Exists:
		return nil, release, nil
	case !a.Exists:
		return nil, release, &NotFoundError{Key: key, Name: a.Name}
	}
	return []string{"CODEX_HOME=" + a.Home}, release, nil
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
		return set, &NotFoundError{Key: key}
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
		return set, &NotFoundError{Key: key}
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
		return set, &NotFoundError{Key: key}
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

// RunsHerdrHook reports whether a Codex home runs herdr's session hook
// (#139): its hooks.json, or a [hooks] table in its config.toml, names
// herdr-agent-state.sh, the script herdr installs to learn a Codex
// session's id. A fresh profile home has neither (#137). Only those two
// files are read; never auth.json.
func RunsHerdrHook(home string) bool {
	for _, name := range []string{"hooks.json", "config.toml"} {
		b, err := os.ReadFile(filepath.Join(home, name))
		if err == nil && strings.Contains(string(b), "herdr-agent-state") {
			return true
		}
	}
	return false
}
