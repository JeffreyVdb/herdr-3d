package server

// M7 boards: worker.open_pr.prepare and worker.open_pr, a pull request for
// a plain worker's branch. Only a live plain worker (no role) on a floor
// with a board, whose checkout is on the h3d/… branch the bridge recorded
// making for it (SQLite hire_branch) in a repository whose origin is the
// floor's repo; a dirty tree or a branch with nothing on top of its base is
// invalid_state. The bridge pushes the branch (the one git write), then
// finds or opens the pull request through the floor's code host.

import (
	"context"
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// PRGit is the git worker.open_pr uses (*gitops.Git): reads of the
// worker's checkout and the push of its branch.
type PRGit interface {
	Fetch(ctx context.Context, dir string) error
	Status(ctx context.Context, dir string) ([]string, error)
	CurrentBranch(ctx context.Context, dir string) (string, error)
	DefaultBranch(ctx context.Context, dir string) string
	Push(ctx context.Context, dir, branch string) error
	AheadOf(ctx context.Context, dir, base string) (int, error)
	Subjects(ctx context.Context, dir, base string) ([]string, error)
}

// openPRPlan is a worker.open_pr validated on the hub goroutine.
type openPRPlan struct {
	worker   *proto.Worker
	board    *boardFloor
	git      PRGit
	checkout string
	made     store.HireBranch
	existing *proto.OpenPRRef // an open request for the branch on the cached board
}

// openPRTarget checks the worker and the floor (hub goroutine).
func (h *Hub) openPRTarget(ctx context.Context, id string) (*openPRPlan, error) {
	w := h.workers[id]
	if w == nil {
		return nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	f, err := h.floorFor(w.Session)
	if err != nil {
		return nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	if err := h.notBusy(w.Session, f); err != nil {
		return nil, err
	}
	if !f.running {
		return nil, fmt.Errorf("%w: floor %q is asleep", errInvalidState, w.Session)
	}
	if f.hires[id] != nil {
		return nil, fmt.Errorf("%w: %s is still being hired", errBusy, w.Name)
	}
	bf := h.boardOf(w.Session)
	if bf == nil || bf.set.Host == nil || !bf.host.Capabilities.OpenFromBranch || h.opts.PRGit == nil {
		return nil, fmt.Errorf("%w: the floor cannot open pull requests (no repo linked, or no code host)", errUnsupported)
	}
	if w.Role != "" {
		return nil, fmt.Errorf("%w: %s is a %s: only a plain worker opens a pull request", errInvalidState, w.Name, w.Role)
	}
	made, ok, err := h.st.HireBranchOf(ctx, id)
	if err != nil {
		return nil, err
	}
	if !ok || made.Session != w.Session {
		return nil, fmt.Errorf("%w: %s was not hired into a branch by the bridge", errInvalidState, w.Name)
	}
	if w.Worktree == nil || !w.Worktree.Linked || w.Worktree.CheckoutPath == "" {
		return nil, fmt.Errorf("%w: %s has no worktree checkout", errInvalidState, w.Name)
	}
	p := &openPRPlan{worker: w, board: bf, git: h.opts.PRGit, checkout: w.Worktree.CheckoutPath, made: made}
	if bf.prs != nil {
		for _, r := range bf.prs.PRs {
			if r.HeadBranch == made.Branch {
				p.existing = &proto.OpenPRRef{ID: r.ID, Key: r.Key, URL: r.URL}
			}
		}
	}
	return p, nil
}

// branchState is what the checkout says about opening a pull request.
type branchState struct {
	Branch, Base string
	Ahead        int
	Dirty        bool
	Subjects     []string
	// Reason is why it cannot be opened ("" when it can).
	Reason string
}

// inspect reads the worker's checkout (off the hub goroutine).
func (h *Hub) inspect(ctx context.Context, p *openPRPlan, session, repo string, fetch bool) (branchState, error) {
	st := branchState{Branch: p.made.Branch}
	if fetch {
		_ = p.git.Fetch(ctx, p.checkout) // only remote-tracking refs; a failure leaves them as they were
	}
	cur, err := p.git.CurrentBranch(ctx, p.checkout)
	if err != nil {
		return st, fmt.Errorf("reading the checkout's branch: %w", err)
	}
	st.Base = p.made.Base
	if st.Base == "" { // a record from before M7 knows only the commit
		st.Base = p.git.DefaultBranch(ctx, p.made.RepoRoot)
	}
	lines, err := p.git.Status(ctx, p.checkout)
	if err != nil {
		return st, fmt.Errorf("reading the checkout's status: %w", err)
	}
	st.Dirty = len(lines) > 0
	origin := ""
	if h.opts.RepoOf != nil {
		origin = h.opts.RepoOf(ctx, p.checkout)
	}
	if st.Base != "" {
		if st.Ahead, err = p.git.AheadOf(ctx, p.checkout, "origin/"+st.Base); err != nil {
			return st, fmt.Errorf("counting the commits ahead of origin/%s: %w", st.Base, err)
		}
		if st.Ahead > 0 {
			if st.Subjects, err = p.git.Subjects(ctx, p.checkout, "origin/"+st.Base); err != nil {
				return st, fmt.Errorf("reading the commits: %w", err)
			}
		}
	}
	switch {
	case cur != p.made.Branch:
		st.Reason = fmt.Sprintf("the checkout is on %q, not on %s", cur, p.made.Branch)
	case origin == "" || !strings.EqualFold(origin, repo):
		st.Reason = fmt.Sprintf("the checkout's origin is %q, not the floor's repo %s", origin, repo)
	case st.Base == "":
		st.Reason = "the base branch is unknown"
	case st.Dirty:
		st.Reason = "the checkout has uncommitted changes: commit them first"
	case st.Ahead == 0:
		st.Reason = fmt.Sprintf("no commits on top of origin/%s", st.Base)
	}
	return st, nil
}

func (h *Hub) startOpenPRPrepare(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	p, err := h.openPRTarget(ctx, a.ID)
	if err != nil {
		return err
	}
	session, repo := p.worker.Session, h.repoOf(p.worker.Session)
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		st, err := h.inspect(ctx, p, session, repo, true)
		if err != nil {
			return nil, err
		}
		res := proto.OpenPRPrepareResult{CanOpen: st.Reason == "", Reason: st.Reason, Branch: st.Branch, Base: st.Base, Ahead: st.Ahead,
			Dirty: st.Dirty, Existing: p.existing, Title: st.Branch}
		if len(st.Subjects) > 0 {
			res.Title = st.Subjects[0] // the latest commit's subject
			lines := make([]string, len(st.Subjects))
			for i, s := range st.Subjects {
				lines[i] = "- " + s
			}
			res.Body = strings.Join(lines, "\n")
		}
		return res, nil
	})
	return nil
}

func (h *Hub) startOpenPR(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.OpenPRArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if err := validBoardTitle(a.Title); err != nil {
		return err
	}
	if err := validBoardText("body", a.Body, 0); err != nil {
		return err
	}
	if !a.Confirm {
		return fmt.Errorf("%w: opening a pull request needs confirm: true", errConfirmation)
	}
	p, err := h.openPRTarget(ctx, a.ID)
	if err != nil {
		return err
	}
	session, repo := p.worker.Session, h.repoOf(p.worker.Session)
	host := p.board.set.Host
	return h.startBoardAsync(ctx, c, cmd, session, true, func(ctx context.Context) (any, any, error) {
		rep := map[string]any{"worker": a.ID, "branch": p.made.Branch, "title_bytes": len(a.Title), "body_bytes": len(a.Body)}
		st, err := h.inspect(ctx, p, session, repo, true)
		if err != nil {
			return nil, rep, provider.Failed("%v", err)
		}
		rep["base"], rep["ahead"] = st.Base, st.Ahead
		if st.Reason != "" {
			return nil, rep, fmt.Errorf("%w: %s", errInvalidState, st.Reason)
		}
		// Push first, then find-or-open: a failed second step is retried by
		// asking again, and an open request for the branch is returned.
		if err := p.git.Push(ctx, p.checkout, p.made.Branch); err != nil {
			return nil, rep, provider.Failed("git push failed: %s", briefError(err))
		}
		rep["pushed"] = true
		opened, err := host.OpenFromBranch(ctx, codehost.Branch{Name: p.made.Branch, Base: st.Base, Title: a.Title, Body: a.Body})
		if err != nil {
			return nil, rep, fmt.Errorf("pushed %s, but opening the pull request failed: %w", p.made.Branch, err)
		}
		rep["pr"], rep["existed"] = opened.ID, opened.Existed
		return proto.OpenPRResult{PR: proto.OpenPRRef{ID: opened.ID, Key: opened.Key, URL: opened.URL}, Pushed: true,
			Existed: opened.Existed}, rep, nil
	})
}
