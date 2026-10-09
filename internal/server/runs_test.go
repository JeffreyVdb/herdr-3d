package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/runs"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// M6 runs

// runWorker is a workspace with a write-code label and h3d_* tokens, as
// world.FromSnapshot derives it.
func runWorker(ws, label string, tokens map[string]string) world.WorkerObs {
	w := worker(ws, label, "sess-"+ws, "idle")
	w.Tokens = tokens
	w.Role, w.Run = world.RoleRun(label, tokens)
	w.RunInfo = world.RunOf(label, tokens)
	return w
}

func runTokens(role, run string, kv ...string) map[string]string {
	m := map[string]string{"h3d_role": role, "h3d_run": run}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i]] = kv[i+1]
	}
	return m
}

func setRepo(c *client, session, repo string) {
	c.t.Helper()
	c.mustAck(proto.CmdFloorSettings, map[string]any{"session": session, "repo": repo})
}

func issueOf(w proto.Worker) proto.IssueRef {
	if w.Issue == nil {
		return proto.IssueRef{}
	}
	return *w.Issue
}

func TestRunFieldsFromTokens(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true)
	setRepo(c, "s", "o/lab")
	const run = "20260929-0746-demo"
	b.floor("s", true,
		runWorker("o", "ORCH|demo", runTokens("orch", run, "h3d_phase", "review", "h3d_pass", "1")),
		runWorker("c", "CODE|demo|7|r2", runTokens("code", run, "h3d_round", "2")),
		runWorker("r", "REVIEW|x", runTokens("review", run, "h3d_round", "1", "h3d_ticket", "#7")),
		runWorker("g", "GROUND|topic", runTokens("ground", run)),
		runWorker("p", "plain", nil))
	ws := workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["g"].OrchID != "" }), "s")
	o, cd, r, g, p := ws["o"], ws["c"], ws["r"], ws["g"], ws["p"]
	want7 := proto.IssueRef{Repo: "o/lab", Number: 7}
	if o.Phase != "review" || o.Pass == nil || *o.Pass != 1 || o.OverCap || issueOf(o) != want7 || o.OrchID != "" {
		t.Errorf("orch = %+v", o)
	}
	if cd.Round != 2 || cd.Ticket != "7" || cd.OrchID != o.ID || issueOf(cd) != want7 || cd.Phase != "" || cd.Pass != nil {
		t.Errorf("coder = %+v", cd)
	}
	if r.Round != 1 || r.Ticket != "#7" || r.OrchID != o.ID || issueOf(r) != want7 {
		t.Errorf("reviewer = %+v", r)
	}
	if g.Round != 0 || g.Ticket != "" || g.OrchID != o.ID || issueOf(g) != want7 {
		t.Errorf("researcher = %+v", g)
	}
	if p.Round != 0 || p.OrchID != "" || p.Issue != nil || p.Report != nil {
		t.Errorf("plain = %+v", p)
	}
}

// Runs started outside the game, without tokens: the labels alone link
// the freelancers to the floor's only orchestrator and to the issue.
func TestRunFieldsFromLabels(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, runWorker("o", "ORCH|herdr-3d", nil), runWorker("c", "CODE|x|7|r1", nil),
		runWorker("r", "REVIEW|x|7|r1", nil), runWorker("u", "UX|x|m6|r1", nil))
	ws := workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["u"].OrchID != "" }), "s")
	if ws["c"].Round != 1 || ws["c"].Ticket != "7" || ws["c"].OrchID != ws["o"].ID || ws["c"].Issue != nil {
		t.Fatalf("no repo yet: coder = %+v", ws["c"])
	}
	// The floor gets a repo: the run gets its issue, the non-numeric
	// ticket its ORCH's.
	setRepo(c, "s", "o/lab")
	want := proto.IssueRef{Repo: "o/lab", Number: 7}
	ws = workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["u"].Issue != nil }), "s")
	for _, k := range []string{"o", "c", "r", "u"} {
		if issueOf(ws[k]) != want {
			t.Errorf("%s: issue = %+v", k, ws[k].Issue)
		}
	}
	if ws["u"].Ticket != "m6" {
		t.Errorf("ux ticket = %q", ws["u"].Ticket)
	}
	// Non-numeric tickets only: no issue.
	b.floor("s", true, runWorker("o", "ORCH|herdr-3d", nil), runWorker("u", "UX|x|m6|r1", nil))
	ws = workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["o"].Issue == nil && len(workersOf(w, "s")) == 2 }), "s")
	if ws["u"].Issue != nil || ws["u"].OrchID != ws["o"].ID {
		t.Fatalf("ux = %+v", ws["u"])
	}
}

