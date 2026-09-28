package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func TestWorkerEvents(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	if s := c.snapshot(); len(s.World.Floors) != 0 {
		t.Fatalf("empty world expected, got %+v", s.World)
	}

	b.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "idle"), worker("w2", "notes", "", "unknown"))
	evs := c.events(3)
	if evs[0].T != proto.EvFloorUpsert || evs[0].Floor.State != world.Running || evs[0].Floor.Building != nil {
		t.Fatalf("first event = %+v", evs[0])
	}
	if evs[1].T != proto.EvWorkerUpsert || evs[1].Worker.Label != "CODE|x|1|r1" || evs[2].Worker.WorkspaceID != "w2" {
		t.Fatalf("worker events = %+v", evs[1:])
	}
	w1, w2 := evs[1].Worker.ID, evs[2].Worker.ID

	// Status only: worker.status with the previous status.
	b.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "working"), worker("w2", "notes", "", "unknown"))
	if ev := c.event(); ev.T != proto.EvWorkerStatus || ev.ID != w1 || ev.Status != "working" || ev.PrevStatus != "idle" || ev.WorkspaceID != "w1" {
		t.Fatalf("status event = %+v", ev)
	}
	// Anything else: a full upsert with the same id.
	b.floor("s", true, worker("w1", "CODE|x|1|r2", "sess-1", "working"), worker("w2", "notes", "", "unknown"))
	if ev := c.event(); ev.T != proto.EvWorkerUpsert || ev.Worker.ID != w1 || ev.Worker.Label != "CODE|x|1|r2" {
		t.Fatalf("upsert event = %+v", ev)
	}
	// Workspace closed while we watched: removed, and recorded as closed.
	b.floor("s", true, worker("w1", "CODE|x|1|r2", "sess-1", "working"))
	if ev := c.event(); ev.T != proto.EvWorkerRemoved || ev.ID != w2 || ev.Session != "s" || ev.WorkspaceID != "w2" {
		t.Fatalf("removed event = %+v", ev)
	}
	// Session stops: the floor goes to sleep, the worker stays.
	b.floor("s", false, worker("w1", "CODE|x|1|r2", "sess-1", "unknown"))
	evs = c.events(2)
	if evs[0].T != proto.EvFloorUpsert || evs[0].Floor.State != world.Asleep {
		t.Fatalf("floor event = %+v", evs[0])
	}
	if evs[1].T != proto.EvWorkerStatus || evs[1].ID != w1 || evs[1].Status != "unknown" {
		t.Fatalf("sleep status event = %+v", evs[1])
	}
	// The session is deleted.
	b.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
	evs = c.events(2)
	if evs[0].T != proto.EvWorkerRemoved || evs[0].ID != w1 || evs[1].T != proto.EvFloorRemoved || evs[1].Session != "s" {
		t.Fatalf("gone events = %+v", evs)
	}

	ws, err := b.st.SessionWorkers(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	closed := map[string]bool{}
	for _, w := range ws {
		closed[w.ID] = w.Closed
	}
	if !closed[w2] || closed[w1] {
		t.Fatalf("closed = %v (w1 %s, w2 %s)", closed, w1, w2)
	}
}

func TestStaleObservationIgnored(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	old, cur := world.NextGen(), world.NextGen()
	b.publish(world.FloorObs{Session: "s", Running: false, Gen: cur})
	c.until(proto.EvFloorUpsert)
	b.publish(world.FloorObs{Session: "s", Running: true, Gen: old, Workers: []world.WorkerObs{worker("w1", "x", "", "idle")}})
	b.publish(world.FloorObs{Session: "marker", Running: false, Gen: world.NextGen()})
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Session != "marker" {
		t.Fatalf("stale observation was applied: %+v", ev)
	}
}

