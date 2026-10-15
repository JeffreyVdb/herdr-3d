package repodisc

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// tmp is a canonical temporary folder (the platform's may be a symlink).
func tmp(t *testing.T) string {
	t.Helper()
	d, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func mkdir(t *testing.T, parts ...string) string {
	t.Helper()
	p := filepath.Join(parts...)
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func touch(t *testing.T, p string) {
	t.Helper()
	if err := os.WriteFile(p, []byte("gitdir: elsewhere\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// The traversal policy, without git: markers stop the walk, grouping
// folders are walked at any depth and whatever their name, symlinks are
// not followed.
func TestWalk(t *testing.T) {
	root := tmp(t)
	mkdir(t, root, "group", "a", ".git")
	mkdir(t, root, "group", "a", "vendor", "inner", ".git") // inside a checkout: not found
	touch(t, filepath.Join(mkdir(t, root, "wt"), ".git"))   // a linked worktree's .git file
	mkdir(t, root, "d1", "d2", "d3", "d4", "d5", "d6", "d7", "deep", ".git")
	mkdir(t, root, "node_modules", "dep", ".git") // no name is skipped
	mkdir(t, root, "my folder ü", "e", ".git")
	mkdir(t, root, "empty", "nothing")
	if err := os.Symlink(filepath.Join(root, "group"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "group", "a"), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	w, err := walk(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		filepath.Join(root, "d1", "d2", "d3", "d4", "d5", "d6", "d7", "deep"),
		filepath.Join(root, "group", "a"),
		filepath.Join(root, "my folder ü", "e"),
		filepath.Join(root, "node_modules", "dep"),
		filepath.Join(root, "wt"),
	}
	if !slices.Equal(w.candidates, want) {
		t.Fatalf("candidates = %q\nwant %q", w.candidates, want)
	}
	if w.skipped != 0 {
		t.Fatalf("skipped = %d", w.skipped)
	}

	// A root that is a checkout is its own only candidate.
	w, err = walk(context.Background(), filepath.Join(root, "group", "a"))
	if err != nil || !slices.Equal(w.candidates, []string{filepath.Join(root, "group", "a")}) {
		t.Fatalf("checkout root: %q, %v", w.candidates, err)
	}
	// An explicit root inside a checkout is walked.
	w, err = walk(context.Background(), filepath.Join(root, "group", "a", "vendor"))
	if err != nil || !slices.Equal(w.candidates, []string{filepath.Join(root, "group", "a", "vendor", "inner")}) {
		t.Fatalf("root inside a checkout: %q, %v", w.candidates, err)
	}

	if _, err := walk(context.Background(), filepath.Join(root, "missing")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing root: %v", err)
	}
	file := filepath.Join(root, "file")
	touch(t, file)
	if _, err := walk(context.Background(), file); !errors.Is(err, errNotDir) {
		t.Fatalf("file root: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := walk(ctx, root); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled walk: %v", err)
	}
}

func TestWalkUnreadable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads everything")
	}
	root := tmp(t)
	mkdir(t, root, "ok", ".git")
	locked := mkdir(t, root, "locked", "hidden")
	mkdir(t, locked, ".git")
	if err := os.Chmod(filepath.Join(root, "locked"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(filepath.Join(root, "locked"), 0o755) })
	w, err := walk(context.Background(), root)
	if err != nil || !slices.Equal(w.candidates, []string{filepath.Join(root, "ok")}) || w.skipped != 1 || !errors.Is(w.skipErr, fs.ErrPermission) {
		t.Fatalf("walk = %+v, %v", w, err)
	}
	if err := os.Chmod(root, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o755) })
	if _, err := walk(context.Background(), root); !errors.Is(err, fs.ErrPermission) {
		t.Fatalf("unreadable root: %v", err)
	}
}

// Identity: worktrees share a common directory, clones a GitHub
// repository (any spelling); nothing else merges.
func TestCatalog(t *testing.T) {
	cat := NewCatalog(3, []Checkout{
		newCheckout("/w/x-feature", "/a/x/.git", "git@github.com:Owner/X.git"),
		newCheckout("/a/x", "/a/x/.git", "git@github.com:Owner/X.git"),
		newCheckout("/b/x", "/b/x/.git", "https://github.com/owner/x"),
		newCheckout("/b/x", "/b/x/.git", "https://github.com/owner/x"), // two roots found it
		newCheckout("/c/api", "/c/api/.git", ""),
		newCheckout("/d/api", "/d/api/.git", ""),
		newCheckout("/e/lib", "/e/lib/.git", "https://gitlab.com/o/lib.git"),
		newCheckout("/f/lib", "/f/lib/.git", "https://gitlab.com/o/lib.git"),
		newCheckout("/w2", "/m/.git", ""),
		newCheckout("/w1", "/m/.git", ""),
	})
	type row struct {
		id, gh string
		paths  []string
	}
	var got []row
	for _, r := range cat.Repos {
		var ps []string
		for _, c := range r.Checkouts {
			ps = append(ps, c.Path)
		}
		got = append(got, row{r.ID, r.GitHub, ps})
	}
	want := []row{
		{"git:/c/api/.git", "", []string{"/c/api"}},
		{"git:/d/api/.git", "", []string{"/d/api"}},
		{"git:/e/lib/.git", "", []string{"/e/lib"}},
		{"git:/f/lib/.git", "", []string{"/f/lib"}},
		{"git:/m/.git", "", []string{"/w1", "/w2"}},
		{"gh:owner/x", "Owner/X", []string{"/a/x", "/b/x", "/w/x-feature"}},
	}
	if !slices.EqualFunc(got, want, func(a, b row) bool { return a.id == b.id && a.gh == b.gh && slices.Equal(a.paths, b.paths) }) {
		t.Fatalf("repos = %+v\nwant %+v", got, want)
	}
	if cat.Revision != 3 || cat.Len() != 6 || cat.Checkouts() != 9 {
		t.Fatalf("revision %d, %d repos, %d checkouts", cat.Revision, cat.Len(), cat.Checkouts())
	}
	if r, ok := cat.ByPath("/w/x-feature"); !ok || r.ID != "gh:owner/x" || r.Path() != "/a/x" || r.Name() != "X" {
		t.Fatalf("ByPath = %+v, %v", r, ok)
	}
	if r, ok := cat.Repo(GitHubID("OWNER/x")); !ok || !r.Checkouts[0].Main {
		t.Fatalf("Repo = %+v, %v", r, ok)
	}
	if r, _ := cat.Repo("git:/m/.git"); r.Name() != "w1" || r.Checkouts[0].Main {
		t.Fatalf("worktrees only: %+v", r)
	}
	var none *Catalog
	if _, ok := none.ByPath("/a/x"); ok || none.Len() != 0 || none.List() != nil {
		t.Fatal("nil catalog is not empty")
	}
}

// fixture is a git environment of its own.
func fixture(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.com")
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

// repo makes a repository with a commit at dir, with origin (""; none).
func repo(t *testing.T, dir, origin string) string {
	t.Helper()
	mkdir(t, dir)
	git(t, dir, "init", "-q", "-b", "main")
	git(t, dir, "commit", "-q", "--allow-empty", "-m", "one")
	if origin != "" {
		git(t, dir, "remote", "add", "origin", origin)
	}
	return dir
}

func paths(cat *Catalog) map[string][]string {
	out := map[string][]string{}
	for _, r := range cat.Repos {
		for _, c := range r.Checkouts {
			out[r.ID] = append(out[r.ID], c.Path)
		}
	}
	return out
}

// A scan with real git over overlapping, aliased and nested roots.
func TestScanRoots(t *testing.T) {
	fixture(t)
	root := tmp(t)
	dev := mkdir(t, root, "dev")
	x := repo(t, filepath.Join(dev, "org", "x"), "git@github.com:Owner/X.git")
	git(t, x, "worktree", "add", "-q", "-b", "feat", filepath.Join(dev, "trees", "x feat ü"))
	clone := repo(t, filepath.Join(root, "other", "x"), "https://github.com/owner/x.git")
	local := repo(t, filepath.Join(dev, "local"), "")
	gl := repo(t, filepath.Join(dev, "gl"), "https://gitlab.com/o/gl.git")
	// Same name, unrelated.
	apiA := repo(t, filepath.Join(dev, "a", "api"), "")
	apiB := repo(t, filepath.Join(dev, "b", "api"), "")
	// Inside x: only an explicit root finds it.
	inner := repo(t, filepath.Join(x, "vendor", "inner"), "")
	// A .git that is not a checkout of its own: git finds none above it.
	mkdir(t, dev, "broken", ".git")
	if err := os.Symlink(dev, filepath.Join(root, "dev-alias")); err != nil {
		t.Fatal(err)
	}

	g := &gitops.Git{Timeout: DefaultGitTimeout}
	roots := []string{dev, filepath.Join(root, "dev-alias"), filepath.Join(dev, "org"), filepath.Join(x, "vendor"), filepath.Join(root, "other"), filepath.Join(root, "nope")}
	var phases []string
	out := scanRoots(context.Background(), g, roots, 2, nil, func(p string, done, total int) {
		if len(phases) == 0 || phases[len(phases)-1] != p {
			phases = append(phases, p)
		}
	})
	if !slices.Equal(phases, []string{"walking", "checking"}) {
		t.Fatalf("phases = %q", phases)
	}
	if rs := out.roots[filepath.Join(root, "nope")]; !errors.Is(rs.err, fs.ErrNotExist) {
		t.Fatalf("missing root: %+v", rs)
	}
	if rs := out.roots[filepath.Join(root, "dev-alias")]; rs.canonical != dev || len(rs.checkouts) != len(out.roots[dev].checkouts) {
		t.Fatalf("alias root: %+v", rs)
	}
	var all []Checkout
	for _, r := range roots {
		all = append(all, out.roots[r].checkouts...)
	}
	cat := NewCatalog(1, all)
	want := map[string][]string{
		"gh:owner/x":                          {x, clone, filepath.Join(dev, "trees", "x feat ü")}, // the main checkouts first
		"git:" + filepath.Join(local, ".git"): {local},
		"git:" + filepath.Join(gl, ".git"):    {gl},
		"git:" + filepath.Join(apiA, ".git"):  {apiA},
		"git:" + filepath.Join(apiB, ".git"):  {apiB},
		"git:" + filepath.Join(inner, ".git"): {inner},
	}
	got := paths(cat)
	if len(got) != len(want) {
		t.Fatalf("repos = %q", got)
	}
	for id, ps := range want {
		if !slices.Equal(got[id], ps) {
			t.Fatalf("%s = %q, want %q (all %q)", id, got[id], ps, got)
		}
	}
	if r, _ := cat.Repo("gh:owner/x"); r.GitHub != "Owner/X" || !r.Checkouts[0].Main {
		t.Fatalf("x = %+v", r)
	}
	if out.candidates != 9 {
		t.Fatalf("candidates = %d", out.candidates)
	}
}

// gate is a Git that waits at the door until let through (or its call's
// context ends), counting the calls in flight.
type gate struct {
	Git
	mu       sync.Mutex
	open     bool
	wake     chan struct{}
	inFlight int
	most     int
	fail     map[string]error // by candidate
}

func newGate(open bool) *gate {
	return &gate{Git: &gitops.Git{Timeout: DefaultGitTimeout}, open: open, wake: make(chan struct{}), fail: map[string]error{}}
}

func (g *gate) setOpen(open bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if open && !g.open {
		close(g.wake)
	}
	if !open && g.open {
		g.wake = make(chan struct{})
	}
	g.open = open
}

func (g *gate) setFail(dir string, err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.fail[dir] = err
}

func (g *gate) Checkout(ctx context.Context, dir string) (gitops.CheckoutInfo, error) {
	g.mu.Lock()
	open, wake, err := g.open, g.wake, g.fail[dir]
	g.inFlight++
	g.most = max(g.most, g.inFlight)
	g.mu.Unlock()
	defer func() {
		g.mu.Lock()
		g.inFlight--
		g.mu.Unlock()
	}()
	if !open {
		select {
		case <-wake:
		case <-ctx.Done():
			return gitops.CheckoutInfo{}, ctx.Err()
		}
	}
	if err != nil {
		return gitops.CheckoutInfo{}, err
	}
	return g.Git.Checkout(ctx, dir)
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func rootOf(v proto.RepoDiscovery, path string) proto.RepoDiscoveryRoot {
	for _, r := range v.Status.Roots {
		if r.Path == path {
			return r
		}
	}
	return proto.RepoDiscoveryRoot{}
}

func has(cat *Catalog, path string) bool {
	_, ok := cat.ByPath(path)
	return ok
}

// The service: startup and manual scans, a new clone and a removed
// checkout, a removed root (at once), a failing root (stale), recovery.
func TestService(t *testing.T) {
	fixture(t)
	root := tmp(t)
	a, b := mkdir(t, root, "a"), mkdir(t, root, "b")
	one := repo(t, filepath.Join(a, "one"), "git@github.com:o/one.git")
	two := repo(t, filepath.Join(b, "two"), "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g := newGate(true)
	s := New(ctx, Options{Git: g})
	if v := s.View(); v.Status.State != proto.RepoDiscoveryOff || v.IntervalMinutes != 10 || v.Roots == nil || v.Status.Roots == nil {
		t.Fatalf("before configure: %+v", v)
	}
	s.Configure(Settings{Roots: []string{a, b}, Interval: time.Hour})
	eventually(t, "the first scan", func() bool { return has(s.Catalog(), one) && has(s.Catalog(), two) })
	v := s.View()
	rev := v.Status.Revision
	if v.Status.State != proto.RepoDiscoveryIdle || v.Status.Repositories != 2 || v.Status.LastSuccessAt == nil || v.Status.NextScanAt == nil ||
		rootOf(v, a).State != proto.RepoRootOK || rootOf(v, a).Checkouts != 1 || rev == 0 {
		t.Fatalf("after the first scan: %+v", v)
	}
	// Nothing changed: a refresh keeps the revision.
	last := *v.Status.LastScanAt
	s.Refresh()
	eventually(t, "a refresh", func() bool {
		v := s.View()
		return v.Status.State == proto.RepoDiscoveryIdle && *v.Status.LastScanAt != last || v.Status.Revision != rev
	})
	if s.View().Status.Revision != rev {
		t.Fatal("an unchanged scan moved the revision")
	}
	// A new clone appears and a removed checkout goes, after a scan.
	three := repo(t, filepath.Join(a, "three"), "")
	if err := os.RemoveAll(two); err != nil {
		t.Fatal(err)
	}
	if !has(s.Catalog(), two) || has(s.Catalog(), three) {
		t.Fatal("the catalog changed before a scan")
	}
	s.Refresh()
	eventually(t, "the clone", func() bool { return has(s.Catalog(), three) && !has(s.Catalog(), two) })
	if s.Catalog().Revision <= rev {
		t.Fatal("the revision did not move")
	}
	// A root that fails keeps its last result, stale, and the other root
	// is scanned as usual; it recovers.
	moved := filepath.Join(root, "a-moved")
	if err := os.Rename(a, moved); err != nil {
		t.Fatal(err)
	}
	four := repo(t, filepath.Join(b, "four"), "")
	s.Refresh()
	eventually(t, "the failure", func() bool { return rootOf(s.View(), a).State == proto.RepoRootStale })
	v = s.View()
	if !has(s.Catalog(), one) || !has(s.Catalog(), four) || !strings.Contains(rootOf(v, a).Error, "does not exist") || rootOf(v, b).State != proto.RepoRootOK {
		t.Fatalf("a failing root: %+v", v)
	}
	if err := os.Rename(moved, a); err != nil {
		t.Fatal(err)
	}
	s.Refresh()
	eventually(t, "the recovery", func() bool { return rootOf(s.View(), a).State == proto.RepoRootOK })
	// A removed root's repositories go at once.
	s.Configure(Settings{Roots: []string{b}, Interval: time.Hour})
	if has(s.Catalog(), one) || !has(s.Catalog(), four) || len(s.View().Status.Roots) != 1 {
		t.Fatalf("after removing a root: %+v", s.View())
	}
	// No roots: off and empty.
	s.Configure(Settings{Interval: time.Hour})
	if v := s.View(); v.Status.State != proto.RepoDiscoveryOff || s.Catalog().Len() != 0 {
		t.Fatalf("off: %+v", v)
	}
	cancel()
	s.Wait()
}

// A root removed while a scan of it is in flight never comes back from
// that scan; the scan is cancelled and a new one starts.
func TestServiceCancel(t *testing.T) {
	fixture(t)
	root := tmp(t)
	a, b := mkdir(t, root, "a"), mkdir(t, root, "b")
	one := repo(t, filepath.Join(a, "one"), "")
	two := repo(t, filepath.Join(b, "two"), "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g := newGate(false)
	s := New(ctx, Options{Git: g})
	s.Configure(Settings{Roots: []string{a, b}, Interval: time.Hour})
	eventually(t, "the scan to wait at git", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return g.inFlight > 0
	})
	if v := s.View(); v.Status.State != proto.RepoDiscoveryScanning || v.Status.Progress == nil || v.Status.Progress.Phase != "checking" {
		t.Fatalf("scanning: %+v", v.Status)
	}
	// Commands answer while it scans: View and Configure do not wait.
	done := make(chan struct{})
	go func() {
		s.Configure(Settings{Roots: []string{b}, Interval: time.Hour})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Configure waited for the scan")
	}
	g.setOpen(true)
	eventually(t, "the new scan", func() bool { return has(s.Catalog(), two) })
	if has(s.Catalog(), one) {
		t.Fatal("the removed root came back")
	}
	if g.most > DefaultWorkers {
		t.Fatalf("%d git calls at once", g.most)
	}
	cancel()
	s.Wait()
}

// Shutdown ends a scan in flight; Wait returns.
func TestServiceShutdown(t *testing.T) {
	fixture(t)
	root := tmp(t)
	repo(t, filepath.Join(root, "one"), "")
	ctx, cancel := context.WithCancel(context.Background())
	g := newGate(false)
	s := New(ctx, Options{Git: g})
	s.Configure(Settings{Roots: []string{root}, Interval: time.Hour})
	eventually(t, "the scan to wait at git", func() bool {
		g.mu.Lock()
		defer g.mu.Unlock()
		return g.inFlight > 0
	})
	cancel()
	waited := make(chan struct{})
	go func() {
		s.Wait()
		close(waited)
	}()
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("Wait did not return after shutdown")
	}
}

// The interval schedules scans; changing it moves the next one. Git
// failing for every candidate fails the root (stale), a scan that runs
// past its bound too.
func TestServiceIntervalAndFailures(t *testing.T) {
	fixture(t)
	root := tmp(t)
	one := repo(t, filepath.Join(root, "one"), "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	g := newGate(true)
	s := New(ctx, Options{Git: g, ScanTimeout: 300 * time.Millisecond})
	s.Configure(Settings{Roots: []string{root}, Interval: time.Hour})
	eventually(t, "the first scan", func() bool { return has(s.Catalog(), one) })
	first := *s.View().Status.LastScanAt
	time.Sleep(200 * time.Millisecond)
	if *s.View().Status.LastScanAt != first {
		t.Fatal("scanned again before the interval")
	}
	two := repo(t, filepath.Join(root, "two"), "")
	s.Configure(Settings{Roots: []string{root}, Interval: 50 * time.Millisecond})
	eventually(t, "a scheduled scan", func() bool { return has(s.Catalog(), two) })
	s.Configure(Settings{Roots: []string{root}, Interval: time.Hour})

	g.setFail(one, errors.New("git exploded"))
	g.setFail(two, errors.New("git exploded"))
	s.Refresh()
	eventually(t, "the git failure", func() bool { return rootOf(s.View(), root).State == proto.RepoRootStale })
	if !has(s.Catalog(), one) || !strings.Contains(rootOf(s.View(), root).Error, "git exploded") {
		t.Fatalf("git failure: %+v", s.View())
	}
	// One candidate failing keeps its previous entry; the root is fine.
	g.setFail(two, nil)
	s.Refresh()
	eventually(t, "a partial failure", func() bool { return rootOf(s.View(), root).State == proto.RepoRootOK })
	if !has(s.Catalog(), one) || !has(s.Catalog(), two) {
		t.Fatal("a candidate git could not answer for was dropped")
	}
	g.setFail(one, nil)
	g.setOpen(false)
	s.Refresh()
	eventually(t, "the timeout", func() bool { return rootOf(s.View(), root).State == proto.RepoRootStale })
	if !strings.Contains(rootOf(s.View(), root).Error, "too long") || !has(s.Catalog(), one) {
		t.Fatalf("timeout: %+v", s.View())
	}
	g.setOpen(true)
	cancel()
	s.Wait()
}

func TestCleanSettings(t *testing.T) {
	got, err := CleanSettings([]string{"/a/b/", "/c d/ü"}, 10)
	if err != nil || !slices.Equal(got, []string{"/a/b", "/c d/ü"}) {
		t.Fatalf("clean = %q, %v", got, err)
	}
	if got, err := CleanSettings(nil, 1); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("none = %q, %v", got, err)
	}
	many := make([]string, proto.RepoDiscoveryMaxRoots+1)
	for i := range many {
		many[i] = "/r" + strings.Repeat("x", i)
	}
	for _, c := range []struct {
		roots    []string
		interval int
		want     string
	}{
		{[]string{"relative"}, 10, "Scan folder 1 must be an absolute path"},
		{[]string{"/a", "/a/"}, 10, "Scan folder 2 is the same as folder 1 (/a)"},
		{[]string{"/a", " "}, 10, "Scan folder 2 is empty"},
		{[]string{"/a\nb"}, 10, "line break"},
		{[]string{"/" + strings.Repeat("a", proto.RepoDiscoveryMaxRoot)}, 10, "longer than"},
		{many, 10, "At most 32"},
		{nil, 0, "from 1 to 1440"},
		{nil, 1441, "from 1 to 1440"},
	} {
		_, err := CleanSettings(c.roots, c.interval)
		var se *SettingsError
		if !errors.As(err, &se) || !strings.Contains(se.Msg, c.want) {
			t.Errorf("CleanSettings(%q, %d) = %v, want %q", c.roots, c.interval, err, c.want)
		}
	}
}
