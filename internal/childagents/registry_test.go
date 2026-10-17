package childagents_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents/childagentstest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

func scripts(t *testing.T) map[string]*childagentstest.Script {
	t.Helper()
	all, err := childagentstest.Scripts("testdata")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) == 0 {
		t.Fatal("no fixtures")
	}
	return all
}

func treeJSON(t *testing.T, n []childagentstest.Node) string {
	t.Helper()
	if n == nil {
		n = []childagentstest.Node{}
	}
	b, err := json.MarshalIndent(n, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Every fixture, played against a registry, ends with its expected trees,
// and every child carries its worker's current generation and session.
func TestScripts(t *testing.T) {
	for name, s := range scripts(t) {
		t.Run(name, func(t *testing.T) {
			r := childagents.New()
			childagentstest.Play(s, r)
			for w, want := range s.Expect {
				got := r.Children(w)
				if g, e := treeJSON(t, childagentstest.Tree(got)), treeJSON(t, want); g != e {
					t.Errorf("%s: tree\n%s\nwant\n%s", w, g, e)
				}
				for _, c := range got {
					if c.Generation != r.Generation(w) || c.WorkerID != w {
						t.Errorf("%s: %s has generation %d of %s, worker's is %d", w, c.ID, c.Generation, c.WorkerID, r.Generation(w))
					}
				}
			}
		})
	}
}

// Nothing is persisted: after a restart a fresh registry, bound to the same
// root sessions, is rebuilt by the sources' replays alone, into the same
// graph (row ids aside: see Node).
func TestFreshRegistryRebuildsFromReplay(t *testing.T) {
	for name, s := range scripts(t) {
		t.Run(name, func(t *testing.T) {
			before := childagents.New()
			childagentstest.Play(s, before)
			var seen []childagents.Evidence
			sessions := map[string]string{}
			for _, w := range s.Workers {
				sessions[w.Name] = w.AgentSession
			}
			for _, st := range s.Steps {
				switch {
				case st.Evidence != nil:
					seen = append(seen, *st.Evidence)
				case st.Session != nil:
					sessions[st.Session.Name] = st.Session.AgentSession
				case st.RemoveWorker != "":
					delete(sessions, st.RemoveWorker)
				}
			}

			// The restarted bridge: an empty registry, a source that finds what
			// the provider kept, the workers seen again.
			after := childagents.New()
			src := childagentstest.NewFixtureSource(seen...)
			var mu sync.Mutex
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			go func() {
				_ = src.Run(ctx, func(e childagents.Evidence) {
					mu.Lock()
					defer mu.Unlock()
					_, _ = after.Apply(e)
				})
				close(done)
			}()
			for _, w := range s.Workers {
				sess, ok := sessions[w.Name]
				if !ok {
					continue
				}
				mu.Lock()
				_, bound := after.Worker(w.Name, sess)
				mu.Unlock()
				if bound {
					src.Replay(sess)
				}
			}
			src.Wait()
			cancel()
			<-done
			for w := range s.Expect {
				if g, e := treeJSON(t, childagentstest.Tree(after.Children(w))), treeJSON(t, childagentstest.Tree(before.Children(w))); g != e {
					t.Errorf("%s: rebuilt\n%s\nwant\n%s", w, g, e)
				}
			}
		})
	}
}

func apply(t *testing.T, r *childagents.Registry, e childagents.Evidence) []proto.Event {
	t.Helper()
	evs, err := r.Apply(e)
	if err != nil {
		t.Fatalf("apply %+v: %v", e, err)
	}
	return evs
}

func kinds(evs []proto.Event) string {
	s := ""
	for _, e := range evs {
		id := e.ID
		if e.Child != nil {
			id = e.Child.ID
		}
		s += fmt.Sprintf("%s:%s ", e.T, id)
	}
	return s
}

// A provisional row (its dispatch only) keeps its row id when the native id
// arrives, and evidence by either id is that row: upserts only, never a
// removal or a second row.
func TestProvisionalReconciledToNative(t *testing.T) {
	r := childagents.New()
	r.Worker("w", "s")
	evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "toolu_1", State: proto.ChildRunning, Source: "transcript"})
	if len(evs) != 1 || evs[0].T != proto.EvChildUpsert || evs[0].Child.NativeID != "" {
		t.Fatalf("dispatch: %+v", evs)
	}
	id := evs[0].Child.ID
	steps := []childagents.Evidence{
		{Session: "s", Provider: proto.ChildClaude, DispatchID: "toolu_1", NativeID: "a1", Source: "transcript"},
		{Session: "s", Provider: proto.ChildClaude, NativeID: "a1", State: proto.ChildCompleted, Source: "hook"},
		{Session: "s", Provider: proto.ChildClaude, DispatchID: "toolu_1", Transcript: proto.TranscriptAvailable, Source: "transcript"},
	}
	for i, e := range steps {
		evs := apply(t, r, e)
		if len(evs) != 1 || evs[0].T != proto.EvChildUpsert || evs[0].Child.ID != id || evs[0].Child.NativeID != "a1" {
			t.Fatalf("step %d: %s %+v", i, kinds(evs), evs)
		}
	}
	if cs := r.Children("w"); len(cs) != 1 || cs[0].ID != id || cs[0].State != proto.ChildCompleted || cs[0].Transcript != proto.TranscriptAvailable {
		t.Fatalf("children = %+v", cs)
	}
	// The same evidence again changes nothing: no event.
	if evs := apply(t, r, steps[1]); len(evs) != 0 {
		t.Fatalf("repeat: %s", kinds(evs))
	}
	// A dispatch already named cannot be another child.
	if _, err := r.Apply(childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "toolu_1", NativeID: "a2", Source: "x"}); !errors.Is(err, childagents.ErrConflict) {
		t.Fatalf("conflict: %v", err)
	}
}

