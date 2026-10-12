package store_test

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #224: an agent handoff request survives a restart, its op is unique, a
// worker has one pending at a time, a settled one can be followed by a new
// one, and only the states and harnesses it knows are stored.
func TestHandoffRequests(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	for _, id := range []string{"a", "b"} {
		if err := st.SaveWorker(ctx, store.Worker{ID: id, Session: "s", WorkspaceID: "w-" + id, Label: id}); err != nil {
			t.Fatal(err)
		}
	}
	a := store.HandoffRequest{Op: "op-a", WorkerID: "a", Floor: "s", Harness: "claude", AgentSession: "sess-a", Offset: -1,
		Path: "/h/.pending/s/op-a.md", Nonce: "5f3c9a1e7b2d4086", Instruction: "summarize the conversation", SendHome: true,
		State: store.HandoffRequestPending, CreatedAt: 1790000000000}
	b := store.HandoffRequest{Op: "op-b", WorkerID: "b", Floor: "s", Harness: "codex", Transcript: "codex/x", Offset: 512,
		Path: "/h/.pending/s/op-b.md", Nonce: "0d1e2f3a4b5c6d7e", State: store.HandoffRequestFailed,
		Reason: "no handoff file within 10m0s", CreatedAt: 1790000001000}
	for _, r := range []store.HandoffRequest{a, b} {
		if err := st.AddHandoffRequest(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	st = open(t, path)
	got, err := st.HandoffRequestByOp(ctx, "op-a")
	if err != nil || !reflect.DeepEqual(got, a) {
		t.Fatalf("op-a = %+v, %v", got, err)
	}
	if p, err := st.HandoffRequests(ctx, store.HandoffRequestPending); err != nil || !reflect.DeepEqual(p, []store.HandoffRequest{a}) {
		t.Fatalf("pending = %+v, %v", p, err)
	}
	if _, err := st.HandoffRequestByOp(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown op: %v", err)
	}

	// The same op again, or a second pending one of a, is taken.
	dup := a
	dup.Path = "/h/.pending/s/other.md"
	if err := st.AddHandoffRequest(ctx, dup); !errors.Is(err, store.ErrRequestTaken) {
		t.Fatalf("same op: %v", err)
	}
	second := a
	second.Op, second.Path = "op-a2", "/h/.pending/s/op-a2.md"
	if err := st.AddHandoffRequest(ctx, second); !errors.Is(err, store.ErrRequestTaken) {
		t.Fatalf("second pending: %v", err)
	}
	// Settled, a new one may be pending.
	a.State, a.HandoffID, a.Transcript, a.Offset = store.HandoffRequestFiled, 7, "claude/sess-a", 4096
	if err := st.UpdateHandoffRequest(ctx, a); err != nil {
		t.Fatal(err)
	}
	if err := st.AddHandoffRequest(ctx, second); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.HandoffRequestByOp(ctx, "op-a"); !reflect.DeepEqual(got, a) {
		t.Fatalf("filed = %+v", got)
	}
	if err := st.UpdateHandoffRequest(ctx, store.HandoffRequest{Op: "nope", State: "failed"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update unknown: %v", err)
	}
	// Pruning forgets settled rows only.
	if err := st.PruneHandoffRequests(ctx, 1790000002000); err != nil {
		t.Fatal(err)
	}
	for op, want := range map[string]bool{"op-a": false, "op-b": false, "op-a2": true} {
		if _, err := st.HandoffRequestByOp(ctx, op); (err == nil) != want {
			t.Errorf("after prune %s: %v", op, err)
		}
	}
	for _, bad := range []store.HandoffRequest{
		{Op: "x1", WorkerID: "b", Floor: "s", Harness: "claude", Path: "/x1", Nonce: "n", State: "armed"},
		{Op: "x2", WorkerID: "b", Floor: "s", Harness: "gemini", Path: "/x2", Nonce: "n", State: "pending"},
		{Op: "x3", WorkerID: "b", Floor: "s", Harness: "claude", Path: "/x3", Nonce: "n", State: "pending", Offset: -2},
		{Op: "x4", WorkerID: "nobody", Floor: "s", Harness: "claude", Path: "/x4", Nonce: "n", State: "pending"},
		{Op: "x5", WorkerID: "b", Floor: "s", Harness: "claude", Path: "/h/.pending/s/op-a2.md", Nonce: "n", State: "failed"},
	} {
		if err := st.AddHandoffRequest(ctx, bad); err == nil {
			t.Errorf("stored %+v", bad)
		}
	}
}

// A database as the bridge left it before #224 (every migration but the
// last) gains the table, its rows kept.
func TestMigratesToHandoffRequests(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	old := store.Migrations[:len(store.Migrations)-1]
	for _, q := range old {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		"PRAGMA user_version = " + strconv.Itoa(len(old)),
		`INSERT INTO worker (id, session_name, workspace_id, label, created_at, last_seen_at) VALUES ('u1', 's', 'w1', 'x', 't', 't')`,
		`INSERT INTO handoff (floor, worker_uuid, worker_name, path, title, created_at, source, op) VALUES
			('s', 'u1', 'Pixel', '/h/s/a.md', 'A', 1, 'literal', 'lit-1')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	st := open(t, path)
	if h, err := st.HandoffByOp(ctx, "lit-1"); err != nil || h.Title != "A" {
		t.Fatalf("kept handoff = %+v, %v", h, err)
	}
	r := store.HandoffRequest{Op: "op", WorkerID: "u1", Floor: "s", Harness: "codex", Offset: -1, Path: "/h/.pending/s/op.md",
		Nonce: "n", State: store.HandoffRequestPending, CreatedAt: 2}
	if err := st.AddHandoffRequest(ctx, r); err != nil {
		t.Fatal(err)
	}
}
