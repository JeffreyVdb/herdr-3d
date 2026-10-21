package store_test

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #138: the Codex profiles' settings are empty until set, and survive a
// restart.
func TestCodexProfilesSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if got, err := st.LoadCodexProfiles(ctx); err != nil || got.Profiles == nil || got.Added == nil || len(got.Profiles)+len(got.Added) != 0 {
		t.Fatalf("fresh: %+v %v", got, err)
	}
	set := store.CodexProfiles{
		Profiles: []store.CodexProfile{{Path: "/home/me/.codex-work", Name: "Work seat"}, {Path: "/srv/codex ü", Hidden: true}},
		Added:    []string{"/srv/codex ü"},
	}
	if err := st.SaveCodexProfiles(ctx, set); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	got, err := st.LoadCodexProfiles(ctx)
	if err != nil || !slices.Equal(got.Profiles, set.Profiles) || !slices.Equal(got.Added, set.Added) {
		t.Fatalf("after reopen: %+v %v", got, err)
	}
	if err := st.SaveCodexProfiles(ctx, store.CodexProfiles{}); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.LoadCodexProfiles(ctx); got.Profiles == nil || got.Added == nil || len(got.Profiles)+len(got.Added) != 0 {
		t.Fatalf("cleared: %+v", got)
	}
}
