package world_test

import (
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func TestReconcileTiers(t *testing.T) {
	cands := []world.Candidate{
		{ID: "7f3a9c01-0000-4000-8000-000000000001", WorkspaceID: "w9"},
		{ID: "agent-worker", WorkspaceID: "w8", AgentSessions: []string{"old-session", "sess-1"}},
		{ID: "weak-worker", WorkspaceID: "w3", LabelCwds: []string{world.LabelCwdKey("notes", "/home/u/notes")}},
		{ID: "fired-worker", WorkspaceID: "w4", Closed: true, LabelCwds: []string{world.LabelCwdKey("gone", "/home/u")}},
	}
	obs := []world.WorkerObs{
		{WorkspaceID: "w1", Label: "CODE|x", Markers: []string{"h3d-7f3a9c01"}},
		{WorkspaceID: "w2", Label: "ORCH|x", AgentSession: "sess-1"},
		{WorkspaceID: "w3", Label: "notes", IdentityCwd: "/home/u/notes"},
		{WorkspaceID: "w4", Label: "gone", IdentityCwd: "/home/u"},
		{WorkspaceID: "w5", Label: "brand new", IdentityCwd: "/home/u/new"},
	}
	got := world.Reconcile(obs, cands, nil)
	want := map[string]world.Match{
		"w1": {ID: "7f3a9c01-0000-4000-8000-000000000001", How: world.ByMarker},
		"w2": {ID: "agent-worker", How: world.ByAgentSession},
		"w3": {ID: "weak-worker", How: world.ByLabelCwd},
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for ws, m := range want {
		if got[ws] != m {
			t.Errorf("%s: got %+v, want %+v", ws, got[ws], m)
		}
	}
}

// A workspace id is never trusted on its own: a reused id with different
// evidence becomes a new worker.
func TestReconcileIgnoresBareWorkspaceID(t *testing.T) {
	cands := []world.Candidate{{ID: "old", WorkspaceID: "w1", AgentSessions: []string{"a"}, LabelCwds: []string{world.LabelCwdKey("x", "/x")}}}
	got := world.Reconcile([]world.WorkerObs{{WorkspaceID: "w1", Label: "y", IdentityCwd: "/y", AgentSession: "b"}}, cands, nil)
	if len(got) != 0 {
		t.Fatalf("got %v, want no match", got)
	}
}

// Strong evidence is assigned for all workers before weak evidence, so a
// weak match cannot steal an identity another workspace proves.
func TestReconcileStrongBeforeWeak(t *testing.T) {
	cands := []world.Candidate{{ID: "x", WorkspaceID: "w1", AgentSessions: []string{"s"}, LabelCwds: []string{world.LabelCwdKey("same", "/p")}}}
	obs := []world.WorkerObs{
		{WorkspaceID: "w1", Label: "same", IdentityCwd: "/p"},  // weak evidence for x, same wsid even
		{WorkspaceID: "w2", Label: "other", AgentSession: "s"}, // strong evidence for x
	}
	got := world.Reconcile(obs, cands, nil)
	if got["w2"].ID != "x" || got["w2"].How != world.ByAgentSession {
		t.Fatalf("w2 = %+v", got["w2"])
	}
	if _, ok := got["w1"]; ok {
		t.Fatalf("w1 must not match: %+v", got["w1"])
	}
}

func TestReconcileAmbiguousWeak(t *testing.T) {
	key := world.LabelCwdKey("research", "/home/u/research")
	cands := []world.Candidate{
		{ID: "a", WorkspaceID: "w21", LabelCwds: []string{key}},
		{ID: "b", WorkspaceID: "w22", LabelCwds: []string{key}},
	}
	obs := []world.WorkerObs{
		{WorkspaceID: "w22", Label: "research", IdentityCwd: "/home/u/research"},
		{WorkspaceID: "w23", Label: "research", IdentityCwd: "/home/u/research"},
	}
	got := world.Reconcile(obs, cands, nil)
	// w22 breaks the tie by workspace id; w23 then has exactly one left.
	if got["w22"].ID != "b" || got["w23"].ID != "a" {
		t.Fatalf("got %v", got)
	}
	// Three identical plain shells and two identities, none on the same id:
	// ambiguous, so no weak match at all.
	got = world.Reconcile([]world.WorkerObs{
		{WorkspaceID: "w30", Label: "research", IdentityCwd: "/home/u/research"},
	}, cands, nil)
	if len(got) != 0 {
		t.Fatalf("ambiguous weak match: %v", got)
	}
}

func TestReconcileRespectsTaken(t *testing.T) {
	cands := []world.Candidate{{ID: "x", WorkspaceID: "w1", AgentSessions: []string{"s"}}}
	got := world.Reconcile([]world.WorkerObs{{WorkspaceID: "w2", AgentSession: "s"}}, cands, map[string]bool{"x": true})
	if len(got) != 0 {
		t.Fatalf("taken identity reassigned: %v", got)
	}
}

func TestReconcileClosedOnlyStrong(t *testing.T) {
	cands := []world.Candidate{{ID: "x", WorkspaceID: "w1", Closed: true, AgentSessions: []string{"s"}, LabelCwds: []string{world.LabelCwdKey("l", "/c")}}}
	if got := world.Reconcile([]world.WorkerObs{{WorkspaceID: "w5", Label: "l", IdentityCwd: "/c"}}, cands, nil); len(got) != 0 {
		t.Fatalf("closed identity weakly revived: %v", got)
	}
	if got := world.Reconcile([]world.WorkerObs{{WorkspaceID: "w5", AgentSession: "s"}}, cands, nil); got["w5"].ID != "x" {
		t.Fatalf("resumed agent session not matched: %v", got)
	}
}