// A native row seen before its dispatch was linked to it merges into the
// provisional row seen first: that row stays, the other is removed (before
// the upsert), and the merged row's children follow it.
func TestMergeKeepsTheRowSeenFirst(t *testing.T) {
	r := childagents.New()
	r.Worker("w", "s")
	prov := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", Parent: &childagents.ParentRef{Kind: proto.ParentRoot}, Source: "transcript"})[0].Child.ID
	nat := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "a", State: proto.ChildRunning, Source: "hook"})[0].Child.ID
	kid := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "k", Parent: &childagents.ParentRef{Kind: proto.ParentChild, NativeID: "a"}, Source: "hook"})[0].Child
	if kid.ParentID != nat {
		t.Fatalf("kid parent = %+v", kid)
	}
	evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", NativeID: "a", Source: "transcript"})
	if got, want := kinds(evs), fmt.Sprintf("child.removed:%s child.upsert:%s child.upsert:%s ", nat, prov, kid.ID); got != want {
		t.Fatalf("events %s, want %s", got, want)
	}
	if evs[0].WorkerID != "w" || evs[0].Generation != r.Generation("w") {
		t.Fatalf("removal = %+v", evs[0])
	}
	if evs[1].Child.NativeID != "a" || evs[1].Child.Parent != proto.ParentRoot || evs[2].Child.ParentID != prov {
		t.Fatalf("merged = %+v, kid %+v", evs[1].Child, evs[2].Child)
	}
	if cs := r.Children("w"); len(cs) != 2 {
		t.Fatalf("children = %+v", cs)
	}
}