func TestIssueFromTheSuggestedRepo(t *testing.T) {
	b := startBridge(t, "", server.Options{RepoOf: func(_ context.Context, dir string) string { return "o/suggested" }})
	b.floor("s", true, runWorker("o", "ORCH|a", nil), runWorker("c", "CODE|x|12|r1", nil))
	ws := workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["o"].Issue != nil }), "s")
	want := proto.IssueRef{Repo: "o/suggested", Number: 12}
	if issueOf(ws["o"]) != want || issueOf(ws["c"]) != want {
		t.Fatalf("workers = %+v", ws)
	}
}

func TestIssueFromTheLaunchRecord(t *testing.T) {
	var orch atomic.Value
	orch.Store("")
	clk := newClock(1_000_000)
	b := startBridge(t, "", server.Options{Now: clk.now, RunLaunch: func(_ context.Context, id string) (runs.Launch, bool) {
		return runs.Launch{Issue: &proto.IssueRef{Repo: "x/launched", Number: 3}}, id == orch.Load()
	}})
	b.floor("s", true, runWorker("o", "ORCH|a", runTokens("orch", "run-1")))
	orch.Store(workersOf(b.world(hasWorkers("s", 1)), "s")["o"].ID)
	// run.start records the launch just after the hire: the bridge looks
	// again a little later. The record wins, and the freelancers get it.
	clk.advance(6 * time.Second)
	b.floor("s", true, runWorker("o", "ORCH|a", runTokens("orch", "run-1")),
		runWorker("g", "GROUND|a", runTokens("ground", "run-1", "h3d_ticket", "9")))
	ws := workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["g"].Issue != nil }), "s")
	want := proto.IssueRef{Repo: "x/launched", Number: 3}
	if issueOf(ws["o"]) != want || issueOf(ws["g"]) != want { // no repo for its own ticket: its ORCH's
		t.Fatalf("no repo: workers = %+v", ws)
	}
	// With a repo the researcher's own ticket is its issue.
	c := b.connect(proto.Hello{})
	c.snapshot()
	setRepo(c, "s", "o/r")
	ws = workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["g"].Issue != nil }), "s")
	if issueOf(ws["o"]) != want || issueOf(ws["g"]) != (proto.IssueRef{Repo: "o/r", Number: 9}) {
		t.Fatalf("workers = %+v", ws)
	}
}

func TestOverCap(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	for _, tc := range []struct {
		phase, pass string
		want        bool
	}{
		{"review", "2", false}, {"waiting_user", "2", false}, {"review", "3", false}, {"waiting_user", "3", true},
		{"fixing", "4", true},
	} {
		b.floor("s", true, runWorker("o", "ORCH|a", runTokens("orch", "r", "h3d_phase", tc.phase, "h3d_pass", tc.pass)))
		o := workersOf(b.world(func(w proto.World) bool {
			return workersOf(w, "s")["o"].Phase == tc.phase
		}), "s")["o"]
		if o.OverCap != tc.want {
			t.Errorf("phase %q pass %q: over_cap %v", tc.phase, tc.pass, o.OverCap)
		}
	}
}

func TestPhaseAndPassRemembered(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	orch := func(tokens map[string]string) world.WorkerObs { return runWorker("o", "ORCH|a", tokens) }
	b.floor("s", true, orch(runTokens("orch", "r", "h3d_phase", "waiting_user", "h3d_pass", "3")))
	b.world(func(w proto.World) bool { return workersOf(w, "s")["o"].OverCap })
	// herdr restarted: the tokens are gone, the label still says ORCH.
	b.floor("s", true, orch(nil))
	o := workersOf(b.world(func(w proto.World) bool { return workersOf(w, "s")["o"].Tokens == nil }), "s")["o"]
	if o.Phase != "waiting_user" || o.Pass == nil || *o.Pass != 3 || !o.OverCap || o.Tokens != nil {
		t.Fatalf("after token loss = %+v", o)
	}
	b.stop()

	// A bridge restart on an asleep floor: from the store.
	b2 := startBridge(t, db, server.Options{})
	b2.floor("s", false, orch(nil))
	o = workersOf(b2.world(hasWorkers("s", 1)), "s")["o"]
	if o.Phase != "waiting_user" || o.Pass == nil || *o.Pass != 3 || !o.OverCap {
		t.Fatalf("after restart = %+v", o)
	}
	// New values win; a pass alone keeps the phase.
	b2.floor("s", true, orch(runTokens("orch", "r", "h3d_pass", "0")))
	o = workersOf(b2.world(func(w proto.World) bool { p := workersOf(w, "s")["o"].Pass; return p != nil && *p == 0 }), "s")["o"]
	if o.Phase != "waiting_user" || o.OverCap {
		t.Fatalf("new pass = %+v", o)
	}
}

