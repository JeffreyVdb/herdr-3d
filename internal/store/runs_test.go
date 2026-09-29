package store_test

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestWorkerRuns(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	for _, w := range []store.Worker{{ID: "o", Session: "s", WorkspaceID: "w1", Label: "ORCH|x"},
		{ID: "p", Session: "s", WorkspaceID: "w2", Label: "ORCH|y"}, {ID: "q", Session: "t", WorkspaceID: "w1", Label: "ORCH|z"}} {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	two, zero := 2, 0
	for id, r := range map[string]store.WorkerRun{"o": {Phase: "review", Pass: &two}, "p": {Phase: "coding"}, "q": {Pass: &zero}} {
		if err := st.SetWorkerRun(ctx, id, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.SetWorkerRun(ctx, "p", store.WorkerRun{Phase: "fixing", Pass: &zero}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	got, err := st.WorkerRuns(ctx, "s")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]store.WorkerRun{"o": {Phase: "review", Pass: &two}, "p": {Phase: "fixing", Pass: &zero}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("runs = %+v, want %+v", got, want)
	}
	if err := st.SetWorkerRun(ctx, "nobody", store.WorkerRun{Phase: "x"}); err == nil {
		t.Fatal("a run needs its worker")
	}
}
