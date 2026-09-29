package proto

// M10 limits: the Claude and Codex plan limits (5-hour and weekly windows),
// read by the bridge from the two CLIs. limits.update is an ordinary event
// (seq, replay ring) with the fields of Limits flat in it; the snapshot
// carries the latest of each provider in World.Limits.

// EvLimitsUpdate carries one provider's limits (the fields of Limits).
const EvLimitsUpdate = "limits.update"

// CmdLimitsRefresh asks the bridge to read the limits now.
const CmdLimitsRefresh = "limits.refresh"

func init() { Commands = append(Commands, CmdLimitsRefresh) }

// Providers of limits.
const (
	LimitsClaude = "claude"
	LimitsCodex  = "codex"
)

// Where a reading came from (Limits.Source).
const (
	LimitsProbe      = "probe"      // the CLI answered
	LimitsTranscript = "transcript" // the last rate_limits a Codex rollout recorded, at Limits.At
)

// Limits.Error values.
const (
	LimitsNoPlan       = "no_plan"       // no plan limits: an API key, or signed out
	LimitsNotInstalled = "not_installed" // the CLI is not on the bridge's PATH
	LimitsTimeout      = "timeout"       // the CLI did not answer in time
	LimitsFailed       = "failed"        // any other failure (details are in the bridge's log)
)

// Limits is one provider's plan limits as of At.
type Limits struct {
	Provider string `json:"provider"` // claude | codex
	// Plan is the subscription plan ("team", "prolite"…), "" when unknown.
	Plan    string        `json:"plan"`
	Windows []LimitWindow `json:"windows"`
	// At is when the reading was taken, unix ms (a transcript reading: when
	// the rollout recorded it).
	At int64 `json:"at"`
	// Stale is set when the reading is not a fresh answer of the CLI: it is
	// from a transcript, or the last probe failed and the reading is the
	// one before. Clients also treat a reading older than 10 minutes as stale.
	Stale bool `json:"stale"`
	// Error is why there is no fresh reading (a LimitsNoPlan… code).
	Error string `json:"error,omitempty"`
	// Source is LimitsProbe or LimitsTranscript.
	Source string `json:"source,omitempty"`
	// Reached is Codex's rateLimitReachedType when a limit is reached.
	Reached string `json:"reached,omitempty"`
	// Credits are Codex's credits.
	Credits *LimitCredits `json:"credits,omitempty"`
}

// LimitWindow is one usage window.
type LimitWindow struct {
	// Label is "5h", "week", or a duration ("30m", "3d") for another window.
	Label string `json:"label"`
	// Model names the model a per-model window is for ("Opus"); absent on
	// the plan's own windows.
	Model string `json:"model,omitempty"`
	// Pct is the share used, 0–100.
	Pct float64 `json:"pct"`
	// ResetsAt is when the window resets, unix ms (0: unknown).
	ResetsAt   int64 `json:"resets_at"`
	WindowMins int   `json:"window_mins,omitempty"`
}

// LimitCredits are a Codex account's credits.
type LimitCredits struct {
	Has       bool   `json:"has_credits"`
	Unlimited bool   `json:"unlimited"`
	Balance   string `json:"balance,omitempty"`
}

// LimitsRefreshResult is the ack data of limits.refresh.
type LimitsRefreshResult struct {
	// Queued is false when the last refresh was less than 20 s ago (the
	// readings there are come back as they are).
	Queued bool `json:"queued"`
}
