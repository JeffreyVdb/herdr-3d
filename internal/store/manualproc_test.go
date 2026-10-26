package store_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func TestManualProcessIdempotentOp(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	first := proto.ManualProcess{ID: "mp_12345678", Op: "op-1", Worker: "w", State: "starting", Cleanup: "none"}
	got, created, err := st.CreateManualProcess(ctx, first)
	if err != nil || !created || got.ID != first.ID {
		t.Fatalf("first: %+v %v %v", got, created, err)
	}
	second := first
	second.ID = "mp_87654321"
	got, created, err = st.CreateManualProcess(ctx, second)
	if err != nil || created || got.ID != first.ID {
		t.Fatalf("duplicate: %+v %v %v", got, created, err)
	}
}

func TestManualProcessRetention(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	for i := 0; i < 25; i++ {
		p := proto.ManualProcess{ID: fmt.Sprintf("mp_%08x", i), Op: fmt.Sprintf("op-%d", i), Worker: "w", State: "exited", Cleanup: "none", CreatedAt: int64(i)}
		if _, _, err := st.CreateManualProcess(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []proto.ManualProcess{
		{ID: "mp_deadbeef", Op: "active", Worker: "w", State: "running", Cleanup: "none"},
		{ID: "mp_abcdefab", Op: "needed", Worker: "gone", State: "exited", Cleanup: "needed"},
	} {
		if _, _, err := st.CreateManualProcess(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	got, err := st.KeptManualProcesses(ctx, map[string]bool{"w": true})
	if err != nil || len(got) != 22 {
		t.Fatalf("got %d: %v", len(got), err)
	}
}

func TestDismissKeepsOperationReservation(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	p := proto.ManualProcess{ID: "mp_12345678", Op: "same", Worker: "w", State: "exited", Cleanup: "none"}
	if _, _, err := st.CreateManualProcess(ctx, p); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteManualProcess(ctx, p.ID); err != nil {
		t.Fatal(err)
	}
	p.ID = "mp_abcdefab"
	got, created, err := st.CreateManualProcess(ctx, p)
	if err != nil || created || got.ID != "mp_12345678" {
		t.Fatalf("got %+v, created %v, err %v", got, created, err)
	}
	visible, err := st.AllManualProcesses(ctx)
	if err != nil || len(visible) != 0 {
		t.Fatalf("visible %+v, %v", visible, err)
	}
}