func TestKeepWorkers(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, worker("w1", "x", "", "idle"))
	c.events(2)
	b.publish(world.FloorObs{Session: "s", Running: true, Gen: world.NextGen(), Fresh: true, KeepWorkers: true, Err: "herdr: boom"})
	if ev := c.event(); ev.T != proto.EvFloorUpsert || ev.Floor.Error != "herdr: boom" {
		t.Fatalf("event = %+v", ev)
	}
	c2 := b.connect(proto.Hello{})
	if s := c2.snapshot(); len(s.World.Workers) != 1 {
		t.Fatalf("workers dropped: %+v", s.World.Workers)
	}
}

func TestSnapshotPlacesFloorsInBuildingsInOrder(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	for _, s := range []string{"zeta", "alpha", "herdr-3d", "infra", "mid"} {
		b.floor(s, s != "mid", worker("w1", s+"-worker", "", "idle"))
	}
	c := b.connect(proto.Hello{})
	c.snapshot()
	work := createBuilding(c, "Work")
	home := createBuilding(c, "Personal")
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "infra", Building: &work})
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "herdr-3d", Building: &work, Index: ptr(0)})
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "zeta", Building: &home})
	c.mustAck(proto.CmdBuildingReorder, proto.BuildingReorderArgs{IDs: []string{home, work}})

	s := b.connect(proto.Hello{}).snapshot().World
	if len(s.Buildings) != 2 || s.Buildings[0].ID != home || s.Buildings[1].ID != work {
		t.Fatalf("buildings = %+v", s.Buildings)
	}
	if !slices.Equal(s.Buildings[1].Floors, []string{"herdr-3d", "infra"}) || !slices.Equal(s.Buildings[0].Floors, []string{"zeta"}) {
		t.Fatalf("building floors = %+v", s.Buildings)
	}
	if !slices.Equal(s.Unassigned, []string{"alpha", "mid"}) {
		t.Fatalf("unassigned = %v", s.Unassigned)
	}
	var order []string
	for _, f := range s.Floors {
		order = append(order, f.Session)
	}
	if !slices.Equal(order, []string{"zeta", "herdr-3d", "infra", "alpha", "mid"}) {
		t.Fatalf("floor order = %v", order)
	}
	if f := s.Floors[2]; *f.Building != work || *f.Index != 1 || f.State != world.Running {
		t.Fatalf("infra = %+v", f)
	}
	if f := s.Floors[4]; f.Building != nil || f.Index != nil || f.State != world.Asleep {
		t.Fatalf("mid = %+v", f)
	}
	var wOrder []string
	for _, w := range s.Workers {
		wOrder = append(wOrder, w.Session)
	}
	if !slices.Equal(wOrder, order) {
		t.Fatalf("workers are not in floor order: %v", wOrder)
	}
}

