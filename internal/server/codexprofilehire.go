package server

// #139: a Codex worker on a chosen Codex profile (docs/decisions.md "#139").
// A profile is a Codex home folder (#138); nothing is switched. A worker
// runs on one by having CODEX_HOME=<its home> in every Codex process it
// starts: its own server's launcher sets it (codexapp.Launch.Env), and the
// pane's shell exports it before herdr types anything of Codex there (the
// attached TUI, a legacy start, a wake's embedded resume or the floor's
// resume fallback). The default profile is exactly what came before: no
// env, the pane untouched, nothing checked. On any other profile a worker
// with its own server is checked once it answers: which account it signed
// in to (compared with the home's own, never stored) and whether the
// account's workspace policy lets it run as herdr-3d hires it.

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// codexProfileRun is a Codex worker's profile for one start (a hire or a
// wake), prepared.
type codexProfileRun struct {
	key, name, home string
	// def: the bridge's own profile: no env, no export, no check.
	def bool
	// env is Prepare's (CODEX_HOME=home); nil on the default.
	env []string
	// noHook: the home runs no herdr hook (a bare profile home).
	noHook bool
}

// profileRefusedError is a profile that keeps the worker from starting:
// not signed in, or a workspace policy that does not allow how herdr-3d
// hires. The hire or wake fails with its words; it never falls back to
// Codex's built-in server, which would meet the same account.
type profileRefusedError struct{ msg string }

func (e *profileRefusedError) Error() string { return e.msg }

// codexPrepare is Prepare of the profile service (or the test hook).
func (h *Hub) codexPrepare(ctx context.Context, key string) ([]string, func(), error) {
	if h.opts.CodexPrepare != nil {
		return h.opts.CodexPrepare(ctx, key)
	}
	if h.opts.CodexProfiles == nil {
		return nil, func() {}, fmt.Errorf("%w: the bridge does not list Codex profiles", errUnsupported)
	}
	return h.opts.CodexProfiles.Prepare(ctx, key)
}

// prepareProfile prepares the profile key for one start (off the hub
// goroutine). release is never nil, also on an error: the caller defers it.
func (h *Hub) prepareProfile(ctx context.Context, key string) (codexProfileRun, func(), error) {
	env, release, err := h.codexPrepare(ctx, key)
	if release == nil {
		release = func() {}
	}
	p := codexProfileRun{key: key, name: key}
	if err != nil {
		return p, release, err
	}
	if a, ok := h.listedProfile(ctx, key); ok {
		p.name, p.home, p.def = a.Name, a.Home, a.Default
	}
	if p.def {
		return p, release, nil
	}
	p.env = env
	for _, kv := range env {
		if home, ok := strings.CutPrefix(kv, "CODEX_HOME="); ok {
			p.home = home
		}
	}
	p.noHook = !codexaccount.RunsHerdrHook(p.home)
	return p, release, nil
}

// listedProfile is the profile key as listed now ("": the default).
func (h *Hub) listedProfile(ctx context.Context, key string) (codexaccount.Account, bool) {
	if h.opts.CodexProfiles == nil {
		return codexaccount.Account{}, false
	}
	list, _ := h.opts.CodexProfiles.Accounts(ctx)
	for _, a := range list {
		if a.Key == key || key == "" && a.Default {
			return a, true
		}
	}
	return codexaccount.Account{}, false
}

// checkProfileKey refuses a hire's or a preset's profile that cannot be
// hired on (hub goroutine): only a Codex hire takes one, it must be listed
// with its folder there, and (not the default) a home typed into the
// pane's shell must be a plain path. keep is a key already stored (a
// preset's): kept as it is, even when gone.
func (h *Hub) checkProfileKey(harness, key, keep string) error {
	if key == "" || key == keep {
		return nil
	}
	if harness != "codex" {
		return bad("codex_profile is for a Codex hire, not %q", harness)
	}
	if h.opts.CodexProfiles == nil {
		return fmt.Errorf("%w: the bridge does not list Codex profiles", errUnsupported)
	}
	a, ok := h.codexAccount(key)
	switch {
	case !ok:
		return fmt.Errorf("%w: no Codex profile %q", store.ErrNotFound, key)
	case !a.Exists && !a.Default:
		return fmt.Errorf("%w: the folder of the Codex profile %q no longer exists", store.ErrNotFound, a.Name)
	case !a.Default && !herdr.ValidPlainDir(a.Home):
		return bad("the folder of the Codex profile %q (%s) has characters the bridge does not type into a terminal", a.Name, a.Home)
	}
	return nil
}

