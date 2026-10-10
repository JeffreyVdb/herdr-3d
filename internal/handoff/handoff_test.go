package handoff_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// The filing service is a leaf: the standard library and the store.
func TestHandoffIsALeaf(t *testing.T) {
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("no go tool")
	}
	const mod = "github.com/JeffreyVdb/herdr-3d/"
	out, err := exec.Command("go", "list", "-deps", mod+"internal/handoff").CombinedOutput()
	if err != nil {
		t.Fatalf("go list: %v\n%s", err, out)
	}
	for _, dep := range strings.Fields(string(out)) {
		if strings.HasPrefix(dep, mod) && dep != mod+"internal/handoff" && dep != mod+"internal/store" {
			t.Errorf("internal/handoff depends on %s", dep)
		}
	}
}

var at = time.Date(2026, 10, 10, 15, 59, 30, 0, time.Local)

func service(t *testing.T) (*handoff.Service, *store.Store, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "handoff")
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "world.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc, err := handoff.New(dir, st, func() time.Time { return at })
	if err != nil {
		t.Fatal(err)
	}
	return svc, st, dir
}

func src(op string) handoff.Source {
	return handoff.Source{Floor: "herdr-3d", WorkerID: "w-1", WorkerName: "Ada Lovelace", Label: "h3d-223", Harness: "claude",
		Model: "opus", Cwd: "/work/x", Branch: "h3d/223-handoff", AgentSession: "sess-1", Kind: store.HandoffLiteral,
		Turn: "cand-1", Items: `{"message":"msg_1"}`, Hash: "abc", Op: op}
}

func TestTitle(t *testing.T) {
	for _, tc := range []struct{ body, want string }{
		{"# Session loader\n\nText", "Session loader"},
		{"Intro line\n\n# The real title #\n", "The real title"},
		{"```md\n# Not a title\n```\n# Title after the fence", "Title after the fence"},
		{"~~~~\n# no\n~~~~\nplain", "no"},
		{"\n\n   ## Second-level start ##\nbody", "Second-level start"},
		{"    # indented code, not a heading\nnext", "indented code, not a heading"},
		{"#hashtag first", "#hashtag first"},
		{"C# notes", "C# notes"},
		{"First   line\twith\x07 blanks\n# Later H1", "Later H1"},
		{"Only a line", "Only a line"},
		{"\n \n\t\n", "Ada 2026-10-10 15:59"},
		{"#\n###\n", "Ada 2026-10-10 15:59"},
		{strings.Repeat("é", 100), strings.Repeat("é", 79) + "…"},
	} {
		if got := handoff.Title(tc.body, "Ada", at); got != tc.want {
			t.Errorf("Title(%q) = %q, want %q", tc.body, got, tc.want)
		}
	}
	if got := handoff.Title("", "", at); got != "Handoff 2026-10-10 15:59" {
		t.Errorf("no worker: %q", got)
	}
}

