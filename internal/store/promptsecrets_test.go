package store_test

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #108 round 5: a lease is held by another worker than the owner, goes with
// its file, and counts for its holder; a handoff's files go with the file
// and with the handoff.
func TestSecretLeases(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	for _, o := range []store.SecretOwner{{Dir: "DA", Kind: store.SecretOwnerWorker, OwnerID: "a"},
		{Dir: "DB", Kind: store.SecretOwnerWorker, OwnerID: "b"}} {
		if err := st.AddSecretOwner(ctx, o); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range [][2]string{{"DA", "F1"}, {"DA", "F2"}, {"DB", "F3"}} {
		if err := st.AddSecretFile(ctx, f[0], f[1]); err != nil {
			t.Fatal(err)
		}
	}
	f1, f2, f3 := store.SecretFile{Dir: "DA", Name: "F1"}, store.SecretFile{Dir: "DA", Name: "F2"}, store.SecretFile{Dir: "DB", Name: "F3"}
	for _, c := range []struct {
		f      store.SecretFile
		worker string
		want   bool
	}{
		{f1, "b", true},
		{f1, "b", false}, // held already
		{f1, "a", false}, // its owner
		{store.SecretFile{Dir: "DA", Name: "NO"}, "b", false}, // no such file
		{f1, "c", true},
		{f3, "a", true},
	} {
		if ok, err := st.AddSecretLease(ctx, c.f, c.worker); err != nil || ok != c.want {
			t.Errorf("lease %v to %s: %v %v", c.f, c.worker, ok, err)
		}
	}
	counts, err := st.SecretFileCounts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if counts["a"] != 3 || counts["b"] != 2 || counts["c"] != 1 || len(counts) != 3 {
		t.Fatalf("counts %v", counts)
	}

	h, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", Path: "/h/f/x.md", Title: "x", Source: store.HandoffLiteral}, "body")
	if err != nil {
		t.Fatal(err)
	}
	if n, err := st.AddHandoffSecrets(ctx, h.ID, []store.SecretFile{f1, f2, f1, {Dir: "DA", Name: "NO"}}); err != nil || n != 2 {
		t.Fatalf("handoff secrets: %d %v", n, err)
	}
	if got, err := st.HandoffSecretsAt(ctx, "/h/f/x.md"); err != nil || len(got) != 2 || got[0] != f1 || got[1] != f2 {
		t.Fatalf("at the path: %v %v", got, err)
	}
	// Named in a text (review L2): by the path as filed, blanks and all,
	// and only whole.
	for path, files := range map[string][]store.SecretFile{"/h s/f/y.md": {f3}, "/h/f/x.md.old": {f2}} {
		x, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", Path: path, Title: "x", Source: store.HandoffLiteral}, "body")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.AddHandoffSecrets(ctx, x.ID, files); err != nil {
			t.Fatal(err)
		}
	}
	for text, want := range map[string][]store.SecretFile{
		"Read /h/f/x.md and continue the work.":       {f1, f2},
		"Read /h/f/x.md.":                             {f1, f2},
		"Read /h/f/x.md.old and continue.":            {f2},
		"Read /h s/f/y.md, then (/h/f/x.md.old).":     {f2, f3},
		"/h/f/x.md /h/f/x.md.old /h s/f/y.md":         {f1, f2, f3},
		"Read /mnt/h/f/x.md or /h s/f/y.mdx or x.md.": nil,
	} {
		if got, err := st.HandoffSecretsIn(ctx, text); err != nil || !slices.Equal(got, want) {
			t.Errorf("in %q: %v %v, want %v", text, got, err, want)
		}
	}

	// A file that goes takes its leases and its handoff's row; a holder's
	// leases go with it.
	if err := st.RemoveSecretFile(ctx, "DA", "F1"); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.SecretLeasesOf(ctx, "b"); len(l) != 0 {
		t.Fatalf("b's leases %v", l)
	}
	if got, _ := st.HandoffSecretsAt(ctx, "/h/f/x.md"); len(got) != 1 || got[0] != f2 {
		t.Fatalf("after the file went: %v", got)
	}
	if err := st.RemoveSecretLeasesOf(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.SecretLeases(ctx); len(l) != 0 {
		t.Fatalf("leases %v", l)
	}
	if err := st.DeleteHandoff(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	if got, _ := st.HandoffSecretsAt(ctx, "/h/f/x.md"); len(got) != 0 {
		t.Fatalf("after the handoff went: %v", got)
	}
	if err := st.RemoveSecretOwner(ctx, "DB"); err != nil {
		t.Fatal(err)
	}
	if counts, _ := st.SecretFileCounts(ctx); counts["a"] != 1 || len(counts) != 1 {
		t.Fatalf("counts at the end %v", counts)
	}
}

// OpenWorkers has every worker not closed, with its session and workspace
// (round 5: the janitor asks whether its floor still shows it).
func TestOpenWorkers(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	for _, w := range []store.Worker{{ID: "a", Session: "s", WorkspaceID: "w1"}, {ID: "b", Session: "t", WorkspaceID: "w2"}} {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.CloseWorker(ctx, "b"); err != nil {
		t.Fatal(err)
	}
	open, err := st.OpenWorkers(ctx)
	if err != nil || len(open) != 1 || open["a"] != (store.OpenWorker{Session: "s", WorkspaceID: "w1"}) {
		t.Fatalf("open %v %v", open, err)
	}
}
