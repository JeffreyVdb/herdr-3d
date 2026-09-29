package server_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// A run's issue is on the wire in the neutral form too: Worker.work_item,
// present whenever issue is, built by the floor's issue provider.
func TestWorkerWorkItem(t *testing.T) {
	bb := startBoardBridge(t, nil,
		runWorker("o", "ORCH|demo", runTokens("orch", "run-1")),
		runWorker("c", "CODE|demo|7|r1", runTokens("code", "run-1")),
		worker("p", "plain", "", "idle"))
	bb.fb.repo("JeffreyVdb/lab")
	bb.link("JeffreyVdb/lab")
	w := bb.world(func(w proto.World) bool { return workersOf(w, "s")["o"].Issue != nil })
	ws := workersOf(w, "s")
	want := &proto.WorkItemRef{Provider: "fake", ID: "JeffreyVdb/lab#7"}
	for _, id := range []string{"o", "c"} {
		got := ws[id]
		if got.WorkItem == nil || *got.WorkItem != *want || got.Issue == nil || got.Issue.Repo != "JeffreyVdb/lab" || got.Issue.Number != 7 {
			t.Errorf("%s: issue %+v, work_item %+v", id, got.Issue, got.WorkItem)
		}
	}
	if ws["p"].WorkItem != nil || ws["p"].Issue != nil {
		t.Errorf("a plain worker has a link: %+v", ws["p"])
	}
	raw, _ := json.Marshal(ws["c"])
	if !strings.Contains(string(raw), `"work_item":{"provider":"fake","id":"JeffreyVdb/lab#7"}`) || !strings.Contains(string(raw), `"issue":{"repo":"JeffreyVdb/lab","number":7}`) {
		t.Errorf("wire = %s", raw)
	}
	// A floor whose repo changes moves them: work_item follows issue.
	bb.fb.repo("JeffreyVdb/other")
	bb.link("JeffreyVdb/other")
	ws = workersOf(bb.world(func(w proto.World) bool { return workersOf(w, "s")["c"].Issue.Repo == "JeffreyVdb/other" }), "s")
	if got := ws["c"].WorkItem; got == nil || got.ID != "JeffreyVdb/other#7" {
		t.Errorf("after the repo changed: %+v", got)
	}
	// With no repo there is no issue and no work_item.
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Null[string]()})
	ws = workersOf(bb.world(func(w proto.World) bool { return workersOf(w, "s")["c"].Issue == nil }), "s")
	if ws["c"].WorkItem != nil {
		t.Errorf("work_item without an issue: %+v", ws["c"].WorkItem)
	}
}

// Without a provider factory the M6 link stays as it was.
func TestWorkItemNeedsBoards(t *testing.T) {
	hb := startHireBridge(t, nil, runWorker("o", "ORCH|demo", runTokens("orch", "run-1")),
		runWorker("c", "CODE|demo|7|r1", runTokens("code", "run-1")))
	setRepo(hb.c, "s", "JeffreyVdb/lab")
	ws := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")["c"].Issue != nil }), "s")
	if ws["c"].WorkItem != nil || ws["o"].WorkItem != nil {
		t.Fatalf("work_item = %+v %+v", ws["c"].WorkItem, ws["o"].WorkItem)
	}
}

func decorateRoles(bb *boardBridge) {
	bb.fl.decorate = func(w *world.WorkerObs) { w.Role, w.Run = world.RoleRun(w.Label, nil) }
}

// run.start: the orchestrator's issue and work item are on the wire before
// the ack, not tens of seconds later (the M6 advisory).
func TestRunStartRelinksBeforeTheAck(t *testing.T) {
	bb := startBoardBridge(t, nil)
	bb.fb.repo("JeffreyVdb/lab")
	bb.git.repos["/home/u/lab"] = "/home/u/lab"
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"), DefaultCwd: proto.Some("/home/u/lab")})
	decorateRoles(bb)
	preset := bb.connect(proto.Hello{}).snapshot().World.Presets[0].ID
	desk := 2
	evs, m := bb.c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, Issue: json.RawMessage("3"),
		Orch: &buildTeam.Orch, Preset: preset})
	res := ackData[proto.RunStartResult](t, m)
	var linked *proto.Worker
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == res.ID && ev.Worker.Issue != nil {
			linked = ev.Worker
		}
	}
	if linked == nil {
		t.Fatalf("no worker.upsert of the orchestrator with its issue before the ack: %v", eventTypes(evs))
	}
	if linked.Issue.Repo != "JeffreyVdb/lab" || linked.Issue.Number != 3 || linked.WorkItem == nil ||
		*linked.WorkItem != (proto.WorkItemRef{Provider: "fake", ID: "JeffreyVdb/lab#3"}) || linked.Role != "orch" {
		t.Fatalf("linked = %+v", linked)
	}
}

