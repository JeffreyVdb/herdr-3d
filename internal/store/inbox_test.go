package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #106: a dismissal survives a restart, is replaced by a newer one, goes when
// the worker is no longer done in the same episode, and with the worker.
func TestInboxDismissed(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	for _, w := range []store.Worker{
		{ID: "a", Session: "s", WorkspaceID: "w-a", Label: "a", Status: "done", StatusSince: 1000},
		{ID: "b", Session: "s", WorkspaceID: "w-b", Label: "b", Status: "done", StatusSince: 2000},
		{ID: "c", Session: "s", WorkspaceID: "w-c", Label: "c", Status: "done", StatusSince: 3000},
	} {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	for id, since := range map[string]int64{"a": 1000, "b": 2000, "c": 3000} {
		if err := st.DismissInbox(ctx, id, since); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	st = open(t, path)
	if got, err := st.InboxDismissed(ctx); err != nil || !reflect.DeepEqual(got, map[string]int64{"a": 1000, "b": 2000, "c": 3000}) {
		t.Fatalf("after reopen = %v, %v", got, err)
	}

	// Episode match: a is done again since 1500, b went back to work, c is untouched.
	if err := st.SetWorkerStatus(ctx, "a", "done", 1500); err != nil {
		t.Fatal(err)
	}
	if err := st.SetWorkerStatus(ctx, "b", "working", 2500); err != nil {
		t.Fatal(err)
	}
	gone, err := st.PruneInboxDismissed(ctx)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(gone)
	if !reflect.DeepEqual(gone, []string{"a", "b"}) {
		t.Fatalf("pruned %v", gone)
	}
	if got, _ := st.InboxDismissed(ctx); !reflect.DeepEqual(got, map[string]int64{"c": 3000}) {
		t.Fatalf("after prune = %v", got)
	}
	if gone, err := st.PruneInboxDismissed(ctx); err != nil || len(gone) != 0 {
		t.Fatalf("second prune = %v, %v", gone, err)
	}

	// A newer dismissal replaces the older one; forgetting removes it.
	if err := st.DismissInbox(ctx, "a", 1500); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.InboxDismissed(ctx); !reflect.DeepEqual(got, map[string]int64{"a": 1500, "c": 3000}) {
		t.Fatalf("after re-dismiss = %v", got)
	}
	if err := st.ForgetInboxDismissed(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.InboxDismissed(ctx); !reflect.DeepEqual(got, map[string]int64{"c": 3000}) {
		t.Fatalf("after forget = %v", got)
	}

	// A worker nobody stored cannot be dismissed.
	if err := st.DismissInbox(ctx, "nobody", 1); err == nil {
		t.Fatal("dismissed an unknown worker")
	}
}

// The dismissal goes with its worker (ON DELETE CASCADE).
func TestInboxDismissedCascade(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if err := st.SaveWorker(ctx, store.Worker{ID: "a", Session: "s", WorkspaceID: "w-a", Label: "a", Status: "done", StatusSince: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.DismissInbox(ctx, "a", 1); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`DELETE FROM worker WHERE id = 'a'`); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.InboxDismissed(ctx); len(got) != 0 {
		t.Fatalf("dismissal outlived its worker: %v", got)
	}
}
