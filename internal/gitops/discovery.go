package gitops

// #54 repository discovery (internal/repodisc): what a candidate checkout
// found on disk is, read-only and local (no network): its top level, Git
// directory and Git common directory (a linked worktree shares its main
// checkout's), and its origin's URL.

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// CheckoutInfo is where git says a checkout is.
type CheckoutInfo struct {
	// TopLevel is the checkout's top level (absolute, as git resolves it).
	TopLevel string
	// GitDir is its own Git directory (absolute): the common directory for
	// a main checkout (wherever it is: <top>/.git, or elsewhere with
	// --separate-git-dir), one under it for a linked worktree.
	GitDir string
	// CommonDir is its Git common directory (absolute): the same for every
	// worktree of one repository.
	CommonDir string
}

// Checkout returns dir's top level, Git directory and Git common
// directory, or ErrNotRepo outside a git work tree.
func (g *Git) Checkout(ctx context.Context, dir string) (CheckoutInfo, error) {
	out, err := g.run(ctx, opCheckout, map[string]string{"dir": dir})
	if err != nil {
		if notRepo(err) {
			return CheckoutInfo{}, ErrNotRepo
		}
		return CheckoutInfo{}, err
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) != 3 {
		return CheckoutInfo{}, fmt.Errorf("git rev-parse --show-toplevel --git-dir --git-common-dir: unexpected %q", out)
	}
	top, gitDir, common := lines[0], lines[1], lines[2]
	if !filepath.IsAbs(gitDir) { // an older git ignores --path-format for them
		gitDir = filepath.Join(top, gitDir)
	}
	if !filepath.IsAbs(common) {
		common = filepath.Join(top, common)
	}
	if !filepath.IsAbs(top) || strings.ContainsRune(top+gitDir+common, 0) {
		return CheckoutInfo{}, fmt.Errorf("git rev-parse --show-toplevel --git-dir --git-common-dir: unexpected %q", out)
	}
	return CheckoutInfo{TopLevel: filepath.Clean(top), GitDir: filepath.Clean(gitDir), CommonDir: filepath.Clean(common)}, nil
}

// Origin returns the URL of dir's origin remote ("" when it has none).
func (g *Git) Origin(ctx context.Context, dir string) (string, error) {
	out, err := g.run(ctx, opOriginURL, map[string]string{"dir": dir})
	if err != nil {
		var ge *Error
		if errors.As(err, &ge) && !ge.TimedOut && strings.Contains(ge.Stderr, "No such remote") {
			return "", nil
		}
		if notRepo(err) {
			return "", ErrNotRepo
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
