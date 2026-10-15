// Package repodisc is #54's repository discovery: a bridge-owned catalog
// of the Git checkouts under folders on the bridge host (scan roots),
// which worker.repos and hire.repos merge with the floors' repositories.
//
// A Service scans in the background: after its roots are set, whenever
// they change, on a timer and when asked. One scan runs at a time; a
// settings change cancels the scan in flight and its result is thrown
// away, so a removed root never comes back. A scan walks the roots'
// grouping folders (walk.go's policy), then asks git (a few at a time,
// each call bounded) about the candidates only. Readers get an immutable
// Catalog at once, whatever is in flight. A root that fails keeps its last
// successful result (stale) without touching the others.
package repodisc

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Defaults of Options.
const (
	// DefaultWorkers is how many git calls a scan makes at once.
	DefaultWorkers = 8
	// DefaultGitTimeout bounds one git call (Options.Git's own).
	DefaultGitTimeout = 2 * time.Second
	// DefaultScanTimeout bounds one scan: past it, the roots it has not
	// finished fail (their last result is kept).
	DefaultScanTimeout = time.Minute
	// progressEvery spaces the progress a scan reports.
	progressEvery = 250 * time.Millisecond
)

// Options configure a Service. Zero values take the defaults.
type Options struct {
	Git         Git
	Workers     int
	ScanTimeout time.Duration
	Log         *slog.Logger
	// Now is the clock of the timestamps (tests).
	Now func() time.Time
}

// Settings are what is scanned and how often.
type Settings struct {
	Roots    []string
	Interval time.Duration
}

// Service is the catalog and its scans.
type Service struct {
	ctx     context.Context
	o       Options
	kick    chan struct{}
	changes chan struct{}
	done    chan struct{}

	mu       sync.Mutex
	gen      uint64 // bumped by a change of the roots
	roots    []string
	interval time.Duration
	want     bool // a scan is asked for
	state    map[string]*rootState
	cat      *Catalog
	rev      uint64
	print    string // the catalog's content, to tell a change
	// The scan in flight.
	scanning bool
	cancel   context.CancelFunc
	progress *proto.RepoDiscoveryProgress
	told     time.Time // when progress was last reported
	// The scans done.
	lastScan, lastSuccess time.Time
	lastDur               time.Duration
	next                  time.Time
}

type rootState struct {
	canonical string
	ok        bool // scanned successfully at least once
	checkouts []Checkout
	at        time.Time
	err       string
	warning   string
}

// New is a service whose scans run under ctx; it does nothing until
// Configure gives it roots. Wait waits for it after ctx ends.
func New(ctx context.Context, o Options) *Service {
	if o.Workers <= 0 {
		o.Workers = DefaultWorkers
	}
	if o.ScanTimeout <= 0 {
		o.ScanTimeout = DefaultScanTimeout
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	s := &Service{ctx: ctx, o: o, kick: make(chan struct{}, 1), changes: make(chan struct{}, 1), done: make(chan struct{}),
		interval: proto.RepoDiscoveryDefaultInterval * time.Minute, state: map[string]*rootState{}}
	go s.run()
	return s
}

// Wait waits for the service to stop (its context ended).
func (s *Service) Wait() { <-s.done }

// Changes signals (coalesced) that View or Catalog changed.
func (s *Service) Changes() <-chan struct{} { return s.changes }

// Catalog is the repositories discovered now.
func (s *Service) Catalog() *Catalog {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cat
}

// Configure sets the roots and the interval (CleanSettings's). It does not
// wait: a change of roots drops the removed roots' repositories now,
// cancels the scan in flight (its result is thrown away) and asks for a
// scan; an interval change only moves the next scan.
func (s *Service) Configure(set Settings) {
	s.mu.Lock()
	defer s.signal()
	defer s.mu.Unlock()
	if set.Interval > 0 {
		s.interval = set.Interval
	}
	if slices.Equal(set.Roots, s.roots) {
		return
	}
	s.gen++
	if s.cancel != nil {
		s.cancel()
	}
	s.roots = slices.Clone(set.Roots)
	keep := map[string]*rootState{}
	for _, r := range s.roots {
		if st, ok := s.state[r]; ok {
			keep[r] = st
		} else {
			keep[r] = &rootState{}
		}
	}
	s.state = keep
	s.want = len(s.roots) > 0
	s.rebuild()
}

// Refresh asks for a scan now (after the one in flight).
func (s *Service) Refresh() {
	s.mu.Lock()
	s.want = len(s.roots) > 0
	s.mu.Unlock()
	s.signal()
}

// signal wakes the loop and tells Changes.
func (s *Service) signal() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
	s.changed()
}

