// Package fileindex answers worker.files (#137): an index of the files and
// directories of each worker's checkout, ranked against a query by
// internal/fuzzy. A checkout in git is listed by gitops (git ls-files:
// tracked plus untracked-not-ignored), one outside git by rg --files; the
// package never walks the disk, opens a listed path or follows a symlink.
// Indexes are cached per checkout and rebuilt off the caller's goroutine
// when git's index file changes or they grow old.
package fileindex

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Git lists a checkout in git (*gitops.Git). Both return gitops.ErrNotRepo
// outside a git work tree.
type Git interface {
	IndexPath(ctx context.Context, dir string) (string, error)
	ListFiles(ctx context.Context, dir string) (*gitops.Listing, error)
}

// Defaults of Options.
const (
	// DefaultThrottle is the least time between the end of one build of a
	// checkout and the start of the next.
	DefaultThrottle = 5 * time.Second
	// DefaultMaxAge is the age at which an index is rebuilt anyway: new
	// untracked files and ignore rules do not touch git's index file, and
	// an rg listing has none.
	DefaultMaxAge = 30 * time.Second
	// DefaultIdle is how long an unqueried checkout's index is kept.
	DefaultIdle = 10 * time.Minute
	// DefaultMaxCheckouts bounds the cached checkouts (least recently
	// queried dropped), but for ones with a build in flight.
	DefaultMaxCheckouts = 32
	// DefaultMaxEntries caps one index: files plus derived directories.
	DefaultMaxEntries = 500_000
)

// Options configure an Index. Zero values take the defaults.
type Options struct {
	Git Git
	// RG lists a checkout outside git (nil: such a checkout has no files,
	// source "none").
	RG  *RG
	Log *slog.Logger
	// Now is the clock (tests).
	Now                    func() time.Time
	Throttle, MaxAge, Idle time.Duration
	MaxCheckouts           int
	MaxEntries             int
}

// Index is the cache of checkout indexes. A query answers from the
// checkout's current index at once, starting a rebuild in the background
// when it is stale; the first query of a checkout waits for its first build
// (bounded by the listers' timeouts). One build per checkout at a time.
type Index struct {
	ctx context.Context // the bridge's: a build outlives the query that started it
	o   Options

	wg      sync.WaitGroup
	mu      sync.Mutex
	entries map[string]*entry
	tick    uint64
}

type entry struct {
	snap     *snapshot     // nil until a build succeeds
	failed   error         // the last build's error (nil: it succeeded)
	at       time.Time     // when the last build ended (zero: none has)
	stamp    stamp         // git's index file when the snapshot's build started
	git      *gitState     // nil until a build resolved it
	building chan struct{} // closed when the build in flight ends (nil: none)
	used     uint64        // least-recently-used order
	lastUsed time.Time
}

// gitState is what a checkout's first successful look at git found.
type gitState struct {
	indexPath string // "" outside git
}

// stamp is the state of git's index file: rebuilt when it differs.
type stamp struct {
	exists  bool
	modTime time.Time
	size    int64
}

func statIndex(p string) stamp {
	fi, err := os.Lstat(p)
	if err != nil {
		return stamp{}
	}
	return stamp{exists: true, modTime: fi.ModTime(), size: fi.Size()}
}

// New is an index whose builds run under ctx: they stop when it ends (Wait
// waits for them).
func New(ctx context.Context, o Options) *Index {
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	o.Throttle = orDefault(o.Throttle, DefaultThrottle)
	o.MaxAge = orDefault(o.MaxAge, DefaultMaxAge)
	o.Idle = orDefault(o.Idle, DefaultIdle)
	if o.MaxCheckouts <= 0 {
		o.MaxCheckouts = DefaultMaxCheckouts
	}
	if o.MaxEntries <= 0 {
		o.MaxEntries = DefaultMaxEntries
	}
	return &Index{ctx: ctx, o: o, entries: map[string]*entry{}}
}

// Wait waits for the builds in flight.
func (x *Index) Wait() { x.wg.Wait() }

// Files ranks the files and directories of the checkout dir (absolute)
// against query, at most limit of them. It fails only when the checkout has
// no index at all (its builds failed, or ctx ended while the first one ran).
func (x *Index) Files(ctx context.Context, dir, query string, limit int) (*proto.WorkerFiles, error) {
	x.mu.Lock()
	now := x.o.Now()
	e := x.entries[dir]
	if e == nil {
		e = &entry{}
		x.entries[dir] = e
	}
	x.tick++
	e.used, e.lastUsed = x.tick, now
	if e.building == nil && x.stale(e, now) {
		x.rebuild(dir, e)
	}
	x.evict(dir, now)
	if e.snap == nil && e.building != nil { // no index yet: wait for this build
		wait := e.building
		x.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		x.mu.Lock()
	}
	snap, failed := e.snap, e.failed
	x.mu.Unlock()
	if snap == nil {
		return nil, fmt.Errorf("listing %s failed: %w", dir, failed)
	}
	reason := snap.reason
	if failed != nil {
		reason = joinReason(reason, fmt.Sprintf("refreshing the file list failed, it may be stale (%v)", failed))
	}
	res := &proto.WorkerFiles{Files: snap.search(query, limit), Source: snap.source}
	if reason != "" {
		res.Reason = &reason
	}
	return res, nil
}

