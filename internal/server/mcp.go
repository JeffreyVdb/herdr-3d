package server

// #196 MCP & skills (docs/protocol.md "MCP and skills"): mcp.inventory
// answers the configured MCP servers and skills of Claude Code and Codex
// for a floor's checkout and a Codex profile, from Options.MCP's cache;
// mcp.check runs one harness's connection check there. The context is
// resolved on the hub goroutine, the reads run off it.
//
// mcp.inventory is not audited: the game polls it while the wall screen is
// in view, and it reads configuration only. mcp.check is: it starts the
// configured servers. Neither needs the floor awake: they change nothing on
// it. While mcp.inventory is asked, the attached shared-server Codex
// workers of the floor in that checkout and profile are also asked for
// their own servers' status, at most once per mcpObserveEvery each; with
// nobody asking, nothing is read.

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/mcpinv"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// MCPInventory answers mcp.inventory and mcp.check per cache key
// (*mcpinv.Service).
type MCPInventory interface {
	Inventory(ctx context.Context, key mcpinv.Key) proto.MCPProvider
	Check(ctx context.Context, key mcpinv.Key) proto.MCPProvider
}

// mcpStatusReader is a Codex join that can read its thread's MCP status
// (*codexapp.Watcher).
type mcpStatusReader interface {
	MCPStatus(ctx context.Context) ([]codexapp.MCPServerStatus, error)
}

// mcpObserveEvery is the least time between two reads of one worker's MCP
// status; mcpObserveTimeout bounds one (all its pages).
const (
	mcpObserveEvery   = 30 * time.Second
	mcpObserveTimeout = 10 * time.Second
)

// mcpState is the hub's worker observations (hub goroutine only).
type mcpState struct {
	obs map[string]*mcpObs // by worker id
}

// mcpObs is a worker's last MCP status read.
type mcpObs struct {
	thread string            // the thread it was read on
	asked  time.Time         // when the last read began (one in flight or abandoned too)
	at     time.Time         // when rows were read
	rows   []mcpinv.Observed // nil: none yet, or the last read failed
}

// mcpScope is one request's context, resolved on the hub goroutine.
type mcpScope struct {
	snap          proto.MCPSnapshot // context, checkouts, expected
	claude, codex mcpinv.Key
	observe       []mcpWorker // workers to read now
	cached        []mcpinv.WorkerObservation
}

// mcpWorker is a Codex worker whose MCP status a request reads.
type mcpWorker struct {
	id, name, thread string
	asked            time.Time
	r                mcpStatusReader
}

