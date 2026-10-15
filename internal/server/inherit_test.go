package server_test

import (
	"context"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/runs"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #58 stage 3: freelancers land on their orchestrator's floor, and an
// h3d_floor token places a workspace nobody attributed.

const (
	vAPI       = "v-ba9876543210"
	vOther     = "v-0000000000ff" // a virtual floor on session "t"
	inheritRun = "20261015-1349-lobby"
)

// seedInherit is seedFloors plus workers stored with every field (a hired
// one has HiredAt) and a virtual floor vOther on session "t".
func seedInherit(t *testing.T, floors, workers map[string]string, more ...store.Worker) string {
	t.Helper()
	db := seedFloors(t, floors, workers)
	ctx := context.Background()
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if _, err := st.CreateVirtualFloor(ctx, vOther, "Other", "t"); err != nil {
		t.Fatal(err)
	}
	for _, w := range more {
		if err := st.SaveWorker(ctx, w); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

// hired is a stored worker the bridge hired on floor.
func hired(id, floor string) store.Worker {
	return store.Worker{ID: id, Session: "s", FloorID: floor, WorkspaceID: id, HiredAt: 1,
		Fingerprints: []store.Fingerprint{{Kind: store.FPAgentSession, Value: "sess-" + id}}}
}

// upsertOf reads events until the next worker.upsert of the worker on ws.
func upsertOf(c *client, ws string) proto.Worker {
	c.t.Helper()
	for {
		if ev := c.event(); ev.T == proto.EvWorkerUpsert && ev.Worker.WorkspaceID == ws {
			return *ev.Worker
		}
	}
}

// A freelancer first seen without its run is on the real floor (and
// stored there); once its run links it to an orchestrator on a virtual
// floor it is on that floor from the same observation, stored there, and
// stays there after a restart that dropped its tokens.
func TestFreelancerInheritsItsOrchestratorsFloor(t *testing.T) {
	t.Parallel()
	db := seedInherit(t, map[string]string{vWeb: "Web"}, map[string]string{"o": vWeb})
	b := startBridge(t, db, server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	orch := runWorker("o", "ORCH|lobby", runTokens("orch", inheritRun))
	b.floor("s", true, orch, runWorker("f", "f", nil))
	f := b.world(func(w proto.World) bool { return workersOf(w, "s")["f"].ID != "" })
	fl := workersOf(f, "s")["f"]
	if fl.Floor != "s" {
		t.Fatalf("unlinked freelancer = %+v", fl)
	}
	if got := storedFloors(t, b); got[fl.ID] != "s" {
		t.Fatalf("stored floors before the link = %v", got)
	}

	c = b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, orch, runWorker("f", "CODE|lobby|3|r1", runTokens("code", inheritRun, "h3d_round", "1")))
	up := upsertOf(c, "f")
	if up.Floor != vWeb || up.OrchID != "o" || up.Session != "s" {
		t.Fatalf("linked freelancer's first upsert = %+v", up)
	}
	if got := storedFloors(t, b); got[fl.ID] != vWeb {
		t.Fatalf("stored floors after the link = %v", got)
	}

	// herdr restarted: no tokens, a label that links nobody.
	b.stop()
	again := startBridge(t, db, server.Options{})
	again.floor("s", true, runWorker("o", "ORCH|lobby", nil), runWorker("f", "f", nil))
	w := again.world(func(w proto.World) bool { return workersOf(w, "s")["f"].ID != "" })
	if got := workersOf(w, "s")["f"]; got.ID != fl.ID || got.Floor != vWeb {
		t.Fatalf("after a restart = %+v (was %s)", got, fl.ID)
	}
}

// A freelancer seen together with its orchestrator for the first time is on
// the orchestrator's floor in its very first upsert.
func TestNewFreelancerStartsOnItsOrchestratorsFloor(t *testing.T) {
	t.Parallel()
	db := seedInherit(t, map[string]string{vWeb: "Web"}, map[string]string{"o": vWeb})
	b := startBridge(t, db, server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, runWorker("o", "ORCH|lobby", runTokens("orch", inheritRun)),
		runWorker("f", "CODE|lobby|3|r1", runTokens("code", inheritRun)))
	if up := upsertOf(c, "f"); up.Floor != vWeb || up.OrchID != "o" {
		t.Fatalf("first upsert = %+v", up)
	}
	w := b.connect(proto.Hello{}).snapshot().World
	o, f := workersOf(w, "s")["o"], workersOf(w, "s")["f"]
	if o.Floor != vWeb || f.Floor != vWeb || f.DeskIndex/runs.PodSize != o.DeskIndex/runs.PodSize {
		t.Fatalf("orch = %+v, freelancer = %+v", o, f)
	}
}

// An orchestrator nothing attributed that tags itself h3d_floor is on that
// floor, and so is its freelancer, listed before it, in the same
// observation.
func TestFreelancerFollowsATaggedOrchestrator(t *testing.T) {
	t.Parallel()
	db := seedInherit(t, map[string]string{vWeb: "Web"}, nil)
	b := startBridge(t, db, server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, runWorker("f", "CODE|lobby|3|r1", runTokens("code", inheritRun)),
		runWorker("o", "ORCH|lobby", runTokens("orch", inheritRun, "h3d_floor", vWeb)))
	if up := upsertOf(c, "f"); up.Floor != vWeb {
		t.Fatalf("freelancer's first upsert = %+v", up)
	}
	w := b.connect(proto.Hello{}).snapshot().World
	if o, f := workersOf(w, "s")["o"], workersOf(w, "s")["f"]; o.Floor != vWeb || f.Floor != vWeb || f.OrchID != o.ID {
		t.Fatalf("orch = %+v, freelancer = %+v", o, f)
	}
}

// An attributed worker keeps its floor whatever its run links it to: one
// the bridge hired (on the real floor too) and one stored on another
// virtual floor. Nor does a link to an orchestrator of another session
// move anyone.
func TestInheritanceNeverOverridesAnAttributedFloor(t *testing.T) {
	t.Parallel()
	db := seedInherit(t, map[string]string{vWeb: "Web", vAPI: "API"}, map[string]string{"o": vWeb, "a": vAPI},
		hired("h", "s"))
	b := startBridge(t, db, server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("t", true, runWorker("ot", "ORCH|elsewhere", runTokens("orch", "20261015-1349-other")))
	b.floor("s", true,
		runWorker("o", "ORCH|lobby", runTokens("orch", inheritRun)),
		runWorker("h", "CODE|lobby|1|r1", runTokens("code", inheritRun)),
		runWorker("a", "REVIEW|lobby|1|r1", runTokens("review", inheritRun)),
		runWorker("x", "CODE|other|1|r1", runTokens("code", "20261015-1349-other")))
	w := b.world(func(w proto.World) bool {
		ws := workersOf(w, "s")
		return ws["h"].OrchID != "" && ws["a"].OrchID != "" && ws["x"].OrchID != ""
	})
	ws := workersOf(w, "s")
	if ws["h"].Floor != "s" || ws["a"].Floor != vAPI || ws["x"].Floor != "s" {
		t.Fatalf("hired = %+v, on API = %+v, other session's run = %+v", ws["h"], ws["a"], ws["x"])
	}
	if got := storedFloors(t, b); got["h"] != "s" || got["a"] != vAPI || got[ws["x"].ID] != "s" {
		t.Fatalf("stored floors = %v", got)
	}
}

// An h3d_floor token places a workspace nobody attributed on the floor it
// names when that floor is on the workspace's session, and the floor is
// stored; any other token is ignored.
func TestFloorToken(t *testing.T) {
	t.Parallel()
	db := seedInherit(t, map[string]string{vWeb: "Web", vAPI: "API"}, map[string]string{"a": vAPI}, hired("h", "s"))
	b := startBridge(t, db, server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("t", true)
	tok := func(floor string) map[string]string { return map[string]string{"h3d_floor": floor} }
	b.floor("s", true,
		runWorker("good", "tui", tok(vWeb)),
		runWorker("real", "tui", tok("s")),
		runWorker("unknown", "tui", tok("v-00000000dead")),
		runWorker("othersv", "tui", tok(vOther)),
		runWorker("others", "tui", tok("t")),
		runWorker("h", "tui", tok(vWeb)),
		runWorker("a", "tui", tok(vWeb)))
	w := b.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 7 })
	ws := workersOf(w, "s")
	want := map[string]string{"good": vWeb, "real": "s", "unknown": "s", "othersv": "s", "others": "s", "h": "s", "a": vAPI}
	stored := storedFloors(t, b)
	for wsID, floor := range want {
		if got := ws[wsID]; got.Floor != floor || stored[got.ID] != floor {
			t.Errorf("%s = %+v, stored %q; want floor %q", wsID, got, stored[got.ID], floor)
		}
	}
	// Honoured once, it is an attribution: a later token does not move it.
	b.floor("s", true, runWorker("good", "tui", tok(vAPI)))
	w = b.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 })
	if got := workersOf(w, "s")["good"]; got.Floor != vWeb {
		t.Fatalf("after a second token = %+v", got)
	}
}

// run.start on a virtual floor: the orchestrator's freelancers land on that
// floor (its launch record names it).
func TestRunStartFreelancersOnItsVirtualFloor(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t)
	c := hb.c
	_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: "s"})
	floor := ack.Data.(map[string]any)["id"].(string)
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Floor: floor, Repo: proto.Some("JeffreyVdb/lab"),
		DefaultCwd: proto.Some("/home/u/lab")})
	orch := buildTeam.Orch
	// The prompt names the floor (a hint for the orchestrator).
	if res := runPrepare(t, c, proto.RunPrepareArgs{Floor: floor, Text: "go"}); !strings.Contains(res.Prompt, "h3d_floor="+floor+",") {
		t.Fatalf("prompt = %q", res.Prompt)
	}
	_, ack = c.mustAck(proto.CmdRunStart, proto.RunStartArgs{Floor: floor, DeskIndex: ptr(0), Text: "go", Orch: &orch,
		Preset: w.Presets[0].ID})
	id := ack.Data.(map[string]any)["id"].(string)
	var orchWS string
	for _, wk := range hb.connect(proto.Hello{}).snapshot().World.Workers {
		if wk.ID == id {
			orchWS = wk.WorkspaceID
		}
	}
	// The orchestrator tags itself; it starts a coder that tags itself too.
	hb.fl.update(orchWS, func(o *world.WorkerObs) {
		o.Tokens = runTokens("orch", inheritRun)
		o.Role, o.Run = world.RoleRun(o.Label, o.Tokens)
	})
	hb.fl.mu.Lock()
	hb.fl.workers = append(hb.fl.workers, runWorker("wf", "CODE|go|1|r1", runTokens("code", inheritRun)))
	hb.fl.mu.Unlock()
	hb.fl.publish()
	got := hb.world(func(w proto.World) bool { return workersOf(w, "s")["wf"].OrchID == id })
	if f := workersOf(got, "s")["wf"]; f.Floor != floor {
		t.Fatalf("freelancer = %+v", f)
	}
	if l, ok, err := hb.st.RunLaunchByWorker(context.Background(), id); err != nil || !ok || l.FloorID != floor {
		t.Fatalf("launch = %+v, %v, %v", l, ok, err)
	}
}
