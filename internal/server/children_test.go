package server_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents/childagentstest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #22: the child-agent fixtures (internal/childagents/testdata), played
// through the hub end to end: a fixture source's evidence and herdr's
// observations of the workers' sessions → the registry → the frames a
// client gets (a snapshot, then every event in seq order). Applied, they
// make each fixture's trees, and so does a fresh client's snapshot. The
// frames are game/fixtures/children-<name>.jsonl, which Vitest feeds
// through the game's decoder and store (src/world/children.frames.test.ts)
// and the fixture bridge plays (`?ws=/fixture/children-<name>`).
// H3D_UPDATE_FIXTURES=1 writes them.

const childFloor = "office"

var childClock = time.UnixMilli(1792000000000)

// childRun is one fixture played on a bridge.
type childRun struct {
	t       *testing.T
	b       *bridge
	src     *childagentstest.FixtureSource
	c       *client
	workers []world.WorkerObs // the floor's workers as herdr shows them now
	frames  [][]byte          // what c got: the snapshot, then every event
}

func startChildRun(t *testing.T, db string, src *childagentstest.FixtureSource, workers []childagentstest.ScriptWorker) *childRun {
	t.Helper()
	r := &childRun{t: t, src: src}
	r.b = startBridge(t, db, server.Options{Now: func() time.Time { return childClock }, ChildSources: []childagents.Source{src}})
	sync := r.b.connect(proto.Hello{})
	sync.snapshot()
	for _, w := range workers {
		r.workers = append(r.workers, worker(w.Name, w.Name, w.AgentSession, "working"))
	}
	r.b.floor(childFloor, true, r.workers...)
	for range workers {
		sync.until(proto.EvWorkerUpsert)
	}
	src.Wait() // the replays of the sessions bound
	r.c = r.b.connect(proto.Hello{})
	m := r.c.next()
	if m.env.T != proto.TSnapshot {
		t.Fatalf("expected world.snapshot, got %s", m.raw)
	}
	r.c.seq = m.env.Seq
	r.frames = append(r.frames, m.raw)
	return r
}

// read records c's frames until one is ok.
func (r *childRun) read(ok func(proto.Event) bool) {
	r.t.Helper()
	for {
		m := r.c.next()
		var ev proto.Event
		if err := json.Unmarshal(m.raw, &ev); err != nil {
			r.t.Fatal(err)
		}
		if ev.T == proto.EvFloorUpsert && ev.Floor.Session == "zz-marker" {
			return
		}
		r.frames = append(r.frames, m.raw)
		if ok(ev) {
			return
		}
	}
}

func (r *childRun) play(steps []childagentstest.Step) {
	r.t.Helper()
	for _, st := range steps {
		switch {
		case st.Evidence != nil:
			r.src.Emit(*st.Evidence) // returns once the hub applied it
		case st.Session != nil:
			for i := range r.workers {
				if r.workers[i].WorkspaceID == st.Session.Name {
					r.workers[i].AgentSession = st.Session.AgentSession
				}
			}
			r.b.floor(childFloor, true, r.workers...)
			r.read(func(ev proto.Event) bool {
				return ev.T == proto.EvWorkerUpsert && ev.Worker.WorkspaceID == st.Session.Name
			})
			r.src.Wait()
		case st.RemoveWorker != "":
			r.workers = slices.DeleteFunc(r.workers, func(w world.WorkerObs) bool { return w.WorkspaceID == st.RemoveWorker })
			r.b.floor(childFloor, true, r.workers...)
			r.read(func(ev proto.Event) bool { return ev.T == proto.EvWorkerRemoved && ev.WorkspaceID == st.RemoveWorker })
		}
	}
	// Everything emitted so far, up to a marker.
	r.b.floor("zz-marker", false)
	r.read(func(proto.Event) bool { return false })
}

// childView is what a client makes of the frames: the workers' child
// generations and their children, by workspace id.
type childView struct {
	gens     map[string]uint64                 // worker id → child_generation
	ws       map[string]string                 // worker id → workspace id
	children map[string]map[string]proto.Child // worker id → row id → child
}

