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

// WorkerRepos is worker.repos's ack: the other floors with a stored repo or
// folder, in display order (the worker's building's floors by index, then,
// with RepoRefs.AllBuildings, the other buildings' by sort and the
// unassigned lot by name). Never null.
type WorkerRepos struct {
	Repos []RepoRef `json:"repos"`
}

// RepoRef is one floor of worker.repos: its stored settings.repo and
// settings.default_cwd (never the suggestions). A floor with only a folder
// is listed only when the folder exists.
type RepoRef struct {
	Session string `json:"session"`
	// Building is the name of the floor's building (null: the unassigned
	// lot). SameBuilding: it is the worker's own building.
	Building     *string `json:"building"`
	SameBuilding bool    `json:"same_building"`
	// Repo is the floor's GitHub "owner/repo" (absent: none).
	Repo string `json:"repo,omitempty"`
	// Dir is the floor's folder (absent: none).
	Dir string `json:"dir,omitempty"`
	// Cloned: Repo is set and Dir exists and is a checkout of it (its
	// origin, ignoring case and a ".git" suffix; a subfolder counts).
	Cloned bool `json:"cloned"`
}
