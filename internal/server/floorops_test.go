package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// fakeHerdr is server.FloorHerdr in memory: calls are recorded, sockets
// answer ping once "up", panes run what procs says, and hooks let a test
// play herdr (publish the floor running, asleep, …).
type fakeHerdr struct {
	mu       sync.Mutex
	calls    []string
	up       map[string]bool
	procs    map[string]*herdr.ProcessInfo // by pane
	startErr error
	stopErr  error
	onStart  func()
	onStop   func()
	onResume func(pane string)
	gate     chan struct{} // StartSession waits for it when set
}

func newFakeHerdr() *fakeHerdr {
	return &fakeHerdr{up: map[string]bool{}, procs: map[string]*herdr.ProcessInfo{}}
}

func (f *fakeHerdr) record(format string, args ...any) {
	f.mu.Lock()
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
	f.mu.Unlock()
}

func (f *fakeHerdr) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeHerdr) setUp(socket string, up bool) {
	f.mu.Lock()
	f.up[socket] = up
	f.mu.Unlock()
}

func (f *fakeHerdr) setProcs(pane string, p *herdr.ProcessInfo) {
	f.mu.Lock()
	f.procs[pane] = p
	f.mu.Unlock()
}

func (f *fakeHerdr) Ping(_ context.Context, socket string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.up[socket] {
		return errors.New("connection refused")
	}
	return nil
}

func (f *fakeHerdr) StartSession(ctx context.Context, session string) error {
	f.record("start %s", session)
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	if f.startErr != nil {
		return f.startErr
	}
	if f.onStart != nil {
		f.onStart()
	}
	return nil
}

func (f *fakeHerdr) StopSession(_ context.Context, session string) (string, error) {
	f.record("stop %s", session)
	if f.stopErr != nil {
		return "", f.stopErr
	}
	if f.onStop != nil {
		f.onStop()
	}
	return `{"stopped":true}`, nil
}

func (f *fakeHerdr) PaneProcesses(_ context.Context, session, pane string) (*herdr.ProcessInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if p := f.procs[pane]; p != nil {
		return p, nil
	}
	return nil, &herdr.APIError{Code: "pane_not_found", Message: "pane not found"}
}

func (f *fakeHerdr) ResumeAgent(_ context.Context, session, pane, harness, id string) error {
	f.record("resume %s %s %s %s", session, pane, harness, id)
	if f.onResume != nil {
		f.onResume(pane)
	}
	return nil
}

func (f *fakeHerdr) ReportCodexSession(_ context.Context, session, pane, id string) error {
	f.record("report %s %s %s", session, pane, id)
	return nil
}

func atShell() *herdr.ProcessInfo {
	pid := 100
	return &herdr.ProcessInfo{ShellPID: &pid, ForegroundPGID: &pid, Foreground: []herdr.Process{{PID: pid, Name: "fish"}}}
}

func running(name, id string) *herdr.ProcessInfo {
	shell, fg := 100, 200
	return &herdr.ProcessInfo{ShellPID: &shell, ForegroundPGID: &fg,
		Foreground: []herdr.Process{{PID: fg, Name: name, Cmdline: name + " --resume " + id}}}
}

func fastOps(fh *fakeHerdr) server.Options {
	return server.Options{Herdr: fh, WakeTimeout: 300 * time.Millisecond, ResumeTimeout: 300 * time.Millisecond,
		SleepTimeout: 2 * time.Second, ResumePoll: 10 * time.Millisecond, ResumeSettle: 30 * time.Millisecond}
}

func claudeW(ws, sess string) world.WorkerObs {
	w := worker(ws, "CODE|"+ws, sess, "unknown")
	w.AgentKind = "claude"
	return w
}

func withStatus(ws []world.WorkerObs, status string) []world.WorkerObs {
	out := slices.Clone(ws)
	for i := range out {
		out[i].Status = status
	}
	return out
}

