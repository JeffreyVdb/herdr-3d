package repodisc

import (
	"path/filepath"
	"slices"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
)

// Checkout is one working checkout a scan found and git confirmed.
type Checkout struct {
	// Path is the checkout's top level, canonical (no symlink in it).
	Path string
	// Common is its Git common directory, canonical: every worktree of one
	// repository shares it.
	Common string
	// Main: the checkout is its repository's main one (Common is its own
	// .git), not a linked worktree.
	Main bool
	// Origin is the URL of its origin remote ("" when it has none).
	Origin string
	// GitHub is the "owner/repo" of a GitHub origin ("" for none or for
	// another host).
	GitHub string
}

// newCheckout fills Main and GitHub from the rest.
func newCheckout(path, common, origin string) Checkout {
	gh, _ := gitremote.ParseGitHub(origin)
	return Checkout{Path: path, Common: common, Main: common == filepath.Join(path, ".git"), Origin: origin, GitHub: gh}
}

// Repo is one repository identity: the checkouts that share a Git common
// directory (worktrees) or a GitHub origin (clones, whatever the remote's
// spelling: ssh or https, case, a ".git" suffix). Checkouts that share
// neither stay apart, even with the same folder name.
type Repo struct {
	// ID is stable across scans: GitHubID of its GitHub repository, else
	// "git:" and its (first) common directory.
	ID string
	// GitHub is its "owner/repo" as an origin spells it ("": none).
	GitHub string
	// Checkouts: the main checkouts first, then by path. The first is the
	// one a pick puts in when no floor names another.
	Checkouts []Checkout
}

// Path is the checkout a pick puts in.
func (r Repo) Path() string { return r.Checkouts[0].Path }

// Name is what the repository is called: its GitHub name, else the
// chosen checkout's folder name.
func (r Repo) Name() string {
	if _, name, ok := strings.Cut(r.GitHub, "/"); ok {
		return name
	}
	return filepath.Base(r.Path())
}

// GitHubID is the identity of a GitHub "owner/repo" (GitHub ignores case).
func GitHubID(repo string) string { return "gh:" + strings.ToLower(repo) }

// Catalog is an immutable snapshot of the discovered repositories. A nil
// Catalog is empty.
type Catalog struct {
	// Revision changes whenever the repositories do (0: none found yet).
	Revision uint64
	// Repos by name (case-insensitively), then ID.
	Repos []Repo

	byID   map[string]int
	byPath map[string]int
}

// NewCatalog groups checkouts into repositories (duplicate paths count
// once).
func NewCatalog(revision uint64, checkouts []Checkout) *Catalog {
	seen := map[string]bool{}
	var cos []Checkout
	for _, c := range checkouts {
		if !seen[c.Path] {
			seen[c.Path] = true
			cos = append(cos, c)
		}
	}
	// Union-find over the checkouts, joined by common directory and by
	// GitHub repository.
	parent := make([]int, len(cos))
	for i := range parent {
		parent[i] = i
	}
	var find func(int) int
	find = func(i int) int {
		if parent[i] != i {
			parent[i] = find(parent[i])
		}
		return parent[i]
	}
	join := func(a, b int) { parent[find(a)] = find(b) }
	first := map[string]int{}
	for i, c := range cos {
		keys := []string{"git:" + c.Common}
		if c.GitHub != "" {
			keys = append(keys, GitHubID(c.GitHub))
		}
		for _, k := range keys {
			if j, ok := first[k]; ok {
				join(i, j)
			} else {
				first[k] = i
			}
		}
	}
	groups := map[int][]Checkout{}
	for i, c := range cos {
		groups[find(i)] = append(groups[find(i)], c)
	}
	cat := &Catalog{Revision: revision, byID: map[string]int{}, byPath: map[string]int{}}
	for _, g := range groups {
		slices.SortFunc(g, func(a, b Checkout) int {
			if a.Main != b.Main {
				if a.Main {
					return -1
				}
				return 1
			}
			return strings.Compare(a.Path, b.Path)
		})
		r := Repo{Checkouts: g}
		var gh, common []string
		for _, c := range g {
			common = append(common, c.Common)
			if c.GitHub != "" {
				gh = append(gh, GitHubID(c.GitHub))
				if r.GitHub == "" {
					r.GitHub = c.GitHub
				}
			}
		}
		if len(gh) > 0 {
			r.ID = slices.Min(gh)
		} else {
			r.ID = "git:" + slices.Min(common)
		}
		cat.Repos = append(cat.Repos, r)
	}
	slices.SortFunc(cat.Repos, func(a, b Repo) int {
		if c := strings.Compare(strings.ToLower(a.Name()), strings.ToLower(b.Name())); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	for i, r := range cat.Repos {
		cat.byID[r.ID] = i
		for _, c := range r.Checkouts {
			cat.byPath[c.Path] = i
		}
	}
	return cat
}

// Repo is the repository with id.
func (c *Catalog) Repo(id string) (Repo, bool) {
	if c == nil {
		return Repo{}, false
	}
	i, ok := c.byID[id]
	if !ok {
		return Repo{}, false
	}
	return c.Repos[i], true
}

// ByPath is the repository of the checkout whose top level is path
// (canonical).
func (c *Catalog) ByPath(path string) (Repo, bool) {
	if c == nil {
		return Repo{}, false
	}
	i, ok := c.byPath[path]
	if !ok {
		return Repo{}, false
	}
	return c.Repos[i], true
}

// Len is the number of repositories.
func (c *Catalog) Len() int {
	if c == nil {
		return 0
	}
	return len(c.Repos)
}

// Checkouts is the number of checkouts.
func (c *Catalog) Checkouts() int {
	if c == nil {
		return 0
	}
	return len(c.byPath)
}

// List is the repositories (nil: none).
func (c *Catalog) List() []Repo {
	if c == nil {
		return nil
	}
	return c.Repos
}
