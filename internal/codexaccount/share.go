package codexaccount

// #167: "Share setup with <default>" (docs/decisions.md "#167"). Turning it
// on links config.toml, AGENTS.md, AGENTS.override.md and rules/ (those the
// default home has) to the default's and writes the profile's own
// hooks.json with the default's commands; anything already there is
// renamed to <name>.before-share-<yyyymmdd-hhmmss> first, never deleted,
// and only when the person confirmed that name (Plan lists them). Turning
// it off replaces each such link with a copy of its target. The only write
// to the default home is MoveSkill, which moves a real skill folder into
// ~/.agents/skills and leaves a link in its place. Only a profile the
// service lists, whose folder is there, is written to; auth.json,
// sessions/, the SQLite stores, logs and skills/.system are never touched.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"time"
)

// What a share step does (proto.CodexShareStep.Action).
const (
	StepLink    = "link"    // nothing there: linked
	StepKeep    = "keep"    // already right: left as it is
	StepReplace = "replace" // backed up, then linked (hooks.json: written)
	StepWrite   = "write"   // hooks.json written
	StepSkip    = "skip"    // not in the default home: nothing to share
	StepCopy    = "copy"    // (off) the link replaced by a copy of its target
	StepLeft    = "left"    // (off) a link whose target is gone: left
)

// Step is one entry of a share (or unshare): Name as shown (rules/ ends in
// /), what is done, and for a replace what is there now (file, folder,
// link) and the backup's name.
type Step struct {
	Name   string
	Action string
	Was    string
	Backup string
}

// ShareResult is what a share, unshare or skill move did: the steps, the
// report in plain words, and Failed when it stopped on an error (the
// report says where). Hooks: the profile has a hooks.json from the default
// now (its trust can be seeded).
type ShareResult struct {
	Steps  []Step
	Report string
	Failed bool
	Hooks  bool
}

// backupStamp is the time in a backup's name.
const backupStamp = "20060102-150405"

// backupName is a free name for entry's backup in home at now:
// <name>.before-share-<stamp>, then -2, -3… (an existing backup is never
// overwritten).
func backupName(home, entry string, now time.Time) string {
	base := strings.TrimSuffix(entry, "/") + ".before-share-" + now.Format(backupStamp)
	name := base
	for i := 2; ; i++ {
		if _, err := os.Lstat(filepath.Join(home, name)); isNotExist(err) {
			return name
		}
		name = fmt.Sprintf("%s-%d", base, i)
	}
}

// planShare is what sharing home with defHome does now.
func planShare(defHome, home string, now time.Time) []Step {
	var out []Step
	for _, e := range linkedEntries {
		want, p := entryPath(defHome, e), entryPath(home, e)
		fi, err := os.Lstat(p)
		switch {
		case !exists(want):
			out = append(out, Step{Name: e, Action: StepSkip})
		case err != nil:
			out = append(out, Step{Name: e, Action: StepLink})
		case fi.Mode()&fs.ModeSymlink != 0 && linksTo(p, want):
			out = append(out, Step{Name: e, Action: StepKeep})
		default:
			out = append(out, Step{Name: e, Action: StepReplace, Was: what(fi), Backup: backupName(home, e, now)})
		}
	}
	def, p := filepath.Join(defHome, hooksFile), filepath.Join(home, hooksFile)
	fi, err := os.Lstat(p)
	switch {
	case !exists(def):
		out = append(out, Step{Name: hooksFile, Action: StepSkip})
	case err != nil:
		out = append(out, Step{Name: hooksFile, Action: StepWrite})
	case fi.Mode().IsRegular() && sameHooks(def, p):
		out = append(out, Step{Name: hooksFile, Action: StepKeep})
	default:
		out = append(out, Step{Name: hooksFile, Action: StepReplace, Was: what(fi), Backup: backupName(home, hooksFile, now)})
	}
	return out
}

// sameHooks reports whether two hooks.json files define the same hooks
// (hooksOf; the share step and the drift check use this one rule).
func sameHooks(a, b string) bool {
	x, ok1 := hooksOf(a)
	y, ok2 := hooksOf(b)
	return ok1 && ok2 && x == y
}

// errChanged is a plan that replaces something not confirmed.
var errChanged = errors.New("changed since the plan")

