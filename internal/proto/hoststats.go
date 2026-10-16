package proto

// #74 server rack: the bridge host's CPU, memory, pending updates and disk
// activity, sampled only while a game watches (docs/protocol.md "Host
// stats"). host.stats and host.disk are connection messages (no seq, never
// replayed), sent to the connections that sent host.watch.

// Messages of the host stats.
const (
	THostStats = "host.stats"
	THostDisk  = "host.disk"
)

// Commands of the host stats (no args; idempotent per connection).
const (
	CmdHostWatch   = "host.watch"
	CmdHostUnwatch = "host.unwatch"
)

func init() { Commands = append(Commands, CmdHostWatch, CmdHostUnwatch) }

// HostStats is one sample of the bridge host, every 5 s while watched.
type HostStats struct {
	T string `json:"t"`
	// CPUPct is the share of CPU time in use across all cores, in percent,
	// null until two samples exist.
	CPUPct        *float64 `json:"cpu_pct"`
	CPUs          int      `json:"cpus"`
	Load1         float64  `json:"load1"`
	MemUsedPct    float64  `json:"mem_used_pct"`
	MemUsedBytes  uint64   `json:"mem_used_bytes"`
	MemTotalBytes uint64   `json:"mem_total_bytes"`
	// SampledAt is RFC 3339, UTC.
	SampledAt string `json:"sampled_at"`
	// Updates is absent on a host that is not Arch-based (or has no
	// checkupdates and fakeroot), and until a check has worked.
	Updates *HostUpdates `json:"updates,omitempty"`
}

// HostUpdates is the last good count of pending pacman updates.
type HostUpdates struct {
	Count int `json:"count"`
	// CheckedAt is RFC 3339, UTC: when that count was taken.
	CheckedAt string `json:"checked_at"`
}

// HostDisk is the physical disks' activity over the last second, sent every
// second while watched.
type HostDisk struct {
	T string `json:"t"`
	// Disks is never null: [] when no physical disk is found.
	Disks []HostDiskRate `json:"disks"`
}

// HostDiskRate is one disk's activity, per second over the last interval.
type HostDiskRate struct {
	Name  string  `json:"name"`
	RIOPS float64 `json:"r_iops"`
	WIOPS float64 `json:"w_iops"`
	RBps  float64 `json:"r_bps"`
	WBps  float64 `json:"w_bps"`
}
