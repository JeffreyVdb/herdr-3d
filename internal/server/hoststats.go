package server

import (
	"context"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #74 server rack: the office's server rack shows the bridge host's CPU,
// memory, pending updates and disk activity. The game sends host.watch while
// the rack is in view and host.unwatch when it is not; the bridge samples
// only between the first watch and the last unwatch (or disconnect), with one
// hoststats.Sampler for the whole hub, and sends host.stats and host.disk to
// the watching connections only (no seq, never replayed). With no watcher,
// nothing is read and checkupdates does not run. docs/protocol.md "Host
// stats".

// hostState is the hub's host stats bookkeeping (hub goroutine only).
type hostState struct {
	sampler  *hoststats.Sampler
	watchers map[*Client]struct{}
	stop     func() // ends the sampler's run (nil: not running)
	gen      uint64 // the run's number: a frame of an earlier run is dropped
	latest   []byte // the last host.stats frame of this run, for a late watcher
}

func (h *Hub) initHostStats() {
	cfg := hoststats.Config{}
	if h.opts.HostStats != nil {
		cfg = *h.opts.HostStats
	}
	if h.opts.HostStatsPoll > 0 {
		cfg.StatsEvery = h.opts.HostStatsPoll
	}
	h.hs.sampler = hoststats.New(cfg)
	h.hs.watchers = map[*Client]struct{}{}
}

// startHostWatch handles host.watch: idempotent per connection. The first
// watcher starts the sampler; one that joins a running sampler gets the
// latest frame at once.
func (h *Hub) startHostWatch(_ context.Context, c *Client, cmd proto.Command) error {
	_, again := h.hs.watchers[c]
	h.hs.watchers[c] = struct{}{}
	if h.hs.stop == nil {
		h.startHostSampler()
	}
	// Not audited: a game watches and unwatches as the player turns, and the
	// command reads nothing but the host's own counters.
	h.reply(c, cmd, nil, nil)
	if !again && h.hs.latest != nil {
		h.deliver(c, h.hs.latest)
	}
	return nil
}

// startHostUnwatch handles host.unwatch: the last one stops the sampler.
func (h *Hub) startHostUnwatch(_ context.Context, c *Client, cmd proto.Command) error {
	h.dropHostWatch(c)
	h.reply(c, cmd, nil, nil)
	return nil
}

// dropHostWatch ends a connection's watch (unwatched, or it went away).
func (h *Hub) dropHostWatch(c *Client) {
	if _, ok := h.hs.watchers[c]; !ok {
		return
	}
	delete(h.hs.watchers, c)
	if len(h.hs.watchers) == 0 {
		h.stopHostSampler()
	}
}

func (h *Hub) startHostSampler() {
	h.hs.gen++
	gen := h.hs.gen
	h.hs.stop = h.hs.sampler.Start(hoststats.Sink{
		Stats: func(ctx context.Context, s hoststats.Stats) {
			frame := mustJSON(hostStatsMsg(s))
			_ = h.do(ctx, func(context.Context) { h.hostFrame(gen, frame, true) })
		},
		Disk: func(ctx context.Context, d []hoststats.DiskRate) {
			frame := mustJSON(hostDiskMsg(d))
			_ = h.do(ctx, func(context.Context) { h.hostFrame(gen, frame, false) })
		},
	})
}

// stopHostSampler ends the run and forgets its frame. It waits for the
// sampler's goroutine, which never waits for the hub: a frame it is handing
// over gives up when its run's context ends.
func (h *Hub) stopHostSampler() {
	if h.hs.stop == nil {
		return
	}
	stop := h.hs.stop
	h.hs.stop, h.hs.latest = nil, nil
	h.hs.gen++
	stop()
}

// hostFrame fans one frame of run gen out to the watchers (hub goroutine).
func (h *Hub) hostFrame(gen uint64, frame []byte, stats bool) {
	if gen != h.hs.gen || h.hs.stop == nil {
		return
	}
	if stats {
		h.hs.latest = frame
	}
	for c := range h.hs.watchers {
		h.deliver(c, frame)
	}
}

func hostStatsMsg(s hoststats.Stats) proto.HostStats {
	m := proto.HostStats{T: proto.THostStats, CPUPct: s.CPUPct, CPUs: s.CPUs, Load1: s.Load1, MemUsedPct: s.MemUsedPct,
		MemUsedBytes: s.MemUsedBytes, MemTotalBytes: s.MemTotalBytes, SampledAt: s.SampledAt.UTC().Format(time.RFC3339)}
	if s.Updates != nil {
		m.Updates = &proto.HostUpdates{Count: s.Updates.Count, CheckedAt: s.Updates.CheckedAt.UTC().Format(time.RFC3339)}
	}
	return m
}

func hostDiskMsg(d []hoststats.DiskRate) proto.HostDisk {
	m := proto.HostDisk{T: proto.THostDisk, Disks: make([]proto.HostDiskRate, 0, len(d))}
	for _, r := range d {
		m.Disks = append(m.Disks, proto.HostDiskRate{Name: r.Name, RIOPS: r.RIOPS, WIOPS: r.WIOPS, RBps: r.RBytes, WBps: r.WBytes})
	}
	return m
}
