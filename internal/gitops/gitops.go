// Package gitops is the bridge's typed git runner for hiring into a
// worktree and for checking a worker's tree before it is sent home. Like
// herdr.Control it runs exactly the commands in shapes, with validated
// variables, each its own argv element (no shell), in a clean
// environment. Only DeleteBranch changes a repository, and only a branch
// the bridge made (h3d/…, and recorded as made for that worker by the
// caller); Push (M7) sends such a branch to origin; Fetch only updates
// remote-tracking refs. Changes (the Changes
// panel) only reads.
package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// Git runs git commands.
type Git struct {
	// Bin is the git executable (default "git").
	Bin string
	// Timeout bounds one command (default 10 s; a fetch 20 s).
	Timeout time.Duration
	// Run executes argv (default: exec with herdr.CleanEnv plus
	// GIT_TERMINAL_PROMPT=0 and GIT_OPTIONAL_LOCKS=0, output capped).
	// Tests inject a fake.
	Run Runner
	// Pipe runs argv streaming its stdout to w, uncapped (default: exec like
	// Run; with only Run set, Run's output is written to w).
	Pipe PipeRunner
	// ChangesTimeout bounds all the git calls of one Changes together
	// (default DefaultChangesTimeout).
	ChangesTimeout time.Duration
}

// Runner runs one command and returns its stdout and stderr.
type Runner func(ctx context.Context, argv []string) (stdout, stderr []byte, err error)

// PipeRunner runs one command, writing its stdout to w, and returns its
// stderr.
type PipeRunner func(ctx context.Context, argv []string, w io.Writer) (stderr []byte, err error)

// Errors.
var (
	ErrNotAllowed = errors.New("git: command not allowed")
	// ErrNotRepo is returned by TopLevel for a directory outside any git
	// work tree.
	ErrNotRepo = errors.New("not a git work tree")
)

// Operations (keys of shapes).
const (
	opTopLevel     = "toplevel"
	opFetch        = "fetch"
	opOriginHead   = "origin-head"
	opCommit       = "commit"
	opStatus       = "status"
	opBranch       = "branch"
	opUnpushed     = "unpushed"
	opBranchAhead  = "branch-unpushed"
	opBranchTip    = "branch-tip"
	opDeleteBranch = "delete-branch"
	// The Changes panel (read-only).
	opStatusV2  = "status-v2"
	opMergeBase = "merge-base"
	opDiff      = "diff"
	// Opening a pull request (M7): push a branch the bridge made, and the
	// read-only questions that come before.
	opPush     = "push"
	opAheadOf  = "ahead-of"
	opSubjects = "subjects"
	// #137 worker.files (read-only): a checkout's index file and its files.
	opIndexPath = "index-path"
	opListFiles = "ls-files"
)

