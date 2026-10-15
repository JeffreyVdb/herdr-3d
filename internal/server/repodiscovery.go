package server

// #54 repository discovery (docs/protocol.md "Repository discovery"): the
// hub carries the settings and the status of internal/repodisc's service:
// it stores the roots and the interval (one row, on the hub goroutine, like
// repo_refs), hands them to the service (which never blocks: its scans run
// on their own goroutines) and publishes repo_discovery.update whenever
// the view changes. worker.repos and hire.repos read the service's catalog
// (repos.go).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/repodisc"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// repoDiscState is the hub's discovery bookkeeping (hub goroutine only).
type repoDiscState struct {
	last string // the view last published
}

// initRepoDiscovery hands the stored settings to the service (NewHub): its
// first scan starts. Settings that no longer pass (stored by hand) are
// left off, logged.
func (h *Hub) initRepoDiscovery(ctx context.Context) error {
	svc := h.opts.RepoDiscovery
	if svc == nil {
		return nil
	}
	set, err := h.st.LoadRepoDiscovery(ctx, proto.RepoDiscoveryDefaultInterval)
	if err != nil {
		return err
	}
	roots, err := repodisc.CleanSettings(set.Roots, set.IntervalMinutes)
	if err != nil {
		h.log.Warn("repository discovery: the stored settings are not valid; discovery is off", "err", err)
		roots, set.IntervalMinutes = nil, proto.RepoDiscoveryDefaultInterval
	}
	svc.Configure(repodisc.Settings{Roots: roots, Interval: time.Duration(set.IntervalMinutes) * time.Minute})
	h.rd.last = string(mustJSON(svc.View()))
	return nil
}

// repoDiscoveryView is the settings and status for the snapshot (nil: the
// bridge does not scan).
func (h *Hub) repoDiscoveryView() *proto.RepoDiscovery {
	if h.opts.RepoDiscovery == nil {
		return nil
	}
	v := h.opts.RepoDiscovery.View()
	return &v
}

// startRepoDiscovery answers repo_discovery.get, .set and .refresh on the
// hub goroutine (one row; the service only takes note). A change is
// published (repo_discovery.update) before the ack.
func (h *Hub) startRepoDiscovery(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.opts.RepoDiscovery
	if svc == nil {
		return fmt.Errorf("%w: the bridge does not scan for repositories", errUnsupported)
	}
	switch cmd.T {
	case proto.CmdRepoDiscoverySet:
		var a proto.RepoDiscoverySetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if a.Roots == nil && a.IntervalMinutes == nil {
			return bad("roots or interval_minutes is required")
		}
		cur := svc.View()
		roots, minutes := cur.Roots, cur.IntervalMinutes
		if a.Roots != nil {
			roots = *a.Roots
		}
		if a.IntervalMinutes != nil {
			minutes = *a.IntervalMinutes
		}
		clean, err := repodisc.CleanSettings(roots, minutes)
		if se := (*repodisc.SettingsError)(nil); errors.As(err, &se) {
			return bad("%s", se.Msg)
		} else if err != nil {
			return err
		}
		if err := h.st.SaveRepoDiscovery(ctx, store.RepoDiscovery{Roots: clean, IntervalMinutes: minutes}); err != nil {
			return err
		}
		svc.Configure(repodisc.Settings{Roots: clean, Interval: time.Duration(minutes) * time.Minute})
	case proto.CmdRepoDiscoveryRefresh:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		svc.Refresh()
	default:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
	}
	h.publishRepoDiscovery()
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, svc.View(), nil)
	return nil
}

// trackRepoDiscovery publishes the view whenever the service says it
// changed (a scan started, progressed or ended; settings).
func (h *Hub) trackRepoDiscovery(ctx context.Context) {
	defer h.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.opts.RepoDiscovery.Changes():
		}
		_ = h.doWait(ctx, h.publishRepoDiscovery)
	}
}

// publishRepoDiscovery sends the view as a repo_discovery.update when it
// changed.
func (h *Hub) publishRepoDiscovery() {
	v := h.opts.RepoDiscovery.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.rd.last {
		return
	}
	h.rd.last = string(b)
	h.seq++
	msg := mustJSON(proto.RepoDiscoveryUpdate{T: proto.EvRepoDiscoveryUpdate, Seq: h.seq, RepoDiscovery: v})
	h.ring.add(h.seq, msg)
	for cl := range h.clients {
		h.deliver(cl, msg)
	}
}
