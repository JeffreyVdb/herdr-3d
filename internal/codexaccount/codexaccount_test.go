package codexaccount

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

var ctx = context.Background()

// home makes a user home folder with Codex homes: name → whether it has an
// auth.json.
func home(t *testing.T, homes map[string]bool) string {
	t.Helper()
	dir := t.TempDir()
	for name, auth := range homes {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if auth {
			if err := os.WriteFile(filepath.Join(p, "auth.json"), []byte(`{"tokens":{"access_token":"secret"}}`), 0o600); err != nil {
				t.Fatal(err)
			}
		}
	}
	return dir
}

func keys(list []Account) []string {
	out := []string{}
	for _, a := range list {
		out = append(out, a.Key)
	}
	return out
}

// hashed is the key of a folder that is not the default nor ~/.codex-<base>.
func hashed(base, home string) string {
	sum := sha256.Sum256([]byte(home))
	return base + "-" + hex.EncodeToString(sum[:3])
}

func TestOnlyTheDefaultHome(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".config": false})
	got, err := New(h, filepath.Join(h, ".codex")).Accounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := []Account{{Key: "codex", Name: "codex", Home: filepath.Join(h, ".codex"), Default: true, Exists: true, SignedIn: true}}
	if !slices.Equal(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

func TestSiblingsNeedAnAuthJSON(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true, ".codex-empty": false, ".codex-": true, "codex-x": true})
	if err := os.WriteFile(filepath.Join(h, ".codex-file"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	got, _ := New(h, filepath.Join(h, ".codex")).Accounts(ctx)
	if k := keys(got); !slices.Equal(k, []string{"codex", "work"}) {
		t.Fatalf("keys %v", k)
	}
	if w := got[1]; w.Default || w.Added || !w.SignedIn || w.Name != "work" || w.Home != filepath.Join(h, ".codex-work") {
		t.Fatalf("work %+v", w)
	}
}

// The bridge's own home without an auth.json (or not there at all) is
// still its profile: "not signed in", not an error.
func TestDefaultWithoutAuthIsAProfile(t *testing.T) {
	h := home(t, map[string]bool{".codex": false})
	got, _ := New(h, filepath.Join(h, ".codex")).Accounts(ctx)
	if len(got) != 1 || got[0].SignedIn || !got[0].Exists {
		t.Fatalf("got %+v", got)
	}
	got, _ = New(h, filepath.Join(h, "nowhere")).Accounts(ctx)
	if len(got) != 1 || got[0].SignedIn || got[0].Exists || !got[0].Default || got[0].Key != "nowhere" {
		t.Fatalf("missing default: %+v", got)
	}
}

// $CODEX_HOME pointing at a sibling makes that sibling the default, once.
func TestDefaultIsDeduplicatedAgainstSiblings(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true})
	link := filepath.Join(t.TempDir(), "work-link")
	if err := os.Symlink(filepath.Join(h, ".codex-work"), link); err != nil {
		t.Fatal(err)
	}
	got, _ := New(h, link).Accounts(ctx)
	if k := keys(got); !slices.Equal(k, []string{"work"}) || !got[0].Default || got[0].Home != filepath.Join(h, ".codex-work") {
		t.Fatalf("got %+v", got)
	}
}

func TestKeysAreUniqueAndFromTheFolder(t *testing.T) {
	for in, want := range map[string]string{"/h/.codex": "codex", "/h/.codex-work": "work", "/data/Team Codex": "team-codex", "/x/codex-": "codex", "/x/...": "profile"} {
		if got := keyOf(in); got != want {
			t.Errorf("keyOf(%q) = %q, want %q", in, got, want)
		}
	}
	h := home(t, map[string]bool{".codex": true, ".codex-codex": true, "else/codex": false})
	s := New(h, filepath.Join(h, ".codex"))
	s.Configure(Settings{Added: []string{filepath.Join(h, "else/codex")}})
	got, _ := s.Accounts(ctx)
	want := []string{"codex", hashed("codex", filepath.Join(h, ".codex-codex")), hashed("codex", filepath.Join(h, "else/codex"))}
	if k := keys(got); !slices.Equal(k, want) {
		t.Fatalf("keys %v, want %v", k, want)
	}
	// Three folders called codex: each is named by its key.
	if n := got[2].Name; n != want[2] {
		t.Fatalf("name %q", n)
	}
}

