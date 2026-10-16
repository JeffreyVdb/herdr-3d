package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestCodexServerSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if en, ok, err := st.LoadCodexServerSettings(ctx); en.Enabled || en.AllowUnverified || ok || err != nil {
		t.Fatalf("fresh settings: %v %v %v", en, ok, err)
	}
	if err := st.SaveCodexServerSettings(ctx, store.CodexServerSettings{Enabled: true, AllowUnverified: true}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if en, ok, err := st.LoadCodexServerSettings(ctx); !en.Enabled || !en.AllowUnverified || !ok || err != nil {
		t.Fatalf("after reopen: %v %v %v", en, ok, err)
	}
	if err := st.SaveCodexServerSettings(ctx, store.CodexServerSettings{}); err != nil {
		t.Fatal(err)
	}
	if en, ok, _ := st.LoadCodexServerSettings(ctx); en.Enabled || en.AllowUnverified || !ok {
		t.Fatal("switch not turned off")
	}
}

func TestCodexLaunch(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	shared := store.CodexLaunch{WorkerID: "w1", Session: "s", Mode: store.CodexShared, AgentName: "mochi-a58752",
		Cwd: "/r", Model: "gpt-6-sol", Effort: "low", RunDir: "/run/user/7/herdr-world/codex", Name: "a58752ea6511",
		Token: "0123456789abcdef0123456789abcdef", ServerPID: 4242, ServerStart: 1 << 40}
	legacy := store.CodexLaunch{WorkerID: "w2", Session: "s", Mode: store.CodexLegacy, Note: ".envrc is blocked"}
	for _, l := range []store.CodexLaunch{shared, legacy} {
		if err := st.RecordCodexLaunch(ctx, l); err != nil {
			t.Fatal(err)
		}
	}
	shared.Thread, shared.ServerPID, shared.ServerStart = "01a0663b-61cd-73a0-a3a0-034ca9fc6c48", 0, 0
	if err := st.RecordCodexLaunch(ctx, shared); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	all, err := st.CodexLaunches(ctx)
	if err != nil || len(all) != 2 || all["w1"] != shared || all["w2"] != legacy {
		t.Fatalf("launches = %+v, %v", all, err)
	}
	if err := st.RecordCodexLaunch(ctx, store.CodexLaunch{WorkerID: "w3", Session: "s", Mode: "other"}); err == nil {
		t.Fatal("unknown mode stored")
	}
	if err := st.ForgetCodexLaunch(ctx, "w1"); err != nil {
		t.Fatal(err)
	}
	if all, _ = st.CodexLaunches(ctx); len(all) != 1 {
		t.Fatalf("after forget %+v", all)
	}
}

// #158: the bridge's async answers outlive a restart; a question's latest
// answer replaces the one before.
func TestCodexAsyncSends(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	a := store.CodexAsyncSend{WorkerID: "w1", Thread: "th", Batch: "call_3", Index: 0, ClientID: "herdr_3d-aa", Turn: "t1"}
	b := a
	b.Index = 1
	c := store.CodexAsyncSend{WorkerID: "w2", Thread: "th2", Batch: "call_9", ClientID: "herdr_3d-bb", Unconfirmed: true}
	if err := st.RecordCodexAsyncSends(ctx, []store.CodexAsyncSend{a, b}); err != nil {
		t.Fatal(err)
	}
	if err := st.RecordCodexAsyncSends(ctx, []store.CodexAsyncSend{c}); err != nil {
		t.Fatal(err)
	}
	a.Turn, a.Confirmed, a.ClientID = "t2", true, "herdr_3d-cc" // sent again after it went undelivered
	if err := st.RecordCodexAsyncSends(ctx, []store.CodexAsyncSend{a}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	all, err := st.CodexAsyncSends(ctx)
	if err != nil || len(all) != 2 || len(all["w1"]) != 2 || all["w1"][0] != a || all["w1"][1] != b || len(all["w2"]) != 1 ||
		all["w2"][0] != c {
		t.Fatalf("sends = %+v, %v", all, err)
	}
	if err := st.ForgetCodexAsyncSend(ctx, "w1", "call_3", 1); err != nil {
		t.Fatal(err)
	}
	if err := st.ForgetCodexAsyncSends(ctx, "w2"); err != nil {
		t.Fatal(err)
	}
	if all, _ = st.CodexAsyncSends(ctx); len(all) != 1 || len(all["w1"]) != 1 || all["w1"][0] != a {
		t.Fatalf("after forget %+v", all)
	}
}

func TestCodexVersionPolicyMigration(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	const before = 26
	for _, q := range store.Migrations[:before] {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO codex_server_settings (id, enabled, updated_at) VALUES (1, 1, 't'); PRAGMA user_version = 26`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	st := open(t, path)
	s, ok, err := st.LoadCodexServerSettings(context.Background())
	if err != nil || !ok || !s.Enabled || s.AllowUnverified {
		t.Fatalf("migrated %+v, %v, %v", s, ok, err)
	}
}