func newChildView(s proto.Snapshot) *childView {
	v := &childView{gens: map[string]uint64{}, ws: map[string]string{}, children: map[string]map[string]proto.Child{}}
	for _, w := range s.World.Workers {
		v.gens[w.ID], v.ws[w.ID] = w.ChildGeneration, w.WorkspaceID
	}
	for _, c := range s.World.Children {
		v.upsert(c)
	}
	return v
}

func (v *childView) upsert(c proto.Child) {
	if c.Generation < v.gens[c.WorkerID] {
		return // an older generation's
	}
	if c.Generation > v.gens[c.WorkerID] {
		v.gens[c.WorkerID], v.children[c.WorkerID] = c.Generation, nil
	}
	if v.children[c.WorkerID] == nil {
		v.children[c.WorkerID] = map[string]proto.Child{}
	}
	v.children[c.WorkerID][c.ID] = c
}

func (v *childView) apply(ev proto.Event) {
	switch ev.T {
	case proto.EvWorkerUpsert:
		w := ev.Worker
		v.ws[w.ID] = w.WorkspaceID
		if w.ChildGeneration > v.gens[w.ID] {
			v.gens[w.ID], v.children[w.ID] = w.ChildGeneration, nil
		}
	case proto.EvWorkerRemoved:
		delete(v.gens, ev.ID)
		delete(v.children, ev.ID)
	case proto.EvChildUpsert:
		v.upsert(*ev.Child)
	case proto.EvChildRemoved:
		if ev.Generation == v.gens[ev.WorkerID] {
			delete(v.children[ev.WorkerID], ev.ID)
		}
	}
}

func (v *childView) tree(t *testing.T, ws string) string {
	t.Helper()
	var list []proto.Child
	for id, cs := range v.children {
		if v.ws[id] != ws {
			continue
		}
		for _, c := range cs {
			if c.Generation != v.gens[id] {
				t.Errorf("%s: %s of generation %d, worker's %d", ws, c.ID, c.Generation, v.gens[id])
			}
			list = append(list, c)
		}
	}
	return treeJSON(t, childagentstest.Tree(list))
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

func childScripts(t *testing.T) map[string]*childagentstest.Script {
	t.Helper()
	all, err := childagentstest.Scripts(filepath.Join("..", "childagents", "testdata"))
	if err != nil || len(all) == 0 {
		t.Fatalf("fixtures: %v (%d)", err, len(all))
	}
	return all
}

func TestChildFixturesEndToEnd(t *testing.T) {
	update := os.Getenv("H3D_UPDATE_FIXTURES") == "1"
	for name, s := range childScripts(t) {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			r := startChildRun(t, "", childagentstest.NewFixtureSource(), s.Workers)
			r.play(s.Steps)

			var snap proto.Snapshot
			if err := json.Unmarshal(r.frames[0], &snap); err != nil {
				t.Fatal(err)
			}
			if len(snap.World.Workers) != len(s.Workers) || snap.World.Children == nil {
				t.Fatalf("snapshot = %s", r.frames[0])
			}
			v := newChildView(snap)
			for _, raw := range r.frames[1:] {
				var ev proto.Event
				_ = json.Unmarshal(raw, &ev)
				v.apply(ev)
			}
			// A client that comes now gets the same from its snapshot alone.
			fresh := newChildView(r.b.connect(proto.Hello{}).snapshot())
			for ws, want := range s.Expect {
				e := treeJSON(t, want)
				if g := v.tree(t, ws); g != e {
					t.Errorf("%s: frames make\n%s\nwant\n%s", ws, g, e)
				}
				if g := fresh.tree(t, ws); g != e {
					t.Errorf("%s: a fresh snapshot has\n%s\nwant\n%s", ws, g, e)
				}
			}

			b := normalizeFrames(r.frames)
			path := filepath.Join("..", "..", "game", "fixtures", "children-"+name+".jsonl")
			if update {
				if err := os.WriteFile(path, b, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			old, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%v (H3D_UPDATE_FIXTURES=1 go test ./internal/server -run TestChildFixtures writes it)", err)
			}
			if !bytes.Equal(old, b) {
				t.Errorf("%s is not what the bridge sends now: H3D_UPDATE_FIXTURES=1 go test ./internal/server -run TestChildFixtures, then check the game's tests", path)
			}
		})
	}
}