func (b *bridge) floorAt(session string, running bool, workers []world.WorkerObs) {
	b.t.Helper()
	b.publish(world.FloorObs{Session: session, Running: running, Gen: world.NextGen(), Socket: "sock-" + session, Workers: workers})
}

func ackData[T any](t *testing.T, m msg) T {
	t.Helper()
	var a struct {
		T    string `json:"t"`
		Data T      `json:"data"`
	}
	if err := json.Unmarshal(m.raw, &a); err != nil || a.T != proto.TAck {
		t.Fatalf("not an ack: %s", m.raw)
	}
	return a.Data
}

func errorOf(m msg) proto.Error {
	var e proto.Error
	_ = json.Unmarshal(m.raw, &e)
	return e
}

func resumes(evs []proto.Event) []string {
	var out []string
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert {
			out = append(out, ev.Worker.WorkspaceID+"="+ev.Worker.Resume)
		}
	}
	return out
}

func lastFloor(t *testing.T, evs []proto.Event) proto.Floor {
	t.Helper()
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].T == proto.EvFloorUpsert {
			return *evs[i].Floor
		}
	}
	t.Fatalf("no floor.upsert in %+v", evs)
	return proto.Floor{}
}

func TestWakeHappyPath(t *testing.T) {
	fh := newFakeHerdr()
	b := startBridge(t, "", fastOps(fh))
	sleeping := []world.WorkerObs{claudeW("w1", "sess-1"), worker("w2", "notes", "", "unknown")}
	b.floorAt("s", false, sleeping)
	c := b.connect(proto.Hello{Client: "wake-test"})
	before := workersOf(c.snapshot().World, "s")

	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", running("claude", "sess-1"))
		b.floorAt("s", true, withStatus(sleeping, "idle"))
	}
	evs, m := c.command(proto.CmdFloorWake, "wake-1", proto.FloorArgs{Session: "s"})
	res := ackData[proto.WakeResult](t, m)

	// Transition first, then the pending worker, then the floor running,
	// the confirmation and the end of the transition.
	if evs[0].T != proto.EvFloorUpsert || evs[0].Floor.Transition != proto.TransitionWaking || evs[0].Floor.State != "asleep" {
		t.Fatalf("first event = %+v", evs[0])
	}
	if evs[1].T != proto.EvWorkerUpsert || evs[1].Worker.WorkspaceID != "w1" || evs[1].Worker.Resume != proto.ResumePending {
		t.Fatalf("second event = %+v", evs[1])
	}
	var sawRunningWaking bool
	for _, ev := range evs {
		if ev.T == proto.EvFloorUpsert && ev.Floor.State == "running" && ev.Floor.Transition == proto.TransitionWaking {
			sawRunningWaking = true
		}
	}
	if !sawRunningWaking {
		t.Errorf("no running floor during the transition: %+v", evs)
	}
	if got := resumes(evs); got[len(got)-1] != "w1=confirmed" || slices.Contains(got, "w2=pending") {
		t.Errorf("resume events = %v", got)
	}
	if f := lastFloor(t, evs); f.Transition != "" || f.State != "running" {
		t.Errorf("final floor = %+v", f)
	}
	want := []proto.WorkerResume{{ID: before["w1"].ID, Resume: proto.ResumeConfirmed}, {ID: before["w2"].ID, Resume: proto.ResumeNone}}
	if !slices.Equal(res.Workers, want) {
		t.Errorf("ack workers = %+v, want %+v", res.Workers, want)
	}
	if calls := fh.Calls(); !slices.Equal(calls, []string{"start s"}) {
		t.Errorf("herdr calls = %v", calls)
	}
	// Workers are the same, at the same desks, with the same names.
	after := workersOf(b.world(func(w proto.World) bool { return floorOf(w, "s").State == "running" }), "s")
	for ws, w := range before {
		a := after[ws]
		if a.ID != w.ID || a.DeskIndex != w.DeskIndex || a.Name != w.Name {
			t.Errorf("%s: %s desk %d %q after wake, was %s desk %d %q", ws, a.ID, a.DeskIndex, a.Name, w.ID, w.DeskIndex, w.Name)
		}
	}
	if after["w1"].Resume != proto.ResumeConfirmed || after["w2"].Resume != "" {
		t.Errorf("resume in the snapshot: %q %q", after["w1"].Resume, after["w2"].Resume)
	}

	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(log) != 1 || log[0].Cmd != proto.CmdFloorWake || !log[0].OK || !log[0].Done || !strings.Contains(log[0].Result, `"resume":"confirmed"`) {
		t.Fatalf("audit = %+v", log)
	}
}

