package store_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestCodexServerSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if en, ok, err := st.LoadCodexServerSettings(ctx); en || ok || err != nil {
		t.Fatalf("fresh settings: %v %v %v", en, ok, err)
	}
	if err := st.SaveCodexServerSettings(ctx, true); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if en, ok, err := st.LoadCodexServerSettings(ctx); !en || !ok || err != nil {
		t.Fatalf("after reopen: %v %v %v", en, ok, err)
	}
	if err := st.SaveCodexServerSettings(ctx, false); err != nil {
		t.Fatal(err)
	}
	if en, ok, _ := st.LoadCodexServerSettings(ctx); en || !ok {
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
