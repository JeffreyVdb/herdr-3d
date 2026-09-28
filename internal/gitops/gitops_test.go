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
		"toplevel":      {"{git}", "-C", "{dir}", "rev-parse", "--show-toplevel"},
		"fetch":         {"{git}", "-C", "{dir}", "fetch", "--quiet", "origin"},
		"origin-head":   {"{git}", "-C", "{dir}", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"},
		"commit":        {"{git}", "-C", "{dir}", "log", "-1", "--format=%H %ct", "{ref}", "--"},
		"status":        {"{git}", "-C", "{dir}", "status", "--porcelain"},
		"branch":        {"{git}", "-C", "{dir}", "symbolic-ref", "--quiet", "--short", "HEAD"},
		"unpushed":      {"{git}", "-C", "{dir}", "rev-list", "--count", "HEAD", "--not", "--remotes"},
		"delete-branch": {"{git}", "-C", "{dir}", "branch", "-D", "{branch}"},
	}
	if !reflect.DeepEqual(shapes, want) {
		t.Fatalf("shapes = %q", shapes)
	}
	var methods []string
	typ := reflect.TypeOf(&Git{})
	for i := range typ.NumMethod() {
		methods = append(methods, typ.Method(i).Name)
	}
	if w := []string{"Commit", "CurrentBranch", "DefaultBranch", "DeleteBranch", "Fetch", "Status", "TopLevel", "Unpushed"}; !slices.Equal(methods, w) {
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
		"branch with flags": func() error { return g.DeleteBranch(ctx, "/r", "h3d/x -f") },
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
	git(t, wt, "push", "-q", "origin", "h3d/mochi-a1b2c3")
	if n, err := g.Unpushed(ctx, wt); err != nil || n != 0 {
		t.Fatalf("Unpushed after push = %d, %v", n, err)
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
