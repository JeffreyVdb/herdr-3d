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
	"os"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
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
		out.Overrides = append(out.Overrides, codexaccount.Override{Path: p.Path, Name: p.Name, Hidden: p.Hidden, Anything: p.Anything, Share: p.Share})
	}
	for _, r := range set.Rules {
		out.Rules = append(out.Rules, codexaccount.Rule{Match: r.Match, Profile: r.Profile})
	}
	return out
}

func toStoredProfiles(set codexaccount.Settings) store.CodexProfiles {
	out := store.CodexProfiles{Profiles: []store.CodexProfile{}, Added: set.Added, Rules: []store.CodexRule{}}
	for _, o := range set.Overrides {
		out.Profiles = append(out.Profiles, store.CodexProfile{Path: o.Path, Name: o.Name, Hidden: o.Hidden, Anything: o.Anything, Share: o.Share})
	}
	for _, r := range set.Rules {
		out.Rules = append(out.Rules, store.CodexRule{Match: r.Match, Profile: r.Profile})
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
	rules := svc.Settings().Rules
	out := &proto.CodexProfiles{Profiles: make([]proto.CodexProfile, 0, len(h.cp.list)), Hire: true, Auto: true,
		Runs: true, Rules: make([]proto.CodexRule, 0, len(rules)), Share: true}
	for _, a := range h.cp.list {
		plan := ""
		if l, ok := h.limits[limitsKey(proto.LimitsCodex, a.Key)]; ok {
			plan = l.Plan
		}
		out.Profiles = append(out.Profiles, proto.CodexProfile{Key: a.Key, Name: a.Name, Path: a.Home, Display: svc.Display(a.Home),
			Plan: plan, SignedIn: a.SignedIn || plan != "", Default: a.Default, Hidden: a.Hidden, Added: a.Added, Missing: a.Added && !a.Exists,
			Anything: a.Anything, Share: a.Share, Drift: driftView(a)})
	}
	for _, r := range rules {
		out.Rules = append(out.Rules, proto.CodexRule{Match: r.Match, Profile: r.Profile})
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

// applyCodexAccounts takes a new list (listed on the hub goroutine): a
// hidden or gone profile's reading is dropped, and so is one whose key now
// names another folder; a renamed one's is sent again with its new name,
// and the view is published when it changed.
func (h *Hub) applyCodexAccounts(list []codexaccount.Account) {
	homes := map[string]string{}
	for _, a := range h.cp.list {
		homes[a.Key] = a.Home
	}
	h.cp.list = list
	for k, l := range h.limits {
		if l.Account == nil {
			continue
		}
		a, ok := h.codexAccount(l.Account.Key)
		if home, was := homes[a.Key]; !ok || a.Hidden || (was && home != a.Home) {
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
// folder, or rename, hide or show, flag (#140) or remove one profile, or
// (#140) replace the rules (one change a command).
func codexProfilesChange(ctx context.Context, svc *codexaccount.Service, a proto.CodexProfilesSetArgs) (codexaccount.Settings, error) {
	n := 0
	for _, set := range []bool{a.Add != nil, a.Name != nil, a.Hidden != nil, a.Anything != nil, a.Rules != nil, a.Remove} {
		if set {
			n++
		}
	}
	switch {
	case n != 1:
		return codexaccount.Settings{}, bad("exactly one of add, name, hidden, anything, rules and remove is required")
	case a.Add != nil:
		if a.Key != "" {
			return codexaccount.Settings{}, bad("add takes no key")
		}
		return svc.Add(ctx, *a.Add)
	case a.Rules != nil:
		if a.Key != "" {
			return codexaccount.Settings{}, bad("rules takes no key")
		}
		rules := make([]codexaccount.Rule, 0, len(*a.Rules))
		for _, r := range *a.Rules {
			rules = append(rules, codexaccount.Rule{Match: r.Match, Profile: r.Profile})
		}
		return svc.SetRules(ctx, rules)
	case a.Key == "":
		return codexaccount.Settings{}, bad("key is required")
	case a.Name != nil:
		return svc.Rename(ctx, a.Key, *a.Name)
	case a.Hidden != nil:
		return svc.SetHidden(ctx, a.Key, *a.Hidden)
	case a.Anything != nil:
		return svc.SetAnything(ctx, a.Key, *a.Anything)
	}
	return svc.Remove(ctx, a.Key)
}

// driftView is a profile's drift as sent: only for a visible profile that
// shares the default's setup (Accounts checks only those).
func driftView(a codexaccount.Account) []proto.CodexDrift {
	if !a.Share || a.Hidden || a.Drift == nil {
		return nil
	}
	out := make([]proto.CodexDrift, 0, len(a.Drift.Items))
	for _, d := range a.Drift.Items {
		out = append(out, proto.CodexDrift{Kind: d.Kind, Name: d.Name, Text: d.Text})
	}
	return out
}

// hookTruster is a CodexHost that can trust a profile's hooks as the
// default home trusts them (#167; the real one: codexapp.SeedHookTrust).
type hookTruster interface {
	SeedHookTrust(ctx context.Context, defHome, home string) (codexapp.HookTrust, error)
}

// codexTrustTimeout bounds the trust seed (two short-lived Codex servers).
const codexTrustTimeout = 30 * time.Second

func (c codexHost) SeedHookTrust(ctx context.Context, defHome, home string) (codexapp.HookTrust, error) {
	ctx, cancel := context.WithTimeout(ctx, codexTrustTimeout)
	defer cancel()
	env := func(h string) []string {
		base := slices.DeleteFunc(herdr.CleanEnv(os.Environ()), func(e string) bool { return strings.HasPrefix(e, "CODEX_HOME=") })
		return append(base, "CODEX_HOME="+h)
	}
	return codexapp.SeedHookTrust(ctx, c.pre.Codex, env(defHome), env(home), home)
}

// startCodexShare answers codex_profiles.share and .move_skill (#167,
// docs/protocol.md "Sharing a profile's setup"): the checks here, the file
// work (and the trust seed) off the hub goroutine, then the setting stored,
// the profiles listed again (so the drift is the new one at once) and
// published before the ack.
func (h *Hub) startCodexShare(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.opts.CodexProfiles
	if svc == nil {
		return fmt.Errorf("%w: the bridge does not list Codex profiles", errUnsupported)
	}
	if cmd.T == proto.CmdCodexProfilesMoveSkill {
		var a proto.CodexMoveSkillArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if a.Key == "" || a.Skill == "" {
			return bad("key and skill are required")
		}
		h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
			res, err := svc.MoveSkill(ctx, a.Key, a.Skill)
			if err != nil {
				return nil, shareError(err)
			}
			return h.shareDone(ctx, res, a.Key, nil)
		})
		return nil
	}
	var a proto.CodexShareArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	switch {
	case a.Key == "":
		return bad("key is required")
	case a.Share == nil:
		return bad("share is required")
	case !*a.Share && (a.DryRun || a.Replace != nil):
		return bad("dry_run and replace are for share: true")
	}
	on := *a.Share
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		if a.DryRun {
			plan, err := svc.SharePlan(ctx, a.Key)
			if err != nil {
				return nil, shareError(err)
			}
			v, err := query(ctx, h, func() *proto.CodexProfiles { return h.codexProfilesView() })
			if err != nil {
				return nil, err
			}
			return proto.CodexShareAck{CodexProfiles: *v, Steps: shareSteps(plan)}, nil
		}
		var res codexaccount.ShareResult
		var err error
		if on {
			res, err = svc.Share(ctx, a.Key, a.Replace)
		} else {
			res, err = svc.Unshare(ctx, a.Key)
		}
		if err != nil {
			return nil, shareError(err)
		}
		if on && res.Hooks {
			res.Report = strings.TrimSpace(res.Report + " " + h.seedTrust(ctx, svc, a.Key))
		}
		keep := !on && res.Failed // a failed unshare stays shared: what is left is drift
		var set *bool
		if !keep {
			set = &on
		}
		return h.shareDone(ctx, res, a.Key, set)
	})
	return nil
}

// shareError is a share's refusal as the client gets it.
func shareError(err error) error {
	var se *codexaccount.SettingsError
	var nf *codexaccount.NotFoundError
	switch {
	case errors.As(err, &se):
		return bad("%s", se.Msg)
	case errors.As(err, &nf):
		return fmt.Errorf("%w: %s", store.ErrNotFound, nf.Error())
	}
	return err
}

func shareSteps(steps []codexaccount.Step) []proto.CodexShareStep {
	out := make([]proto.CodexShareStep, 0, len(steps))
	for _, s := range steps {
		out = append(out, proto.CodexShareStep{Name: s.Name, Action: s.Action, Was: s.Was, Backup: s.Backup})
	}
	return out
}

// seedTrust trusts the profile key's hooks as the default home trusts them
// (off the hub goroutine) and says what a new hire will meet: nothing when
// they are trusted (already, or now: then it says so), else Codex's
// one-time review (also when this bridge cannot run Codex to seed it).
func (h *Hub) seedTrust(ctx context.Context, svc *codexaccount.Service, key string) string {
	list, _ := svc.Accounts(ctx)
	var a, def codexaccount.Account
	for _, x := range list {
		if x.Key == key {
			a = x
		}
		if x.Default {
			def = x
		}
	}
	review := "Codex will ask once to review the hooks of " + a.Name + "."
	t, ok := h.opts.CodexHost.(hookTruster)
	if !ok || a.Home == "" || def.Home == "" {
		return review
	}
	r, err := t.SeedHookTrust(ctx, def.Home, a.Home)
	switch {
	case err != nil:
		// An app-server's error text could quote its config: only its code is logged.
		why := err.Error()
		if rpc := (*codexapp.RPCError)(nil); errors.As(err, &rpc) {
			why = fmt.Sprintf("app-server error %d", rpc.Code)
		}
		h.log.Warn("codex profiles: trusting a shared profile's hooks failed", "profile", key, "err", why)
		return review
	case r.Untrusted > 0:
		return review
	case r.Seeded > 0:
		return a.Name + "'s hooks are trusted as on " + def.Name + ", so Codex will not ask to review them."
	}
	return ""
}

// shareDone stores the share setting (set: on or off; nil: as it is),
// lists the profiles again and publishes them (hub goroutine), and answers
// the list with what was done.
func (h *Hub) shareDone(ctx context.Context, res codexaccount.ShareResult, key string, set *bool) (any, error) {
	svc := h.opts.CodexProfiles
	type out struct {
		v   *proto.CodexProfiles
		err error
	}
	o, err := query(ctx, h, func() out {
		if set != nil {
			next, err := svc.SetShare(ctx, key, *set)
			if err == nil {
				err = h.st.SaveCodexProfiles(ctx, toStoredProfiles(next))
			}
			if err != nil {
				return out{err: err}
			}
			svc.Configure(next)
		}
		if list, err := svc.Accounts(ctx); err == nil {
			h.applyCodexAccounts(list)
		}
		if h.limitsPoller != nil {
			h.limitsPoller.Relist()
		}
		return out{v: h.codexProfilesView()}
	})
	if err == nil {
		err = o.err
	}
	if err != nil {
		return nil, err
	}
	return proto.CodexShareAck{CodexProfiles: *o.v, Steps: shareSteps(res.Steps), Report: res.Report, Failed: res.Failed}, nil
}
