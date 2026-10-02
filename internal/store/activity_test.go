package store_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestActivitySettingsAndCache(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, ok, err := st.LoadActivitySettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	want := store.ActivitySettings{ModelEnabled: true, Threshold: 0.7, Margin: 0.25, DailyCap: 500, CallsDay: "2026-10-02", CallsToday: 3}
	if err := st.SaveActivitySettings(ctx, want); err != nil {
		t.Fatal(err)
	}
	for i := range 5 {
		if err := st.SaveActivityAnswer(ctx, store.ActivityAnswer{Key: fmt.Sprint("k", i), Kind: "waiting"}, 3); err != nil {
			t.Fatal(err)
		}
	}
	// An answer given again is the newest.
	if err := st.SaveActivityAnswer(ctx, store.ActivityAnswer{Key: "k2", Kind: "testing"}, 3); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	got, ok, err := st.LoadActivitySettings(ctx)
	if !ok || err != nil || got != want {
		t.Fatalf("settings after reopen = %+v %v %v", got, ok, err)
	}
	as, err := st.ActivityCache(ctx, 10)
	if err != nil || len(as) != 3 || as[0] != (store.ActivityAnswer{Key: "k2", Kind: "testing"}) || as[1].Key != "k4" || as[2].Key != "k3" {
		t.Fatalf("%+v %v", as, err)
	}
}