func TestNames(t *testing.T) {
	for in, want := range map[string]string{
		"Session loader: v2!":     "session-loader-v2",
		"../../etc/passwd":        "etc-passwd",
		"日本語":                     "handoff",
		strings.Repeat("ab ", 40): strings.TrimRight(strings.Repeat("ab-", 16), "-"),
	} {
		if got := handoff.Slug(in); got != want {
			t.Errorf("Slug(%q) = %q, want %q", in, got, want)
		}
	}
	for in, want := range map[string]string{
		"herdr-3d": "herdr-3d", "../up": "-up", ".trash": "trash", "a/b": "a-b", "": "floor", "...": "floor", "sp ace": "sp-ace",
	} {
		if got := handoff.FloorDir(in); got != want {
			t.Errorf("FloorDir(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFrontMatter(t *testing.T) {
	h := store.Handoff{Floor: "f", WorkerName: `Ada "the" \ one`, Branch: "b", Harness: "codex", Source: store.HandoffLiteral}
	body := "---\nnot: front matter\n---\n  body  \n"
	fm, got := handoff.SplitFrontMatter(handoff.FrontMatter(h, at) + body)
	if got != body || fm["worker"] != h.WorkerName || fm["source"] != "literal" || fm["date"] != at.Format(time.RFC3339) || fm["model"] != "" {
		t.Fatalf("front matter %v, body %q", fm, got)
	}
	if fm, got := handoff.SplitFrontMatter("plain\n"); len(fm) != 0 || got != "plain\n" {
		t.Fatalf("no front matter: %v %q", fm, got)
	}
}

func TestFile(t *testing.T) {
	ctx := context.Background()
	svc, st, dir := service(t)
	body := "  # Loader\n\n```go\nfunc main() {}\n```\n\n" + strings.Repeat("tail ", 4000) + "\n\n  "
	h, existing, err := svc.File(ctx, src("op-1"), body)
	if err != nil || existing {
		t.Fatalf("File: %+v %v %v", h, existing, err)
	}
	want := filepath.Join(dir, "herdr-3d", "20261010-1559-ada-lovelace-loader.md")
	if h.Path != want || h.Title != "Loader" || h.ID == 0 || h.CreatedAt != at.UnixMilli() || h.Size == 0 {
		t.Fatalf("handoff %+v", h)
	}
	b, err := os.ReadFile(h.Path)
	if err != nil {
		t.Fatal(err)
	}
	fm, got := handoff.SplitFrontMatter(string(b))
	if got != body || fm["branch"] != "h3d/223-handoff" || fm["session"] != "sess-1" || fm["source"] != "literal" || fm["cwd"] != "/work/x" {
		t.Fatalf("file: %v / %d bytes", fm, len(got))
	}
	if fi, _ := os.Stat(h.Path); fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode())
	}
	if left, _ := filepath.Glob(filepath.Join(dir, "herdr-3d", ".*")); len(left) != 0 {
		t.Fatalf("leftover tmp: %v", left)
	}
	// The same operation again: the same handoff, no second file.
	again, existing, err := svc.File(ctx, src("op-1"), body)
	if err != nil || !existing || again.ID != h.ID {
		t.Fatalf("again: %+v %v %v", again, existing, err)
	}
	// Another operation of the same source: the same handoff too.
	again, existing, err = svc.File(ctx, src("op-2"), body)
	if err != nil || !existing || again.ID != h.ID {
		t.Fatalf("same source: %+v %v %v", again, existing, err)
	}
	// The operation id of another source: refused.
	other := src("op-1")
	other.Hash = "def"
	if _, _, err := svc.File(ctx, other, "x"); !errors.Is(err, handoff.ErrOpReused) {
		t.Fatalf("op reused: %v", err)
	}
	// Another source with the same title in the same minute: a suffix.
	other = src("op-3")
	other.Turn = "cand-2"
	h2, _, err := svc.File(ctx, other, "# Loader\nother")
	if err != nil || h2.Path != strings.TrimSuffix(want, ".md")+"-2.md" {
		t.Fatalf("collision: %+v %v", h2, err)
	}
	if files, _ := filepath.Glob(filepath.Join(dir, "herdr-3d", "*.md")); len(files) != 2 {
		t.Fatalf("files %v", files)
	}
	// Read: the body as filed, without front matter.
	_, rb, err := svc.Read(ctx, h.ID)
	if err != nil || rb != body {
		t.Fatalf("Read: %d bytes, %v", len(rb), err)
	}
	// Refused: empty, too large, invalid UTF-8.
	for in, wantErr := range map[string]error{" \n\t": handoff.ErrEmpty, strings.Repeat("x", handoff.MaxBody+1): handoff.ErrTooLarge,
		"bad \xff": handoff.ErrInvalid} {
		if _, _, err := svc.File(ctx, src("op-x"), in); !errors.Is(err, wantErr) {
			t.Errorf("%d bytes: %v, want %v", len(in), err, wantErr)
		}
	}
	// A floor name never leaves the directory.
	esc := src("op-4")
	esc.Floor, esc.Turn = "../../outside", "cand-4"
	h4, _, err := svc.File(ctx, esc, "escape")
	if err != nil || filepath.Dir(h4.Path) != filepath.Join(dir, "-..-outside") {
		t.Fatalf("escape: %+v %v", h4, err)
	}
	if n, _ := st.HandoffCounts(ctx); n["herdr-3d"] != 2 {
		t.Fatalf("counts %v", n)
	}
}

// failIndex fails AddHandoff.
type failIndex struct{ *store.Store }

func (failIndex) AddHandoff(context.Context, store.Handoff, string) (store.Handoff, error) {
	return store.Handoff{}, errors.New("disk I/O error")
}

// A database failure leaves no handoff: no row, no file.
func TestFileDBFailure(t *testing.T) {
	ctx := context.Background()
	_, st, dir := service(t)
	svc, _ := handoff.New(dir, failIndex{st}, func() time.Time { return at })
	if _, _, err := svc.File(ctx, src("op-1"), "# Body"); err == nil {
		t.Fatal("no error")
	}
	if files, _ := filepath.Glob(filepath.Join(dir, "herdr-3d", "*")); len(files) != 0 {
		t.Fatalf("files left: %v", files)
	}
	if all, _ := st.AllHandoffs(ctx); len(all) != 0 {
		t.Fatalf("rows: %+v", all)
	}
	// A file error (the floor's directory is a file) too.
	svc2, _ := handoff.New(dir, st, func() time.Time { return at })
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "other"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	s2 := src("op-2")
	s2.Floor = "other"
	if _, _, err := svc2.File(ctx, s2, "# Body"); err == nil {
		t.Fatal("no error writing into a file")
	}
	if all, _ := st.AllHandoffs(ctx); len(all) != 0 {
		t.Fatalf("rows: %+v", all)
	}
}

func TestDelete(t *testing.T) {
	ctx := context.Background()
	svc, st, dir := service(t)
	h, _, err := svc.File(ctx, src("op-1"), "# One")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Delete(ctx, h.ID); err != nil {
		t.Fatal(err)
	}
	trashed := filepath.Join(dir, handoff.TrashDir, "herdr-3d", filepath.Base(h.Path))
	if _, err := os.Stat(trashed); err != nil {
		t.Fatalf("not in the trash: %v", err)
	}
	if _, err := os.Stat(h.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("still there: %v", err)
	}
	if _, err := st.HandoffByID(ctx, h.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("row: %v", err)
	}
	if _, err := svc.Delete(ctx, h.ID); !errors.Is(err, handoff.ErrNotFound) {
		t.Fatalf("twice: %v", err)
	}
	// The same name again: the trash keeps both.
	h2, _, err := svc.File(ctx, src("op-2"), "# One")
	if err != nil || h2.Path != h.Path {
		t.Fatalf("refile: %+v %v", h2, err)
	}
	if _, err := svc.Delete(ctx, h2.ID); err != nil {
		t.Fatal(err)
	}
	if files, _ := filepath.Glob(filepath.Join(dir, handoff.TrashDir, "herdr-3d", "*.md")); len(files) != 2 {
		t.Fatalf("trash %v", files)
	}
	// A file already gone is only forgotten.
	h3, _, _ := svc.File(ctx, src("op-3"), "# Three")
	os.Remove(h3.Path)
	if _, err := svc.Delete(ctx, h3.ID); err != nil {
		t.Fatal(err)
	}
	// A row whose path is outside the directory is never touched.
	out := filepath.Join(t.TempDir(), "victim.md")
	os.WriteFile(out, []byte("keep"), 0o600)
	bad, err := st.AddHandoff(ctx, store.Handoff{Floor: "f", Path: out, Title: "x", Source: store.HandoffLiteral}, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Delete(ctx, bad.ID); !errors.Is(err, handoff.ErrOutside) {
		t.Fatalf("outside: %v", err)
	}
	if _, _, err := svc.Read(ctx, bad.ID); !errors.Is(err, handoff.ErrOutside) {
		t.Fatalf("read outside: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatal("the outside file was moved")
	}
}

// The startup reconcile: a file gone is forgotten, a changed one indexed
// again, a file a crash left without its row registered, a .tmp removed.
func TestReconcile(t *testing.T) {
	ctx := context.Background()
	svc, st, dir := service(t)
	gone, _, _ := svc.File(ctx, src("op-1"), "# Gone\nbody")
	other := src("op-2")
	other.Turn = "cand-2"
	changed, _, _ := svc.File(ctx, other, "# Changed\nbody")
	os.Remove(gone.Path)
	b, _ := os.ReadFile(changed.Path)
	fm, _ := handoff.SplitFrontMatter(string(b))
	if err := os.WriteFile(changed.Path, []byte(handoff.FrontMatter(store.Handoff{WorkerName: fm["worker"], Source: "literal"}, at)+"# Edited by hand\nzebras"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A crash after the file was written, before its row: an orphan.
	orphan := filepath.Join(dir, "herdr-3d", "20261010-1600-bob-orphan.md")
	os.WriteFile(orphan, []byte(handoff.FrontMatter(store.Handoff{Floor: "herdr-3d", WorkerName: "Bob", Branch: "h3d/x",
		Source: "literal"}, at)+"# Orphan\nfound again"), 0o600)
	os.WriteFile(filepath.Join(dir, "herdr-3d", ".handoff-123.tmp"), []byte("half"), 0o600)
	os.WriteFile(filepath.Join(dir, "herdr-3d", "notes.md"), []byte("# Not ours\nno front matter"), 0o600)
	os.MkdirAll(filepath.Join(dir, handoff.TrashDir, "herdr-3d"), 0o700)
	os.WriteFile(filepath.Join(dir, handoff.TrashDir, "herdr-3d", "x.md"), []byte(handoff.FrontMatter(store.Handoff{Source: "literal"}, at)+"trashed"), 0o600)

	// A restart: a new service on the same store and directory.
	svc2, _ := handoff.New(dir, st, func() time.Time { return at })
	r, err := svc2.Reconcile(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if r != (handoff.Reconciled{Removed: 1, Reindexed: 1, Registered: 1, Tmp: 1}) {
		t.Fatalf("reconciled %+v", r)
	}
	if hits, _ := st.Handoffs(ctx, "herdr-3d", "zebras", 0); len(hits) != 1 || hits[0].Title != "Edited by hand" {
		t.Fatalf("reindexed: %+v", hits)
	}
	if hits, _ := st.Handoffs(ctx, "herdr-3d", "orphan", 0); len(hits) != 1 || hits[0].WorkerName != "Bob" || hits[0].Branch != "h3d/x" {
		t.Fatalf("registered: %+v", hits)
	}
	if all, _ := st.AllHandoffs(ctx); len(all) != 2 {
		t.Fatalf("rows %+v", all)
	}
	// Once more: nothing to do.
	if r, err := svc2.Reconcile(ctx); err != nil || r != (handoff.Reconciled{}) {
		t.Fatalf("again %+v %v", r, err)
	}
}