// notSignedIn is the refusal of a profile with no sign-in.
func notSignedIn(p *codexProfileRun) error {
	return &profileRefusedError{fmt.Sprintf("%s is not signed in. Run `CODEX_HOME=%s codex login` in a terminal.", p.name, p.home)}
}

// policyRefusal is the refusal of a workspace policy that does not allow
// a worker that runs without asking and without a sandbox
// (docs/research/codex-accounts-shared-setup.md "What #139 must report"):
// "<name> does not allow workers that run without asking. Its workspace
// policy limits approvals to <list> and sandbox to <list>."
func policyRefusal(p *codexProfileRun, r codexapp.Requirements) error {
	var limits []string
	for _, l := range []struct {
		what    string
		allowed []string
	}{{"approvals", r.Approvals}, {"sandbox", r.Sandboxes}} {
		switch {
		case l.allowed == nil:
		case len(l.allowed) == 0:
			limits = append(limits, l.what+" to none")
		default:
			limits = append(limits, l.what+" to "+strings.Join(l.allowed, ", "))
		}
	}
	return &profileRefusedError{fmt.Sprintf("%s does not allow workers that run without asking. Its workspace policy limits %s.",
		p.name, strings.Join(limits, " and "))}
}

// confirmProfile checks a worker's own server on a profile once it
// answers (off the hub goroutine): not signed in or a refusing policy is a
// *profileRefusedError; otherwise rec takes what its sign-in was found to
// be (confirmed, another account's, or not confirmed and why) and the plan.
// Its account is compared with the one the profile's home reports by
// itself, by workspaceRouting.chatgptAccountId: never kept.
func (h *Hub) confirmProfile(ctx context.Context, p *codexProfileRun, sock string, rec *store.CodexLaunch) error {
	host := h.opts.CodexHost
	acct, req, err := host.ReadProfile(ctx, sock)
	switch {
	case acct.Answered && !acct.SignedIn: // also when the policy read after it failed
		return notSignedIn(p)
	case err != nil:
		profileChecked(p, rec, store.AccountUnconfirmed, "", "Could not confirm the account: "+err.Error()+".")
		return nil
	case !acct.SignedIn:
		return notSignedIn(p)
	}
	if req.Refuses() {
		return policyRefusal(p, req)
	}
	ref, _, err := host.HomeProfile(ctx, p.env)
	switch {
	case err != nil:
		profileChecked(p, rec, store.AccountUnconfirmed, acct.Plan, "Could not confirm the account: reading "+p.name+"'s own sign-in failed ("+err.Error()+").")
	case acct.ID == "" || ref.ID == "":
		profileChecked(p, rec, store.AccountUnconfirmed, acct.Plan, "Could not confirm the account: this Codex does not say which account it signed in to.")
	case acct.ID != ref.ID:
		profileChecked(p, rec, store.AccountMismatch, acct.Plan, "Asked for "+p.name+", the server signed in to another account.")
	default:
		profileChecked(p, rec, store.AccountConfirmed, acct.Plan, "")
	}
	return nil
}

