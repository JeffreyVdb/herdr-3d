package world_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func snapshot(t *testing.T, name string) *herdr.Snapshot {
	t.Helper()
	var snap herdr.Snapshot
	if err := json.Unmarshal(herdrtest.SnapshotFixture(t, name), &snap); err != nil {
		t.Fatal(err)
	}
	return &snap
}

func byWS(ws []world.WorkerObs) map[string]world.WorkerObs {
	m := map[string]world.WorkerObs{}
	for _, w := range ws {
		m[w.WorkspaceID] = w
	}
	return m
}

func TestFromSnapshot(t *testing.T) {
	ws := world.FromSnapshot(snapshot(t, "snapshot.json"))
	if len(ws) != 4 {
		t.Fatalf("workers = %d, want one per workspace", len(ws))
	}
	if ws[0].WorkspaceID != "w1" || ws[3].WorkspaceID != "w4" {
		t.Fatal("workers are not in sidebar order")
	}
	m := byWS(ws)

	orch := m["w1"]
	want := world.WorkerObs{
		WorkspaceID: "w1", Label: "ORCH|bridge-ro", Cwd: "/home/u/devel/herdr-3d", IdentityCwd: "/home/u/devel/herdr-3d",
		PaneID: "w1:p1", AgentKind: "claude", AgentSession: "c6f58eef-ca04-4fe4-a564-3b15f8311bf3",
		Status: "working", Title: "Claude Code",
		Tokens:   map[string]string{"h3d_run": "20260928-1344-bridge-ro", "h3d_role": "orch", "h3d_pass": "0", "h3d_phase": "coding"},
		Worktree: &world.Worktree{RepoRoot: "/home/u/devel/herdr-3d", RepoName: "herdr-3d", CheckoutPath: "/home/u/devel/herdr-3d"},
		Role:     "orch", Run: "20260928-1344-bridge-ro",
	}
	if !reflect.DeepEqual(orch, want) {
		t.Fatalf("w1 =\n%+v\nwant\n%+v", orch, want)
	}

	code := m["wD"]
	if code.AgentName != "coder-r1" || code.Status != "idle" || code.PaneLabel != "h3d-7f3a9c" ||
		!reflect.DeepEqual(code.Markers, []string{"h3d-7f3a9c"}) || code.Role != "code" {
		t.Fatalf("wD = %+v", code)
	}
	if _, ok := code.Tokens["building"]; ok {
		t.Fatal("non-h3d tokens must be dropped")
	}

	// Two panes, the agent in the second: the agent pane represents the worker.
	research := m["w3"]
	if research.PaneID != "w3:p2" || research.AgentKind != "codex" || research.Status != "blocked" ||
		research.AgentName != "rx" || research.Cwd != "/home/u/research/sub" || research.Role != "" {
		t.Fatalf("w3 = %+v", research)
	}

	notes := m["w4"]
	if notes.PaneID != "w4:p1" || notes.Status != "unknown" || notes.AgentKind != "" || notes.Tokens != nil {
		t.Fatalf("w4 = %+v", notes)
	}
}

func TestApplyStatus(t *testing.T) {
	snap := snapshot(t, "snapshot.json")
	claude := "claude"
	if !world.ApplyStatus(snap, herdr.StatusChanged{PaneID: "wD:p1", WorkspaceID: "wD", AgentStatus: "working", Agent: &claude}) {
		t.Fatal("known pane not applied")
	}
	if got := byWS(world.FromSnapshot(snap))["wD"].Status; got != "working" {
		t.Fatalf("status = %q", got)
	}
	if world.ApplyStatus(snap, herdr.StatusChanged{PaneID: "w9:p1", WorkspaceID: "w9", AgentStatus: "idle"}) {
		t.Fatal("unknown pane reported as applied")
	}
	// A plain shell reporting an agent picks it up.
	x := "h3dprobe"
	world.ApplyStatus(snap, herdr.StatusChanged{PaneID: "w4:p1", WorkspaceID: "w4", AgentStatus: "working", Agent: &x})
	if w := byWS(world.FromSnapshot(snap))["w4"]; w.AgentKind != "h3dprobe" || w.Status != "working" {
		t.Fatalf("w4 = %+v", w)
	}
}

