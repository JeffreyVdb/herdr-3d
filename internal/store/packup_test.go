package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestPackupSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, ok, err := st.LoadPackupSettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	if err := st.SavePackupSettings(ctx, store.PackupSettings{Enabled: true, Threshold: 0.9}); err != nil {
		t.Fatal(err)
	}
	if err := st.SavePackupSettings(ctx, store.PackupSettings{Threshold: 0.85, ReasoningEffort: "high", MaxTokens: 2048}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	v, ok, err := st.LoadPackupSettings(ctx)
	if !ok || err != nil || v.Enabled || v.Threshold != 0.85 || v.ReasoningEffort != "high" || v.MaxTokens != 2048 {
		t.Fatalf("settings after reopen = %v %v %v %v", v.Enabled, v.Threshold, ok, err)
	}
}

func TestPackupReasoningMigrationPreservesSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	added := slices.IndexFunc(store.Migrations, func(q string) bool {
		return strings.Contains(q, "ALTER TABLE packup_settings ADD COLUMN reasoning_effort")
	})
	if added < 0 {
		t.Fatal("missing migration")
	}
	for _, q := range store.Migrations[:added] {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("PRAGMA user_version = " + strconv.Itoa(added)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO packup_settings VALUES(1,1,0.75,'old')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	st := open(t, path)
	v, ok, err := st.LoadPackupSettings(ctx)
	if err != nil || !ok || !v.Enabled || v.Threshold != .75 || v.ReasoningEffort != "" || v.MaxTokens != 600 {
		t.Fatalf("migration: %+v %v", v, err)
	}
}
