package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
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
