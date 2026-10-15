package proto

// #247 repositories on other floors (docs/protocol.md "Repositories on other
// floors"): the transcript composer's `@r:` lists the repositories and
// folders configured on the other floors of the worker's building
// (worker.repos, read-only). A shared switch, "Repositories from other
// buildings", lists the other buildings' floors too: it is in the snapshot
// (World.RepoRefs) and every change is a repo_refs.update event
// (RepoRefsUpdate: the fields of RepoRefs flat in it).

// Commands of the feature.
const (
	CmdWorkerRepos   = "worker.repos"
	CmdRepoRefsGet   = "repo_refs.get"
	CmdRepoRefsSet   = "repo_refs.set"
	EvRepoRefsUpdate = "repo_refs.update"
)

func init() { Commands = append(Commands, CmdWorkerRepos, CmdRepoRefsGet, CmdRepoRefsSet) }

// RepoRefs is the shared switch: repo_refs.get's and repo_refs.set's ack,
// World.RepoRefs, and flat in repo_refs.update.
type RepoRefs struct {
	// AllBuildings: worker.repos lists the floors of the other buildings
	// (and of the unassigned lot) too, after the worker's own building's.
	AllBuildings bool `json:"all_buildings"`
}

// RepoRefsUpdate is the repo_refs.update event.
type RepoRefsUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	RepoRefs
}

// RepoRefsSetArgs are the args of repo_refs.set.
type RepoRefsSetArgs struct {
	AllBuildings *bool `json:"all_buildings"`
}

// WorkerReposArgs are the args of worker.repos.
type WorkerReposArgs struct {
	ID string `json:"id"`
}

// WorkerRepos is worker.repos's ack: one row per repository (or folder),
// in display order: the other floors with a stored repo or folder (the
// worker's building's floors by index, then, with RepoRefs.AllBuildings,
// the other buildings' by sort and the unassigned lot by name), then (#54)
// the discovered repositories no floor names, by name. Never null.
type WorkerRepos struct {
	Repos []RepoRef `json:"repos"`
}

// Values of RepoRef.Source.
const (
	RepoSourceFloor      = "floor"
	RepoSourceDiscovered = "discovered"
)

// RepoRef is one row of worker.repos: a floor's stored settings.repo and
// settings.default_cwd (never the suggestions), or (#54) a repository
// discovered under the scan roots. A floor with only a folder is listed only
// when the folder exists. Rows for one repository merge into one (#54): the
// floors naming the same GitHub repository or folders in the same checkout,
// and a discovered checkout of it.
type RepoRef struct {
	// ID is the row's identity, stable across asks (opaque).
	ID string `json:"id"`
	// Source is RepoSourceFloor (Session is the floor it comes from) or
	// RepoSourceDiscovered (no floor names it: Session is absent).
	Source string `json:"source"`
	// Session is the floor's herdr session and Floor (#58) its floor id
	// (both absent for a discovered row).
	Session string `json:"session,omitempty"`
	Floor   string `json:"floor,omitempty"`
	// Building is the name of the floor's building (null: the unassigned
	// lot, or a discovered row). SameBuilding: it is the worker's own
	// building.
	Building     *string `json:"building"`
	SameBuilding bool    `json:"same_building"`
	// Repo is the GitHub "owner/repo" (absent: none).
	Repo string `json:"repo,omitempty"`
	// Dir is the folder a pick puts in (absent: none): the floor's folder,
	// or, when the floor has no usable checkout of Repo and one was
	// discovered, that checkout (the main one first, then by path).
	Dir string `json:"dir,omitempty"`
	// Cloned: Repo is set and Dir is a checkout of it (its origin, ignoring
	// case and a ".git" suffix; a subfolder counts).
	Cloned bool `json:"cloned"`
	// Checkouts is how many checkouts of the repository were discovered
	// (clones and worktrees; absent: none).
	Checkouts int `json:"checkouts,omitempty"`
}