func TestCommands(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	b.floor("s1", true)
	b.floor("s2", false)
	c := b.connect(proto.Hello{Client: "cmd-test"})
	c.snapshot()

	evs, ack := c.mustAck(proto.CmdBuildingCreate, proto.BuildingCreateArgs{Name: "Work"})
	id := ack.Data.(map[string]any)["id"].(string)
	if len(evs) != 1 || evs[0].T != proto.EvBuildingUpsert || evs[0].Building.ID != id || evs[0].Building.Name != "Work" {
		t.Fatalf("create events = %+v", evs)
	}
	c.mustError(proto.CmdBuildingCreate, proto.BuildingCreateArgs{Name: "work"}, proto.ErrNameTaken)
	c.mustError(proto.CmdBuildingCreate, map[string]any{"name": "X", "colour": "red"}, proto.ErrBadRequest)
	c.mustError(proto.CmdBuildingCreate, proto.BuildingCreateArgs{Name: ""}, proto.ErrBadRequest)
	c.mustError(proto.CmdBuildingRename, proto.BuildingRenameArgs{ID: "b_nope", Name: "X"}, proto.ErrNotFound)
	c.mustError(proto.CmdBuildingDelete, proto.BuildingDeleteArgs{ID: "b_nope"}, proto.ErrNotFound)
	c.mustError(proto.CmdBuildingReorder, proto.BuildingReorderArgs{IDs: []string{}}, proto.ErrBadRequest)
	c.mustError(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "nope", Building: &id}, proto.ErrUnknownSession)
	c.mustError(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "s1", Building: ptr("b_nope")}, proto.ErrNotFound)

	evs, _ = c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "s2", Building: &id})
	if len(evs) != 2 || evs[0].T != proto.EvFloorUpsert || *evs[0].Floor.Building != id || evs[1].T != proto.EvBuildingUpsert ||
		!slices.Equal(evs[1].Building.Floors, []string{"s2"}) {
		t.Fatalf("assign events = %+v", evs)
	}
	evs, _ = c.mustAck(proto.CmdBuildingRename, proto.BuildingRenameArgs{ID: id, Name: "Office"})
	if len(evs) != 1 || evs[0].Building.Name != "Office" {
		t.Fatalf("rename events = %+v", evs)
	}
	evs, _ = c.mustAck(proto.CmdBuildingDelete, proto.BuildingDeleteArgs{ID: id})
	if len(evs) != 2 || evs[0].T != proto.EvFloorUpsert || evs[0].Floor.Building != nil || evs[1].T != proto.EvBuildingRemoved || evs[1].ID != id {
		t.Fatalf("delete events = %+v", evs)
	}

	// Unknown commands and malformed messages are rejected, and the
	// connection stays usable.
	c.mustError("worker.prompt", map[string]any{"id": "x"}, proto.ErrUnknownCommand)
	c.mustError("herdr.workspace.close", nil, proto.ErrUnknownCommand)
	c.send(map[string]any{"t": proto.CmdBuildingCreate, "args": map[string]any{"name": "NoReq"}})
	if m := c.next(); m.env.T != proto.TError || !strings.Contains(string(m.raw), proto.ErrBadRequest) {
		t.Fatalf("missing req_id: %s", m.raw)
	}
	c.send(proto.Hello{T: proto.THello, Proto: 1})
	if m := c.next(); m.env.T != proto.TError {
		t.Fatalf("second hello: %s", m.raw)
	}
	createBuilding(c, "Still works")

	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, e := range log {
		if e.Client != "cmd-test" {
			t.Fatalf("audit client = %q", e.Client)
		}
		cmds = append(cmds, e.Cmd)
	}
	if len(log) != 14 || log[0].Cmd != proto.CmdBuildingCreate || !log[0].OK || log[1].OK ||
		log[12].Cmd != proto.CmdBuildingCreate || log[12].Error != "commands need a req_id" {
		t.Fatalf("audit log = %v", cmds)
	}
}

// A known command without req_id is rejected like before, and audited
// like every other rejection; an unknown one is not a command.
func TestCommandWithoutReqIDIsAudited(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	b.floor("s", true)
	c := b.connect(proto.Hello{Client: "no-req"})
	c.snapshot()
	sent := []string{
		`{"t":"floor.sleep","args":{"session":"s"}}`,
		`{"t":"floor.wake","args":{"session":"s"}}`,
		`{"t":"floor.settings.set","args":{"session":"s","repo":"o/r"}}`,
		`{"t":"building.create","req_id":"","args":{"name":"NoReq"}}`,
		`{"t":"worker.prompt","args":{}}`,
	}
	for _, raw := range sent {
		c.send(json.RawMessage(raw))
		m := c.next()
		e := errorOf(m)
		want := proto.Error{T: proto.TError, Code: proto.ErrBadRequest, Message: "commands need a req_id"}
		if strings.Contains(raw, "worker.prompt") {
			want = proto.Error{T: proto.TError, Code: proto.ErrUnknownCommand, Message: `unknown command "worker.prompt"`}
		}
		if e != want {
			t.Fatalf("%s: reply %s, want %+v", raw, m.raw, want)
		}
	}
	createBuilding(c, "Still works")

	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows []string
	for _, e := range log {
		rows = append(rows, fmt.Sprintf("%s %s ok=%v done=%v %s %s", e.Client, e.Cmd, e.OK, e.Done, e.Error, e.Args))
	}
	want := []string{
		`no-req floor.sleep ok=false done=true commands need a req_id {"session":"s"}`,
		`no-req floor.wake ok=false done=true commands need a req_id {"session":"s"}`,
		`no-req floor.settings.set ok=false done=true commands need a req_id {"session":"s","repo":"o/r"}`,
		`no-req building.create ok=false done=true commands need a req_id {"name":"NoReq"}`,
		`no-req building.create ok=true done=true  {"name":"Still works"}`,
	}
	if !slices.Equal(rows, want) {
		t.Fatalf("audit =\n%s\nwant\n%s", strings.Join(rows, "\n"), strings.Join(want, "\n"))
	}
	if all, err := b.st.FloorSettings(context.Background()); err != nil || len(all) != 0 {
		t.Fatalf("a command without req_id was applied: %+v %v", all, err)
	}
}

