package usage

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// recKids records what a Session sends a Children.
type recKids struct {
	ev   []string
	want bool
}

func (r *recKids) Main(_ int64, b []byte)             { r.ev = append(r.ev, "main "+string(b)) }
func (r *recKids) Child(id string, _ int64, b []byte) { r.ev = append(r.ev, "child "+id+" "+string(b)) }
func (r *recKids) Meta(id string, b []byte, _ time.Time) {
	r.ev = append(r.ev, "meta "+id+" "+string(b))
}
func (r *recKids) Gone(id string)   { r.ev = append(r.ev, "gone "+id) }
func (r *recKids) Reset()           { r.ev = append(r.ev, "reset") }
func (r *recKids) WantList() bool   { return r.want }
func (r *recKids) Polled(time.Time) { r.ev = append(r.ev, "polled") }
func (r *recKids) take() []string   { ev := r.ev; r.ev = nil; return ev }

// #23: a Claude session sends its children's evidence from the same reads:
// main lines, then each subagent's lines and its meta file (when it
// changed: Claude renames a new one over it), Gone when a file goes, Reset
// when everything is read again, Polled at the end of every Poll; and lists
// the subagents directory early when asked (a call whose file is not seen).
func TestChildren(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "p", claudeID+".jsonl")
	sub := filepath.Join(dir, "p", claudeID, "subagents")
	writeFile(t, path, "m1\n")
	writeFile(t, filepath.Join(sub, "agent-a1.jsonl"), "c1\n")
	writeFile(t, filepath.Join(sub, "agent-a1.meta.json"), `{"toolUseId":"t1"}`)
	s := NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing())
	k := &recKids{}
	s.SetChildren(k)
	s.Poll(t0)
	if got, want := k.take(), []string{"main m1", "child a1 c1", `meta a1 {"toolUseId":"t1"}`, "polled"}; !slices.Equal(got, want) {
		t.Fatalf("first poll %q, want %q", got, want)
	}
	s.Poll(t0.Add(time.Second)) // nothing new: the meta is not sent again
	if got := k.take(); !slices.Equal(got, []string{"polled"}) {
		t.Fatalf("quiet poll %q", got)
	}
	// A new child within SubagentRescan: listed only when asked.
	writeFile(t, filepath.Join(sub, "agent-a2.jsonl"), "c2\n")
	appendFile(t, path, "m2\n")
	s.Poll(t0.Add(2 * time.Second))
	if got := k.take(); slices.ContainsFunc(got, func(e string) bool { return strings.HasPrefix(e, "child a2") }) {
		t.Fatalf("listed unasked: %q", got)
	}
	k.want = true
	s.Poll(t0.Add(3 * time.Second))
	if got := k.take(); !slices.Contains(got, "child a2 c2") {
		t.Fatalf("not listed when asked: %q", got)
	}
	k.want = false
	// The meta replaced (a new file renamed over it): sent again.
	tmp := filepath.Join(sub, "agent-a1.meta.json.tmp")
	writeFile(t, tmp, `{"toolUseId":"t1","finished":true}`)
	if err := os.Rename(tmp, filepath.Join(sub, "agent-a1.meta.json")); err != nil {
		t.Fatal(err)
	}
	s.Poll(t0.Add(4 * time.Second))
	if got := k.take(); !slices.Contains(got, `meta a1 {"toolUseId":"t1","finished":true}`) {
		t.Fatalf("meta not re-sent: %q", got)
	}
	// A child's file goes (cleaned up).
	if err := os.Remove(filepath.Join(sub, "agent-a2.jsonl")); err != nil {
		t.Fatal(err)
	}
	s.Poll(t0.Add(5 * time.Second))
	if got := k.take(); !slices.Contains(got, "gone a2") {
		t.Fatalf("gone not sent: %q", got)
	}
	// The main transcript replaced: Reset, then everything again, metas too.
	writeFile(t, path, "m3\n")
	s.Poll(t0.Add(6 * time.Second))
	got := k.take()
	if i := slices.Index(got, "reset"); i < 0 || !slices.Contains(got[i:], "main m3") || !slices.Contains(got[i:], "child a1 c1") ||
		!slices.Contains(got[i:], `meta a1 {"toolUseId":"t1","finished":true}`) || got[len(got)-1] != "polled" {
		t.Fatalf("after replacement %q", got)
	}
}

