package server_test

import (
	"context"
	"errors"
	"fmt"
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
	// A virtual floor id is no name for a new session: the shape is reserved.
	c.mustError(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: id}, proto.ErrBadRequest)

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

// A real herdr session whose name has a virtual floor id's shape can be a
// virtual floor's base: virtuality is the floor's, not its name's. No new
// session takes such a name (the virtual ids' namespace is reserved).
func TestVirtualFloorOnSessionWithVirtualShapedName(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	const real = "v-ba9876543210"
	hb.floorAt(real, true, nil)
	_, ack := hb.c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: real})
	v := ack.Data.(map[string]any)
	if v["base_session"] != real || v["session"] != real || v["virtual"] != true || v["id"] == real {
		t.Fatalf("created = %+v", v)
	}
	w := hb.connect(proto.Hello{}).snapshot().World
	if f, ok := floorByID(w, real); !ok || f.Virtual || f.Name != real {
		t.Fatalf("the real floor = %+v, %v", f, ok)
	}
	// A virtual floor's base is a real floor, whatever its name.
	hb.c.mustError(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "X", BaseSession: v["id"].(string)}, proto.ErrUnknownSession)
	_, m := hb.c.command(proto.CmdSessionCreate, "new", proto.SessionCreateArgs{Name: "v-0123456789ab"})
	if e := errorOf(m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, "virtual floors") {
		t.Fatalf("session.create v-<12 hex>: %s", m.raw)
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

// run.start on a virtual floor: the orchestrator is on it from its first
// event, its launch records the floor, and the floor's last preset is its
// own.
func TestRunStartOnVirtualFloor(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t)
	c := hb.c
	_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "s"})
	id := ack.Data.(map[string]any)["id"].(string)
	// Its settings are its own: none until set.
	if v, _ := floorByID(hb.connect(proto.Hello{}).snapshot().World, id); v.Settings != nil {
		t.Fatalf("new floor settings = %+v", v.Settings)
	}
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Floor: id, Repo: proto.Some("JeffreyVdb/lab"),
		DefaultCwd: proto.Some("/home/u/lab")})
	orch := buildTeam.Orch
	evs, ack := c.mustAck(proto.CmdRunStart, proto.RunStartArgs{Floor: id, DeskIndex: ptr(0), Text: "go", Orch: &orch,
		Preset: w.Presets[0].ID})
	worker := ack.Data.(map[string]any)["id"].(string)
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == worker && ev.Worker.Floor != id {
			t.Fatalf("orchestrator upsert = %+v", ev.Worker)
		}
	}
	l, ok, err := hb.st.RunLaunchByWorker(context.Background(), worker)
	if err != nil || !ok || l.FloorID != id || l.Session != "s" {
		t.Fatalf("launch = %+v, %v, %v", l, ok, err)
	}
	w = hb.connect(proto.Hello{}).snapshot().World
	if v, _ := floorByID(w, id); v.LastPreset != w.Presets[0].ID {
		t.Fatalf("virtual floor = %+v", v)
	}
	if real, _ := floorByID(w, "s"); real.LastPreset != "" {
		t.Fatalf("real floor = %+v", real)
	}
}

// sleepHireFloor puts the hire bridge's session to sleep with its workers
// (as herdr lists them asleep) and makes its next wake bring it back.
func sleepHireFloor(t *testing.T, hb *hireBridge) {
	t.Helper()
	hb.fl.mu.Lock()
	ws := slices.Clone(hb.fl.workers)
	hb.fl.mu.Unlock()
	hb.floorAt("s", false, ws)
	hb.world(func(w proto.World) bool { f, _ := floorByID(w, "s"); return f.State == "asleep" })
	hb.fl.onStart = func() {
		hb.fl.setUp("sock-s", true)
		hb.fl.publish()
	}
}

// floorStates is each floor's state and transition, in event order, from
// floor.upsert events.
func floorStates(evs []proto.Event) map[string][]string {
	out := map[string][]string{}
	for _, ev := range evs {
		if ev.T == proto.EvFloorUpsert {
			st := ev.Floor.State
			if ev.Floor.Transition != "" {
				st += "/" + ev.Floor.Transition
			}
			if l := out[ev.Floor.ID]; len(l) == 0 || l[len(l)-1] != st {
				out[ev.Floor.ID] = append(l, st)
			}
		}
	}
	return out
}