// stale reports whether e needs a build (x.mu held): never built; or, once
// the throttle has passed since the last build, a failed one, the max age
// reached, or git's index file changed.
func (x *Index) stale(e *entry, now time.Time) bool {
	if e.at.IsZero() {
		return true
	}
	since := now.Sub(e.at)
	switch {
	case since < x.o.Throttle:
		return false
	case e.snap == nil, since >= x.o.MaxAge:
		return true
	case e.git != nil && e.git.indexPath != "":
		return statIndex(e.git.indexPath) != e.stamp
	}
	return false
}

// rebuild starts e's build (x.mu held).
func (x *Index) rebuild(dir string, e *entry) {
	done := make(chan struct{})
	e.building = done
	gs := e.git
	x.wg.Add(1)
	go func() {
		defer x.wg.Done()
		snap, gs, st, err := x.build(dir, gs)
		x.mu.Lock()
		defer x.mu.Unlock()
		if gs != nil {
			e.git = gs
		}
		if err != nil {
			x.o.Log.Warn("file index build failed", "dir", dir, "kept", e.snap != nil, "err", err)
			e.failed = err
		} else {
			e.snap, e.stamp, e.failed = snap, st, nil
		}
		e.at, e.building = x.o.Now(), nil
		close(done)
		x.evict(dir, e.at)
	}()
}

// build lists dir: with git (resolving its index file the first time), or
// outside git with rg. It returns the git state it resolved and the index
// file's stamp from before the listing (a change during it is seen next).
func (x *Index) build(dir string, gs *gitState) (*snapshot, *gitState, stamp, error) {
	ctx := x.ctx
	if gs == nil {
		p, err := x.o.Git.IndexPath(ctx, dir)
		switch {
		case errors.Is(err, gitops.ErrNotRepo):
			gs = &gitState{}
		case err != nil:
			return nil, nil, stamp{}, err
		default:
			gs = &gitState{indexPath: p}
		}
	}
	if gs.indexPath == "" {
		snap, err := x.buildRG(ctx, dir)
		return snap, gs, stamp{}, err
	}
	st := statIndex(gs.indexPath)
	l, err := x.o.Git.ListFiles(ctx, dir)
	if err != nil {
		return nil, gs, stamp{}, err
	}
	return newSnapshot(l.Paths, proto.FilesSourceGit, cutReason(l.Cut), x.o.MaxEntries), gs, st, nil
}

func (x *Index) buildRG(ctx context.Context, dir string) (*snapshot, error) {
	const noRG = "not a git work tree, and rg is not installed to list it"
	if x.o.RG == nil {
		return newSnapshot(nil, proto.FilesSourceNone, noRG, x.o.MaxEntries), nil
	}
	l, err := x.o.RG.List(ctx, dir)
	switch {
	case errors.Is(err, ErrNoRG):
		return newSnapshot(nil, proto.FilesSourceNone, noRG, x.o.MaxEntries), nil
	case err != nil:
		return nil, err
	}
	return newSnapshot(l.Paths, proto.FilesSourceRG, cutReason(l.Cut), x.o.MaxEntries), nil
}

func cutReason(cut string) string {
	if cut == "" {
		return ""
	}
	return "the listing is incomplete: " + cut
}

// evict drops checkouts unqueried for longer than Idle, then the least
// recently queried beyond MaxCheckouts; never keep or one with a build in
// flight (x.mu held). Dropping a building one would let the next query
// start a second build of it; each build trims the map as it ends.
func (x *Index) evict(keep string, now time.Time) {
	for k, e := range x.entries {
		if k != keep && e.building == nil && now.Sub(e.lastUsed) > x.o.Idle {
			delete(x.entries, k)
		}
	}
	for len(x.entries) > x.o.MaxCheckouts {
		var oldest string
		var used uint64
		found := false
		for k, e := range x.entries {
			if k != keep && e.building == nil && (!found || e.used < used) {
				oldest, used, found = k, e.used, true
			}
		}
		if !found {
			return
		}
		delete(x.entries, oldest)
	}
}