var (
	uuidRE   = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	rowIDRE  = regexp.MustCompile(`"ch_[0-9a-f]{16}"`)
	presetRE = regexp.MustCompile(`"p_[0-9a-f]{12}"`)
	// A worker's name (Worker.Name comes right before DeskIndex; a child's
	// name never does).
	nameRE     = regexp.MustCompile(`"name":"[^"]*","desk_index":`)
	fixedNames = []string{"Nibble", "Pixel", "Mochi", "Flicker"}
)

// normalizeFrames makes the frames the same on every run, in order of
// appearance: the worker ids (random UUIDs), the row ids and the worker
// names (both made from them) and the seeded presets' ids.
func normalizeFrames(frames [][]byte) []byte {
	all := bytes.Join(frames, []byte("\n"))
	renumber := func(re *regexp.Regexp, as func(n int) string) {
		seen := map[string]string{}
		all = re.ReplaceAllFunc(all, func(b []byte) []byte {
			if _, ok := seen[string(b)]; !ok {
				seen[string(b)] = as(len(seen))
			}
			return []byte(seen[string(b)])
		})
	}
	renumber(uuidRE, func(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n+1) })
	renumber(rowIDRE, func(n int) string { return fmt.Sprintf(`"ch_%016x"`, n+1) })
	renumber(presetRE, func(n int) string { return fmt.Sprintf(`"p_%012x"`, n+1) })
	renumber(nameRE, func(n int) string { return fmt.Sprintf(`"name":%q,"desk_index":`, fixedNames[n%len(fixedNames)]) })
	return append(all, '\n')
}

// Nothing is persisted: a restarted bridge (same database) is rebuilt by
// its source's replays of the sessions it binds, to the same trees; with a
// source that finds nothing, it has no children at all.
func TestChildAgentsRebuiltAfterRestart(t *testing.T) {
	for _, name := range []string{"provisional", "replaced", "nested"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			s := childScripts(t)[name]
			db := filepath.Join(t.TempDir(), "world.db")
			first := startChildRun(t, db, childagentstest.NewFixtureSource(), s.Workers)
			first.play(s.Steps)
			final := slices.Clone(first.workers)
			seen := first.src.Seen()
			first.b.stop()

			var sessions []childagentstest.ScriptWorker
			for _, w := range final {
				sessions = append(sessions, childagentstest.ScriptWorker{Name: w.WorkspaceID, AgentSession: w.AgentSession})
			}
			again := startChildRun(t, db, childagentstest.NewFixtureSource(seen...), sessions)
			var snap proto.Snapshot
			_ = json.Unmarshal(again.frames[0], &snap)
			v := newChildView(snap)
			for ws, want := range s.Expect {
				if g, e := v.tree(t, ws), treeJSON(t, want); g != e {
					t.Errorf("%s: rebuilt\n%s\nwant\n%s", ws, g, e)
				}
			}
			again.b.stop()

			empty := startChildRun(t, db, childagentstest.NewFixtureSource(), sessions)
			_ = json.Unmarshal(empty.frames[0], &snap)
			if len(snap.World.Children) != 0 {
				t.Fatalf("children without evidence: %+v", snap.World.Children)
			}
		})
	}
}

// Evidence of a session no worker has yet is dropped; once a worker shows
// with it, the source's replay brings it, after the worker.upsert.
func TestChildEvidenceReplayedOnBind(t *testing.T) {
	t.Parallel()
	src := childagentstest.NewFixtureSource()
	r := startChildRun(t, "", src, []childagentstest.ScriptWorker{{Name: "w1", AgentSession: "sess-1"}})
	src.Emit(childagents.Evidence{Session: "sess-2", Provider: proto.ChildClaude, NativeID: "a1", State: proto.ChildRunning, Source: proto.ChildFromHook})
	r.workers = append(r.workers, worker("w2", "w2", "sess-2", "working"))
	r.b.floor(childFloor, true, r.workers...)
	up := r.c.until(proto.EvWorkerUpsert)
	src.Wait()
	ev := r.c.event()
	if up.Worker.WorkspaceID != "w2" || ev.T != proto.EvChildUpsert || ev.Child.WorkerID != up.Worker.ID || ev.Child.NativeID != "a1" ||
		ev.Child.Generation != up.Worker.ChildGeneration || ev.Child.AgentSession != "sess-2" || up.Worker.ChildGeneration == 0 {
		t.Fatalf("worker %+v, then %+v", up.Worker, ev)
	}
}