// R1 of the #138 review: a key is the folder's alone. Whichever of the
// other folders are there (found or added), every folder keeps the key it
// has with all of them there, and no two share one.
func TestKeysDependOnTheFolderAlone(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-a": false, ".codex-+a": false, ".codex-codex": false, ".codex-b": false, "else/a": false, "else/b": false})
	found := []string{".codex-a", ".codex-+a", ".codex-codex"} // found when they have an auth.json
	added := []string{".codex-b", "else/a", "else/b"}
	s := New(h, filepath.Join(h, ".codex"))
	listWith := func(mask int) map[string]string {
		t.Helper()
		set := Settings{Added: []string{}}
		for i, name := range append(slices.Clone(found), added...) {
			on := mask&(1<<i) != 0
			if i >= len(found) {
				if on {
					set.Added = append(set.Added, filepath.Join(h, name))
				}
				continue
			}
			auth := filepath.Join(h, name, "auth.json")
			if on {
				if err := os.WriteFile(auth, []byte(`{}`), 0o600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Remove(auth); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		}
		s.Configure(set)
		got, _ := s.Accounts(ctx)
		out := map[string]string{}
		seen := map[string]bool{}
		for _, a := range got {
			if seen[a.Key] {
				t.Fatalf("mask %b: key %q twice in %v", mask, a.Key, keys(got))
			}
			seen[a.Key] = true
			out[a.Home] = a.Key
		}
		return out
	}
	all := 1<<(len(found)+len(added)) - 1
	want := listWith(all)
	if len(want) != 1+len(found)+len(added) {
		t.Fatalf("all: %v", want)
	}
	for _, c := range []struct{ name, key string }{{".codex", "codex"}, {".codex-a", "a"}, {".codex-b", "b"},
		{".codex-+a", hashed("a", filepath.Join(h, ".codex-+a"))}, {".codex-codex", hashed("codex", filepath.Join(h, ".codex-codex"))},
		{"else/a", hashed("a", filepath.Join(h, "else/a"))}, {"else/b", hashed("b", filepath.Join(h, "else/b"))}} {
		if got := want[filepath.Join(h, c.name)]; got != c.key {
			t.Errorf("%s: key %q, want %q", c.name, got, c.key)
		}
	}
	for mask := range all {
		for home, key := range listWith(mask) {
			if key != want[home] {
				t.Errorf("mask %b: %s has key %q, %q with every folder there", mask, home, key, want[home])
			}
		}
	}
}

// A key with a path hash is named by its folder while no other profile's
// folder has that name; a stored name it now has gives way.
func TestHashedKeysAreNamedByTheFolder(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, "srv/codex-spare": false, "other/spare": false})
	s := New(h, filepath.Join(h, ".codex"))
	s.Configure(Settings{Added: []string{filepath.Join(h, "srv/codex-spare")}})
	got, _ := s.Accounts(ctx)
	if a := got[1]; a.Key != hashed("spare", filepath.Join(h, "srv/codex-spare")) || a.Name != "spare" {
		t.Fatalf("spare %+v", a)
	}
	s.Configure(Settings{Added: []string{filepath.Join(h, "srv/codex-spare"), filepath.Join(h, "other/spare")}})
	got, _ = s.Accounts(ctx)
	if got[1].Name != got[1].Key || got[2].Name != got[2].Key {
		t.Fatalf("two spares: %+v", got[1:])
	}
	s.Configure(Settings{Added: []string{filepath.Join(h, "srv/codex-spare")}, Overrides: []Override{{Path: filepath.Join(h, ".codex"), Name: "spare"}}})
	got, _ = s.Accounts(ctx)
	if got[0].Name != "codex" || got[1].Name != "spare" {
		t.Fatalf("stored name gives way: %+v", got)
	}
}