// floor.sleep on a virtual floor puts its base session to sleep: herdr is
// stopped with the session, every floor of it goes asleep, and its workers
// stay on their floors.
func TestSleepVirtualFloorSleepsBase(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, map[string]string{"u1": vWeb})
	fh := newFakeHerdr()
	b := startBridge(t, db, fastOps(fh))
	ws := []world.WorkerObs{worker("w1", "CODE|a", "sess-u1", "idle"), worker("w2", "tui", "", "idle")}
	b.floorAt("s", true, ws)
	c := b.connect(proto.Hello{})
	c.snapshot()
	fh.onStop = func() { fh.setUp("sock-s", false); b.floorAt("s", false, withStatus(ws, "unknown")) }
	evs, _ := c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Floor: vWeb})
	if calls := fh.Calls(); !slices.Equal(calls, []string{"stop s"}) {
		t.Fatalf("herdr calls = %v", calls)
	}
	got := floorStates(evs)
	for _, id := range []string{"s", vWeb} {
		if l := got[id]; len(l) < 2 || l[0] != "running/sleeping" || l[len(l)-1] != "asleep" {
			t.Fatalf("floor %s went %v", id, l)
		}
	}
	w := b.connect(proto.Hello{}).snapshot().World
	if v, _ := floorByID(w, vWeb); v.State != "asleep" {
		t.Fatalf("virtual floor = %+v", v)
	}
	if u1, ok := workerByID(w, "u1"); !ok || u1.Floor != vWeb {
		t.Fatalf("u1 asleep = %+v", u1)
	}
	if tui := workersOf(w, "s")["w2"]; tui.Floor != "s" {
		t.Fatalf("unattributed asleep = %+v", tui)
	}
}

// Decision 3: a hire on a virtual floor whose session is asleep wakes the
// session (every floor of it shows waking, then running), then hires; the
// hire dialog opens there meanwhile. An asleep real floor still refuses.
func TestHireOnAsleepVirtualFloorWakesItsSession(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	sleepHireFloor(t, hb)

	c.mustError(proto.CmdWorkerHire, hireArgs(1), proto.ErrInvalidState) // the real floor
	c.mustError(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: "s"}, proto.ErrInvalidState)
	_, m := c.command(proto.CmdHirePrepare, "p", proto.HirePrepareArgs{Floor: vWeb})
	if res := ackData[proto.HirePrepareResult](t, m); res.Label == "" || res.Cwd == "" {
		t.Fatalf("prepare on the asleep virtual floor = %+v", res)
	}
	// A request that cannot be a hire does not wake anything.
	bad := hireArgs(0)
	bad.Session, bad.Floor, bad.Harness = "", vWeb, "nope"
	c.mustError(proto.CmdWorkerHire, bad, proto.ErrBadRequest)
	if calls := hb.fl.Calls(); slices.Contains(calls, "start s") {
		t.Fatalf("woken by a bad hire: %v", calls)
	}

	args := hireArgs(0)
	args.Session, args.Floor = "", vWeb
	evs, ack := c.mustAck(proto.CmdWorkerHire, args)
	id := ack.Data.(map[string]any)["id"].(string)
	calls := hb.fl.Calls()
	start := slices.Index(calls, "start s")
	create := slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, "create s ") })
	if start < 0 || create < start {
		t.Fatalf("herdr calls = %v", calls)
	}
	for _, call := range calls {
		if strings.Contains(call, "v-") {
			t.Fatalf("a virtual floor id reached herdr: %v", calls)
		}
	}
	got := floorStates(evs)
	for _, fid := range []string{"s", vWeb} {
		if l := got[fid]; len(l) < 2 || l[0] != "asleep/waking" || l[len(l)-1] != "running" {
			t.Fatalf("floor %s went %v", fid, l)
		}
	}
	if i := slices.IndexFunc(evs, func(ev proto.Event) bool { return ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id }); i < 0 ||
		evs[i].Worker.Floor != vWeb {
		t.Fatalf("hired worker events = %+v", evs)
	}
	if got := storedFloors(t, hb.bridge); got[id] != vWeb {
		t.Fatalf("stored floors = %v", got)
	}
	// The wake is audited as the hire's floor.wake.
	if row := auditRow(t, hb.bridge, proto.CmdFloorWake); !row.OK || !row.Done {
		t.Fatalf("wake audit = %+v", row)
	}
}