func TestHelloRequired(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	for name, first := range map[string]any{
		"command first": proto.Command{T: proto.CmdBuildingCreate, ReqID: "1"},
		"proto 2":       proto.Hello{T: proto.THello, Proto: 2},
		"garbage":       "hello?",
	} {
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			conn, err := proto.Dial(ctx, b.sock)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if err := conn.Send(ctx, first); err != nil {
				t.Fatal(err)
			}
			env, raw, err := conn.Read(ctx)
			if err != nil || env.T != proto.TError {
				t.Fatalf("got %s, %v", raw, err)
			}
			if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("connection not closed with policy violation: %v", err)
			}
		})
	}
}

func TestReplaySinceSeq(t *testing.T) {
	b := startBridge(t, "", server.Options{Ring: 16})
	b.floor("s", true, worker("w1", "a", "", "idle"))
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, worker("w1", "a", "", "working"))
	c.event()
	epoch, last := c.welcome.Epoch, c.seq
	c.conn.CloseNow()

	// Missed while away: three status flips.
	for _, st := range []string{"idle", "working", "blocked"} {
		b.floor("s", true, worker("w1", "a", "", st))
	}
	// Wait until the hub applied them (a new client sees them in its snapshot).
	for b.connect(proto.Hello{}).snapshot().Seq != last+3 {
		time.Sleep(10 * time.Millisecond)
	}

	r := b.connect(proto.Hello{SinceSeq: &last, Epoch: epoch})
	if r.welcome.Resume != proto.ResumeReplay || r.welcome.ServerSeq != last+3 {
		t.Fatalf("welcome = %+v", r.welcome)
	}
	r.seq = last
	var got []string
	for _, ev := range r.events(3) {
		got = append(got, ev.Status)
	}
	if !slices.Equal(got, []string{"idle", "working", "blocked"}) {
		t.Fatalf("replayed = %v", got)
	}
	// Then live events continue seamlessly.
	b.floor("s", true, worker("w1", "a", "", "done"))
	if ev := r.event(); ev.Status != "done" || ev.Seq != last+4 {
		t.Fatalf("live after replay = %+v", ev)
	}

	// Caught up exactly: replay of nothing.
	cur := r.seq
	if w := b.connect(proto.Hello{SinceSeq: &cur, Epoch: epoch}).welcome; w.Resume != proto.ResumeReplay {
		t.Fatalf("up-to-date client got %+v", w)
	}

	// Anything the ring cannot prove complete gets a fresh snapshot.
	for i := 0; i < 20; i++ {
		b.floor("s", true, worker("w1", "a", "", []string{"idle", "working"}[i%2]))
	}
	for b.connect(proto.Hello{}).snapshot().Seq != cur+20 {
		time.Sleep(10 * time.Millisecond)
	}
	future := cur + 1000
	for name, hello := range map[string]proto.Hello{
		"too old":     {SinceSeq: &last, Epoch: epoch},
		"other epoch": {SinceSeq: &cur, Epoch: "0000000000000000"},
		"no epoch":    {SinceSeq: &cur},
		"future":      {SinceSeq: &future, Epoch: epoch},
	} {
		c := b.connect(hello)
		if c.welcome.Resume != proto.ResumeSnapshot {
			t.Fatalf("%s: welcome = %+v", name, c.welcome)
		}
		if s := c.snapshot(); s.Seq != cur+20 || len(s.World.Workers) != 1 {
			t.Fatalf("%s: snapshot seq %d", name, s.Seq)
		}
	}
}