func TestWakeConfirmedByAgentDetected(t *testing.T) {
	fh := newFakeHerdr()
	opts := fastOps(fh)
	opts.ResumeTimeout = 5 * time.Second // only the event can end it quickly
	b := startBridge(t, "", opts)
	sleeping := []world.WorkerObs{claudeW("w1", "sess-1")}
	b.floorAt("s", false, sleeping)
	c := b.connect(proto.Hello{})
	c.snapshot()
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		b.floorAt("s", true, sleeping)
		b.publish(world.AgentDetected{Session: "s", WorkspaceID: "w1", PaneID: "w1:p1", Agent: "claude"})
	}
	start := time.Now()
	_, m := c.command(proto.CmdFloorWake, "w", proto.FloorArgs{Session: "s"})
	if res := ackData[proto.WakeResult](t, m); res.Workers[0].Resume != proto.ResumeConfirmed {
		t.Fatalf("ack = %s", m.raw)
	}
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("confirmation took %v", took)
	}
}

func TestWakeFallback(t *testing.T) {
	fh := newFakeHerdr()
	b := startBridge(t, "", fastOps(fh))
	codex := worker("w2", "CODE|w2", "01a0e795-0000", "unknown")
	codex.AgentKind = "codex"
	sleeping := []world.WorkerObs{claudeW("w1", "8cb4e8a5-0000"), codex}
	b.floorAt("s", false, sleeping)
	c := b.connect(proto.Hello{})
	c.snapshot()
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", atShell()) // herdr's own resume did not stick
		fh.setProcs("w2:p1", atShell())
		b.floorAt("s", true, sleeping)
	}
	fh.onResume = func(pane string) {
		if pane == "w1:p1" {
			fh.setProcs(pane, running("claude", "8cb4e8a5-0000"))
		}
	}
	evs, m := c.command(proto.CmdFloorWake, "w", proto.FloorArgs{Session: "s"})
	res := ackData[proto.WakeResult](t, m)
	if res.Workers[0].Resume != proto.ResumeFallback || res.Workers[1].Resume != proto.ResumeFailed {
		t.Fatalf("ack = %s", m.raw)
	}
	calls := fh.Calls()
	if !slices.Equal(calls, []string{"start s", "resume s w1:p1 claude 8cb4e8a5-0000", "resume s w2:p1 codex 01a0e795-0000"}) {
		t.Fatalf("herdr calls = %v", calls)
	}
	if got := resumes(evs); !slices.Contains(got, "w1=fallback") || !slices.Contains(got, "w2=failed") {
		t.Errorf("resume events = %v", got)
	}
	log, _ := b.st.AuditLog(context.Background())
	if len(log) != 1 || !log[0].OK || !strings.Contains(log[0].Result, "fallback: ran the resume command") {
		t.Fatalf("audit = %+v", log)
	}
}

// A pane that runs something else is not typed into: its worker fails.
func TestWakeNoFallbackOutsideAShell(t *testing.T) {
	fh := newFakeHerdr()
	b := startBridge(t, "", fastOps(fh))
	sleeping := []world.WorkerObs{claudeW("w1", "sess-1")}
	b.floorAt("s", false, sleeping)
	c := b.connect(proto.Hello{})
	c.snapshot()
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", running("vim", "notes.txt"))
		b.floorAt("s", true, sleeping)
	}
	_, m := c.command(proto.CmdFloorWake, "w", proto.FloorArgs{Session: "s"})
	if res := ackData[proto.WakeResult](t, m); res.Workers[0].Resume != proto.ResumeFailed {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := fh.Calls(); !slices.Equal(calls, []string{"start s"}) {
		t.Fatalf("herdr calls = %v", calls)
	}
}

