package store_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestLogoRoundTrip(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	if _, err := st.CreateBuilding(ctx, "b1", "Work"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.LogoOf(ctx, "b1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("no logo yet: err = %v", err)
	}
	bs, err := st.Buildings(ctx)
	if err != nil || len(bs) != 1 || bs[0].Logo != "" {
		t.Fatalf("buildings = %+v, %v", bs, err)
	}

	first := store.Logo{Hash: "h1", PNG: []byte("png-one"), W: 10, H: 5}
	if err := st.SetLogo(ctx, "b1", first); err != nil {
		t.Fatal(err)
	}
	got, err := st.LogoOf(ctx, "b1")
	if err != nil || got.Hash != "h1" || !bytes.Equal(got.PNG, first.PNG) || got.W != 10 || got.H != 5 {
		t.Fatalf("logo = %+v, %v", got, err)
	}
	if bs, _ = st.Buildings(ctx); bs[0].Logo != "h1" {
		t.Fatalf("building logo hash = %q", bs[0].Logo)
	}

	// Replacing changes the hash and the bytes, and keeps one row.
	if err := st.SetLogo(ctx, "b1", store.Logo{Hash: "h2", PNG: []byte("png-two"), W: 3, H: 3}); err != nil {
		t.Fatal(err)
	}
	if got, _ = st.LogoOf(ctx, "b1"); got.Hash != "h2" || string(got.PNG) != "png-two" {
		t.Fatalf("replaced logo = %+v", got)
	}
	if bs, _ = st.Buildings(ctx); bs[0].Logo != "h2" {
		t.Fatalf("building logo hash = %q", bs[0].Logo)
	}

	if err := st.ClearLogo(ctx, "b1"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.LogoOf(ctx, "b1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("cleared: err = %v", err)
	}
	if err := st.ClearLogo(ctx, "b1"); err != nil {
		t.Fatalf("clearing twice: %v", err)
	}
	if bs, _ = st.Buildings(ctx); bs[0].Logo != "" {
		t.Fatalf("building logo hash after clear = %q", bs[0].Logo)
	}
}

func TestLogoNeedsABuilding(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "w.db"))
	if err := st.SetLogo(ctx, "nope", store.Logo{Hash: "h", PNG: []byte("x")}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("SetLogo: err = %v", err)
	}
	if err := st.ClearLogo(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("ClearLogo: err = %v", err)
	}
	if _, err := st.LogoOf(ctx, "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("LogoOf: err = %v", err)
	}
}

func TestDeletingABuildingDeletesItsLogo(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	if _, err := st.CreateBuilding(ctx, "b1", "Work"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetLogo(ctx, "b1", store.Logo{Hash: "h", PNG: []byte("x"), W: 1, H: 1}); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteBuilding(ctx, "b1"); err != nil {
		t.Fatal(err)
	}
	st.Close()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM building_logo`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("logo rows left = %d, %v", n, err)
	}
}

// A database as the bridge left it before logos (every migration but the
// last): buildings are kept, none has a logo, and a logo can be stored.
func TestMigratesToLogos(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	old := store.Migrations[:len(store.Migrations)-1]
	for _, q := range old {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		"PRAGMA user_version = " + strconv.Itoa(len(old)),
		`INSERT INTO building (id, name, sort, created_at) VALUES ('b1', 'Work', 0, 't')`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	bs, err := st.Buildings(ctx)
	if err != nil || len(bs) != 1 || bs[0].Name != "Work" || bs[0].Logo != "" {
		t.Fatalf("migrated buildings = %+v, %v", bs, err)
	}
	if err := st.SetLogo(ctx, "b1", store.Logo{Hash: "h", PNG: []byte("x"), W: 1, H: 1}); err != nil {
		t.Fatal(err)
	}
	if bs, _ = st.Buildings(ctx); bs[0].Logo != "h" {
		t.Fatalf("logo hash = %q", bs[0].Logo)
	}
}