func (s *Service) changed() {
	select {
	case s.changes <- struct{}{}:
	default:
	}
}

type scanDone struct {
	gen        uint64
	out        scanOut
	start, end time.Time
}

// run starts the scans: one at a time, when one is asked for or the
// interval has passed since the last one ended.
func (s *Service) run() {
	defer close(s.done)
	results := make(chan scanDone, 1)
	running := false
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	for {
		s.mu.Lock()
		if !running && len(s.roots) > 0 && !s.want && !s.lastScan.IsZero() && !s.o.Now().Before(s.lastScan.Add(s.interval)) {
			s.want = true
		}
		if !running && s.want && len(s.roots) > 0 {
			s.want = false
			running = true
			s.start(results)
		}
		var wait time.Duration = -1
		s.next = time.Time{}
		if !running && len(s.roots) > 0 && !s.lastScan.IsZero() {
			s.next = s.lastScan.Add(s.interval)
			wait = max(0, s.next.Sub(s.o.Now()))
		}
		s.mu.Unlock()
		timer.Stop()
		if wait >= 0 {
			timer.Reset(wait)
		}
		select {
		case <-s.ctx.Done():
			s.mu.Lock()
			if s.cancel != nil {
				s.cancel()
			}
			s.mu.Unlock()
			if running {
				<-results
			}
			timer.Stop()
			return
		case <-s.kick:
		case <-timer.C:
		case d := <-results:
			running = false
			s.commit(d)
		}
	}
}

// start starts a scan of the roots (s.mu held).
func (s *Service) start(results chan<- scanDone) {
	ctx, cancel := context.WithTimeout(s.ctx, s.o.ScanTimeout)
	s.cancel = cancel
	s.scanning = true
	s.progress = &proto.RepoDiscoveryProgress{Phase: "walking", Total: len(s.roots)}
	gen, roots := s.gen, slices.Clone(s.roots)
	prev := map[string]Checkout{}
	for _, st := range s.state {
		for _, c := range st.checkouts {
			prev[c.Path] = c
		}
	}
	s.changed()
	go func() {
		defer cancel()
		start := s.o.Now()
		out := scanRoots(ctx, s.o.Git, roots, s.o.Workers, prev, func(phase string, done, total int) { s.report(gen, phase, done, total) })
		results <- scanDone{gen: gen, out: out, start: start, end: s.o.Now()}
	}()
}

// report keeps a scan's progress, told at most every progressEvery (and
// at every new phase).
func (s *Service) report(gen uint64, phase string, done, total int) {
	s.mu.Lock()
	if gen != s.gen || !s.scanning {
		s.mu.Unlock()
		return
	}
	newPhase := s.progress == nil || s.progress.Phase != phase
	s.progress = &proto.RepoDiscoveryProgress{Phase: phase, Done: done, Total: total}
	now := s.o.Now()
	tell := newPhase || now.Sub(s.told) >= progressEvery
	if tell {
		s.told = now
	}
	s.mu.Unlock()
	if tell {
		s.changed()
	}
}

// commit keeps a scan's result, unless the roots changed since it started
// (or the service is stopping): each root's own result, or, for a root
// that failed, its error next to its previous result.
func (s *Service) commit(d scanDone) {
	s.mu.Lock()
	defer s.changed()
	defer s.mu.Unlock()
	s.scanning, s.progress, s.cancel = false, nil, nil
	if d.gen != s.gen || s.ctx.Err() != nil {
		return
	}
	failed := 0
	for _, root := range s.roots {
		st, rs := s.state[root], d.out.roots[root]
		st.canonical = rs.canonical
		if rs.err != nil {
			failed++
			st.err = rootError(rs.err)
			s.o.Log.Warn("repository discovery: a root failed", "root", root, "kept", st.ok, "err", rs.err)
			continue
		}
		st.ok, st.checkouts, st.at, st.err, st.warning = true, rs.checkouts, d.end, "", rs.warning
	}
	s.lastScan, s.lastDur = d.end, d.end.Sub(d.start)
	if failed == 0 {
		s.lastSuccess = d.end
	}
	s.rebuild()
}

// rebuild makes the catalog from the roots' results, a new revision when
// its content changed (s.mu held).
func (s *Service) rebuild() {
	var all []Checkout
	for _, r := range s.roots {
		all = append(all, s.state[r].checkouts...)
	}
	cat := NewCatalog(s.rev, all)
	var b strings.Builder
	for _, r := range cat.Repos {
		for _, c := range r.Checkouts {
			fmt.Fprintf(&b, "%s\x00%s\x00%s\x00%s\x00%t\n", r.ID, c.Path, c.Common, c.Origin, c.Main)
		}
	}
	if p := b.String(); p != s.print {
		s.print = p
		s.rev++
		cat.Revision = s.rev
	}
	s.cat = cat
}