func TestWakeFailsWhenTheServerDoesNotAnswer(t *testing.T) {
	fh := newFakeHerdr() // started, but the socket never answers
	b := startBridge(t, "", fastOps(fh))
	b.floorAt("s", false, []world.WorkerObs{claudeW("w1", "sess-1")})
	c := b.connect(proto.Hello{})
	c.snapshot()
	evs, m := c.command(proto.CmdFloorWake, "w", proto.FloorArgs{Session: "s"})
	if e := errorOf(m); e.Code != proto.ErrWakeFailed || !strings.Contains(e.Message, "did not answer ping") {
		t.Fatalf("reply = %s", m.raw)
	}
	if got := resumes(evs); !slices.Equal(got, []string{"w1=pending", "w1="}) {
		t.Errorf("resume events = %v", got)
	}
	if f := lastFloor(t, evs); f.Transition != "" || f.State != "asleep" {
		t.Errorf("final floor = %+v", f)
	}
	fh.startErr = errors.New("Unit herdr-s-s.service already exists")
	_, m = c.command(proto.CmdFloorWake, "w2", proto.FloorArgs{Session: "s"})
	if e := errorOf(m); e.Code != proto.ErrWakeFailed || !strings.Contains(e.Message, "already exists") {
		t.Fatalf("reply = %s", m.raw)
	}
	log, _ := b.st.AuditLog(context.Background())
	if len(log) != 2 || log[0].OK || !log[0].Done || !strings.Contains(log[0].Error, "wake failed") {
		t.Fatalf("audit = %+v", log)
	}
}

func TestFloorCommandStates(t *testing.T) {
	fh := newFakeHerdr()
	fh.gate = make(chan struct{})
	opts := fastOps(fh)
	opts.Sessions = regexp.MustCompile(`^(s|up|other)$`)
	b := startBridge(t, "", opts)
	b.floorAt("s", false, []world.WorkerObs{claudeW("w1", "sess-1")})
	b.floorAt("up", true, nil)
	b.floorAt("other", false, nil)
	b.floorAt("hidden", false, nil) // known, but outside the watched set
	c := b.connect(proto.Hello{Client: "states"})
	c.snapshot()

	c.mustError(proto.CmdFloorWake, proto.FloorArgs{Session: "up"}, proto.ErrInvalidState)
	c.mustError(proto.CmdFloorSleep, proto.FloorArgs{Session: "other"}, proto.ErrInvalidState)
	c.mustError(proto.CmdFloorWake, proto.FloorArgs{Session: "nope"}, proto.ErrUnknownSession)
	c.mustError(proto.CmdFloorWake, proto.FloorArgs{Session: "hidden"}, proto.ErrUnknownSession)
	c.mustError(proto.CmdFloorSleep, map[string]any{"session": "up", "force": true}, proto.ErrBadRequest)

	// A wake in progress: the floor is busy, everything else keeps going.
	c.send(proto.Command{T: proto.CmdFloorWake, ReqID: "slow", Args: json.RawMessage(`{"session":"s"}`)})
	c.until(proto.EvWorkerUpsert) // w1 pending
	other := b.connect(proto.Hello{Client: "other"})
	other.snapshot()
	other.mustError(proto.CmdFloorWake, proto.FloorArgs{Session: "s"}, proto.ErrBusy)
	other.mustError(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"}, proto.ErrBusy)
	other.mustError(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("o/r")}, proto.ErrBusy)
	other.mustError(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "s"}, proto.ErrBusy)
	createBuilding(other, "Work")
	b.floorAt("up", true, []world.WorkerObs{worker("w9", "new", "", "idle")})
	if ev := other.until(proto.EvWorkerUpsert); ev.Worker.WorkspaceID != "w9" {
		t.Fatalf("event during the wake = %+v", ev)
	}
	close(fh.gate) // the server "starts" but never answers ping
	for {
		m := c.next()
		if m.env.ReqID == "slow" {
			if e := errorOf(m); e.Code != proto.ErrWakeFailed {
				t.Fatalf("slow wake: %s", m.raw)
			}
			break
		}
	}
	// Every command, accepted or not, is in the audit log.
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, e := range log {
		if !e.Done {
			t.Errorf("audit row not done: %+v", e)
		}
		cmds = append(cmds, e.Client+":"+e.Cmd)
	}
	want := []string{"states:floor.wake", "states:floor.sleep", "states:floor.wake", "states:floor.wake", "states:floor.sleep",
		"states:floor.wake", "other:floor.wake", "other:floor.sleep", "other:floor.settings.set", "other:floor.assign", "other:building.create"}
	slices.Sort(cmds)
	slices.Sort(want)
	if !slices.Equal(cmds, want) {
		t.Fatalf("audit = %v, want %v", cmds, want)
	}
}

