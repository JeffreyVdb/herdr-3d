package codexaccount

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// secret is a fake API key in the default's config.toml: it must never
// reach a drift item, a report or the JSON of the list.
const secret = "sk-test-SECRET-167"

const defConfig = `# my config
model = "gpt-6"
[mcp_servers.alterlab]
command = "alterlab-mcp"
[mcp_servers.alterlab.env]
ALTERLAB_API_KEY = "` + secret + `"
[mcp_servers."kaneo"]
url = "https://kaneo.example/mcp?token=` + secret + `"
`

const defHooks = `{"hooks":{"SessionStart":[{"hooks":[{"command":"bash '/u/.codex/herdr-agent-state.sh' session","timeout":10,"type":"command"}]}]}}`

// shareHomes is a user home with a default ~/.codex holding a config.toml
// (two MCP servers and the secret), hooks.json, AGENTS.md, rules/ and
// skills (a real one, .system, a link), and a signed-in ~/.codex-work with
// sessions; the service on it, its clock at 2026-10-21 15:10:02.
func shareHomes(t *testing.T) (*Service, string, string, string) {
	t.Helper()
	u, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	def, work := filepath.Join(u, ".codex"), filepath.Join(u, ".codex-work")
	files := map[string]string{
		".codex/config.toml":                defConfig,
		".codex/hooks.json":                 defHooks,
		".codex/AGENTS.md":                  "# be kind\n",
		".codex/rules/default.rules":        "prefix_rule(pattern=[\"git\"])\n",
		".codex/rules/more/deep.rules":      "x\n",
		".codex/skills/infra/SKILL.md":      "infra\n",
		".codex/skills/.system/s/SKILL.md":  "system\n",
		".codex/auth.json":                  `{"tokens":{"access_token":"tok"}}`,
		".codex-work/auth.json":             `{"tokens":{"access_token":"tok2"}}`,
		".codex-work/sessions/2026/a.jsonl": "{}\n",
		".codex-work/state_5.sqlite":        "db",
		".agents/skills/handoff/SKILL.md":   "handoff\n",
	}
	for name, body := range files {
		p := filepath.Join(u, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chmod(filepath.Join(def, "config.toml"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../.agents/skills/handoff", filepath.Join(def, "skills", "handoff")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(u, ".codex/rules/default.rules"), filepath.Join(def, "rules", "alias.rules")); err != nil {
		t.Fatal(err)
	}
	s := New(u, def)
	s.now = func() time.Time { return time.Date(2026, 10, 21, 15, 10, 2, 0, time.UTC) }
	return s, u, def, work
}

// tree is every path under dir with what it is: a file's content hash, a
// link's target, or "dir" (a snapshot to compare before and after).
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		info, _ := d.Info()
		switch {
		case d.Type()&fs.ModeSymlink != 0:
			l, _ := os.Readlink(p)
			out[rel] = "-> " + l
		case d.IsDir():
			out[rel] = "dir " + info.Mode().String()
		default:
			b, _ := os.ReadFile(p)
			sum := sha256.Sum256(b)
			out[rel] = hex.EncodeToString(sum[:8]) + " " + info.Mode().String()
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func readlink(t *testing.T, p string) string {
	t.Helper()
	l, err := os.Readlink(p)
	if err != nil {
		t.Fatalf("%s is not a link: %v", p, err)
	}
	return l
}

func listed(t *testing.T, s *Service, key string) Account {
	t.Helper()
	list, err := s.Accounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	a, ok := find(list, key)
	if !ok {
		t.Fatalf("no profile %q in %v", key, keys(list))
	}
	return a
}

func actions(steps []Step) string {
	var out []string
	for _, s := range steps {
		out = append(out, s.Name+":"+s.Action)
	}
	return strings.Join(out, " ")
}

func driftKinds(a Account) string {
	if a.Drift == nil {
		return ""
	}
	var out []string
	for _, d := range a.Drift.Items {
		out = append(out, d.Kind+":"+d.Name)
	}
	return strings.Join(out, " ")
}

// share applies the plan with every replace confirmed, and configures the
// settings it returns, as the hub does.
func share(t *testing.T, s *Service, key string) ShareResult {
	t.Helper()
	plan, err := s.SharePlan(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	var confirm []string
	for _, st := range plan {
		if st.Action == StepReplace {
			confirm = append(confirm, st.Name)
		}
	}
	res, err := s.Share(ctx, key, confirm)
	if err != nil {
		t.Fatal(err)
	}
	set, err := s.SetShare(ctx, key, true)
	if err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	return res
}

// AC1: a bare home is linked to the default's entries, gets a real
// hooks.json with the default's commands and mode, and the report says so.
func TestShareBareHome(t *testing.T) {
	s, u, def, work := shareHomes(t)
	before := tree(t, filepath.Join(work, "sessions"))
	plan, err := s.SharePlan(ctx, "work")
	if err != nil {
		t.Fatal(err)
	}
	if got := actions(plan); got != "config.toml:link AGENTS.md:link AGENTS.override.md:skip rules/:link hooks.json:write" {
		t.Fatalf("plan %s", got)
	}
	res := share(t, s, "work")
	if res.Failed || !res.Hooks {
		t.Fatalf("result %+v", res)
	}
	want := "Linked config.toml, AGENTS.md and rules/, wrote hooks.json."
	if res.Report != want {
		t.Fatalf("report %q, want %q", res.Report, want)
	}
	for _, e := range []string{"config.toml", "AGENTS.md", "rules"} {
		if got := readlink(t, filepath.Join(work, e)); got != filepath.Join(def, e) {
			t.Errorf("%s links to %s", e, got)
		}
	}
	if _, err := os.Lstat(filepath.Join(work, "AGENTS.override.md")); !isNotExist(err) {
		t.Error("AGENTS.override.md is not in the default home: none is made")
	}
	fi, err := os.Lstat(filepath.Join(work, "hooks.json"))
	if err != nil || !fi.Mode().IsRegular() || fi.Mode().Perm() != 0o644 {
		t.Fatalf("hooks.json %v %v", fi, err)
	}
	if !sameHooks(filepath.Join(def, "hooks.json"), filepath.Join(work, "hooks.json")) {
		t.Error("hooks.json runs other commands")
	}
	if a := listed(t, s, "work"); !a.Share || driftKinds(a) != "skill_only_default:infra" { // the default's own skill folder
		t.Errorf("shared work: share %v drift %s", a.Share, driftKinds(a))
	}
	if !maps(before, tree(t, filepath.Join(work, "sessions"))) {
		t.Error("sessions/ changed")
	}
	if b, _ := os.ReadFile(filepath.Join(work, "auth.json")); string(b) != `{"tokens":{"access_token":"tok2"}}` {
		t.Error("auth.json changed")
	}
	_ = u
}

func maps(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// AC1, AC7: a home with its own config.toml (the real ~/.codex-work today)
// is refused while the replace is not confirmed (nothing written), then
// backed up under the confirmed name and linked.
func TestShareOverExistingFileNeedsConfirm(t *testing.T) {
	s, u, def, work := shareHomes(t)
	if err := os.WriteFile(filepath.Join(work, "config.toml"), []byte("model = \"mine\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "hooks.json"), []byte(`{"hooks":{"Stop":[{"hooks":[{"command":"other","type":"command"}]}]}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	plan, err := s.SharePlan(ctx, "work")
	if err != nil {
		t.Fatal(err)
	}
	if got := actions(plan); got != "config.toml:replace AGENTS.md:link AGENTS.override.md:skip rules/:link hooks.json:replace" {
		t.Fatalf("plan %s", got)
	}
	if plan[0].Backup != "config.toml.before-share-20261021-151002" || plan[0].Was != "file" {
		t.Fatalf("backup %+v", plan[0])
	}
	before := tree(t, u)
	for _, confirm := range [][]string{nil, {"config.toml"}, {"hooks.json"}} {
		_, err := s.Share(ctx, "work", confirm)
		var se *SettingsError
		if !errors.As(err, &se) || se.Msg != "~/.codex-work changed since you looked; look again." {
			t.Fatalf("confirm %v: %v", confirm, err)
		}
	}
	if !maps(before, tree(t, u)) {
		t.Fatal("a refused share wrote something")
	}
	res, err := s.Share(ctx, "work", []string{"config.toml", "hooks.json"})
	if err != nil {
		t.Fatal(err)
	}
	set, _ := s.SetShare(ctx, "work", true)
	s.Configure(set)
	want := "Linked config.toml, AGENTS.md and rules/, wrote hooks.json, backed up the old config.toml to config.toml.before-share-20261021-151002 and the old hooks.json to hooks.json.before-share-20261021-151002."
	if res.Report != want {
		t.Fatalf("report %q\nwant   %q", res.Report, want)
	}
	if b, _ := os.ReadFile(filepath.Join(work, "config.toml.before-share-20261021-151002")); string(b) != "model = \"mine\"\n" {
		t.Fatalf("backup %q", b)
	}
	if got := readlink(t, filepath.Join(work, "config.toml")); got != filepath.Join(def, "config.toml") {
		t.Fatalf("config.toml -> %s", got)
	}
	if a := listed(t, s, "work"); driftKinds(a) != "skill_only_default:infra" {
		t.Fatalf("drift after share: %s", driftKinds(a))
	}
}

// AC2: sharing again changes nothing and backs nothing up; a backup name
// that is taken gets -2, never overwritten.
func TestShareAgainChangesNothing(t *testing.T) {
	s, _, _, work := shareHomes(t)
	share(t, s, "work")
	before := tree(t, work)
	res := share(t, s, "work")
	if res.Report != "Nothing to change: work already shares codex's setup. codex has no hooks.json, so none was written." &&
		res.Report != "Nothing to change: work already shares codex's setup." {
		t.Fatalf("report %q", res.Report)
	}
	if !maps(before, tree(t, work)) {
		t.Fatal("a second share changed the home")
	}
	// A backup name taken in the same second.
	os.Remove(filepath.Join(work, "AGENTS.md"))
	os.WriteFile(filepath.Join(work, "AGENTS.md"), []byte("a"), 0o644)
	os.WriteFile(filepath.Join(work, "AGENTS.md.before-share-20261021-151002"), []byte("older"), 0o644)
	plan, _ := s.SharePlan(ctx, "work")
	if plan[1].Backup != "AGENTS.md.before-share-20261021-151002-2" {
		t.Fatalf("backup %q", plan[1].Backup)
	}
	share(t, s, "work")
	if b, _ := os.ReadFile(filepath.Join(work, "AGENTS.md.before-share-20261021-151002")); string(b) != "older" {
		t.Fatal("an older backup was overwritten")
	}
	if b, _ := os.ReadFile(filepath.Join(work, "AGENTS.md.before-share-20261021-151002-2")); string(b) != "a" {
		t.Fatal("no -2 backup")
	}
}

// AC5: turning sharing off leaves regular copies (a file, and rules/ with
// its tree and links) and keeps hooks.json; Share goes off.
func TestUnshareLeavesCopies(t *testing.T) {
	s, _, def, work := shareHomes(t)
	share(t, s, "work")
	res, err := s.Unshare(ctx, "work")
	if err != nil || res.Failed {
		t.Fatal(err, res)
	}
	set, _ := s.SetShare(ctx, "work", false)
	s.Configure(set)
	if want := "Copied config.toml, AGENTS.md and rules/ from codex: work keeps them as its own and no longer follows codex. Its hooks.json stays."; res.Report != want {
		t.Fatalf("report %q", res.Report)
	}
	for _, e := range []string{"config.toml", "AGENTS.md", "rules/default.rules", "rules/more/deep.rules"} {
		fi, err := os.Lstat(filepath.Join(work, e))
		if err != nil || !fi.Mode().IsRegular() {
			t.Fatalf("%s: %v %v", e, fi, err)
		}
		a, _ := os.ReadFile(filepath.Join(def, e))
		b, _ := os.ReadFile(filepath.Join(work, e))
		if string(a) != string(b) {
			t.Errorf("%s differs", e)
		}
	}
	if fi, _ := os.Lstat(filepath.Join(work, "config.toml")); fi.Mode().Perm() != 0o600 {
		t.Errorf("config.toml mode %v", fi.Mode())
	}
	if fi, _ := os.Lstat(filepath.Join(work, "rules")); !fi.IsDir() {
		t.Error("rules/ is not a folder")
	}
	if l := readlink(t, filepath.Join(work, "rules", "alias.rules")); l != filepath.Join(def, "rules/default.rules") {
		t.Errorf("rules/alias.rules -> %s", l)
	}
	if fi, err := os.Lstat(filepath.Join(work, "hooks.json")); err != nil || !fi.Mode().IsRegular() {
		t.Error("hooks.json is gone")
	}
	ents, _ := os.ReadDir(work)
	for _, e := range ents {
		if strings.Contains(e.Name(), ".h3d-") {
			t.Errorf("left over %s", e.Name())
		}
	}
	if a := listed(t, s, "work"); a.Share || a.Drift != nil {
		t.Errorf("after unshare: share %v drift %s", a.Share, driftKinds(a))
	}
	// The default's files are untouched, and a change there no longer reaches work.
	os.WriteFile(filepath.Join(def, "AGENTS.md"), []byte("changed"), 0o644)
	if b, _ := os.ReadFile(filepath.Join(work, "AGENTS.md")); string(b) != "# be kind\n" {
		t.Error("work still follows the default")
	}
}

// AC3, AC4: each drift kind, in plain words; a hidden profile and one that
// does not share have none; Fix (share again) clears it and keeps the
// backup.
func TestDriftKinds(t *testing.T) {
	s, u, def, work := shareHomes(t)
	share(t, s, "work")
	// sed -i: a temp file renamed over the link.
	tmp := filepath.Join(work, "sedXYZ")
	os.WriteFile(tmp, []byte("edited\n"), 0o600)
	if err := os.Rename(tmp, filepath.Join(work, "config.toml")); err != nil {
		t.Fatal(err)
	}
	os.Remove(filepath.Join(work, "AGENTS.md"))
	os.Remove(filepath.Join(work, "rules"))
	os.Symlink(filepath.Join(u, "elsewhere"), filepath.Join(work, "rules"))
	os.WriteFile(filepath.Join(work, "hooks.json"), []byte(`{"hooks":{"SessionStart":[{"hooks":[{"command":"bash other.sh","type":"command"}]}]}}`), 0o644)
	os.MkdirAll(filepath.Join(work, "skills", "mine"), 0o755)
	os.MkdirAll(filepath.Join(work, "skills", ".system", "x"), 0o755)
	a := listed(t, s, "work")
	want := "link_replaced:config.toml link_missing:AGENTS.md link_elsewhere:rules/ hooks_differ:hooks.json skill_only_default:infra skill_only_profile:mine"
	if got := driftKinds(a); got != want {
		t.Fatalf("drift %s\nwant  %s", got, want)
	}
	texts := map[string]string{}
	for _, d := range a.Drift.Items {
		texts[d.Name] = d.Text
	}
	for name, want := range map[string]string{
		"config.toml": "config.toml is no longer a link: a file replaced it (MCP servers only on codex: alterlab, kaneo)",
		"AGENTS.md":   "AGENTS.md is not linked to codex's",
		"rules/":      "rules/ links somewhere else, not to codex's",
		"hooks.json":  "hooks.json runs other commands than codex's",
		"infra":       "skill infra is only on codex",
		"mine":        "skill mine is only on work",
	} {
		if texts[name] != want {
			t.Errorf("%s: %q, want %q", name, texts[name], want)
		}
	}
	if note := SetupNote(mustList(t, s), a); !strings.HasPrefix(note, "work's shared setup has drifted from codex's: config.toml is no longer a link") {
		t.Errorf("note %q", note)
	}
	// A missing target and a missing hooks.json.
	os.Remove(filepath.Join(work, "hooks.json"))
	os.Remove(filepath.Join(work, "AGENTS.md"))
	os.Symlink(filepath.Join(def, "AGENTS.md"), filepath.Join(work, "AGENTS.md"))
	os.Rename(filepath.Join(def, "AGENTS.md"), filepath.Join(u, "AGENTS.md.away"))
	a = listed(t, s, "work")
	if got := driftKinds(a); !strings.Contains(got, "target_missing:AGENTS.md") || !strings.Contains(got, "hooks_missing:hooks.json") {
		t.Fatalf("drift %s", got)
	}
	os.Rename(filepath.Join(u, "AGENTS.md.away"), filepath.Join(def, "AGENTS.md"))
	// Hidden: none; sharing off: none.
	set, _ := s.SetHidden(ctx, "work", true)
	s.Configure(set)
	if a := listed(t, s, "work"); a.Drift != nil {
		t.Errorf("hidden: %s", driftKinds(a))
	}
	set, _ = s.SetHidden(ctx, "work", false)
	s.Configure(override(set, work, func(o *Override) { o.Share = false }))
	if a := listed(t, s, "work"); a.Drift != nil || a.Share {
		t.Errorf("sharing off: %s", driftKinds(a))
	}
	// Fix: share again; the replaced config.toml is backed up.
	s.Configure(override(s.Settings(), work, func(o *Override) { o.Share = true }))
	os.RemoveAll(filepath.Join(work, "skills", "mine"))
	share(t, s, "work")
	s.MoveSkill(ctx, "codex", "infra")
	if a := listed(t, s, "work"); a.Drift != nil {
		t.Fatalf("after Fix: %s", driftKinds(a))
	}
	if b, _ := os.ReadFile(filepath.Join(work, "config.toml.before-share-20261021-151002")); string(b) != "edited\n" {
		t.Errorf("backup %q", b)
	}
}

func mustList(t *testing.T, s *Service) []Account {
	t.Helper()
	l, err := s.Accounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// The skill fix moves a real folder into ~/.agents/skills and leaves a
// link; a name already there is refused, nothing moved.
func TestMoveSkill(t *testing.T) {
	s, u, def, _ := shareHomes(t)
	res, err := s.MoveSkill(ctx, "codex", "infra")
	if err != nil || res.Failed {
		t.Fatal(err, res)
	}
	if want := "Moved the skill infra to ~/.agents/skills/infra and left a link in codex's skills/: every Codex home sees it now."; res.Report != want {
		t.Fatalf("report %q", res.Report)
	}
	if l := readlink(t, filepath.Join(def, "skills", "infra")); l != filepath.Join(u, ".agents/skills/infra") {
		t.Fatalf("link %s", l)
	}
	if b, _ := os.ReadFile(filepath.Join(u, ".agents/skills/infra/SKILL.md")); string(b) != "infra\n" {
		t.Fatal("not moved")
	}
	os.MkdirAll(filepath.Join(def, "skills", "handoff2"), 0o755)
	os.MkdirAll(filepath.Join(u, ".agents/skills/handoff2"), 0o755)
	before := tree(t, u)
	for _, name := range []string{"handoff2", "handoff", ".system", "../x", "", "nope"} {
		_, err := s.MoveSkill(ctx, "codex", name)
		var se *SettingsError
		if !errors.As(err, &se) {
			t.Errorf("%q: %v", name, err)
		}
	}
	if _, err := s.MoveSkill(ctx, "nobody", "infra"); !errors.As(err, new(*NotFoundError)) {
		t.Errorf("unknown key: %v", err)
	}
	if !maps(before, tree(t, u)) {
		t.Fatal("a refused move wrote something")
	}
}

// AC7: the default, an unknown key and a profile whose folder is gone are
// refused, nothing written; a path is never taken from the caller.
func TestShareRefusesOutsideTheList(t *testing.T) {
	s, u, _, _ := shareHomes(t)
	gone := filepath.Join(u, "gone")
	os.MkdirAll(gone, 0o755)
	set, err := s.Add(ctx, gone)
	if err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	os.Remove(gone)
	before := tree(t, u)
	for _, key := range []string{"codex", "nobody", hashed("gone", gone), "../.codex"} {
		if _, err := s.Share(ctx, key, nil); err == nil {
			t.Errorf("%s: shared", key)
		}
		if _, err := s.Unshare(ctx, key); err == nil {
			t.Errorf("%s: unshared", key)
		}
		if _, err := s.SharePlan(ctx, key); err == nil {
			t.Errorf("%s: planned", key)
		}
	}
	if !maps(before, tree(t, u)) {
		t.Fatal("a refusal wrote something")
	}
}

// AC6: no config value in any drift item, report, note or the list's JSON.
func TestShareNeverShowsAConfigValue(t *testing.T) {
	s, _, _, work := shareHomes(t)
	var seen []string
	plan, _ := s.SharePlan(ctx, "work")
	seen = append(seen, mustJSON(t, plan))
	seen = append(seen, share(t, s, "work").Report)
	os.Remove(filepath.Join(work, "config.toml"))
	os.WriteFile(filepath.Join(work, "config.toml"), []byte(`[mcp_servers.other]
env = { KEY = "`+secret+`" }
`), 0o600)
	list := mustList(t, s)
	seen = append(seen, mustJSON(t, list))
	for _, a := range list {
		seen = append(seen, SetupNote(list, a))
	}
	res, _ := s.Unshare(ctx, "work")
	seen = append(seen, res.Report)
	if !strings.Contains(strings.Join(seen, "\n"), "alterlab") {
		t.Fatal("expected the server names to be named")
	}
	for _, s := range seen {
		if strings.Contains(s, secret) || strings.Contains(s, "ALTERLAB_API_KEY") {
			t.Fatalf("a config value leaked: %s", s)
		}
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// #139's hire note: a profile that does not share says what it lacks.
func TestSetupNote(t *testing.T) {
	s, _, _, work := shareHomes(t)
	list := mustList(t, s)
	work0, _ := find(list, "work")
	if got := SetupNote(list, work0); got != "work does not share setup with codex: no MCP servers, no herdr hooks." {
		t.Errorf("note %q", got)
	}
	os.WriteFile(filepath.Join(work, "hooks.json"), []byte(defHooks), 0o644)
	if got := SetupNote(list, work0); got != "work does not share setup with codex: no MCP servers." {
		t.Errorf("note %q", got)
	}
	share(t, s, "work")
	s.MoveSkill(ctx, "codex", "infra")
	list = mustList(t, s)
	work1, _ := find(list, "work")
	def, _ := find(list, "codex")
	if got := SetupNote(list, work1) + SetupNote(list, def); got != "" {
		t.Errorf("shared, in step: %q", got)
	}
}

// The share flag is kept by Clean and survives a rename back to the key.
func TestShareSettingKept(t *testing.T) {
	s, _, _, work := shareHomes(t)
	share(t, s, "work")
	set, err := s.Rename(ctx, "work", "Work seat")
	if err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	set, _ = s.Rename(ctx, "work", "work")
	s.Configure(Clean(set))
	if a := listed(t, s, "work"); !a.Share {
		t.Fatal("share was dropped")
	}
	if got := Clean(Settings{Overrides: []Override{{Path: work, Share: true}}}); len(got.Overrides) != 1 || !got.Overrides[0].Share {
		t.Fatalf("clean %+v", got)
	}
}

// The poller compares lists with Equal: the same drift twice is no change.
func TestAccountEqualComparesDrift(t *testing.T) {
	a := Account{Key: "work", Share: true, Drift: &Drift{Items: []DriftItem{{Kind: DriftHooksMissing, Name: "hooks.json", Text: "x"}}}}
	b := a
	b.Drift = &Drift{Items: slices.Clone(a.Drift.Items)}
	if !a.Equal(b) {
		t.Fatal("same drift, not equal")
	}
	b.Drift.Items[0].Text = "y"
	if a.Equal(b) || a.Equal(Account{Key: "work", Share: true}) {
		t.Fatal("other drift, equal")
	}
}
