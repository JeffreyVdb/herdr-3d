package store_test

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func open(t *testing.T, path string) *store.Store {
	t.Helper()
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func floorsOf(t *testing.T, st *store.Store, building string) []string {
	t.Helper()
	as, err := st.Assignments(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, a := range as {
		if a.BuildingID == building {
			if a.Index != len(out) {
				t.Fatalf("building %s: floor indexes not dense: %+v", building, as)
			}
			out = append(out, a.Session)
		}
	}
	return out
}

func TestOpenMigratesOnceAndPersists(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "state", "world.db")
	st := open(t, path)
	if _, err := st.CreateBuilding(ctx, "b1", "Work"); err != nil {
		t.Fatal(err)
	}
	st.Close()
	for _, p := range []string{path, filepath.Dir(path)} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if want := os.FileMode(0o600); fi.IsDir() {
			want = 0o700 | os.ModeDir
			if fi.Mode() != want {
				t.Errorf("%s mode = %v, want %v", p, fi.Mode(), want)
			}
		} else if fi.Mode().Perm() != want {
			t.Errorf("%s mode = %v, want %v", p, fi.Mode(), want)
		}
	}
	st = open(t, path) // re-open: migrations must not re-run
	bs, err := st.Buildings(ctx)
	if err != nil || len(bs) != 1 || bs[0].Name != "Work" {
		t.Fatalf("buildings = %+v, %v", bs, err)
	}
}

func TestBuildingCommands(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	for i, name := range []string{"Work", "Personal", "Games"} {
		b, err := st.CreateBuilding(ctx, "b"+string(rune('1'+i)), name)
		if err != nil || b.Sort != i {
			t.Fatalf("create %s: %+v %v", name, b, err)
		}
	}
	if _, err := st.CreateBuilding(ctx, "b9", " work "); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("duplicate name: %v", err)
	}
	if _, err := st.CreateBuilding(ctx, "b9", "   "); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("blank name: %v", err)
	}
	if err := st.RenameBuilding(ctx, "b1", "Office"); err != nil {
		t.Fatal(err)
	}
	if err := st.RenameBuilding(ctx, "b1", "office"); err != nil {
		t.Fatalf("renaming to own name in other case: %v", err)
	}
	if err := st.RenameBuilding(ctx, "b2", "OFFICE"); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("rename onto another's name: %v", err)
	}
	if err := st.RenameBuilding(ctx, "nope", "X"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("rename missing: %v", err)
	}
	if err := st.ReorderBuildings(ctx, []string{"b3", "b1", "b2"}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"b3", "b1"}, {"b3", "b1", "b1"}, {"b3", "b1", "zz"}} {
		if err := st.ReorderBuildings(ctx, bad); err == nil {
			t.Errorf("reorder %v accepted", bad)
		}
	}
	names := func() []string {
		bs, _ := st.Buildings(ctx)
		var out []string
		for _, b := range bs {
			out = append(out, b.ID+":"+b.Name)
		}
		return out
	}
	if got := names(); !slices.Equal(got, []string{"b3:Games", "b1:office", "b2:Personal"}) {
		t.Fatalf("after reorder: %v", got)
	}
	if err := st.DeleteBuilding(ctx, "b1"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteBuilding(ctx, "b1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	bs, _ := st.Buildings(ctx)
	if len(bs) != 2 || bs[0].Sort != 0 || bs[1].Sort != 1 {
		t.Fatalf("sort not renumbered after delete: %+v", bs)
	}
}

func TestAssignFloor(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	for _, id := range []string{"work", "home"} {
		if _, err := st.CreateBuilding(ctx, id, id); err != nil {
			t.Fatal(err)
		}
	}
	assign := func(session, building string, index int) {
		t.Helper()
		if err := st.AssignFloor(ctx, session, building, index); err != nil {
			t.Fatal(err)
		}
	}
	assign("a", "work", -1)
	assign("b", "work", -1)
	assign("c", "work", 0)
	assign("d", "work", 99) // clamped: appends
	if got := floorsOf(t, st, "work"); !slices.Equal(got, []string{"c", "a", "b", "d"}) {
		t.Fatalf("work = %v", got)
	}
	assign("a", "work", 3) // move within the building
	if got := floorsOf(t, st, "work"); !slices.Equal(got, []string{"c", "b", "d", "a"}) {
		t.Fatalf("work after move = %v", got)
	}
	assign("b", "home", -1) // move across buildings: both stay dense
	if got := floorsOf(t, st, "work"); !slices.Equal(got, []string{"c", "d", "a"}) {
		t.Fatalf("work after b left = %v", got)
	}
	if got := floorsOf(t, st, "home"); !slices.Equal(got, []string{"b"}) {
		t.Fatalf("home = %v", got)
	}
	assign("d", "", -1) // unassign
	if got := floorsOf(t, st, "work"); !slices.Equal(got, []string{"c", "a"}) {
		t.Fatalf("work after unassign = %v", got)
	}
	if err := st.AssignFloor(ctx, "x", "nope", -1); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("assign to missing building: %v", err)
	}
	if err := st.AssignFloor(ctx, "", "work", -1); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("assign empty session: %v", err)
	}
	// Deleting a building sends its floors back to the unassigned lot.
	if err := st.DeleteBuilding(ctx, "work"); err != nil {
		t.Fatal(err)
	}
	as, _ := st.Assignments(ctx)
	if len(as) != 1 || as[0].Session != "b" {
		t.Fatalf("assignments after delete = %+v", as)
	}
}

