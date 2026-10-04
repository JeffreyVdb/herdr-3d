package fileindex

import (
	"context"
	"errors"
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

func TestValidPath(t *testing.T) {
	for p, want := range map[string]bool{
		"a.go": true, "src/ui/button.ts": true, "docs/my file #1?.md": true, "école/thé.md": true, ".github/ci.yml": true,
		"a\\b": true, ".gitignore": true, "x/.gitkeep": true,
		"": false, ".": false, "/etc/passwd": false, "../x": false, "a/../b": false, "a/..": false, "./a": false,
		"a/": false, "a//b": false, "a/./b": false, ".git/config": false, "sub/.git/HEAD": false, ".git": false,
		"bad\xffutf8": false, "nul\x00": false,
	} {
		if got := validPath(p); got != want {
			t.Errorf("validPath(%q) = %v, want %v", p, got, want)
		}
	}
}

func paths(ms []proto.FileMatch) []string {
	out := []string{}
	for _, m := range ms {
		out = append(out, m.Path+":"+m.Kind)
	}
	return out
}

func TestSnapshot(t *testing.T) {
	s := newSnapshot([]string{"src/ui/button.ts", "./README.md", "../escape", "/abs", ".git/config", "src/a.go", "src/a.go",
		"a/b/../c", "zz", "src/ui/x/deep.ts"}, proto.FilesSourceGit, "", 100)
	got := paths(s.search("", 100))
	want := []string{"src:dir", "README.md:file", "zz:file", "src/ui:dir", "src/a.go:file", "src/ui/x:dir",
		"src/ui/button.ts:file", "src/ui/x/deep.ts:file"}
	if !slices.Equal(got, want) {
		t.Fatalf("empty query = %q\nwant %q", got, want)
	}
	for _, m := range s.search("", 2) {
		if m.Indices == nil || len(m.Indices) != 0 {
			t.Fatalf("empty query indices = %v", m.Indices)
		}
	}
	if got := paths(s.search("ui", 1)); !slices.Equal(got, []string{"src/ui:dir"}) {
		t.Fatalf("ui = %q", got)
	}
	if s.reason != "" {
		t.Fatalf("reason = %q", s.reason)
	}

	// The cap: whole files with their directories, and why.
	s = newSnapshot([]string{"a", "b/c", "d/e/f", "g"}, proto.FilesSourceGit, "", 4)
	if got := paths(s.search("", 10)); !slices.Equal(got, []string{"b:dir", "a:file", "b/c:file"}) ||
		!strings.Contains(s.reason, "more than 4") {
		t.Fatalf("capped = %q, reason %q", got, s.reason)
	}
	// A file that is also a directory above another file: once, the file.
	s = newSnapshot([]string{"a/b", "a"}, proto.FilesSourceGit, "", 10)
	if got := paths(s.search("", 10)); !slices.Equal(got, []string{"a:file", "a/b:file"}) {
		t.Fatalf("conflict = %q", got)
	}

	// Nothing listed (or nothing valid): a reason, joined to the lister's.
	for _, listed := range [][]string{nil, {"../x", ".git/config"}} {
		s = newSnapshot(listed, proto.FilesSourceGit, "", 10)
		if s.reason != noFiles || len(s.search("", 10)) != 0 {
			t.Fatalf("empty %q: reason %q", listed, s.reason)
		}
	}
	if s = newSnapshot(nil, proto.FilesSourceRG, "the listing is incomplete: x", 10); s.reason != "the listing is incomplete: x; "+noFiles {
		t.Fatalf("empty and cut: reason %q", s.reason)
	}
}

// #137: an empty checkout says so for every query; one with files answers a
// query nothing matches with files [] and no reason.
func TestIndexEmptyCheckout(t *testing.T) {
	gitEnv(t)
	root := t.TempDir()
	empty, ignored, full := filepath.Join(root, "empty"), filepath.Join(root, "ignored"), filepath.Join(root, "full")
	for _, r := range []string{empty, ignored, full} {
		run(t, root, "init", "-q", "-b", "main", r)
	}
	if err := os.WriteFile(filepath.Join(ignored, ".git", "info", "exclude"), []byte("*\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, ignored, "a.go", "src/b.go")
	writeFiles(t, full, "a.go")

	x := New(context.Background(), Options{Git: &gitops.Git{}})
	for _, dir := range []string{empty, ignored} {
		for _, q := range []string{"", "a"} {
			res := query(t, x, dir, q, 10)
			if len(res.Files) != 0 || res.Source != proto.FilesSourceGit || res.Reason == nil || *res.Reason != noFiles {
				t.Fatalf("%s %q = %+v", filepath.Base(dir), q, res)
			}
		}
	}
	if res := query(t, x, full, "zzz", 10); len(res.Files) != 0 || res.Reason != nil {
		t.Fatalf("no match = %+v", res)
	}
}

// fakeClock is a settable clock.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// countingGit counts listings, and holds each until gate (if set) is
// closed.
type countingGit struct {
	Git
	mu    sync.Mutex
	lists int
	gate  chan struct{}
	err   error
}

func (c *countingGit) ListFiles(ctx context.Context, dir string) (*gitops.Listing, error) {
	c.mu.Lock()
	c.lists++
	gate, err := c.gate, c.err
	c.mu.Unlock()
	if gate != nil {
		<-gate
	}
	if err != nil {
		return nil, err
	}
	return c.Git.ListFiles(ctx, dir)
}

func (c *countingGit) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lists
}

func gitEnv(t *testing.T) {
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

func run(t *testing.T, dir string, args ...string) {
	t.Helper()
	if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
}

func writeFiles(t *testing.T, root string, files ...string) {
	t.Helper()
	for _, name := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func query(t *testing.T, x *Index, dir, q string, limit int) *proto.WorkerFiles {
	t.Helper()
	res, err := x.Files(context.Background(), dir, q, limit)
	if err != nil {
		t.Fatalf("Files(%q): %v", q, err)
	}
	if res.Files == nil {
		t.Fatal("files is nil")
	}
	return res
}

// building reports whether dir's index has a build in flight.
func building(x *Index, dir string) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	e := x.entries[dir]
	return e != nil && e.building != nil
}

func has(res *proto.WorkerFiles, p string) bool {
	return slices.ContainsFunc(res.Files, func(m proto.FileMatch) bool { return m.Path == p })
}

// #137: tracked and untracked files and their directories, never ignored
// ones; odd names verbatim; a symlink out of the checkout is only itself.
func TestIndexGitRepository(t *testing.T) {
	gitEnv(t)
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	run(t, root, "init", "-q", "-b", "main", repo)
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("build/\n*.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, repo, "a.go", "src/ui/button.ts", "docs/my file #1?.md", "docs/école.md")
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-q", "-m", "one")
	writeFiles(t, repo, "untracked.txt", "build/out.bin", "debug.log", "src/ui/new.ts")
	writeFiles(t, root, "outside/secret.txt")
	if err := os.Symlink(filepath.Join(root, "outside"), filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}

	x := New(context.Background(), Options{Git: &gitops.Git{}})
	all := query(t, x, repo, "", 100)
	got := paths(all.Files)
	want := []string{"docs:dir", "src:dir", ".gitignore:file", "a.go:file", "link:file", "untracked.txt:file",
		"src/ui:dir", "docs/my file #1?.md:file", "docs/école.md:file", "src/ui/button.ts:file", "src/ui/new.ts:file"}
	if !slices.Equal(got, want) || all.Source != proto.FilesSourceGit || all.Reason != nil {
		t.Fatalf("all = %q %s %v\nwant %q", got, all.Source, all.Reason, want)
	}

	res := query(t, x, repo, "my file", 5)
	if len(res.Files) == 0 || res.Files[0].Path != "docs/my file #1?.md" || !slices.Equal(res.Files[0].Indices, []int{5, 6, 7, 8, 9, 10, 11}) {
		t.Fatalf("my file = %+v", res.Files)
	}
	res = query(t, x, repo, "école", 5)
	if len(res.Files) == 0 || res.Files[0].Path != "docs/école.md" || !slices.Equal(res.Files[0].Indices, []int{5, 6, 7, 8, 9}) {
		t.Fatalf("école = %+v", res.Files)
	}
	res = query(t, x, repo, "#1?", 5)
	if len(res.Files) != 1 || res.Files[0].Path != "docs/my file #1?.md" {
		t.Fatalf("#1? = %+v", res.Files)
	}
	if res := query(t, x, repo, "secret", 5); len(res.Files) != 0 {
		t.Fatalf("secret = %+v", res.Files)
	}
	if res := query(t, x, repo, "out", 5); has(res, "build/out.bin") || has(res, "build") {
		t.Fatalf("ignored listed: %+v", res.Files)
	}
	if res := query(t, x, repo, "ui", 1); len(res.Files) != 1 || res.Files[0].Path != "src/ui" || res.Files[0].Kind != proto.FileKindDir {
		t.Fatalf("ui = %+v", res.Files)
	}

	// A checkout that is a subdirectory of the repository: relative to it.
	if res := query(t, x, filepath.Join(repo, "src"), "", 10); !slices.Equal(paths(res.Files),
		[]string{"ui:dir", "ui/button.ts:file", "ui/new.ts:file"}) {
		t.Fatalf("src = %q", paths(res.Files))
	}
}

// #137: rebuilt when git's index file changes, at most every Throttle, and
// at MaxAge anyway (new untracked files); never by its own listing; a query
// during a rebuild answers from the old index.
func TestIndexInvalidation(t *testing.T) {
	gitEnv(t)
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	run(t, root, "init", "-q", "-b", "main", repo)
	writeFiles(t, repo, "one.go")
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-q", "-m", "one")

	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	cg := &countingGit{Git: &gitops.Git{}}
	x := New(context.Background(), Options{Git: cg, Now: clock.Now})
	query(t, x, repo, "", 10)
	if cg.count() != 1 {
		t.Fatalf("builds = %d", cg.count())
	}
	// Unchanged: no rebuild, however often asked (listing does not touch
	// the index).
	for range 3 {
		clock.Add(6 * time.Second)
		query(t, x, repo, "one", 10)
		x.Wait()
	}
	if cg.count() != 1 {
		t.Fatalf("builds without a change = %d", cg.count())
	}

	// The index changes: not before the throttle, then once.
	clock.Add(24 * time.Second) // 42 s: the max age rebuilds once
	query(t, x, repo, "", 10)
	x.Wait()
	if cg.count() != 2 {
		t.Fatalf("builds at max age = %d", cg.count())
	}
	writeFiles(t, repo, "two.go")
	run(t, repo, "add", "two.go")
	clock.Add(2 * time.Second)
	if res := query(t, x, repo, "two", 10); len(res.Files) != 0 || building(x, repo) || cg.count() != 2 {
		t.Fatalf("within the throttle: %+v, builds %d", res.Files, cg.count())
	}
	clock.Add(4 * time.Second)
	cg.mu.Lock()
	cg.gate = make(chan struct{})
	cg.mu.Unlock()
	// Answered from the old index while the rebuild runs; one rebuild.
	if res := query(t, x, repo, "two", 10); len(res.Files) != 0 || !building(x, repo) {
		t.Fatalf("during the rebuild: %+v, building %v", res.Files, building(x, repo))
	}
	clock.Add(6 * time.Second)
	if res := query(t, x, repo, "two", 10); len(res.Files) != 0 {
		t.Fatalf("a second query during the rebuild: %+v", res.Files)
	}
	cg.mu.Lock()
	close(cg.gate)
	cg.gate = nil
	cg.mu.Unlock()
	x.Wait()
	if res := query(t, x, repo, "two", 10); !has(res, "two.go") || cg.count() != 3 {
		t.Fatalf("after the rebuild: %+v, builds %d", res.Files, cg.count())
	}

	// An untracked file touches no index: found at the max age.
	writeFiles(t, repo, "three.go")
	clock.Add(10 * time.Second)
	query(t, x, repo, "three", 10)
	x.Wait()
	if res := query(t, x, repo, "three", 10); has(res, "three.go") {
		t.Fatal("untracked file found before the max age")
	}
	clock.Add(25 * time.Second)
	query(t, x, repo, "three", 10)
	x.Wait()
	if res := query(t, x, repo, "three", 10); !has(res, "three.go") {
		t.Fatalf("untracked file at max age: %+v", res.Files)
	}
}

// #137: a linked worktree (a .git file) is rebuilt when its own index file
// changes.
func TestIndexLinkedWorktree(t *testing.T) {
	gitEnv(t)
	root := t.TempDir()
	repo, wt := filepath.Join(root, "repo"), filepath.Join(root, "wt")
	run(t, root, "init", "-q", "-b", "main", repo)
	writeFiles(t, repo, "one.go")
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-q", "-m", "one")
	run(t, repo, "worktree", "add", "-q", "-b", "feature", wt)
	if fi, err := os.Lstat(filepath.Join(wt, ".git")); err != nil || fi.IsDir() {
		t.Fatalf("worktree .git: %v", err)
	}

	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	cg := &countingGit{Git: &gitops.Git{}}
	x := New(context.Background(), Options{Git: cg, Now: clock.Now})
	if res := query(t, x, wt, "", 10); !has(res, "one.go") {
		t.Fatalf("worktree = %+v", res.Files)
	}
	x.mu.Lock()
	idx := x.entries[wt].git.indexPath
	x.mu.Unlock()
	if !strings.HasPrefix(idx, filepath.Join(repo, ".git", "worktrees")+string(filepath.Separator)) {
		t.Fatalf("index path = %q", idx)
	}
	// The main checkout's index changing is not the worktree's.
	writeFiles(t, repo, "main-only.go")
	run(t, repo, "add", "main-only.go")
	clock.Add(6 * time.Second)
	query(t, x, wt, "", 10)
	x.Wait()
	if cg.count() != 1 {
		t.Fatalf("builds after the main index changed = %d", cg.count())
	}
	writeFiles(t, wt, "two.go")
	run(t, wt, "add", "two.go")
	clock.Add(6 * time.Second)
	query(t, x, wt, "", 10)
	x.Wait()
	if res := query(t, x, wt, "two", 10); cg.count() != 2 || !has(res, "two.go") {
		t.Fatalf("after the worktree index changed: builds %d, %+v", cg.count(), res.Files)
	}
}

// Outside git: rg --files (its ignore rules, no hidden files); without rg
// an empty list and why; never a walk of the disk.
func TestIndexOutsideGit(t *testing.T) {
	gitEnv(t)
	dir := t.TempDir()
	writeFiles(t, dir, "a.go", "src/b.ts", "skip.log", ".hidden/x", "with space.md")
	if err := os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("*.log\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	x := New(context.Background(), Options{Git: &gitops.Git{}, RG: &RG{Bin: filepath.Join(dir, "no-such-rg")}})
	res := query(t, x, dir, "", 10)
	if len(res.Files) != 0 || res.Source != proto.FilesSourceNone || res.Reason == nil || !strings.Contains(*res.Reason, "rg") ||
		!strings.HasSuffix(*res.Reason, "; "+noFiles) {
		t.Fatalf("no rg = %+v", res)
	}
	x = New(context.Background(), Options{Git: &gitops.Git{}})
	if res := query(t, x, dir, "", 10); res.Source != proto.FilesSourceNone || len(res.Files) != 0 {
		t.Fatalf("no RG = %+v", res)
	}

	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg is not installed")
	}
	x = New(context.Background(), Options{Git: &gitops.Git{}, RG: &RG{}})
	res = query(t, x, dir, "", 10)
	if got := paths(res.Files); !slices.Equal(got, []string{"src:dir", "a.go:file", "with space.md:file", "src/b.ts:file"}) ||
		res.Source != proto.FilesSourceRG || res.Reason != nil {
		t.Fatalf("rg = %q %s %v", got, res.Source, res.Reason)
	}
}

// RG stops a listing at its timeout (SIGTERM, then SIGKILL) and keeps the
// complete records; it caps the output.
func TestRGTimeoutAndCap(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	script := func(name, body string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
		return p
	}
	ctx := context.Background()
	for name, body := range map[string]string{
		"term": "printf 'a\\000b\\000c'\nexec sleep 30\n",
		"kill": "trap '' TERM\nprintf 'a\\000b\\000c'\nsleep 30\n",
	} {
		r := &RG{Bin: script(name, body), Timeout: 200 * time.Millisecond, Grace: 200 * time.Millisecond}
		start := time.Now()
		l, err := r.List(ctx, dir)
		if err != nil || !slices.Equal(l.Paths, []string{"a", "b"}) || !strings.Contains(l.Cut, "timed out") {
			t.Fatalf("%s: %+v, %v", name, l, err)
		}
		if d := time.Since(start); d > 5*time.Second {
			t.Fatalf("%s: took %s", name, d)
		}
	}
	r := &RG{Bin: script("big", "printf 'aaaa\\000bbbb\\000cccc\\000'\n"), MaxOutput: 10}
	if l, err := r.List(ctx, dir); err != nil || !slices.Equal(l.Paths, []string{"aaaa", "bbbb"}) || !strings.Contains(l.Cut, "passed") {
		t.Fatalf("capped: %+v, %v", l, err)
	}
	r = &RG{Bin: script("none", "exit 1\n")}
	if l, err := r.List(ctx, dir); err != nil || len(l.Paths) != 0 || l.Cut != "" {
		t.Fatalf("no files: %+v, %v", l, err)
	}
	r = &RG{Bin: script("partial", "printf 'a\\000'\necho 'rg: ./x: Permission denied' >&2\nexit 2\n")}
	if l, err := r.List(ctx, dir); err != nil || !slices.Equal(l.Paths, []string{"a"}) || !strings.Contains(l.Cut, "Permission denied") {
		t.Fatalf("partial: %+v, %v", l, err)
	}
	r = &RG{Bin: script("broken", "echo 'rg: bad flag' >&2\nexit 2\n")}
	if _, err := r.List(ctx, dir); err == nil || errors.Is(err, ErrNoRG) {
		t.Fatalf("broken: %v", err)
	}
}

// fakeGit plays gitops.Git: one listing per dir, or an error.
type fakeGit struct {
	mu    sync.Mutex
	files map[string][]string
	err   error
	lists []string
}

func (f *fakeGit) IndexPath(_ context.Context, dir string) (string, error) {
	return filepath.Join(dir, ".git", "index"), nil
}

func (f *fakeGit) ListFiles(_ context.Context, dir string) (*gitops.Listing, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lists = append(f.lists, dir)
	if f.err != nil {
		return nil, f.err
	}
	return &gitops.Listing{Paths: f.files[dir]}, nil
}

func (f *fakeGit) set(err error) {
	f.mu.Lock()
	f.err = err
	f.mu.Unlock()
}

func (f *fakeGit) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.lists)
}

// A failed first build is an error (retried after the throttle); a failed
// rebuild keeps the old index and says so.
func TestIndexFailures(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	fg := &fakeGit{files: map[string][]string{"/r": {"a.go"}}, err: errors.New("git ls-files: boom")}
	x := New(context.Background(), Options{Git: fg, Now: clock.Now})
	ctx := context.Background()
	if _, err := x.Files(ctx, "/r", "", 10); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("first build failed: %v", err)
	}
	if _, err := x.Files(ctx, "/r", "", 10); err == nil || fg.count() != 1 {
		t.Fatalf("within the throttle: %v, builds %d", err, fg.count())
	}
	fg.set(nil)
	clock.Add(6 * time.Second)
	if res, err := x.Files(ctx, "/r", "", 10); err != nil || !has(res, "a.go") {
		t.Fatalf("retried: %+v, %v", res, err)
	}
	fg.set(errors.New("git ls-files: boom again"))
	clock.Add(31 * time.Second)
	x.Files(ctx, "/r", "", 10)
	x.Wait()
	res, err := x.Files(ctx, "/r", "", 10)
	if err != nil || !has(res, "a.go") || res.Reason == nil || !strings.Contains(*res.Reason, "boom again") {
		t.Fatalf("failed rebuild: %+v, %v", res, err)
	}

	// A first query whose caller gives up: an error, the build goes on.
	gate := make(chan struct{})
	cg := &countingGit{Git: fg, gate: gate}
	fg.set(nil)
	x = New(context.Background(), Options{Git: cg, Now: clock.Now})
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := x.Files(cctx, "/r", "", 10); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled first query: %v", err)
	}
	close(gate)
	x.Wait()
	if res, err := x.Files(ctx, "/r", "", 10); err != nil || !has(res, "a.go") || cg.count() != 1 {
		t.Fatalf("after the build: %+v, %v, builds %d", res, err, cg.count())
	}
}

