package server_test

import (
	"context"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #58 virtual floors: the bridge's store says which floor a worker is on.

const vWeb = "v-0123456789ab"

// seedFloors stores virtual floors (id → name, all on session "s") and
// workers (id → floor id, with their agent session "sess-<id>" as identity)
// in a new database, as a bridge that ran before left them.
func seedFloors(t *testing.T, floors map[string]string, workers map[string]string) string {
	t.Helper()
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "world.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for id, name := range floors {
		if _, err := st.CreateVirtualFloor(ctx, id, name, "s"); err != nil {
			t.Fatal(err)
		}
	}
	for id, floor := range workers {
		w := store.Worker{ID: id, Session: "s", FloorID: floor, WorkspaceID: "w-" + id,
			Fingerprints: []store.Fingerprint{{Kind: store.FPAgentSession, Value: "sess-" + id}}}
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func floorByID(w proto.World, id string) (proto.Floor, bool) {
	for _, f := range w.Floors {
		if f.ID == id {
			return f, true
		}
	}
	return proto.Floor{}, false
}

func workerByID(w proto.World, id string) (proto.Worker, bool) {
	for _, wk := range w.Workers {
		if wk.ID == id {
			return wk, true
		}
	}
	return proto.Worker{}, false
}

func storedFloors(t *testing.T, b *bridge) map[string]string {
	t.Helper()
	ws, err := b.st.SessionWorkers(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, w := range ws {
		out[w.ID] = w.FloorID
	}
	return out
}

// One observation of a session fans its workspaces out to its floors by
// each worker's stored floor; an unattributed one stays on the real floor.
// Each floor seats and names its own workers.
func TestVirtualFloorFanOut(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, map[string]string{"u1": vWeb, "u2": "s"})
	hb := startHireBridgeAt(t, db, nil,
		worker("w1", "CODE|a", "sess-u1", "idle"), worker("w2", "CODE|b", "sess-u2", "idle"), worker("w3", "tui", "", "idle"))
	w := hb.connect(proto.Hello{}).snapshot().World

	real, ok := floorByID(w, "s")
	if !ok || real.Name != "s" || real.Session != "s" || real.BaseSession != "s" || real.Virtual {
		t.Fatalf("real floor = %+v", real)
	}
	v, ok := floorByID(w, vWeb)
	if !ok || v.Name != "Web" || v.Session != "s" || v.BaseSession != "s" || !v.Virtual || v.State != "running" {
		t.Fatalf("virtual floor = %+v", v)
	}
	if !slices.Equal(w.Unassigned, []string{"s", vWeb}) {
		t.Fatalf("unassigned = %v", w.Unassigned)
	}
	u1, _ := workerByID(w, "u1")
	u2, _ := workerByID(w, "u2")
	if u1.Floor != vWeb || u1.Session != "s" || u2.Floor != "s" {
		t.Fatalf("u1 = %+v, u2 = %+v", u1, u2)
	}
	tui := workersOf(w, "s")["w3"]
	if tui.ID == "" || tui.Floor != "s" {
		t.Fatalf("unattributed workspace = %+v", tui)
	}
	// Desks and names are per floor: the virtual floor's only worker has
	// its first desk.
	if u1.DeskIndex != 0 || u1.Name == "" {
		t.Fatalf("u1 seat = %d, name %q", u1.DeskIndex, u1.Name)
	}
	if desks := []int{u2.DeskIndex, tui.DeskIndex}; slices.Contains(desks, -1) || desks[0] == desks[1] {
		t.Fatalf("real floor desks = %v", desks)
	}
	if got := storedFloors(t, hb.bridge); got["u1"] != vWeb || got["u2"] != "s" || got[tui.ID] != "s" {
		t.Fatalf("stored floors = %v", got)
	}
}

// A stored floor that names a virtual floor no longer defined falls back
// to the real floor, and the store is told.
func TestDeletedVirtualFloorFallsBackToRealFloor(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, nil, map[string]string{"u1": "v-00000000dead"})
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "sess-u1", "idle"))
	u1, ok := workerByID(hb.connect(proto.Hello{}).snapshot().World, "u1")
	if !ok || u1.Floor != "s" {
		t.Fatalf("u1 = %+v", u1)
	}
	if got := storedFloors(t, hb.bridge); got["u1"] != "s" {
		t.Fatalf("stored floor = %q", got["u1"])
	}
}

