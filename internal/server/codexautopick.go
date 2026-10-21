package server

// #140: an Auto hire's Codex profile (docs/decisions.md "#140"). beginHire
// copies what the pick reads from the hub (the profiles as listed, each
// one's latest Codex reading, the rules); runHire, off the hub goroutine,
// reads the source folder's origin and picks once, before #139's prepare.
// The worker keeps that key for good: a wake never picks again.

import (
	"context"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// autoPick is what an Auto hire's pick reads, as the hub had it when the
// hire began.
type autoPick struct {
	accounts []codexaccount.Account
	readings map[string]codexaccount.Reading
	rules    []codexaccount.Rule
	userHome string
}

// autoPickOf copies the pick's inputs (hub goroutine). A profile whose
// reading had a plan is signed in, as the codex_profiles view says.
func (h *Hub) autoPickOf() *autoPick {
	svc := h.opts.CodexProfiles
	p := &autoPick{accounts: slices.Clone(h.cp.list), readings: map[string]codexaccount.Reading{}}
	if svc != nil {
		p.rules, p.userHome = svc.Settings().Rules, svc.UserHome()
	}
	def := ""
	for _, a := range p.accounts {
		if a.Default {
			def = a.Key
		}
	}
	for _, l := range h.limits {
		if l.Provider != proto.LimitsCodex {
			continue
		}
		key := def // a reading without an account is the default's
		if l.Account != nil {
			key = l.Account.Key
		}
		r := codexaccount.Reading{At: time.UnixMilli(l.At), Stale: l.Stale, Error: l.Error, Reached: l.Reached}
		for _, w := range l.Windows {
			r.Windows = append(r.Windows, codexaccount.Window{Label: w.Label, Model: w.Model, Pct: w.Pct})
		}
		p.readings[key] = r
	}
	for i, a := range p.accounts {
		if r, ok := h.limits[limitsKey(proto.LimitsCodex, a.Key)]; ok && r.Plan != "" {
			p.accounts[i].SignedIn = true
		}
	}
	return p
}

// resolveAuto picks an Auto hire's profile (runHire, off the hub
// goroutine): the origin of the folder it was asked for (a worktree hire's
// source, not its new checkout), then Pick. The key replaces Auto; the
// reason goes into the report and the ack as Pick says it.
func (h *Hub) resolveAuto(ctx context.Context, op *hireOp, rep *hireReport, res *proto.HireResult) {
	a := op.auto
	op.auto = nil
	repo := h.cachedOrigin(ctx, op.cwd)
	key, why := codexaccount.Pick(codexaccount.Hire{Cwd: op.cwd, Repo: repo, UserHome: a.userHome}, a.accounts, a.readings, a.rules, h.opts.Now())
	op.profile = key
	rep.Reason, res.CodexProfileReason = why, why
	rep.step("codex profile auto: %s", why)
}