func TestWorkers(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	w := store.Worker{ID: "u1", Session: "s", WorkspaceID: "w1", Label: "CODE|x", Fingerprints: []store.Fingerprint{
		{Kind: store.FPAgentSession, Value: "sess-a"}, {Kind: store.FPLabelCwd, Value: "CODE|x\x00/p"},
	}}
	if err := st.SaveWorker(ctx, w); err != nil {
		t.Fatal(err)
	}
	// A new agent session (Claude /clear) adds evidence; the old one stays.
	w.Fingerprints = []store.Fingerprint{{Kind: store.FPAgentSession, Value: "sess-b"}}
	if err := st.SaveWorker(ctx, w); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveWorker(ctx, store.Worker{ID: "u2", Session: "other", WorkspaceID: "w1", Label: "y"}); err != nil {
		t.Fatal(err)
	}
	ws, err := st.SessionWorkers(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 1 || ws[0].ID != "u1" || ws[0].Closed || len(ws[0].Fingerprints) != 3 {
		t.Fatalf("workers = %+v", ws)
	}
	if err := st.CloseWorker(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	ws, _ = st.SessionWorkers(ctx, "s")
	if !ws[0].Closed {
		t.Fatal("worker not closed")
	}
	if err := st.SaveWorker(ctx, w); err != nil { // seen again: reopened
		t.Fatal(err)
	}
	ws, _ = st.SessionWorkers(ctx, "s")
	if ws[0].Closed {
		t.Fatal("saving a worker should reopen it")
	}
	// last seen is the caller's time; TouchWorker moves it.
	seen := time.UnixMilli(1_790_000_000_123)
	w.LastSeen = seen
	if err := st.SaveWorker(ctx, w); err != nil {
		t.Fatal(err)
	}
	if ws, _ = st.SessionWorkers(ctx, "s"); !ws[0].LastSeen.Equal(seen) {
		t.Fatalf("last seen %v, want %v", ws[0].LastSeen, seen)
	}
	if err := st.TouchWorker(ctx, "u1", seen.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if ws, _ = st.SessionWorkers(ctx, "s"); !ws[0].LastSeen.Equal(seen.Add(time.Hour)) {
		t.Fatalf("touched: last seen %v, want %v", ws[0].LastSeen, seen.Add(time.Hour))
	}
}

func TestAudit(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	if err := st.Audit(ctx, "dump", "building.create", []byte(`{"name":"W"}`), nil); err != nil {
		t.Fatal(err)
	}
	if err := st.Audit(ctx, "dump", "building.delete", nil, store.ErrNotFound); err != nil {
		t.Fatal(err)
	}
	log, err := st.AuditLog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 2 || !log[0].OK || log[0].Args != `{"name":"W"}` || log[1].OK || log[1].Error != "not found" || log[1].Args != "{}" {
		t.Fatalf("audit = %+v", log)
	}
}

func TestRefusesNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.db")
	open(t, path).Close()
	// Simulate a database written by a newer bridge.
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA user_version = 99"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err := store.Open(context.Background(), path); err == nil {
		t.Fatal("opened a database from the future")
	}
}

func TestMigratesVersion1Forward(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	// A database as the M1 bridge left it.
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		store.Migrations[0],
		"PRAGMA user_version = 1",
		`INSERT INTO worker (id, session_name, workspace_id, label, created_at, last_seen_at) VALUES ('u1', 's', 'w1', 'CODE|x', 't', 't')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	ws, err := st.SessionWorkers(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	if len(ws) != 1 || ws[0].Label != "CODE|x" || ws[0].Name != "" || ws[0].StatusSince != 0 || ws[0].Model != "" {
		t.Fatalf("migrated workers = %+v", ws)
	}
	if err := st.AssignDesk(ctx, "s", 0, "u1"); err != nil {
		t.Fatal(err)
	}
	if ds, err := st.Desks(ctx); err != nil || len(ds) != 1 || ds[0] != (store.Desk{Floor: "s", Index: 0, WorkerID: "u1"}) {
		t.Fatalf("desks = %+v, %v", ds, err)
	}
}

func TestWorkerStateAndDesks(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	w := store.Worker{ID: "u1", Session: "s", WorkspaceID: "w1", Label: "a", Name: "Nibble", Status: "idle", StatusSince: 1000,
		Harness: "claude", Model: "claude-opus-5-5", Effort: "high"}
	for _, x := range []store.Worker{w, {ID: "u2", Session: "s", WorkspaceID: "w2", Label: "b"}, {ID: "u3", Session: "t", WorkspaceID: "w1", Label: "c"}} {
		if err := st.SaveWorker(ctx, x); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SetWorkerStatus(ctx, "u1", "working", 2000); err != nil {
		t.Fatal(err)
	}
	for _, d := range []store.Desk{{"s", 0, "u1"}, {"s", 1, "u2"}, {"t", 0, "u3"}} {
		if err := st.AssignDesk(ctx, d.Floor, d.Index, d.WorkerID); err != nil {
			t.Fatal(err)
		}
	}
	// A taken desk cannot be handed out twice, and indexes are >= 0.
	if err := st.AssignDesk(ctx, "s", 1, "u1"); err == nil {
		t.Fatal("two workers on one desk")
	}
	if err := st.AssignDesk(ctx, "s", -1, "u1"); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("negative desk: %v", err)
	}
	// Moving a worker frees its old desk.
	if err := st.AssignDesk(ctx, "s", 4, "u2"); err != nil {
		t.Fatal(err)
	}
	st.Close()

	st = open(t, path)
	ws, err := st.SessionWorkers(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]store.Worker{}
	for _, x := range ws {
		got[x.ID] = x
	}
	want := w
	want.Status, want.StatusSince = "working", 2000
	if g := got["u1"]; g.Name != want.Name || g.Status != want.Status || g.StatusSince != want.StatusSince ||
		g.Harness != want.Harness || g.Model != want.Model || g.Effort != want.Effort {
		t.Fatalf("u1 = %+v, want %+v", g, want)
	}
	ds, err := st.Desks(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ds, []store.Desk{{"s", 0, "u1"}, {"s", 4, "u2"}, {"t", 0, "u3"}}) {
		t.Fatalf("desks = %+v", ds)
	}
	if err := st.FreeDesk(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	if err := st.FreeFloorDesks(ctx, "t"); err != nil {
		t.Fatal(err)
	}
	if ds, _ := st.Desks(ctx); !slices.Equal(ds, []store.Desk{{"s", 4, "u2"}}) {
		t.Fatalf("desks after free = %+v", ds)
	}
}
