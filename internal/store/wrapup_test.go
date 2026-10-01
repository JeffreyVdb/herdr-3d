package store_test

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #83: a wrap-up survives a restart, is replaced by a re-arm, and only
// takes the states and choices it knows, for a stored worker.
func TestWrapUps(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	for _, id := range []string{"a", "b"} {
		if err := st.SaveWorker(ctx, store.Worker{ID: id, Session: "s", WorkspaceID: "w-" + id, Label: id}); err != nil {
			t.Fatal(err)
		}
	}
	a := store.WrapUp{WorkerID: "a", Session: "s", Nonce: "5f3c9a1e7b2d4086", Worktree: "delete", ArmedAt: 1790000000000,
		Transcript: "claude/6c1f0e2a", Offset: 4096, State: "armed"}
	b := store.WrapUp{WorkerID: "b", Session: "s", Nonce: "0d1e2f3a4b5c6d7e", Worktree: "keep", ArmedAt: 1790000001000,
		Transcript: "codex/01a0f500", Offset: 0, State: "needs_you", Reason: "did not report a wrap-up result"}
	for _, w := range []store.WrapUp{a, b} {
		if err := st.SetWrapUp(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	st = open(t, path)
	got, err := st.WrapUps(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []store.WrapUp{a, b}) {
		t.Fatalf("wrap-ups = %+v", got)
	}
	b.State, b.Nonce, b.Reason, b.Offset = "armed", "1111222233334444", "", 9000
	if err := st.SetWrapUp(ctx, b); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteWrapUp(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.WrapUps(ctx); !reflect.DeepEqual(got, []store.WrapUp{b}) {
		t.Fatalf("after re-arm and delete: %+v", got)
	}
	for _, bad := range []store.WrapUp{
		{WorkerID: "b", Session: "s", Nonce: "n", Worktree: "burn", Transcript: "t", State: "armed"},
		{WorkerID: "b", Session: "s", Nonce: "n", Worktree: "keep", Transcript: "t", State: "firing"},
		{WorkerID: "b", Session: "s", Nonce: "n", Worktree: "keep", Transcript: "t", State: "armed", Offset: -1},
		{WorkerID: "nobody", Session: "s", Nonce: "n", Worktree: "keep", Transcript: "t", State: "armed"},
	} {
		if err := st.SetWrapUp(ctx, bad); err == nil {
			t.Errorf("stored %+v", bad)
		}
	}
}
