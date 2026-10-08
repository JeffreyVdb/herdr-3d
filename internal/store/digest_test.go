package store_test

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #118 phase 2: the summaries' settings, the day's count saved apart, and the
// lines by input hash, kept across a reopen; the cache table has the key and
// the line only.
func TestDigestSettingsAndCache(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if _, ok, err := st.LoadDigestSettings(ctx); ok || err != nil {
		t.Fatalf("fresh settings: ok %v, %v", ok, err)
	}
	if err := st.SaveDigestCalls(ctx, store.DigestSettings{DailyCap: 300, CallsDay: "2026-10-03", CallsToday: 1}); err != nil {
		t.Fatal(err) // no row yet: all of it
	}
	if err := st.SaveDigestSettings(ctx, store.DigestSettings{Enabled: true, DailyCap: 50, CallsDay: "2026-10-01"}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveDigestCalls(ctx, store.DigestSettings{DailyCap: 300, CallsDay: "2026-10-03", CallsToday: 2}); err != nil {
		t.Fatal(err)
	}
	for i := range 5 {
		if err := st.SaveDigestLine(ctx, store.DigestLine{Key: fmt.Sprint("k", i), Line: fmt.Sprint("Line ", i)}, 3); err != nil {
			t.Fatal(err)
		}
	}
	// #198: when the line was written goes with it (the caller's time; none: the store's clock).
	written := time.Date(2026, 10, 8, 10, 0, 0, 123_000_000, time.FixedZone("CEST", 2*3600))
	if err := st.SaveDigestLine(ctx, store.DigestLine{Key: "k2", Line: "Again", UsedAt: written}, 3); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	want := store.DigestSettings{Enabled: true, DailyCap: 50, CallsDay: "2026-10-03", CallsToday: 2}
	if got, ok, err := st.LoadDigestSettings(ctx); !ok || err != nil || got != want {
		t.Fatalf("settings after reopen = %+v %v %v", got, ok, err)
	}
	ls, err := st.DigestCache(ctx, 10)
	if err != nil || len(ls) != 3 || ls[0].Key != "k2" || ls[0].Line != "Again" || ls[1].Key != "k4" || ls[2].Key != "k3" {
		t.Fatalf("%+v %v", ls, err)
	}
	if !ls[0].UsedAt.Equal(written) {
		t.Fatalf("k2 written at %v, want %v", ls[0].UsedAt, written)
	}
	if ls[1].UsedAt.IsZero() {
		t.Fatalf("k4 has no time: %+v", ls[1])
	}
	st.Close()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT name FROM pragma_table_info('digest_cache') ORDER BY cid`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var c string
		_ = rows.Scan(&c)
		cols = append(cols, c)
	}
	if fmt.Sprint(cols) != "[key line used_at]" {
		t.Fatalf("digest_cache columns = %v", cols)
	}
}

// #174: the reasoning effort and the completion budget are saved with the
// settings (never by the call count's save), and a row from before them reads
// as the provider's default effort and the default budget (0).
func TestDigestReasoningSettings(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	if err := st.SaveDigestSettings(ctx, store.DigestSettings{Enabled: true, DailyCap: 300, ReasoningEffort: "none", MaxTokens: 2048}); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveDigestCalls(ctx, store.DigestSettings{DailyCap: 300, CallsDay: "2026-10-07", CallsToday: 4}); err != nil {
		t.Fatal(err) // the count's save leaves the settings alone
	}
	st.Close()
	st = open(t, path)
	want := store.DigestSettings{Enabled: true, DailyCap: 300, ReasoningEffort: "none", MaxTokens: 2048, CallsDay: "2026-10-07", CallsToday: 4}
	if got, ok, err := st.LoadDigestSettings(ctx); !ok || err != nil || got != want {
		t.Fatalf("after reopen = %+v %v %v", got, ok, err)
	}
	if err := st.SaveDigestSettings(ctx, store.DigestSettings{Enabled: true, DailyCap: 300}); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.LoadDigestSettings(ctx); got.ReasoningEffort != "" || got.MaxTokens != 0 {
		t.Fatalf("back to the defaults = %+v", got)
	}
}
