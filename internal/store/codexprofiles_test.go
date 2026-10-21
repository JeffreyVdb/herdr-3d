package store_test

import (
	"context"
	"database/sql"
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
		Profiles: []store.CodexProfile{{Path: "/home/me/.codex-work", Name: "Work seat"}, {Path: "/srv/codex ü", Hidden: true},
			{Path: "/home/me/.codex", Anything: true}},
		Added: []string{"/srv/codex ü"},
		Rules: []store.CodexRule{{Match: "github.com/acme/*", Profile: "work"}, {Match: "~/src/mine", Profile: "codex"}},
	}
	if err := st.SaveCodexProfiles(ctx, set); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	got, err := st.LoadCodexProfiles(ctx)
	if err != nil || !slices.Equal(got.Profiles, set.Profiles) || !slices.Equal(got.Added, set.Added) || !slices.Equal(got.Rules, set.Rules) {
		t.Fatalf("after reopen: %+v %v", got, err)
	}
	if err := st.SaveCodexProfiles(ctx, store.CodexProfiles{}); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.LoadCodexProfiles(ctx); got.Profiles == nil || got.Added == nil || got.Rules == nil || len(got.Profiles)+len(got.Added)+len(got.Rules) != 0 {
		t.Fatalf("cleared: %+v", got)
	}
}

// #140: settings stored before #140 (no rules, no anything) read as they
// were, with no rules: no migration.
func TestCodexProfilesSettingsBefore140(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	open(t, path).Close()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO codex_profiles_settings (id, settings, updated_at) VALUES (1, ?, 't')`,
		`{"profiles":[{"path":"/home/me/.codex-work","name":"Work seat","hidden":true}],"added":[]}`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	got, err := open(t, path).LoadCodexProfiles(ctx)
	want := []store.CodexProfile{{Path: "/home/me/.codex-work", Name: "Work seat", Hidden: true}}
	if err != nil || !slices.Equal(got.Profiles, want) || got.Rules == nil || len(got.Rules) != 0 {
		t.Fatalf("before #140: %+v %v", got, err)
	}
}
