package server

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestManualStorageOmitsCredentialMetadata(t *testing.T) {
	const marker = "H3D-MARKER-storage-test"
	p := proto.ManualProcess{ID: "mp_12345678", Op: "op", Command: "echo safe", Credential: &proto.ManualCredential{Request: "cr_test", Prompt: marker}}
	record := manualToStore(p)
	b, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), marker) || strings.Contains(string(b), "credential") {
		t.Fatalf("credential reached storage: %s", b)
	}
	restored := manualFromStore(record)
	if restored.ID != p.ID || restored.Command != p.Command || restored.Credential != nil {
		t.Fatalf("record round trip: %+v", restored)
	}
}

func TestManualHistoryUsesCreationOrderForTies(t *testing.T) {
	h := &Hub{workers: map[string]*proto.Worker{"worker": {}}, manualProcesses: map[string]proto.ManualProcess{}, manualOrder: map[string]uint64{}}
	for i := 0; i < 21; i++ {
		id := fmt.Sprintf("mp_%08x", 21-i)
		h.manualProcesses[id] = proto.ManualProcess{ID: id, Worker: "worker", State: "exited", Cleanup: "none", CreatedAt: 1}
		h.rememberManualOrder(id)
	}
	views := h.manualProcessViews()
	if len(views) != 20 {
		t.Fatalf("got %d records", len(views))
	}
	for _, p := range views {
		if p.ID == "mp_00000015" {
			t.Fatal("oldest record retained ahead of newer ties")
		}
	}
}

func TestManualEffectsReserveSamePort(t *testing.T) {
	a := proto.ManualEffect{Kind: "tailscale_serve", Endpoint: "https:8443"}
	if !manualEffectsConflict(a, proto.ManualEffect{Kind: "tailscale_serve", Endpoint: "tcp:8443"}) {
		t.Fatal("shared listener was not reserved")
	}
	if manualEffectsConflict(a, proto.ManualEffect{Kind: "tailscale_serve", Endpoint: "https:443"}) {
		t.Fatal("different ports conflict")
	}
}

func TestManualCredentialIsEphemeralAndIdempotentRepliesAreCurrent(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	p := proto.ManualProcess{ID: "mp_12345678", Op: "same", Worker: "worker", State: "waiting", Cleanup: "none", Credential: &proto.ManualCredential{Request: "cr_1", Prompt: "password", Attempt: 1}}
	if _, _, err := st.CreateManualProcess(ctx, manualToStore(p)); err != nil {
		t.Fatal(err)
	}
	h := &Hub{st: st, opts: Options{ManualDir: t.TempDir()}, manualProcesses: map[string]proto.ManualProcess{}, manualOrder: map[string]uint64{}, manualLocks: map[string]*sync.Mutex{}, manualCleanups: map[string]manualCleanupLink{}}
	if err := h.initManualProcesses(ctx); err != nil {
		t.Fatal(err)
	}
	restored := h.manualProcesses[p.ID]
	if restored.State != "unknown" || restored.Credential != nil {
		t.Fatalf("restart: %+v", restored)
	}
	h.manualProcesses[p.ID] = p
	got, ok, err := h.manualByOp(ctx, p.Op)
	if err != nil || !ok || got.Credential == nil || got.Credential.Request != "cr_1" {
		t.Fatalf("duplicate: %+v %v %v", got, ok, err)
	}
}

func TestManualStopKeepsPendingCleanupWorkspaceVisible(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	p := proto.ManualProcess{ID: "mp_12345678", Op: "pending", Worker: "gone", State: "exited", Cleanup: "failed", Effects: []proto.ManualEffect{{Kind: "tailscale_serve", Endpoint: "https:8443", State: "removed"}}}
	if _, _, err := st.CreateManualProcess(ctx, manualToStore(p)); err != nil {
		t.Fatal(err)
	}
	h, err := NewHub(ctx, st, Options{ManualDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { _ = h.Run(ctx); close(done) }()
	defer func() { cancel(); <-done; _ = st.Close() }()
	_, err = query(ctx, h, func() struct{} {
		h.manualCleanups["mp_abcdef12"] = manualCleanupLink{Parent: p.ID, TemporaryWorkspace: true}
		return struct{}{}
	})
	if err != nil {
		t.Fatal(err)
	}
	h.manualLocks[p.ID].Lock()
	result, verified, err := h.cleanupManual(ctx, p.ID, "stopped by user", false, true)
	h.manualLocks[p.ID].Unlock()
	if err != nil || !verified || result.Cleanup != "needed" || !strings.Contains(result.CleanupNote, "workspace") {
		t.Fatalf("cleanup: %+v verified=%v err=%v", result, verified, err)
	}
}