// applyShare shares home with defHome: the plan again, refused with
// errChanged (nothing written) when it replaces a name not in confirmed;
// else each step in turn. It returns the steps done, and the error that
// stopped it.
func applyShare(defHome, home string, confirmed []string, now time.Time) ([]Step, error) {
	plan := planShare(defHome, home, now)
	for _, s := range plan {
		if s.Action == StepReplace && !slices.Contains(confirmed, s.Name) {
			return nil, errChanged
		}
	}
	return applySteps(defHome, home, plan, now)
}

// applySteps does a share's planned steps in turn, never over anything: a
// backup whose name was taken since the plan takes the next free one; an
// entry that appeared since (where the plan saw none, or after the one
// there was backed up) is left as it is, and the share stops there.
func applySteps(defHome, home string, plan []Step, now time.Time) ([]Step, error) {
	var done []Step
	for _, s := range plan {
		p := entryPath(home, s.Name)
		if s.Action == StepReplace {
			b, err := backUp(home, s, now)
			if err != nil {
				return done, fmt.Errorf("backing up %s: %w", s.Name, err)
			}
			s.Backup = b
		}
		var err error
		switch {
		case s.Name == hooksFile && (s.Action == StepWrite || s.Action == StepReplace):
			err = copyFile(filepath.Join(defHome, hooksFile), p)
		case s.Action == StepLink || s.Action == StepReplace:
			err = os.Symlink(entryPath(defHome, s.Name), p)
		}
		if err != nil {
			if s.Action == StepReplace {
				done = append(done, Step{Name: s.Name, Action: "backup", Backup: s.Backup})
			}
			if errors.Is(err, fs.ErrExist) {
				return done, fmt.Errorf("a new %s appeared meanwhile: left as it is", s.Name)
			}
			return done, fmt.Errorf("%s: %w", s.Name, err)
		}
		done = append(done, s)
	}
	return done, nil
}

// backUp renames the entry of s in home to its backup: the planned name,
// or the next free one when that was taken since (never over anything).
func backUp(home string, s Step, now time.Time) (string, error) {
	name := s.Backup
	for range 100 {
		err := renameNew(entryPath(home, s.Name), filepath.Join(home, name))
		if !errors.Is(err, fs.ErrExist) {
			return name, err
		}
		name = backupName(home, s.Name, now)
	}
	return "", errors.New("no free backup name")
}

// unshare replaces each link of home to defHome's entries with a copy of
// its target; hooks.json and anything that is not such a link stay.
func unshare(defHome, home string) ([]Step, error) {
	var done []Step
	for _, e := range linkedEntries {
		want, p := entryPath(defHome, e), entryPath(home, e)
		fi, err := os.Lstat(p)
		if err != nil || fi.Mode()&fs.ModeSymlink == 0 || !linksTo(p, want) {
			continue
		}
		src, err := os.Stat(want)
		if err != nil {
			done = append(done, Step{Name: e, Action: StepLeft})
			continue
		}
		if src.IsDir() {
			err = copyTreeOver(want, p)
		} else {
			err = copyOver(want, p)
		}
		if err != nil {
			return done, fmt.Errorf("copying %s: %w", e, err)
		}
		done = append(done, Step{Name: e, Action: StepCopy})
	}
	return done, nil
}

// tempName is a fresh hidden name beside path.
func tempName(path string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".h3d-"+hex.EncodeToString(b))
}

// copyFile writes src's content to dst, which must not be there: a temp
// file beside dst, then renamed to it, never over anything (an error that
// is fs.ErrExist when something appeared there).
func copyFile(src, dst string) error { return copyThen(src, dst, renameNew) }

// copyOver replaces the link dst with a copy of src (a temp file beside
// it, renamed over it: the link is replaced, not followed).
func copyOver(src, dst string) error { return copyThen(src, dst, os.Rename) }

// copyThen writes src's content, with src's mode, to a temp file beside dst
// and puts it at dst with rename. src must be a regular file: a FIFO is
// refused, not waited on.
func copyThen(src, dst string, rename func(old, new string) error) error {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer in.Close()
	st, err := in.Stat()
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a regular file", filepath.Base(src))
	}
	tmp := tempName(dst)
	out, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, st.Mode().Perm())
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp, st.Mode().Perm()) // past the umask
	}
	if err == nil {
		err = rename(tmp, dst)
	}
	if err != nil {
		os.Remove(tmp)
	}
	return err
}

