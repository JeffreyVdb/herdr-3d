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