func TestFromSessionFile(t *testing.T) {
	sf, err := herdr.ParseSessionFile(herdrtest.Fixture(t, "session_v3.json"))
	if err != nil {
		t.Fatal(err)
	}
	m := byWS(world.FromSessionFile(sf))
	if len(m) != 4 {
		t.Fatalf("workers = %d", len(m))
	}
	if w := m["w1"]; w.Label != "ORCH|slackpriv" || w.PaneID != "w1:p1" || w.AgentKind != "claude" ||
		w.AgentSession != "51b5e2e7-8d46-414e-9aa4-1b11c44a84d2" || w.Status != "unknown" || w.Role != "orch" || w.Run != "slackpriv" {
		t.Fatalf("w1 = %+v", w)
	}
	// The agent sits in internal pane 7 = public p2, not the root pane.
	if w := m["w1Q"]; w.PaneID != "w1Q:p2" || w.AgentName != "code_learnpref_100_r1" || w.PaneLabel != "h3d-7f3a9c" ||
		!reflect.DeepEqual(w.Markers, []string{"h3d-7f3a9c"}) || w.Worktree == nil || !w.Worktree.Linked ||
		w.IdentityCwd != "/home/u/.herdr/worktrees/gcr/feat-100" || w.Role != "code" || w.Run != "learnpref" {
		t.Fatalf("w1Q = %+v", w)
	}
	// No custom name: herdr's automatic label is the cwd basename or the repo.
	if w := m["w2"]; w.Label != "pastry" || w.PaneID != "w2:p1" || w.AgentKind != "" {
		t.Fatalf("w2 = %+v", w)
	}
	if w := m["w3"]; w.Label != "gcr" {
		t.Fatalf("w3 label = %q", w.Label)
	}
}

func TestFromSessionFileUnknownFields(t *testing.T) {
	sf, err := herdr.ParseSessionFile(herdrtest.Fixture(t, "session_v3_unknown_fields.json"))
	if err != nil {
		t.Fatal(err)
	}
	ws := world.FromSessionFile(sf)
	if len(ws) != 1 || ws[0].Label != "GROUND|herdr" || ws[0].AgentKind != "codex" || ws[0].AgentName != "r-herdr" || ws[0].PaneID != "w7:p1" {
		t.Fatalf("workers = %+v", ws)
	}
}

func TestRoleRun(t *testing.T) {
	for _, tc := range []struct {
		label     string
		tokens    map[string]string
		role, run string
	}{
		{"ORCH|bridge-ro", nil, "orch", "bridge-ro"},
		{"CODE|bridge-ro|2|r1", nil, "code", "bridge-ro"},
		{"REVIEW|x|3|r2", nil, "review", "x"},
		{"UX|lobby", nil, "ux", "lobby"},
		{"GROUND|herdr", nil, "ground", "herdr"},
		{"VERIFY|herdr", nil, "", ""},
		{"code|lower", nil, "", ""},
		{"research", nil, "", ""},
		{"CODE|a|1|r1", map[string]string{"h3d_role": "code", "h3d_run": "20260928-1344-a"}, "code", "20260928-1344-a"},
		{"notes", map[string]string{"h3d_role": "ux"}, "ux", ""},
	} {
		role, run := world.RoleRun(tc.label, tc.tokens)
		if role != tc.role || run != tc.run {
			t.Errorf("RoleRun(%q, %v) = %q, %q; want %q, %q", tc.label, tc.tokens, role, run, tc.role, tc.run)
		}
	}
}

func TestIsMarker(t *testing.T) {
	for label, want := range map[string]bool{
		"h3d-7f3a9c": true, "h3d-0123456789abcdef": true, "h3d-7f3a9": false, "h3d-7F3A9C": false,
		"x h3d-7f3a9c": false, "h3d-": false, "": false,
	} {
		if got := world.IsMarker(label); got != want {
			t.Errorf("IsMarker(%q) = %v", label, got)
		}
	}
}
