package store_test

import (
	"context"
	"database/sql"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #11: the notifications' settings, kept across a reopen. #13: replies too.
func TestNotifySettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, ok, err := st.LoadNotifySettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	want := store.NotifySettings{Enabled: true, NeedsYou: true, Quiet: true, Replies: true, Mode: "questions"}
	if err := st.SaveNotifySettings(ctx, store.NotifySettings{Done: true}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveNotifySettings(ctx, want); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if got, ok, err := st.LoadNotifySettings(ctx); !ok || err != nil || got != want {
		t.Fatalf("reopened: %+v %v %v", got, ok, err)
	}
}

// H3D-1: a row saved before the mode existed loads as everything (the mode
// it had); the mode is kept across a reopen, and an empty one is saved as
// everything.
func TestNotifySettingsMode(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	before := slices.IndexFunc(store.Migrations, func(q string) bool { return strings.Contains(q, "notify_settings ADD COLUMN mode") })
	if before < 0 {
		t.Fatal("no migration adds the mode")
	}
	for _, q := range append(slices.Clone(store.Migrations[:before]), "PRAGMA user_version = "+strconv.Itoa(before),
		`INSERT INTO notify_settings (id, enabled, needs_you, done, quiet, freelancers, replies, updated_at)
			VALUES (1, 1, 1, 0, 1, 0, 1, '2026-10-18T12:00:00Z')`) {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	st := open(t, path)
	old := store.NotifySettings{Enabled: true, NeedsYou: true, Quiet: true, Replies: true, Mode: "everything"}
	if got, ok, err := st.LoadNotifySettings(ctx); !ok || err != nil || got != old {
		t.Fatalf("migrated: %+v %v %v", got, ok, err)
	}
	q := old
	q.Mode = "questions"
	if err := st.SaveNotifySettings(ctx, q); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if got, _, _ := st.LoadNotifySettings(ctx); got != q {
		t.Fatalf("reopened: %+v", got)
	}
	q.Mode = ""
	if err := st.SaveNotifySettings(ctx, q); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.LoadNotifySettings(ctx); got.Mode != "everything" {
		t.Fatalf("an empty mode saved as %q", got.Mode)
	}
}

// #13: which worker each sent notification was about, kept across a
// reopen (a bridge restarts on every release), keyed on the chat and the
// message, and bounded: the newest NotifyMessagesKept within
// NotifyMessageAge of the newest.
func TestNotifyMessages(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	t0 := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	if err := st.SaveNotifyMessage(ctx, 42, 7, "w-a", t0); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveNotifyMessage(ctx, 42, 8, "w-b", t0.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	// The same message id in another chat is another message.
	if err := st.SaveNotifyMessage(ctx, 43, 7, "w-c", t0.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	for _, c := range []struct {
		chat, msg int64
		want      string
		at        time.Time
	}{{42, 7, "w-a", t0}, {42, 8, "w-b", t0.Add(time.Second)}, {43, 7, "w-c", t0.Add(2 * time.Second)}} {
		id, at, ok, err := st.NotifyMessage(ctx, c.chat, c.msg)
		if err != nil || !ok || id != c.want || !at.Equal(c.at) {
			t.Fatalf("%d/%d: %q %v %v %v", c.chat, c.msg, id, at, ok, err)
		}
	}
	if _, _, ok, err := st.NotifyMessage(ctx, 42, 9); ok || err != nil {
		t.Fatalf("unknown message: %v %v", ok, err)
	}
	// Older than the age bound (from the newest save): forgotten.
	if err := st.SaveNotifyMessage(ctx, 42, 10, "w-d", t0.Add(store.NotifyMessageAge+3*time.Second)); err != nil {
		t.Fatal(err)
	}
	for _, m := range []int64{7, 8} {
		if _, _, ok, _ := st.NotifyMessage(ctx, 42, m); ok {
			t.Fatalf("message %d older than %s kept", m, store.NotifyMessageAge)
		}
	}
	// At most NotifyMessagesKept: the oldest go first.
	at := t0.Add(store.NotifyMessageAge + time.Hour)
	for i := range store.NotifyMessagesKept + 3 {
		if err := st.SaveNotifyMessage(ctx, 42, int64(1000+i), "w", at.Add(time.Duration(i)*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	if n, err := st.NotifyMessageCount(ctx); err != nil || n != store.NotifyMessagesKept {
		t.Fatalf("%d kept (%v), want %d", n, err, store.NotifyMessagesKept)
	}
	for i, want := range map[int64]bool{1000: false, 1002: false, 1003: true, int64(1000 + store.NotifyMessagesKept + 2): true} {
		if _, _, ok, _ := st.NotifyMessage(ctx, 42, i); ok != want {
			t.Fatalf("message %d kept %v, want %v", i, ok, want)
		}
	}
	// Never a message id 0 (Telegram's "not sent yet").
	if err := st.SaveNotifyMessage(ctx, 42, 0, "w", at); err == nil {
		t.Fatal("message 0 saved")
	}
}
