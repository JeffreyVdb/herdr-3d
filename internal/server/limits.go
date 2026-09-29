package server

import (
	"context"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// M10 limits: the Claude and Codex plan limits. A limits.Poller reads them
// while a client is connected; every reading is a limits.update event and the
// latest of each provider is in the snapshot.

// trackLimits runs the poller until ctx is done.
func (h *Hub) trackLimits(ctx context.Context) {
	defer h.wg.Done()
	h.limitsPoller.Run(ctx, func() bool { return h.nclients.Load() > 0 }, func(l proto.Limits) {
		_ = h.doWait(ctx, func() { h.setLimits(l) })
	})
}

// setLimits publishes a provider's reading (on the hub goroutine).
func (h *Hub) setLimits(l proto.Limits) {
	h.limits[l.Provider] = l
	h.emit(proto.Event{T: proto.EvLimitsUpdate, Limits: &l})
}

// limitsViews are the latest readings, Claude first: [] before the first,
// nil (left out of the snapshot) when the bridge does not read limits.
func (h *Hub) limitsViews() []proto.Limits {
	if h.limitsPoller == nil {
		return nil
	}
	out := []proto.Limits{}
	for _, p := range []string{proto.LimitsClaude, proto.LimitsCodex} {
		if l, ok := h.limits[p]; ok {
			out = append(out, l)
		}
	}
	return out
}

// setClients keeps the count the poller looks at.
func (h *Hub) setClients() { h.nclients.Store(int32(len(h.clients))) }

// startLimitsRefresh answers limits.refresh: the poller reads at once,
// unless it did less than 20 s ago.
func (h *Hub) startLimitsRefresh(ctx context.Context, c *Client, cmd proto.Command) error {
	if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
		return err
	}
	if h.limitsPoller == nil {
		return fmt.Errorf("%w: the bridge does not read limits", errUnsupported)
	}
	queued := h.limitsPoller.Refresh()
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, proto.LimitsRefreshResult{Queued: queued}, nil)
	return nil
}

// newLimitsPoller builds the poller of Options.Limits.
func newLimitsPoller(cfg *limits.Config) *limits.Poller {
	if cfg == nil {
		return nil
	}
	return limits.New(*cfg)
}
