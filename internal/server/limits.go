package server

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/limits"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// M10 limits: the Claude and Codex plan limits. A limits.Poller reads them
// while a client is connected; every reading is a limits.update event and the
// latest of each provider is in the snapshot. #138: the latest of each
// (provider, Codex profile), every visible profile its own reading.

// trackLimits runs the poller until ctx is done. A list of the Codex
// profiles the poller found changed is not taken as it is: the poller took
// it outside the hub goroutine, maybe from settings older than the ones a
// codex_profiles.set has since applied and published, so the hub lists
// them again on its goroutine, where the settings change. Only the drift
// the poller read (#167: files, off the hub goroutine) is kept, for the
// profiles whose key still names the same home.
func (h *Hub) trackLimits(ctx context.Context) {
	defer h.wg.Done()
	h.limitsPoller.Run(ctx, func() bool { return h.nclients.Load() > 0 }, func(l proto.Limits) {
		_ = h.doWait(ctx, func() { h.setLimits(l) })
	}, func(list []codexaccount.Account) {
		_ = h.doWait(ctx, func() {
			if h.opts.CodexProfiles != nil {
				h.keepDrift(list)
				list = h.listCodexProfiles(ctx)
			}
			h.applyCodexAccounts(list)
		})
	})
}

// limitsKey keys a reading: the provider, and a Codex profile's key.
func limitsKey(provider, account string) string {
	if account == "" {
		return provider
	}
	return provider + "/" + account
}

// setLimits publishes a reading (on the hub goroutine). A Codex profile
// hidden or gone while it was read is dropped; one renamed meanwhile goes
// out with its name now.
func (h *Hub) setLimits(l proto.Limits) {
	key := limitsKey(l.Provider, "")
	if l.Account != nil {
		if h.opts.CodexProfiles != nil {
			a, ok := h.codexAccount(l.Account.Key)
			if !ok || a.Hidden {
				return
			}
			acct := *l.Account
			acct.Name, acct.Default = a.Name, a.Default
			l.Account = &acct
		}
		key = limitsKey(l.Provider, l.Account.Key)
	}
	h.limits[key] = l
	h.emit(proto.Event{T: proto.EvLimitsUpdate, Limits: &l})
	h.publishCodexProfiles() // a profile's plan
}

// limitsViews are the latest readings, Claude first, then the default Codex
// profile's, then the other profiles' by name: [] before the first, nil
// (left out of the snapshot) when the bridge does not read limits.
func (h *Hub) limitsViews() []proto.Limits {
	if h.limitsPoller == nil {
		return nil
	}
	out := make([]proto.Limits, 0, len(h.limits))
	for _, l := range h.limits {
		out = append(out, l)
	}
	rank := func(l proto.Limits) int {
		switch {
		case l.Provider == proto.LimitsClaude:
			return 0
		case l.Provider != proto.LimitsCodex:
			return 3
		case l.Account == nil || l.Account.Default:
			return 1
		}
		return 2
	}
	name := func(l proto.Limits) string {
		if l.Account == nil {
			return ""
		}
		return strings.ToLower(l.Account.Name) + "\x00" + l.Account.Key
	}
	slices.SortFunc(out, func(a, b proto.Limits) int {
		return cmp.Or(cmp.Compare(rank(a), rank(b)), cmp.Compare(a.Provider, b.Provider), cmp.Compare(name(a), name(b)))
	})
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
