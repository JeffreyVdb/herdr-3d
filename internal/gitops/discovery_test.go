package gitops

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// #54: a checkout's top level and common directory, and its origin, on a
// real repository with a linked worktree, a folder with spaces and unicode,
// and an inherited GIT_DIR that must not leak in.
func TestCheckoutAndOrigin(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "t")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "t")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.com")
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	main, wt := filepath.Join(root, "my repo ü"), filepath.Join(root, "wt")
	git(t, root, "init", "-q", "-b", "trunk", main)
	git(t, main, "commit", "-q", "--allow-empty", "-m", "one")
	git(t, main, "worktree", "add", "-q", "-b", "side", wt)
	decoy := filepath.Join(root, "decoy")
	git(t, root, "init", "-q", decoy)
	other := filepath.Join(root, "other")
	git(t, root, "init", "-q", other)
	git(t, other, "remote", "add", "origin", "git@github.com:Owner/Repo.git")
	// From here on the test's own git calls would hit decoy: the bridge's must not.
	t.Setenv("GIT_DIR", filepath.Join(decoy, ".git"))
	t.Setenv("GIT_WORK_TREE", decoy)

	ctx := context.Background()
	g := &Git{}
	got, err := g.Checkout(ctx, main)
	if err != nil || got != (CheckoutInfo{TopLevel: main, GitDir: filepath.Join(main, ".git"), CommonDir: filepath.Join(main, ".git")}) {
		t.Fatalf("Checkout(main) = %+v, %v", got, err)
	}
	got, err = g.Checkout(ctx, wt)
	if err != nil || got != (CheckoutInfo{TopLevel: wt, GitDir: filepath.Join(main, ".git", "worktrees", "wt"), CommonDir: filepath.Join(main, ".git")}) {
		t.Fatalf("Checkout(worktree) = %+v, %v", got, err)
	}
	if _, err := g.Checkout(ctx, root); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("Checkout outside a repo: %v", err)
	}
	if o, err := g.Origin(ctx, main); o != "" || err != nil {
		t.Fatalf("Origin without a remote = %q, %v", o, err)
	}
	if o, err := g.Origin(ctx, other); o != "git@github.com:Owner/Repo.git" || err != nil {
		t.Fatalf("Origin = %q, %v", o, err)
	}
}