func TestRenameHideAddRemove(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true, "spare": false})
	s := New(h, filepath.Join(h, ".codex"))
	apply := func(set Settings, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		s.Configure(set)
	}
	apply(s.Rename(ctx, "work", "  Work seat "))
	apply(s.SetHidden(ctx, "work", true))
	apply(s.Add(ctx, "~/spare/"))
	got, _ := s.Accounts(ctx)
	spare := hashed("spare", filepath.Join(h, "spare"))
	if k := keys(got); !slices.Equal(k, []string{"codex", "work", spare}) {
		t.Fatalf("keys %v", k)
	}
	if w := got[1]; w.Name != "Work seat" || !w.Hidden {
		t.Fatalf("work %+v", w)
	}
	if sp := got[2]; !sp.Added || sp.SignedIn || !sp.Exists || sp.Home != filepath.Join(h, "spare") || sp.Name != "spare" {
		t.Fatalf("spare %+v", sp)
	}
	if set := s.Settings(); !slices.Equal(set.Added, []string{filepath.Join(h, "spare")}) {
		t.Fatalf("added %v", set.Added)
	}
	// Back to its own key: the override is gone once it holds nothing.
	apply(s.Rename(ctx, "work", "work"))
	apply(s.SetHidden(ctx, "work", false))
	if set := s.Settings(); len(set.Overrides) != 0 {
		t.Fatalf("overrides %+v", set.Overrides)
	}
	apply(s.Rename(ctx, spare, "Spare"))
	apply(s.Remove(ctx, spare))
	if set := s.Settings(); len(set.Added) != 0 || len(set.Overrides) != 0 {
		t.Fatalf("after remove %+v", set)
	}
}

func TestSettingsAreChecked(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true, "other": false})
	if err := os.WriteFile(filepath.Join(h, "file"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	s := New(h, filepath.Join(h, ".codex"))
	set, err := s.Add(ctx, filepath.Join(h, "other"))
	if err != nil {
		t.Fatal(err)
	}
	s.Configure(set)
	refuse := func(what, says string, err error) {
		t.Helper()
		var se *SettingsError
		if !errors.As(err, &se) || !strings.Contains(se.Msg, says) {
			t.Errorf("%s: err %v, want a SettingsError with %q", what, err, says)
		}
	}
	var nf *NotFoundError
	if _, err := s.Rename(ctx, "nope", "x"); !errors.As(err, &nf) {
		t.Errorf("unknown key: %v", err)
	}
	refuse("empty name", "Type a name", errOf(s.Rename(ctx, "work", "   ")))
	refuse("long name", "at most 40", errOf(s.Rename(ctx, "work", strings.Repeat("é", MaxName+1))))
	refuse("line break", "line break", errOf(s.Rename(ctx, "work", "a\nb")))
	refuse("taken name", "Another profile", errOf(s.Rename(ctx, "work", "CODEX")))
	refuse("taken key", "Another profile", errOf(s.Rename(ctx, "codex", "Work")))
	if _, err := s.Rename(ctx, "work", strings.Repeat("é", MaxName)); err != nil {
		t.Errorf("a name of MaxName characters: %v", err)
	}
	refuse("hide default", "cannot be hidden", errOf(s.SetHidden(ctx, "codex", true)))
	refuse("remove found", "only hidden", errOf(s.Remove(ctx, "work")))
	refuse("relative", "absolute path", errOf(s.Add(ctx, "devel/x")))
	refuse("empty path", "Type the folder", errOf(s.Add(ctx, " ")))
	refuse("missing", "no folder there", errOf(s.Add(ctx, filepath.Join(h, "gone"))))
	refuse("file", "not a folder", errOf(s.Add(ctx, filepath.Join(h, "file"))))
	refuse("detected", "already the profile", errOf(s.Add(ctx, "~/.codex-work")))
	refuse("default", "already the profile", errOf(s.Add(ctx, filepath.Join(h, ".codex", "."))))
	refuse("added twice", "already the profile", errOf(s.Add(ctx, filepath.Join(h, "other")+"/")))
	full := Settings{}
	for i := range MaxAdded {
		full.Added = append(full.Added, filepath.Join(h, "x", strings.Repeat("a", i+1)))
	}
	s.Configure(full)
	refuse("too many", "At most 16", errOf(s.Add(ctx, filepath.Join(h, "other"))))
}

// A folder that was added and is gone (or cannot be read) is still listed,
// so it can be removed, and is not there to be read.
func TestMissingOrUnreadableAddedFolder(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, "locked": true})
	s := New(h, filepath.Join(h, ".codex"))
	s.Configure(Settings{Added: []string{filepath.Join(h, "gone"), filepath.Join(h, "locked")}})
	if err := os.Chmod(filepath.Join(h, "locked"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(h, "locked"), 0o700) })
	got, err := s.Accounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	gone := hashed("gone", filepath.Join(h, "gone"))
	if k := keys(got); !slices.Equal(k, []string{"codex", gone, hashed("locked", filepath.Join(h, "locked"))}) {
		t.Fatalf("keys %v", k)
	}
	if g := got[1]; g.Exists || g.SignedIn || !g.Added {
		t.Errorf("gone %+v", g)
	}
	if l := got[2]; !l.Exists || (l.SignedIn && os.Geteuid() != 0) {
		t.Errorf("locked %+v", l)
	}
	set, err := s.Remove(ctx, gone)
	if err != nil || len(set.Added) != 1 {
		t.Fatalf("remove gone: %v %+v", err, set)
	}
}