// copyTreeOver copies the folder src into a temp folder beside dst, then
// puts it where dst (a link) is: the link is renamed aside, the copy into
// its place, and the aside link removed (a folder cannot be renamed over a
// link); on a failure the link is put back.
func copyTreeOver(src, dst string) error {
	tmp := tempName(dst)
	if err := copyTree(src, tmp); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	aside := tempName(dst)
	if err := os.Rename(dst, aside); err != nil {
		os.RemoveAll(tmp)
		return err
	}
	if err := renameNew(tmp, dst); err != nil {
		_ = renameNew(aside, dst)
		os.RemoveAll(tmp)
		return err
	}
	return os.Remove(aside)
}

// copyTree copies the folder src to dst (which must not exist): folders,
// regular files and links (as links), with their modes; nothing else. A
// src that is a link is copied as the folder it names.
func copyTree(src, dst string) error {
	root, err := filepath.EvalSymlinks(src)
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		info, err := d.Info()
		if err != nil {
			return err
		}
		switch {
		case d.IsDir():
			if err := os.Mkdir(to, 0o700); err != nil {
				return err
			}
			return os.Chmod(to, info.Mode().Perm())
		case d.Type()&fs.ModeSymlink != 0:
			t, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(t, to)
		case d.Type().IsRegular():
			return copyFile(path, to)
		}
		return nil
	})
}

// moveTree moves the folder src to dst, which must not be there: a rename
// (never over anything), or across file systems a copy and then the
// original removed.
func moveTree(src, dst string) error {
	err := renameNew(src, dst)
	if !errors.Is(err, syscall.EXDEV) {
		return err
	}
	if err := copyTree(src, dst); err != nil {
		os.RemoveAll(dst)
		return err
	}
	return os.RemoveAll(src)
}

// names joins names in words: "a", "a and b", "a, b and c".
func names(list []string) string {
	switch len(list) {
	case 0:
		return ""
	case 1:
		return list[0]
	}
	return strings.Join(list[:len(list)-1], ", ") + " and " + list[len(list)-1]
}

// sentence is parts as one sentence: the first letter up, a full stop.
func sentence(parts []string) string {
	s := strings.Join(parts, ", ")
	if s == "" {
		return ""
	}
	return strings.ToUpper(s[:1]) + s[1:] + "."
}

// shareReport is a share's steps in words, e.g. "Linked config.toml and
// rules/, wrote hooks.json, backed up the old config.toml to
// config.toml.before-share-20261021-151002."
func shareReport(steps []Step, name, defName string) string {
	var linked, backups, parts []string
	wrote, noHooks, kept := false, false, 0
	for _, s := range steps {
		switch {
		case s.Action == "backup":
			backups = append(backups, "the old "+s.Name+" to "+s.Backup)
		case s.Name == hooksFile && (s.Action == StepWrite || s.Action == StepReplace):
			wrote = true
		case s.Name == hooksFile && s.Action == StepSkip:
			noHooks = true
		case s.Action == StepLink || s.Action == StepReplace:
			linked = append(linked, s.Name)
		case s.Action == StepKeep:
			kept++
		}
		if s.Action == StepReplace {
			backups = append(backups, "the old "+s.Name+" to "+s.Backup)
		}
	}
	if len(linked) > 0 {
		parts = append(parts, "linked "+names(linked))
	}
	if wrote {
		parts = append(parts, "wrote "+hooksFile)
	}
	if len(backups) > 0 {
		parts = append(parts, "backed up "+names(backups))
	}
	out := sentence(parts)
	if out == "" && kept > 0 {
		out = "Nothing to change: " + name + " already shares " + defName + "'s setup."
	}
	if noHooks {
		out = strings.TrimSpace(out + " " + defName + " has no " + hooksFile + ", so none was written.")
	}
	return out
}

// unshareReport is an unshare's steps in words.
func unshareReport(steps []Step, name, defName string) string {
	var copied, left []string
	for _, s := range steps {
		switch s.Action {
		case StepCopy:
			copied = append(copied, s.Name)
		case StepLeft:
			left = append(left, s.Name)
		}
	}
	var out string
	if len(copied) > 0 {
		out = "Copied " + names(copied) + " from " + defName + ": " + name + " keeps them as its own and no longer follows " + defName + "."
	} else {
		out = name + " had no links to " + defName + " to copy."
	}
	if len(left) > 0 {
		out += " " + names(left) + " linked to " + defName + "'s, which is gone: left as it was."
	}
	return out + " Its " + hooksFile + " stays."
}