func TestSleepBackfillsCodexThenStops(t *testing.T) {
	fh := newFakeHerdr()
	opts := fastOps(fh)
	var looked []string
	opts.CodexSession = func(cwd string, skip func(string) bool) (string, error) {
		looked = append(looked, cwd)
		if cwd == "/home/u/w2" && !skip("01a0-found") {
			return "01a0-found", nil
		}
		return "", nil
	}
	b := startBridge(t, "", opts)
	codex := worker("w2", "CODE|w2", "", "idle")
	codex.AgentKind = "codex"
	lost := worker("w3", "CODE|w3", "", "idle")
	lost.AgentKind = "codex"
	awake := []world.WorkerObs{claudeW("w1", "sess-1"), codex, lost, worker("w4", "shell", "", "unknown")}
	b.floorAt("s", true, awake)
	c := b.connect(proto.Hello{Client: "sleeper"})
	before := workersOf(c.snapshot().World, "s")

	asleep := withStatus(awake, "unknown")
	asleep[1].AgentSession = "01a0-found"
	fh.onStop = func() { b.floorAt("s", false, asleep) }
	evs, m := c.command(proto.CmdFloorSleep, "zz", proto.FloorArgs{Session: "s"})
	if m.env.T != proto.TAck {
		t.Fatalf("reply = %s", m.raw)
	}
	if evs[0].T != proto.EvFloorUpsert || evs[0].Floor.Transition != proto.TransitionSleeping || evs[0].Floor.State != "running" {
		t.Fatalf("first event = %+v", evs[0])
	}
	var asleepIdx = -1
	for i, ev := range evs {
		if ev.T == proto.EvFloorUpsert && ev.Floor.State == "asleep" {
			if ev.Floor.Transition != "" {
				t.Errorf("asleep floor still in transition: %+v", ev.Floor)
			}
			asleepIdx = i
		}
	}
	if asleepIdx < 0 || !slices.ContainsFunc(evs[asleepIdx:], func(ev proto.Event) bool { return ev.T == proto.EvWorkerUpsert || ev.T == proto.EvWorkerStatus }) {
		t.Fatalf("no asleep floor followed by its workers: %+v", evs)
	}
	if calls := fh.Calls(); !slices.Equal(calls, []string{"report s w2:p1 01a0-found", "stop s"}) {
		t.Fatalf("herdr calls = %v", calls)
	}
	if !slices.Equal(looked, []string{"/home/u/w2", "/home/u/w3"}) {
		t.Fatalf("rollout lookups = %v", looked)
	}
	after := workersOf(b.world(func(w proto.World) bool { return floorOf(w, "s").State == "asleep" }), "s")
	for ws, w := range before {
		if a := after[ws]; a.ID != w.ID || a.DeskIndex != w.DeskIndex || a.Name != w.Name || a.Status != "unknown" {
			t.Errorf("%s asleep = %+v, was %+v", ws, a, w)
		}
	}
	log, _ := b.st.AuditLog(context.Background())
	if len(log) != 1 || !log[0].OK || !strings.Contains(log[0].Result, `"agent_session":"01a0-found"`) ||
		!strings.Contains(log[0].Result, `"skipped":"no codex rollout for /home/u/w3"`) || !strings.Contains(log[0].Result, `"seen_asleep":true`) {
		t.Fatalf("audit = %+v", log)
	}
}