func TestCleanDropsWhatCannotBe(t *testing.T) {
	got := Clean(Settings{
		Added:     []string{"/a/", "/a", "rel", ""},
		Overrides: []Override{{Path: "/a", Name: " A "}, {Path: "rel", Name: "x"}, {Path: "/b"}, {Path: "/c", Hidden: true}},
	})
	if !slices.Equal(got.Added, []string{"/a"}) || !slices.Equal(got.Overrides, []Override{{Path: "/a", Name: "A"}, {Path: "/c", Hidden: true}}) {
		t.Fatalf("got %+v", got)
	}
}

func TestDisplay(t *testing.T) {
	s := New("/home/u", "/home/u/.codex")
	for in, want := range map[string]string{"/home/u/.codex-work": "~/.codex-work", "/home/u": "~", "/home/user2/x": "/home/user2/x", "/srv/codex": "/srv/codex"} {
		if got := s.Display(in); got != want {
			t.Errorf("Display(%q) = %q, want %q", in, got, want)
		}
	}
}

// The auth.json is never opened: a home whose auth.json cannot be read is
// signed in all the same.
func TestAuthJSONIsOnlyStated(t *testing.T) {
	h := home(t, map[string]bool{".codex": true})
	if err := os.Chmod(filepath.Join(h, ".codex", "auth.json"), 0); err != nil {
		t.Fatal(err)
	}
	got, _ := New(h, filepath.Join(h, ".codex")).Accounts(ctx)
	if !got[0].SignedIn {
		t.Fatalf("got %+v", got)
	}
}

func errOf(_ Settings, err error) error { return err }