// sharable is the listed profile key that can share with the default, and
// the default: not the default itself, its folder there, the default's too.
func (s *Service) sharable(key string) (a, def Account, err error) {
	all := list(s.userHome, s.defaultHome, s.Settings())
	a, ok := find(all, key)
	switch {
	case !ok:
		return a, def, &NotFoundError{Key: key}
	case a.Default:
		return a, def, &SettingsError{"The default profile is the one the others share from."}
	case !a.Exists:
		return a, def, &NotFoundError{Key: key, Name: a.Name}
	}
	for _, x := range all {
		if x.Default {
			def = x
		}
	}
	if !def.Exists || def.Home == "" {
		return a, def, &SettingsError{"The default Codex home (" + s.Display(def.Home) + ") is not there to share from."}
	}
	return a, def, nil
}

// SharePlan is what turning sharing on for the profile key does now (or a
// Fix): read only.
func (s *Service) SharePlan(ctx context.Context, key string) ([]Step, error) {
	a, def, err := s.sharable(key)
	if err != nil {
		return nil, err
	}
	return planShare(def.Home, a.Home, s.clock()), nil
}

// Share turns sharing on for the profile key (also a Fix): replace are the
// names the person confirmed to replace. A plan that now replaces anything
// else is refused with words, nothing written. Without an error, the
// setting is to be turned on (SetShare), also when it stopped half way
// (what is left is drift, and a Fix finishes it).
func (s *Service) Share(ctx context.Context, key string, replace []string) (ShareResult, error) {
	s.files.Lock()
	defer s.files.Unlock()
	a, def, err := s.sharable(key)
	if err != nil {
		return ShareResult{}, err
	}
	steps, err := applyShare(def.Home, a.Home, replace, s.clock())
	if errors.Is(err, errChanged) {
		return ShareResult{}, &SettingsError{s.Display(a.Home) + " changed since you looked; look again."}
	}
	res := ShareResult{Steps: steps, Report: shareReport(steps, a.Name, def.Name), Hooks: exists(filepath.Join(def.Home, hooksFile))}
	if err != nil {
		res.Failed = true
		res.Report = strings.TrimSpace(res.Report + " Stopped: " + err.Error() + ".")
	}
	return res, nil
}

// Unshare turns sharing off for the profile key: each link to the
// default's entries becomes a copy of its target. Without an error and
// not Failed, the setting is to be turned off (SetShare); a failed one
// stays on (what is left is drift).
func (s *Service) Unshare(ctx context.Context, key string) (ShareResult, error) {
	s.files.Lock()
	defer s.files.Unlock()
	a, def, err := s.sharable(key)
	if err != nil {
		return ShareResult{}, err
	}
	steps, err := unshare(def.Home, a.Home)
	res := ShareResult{Steps: steps, Report: unshareReport(steps, a.Name, def.Name)}
	if err != nil {
		res.Failed = true
		res.Report = "Stopped: " + err.Error() + ". " + res.Report
	}
	return res, nil
}

// SetShare turns the profile key's "Share setup" setting on or off (the
// files are Share's and Unshare's): it returns the settings that do it,
// without applying them. The default has none.
func (s *Service) SetShare(ctx context.Context, key string, on bool) (Settings, error) {
	set := s.Settings()
	a, ok := find(list(s.userHome, s.defaultHome, set), key)
	switch {
	case !ok:
		return set, &NotFoundError{Key: key}
	case a.Default:
		return set, &SettingsError{"The default profile is the one the others share from."}
	}
	return override(set, a.Home, func(o *Override) { o.Share = on }), nil
}

