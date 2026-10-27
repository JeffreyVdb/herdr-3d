package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #219: a handoff's pending hire leaves a marker on its agent request or
// LLM job (never its task) that survives a restart, so a restarted bridge
// finds the hires it interrupted; once the hire ended it says how; a row
// without one is not listed.
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
		WorkerName: "Pixel", SendHome: true, StartedAt: 1790000000000, Owners: []string{"OWNERA"}}
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
	// A filed request is listed until its hire ended: the hire after it may
	// have been running.
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
	// Ended, the marker says how and stays; a pending request's is still
	// listed (it resumes), the others are not.
	end := func(m *store.HandoffHireMarker) store.HandoffHireMarker {
		e := *m
		e.State, e.Code, e.Reason = "failed", "floor_gone", "The floor of Desk 3 is gone; nobody was hired."
		return e
	}
	ea, eb := end(ma), end(mb)
	for op, m := range map[string]store.HandoffHireMarker{"op-a": ea, "op-b": eb, "op-n": ea, "nope": ea} {
		if err := st.EndHandoffHire(ctx, op, m); err != nil {
			t.Fatal(err)
		}
	}
	if rows, err := st.HandoffHireRows(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("after ending: %+v, %v", rows, err)
	}
	if got, _ := st.HandoffLLMJobByOp(ctx, "op-b"); got.Hire == nil || !reflect.DeepEqual(*got.Hire, eb) || !got.Hire.Ended() {
		t.Fatalf("op-b's marker: %+v", got.Hire)
	}
	if got, _ := st.HandoffRequestByOp(ctx, "op-n"); got.Hire != nil {
		t.Fatalf("op-n got a marker: %+v", got.Hire)
	}
	ra.State = store.HandoffRequestPending
	if err := st.UpdateHandoffRequest(ctx, ra); err != nil {
		t.Fatal(err)
	}
	rows, err = st.HandoffHireRows(ctx)
	if err != nil || len(rows) != 1 || rows[0].Op != "op-a" || !reflect.DeepEqual(rows[0].Marker, ea) {
		t.Fatalf("a pending request's ended hire: %+v, %v", rows, err)
	}
	// A marker that does not decode is listed (as an empty one), never an
	// error.
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.ExecContext(ctx, `UPDATE handoff_llm_job SET hire = '{bad' WHERE op = 'op-b'`); err != nil {
		t.Fatal(err)
	}
	if rows, err := st.HandoffHireRows(ctx); err != nil || len(rows) != 2 {
		t.Fatalf("with a bad marker: %+v, %v", rows, err)
	}
	// The marker is what it says: no task, no review.
	if j := markerJSON(&ea); strings.Contains(j, "prompt") || strings.Contains(j, "secrets") {
		t.Fatalf("marker = %s", j)
	}
}

func markerJSON(m *store.HandoffHireMarker) string {
	b, _ := json.Marshal(m)
	return string(b)
}
