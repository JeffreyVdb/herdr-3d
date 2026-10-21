package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

var buildTeam = store.PresetRoles{
	Orch:       store.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "medium"},
	Coder:      store.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "medium"},
	Reviewer:   store.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "high"},
	UX:         store.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "high"},
	Researcher: store.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low"},
}

// The migration that creates team_preset seeds "Build team" once: deleted,
// it stays deleted when the database is opened again.
func TestPresetSeedOnce(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	ps, err := st.Presets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 1 {
		t.Fatalf("presets = %+v", ps)
	}
	seed := ps[0]
	if seed.Name != "Build team" || !seed.Seeded || seed.Roles != buildTeam ||
		!regexp.MustCompile(`^p_[0-9a-f]{12}$`).MatchString(seed.ID) {
		t.Fatalf("seed = %+v", seed)
	}
	st.Close()

	st = open(t, path)
	if ps, _ := st.Presets(ctx); len(ps) != 1 || ps[0] != seed {
		t.Fatalf("reopened = %+v", ps)
	}
	if err := st.DeletePreset(ctx, seed.ID); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if ps, _ := st.Presets(ctx); len(ps) != 0 {
		t.Fatalf("seed came back: %+v", ps)
	}
}

func TestPresetCRUD(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	cheap := buildTeam
	cheap.Coder = store.Hire{Harness: "codex", Model: "gpt-6-luna", Effort: "low"}
	p, err := st.CreatePreset(ctx, "p_000000000001", "  Cheap team ", cheap)
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "Cheap team" || p.Seeded || p.Roles != cheap {
		t.Fatalf("created = %+v", p)
	}
	for _, name := range []string{"cheap TEAM", "build team"} {
		if _, err := st.CreatePreset(ctx, "p_000000000002", name, cheap); !errors.Is(err, store.ErrNameTaken) {
			t.Fatalf("create %q: %v", name, err)
		}
	}
	for _, name := range []string{"", "   ", "a\tb", "x\x00", strings.Repeat("a", 41)} {
		if _, err := st.CreatePreset(ctx, "p_000000000002", name, cheap); !errors.Is(err, store.ErrInvalid) {
			t.Fatalf("create %q: %v", name, err)
		}
	}
	if _, err := st.CreatePreset(ctx, "p_000000000002", "Ünïcode ✓ team", cheap); err != nil {
		t.Fatalf("unicode name: %v", err)
	}

	// Rename to its own name in another case is fine; to another's is not.
	p.Name = "CHEAP team"
	p.Roles.UX = store.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "high"}
	if err := st.UpdatePreset(ctx, p); err != nil {
		t.Fatal(err)
	}
	q := p
	q.Name = "Build Team"
	if err := st.UpdatePreset(ctx, q); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("rename onto another: %v", err)
	}
	if err := st.UpdatePreset(ctx, store.Preset{ID: "p_ffffffffffff", Name: "x", Roles: cheap}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update missing: %v", err)
	}
	if err := st.DeletePreset(ctx, "p_ffffffffffff"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete missing: %v", err)
	}
	st.Close()

	// By name, ignoring case; everything survives a reopen.
	st = open(t, path)
	ps, err := st.Presets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, x := range ps {
		names = append(names, x.Name)
	}
	if len(ps) != 3 || names[0] != "Build team" || names[1] != "CHEAP team" || names[2] != "Ünïcode ✓ team" || ps[1] != p {
		t.Fatalf("presets = %+v", ps)
	}
}

// #167: a role's Codex profile (a key or "auto") is kept, and survives a
// reopen and an update; a role without one stays without (the seed's old
// JSON has none and loads as before: TestPresetSeedOnce).
func TestPresetRoleCodexProfile(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	team := buildTeam
	team.Orch = store.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "high", CodexProfile: "work"}
	team.Reviewer.CodexProfile = "auto"
	p, err := st.CreatePreset(ctx, "p_000000000001", "Work team", team)
	if err != nil {
		t.Fatal(err)
	}
	if p.Roles != team {
		t.Fatalf("created = %+v", p.Roles)
	}
	p.Roles.Reviewer.CodexProfile = ""
	p.Roles.UX.CodexProfile = "work"
	if err := st.UpdatePreset(ctx, p); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	ps, err := st.Presets(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, x := range ps {
		switch x.ID {
		case p.ID:
			if x.Roles != p.Roles {
				t.Fatalf("reopened = %+v, want %+v", x.Roles, p.Roles)
			}
		default:
			if x.Roles != buildTeam {
				t.Fatalf("the seed = %+v", x.Roles)
			}
		}
	}
}

