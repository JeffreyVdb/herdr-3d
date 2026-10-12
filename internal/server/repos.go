package server

// #247 repositories on other floors (docs/protocol.md "Repositories on other
// floors"): worker.repos lists the repos and folders stored on the other
// floors of the worker's building (and, with the shared repo_refs switch,
// of every building), for the composer's `@r:`. The scope and order are
// decided on the hub goroutine; whether a floor's folder is a checkout of
// its repo (a stat and an origin lookup) off it, each lookup bounded and
// cached briefly, failing open: a lookup that fails is "not cloned", never
// an error for the whole list.

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

const (
	// repoOriginTTL is how long a folder's origin is reused by worker.repos
	// (the popup asks once per opening; a clone shows up after it).
	repoOriginTTL = 30 * time.Second
	// repoLookupTimeout bounds one origin lookup: past it, the folder is not
	// a checkout for this answer (the lookup's own answer is still cached).
	repoLookupTimeout = 3 * time.Second
)

// repoRefsState is the hub's part of the feature: the switch (hub
// goroutine) and the origin cache (any goroutine, under mu).
type repoRefsState struct {
	all bool

	mu      sync.Mutex
	origins map[string]originRead // folder → its origin, as last read
}

type originRead struct {
	repo string
	at   time.Time
}

// initRepoRefs loads the switch (NewHub).
func (h *Hub) initRepoRefs(ctx context.Context) error {
	all, err := h.st.LoadRepoRefs(ctx)
	if err != nil {
		return err
	}
	h.rr.all = all
	h.rr.origins = map[string]originRead{}
	return nil
}

// repoRefsView is the switch for the snapshot and the acks.
func (h *Hub) repoRefsView() *proto.RepoRefs { return &proto.RepoRefs{AllBuildings: h.rr.all} }

// startRepoRefs answers repo_refs.get and repo_refs.set (on the hub
// goroutine: one row). A change is published (repo_refs.update) before the
// ack.
func (h *Hub) startRepoRefs(ctx context.Context, c *Client, cmd proto.Command) error {
	if cmd.T == proto.CmdRepoRefsSet {
		var a proto.RepoRefsSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if a.AllBuildings == nil {
			return bad("all_buildings is required")
		}
		if err := h.st.SaveRepoRefs(ctx, *a.AllBuildings); err != nil {
			return err
		}
		if *a.AllBuildings != h.rr.all {
			h.rr.all = *a.AllBuildings
			h.seq++
			msg := mustJSON(proto.RepoRefsUpdate{T: proto.EvRepoRefsUpdate, Seq: h.seq, RepoRefs: *h.repoRefsView()})
			h.ring.add(h.seq, msg)
			for cl := range h.clients {
				h.deliver(cl, msg)
			}
		}
	} else if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
		return err
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, *h.repoRefsView(), nil)
	return nil
}

// startWorkerRepos answers worker.repos: the floors in scope and order now,
// their folders checked off the hub goroutine.
func (h *Hub) startWorkerRepos(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerReposArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	w := h.workers[a.ID]
	if w == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
	}
	refs := h.repoCandidates(w.Session)
	stat := h.opts.StatDir
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		return proto.WorkerRepos{Repos: resolveRepoRefs(ctx, refs, stat, h.cachedOrigin)}, nil
	})
	return nil
}

// repoCandidates are the floors worker.repos may list for a worker of
// session, in display order: the other floors of its building by index,
// then, with the switch on, the other buildings' floors by sort and the
// unassigned lot by name. Only the stored repo and folder count (never the
// suggestions); a floor with neither is left out.
func (h *Hub) repoCandidates(session string) []proto.RepoRef {
	own := ""
	if a, ok := h.assign[session]; ok {
		if _, ok := h.buildings[a.BuildingID]; ok {
			own = a.BuildingID
		}
	}
	add := func(out []proto.RepoRef, s string, building *string, same bool) []proto.RepoRef {
		st := h.settings[s]
		if s == session || (st.Repo == "" && st.DefaultCwd == "") {
			return out
		}
		return append(out, proto.RepoRef{Session: s, Building: building, SameBuilding: same, Repo: st.Repo, Dir: st.DefaultCwd})
	}
	var same, other []proto.RepoRef
	placed := map[string]bool{}
	for _, b := range h.buildingViews() {
		name := b.Name
		for _, s := range b.Floors {
			placed[s] = true
			if own != "" && b.ID == own {
				same = add(same, s, &name, true)
			} else if h.rr.all {
				other = add(other, s, &name, false)
			}
		}
	}
	if h.rr.all {
		for _, s := range sortedFloors(h.floors) {
			if !placed[s] {
				other = add(other, s, nil, false)
			}
		}
	}
	return append(same, other...)
}

// resolveRepoRefs checks every candidate's folder at once: a floor with a
// repo is cloned when its folder is a checkout of it; a floor with only a
// folder is dropped when the folder does not exist.
func resolveRepoRefs(ctx context.Context, refs []proto.RepoRef, stat func(string) error, origin func(context.Context, string) string) []proto.RepoRef {
	keep := make([]bool, len(refs))
	var wg sync.WaitGroup
	for i := range refs {
		wg.Add(1)
		go func(r *proto.RepoRef) {
			defer wg.Done()
			if r.Repo == "" {
				keep[i] = stat(r.Dir) == nil
				return
			}
			keep[i] = true
			r.Cloned = repoCloned(ctx, r.Dir, r.Repo, stat, origin, repoLookupTimeout)
		}(&refs[i])
	}
	wg.Wait()
	out := make([]proto.RepoRef, 0, len(refs))
	for i, r := range refs {
		if keep[i] {
			out = append(out, r)
		}
	}
	return out
}

// repoCloned reports whether dir exists and its GitHub origin is repo
// (ignoring case and a ".git" suffix; git finds the origin from a subfolder
// of the checkout too). A lookup that fails or does not answer within
// timeout is not a checkout.
func repoCloned(ctx context.Context, dir, repo string, stat func(string) error, origin func(context.Context, string) string, timeout time.Duration) bool {
	if repo == "" || dir == "" || stat(dir) != nil {
		return false
	}
	// The lookup keeps ctx (not the timeout): one that answers late is still
	// cached for the next ask.
	got := make(chan string, 1)
	go func() { got <- origin(ctx, dir) }()
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case o := <-got:
		norm := func(s string) string { return strings.TrimSuffix(strings.TrimSpace(s), ".git") }
		return o != "" && strings.EqualFold(norm(o), norm(repo))
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// cachedOrigin is Options.RepoOf, reused for repoOriginTTL (nil RepoOf: no
// folder has an origin).
func (h *Hub) cachedOrigin(ctx context.Context, dir string) string {
	if h.opts.RepoOf == nil {
		return ""
	}
	now := h.opts.Now()
	h.rr.mu.Lock()
	r, ok := h.rr.origins[dir]
	h.rr.mu.Unlock()
	if ok && now.Sub(r.at) < repoOriginTTL {
		return r.repo
	}
	repo := h.opts.RepoOf(ctx, dir)
	if ctx.Err() != nil {
		return repo // cut short: not kept
	}
	h.rr.mu.Lock()
	h.rr.origins[dir] = originRead{repo: repo, at: now}
	h.rr.mu.Unlock()
	return repo
}
