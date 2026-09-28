package server_test

import (
	"fmt"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// clock is a settable bridge clock.
type clock struct{ ms atomic.Int64 }

func newClock(ms int64) *clock {
	c := &clock{}
	c.ms.Store(ms)
	return c
}

func (c *clock) now() time.Time { return time.UnixMilli(c.ms.Load()) }
func (c *clock) set(ms int64)   { c.ms.Store(ms) }

// world waits until a fresh snapshot satisfies ok and returns it.
func (b *bridge) world(ok func(proto.World) bool) proto.World {
	b.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		w := b.connect(proto.Hello{}).snapshot().World
		if ok(w) {
			return w
		}
		if time.Now().After(deadline) {
			b.t.Fatalf("world never got there: %+v", w)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func workersOf(w proto.World, session string) map[string]proto.Worker {
	m := map[string]proto.Worker{}
	for _, wk := range w.Workers {
		if wk.Session == session {
			m[wk.WorkspaceID] = wk
		}
	}
	return m
}

func floorOf(w proto.World, session string) proto.Floor {
	for _, f := range w.Floors {
		if f.Session == session {
			return f
		}
	}
	return proto.Floor{}
}

func hasWorkers(session string, n int) func(proto.World) bool {
	return func(w proto.World) bool { return len(workersOf(w, session)) == n }
}

// agent is a worker with a stable identity (its agent session).
func agent(ws, status string) world.WorkerObs {
	return worker(ws, "CODE|"+ws, "sess-"+ws, status)
}

func TestDesksAndNamesSurviveRestartAndFreedDesksAreReused(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	b.floor("s", true, agent("a", "idle"), agent("b", "idle"), agent("c", "working"), agent("d", "idle"))
	b.floor("t", true, agent("a", "idle"))
	w := b.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 4 && len(workersOf(w, "t")) == 1 })
	s := workersOf(w, "s")
	for i, ws := range []string{"a", "b", "c", "d"} {
		if s[ws].DeskIndex != i {
			t.Fatalf("%s: desk %d, want %d (sidebar order)", ws, s[ws].DeskIndex, i)
		}
	}
	if d := workersOf(w, "t")["a"].DeskIndex; d != 0 {
		t.Fatalf("desks are per floor: t/a has desk %d", d)
	}
	names := map[string]string{}
	seen := map[string]bool{}
	for ws, wk := range s {
		if wk.Name == "" || seen[wk.Name] {
			t.Fatalf("names must be set and unique per floor: %+v", s)
		}
		seen[wk.Name] = true
		names[ws] = wk.Name
	}

	// b's workspace closes; the next new worker takes the lowest free desk.
	b.floor("s", true, agent("a", "idle"), agent("c", "working"), agent("d", "idle"))
	b.floor("s", true, agent("a", "idle"), agent("c", "working"), agent("d", "idle"), agent("e", "idle"))
	w = b.world(hasWorkers("s", 4))
	if d := workersOf(w, "s")["e"].DeskIndex; d != 1 {
		t.Fatalf("e got desk %d, want the freed desk 1", d)
	}
	names["e"] = workersOf(w, "s")["e"].Name
	b.stop()

	// Restart. herdr restarted too (new workspace ids), c closed while the
	// bridge was down, and f is new: everyone keeps desk and name, and f
	// gets c's desk.
	b2 := startBridge(t, db, server.Options{})
	renamed := func(o world.WorkerObs) world.WorkerObs { o.WorkspaceID = "n" + o.WorkspaceID; return o }
	b2.floor("s", true, renamed(agent("a", "idle")), renamed(agent("d", "idle")), renamed(agent("e", "idle")), agent("f", "idle"))
	w = b2.world(hasWorkers("s", 4))
	after := workersOf(w, "s")
	for ws, desk := range map[string]int{"na": 0, "ne": 1, "f": 2, "nd": 3} {
		if after[ws].DeskIndex != desk {
			t.Errorf("%s: desk %d, want %d", ws, after[ws].DeskIndex, desk)
		}
	}
	for _, ws := range []string{"a", "d", "e"} {
		if got := after["n"+ws].Name; got != names[ws] {
			t.Errorf("%s: name %q after restart, was %q", ws, got, names[ws])
		}
	}
	if f := after["f"].Name; f == "" || f == after["na"].Name || f == after["nd"].Name || f == after["ne"].Name {
		t.Errorf("f's name %q is not unique on the floor", f)
	}

	// Sleeping workers keep their desks; a deleted session frees them.
	b2.floor("s", false, renamed(agent("a", "unknown")), renamed(agent("d", "unknown")), renamed(agent("e", "unknown")), agent("f", "unknown"))
	w = b2.world(func(w proto.World) bool { return floorOf(w, "s").State == world.Asleep })
	if d := workersOf(w, "s")["nd"].DeskIndex; d != 3 {
		t.Fatalf("asleep: d moved to desk %d", d)
	}
	b2.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
	b2.floor("s", true, renamed(agent("d", "idle")))
	w = b2.world(hasWorkers("s", 1))
	if d := workersOf(w, "s")["nd"].DeskIndex; d != 0 {
		t.Fatalf("after the session was deleted, d should start over at desk 0, got %d", d)
	}
}

func TestNamesUniqueOnABigFloor(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	var obs []world.WorkerObs
	for i := range len(world.Names) + 20 {
		obs = append(obs, agent(fmt.Sprintf("w%03d", i), "idle"))
	}
	b.floor("big", true, obs...)
	w := b.world(hasWorkers("big", len(obs)))
	seen := map[string]bool{}
	for _, wk := range w.Workers {
		if seen[wk.Name] {
			t.Fatalf("name %q handed out twice", wk.Name)
		}
		seen[wk.Name] = true
	}
}

// A worker that left keeps its name while it may come back: within the
// name hold a newcomer never gets it, even when that leaves only suffixed
// names, and a bridge restart changes nothing. Past the hold the name is
// free again, and the worker keeps it only if nobody took it.
func TestReturningWorkerKeepsItsName(t *testing.T) {
	const day = int64(24 * time.Hour / time.Millisecond)
	db := filepath.Join(t.TempDir(), "world.db")
	clk := newClock(1_790_000_000_000)
	opts := server.Options{Now: clk.now, NameHold: 7 * 24 * time.Hour}
	b := startBridge(t, db, opts)
	var obs []world.WorkerObs
	for i := range len(world.Names) {
		obs = append(obs, agent(fmt.Sprintf("w%03d", i), "idle"))
	}
	b.floor("s", true, obs...)
	w := b.world(hasWorkers("s", len(obs)))
	names := map[string]string{} // agent session → name
	for _, wk := range workersOf(w, "s") {
		names[wk.AgentSession] = wk.Name
	}
	if len(names) != len(world.Names) {
		t.Fatalf("the floor should hold every base name once: %v", names)
	}
	nameA := names["sess-w000"]
	var others []world.WorkerObs // everyone but A
	with := func(ws ...world.WorkerObs) []world.WorkerObs {
		return append(append(append([]world.WorkerObs{}, obs[1:]...), others...), ws...)
	}
	// A back from a closed workspace: new workspace id, same agent session.
	back := worker("ra", "CODE|w000", "sess-w000", "idle")
	// leave closes A's workspace, lets days pass and has newcomer ws join.
	leave := func(b *bridge, days int64, ws string) string {
		t.Helper()
		b.floor("s", true, with()...)
		b.world(func(w proto.World) bool {
			s := workersOf(w, "s")
			_, a := s["w000"]
			_, ra := s["ra"]
			return !a && !ra
		})
		clk.set(clk.ms.Load() + days*day)
		others = append(others, agent(ws, "idle"))
		b.floor("s", true, with()...)
		w := b.world(func(w proto.World) bool { _, ok := workersOf(w, "s")[ws]; return ok })
		names["sess-"+ws] = workersOf(w, "s")[ws].Name
		return names["sess-"+ws]
	}
	check := func(w proto.World, want map[string]string) {
		t.Helper()
		seen := map[string]bool{}
		for _, wk := range workersOf(w, "s") {
			if seen[wk.Name] {
				t.Errorf("name %q handed out twice", wk.Name)
			}
			seen[wk.Name] = true
			if n, ok := want[wk.AgentSession]; ok && wk.Name != n {
				t.Errorf("%s: name %q, want %q", wk.AgentSession, wk.Name, n)
			}
		}
	}

	// Within the hold: A leaves, newcomer B joins six days later, A returns.
	if n := leave(b, 6, "b"); n == nameA {
		t.Fatalf("newcomer b got %q, the name of a worker that may come back", n)
	}
	b.floor("s", true, with(back)...)
	check(b.world(hasWorkers("s", len(obs)+1)), names)

	// Again across a bridge restart.
	if n := leave(b, 6, "c"); n == nameA {
		t.Fatalf("newcomer c got %q, the name of a worker that may come back", n)
	}
	b.stop()
	b = startBridge(t, db, opts)
	b.floor("s", true, with(back)...)
	check(b.world(hasWorkers("s", len(obs)+2)), names)

	// Past the hold A's name is free: newcomer D takes it (the only free
	// base name), and A comes back under a new one.
	if n := leave(b, 8, "d"); n != nameA {
		t.Fatalf("newcomer d got %q, want the released %q", n, nameA)
	}
	b.floor("s", true, with(back)...)
	w = b.world(hasWorkers("s", len(obs)+3))
	delete(names, "sess-w000")
	check(w, names)
	if n := workersOf(w, "s")["ra"].Name; n == "" || n == nameA {
		t.Fatalf("A came back after the hold as %q; d has %q", n, nameA)
	}
}

// The name hold counts from when a worker was last on its floor, not from
// when it joined: leaving records that time, and a worker that stays has it
// refreshed, so a bridge that stops without seeing it leave still knows.
func TestNameHoldCountsFromLastSeen(t *testing.T) {
	const day = int64(24 * time.Hour / time.Millisecond)
	db := filepath.Join(t.TempDir(), "world.db")
	clk := newClock(1_790_000_000_000)
	opts := server.Options{Now: clk.now, NameHold: 7 * 24 * time.Hour}
	b := startBridge(t, db, opts)
	var obs []world.WorkerObs
	for i := range len(world.Names) {
		obs = append(obs, agent(fmt.Sprintf("w%03d", i), "idle"))
	}
	b.floor("s", true, obs...)
	w := b.world(hasWorkers("s", len(obs)))
	nameA, nameX := workersOf(w, "s")["w000"].Name, workersOf(w, "s")["w001"].Name
	newName := func(b *bridge, ws string, floor ...world.WorkerObs) string {
		t.Helper()
		b.floor("s", true, floor...)
		w := b.world(func(w proto.World) bool { _, ok := workersOf(w, "s")[ws]; return ok })
		return workersOf(w, "s")[ws].Name
	}

	// A stays ten days, leaves, and newcomer B joins a day later; then A
	// comes back.
	clk.set(clk.ms.Load() + 10*day)
	b.floor("s", true, obs[1:]...)
	b.world(func(w proto.World) bool { _, a := workersOf(w, "s")["w000"]; return !a })
	clk.set(clk.ms.Load() + day)
	rest := append(append([]world.WorkerObs{}, obs[1:]...), agent("b", "idle"))
	if n := newName(b, "b", rest...); n == nameA {
		t.Fatalf("b got %q from A, which left a day ago", n)
	}
	if n := newName(b, "ra", append(rest, worker("ra", "CODE|w000", "sess-w000", "idle"))...); n != nameA {
		t.Fatalf("A came back as %q, want %q", n, nameA)
	}

	// Nine days on, X is still there (b turns busy, so the observation is
	// visibly applied); the bridge stops, X is gone when it restarts a day
	// later, and newcomer C joins: X was there a day ago.
	clk.set(clk.ms.Load() + 9*day)
	rest = append(rest[:len(rest)-1], agent("b", "working"), worker("ra", "CODE|w000", "sess-w000", "idle"))
	b.floor("s", true, rest...)
	b.world(func(w proto.World) bool { return workersOf(w, "s")["b"].Status == "working" })
	b.stop()
	clk.set(clk.ms.Load() + day)
	b = startBridge(t, db, opts)
	if n := newName(b, "c", append(append([]world.WorkerObs{}, rest[1:]...), agent("c", "idle"))...); n == nameX {
		t.Fatalf("c got %q from X, which was there a day ago", n)
	}
}

func TestStatusSinceSurvivesRestartWhenUnchanged(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	clk := newClock(1_000)
	b := startBridge(t, db, server.Options{Now: clk.now})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, agent("a", "idle"), agent("b", "working"))
	evs := c.events(3)
	if evs[1].Worker.StatusSince != 1_000 || evs[2].Worker.StatusSince != 1_000 {
		t.Fatalf("first sight: status_since = %d, %d, want now", evs[1].Worker.StatusSince, evs[2].Worker.StatusSince)
	}
	clk.set(2_000)
	b.floor("s", true, agent("a", "working"), agent("b", "working"))
	if ev := c.event(); ev.T != proto.EvWorkerStatus || ev.StatusSince != 2_000 || ev.PrevStatus != "idle" {
		t.Fatalf("status change = %+v", ev)
	}
	clk.set(3_000)
	b.floor("s", true, agent("a", "working"), agent("b", "working")) // nothing changed: no event, no reset
	b.stop()

	clk.set(9_000)
	b2 := startBridge(t, db, server.Options{Now: clk.now})
	b2.floor("s", true, agent("a", "working"), agent("b", "idle"))
	s := workersOf(b2.world(hasWorkers("s", 2)), "s")
	if got := s["a"].StatusSince; got != 2_000 {
		t.Errorf("a kept its status across the restart: status_since %d, want 2000", got)
	}
	if got := s["b"].StatusSince; got != 9_000 {
		t.Errorf("b changed status while the bridge was down: status_since %d, want 9000", got)
	}
}

