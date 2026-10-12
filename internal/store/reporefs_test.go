package store_test

import (
	"context"
	"path/filepath"
	"testing"
)

// #247: the "Repositories from other buildings" switch is off until set and
// survives a restart.
func TestRepoRefsSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if all, err := st.LoadRepoRefs(ctx); all || err != nil {
		t.Fatalf("fresh switch: %v %v", all, err)
	}
	if err := st.SaveRepoRefs(ctx, true); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if all, err := st.LoadRepoRefs(ctx); !all || err != nil {
		t.Fatalf("after reopen: %v %v", all, err)
	}
	if err := st.SaveRepoRefs(ctx, false); err != nil {
		t.Fatal(err)
	}
	if all, _ := st.LoadRepoRefs(ctx); all {
		t.Fatal("switch not turned off")
	}
}