// A hire on a virtual floor makes the workspace in the base session and
// the worker is on the virtual floor from its first event, and after a
// bridge restart.
func TestHireOnVirtualFloor(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	args := hireArgs(1)
	args.Session, args.Floor = "", vWeb
	evs, ack := c.mustAck(proto.CmdWorkerHire, args)
	id := ack.Data.(map[string]any)["id"].(string)
	upserts := 0
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id {
			upserts++
			if ev.Worker.Floor != vWeb || ev.Worker.Session != "s" || ev.Worker.DeskIndex != 1 {
				t.Fatalf("hired worker upsert = %+v", ev.Worker)
			}
		}
		if (ev.T == proto.EvWorkerStatus || ev.T == proto.EvWorkerRemoved) && ev.ID == id && ev.FloorID != vWeb {
			t.Fatalf("hired worker event = %+v", ev)
		}
	}
	if upserts == 0 {
		t.Fatalf("no upsert of the hired worker: %+v", evs)
	}
	// herdr only ever heard of the base session.
	calls := hb.fl.Calls()
	if !slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "create s ") }) {
		t.Fatalf("herdr calls = %v", calls)
	}
	for _, call := range calls {
		if strings.Contains(call, "v-") {
			t.Fatalf("a virtual floor id reached herdr: %v", calls)
		}
	}
	if got := storedFloors(t, hb.bridge); got[id] != vWeb {
		t.Fatalf("stored floor = %v", got)
	}
	// Per floor: the hire counts on the virtual floor and its last hire is
	// its own.
	_, m := c.command(proto.CmdHirePrepare, "p", proto.HirePrepareArgs{Floor: vWeb})
	if res := ackData[proto.HirePrepareResult](t, m); res.Capacity.Floor.Count != 1 || res.Capacity.Host.Count != 2 ||
		res.ChoiceSource != proto.ChoiceLast {
		t.Fatalf("prepare on the virtual floor = %+v", res)
	}
	_, m = c.command(proto.CmdHirePrepare, "p2", proto.HirePrepareArgs{Session: "s"})
	if res := ackData[proto.HirePrepareResult](t, m); res.Capacity.Floor.Count != 1 || res.ChoiceSource != proto.ChoiceNone {
		t.Fatalf("prepare on the real floor = %+v", res)
	}

	// The bridge restarts; herdr still shows the workspace (its pane marker).
	hb.fl.mu.Lock()
	now := slices.Clone(hb.fl.workers)
	hb.fl.mu.Unlock()
	hb.stop()
	again := startHireBridgeAt(t, db, nil, now...)
	w := again.connect(proto.Hello{}).snapshot().World
	if wk, ok := workerByID(w, id); !ok || wk.Floor != vWeb || wk.DeskIndex != 1 {
		t.Fatalf("after a restart: %+v (%v)", wk, ok)
	}
}

// floor.wake on a virtual floor wakes its base session: herdr is started
// with the session, never the floor id, and every floor of it wakes.
func TestWakeVirtualFloorWakesBase(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
	fh := newFakeHerdr()
	b := startBridge(t, db, fastOps(fh))
	b.floorAt("s", false, nil)
	c := b.connect(proto.Hello{})
	if v, ok := floorByID(c.snapshot().World, vWeb); !ok || v.State != "asleep" {
		t.Fatalf("virtual floor = %+v", v)
	}
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		b.floorAt("s", true, nil)
	}
	evs, m := c.command(proto.CmdFloorWake, "wake", proto.FloorArgs{Floor: vWeb})
	if m.env.T != proto.TAck {
		t.Fatalf("wake: %s", m.raw)
	}
	if calls := fh.Calls(); !slices.Equal(calls, []string{"start s"}) {
		t.Fatalf("herdr calls = %v", calls)
	}
	running := map[string]bool{}
	for _, ev := range evs {
		if ev.T == proto.EvFloorUpsert {
			running[ev.Floor.ID] = ev.Floor.State == "running" && ev.Floor.Transition == ""
		}
	}
	if !running["s"] || !running[vWeb] {
		t.Fatalf("floors after the wake = %v", running)
	}
}

// A session that goes away takes its virtual floors (and their workers) out
// of the world; they come back with it.
func TestSessionGoneRemovesItsVirtualFloors(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, map[string]string{"u1": vWeb})
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "sess-u1", "idle"))
	c := hb.c
	hb.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
	removed := map[string]string{}
	var workerGone proto.Event
	for len(removed) < 2 {
		ev := c.event()
		switch ev.T {
		case proto.EvFloorRemoved:
			removed[ev.FloorID] = ev.Session
		case proto.EvWorkerRemoved:
			workerGone = ev
		}
	}
	if removed["s"] != "s" || removed[vWeb] != "s" {
		t.Fatalf("floor.removed = %v", removed)
	}
	if workerGone.ID != "u1" || workerGone.FloorID != vWeb || workerGone.Session != "s" {
		t.Fatalf("worker.removed = %+v", workerGone)
	}
	if vs, err := hb.st.VirtualFloors(context.Background()); err != nil || len(vs) != 1 {
		t.Fatalf("definitions = %+v, %v", vs, err)
	}
	hb.fl.publish()
	for {
		ev := c.event()
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == "u1" {
			if ev.Worker.Floor != vWeb {
				t.Fatalf("back on %q", ev.Worker.Floor)
			}
			break
		}
	}
	if _, ok := floorByID(hb.connect(proto.Hello{}).snapshot().World, vWeb); !ok {
		t.Fatal("the virtual floor did not come back")
	}
}