// A merge keeps every field either row observed: a field one row has is
// kept, a last-wins field both have takes the one observed later (the state
// with its source), started_at the earliest, last_activity_at the latest.
func TestMergeKeepsEveryObservedField(t *testing.T) {
	t.Run("only the merged row has them", func(t *testing.T) {
		r := childagents.New()
		r.Worker("w", "s")
		d := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", Source: "transcript"})[0].Child.ID
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "a", State: proto.ChildRunning, Source: "hook",
			Name: "Ada", StartedAt: 10, LastActivityAt: 20, Transcript: proto.TranscriptAvailable})
		evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", NativeID: "a", Source: "transcript"})
		want := proto.Child{ID: d, NativeID: "a", Provider: proto.ChildClaude, WorkerID: "w", AgentSession: "s", Generation: r.Generation("w"),
			Parent: proto.ParentUnresolved, Name: "Ada", State: proto.ChildRunning, Source: "hook", StartedAt: 10, LastActivityAt: 20,
			Transcript: proto.TranscriptAvailable}
		if len(evs) != 2 || evs[1].Child == nil || *evs[1].Child != want {
			t.Fatalf("events %s\n%+v\nwant upsert of %+v", kinds(evs), evs, want)
		}
		if cs := r.Children("w"); len(cs) != 1 || cs[0] != want {
			t.Fatalf("children = %+v", cs)
		}
	})
	t.Run("both rows have them", func(t *testing.T) {
		r := childagents.New()
		r.Worker("w", "s")
		// The provisional row: completed (older), its type and description.
		d := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, DispatchID: "d", State: proto.ChildCompleted, Source: "rollout",
			Type: "worker", Description: "first", StartedAt: 30, LastActivityAt: 40, EndedAt: 45, Transcript: proto.TranscriptPending})[0].Child.ID
		// The native row: running again (newer: clears the end), a newer
		// description, no type, an earlier start, an earlier activity.
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "a", State: proto.ChildRunning, Source: "app_server",
			Name: "Ada", Description: "second", StartedAt: 25, LastActivityAt: 35})
		// Then the provisional row's transcript, newer than nothing.
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, DispatchID: "d", Source: "rollout", Transcript: proto.TranscriptAvailable})
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, DispatchID: "d", NativeID: "a", Source: "rollout"})
		want := proto.Child{ID: d, NativeID: "a", Provider: proto.ChildCodex, WorkerID: "w", AgentSession: "s", Generation: r.Generation("w"),
			Parent: proto.ParentUnresolved, Name: "Ada", Type: "worker", Description: "second", State: proto.ChildRunning, Source: "app_server",
			StartedAt: 25, LastActivityAt: 40, Transcript: proto.TranscriptAvailable}
		if cs := r.Children("w"); len(cs) != 1 || cs[0] != want {
			t.Fatalf("children = %+v\nwant %+v", cs, want)
		}
	})
	t.Run("the row kept observed later", func(t *testing.T) {
		r := childagents.New()
		r.Worker("w", "s")
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", Source: "transcript"})
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "a", State: proto.ChildRunning, Source: "hook", Name: "Old"})
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", State: proto.ChildInterrupted, Source: "transcript", Name: "New", EndedAt: 50})
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, DispatchID: "d", NativeID: "a", Source: "transcript"})
		if cs := r.Children("w"); len(cs) != 1 || cs[0].State != proto.ChildInterrupted || cs[0].Source != "transcript" || cs[0].Name != "New" || cs[0].EndedAt != 50 {
			t.Fatalf("children = %+v", cs)
		}
	})
}

