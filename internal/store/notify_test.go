package store_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #11: the notifications' settings, kept across a reopen.
func TestNotifySettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, ok, err := st.LoadNotifySettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	want := store.NotifySettings{Enabled: true, NeedsYou: true, Quiet: true}
	if err := st.SaveNotifySettings(ctx, store.NotifySettings{Done: true}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveNotifySettings(ctx, want); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if got, ok, err := st.LoadNotifySettings(ctx); !ok || err != nil || got != want {
		t.Fatalf("reopened: %+v %v %v", got, ok, err)
	}
}
