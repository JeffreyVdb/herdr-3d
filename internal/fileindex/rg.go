package fileindex

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// Defaults of RG.
const (
	DefaultRGTimeout = 20 * time.Second
	DefaultRGOutput  = 20 << 20
	defaultRGGrace   = 2 * time.Second
	maxRGStderr      = 64 << 10
)

// ErrNoRG is RG.List without an rg to run.
var ErrNoRG = errors.New("rg is not installed")

// RG lists the files of a directory outside git with ripgrep: what rg would
// search (.gitignore, .ignore and .rgignore rules honored, hidden files
// skipped, symlinks not followed), never their contents. Argv only, no user
// config (--no-config), the clean environment of a herdr launch.
type RG struct {
	// Bin is the rg executable (default "rg", looked up on PATH).
	Bin string
	// Timeout bounds one listing (default DefaultRGTimeout): rg then gets
	// SIGTERM, and SIGKILL Grace later (default 2 s).
	Timeout, Grace time.Duration
	// MaxOutput caps the listing's output (default DefaultRGOutput).
	MaxOutput int
}

// List lists dir's files relative to it. A timed-out or capped listing, or
// one rg reported errors for (an unreadable directory), returns what was
// complete with Cut set. Without an rg it returns ErrNoRG.
func (r *RG) List(ctx context.Context, dir string) (*gitops.Listing, error) {
	bin := r.Bin
	if bin == "" {
		bin = "rg"
	}
	path, err := exec.LookPath(bin)
	if err != nil {
		return nil, fmt.Errorf("%w (%v)", ErrNoRG, err)
	}
	timeout := orDefault(r.Timeout, DefaultRGTimeout)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--no-config", "--files", "--null", "--no-require-git")
	cmd.Dir = dir
	cmd.Env = herdr.CleanEnv(os.Environ())
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = orDefault(r.Grace, defaultRGGrace)
	stdout := &capBuffer{limit: r.MaxOutput}
	if stdout.limit <= 0 {
		stdout.limit = DefaultRGOutput
	}
	stderr := &capBuffer{limit: maxRGStderr}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	err = cmd.Run()
	var cut string
	var ee *exec.ExitError
	switch {
	case ctx.Err() != nil:
		cut = "rg timed out after " + timeout.String()
	case err == nil:
	case errors.As(err, &ee) && ee.ExitCode() == 1: // no files
	case errors.As(err, &ee) && ee.ExitCode() == 2 && stdout.buf.Len() > 0:
		line, _, _ := strings.Cut(strings.TrimSpace(stderr.buf.String()), "\n")
		cut = fmt.Sprintf("rg reported errors (%.200s)", line)
	default:
		return nil, fmt.Errorf("rg --files: %w: %.300s", err, strings.TrimSpace(stderr.buf.String()))
	}
	if stdout.over {
		cut = fmt.Sprintf("rg's listing passed %d MiB", stdout.limit>>20)
	}
	return &gitops.Listing{Paths: splitNUL(stdout.buf.Bytes()), Cut: cut}, nil
}

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

// splitNUL splits NUL-terminated records, dropping an unterminated last
// one (cut off) and empty ones.
func splitNUL(b []byte) []string {
	i := bytes.LastIndexByte(b, 0)
	if i < 0 {
		return []string{}
	}
	var paths []string
	for rec := range bytes.SplitSeq(b[:i], []byte{0}) {
		if len(rec) > 0 {
			paths = append(paths, string(rec))
		}
	}
	return paths
}

// capBuffer keeps the first limit bytes and drains the rest (the child
// never blocks on a full pipe); over says some were dropped.
type capBuffer struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (c *capBuffer) Write(p []byte) (int, error) {
	room := c.limit - c.buf.Len()
	if room < len(p) {
		c.over = true
	}
	if room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
