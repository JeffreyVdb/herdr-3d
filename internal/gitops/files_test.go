package gitops

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func gitRepo(t *testing.T) string {
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
	return t.TempDir()
}

func writeFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// #137: tracked and untracked files, never ignored ones; odd names verbatim;
// a symlink is its own path; a subdirectory lists relative to itself; a
// linked worktree has its own index file.
func TestListFilesOnARepository(t *testing.T) {
	root := gitRepo(t)
	repo := filepath.Join(root, "repo")
	git(t, root, "init", "-q", "-b", "main", repo)
	writeFiles(t, repo, map[string]string{
		".gitignore": "build/\n*.log\n", "a.go": "", "src/ui/button.ts": "", "docs/my file #1?.md": "",
		"docs/école.md": "",
	})
	git(t, repo, "add", "-A")
	git(t, repo, "commit", "-q", "-m", "one")
	writeFiles(t, repo, map[string]string{"new.txt": "", "build/out.bin": "", "x.log": "", "src/ui/new.ts": ""})
	outside := filepath.Join(root, "outside")
	writeFiles(t, outside, map[string]string{"secret": ""})
	if err := os.Symlink(outside, filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}

	ctx := context.Background()
	g := &Git{}
	l, err := g.ListFiles(ctx, repo)
	if err != nil || l.Cut != "" {
		t.Fatalf("ListFiles = %+v, %v", l, err)
	}
	got := slices.Sorted(slices.Values(l.Paths))
	want := []string{".gitignore", "a.go", "docs/my file #1?.md", "docs/école.md", "link", "new.txt", "src/ui/button.ts",
		"src/ui/new.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("paths = %q\nwant %q", got, want)
	}
	if sub, err := g.ListFiles(ctx, filepath.Join(repo, "src")); err != nil ||
		!slices.Equal(slices.Sorted(slices.Values(sub.Paths)), []string{"ui/button.ts", "ui/new.ts"}) {
		t.Fatalf("ListFiles(src) = %+v, %v", sub, err)
	}
	idx, err := g.IndexPath(ctx, filepath.Join(repo, "src"))
	if err != nil || idx != filepath.Join(repo, ".git", "index") {
		t.Fatalf("IndexPath = %q, %v", idx, err)
	}
	// Listing does not touch the index.
	before, _ := os.Stat(idx)
	time.Sleep(20 * time.Millisecond)
	if _, err := g.ListFiles(ctx, repo); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.Stat(idx); !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Fatal("ListFiles wrote the index")
	}

	wt := filepath.Join(root, "wt")
	git(t, repo, "worktree", "add", "-q", "-b", "feature", wt)
	widx, err := g.IndexPath(ctx, wt)
	if err != nil || filepath.Dir(widx) == filepath.Join(repo, ".git") || !strings.HasPrefix(widx, filepath.Join(repo, ".git", "worktrees")) {
		t.Fatalf("worktree IndexPath = %q, %v", widx, err)
	}
	if _, err := os.Stat(widx); err != nil {
		t.Fatalf("worktree index: %v", err)
	}

	if _, err := g.ListFiles(ctx, outside); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("ListFiles outside a repo: %v", err)
	}
	if _, err := g.IndexPath(ctx, outside); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("IndexPath outside a repo: %v", err)
	}
}

func TestListFilesCutAndRepeats(t *testing.T) {
	ctx := context.Background()
	g := &Git{Pipe: func(_ context.Context, argv []string, w io.Writer) ([]byte, error) {
		_, _ = io.WriteString(w, "a\x00b\x00a\x00\x00c")
		return nil, nil
	}}
	l, err := g.ListFiles(ctx, "/r")
	if err != nil || !slices.Equal(l.Paths, []string{"a", "b"}) || l.Cut != "" {
		t.Fatalf("ListFiles = %+v, %v", l, err)
	}

	// Timed out: the complete records so far, and why.
	g = &Git{Timeout: 20 * time.Millisecond, Pipe: func(ctx context.Context, _ []string, w io.Writer) ([]byte, error) {
		_, _ = io.WriteString(w, "a\x00b")
		<-ctx.Done()
		return nil, ctx.Err()
	}}
	l, err = g.ListFiles(ctx, "/r")
	if err != nil || !slices.Equal(l.Paths, []string{"a"}) || !strings.Contains(l.Cut, "timed out") {
		t.Fatalf("timed out ListFiles = %+v, %v", l, err)
	}

	// Over the cap: what fit.
	g = &Git{Pipe: func(_ context.Context, _ []string, w io.Writer) ([]byte, error) {
		for i := range MaxListing>>20 + 2 { // records of exactly 1 MiB
			_, _ = io.WriteString(w, fmt.Sprintf("%07d", i)+strings.Repeat("x", 1<<20-8)+"\x00")
		}
		return nil, nil
	}}
	l, err = g.ListFiles(ctx, "/r")
	if err != nil || len(l.Paths) != MaxListing>>20 || !strings.Contains(l.Cut, "MiB") {
		t.Fatalf("capped ListFiles: %d paths, cut %q, %v", len(l.Paths), l.Cut, err)
	}

	// Any other failure is an error.
	g = &Git{Pipe: func(context.Context, []string, io.Writer) ([]byte, error) {
		return []byte("fatal: bad"), errors.New("exit status 128")
	}}
	if _, err := g.ListFiles(ctx, "/r"); err == nil {
		t.Fatal("a failed listing succeeded")
	}
}
