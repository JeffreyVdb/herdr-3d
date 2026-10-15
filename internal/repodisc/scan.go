package repodisc

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// Git is what a scan asks git (*gitops.Git): only for the candidate
// checkouts, read-only and local.
type Git interface {
	Checkout(ctx context.Context, dir string) (gitops.CheckoutInfo, error)
	Origin(ctx context.Context, dir string) (string, error)
}

// rootScan is one root's part of a scan.
type rootScan struct {
	canonical string
	err       error // the root failed: its previous result stays
	checkouts []Checkout
	warning   string
}

// scanOut is a whole scan.
type scanOut struct {
	roots map[string]rootScan // by configured root
	// Counts, for the benchmark.
	candidates, dirs, entries int
}

// inspected is what git said of one candidate.
type inspected struct {
	co  Checkout
	ok  bool  // a checkout whose top level is the candidate
	err error // git could not tell (a timeout, no git): not "not a checkout"
	// noOrigin: the origin lookup failed (not: there is none).
	noOrigin bool
}

// scanRoots walks roots, then asks git about every candidate found (each
// once, at most workers at a time). prev are the checkouts last known by
// path: a candidate git cannot answer for this time keeps its old entry.
// progress is told where the scan is.
func scanRoots(ctx context.Context, git Git, roots []string, workers int, prev map[string]Checkout, progress func(phase string, done, total int)) scanOut {
	out := scanOut{roots: map[string]rootScan{}}
	walked := map[string]walkResult{} // by canonical root: an alias is walked once
	failed := map[string]error{}
	var order []string // candidates, each once
	seen := map[string]bool{}
	for i, root := range roots {
		progress("walking", i, len(roots))
		rs := rootScan{}
		canon, err := filepath.EvalSymlinks(root)
		if err != nil {
			rs.err = err
			out.roots[root] = rs
			continue
		}
		rs.canonical = canon
		if err, ok := failed[canon]; ok {
			rs.err = err
			out.roots[root] = rs
			continue
		}
		w, ok := walked[canon]
		if !ok {
			w, err = walk(ctx, canon)
			if err != nil {
				failed[canon] = err
				rs.err = err
				out.roots[root] = rs
				continue
			}
			walked[canon] = w
			out.dirs += w.dirs
			out.entries += w.entries
			for _, c := range w.candidates {
				if !seen[c] {
					seen[c] = true
					order = append(order, c)
				}
			}
		}
		if w.skipped > 0 {
			rs.warning = fmt.Sprintf("%d %s could not be read (%s)", w.skipped, plural(w.skipped, "folder", "folders"), rootError(w.skipErr))
		}
		out.roots[root] = rs
	}
	out.candidates = len(order)
	progress("checking", 0, len(order))
	got := inspectAll(ctx, git, order, workers, func(done int) { progress("checking", done, len(order)) })
	for _, root := range roots {
		rs := out.roots[root]
		if rs.err != nil {
			continue
		}
		if err := ctx.Err(); err != nil {
			rs.err = err
			out.roots[root] = rs
			continue
		}
		cands := walked[rs.canonical].candidates
		var gitErr error
		answered := 0
		for _, c := range cands {
			in := got[c]
			switch {
			case in.ok:
				if p, ok := prev[c]; ok && in.noOrigin && p.Common == in.co.Common {
					in.co = newCheckout(c, in.co.Common, in.co.Main, p.Origin) // keep its identity through a slow lookup
				}
				rs.checkouts = append(rs.checkouts, in.co)
				answered++
			case in.err == nil: // not a checkout of its own
				answered++
			default:
				gitErr = in.err
				if p, ok := prev[c]; ok {
					rs.checkouts = append(rs.checkouts, p)
				}
			}
		}
		if answered == 0 && gitErr != nil { // git answered for none of them
			rs.err = fmt.Errorf("git: %w", gitErr)
			rs.checkouts = nil
		}
		out.roots[root] = rs
	}
	return out
}

// inspectAll asks git about each candidate, at most workers at a time.
func inspectAll(ctx context.Context, git Git, cands []string, workers int, done func(int)) map[string]inspected {
	out := make(map[string]inspected, len(cands))
	var mu sync.Mutex
	jobs := make(chan string)
	var wg sync.WaitGroup
	n := 0
	for range max(1, min(workers, len(cands))) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range jobs {
				in := inspect(ctx, git, c)
				mu.Lock()
				out[c] = in
				n++
				d := n
				mu.Unlock()
				done(d)
			}
		}()
	}
feed:
	for _, c := range cands {
		select {
		case jobs <- c:
		case <-ctx.Done():
			break feed
		}
	}
	close(jobs)
	wg.Wait()
	for _, c := range cands {
		if _, ok := out[c]; !ok {
			out[c] = inspected{err: ctx.Err()}
		}
	}
	return out
}

// inspect asks git whether dir is a checkout of its own (its top level),
// where its common directory is, and its origin (optional: a failed
// lookup is no origin).
func inspect(ctx context.Context, git Git, dir string) inspected {
	if !herdr.ValidDir(dir) { // a line break in a folder name: git's output could not be read back
		return inspected{}
	}
	info, err := git.Checkout(ctx, dir)
	switch {
	case errors.Is(err, gitops.ErrNotRepo):
		return inspected{}
	case err != nil:
		return inspected{err: err}
	}
	if info.TopLevel != dir {
		if top, err := filepath.EvalSymlinks(info.TopLevel); err != nil || top != dir {
			return inspected{} // the marker is not a checkout's: git found an enclosing one
		}
	}
	canon := func(p string) string {
		if c, err := filepath.EvalSymlinks(p); err == nil {
			return c
		}
		return p
	}
	// A main checkout's Git directory is the common one, wherever it is (a
	// .git file points at it with --separate-git-dir); a linked worktree's
	// is under it.
	common := canon(info.CommonDir)
	main := canon(info.GitDir) == common
	origin, err := git.Origin(ctx, dir)
	return inspected{co: newCheckout(dir, common, main, origin), ok: true, noOrigin: err != nil}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}