func TestWorkerStatusCarriesTitle(t *testing.T) {
	clk := newClock(1_000)
	b := startBridge(t, "", server.Options{Now: clk.now})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w := agent("a", "working")
	w.Title = "Reading hub.go"
	b.floor("s", true, w)
	up := c.events(2)[1]
	if up.T != proto.EvWorkerUpsert || up.Worker.Title != "Reading hub.go" || up.Worker.StatusSince != 1_000 {
		t.Fatalf("upsert = %+v", up.Worker)
	}

	// Title only: worker.status, status_since unchanged.
	clk.set(2_000)
	w.Title = "Writing tests"
	b.floor("s", true, w)
	ev := c.event()
	if ev.T != proto.EvWorkerStatus || ev.Title == nil || *ev.Title != "Writing tests" || ev.Status != "working" ||
		ev.PrevStatus != "working" || ev.StatusSince != 1_000 {
		t.Fatalf("title-only change = %+v", ev)
	}
	// Title and status together: still worker.status.
	clk.set(3_000)
	w.Title, w.Status = "", "idle"
	b.floor("s", true, w)
	m := c.next()
	if !strings.Contains(string(m.raw), `"title":""`) || !strings.Contains(string(m.raw), `"status_since":3000`) ||
		!strings.Contains(string(m.raw), `"t":"worker.status"`) {
		t.Fatalf("title cleared + status: %s", m.raw)
	}
	// Anything else is a full upsert.
	w.Label = "CODE|renamed"
	b.floor("s", true, w)
	if ev := c.event(); ev.T != proto.EvWorkerUpsert || ev.Worker.Label != "CODE|renamed" || ev.Worker.StatusSince != 3_000 {
		t.Fatalf("label change = %+v", ev)
	}
}

