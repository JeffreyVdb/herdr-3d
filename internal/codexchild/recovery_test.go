package codexchild

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
)

// Root-session recovery (the sleep backfill's codex.FindSession, the usage
// tracker's codex.Finder) never takes a child rollout for a pane's
// session: every case's children are newer than its root and share its
// cwd, forked ones carry the root's session_meta on their second line,
// depth 2 and 0.160.1 included, and a guardian reviewer is no root either.
func TestRootRecoveryIgnoresChildren(t *testing.T) {
	for name, session := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, name)
			r.all()
			m, _, ok := codex.ReadMeta(r.path(session))
			if !ok || m.Cwd == "" {
				t.Fatalf("root meta %+v", m)
			}
			if got, err := codex.FindSession(r.root, m.Cwd, nil); got != session || err != nil {
				t.Errorf("FindSession = %q, %v; want the root %s", got, err, session)
			}
			f := &codex.Finder{Root: r.root}
			if got, _ := f.Find(m.Cwd, nil); got != session {
				t.Errorf("Finder = %q; want the root", got)
			}
			taken := func(id string) bool { return id == session }
			if got, _ := codex.FindSession(r.root, m.Cwd, taken); got != "" {
				t.Errorf("the root taken: FindSession = %q; want none", got)
			}
			if got, _ := f.Find(m.Cwd, taken); got != "" {
				t.Errorf("the root taken: Finder = %q; want none", got)
			}
		})
	}
}

// The child finder finds a session's children by their first line, nested
// ones included, and nothing of another session's or a guardian's.
func TestChildFinder(t *testing.T) {
	r := newRig(t, "c2")
	r.all()
	for _, other := range []string{"b", "corpus-guardian"} {
		o := newRig(t, other)
		o.root = r.root
		o.all()
	}
	f := &codex.ChildFinder{Root: r.root, Session: r.session, From: codex.DateDir(r.root, r.path(r.session))}
	var got []string
	for _, c := range f.Find() {
		got = append(got, c.Meta.ID)
	}
	slices.Sort(got)
	if want := []string{c2Outer, c2Inner}; !slices.Equal(got, want) {
		t.Fatalf("children %v; want %v", got, want)
	}
	// From a later day on: none (the fixtures are of 2026/10/18).
	if cs := (&codex.ChildFinder{Root: r.root, Session: r.session, From: "2026/10/19"}).Find(); len(cs) != 0 {
		t.Fatalf("from a later day: %+v", cs)
	}
	g := &codex.ChildFinder{Root: r.root, Session: cases["corpus-guardian"]}
	if cs := g.Find(); len(cs) != 0 {
		t.Fatalf("a guardian's session: %+v", cs)
	}
}

// A child rollout whose first line is still being written is found once
// it is whole.
func TestChildFinderPartialFirstLine(t *testing.T) {
	r := newRig(t, "a")
	r.write(r.session, -1)
	p := r.path(aChild)
	line := r.fx.lines[aChild][0]
	if err := os.WriteFile(p, []byte(line[:len(line)/2]), 0o644); err != nil {
		t.Fatal(err)
	}
	f := &codex.ChildFinder{Root: r.root, Session: r.session}
	if cs := f.Find(); len(cs) != 0 {
		t.Fatalf("half a line: %+v", cs)
	}
	if err := os.WriteFile(p, []byte(line+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if cs := f.Find(); len(cs) != 1 || cs[0].Meta.ID != aChild || filepath.Base(cs[0].Path) != r.fx.names[aChild] {
		t.Fatalf("whole: %+v", cs)
	}
}
