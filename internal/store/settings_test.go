package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestFloorSettingsPersistAndClear(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	full := store.FloorSettings{
		Repo: "JeffreyVdb/herdr-3d", ProjectOwner: "JeffreyVdb", ProjectNumber: 3,
		StatusField: "Status", StatusOptions: []string{"Todo", "Doing", "QA", "Done"},
		DefaultCwd: "/home/u/herdr-3d", HireHarness: "codex", HireModel: "gpt-6-sol", HireEffort: "ultra",
	}
	if err := st.SetFloorSettings(ctx, "herdr-3d", full); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFloorSettings(ctx, "gone", store.FloorSettings{Repo: "o/r"}); err != nil {
		t.Fatal(err)
	}
	st.Close()

	st = open(t, path)
	got, err := st.FloorSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]store.FloorSettings{"herdr-3d": full, "gone": {Repo: "o/r"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("settings = %+v, want %+v", got, want)
	}
	// Clearing everything drops the row.
	if err := st.SetFloorSettings(ctx, "gone", store.FloorSettings{}); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.FloorSettings(ctx); len(got) != 1 {
		t.Fatalf("after clear = %+v", got)
	}
	if err := st.SetFloorSettings(ctx, "", full); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("empty session: %v", err)
	}
}

func TestAuditOfLongCommands(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	id, err := st.AuditBegin(ctx, "game", "floor.wake", []byte(`{"session":"s"}`))
	if err != nil {
		t.Fatal(err)
	}
	if log, _ := st.AuditLog(ctx); len(log) != 1 || log[0].Done || log[0].OK {
		t.Fatalf("in progress = %+v", log)
	}
	id2, err := st.AuditBegin(ctx, "game", "floor.sleep", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AuditEnd(ctx, id, nil, map[string]any{"workers": []string{"w1"}}); err != nil {
		t.Fatal(err)
	}
	if err := st.AuditEnd(ctx, id2, errors.New("herdr session stop: exit 1"), map[string]string{"stop": "boom"}); err != nil {
		t.Fatal(err)
	}
	log, err := st.AuditLog(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 2 || !log[0].Done || !log[0].OK || log[0].Result != `{"workers":["w1"]}` || log[0].Args != `{"session":"s"}` ||
		!log[1].Done || log[1].OK || log[1].Error != "herdr session stop: exit 1" || log[1].Result != `{"stop":"boom"}` {
		t.Fatalf("audit = %+v", log)
	}
	// Short commands are done at once and have no result.
	if err := st.Audit(ctx, "game", "building.create", nil, nil); err != nil {
		t.Fatal(err)
	}
	if log, _ := st.AuditLog(ctx); !log[2].Done || log[2].Result != "" {
		t.Fatalf("short = %+v", log[2])
	}
}

// A database as the M2 bridge left it (schema 3): audit rows are done and
// floor_repo exists afterwards.
func TestMigratesVersion3Forward(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		store.Migrations[0], store.Migrations[1], store.Migrations[2],
		"PRAGMA user_version = 3",
		`INSERT INTO audit_log (ts, client, cmd, args, ok, error) VALUES ('2026-09-01T10:00:00Z', 'c', 'building.create', '{}', 1, NULL)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	if log, err := st.AuditLog(ctx); err != nil || len(log) != 1 || !log[0].Done || !log[0].OK {
		t.Fatalf("audit = %+v, %v", log, err)
	}
	if err := st.SetFloorSettings(ctx, "s", store.FloorSettings{Repo: "o/r"}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	db, err = sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM floor_repo WHERE session_name = 's' AND repo = 'o/r'`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("floor_repo rows = %d, %v", n, err)
	}
}

func TestLastHireAndHiredAt(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	if err := st.SetLastHire(ctx, "s", store.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "low"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastHire(ctx, "s", store.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "ultra"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLastHire(ctx, "s", store.Hire{Harness: "codex"}); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("partial hire: %v", err)
	}
	w := store.Worker{ID: "a58752ea-6511-4318-be9a-59e41c09d7c5", Session: "s", WorkspaceID: "w1", Label: "Mochi", HiredAt: 1790601900000}
	if err := st.SaveWorker(ctx, w); err != nil {
		t.Fatal(err)
	}
	w.HiredAt = 0 // a later save without it keeps it
	w.Label = "Mochi 2"
	if err := st.SaveWorker(ctx, w); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	last, err := st.LastHires(ctx)
	if err != nil || !reflect.DeepEqual(last, map[string]store.Hire{"s": {Harness: "codex", Model: "gpt-6-sol", Effort: "ultra"}}) {
		t.Fatalf("last = %+v, %v", last, err)
	}
	ws, err := st.SessionWorkers(ctx, "s")
	if err != nil || len(ws) != 1 || ws[0].HiredAt != 1790601900000 || ws[0].Label != "Mochi 2" {
		t.Fatalf("workers = %+v, %v", ws, err)
	}
}

func TestHireBranches(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	b := store.HireBranch{WorkerID: "a58752ea-6511-4318-be9a-59e41c09d7c5", Session: "s", RepoRoot: "/home/u/repo",
		Branch: "h3d/mochi-a58752", BaseSHA: "8739ddc5f3e1d0c4b2a8e7f6d5c4b3a2918e7d6c"}
	if err := st.RecordHireBranch(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordHireBranch(ctx, store.HireBranch{WorkerID: "x", Branch: "h3d/x"}); !errors.Is(err, store.ErrInvalid) {
		t.Fatalf("partial record: %v", err)
	}
	st.Close()

	st = open(t, path)
	if got, ok, err := st.HireBranchOf(ctx, b.WorkerID); err != nil || !ok || got != b {
		t.Fatalf("HireBranchOf = %+v %v %v", got, ok, err)
	}
	if _, ok, err := st.HireBranchOf(ctx, "someone-else"); err != nil || ok {
		t.Fatalf("unrecorded worker: %v %v", ok, err)
	}
	if err := st.ForgetHireBranch(ctx, b.WorkerID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.HireBranchOf(ctx, b.WorkerID); err != nil || ok {
		t.Fatalf("after forget: %v %v", ok, err)
	}
}

// #184: a floor saved before the issue tracker choice is a GitHub floor
// after the migration; a Kaneo floor keeps its GitHub fields and its Kaneo
// link through a restart.
func TestFloorTrackerMigrationAndKaneoLink(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	before := len(store.Migrations) - 1 // the schema before #184
	for _, q := range store.Migrations[:before] {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		fmt.Sprintf("PRAGMA user_version = %d", before),
		`INSERT INTO floor_repo (session_name, repo, project_owner, project_number, updated_at) VALUES ('old', 'o/r', 'o', 3, '2026-09-01T10:00:00Z')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	fs, err := st.FloorSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if f := fs["old"]; f.Tracker != "" || f.Repo != "o/r" || f.ProjectNumber != 3 || f.KaneoProjectID != "" {
		t.Fatalf("migrated floor = %+v", f)
	}
	kaneo := store.FloorSettings{Repo: "o/r", ProjectOwner: "o", ProjectNumber: 3, Tracker: "kaneo", KaneoWorkspaceID: "ws1",
		KaneoWorkspaceName: "Studio", KaneoProjectID: "p1", KaneoProjectName: "Herdr"}
	if err := st.SetFloorSettings(ctx, "new", kaneo); err != nil {
		t.Fatal(err)
	}
	// Back to GitHub: the link is kept, the floor is not zero.
	inactive := kaneo
	inactive.Tracker, inactive.Repo, inactive.ProjectOwner, inactive.ProjectNumber = "", "", "", 0
	if inactive.IsZero() {
		t.Fatal("a floor with only a Kaneo link is zero")
	}
	if err := st.SetFloorSettings(ctx, "inactive", inactive); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	fs, _ = st.FloorSettings(ctx)
	if !reflect.DeepEqual(fs["new"], kaneo) || !reflect.DeepEqual(fs["inactive"], inactive) {
		t.Fatalf("after restart: %+v / %+v", fs["new"], fs["inactive"])
	}
}
