package server

import (
	"context"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
)

// #22 native child agents (docs/protocol.md "Native child agents"): the
// registry of every worker's children, fed by Options.ChildSources. The
// registry is the hub goroutine's; a source's evidence comes over h.do.

type childState struct {
	reg *childagents.Registry
}

// runChildSources starts the sources (hub goroutine, from Run).
func (h *Hub) runChildSources(ctx context.Context) {
	for _, src := range h.opts.ChildSources {
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			if err := src.Run(ctx, func(e childagents.Evidence) { h.childEvidence(ctx, e) }); err != nil {
				h.log.Error("child agent source stopped", "err", err)
			}
		}()
	}
}

// childEvidence applies one observation on the hub goroutine and returns
// once it did (a source's order is its evidence's order).
func (h *Hub) childEvidence(ctx context.Context, e childagents.Evidence) {
	done := make(chan struct{})
	if h.do(ctx, func(context.Context) {
		defer close(done)
		evs, err := h.ch.reg.Apply(e)
		if err != nil {
			h.log.Debug("child agent evidence dropped", "session", e.Session, "native", e.NativeID, "dispatch", e.DispatchID, "err", err)
			return
		}
		for _, ev := range evs {
			h.emit(ev)
		}
	}) != nil {
		return
	}
	select {
	case <-done:
	case <-ctx.Done():
	case <-h.done:
	}
}

// childSession records a worker's root agent session on its refresh and
// returns its child generation. A session bound anew (the worker's first,
// a replacement, every worker after a bridge start) is replayed by the
// sources: nothing of the children is kept anywhere else.
func (h *Hub) childSession(id, agentSession string) uint64 {
	gen, bound := h.ch.reg.Worker(id, agentSession)
	if bound {
		for _, src := range h.opts.ChildSources {
			src.Replay(agentSession)
		}
	}
	return gen
}
