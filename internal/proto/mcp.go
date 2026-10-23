package proto

// #196 MCP & skills: the configured MCP servers and skills of Claude Code
// and Codex for a floor's checkout and Codex profile (docs/protocol.md "MCP
// and skills"). mcp.inventory reads configuration only and is served from a
// bridge-wide cache; mcp.check starts the configured servers in a fresh probe
// process, only on request. Both answer a Snapshot. Nothing in a Snapshot is
// a config object, command, argument, environment value, header, URL, token or
// raw error text: names, descriptions of skills, bridge-authored notes,
// scopes, transports, booleans, times and display paths only.

// Commands of the MCP & skills wall.
const (
	CmdMCPInventory = "mcp.inventory"
	CmdMCPCheck     = "mcp.check"
)

func init() { Commands = append(Commands, CmdMCPInventory, CmdMCPCheck) }

// MCPInventoryArgs are the args of mcp.inventory. Cwd absent: the floor's
// default checkout; null: user scope only. CodexProfile absent or null: the
// default profile.
type MCPInventoryArgs struct {
	Session      string           `json:"session,omitempty"`
	Floor        string           `json:"floor,omitempty"`
	Cwd          Optional[string] `json:"cwd,omitzero"`
	CodexProfile Optional[string] `json:"codex_profile,omitzero"`
}

// MCPCheckArgs are the args of mcp.check: mcp.inventory's, and the harness
// whose servers the probe starts ("claude" or "codex").
type MCPCheckArgs struct {
	Session      string           `json:"session,omitempty"`
	Floor        string           `json:"floor,omitempty"`
	Cwd          Optional[string] `json:"cwd,omitzero"`
	CodexProfile Optional[string] `json:"codex_profile,omitzero"`
	Harness      string           `json:"harness"`
}

// Limits of the expected_mcp floor setting.
const (
	MaxExpectedMCP     = 32
	MaxExpectedMCPName = 100
)

// MCPSnapshot is the ack data of mcp.inventory and mcp.check.
type MCPSnapshot struct {
	Context   MCPContext    `json:"context"`
	Checkouts []MCPCheckout `json:"checkouts"`
	// Expected are the floor's expected_mcp names ([] when none).
	Expected    []string     `json:"expected"`
	GeneratedAt string       `json:"generated_at"`
	Providers   MCPProviders `json:"providers"`
}

// MCPContext is what a Snapshot describes: the floor, the checkout (nil:
// user scope only) and the Codex profile, and Claude Code's config dir.
type MCPContext struct {
	Floor            string  `json:"floor"`
	Cwd              *string `json:"cwd"`
	CwdDisplay       string  `json:"cwd_display"`
	CodexProfile     string  `json:"codex_profile"`
	CodexProfileName string  `json:"codex_profile_name"`
	ClaudeConfig     string  `json:"claude_config"`
}

// MCPCheckout is one choice of cwd.
type MCPCheckout struct {
	Path    string `json:"path"`
	Display string `json:"display"`
	Label   string `json:"label"`
}

// MCPProviders are the two harnesses, always both.
type MCPProviders struct {
	Claude MCPProvider `json:"claude"`
	Codex  MCPProvider `json:"codex"`
}

// States of a provider's config and skills reads.
const (
	MCPStateOK          = "ok"
	MCPStatePartial     = "partial"
	MCPStateFailed      = "failed"
	MCPStatePending     = "pending"
	MCPStateUnsupported = "unsupported"
	MCPStateUnavailable = "unavailable"
)

// States of a provider's connection check.
const (
	MCPCheckNone    = "none"
	MCPCheckOK      = "ok"
	MCPCheckFailed  = "failed"
	MCPCheckSkipped = "skipped"
	MCPCheckTimeout = "timeout"
)

// MCPProvider is one harness's inventory.
type MCPProvider struct {
	Available bool     `json:"available"`
	Version   string   `json:"version"`
	Reason    string   `json:"reason"`
	Config    MCPRead  `json:"config"`
	Check     MCPCheck `json:"check"`
	// Servers: [] when the read is ok and nothing is configured; meaningful
	// only when Config.State is ok or partial.
	Servers []MCPServer `json:"servers"`
	Skills  MCPSkills   `json:"skills"`
}

