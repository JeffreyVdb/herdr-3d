package store_test

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// The board cache: both boards of a good poll, the open set replaced by the
// next one, the announced merges kept (and only once each), and all of it
// there after the database is opened again.
func TestBoardCache(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	if c, err := st.BoardCaches(ctx); err != nil || len(c) != 0 {
		t.Fatalf("empty = %+v %v", c, err)
	}
	if err := st.SaveBoardPoll(ctx, "", "k", nil, nil, 0, 0, nil, nil); err == nil {
		t.Fatal("saved a poll of no floor")
	}
	err := st.SaveBoardPoll(ctx, "s", "fake:a/b", []byte(`{"t":"board.issues"}`), []byte(`{"t":"board.prs"}`), 1000, 1001,
		[]string{"a/b#1", "a/b#2"}, []store.BoardMerge{{ID: "a/b#9", MergedAt: 500}})
	if err != nil {
		t.Fatal(err)
	}
	c, _ := st.BoardCaches(ctx)
	got := c["s"]
	if got.Source != "fake:a/b" || string(got.Issues) != `{"t":"board.issues"}` || got.IssuesAt != 1000 || string(got.PRs) != `{"t":"board.prs"}` ||
		got.PRsAt != 1001 || !slices.Equal(got.OpenPRs, []string{"a/b#1", "a/b#2"}) || !got.Announced[store.MergeKey("a/b#9", 500)] || len(got.Announced) != 1 {
		t.Fatalf("cache = %+v", got)
	}
	// The next poll replaces the boards and the open set; merges pile up, once each.
	err = st.SaveBoardPoll(ctx, "s", "fake:a/b", []byte(`{"n":2}`), []byte(`{"n":2}`), 2000, 2000, []string{"a/b#2"},
		[]store.BoardMerge{{ID: "a/b#1", MergedAt: 1500}, {ID: "a/b#9", MergedAt: 500}})
	if err != nil {
		t.Fatal(err)
	}
	c, _ = st.BoardCaches(ctx)
	got = c["s"]
	if string(got.Issues) != `{"n":2}` || got.IssuesAt != 2000 || !slices.Equal(got.OpenPRs, []string{"a/b#2"}) || len(got.Announced) != 2 ||
		!got.Announced[store.MergeKey("a/b#1", 1500)] {
		t.Fatalf("cache = %+v", got)
	}
	// Another floor is its own.
	if err := st.SaveBoardPoll(ctx, "t", "fake:c/d", []byte(`{}`), nil, 3000, 0, nil, nil); err != nil {
		t.Fatal(err)
	}
	if c, _ = st.BoardCaches(ctx); c["t"].PRs != nil || c["t"].Issues == nil || len(c["t"].Announced) != 0 || len(c["s"].OpenPRs) != 1 {
		t.Fatalf("floors = %+v", c)
	}
	st.Close()

	st = open(t, path)
	c, _ = st.BoardCaches(ctx)
	if got = c["s"]; string(got.PRs) != `{"n":2}` || len(got.Announced) != 2 || !slices.Equal(got.OpenPRs, []string{"a/b#2"}) {
		t.Fatalf("after reopening: %+v", got)
	}
	// A changed link drops the cache and the open set, not what was announced.
	if err := st.ClearBoard(ctx, "s"); err != nil {
		t.Fatal(err)
	}
	c, _ = st.BoardCaches(ctx)
	if got = c["s"]; got.Issues != nil || got.PRs != nil || len(got.OpenPRs) != 0 || len(got.Announced) != 2 {
		t.Fatalf("after clearing: %+v", got)
	}
	if c["t"].Issues == nil {
		t.Fatal("cleared another floor")
	}
}

// A hire's base branch is remembered for its pull request; records from before
// M7 have none.
func TestHireBranchBase(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	rec := store.HireBranch{WorkerID: "w1", Session: "s", RepoRoot: "/r", Branch: "h3d/a-b", BaseSHA: "abc", Base: "main"}
	if err := st.RecordHireBranch(ctx, rec); err != nil {
		t.Fatal(err)
	}
	got, ok, err := st.HireBranchOf(ctx, "w1")
	if err != nil || !ok || got != rec {
		t.Fatalf("record = %+v %v %v", got, ok, err)
	}
	old := rec
	old.WorkerID, old.Base = "w2", ""
	if err := st.RecordHireBranch(ctx, old); err != nil {
		t.Fatal(err)
	}
	if got, _, _ = st.HireBranchOf(ctx, "w2"); got.Base != "" {
		t.Fatalf("base = %q", got.Base)
	}
}