// #26: a watched child's transcript is read by the session's own tail of it
// (one reader per file): Child says where its next line starts, its tap gets
// the lines read from then on, and is told when they are void (the file
// went, or every file is read again). A watched child not seen yet is looked
// for in every poll, not every SubagentRescan.
func TestChildTap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "p", claudeID+".jsonl")
	sub := filepath.Join(dir, "p", claudeID, "subagents")
	writeFile(t, path, "m1\n")
	s := NewSession(Claude, claudeID, Roots{ClaudeProjects: dir}, DefaultPricing())
	s.Poll(t0)
	s.WantChildren([]string{"a1"})
	if _, ok := s.Child("a1"); ok {
		t.Fatal("a child with no file")
	}
	writeFile(t, filepath.Join(sub, "agent-a1.jsonl"), "c1\n")
	writeFile(t, filepath.Join(sub, "agent-a9.jsonl"), "z1\n") // not watched: listed with it, never tapped
	s.Poll(t0.Add(time.Second))                                // within SubagentRescan: listed for the watched one
	f, ok := s.Child("a1")
	if !ok || f.Path != filepath.Join(sub, "agent-a1.jsonl") || f.File == nil || f.Next != 3 || f.HistoryStart != 0 {
		t.Fatalf("child = %+v %v", f, ok)
	}
	if _, ok := s.Child("../../p/" + claudeID); ok {
		t.Fatal("a path outside the subagents read as a child")
	}
	tap := &recTap{}
	s.SetChildTap("a1", tap)
	appendFile(t, filepath.Join(sub, "agent-a1.jsonl"), "c2\n")
	appendFile(t, filepath.Join(sub, "agent-a9.jsonl"), "z2\n")
	s.Poll(t0.Add(2 * time.Second))
	if !slices.Equal(tap.lines, []string{"c2"}) || tap.offs[0] != 3 || len(tap.void) != 0 {
		t.Fatalf("tap = %+v", tap)
	}
	// The main transcript replaced: every file is read again, so the tap's lines are void.
	writeFile(t, path, "m\n") // shorter: truncated
	s.Poll(t0.Add(3 * time.Second))
	if !slices.Equal(tap.void, []bool{false}) || len(tap.lines) != 1 {
		t.Fatalf("after replacement: %+v", tap)
	}
	// A new tap; the child's file goes: void, gone.
	tap2 := &recTap{}
	s.SetChildTap("a1", tap2)
	if err := os.Remove(filepath.Join(sub, "agent-a1.jsonl")); err != nil {
		t.Fatal(err)
	}
	s.Poll(t0.Add(4 * time.Second))
	if !slices.Equal(tap2.void, []bool{true}) {
		t.Fatalf("gone: %+v", tap2)
	}
	if _, ok := s.Child("a1"); ok {
		t.Fatal("a gone child still read")
	}
	// Not watched any more: its tap is dropped.
	writeFile(t, filepath.Join(sub, "agent-a1.jsonl"), "c1\n")
	s.Poll(t0.Add(5 * time.Second))
	tap3 := &recTap{}
	s.SetChildTap("a1", tap3)
	s.WantChildren(nil)
	appendFile(t, filepath.Join(sub, "agent-a1.jsonl"), "c2\n")
	s.Poll(t0.Add(6 * time.Second))
	if len(tap3.lines) != 0 {
		t.Fatalf("an unwatched child's tap got %q", tap3.lines)
	}
}

// #26: a Codex session with no Children reads only its watched children's
// rollouts, found by their first line (a child of this session), with the
// history start their copied parent records end at.
func TestChildTapCodex(t *testing.T) {
	const child = "33333333-3333-4333-8333-333333333333"
	const other = "44444444-4444-4444-8444-444444444444"
	dir := t.TempDir()
	day := filepath.Join(dir, "2026", "09", "29")
	writeFile(t, filepath.Join(day, "rollout-2026-09-29T00-00-00-"+codexID+".jsonl"), `{"type":"session_meta","payload":{"id":"`+codexID+`","cwd":"/w"}}`+"\n")
	meta := func(id string) string {
		return `{"type":"session_meta","payload":{"id":"` + id + `","session_id":"` + codexID + `","cwd":"/w","thread_source":"subagent",` +
			`"subagent_history_start_ordinal":5,"source":{"subagent":{"thread_spawn":{"parent_thread_id":"` + codexID + `","depth":1}}}}}` + "\n"
	}
	s := NewSession(Codex, codexID, Roots{CodexSessions: dir}, DefaultPricing())
	s.Poll(t0)
	s.WantChildren([]string{child})
	writeFile(t, filepath.Join(day, "rollout-2026-09-29T00-00-01-"+child+".jsonl"), meta(child))
	writeFile(t, filepath.Join(day, "rollout-2026-09-29T00-00-02-"+other+".jsonl"), meta(other))
	s.Poll(t0.Add(time.Second))
	f, ok := s.Child(child)
	if !ok || f.HistoryStart != 5 || f.Next != int64(len(meta(child))) {
		t.Fatalf("child = %+v %v", f, ok)
	}
	if _, ok := s.Child(other); ok {
		t.Fatal("an unwatched child read without Children")
	}
	tap := &recTap{}
	s.SetChildTap(child, tap)
	appendFile(t, f.Path, `{"type":"event_msg"}`+"\n")
	s.Poll(t0.Add(2 * time.Second))
	if !slices.Equal(tap.lines, []string{`{"type":"event_msg"}`}) {
		t.Fatalf("tap = %+v", tap)
	}
}
