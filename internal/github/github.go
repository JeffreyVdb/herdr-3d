// Package github is the GitHub provider of the bridge's neutral interfaces:
// GitHub Issues (with a Projects v2 Status column list, when a project is
// configured) as a tracker.Tracker and pull requests as a codehost.Host,
// through the typed gh runner (internal/githubcli). Both are served from one
// feed query per repository and project, shared by the floors that link the
// same ones. GraphQL node ids, project, field and option ids and head oids
// never leave this package: an item's id outside it is "<owner>/<repo>#<n>".
package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// ProviderID and ProviderName identify this provider on the wire.
const (
	ProviderID   = "github"
	ProviderName = "GitHub"
)

// DefaultStatusField is the project field the columns come from.
const DefaultStatusField = "Status"

// feedTTL is how long a feed is reused by the second board of the same
// poll (and by floors that link the same repository).
const feedTTL = 2 * time.Second

// Config is what a floor links: its repository, and optionally a project.
type Config struct {
	Repo          string // owner/repo
	ProjectOwner  string
	ProjectNumber int // 0: no project
	StatusField   string
}

// Key identifies a fetch: floors with the same key share it.
func (c Config) Key() string {
	return fmt.Sprintf("github:%s|%s#%d|%s", strings.ToLower(c.Repo), strings.ToLower(c.ProjectOwner), c.ProjectNumber,
		strings.ToLower(c.field()))
}

func (c Config) field() string {
	if c.StatusField == "" {
		return DefaultStatusField
	}
	return c.StatusField
}

// Registry hands out the trackers and hosts of floors, sharing a source per
// repository and project.
type Registry struct {
	cli *githubcli.Client
	now func() time.Time

	mu      sync.Mutex
	sources map[string]*source
}

// NewRegistry makes a registry that runs its calls through cli. now is the
// clock (nil: time.Now).
func NewRegistry(cli *githubcli.Client, now func() time.Time) *Registry {
	if now == nil {
		now = time.Now
	}
	return &Registry{cli: cli, now: now, sources: map[string]*source{}}
}

// For returns the tracker and the host of a floor's link.
func (r *Registry) For(cfg Config) (tracker.Tracker, codehost.Host) {
	key := cfg.Key()
	r.mu.Lock()
	s := r.sources[key]
	if s == nil {
		s = &source{cfg: cfg, cli: r.cli, now: r.now, nodes: map[string]string{}}
		r.sources[key] = s
	}
	r.mu.Unlock()
	return &issues{s}, &requests{s}
}

// source is one repository (and project): the shared fetch, and the node
// ids seen so far.
type source struct {
	cfg Config
	cli *githubcli.Client
	now func() time.Time

	fetch sync.Mutex // one feed at a time; the second caller reuses it
	last  *feed

	mu    sync.Mutex
	nodes map[string]string // item id → GraphQL node id
}

func (s *source) owner() string    { o, _, _ := strings.Cut(s.cfg.Repo, "/"); return o }
func (s *source) repoName() string { _, r, _ := strings.Cut(s.cfg.Repo, "/"); return r }
func (s *source) hasProject() bool { return s.cfg.ProjectNumber > 0 }
func (s *source) statusField() string {
	return s.cfg.field()
}

// itemID is the id of number in repo (a repository name as GitHub spells
// it): the floor's own repository keeps the spelling it was linked with.
func (s *source) itemID(repo string, number int) string {
	if strings.EqualFold(repo, s.cfg.Repo) {
		repo = s.cfg.Repo
	}
	return repo + "#" + strconv.Itoa(number)
}

// parseID splits an id of this repository; repo is "" for another one.
func (s *source) parseID(id string) (repo string, number int, ok bool) {
	r, n, found := strings.Cut(id, "#")
	if !found {
		return "", 0, false
	}
	num, err := strconv.Atoi(n)
	if err != nil || num < 1 || strconv.Itoa(num) != n {
		return "", 0, false
	}
	if !strings.EqualFold(r, s.cfg.Repo) {
		return "", num, true
	}
	return s.cfg.Repo, num, true
}

// own parses an id that must belong to this repository.
func (s *source) own(id string) (int, error) {
	repo, n, ok := s.parseID(id)
	if !ok || repo == "" {
		return 0, provider.Errorf(provider.ErrNotFound, "%q is not on %s", id, s.cfg.Repo)
	}
	return n, nil
}

func (s *source) remember(node, id string) {
	s.mu.Lock()
	s.nodes[id] = node
	s.mu.Unlock()
}

func (s *source) trackerCaps() tracker.Capabilities {
	return tracker.Capabilities{Comment: true, Close: true, SetStatus: s.hasProject()}
}

// feed returns the feed of this poll: a recent one that covers watched, else
// a fresh one.
func (s *source) feed(ctx context.Context, watched []string) (*feed, error) {
	s.fetch.Lock()
	defer s.fetch.Unlock()
	if f := s.last; f != nil && s.now().Sub(f.fetchedAt) < feedTTL && !s.now().Before(f.fetchedAt) {
		covered := true
		for _, id := range watched {
			covered = covered && f.watched[id]
		}
		if covered {
			return f, nil
		}
	}
	f, err := s.fetchFeed(ctx, watched)
	if err != nil {
		return nil, err
	}
	s.last = f
	return f, nil
}

// changed forgets the last feed: a write made it stale.
func (s *source) changed() {
	s.fetch.Lock()
	s.last = nil
	s.fetch.Unlock()
}

// lastFeed is the last feed, if any (for a card's column, and node ids).
func (s *source) lastFeed() *feed {
	s.fetch.Lock()
	defer s.fetch.Unlock()
	return s.last
}

// query runs a document and decodes its data into out. A NOT_FOUND
// GraphQL error is provider.ErrNotFound, other GraphQL errors are failures
// (the caller reads the ones it expects from the Response instead: see
// call).
func (s *source) query(ctx context.Context, doc githubcli.Doc, vars map[string]any, out any) error {
	resp, err := s.call(ctx, doc, vars)
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(resp.Data, out); err != nil {
		return provider.Failed("GitHub: unreadable answer")
	}
	return nil
}

// call runs a document and maps its GraphQL errors.
func (s *source) call(ctx context.Context, doc githubcli.Doc, vars map[string]any) (*githubcli.Response, error) {
	resp, err := s.cli.Query(ctx, doc, vars)
	if err != nil {
		return nil, err
	}
	if len(resp.Errors) > 0 {
		e := resp.Errors[0]
		switch e.Type {
		case "NOT_FOUND":
			return nil, provider.Errorf(provider.ErrNotFound, "GitHub: %s", clip(e.Message))
		case "UNPROCESSABLE":
			if strings.Contains(e.Message, "Head branch was modified") {
				return nil, provider.Errorf(provider.ErrStale, "the head branch moved: %s", clip(e.Message))
			}
		}
		return nil, provider.Failed("GitHub: %s", clip(e.Message))
	}
	return resp, nil
}

func isKind(err, kind error) bool { return errors.Is(err, kind) }

func itoa(n int) string { return strconv.Itoa(n) }