func TestSleepFailed(t *testing.T) {
	fh := newFakeHerdr()
	fh.stopErr = errors.New("herdr session stop: exit status 1: no such session")
	b := startBridge(t, "", fastOps(fh))
	b.floorAt("s", true, []world.WorkerObs{claudeW("w1", "sess-1")})
	c := b.connect(proto.Hello{})
	c.snapshot()
	evs, m := c.command(proto.CmdFloorSleep, "zz", proto.FloorArgs{Session: "s"})
	if e := errorOf(m); e.Code != proto.ErrSleepFailed || !strings.Contains(e.Message, "no such session") {
		t.Fatalf("reply = %s", m.raw)
	}
	if f := lastFloor(t, evs); f.Transition != "" || f.State != "running" {
		t.Errorf("final floor = %+v", f)
	}
	log, _ := b.st.AuditLog(context.Background())
	if len(log) != 1 || log[0].OK || !log[0].Done {
		t.Fatalf("audit = %+v", log)
	}
}

// A full cycle keeps every worker's identity, desk and name, and resume
// states end with the next sleep.
func TestSleepWakeCycleKeepsDesksAndNames(t *testing.T) {
	fh := newFakeHerdr()
	b := startBridge(t, "", fastOps(fh))
	var awake []world.WorkerObs
	for i := 1; i <= 5; i++ {
		awake = append(awake, claudeW(fmt.Sprintf("w%d", i), fmt.Sprintf("sess-%d", i)))
	}
	awake = withStatus(awake, "idle")
	b.floorAt("s", true, awake)
	c := b.connect(proto.Hello{})
	before := workersOf(c.snapshot().World, "s")
	check := func(when string, w map[string]proto.Worker) {
		t.Helper()
		for ws, x := range before {
			if y := w[ws]; y.ID != x.ID || y.DeskIndex != x.DeskIndex || y.Name != x.Name {
				t.Errorf("%s %s: %s desk %d %q, was %s desk %d %q", when, ws, y.ID, y.DeskIndex, y.Name, x.ID, x.DeskIndex, x.Name)
			}
		}
	}
	for round := range 2 {
		fh.onStop = func() { fh.setUp("sock-s", false); b.floorAt("s", false, withStatus(awake, "unknown")) }
		c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
		asleep := workersOf(b.world(func(w proto.World) bool { return floorOf(w, "s").State == "asleep" }), "s")
		check(fmt.Sprintf("asleep %d", round), asleep)
		for ws, w := range asleep {
			if w.Resume != "" {
				t.Errorf("round %d: %s asleep with resume %q", round, ws, w.Resume)
			}
		}
		fh.onStart = func() {
			fh.setUp("sock-s", true)
			for _, w := range awake {
				fh.setProcs(w.PaneID, running("claude", w.AgentSession))
			}
			b.floorAt("s", true, awake)
		}
		_, ack := c.mustAck(proto.CmdFloorWake, proto.FloorArgs{Session: "s"})
		raw, _ := json.Marshal(ack.Data)
		if strings.Count(string(raw), proto.ResumeConfirmed) != 5 {
			t.Fatalf("round %d: wake ack %s", round, raw)
		}
		check(fmt.Sprintf("awake %d", round), workersOf(b.world(func(w proto.World) bool { return floorOf(w, "s").State == "running" }), "s"))
	}
}
