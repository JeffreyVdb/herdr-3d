package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/watch"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// fullFloor is one worker per base name: a newcomer gets a suffixed name
// unless a base name is free.
func fullFloor() []world.WorkerObs {
	var obs []world.WorkerObs
	for i := range len(world.Names) {
		obs = append(obs, agent(fmt.Sprintf("w%03d", i), "idle"))
	}
	return obs
}

// floorWith is a new slice of base followed by extra.
func floorWith(base []world.WorkerObs, extra ...world.WorkerObs) []world.WorkerObs {
	return append(append([]world.WorkerObs{}, base...), extra...)
}

// claims returns a floor's stored name claims by worker id.
func claims(t *testing.T, st *store.Store, floor string) map[string]store.NameClaim {
	t.Helper()
	ns, err := st.Names(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]store.NameClaim{}
	for _, c := range ns {
		if c.Floor == floor {
			m[c.WorkerID] = c
		}
	}
	return m
}

// checkClaims asserts that the floor's workers have unique names and that
// each holds exactly the stored claim of its name.
func checkClaims(t *testing.T, st *store.Store, w proto.World, floor string) {
	t.Helper()
	cs := claims(t, st, floor)
	seen := map[string]bool{}
	for _, wk := range workersOf(w, floor) {
		if seen[wk.Name] {
			t.Errorf("name %q handed out twice", wk.Name)
		}
		seen[wk.Name] = true
		if c, ok := cs[wk.ID]; !ok || c.Name != wk.Name || !c.Released.IsZero() {
			t.Errorf("%s (%q): stored claim %+v, want its name, held", wk.WorkspaceID, wk.Name, c)
		}
	}
}

func hasWorker(session, ws string) func(proto.World) bool {
	return func(w proto.World) bool { _, ok := workersOf(w, session)[ws]; return ok }
}

// A worker leaving and a newcomer joining in the same observation: the
// departure is recorded first, so the newcomer never gets the name, even
// with a hold shorter than the leaver's time on the floor.
func TestLeaveAndJoinInOneObservation(t *testing.T) {
	clk := newClock(1_790_000_000_000)
	b := startBridge(t, "", server.Options{Now: clk.now, NameHold: time.Minute})
	obs := fullFloor()
	b.floor("s", true, obs...)
	s := workersOf(b.world(hasWorkers("s", len(obs))), "s")
	a, x := s["w000"], s["w001"]

	clk.advance(2 * time.Minute)
	b.floor("s", true, floorWith(obs[1:], agent("b", "idle"))...)
	nb := workersOf(b.world(hasWorker("s", "b")), "s")["b"].Name
	if nb == a.Name {
		t.Fatalf("newcomer b got %q from A, which left in the same observation", nb)
	}
	if c := claims(t, b.st, "s")[a.ID]; c.Name != a.Name || !c.Released.Equal(clk.now()) {
		t.Fatalf("A's claim = %+v, want %q released now", c, a.Name)
	}
	// A comes back at once, well inside the hold.
	back := worker("ra", "CODE|w000", "sess-w000", "idle")
	b.floor("s", true, floorWith(obs[1:], agent("b", "idle"), back)...)
	w := b.world(hasWorkers("s", len(obs)+1))
	if ra := workersOf(w, "s")["ra"]; ra.ID != a.ID || ra.Name != a.Name {
		t.Fatalf("A came back as %+v, want id %s named %q", ra, a.ID, a.Name)
	}
	checkClaims(t, b.st, w, "s")

	// Two leave and two join at once.
	clk.advance(2 * time.Minute)
	rest := floorWith(obs[2:], agent("b", "idle"), back)
	b.floor("s", true, floorWith(rest, agent("c", "idle"), agent("d", "idle"))...)
	w = b.world(hasWorker("s", "d"))
	for _, ws := range []string{"c", "d"} {
		if n := workersOf(w, "s")[ws].Name; n == a.Name || n == x.Name {
			t.Fatalf("newcomer %s got %q from a worker that left in the same observation", ws, n)
		}
	}
	checkClaims(t, b.st, w, "s")
}

