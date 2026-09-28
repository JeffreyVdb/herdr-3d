package herdr

import "encoding/json"

// Session is one entry of `herdr session list --json`.
type Session struct {
	Name       string `json:"name"`
	Default    bool   `json:"default"`
	Running    bool   `json:"running"` // a hint only; probe the socket
	SessionDir string `json:"session_dir"`
	SocketPath string `json:"socket_path"`
}

// Pong is the result of a `ping`.
type Pong struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
}

// Snapshot is `result.snapshot` of `session.snapshot` (SessionSnapshot in
// `herdr api schema --json`). Only the fields the bridge uses are decoded.
type Snapshot struct {
	Version    string          `json:"version"`
	Protocol   int             `json:"protocol"`
	Workspaces []WorkspaceInfo `json:"workspaces"`
	Panes      []PaneInfo      `json:"panes"`
	Agents     []AgentInfo     `json:"agents"`
}

// WorkspaceInfo mirrors the schema's WorkspaceInfo.
type WorkspaceInfo struct {
	WorkspaceID string            `json:"workspace_id"`
	Number      int               `json:"number"`
	Label       string            `json:"label"`
	ActiveTabID string            `json:"active_tab_id"`
	AgentStatus string            `json:"agent_status"`
	Tokens      map[string]string `json:"tokens,omitempty"`
	Worktree    *WorktreeInfo     `json:"worktree,omitempty"`
}

// WorktreeInfo mirrors the schema's WorkspaceWorktreeInfo.
type WorktreeInfo struct {
	RepoKey          string `json:"repo_key"`
	RepoName         string `json:"repo_name"`
	RepoRoot         string `json:"repo_root"`
	CheckoutPath     string `json:"checkout_path"`
	IsLinkedWorktree bool   `json:"is_linked_worktree"`
}

// PaneInfo mirrors the schema's PaneInfo.
type PaneInfo struct {
	PaneID                string        `json:"pane_id"`
	WorkspaceID           string        `json:"workspace_id"`
	TabID                 string        `json:"tab_id"`
	Label                 *string       `json:"label,omitempty"`
	Cwd                   *string       `json:"cwd,omitempty"`
	Agent                 *string       `json:"agent,omitempty"`
	AgentStatus           string        `json:"agent_status"`
	AgentSession          *AgentSession `json:"agent_session,omitempty"`
	TerminalTitleStripped *string       `json:"terminal_title_stripped,omitempty"`
}

// AgentInfo mirrors the schema's AgentInfo.
type AgentInfo struct {
	PaneID                string        `json:"pane_id"`
	WorkspaceID           string        `json:"workspace_id"`
	Name                  *string       `json:"name,omitempty"`
	Agent                 *string       `json:"agent,omitempty"`
	AgentStatus           string        `json:"agent_status"`
	AgentSession          *AgentSession `json:"agent_session,omitempty"`
	Cwd                   *string       `json:"cwd,omitempty"`
	TerminalTitleStripped *string       `json:"terminal_title_stripped,omitempty"`
}

// AgentSession is the native agent session reference (AgentSessionInfo).
type AgentSession struct {
	Source string `json:"source"`
	Agent  string `json:"agent"`
	Kind   string `json:"kind"`
	Value  string `json:"value"`
}

// Subscription is one entry of `events.subscribe` params.subscriptions.
type Subscription struct {
	Type   string `json:"type"`
	PaneID string `json:"pane_id,omitempty"`
}

// Event is one pushed line of a subscription stream. Lifecycle events are
// named with underscores (`workspace_closed`), per-pane subscription events
// with dots (`pane.agent_status_changed`); see EventEnvelope and
// SubscriptionEventKind in the schema.
type Event struct {
	Event string          `json:"event"`
	Data  json.RawMessage `json:"data"`
}

// StatusChanged is the data of a `pane.agent_status_changed` event.
type StatusChanged struct {
	PaneID      string  `json:"pane_id"`
	WorkspaceID string  `json:"workspace_id"`
	AgentStatus string  `json:"agent_status"`
	Agent       *string `json:"agent,omitempty"`
}

// EventStatusChanged is the per-pane status event name.
const EventStatusChanged = "pane.agent_status_changed"

// LifecycleSubscriptions are the lifecycle events that can change which
// workers exist or what they look like. Any of them triggers a re-snapshot.
var LifecycleSubscriptions = []Subscription{
	{Type: "workspace.created"}, {Type: "workspace.updated"}, {Type: "workspace.metadata_updated"},
	{Type: "workspace.renamed"}, {Type: "workspace.moved"}, {Type: "workspace.reordered"},
	{Type: "workspace.closed"}, {Type: "worktree.created"}, {Type: "worktree.opened"},
	{Type: "worktree.removed"}, {Type: "tab.created"}, {Type: "tab.closed"},
	{Type: "pane.created"}, {Type: "pane.closed"}, {Type: "pane.updated"}, {Type: "pane.moved"},
	{Type: "pane.exited"}, {Type: "pane.agent_detected"},
}

// StatusSubscriptions subscribes to agent status changes of each pane.
// Unfiltered, so herdr sends no initial event: the snapshot is the baseline.
func StatusSubscriptions(paneIDs []string) []Subscription {
	subs := make([]Subscription, len(paneIDs))
	for i, id := range paneIDs {
		subs[i] = Subscription{Type: EventStatusChanged, PaneID: id}
	}
	return subs
}