func TestHarnessModelEffortRemembered(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	w := agent("a", "working")
	w.AgentKind, w.Harness, w.Model, w.Effort = "claude", "claude", "claude-opus-5-5", "high"
	b.floor("s", true, w)
	got := workersOf(b.world(hasWorkers("s", 1)), "s")["a"]
	if got.Harness != "claude" || got.Model != "claude-opus-5-5" || got.Effort != "high" {
		t.Fatalf("worker = %+v", got)
	}
	b.stop()

	// herdr restarted and the tokens are gone (a sleeping floor has none).
	b2 := startBridge(t, db, server.Options{})
	w.AgentKind, w.Harness, w.Model, w.Effort = "", "", "", ""
	b2.floor("s", false, w)
	got = workersOf(b2.world(hasWorkers("s", 1)), "s")["a"]
	if got.Harness != "claude" || got.Model != "claude-opus-5-5" || got.Effort != "high" {
		t.Fatalf("after token loss = %+v", got)
	}
	// A new token value wins.
	w.Model = "claude-fable-5-1"
	b2.floor("s", true, w)
	got = workersOf(b2.world(func(w proto.World) bool { return workersOf(w, "s")["a"].Model == "claude-fable-5-1" }), "s")["a"]
	if got.Effort != "high" {
		t.Fatalf("effort forgotten: %+v", got)
	}
}