// A worker back after its hold, whose name a newcomer took, gets a new
// name: it must not take one another absent worker still holds.
func TestExpiredReturnDoesNotTakeAHeldName(t *testing.T) {
	const day = 24 * time.Hour
	clk := newClock(1_790_000_000_000)
	b := startBridge(t, "", server.Options{Now: clk.now})
	obs := fullFloor()
	b.floor("s", true, obs...)
	a := workersOf(b.world(hasWorkers("s", len(obs))), "s")["w000"]
	b.floor("s", true, obs[1:]...)
	b.world(hasWorkers("s", len(obs)-1))

	// Eight days on, newcomer B takes A's name (the only free base name).
	clk.advance(8 * day)
	b.floor("s", true, floorWith(obs[1:], agent("b", "idle"))...)
	bw := workersOf(b.world(hasWorker("s", "b")), "s")["b"]
	if bw.Name != a.Name {
		t.Fatalf("B got %q, want A's expired name %q", bw.Name, a.Name)
	}
	cs := claims(t, b.st, "s")
	if _, ok := cs[a.ID]; ok || cs[bw.ID].Name != a.Name {
		t.Fatalf("claims after B took A's name: A %+v, B %+v", cs[a.ID], cs[bw.ID])
	}

	// B leaves; a day later A comes back, then B.
	b.floor("s", true, obs[1:]...)
	b.world(hasWorkers("s", len(obs)-1))
	clk.advance(day)
	backA := worker("ra", "CODE|w000", "sess-w000", "idle")
	b.floor("s", true, floorWith(obs[1:], backA)...)
	ra := workersOf(b.world(hasWorker("s", "ra")), "s")["ra"]
	if ra.ID != a.ID || ra.Name == bw.Name {
		t.Fatalf("A came back as %+v; B holds %q", ra, bw.Name)
	}
	backB := worker("rb", "CODE|b", "sess-b", "idle")
	b.floor("s", true, floorWith(obs[1:], backA, backB)...)
	w := b.world(hasWorkers("s", len(obs)+1))
	s := workersOf(w, "s")
	if rb := s["rb"]; rb.ID != bw.ID || rb.Name != bw.Name {
		t.Fatalf("B came back one day into its hold as %+v, want %q", rb, bw.Name)
	}
	if s["ra"].Name != ra.Name {
		t.Fatalf("A's new name changed from %q to %q", ra.Name, s["ra"].Name)
	}
	checkClaims(t, b.st, w, "s")
}

