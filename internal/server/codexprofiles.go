package server

// #138 Codex profiles (docs/protocol.md "Codex profiles"): the hub keeps the
// user's settings of the Codex home folders (one row, on the hub goroutine,
// like repo_discovery), hands them to the codexaccount service the limits
// poller lists the profiles through, and publishes codex_profiles.update
// whenever the list as shown changes: a setting, a folder found or gone
// (the poller lists them again while a client is connected), or a profile's
// plan in its latest limits reading.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// codexProfilesState is the hub's bookkeeping (hub goroutine only).
type codexProfilesState struct {
	list []codexaccount.Account // as last listed
	last string                 // the view last published
}

// initCodexProfiles hands the stored settings to the service and lists the
// profiles once, for the first snapshot (NewHub).
func (h *Hub) initCodexProfiles(ctx context.Context) error {
	svc := h.opts.CodexProfiles
	if svc == nil {
		return nil
	}
	set, err := h.st.LoadCodexProfiles(ctx)
	if err != nil {
		return err
	}
	svc.Configure(codexaccount.Clean(fromStoredProfiles(set)))
	h.cp.list, _ = svc.Accounts(ctx)
	h.cp.last = string(mustJSON(h.codexProfilesView()))
	return nil
}

func fromStoredProfiles(set store.CodexProfiles) codexaccount.Settings {
	out := codexaccount.Settings{Added: set.Added}
	for _, p := range set.Profiles {
		out.Overrides = append(out.Overrides, codexaccount.Override{Path: p.Path, Name: p.Name, Hidden: p.Hidden})
	}
	return out
}

func toStoredProfiles(set codexaccount.Settings) store.CodexProfiles {
	out := store.CodexProfiles{Profiles: []store.CodexProfile{}, Added: set.Added}
	for _, o := range set.Overrides {
		out.Profiles = append(out.Profiles, store.CodexProfile{Path: o.Path, Name: o.Name, Hidden: o.Hidden})
	}
	return out
}

// codexProfilesView is the list for the snapshot and the acks (nil: no
// profile service).
func (h *Hub) codexProfilesView() *proto.CodexProfiles {
	svc := h.opts.CodexProfiles
	if svc == nil {
		return nil
	}
	out := &proto.CodexProfiles{Profiles: make([]proto.CodexProfile, 0, len(h.cp.list))}
	for _, a := range h.cp.list {
		plan := ""
		if l, ok := h.limits[limitsKey(proto.LimitsCodex, a.Key)]; ok {
			plan = l.Plan
		}
		out.Profiles = append(out.Profiles, proto.CodexProfile{Key: a.Key, Name: a.Name, Path: a.Home, Display: svc.Display(a.Home),
			Plan: plan, SignedIn: a.SignedIn || plan != "", Default: a.Default, Hidden: a.Hidden, Added: a.Added, Missing: a.Added && !a.Exists})
	}
	return out
}

// codexAccount is the listed profile with key (ok false: none, or the hub
// has no list).
func (h *Hub) codexAccount(key string) (codexaccount.Account, bool) {
	for _, a := range h.cp.list {
		if a.Key == key {
			return a, true
		}
	}
	return codexaccount.Account{}, false
}

// applyCodexAccounts takes a new list (the poller's, or one listed for a
// command): a hidden or gone profile's reading is dropped, a renamed one's
// is sent again with its new name, and the view is published when it
// changed.
func (h *Hub) applyCodexAccounts(list []codexaccount.Account) {
	h.cp.list = list
	for k, l := range h.limits {
		if l.Account == nil {
			continue
		}
		a, ok := h.codexAccount(l.Account.Key)
		if !ok || a.Hidden {
			delete(h.limits, k)
			continue
		}
		if a.Name != l.Account.Name || a.Default != l.Account.Default {
			acct := *l.Account
			acct.Name, acct.Default = a.Name, a.Default
			l.Account = &acct
			h.limits[k] = l
			h.emit(proto.Event{T: proto.EvLimitsUpdate, Limits: &l})
		}
	}
	h.publishCodexProfiles()
}

// publishCodexProfiles sends the view as a codex_profiles.update when it
// changed.
func (h *Hub) publishCodexProfiles() {
	v := h.codexProfilesView()
	if v == nil {
		return
	}
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.cp.last {
		return
	}
	h.cp.last = string(b)
	h.seq++
	msg := mustJSON(proto.CodexProfilesUpdate{T: proto.EvCodexProfilesUpdate, Seq: h.seq, CodexProfiles: *v})
	h.ring.add(h.seq, msg)
	for cl := range h.clients {
		h.deliver(cl, msg)
	}
}

// startCodexProfiles answers codex_profiles.get and .set on the hub
// goroutine. Both list the profiles afresh; a change is stored, handed to
// the service and the poller (which reads a profile shown or added at its
// next poll), and published before the ack.
func (h *Hub) startCodexProfiles(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.opts.CodexProfiles
	if svc == nil {
		return fmt.Errorf("%w: the bridge does not list Codex profiles", errUnsupported)
	}
	if cmd.T == proto.CmdCodexProfilesSet {
		var a proto.CodexProfilesSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		next, err := codexProfilesChange(ctx, svc, a)
		var se *codexaccount.SettingsError
		var nf *codexaccount.NotFoundError
		switch {
		case errors.As(err, &se):
			return bad("%s", se.Msg)
		case errors.As(err, &nf):
			return fmt.Errorf("%w: %s", store.ErrNotFound, nf.Error())
		case err != nil:
			return err
		}
		if err := h.st.SaveCodexProfiles(ctx, toStoredProfiles(next)); err != nil {
			return err
		}
		svc.Configure(next)
		if h.limitsPoller != nil {
			h.limitsPoller.Relist()
		}
	} else if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
		return err
	}
	list, err := svc.Accounts(ctx)
	if err != nil {
		return err
	}
	h.applyCodexAccounts(list)
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, h.codexProfilesView(), nil)
	return nil
}

// codexProfilesChange is the settings a codex_profiles.set asks for: add a
// folder, or rename, hide or show, or remove one profile (one change a
// command).
func codexProfilesChange(ctx context.Context, svc *codexaccount.Service, a proto.CodexProfilesSetArgs) (codexaccount.Settings, error) {
	n := 0
	for _, set := range []bool{a.Add != nil, a.Name != nil, a.Hidden != nil, a.Remove} {
		if set {
			n++
		}
	}
	switch {
	case n != 1:
		return codexaccount.Settings{}, bad("exactly one of add, name, hidden and remove is required")
	case a.Add != nil:
		if a.Key != "" {
			return codexaccount.Settings{}, bad("add takes no key")
		}
		return svc.Add(ctx, *a.Add)
	case a.Key == "":
		return codexaccount.Settings{}, bad("key is required")
	case a.Name != nil:
		return svc.Rename(ctx, a.Key, *a.Name)
	case a.Hidden != nil:
		return svc.SetHidden(ctx, a.Key, *a.Hidden)
	}
	return svc.Remove(ctx, a.Key)
}
