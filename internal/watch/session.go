package watch

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"reflect"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// debounce coalesces bursts of lifecycle events into one re-snapshot.
const debounce = 50 * time.Millisecond

// watcher follows one running session.
type watcher struct {
	cfg   Config
	info  herdr.Session
	fresh bool // the first observation cannot vouch for continuity
	log   *slog.Logger
}

// run follows the session, reconnecting while it still answers pings, and
// returns once it does not (the session stopped) or ctx is done.
func (w *watcher) run(ctx context.Context) {
	backoff := 250 * time.Millisecond
	for first := true; ; first = false {
		start := time.Now()
		err := w.follow(ctx, w.fresh || !first)
		if ctx.Err() != nil {
			return
		}
		pctx, cancel := context.WithTimeout(ctx, w.cfg.ProbeTimeout)
		_, perr := w.cfg.Herdr.Ping(pctx, w.info.SocketPath)
		cancel()
		if perr != nil {
			w.log.Info("session stopped answering", "err", err)
			return
		}
		if time.Since(start) > time.Minute {
			backoff = 250 * time.Millisecond
		}
		w.log.Warn("session stream ended, reconnecting", "err", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}

// follow is one connection's worth of watching: subscribe to lifecycle
// events, then snapshot (so nothing falls between the two), then subscribe
// to every pane's status, and keep the floor current until a stream ends.
// Every lifecycle event, and a safety tick, triggers a re-snapshot; status
// events are folded into the last snapshot directly.
func (w *watcher) follow(ctx context.Context, fresh bool) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	gen := world.NextGen()
	ends := make(chan error, 1)

	sub, err := w.cfg.Herdr.Subscribe(ctx, w.info.SocketPath, herdr.LifecycleSubscriptions)
	if err != nil {
		w.degraded(ctx, gen, fresh, err)
		return err
	}
	life := startPump(ctx, sub, "lifecycle", ends)
	defer life.close()

	snap, err := w.snapshot(ctx)
	if err != nil {
		w.degraded(ctx, gen, fresh, err)
		return err
	}
	var last []world.WorkerObs
	publish := func() bool {
		obs := world.FromSnapshot(snap)
		if last != nil && reflect.DeepEqual(obs, last) {
			return true
		}
		ok := send(ctx, w.cfg.Out, world.FloorObs{
			Session: w.info.Name, Default: w.info.Default, Running: true, Gen: gen, Fresh: fresh, Workers: obs,
			Socket: w.info.SocketPath,
		})
		fresh, last = false, obs
		return ok
	}
	if !publish() {
		return ctx.Err()
	}

	// The status stream covers exactly the snapshot's panes; it is replaced
	// whenever that set changes.
	var status *pumped
	var panes []string
	defer func() {
		if status != nil {
			status.close()
		}
	}()
	resubscribe := func() error {
		ids := world.PaneIDs(snap)
		if slices.Equal(ids, panes) && (status != nil || len(ids) == 0) {
			return nil
		}
		if status != nil {
			status.close()
			status = nil
		}
		panes = ids
		if len(ids) == 0 {
			return nil
		}
		s, err := w.cfg.Herdr.Subscribe(ctx, w.info.SocketPath, herdr.StatusSubscriptions(ids))
		if err != nil {
			return err
		}
		status = startPump(ctx, s, "status", ends)
		// A status change between the snapshot and this ack would be lost:
		// look again now that the stream is live.
		if snap, err = w.snapshot(ctx); err != nil {
			return err
		}
		if !publish() {
			return ctx.Err()
		}
		return nil
	}
	if err := resubscribe(); err != nil {
		return err
	}

	safety := time.NewTicker(w.cfg.Resnapshot)
	defer safety.Stop()
	var pending <-chan time.Time
	for {
		var statusEv <-chan herdr.Event
		if status != nil {
			statusEv = status.events
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-ends:
			return err
		case ev := <-life.events:
			w.log.Debug("herdr event", "event", ev.Event)
			if ev.Event == herdr.EventAgentDetected && !w.agentDetected(ctx, ev) {
				return ctx.Err()
			}
			if pending == nil {
				pending = time.After(debounce)
			}
			continue
		case ev := <-statusEv:
			var sc herdr.StatusChanged
			if err := json.Unmarshal(ev.Data, &sc); err != nil || ev.Event != herdr.EventStatusChanged {
				w.log.Warn("unexpected status stream event", "event", ev.Event, "err", err)
				continue
			}
			if !world.ApplyStatus(snap, sc) {
				// A pane the snapshot does not know yet: look again.
				if pending == nil {
					pending = time.After(debounce)
				}
				continue
			}
			if !publish() {
				return ctx.Err()
			}
			continue
		case <-pending:
		case <-safety.C:
		}
		pending = nil
		if snap, err = w.snapshot(ctx); err != nil {
			return err
		}
		if !publish() {
			return ctx.Err()
		}
		if err := resubscribe(); err != nil {
			return err
		}
	}
}

// agentDetected forwards a pane_agent_detected event to the hub (a wake
// waits for them). It reports false when ctx ended.
func (w *watcher) agentDetected(ctx context.Context, ev herdr.Event) bool {
	var d herdr.AgentDetected
	if err := json.Unmarshal(ev.Data, &d); err != nil || d.PaneID == "" {
		w.log.Warn("bad pane_agent_detected event", "err", err)
		return true
	}
	agent := ""
	if d.Agent != nil {
		agent = *d.Agent
	}
	return send(ctx, w.cfg.Out, world.AgentDetected{
		Session: w.info.Name, WorkspaceID: d.WorkspaceID, PaneID: d.PaneID, Agent: agent, Released: d.Released,
	})
}

func (w *watcher) snapshot(ctx context.Context) (*herdr.Snapshot, error) {
	sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return w.cfg.Herdr.Snapshot(sctx, w.info.SocketPath)
}

// degraded marks the floor running but unreadable, keeping its workers.
func (w *watcher) degraded(ctx context.Context, gen uint64, fresh bool, err error) {
	if ctx.Err() != nil {
		return
	}
	w.log.Warn("session answers ping but cannot be followed", "err", err)
	send(ctx, w.cfg.Out, world.FloorObs{
		Session: w.info.Name, Default: w.info.Default, Running: true, Gen: gen, Fresh: fresh,
		KeepWorkers: true, Err: "herdr: " + err.Error(), Socket: w.info.SocketPath,
	})
}

// pumped is a stream read by its own goroutine into a bounded channel.
// When the watcher falls behind, backpressure goes to herdr's socket.
type pumped struct {
	stream *herdr.Stream
	events chan herdr.Event
	cancel context.CancelFunc
}

// startPump reads s until it ends. An unexpected end is reported on ends
// (once per follow: the first one ends it); close() ends it silently.
func startPump(ctx context.Context, s *herdr.Stream, which string, ends chan<- error) *pumped {
	ctx, cancel := context.WithCancel(ctx)
	p := &pumped{stream: s, events: make(chan herdr.Event, 64), cancel: cancel}
	go func() {
		for {
			ev, err := s.Next()
			if err != nil {
				if ctx.Err() == nil {
					select {
					case ends <- errors.Join(errors.New(which+" stream ended"), err):
					default:
					}
				}
				return
			}
			select {
			case p.events <- ev:
			case <-ctx.Done():
				return
			}
		}
	}()
	return p
}

func (p *pumped) close() {
	p.cancel()
	p.stream.Close()
}