// R1 of the #138 review, round 3: a folder named like another folder's
// hashed key (~/.codex-a-<hash of ~/.codex-+a>) does not take that key, nor
// does any folder whose name ends in "-" and hex. Every folder keeps its key
// whichever of the others are there, found or added, in whatever order.
func TestKeysDependOnTheFolderAloneInAnyOrder(t *testing.T) {
	h, err := filepath.EvalSymlinks(home(t, map[string]bool{".codex": true, ".codex-+a": false, ".codex-a": false,
		".codex-team-c0ffee": false, "else/a": false, "else/.codex-a": false, "real/codex-s": false}))
	if err != nil {
		t.Fatal(err)
	}
	plusA := hashed("a", filepath.Join(h, ".codex-+a"))
	for _, dir := range []string{".codex-" + plusA, "links"} {
		if err := os.MkdirAll(filepath.Join(h, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(h, "real/codex-s"), filepath.Join(h, ".codex-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(h, "else/a"), filepath.Join(h, "links/a")); err != nil {
		t.Fatal(err)
	}
	// Each folder as listed (found when it has an auth.json, else added),
	// the folder its auth.json goes in, and its key.
	type folder struct{ path, auth, key string }
	folders := []folder{
		{".codex-+a", ".codex-+a", plusA},
		{".codex-" + plusA, ".codex-" + plusA, hashed(plusA, filepath.Join(h, ".codex-"+plusA))},
		{".codex-a", ".codex-a", "a"},
		{".codex-team-c0ffee", ".codex-team-c0ffee", hashed("team-c0ffee", filepath.Join(h, ".codex-team-c0ffee"))},
		{"else/a", "", hashed("a", filepath.Join(h, "else/a"))},
		{"else/.codex-a", "", hashed("a", filepath.Join(h, "else/.codex-a"))},
		{".codex-link", "real/codex-s", hashed("s", filepath.Join(h, "real/codex-s"))},
		{"links/a", "", hashed("a", filepath.Join(h, "else/a"))},
	}
	s := New(h, filepath.Join(h, ".codex"))
	rng := rand.New(rand.NewPCG(138, 3))
	check := func(trial string, found []bool, added []int) {
		t.Helper()
		for i, f := range folders {
			if f.auth == "" {
				continue
			}
			auth := filepath.Join(h, f.auth, "auth.json")
			if found[i] {
				if err := os.WriteFile(auth, []byte(`{}`), 0o600); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Remove(auth); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		}
		set := Settings{Added: []string{}}
		for _, i := range added {
			set.Added = append(set.Added, filepath.Join(h, folders[i].path))
		}
		s.Configure(set)
		got, _ := s.Accounts(ctx)
		want := map[string]string{filepath.Join(h, ".codex"): "codex"}
		for i, f := range folders {
			if found[i] || slices.Contains(added, i) {
				want[canonical(filepath.Join(h, f.path))] = f.key
			}
		}
		keySeen, nameSeen := map[string]bool{}, map[string]bool{}
		for _, a := range got {
			if k, ok := want[a.Home]; !ok || a.Key != k {
				t.Fatalf("%s: %s has key %q, want %q (all %v)", trial, a.Home, a.Key, k, keys(got))
			}
			delete(want, a.Home)
			if keySeen[a.Key] || nameSeen[strings.ToLower(a.Name)] {
				t.Fatalf("%s: key %q or name %q twice in %+v", trial, a.Key, a.Name, got)
			}
			keySeen[a.Key], nameSeen[strings.ToLower(a.Name)] = true, true
		}
		if len(want) != 0 {
			t.Fatalf("%s: not listed %v", trial, want)
		}
	}
	// Every subset, added in order and in reverse; then random mixes of
	// found and added folders in random orders.
	for mask := range 1 << len(folders) {
		var added []int
		for i := range folders {
			if mask&(1<<i) != 0 {
				added = append(added, i)
			}
		}
		check(fmt.Sprintf("added %v", added), make([]bool, len(folders)), added)
		slices.Reverse(added)
		check(fmt.Sprintf("added %v", added), make([]bool, len(folders)), added)
	}
	for trial := range 500 {
		found := make([]bool, len(folders))
		var added []int
		for _, i := range rng.Perm(len(folders)) {
			switch rng.IntN(3) {
			case 1:
				added = append(added, i)
			case 2:
				found[i] = folders[i].auth != "" && strings.HasPrefix(folders[i].path, ".codex-")
			}
		}
		check(fmt.Sprintf("trial %d: found %v, added %v", trial, found, added), found, added)
	}
}

// Two paths whose hashes start alike both take the whole hash, whichever
// is listed first; alone, each has the short one.
func TestHashPrefixClashTakesTheWholeHash(t *testing.T) {
	h, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	var p, q string
	seen := map[string]string{}
	for i := 0; p == ""; i++ {
		path := filepath.Join(h, strconv.Itoa(i), "x")
		sum := sha256.Sum256([]byte(path))
		prefix := hex.EncodeToString(sum[:3])
		if other, ok := seen[prefix]; ok {
			p, q = other, path
		}
		seen[prefix] = path
	}
	for _, dir := range []string{p, q} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	whole := func(path string) string {
		sum := sha256.Sum256([]byte(path))
		return "x-" + hex.EncodeToString(sum[:])
	}
	s := New(h, filepath.Join(h, ".codex"))
	for _, added := range [][]string{{p, q}, {q, p}} {
		s.Configure(Settings{Added: added})
		got, _ := s.Accounts(ctx)
		if got[1].Key != whole(added[0]) || got[2].Key != whole(added[1]) {
			t.Fatalf("added %v: keys %v", added, keys(got))
		}
	}
	for _, path := range []string{p, q} {
		s.Configure(Settings{Added: []string{path}})
		if got, _ := s.Accounts(ctx); got[1].Key != hashed("x", path) {
			t.Fatalf("%s alone: keys %v", path, keys(got))
		}
	}
}

// A default home whose name ends in "-" and hex is hashed too.
func TestHexEndedDefaultIsHashed(t *testing.T) {
	h, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	def := filepath.Join(h, "codex-srv-0a1b2c")
	got, _ := New(h, def).Accounts(ctx)
	if got[0].Key != hashed("srv-0a1b2c", def) || got[0].Name != "srv-0a1b2c" {
		t.Fatalf("default %+v", got[0])
	}
}

// #139: Prepare is the env a Codex process of a profile runs with.
func TestPrepare(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true, ".codex-shy": true, "elsewhere": true})
	svc := New(h, filepath.Join(h, ".codex"))
	set, err := svc.SetHidden(ctx, "shy", true)
	if err != nil {
		t.Fatal(err)
	}
	svc.Configure(set)
	if set, err = svc.Add(ctx, filepath.Join(h, "elsewhere")); err != nil {
		t.Fatal(err)
	}
	svc.Configure(set)
	added := hashed("elsewhere", filepath.Join(h, "elsewhere"))
	if err := os.RemoveAll(filepath.Join(h, "elsewhere")); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		key  string
		env  []string
		gone bool
	}{
		{key: "codex", env: []string{"CODEX_HOME=" + filepath.Join(h, ".codex")}},
		{key: "", env: []string{"CODEX_HOME=" + filepath.Join(h, ".codex")}}, // the default
		{key: "work", env: []string{"CODEX_HOME=" + filepath.Join(h, ".codex-work")}},
		{key: "shy", env: []string{"CODEX_HOME=" + filepath.Join(h, ".codex-shy")}}, // hidden only keeps it off the meter
		{key: "nope", gone: true},
		{key: added, gone: true}, // its folder went: listed, not preparable
	} {
		env, release, err := svc.Prepare(ctx, c.key)
		if release == nil {
			t.Fatalf("%q: release is nil", c.key)
		}
		release()
		if c.gone {
			var nf *NotFoundError
			if !errors.As(err, &nf) || nf.Key != c.key || env != nil {
				t.Fatalf("%q: env %v err %v", c.key, env, err)
			}
			continue
		}
		if err != nil || !slices.Equal(env, c.env) {
			t.Fatalf("%q: env %v err %v, want %v", c.key, env, err, c.env)
		}
	}
	var nf *NotFoundError
	if _, _, err := svc.Prepare(ctx, added); !errors.As(err, &nf) || nf.Name != "elsewhere" || !strings.Contains(err.Error(), "no longer exists") {
		t.Fatalf("gone folder: %v", err)
	}

	// The default's folder not there: no env (Codex refuses a CODEX_HOME
	// that is not), as the limits probe reads it.
	bare := home(t, map[string]bool{".codex-work": true})
	env, release, err := New(bare, filepath.Join(bare, ".codex")).Prepare(ctx, "codex")
	if err != nil || env != nil || release == nil {
		t.Fatalf("missing default: env %v err %v", env, err)
	}
}

func TestRunsHerdrHook(t *testing.T) {
	h := home(t, map[string]bool{".codex": true, ".codex-work": true, ".codex-toml": true, ".codex-other": true})
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(h, rel), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(".codex/hooks.json", `{"hooks":{"SessionStart":[{"hooks":[{"command":"bash '/home/u/.codex/herdr-agent-state.sh' session"}]}]}}`)
	write(".codex-toml/config.toml", "[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ncommand = \"bash /home/u/.codex/herdr-agent-state.sh session\"\n")
	write(".codex-other/hooks.json", `{"hooks":{}}`)
	for name, want := range map[string]bool{".codex": true, ".codex-toml": true, ".codex-work": false, ".codex-other": false, "nope": false} {
		if got := RunsHerdrHook(filepath.Join(h, name)); got != want {
			t.Errorf("%s: %v", name, got)
		}
	}
}
