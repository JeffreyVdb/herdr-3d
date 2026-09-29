package gitops

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// TestGitAllowlist is the tripwire for the git commands the bridge runs.
func TestGitAllowlist(t *testing.T) {
	want := map[string][]string{
		"toplevel":        {"{git}", "-C", "{dir}", "rev-parse", "--show-toplevel"},
		"fetch":           {"{git}", "-C", "{dir}", "fetch", "--quiet", "origin"},
		"origin-head":     {"{git}", "-C", "{dir}", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"},
		"commit":          {"{git}", "-C", "{dir}", "log", "-1", "--format=%H %ct", "{ref}", "--"},
		"status":          {"{git}", "-C", "{dir}", "status", "--porcelain"},
		"branch":          {"{git}", "-C", "{dir}", "symbolic-ref", "--quiet", "--short", "HEAD"},
		"unpushed":        {"{git}", "-C", "{dir}", "rev-list", "--count", "HEAD", "--not", "--remotes"},
		"branch-unpushed": {"{git}", "-C", "{dir}", "rev-list", "--count", "refs/heads/{branch}", "--not", "--remotes"},
		"branch-tip":      {"{git}", "-C", "{dir}", "rev-parse", "--verify", "--quiet", "refs/heads/{branch}"},
		"delete-branch":   {"{git}", "-C", "{dir}", "branch", "-D", "{branch}"},
		// M5: the Changes panel, read-only.
		"status-v2":  {"{git}", "-C", "{dir}", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"},
		"merge-base": {"{git}", "-C", "{dir}", "merge-base", "HEAD", "{ref}"},
		"diff": {"{git}", "-C", "{dir}", "diff", "--numstat", "--patch", "-z", "--find-renames", "--no-color", "--no-ext-diff",
			"--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "{rev}", "--"},
		// M7: opening a pull request.
		"push":     {"{git}", "-C", "{dir}", "push", "-u", "origin", "refs/heads/{branch}:refs/heads/{branch}"},
		"ahead-of": {"{git}", "-C", "{dir}", "rev-list", "--count", "HEAD", "--not", "{ref}"},
		"subjects": {"{git}", "-C", "{dir}", "log", "--format=%s", "-n", "20", "HEAD", "--not", "{ref}", "--"},
	}
	if !reflect.DeepEqual(shapes, want) {
		t.Fatalf("shapes = %q", shapes)
	}
	var methods []string
	typ := reflect.TypeOf(&Git{})
	for i := range typ.NumMethod() {
		methods = append(methods, typ.Method(i).Name)
	}
	if w := []string{"AheadOf", "BranchTip", "BranchUnpushed", "Changes", "Commit", "CurrentBranch", "DefaultBranch", "DeleteBranch",
		"Fetch", "Push", "Status", "Subjects", "TopLevel", "Unpushed"}; !slices.Equal(methods, w) {
		t.Fatalf("Git methods = %v, want %v", methods, w)
	}

	ran := false
	g := &Git{Run: func(context.Context, []string) ([]byte, []byte, error) { ran = true; return nil, nil, nil }}
	ctx := context.Background()
	for name, call := range map[string]func() error{
		"relative dir":      func() error { return g.Fetch(ctx, "repo") },
		"flag dir":          func() error { return g.Fetch(ctx, "--upload-pack=x") },
		"local ref":         func() error { _, _, err := g.Commit(ctx, "/r", "HEAD"); return err },
		"ref option":        func() error { _, _, err := g.Commit(ctx, "/r", "--all"); return err },
		"foreign branch":    func() error { return g.DeleteBranch(ctx, "/r", "main") },
		"push a foreign":    func() error { return g.Push(ctx, "/r", "main") },
		"push a refspec":    func() error { return g.Push(ctx, "/r", "h3d/x:refs/heads/main") },
		"push relative dir": func() error { return g.Push(ctx, "repo", "h3d/x") },
		"ahead of local":    func() error { _, err := g.AheadOf(ctx, "/r", "main"); return err },
		"subjects of range": func() error { _, err := g.Subjects(ctx, "/r", "origin/a..b"); return err },
		"branch with flags": func() error { return g.DeleteBranch(ctx, "/r", "h3d/x -f") },
		"foreign ahead":     func() error { _, err := g.BranchUnpushed(ctx, "/r", "main"); return err },
		"foreign tip":       func() error { _, err := g.BranchTip(ctx, "/r", "--all"); return err },
		"changes relative":  func() error { _, err := g.Changes(ctx, "repo"); return err },
		"diff option": func() error {
			return g.pipe(ctx, opDiff, map[string]string{"dir": "/r", "rev": "--output=/tmp/x"}, nil)
		},
		"diff range": func() error { return g.pipe(ctx, opDiff, map[string]string{"dir": "/r", "rev": "HEAD..x"}, nil) },
		"merge-base local": func() error {
			_, err := g.run(ctx, opMergeBase, map[string]string{"dir": "/r", "ref": "main"})
			return err
		},
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if ran {
		t.Fatal("a refused command ran")
	}
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v: %s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// A real repository: a bare "origin", a clone, a linked worktree.
func TestGitOnARepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.com")
	root := t.TempDir()
	origin, work, other := filepath.Join(root, "origin.git"), filepath.Join(root, "work"), filepath.Join(root, "other")
	git(t, root, "init", "-q", "--bare", "-b", "trunk", origin)
	git(t, root, "clone", "-q", origin, work)
	git(t, work, "commit", "-q", "--allow-empty", "-m", "one")
	git(t, work, "push", "-q", "origin", "trunk")
	git(t, root, "clone", "-q", origin, other)

	ctx := context.Background()
	g := &Git{}
	if _, err := g.TopLevel(ctx, root); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("TopLevel outside a repo: %v", err)
	}
	sub := filepath.Join(work, "a", "b")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if top, err := g.TopLevel(ctx, sub); err != nil || top != work {
		t.Fatalf("TopLevel = %q, %v", top, err)
	}
	// The clone of an empty origin has no origin/HEAD; trunk is neither main
	// nor master: unknown. With origin/HEAD set it is found.
	if b := g.DefaultBranch(ctx, work); b != "" {
		t.Fatalf("DefaultBranch without origin/HEAD = %q", b)
	}
	git(t, work, "remote", "set-head", "origin", "trunk")
	if b := g.DefaultBranch(ctx, work); b != "trunk" {
		t.Fatalf("DefaultBranch = %q", b)
	}

	// Someone else pushes: only a fetch shows it.
	git(t, other, "commit", "-q", "--allow-empty", "-m", "two")
	git(t, other, "push", "-q", "origin", "trunk")
	pushed := git(t, other, "rev-parse", "HEAD")
	if sha, _, _ := g.Commit(ctx, work, "origin/trunk"); sha == pushed {
		t.Fatal("origin/trunk moved without a fetch")
	}
	if err := g.Fetch(ctx, work); err != nil {
		t.Fatal(err)
	}
	sha, at, err := g.Commit(ctx, work, "origin/trunk")
	if err != nil || sha != pushed || at.IsZero() {
		t.Fatalf("Commit = %q %v %v, want %s", sha, at, err, pushed)
	}

	wt := filepath.Join(root, "wt")
	git(t, work, "worktree", "add", "-q", "-b", "h3d/mochi-a1b2c3", wt, "origin/trunk")
	if b := HeadBranch(wt); b != "h3d/mochi-a1b2c3" {
		t.Fatalf("HeadBranch(linked) = %q", b)
	}
	if b := HeadBranch(work); b != "trunk" {
		t.Fatalf("HeadBranch(main) = %q", b)
	}
	if b, err := g.CurrentBranch(ctx, wt); err != nil || b != "h3d/mochi-a1b2c3" {
		t.Fatalf("CurrentBranch = %q, %v", b, err)
	}
	if lines, err := g.Status(ctx, wt); err != nil || len(lines) != 0 {
		t.Fatalf("clean Status = %q, %v", lines, err)
	}
	if n, err := g.Unpushed(ctx, wt); err != nil || n != 0 {
		t.Fatalf("Unpushed on the base = %d, %v", n, err)
	}
	base := git(t, work, "rev-parse", "origin/trunk")
	if tip, err := g.BranchTip(ctx, work, "h3d/mochi-a1b2c3"); err != nil || tip != base {
		t.Fatalf("BranchTip = %q, %v, want %s", tip, err, base)
	}
	if err := os.WriteFile(filepath.Join(wt, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if lines, err := g.Status(ctx, wt); err != nil || !slices.Equal(lines, []string{"?? notes.txt"}) {
		t.Fatalf("dirty Status = %q, %v", lines, err)
	}
	git(t, wt, "add", "notes.txt")
	git(t, wt, "commit", "-q", "-m", "notes")
	if n, err := g.Unpushed(ctx, wt); err != nil || n != 1 {
		t.Fatalf("Unpushed = %d, %v", n, err)
	}
	if tip, err := g.BranchTip(ctx, work, "h3d/mochi-a1b2c3"); err != nil || tip == base {
		t.Fatalf("BranchTip after a commit = %q, %v", tip, err)
	}
	// M7: what a pull request for it would hold, and pushing it.
	if n, err := g.AheadOf(ctx, wt, "origin/trunk"); err != nil || n != 1 {
		t.Fatalf("AheadOf = %d, %v", n, err)
	}
	if subs, err := g.Subjects(ctx, wt, "origin/trunk"); err != nil || !slices.Equal(subs, []string{"notes"}) {
		t.Fatalf("Subjects = %q, %v", subs, err)
	}
	// The branch's own commits count, whatever the checkout has out.
	git(t, wt, "checkout", "-q", "--detach", "origin/trunk")
	if n, err := g.BranchUnpushed(ctx, work, "h3d/mochi-a1b2c3"); err != nil || n != 1 {
		t.Fatalf("BranchUnpushed = %d, %v", n, err)
	}
	if n, err := g.Unpushed(ctx, wt); err != nil || n != 0 {
		t.Fatalf("Unpushed of a detached base = %d, %v", n, err)
	}
	git(t, wt, "checkout", "-q", "h3d/mochi-a1b2c3")
	git(t, wt, "push", "-q", "origin", "h3d/mochi-a1b2c3")
	if n, err := g.Unpushed(ctx, wt); err != nil || n != 0 {
		t.Fatalf("Unpushed after push = %d, %v", n, err)
	}
	if n, err := g.BranchUnpushed(ctx, work, "h3d/mochi-a1b2c3"); err != nil || n != 0 {
		t.Fatalf("BranchUnpushed after push = %d, %v", n, err)
	}
	// M7: Push sends a branch of the bridge to origin under its own name.
	git(t, wt, "commit", "-q", "--allow-empty", "-m", "more")
	if err := g.Push(ctx, wt, "h3d/mochi-a1b2c3"); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if out := git(t, origin, "rev-parse", "refs/heads/h3d/mochi-a1b2c3"); out != git(t, wt, "rev-parse", "HEAD") {
		t.Fatalf("origin's branch = %s", out)
	}
	if up := git(t, wt, "rev-parse", "--abbrev-ref", "@{upstream}"); up != "origin/h3d/mochi-a1b2c3" {
		t.Fatalf("upstream = %s", up)
	}
	if n, err := g.AheadOf(ctx, wt, "origin/h3d/mochi-a1b2c3"); err != nil || n != 0 {
		t.Fatalf("AheadOf its own upstream = %d, %v", n, err)
	}
	git(t, wt, "checkout", "-q", "--detach")
	if b, err := g.CurrentBranch(ctx, wt); err != nil || b != "" || HeadBranch(wt) != "" {
		t.Fatalf("detached: %q %v %q", b, err, HeadBranch(wt))
	}
	git(t, work, "worktree", "remove", wt)
	if err := g.DeleteBranch(ctx, work, "h3d/mochi-a1b2c3"); err != nil {
		t.Fatal(err)
	}
	if out := git(t, work, "branch", "--list", "h3d/*"); out != "" {
		t.Fatalf("branch left: %q", out)
	}
}