// mcpScopeOf resolves a request's context: the floor (it must be known),
// the checkout (absent: the floor's default; null: user scope; else an
// existing absolute directory) and the Codex profile (absent or null: the
// default; an unknown key is not found).
//
// With observe, the attached shared-server Codex workers of the floor in
// that checkout and profile whose last read is older than mcpObserveEvery
// are marked as being read and returned in observe; the newer reads are in
// cached.
func (h *Hub) mcpScopeOf(floor string, cwdArg, profileArg proto.Optional[string], observe bool) (*mcpScope, error) {
	f, err := h.floorFor(floor)
	if err != nil {
		return nil, err
	}
	settings := h.settings[floor]
	var candidates []string // the floor's checkouts, its default first
	if settings.DefaultCwd != "" {
		candidates = append(candidates, settings.DefaultCwd)
	}
	if f.suggested != nil && f.suggested.DefaultCwd != "" {
		candidates = append(candidates, f.suggested.DefaultCwd)
	}
	for _, id := range f.order {
		if w := h.workers[id]; w != nil {
			if dir := checkoutOf(w); filepath.IsAbs(dir) && herdr.ValidDir(filepath.Clean(dir)) {
				candidates = append(candidates, filepath.Clean(dir))
			}
		}
	}
	def := ""
	for _, dir := range candidates {
		if h.opts.StatDir(dir) == nil {
			def = dir
			break
		}
	}
	cwd := def
	if cwdArg.Set {
		cwd = ""
		if v := cwdArg.Value; v != nil {
			if !filepath.IsAbs(*v) || !herdr.ValidDir(filepath.Clean(*v)) {
				return nil, bad("cwd must be an absolute path or null, got %q", *v)
			}
			cwd = filepath.Clean(*v)
			if err := h.opts.StatDir(cwd); err != nil {
				return nil, bad("cwd %q: %v", cwd, err)
			}
		}
	}

	s := &mcpScope{}
	s.snap.Context = proto.MCPContext{Floor: floor, ClaudeConfig: mcpinv.Display(h.opts.HomeDir, h.opts.MCPClaudeDir)}
	if cwd != "" {
		s.snap.Context.Cwd, s.snap.Context.CwdDisplay = &cwd, mcpinv.Display(h.opts.HomeDir, cwd)
	}
	codexHome := h.opts.MCPCodexHome
	if key := profileArg.Value; key != nil && *key != "" {
		a, ok := h.codexAccount(*key)
		switch {
		case !ok:
			return nil, fmt.Errorf("%w: no Codex profile %q", store.ErrNotFound, *key)
		case !a.Exists && !a.Default:
			return nil, fmt.Errorf("%w: the folder of the Codex profile %q no longer exists", store.ErrNotFound, a.Name)
		}
		codexHome, s.snap.Context.CodexProfile, s.snap.Context.CodexProfileName = a.Home, a.Key, a.Name
	} else if i := slices.IndexFunc(h.cp.list, func(a codexaccount.Account) bool { return a.Default }); i >= 0 {
		a := h.cp.list[i]
		codexHome, s.snap.Context.CodexProfile, s.snap.Context.CodexProfileName = a.Home, a.Key, a.Name
	}
	defaultProfile := s.snap.Context.CodexProfile == "" || slices.ContainsFunc(h.cp.list, func(a codexaccount.Account) bool {
		return a.Default && a.Key == s.snap.Context.CodexProfile
	})
	s.claude = mcpinv.Key{Harness: mcpinv.Claude, Cwd: cwd, Home: h.opts.MCPClaudeDir}
	s.codex = mcpinv.Key{Harness: mcpinv.Codex, Cwd: cwd, Home: codexHome}

	s.snap.Checkouts = []proto.MCPCheckout{}
	seen := map[string]bool{}
	for _, dir := range candidates {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		if dir != def && h.opts.StatDir(dir) != nil { // gone: not a choice
			continue
		}
		label := filepath.Base(dir)
		if dir == def {
			label += " (default)"
		}
		s.snap.Checkouts = append(s.snap.Checkouts, proto.MCPCheckout{Path: dir, Display: mcpinv.Display(h.opts.HomeDir, dir), Label: label})
	}
	s.snap.Expected = append([]string{}, settings.ExpectedMCP...)

	// The attached shared-server Codex workers of the floor in this
	// checkout and profile: their own servers' status.
	now := h.opts.Now()
	for id := range h.mcp.obs {
		if h.cx.watches[id] == nil {
			delete(h.mcp.obs, id)
		}
	}
	if cwd == "" {
		return s, nil
	}
	for _, id := range f.order {
		w, cw := h.workers[id], h.cx.watches[id]
		if w == nil || cw == nil || !cw.attached || filepath.Clean(checkoutOf(w)) != cwd {
			continue
		}
		home, other := h.codexHomeOf(id)
		if other == defaultProfile || other && home != codexHome {
			continue
		}
		r, ok := cw.w.(mcpStatusReader)
		if !ok {
			continue
		}
		o := h.mcp.obs[id]
		known := o != nil && o.thread == cw.thread
		if known && o.rows != nil {
			s.cached = append(s.cached, mcpinv.WorkerObservation{Worker: proto.MCPWorker{ID: id, Name: w.Name}, At: o.at, Rows: o.rows})
		}
		if !observe || known && now.Sub(o.asked) < mcpObserveEvery {
			continue
		}
		next := &mcpObs{thread: cw.thread, asked: now}
		if known {
			next.at, next.rows = o.at, o.rows
		}
		h.mcp.obs[id] = next
		s.observe = append(s.observe, mcpWorker{id: id, name: w.Name, thread: cw.thread, asked: now, r: r})
	}
	return s, nil
}

