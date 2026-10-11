package handoff_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func agentSrc(op string) handoff.Source {
	s := src(op)
	s.Kind, s.Turn, s.Items, s.Hash = store.HandoffAgent, op, `{"harness":"claude"}`, ""
	s.At = time.Date(2026, 10, 11, 9, 30, 0, 0, time.Local)
	return s
}

// #224: the reserved path is in the hidden pending directory, a leftover of
// the op goes, Written tells absent, incomplete and complete apart, and
// Adopt files the text with the bridge's front matter (the agent's dropped)
// and the request's date, then removes the reserved file; a retry answers
// the same handoff.
func TestReserveAndAdopt(t *testing.T) {
	ctx := context.Background()
	svc, st, dir := service(t)
	path, err := svc.Reserve("herdr 3d", "op-1")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(dir, ".pending", "herdr-3d", "op-1.md"); path != want {
		t.Fatalf("path = %s, want %s", path, want)
	}
	if fi, err := os.Stat(filepath.Dir(path)); err != nil || fi.Mode().Perm() != 0o700 {
		t.Fatalf("pending dir: %v %v", fi, err)
	}
	// A leftover of the op is not the agent's answer.
	if err := os.WriteFile(path, []byte("# Old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if again, err := svc.Reserve("herdr 3d", "op-1"); err != nil || again != path {
		t.Fatal(again, err)
	}
	if err := svc.Written(path); !errors.Is(err, handoff.ErrNoFile) {
		t.Fatalf("leftover kept: %v", err)
	}
	if err := os.WriteFile(path+".tmp", []byte("# Half"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := svc.Written(path); !errors.Is(err, handoff.ErrIncomplete) {
		t.Fatalf("tmp: %v", err)
	}
	if _, _, err := svc.Adopt(ctx, agentSrc("op-1"), path); !errors.Is(err, handoff.ErrIncomplete) {
		t.Fatalf("adopt while tmp: %v", err)
	}
	body := "# Loader handoff: streaming done\n\nNext: docs.\n"
	agentFM := "---\ndate: 1999-01-01\nsource: literal\nworker: Mallory\n---\n"
	if err := os.WriteFile(path+".tmp", []byte(agentFM+body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		t.Fatal(err)
	}
	if err := svc.Written(path); err != nil {
		t.Fatal(err)
	}
	h, existing, err := svc.Adopt(ctx, agentSrc("op-1"), path)
	if err != nil || existing {
		t.Fatal(h, existing, err)
	}
	if h.Source != store.HandoffAgent || h.Title != "Loader handoff: streaming done" || h.Op != "op-1" || filepath.Dir(h.Path) != filepath.Join(dir, "herdr-3d") ||
		!strings.HasPrefix(filepath.Base(h.Path), "20261011-0930-ada-lovelace-loader-handoff-streaming-done") {
		t.Fatalf("filed = %+v", h)
	}
	b, err := os.ReadFile(h.Path)
	if err != nil {
		t.Fatal(err)
	}
	fm, got := handoff.SplitFrontMatter(string(b))
	if got != body || fm["source"] != "agent" || fm["worker"] != "Ada Lovelace" || fm["date"] != agentSrc("").At.Format(time.RFC3339) ||
		fm["op"] != "op-1" || fm["harness"] != "claude" || fm["session"] != "sess-1" || fm["branch"] != "h3d/223-handoff" {
		t.Fatalf("file:\n%s", b)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("reserved file kept: %v", err)
	}
	// A retry of the op answers the same handoff, nothing written again.
	if err := os.WriteFile(path, []byte("# Other\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if again, existing, err := svc.Adopt(ctx, agentSrc("op-1"), path); err != nil || !existing || again.ID != h.ID {
		t.Fatalf("retry = %+v %v %v", again, existing, err)
	}
	if all, _ := st.AllHandoffs(ctx); len(all) != 1 {
		t.Fatalf("handoffs = %d", len(all))
	}
	// A restart's reconcile never registers from the pending directory.
	if err := os.WriteFile(path, []byte("---\ndate: \"2026-10-11T09:30:00+02:00\"\nsource: \"agent\"\n---\n# Sneaky\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if r, err := svc.Reconcile(ctx); err != nil || r.Registered != 0 {
		t.Fatalf("reconcile = %+v, %v", r, err)
	}
}

// What Adopt refuses: an empty text (front matter only), invalid UTF-8, a
// file over the cap, a symlink, a path outside the pending directory.
func TestAdoptRefuses(t *testing.T) {
	ctx := context.Background()
	svc, _, dir := service(t)
	write := func(op, s string) string {
		p, err := svc.Reserve("f", op)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if _, _, err := svc.Adopt(ctx, agentSrc("e"), write("e", "---\nx: y\n---\n\n  \n")); !errors.Is(err, handoff.ErrEmpty) {
		t.Errorf("empty: %v", err)
	}
	if _, _, err := svc.Adopt(ctx, agentSrc("u"), write("u", "# T\n\xff\xfe")); !errors.Is(err, handoff.ErrInvalid) {
		t.Errorf("utf-8: %v", err)
	}
	if _, _, err := svc.Adopt(ctx, agentSrc("b"), write("b", strings.Repeat("a", handoff.MaxFile+1))); !errors.Is(err, handoff.ErrTooLarge) {
		t.Errorf("too large: %v", err)
	}
	p, _ := svc.Reserve("f", "l")
	target := filepath.Join(t.TempDir(), "secret.md")
	if err := os.WriteFile(target, []byte("# secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, p); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.Adopt(ctx, agentSrc("l"), p); err == nil {
		t.Error("adopted a symlink")
	}
	for _, bad := range []string{filepath.Join(dir, "f", "x.md"), filepath.Join(dir, ".pending", "x.md"), "/etc/passwd"} {
		if _, _, err := svc.Adopt(ctx, agentSrc("o"), bad); !errors.Is(err, handoff.ErrOutside) {
			t.Errorf("%s: %v", bad, err)
		}
	}
	if _, err := svc.Reserve("f", "../x"); !errors.Is(err, handoff.ErrOutside) {
		t.Errorf("op with a path: %v", err)
	}
}

// A failed request's file goes to the trash (not lost); CleanPending keeps
// the pending requests' files and discards the rest.
func TestDiscardAndCleanPending(t *testing.T) {
	svc, _, dir := service(t)
	keep, _ := svc.Reserve("f", "keep")
	gone, _ := svc.Reserve("f", "gone")
	for _, p := range []string{keep, gone, gone + ".tmp", keep + ".tmp"} {
		if err := os.WriteFile(p, []byte("# x\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	n, err := svc.CleanPending(map[string]bool{keep: true})
	if err != nil || n != 1 {
		t.Fatalf("cleaned %d, %v", n, err)
	}
	for p, want := range map[string]bool{keep: true, keep + ".tmp": true, gone: false, gone + ".tmp": false,
		filepath.Join(dir, ".trash", "f", "agent-gone.md"): true} {
		if _, err := os.Lstat(p); (err == nil) != want {
			t.Errorf("%s: %v", p, err)
		}
	}
	if err := svc.Discard(keep); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(dir, ".trash", "f", "agent-keep.md")); err != nil {
		t.Fatal(err)
	}
	if err := svc.Discard(keep); err != nil { // nothing there
		t.Fatal(err)
	}
}

func TestStripFrontMatter(t *testing.T) {
	for in, want := range map[string]string{
		"# T\n":                           "# T\n",
		"---\na: b\n---\n# T\n":           "# T\n",
		"---\r\na: \"b\"\r\n---\r\n# T\n": "# T\n",
		"---\n---\nbody":                  "body",
		"---\nnot closed\n# T":            "---\nnot closed\n# T",
		"\ufeff---\na: 1\n--- \nbody":     "body",
		"text\n---\na\n---\n":             "text\n---\na\n---\n",
	} {
		if got := handoff.StripFrontMatter(in); got != want {
			t.Errorf("StripFrontMatter(%q) = %q, want %q", in, got, want)
		}
	}
}