// publish writes a report the way write-code does: a temp file renamed
// into place.
func publish(t *testing.T, dir, run, name, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, run), 0o755); err != nil {
		t.Fatal(err)
	}
	tmp := filepath.Join(dir, run, name+".tmp")
	if err := os.WriteFile(tmp, []byte(data), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, filepath.Join(dir, run, name)); err != nil {
		t.Fatal(err)
	}
}

// reportEvent waits for the worker.upsert of worker id with a report in
// state.
func reportEvent(c *client, id, state string) *proto.RunReport {
	c.t.Helper()
	for {
		ev := c.event()
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.Report != nil && ev.Worker.Report.State == state {
			return ev.Worker.Report
		}
	}
}

// quiet checks that nothing more happens for a few poll rounds.
func quiet(c *client, poll time.Duration) {
	c.t.Helper()
	time.Sleep(5 * poll)
	if evs, _ := c.command("nothing", "q", nil); len(evs) > 0 {
		c.t.Fatalf("unexpected events: %+v", evs)
	}
}

func TestReports(t *testing.T) {
	dir := t.TempDir()
	const poll = 20 * time.Millisecond
	b := startBridge(t, "", server.Options{RunsDir: dir, ReportPoll: poll})
	c := b.connect(proto.Hello{})
	c.snapshot()
	const run = "20260929-0746-demo"
	coder := func(report string) world.WorkerObs {
		return runWorker("c", "CODE|demo|7|r1", runTokens("code", run, "h3d_report", report))
	}
	reviewer := runWorker("r", "REVIEW|demo|7|r1", runTokens("review", run, "h3d_report", "review-r1.json"))
	b.floor("s", true, coder("code-r1.json"), reviewer)
	var cid, rid string
	for _, ev := range c.events(3) {
		if ev.T == proto.EvWorkerUpsert {
			if ev.Worker.Report == nil || ev.Worker.Report.State != proto.ReportPending {
				t.Fatalf("new freelancer's report = %+v", ev.Worker.Report)
			}
			switch ev.Worker.WorkspaceID {
			case "c":
				cid = ev.Worker.ID
			case "r":
				rid = ev.Worker.ID
			}
		}
	}
	quiet(c, poll)

	// The coder publishes: one upsert.
	publish(t, dir, run, "code-r1.json", `{"input_required":null,"summary":"done","crucial_bits":[]}`)
	r := reportEvent(c, cid, proto.ReportReady)
	if r.Summary != "done" || r.At == 0 || r.InputRequired != nil {
		t.Fatalf("coder report = %+v", r)
	}
	quiet(c, poll)

	// The reviewer's verdict, with its counts.
	publish(t, dir, run, "review-r1.json", `{"verdict":"CHANGES_REQUIRED","input_required":null,
		"issues_found":[{"priority":"BLOCKER"},{"priority":"BLOCKER"},{"priority":"medium"}]}`)
	r = reportEvent(c, rid, proto.ReportReady)
	if r.Verdict != proto.VerdictChangesRequired || *r.Blockers != 2 || *r.Issues != 3 {
		t.Fatalf("reviewer report = %+v", r)
	}
	// Rewritten (a changed size and mtime): read again.
	publish(t, dir, run, "review-r1.json", `{"verdict":"LGTM"}`)
	if r = reportEvent(c, rid, proto.ReportInvalid); r.Error != "bad verdict" || r.At == 0 {
		t.Fatalf("bad verdict = %+v", r)
	}

	// The coder needs input and gets a fresh report path: pending again.
	publish(t, dir, run, "code-r1.json", `{"input_required":"Which port should the demo use?","summary":"half"}`)
	if r = reportEvent(c, cid, proto.ReportReady); r.InputRequired == nil || *r.InputRequired != "Which port should the demo use?" {
		t.Fatalf("input required = %+v", r)
	}
	b.floor("s", true, coder("code-r1b.json"), reviewer)
	reportEvent(c, cid, proto.ReportPending)
	publish(t, dir, run, "code-r1b.json", `{"summary":"all done"}`)
	if r = reportEvent(c, cid, proto.ReportReady); r.Summary != "all done" {
		t.Fatalf("resumed report = %+v", r)
	}

	// Invalid: a bad name, a path out of the run dir, a symlink, oversize,
	// not an object.
	for name, setup := range map[string]func(){
		"..":          func() {},
		"../escape":   func() {},
		"link.json":   func() { _ = os.Symlink(filepath.Join(dir, run, "code-r1b.json"), filepath.Join(dir, run, "link.json")) },
		"big.json":    func() { publish(t, dir, run, "big.json", `{"summary":"`+string(make([]byte, 300<<10))+`"}`) },
		"array.json":  func() { publish(t, dir, run, "array.json", `[]`) },
		"string.json": func() { publish(t, dir, run, "string.json", `"x"`) },
	} {
		setup()
		b.floor("s", true, coder(name), reviewer)
		if r := reportEvent(c, cid, proto.ReportInvalid); r.Error == "" {
			t.Errorf("%s: %+v", name, r)
		}
	}
	// No runs token, no report.
	b.floor("s", true, runWorker("c", "CODE|demo|7|r1", map[string]string{"h3d_role": "code", "h3d_report": "code-r1.json"}), reviewer)
	for {
		ev := c.event()
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == cid {
			if ev.Worker.Report != nil {
				t.Fatalf("report without a run token: %+v", ev.Worker.Report)
			}
			break
		}
	}
}

