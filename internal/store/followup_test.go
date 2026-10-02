package store_test

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
)

func TestFollowupSettingsAndSeen(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, _, ok, err := st.LoadFollowupSettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	if err := st.SaveFollowupSettings(ctx, true, 0.8); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.FollowupSeenOf(ctx, "w1", "abc"); ok || err != nil {
		t.Fatalf("unseen: ok %v, %v", ok, err)
	}
	if err := st.RecordFollowupSeen(ctx, "w1", "abc", `{"turn_id":"abc"}`, false); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	en, th, ok, err := st.LoadFollowupSettings(ctx)
	if !ok || err != nil || !en || th != 0.8 {
		t.Fatalf("settings after reopen = %v %v %v %v", en, th, ok, err)
	}
	f, ok, err := st.FollowupSeenOf(ctx, "w1", "abc")
	if !ok || err != nil || f.Followup != `{"turn_id":"abc"}` || f.Cleared {
		t.Fatalf("seen = %+v %v %v", f, ok, err)
	}
	if err := st.ClearFollowupSeen(ctx, "w1", "abc"); err != nil {
		t.Fatal(err)
	}
	if f, _, _ := st.FollowupSeenOf(ctx, "w1", "abc"); !f.Cleared {
		t.Fatal("not cleared")
	}
	// Bounded per worker: the oldest go.
	for i := range 25 {
		if err := st.RecordFollowupSeen(ctx, "w2", fmt.Sprint(i), "", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, ok, _ := st.FollowupSeenOf(ctx, "w2", "0"); ok {
		t.Fatal("the oldest message is still remembered")
	}
	if _, ok, _ := st.FollowupSeenOf(ctx, "w2", "24"); !ok {
		t.Fatal("the newest message is forgotten")
	}
	if _, ok, _ := st.FollowupSeenOf(ctx, "w1", "abc"); !ok {
		t.Fatal("another worker's message is forgotten")
	}
}