// MCPRead is the state of a configuration read.
type MCPRead struct {
	State  string  `json:"state"`
	ReadAt *string `json:"read_at"`
	Stale  bool    `json:"stale"`
	Note   string  `json:"note"`
}

// MCPCheck is the state of the last connection check.
type MCPCheck struct {
	State string  `json:"state"`
	At    *string `json:"at"`
	Note  string  `json:"note"`
}

// Sources of a server or skill.
const (
	MCPSourceUser      = "user"
	MCPSourceLocal     = "local"
	MCPSourceProject   = "project"
	MCPSourcePlugin    = "plugin"
	MCPSourceManaged   = "managed"
	MCPSourceConnector = "connector"
	MCPSourceSystem    = "system"
	MCPSourceRepo      = "repo"
	MCPSourceAdmin     = "admin"
	MCPSourceUnknown   = "unknown"
)

// Transports of a server.
const (
	MCPTransportStdio   = "stdio"
	MCPTransportHTTP    = "http"
	MCPTransportSSE     = "sse"
	MCPTransportUnknown = "unknown"
)

// Approvals of a Claude project-scope server.
const (
	MCPApprovalApproved = "approved"
	MCPApprovalPending  = "pending"
	MCPApprovalRejected = "rejected"
	MCPApprovalNA       = "n/a"
)

// Statuses of a server.
const (
	MCPStatusNotChecked       = "not_checked"
	MCPStatusDisabled         = "disabled"
	MCPStatusApprovalRequired = "approval_required"
	MCPStatusBlocked          = "blocked"
	MCPStatusConnecting       = "connecting"
	MCPStatusConnected        = "connected"
	MCPStatusAuthRequired     = "auth_required"
	MCPStatusFailed           = "failed"
	MCPStatusUnknown          = "unknown"
)

// Where a server's status came from.
const (
	MCPScopeConfig = "config"
	MCPScopeProbe  = "probe"
	MCPScopeWorker = "worker"
)

// MCPServer is one server of one provider.
type MCPServer struct {
	Name        string     `json:"name"`
	Source      string     `json:"source"`
	Plugin      string     `json:"plugin"`
	Transport   string     `json:"transport"`
	Enabled     *bool      `json:"enabled"`
	Approval    string     `json:"approval"`
	Status      string     `json:"status"`
	StatusScope string     `json:"status_scope"`
	StatusAt    *string    `json:"status_at"`
	Worker      *MCPWorker `json:"worker,omitempty"`
	Reason      string     `json:"reason"`
}

// MCPWorker names the worker a status was observed on.
type MCPWorker struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// MCPSkills is a provider's skills.
type MCPSkills struct {
	State  string  `json:"state"`
	ReadAt *string `json:"read_at"`
	Stale  bool    `json:"stale"`
	// Complete is true only when the harness enumerates its skills itself
	// (Codex skills/list); Claude's are found on disk.
	Complete bool            `json:"complete"`
	Note     string          `json:"note"`
	Items    []MCPSkill      `json:"items"`
	Errors   []MCPSkillError `json:"errors"`
}

// Invocations of a skill.
const (
	MCPInvocationBoth      = "both"
	MCPInvocationUserOnly  = "user_only"
	MCPInvocationModelOnly = "model_only"
	MCPInvocationUnknown   = "unknown"
)

// MCPSkill is one skill.
type MCPSkill struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Source      string `json:"source"`
	Plugin      string `json:"plugin"`
	Enabled     *bool  `json:"enabled"`
	Invocation  string `json:"invocation"`
	Where       string `json:"where"`
}

// MCPSkillError is a skill that failed to load: where (a display path) and
// a bridge-authored category.
type MCPSkillError struct {
	Where   string `json:"where"`
	Message string `json:"message"`
}