func TestVirtualFloorCommands(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	other := hb.connect(proto.Hello{Client: "other"})
	other.snapshot()

	c.mustError(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "nope"}, proto.ErrUnknownSession)
	c.mustError(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: " ", BaseSession: "s"}, proto.ErrBadRequest)
	c.mustError(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web"}, proto.ErrBadRequest)
	_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: " Web ", BaseSession: "s"})
	v := ack.Data.(map[string]any)
	id, _ := v["id"].(string)
	if !regexp.MustCompile(`^v-[0-9a-f]{12}$`).MatchString(id) || v["name"] != "Web" || v["base_session"] != "s" ||
		v["virtual"] != true || v["session"] != "s" {
		t.Fatalf("created = %+v", v)
	}
	// Every client hears of it.
	if ev := other.until(proto.EvFloorUpsert); ev.Floor.ID != id || !ev.Floor.Virtual {
		t.Fatalf("other client: %+v", ev.Floor)
	}
	// A virtual floor id is no name for a new session.
	c.mustError(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: id}, proto.ErrNameTaken)

	evs, _ := c.mustAck(proto.CmdFloorRename, proto.FloorRenameArgs{Floor: id, Name: "Frontend"})
	if len(evs) != 1 || evs[0].T != proto.EvFloorUpsert || evs[0].Floor.Name != "Frontend" {
		t.Fatalf("rename events = %+v", evs)
	}
	c.mustError(proto.CmdFloorRename, proto.FloorRenameArgs{Floor: "s", Name: "X"}, proto.ErrBadRequest)
	c.mustError(proto.CmdFloorRename, proto.FloorRenameArgs{Floor: "v-aaaaaaaaaaaa", Name: "X"}, proto.ErrNotFound)
	c.mustError(proto.CmdFloorRename, proto.FloorRenameArgs{Floor: id, Name: ""}, proto.ErrBadRequest)

	// Decision 4: it stays in its base's building.
	b1, b2 := createBuilding(c, "One"), createBuilding(c, "Two")
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "s", Building: &b1})
	c.mustError(proto.CmdFloorAssign, proto.FloorAssignArgs{Floor: id, Building: &b2}, proto.ErrBadRequest)
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Floor: id, Building: &b1, Index: ptr(0)})
	w := hb.connect(proto.Hello{}).snapshot().World
	if w.Buildings[0].ID != b1 || !slices.Equal(w.Buildings[0].Floors, []string{id, "s"}) || len(w.Unassigned) != 0 {
		t.Fatalf("buildings = %+v, unassigned %v", w.Buildings, w.Unassigned)
	}
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Floor: "s", Building: &b2})
	w = hb.connect(proto.Hello{}).snapshot().World
	if !slices.Equal(w.Buildings[1].Floors, []string{"s", id}) {
		t.Fatalf("after the base moved = %+v", w.Buildings)
	}

	// Not deleted while it has a worker.
	args := hireArgs(0)
	args.Session, args.Floor = "", id
	c.mustAck(proto.CmdWorkerHire, args)
	_, m := c.command(proto.CmdFloorDelete, "del", proto.FloorDeleteArgs{Floor: id})
	if e := errorOf(m); e.Code != proto.ErrInvalidState || !strings.Contains(e.Message, "1 worker") {
		t.Fatalf("delete with a worker: %s", m.raw)
	}
	c.mustError(proto.CmdFloorDelete, proto.FloorDeleteArgs{Floor: id, MoveWorkers: true}, proto.ErrUnsupported)
	c.mustError(proto.CmdFloorDelete, proto.FloorDeleteArgs{Floor: "s"}, proto.ErrBadRequest)

	// An empty one goes: floor.removed names it.
	_, ack = c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Spare", BaseSession: "s"})
	spare := ack.Data.(map[string]any)["id"].(string)
	evs, _ = c.mustAck(proto.CmdFloorDelete, proto.FloorDeleteArgs{Floor: spare})
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvFloorRemoved && ev.FloorID == spare && ev.Session == "s"
	}) {
		t.Fatalf("delete events = %+v", evs)
	}
	if vs, _ := hb.st.VirtualFloors(context.Background()); len(vs) != 1 || vs[0].ID != id {
		t.Fatalf("definitions = %+v", vs)
	}
}

// floor.create refuses a base session outside --sessions.
func TestFloorCreateRespectsSessions(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, func(o *server.Options) { o.Sessions = regexp.MustCompile(`^s$`) })
	hb.floorAt("x", true, nil)
	hb.c.mustError(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "x"}, proto.ErrUnknownSession)
	hb.c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "s"})
}
