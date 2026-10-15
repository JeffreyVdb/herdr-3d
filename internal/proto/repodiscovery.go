package proto

// #54 repository discovery (docs/protocol.md "Repository discovery"): the
// bridge scans folders on its host for Git checkouts (scan roots) and
// merges what it finds into worker.repos and hire.repos (RepoRef.Source
// "discovered"). The roots and the refresh interval are bridge-wide
// settings: in the snapshot (World.RepoDiscovery, absent when the bridge
// cannot scan), changed with repo_discovery.set, and every change of them
// or of the scan's status is a repo_discovery.update event (the fields of
// RepoDiscovery flat in it). Status.Revision changes only when the
// discovered repositories do: a client that lists them asks again then.

// Commands and the event of the feature.
const (
	CmdRepoDiscoveryGet     = "repo_discovery.get"
	CmdRepoDiscoverySet     = "repo_discovery.set"
	CmdRepoDiscoveryRefresh = "repo_discovery.refresh"
	EvRepoDiscoveryUpdate   = "repo_discovery.update"
)

func init() {
	Commands = append(Commands, CmdRepoDiscoveryGet, CmdRepoDiscoverySet, CmdRepoDiscoveryRefresh)
}

// Limits of the settings.
const (
	// RepoDiscoveryDefaultInterval is the refresh interval, in minutes,
	// until one is set.
	RepoDiscoveryDefaultInterval = 10
	// RepoDiscoveryMaxInterval is the longest interval (a day).
	RepoDiscoveryMaxInterval = 24 * 60
	// RepoDiscoveryMaxRoots bounds the scan roots.
	RepoDiscoveryMaxRoots = 32
	// RepoDiscoveryMaxRoot bounds one root's length in bytes.
	RepoDiscoveryMaxRoot = 4096
)

// Values of RepoDiscoveryStatus.State.
const (
	RepoDiscoveryOff      = "off" // no roots: discovery is off
	RepoDiscoveryIdle     = "idle"
	RepoDiscoveryScanning = "scanning"
)

// Values of RepoDiscoveryRoot.State.
const (
	RepoRootPending = "pending" // not scanned yet
	RepoRootOK      = "ok"
	RepoRootStale   = "stale" // the last scan of it failed: its previous result is kept
	RepoRootError   = "error" // it failed and was never scanned successfully
)

// RepoDiscovery is the settings and the scan's status: repo_discovery.get's,
// .set's and .refresh's ack, World.RepoDiscovery, and flat in
// repo_discovery.update.
type RepoDiscovery struct {
	// Roots are the absolute folders on the bridge host that are scanned,
	// as set (cleaned). Never null; empty: discovery is off.
	Roots []string `json:"roots"`
	// IntervalMinutes is how often they are scanned again.
	IntervalMinutes int                 `json:"interval_minutes"`
	Status          RepoDiscoveryStatus `json:"status"`
}

// RepoDiscoveryStatus is how the scans are doing.
type RepoDiscoveryStatus struct {
	State string `json:"state"`
	// Revision changes whenever the discovered repositories do.
	Revision uint64 `json:"revision"`
	// Repositories and Checkouts are what is discovered now (a repository
	// can have several checkouts: clones and worktrees).
	Repositories int `json:"repositories"`
	Checkouts    int `json:"checkouts"`
	// LastScanAt is when the last scan ended (unix ms; null: none has),
	// LastSuccessAt when the last one with no root failing did.
	LastScanAt    *int64 `json:"last_scan_at"`
	LastSuccessAt *int64 `json:"last_success_at"`
	// LastDurationMS is how long the last scan took.
	LastDurationMS *int64 `json:"last_duration_ms,omitempty"`
	// NextScanAt is when the next scheduled scan starts (unix ms; absent:
	// off or scanning).
	NextScanAt *int64 `json:"next_scan_at,omitempty"`
	// Progress is the scan in flight's (absent: none).
	Progress *RepoDiscoveryProgress `json:"progress,omitempty"`
	// Roots are the roots' own states, in the order of RepoDiscovery.Roots.
	Roots []RepoDiscoveryRoot `json:"roots"`
}

// RepoDiscoveryProgress is where a scan is: walking the roots' folders
// (Done of Total roots), then checking the checkouts found with git.
type RepoDiscoveryProgress struct {
	Phase string `json:"phase"` // "walking" or "checking"
	Done  int    `json:"done"`
	Total int    `json:"total"`
}

// RepoDiscoveryRoot is one root's state.
type RepoDiscoveryRoot struct {
	Path string `json:"path"`
	// Canonical is the folder Path resolves to, when it is another (a
	// symlink).
	Canonical string `json:"canonical,omitempty"`
	State     string `json:"state"`
	// Error is why its last scan failed (pending and ok: absent).
	Error string `json:"error,omitempty"`
	// Warning is what its last successful scan could not look at (folders
	// it could not read).
	Warning string `json:"warning,omitempty"`
	// Checkouts is how many checkouts it has in the catalog.
	Checkouts int `json:"checkouts"`
	// LastSuccessAt is when it was last scanned successfully (unix ms;
	// null: never).
	LastSuccessAt *int64 `json:"last_success_at"`
}

// RepoDiscoveryUpdate is the repo_discovery.update event.
type RepoDiscoveryUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	RepoDiscovery
}

// RepoDiscoverySetArgs are the args of repo_discovery.set: either may be
// left out to keep it.
type RepoDiscoverySetArgs struct {
	Roots           *[]string `json:"roots"`
	IntervalMinutes *int      `json:"interval_minutes"`
}
