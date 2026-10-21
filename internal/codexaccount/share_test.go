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
	"syscall"
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
	os.WriteFile(tmp, []byte("model = \"edited\"\n"), 0o600)
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
	if b, _ := os.ReadFile(filepath.Join(work, "config.toml.before-share-20261021-151002")); string(b) != "model = \"edited\"\n" {
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

// AC6 (review R1): a header-looking line inside a value of the default's
// config.toml (a multi-line string of either kind, an array of strings over
// lines) is not a server: no drift item, report or note names it.
func TestConfigValueNeverNamed(t *testing.T) {
	for name, config := range map[string]string{
		"multi-line literal": "developer_instructions = '''\n[mcp_servers.\"" + secret + "\"]\n'''\n",
		"multi-line basic":   "developer_instructions = \"\"\"\n[mcp_servers.\"" + secret + "\"]\n\"\"\"\n",
		"array over lines":   "notes = [\n  \"a\",\n  '''\n[mcp_servers." + secret + "]\n''',\n  \"[mcp_servers." + secret + "]\",\n]\n",
	} {
		t.Run(name, func(t *testing.T) {
			s, _, def, work := shareHomes(t)
			if err := os.WriteFile(filepath.Join(def, "config.toml"), []byte(config), 0o600); err != nil {
				t.Fatal(err)
			}
			seen := []string{share(t, s, "work").Report}
			os.Remove(filepath.Join(work, "config.toml"))
			if err := os.WriteFile(filepath.Join(work, "config.toml"), []byte("model = \"mine\"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			list := mustList(t, s)
			a, _ := find(list, "work")
			if got := driftKinds(a); !strings.Contains(got, "link_replaced:config.toml") {
				t.Fatalf("drift %s", got)
			}
			seen = append(seen, mustJSON(t, list))
			for _, d := range a.Drift.Items {
				seen = append(seen, d.Text)
			}
			unshared := a
			unshared.Share = false
			seen = append(seen, SetupNote(list, a), SetupNote(list, unshared))
			plan, _ := s.SharePlan(ctx, "work")
			seen = append(seen, mustJSON(t, plan))
			res, err := s.Share(ctx, "work", []string{"config.toml"})
			if err != nil {
				t.Fatal(err)
			}
			seen = append(seen, res.Report)
			for _, x := range seen {
				if strings.Contains(x, secret) || strings.Contains(x, "MCP servers") {
					t.Fatalf("a value was named as a server: %s", x)
				}
			}
		})
	}
}

// AC5 (review R5): a default whose rules/ is itself a link: unsharing
// copies the folder it names (a link inside stays a link).
func TestUnshareLinkedDefaultRules(t *testing.T) {
	s, u, def, work := shareHomes(t)
	shared := filepath.Join(u, "shared-rules")
	if err := os.Rename(filepath.Join(def, "rules"), shared); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(shared, filepath.Join(def, "rules")); err != nil {
		t.Fatal(err)
	}
	share(t, s, "work")
	res, err := s.Unshare(ctx, "work")
	if err != nil || res.Failed {
		t.Fatal(err, res)
	}
	if fi, err := os.Lstat(filepath.Join(work, "rules")); err != nil || !fi.IsDir() {
		t.Fatalf("rules/ is not a folder of its own: %v %v; %s", fi, err, res.Report)
	}
	if fi, err := os.Lstat(filepath.Join(work, "rules", "more", "deep.rules")); err != nil || !fi.Mode().IsRegular() {
		t.Fatalf("deep.rules not copied: %v %v", fi, err)
	}
	readlink(t, filepath.Join(work, "rules", "alias.rules"))
}

func hooksJSON(t *testing.T, command string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"hooks": map[string]any{"SessionStart": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": command}}}}}})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// AC4 (review R6): hook commands are compared as written (a space inside
// quotes counts) and only the JSON's formatting is set aside; a Fix
// restores a changed command.
func TestHooksComparedAsWritten(t *testing.T) {
	s, _, def, work := shareHomes(t)
	if err := os.WriteFile(filepath.Join(def, "hooks.json"), hooksJSON(t, "printf '%s' 'a  b'"), 0o600); err != nil {
		t.Fatal(err)
	}
	share(t, s, "work")
	// The same hooks, laid out and ordered otherwise: no drift.
	os.WriteFile(filepath.Join(work, "hooks.json"), []byte("{\n  \"hooks\": {\"SessionStart\": [\n    {\"hooks\": [{\"command\": \"printf '%s' 'a  b'\", \"type\": \"command\"}]}\n  ]}\n}\n"), 0o600)
	const skill = "skill_only_default:infra" // the default's skill, not shared
	if got := driftKinds(listed(t, s, "work")); got != skill {
		t.Fatalf("formatting is drift: %s", got)
	}
	os.WriteFile(filepath.Join(work, "hooks.json"), hooksJSON(t, "printf '%s' 'a b'"), 0o600)
	if got := driftKinds(listed(t, s, "work")); got != "hooks_differ:hooks.json "+skill {
		t.Fatalf("drift %q", got)
	}
	plan, err := s.SharePlan(ctx, "work")
	if err != nil {
		t.Fatal(err)
	}
	if last := plan[len(plan)-1]; last.Name != hooksFile || last.Action != StepReplace {
		t.Fatalf("Fix keeps the changed hooks: %+v", last)
	}
	if res, err := s.Share(ctx, "work", []string{hooksFile}); err != nil || res.Failed {
		t.Fatal(err, res)
	}
	if b, _ := os.ReadFile(filepath.Join(work, "hooks.json")); string(b) != string(hooksJSON(t, "printf '%s' 'a  b'")) {
		t.Fatalf("Fix wrote %s", b)
	}
	if got := driftKinds(listed(t, s, "work")); got != skill {
		t.Fatalf("drift after the Fix: %s", got)
	}
}

// AC7 (review R2): a skill is moved only from a skills/ that is a folder
// of its own, into a ~/.agents/skills that is one: a skills/ linked to
// sessions/ or out of the listed homes, or a linked ~/.agents/skills, is
// refused and nothing is written.
func TestMoveSkillOnlyThroughRealFolders(t *testing.T) {
	t.Run("skills/ linked to sessions/", func(t *testing.T) {
		s, u, _, work := shareHomes(t)
		os.Symlink(filepath.Join(work, "sessions"), filepath.Join(work, "skills"))
		before := tree(t, u)
		if _, err := s.MoveSkill(ctx, "work", "2026"); !errors.As(err, new(*SettingsError)) {
			t.Fatalf("moved: %v", err)
		}
		if !maps(before, tree(t, u)) {
			t.Fatal("a refused move wrote something")
		}
	})
	t.Run("skills/ linked out of the homes", func(t *testing.T) {
		s, u, _, work := shareHomes(t)
		outside := t.TempDir()
		os.MkdirAll(filepath.Join(outside, "mine"), 0o755)
		os.WriteFile(filepath.Join(outside, "mine", "SKILL.md"), []byte("keep"), 0o600)
		os.Symlink(outside, filepath.Join(work, "skills"))
		before, out := tree(t, u), tree(t, outside)
		if _, err := s.MoveSkill(ctx, "work", "mine"); !errors.As(err, new(*SettingsError)) {
			t.Fatalf("moved: %v", err)
		}
		if !maps(before, tree(t, u)) || !maps(out, tree(t, outside)) {
			t.Fatal("a refused move wrote something")
		}
	})
	for _, link := range []string{".agents", ".agents/skills"} {
		t.Run(link+" a link", func(t *testing.T) {
			s, u, _, _ := shareHomes(t)
			elsewhere := t.TempDir()
			os.RemoveAll(filepath.Join(u, link))
			os.Symlink(elsewhere, filepath.Join(u, link))
			before, out := tree(t, u), tree(t, elsewhere)
			if _, err := s.MoveSkill(ctx, "codex", "infra"); !errors.As(err, new(*SettingsError)) {
				t.Fatalf("moved: %v", err)
			}
			if !maps(before, tree(t, u)) || !maps(out, tree(t, elsewhere)) {
				t.Fatal("a refused move wrote something")
			}
		})
	}
	t.Run("no ~/.agents yet", func(t *testing.T) {
		s, u, _, _ := shareHomes(t)
		os.RemoveAll(filepath.Join(u, ".agents"))
		if res, err := s.MoveSkill(ctx, "codex", "infra"); err != nil || res.Failed {
			t.Fatal(err, res)
		}
		for _, d := range []string{".agents", ".agents/skills", ".agents/skills/infra"} {
			if !realDir(filepath.Join(u, d)) {
				t.Fatalf("%s is not a folder", d)
			}
		}
	})
}

// otherFS is a fresh folder on another file system than near (/dev/shm),
// or the test is skipped when there is none: a rename between them fails
// with EXDEV.
func otherFS(t *testing.T, near string) string {
	t.Helper()
	dir, err := os.MkdirTemp("/dev/shm", "h3d-move-")
	if err != nil {
		t.Skipf("no second file system: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	probe := filepath.Join(near, ".probe")
	if err := os.Mkdir(probe, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(probe)
	if err := renameNew(probe, filepath.Join(dir, "probe")); !errors.Is(err, syscall.EXDEV) {
		os.Remove(filepath.Join(dir, "probe"))
		t.Skipf("/dev/shm is not another file system: %v", err)
	}
	return dir
}

// noTemp fails when a copy's temp folder (.<name>.h3d-…) is left in dir.
func noTemp(t *testing.T, dir string) {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range es {
		if strings.Contains(e.Name(), ".h3d-") {
			t.Errorf("temp %s left", e.Name())
		}
	}
}

// skillTree writes a skill at dir: files with their modes, a folder with
// its own, a link inside.
func skillTree(t *testing.T, dir string) {
	t.Helper()
	for name, mode := range map[string]os.FileMode{"SKILL.md": 0o644, "bin/run": 0o755, "bin/key": 0o600} {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(name+"\n"), mode); err != nil {
			t.Fatal(err)
		}
		os.Chmod(p, mode)
	}
	os.Chmod(filepath.Join(dir, "bin"), 0o750)
	if err := os.Symlink("bin/run", filepath.Join(dir, "run")); err != nil {
		t.Fatal(err)
	}
}

// readOnly makes the folder dir read-only until the test ends.
func readOnly(t *testing.T, dir string) {
	t.Helper()
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
}

// Review R2-1: across file systems the move copies beside dst and renames
// the copy to it, never over anything: a dst that appeared meanwhile is
// left as it is (only the copy is removed), and so is src.
func TestMoveTreeAcrossFileSystems(t *testing.T) {
	t.Run("a folder that appeared meanwhile stays", func(t *testing.T) {
		src := filepath.Join(t.TempDir(), "source")
		if err := os.Mkdir(src, 0o700); err != nil {
			t.Fatal(err)
		}
		skillTree(t, src)
		dstRoot := otherFS(t, filepath.Dir(src))
		dst := filepath.Join(dstRoot, "skill")
		if err := os.Mkdir(dst, 0o700); err != nil {
			t.Fatal(err)
		}
		sentinel := filepath.Join(dst, "existing.txt")
		if err := os.WriteFile(sentinel, []byte("irreplaceable"), 0o600); err != nil {
			t.Fatal(err)
		}
		before, there := tree(t, src), tree(t, dst)
		moved, err := moveTree(src, dst)
		if moved || !errors.Is(err, fs.ErrExist) {
			t.Fatalf("moved=%v err=%v", moved, err)
		}
		if got, err := os.ReadFile(sentinel); err != nil || string(got) != "irreplaceable" {
			t.Fatalf("existing destination lost: %v %q", err, got)
		}
		if !maps(there, tree(t, dst)) || !maps(before, tree(t, src)) {
			t.Fatal("a refused move changed a folder")
		}
		noTemp(t, dstRoot)
	})
	t.Run("nothing in the way", func(t *testing.T) {
		src := filepath.Join(t.TempDir(), "source")
		if err := os.Mkdir(src, 0o700); err != nil {
			t.Fatal(err)
		}
		skillTree(t, src)
		dstRoot := otherFS(t, filepath.Dir(src))
		dst := filepath.Join(dstRoot, "skill")
		before := tree(t, src)
		if moved, err := moveTree(src, dst); !moved || err != nil {
			t.Fatalf("moved=%v err=%v", moved, err)
		}
		if !maps(before, tree(t, dst)) {
			t.Fatalf("copy %v, want %v", tree(t, dst), before)
		}
		if _, err := os.Lstat(src); !isNotExist(err) {
			t.Fatalf("source still there: %v", err)
		}
		noTemp(t, dstRoot)
	})
}

// R2-1: MoveSkill across file systems: the skill arrives whole, the link is
// left; an old folder that cannot all be removed is reported, the copy kept.
func TestMoveSkillAcrossFileSystems(t *testing.T) {
	setup := func(t *testing.T) (*Service, string, string, string) {
		def := filepath.Join(t.TempDir(), ".codex")
		skillTree(t, filepath.Join(def, "skills", "infra"))
		u := otherFS(t, def)
		s := New(u, def)
		return s, list(u, def, s.Settings())[0].Key, filepath.Join(def, "skills", "infra"), filepath.Join(u, ".agents", "skills")
	}
	t.Run("moved", func(t *testing.T) {
		s, key, src, dir := setup(t)
		before := tree(t, src)
		res, err := s.MoveSkill(ctx, key, "infra")
		if err != nil || res.Failed {
			t.Fatal(err, res)
		}
		if want := "Moved the skill infra to ~/.agents/skills/infra and left a link in codex's skills/: every Codex home sees it now."; res.Report != want {
			t.Fatalf("report %q", res.Report)
		}
		if !maps(before, tree(t, filepath.Join(dir, "infra"))) {
			t.Fatal("the skill did not arrive whole")
		}
		if l := readlink(t, src); l != filepath.Join(dir, "infra") {
			t.Fatalf("link %s", l)
		}
		noTemp(t, dir)
	})
	t.Run("old folder not all removed", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root removes a read-only folder's files")
		}
		s, key, src, dir := setup(t)
		readOnly(t, filepath.Dir(src)) // the folder cannot be removed from skills/
		before := tree(t, src)
		res, err := s.MoveSkill(ctx, key, "infra")
		if err != nil || !res.Failed {
			t.Fatal(err, res)
		}
		if want := "Copied the skill infra to ~/.agents/skills/infra, but its old folder in codex's skills/ could not all be removed: both are there now. Remove the old one by hand."; res.Report != want {
			t.Fatalf("report %q", res.Report)
		}
		if !maps(before, tree(t, filepath.Join(dir, "infra"))) {
			t.Fatal("the copy is not whole")
		}
		noTemp(t, dir)
	})
}

// Review R3/R4: what appeared since the plan is never overwritten. A
// backup name taken meanwhile: the next free one, and the report names it.
// A hooks.json or an entry where the plan saw none: left as it is, and the
// share stops there, saying so.
func TestShareNeverOverwrites(t *testing.T) {
	t.Run("backup name taken", func(t *testing.T) {
		s, _, def, work := shareHomes(t)
		os.WriteFile(filepath.Join(work, "config.toml"), []byte("profile original"), 0o600)
		plan := planShare(def, work, s.clock())
		backup := filepath.Join(work, plan[0].Backup)
		os.WriteFile(backup, []byte("irreplaceable earlier backup"), 0o600)
		done, err := applySteps(def, work, plan, s.clock())
		if err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(backup); string(b) != "irreplaceable earlier backup" {
			t.Fatalf("backup overwritten: %q", b)
		}
		if done[0].Backup != plan[0].Backup+"-2" {
			t.Fatalf("backup %s", done[0].Backup)
		}
		if b, _ := os.ReadFile(filepath.Join(work, done[0].Backup)); string(b) != "profile original" {
			t.Fatalf("-2 holds %q", b)
		}
		if r := shareReport(done, "work", "codex"); !strings.Contains(r, "config.toml.before-share-20261021-151002-2") {
			t.Fatalf("report %q", r)
		}
	})
	for _, entry := range []string{hooksFile, "AGENTS.md"} {
		t.Run(entry+" appeared", func(t *testing.T) {
			s, _, def, work := shareHomes(t)
			plan := planShare(def, work, s.clock())
			p := filepath.Join(work, entry)
			os.WriteFile(p, []byte("concurrent user's"), 0o600)
			done, err := applySteps(def, work, plan, s.clock())
			if err == nil || err.Error() != "a new "+entry+" appeared meanwhile: left as it is" {
				t.Fatalf("err %v", err)
			}
			if b, _ := os.ReadFile(p); string(b) != "concurrent user's" {
				t.Fatalf("overwritten: %q", b)
			}
			if backups, _ := filepath.Glob(p + ".before-share-*"); len(backups) > 0 || strings.Contains(actions(done), entry) {
				t.Fatalf("%v %s", backups, actions(done))
			}
		})
	}
	// A FIFO where the default's hooks.json is: refused, not waited on.
	t.Run("hooks.json a FIFO", func(t *testing.T) {
		s, _, def, work := shareHomes(t)
		hooks := filepath.Join(def, hooksFile)
		os.Remove(hooks)
		if err := syscall.Mkfifo(hooks, 0o600); err != nil {
			t.Fatal(err)
		}
		done := make(chan ShareResult, 1)
		go func() {
			res, _ := s.Share(ctx, "work", nil)
			done <- res
		}()
		select {
		case res := <-done:
			if !res.Failed || !strings.Contains(res.Report, "Stopped: hooks.json: hooks.json is not a regular file.") {
				t.Fatalf("report %q", res.Report)
			}
		case <-time.After(5 * time.Second):
			w, _ := os.OpenFile(hooks, os.O_WRONLY, 0)
			w.Close()
			t.Fatal("share waited on the FIFO")
		}
		if _, err := os.Lstat(filepath.Join(work, hooksFile)); !isNotExist(err) {
			t.Fatalf("hooks.json written: %v", err)
		}
	})
}
