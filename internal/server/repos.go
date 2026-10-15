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
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/repodisc"
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
	h.startAsync(ctx, c, cmd, h.reposFor(workerFloor(w)))
	return nil
}

// reposFor is worker.repos's answer for a worker of a floor: the floors in
// scope and order and the discovered catalog now (hub goroutine), the
// folders checked and the two merged off it.
func (h *Hub) reposFor(floor string) func(context.Context) (any, error) {
	refs := h.repoCandidates(floor)
	stat := h.opts.StatDir
	var cat *repodisc.Catalog
	if h.opts.RepoDiscovery != nil {
		cat = h.opts.RepoDiscovery.Catalog()
	}
	return func(ctx context.Context) (any, error) {
		rows := resolveRepoRefs(ctx, refs, stat, h.cachedOrigin, repodisc.CheckoutRoot)
		return proto.WorkerRepos{Repos: mergeRepos(rows, cat)}, nil
	}
}

// repoCandidates are the floors worker.repos may list for a worker of
// session, in display order: the other floors of its building by index,
// then, with the switch on, the other buildings' floors by sort and the
// unassigned lot by name. Only the stored repo and folder count (never the
// suggestions); a floor with neither is left out.
func (h *Hub) repoCandidates(floor string) []proto.RepoRef {
	own := ""
	if a, ok := h.assign[floor]; ok {
		if _, ok := h.buildings[a.BuildingID]; ok {
			own = a.BuildingID
		}
	}
	add := func(out []proto.RepoRef, s string, building *string, same bool) []proto.RepoRef {
		st := h.settings[s]
		if s == floor || (st.Repo == "" && st.DefaultCwd == "") {
			return out
		}
		session := s
		if f := h.floors[s]; f != nil {
			session = f.session
		}
		return append(out, proto.RepoRef{Session: session, Floor: s, Building: building, SameBuilding: same, Repo: st.Repo,
			Dir: st.DefaultCwd})
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

// floorRepo is a floor's row checked: where its folder is.
type floorRepo struct {
	ref proto.RepoRef
	// root is the checkout the folder is in, canonical ("": none, or the
	// folder does not resolve).
	root string
	// gh is the GitHub repository of a folder-only floor's checkout ("":
	// none, or not looked up).
	gh string
}

// resolveRepoRefs checks every candidate's folder at once: a floor with a
// repo is cloned when its folder is a checkout of it; a floor with only a
// folder is dropped when the folder does not exist. root finds the
// checkout a folder is in (repodisc.CheckoutRoot); a folder-only floor's
// checkout's origin is looked up too, so it merges with a floor naming the
// same repository.
func resolveRepoRefs(ctx context.Context, refs []proto.RepoRef, stat func(string) error, origin func(context.Context, string) string,
	root func(string) string) []floorRepo {
	rows := make([]floorRepo, len(refs))
	keep := make([]bool, len(refs))
	var wg sync.WaitGroup
	for i := range refs {
		wg.Add(1)
		go func(f *floorRepo) {
			defer wg.Done()
			f.ref = refs[i]
			r := &f.ref
			if r.Dir != "" {
				f.root = root(r.Dir)
			}
			if r.Repo == "" {
				keep[i] = stat(r.Dir) == nil
				if keep[i] && f.root != "" {
					f.gh = lookupRepo(ctx, f.root, origin, repoLookupTimeout)
				}
				return
			}
			keep[i] = true
			r.Cloned = repoCloned(ctx, r.Dir, r.Repo, stat, origin, repoLookupTimeout)
		}(&rows[i])
	}
	wg.Wait()
	out := make([]floorRepo, 0, len(refs))
	for i, r := range rows {
		if keep[i] {
			out = append(out, r)
		}
	}
	return out
}

// mergeRepos is worker.repos's rows: the floors' (in their order) and the
// discovered repositories', one row per repository. A floor's identity is
// its GitHub repository; a folder-only floor's, the discovered repository
// of the checkout it is in, else that checkout's GitHub repository, else
// the checkout, else the folder. The floors that share one are one row at
// the first one's place, offering the first of them (in floor order) with
// a usable folder (a checkout of its repo, or an existing folder), else the
// discovered checkout (main first, then by path), else the GitHub address.
// The discovered repositories no floor names follow, by name.
func mergeRepos(floors []floorRepo, cat *repodisc.Catalog) []proto.RepoRef {
	type group struct {
		id     string
		floors []floorRepo
	}
	var groups []*group
	byID := map[string]*group{}
	for _, f := range floors {
		id := floorRepoID(f, cat)
		g := byID[id]
		if g == nil {
			g = &group{id: id}
			byID[id] = g
			groups = append(groups, g)
		}
		g.floors = append(g.floors, f)
	}
	out := make([]proto.RepoRef, 0, len(groups)+cat.Len())
	for _, g := range groups {
		disc, found := cat.Repo(g.id)
		var win *floorRepo
		for i := range g.floors {
			if f := &g.floors[i]; f.ref.Repo == "" || f.ref.Cloned {
				win = f
				break
			}
		}
		from := &g.floors[0]
		if win != nil {
			from = win
		}
		row := from.ref
		row.ID, row.Source = g.id, proto.RepoSourceFloor
		if row.Repo == "" { // a folder-only floor: the repository the others or the scan name
			for _, f := range g.floors {
				if f.ref.Repo != "" {
					row.Repo = f.ref.Repo
					break
				}
			}
			if row.Repo == "" && found {
				row.Repo = disc.GitHub
			}
			if row.Repo == "" && from.gh != "" {
				row.Repo = from.gh
			}
			row.Cloned = row.Repo != "" && from.root != ""
		}
		if win == nil && found {
			row.Dir, row.Cloned = disc.Path(), row.Repo != ""
		}
		if found {
			row.Checkouts = len(disc.Checkouts)
		}
		out = append(out, row)
	}
	for _, r := range cat.List() {
		if byID[r.ID] != nil {
			continue
		}
		out = append(out, proto.RepoRef{ID: r.ID, Source: proto.RepoSourceDiscovered, Repo: r.GitHub, Dir: r.Path(), Cloned: r.GitHub != "",
			Checkouts: len(r.Checkouts)})
	}
	return out
}

// floorRepoID is a floor row's repository identity (mergeRepos).
func floorRepoID(f floorRepo, cat *repodisc.Catalog) string {
	switch {
	case f.ref.Repo != "":
		return repodisc.GitHubID(f.ref.Repo)
	case f.root != "":
		if r, ok := cat.ByPath(f.root); ok {
			return r.ID
		}
		if f.gh != "" {
			return repodisc.GitHubID(f.gh)
		}
		return "checkout:" + f.root
	}
	dir := f.ref.Dir
	if p, err := filepath.EvalSymlinks(dir); err == nil {
		dir = p
	}
	return "dir:" + filepath.Clean(dir)
}

// lookupRepo is the GitHub repository of dir's origin, "" when it has
// none or the lookup does not answer within timeout (it is still cached).
func lookupRepo(ctx context.Context, dir string, origin func(context.Context, string) string, timeout time.Duration) string {
	got := make(chan string, 1)
	go func() { got <- origin(ctx, dir) }()
	t := time.NewTimer(timeout)
	defer t.Stop()
	select {
	case o := <-got:
		return strings.TrimSuffix(strings.TrimSpace(o), ".git")
	case <-t.C:
		return ""
	case <-ctx.Done():
		return ""
	}
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
