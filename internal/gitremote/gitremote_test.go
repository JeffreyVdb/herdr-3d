package gitremote

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func TestParseGitHub(t *testing.T) {
	for _, tc := range []struct {
		url, want string
	}{
		{"git@github.com:JeffreyVdb/herdr-3d.git", "JeffreyVdb/herdr-3d"},
		{"git@github.com:JeffreyVdb/herdr-3d", "JeffreyVdb/herdr-3d"},
		{"git@github.com:JeffreyVdb/herdr-3d.git\n", "JeffreyVdb/herdr-3d"},
		{"github.com:o/r.git", "o/r"},
		{"https://github.com/JeffreyVdb/herdr-3d.git", "JeffreyVdb/herdr-3d"},
		{"https://github.com/JeffreyVdb/herdr-3d", "JeffreyVdb/herdr-3d"},
		{"https://github.com/JeffreyVdb/herdr-3d/", "JeffreyVdb/herdr-3d"},
		{"https://token@github.com/o/r.git", "o/r"},
		{"https://GitHub.com/o/my.repo_x-1", "o/my.repo_x-1"},
		{"ssh://git@github.com/o/r.git", "o/r"},
		{"ssh://git@github.com:22/o/r.git", "o/r"},
		{"git://github.com/o/r", "o/r"},
		// Not GitHub, or not a repo.
		{"git@gitlab.com:o/r.git", ""},
		{"https://github.example.com/o/r", ""},
		{"https://github.com/o", ""},
		{"https://github.com/o/r/tree/main", ""},
		{"file:///srv/git/r.git", ""},
		{"/srv/git/r.git", ""},
		{"../r.git", ""},
		{"https://github.com/-bad_owner!/r", ""},
		{"https://github.com/o/..", ""},
		{"", ""},
	} {
		got, ok := ParseGitHub(tc.url)
		if got != tc.want || ok != (tc.want != "") {
			t.Errorf("ParseGitHub(%q) = %q, %v; want %q", tc.url, got, ok, tc.want)
		}
	}
}

func TestValidRepo(t *testing.T) {
	for s, want := range map[string]bool{
		"JeffreyVdb/herdr-3d": true, "o/r.js": true, "o/r": true,
		"o": false, "o/r/x": false, "/r": false, "o/": false, "o r/x": false, "o/..": false,
		"a123456789012345678901234567890123456789/r": false,
	} {
		if ValidRepo(s) != want {
			t.Errorf("ValidRepo(%q) = %v", s, !want)
		}
	}
}

func TestResolverCachesWithTTL(t *testing.T) {
	now := time.Unix(1000, 0)
	var calls [][]string
	origin := map[string]string{"/w/a": "git@github.com:o/a.git\n", "/w/b": "https://github.com/o/b\n"}
	r := &Resolver{Now: func() time.Time { return now }, TTL: time.Minute,
		Run: func(_ context.Context, argv []string) ([]byte, error) {
			calls = append(calls, argv)
			if u, ok := origin[argv[2]]; ok {
				return []byte(u), nil
			}
			return nil, errors.New("exit status 2")
		}}
	ctx := context.Background()
	if got := r.Repo(ctx, "/w/a"); got != "o/a" {
		t.Fatalf("a = %q", got)
	}
	if got := r.Repo(ctx, "/w/none"); got != "" {
		t.Fatalf("none = %q", got)
	}
	r.Repo(ctx, "/w/a")
	r.Repo(ctx, "/w/none")
	if len(calls) != 2 || !slices.Equal(calls[0], []string{"git", "-C", "/w/a", "remote", "get-url", "origin"}) {
		t.Fatalf("calls = %q", calls)
	}
	origin["/w/a"] = "git@github.com:o/renamed.git"
	now = now.Add(2 * time.Minute)
	if got := r.Repo(ctx, "/w/a"); got != "o/renamed" || len(calls) != 3 {
		t.Fatalf("after TTL: %q, %d calls", got, len(calls))
	}
	if got := r.Repo(ctx, "relative"); got != "" || len(calls) != 3 {
		t.Fatalf("relative dir: %q", got)
	}
}

// Against a real git: a throwaway repository with an origin.
func TestResolverRealGit(t *testing.T) {
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	for _, args := range [][]string{{"init", "-q", dir}, {"-C", dir, "remote", "add", "origin", "git@github.com:JeffreyVdb/herdr-3d.git"}} {
		if out, err := exec.Command(git, args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	r := &Resolver{}
	if got := r.Repo(context.Background(), sub); got != "JeffreyVdb/herdr-3d" {
		t.Fatalf("Repo = %q", got)
	}
	if got := r.Repo(context.Background(), t.TempDir()); got != "" {
		t.Fatalf("not a repo: %q", got)
	}
}