func TestPersistsAcrossRestart(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	b.floor("a", true, worker("w1", "ORCH|x", "sess-1", "idle"), worker("w2", "notes", "", "unknown"))
	b.floor("b", false)
	b.floor("c", false)
	c := b.connect(proto.Hello{})
	before := c.snapshot().World
	work := createBuilding(c, "Work")
	createBuilding(c, "Personal")
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "c", Building: &work})
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "a", Building: &work, Index: ptr(0)})
	b.stop()

	b2 := startBridge(t, db, server.Options{})
	if b2.hub.Epoch() == b.hub.Epoch() {
		t.Fatal("epoch must change across restarts")
	}
	// A restarted herdr may even hand out different workspace ids.
	b2.floor("a", true, worker("w7", "ORCH|x", "sess-1", "working"), worker("w2", "notes", "", "unknown"))
	b2.floor("b", false)
	b2.floor("c", false)
	c2 := b2.connect(proto.Hello{})
	var after proto.World
	for {
		after = c2.snapshot().World
		if len(after.Floors) == 3 && len(after.Workers) == 2 {
			break
		}
		c2 = b2.connect(proto.Hello{})
	}
	if len(after.Buildings) != 2 || after.Buildings[0].Name != "Work" || !slices.Equal(after.Buildings[0].Floors, []string{"a", "c"}) {
		t.Fatalf("buildings after restart = %+v", after.Buildings)
	}
	if !slices.Equal(after.Unassigned, []string{"b"}) {
		t.Fatalf("unassigned after restart = %v", after.Unassigned)
	}
	ids := map[string]string{}
	for _, w := range before.Workers {
		ids[w.Label] = w.ID
	}
	for _, w := range after.Workers {
		if ids[w.Label] != w.ID {
			t.Errorf("%s: id %s after restart, was %s", w.Label, w.ID, ids[w.Label])
		}
	}
}

func TestSlowClientIsDropped(t *testing.T) {
	b := startBridge(t, "", server.Options{Queue: 64})
	b.floor("s", true, worker("w1", "a", "", "idle"))
	slow := b.connect(proto.Hello{Client: "slow"}) // never reads
	fast := b.connect(proto.Hello{Client: "fast"})
	fast.snapshot()
	// Big messages so the slow client's socket buffer fills quickly.
	title := strings.Repeat("x", 4096)
	for i := range 600 {
		w := worker("w1", "a", "", "idle")
		w.Title = title + string(rune('a'+i%26))
		b.floor("s", true, w)
		if i%32 == 31 {
			fast.events(32) // keep the fast client well inside its queue
		}
	}
	// The fast client got everything; the slow one was cut off.
	for fast.seq < b.connect(proto.Hello{}).welcome.ServerSeq {
		fast.event()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var err error
	for err == nil {
		_, _, err = slow.conn.Read(ctx)
	}
	var ce websocket.CloseError
	if !errors.As(err, &ce) || ce.Code != websocket.StatusPolicyViolation || ce.Reason != server.ErrSlowConsumer.Error() {
		t.Fatalf("slow client ended with %v, want policy violation %q", err, server.ErrSlowConsumer)
	}
}