func TestFloorDesks(t *testing.T) {
	b := startBridge(t, "", server.Options{MaxDesks: 8})
	c := b.connect(proto.Hello{})
	c.snapshot()
	obs := func(n int) []world.WorkerObs {
		var out []world.WorkerObs
		for i := range n {
			out = append(out, agent(fmt.Sprintf("w%02d", i), "idle"))
		}
		return out
	}
	b.floor("s", true)
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Desks != 6 {
		t.Fatalf("empty floor = %+v", ev.Floor)
	}
	// 5 workers: 5+2 = 7 desks, announced before the workers.
	b.floor("s", true, obs(5)...)
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Desks != 7 {
		t.Fatalf("5 workers = %+v", ev.Floor)
	}
	c.events(5)
	// 7 workers: 9 would exceed the cap of 8.
	b.floor("s", true, obs(7)...)
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Desks != 8 {
		t.Fatalf("7 workers = %+v", ev.Floor)
	}
	c.events(2)
	// Over the cap every worker still has a desk.
	b.floor("s", true, obs(10)...)
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Desks != 10 {
		t.Fatalf("10 workers = %+v", ev.Floor)
	}
	c.events(3)
	// Only the worker on desk 9 is left: the floor keeps desks up to it.
	b.floor("s", true, obs(10)[9])
	w := b.world(hasWorkers("s", 1))
	if wk := workersOf(w, "s")["w09"]; wk.DeskIndex != 9 || floorOf(w, "s").Desks != 10 {
		t.Fatalf("desk %d, floor desks %d", wk.DeskIndex, floorOf(w, "s").Desks)
	}
	b.floor("s", true)
	if f := floorOf(b.world(hasWorkers("s", 0)), "s"); f.Desks != 6 {
		t.Fatalf("empty again: %d desks", f.Desks)
	}
}