// MoveSkill moves the skill name, a real folder in the profile key's
// skills/ (the default's too), to ~/.agents/skills/<name>, where every
// Codex home reads it, and leaves a link to it in its old place. A name
// already in ~/.agents/skills is refused: nothing is overwritten.
func (s *Service) MoveSkill(ctx context.Context, key, name string) (ShareResult, error) {
	s.files.Lock()
	defer s.files.Unlock()
	a, ok := find(list(s.userHome, s.defaultHome, s.Settings()), key)
	switch {
	case !ok:
		return ShareResult{}, &NotFoundError{Key: key}
	case !a.Exists:
		return ShareResult{}, &NotFoundError{Key: key, Name: a.Name}
	case name == "" || strings.HasPrefix(name, ".") || strings.ContainsAny(name, "/\\\x00") || filepath.Base(name) != name:
		return ShareResult{}, &SettingsError{fmt.Sprintf("%q is not a skill folder's name.", name)}
	case s.userHome == "":
		return ShareResult{}, &SettingsError{"The bridge has no home folder, so no ~/.agents/skills."}
	}
	// Every part of both paths is a real folder (a.Home has its links
	// resolved): a skills/ that is a link would move what it points at.
	skills := filepath.Join(a.Home, "skills")
	if fi, err := os.Lstat(skills); err == nil && !fi.IsDir() {
		return ShareResult{}, &SettingsError{fmt.Sprintf("%s's skills/ is a link, not a folder: the bridge moves no skill through it.", a.Name)}
	}
	src := filepath.Join(skills, name)
	if !realDir(src) {
		return ShareResult{}, &SettingsError{fmt.Sprintf("%s has no skill folder %s.", a.Name, name)}
	}
	dir := filepath.Join(s.userHome, ".agents", "skills")
	dst := filepath.Join(dir, name)
	if _, err := os.Lstat(dst); !isNotExist(err) {
		return ShareResult{}, &SettingsError{fmt.Sprintf("%s already exists: the bridge does not overwrite it. Move or rename one of them by hand.", s.Display(dst))}
	}
	for _, d := range []string{filepath.Dir(dir), dir} {
		if err := os.Mkdir(d, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return ShareResult{}, err
		}
		if !realDir(d) {
			return ShareResult{}, &SettingsError{fmt.Sprintf("%s is a link, not a folder: the bridge moves no skill through it.", s.Display(d))}
		}
	}
	if err := moveTree(src, dst); err != nil {
		return ShareResult{}, err
	}
	if err := os.Symlink(dst, src); err != nil {
		return ShareResult{Failed: true, Report: fmt.Sprintf("Moved the skill %s to %s, but the link in %s's skills/ could not be made (%v).", name, s.Display(dst), a.Name, err)}, nil
	}
	return ShareResult{Steps: []Step{{Name: name, Action: "move"}},
		Report: fmt.Sprintf("Moved the skill %s to %s and left a link in %s's skills/: every Codex home sees it now.", name, s.Display(dst), a.Name)}, nil
}

// realDir reports whether path is a folder itself, not a link to one.
func realDir(path string) bool {
	fi, err := os.Lstat(path)
	return err == nil && fi.IsDir()
}

// clock is the time a backup is named by.
func (s *Service) clock() time.Time {
	if s.now != nil {
		return s.now()
	}
	return time.Now()
}

// SetupNote is what a Codex hire on profile a says about its setup (#167,
// beside #139's note on herdr's hook): a profile that does not share the
// default's, and what it lacks then; a shared one that drifted, and how.
// "" for the default, a shared profile in step, or a folder that is gone.
// list is the profiles as listed (with drift: Service.Accounts).
func SetupNote(list []Account, a Account) string {
	var def Account
	for _, x := range list {
		if x.Default {
			def = x
		}
	}
	if a.Default || !a.Exists || !def.Exists {
		return ""
	}
	if a.Share {
		if a.Drift == nil || len(a.Drift.Items) == 0 {
			return ""
		}
		var what []string
		for _, d := range a.Drift.Items {
			what = append(what, d.Text)
		}
		return a.Name + "'s shared setup has drifted from " + def.Name + "'s: " + strings.Join(what, "; ") + "."
	}
	var lacks []string
	if want, _ := mcpServers(filepath.Join(def.Home, "config.toml")); len(want) > 0 {
		if have, ok := mcpServers(filepath.Join(a.Home, "config.toml")); ok && len(have) == 0 {
			lacks = append(lacks, "no MCP servers")
		}
	}
	if RunsHerdrHook(def.Home) && !RunsHerdrHook(a.Home) {
		lacks = append(lacks, "no herdr hooks")
	}
	if len(lacks) == 0 {
		return a.Name + " does not share setup with " + def.Name + "."
	}
	return a.Name + " does not share setup with " + def.Name + ": " + strings.Join(lacks, ", ") + "."
}
