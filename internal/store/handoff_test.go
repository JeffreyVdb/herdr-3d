package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func TestHandoffQuery(t *testing.T) {
	for in, want := range map[string]string{
		"":                       "",
		"   \t\n":                "",
		"run":                    `"run"*`,
		"session loader":         `"session" "loader"*`,
		`say "hi"`:               `"say" """hi"""*`,
		`title:x OR y NEAR(a b)`: `"title:x" "OR" "y" "NEAR(a" "b)"*`,
		"a b c d e f g h i j":    `"a" "b" "c" "d" "e" "f" "g" "h"*`,
		"*":                      `"*"*`,
	} {
		if got := store.HandoffQuery(in); got != want {
			t.Errorf("HandoffQuery(%q) = %s, want %s", in, got, want)
		}
	}
	long := strings.Repeat("é", 200) // 400 bytes: cut on a rune
	if got := store.HandoffQuery(long); !strings.HasPrefix(got, `"é`) || len(got) > store.MaxHandoffQuery+8 {
		t.Errorf("long query: %q", got)
	}
}

func addHandoff(t *testing.T, st *store.Store, floor, title, worker, body string, at int64) store.Handoff {
	t.Helper()
	h, err := st.AddHandoff(context.Background(), store.Handoff{Floor: floor, WorkerName: worker, Label: "lbl", Branch: "h3d/x",
		Path: "/h/" + floor + "/" + title + ".md", Title: title, CreatedAt: at, Source: store.HandoffLiteral}, body)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// #223: the cabinet's index: newest first without a query, bm25 with one
// (the title weighs most), only the floor's, snippets with private-use
// markers, deletion out of the index, and no query that is FTS5 syntax.
func TestHandoffIndex(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	a := addHandoff(t, st, "f1", "Session loader refactor", "Ada", "The loader now streams. Tests pass.", 1000)
	b := addHandoff(t, st, "f1", "Notes", "Bob", "The session loader was refactored; the loader streams, see the loader docs.", 2000)
	c := addHandoff(t, st, "f1", "Café menu", "Cy", "Résumé of the <b>day</b> & running jobs", 3000)
	addHandoff(t, st, "f2", "Session loader elsewhere", "Di", "loader", 4000)

	list, err := st.Handoffs(ctx, "f1", "  ", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].ID != c.ID || list[1].ID != b.ID || list[2].ID != a.ID || list[0].Snippet != "" {
		t.Fatalf("list = %+v", list)
	}
	hits, err := st.Handoffs(ctx, "f1", "loader", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 2 || hits[0].ID != a.ID || hits[1].ID != b.ID {
		t.Fatalf("ranking: %+v", hits)
	}
	if !strings.Contains(hits[1].Snippet, store.SnippetOpen+"loader"+store.SnippetClose) {
		t.Fatalf("snippet %q", hits[1].Snippet)
	}
	// Porter stemming, diacritics, prefixes.
	for q, want := range map[string]int64{"run": c.ID, "cafe": c.ID, "resume": c.ID, "refactoring": a.ID, "docs": b.ID, "strea": a.ID} {
		hits, err := st.Handoffs(ctx, "f1", q, 0)
		if err != nil || len(hits) == 0 || hits[0].ID != want {
			t.Errorf("%q: %+v, %v", q, hits, err)
		}
	}
	// FTS5 syntax is text, never an error or another query.
	for _, q := range []string{`"`, `*`, `loader OR notes`, `NEAR(loader streams)`, `title:Notes`, `-loader`, `(`, `^`, `""""`, "a\x00b"} {
		if _, err := st.Handoffs(ctx, "f1", q, 0); err != nil {
			t.Errorf("%q: %v", q, err)
		}
	}
	if hits, _ := st.Handoffs(ctx, "f1", "loader OR cafe", 0); len(hits) != 0 {
		t.Errorf("OR was syntax: %+v", hits)
	}
	// The snippet keeps the markup as text.
	hits, _ = st.Handoffs(ctx, "f1", "day", 0)
	if len(hits) != 1 || !strings.Contains(hits[0].Snippet, "<b>"+store.SnippetOpen+"day"+store.SnippetClose+"</b>") {
		t.Fatalf("markup snippet: %+v", hits)
	}
	// Delete: out of the list and the index.
	if err := st.DeleteHandoff(ctx, b.ID); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteHandoff(ctx, b.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	if hits, _ := st.Handoffs(ctx, "f1", "docs", 0); len(hits) != 0 {
		t.Fatalf("deleted still found: %+v", hits)
	}
	// Reindex: the file changed.
	if err := st.ReindexHandoff(ctx, a.ID, "Loader v2", 99, 7, "Rewritten entirely with zebras."); err != nil {
		t.Fatal(err)
	}
	if hits, _ := st.Handoffs(ctx, "f1", "zebra", 0); len(hits) != 1 || hits[0].Title != "Loader v2" || hits[0].Size != 99 {
		t.Fatalf("reindexed: %+v", hits)
	}
	if hits, _ := st.Handoffs(ctx, "f1", "streams", 0); len(hits) != 0 {
		t.Fatalf("old body still indexed: %+v", hits)
	}
	counts, err := st.HandoffCounts(ctx)
	if err != nil || counts["f1"] != 2 || counts["f2"] != 1 {
		t.Fatalf("counts %v %v", counts, err)
	}
	// It all survives a restart.
	st.Close()
	st = open(t, path)
	if hits, _ := st.Handoffs(ctx, "f1", "zebra", 0); len(hits) != 1 {
		t.Fatalf("after a restart: %+v", hits)
	}
}

// The operation key and the source make a filing findable again.
func TestHandoffLookups(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	h, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", WorkerID: "w1", Path: "/h/f/a.md", Title: "A", CreatedAt: 1,
		Source: store.HandoffLiteral, SourceTurn: "c1", SourceHash: "ab", Op: "op-1"}, "body")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := st.HandoffByOp(ctx, "op-1"); err != nil || got.ID != h.ID {
		t.Fatalf("by op: %+v %v", got, err)
	}
	if got, err := st.HandoffBySource(ctx, "w1", "c1", "ab"); err != nil || got.ID != h.ID || got.Op != "op-1" {
		t.Fatalf("by source: %+v %v", got, err)
	}
	if _, err := st.HandoffByOp(ctx, "op-2"); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	if _, err := st.HandoffByOp(ctx, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatal(err)
	}
	// The same operation, or the same path, twice: refused.
	if _, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", Path: "/h/f/b.md", Title: "B", Source: store.HandoffLiteral, Op: "op-1"}, ""); err == nil {
		t.Fatal("a second row of one operation")
	}
	if _, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", Path: "/h/f/a.md", Title: "B", Source: store.HandoffLiteral}, ""); err == nil {
		t.Fatal("a second row of one path")
	}
	if _, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", Path: "/h/f/c.md", Title: "C", Source: "summary"}, ""); err == nil {
		t.Fatal("an unknown source")
	}
	// A failed add leaves nothing in the index.
	if hits, _ := st.Handoffs(ctx, "f", "", 0); len(hits) != 1 {
		t.Fatalf("index: %+v", hits)
	}
	all, err := st.AllHandoffs(ctx)
	if err != nil || len(all) != 1 {
		t.Fatalf("all: %+v %v", all, err)
	}
}
