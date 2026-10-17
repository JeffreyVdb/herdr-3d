// Package childagents is #22's provider-neutral model of the native child
// agents (subagents) a worker's own Claude Code or Codex session runs: the
// Registry the hub keeps them in, the Evidence a Source reports, and a
// fixture Source for tests and for building against before the providers
// land (docs/protocol.md "Native child agents"). It knows no provider:
// phases 2, 4 and 6 of #20 are Sources. Nothing here is persisted.
package childagents

import (
	"context"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Source is where evidence of native children comes from: Claude's hooks
// and child transcripts, Codex's rollouts or app-server. A source reports
// what it observed, keyed by the root agent session, never a worker id or a
// generation: the Registry resolves the session to the worker it is bound
// to now, and evidence of any other session is dropped.
//
// Nothing is persisted and the Registry starts empty, so a bridge restart
// rebuilds the graph from the sources alone: whenever the hub binds a
// worker to a root session (a worker first seen with it, a new session, or
// every worker again after a restart) it asks each source to Replay that
// session.
type Source interface {
	// Run observes until ctx ends, passing each observation to emit in the
	// order observed (emit returns once the hub applied it). It is called
	// once.
	Run(ctx context.Context, emit func(Evidence)) error
	// Replay asks for all the evidence the source can find for a root
	// session again, from the start and in observation order, through Run's
	// emit; so the last word is the latest observation. It never blocks:
	// the hub calls it on its own goroutine, and the evidence follows from
	// the source's.
	Replay(session string)
}

// Evidence is one observation of one child. A zero field says nothing:
// the child keeps what it has (a new child: the defaults, State
// proto.ChildUnknown and Transcript proto.TranscriptUnavailable).
type Evidence struct {
	// Session is the root agent session the child belongs to (the root
	// worker's agent_session).
	Session string `json:"session"`
	// Provider is proto.ChildClaude or proto.ChildCodex.
	Provider string `json:"provider"`
	// NativeID is the provider's child id (Claude's agentId, Codex's child
	// thread.id), and DispatchID the key of the dispatch that started it
	// (Claude: the Agent tool call's id; Codex: the spawn call's id), seen
	// before the provider named the child. At least one is set; with both,
	// the observation says they are one child: a provisional row keeps its
	// row id and gains the native id.
	NativeID   string `json:"native_id,omitempty"`
	DispatchID string `json:"dispatch_id,omitempty"`
	// Parent is the child's immediate parent as the evidence shows it (nil:
	// it shows none). Never inferred from timing or launch order.
	Parent *ParentRef `json:"parent,omitempty"`

	Name        string `json:"name,omitempty"`
	Type        string `json:"type,omitempty"`
	Description string `json:"description,omitempty"`
	// State is one of proto.ChildStates ("": the observation shows none; a
	// value outside them is read as proto.ChildUnknown).
	State string `json:"state,omitempty"`
	// Source is the evidence source (proto.ChildFromHook, …); required.
	Source string `json:"source"`
	// Unix milliseconds on the provider's clock (0: not shown).
	StartedAt      int64 `json:"started_at,omitempty"`
	LastActivityAt int64 `json:"last_activity_at,omitempty"`
	EndedAt        int64 `json:"ended_at,omitempty"`
	// Transcript is proto.TranscriptAvailable, …Pending or …Unavailable
	// ("": unchanged).
	Transcript string `json:"transcript,omitempty"`
	// Removed says the child is gone from the provider's evidence (its
	// transcript cleaned up, a thread the server no longer lists): its row
	// is removed.
	Removed bool `json:"removed,omitempty"`
}

// ParentRef names an immediate parent in evidence: the root worker's own
// session (Kind "root"), or another child by its native or dispatch id
// (Kind "child"). A child named before the registry knows it leaves the
// row's parent unresolved until that child shows up.
type ParentRef struct {
	Kind       string `json:"kind"`
	NativeID   string `json:"native_id,omitempty"`
	DispatchID string `json:"dispatch_id,omitempty"`
}

// validState reads a state from evidence: one of proto.ChildStates, else
// unknown.
func validState(s string) string {
	for _, v := range proto.ChildStates {
		if s == v {
			return s
		}
	}
	return proto.ChildUnknown
}

func validTranscript(s string) bool {
	return s == proto.TranscriptAvailable || s == proto.TranscriptPending || s == proto.TranscriptUnavailable
}