// Generations: one bridge-wide counter, so a worker's only rises (also
// after it left and came back). A replaced session (X→Y, X→none) drops the
// children and the old session's evidence; a first session (none→X) is no
// replacement.
func TestGenerations(t *testing.T) {
	r := childagents.New()
	g1, bound := r.Worker("w", "")
	if g1 == 0 || bound {
		t.Fatalf("first sight without a session: %d %v", g1, bound)
	}
	if g, bound := r.Worker("w", "s1"); g != g1 || !bound {
		t.Fatalf("first session: %d %v, want %d bound", g, bound, g1)
	}
	if g, bound := r.Worker("w", "s1"); g != g1 || bound {
		t.Fatalf("same session: %d %v", g, bound)
	}
	other, _ := r.Worker("v", "sv")
	apply(t, r, childagents.Evidence{Session: "s1", Provider: proto.ChildClaude, NativeID: "a", Source: "hook"})
	g2, bound := r.Worker("w", "s2")
	if g2 <= g1 || g2 <= other || !bound || len(r.Children("w")) != 0 {
		t.Fatalf("replaced: %d (was %d, v %d) %v %+v", g2, g1, other, bound, r.Children("w"))
	}
	if _, err := r.Apply(childagents.Evidence{Session: "s1", Provider: proto.ChildClaude, NativeID: "a", Source: "hook"}); !errors.Is(err, childagents.ErrUnbound) {
		t.Fatalf("old session's evidence: %v", err)
	}
	apply(t, r, childagents.Evidence{Session: "s2", Provider: proto.ChildClaude, NativeID: "b", Source: "hook"})
	g3, bound := r.Worker("w", "")
	if g3 <= g2 || bound || len(r.Children("w")) != 0 {
		t.Fatalf("session gone: %d %v", g3, bound)
	}
	r.Remove("w")
	if r.Generation("w") != 0 || r.Children("w") != nil {
		t.Fatal("removed worker still known")
	}
	if g, _ := r.Worker("w", "s2"); g <= g3 {
		t.Fatalf("back: %d, want > %d", g, g3)
	}
	// A session another worker holds is not bound twice.
	if _, bound := r.Worker("x", "sv"); bound {
		t.Fatal("bound a session another worker holds")
	}
	if evs := apply(t, r, childagents.Evidence{Session: "sv", Provider: proto.ChildCodex, NativeID: "t", Source: "rollout"}); evs[0].Child.WorkerID != "v" {
		t.Fatalf("evidence of sv went to %s", evs[0].Child.WorkerID)
	}
	if _, bound := r.Worker("x", "sv"); bound {
		t.Fatal("bound on a refresh while the other still holds it")
	}
	// Once that worker lets go, the next refresh binds it (and asks for its replay).
	r.Remove("v")
	if _, bound := r.Worker("x", "sv"); !bound {
		t.Fatal("not bound after the holder left")
	}
	if _, bound := r.Worker("x", "sv"); bound {
		t.Fatal("bound twice")
	}
	if evs := apply(t, r, childagents.Evidence{Session: "sv", Provider: proto.ChildCodex, NativeID: "t", Source: "rollout"}); evs[0].Child.WorkerID != "x" ||
		evs[0].Child.Generation != r.Generation("x") {
		t.Fatalf("evidence of sv after the handover: %+v", evs[0].Child)
	}
}

// A new child has no guessed parent, state or transcript.
func TestDefaultsAreUnknown(t *testing.T) {
	r := childagents.New()
	r.Worker("w", "s")
	c := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "t", Source: "rollout"})[0].Child
	if c.Parent != proto.ParentUnresolved || c.ParentID != "" || c.State != proto.ChildUnknown || c.Transcript != proto.TranscriptUnavailable ||
		c.Source != "rollout" || c.AgentSession != "s" {
		t.Fatalf("new child = %+v", c)
	}
	b, _ := json.Marshal(c)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["parent"] != "unresolved" || m["state"] != "unknown" || m["transcript"] != "unavailable" {
		t.Fatalf("wire = %s", b)
	}
	// Evidence saying nothing more keeps it so.
	if evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "t", Source: "rollout"}); len(evs) != 0 {
		t.Fatalf("no-op evidence made %s", kinds(evs))
	}
}

