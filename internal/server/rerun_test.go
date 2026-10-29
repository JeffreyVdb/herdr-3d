package server_test

import (
	"context"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// "Run elsewhere": worker.hire's rerun_of is kept with the new worker, in
// its view and its stored record; the world says the bridge takes it.
func TestHireRerunOf(t *testing.T) {
	hb := startHireBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	if w := hb.world(func(w proto.World) bool { return len(w.Workers) == 1 }); !w.Rerun {
		t.Fatalf("world.rerun = false")
	}
	c.mustError(proto.CmdWorkerHire, func() proto.WorkerHireArgs {
		a := hireArgs(3)
		a.RerunOf = strings.Repeat("x", 129)
		return a
	}(), proto.ErrBadRequest)

	args := hireArgs(3)
	args.Prompt, args.Cwd, args.RerunOf = "Read CONTRIBUTING.md", "/home/u/repo", "w1"
	evs, m := c.command(proto.CmdWorkerHire, "h1", args)
	res := ackData[proto.HireResult](t, m)
	var first *proto.Worker
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == res.ID && first == nil {
			first = ev.Worker
		}
	}
	if first == nil || first.RerunOf != "w1" {
		t.Fatalf("hired worker = %+v", first)
	}
	// Reconciled by its marker, it keeps it; so does its stored record.
	w := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")["w2"].ID == res.ID }), "s")["w2"]
	if w.RerunOf != "w1" {
		t.Fatalf("worker after the hire = %+v", w)
	}
	if o := workersOf(hb.world(func(proto.World) bool { return true }), "s")["w1"]; o.RerunOf != "" {
		t.Fatalf("the original = %+v", o)
	}
	recs, err := hb.st.SessionWorkers(context.Background(), "s")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range recs {
		if r.ID == res.ID {
			found = true
			if r.RerunOf != "w1" {
				t.Fatalf("stored = %+v", r)
			}
		}
	}
	if !found {
		t.Fatalf("no stored record for %s: %+v", res.ID, recs)
	}
}