// checkHomeProfile is the check of a worker on a profile that runs without
// a server of its own (a legacy hire, a wake's embedded resume): Codex run
// on the profile's home says whether it is signed in and which policy
// applies; which account the worker itself got cannot be asked.
func (h *Hub) checkHomeProfile(ctx context.Context, p *codexProfileRun, rec *store.CodexLaunch) error {
	if p.def {
		return nil
	}
	if h.opts.CodexHost == nil {
		profileChecked(p, rec, store.AccountUnconfirmed, "", "Could not confirm the account: this bridge does not run Codex to ask.")
		return nil
	}
	acct, req, err := h.opts.CodexHost.HomeProfile(ctx, p.env)
	switch {
	case acct.Answered && !acct.SignedIn: // also when the policy read after it failed
		return notSignedIn(p)
	case err != nil:
		profileChecked(p, rec, store.AccountUnconfirmed, "", "Could not confirm the account: reading "+p.name+"'s sign-in failed ("+err.Error()+").")
	case !acct.SignedIn:
		return notSignedIn(p)
	case req.Refuses():
		return policyRefusal(p, req)
	default:
		profileChecked(p, rec, store.AccountUnconfirmed, acct.Plan, "Could not confirm the account: it has no Codex server of its own to ask.")
	}
	return nil
}

// noHookNote is what a worker loses on a home that runs no herdr hook:
// herdr's session hook (herdr-agent-state.sh) is how herdr, and so the
// bridge, learns the worker's Codex session.
func noHookNote(name string) string {
	return name + " has no hooks.json with herdr's hook: herdr is not told the worker's Codex session, so the bridge cannot " +
		"join its thread (its async questions cannot be answered from the transcript) and a wake starts a new Codex session."
}

// profileChecked writes a check's outcome into rec, with the bare home's
// note after it.
func profileChecked(p *codexProfileRun, rec *store.CodexLaunch, account, plan, note string) {
	rec.Account, rec.Plan = account, plan
	var notes []string
	if note != "" {
		notes = append(notes, note)
	}
	if p.noHook {
		notes = append(notes, noHookNote(p.name))
	}
	rec.ProfileNote = strings.Join(notes, " ")
}

// profileOnRecord sets rec's profile for a start on p: its key and name,
// and nothing checked yet (the default stays so).
func profileOnRecord(p *codexProfileRun, rec *store.CodexLaunch) {
	if p == nil {
		return
	}
	rec.Profile, rec.ProfileName, rec.Account, rec.Plan, rec.ProfileNote = p.key, p.name, "", "", ""
	if !p.def && p.noHook {
		rec.ProfileNote = noHookNote(p.name)
	}
}

// profileView adds a launch's profile to a worker's Codex view.
func profileView(v *proto.WorkerCodex, l store.CodexLaunch) {
	v.Profile, v.Account, v.Plan, v.ProfileNote = l.Profile, l.Account, l.Plan, l.ProfileNote
}

// profileReport puts what the hire found about its profile into the
// report.
func profileReport(rep *hireReport, l store.CodexLaunch) {
	if l.Account != "" {
		rep.step("codex profile %s: account %s", l.ProfileName, l.Account)
	}
	if l.ProfileNote != "" {
		rep.step("%s", l.ProfileNote)
	}
}

// isProfileRefused reports whether err is a profile's refusal.
func isProfileRefused(err error) bool {
	var pr *profileRefusedError
	return errors.As(err, &pr)
}

// hireOnProfile starts a Codex hire on a profile without a server of its
// own (the shared server switch is off; runHire, off the hub goroutine):
// the profile's home is checked first (checkHomeProfile), and the launch
// is recorded as a legacy one, so its seat shows the profile.
func (h *Hub) hireOnProfile(ctx context.Context, op *hireOp, pane, dir string, a herdr.Agent, rep *hireReport, res *proto.HireResult,
	prof *codexProfileRun) error {
	rec := store.CodexLaunch{WorkerID: op.id, Session: op.session, Mode: store.CodexLegacy, AgentName: op.agent, Cwd: dir,
		Model: op.model, Effort: op.effort}
	profileOnRecord(prof, &rec)
	if err := h.checkHomeProfile(ctx, prof, &rec); err != nil {
		rep.step("%v", err)
		return err
	}
	res.Codex = &proto.WorkerCodex{Mode: proto.CodexModeLegacy}
	profileView(res.Codex, rec)
	profileReport(rep, rec)
	_ = h.doWait(ctx, func() { h.setLaunch(ctx, rec) })
	return h.opts.Hire.StartAgent(ctx, op.session, pane, op.agent, a)
}

