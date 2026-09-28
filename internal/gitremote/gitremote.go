// Package gitremote finds which GitHub repository a directory belongs to,
// from `git -C <dir> remote get-url origin`, for the floor repo
// suggestion. It never changes anything in the repository.
package gitremote

import (
	"bytes"
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

var (
	ownerRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,39}$`)
	repoRe  = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
	// scp-like ssh: [user@]github.com:owner/repo
	scpRe = regexp.MustCompile(`^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):([^/].*)$`)
)

// ValidRepo reports whether s is a GitHub "owner/repo".
func ValidRepo(s string) bool {
	owner, name, ok := strings.Cut(s, "/")
	return ok && ValidOwner(owner) && validName(name)
}

// ValidOwner reports whether s is a GitHub user or organization name.
func ValidOwner(s string) bool { return ownerRe.MatchString(s) }

func validName(s string) bool { return repoRe.MatchString(s) && s != "." && s != ".." }

// ParseGitHub returns "owner/repo" for a GitHub remote URL: ssh
// (git@github.com:o/r, ssh://git@github.com/o/r) or https
// (https://github.com/o/r), with or without ".git".
func ParseGitHub(remote string) (string, bool) {
	remote = strings.TrimSpace(remote)
	var host, path string
	if u, err := url.Parse(remote); err == nil && u.Scheme != "" && u.Host != "" {
		switch u.Scheme {
		case "https", "http", "ssh", "git", "git+ssh", "ssh+git":
		default:
			return "", false
		}
		host, path = u.Hostname(), u.Path
	} else if m := scpRe.FindStringSubmatch(remote); m != nil && !strings.Contains(m[1], "/") {
		host, path = m[1], m[2]
	} else {
		return "", false
	}
	if h := strings.ToLower(host); h != "github.com" && h != "www.github.com" {
		return "", false
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	owner, name, ok := strings.Cut(path, "/")
	if !ok || !ValidOwner(owner) || !validName(name) {
		return "", false
	}
	return owner + "/" + name, true
}

// Resolver looks up and caches the GitHub repo of directories.
type Resolver struct {
	// Git is the git executable (default "git").
	Git string
	// Timeout bounds one git call (default 2 s).
	Timeout time.Duration
	// TTL is how long an answer is reused (default 5 min).
	TTL time.Duration
	// Now is the clock (default time.Now).
	Now func() time.Time
	// Run runs argv and returns its stdout (default: exec with
	// herdr.CleanEnv). Tests inject a fake.
	Run func(ctx context.Context, argv []string) ([]byte, error)

	mu    sync.Mutex
	cache map[string]entry
}

type entry struct {
	repo string
	at   time.Time
}

// Repo returns the GitHub "owner/repo" of dir's origin remote, or "" when
// dir is not a git checkout with a GitHub origin.
func (r *Resolver) Repo(ctx context.Context, dir string) string {
	if dir == "" || !filepath.IsAbs(dir) {
		return ""
	}
	now := r.now()
	r.mu.Lock()
	e, ok := r.cache[dir]
	r.mu.Unlock()
	if ok && now.Sub(e.at) < r.ttl() {
		return e.repo
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	run := r.Run
	if run == nil {
		run = execGit
	}
	git := r.Git
	if git == "" {
		git = "git"
	}
	out, err := run(cctx, []string{git, "-C", dir, "remote", "get-url", "origin"})
	if ctx.Err() != nil {
		return "" // shutting down: do not cache
	}
	repo := ""
	if err == nil {
		repo, _ = ParseGitHub(string(out))
	}
	r.mu.Lock()
	if r.cache == nil {
		r.cache = map[string]entry{}
	}
	r.cache[dir] = entry{repo: repo, at: now}
	r.mu.Unlock()
	return repo
}

func (r *Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Resolver) ttl() time.Duration {
	if r.TTL <= 0 {
		return 5 * time.Minute
	}
	return r.TTL
}

func execGit(ctx context.Context, argv []string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append(herdr.CleanEnv(os.Environ()), "GIT_TERMINAL_PROMPT=0")
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	return out.Bytes(), err
}
