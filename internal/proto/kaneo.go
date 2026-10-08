package proto

import "github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"

// #184 Kaneo (docs/protocol.md "Kaneo"): the bridge-wide connection to a
// Kaneo instance, an issue tracker a floor may use instead of GitHub. The
// state is in the snapshot (World.Kaneo) and every change is a kaneo.update
// event (KaneoUpdate: the fields of Kaneo flat in it). A key is sent by the
// game in kaneo.test and kaneo.set and is never in anything the bridge
// sends: only key_set is.

// EvKaneoUpdate carries the Kaneo connection's state.
const EvKaneoUpdate = "kaneo.update"

// Commands of the Kaneo connection.
const (
	CmdKaneoGet        = "kaneo.get"
	CmdKaneoTest       = "kaneo.test"
	CmdKaneoSet        = "kaneo.set"
	CmdKaneoClear      = "kaneo.clear"
	CmdKaneoWorkspaces = "kaneo.workspaces"
	CmdKaneoProjects   = "kaneo.projects"
)

func init() {
	Commands = append(Commands, CmdKaneoGet, CmdKaneoTest, CmdKaneoSet, CmdKaneoClear, CmdKaneoWorkspaces, CmdKaneoProjects)
}

// Issue trackers of a floor (FloorSettings.Tracker; BoardIssues.Provider
// is the tracker's id).
const (
	TrackerGitHub = "github"
	TrackerKaneo  = "kaneo"
)

// Error codes of Kaneo (besides bad_request, not_found, unsupported,
// unreachable, timeout, test_required, rate_limited and provider_failed).
// unauthorized and forbidden are also the board commands' for any
// provider that tells them apart.
const (
	ErrBadURL        = "bad_url"        // the instance URL is not one
	ErrKeyRequired   = "key_required"   // a new instance needs its key typed: the saved one is never sent elsewhere
	ErrNotConfigured = "not_configured" // no saved connection
	ErrUnauthorized  = "unauthorized"   // the provider refused the key (HTTP 401; it may be the key's request quota)
	ErrForbidden     = "forbidden"      // the key may not reach that workspace, project or item (HTTP 403)
)

// Kaneo is the connection: kaneo.get's ack, World.Kaneo, and flat in
// kaneo.update. Never the key.
type Kaneo = kaneoconf.View

// KaneoWorkspace and KaneoProject are what the dropdowns list.
type (
	KaneoWorkspace = kaneoconf.Workspace
	KaneoProject   = kaneoconf.Project
)

// KaneoUpdate is the kaneo.update event. It is not an Event: the fields of
// Kaneo would collide with AI's flat in it.
type KaneoUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	Kaneo
}

// KaneoTestArgs are the args of kaneo.test: a field left out is the saved
// one; a blank or absent key is the saved key, and only for the saved
// instance (else key_required).
type KaneoTestArgs struct {
	URL *string `json:"url,omitempty"`
	Key *string `json:"key,omitempty"`
}

// KaneoSetArgs are the args of kaneo.set: the same draft as the test that
// passed for it, and the default workspace (absent: the saved one, while
// the test found it; null: none).
type KaneoSetArgs struct {
	URL              *string          `json:"url,omitempty"`
	Key              *string          `json:"key,omitempty"`
	DefaultWorkspace Optional[string] `json:"default_workspace,omitzero"`
}

// KaneoTestResult is kaneo.test's ack (a failing test is an error).
type KaneoTestResult struct {
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latency_ms"`
	URL       string `json:"url"`
	APIBase   string `json:"api_base"`
	WebOrigin string `json:"web_origin"`
	// Workspaces are the ones the key reaches ([]: authenticated, but no
	// floor can be linked yet).
	Workspaces []KaneoWorkspace `json:"workspaces"`
	User       string           `json:"user,omitempty"`
}

// KaneoWorkspacesResult is kaneo.workspaces' ack: the saved connection's
// workspaces, and the generation they are of.
type KaneoWorkspacesResult struct {
	Workspaces []KaneoWorkspace `json:"workspaces"`
	Generation int64            `json:"generation"`
}

// KaneoProjectsArgs are the args of kaneo.projects.
type KaneoProjectsArgs struct {
	WorkspaceID string `json:"workspace_id"`
}

// KaneoProjectsResult is kaneo.projects' ack.
type KaneoProjectsResult struct {
	WorkspaceID string         `json:"workspace_id"`
	Projects    []KaneoProject `json:"projects"`
	Generation  int64          `json:"generation"`
}