// startMCPInventory answers mcp.inventory, unaudited (a polled read),
// also when it is refused.
func (h *Hub) startMCPInventory(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.MCPInventoryArgs
	var s *mcpScope
	err := decodeArgs(cmd.Args, &a)
	if err == nil && h.opts.MCP == nil {
		err = fmt.Errorf("%w: the bridge has no MCP inventory", errUnsupported)
	}
	if err == nil {
		s, err = h.mcpScopeOf(floorArg(a.Floor, a.Session), a.Cwd, a.CodexProfile, true)
	}
	if err != nil {
		h.reply(c, cmd, nil, err)
		return nil
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		var claude, codex proto.MCPProvider
		read := make([][]codexapp.MCPServerStatus, len(s.observe))
		var wg sync.WaitGroup
		wg.Go(func() { claude = h.opts.MCP.Inventory(ctx, s.claude) })
		wg.Go(func() { codex = h.opts.MCP.Inventory(ctx, s.codex) })
		octx, cancel := context.WithTimeout(ctx, mcpObserveTimeout)
		defer cancel()
		for i, w := range s.observe {
			wg.Go(func() {
				rows, err := w.r.MCPStatus(octx)
				if err != nil {
					h.log.Debug("reading a codex worker's mcp status failed", "worker", w.id, "err", err)
					return
				}
				read[i] = rows
			})
		}
		wg.Wait()
		if derr := h.doWait(ctx, func() {
			now := h.opts.Now()
			obs := s.cached
			for i, w := range s.observe {
				o := &mcpObs{thread: w.thread, asked: w.asked, at: now}
				if read[i] != nil {
					o.rows = mcpinv.MapCodexStatuses(codexStatuses(read[i]))
					obs = append(obs, mcpinv.WorkerObservation{Worker: proto.MCPWorker{ID: w.id, Name: w.name}, At: now, Rows: o.rows})
				}
				if cur := h.mcp.obs[w.id]; cur != nil && cur.thread == w.thread && cur.asked.Equal(w.asked) {
					h.mcp.obs[w.id] = o
				}
			}
			for _, o := range obs {
				mcpinv.ApplyObservation(&codex, o)
			}
			h.reply(c, cmd, h.mcpSnapshot(s, claude, codex), nil)
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

// startMCPCheck answers mcp.check after the check (audited: it starts the
// configured servers).
func (h *Hub) startMCPCheck(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.MCPCheckArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Harness != mcpinv.Claude && a.Harness != mcpinv.Codex {
		return bad("harness must be claude or codex, got %q", a.Harness)
	}
	if h.opts.MCP == nil {
		return fmt.Errorf("%w: the bridge has no MCP inventory", errUnsupported)
	}
	s, err := h.mcpScopeOf(floorArg(a.Floor, a.Session), a.Cwd, a.CodexProfile, false)
	if err != nil {
		return err
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		var claude, codex proto.MCPProvider
		if a.Harness == mcpinv.Claude {
			claude, codex = h.opts.MCP.Check(ctx, s.claude), h.opts.MCP.Inventory(ctx, s.codex)
		} else {
			claude, codex = h.opts.MCP.Inventory(ctx, s.claude), h.opts.MCP.Check(ctx, s.codex)
		}
		for _, o := range s.cached {
			mcpinv.ApplyObservation(&codex, o)
		}
		return h.mcpSnapshot(s, claude, codex), nil
	})
	return nil
}

// mcpSnapshot is a request's answer from its scope and the providers.
func (h *Hub) mcpSnapshot(s *mcpScope, claude, codex proto.MCPProvider) proto.MCPSnapshot {
	snap := s.snap
	snap.GeneratedAt = h.opts.Now().UTC().Format(time.RFC3339)
	snap.Providers = proto.MCPProviders{Claude: claude, Codex: codex}
	return snap
}

// codexStatuses converts a worker's rows for mcpinv (the same fields).
func codexStatuses(rows []codexapp.MCPServerStatus) []mcpinv.CodexStatus {
	out := make([]mcpinv.CodexStatus, len(rows))
	for i, r := range rows {
		out[i] = mcpinv.CodexStatus(r)
	}
	return out
}
