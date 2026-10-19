package store_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestScheduleSuggestSettingsAndSeen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, _, _, ok, err := st.LoadScheduleSuggestSettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	if err := st.SaveScheduleSuggestSettings(ctx, true, 0.8, "Europe/Brussels"); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.ScheduleSuggestSeenOf(ctx, "w1", "abc"); ok || err != nil {
		t.Fatalf("unseen: ok %v, %v", ok, err)
	}
	if err := st.RecordScheduleSuggestSeen(ctx, "w1", "abc", `{"id":"t1"}`, ""); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	en, th, zone, ok, err := st.LoadScheduleSuggestSettings(ctx)
	if !ok || err != nil || !en || th != 0.8 || zone != "Europe/Brussels" {
		t.Fatalf("settings after reopen = %v %v %q %v %v", en, th, zone, ok, err)
	}
	f, ok, err := st.ScheduleSuggestSeenOf(ctx, "w1", "abc")
	if !ok || err != nil || f.Suggestion != `{"id":"t1"}` || f.Outcome != "" {
		t.Fatalf("seen = %+v %v %v", f, ok, err)
	}
	if err := st.CloseScheduleSuggestSeen(ctx, "w1", "abc", store.ScheduleSuggestDismissed); err != nil {
		t.Fatal(err)
	}
	// The first outcome stays.
	if err := st.CloseScheduleSuggestSeen(ctx, "w1", "abc", store.ScheduleSuggestMoved); err != nil {
		t.Fatal(err)
	}
	if f, _, _ := st.ScheduleSuggestSeenOf(ctx, "w1", "abc"); f.Outcome != store.ScheduleSuggestDismissed || f.Suggestion == "" {
		t.Fatalf("closed = %+v", f)
	}
	// Bounded per worker: the oldest go.
	for i := range 25 {
		if err := st.RecordScheduleSuggestSeen(ctx, "w2", fmt.Sprint(i), "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok, _ := st.ScheduleSuggestSeenOf(ctx, "w2", "0"); ok {
		t.Fatal("the oldest message is still remembered")
	}
	if _, ok, _ := st.ScheduleSuggestSeenOf(ctx, "w2", "24"); !ok {
		t.Fatal("the newest message is forgotten")
	}
	if _, ok, _ := st.ScheduleSuggestSeenOf(ctx, "w1", "abc"); !ok {
		t.Fatal("another worker's message is forgotten")
	}
}