// A hire whose wake fails fails with the wake's error and hires nothing.
func TestHireOnAsleepVirtualFloorWakeFails(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "", "idle"))
	sleepHireFloor(t, hb)
	hb.fl.fakeHerdr.startErr = errors.New("systemd-run: boom") // the session's start, not the agent's
	args := hireArgs(0)
	args.Session, args.Floor = "", vWeb
	_, m := hb.c.command(proto.CmdWorkerHire, "h", args)
	if e := errorOf(m); e.Code != proto.ErrWakeFailed || !strings.Contains(e.Message, "waking floor “Web” (session s) before the hire") ||
		!strings.Contains(e.Message, "boom") {
		t.Fatalf("hire = %s", m.raw)
	}
	if slices.ContainsFunc(hb.fl.Calls(), func(c string) bool { return strings.HasPrefix(c, "create ") }) {
		t.Fatalf("hired anyway: %v", hb.fl.Calls())
	}
	w := hb.connect(proto.Hello{}).snapshot().World
	if v, _ := floorByID(w, vWeb); v.State != "asleep" || v.Transition != "" {
		t.Fatalf("virtual floor = %+v", v)
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHire); row.OK || !strings.Contains(row.Error, "boom") {
		t.Fatalf("hire audit = %+v", row)
	}
}

// run.start on an asleep virtual floor wakes its session too.
func TestRunStartOnAsleepVirtualFloor(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t)
	c := hb.c
	_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "s"})
	id := ack.Data.(map[string]any)["id"].(string)
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Floor: id, Repo: proto.Some("JeffreyVdb/lab"),
		DefaultCwd: proto.Some("/home/u/lab")})
	sleepHireFloor(t, hb)
	orch := buildTeam.Orch
	if res := runPrepare(t, c, proto.RunPrepareArgs{Floor: id}); res.Preset == "" {
		t.Fatalf("run.prepare = %+v", res)
	}
	_, ack = c.mustAck(proto.CmdRunStart, proto.RunStartArgs{Floor: id, DeskIndex: ptr(0), Text: "go", Orch: &orch,
		Preset: w.Presets[0].ID})
	worker := ack.Data.(map[string]any)["id"].(string)
	if l, ok, err := hb.st.RunLaunchByWorker(context.Background(), worker); err != nil || !ok || l.FloorID != id {
		t.Fatalf("launch = %+v, %v, %v", l, ok, err)
	}
	if !slices.Contains(hb.fl.Calls(), "start s") {
		t.Fatalf("herdr calls = %v", hb.fl.Calls())
	}
}

// floor.hide stores a floor's hidden flag (decision 2) and every client
// hears of it; it survives a restart.
func TestFloorHide(t *testing.T) {
	t.Parallel()
	db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
	hb := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	other := hb.connect(proto.Hello{Client: "other"})
	other.snapshot()
	c.mustAck(proto.CmdFloorHide, proto.FloorHideArgs{Floor: "s", Hidden: true})
	if ev := other.until(proto.EvFloorUpsert); ev.Floor.ID != "s" || !ev.Floor.Hidden {
		t.Fatalf("other client: %+v", ev.Floor)
	}
	c.mustAck(proto.CmdFloorHide, proto.FloorHideArgs{Floor: vWeb, Hidden: true})
	c.mustAck(proto.CmdFloorHide, proto.FloorHideArgs{Floor: vWeb, Hidden: false})
	c.mustError(proto.CmdFloorHide, proto.FloorHideArgs{Floor: "nope", Hidden: true}, proto.ErrUnknownSession)
	c.mustError(proto.CmdFloorHide, proto.FloorHideArgs{Hidden: true}, proto.ErrBadRequest)
	if hidden, err := hb.st.HiddenFloors(context.Background()); err != nil || !hidden["s"] || hidden[vWeb] {
		t.Fatalf("stored = %v, %v", hidden, err)
	}
	hb.stop()
	again := startHireBridgeAt(t, db, nil, worker("w1", "CODE|a", "", "idle"))
	w := again.connect(proto.Hello{}).snapshot().World
	if f, _ := floorByID(w, "s"); !f.Hidden {
		t.Fatalf("after a restart: %+v", f)
	}
	if v, _ := floorByID(w, vWeb); v.Hidden {
		t.Fatalf("virtual floor after a restart: %+v", v)
	}
}

