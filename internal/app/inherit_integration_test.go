//go:build integration

package app

import (
	"encoding/json"
	"os/exec"
	"regexp"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TestIntegrationFreelancerInheritsFloor (#58 stage 3) runs a write-code
// run on a virtual floor of a throwaway session, as the orchestrator's
// agent would make it: plain `herdr workspace create` and `report-metadata`
// tokens. No agent starts (noAgent).
//
//   - the orchestrator is hired on the virtual floor and tags itself;
//   - a freelancer workspace is on the real floor until it reports its run,
//     then on the virtual floor;
//   - a workspace tagged only h3d_floor=<the virtual floor> is on it;
//   - herdr restarts (sleep and wake: every token gone) and the bridge
//     restarts: both are still on the virtual floor.
func TestIntegrationFreelancerInheritsFloor(t *testing.T) {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run is not installed")
	}
	s := startThrowaway(t)
	wakeUnitCleanup(t, s)
	cwd := t.TempDir()
	vb := newVFBridge(t, s, regexp.MustCompile("^"+regexp.QuoteMeta(s.name)+"$"))
	b := vb.conn
	const run = "20261015-1349-lobby"

	var v proto.Floor
	b.ack(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: s.name}, 15*time.Second, &v)
	desk := 0
	var orch proto.HireResult
	b.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Floor: v.ID, DeskIndex: &desk, Harness: "claude", Model: cheapClaude,
		Effort: "low", Label: "Orchy", Cwd: cwd}, 2*time.Minute, &orch)
	tag := func(ws string, tokens ...string) {
		t.Helper()
		args := []string{"--session", s.name, "workspace", "report-metadata", ws, "--source", "write-code"}
		for _, tok := range tokens {
			args = append(args, "--token", tok)
		}
		s.run(args...)
	}
	create := func(label string) string {
		t.Helper()
		var created struct {
			Result struct {
				Workspace struct {
					WorkspaceID string `json:"workspace_id"`
				} `json:"workspace"`
			} `json:"result"`
		}
		if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"),
			&created); err != nil {
			t.Fatal(err)
		}
		return created.Result.Workspace.WorkspaceID
	}
	labelled := func(label string) func(proto.Worker) bool {
		return func(wk proto.Worker) bool { return wk.Label == label }
	}
	tag(orch.WorkspaceID, "h3d_role=orch", "h3d_run="+run)

	// The freelancer, before and after it reports its run.
	coder := create("coder")
	w := vb.world("the untagged freelancer", 15*time.Second, func(w proto.World) bool {
		_, ok := workerIn(w, labelled("coder"))
		return ok
	})
	if wk, _ := workerIn(w, labelled("coder")); wk.Floor != s.name {
		t.Fatalf("untagged freelancer = %+v", wk)
	}
	tag(coder, "h3d_role=code", "h3d_run="+run, "h3d_round=1")
	w = vb.world("the freelancer linked", 15*time.Second, func(w proto.World) bool {
		wk, _ := workerIn(w, labelled("coder"))
		return wk.OrchID == orch.ID
	})
	if wk, _ := workerIn(w, labelled("coder")); wk.Floor != v.ID {
		t.Fatalf("linked freelancer = %+v", wk)
	}

	// A workspace that only names its floor.
	tag(create("hinted"), "h3d_floor="+v.ID)
	w = vb.world("the hinted workspace", 15*time.Second, func(w proto.World) bool {
		wk, ok := workerIn(w, labelled("hinted"))
		return ok && wk.Tokens["h3d_floor"] != ""
	})
	if wk, _ := workerIn(w, labelled("hinted")); wk.Floor != v.ID {
		t.Fatalf("hinted workspace = %+v", wk)
	}

	check := func(when string) {
		t.Helper()
		w := vb.world(when, 20*time.Second, func(w proto.World) bool {
			_, coderOK := workerIn(w, labelled("coder"))
			_, hintedOK := workerIn(w, labelled("hinted"))
			return coderOK && hintedOK && settled("running", s.name, v.ID)(w)
		})
		c, _ := workerIn(w, labelled("coder"))
		h, _ := workerIn(w, labelled("hinted"))
		if c.Floor != v.ID || h.Floor != v.ID || len(c.Tokens) != 0 || len(h.Tokens) != 0 {
			t.Fatalf("%s: coder %+v, hinted %+v", when, c, h)
		}
	}
	b.ack(proto.CmdFloorSleep, proto.FloorArgs{Floor: s.name}, time.Minute, nil)
	vb.world("both floors asleep", 15*time.Second, settled("asleep", s.name, v.ID))
	b.ack(proto.CmdFloorWake, proto.FloorArgs{Floor: s.name}, time.Minute, nil)
	check("after a herdr restart")
	vb.stop()
	vb.start()
	check("after a bridge restart")
}
