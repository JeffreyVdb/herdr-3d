package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #62: a schedule survives a restart with every field; the listing leaves
// out cancelled and dismissed ones; done ones beyond the kept number of a
// floor are pruned, the oldest fired first.
func TestSchedules(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	a := store.Schedule{ID: "sch_a", Floor: "s", Title: "Soak done", Prompt: "Delete the backups.", DueAt: 1790000600000,
		OnMiss: "run_late", MaxLateness: 3600000, Harness: "claude", Model: "claude-opus-5-5", Effort: "high", Cwd: "/home/u/repo",
		Worktree: true, WakeFloor: true, HandoffPath: "/h/s/a.md", Source: "transcript", SourceWorker: "u1",
		SourceMessage: "m-1", State: store.ScheduleScheduled, CreatedAt: 1790000000000, UpdatedAt: 1790000000000}
	b := store.Schedule{ID: "sch_b", Floor: "s", Title: "B", Prompt: "p", DueAt: 1790000500000, OnMiss: "skip",
		Harness: "codex", Model: "gpt-6-sol", Effort: "low", Cwd: "/tmp", Source: "manual", State: store.ScheduleScheduled,
		CreatedAt: 1, UpdatedAt: 1}
	for _, s := range []store.Schedule{a, b} {
		if err := st.AddSchedule(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.AddSchedule(ctx, a); err == nil {
		t.Fatal("same id stored twice")
	}
	st.Close()
	st = open(t, path)
	if got, err := st.ScheduleByID(ctx, "sch_a"); err != nil || !reflect.DeepEqual(got, a) {
		t.Fatalf("a = %+v, %v", got, err)
	}
	if _, err := st.ScheduleByID(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	if l, err := st.Schedules(ctx); err != nil || !reflect.DeepEqual(l, []store.Schedule{b, a}) {
		t.Fatalf("listed = %+v, %v", l, err)
	}

	// A transition writes the state and its instants; source and floor stay.
	a.State, a.StateReason, a.SeenAt, a.FiredAt, a.WorkerID, a.UpdatedAt = store.ScheduleRunning, "", 1790000600100,
		1790000600100, "u9", 1790000600100
	a.Source, a.Floor = "manual", "other"
	if err := st.SaveSchedule(ctx, a); err != nil {
		t.Fatal(err)
	}
	a.Source, a.Floor = "transcript", "s"
	if got, _ := st.ScheduleByID(ctx, "sch_a"); !reflect.DeepEqual(got, a) {
		t.Fatalf("saved a = %+v", got)
	}
	if err := st.SaveSchedule(ctx, store.Schedule{ID: "nope", OnMiss: "skip", State: "done"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("save unknown: %v", err)
	}
	// Only known states and on_miss values are stored.
	bad := b
	bad.State = "fired"
	if err := st.SaveSchedule(ctx, bad); err == nil {
		t.Fatal("unknown state stored")
	}
	bad = b
	bad.OnMiss = "later"
	if err := st.SaveSchedule(ctx, bad); err == nil {
		t.Fatal("unknown on_miss stored")
	}

	// Cancelled, and failed once dismissed, leave the listing.
	b.State, b.StateReason = store.ScheduleFailed, "floor asleep"
	if err := st.SaveSchedule(ctx, b); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.Schedules(ctx); len(l) != 2 {
		t.Fatalf("failed not listed: %+v", l)
	}
	b.DismissedAt = 1790000700000
	if err := st.SaveSchedule(ctx, b); err != nil {
		t.Fatal(err)
	}
	a.State = store.ScheduleCancelled
	if err := st.SaveSchedule(ctx, a); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.Schedules(ctx); len(l) != 0 {
		t.Fatalf("cancelled or dismissed listed: %+v", l)
	}
	if got, _ := st.ScheduleByID(ctx, "sch_b"); got.DismissedAt != 1790000700000 {
		t.Fatalf("dismissed b = %+v", got)
	}
}

func TestPruneDoneSchedules(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	add := func(id, floor, state string, fired int64) {
		t.Helper()
		s := store.Schedule{ID: id, Floor: floor, Title: id, Prompt: "p", DueAt: fired, OnMiss: "run_late", Harness: "claude",
			Model: "m", Effort: "e", Cwd: "/", Source: "manual", State: state, FiredAt: fired, CreatedAt: 1, UpdatedAt: 1}
		if err := st.AddSchedule(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	for i := range 5 {
		add(fmt.Sprintf("d%d", i), "s", store.ScheduleDone, int64(100+i))
	}
	add("other", "t", store.ScheduleDone, 1)
	add("failed", "s", store.ScheduleFailed, 2)
	gone, err := st.PruneDoneSchedules(ctx, "s", 3)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(gone)
	if !slices.Equal(gone, []string{"d0", "d1"}) {
		t.Fatalf("pruned %v", gone)
	}
	var left []string
	l, _ := st.Schedules(ctx)
	for _, s := range l {
		left = append(left, s.ID)
	}
	slices.Sort(left)
	if !slices.Equal(left, []string{"d2", "d3", "d4", "failed", "other"}) {
		t.Fatalf("left %v", left)
	}
	if gone, err := st.PruneDoneSchedules(ctx, "s", 3); err != nil || len(gone) != 0 {
		t.Fatalf("pruned again: %v, %v", gone, err)
	}
}

func TestWorkerExists(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	if err := st.SaveWorker(ctx, store.Worker{ID: "u1", Session: "s", WorkspaceID: "w1", Label: "x"}); err != nil {
		t.Fatal(err)
	}
	if err := st.CloseWorker(ctx, "u1"); err != nil {
		t.Fatal(err)
	}
	if ok, err := st.WorkerExists(ctx, "u1"); !ok || err != nil {
		t.Fatalf("closed worker: %v, %v", ok, err)
	}
	if ok, err := st.WorkerExists(ctx, "u2"); ok || err != nil {
		t.Fatalf("unknown worker: %v, %v", ok, err)
	}
}

// #127: a database from before schedules' "Add herdr hiring instructions"
// keeps its schedules with the box off; the flag is stored, survives a
// restart and a save replaces it.
func TestScheduleInstructions(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	added := slices.IndexFunc(store.Migrations, func(q string) bool {
		return strings.Contains(q, "ALTER TABLE schedule ADD COLUMN herdr_instructions")
	})
	if added < 0 {
		t.Fatal("no migration adds schedule.herdr_instructions")
	}
	for _, q := range store.Migrations[:added] {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		"PRAGMA user_version = " + strconv.Itoa(added),
		`INSERT INTO schedule (id, floor, title, prompt, due_at, harness, model, effort, cwd, state, created_at, updated_at)
			VALUES ('sch_old', 's', 'Old', 'For each PR, spawn a subagent.', 5, 'claude', 'm', 'e', '/r', 'scheduled', 1, 1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	old := store.Schedule{ID: "sch_old", Floor: "s", Title: "Old", Prompt: "For each PR, spawn a subagent.", DueAt: 5,
		OnMiss: "run_late", Harness: "claude", Model: "m", Effort: "e", Cwd: "/r", WakeFloor: true, Source: "manual",
		State: store.ScheduleScheduled, CreatedAt: 1, UpdatedAt: 1}
	if got, err := st.ScheduleByID(ctx, "sch_old"); err != nil || !reflect.DeepEqual(got, old) {
		t.Fatalf("migrated = %+v, %v", got, err)
	}
	ticked := store.Schedule{ID: "sch_new", Floor: "v-mon", Title: "New", Prompt: "Hire reviewers.", DueAt: 6, OnMiss: "skip",
		Harness: "codex", Model: "m", Effort: "e", Cwd: "/r", Source: "manual", State: store.ScheduleScheduled,
		HerdrInstructions: true, CreatedAt: 2, UpdatedAt: 2}
	if err := st.AddSchedule(ctx, ticked); err != nil {
		t.Fatal(err)
	}
	on := old
	on.HerdrInstructions, on.UpdatedAt = true, 3
	if err := st.SaveSchedule(ctx, on); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if l, _ := st.Schedules(ctx); !reflect.DeepEqual(l, []store.Schedule{on, ticked}) {
		t.Fatalf("after restart = %+v", l)
	}
	off := ticked
	off.HerdrInstructions, off.UpdatedAt = false, 4
	if err := st.SaveSchedule(ctx, off); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.ScheduleByID(ctx, "sch_new"); !reflect.DeepEqual(got, off) {
		t.Fatalf("after unticking = %+v", got)
	}
}
