package proto

// #22 native child agents (docs/protocol.md "Native child agents"): the
// subagents a worker's own Claude Code or Codex session runs (Claude's
// agentId, Codex's child thread.id), published whether or not a transcript
// is open. Every child the bridge knows is in the snapshot (World.Children);
// each change is a child.upsert (Child), and one that goes away a
// child.removed (ID, WorkerID, Generation). A worker's children also go with
// its worker.removed, and with a worker.upsert that raises its
// ChildGeneration (its root agent session was replaced): no child.removed is
// sent for those.

// Events of the feature.
const (
	EvChildUpsert  = "child.upsert"
	EvChildRemoved = "child.removed"
)

// Providers of a child (Child.Provider).
const (
	ChildClaude = "claude"
	ChildCodex  = "codex"
)

// Lifecycle states (Child.State), kept apart: nothing turns one into
// another but evidence, and quiet logs are no evidence. A state the bridge
// has no evidence of is ChildUnknown, never a guess.
const (
	ChildRunning     = "running"     // working now
	ChildCompleted   = "completed"   // its task completed
	ChildIdle        = "idle"        // idle and reusable (it can be messaged again)
	ChildShutDown    = "shut_down"   // shut down for good
	ChildInterrupted = "interrupted" // interrupted before it completed
	ChildUnknown     = "unknown"     // disconnected, or no evidence of a state
)

// ChildStates are the lifecycle states, in the order the docs list them.
var ChildStates = []string{ChildRunning, ChildCompleted, ChildIdle, ChildShutDown, ChildInterrupted, ChildUnknown}

// Immediate parents (Child.Parent): the root worker's own agent session, a
// child (Child.ParentID), or not known yet. Unresolved is its own value: a
// client shows such a child under its root worker until evidence resolves
// it, and never reads it as the root.
const (
	ParentRoot       = "root"
	ParentChild      = "child"
	ParentUnresolved = "unresolved"
)

// Transcript availability (Child.Transcript).
const (
	TranscriptAvailable   = "available"   // there is a transcript to open
	TranscriptPending     = "pending"     // one is expected, not written yet
	TranscriptUnavailable = "unavailable" // none is known (the default)
)

// Evidence sources (Child.Source): what set the child's current state.
// Free-form beyond these; a client shows any other as it is.
const (
	ChildFromHook       = "hook"       // Claude's SubagentStart / SubagentStop hooks
	ChildFromTranscript = "transcript" // a transcript (Claude's JSONL, the parent's tool results)
	ChildFromAppServer  = "app_server" // a Codex app-server's notifications
	ChildFromRollout    = "rollout"    // a Codex rollout file
	ChildFromFixture    = "fixture"    // the fake source (tests, fixtures)
)

// Child is one native child agent of a worker, as clients see it.
type Child struct {
	// ID is the bridge's row id, "ch_<hex>": it never changes for the life
	// of the row, also when the native id arrives later.
	ID string `json:"id"`
	// NativeID is the provider's id (Claude's agentId, Codex's child
	// thread.id); absent while the row is provisional (seen from its
	// dispatch, before the provider named it).
	NativeID string `json:"native_id,omitempty"`
	Provider string `json:"provider"`
	// WorkerID is the root worker that owns it, AgentSession that worker's
	// root agent session it belongs to, and Generation that worker's
	// ChildGeneration when the row was made.
	WorkerID     string `json:"worker_id"`
	AgentSession string `json:"agent_session"`
	Generation   uint64 `json:"generation"`
	// Parent is ParentRoot, ParentChild (ParentID is that child's row id)
	// or ParentUnresolved. Always present.
	Parent   string `json:"parent"`
	ParentID string `json:"parent_id,omitempty"`
	// Name, Type and Description as the provider gives them (Claude: the
	// subagent type and the task's description; Codex: the nickname and
	// role), when known.
	Name        string `json:"name,omitempty"`
	Type        string `json:"type,omitempty"`
	Description string `json:"description,omitempty"`
	// State is one of ChildStates; Source the evidence source that set it.
	State  string `json:"state"`
	Source string `json:"source"`
	// When it started, was last seen active and ended: unix milliseconds,
	// from the evidence (the provider's clock); absent when not known.
	StartedAt      int64 `json:"started_at,omitempty"`
	LastActivityAt int64 `json:"last_activity_at,omitempty"`
	EndedAt        int64 `json:"ended_at,omitempty"`
	// Transcript is TranscriptAvailable, TranscriptPending or
	// TranscriptUnavailable.
	Transcript string `json:"transcript"`
}
