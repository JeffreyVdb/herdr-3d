// Package watch keeps the hub's view of herdr current. A discovery loop
// lists sessions every Poll and probes each socket; running sessions get a
// watcher (its own goroutine tree: lifecycle stream, status stream,
// snapshots), stopped ones are read from session.json. A broken or hung
// session only ever stalls its own watcher.
package watch

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// Herdr is the read-only herdr surface the watchers use (*herdr.Client).
type Herdr interface {
	ListSessions(ctx context.Context) ([]herdr.Session, error)
	Ping(ctx context.Context, socket string) (*herdr.Pong, error)
	Snapshot(ctx context.Context, socket string) (*herdr.Snapshot, error)
	Subscribe(ctx context.Context, socket string, subs []herdr.Subscription) (*herdr.Stream, error)
}

// Config configures Run.
type Config struct {
	Herdr Herdr
	Out   chan<- world.Update
	// Only, if set, limits which sessions are watched.
	Only *regexp.Regexp
	// Poll is the discovery interval (default 2 s).
	Poll time.Duration
	// Resnapshot is the safety re-snapshot interval (default 30 s).
	Resnapshot time.Duration
	// ProbeTimeout bounds one liveness ping (default 500 ms).
	ProbeTimeout time.Duration
	Log          *slog.Logger
}

func (c *Config) defaults() {
	if c.Poll <= 0 {
		c.Poll = 2 * time.Second
	}
	if c.Resnapshot <= 0 {
		c.Resnapshot = 30 * time.Second
	}
	if c.ProbeTimeout <= 0 {
		c.ProbeTimeout = 500 * time.Millisecond
	}
	if c.Log == nil {
		c.Log = slog.Default()
	}
}

type session struct {
	info herdr.Session
	// watcher, while one runs.
	cancel context.CancelFunc
	done   chan struct{}
	// published is true once the hub has any observation of this session.
	published bool
	// asleepSig identifies the session.json last published as asleep ("" if
	// the last observation was not an asleep one).
	asleepSig string
	// gap is set when a watcher ended without the stop being observed, so
	// the next observation cannot vouch for continuity.
	gap bool
}

// Run discovers sessions until ctx is done, then stops every watcher.
func Run(ctx context.Context, cfg Config) error {
	cfg.defaults()
	d := &discovery{cfg: cfg, sessions: map[string]*session{}, kick: make(chan struct{}, 1)}
	defer d.stopAll()
	t := time.NewTicker(cfg.Poll)
	defer t.Stop()
	for {
		d.tick(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		case <-d.kick:
		}
	}
}

type discovery struct {
	cfg      Config
	sessions map[string]*session
	kick     chan struct{} // a watcher ended: re-evaluate now
}

func (d *discovery) tick(ctx context.Context) {
	// Reap watchers that ended on their own (their session went away).
	for _, s := range d.sessions {
		if s.done != nil {
			select {
			case <-s.done:
				s.cancel()
				s.cancel, s.done, s.gap = nil, nil, true
			default:
			}
		}
	}
	list, err := d.cfg.Herdr.ListSessions(ctx)
	if err != nil {
		if ctx.Err() == nil {
			d.cfg.Log.Warn("listing herdr sessions failed", "err", err)
		}
		return
	}
	var listed []herdr.Session
	for _, s := range list {
		if d.cfg.Only == nil || d.cfg.Only.MatchString(s.Name) {
			listed = append(listed, s)
		}
	}
	alive := d.probe(ctx, listed)
	seen := map[string]bool{}
	for i, info := range listed {
		seen[info.Name] = true
		s := d.sessions[info.Name]
		if s == nil {
			s = &session{}
			d.sessions[info.Name] = s
			d.cfg.Log.Info("session discovered", "session", info.Name)
		}
		s.info = info
		if alive[i] {
			if s.done == nil {
				d.startWatcher(ctx, s)
			}
			continue
		}
		if s.done != nil {
			d.stopWatcher(s)
			s.gap = false // we saw it stop
		}
		d.publishAsleep(ctx, s)
	}
	for name, s := range d.sessions {
		if seen[name] {
			continue
		}
		d.stopWatcher(s)
		delete(d.sessions, name)
		if s.published {
			d.cfg.Log.Info("session gone", "session", name)
			send(ctx, d.cfg.Out, world.FloorGone{Session: name, Gen: world.NextGen()})
		}
	}
}

// probe pings every session concurrently; a hung socket costs at most
// ProbeTimeout.
func (d *discovery) probe(ctx context.Context, list []herdr.Session) []bool {
	alive := make([]bool, len(list))
	var wg sync.WaitGroup
	for i, s := range list {
		wg.Add(1)
		go func() {
			defer wg.Done()
			pctx, cancel := context.WithTimeout(ctx, d.cfg.ProbeTimeout)
			defer cancel()
			_, err := d.cfg.Herdr.Ping(pctx, s.SocketPath)
			alive[i] = err == nil
		}()
	}
	wg.Wait()
	return alive
}

func (d *discovery) startWatcher(ctx context.Context, s *session) {
	wctx, cancel := context.WithCancel(ctx)
	w := &watcher{cfg: d.cfg, info: s.info, fresh: s.gap || !s.published, log: d.cfg.Log.With("session", s.info.Name)}
	s.cancel, s.done = cancel, make(chan struct{})
	s.published, s.asleepSig, s.gap = true, "", false
	done := s.done
	go func() {
		defer close(done)
		w.run(wctx)
		select {
		case d.kick <- struct{}{}:
		default:
		}
	}()
}

func (d *discovery) stopWatcher(s *session) {
	if s.done == nil {
		return
	}
	s.cancel()
	<-s.done
	s.cancel, s.done = nil, nil
}

func (d *discovery) stopAll() {
	for _, s := range d.sessions {
		d.stopWatcher(s)
	}
}

// publishAsleep sends the stopped session's floor from its session.json
// when that differs from what was last published.
func (d *discovery) publishAsleep(ctx context.Context, s *session) {
	path := filepath.Join(s.info.SessionDir, "session.json")
	sig := fileSig(path)
	if sig == s.asleepSig {
		return
	}
	obs := world.FloorObs{
		Session: s.info.Name,
		Default: s.info.Default,
		Gen:     world.NextGen(),
		// Going to sleep from a watched run is continuous (the file is the
		// state herdr saved on the way down); session.json changing while
		// we only ever saw the session asleep means it ran unseen.
		Fresh: !s.published || s.asleepSig != "",
	}
	sf, err := herdr.ReadSessionFile(path)
	var unsupported *herdr.UnsupportedVersionError
	switch {
	case err == nil:
		obs.Workers = world.FromSessionFile(sf)
	case errors.Is(err, fs.ErrNotExist):
		// A session that never saved state has no workers.
	case errors.As(err, &unsupported):
		obs.Err = err.Error()
		d.cfg.Log.Warn("cannot read stopped session", "session", s.info.Name, "err", err)
	default:
		obs.Err = "session.json: " + err.Error()
		d.cfg.Log.Warn("cannot read stopped session", "session", s.info.Name, "err", err)
	}
	if send(ctx, d.cfg.Out, obs) {
		s.published, s.asleepSig, s.gap = true, sig, false
	}
}

func fileSig(path string) string {
	fi, err := os.Stat(path)
	if err != nil {
		return "missing"
	}
	return fmt.Sprintf("%d:%d", fi.ModTime().UnixNano(), fi.Size())
}

func send(ctx context.Context, out chan<- world.Update, u world.Update) bool {
	select {
	case out <- u:
		return true
	case <-ctx.Done():
		return false
	}
}
