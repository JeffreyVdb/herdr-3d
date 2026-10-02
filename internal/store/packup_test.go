package store_test

import (
	"context"
	"path/filepath"
	"testing"
)

func TestPackupSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, _, ok, err := st.LoadPackupSettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	if err := st.SavePackupSettings(ctx, true, 0.9); err != nil {
		t.Fatal(err)
	}
	if err := st.SavePackupSettings(ctx, false, 0.85); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	en, th, ok, err := st.LoadPackupSettings(ctx)
	if !ok || err != nil || en || th != 0.85 {
		t.Fatalf("settings after reopen = %v %v %v %v", en, th, ok, err)
	}
}
