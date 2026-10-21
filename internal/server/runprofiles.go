package server

// #167: a Codex profile for a run's orchestrator and for each Codex role of
// its team preset (docs/decisions.md "#167 run profiles"). The orchestrator
// is a hire: run.start hands its codex_profile to worker.hire's path, which
// checks it, picks Auto, prepares it and starts the orchestrator on it
// (#139, #140). The roles are agents the orchestrator starts itself with a
// raw herdr agent start: run.start resolves each one's profile once (Auto
// by the #140 picker with the floor's folder and its origin) and refuses
// one that cannot be used; the prompt names each one's home and token
// (TeamPrompt), and the bridge finds such an agent's sessions by its token
// (codexHomeOf).

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// teamAsk is what resolving a run's Codex roles reads, as the hub had it
// (hub goroutine): the roles with a profile, the pick's inputs and the
// folder the run starts in.
type teamAsk struct {
	roles []teamRole
	pick  *autoPick
	cwd   string
}

// runTeam is a run's Codex roles resolved: the profiles the prompt names,
// what Auto picked and why ("reviewers: …"), and the notes of homes that
// run no herdr hook.
type runTeam struct {
	profiles TeamProfiles
	reasons  []string
	notes    []string
}

// roleProfileError is a role's profile that keeps the run from starting,
// in plain words naming the role (also the orchestrator's): a bad_args,
// never checkProfileKey's not_found (the dialog reads that as its preset
// gone).
func roleProfileError(what string, err error) error {
	msg := err.Error()
	for _, sentinel := range []error{store.ErrNotFound, errUnsupported} {
		if errors.Is(err, sentinel) {
			msg = strings.TrimPrefix(msg, sentinel.Error()+": ")
		}
	}
	var b *badArgsError
	if errors.As(err, &b) {
		msg = b.err.Error()
	}
	return bad("the %s Codex profile cannot be used: %s", what, msg)
}

// possessive is a role's words as the owner of its profile.
func possessive(what string) string {
	if strings.HasSuffix(what, "s") {
		return what + "'"
	}
	return what + "'s"
}

// askTeam checks the Codex roles of roles that have a profile (hub
// goroutine): a key as a hire's is checked (checkProfileKey), and off the
// default it must be signed in (as the codex_profiles view says, with no
// Codex run for it); Auto is left to resolveTeam. strict: the first role
// that cannot be used is the error; else (run.prepare's preview) it is
// left out, on the default. nil when no role has a profile.
func (h *Hub) askTeam(roles proto.PresetRoles, cwd string, strict bool) (*teamAsk, error) {
	var ask *teamAsk
	for _, r := range teamRoles(roles) {
		key := r.hire.CodexProfile
		if r.hire.Harness != "codex" || key == "" {
			continue
		}
		if ask == nil {
			ask = &teamAsk{pick: h.autoPickOf(), cwd: cwd}
		}
		err := h.checkProfileKey(r.hire.Harness, key, "")
		if err == nil && key != proto.CodexProfileAuto {
			for _, a := range ask.pick.accounts {
				if a.Key == key && !a.Default && !a.SignedIn {
					err = notSignedIn(&codexProfileRun{name: a.Name, home: a.Home})
				}
			}
		}
		switch {
		case err != nil && strict:
			return nil, roleProfileError(possessive(r.what), err)
		case err == nil:
			ask.roles = append(ask.roles, r)
		}
	}
	return ask, nil
}

// resolveTeam makes each role of ask concrete, once (off the hub
// goroutine): Auto by the #140 picker with the run's folder and its
// origin, then the profile as listed when ask was made. A role on the
// default is left out of the profiles. notes (with homes) is false for
// run.prepare, which reads no hooks.json. An Auto pick whose folder the
// bridge does not type is the error, as a key's is in askTeam.
func (h *Hub) resolveTeam(ctx context.Context, ask *teamAsk, notes bool) (runTeam, error) {
	team := runTeam{profiles: TeamProfiles{}}
	if ask == nil {
		return team, nil
	}
	repo, read := "", false
	noted := map[string]bool{}
	for _, r := range ask.roles {
		key := r.hire.CodexProfile
		if key == proto.CodexProfileAuto {
			if !read {
				repo, read = h.cachedOrigin(ctx, ask.cwd), true
			}
			var why string
			key, why = codexaccount.Pick(codexaccount.Hire{Cwd: ask.cwd, Repo: repo, UserHome: ask.pick.userHome}, ask.pick.accounts,
				ask.pick.readings, ask.pick.rules, h.opts.Now())
			team.reasons = append(team.reasons, r.what+": "+why)
		}
		a, ok := codexaccount.Account{}, false
		for _, x := range ask.pick.accounts {
			if x.Key == key {
				a, ok = x, true
			}
		}
		if !ok || a.Default {
			continue
		}
		if !herdr.ValidPlainDir(a.Home) {
			return team, roleProfileError(possessive(r.what),
				fmt.Errorf("the folder of the Codex profile %q (%s) has characters the bridge does not type into a terminal", a.Name, a.Home))
		}
		team.profiles[r.role] = TeamProfile{Key: a.Key, Name: a.Name, Home: a.Home}
		if notes && !noted[a.Key] && !codexaccount.RunsHerdrHook(a.Home) {
			noted[a.Key] = true
			team.notes = append(team.notes, teamHookNote(a.Name))
		}
	}
	return team, nil
}

// teamHookNote is what a role's home that runs no herdr hook changes, in
// the run's start report: the hire's note for a worker the bridge finds by
// its folder (the one place it is called for a run's roles).
func teamHookNote(name string) string {
	return noHookNote(name, store.CodexLegacy)
}

// teamReport puts what resolving the team found into the run's start
// report and its ack.
func teamReport(rep *hireReport, res *proto.RunStartResult, team runTeam) {
	for _, why := range team.reasons {
		rep.step("codex profile auto for the %s", why)
	}
	for _, role := range []string{"coder", "reviewer", "ux", "researcher"} {
		if p, ok := team.profiles[role]; ok {
			rep.step("codex profile of the %s: %s (%s)", role, p.Name, p.Home)
		}
	}
	for _, n := range team.notes {
		rep.step("%s", n)
	}
	if len(team.reasons) > 0 {
		res.CodexTeamReason = strings.Join(team.reasons, "; ")
	}
	res.CodexTeamNote = strings.Join(team.notes, " ")
}

// tokenProfile is the Codex profile a worker's workspace is tagged with
// (profileToken; "": none), for a worker with no launch of the bridge's.
func tokenProfile(w *proto.Worker) string {
	if w == nil {
		return ""
	}
	return w.Tokens[profileToken]
}
