package store_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #219: a handoff's pending hire leaves a marker on its agent request or
// LLM job (never its task) that survives a restart until it is cleared, so
// a restarted bridge finds the hires it interrupted; a row without one is
// not listed.
func TestHandoffHireMarker(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	for _, id := range []string{"a", "b"} {
		if err := st.SaveWorker(ctx, store.Worker{ID: id, Session: "s", WorkspaceID: "w-" + id, Label: id}); err != nil {
			t.Fatal(err)
		}
	}
	ma := &store.HandoffHireMarker{Floor: "s", Desk: 2, Label: "Ada", Harness: "claude", Model: "opus", Effort: "high", Origin: "tab-1",
		WorkerName: "Pixel", SendHome: true, StartedAt: 1790000000000}
	mb := &store.HandoffHireMarker{Floor: "v-x", Desk: 0, Harness: "codex", Model: "gpt", Effort: "low", WorkerName: "Mochi", StartedAt: 1790000002000}
	ra := store.HandoffRequest{Op: "op-a", WorkerID: "a", Floor: "s", Harness: "claude", Offset: -1, Path: "/h/.pending/s/op-a.md",
		Nonce: "5f3c9a1e7b2d4086", State: store.HandoffRequestPending, CreatedAt: 1790000000000, Hire: ma}
	rn := store.HandoffRequest{Op: "op-n", WorkerID: "b", Floor: "s", Harness: "codex", Offset: -1, Path: "/h/.pending/s/op-n.md",
		Nonce: "0d1e2f3a4b5c6d7e", State: store.HandoffRequestPending, CreatedAt: 1790000001000}
	jb := store.HandoffLLMJob{Op: "op-b", WorkerID: "b", Floor: "s", Candidate: "c", ArgsHash: "h", PromptVersion: "1",
		State: store.HandoffJobRunning, CreatedAt: 1790000002000, UpdatedAt: 1790000002000, Hire: mb}
	for _, r := range []store.HandoffRequest{ra, rn} {
		if err := st.AddHandoffRequest(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.AddHandoffLLMJob(ctx, jb); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if got, err := st.HandoffRequestByOp(ctx, "op-a"); err != nil || !reflect.DeepEqual(got, ra) {
		t.Fatalf("op-a = %+v, %v", got, err)
	}
	if got, err := st.HandoffRequestByOp(ctx, "op-n"); err != nil || got.Hire != nil {
		t.Fatalf("op-n = %+v, %v", got, err)
	}
	if got, err := st.HandoffLLMJobByOp(ctx, "op-b"); err != nil || !reflect.DeepEqual(got, jb) {
		t.Fatalf("op-b = %+v, %v", got, err)
	}
	// A filed request keeps its marker until it is cleared: the hire after
	// it may have been running.
	ra.State, ra.HandoffID = store.HandoffRequestFiled, 7
	if err := st.UpdateHandoffRequest(ctx, ra); err != nil {
		t.Fatal(err)
	}
	rows, err := st.HandoffHireRows(ctx)
	want := []store.HandoffHireRow{{Op: "op-a", Mode: store.HandoffHireAgent, WorkerID: "a", State: store.HandoffRequestFiled, HandoffID: 7, Marker: *ma},
		{Op: "op-b", Mode: store.HandoffHireLLM, WorkerID: "b", State: store.HandoffJobRunning, Marker: *mb}}
	if err != nil || !reflect.DeepEqual(rows, want) {
		t.Fatalf("rows = %+v, %v", rows, err)
	}
	for _, op := range []string{"op-a", "op-b", "op-n", "nope"} {
		if err := st.ClearHandoffHire(ctx, op); err != nil {
			t.Fatal(err)
		}
	}
	if rows, err := st.HandoffHireRows(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("after clearing: %+v, %v", rows, err)
	}
	if got, _ := st.HandoffLLMJobByOp(ctx, "op-b"); got.Hire != nil {
		t.Fatalf("op-b kept its marker: %+v", got)
	}
	// The marker is what it says: no task, no review.
	b, _ := st.HandoffRequestByOp(ctx, "op-a")
	if b.Hire != nil || strings.Contains(markerJSON(ma), "prompt") || strings.Contains(markerJSON(ma), "secrets") {
		t.Fatalf("marker = %s", markerJSON(ma))
	}
}

func markerJSON(m *store.HandoffHireMarker) string {
	b, _ := json.Marshal(m)
	return string(b)
}
