package server

import (
	"encoding/json"
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
