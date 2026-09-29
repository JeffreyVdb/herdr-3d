package server

import (
	"context"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// suggestTTL is how often a floor's cwds are looked up again when they did
// not change (the resolver caches per cwd for as long).
const suggestTTL = 5 * time.Minute

// suggestJob asks for the GitHub repos of a floor's cwds.
type suggestJob struct {
	session string
	cwds    []string
}

// askOrigins queues a lookup of the floor's cwds when they changed since the
// last one, or it is older than suggestTTL. Never blocks: a full queue is
// retried at the next observation.
func (h *Hub) askOrigins(session string, f *floorState) {
	if h.opts.RepoOf == nil {
		return
	}
	var cwds []string
	for _, id := range f.order {
		if w := h.workers[id]; w != nil && w.Cwd != "" && !slices.Contains(cwds, w.Cwd) {
			cwds = append(cwds, w.Cwd)
		}
	}
	now := h.opts.Now()
	if slices.Equal(cwds, f.askedCwds) && f.askedAt.Add(suggestTTL).After(now) {
		return
	}
	select {
	case h.suggest <- suggestJob{session: session, cwds: cwds}:
		f.askedCwds, f.askedAt = cwds, now
	default:
	}
}

// suggester resolves lookups off the hub goroutine and hands the answers
// back through do.
func (h *Hub) suggester(ctx context.Context) {
	defer h.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-h.suggest:
			origins := make(map[string]string, len(job.cwds))
			for _, cwd := range job.cwds {
				if repo := h.opts.RepoOf(ctx, cwd); repo != "" {
					origins[cwd] = repo
				}
			}
			if ctx.Err() != nil {
				return
			}
			_ = h.do(ctx, func(context.Context) {
				f := h.floors[job.session]
				if f == nil {
					return
				}
				f.origins = origins
				h.refreshSuggested(job.session, f)
				h.syncLayout()
				h.relink() // M6 runs: the floor's repo may have changed
			})
		}
	}
}

// refreshSuggested recomputes a floor's suggestion (the floor view shows it
// at the next syncLayout).
func (h *Hub) refreshSuggested(session string, f *floorState) {
	f.suggested = h.suggestion(session, f)
}

// suggestion is the most common GitHub repo among the floor's workers' cwds
// (ties: the first in sidebar order), and the root checkout of the first
// worker of the effective repo (the setting, else the suggestion).
func (h *Hub) suggestion(session string, f *floorState) *proto.Suggested {
	counts, first := map[string]int{}, map[string]int{}
	for i, id := range f.order {
		w := h.workers[id]
		if w == nil {
			continue
		}
		repo := f.origins[w.Cwd]
		if repo == "" {
			continue
		}
		if _, ok := first[repo]; !ok {
			first[repo] = i
		}
		counts[repo]++
	}
	best := ""
	for repo, n := range counts {
		if best == "" || n > counts[best] || (n == counts[best] && first[repo] < first[best]) {
			best = repo
		}
	}
	effective := h.settings[session].Repo
	if effective == "" {
		effective = best
	}
	s := proto.Suggested{Repo: best}
	for _, id := range f.order {
		if w := h.workers[id]; w != nil && effective != "" && f.origins[w.Cwd] == effective && w.Worktree != nil && w.Worktree.RepoRoot != "" {
			s.DefaultCwd = w.Worktree.RepoRoot
			break
		}
	}
	if s == (proto.Suggested{}) {
		return nil
	}
	return &s
}