// View is the settings and the status, for the snapshot, the acks and
// repo_discovery.update.
func (s *Service) View() proto.RepoDiscovery {
	s.mu.Lock()
	defer s.mu.Unlock()
	ts := func(t time.Time) *int64 {
		if t.IsZero() {
			return nil
		}
		v := t.UnixMilli()
		return &v
	}
	st := proto.RepoDiscoveryStatus{State: proto.RepoDiscoveryIdle, Revision: s.cat.revision(), Repositories: s.cat.Len(), Checkouts: s.cat.Checkouts(),
		LastScanAt: ts(s.lastScan), LastSuccessAt: ts(s.lastSuccess), Roots: []proto.RepoDiscoveryRoot{}}
	switch {
	case len(s.roots) == 0:
		st.State = proto.RepoDiscoveryOff
	case s.scanning:
		st.State = proto.RepoDiscoveryScanning
		if s.progress != nil {
			p := *s.progress
			st.Progress = &p
		}
	default:
		st.NextScanAt = ts(s.next)
	}
	if !s.lastScan.IsZero() {
		ms := s.lastDur.Milliseconds()
		st.LastDurationMS = &ms
	}
	for _, r := range s.roots {
		rs := s.state[r]
		v := proto.RepoDiscoveryRoot{Path: r, State: proto.RepoRootPending, Error: rs.err, Checkouts: len(rs.checkouts), LastSuccessAt: ts(rs.at)}
		if rs.canonical != "" && rs.canonical != r {
			v.Canonical = rs.canonical
		}
		switch {
		case rs.err != "" && rs.ok:
			v.State = proto.RepoRootStale
		case rs.err != "":
			v.State = proto.RepoRootError
		case rs.ok:
			v.State, v.Warning = proto.RepoRootOK, rs.warning
		}
		st.Roots = append(st.Roots, v)
	}
	return proto.RepoDiscovery{Roots: append([]string{}, s.roots...), IntervalMinutes: int(s.interval / time.Minute), Status: st}
}

func (c *Catalog) revision() uint64 {
	if c == nil {
		return 0
	}
	return c.Revision
}

// SettingsError is a setting repo_discovery.set refuses, in words for the
// person who typed it.
type SettingsError struct{ Msg string }

func (e *SettingsError) Error() string { return e.Msg }

// CleanSettings checks roots and an interval in minutes as typed: each root
// absolute, without a line break or NUL, at most RepoDiscoveryMaxRoot
// bytes, and listed once (after cleaning: a trailing slash is the same
// folder); at most RepoDiscoveryMaxRoots; the interval 1 to
// RepoDiscoveryMaxInterval minutes. Whether a root exists is the scan's
// business: a folder that is missing now (an unmounted disk) may be set.
func CleanSettings(roots []string, intervalMinutes int) ([]string, error) {
	if len(roots) > proto.RepoDiscoveryMaxRoots {
		return nil, &SettingsError{fmt.Sprintf("At most %d scan folders can be set; remove one first.", proto.RepoDiscoveryMaxRoots)}
	}
	if intervalMinutes < 1 || intervalMinutes > proto.RepoDiscoveryMaxInterval {
		return nil, &SettingsError{fmt.Sprintf("The refresh interval must be a whole number of minutes from 1 to %d.", proto.RepoDiscoveryMaxInterval)}
	}
	out := make([]string, 0, len(roots))
	for i, r := range roots {
		n := i + 1
		switch {
		case strings.TrimSpace(r) == "":
			return nil, &SettingsError{fmt.Sprintf("Scan folder %d is empty.", n)}
		case strings.ContainsAny(r, "\x00\n\r"):
			return nil, &SettingsError{fmt.Sprintf("Scan folder %d has a line break in it.", n)}
		case len(r) > proto.RepoDiscoveryMaxRoot:
			return nil, &SettingsError{fmt.Sprintf("Scan folder %d is longer than %d characters.", n, proto.RepoDiscoveryMaxRoot)}
		case !filepath.IsAbs(r):
			return nil, &SettingsError{fmt.Sprintf("Scan folder %d must be an absolute path on the bridge host, starting with /: %q is not.", n, r)}
		}
		c := filepath.Clean(r)
		if j := slices.Index(out, c); j >= 0 {
			return nil, &SettingsError{fmt.Sprintf("Scan folder %d is the same as folder %d (%s).", n, j+1, c)}
		}
		out = append(out, c)
	}
	return out, nil
}