// At most MaxCheckouts indexes (the least recently queried dropped), and
// none unqueried for longer than Idle.
func TestIndexEviction(t *testing.T) {
	clock := &fakeClock{t: time.Unix(1_800_000_000, 0)}
	fg := &fakeGit{files: map[string][]string{}}
	x := New(context.Background(), Options{Git: fg, Now: clock.Now, MaxCheckouts: 2, Idle: time.Minute})
	ctx := context.Background()
	for _, d := range []string{"/a", "/b", "/a", "/c"} {
		if _, err := x.Files(ctx, d, "", 10); err != nil {
			t.Fatal(err)
		}
	}
	x.Wait()
	x.mu.Lock()
	_, a := x.entries["/a"]
	_, b := x.entries["/b"]
	n := len(x.entries)
	x.mu.Unlock()
	if !a || b || n != 2 {
		t.Fatalf("entries: /a %v /b %v, %d", a, b, n)
	}
	clock.Add(2 * time.Minute)
	x.Files(ctx, "/c", "", 10)
	x.Wait()
	x.mu.Lock()
	_, a = x.entries["/a"]
	n = len(x.entries)
	x.mu.Unlock()
	if a || n != 1 {
		t.Fatalf("idle /a kept: %d entries", n)
	}
	if fg.count() != 4 { // /a, /b, /c, then /c again at its max age
		t.Fatalf("builds = %d (%v)", fg.count(), fg.lists)
	}
}
