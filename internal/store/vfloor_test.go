package store_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// A database as the bridge left it before #58 (schema 25): every worker
// and run launch gets its session as its floor, and the floor-keyed rows
// (whose keys were session names, now the real floors' ids) keep working.
func TestMigratesToVirtualFloors(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	const before = 25
	if len(store.Migrations) < before+1 {
		t.Fatalf("expected migration %d, have %d", before+1, len(store.Migrations))
	}
	for _, q := range store.Migrations[:before] {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		"PRAGMA user_version = " + strconv.Itoa(before),
		`INSERT INTO building (id, name, sort, created_at) VALUES ('b1', 'Work', 0, 't')`,
		`INSERT INTO floor_assignment (session_name, building_id, floor_index) VALUES ('s', 'b1', 0), ('t', 'b1', 1)`,
		`INSERT INTO worker (id, session_name, workspace_id, label, created_at, last_seen_at) VALUES ('u1', 's', 'w1', 'x', 't', 't')`,
		`INSERT INTO worker (id, session_name, workspace_id, label, created_at, last_seen_at) VALUES ('u2', 't', 'w1', 'y', 't', 't')`,
		`INSERT INTO desk_assignment (floor, desk_index, worker_uuid) VALUES ('s', 3, 'u1')`,
		`INSERT INTO worker_name (floor, name, worker_uuid) VALUES ('s', 'Pixel', 'u1')`,
		`INSERT INTO floor_repo (session_name, repo, updated_at) VALUES ('s', 'o/r', 't')`,
		`INSERT INTO floor_hire_last (session_name, harness, model, effort, updated_at) VALUES ('s', 'claude', 'opus', 'high', 't')`,
		`INSERT INTO run_launch (id, session, orch_worker_id, preset_id, preset_name, created_at) VALUES ('l1', 's', 'u1', 'p', 'P', 't')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	for session, id := range map[string]string{"s": "u1", "t": "u2"} {
		ws, err := st.SessionWorkers(ctx, session)
		if err != nil || len(ws) != 1 || ws[0].ID != id || ws[0].FloorID != session {
			t.Fatalf("session %s workers = %+v, %v", session, ws, err)
		}
	}
	if l, ok, err := st.RunLaunchByWorker(ctx, "u1"); err != nil || !ok || l.FloorID != "s" || l.Session != "s" {
		t.Fatalf("run launch = %+v, %v, %v", l, ok, err)
	}
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{"s", "t"}) {
		t.Fatalf("building floors = %v", got)
	}
	if ds, err := st.Desks(ctx); err != nil || len(ds) != 1 || ds[0] != (store.Desk{Floor: "s", Index: 3, WorkerID: "u1"}) {
		t.Fatalf("desks = %+v, %v", ds, err)
	}
	if ns, err := st.Names(ctx); err != nil || len(ns) != 1 || ns[0].Floor != "s" || ns[0].Name != "Pixel" {
		t.Fatalf("names = %+v, %v", ns, err)
	}
	if fs, err := st.FloorSettings(ctx); err != nil || fs["s"].Repo != "o/r" {
		t.Fatalf("settings = %+v, %v", fs, err)
	}
	if hs, err := st.LastHires(ctx); err != nil || hs["s"].Model != "opus" {
		t.Fatalf("last hires = %+v, %v", hs, err)
	}
	if vs, err := st.VirtualFloors(ctx); err != nil || len(vs) != 0 {
		t.Fatalf("virtual floors = %+v, %v", vs, err)
	}
	if hidden, err := st.HiddenFloors(ctx); err != nil || len(hidden) != 0 {
		t.Fatalf("hidden = %v, %v", hidden, err)
	}
}

func TestVirtualFloorCRUD(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	v, err := st.CreateVirtualFloor(ctx, "v-0123456789ab", "  Frontend  ", "s")
	if err != nil {
		t.Fatal(err)
	}
	if v.ID != "v-0123456789ab" || v.Name != "Frontend" || v.BaseSession != "s" || v.CreatedAt.IsZero() {
		t.Fatalf("created = %+v", v)
	}
	// Id collisions and bad shapes are refused.
	if _, err := st.CreateVirtualFloor(ctx, "v-0123456789ab", "Other", "s"); !errors.Is(err, store.ErrFloorExists) {
		t.Fatalf("duplicate id: %v", err)
	}
	for _, id := range []string{"s", "v-0123", "v-0123456789AB", "v-0123456789abc", "../v-0123456789ab", "w-0123456789ab"} {
		if _, err := st.CreateVirtualFloor(ctx, id, "X", "s"); !errors.Is(err, store.ErrInvalid) {
			t.Errorf("id %q: %v", id, err)
		}
	}
	for _, name := range []string{"", "   ", strings.Repeat("x", store.MaxFloorNameLen+1), "a\nb"} {
		if _, err := st.CreateVirtualFloor(ctx, "v-00000000000f", name, "s"); !errors.Is(err, store.ErrInvalid) {
			t.Errorf("name %q: %v", name, err)
		}
	}
	if _, err := st.CreateVirtualFloor(ctx, "v-00000000000f", "X", "v-0123456789ab"); !errors.Is(err, store.ErrInvalid) {
		t.Errorf("virtual base: %v", err)
	}
	// A real herdr session whose name has a virtual id's shape is a base like
	// any other: being virtual is being defined, not a name's shape.
	if v, err := st.CreateVirtualFloor(ctx, "v-0000000000aa", "Web", "v-ba9876543210"); err != nil || v.BaseSession != "v-ba9876543210" {
		t.Errorf("real base with a virtual id's shape: %+v, %v", v, err)
	} else if err := st.DeleteVirtualFloor(ctx, v.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateVirtualFloor(ctx, "v-00000000000f", "Backend", "t"); err != nil {
		t.Fatal(err)
	}
	if err := st.RenameVirtualFloor(ctx, "v-0123456789ab", "Web"); err != nil {
		t.Fatal(err)
	}
	if err := st.RenameVirtualFloor(ctx, "v-0123456789ab", " "); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("blank rename: %v", err)
	}
	if err := st.RenameVirtualFloor(ctx, "v-aaaaaaaaaaaa", "X"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown rename: %v", err)
	}
	vs, err := st.VirtualFloors(ctx)
	if err != nil || len(vs) != 2 || vs[0].ID != "v-0123456789ab" || vs[0].Name != "Web" || vs[1].BaseSession != "t" {
		t.Fatalf("virtual floors = %+v, %v", vs, err)
	}
	if err := st.DeleteVirtualFloor(ctx, "v-00000000000f", false); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteVirtualFloor(ctx, "v-00000000000f", false); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	if vs, _ := st.VirtualFloors(ctx); len(vs) != 1 {
		t.Fatalf("after delete = %+v", vs)
	}
}

// A virtual floor with open workers cannot be deleted; once they are gone
// (closed) it can, its closed workers go back to the real floor and every
// row keyed by it goes.
func TestDeleteVirtualFloorRefusesWorkersAndDropsItsRows(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	const vf = "v-0123456789ab"
	if _, err := st.CreateBuilding(ctx, "b1", "Work"); err != nil {
		t.Fatal(err)
	}
	if err := st.AssignFloor(ctx, "s", "b1", -1); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateVirtualFloor(ctx, vf, "Web", "s"); err != nil {
		t.Fatal(err)
	}
	for _, w := range []store.Worker{{ID: "u1", Session: "s", FloorID: vf}, {ID: "u2", Session: "s", FloorID: vf}, {ID: "u3", Session: "s"}} {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	if ids, err := st.FloorWorkers(ctx, vf); err != nil || !slices.Equal(ids, []string{"u1", "u2"}) {
		t.Fatalf("floor workers = %v, %v", ids, err)
	}
	if ids, err := st.FloorWorkers(ctx, "s"); err != nil || !slices.Equal(ids, []string{"u3"}) {
		t.Fatalf("real floor workers = %v, %v", ids, err)
	}
	err := st.DeleteVirtualFloor(ctx, vf, false)
	if !errors.Is(err, store.ErrFloorHasWorkers) || !strings.Contains(err.Error(), "2 workers") {
		t.Fatalf("delete with workers: %v", err)
	}
	if err := st.SetWorkerFloor(ctx, "u2", "s"); err != nil {
		t.Fatal(err)
	}
	if err := st.CloseWorker(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := st.AssignDesk(ctx, vf, 0, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := st.ClaimName(ctx, vf, "Pixel", "u1"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFloorSettings(ctx, vf, store.FloorSettings{Repo: "o/r"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastHire(ctx, vf, store.Hire{Harness: "claude", Model: "opus", Effort: "high"}); err != nil {
		t.Fatal(err)
	}
	presets, err := st.Presets(ctx)
	if err != nil || len(presets) == 0 {
		t.Fatalf("presets = %+v, %v", presets, err)
	}
	if err := st.SetLastPreset(ctx, vf, presets[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFloorHidden(ctx, vf, true); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteVirtualFloor(ctx, vf, false); err != nil {
		t.Fatal(err)
	}
	ws, _ := st.SessionWorkers(ctx, "s")
	for _, w := range ws {
		if w.FloorID != "s" {
			t.Errorf("worker %s floor = %q after delete", w.ID, w.FloorID)
		}
	}
	if ds, _ := st.Desks(ctx); len(ds) != 0 {
		t.Errorf("desks = %+v", ds)
	}
	if ns, _ := st.Names(ctx); len(ns) != 0 {
		t.Errorf("names = %+v", ns)
	}
	if fs, _ := st.FloorSettings(ctx); len(fs) != 0 {
		t.Errorf("settings = %+v", fs)
	}
	if hs, _ := st.LastHires(ctx); len(hs) != 0 {
		t.Errorf("last hires = %+v", hs)
	}
	if ps, _ := st.LastPresets(ctx); len(ps) != 0 {
		t.Errorf("last presets = %+v", ps)
	}
	if h, _ := st.HiddenFloors(ctx); len(h) != 0 {
		t.Errorf("hidden = %v", h)
	}
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{"s"}) {
		t.Errorf("building floors = %v", got)
	}
}

// With moveWorkers, a virtual floor with open workers goes too: they are
// back on its session's real floor.
func TestDeleteVirtualFloorMovingItsWorkers(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	const vf = "v-0123456789ab"
	if _, err := st.CreateVirtualFloor(ctx, vf, "Web", "s"); err != nil {
		t.Fatal(err)
	}
	for _, w := range []store.Worker{{ID: "u1", Session: "s", FloorID: vf}, {ID: "u2", Session: "s"}} {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.AssignDesk(ctx, vf, 0, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteVirtualFloor(ctx, vf, true); err != nil {
		t.Fatal(err)
	}
	if ids, err := st.FloorWorkers(ctx, "s"); err != nil || !slices.Equal(ids, []string{"u1", "u2"}) {
		t.Fatalf("real floor workers = %v, %v", ids, err)
	}
	if ds, _ := st.Desks(ctx); len(ds) != 0 {
		t.Errorf("desks = %+v", ds)
	}
	if vs, _ := st.VirtualFloors(ctx); len(vs) != 0 {
		t.Errorf("virtual floors = %+v", vs)
	}
}

// Decision 4: a virtual floor stands in its base's building. It joins it
// when created, moves within it only, follows its base to another building
// and out of every building.
func TestVirtualFloorsFollowTheirBase(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	for _, b := range []string{"b1", "b2"} {
		if _, err := st.CreateBuilding(ctx, b, b); err != nil {
			t.Fatal(err)
		}
	}
	const v1, v2, v3 = "v-000000000001", "v-000000000002", "v-000000000003"
	// Created while its base is unassigned: unassigned too.
	if _, err := st.CreateVirtualFloor(ctx, v1, "One", "s"); err != nil {
		t.Fatal(err)
	}
	if err := st.AssignFloor(ctx, v1, "b1", 0); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("virtual floor of an unassigned base assigned: %v", err)
	}
	for _, f := range []string{"x", "s", "y"} {
		if err := st.AssignFloor(ctx, f, "b1", -1); err != nil {
			t.Fatal(err)
		}
	}
	// The base joined b1: its virtual floor came right after it.
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{"x", "s", v1, "y"}) {
		t.Fatalf("b1 = %v", got)
	}
	// Created while the base is placed: last in the base's building.
	if _, err := st.CreateVirtualFloor(ctx, v2, "Two", "s"); err != nil {
		t.Fatal(err)
	}
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{"x", "s", v1, "y", v2}) {
		t.Fatalf("b1 = %v", got)
	}
	// Moves within the building only.
	if err := st.AssignFloor(ctx, v2, "b1", 0); err != nil {
		t.Fatal(err)
	}
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{v2, "x", "s", v1, "y"}) {
		t.Fatalf("b1 = %v", got)
	}
	for _, b := range []string{"b2", ""} {
		if err := st.AssignFloor(ctx, v2, b, 0); !errors.Is(err, store.ErrInvalid) {
			t.Fatalf("virtual floor to %q: %v", b, err)
		}
	}
	// Reordering the base within its building leaves its virtual floors.
	if err := st.AssignFloor(ctx, "s", "b1", 4); err != nil {
		t.Fatal(err)
	}
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{v2, "x", v1, "y", "s"}) {
		t.Fatalf("b1 = %v", got)
	}
	// Another session's virtual floor is not taken along.
	if err := st.AssignFloor(ctx, "t", "b2", -1); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateVirtualFloor(ctx, v3, "Three", "t"); err != nil {
		t.Fatal(err)
	}
	// The base moves to b2: its virtual floors follow in their order.
	if err := st.AssignFloor(ctx, "s", "b2", 0); err != nil {
		t.Fatal(err)
	}
	if got := floorsOf(t, st, "b1"); !slices.Equal(got, []string{"x", "y"}) {
		t.Fatalf("b1 = %v", got)
	}
	if got := floorsOf(t, st, "b2"); !slices.Equal(got, []string{"s", v2, v1, "t", v3}) {
		t.Fatalf("b2 = %v", got)
	}
	// Unassigned: all of them leave.
	if err := st.AssignFloor(ctx, "s", "", 0); err != nil {
		t.Fatal(err)
	}
	if got := floorsOf(t, st, "b2"); !slices.Equal(got, []string{"t", v3}) {
		t.Fatalf("b2 = %v", got)
	}
	if as, _ := st.Assignments(ctx); len(as) != 4 {
		t.Fatalf("assignments = %+v", as)
	}
}

func TestHiddenFloors(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	for _, f := range []string{"s", "v-0123456789ab"} {
		if err := st.SetFloorHidden(ctx, f, true); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SetFloorHidden(ctx, "s", true); err != nil { // twice is fine
		t.Fatal(err)
	}
	if err := st.SetFloorHidden(ctx, "v-0123456789ab", false); err != nil {
		t.Fatal(err)
	}
	if h, err := st.HiddenFloors(ctx); err != nil || len(h) != 1 || !h["s"] {
		t.Fatalf("hidden = %v, %v", h, err)
	}
	if err := st.SetFloorHidden(ctx, "", true); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("empty floor: %v", err)
	}
}

func TestRunLaunchFloor(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	l := store.RunLaunch{ID: "l1", Session: "s", FloorID: "v-0123456789ab", OrchWorkerID: "u1", PresetID: "p", PresetName: "P"}
	if err := st.RecordRunLaunch(ctx, l); err != nil {
		t.Fatal(err)
	}
	l.ID, l.OrchWorkerID, l.FloorID = "l2", "u2", ""
	if err := st.RecordRunLaunch(ctx, l); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := st.RunLaunchByWorker(ctx, "u1"); err != nil || !ok || got.FloorID != "v-0123456789ab" || got.Session != "s" {
		t.Fatalf("u1 launch = %+v, %v, %v", got, ok, err)
	}
	if got, ok, err := st.RunLaunchByWorker(ctx, "u2"); err != nil || !ok || got.FloorID != "s" {
		t.Fatalf("u2 launch = %+v, %v, %v", got, ok, err)
	}
}

func TestWorkerFloor(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	if err := st.SaveWorker(ctx, store.Worker{ID: "u1", Session: "s", FloorID: "v-0123456789ab", WorkspaceID: "w1"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveWorker(ctx, store.Worker{ID: "u2", Session: "s", WorkspaceID: "w2"}); err != nil {
		t.Fatal(err)
	}
	ws, err := st.SessionWorkers(ctx, "s")
	if err != nil || len(ws) != 2 {
		t.Fatalf("workers = %+v, %v", ws, err)
	}
	got := map[string]string{}
	for _, w := range ws {
		got[w.ID] = w.FloorID
	}
	if got["u1"] != "v-0123456789ab" || got["u2"] != "s" {
		t.Fatalf("floors = %v", got)
	}
	// Re-attributed (a deleted floor's fallback): the save carries it.
	if err := st.SaveWorker(ctx, store.Worker{ID: "u1", Session: "s", FloorID: "s", WorkspaceID: "w1"}); err != nil {
		t.Fatal(err)
	}
	if ids, _ := st.FloorWorkers(ctx, "s"); !slices.Equal(ids, []string{"u1", "u2"}) {
		t.Fatalf("real floor workers = %v", ids)
	}
}
