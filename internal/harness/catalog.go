package harness

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Probe lists a harness's commands and skills in a checkout.
type Probe func(ctx context.Context, dir string) ([]proto.CommandEntry, error)

const (
	// catalogTTL is how long a probed list is fresh, and how long after a
	// failed probe the next one waits.
	catalogTTL = 30 * time.Second
	// catalogMax bounds the cached (harness, checkout) keys, but for keys
	// with a probe in flight.
	catalogMax = 64
)

// Catalog answers worker.commands from a stale-while-revalidate cache per
// (harness, checkout): a fresh list at once; a stale one at once while one
// probe refreshes it in the background; a first request waits for its probe
// (bounded by the probe's 10 s). Concurrent requests share one probe per
// key. A failed probe keeps the previous list; with none, the answer is the
// harness's built-ins with Partial set, and the next probe waits catalogTTL.
type Catalog struct {
	ctx      context.Context // the bridge's: a probe outlives the request that started it
	log      *slog.Logger
	probes   map[string]Probe
	builtins map[string][]proto.CommandEntry
	now      func() time.Time
	ttl      time.Duration
	max      int

	wg      sync.WaitGroup
	mu      sync.Mutex
	entries map[catalogKey]*catalogEntry
	tick    uint64
}

type catalogKey struct{ harness, dir string }

type catalogEntry struct {
	list    []proto.CommandEntry // nil until a probe succeeds
	at      time.Time            // when the last probe ended (zero: none has)
	probing chan struct{}        // closed when the probe in flight ends (nil: none)
	used    uint64               // for least-recently-used eviction
}

// NewCatalog is a catalog of probes by harness, with each harness's
// built-ins for when no probe has succeeded yet. Probes run under ctx: they
// stop when it ends (Wait waits for them).
func NewCatalog(ctx context.Context, log *slog.Logger, probes map[string]Probe, builtins map[string][]proto.CommandEntry) *Catalog {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	return &Catalog{ctx: ctx, log: log, probes: probes, builtins: builtins, now: time.Now, ttl: catalogTTL, max: catalogMax,
		entries: map[catalogKey]*catalogEntry{}}
}

// NewCommandCatalog is the catalog of the installed Claude Code and Codex
// CLIs (bins as for Claude and Codex). Claude has no static built-ins: its
// own come from the probe.
func NewCommandCatalog(ctx context.Context, log *slog.Logger, claudeBin, codexBin string) *Catalog {
	return NewCatalog(ctx, log, map[string]Probe{
		"claude": func(ctx context.Context, dir string) ([]proto.CommandEntry, error) {
			return ClaudeCommands(ctx, claudeBin, dir)
		},
		"codex": func(ctx context.Context, dir string) ([]proto.CommandEntry, error) {
			return CodexCommands(ctx, log, codexBin, dir)
		},
	}, map[string][]proto.CommandEntry{"claude": {}, "codex": CodexBuiltins()})
}

// Commands lists harness's commands and skills in dir. It fails only for a
// harness without a probe, or when ctx ends while it waits for a first probe.
func (c *Catalog) Commands(ctx context.Context, harness, dir string) (*proto.WorkerCommands, error) {
	probe, ok := c.probes[harness]
	if !ok {
		return nil, fmt.Errorf("no command catalog for harness %q", harness)
	}
	key := catalogKey{harness, dir}
	c.mu.Lock()
	e := c.entries[key]
	if e == nil {
		e = &catalogEntry{}
		c.entries[key] = e
	}
	c.tick++
	e.used = c.tick
	if e.probing == nil && (e.at.IsZero() || c.now().Sub(e.at) > c.ttl) {
		c.refresh(key, e, probe)
	}
	c.evict(key)
	if e.at.IsZero() { // never probed: wait for the first probe
		wait := e.probing
		c.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		c.mu.Lock()
	}
	defer c.mu.Unlock()
	return c.answer(harness, e), nil
}

// Wait waits for the probes in flight (they end with the catalog's ctx).
func (c *Catalog) Wait() { c.wg.Wait() }

// answer is e's list, or the built-ins (partial) when no probe succeeded.
func (c *Catalog) answer(harness string, e *catalogEntry) *proto.WorkerCommands {
	if e.list != nil {
		return &proto.WorkerCommands{Commands: slices.Clone(e.list)}
	}
	return &proto.WorkerCommands{Commands: append([]proto.CommandEntry{}, c.builtins[harness]...), Partial: true}
}

// refresh starts e's probe (c.mu held).
func (c *Catalog) refresh(key catalogKey, e *catalogEntry, probe Probe) {
	done := make(chan struct{})
	e.probing = done
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		list, err := probe(c.ctx, key.dir)
		c.mu.Lock()
		defer c.mu.Unlock()
		if err != nil {
			c.log.Warn("command catalog probe failed", "harness", key.harness, "dir", key.dir, "kept", e.list != nil, "err", err)
		} else {
			e.list = append([]proto.CommandEntry{}, list...)
		}
		e.at, e.probing = c.now(), nil
		close(done)
	}()
}

// evict drops the least recently used keys beyond c.max, except keep and
// keys with a probe in flight (c.mu held): dropping those would let the next
// ask start a second probe for its key. The map can so exceed c.max while
// probes run; a later ask trims it.
func (c *Catalog) evict(keep catalogKey) {
	for len(c.entries) > c.max {
		var oldest *catalogKey
		var used uint64
		for k, e := range c.entries {
			if k != keep && e.probing == nil && (oldest == nil || e.used < used) {
				oldest, used = &k, e.used
			}
		}
		if oldest == nil {
			return
		}
		delete(c.entries, *oldest)
	}
}