// A running floor that does not change produces no hub writes, yet a
// worker that disappears during a short bridge restart still holds its
// name: the hold starts when the restarted bridge sees it missing. Uses the
// real watcher against a fake herdr, whose unchanged safety snapshots never
// reach the hub.
func TestUnchangedRunningFloorAcrossRestart(t *testing.T) {
	const day = 24 * time.Hour
	clk := newClock(1_790_000_000_000)
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{Now: clk.now})
	fake := herdrtest.Start(t, shortDir(t))
	snap := &herdr.Snapshot{}
	for _, o := range fullFloor() {
		snap.Workspaces = append(snap.Workspaces, herdr.WorkspaceInfo{WorkspaceID: o.WorkspaceID, Label: o.Label})
		snap.Panes = append(snap.Panes, herdr.PaneInfo{PaneID: o.PaneID, WorkspaceID: o.WorkspaceID, AgentStatus: o.Status,
			Cwd: ptr(o.Cwd), AgentSession: &herdr.AgentSession{Value: o.AgentSession}})
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatal(err)
	}
	fake.SetSnapshot(raw)
	lister := herdrtest.NewLister()
	lister.Set(herdr.Session{Name: "s", SessionDir: filepath.Dir(fake.Socket), SocketPath: fake.Socket})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		watch.Run(ctx, watch.Config{Herdr: lister, Out: b.hub.Updates(), Poll: 10 * time.Millisecond,
			Resnapshot: 10 * time.Millisecond, Log: quietLog()})
	}()
	defer func() { cancel(); <-done }()
	a := workersOf(b.world(hasWorkers("s", len(world.Names))), "s")["w000"]
	snapshots := func() int {
		n := 0
		for _, m := range fake.Methods() {
			if m == "session.snapshot" {
				n++
			}
		}
		return n
	}
	initial := snapshots()
	clk.advance(8 * day)
	deadline := time.Now().Add(5 * time.Second)
	for snapshots() < initial+5 {
		if time.Now().After(deadline) {
			t.Fatal("no safety snapshots")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if c := claims(t, b.st, "s")[a.ID]; c.Name != a.Name || !c.Released.IsZero() {
		t.Fatalf("A's claim while on the floor = %+v", c)
	}
	b.stop()

	// A disappears during a one-minute downtime and B joins at restart.
	clk.advance(time.Minute)
	b = startBridge(t, db, server.Options{Now: clk.now})
	obs := world.FromSnapshot(snap)
	b.floor("s", true, floorWith(obs[1:], agent("b", "idle"))...)
	bw := workersOf(b.world(hasWorkers("s", len(obs))), "s")["b"]
	if bw.Name == a.Name {
		t.Fatalf("B got %q from A, which the bridge saw on the floor a minute ago", bw.Name)
	}
	if c := claims(t, b.st, "s")[a.ID]; c.Name != a.Name || !c.Released.Equal(clk.now()) {
		t.Fatalf("A's claim after the restart = %+v, want %q released now", c, a.Name)
	}
	back := obs[0]
	back.WorkspaceID = "ra"
	b.floor("s", true, floorWith(obs[1:], agent("b", "idle"), back)...)
	w := b.world(hasWorkers("s", len(obs)+1))
	if ra := workersOf(w, "s")["ra"]; ra.ID != a.ID || ra.Name != a.Name {
		t.Fatalf("A came back as %+v, want id %s named %q", ra, a.ID, a.Name)
	}
	checkClaims(t, b.st, w, "s")
}

// Names are written only when a worker joins, leaves or comes back:
// status, title and metadata changes keep their events and leave the claim
// alone. A deleted session releases its names, which its workers get back
// if it returns within the hold.
func TestNameClaimsEventsAndFloorRemoval(t *testing.T) {
	clk := newClock(1_790_000_000_000)
	b := startBridge(t, "", server.Options{Now: clk.now})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w := agent("a", "idle")
	b.floor("s", true, w)
	initial := c.events(2)[1].Worker
	held := func() {
		t.Helper()
		if cl := claims(t, b.st, "s")[initial.ID]; cl.Name != initial.Name || !cl.Released.IsZero() {
			t.Fatalf("claim = %+v, want %q held", cl, initial.Name)
		}
	}
	held()

	clk.advance(time.Hour)
	b.floor("s", true, w)
	b.floor("barrier", true)
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Session != "barrier" {
		t.Fatalf("unchanged observation emitted %+v", ev)
	}
	clk.advance(time.Millisecond)
	w.Title = "new title"
	b.floor("s", true, w)
	if ev := c.event(); ev.T != proto.EvWorkerStatus || ev.StatusSince != initial.StatusSince {
		t.Fatalf("title only = %+v", ev)
	}
	clk.advance(time.Millisecond)
	w.Status = "working"
	b.floor("s", true, w)
	if ev := c.event(); ev.T != proto.EvWorkerStatus || ev.StatusSince != clk.ms.Load() {
		t.Fatalf("status only = %+v", ev)
	}
	clk.advance(time.Millisecond)
	w.Label = "new label"
	b.floor("s", true, w)
	if ev := c.event(); ev.T != proto.EvWorkerUpsert || ev.Worker.StatusSince != clk.ms.Load()-1 ||
		ev.Worker.DeskIndex != initial.DeskIndex || ev.Worker.Name != initial.Name {
		t.Fatalf("metadata = %+v", ev)
	}
	held()

	clk.advance(24 * time.Hour)
	b.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
	if evs := c.events(2); evs[0].T != proto.EvWorkerRemoved || evs[1].T != proto.EvFloorRemoved {
		t.Fatalf("floor removal = %+v", evs)
	}
	if cl := claims(t, b.st, "s")[initial.ID]; cl.Name != initial.Name || !cl.Released.Equal(clk.now()) {
		t.Fatalf("claim after the session was deleted = %+v, want released now", cl)
	}
	if desks, err := b.st.Desks(context.Background()); err != nil || len(desks) != 0 {
		t.Fatalf("desks after removal = %+v, %v", desks, err)
	}
	clk.advance(24 * time.Hour)
	b.floor("s", true, w)
	if back := workersOf(b.world(hasWorkers("s", 1)), "s")["a"]; back.ID != initial.ID || back.Name != initial.Name {
		t.Fatalf("back after the session returned = %+v, want %q", back, initial.Name)
	}
	held()
}

// A bridge starts on the claims a stopped bridge (or migration 3) left
// held: a worker on the floor keeps its name, and one that is not there
// when the bridge first looks is released then.
func TestNamesHeldAtStartup(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range []store.Worker{
		{ID: "u1", Session: "s", WorkspaceID: "a", Label: "CODE|a", Status: "idle", StatusSince: 1000,
			Fingerprints: []store.Fingerprint{{Kind: store.FPAgentSession, Value: "sess-a"}}},
		{ID: "u2", Session: "s", WorkspaceID: "x", Label: "CODE|x", Status: "idle", StatusSince: 1000,
			Fingerprints: []store.Fingerprint{{Kind: store.FPAgentSession, Value: "sess-x"}}},
	} {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	for _, err := range []error{st.ClaimName(ctx, "s", "Zippy", "u1"), st.ClaimName(ctx, "s", "Pixel", "u2"), st.AssignDesk(ctx, "s", 3, "u1")} {
		if err != nil {
			t.Fatal(err)
		}
	}
	st.Close()

	clk := newClock(1_790_000_000_000)
	b := startBridge(t, path, server.Options{Now: clk.now})
	b.floor("s", true, agent("a", "idle"), agent("b", "idle"))
	w := b.world(hasWorkers("s", 2))
	if a := workersOf(w, "s")["a"]; a.ID != "u1" || a.Name != "Zippy" || a.DeskIndex != 3 || a.StatusSince != 1000 {
		t.Fatalf("a = %+v", a)
	}
	if n := workersOf(w, "s")["b"].Name; n == "Zippy" || n == "Pixel" {
		t.Fatalf("newcomer got a held name %q", n)
	}
	if cl := claims(t, b.st, "s")["u2"]; cl.Name != "Pixel" || !cl.Released.Equal(clk.now()) {
		t.Fatalf("absent u2's claim = %+v, want Pixel released now", cl)
	}
	checkClaims(t, b.st, w, "s")
}
