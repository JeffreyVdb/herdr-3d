package codex

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func rollout(t *testing.T, root, day, stamp, id, cwd string) {
	t.Helper()
	dir := filepath.Join(root, filepath.FromSlash(day))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta := `{"timestamp":"x","type":"session_meta","payload":{"id":"` + id + `","cwd":"` + cwd +
		`","base_instructions":{"text":"` + strings.Repeat("x", 100<<10) + `"}}}` + "\n" +
		`{"type":"turn_context","payload":{"cwd":"/elsewhere"}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "rollout-"+stamp+"-"+id+".jsonl"), []byte(meta), 0o600); err != nil {
		t.Fatal(err)
	}
}

// subRollout writes a subagent's rollout: its own id, the parent's cwd, and
// the fields Codex marks it with.
func subRollout(t *testing.T, root, day, stamp, id, parent, cwd string) {
	t.Helper()
	dir := filepath.Join(root, filepath.FromSlash(day))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	meta := `{"timestamp":"x","type":"session_meta","payload":{"id":"` + id + `","session_id":"` + parent +
		`","forked_from_id":"` + parent + `","parent_thread_id":"` + parent + `","cwd":"` + cwd +
		`","thread_source":"subagent","source":{"subagent":{"thread_spawn":{"parent_thread_id":"` + parent +
		`","depth":1,"agent_path":"/root/spec"}}}}}` + "\n"
	if err := os.WriteFile(filepath.Join(dir, "rollout-"+stamp+"-"+id+".jsonl"), []byte(meta), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A pane's Codex spawns subagents in its cwd, newer than the pane's own
// rollout: another pane in that cwd must not take one for its session.
func TestFindSessionSkipsSubagents(t *testing.T) {
	root := t.TempDir()
	rollout(t, root, "2026/10/02", "2026-10-02T08-38-16", "01a0-root", "/home/u/repo")
	subRollout(t, root, "2026/10/02", "2026-10-02T08-39-17", "01a0-standards", "01a0-root", "/home/u/repo")
	subRollout(t, root, "2026/10/02", "2026-10-02T08-39-28", "01a0-spec", "01a0-root", "/home/u/repo")

	if got, err := FindSession(root, "/home/u/repo", nil); got != "01a0-root" || err != nil {
		t.Errorf("newest = %q, %v; want the root", got, err)
	}
	// The root's own pane has it: the other pane has no session yet.
	if got, _ := FindSession(root, "/home/u/repo", func(id string) bool { return id == "01a0-root" }); got != "" {
		t.Errorf("only subagents left = %q; want none", got)
	}
	// Still reachable by id (a transcript of a subagent).
	if p, _ := FindRollout(root, "01a0-spec"); p == "" {
		t.Error("FindRollout lost the subagent's file")
	}
}

func TestFindSession(t *testing.T) {
	root := t.TempDir()
	rollout(t, root, "2026/09/27", "2026-09-27T23-00-00", "01a0-old", "/home/u/repo")
	rollout(t, root, "2026/09/28", "2026-09-28T10-00-00", "01a0-morning", "/home/u/repo")
	rollout(t, root, "2026/09/28", "2026-09-28T12-00-00", "01a0-noon", "/home/u/other")
	rollout(t, root, "2026/09/28", "2026-09-28T09-00-00", "01a0-early", "/home/u/repo/")
	// Not rollouts, or not parseable.
	if err := os.WriteFile(filepath.Join(root, "2026", "09", "28", "notes.txt"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "2026", "09", "28", "rollout-2026-09-28T23-59-59-bad.jsonl"), []byte("garbage\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	rollout(t, root, "2026/09/28", "2026-09-28T23-00-00", "bad id!", "/home/u/repo")

	for _, tc := range []struct {
		cwd  string
		skip []string
		want string
	}{
		{"/home/u/repo", nil, "01a0-morning"},
		{"/home/u/repo/", nil, "01a0-morning"},
		{"/home/u/repo", []string{"01a0-morning"}, "01a0-early"},
		{"/home/u/repo", []string{"01a0-morning", "01a0-early"}, "01a0-old"},
		{"/home/u/repo", []string{"01a0-morning", "01a0-early", "01a0-old"}, ""},
		{"/home/u/other", nil, "01a0-noon"},
		{"/home/u/none", nil, ""},
		{"", nil, ""},
	} {
		skip := func(id string) bool {
			for _, s := range tc.skip {
				if s == id {
					return true
				}
			}
			return false
		}
		got, err := FindSession(root, tc.cwd, skip)
		if err != nil || got != tc.want {
			t.Errorf("FindSession(%q, skip %v) = %q, %v; want %q", tc.cwd, tc.skip, got, err, tc.want)
		}
	}
	if got, err := FindSession(filepath.Join(root, "missing"), "/home/u/repo", nil); got != "" || err != nil {
		t.Errorf("missing root: %q, %v", got, err)
	}
}

// A Finder reads a rollout's first line once, and one it could not read
// (still being written) again the next time.
func TestFinderRemembers(t *testing.T) {
	root := t.TempDir()
	rollout(t, root, "2026/09/28", "2026-09-28T10-00-00", "01a0-morning", "/home/u/repo")
	f := &Finder{Root: root}
	if got, err := f.Find("/home/u/repo", nil); got != "01a0-morning" || err != nil {
		t.Fatalf("first = %q, %v", got, err)
	}
	// Its first line changed on disk (it never does): the remembered one counts.
	rollout(t, root, "2026/09/28", "2026-09-28T10-00-00", "01a0-morning", "/home/u/other")
	if got, _ := f.Find("/home/u/repo", nil); got != "01a0-morning" {
		t.Fatalf("remembered = %q", got)
	}
	// A new rollout whose first line is not complete yet, then is.
	partial := filepath.Join(root, "2026", "09", "28", "rollout-2026-09-28T11-00-00-01a0-late.jsonl")
	if err := os.WriteFile(partial, []byte(`{"type":"session_meta","payload":{"id":"01a0-la`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := f.Find("/home/u/repo", nil); got != "01a0-morning" {
		t.Fatalf("with a partial one = %q", got)
	}
	rollout(t, root, "2026/09/28", "2026-09-28T11-00-00", "01a0-late", "/home/u/repo")
	if got, _ := f.Find("/home/u/repo", nil); got != "01a0-late" {
		t.Fatalf("once written = %q", got)
	}
}

func TestDefaultSessionsDir(t *testing.T) {
	t.Setenv("CODEX_HOME", "/opt/codex")
	if got := DefaultSessionsDir(); got != "/opt/codex/sessions" {
		t.Errorf("with CODEX_HOME: %q", got)
	}
	t.Setenv("CODEX_HOME", "")
	t.Setenv("HOME", "/home/u")
	if got := DefaultSessionsDir(); got != "/home/u/.codex/sessions" {
		t.Errorf("default: %q", got)
	}
}

func TestFindRollout(t *testing.T) {
	root := t.TempDir()
	rollout(t, root, "2026/09/27", "2026-09-27T23-00-00", "01a0-old", "/home/u/repo")
	rollout(t, root, "2026/09/28", "2026-09-28T10-00-00", "01a0-morning", "/home/u/repo")
	// A name that ends in the id but whose first line is another session.
	rollout(t, root, "2026/09/28", "2026-09-28T11-00-00", "01a0-other", "/home/u/repo")
	if err := os.Rename(filepath.Join(root, "2026/09/28/rollout-2026-09-28T11-00-00-01a0-other.jsonl"),
		filepath.Join(root, "2026/09/28/rollout-2026-09-28T11-00-00-01a0-old.jsonl")); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]string{
		"01a0-morning": "2026/09/28/rollout-2026-09-28T10-00-00-01a0-morning.jsonl",
		"01a0-old":     "2026/09/27/rollout-2026-09-27T23-00-00-01a0-old.jsonl",
		"01a0-none":    "",
		"../x":         "",
	} {
		got, err := FindRollout(root, id)
		if want != "" {
			want = filepath.Join(root, filepath.FromSlash(want))
		}
		if err != nil || got != want {
			t.Errorf("FindRollout(%q) = %q, %v; want %q", id, got, err, want)
		}
	}
}
