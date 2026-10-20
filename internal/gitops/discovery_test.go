package gitops

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	bare, bareWT := filepath.Join(root, "bare.git"), filepath.Join(root, "bare-wt")
	git(t, root, "init", "-q", "--bare", "-b", "trunk", bare)
	git(t, bare, "worktree", "add", "-q", "--orphan", "-b", "side", bareWT)
	sub := filepath.Join(wt, "a")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
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
	// The main checkout, from it and from anywhere in a linked worktree;
	// a bare repository's worktree has none.
	for _, dir := range []string{main, wt, sub} {
		if m, err := g.MainCheckout(ctx, dir); m != main || err != nil {
			t.Fatalf("MainCheckout(%s) = %q, %v", dir, m, err)
		}
	}
	if m, err := g.MainCheckout(ctx, bareWT); err == nil || !strings.Contains(err.Error(), "has no main checkout") {
		t.Fatalf("MainCheckout(worktree of a bare repo) = %q, %v", m, err)
	}
	if _, err := g.MainCheckout(ctx, root); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("MainCheckout outside a repo: %v", err)
	}
	if o, err := g.Origin(ctx, main); o != "" || err != nil {
		t.Fatalf("Origin without a remote = %q, %v", o, err)
	}
	if o, err := g.Origin(ctx, other); o != "git@github.com:Owner/Repo.git" || err != nil {
		t.Fatalf("Origin = %q, %v", o, err)
	}
}
