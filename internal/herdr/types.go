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
	// M5 term: where each tab's panes are, in cells.
	Layouts []LayoutInfo `json:"layouts"`
}

// M5 term

// LayoutInfo is one tab's layout (the schema's TabLayout): its panes'
// rectangles, in terminal cells.
type LayoutInfo struct {
	WorkspaceID string       `json:"workspace_id"`
	TabID       string       `json:"tab_id"`
	Panes       []LayoutPane `json:"panes"`
}

// LayoutPane is one pane of a layout.
type LayoutPane struct {
	PaneID string `json:"pane_id"`
	Rect   Rect   `json:"rect"`
}

// Rect is a rectangle in terminal cells.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// headlessCols / headlessRows are herdr's size for a pane no client has laid
// out (its layout then says 120 × 40 whatever the pane really is).
const headlessCols, headlessRows = 120, 40

// wideRatio is columns per row of a full-screen terminal window (cells are
// about twice as tall as wide, windows 16:9-ish): a guess for a pane's width
// when only its height is known.
const wideRatio = 2.8

// PaneSize is a pane's size in cells, if it is there. The layout's rectangle
// is the size its attached clients last gave it, but a pane nobody laid out
// gets herdr's headless 120 × 40 while the pane itself (`scroll.viewport_rows`)
// is as tall as its terminal really is; an observer smaller than the pane
// cuts off its bottom rows, where an agent's prompt is. So the taller of the
// two is the height, and when the layout was stale the width is a guess from it.
func (s *Snapshot) PaneSize(pane string) (cols, rows int, ok bool) {
	for _, l := range s.Layouts {
		for _, p := range l.Panes {
			if p.PaneID == pane && p.Rect.Width > 0 && p.Rect.Height > 0 {
				cols, rows = p.Rect.Width, p.Rect.Height
				if v := s.viewportRows(pane); v > rows {
					rows = v
					if cols == headlessCols && p.Rect.Height == headlessRows {
						cols = max(cols, int(float64(rows)*wideRatio))
					}
				}
				return cols, rows, true
			}
		}
	}
	return 0, 0, false
}

// viewportRows is a pane's real height from its scroll state, 0 if unknown.
func (s *Snapshot) viewportRows(pane string) int {
	for _, p := range s.Panes {
		if p.PaneID == pane && p.Scroll != nil {
			return p.Scroll.ViewportRows
		}
	}
	return 0
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
	// M5 term: the pane's real screen height (the layout's can be herdr's headless default).
	Scroll *PaneScroll `json:"scroll,omitempty"`
}

// PaneScroll is the part of a pane's scroll state the bridge reads.
type PaneScroll struct {
	ViewportRows int `json:"viewport_rows"`
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

// EventAgentDetected is the lifecycle event of an agent being detected in,
// or released from, a pane.
const EventAgentDetected = "pane_agent_detected"

// AgentDetected is the data of a `pane_agent_detected` event.
type AgentDetected struct {
	PaneID      string  `json:"pane_id"`
	WorkspaceID string  `json:"workspace_id"`
	Agent       *string `json:"agent,omitempty"`
	Released    bool    `json:"released,omitempty"`
}

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