// The game's over-cap run (game/fixtures/runs/20260928-1400-overcap, the
// same synthetic run its demo-m6 floor is built from): the ORCH at pass 3
// waiting for the user is over the cap, REVIEW r3 says CHANGES_REQUIRED with
// two blockers, UX r3 passed, CODE r3 handed in its summary.
func TestOverCapFixture(t *testing.T) {
	runsDir := filepath.Join("..", "..", "game", "fixtures", "runs")
	raw, err := os.ReadFile(filepath.Join(runsDir, "20260928-1400-overcap", "workspaces.json"))
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Repo       string `json:"repo"`
		Issue      int    `json:"issue"`
		Workspaces []struct {
			Label  string            `json:"label"`
			Status string            `json:"status"`
			Model  [3]string         `json:"model"`
			Tokens map[string]string `json:"tokens"`
		} `json:"workspaces"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	var obs []world.WorkerObs
	for i, s := range spec.Workspaces {
		w := runWorker(fmt.Sprintf("w%d", i+1), s.Label, s.Tokens)
		w.Status = s.Status
		w.Harness, w.Model, w.Effort = s.Model[0], s.Model[1], s.Model[2]
		obs = append(obs, w)
	}
	if len(obs) != 4 {
		t.Fatalf("fixture has %d workspaces, want 4", len(obs))
	}
	b := startBridge(t, "", server.Options{RunsDir: runsDir, ReportPoll: 20 * time.Millisecond})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("demo", true)
	setRepo(c, "demo", spec.Repo)
	b.floor("demo", true, obs...)
	ws := workersOf(b.world(func(w proto.World) bool {
		for _, id := range []string{"w2", "w3", "w4"} {
			if r := workersOf(w, "demo")[id].Report; r == nil || r.State != proto.ReportReady {
				return false
			}
		}
		return true
	}), "demo")
	o, cd, rv, ux := ws["w1"], ws["w2"], ws["w3"], ws["w4"]
	want := proto.IssueRef{Repo: spec.Repo, Number: spec.Issue}
	if !o.OverCap || o.Phase != "waiting_user" || o.Pass == nil || *o.Pass != 3 || issueOf(o) != want {
		t.Errorf("orch = %+v", o)
	}
	if rv.OrchID != o.ID || rv.Round != 3 || rv.Report.Verdict != proto.VerdictChangesRequired || *rv.Report.Blockers != 2 ||
		*rv.Report.Issues != 5 || rv.OverCap || issueOf(rv) != want {
		t.Errorf("reviewer = %+v report %+v", rv, rv.Report)
	}
	if cd.OrchID != o.ID || cd.Report.Summary == "" || cd.Model != "claude-opus-5-5" {
		t.Errorf("coder = %+v report %+v", cd, cd.Report)
	}
	if ux.OrchID != o.ID || ux.Report.Verdict != proto.VerdictPass {
		t.Errorf("ux = %+v report %+v", ux, ux.Report)
	}
	// All four sit in the ORCH's pod.
	for _, w := range ws {
		if w.DeskIndex/4 != o.DeskIndex/4 {
			t.Errorf("%s at desk %d, ORCH at %d", w.Label, w.DeskIndex, o.DeskIndex)
		}
	}
}

func desksOf(w proto.World, session string) map[string]int {
	m := map[string]int{}
	for ws, wk := range workersOf(w, session) {
		m[ws] = wk.DeskIndex
	}
	return m
}

func TestFreelancersSitNextToTheirOrchestrator(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	fl := func(ws, role, run string) world.WorkerObs {
		return runWorker(ws, "CODE|"+ws, runTokens(role, run))
	}
	// Five employees, then an ORCH at desk 5 (pod 1).
	emp := []world.WorkerObs{agent("e0", "idle"), agent("e1", "idle"), agent("e2", "idle"), agent("e3", "idle"), agent("e4", "idle")}
	for i := range emp {
		emp[i].Label = "plain " + emp[i].WorkspaceID
		emp[i].Role = ""
	}
	orchA := runWorker("oa", "ORCH|a", runTokens("orch", "run-a"))
	obs := append(append([]world.WorkerObs{}, emp...), orchA)
	b.floor("s", true, obs...)
	b.world(hasWorkers("s", 6))
	// Freelancers of run a fill pod 1 (desks 4 is taken by e4: 6, 7), then
	// the nearest pods: 0 is full, so pod 2 (8…).
	obs = append(obs, fl("a1", "code", "run-a"), fl("a2", "review", "run-a"), fl("a3", "ux", "run-a"))
	b.floor("s", true, obs...)
	d := desksOf(b.world(hasWorkers("s", 9)), "s")
	if d["oa"] != 5 || d["a1"] != 6 || d["a2"] != 7 || d["a3"] != 8 {
		t.Fatalf("desks = %v", d)
	}
	// A plain newcomer still takes the lowest free desk.
	obs = append(obs, agent("e5", "idle"))
	b.floor("s", true, obs...)
	if d = desksOf(b.world(hasWorkers("s", 10)), "s"); d["e5"] != 9 {
		t.Fatalf("plain newcomer at %d: %v", d["e5"], d)
	}

	// A second run on the floor: its ORCH takes the lowest free desk (10,
	// pod 2), its freelancer the nearest free one (11); the floor grows.
	orchB := runWorker("ob", "ORCH|b", runTokens("orch", "run-b"))
	obs = append(obs, orchB)
	b.floor("s", true, obs...)
	b.world(hasWorkers("s", 11))
	obs = append(obs, fl("b1", "code", "run-b"), fl("b2", "code", "run-b"))
	b.floor("s", true, obs...)
	w := b.world(hasWorkers("s", 13))
	d = desksOf(w, "s")
	if d["ob"] != 10 || d["b1"] != 11 || d["b2"] != 12 || floorOf(w, "s").Desks < 13 {
		t.Fatalf("second run: desks %v, floor desks %d", d, floorOf(w, "s").Desks)
	}
	// Links per run.
	ws := workersOf(w, "s")
	if ws["a1"].OrchID != ws["oa"].ID || ws["b2"].OrchID != ws["ob"].ID {
		t.Fatalf("links: a1 → %s, b2 → %s", ws["a1"].OrchID, ws["b2"].OrchID)
	}

	// The ORCH on another floor: linked, but seated at the lowest free desk.
	b.floor("t", true, agent("x0", "idle"), fl("c1", "code", "run-a"))
	w = b.world(hasWorkers("t", 2))
	if c1 := workersOf(w, "t")["c1"]; c1.DeskIndex != 1 || c1.OrchID != ws["oa"].ID {
		t.Fatalf("other floor: %+v", c1)
	}
}

// One observation brings a run's freelancers and its ORCH together (a
// fresh bridge, a new floor): the ORCH is seated first and its freelancers
// take the desks nearest to it, at once.
func TestInitialDiscoverySeatsFreelancersNextToTheirOrchestrator(t *testing.T) {
	plain := func(ws string) world.WorkerObs {
		w := agent(ws, "idle")
		w.Label, w.Role = "plain "+ws, ""
		return w
	}
	fl := func(ws, role, run string) world.WorkerObs {
		return runWorker(ws, "CODE|"+ws, runTokens(role, run))
	}
	t.Run("one run", func(t *testing.T) {
		b := startBridge(t, "", server.Options{})
		// CODE first, four plain workers, the ORCH last.
		b.floor("s", true, fl("c", "code", "run-a"), plain("e1"), plain("e2"), plain("e3"), plain("e4"),
			runWorker("o", "ORCH|a", runTokens("orch", "run-a")))
		w := b.world(hasWorkers("s", 6))
		d := desksOf(w, "s")
		if d["o"]/4 != d["c"]/4 || d["c"] == d["o"] {
			t.Fatalf("coder at %d, ORCH at %d: %v", d["c"], d["o"], d)
		}
		if ws := workersOf(w, "s"); ws["c"].OrchID != ws["o"].ID {
			t.Fatalf("coder linked to %q, want %q", ws["c"].OrchID, ws["o"].ID)
		}
		seen := map[int]string{}
		for ws, desk := range d {
			if other, dup := seen[desk]; dup {
				t.Fatalf("desk %d taken by %s and %s: %v", desk, other, ws, d)
			}
			seen[desk] = ws
		}
	})
	t.Run("two runs together", func(t *testing.T) {
		b := startBridge(t, "", server.Options{})
		b.floor("s", true,
			fl("a1", "code", "run-a"), fl("b1", "code", "run-b"), plain("e1"), plain("e2"),
			fl("a2", "review", "run-a"), fl("b2", "review", "run-b"),
			runWorker("ob", "ORCH|b", runTokens("orch", "run-b")), runWorker("oa", "ORCH|a", runTokens("orch", "run-a")),
			plain("e3"))
		d := desksOf(b.world(hasWorkers("s", 9)), "s")
		// The ORCHs take the lowest free desks in the order of their first
		// freelancer (oa 0, ob 1); the freelancers follow, nearest first:
		// pod 0, then pod 1.
		want := map[string]int{"oa": 0, "ob": 1, "a1": 2, "b1": 3, "a2": 4, "b2": 5, "e1": 6, "e2": 7, "e3": 8}
		if !reflect.DeepEqual(d, want) {
			t.Fatalf("desks %v, want %v", d, want)
		}
	})
}

func TestFreelancerReseatedOnceWhenItsLinkAppearsLate(t *testing.T) {
	clk := newClock(1_000_000)
	b := startBridge(t, "", server.Options{Now: clk.now})
	emp := func(ws string) world.WorkerObs {
		w := agent(ws, "idle")
		w.Label, w.Role = "plain "+ws, ""
		return w
	}
	floor := func(session string, ws ...world.WorkerObs) map[string]int {
		t.Helper()
		b.floor(session, true, ws...)
		want := map[string]string{}
		for _, w := range ws {
			want[w.WorkspaceID] = w.Label
		}
		return desksOf(b.world(func(w proto.World) bool {
			got := map[string]string{}
			for ws, wk := range workersOf(w, session) {
				got[ws] = wk.Label
			}
			return reflect.DeepEqual(got, want)
		}), session)
	}
	// The ORCH at desk 5; desks 0…8 taken.
	orch := runWorker("o", "ORCH|a", runTokens("orch", "run-1"))
	staff := []world.WorkerObs{emp("e0"), emp("e1"), emp("e2"), emp("e3"), emp("e4"), orch, emp("e6"), emp("e7"), emp("e8")}
	floor("s", staff...)
	// A workspace appears before its tokens: a plain label, the lowest free
	// desk (9, pod 2).
	late := worker("n", "new workspace", "sess-n", "idle")
	if d := floor("s", append(staff, late)...); d["n"] != 9 {
		t.Fatalf("first desk %d", d["n"])
	}
	// Its tokens arrive 3 s later, when desk 6 (the ORCH's pod) is free:
	// it moves there.
	clk.advance(3 * time.Second)
	staff = []world.WorkerObs{emp("e0"), emp("e1"), emp("e2"), emp("e3"), emp("e4"), orch, emp("e7"), emp("e8")}
	tagged := runWorker("n", "CODE|a|1|r1", runTokens("code", "run-1"))
	tagged.IdentityCwd, tagged.Cwd = late.IdentityCwd, late.Cwd
	if d := floor("s", append(staff, tagged)...); d["n"] != 6 {
		t.Fatalf("re-seat: desks %v", d)
	}
	// Only once: desk 4 frees up, it stays at 6.
	staff = []world.WorkerObs{emp("e0"), emp("e1"), emp("e2"), emp("e3"), orch, emp("e7"), emp("e8")}
	if d := floor("s", append(staff, tagged)...); d["n"] != 6 {
		t.Fatalf("moved twice: %v", d)
	}

	// Past the window a newcomer keeps its desk.
	orch2 := runWorker("o2", "ORCH|b", runTokens("orch", "run-2"))
	staff2 := []world.WorkerObs{emp("e0"), emp("e1"), emp("e2"), emp("e3"), orch2, emp("e5"), emp("e6"), emp("e7")}
	floor("u", staff2...)
	late2 := worker("m", "other", "sess-m", "idle")
	if d := floor("u", append(staff2, late2)...); d["m"] != 8 {
		t.Fatalf("m desk %v", d)
	}
	clk.advance(server.ReseatWindow + time.Second)
	staff2 = []world.WorkerObs{emp("e0"), emp("e1"), emp("e2"), emp("e3"), orch2, emp("e6"), emp("e7")}
	tagged2 := runWorker("m", "CODE|b|1|r1", runTokens("code", "run-2"))
	tagged2.IdentityCwd, tagged2.Cwd = late2.IdentityCwd, late2.Cwd
	if d := floor("u", append(staff2, tagged2)...); d["m"] != 8 {
		t.Fatalf("re-seated after the window: %v", d)
	}
	// Hired workers and employees never move: e0…e3 and the ORCHs kept
	// their desks throughout.
	if d := floor("u", append(staff2, tagged2)...); d["o2"] != 4 || d["e0"] != 0 {
		t.Fatalf("desks %v", d)
	}
}

// Workers in a run without a freelancer role are seated as before.
func TestNonFreelancersSeatedAsBefore(t *testing.T) {
	b := startBridge(t, "", server.Options{})
	orch := runWorker("o", "ORCH|a", runTokens("orch", "run-1"))
	b.floor("s", true, agent("e0", "idle"), agent("e1", "idle"), agent("e2", "idle"), agent("e3", "idle"), orch)
	b.world(hasWorkers("s", 5))
	emp := runWorker("p", "plain", map[string]string{"h3d_run": "run-1"}) // in the run, but no freelancer role
	b.floor("s", true, agent("e0", "idle"), agent("e1", "idle"), agent("e2", "idle"), agent("e3", "idle"), orch, emp)
	if d := desksOf(b.world(hasWorkers("s", 6)), "s"); d["p"] != 5 || d["o"] != 4 {
		t.Fatalf("desks %v", d)
	}
}

// A hired worker sits where it was hired, even once it turns out to be a
// freelancer of an ORCH on its floor.
func TestHiredFreelancerKeepsItsDesk(t *testing.T) {
	orch := runWorker("w1", "ORCH|a", runTokens("orch", "run-1"))
	hb := startHireBridge(t, nil, orch)
	a := hireArgs(5) // pod 1; desks 1…3 next to the ORCH are free
	a.Label = "CODE|a|1|r1"
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	res := ackData[proto.HireResult](t, m)
	hb.fl.update(res.WorkspaceID, func(w *world.WorkerObs) {
		w.Tokens = runTokens("code", "run-1")
		w.Role, w.Run = world.RoleRun(w.Label, w.Tokens)
		w.RunInfo = world.RunOf(w.Label, w.Tokens)
	})
	w := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")[res.WorkspaceID].OrchID != "" }), "s")
	if got := w[res.WorkspaceID]; got.DeskIndex != 5 || got.OrchID != w["w1"].ID {
		t.Fatalf("hired freelancer = %+v", got)
	}
}

// reportWhere waits for the worker.upsert of worker id whose report satisfies ok.
func reportWhere(c *client, id string, ok func(*proto.RunReport) bool) *proto.RunReport {
	c.t.Helper()
	for {
		ev := c.event()
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.Report != nil && ok(ev.Worker.Report) {
			return ev.Worker.Report
		}
	}
}

// touch sets a file's mtime.
func touch(t *testing.T, path string, mod time.Time) {
	t.Helper()
	if err := os.Chtimes(path, mod, mod); err != nil {
		t.Fatal(err)
	}
}

// #215: the orchestrator accepts a report's request without resuming the
// freelancer by writing <report>.resolved.json next to it; the bridge
// follows its creation, replacement and removal, and a report rewritten
// afterwards asks again. A bridge started later over the same directory sees
// the same (the sidecar is the state).
func TestReportRequestResolution(t *testing.T) {
	dir := t.TempDir()
	const poll = 20 * time.Millisecond
	const run = "20260929-0746-resolve"
	b := startBridge(t, "", server.Options{RunsDir: dir, ReportPoll: poll})
	c := b.connect(proto.Hello{})
	c.snapshot()
	coder := runWorker("c", "CODE|demo|7|r1", runTokens("code", run, "h3d_report", "coder-r1.json"))
	b.floor("s", true, coder)
	var cid string
	for _, ev := range c.events(2) {
		if ev.T == proto.EvWorkerUpsert {
			cid = ev.Worker.ID
		}
	}
	sidePath := filepath.Join(dir, run, "coder-r1.resolved.json")
	t0 := time.Now().Add(-time.Hour)
	publishAt := func(name, data string, mod time.Time) {
		publish(t, dir, run, name, data)
		touch(t, filepath.Join(dir, run, name), mod)
	}
	resolved := func(r *proto.RunReport) bool { return r.InputResolved != nil }
	active := func(r *proto.RunReport) bool {
		return r.State == proto.ReportReady && r.InputRequired != nil && r.InputResolved == nil
	}

	// Published with a request, "done" agent: it asks.
	req := "Accept the existing evidence? " // text after byte 500 follows
	for len(req) < 700 {
		req += "padding "
	}
	req += "ORCHESTRATOR ACCEPTANCE alternative."
	data, _ := json.Marshal(map[string]any{"input_required": req, "input_for": "orchestrator", "summary": "s"})
	publishAt("coder-r1.json", string(data), t0)
	r := reportWhere(c, cid, active)
	if *r.InputRequired != req || r.InputTruncated || r.InputFor != proto.InputForOrchestrator {
		t.Fatalf("request = %+v", r)
	}
	quiet(c, poll)

	// Accepted: the sidecar alone changes (the report is not touched).
	publishAt("coder-r1.resolved.json", `{"report":"coder-r1.json","resolved_by":"orchestrator","note":"accepted as AC4 evidence"}`, t0.Add(time.Second))
	r = reportWhere(c, cid, resolved)
	if r.InputRequired == nil || *r.InputRequired != req || r.InputResolved.By != "orchestrator" || r.InputResolved.Note != "accepted as AC4 evidence" {
		t.Fatalf("resolved = %+v %+v", r, r.InputResolved)
	}
	quiet(c, poll)

	// Bridge restart: a fresh hub and tracker over the same directory.
	b2 := startBridge(t, "", server.Options{RunsDir: dir, ReportPoll: poll})
	c2 := b2.connect(proto.Hello{})
	c2.snapshot()
	b2.floor("s", true, coder)
	var cid2 string
	for _, ev := range c2.events(2) {
		if ev.T == proto.EvWorkerUpsert {
			cid2 = ev.Worker.ID
		}
	}
	if r = reportWhere(c2, cid2, func(r *proto.RunReport) bool { return r.State == proto.ReportReady }); r.InputResolved == nil || r.InputRequired == nil {
		t.Fatalf("after restart = %+v %+v", r, r.InputResolved)
	}

	// The sidecar removed: it asks again.
	if err := os.Remove(sidePath); err != nil {
		t.Fatal(err)
	}
	if r = reportWhere(c, cid, active); r.InputResolved != nil {
		t.Fatalf("after delete = %+v", r)
	}
	// Written again, then the report is rewritten (newer): it asks again.
	publishAt("coder-r1.resolved.json", `{"report":"coder-r1.json"}`, t0.Add(time.Second))
	reportWhere(c, cid, resolved)
	publishAt("coder-r1.json", `{"input_required":"A new request","summary":"s2"}`, t0.Add(2*time.Second))
	if r = reportWhere(c, cid, func(r *proto.RunReport) bool { return r.InputRequired != nil && *r.InputRequired == "A new request" }); r.InputResolved != nil {
		t.Fatalf("rewritten report still resolved: %+v", r.InputResolved)
	}
	// A garbage sidecar newer than the report changes nothing.
	publishAt("coder-r1.resolved.json", `{"note":`, t0.Add(3*time.Second))
	quiet(c, poll)
	// So does a sidecar without (or with another) report name, or with a
	// null field.
	for _, side := range []string{`{}`, `{"report":"coder-r2.json"}`, `{"report":"coder-r1.json","note":null}`, `{"input_required":"x","summary":"s"}`} {
		publishAt("coder-r1.resolved.json", side, t0.Add(4*time.Second))
		quiet(c, poll)
	}
}