// A floor's last preset goes with the preset.
func TestLastPreset(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	p, err := st.CreatePreset(ctx, "p_000000000001", "Other", buildTeam)
	if err != nil {
		t.Fatal(err)
	}
	ps, _ := st.Presets(ctx)
	seed := ps[0].ID
	if err := st.SetLastPreset(ctx, "a", p.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastPreset(ctx, "b", p.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastPreset(ctx, "b", seed); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastPreset(ctx, "c", "p_ffffffffffff"); err == nil {
		t.Fatal("a missing preset was remembered")
	}
	st.Close()
	st = open(t, path)
	last, err := st.LastPresets(ctx)
	if err != nil || len(last) != 2 || last["a"] != p.ID || last["b"] != seed {
		t.Fatalf("last = %v, %v", last, err)
	}
	if err := st.DeletePreset(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	if last, _ := st.LastPresets(ctx); len(last) != 1 || last["b"] != seed {
		t.Fatalf("after delete = %v", last)
	}
}

func TestRunLaunch(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	issue := store.RunLaunch{ID: "l_01", Session: "lab", Repo: "JeffreyVdb/lab", IssueNumber: 3, OrchWorkerID: "w-1",
		PresetID: "p_000000000001", PresetName: "Build team"}
	text := store.RunLaunch{ID: "l_02", Session: "lab", TicketText: "Fix the lobby\nplease", OrchWorkerID: "w-2",
		PresetID: "p_000000000001", PresetName: "Build team"}
	for _, l := range []store.RunLaunch{issue, text} {
		if err := st.RecordRunLaunch(ctx, l); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.RecordRunLaunch(ctx, store.RunLaunch{ID: "l_03"}); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("empty launch: %v", err)
	}
	if pending, err := st.PendingRunLaunches(ctx); err != nil || len(pending) != 2 {
		t.Fatalf("pending = %v, %v", pending, err)
	}
	if err := st.SetRunLaunchRun(ctx, "w-1", "20260929-0800-lab"); err != nil {
		t.Fatal(err)
	}
	// Only the first run id is kept.
	if err := st.SetRunLaunchRun(ctx, "w-1", "other"); err != nil {
		t.Fatal(err)
	}
	st.Close()

	st = open(t, path)
	got, ok, err := st.RunLaunchByWorker(ctx, "w-1")
	if err != nil || !ok {
		t.Fatalf("by worker: %v %v", ok, err)
	}
	if got.RunID != "20260929-0800-lab" || got.Repo != "JeffreyVdb/lab" || got.IssueNumber != 3 || got.TicketText != "" ||
		got.PresetName != "Build team" || got.Session != "lab" || got.CreatedAt.IsZero() {
		t.Fatalf("launch = %+v", got)
	}
	got, ok, _ = st.RunLaunchByWorker(ctx, "w-2")
	if !ok || got.RunID != "" || got.Repo != "" || got.IssueNumber != 0 || got.TicketText != "Fix the lobby\nplease" {
		t.Fatalf("text launch = %+v", got)
	}
	if _, ok, err := st.RunLaunchByWorker(ctx, "nobody"); ok || err != nil {
		t.Fatalf("unknown worker: %v %v", ok, err)
	}
	if pending, _ := st.PendingRunLaunches(ctx); len(pending) != 1 || pending[0] != "w-2" {
		t.Fatalf("pending = %v", pending)
	}
}

// #184: a run launched on a Kaneo task keeps {provider, id} and its key
// across a restart, and never a repository or an issue number.
func TestRunLaunchOfAnItem(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	l := store.RunLaunch{ID: "l_k1", Session: "lab", ItemProvider: "kaneo", ItemID: "task-01", ItemKey: "HRD-12", OrchWorkerID: "w-k",
		PresetID: "p_000000000001", PresetName: "Build team"}
	if err := st.RecordRunLaunch(ctx, l); err != nil {
		t.Fatal(err)
	}
	half := l
	half.ID, half.ItemProvider = "l_k2", ""
	if err := st.RecordRunLaunch(ctx, half); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("an item without its provider: %v", err)
	}
	st.Close()
	st = open(t, path)
	got, ok, err := st.RunLaunchByWorker(ctx, "w-k")
	if err != nil || !ok || got.ItemProvider != "kaneo" || got.ItemID != "task-01" || got.ItemKey != "HRD-12" || got.Repo != "" || got.IssueNumber != 0 {
		t.Fatalf("launch = %+v, %v, %v", got, ok, err)
	}
}