// legacyWake readies a Codex worker without its own server for the
// floor's resume fallback (off the hub goroutine; #139). On a profile, its
// home is checked again, as at its hire (checkHomeProfile), and exported
// in its pane before `codex resume <id>` is typed there: its session is in
// that home, and herdr's own resume, which takes no env, looks in the
// default one. A refusal is the error, and its seat's note. A profile that
// is gone wakes on the default with a new Codex session, as a shared
// worker does (wakeProfile): start starts it, and note says so. Nothing
// for a worker on the default profile or none (start nil: resume).
func (h *Hub) legacyWake(ctx context.Context, session, id, pane string) (start func(ctx context.Context) error, note string, err error) {
	rec, err := query(ctx, h, func() store.CodexLaunch { return h.cx.launches[id] })
	if err != nil || rec.Profile == "" {
		return nil, "", nil
	}
	p, release, err := h.prepareProfile(ctx, rec.Profile)
	defer func() { release() }()
	var nf *codexaccount.NotFoundError
	switch {
	case errors.As(err, &nf):
		_, release2, gone, err := h.wakeOnDefault(ctx, id, rec, nf)
		release = joinRelease(release, release2)
		if err != nil {
			return nil, "", err
		}
		return func(ctx context.Context) error { return h.startLegacy(ctx, session, pane, rec) }, gone, nil
	case err != nil:
		h.log.Warn("the codex profile of a resumed worker could not be prepared", "worker", id, "profile", rec.Profile, "err", err)
		return nil, "", fmt.Errorf("preparing its Codex profile %s failed: %v", cmp.Or(rec.ProfileName, rec.Profile), err)
	case p.def:
		return nil, "", nil
	}
	checked := rec
	if err := h.checkHomeProfile(ctx, &p, &checked); err != nil {
		_ = h.doWait(ctx, func() {
			h.updateLaunch(ctx, id, func(l *store.CodexLaunch) { l.ProfileNote = "The wake did not resume it: " + err.Error() })
		})
		return nil, "", err
	}
	_ = h.doWait(ctx, func() {
		h.updateLaunch(ctx, id, func(l *store.CodexLaunch) {
			l.ProfileName, l.Account, l.Plan, l.ProfileNote = checked.ProfileName, checked.Account, checked.Plan, checked.ProfileNote
		})
	})
	if err := h.opts.Herdr.ExportCodexHome(ctx, session, pane, p.home); err != nil {
		return nil, "", fmt.Errorf("exporting CODEX_HOME for its Codex profile %s failed: %v", p.name, err)
	}
	return nil, "", nil
}

// startLegacy starts a new Codex session in a legacy worker's pane, as its
// hire did, its trust dialog answered as a hire answers it.
func (h *Hub) startLegacy(ctx context.Context, session, pane string, rec store.CodexLaunch) error {
	if h.opts.Hire == nil {
		return errors.New("this bridge cannot start agents")
	}
	err := h.opts.Hire.StartAgent(ctx, session, pane, rec.AgentName, herdr.Agent{Harness: "codex", Model: rec.Model, Effort: rec.Effort})
	var api *herdr.APIError
	if errors.As(err, &api) && api.Code == "agent_not_ready" {
		h.answerTrust(ctx, &hireOp{session: session, harness: "codex"}, pane, rec.Cwd)
		return nil
	}
	return err
}

// codexHomeOf is the Codex home a worker's sessions are in (hub
// goroutine; #139): other is false for the bridge's own (--codex-sessions:
// the default profile, a worker hired before profiles, any other worker);
// on another profile home is its folder, "" when that profile is gone (no
// longer listed, or its folder gone): its sessions are read nowhere then,
// never in the default's folder.
func (h *Hub) codexHomeOf(id string) (home string, other bool) {
	l, ok := h.cx.launches[id]
	if !ok || l.Profile == "" {
		return "", false
	}
	a, listed := h.codexAccount(l.Profile)
	switch {
	case listed && a.Default:
		return "", false
	case !listed || !a.Exists:
		return "", true
	}
	return a.Home, true
}
