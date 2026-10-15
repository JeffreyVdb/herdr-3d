package repodisc

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// The traversal policy (docs/research/repository-scan-bench): a folder
// with a .git marker (a folder, a file or a link: a linked worktree or a
// submodule has a file) is a candidate checkout and the walk stops there,
// never listing a checkout's contents (so it never finds a repository
// nested in one: add that folder as a root of its own). Any other folder
// is a grouping folder: its subfolders are walked, at any depth and
// whatever their names. Symlinked subfolders are not followed; a root
// itself is resolved (canonical) before the walk. Bare repositories (no
// .git) are not working checkouts and are not found.

// walkResult is what one root's walk found.
type walkResult struct {
	// candidates are the folders with a .git marker, in name order.
	candidates []string
	// dirs and entries are the grouping folders listed and their entries.
	dirs, entries int
	// skipped counts the grouping folders below the root that could not
	// be listed; skipErr is the first such failure.
	skipped int
	skipErr error
}

// isMarker reports whether dir has a .git marker.
func isMarker(dir string) bool {
	st, err := os.Lstat(filepath.Join(dir, ".git"))
	if err != nil {
		return false
	}
	m := st.Mode()
	return m.IsDir() || m.IsRegular() || m&fs.ModeSymlink != 0
}

// walk lists the candidate checkouts under root (canonical). It fails when
// the root itself cannot be listed or ctx ends first; a subfolder that
// cannot be listed is skipped and counted.
func walk(ctx context.Context, root string) (walkResult, error) {
	var r walkResult
	st, err := os.Stat(root)
	if err != nil {
		return r, err
	}
	if !st.IsDir() {
		return r, errNotDir
	}
	stack := []string{root}
	for len(stack) > 0 {
		if err := ctx.Err(); err != nil {
			return r, err
		}
		dir := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if isMarker(dir) {
			r.candidates = append(r.candidates, dir)
			continue
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			if dir == root {
				return r, err
			}
			r.skipped++
			if r.skipErr == nil {
				r.skipErr = err
			}
			if len(entries) == 0 {
				continue
			}
		}
		r.dirs++
		r.entries += len(entries)
		// Pushed in reverse: listed in name order.
		for i := len(entries) - 1; i >= 0; i-- {
			if e := entries[i]; e.IsDir() { // a symlink is not a dir here: not followed
				stack = append(stack, filepath.Join(dir, e.Name()))
			}
		}
	}
	return r, nil
}

var errNotDir = errors.New("not a folder")

// rootError is a root's failure in plain words.
func rootError(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "the scan took too long; the last result is kept"
	case errors.Is(err, fs.ErrNotExist):
		return "the folder does not exist on the bridge host"
	case errors.Is(err, fs.ErrPermission):
		return "the bridge may not read this folder (permission denied)"
	case errors.Is(err, errNotDir):
		return "this is a file, not a folder"
	}
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return fmt.Sprintf("%s: %v", pe.Op, pe.Err)
	}
	return err.Error()
}

// CheckoutRoot is the checkout dir is in, canonical: the nearest folder,
// from dir up, with a .git marker (the boundary a scan stops at); "" when
// dir does not resolve or no folder above it has one. It runs no git: a
// floor's folder, perhaps a subfolder or a symlink, matched to the
// discovered checkouts.
func CheckoutRoot(dir string) string {
	p, err := filepath.EvalSymlinks(dir)
	if err != nil || !filepath.IsAbs(p) {
		return ""
	}
	for {
		if isMarker(p) {
			return p
		}
		up := filepath.Dir(p)
		if up == p {
			return ""
		}
		p = up
	}
}
