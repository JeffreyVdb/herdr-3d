package gitops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// Limits of ListFiles (#137 worker.files).
const (
	// ListFilesTimeout bounds one listing.
	ListFilesTimeout = 20 * time.Second
	// MaxListing caps the listing's output: far above maxOutput, for a
	// repository of a few hundred thousand files.
	MaxListing = 32 << 20
)

// Listing is the files of a checkout as git lists them.
type Listing struct {
	// Paths are relative to the checkout, unquoted, each once, in git's
	// order (tracked, then untracked). They are not validated.
	Paths []string
	// Cut says why Paths is incomplete ("" when complete): the output
	// passed MaxListing, or the listing timed out. Paths then holds the
	// complete records before that.
	Cut string
}

// IndexPath returns the absolute path of the index file of the work tree
// dir is in (a linked worktree's own, under the main repository's
// .git/worktrees/), or ErrNotRepo.
func (g *Git) IndexPath(ctx context.Context, dir string) (string, error) {
	out, err := g.run(ctx, opIndexPath, map[string]string{"dir": dir})
	if err != nil {
		if notRepo(err) {
			return "", ErrNotRepo
		}
		return "", err
	}
	p := strings.TrimSpace(string(out))
	if !filepath.IsAbs(p) || strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("git rev-parse --git-path index: unexpected %q", p)
	}
	return p, nil
}

// ListFiles lists the tracked and the untracked-but-not-ignored files
// under dir (git's standard exclusions), relative to dir, or ErrNotRepo.
// Only read-only git runs, for at most ListFilesTimeout and MaxListing
// bytes; a timed-out or capped listing returns what was complete, with Cut.
func (g *Git) ListFiles(ctx context.Context, dir string) (*Listing, error) {
	out := &cappedBuffer{limit: MaxListing}
	err := g.pipe(ctx, opListFiles, map[string]string{"dir": dir}, out)
	var cut string
	if err != nil {
		var ge *Error
		switch {
		case notRepo(err):
			return nil, ErrNotRepo
		case errors.As(err, &ge) && ge.TimedOut:
			cut = ge.Stderr
		default:
			return nil, err
		}
	}
	if out.over {
		cut = fmt.Sprintf("the listing passed %d MiB", MaxListing>>20)
	}
	return &Listing{Paths: splitRecords(out.buf.Bytes()), Cut: cut}, nil
}

// splitRecords splits NUL-terminated records, dropping an unterminated last
// one (cut off), empty ones and repeats.
func splitRecords(b []byte) []string {
	if i := bytes.LastIndexByte(b, 0); i >= 0 {
		b = b[:i]
	} else {
		return []string{}
	}
	seen := map[string]struct{}{}
	paths := []string{}
	for rec := range bytes.SplitSeq(b, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		p := string(rec)
		if _, dup := seen[p]; dup {
			continue
		}
		seen[p] = struct{}{}
		paths = append(paths, p)
	}
	return paths
}

// cappedBuffer keeps the first limit bytes written to it and drains the
// rest, so the writer never blocks; over says some were dropped.
// The buffer is not embedded: its WriteString would bypass the cap.
type cappedBuffer struct {
	buf   bytes.Buffer
	limit int
	over  bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	room := c.limit - c.buf.Len()
	if room < len(p) {
		c.over = true
	}
	if room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