// run.prepare and run.start take a work_item, a third way to name the ticket.
func TestRunWorkItem(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#9", "#9", "Boards", "todo")}
	bb.git.repos["/home/u/lab"] = "/home/u/lab"
	c := bb.c
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"), DefaultCwd: proto.Some("/home/u/lab")})
	bb.polled("s")
	decorateRoles(bb)
	item := &proto.WorkItemRef{Provider: "fake", ID: "JeffreyVdb/lab#9"}

	_, m := c.command(proto.CmdRunPrepare, "p", proto.RunPrepareArgs{Session: "s", WorkItem: item})
	res := ackData[proto.RunPrepareResult](t, m)
	wantTicket := proto.RunTicket{Kind: proto.TicketIssue, Repo: "JeffreyVdb/lab", Number: 9, URL: "https://example.test/JeffreyVdb/lab/issues/9"}
	if res.Ticket == nil || *res.Ticket != wantTicket || res.Label != "ORCH|issue-9" ||
		!strings.HasPrefix(res.Prompt, "/write-code https://example.test/JeffreyVdb/lab/issues/9\n\n") || !strings.Contains(res.Prompt, statusLine) {
		t.Fatalf("prepare = %+v", res)
	}
	// Exclusive with an issue and with text; unknown ones are not_found.
	c.mustError(proto.CmdRunPrepare, map[string]any{"session": "s", "work_item": item, "issue": 9}, proto.ErrBadRequest)
	c.mustError(proto.CmdRunPrepare, map[string]any{"session": "s", "work_item": item, "text": "x"}, proto.ErrBadRequest)
	for _, bad := range []proto.WorkItemRef{{Provider: "github", ID: "JeffreyVdb/lab#9"}, {Provider: "fake", ID: "JeffreyVdb/lab#404"},
		{Provider: "fake", ID: "other/repo#9"}, {Provider: "fake", ID: "9"}, {Provider: "fake", ID: ""}} {
		c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", WorkItem: &bad}, proto.ErrNotFound)
	}
	c.mustError(proto.CmdRunPrepare, map[string]any{"session": "s", "work_item": map[string]any{"provider": "fake", "id": "x", "repo": "a/b"}}, proto.ErrBadRequest)

	// run.start records the launch as M6 does, and the orchestrator is linked before the ack.
	preset := bb.connect(proto.Hello{}).snapshot().World.Presets[0].ID
	desk := 1
	evs, m := c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, WorkItem: item, Orch: &buildTeam.Orch, Preset: preset})
	start := ackData[proto.RunStartResult](t, m)
	l, ok, err := bb.st.RunLaunchByWorker(t.Context(), start.ID)
	if err != nil || !ok || l.Repo != "JeffreyVdb/lab" || l.IssueNumber != 9 || l.TicketText != "" {
		t.Fatalf("run_launch = %+v %v %v", l, ok, err)
	}
	if !strings.HasPrefix(start.Prompt, "/write-code https://example.test/JeffreyVdb/lab/issues/9") {
		t.Fatalf("prompt = %q", start.Prompt)
	}
	found := false
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == start.ID && ev.Worker.WorkItem != nil && ev.Worker.WorkItem.ID == "JeffreyVdb/lab#9" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the orchestrator is not linked to its work item before the ack: %v", eventTypes(evs))
	}
	desk = 2
	c.mustError(proto.CmdRunStart, proto.RunStartArgs{Session: "s", DeskIndex: &desk, WorkItem: &proto.WorkItemRef{Provider: "fake", ID: "JeffreyVdb/lab#404"},
		Orch: &buildTeam.Orch, Preset: preset}, proto.ErrNotFound)

	// A floor with no board: nothing to resolve it.
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Null[string]()})
	c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", WorkItem: item}, proto.ErrNotFound)
}
