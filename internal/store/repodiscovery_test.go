package store_test

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #54: the discovery settings are no roots and the default interval until
// set, and survive a restart.
func TestRepoDiscoverySettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if got, err := st.LoadRepoDiscovery(ctx, 10); err != nil || got.Roots == nil || len(got.Roots) != 0 || got.IntervalMinutes != 10 {
		t.Fatalf("fresh: %+v %v", got, err)
	}
	set := store.RepoDiscovery{Roots: []string{"/home/me/dev", "/srv/my repos ü"}, IntervalMinutes: 25}
	if err := st.SaveRepoDiscovery(ctx, set); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	got, err := st.LoadRepoDiscovery(ctx, 10)
	if err != nil || !slices.Equal(got.Roots, set.Roots) || got.IntervalMinutes != 25 {
		t.Fatalf("after reopen: %+v %v", got, err)
	}
	if err := st.SaveRepoDiscovery(ctx, store.RepoDiscovery{IntervalMinutes: 10}); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.LoadRepoDiscovery(ctx, 10); got.Roots == nil || len(got.Roots) != 0 {
		t.Fatalf("cleared: %+v", got)
	}
	if err := st.SaveRepoDiscovery(ctx, store.RepoDiscovery{IntervalMinutes: 0}); err == nil {
		t.Fatal("a zero interval was stored")
	}
}