// A removed parent leaves its children unresolved, waiting for it; it
// coming back resolves them again. A parent that would make a cycle is
// ignored.
func TestParents(t *testing.T) {
	r := childagents.New()
	r.Worker("w", "s")
	root := &childagents.ParentRef{Kind: proto.ParentRoot}
	under := func(id string) *childagents.ParentRef {
		return &childagents.ParentRef{Kind: proto.ParentChild, NativeID: id}
	}
	a := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "a", Parent: root, Source: "x"})[0].Child.ID
	b := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "b", Parent: under("a"), Source: "x"})[0].Child.ID
	if evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "a", Parent: under("b"), Source: "x"}); len(evs) != 0 {
		t.Fatalf("cycle applied: %s", kinds(evs))
	}
	if evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "a", Parent: under("a"), Source: "x"}); len(evs) != 0 {
		t.Fatalf("self parent applied: %s", kinds(evs))
	}
	evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "a", Removed: true, Source: "x"})
	if got := kinds(evs); got != "child.removed:"+a+" child.upsert:"+b+" " || evs[1].Child.Parent != proto.ParentUnresolved {
		t.Fatalf("removal: %s %+v", got, evs)
	}
	// Back (a new row: the old one was removed), the child under it again,
	// the parent's upsert first.
	evs = apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "a", Parent: root, Source: "x"})
	if len(evs) != 2 || evs[0].Child.NativeID != "a" || evs[1].Child.ID != b || evs[1].Child.ParentID != evs[0].Child.ID {
		t.Fatalf("back: %s %+v", kinds(evs), evs)
	}
	// Removing a child nobody knows is nothing.
	if evs := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildCodex, NativeID: "zz", Removed: true, Source: "x"}); len(evs) != 0 {
		t.Fatalf("unknown removal: %s", kinds(evs))
	}
}

func TestInvalidEvidence(t *testing.T) {
	r := childagents.New()
	r.Worker("w", "s")
	ok := childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "a", Source: "hook"}
	for name, mod := range map[string]func(*childagents.Evidence){
		"no session":       func(e *childagents.Evidence) { e.Session = "" },
		"no source":        func(e *childagents.Evidence) { e.Source = "" },
		"no id":            func(e *childagents.Evidence) { e.NativeID = "" },
		"provider":         func(e *childagents.Evidence) { e.Provider = "gemini" },
		"parent kind":      func(e *childagents.Evidence) { e.Parent = &childagents.ParentRef{Kind: "unresolved"} },
		"parent without":   func(e *childagents.Evidence) { e.Parent = &childagents.ParentRef{Kind: proto.ParentChild} },
		"empty parent ref": func(e *childagents.Evidence) { e.Parent = &childagents.ParentRef{} },
	} {
		e := ok
		mod(&e)
		if _, err := r.Apply(e); !errors.Is(err, childagents.ErrInvalid) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(r.Children("w")) != 0 {
		t.Fatal("invalid evidence made a row")
	}
}

func TestLimits(t *testing.T) {
	r := childagents.New()
	r.Worker("w", "s")
	long := make([]byte, 2000)
	for i := range long {
		long[i] = 'x'
	}
	long[127] = 0xc3 // a rune cut at the byte limit
	c := apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "a", Name: string(long[:126]) + "éé", Description: string(long), Source: "x"})[0].Child
	if len(c.Name) != 128 || len(c.Description) != 1000 {
		t.Fatalf("name %d, description %d bytes", len(c.Name), len(c.Description))
	}
	for i := 1; i < childagents.MaxPerWorker; i++ {
		apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: fmt.Sprint(i), Source: "x"})
	}
	if _, err := r.Apply(childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "one more", Source: "x"}); !errors.Is(err, childagents.ErrFull) {
		t.Fatalf("over the limit: %v", err)
	}
	// Evidence of a known child still applies.
	apply(t, r, childagents.Evidence{Session: "s", Provider: proto.ChildClaude, NativeID: "a", State: proto.ChildIdle, Source: "x"})
}

// The same first observation in the same worker and generation makes the
// same row id; another generation another.
func TestRowIDs(t *testing.T) {
	ids := func(sessions ...string) []string {
		r := childagents.New()
		var out []string
		for _, s := range sessions {
			r.Worker("w", s)
			out = append(out, apply(t, r, childagents.Evidence{Session: s, Provider: proto.ChildClaude, NativeID: "a", Source: "x"})[0].Child.ID)
		}
		return out
	}
	a, b := ids("s1", "s2"), ids("s1", "s2")
	if !reflect.DeepEqual(a, b) || a[0] == a[1] {
		t.Fatalf("ids %v, %v", a, b)
	}
}