// shapes is the complete set of git commands the bridge runs. {git} is
// the executable, {dir} {ref} {branch} validated placeholders.
// TestGitAllowlist is the tripwire.
var shapes = map[string][]string{
	opTopLevel:   {"{git}", "-C", "{dir}", "rev-parse", "--show-toplevel"},
	opFetch:      {"{git}", "-C", "{dir}", "fetch", "--quiet", "origin"},
	opOriginHead: {"{git}", "-C", "{dir}", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"},
	opCommit:     {"{git}", "-C", "{dir}", "log", "-1", "--format=%H %ct", "{ref}", "--"},
	opStatus:     {"{git}", "-C", "{dir}", "status", "--porcelain"},
	opBranch:     {"{git}", "-C", "{dir}", "symbolic-ref", "--quiet", "--short", "HEAD"},
	opUnpushed:   {"{git}", "-C", "{dir}", "rev-list", "--count", "HEAD", "--not", "--remotes"},
	// The same for a branch the bridge made, and where it points.
	opBranchAhead: {"{git}", "-C", "{dir}", "rev-list", "--count", "refs/heads/{branch}", "--not", "--remotes"},
	opBranchTip:   {"{git}", "-C", "{dir}", "rev-parse", "--verify", "--quiet", "refs/heads/{branch}"},
	// Only a branch the bridge made, after its commits were seen pushed.
	opDeleteBranch: {"{git}", "-C", "{dir}", "branch", "-D", "{branch}"},
	// The Changes panel: status, the merge-base with origin/<default>, and
	// numstat + patch of the work tree against it in one call (one snapshot).
	// No external diff or textconv programs run.
	opStatusV2:  {"{git}", "-C", "{dir}", "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"},
	opMergeBase: {"{git}", "-C", "{dir}", "merge-base", "HEAD", "{ref}"},
	opDiff: {"{git}", "-C", "{dir}", "diff", "--numstat", "--patch", "-z", "--find-renames", "--no-color", "--no-ext-diff",
		"--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "{rev}", "--"},
	// Opening a pull request (M7). The one shape that writes outside the
	// checkout: pushing an h3d/… branch (the caller checked the bridge made
	// it for the worker) to its own name on origin. The others count and
	// list the commits HEAD has on top of origin/<base>.
	opPush:     {"{git}", "-C", "{dir}", "push", "-u", "origin", "refs/heads/{branch}:refs/heads/{branch}"},
	opAheadOf:  {"{git}", "-C", "{dir}", "rev-list", "--count", "HEAD", "--not", "{ref}"},
	opSubjects: {"{git}", "-C", "{dir}", "log", "--format=%s", "-n", "20", "HEAD", "--not", "{ref}", "--"},
	// #137 worker.files: where the checkout's index file is (a linked
	// worktree has its own), and the tracked plus untracked-not-ignored
	// files under the checkout, relative to it, NUL-terminated and unquoted.
	// Neither writes the index (and GIT_OPTIONAL_LOCKS=0 besides).
	opIndexPath: {"{git}", "-C", "{dir}", "rev-parse", "--path-format=absolute", "--git-path", "index"},
	opListFiles: {"{git}", "-C", "{dir}", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"},
}

var placeholders = map[string]func(string) bool{
	"dir":    herdr.ValidDir,
	"ref":    herdr.ValidBase,
	"branch": herdr.ValidBranch,
	"rev":    validRev,
}

var placeholderRe = regexp.MustCompile(`\{[a-z]+\}`)

func (g *Git) run(ctx context.Context, op string, vars map[string]string) ([]byte, error) {
	var stdout []byte
	err := g.exec(ctx, op, vars, func(ctx context.Context, argv []string) ([]byte, error) {
		runner := g.Run
		if runner == nil {
			runner = execRunner
		}
		var stderr []byte
		var err error
		stdout, stderr, err = runner(ctx, argv)
		return stderr, err
	})
	return stdout, err
}

// pipe runs op like run, streaming its stdout to w.
func (g *Git) pipe(ctx context.Context, op string, vars map[string]string, w io.Writer) error {
	return g.exec(ctx, op, vars, func(ctx context.Context, argv []string) ([]byte, error) {
		switch {
		case g.Pipe != nil:
			return g.Pipe(ctx, argv, w)
		case g.Run != nil:
			stdout, stderr, err := g.Run(ctx, argv)
			if _, werr := w.Write(stdout); err == nil {
				err = werr
			}
			return stderr, err
		}
		return execPipe(ctx, argv, w)
	})
}

// exec builds op's argv from its shape and validated vars and runs it
// with the op's timeout.
func (g *Git) exec(ctx context.Context, op string, vars map[string]string,
	run func(ctx context.Context, argv []string) (stderr []byte, err error)) error {
	shape, ok := shapes[op]
	if !ok {
		return fmt.Errorf("%w: unknown operation %q", ErrNotAllowed, op)
	}
	for name, v := range vars {
		if valid, known := placeholders[name]; !known || !valid(v) {
			return fmt.Errorf("%w: invalid %s %q", ErrNotAllowed, name, v)
		}
	}
	argv := make([]string, len(shape))
	var missing error
	for i, tmpl := range shape {
		argv[i] = placeholderRe.ReplaceAllStringFunc(tmpl, func(ph string) string {
			name := ph[1 : len(ph)-1]
			if name == "git" {
				if g.Bin != "" {
					return g.Bin
				}
				return "git"
			}
			v, ok := vars[name]
			if !ok {
				missing = fmt.Errorf("%w: %s needs %s", ErrNotAllowed, op, name)
			}
			return v
		})
	}
	if missing != nil {
		return missing
	}
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
		switch op {
		case opFetch:
			timeout = 20 * time.Second
		case opPush:
			timeout = 60 * time.Second
		case opListFiles:
			timeout = ListFilesTimeout
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	stderr, err := run(ctx, argv)
	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if ctx.Err() != nil {
			msg = "timed out after " + timeout.String()
		}
		return &Error{Op: op, Err: err, Stderr: msg, TimedOut: ctx.Err() != nil}
	}
	return nil
}

// Error is a git command that failed.
type Error struct {
	Op     string
	Err    error
	Stderr string
	// TimedOut is set when the command was stopped by its timeout (or its
	// caller's context).
	TimedOut bool
}

func (e *Error) Error() string {
	if e.Stderr != "" {
		return fmt.Sprintf("git %s: %.300s", e.Op, e.Stderr)
	}
	return fmt.Sprintf("git %s: %v", e.Op, e.Err)
}

func (e *Error) Unwrap() error { return e.Err }

// TopLevel returns the top level of the work tree dir is in, or
// ErrNotRepo.
func (g *Git) TopLevel(ctx context.Context, dir string) (string, error) {
	out, err := g.run(ctx, opTopLevel, map[string]string{"dir": dir})
	if err != nil {
		if notRepo(err) {
			return "", ErrNotRepo
		}
		return "", err
	}
	top := strings.TrimSpace(string(out))
	if !herdr.ValidDir(top) {
		return "", fmt.Errorf("git rev-parse --show-toplevel: unexpected %q", top)
	}
	return top, nil
}

// notRepo reports whether err is git's "not a git repository".
func notRepo(err error) bool {
	var ge *Error
	return errors.As(err, &ge) && strings.Contains(ge.Stderr, "not a git repository")
}

// Fetch runs `git fetch origin` in dir.
func (g *Git) Fetch(ctx context.Context, dir string) error {
	_, err := g.run(ctx, opFetch, map[string]string{"dir": dir})
	return err
}

// DefaultBranch returns the default branch of origin: origin/HEAD, else
// main or master when origin/<that> exists; "" when unknown.
func (g *Git) DefaultBranch(ctx context.Context, dir string) string {
	if out, err := g.run(ctx, opOriginHead, map[string]string{"dir": dir}); err == nil {
		if b, ok := strings.CutPrefix(strings.TrimSpace(string(out)), "origin/"); ok && herdr.ValidBase("origin/"+b) {
			return b
		}
	}
	for _, b := range []string{"main", "master"} {
		if _, _, err := g.Commit(ctx, dir, "origin/"+b); err == nil {
			return b
		}
	}
	return ""
}

// Commit returns the SHA and commit time of ref (a remote-tracking
// origin/… ref).
func (g *Git) Commit(ctx context.Context, dir, ref string) (string, time.Time, error) {
	out, err := g.run(ctx, opCommit, map[string]string{"dir": dir, "ref": ref})
	if err != nil {
		return "", time.Time{}, err
	}
	sha, ts, ok := strings.Cut(strings.TrimSpace(string(out)), " ")
	sec, perr := strconv.ParseInt(ts, 10, 64)
	if !ok || perr != nil || len(sha) < 40 {
		return "", time.Time{}, fmt.Errorf("git log %s: unexpected %q", ref, out)
	}
	return sha, time.Unix(sec, 0), nil
}

// Status returns `git status --porcelain` lines (empty: clean).
func (g *Git) Status(ctx context.Context, dir string) ([]string, error) {
	out, err := g.run(ctx, opStatus, map[string]string{"dir": dir})
	if err != nil {
		return nil, err
	}
	var lines []string
	for _, l := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	return lines, nil
}

// CurrentBranch returns the checked-out branch ("" on a detached HEAD).
func (g *Git) CurrentBranch(ctx context.Context, dir string) (string, error) {
	out, err := g.run(ctx, opBranch, map[string]string{"dir": dir})
	if err != nil {
		var ge *Error
		var ee *exec.ExitError
		if errors.As(err, &ge) && errors.As(ge.Err, &ee) && ee.ExitCode() == 1 {
			return "", nil // detached
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// Unpushed counts the commits reachable from HEAD that are on no
// remote-tracking branch.
func (g *Git) Unpushed(ctx context.Context, dir string) (int, error) {
	out, err := g.run(ctx, opUnpushed, map[string]string{"dir": dir})
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("git rev-list --count: unexpected %q", out)
	}
	return n, nil
}

// BranchUnpushed counts the commits reachable from branch (one the bridge
// made) that are on no remote-tracking branch.
func (g *Git) BranchUnpushed(ctx context.Context, dir, branch string) (int, error) {
	out, err := g.run(ctx, opBranchAhead, map[string]string{"dir": dir, "branch": branch})
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("git rev-list --count: unexpected %q", out)
	}
	return n, nil
}

// BranchTip returns the commit branch (one the bridge made) points at.
func (g *Git) BranchTip(ctx context.Context, dir, branch string) (string, error) {
	out, err := g.run(ctx, opBranchTip, map[string]string{"dir": dir, "branch": branch})
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(out))
	if len(sha) < 40 {
		return "", fmt.Errorf("git rev-parse %s: unexpected %q", branch, out)
	}
	return sha, nil
}

// Push pushes branch (one the bridge made, h3d/…) of the checkout at dir to
// the same name on origin and sets it as upstream.
func (g *Git) Push(ctx context.Context, dir, branch string) error {
	_, err := g.run(ctx, opPush, map[string]string{"dir": dir, "branch": branch})
	return err
}

// AheadOf counts the commits of HEAD that origin/<base> (base is that
// remote-tracking ref) does not have.
func (g *Git) AheadOf(ctx context.Context, dir, base string) (int, error) {
	out, err := g.run(ctx, opAheadOf, map[string]string{"dir": dir, "ref": base})
	if err != nil {
		return 0, err
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0, fmt.Errorf("git rev-list --count: unexpected %q", out)
	}
	return n, nil
}

// Subjects returns the subject lines of the (at most 20) newest commits of
// HEAD that origin/<base> does not have, newest first.
func (g *Git) Subjects(ctx context.Context, dir, base string) ([]string, error) {
	out, err := g.run(ctx, opSubjects, map[string]string{"dir": dir, "ref": base})
	if err != nil {
		return nil, err
	}
	var subjects []string
	for _, l := range strings.Split(strings.TrimRight(string(out), "\n"), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			subjects = append(subjects, l)
		}
	}
	return subjects, nil
}

// DeleteBranch deletes a branch the bridge made (h3d/…) in the repository
// at dir. The caller has checked its commits are on a remote, or that it
// has none of its own.
func (g *Git) DeleteBranch(ctx context.Context, dir, branch string) error {
	_, err := g.run(ctx, opDeleteBranch, map[string]string{"dir": dir, "branch": branch})
	return err
}

// HeadBranch reads the branch checked out in the work tree at checkout
// from its files (no git process): "" when detached or unreadable.
func HeadBranch(checkout string) string {
	gitDir := filepath.Join(checkout, ".git")
	if b, err := os.ReadFile(gitDir); err == nil { // a linked worktree: "gitdir: <path>"
		p, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "gitdir: ")
		if !ok {
			return ""
		}
		if !filepath.IsAbs(p) {
			p = filepath.Join(checkout, p)
		}
		gitDir = p
	}
	b, err := os.ReadFile(filepath.Join(gitDir, "HEAD"))
	if err != nil {
		return ""
	}
	ref, ok := strings.CutPrefix(strings.TrimSpace(string(b)), "ref: refs/heads/")
	if !ok {
		return ""
	}
	return ref
}

const maxOutput = 1 << 20

func execRunner(ctx context.Context, argv []string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = gitEnv()
	var stdout, stderr capped
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

func execPipe(ctx context.Context, argv []string, w io.Writer) ([]byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = gitEnv()
	cmd.WaitDelay = time.Second
	var stderr capped
	cmd.Stdout, cmd.Stderr = w, &stderr
	err := cmd.Run()
	return stderr.Bytes(), err
}

func gitEnv() []string {
	return append(herdr.CleanEnv(os.Environ()), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0", "LC_ALL=C")
}

type capped struct{ bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := maxOutput - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
