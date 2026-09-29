package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
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
	b := startBridge(t, "", server.Options{Now: clk.now, RunLaunch: func(_ context.Context, id string) (proto.IssueRef, bool) {
		return proto.IssueRef{Repo: "x/launched", Number: 3}, id == orch.Load()
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

// The committed over-cap run (internal/runs/testdata/overcap): the ORCH at
// pass 3 waiting for the user is over the cap, its reviewer stamped
// CHANGES_REQUIRED.
func TestOverCapFixture(t *testing.T) {
	fixture := filepath.Join("..", "runs", "testdata", "overcap")
	raw, err := os.ReadFile(filepath.Join(fixture, "workers.json"))
	if err != nil {
		t.Fatal(err)
	}
	var spec []struct {
		WorkspaceID string            `json:"workspace_id"`
		Label       string            `json:"label"`
		Status      string            `json:"status"`
		Tokens      map[string]string `json:"tokens"`
	}
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatal(err)
	}
	var obs []world.WorkerObs
	for _, s := range spec {
		w := runWorker(s.WorkspaceID, s.Label, s.Tokens)
		w.Status = s.Status
		w.Harness, w.Model, w.Effort = world.HarnessOf(s.Tokens, "")
		obs = append(obs, w)
	}
	b := startBridge(t, "", server.Options{RunsDir: filepath.Join(fixture, "runs"), ReportPoll: 20 * time.Millisecond})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("demo", true)
	setRepo(c, "demo", "example/lab")
	b.floor("demo", true, obs...)
	ws := workersOf(b.world(func(w proto.World) bool {
		r, r2 := workersOf(w, "demo")["w3"].Report, workersOf(w, "demo")["w2"].Report
		return r != nil && r2 != nil && r.State == proto.ReportReady && r2.State == proto.ReportReady
	}), "demo")
	o, cd, rv, ux := ws["w1"], ws["w2"], ws["w3"], ws["w4"]
	want := proto.IssueRef{Repo: "example/lab", Number: 3}
	if !o.OverCap || o.Phase != "waiting_user" || *o.Pass != 3 || issueOf(o) != want {
		t.Errorf("orch = %+v", o)
	}
	if rv.OrchID != o.ID || rv.Round != 3 || rv.Report.Verdict != proto.VerdictChangesRequired || *rv.Report.Blockers != 1 ||
		*rv.Report.Issues != 2 || rv.OverCap || issueOf(rv) != want {
		t.Errorf("reviewer = %+v report %+v", rv, rv.Report)
	}
	if cd.OrchID != o.ID || cd.Report.Summary == "" || cd.Model != "claude-opus-5-5" {
		t.Errorf("coder = %+v report %+v", cd, cd.Report)
	}
	if ux.OrchID != o.ID || ux.Report == nil || ux.Report.State != proto.ReportPending {
		t.Errorf("ux = %+v", ux)
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