// floor.delete with move_workers: the virtual floor's workers go to the
// base session's real floor (its desks and names), running or asleep, and
// the store says so.
func TestDeleteVirtualFloorMovingWorkers(t *testing.T) {
	t.Parallel()
	for _, running := range []bool{true, false} {
		t.Run(fmt.Sprintf("running=%v", running), func(t *testing.T) {
			t.Parallel()
			db := seedFloors(t, map[string]string{vWeb: "Web"}, map[string]string{"u1": vWeb, "u2": vWeb, "u3": "s"})
			fh := newFakeHerdr()
			b := startBridge(t, db, fastOps(fh))
			b.floorAt("s", running, []world.WorkerObs{worker("w1", "CODE|a", "sess-u1", "idle"),
				worker("w2", "CODE|b", "sess-u2", "idle"), worker("w3", "CODE|c", "sess-u3", "idle")})
			c := b.connect(proto.Hello{})
			c.snapshot()
			evs, _ := c.mustAck(proto.CmdFloorDelete, proto.FloorDeleteArgs{Floor: vWeb, MoveWorkers: true})
			removed := slices.IndexFunc(evs, func(ev proto.Event) bool { return ev.T == proto.EvFloorRemoved && ev.FloorID == vWeb })
			moved := slices.IndexFunc(evs, func(ev proto.Event) bool {
				return ev.T == proto.EvWorkerUpsert && ev.Worker.ID == "u1" && ev.Worker.Floor == "s"
			})
			if removed < 0 || moved < 0 {
				t.Fatalf("events = %+v", evs)
			}
			w := b.connect(proto.Hello{}).snapshot().World
			if _, ok := floorByID(w, vWeb); ok {
				t.Fatal("the virtual floor is still there")
			}
			desks, names := map[int]bool{}, map[string]bool{}
			for _, id := range []string{"u1", "u2", "u3"} {
				wk, ok := workerByID(w, id)
				if !ok || wk.Floor != "s" || desks[wk.DeskIndex] || names[wk.Name] || wk.Name == "" {
					t.Fatalf("%s = %+v (desks %v, names %v)", id, wk, desks, names)
				}
				desks[wk.DeskIndex], names[wk.Name] = true, true
			}
			if got := storedFloors(t, b); got["u1"] != "s" || got["u2"] != "s" || got["u3"] != "s" {
				t.Fatalf("stored floors = %v", got)
			}
			if vs, _ := b.st.VirtualFloors(context.Background()); len(vs) != 0 {
				t.Fatalf("definitions = %+v", vs)
			}
		})
	}
}

// A handoff of a worker on a virtual floor is that floor's: its directory,
// its cabinet, its count, and handoff.added names it (floor_id).
func TestHandoffOnVirtualFloor(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "world.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateVirtualFloor(ctx, vWeb, "Web", "s"); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveWorker(ctx, store.Worker{ID: "u1", Session: "s", FloorID: vWeb,
		Fingerprints: []store.Fingerprint{{Kind: store.FPAgentSession, Value: wrapSess}}}); err != nil {
		t.Fatal(err)
	}
	st.Close()
	dir := filepath.Join(t.TempDir(), "handoff")
	svc := hoService(t, dir, db)
	off := false
	fb := startFuBridgeWith(t, db, "", newFuRoles(), &off, "", func(o *server.Options) {
		o.Handoffs = svc
		o.DigestEnabled, o.PackupEnabled, o.ActivityModel = &off, &off, &off
	})
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w1"]
	if id != "u1" {
		t.Fatalf("w1 is %q", id)
	}
	appendTo(t, fb.claude, wrapUser("Refactor the loader.")+claudeReply("msg_1", "u1", "# Loader\n\nDone.", "end_turn")+turnDone)
	w := handoffOf(c, id)
	if w.Floor != vWeb {
		t.Fatalf("worker floor %q", w.Floor)
	}
	cand := *w.Handoff
	evs, m := c.command(proto.CmdWorkerHandoff, "h", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral,
		Session: cand.Session, Candidate: cand.ID, Revision: cand.Revision, Op: "op-1"})
	res := ackData[proto.WorkerHandoffResult](t, m)
	if res.Handoff.Floor != vWeb || filepath.Dir(res.Handoff.Path) != filepath.Join(dir, vWeb) {
		t.Fatalf("handoff = %+v", res.Handoff)
	}
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvHandoffAdded && ev.FloorID == vWeb && ev.Session == "s" && *ev.HandoffCount == 1
	}) {
		t.Fatalf("events = %+v", evs)
	}
	_, m = c.command(proto.CmdHandoffList, "l", proto.HandoffListArgs{Floor: vWeb})
	if list := ackData[proto.HandoffListResult](t, m); len(list.Handoffs) != 1 {
		t.Fatalf("cabinet = %s", m.raw)
	}
	if counts := fb.connect(proto.Hello{}).snapshot().World.Handoffs.Counts; counts[vWeb] != 1 || counts["s"] != 0 {
		t.Fatalf("counts = %v", counts)
	}
}
