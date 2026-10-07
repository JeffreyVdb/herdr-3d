package server_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #155: the shared Codex server, against a fake floor and a fake CodexHost.

const codexRun = "/run/user/7/herdr-world/codex"

// fakeCodexHost is server.CodexHost in memory: every launch's server
// answers (unless readyErr) with a supported userAgent and gets the next
// pid; dead pids are reported down; joins are recorded.
type fakeCodexHost struct {
	mu       sync.Mutex
	calls    []string
	preErr   error
	readyErr error
	ua       string
	next     int
	dead     map[int]bool
	stopped  []codexapp.Launch
	watches  []*fakeCodexWatch
	// #156: what a watch's Steer and StartTurn answer (nil: accepted, turn
	// "t-steered" / "t-started"), and every send, in order.
	steer func(turn, text, cid string) (string, error)
	start func(text, cid string) (string, error)
	sends []fakeSend
	// #158: the thread a new join reads (nil: an empty one).
	history *codexapp.Thread
}

// fakeSend is one Steer or StartTurn of a fake watch.
type fakeSend struct {
	method, turn, text, cid string
}

type fakeCodexWatch struct {
	o      codexapp.Options
	closed bool
	mu     *sync.Mutex
	host   *fakeCodexHost
}

func (w *fakeCodexWatch) Close() {
	w.mu.Lock()
	w.closed = true
	w.mu.Unlock()
}

func (w *fakeCodexWatch) Steer(_ context.Context, turn, text, cid string) (string, error) {
	f := w.host
	f.mu.Lock()
	f.sends = append(f.sends, fakeSend{"turn/steer", turn, text, cid})
	fn := f.steer
	f.mu.Unlock()
	if fn != nil {
		return fn(turn, text, cid)
	}
	return turn, nil
}

func (w *fakeCodexWatch) StartTurn(_ context.Context, text, cid string) (string, error) {
	f := w.host
	f.mu.Lock()
	f.sends = append(f.sends, fakeSend{"turn/start", "", text, cid})
	fn := f.start
	f.mu.Unlock()
	if fn != nil {
		return fn(text, cid)
	}
	return "t-started", nil
}

func newFakeCodexHost() *fakeCodexHost {
	return &fakeCodexHost{ua: "herdr_3d/0.160.1 (Linux; x86_64) xterm", next: 4000, dead: map[int]bool{}}
}

func (f *fakeCodexHost) record(format string, args ...any) {
	f.mu.Lock()
	f.calls = append(f.calls, fmt.Sprintf(format, args...))
	f.mu.Unlock()
}

func (f *fakeCodexHost) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeCodexHost) Preflight(_ context.Context, dir string) error {
	f.record("preflight %s", dir)
	return f.preErr
}

func (f *fakeCodexHost) Prepare(l codexapp.Launch) error {
	f.record("prepare %s %s", l.Name, l.Cwd)
	return l.Valid()
}

func (f *fakeCodexHost) WaitReady(_ context.Context, sock string) (string, error) {
	f.record("ready %s", sock)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.readyErr != nil {
		return "", f.readyErr
	}
	return f.ua, nil
}

func (f *fakeCodexHost) FindServer(l codexapp.Launch) (codexapp.Server, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	return codexapp.Server{PID: f.next, Start: 77}, nil
}

func (f *fakeCodexHost) Alive(_ codexapp.Launch, s codexapp.Server) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return !f.dead[s.PID]
}

func (f *fakeCodexHost) Stop(l codexapp.Launch) []int {
	f.record("stop %s", l.Name)
	f.mu.Lock()
	f.stopped = append(f.stopped, l)
	f.mu.Unlock()
	return nil
}

func (f *fakeCodexHost) Watch(o codexapp.Options) (server.CodexWatch, error) {
	f.record("watch %s %s", o.Socket, o.Thread)
	w := &fakeCodexWatch{o: o, mu: &f.mu, host: f}
	f.mu.Lock()
	f.watches = append(f.watches, w)
	f.mu.Unlock()
	th := &codexapp.Thread{ID: o.Thread}
	if f.history != nil {
		c := *f.history
		c.ID, th = o.Thread, &c
	}
	go o.OnEvent(codexapp.Event{Kind: codexapp.EvJoined, Thread: th})
	return w, nil
}

func (f *fakeCodexHost) kill(pid int) {
	f.mu.Lock()
	f.dead[pid] = true
	f.mu.Unlock()
}

type sharedBridge struct {
	*hireBridge
	host *fakeCodexHost
	term *fakeTerm
}

// startSharedBridge is a hire bridge that can launch shared Codex servers,
// with the switch on unless off.
func startSharedBridge(t *testing.T, on bool, workers ...world.WorkerObs) *sharedBridge {
	t.Helper()
	return startSharedBridgeAt(t, "", newFakeCodexHost(), on, workers...)
}

// startSharedBridgeAt is startSharedBridge on the database at db ("": a new
// one) and host, for a test that restarts the bridge.
func startSharedBridgeAt(t *testing.T, db string, host *fakeCodexHost, on bool, workers ...world.WorkerObs) *sharedBridge {
	t.Helper()
	term := newFakeTerm()
	sessions := t.TempDir()
	hb := startHireBridgeAt(t, db, func(o *server.Options) {
		o.CodexRun, o.CodexHost, o.CodexPoll = codexRun, host, 20*time.Millisecond
		o.Term, o.CodexRejoin = term, 150*time.Millisecond
		o.Usage = &server.UsageConfig{Roots: usage.Roots{CodexSessions: sessions}, Interval: 20 * time.Millisecond}
	}, workers...)
	if on {
		hb.c.mustAck(proto.CmdCodexServerSet, proto.CodexServerSetArgs{Enabled: ptr(true)})
	}
	return &sharedBridge{hireBridge: hb, host: host, term: term}
}

func codexHire(desk int) proto.WorkerHireArgs {
	return proto.WorkerHireArgs{Session: "s", DeskIndex: &desk, Harness: "codex", Model: "gpt-6-sol", Effort: "low",
		Cwd: "/home/u/repo"}
}

func (sb *sharedBridge) launches(t *testing.T) map[string]store.CodexLaunch {
	t.Helper()
	all, err := sb.st.CodexLaunches(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return all
}

func TestCodexServerSwitch(t *testing.T) {
	sb := startSharedBridge(t, false)
	snap := sb.connect(proto.Hello{Client: "x"}).snapshot()
	if cs := snap.World.CodexServer; cs == nil || cs.Enabled || !cs.Available {
		t.Fatalf("snapshot switch = %+v", cs)
	}
	_, ack := sb.c.mustAck(proto.CmdCodexServerGet, nil)
	if ack.Data.(map[string]any)["enabled"] != false {
		t.Fatalf("get = %+v", ack.Data)
	}
	evs, m := sb.c.command(proto.CmdCodexServerSet, "on", proto.CodexServerSetArgs{Enabled: ptr(true)})
	if m.env.T != proto.TAck || len(evs) != 1 || evs[0].T != proto.EvCodexServerUpdate {
		t.Fatalf("set: %s, events %+v", m.raw, evs)
	}
	if !strings.Contains(string(m.raw), `"enabled":true`) {
		t.Fatalf("set ack %s", m.raw)
	}
	sb.c.mustError(proto.CmdCodexServerSet, map[string]any{}, proto.ErrBadRequest)
	if en, ok, _ := sb.st.LoadCodexServerSettings(context.Background()); !en || !ok {
		t.Fatal("switch not stored")
	}

	// A bridge without a run directory cannot turn it on.
	hb := startHireBridge(t, nil)
	if cs := hb.connect(proto.Hello{}).snapshot().World.CodexServer; cs == nil || cs.Available {
		t.Fatalf("no run dir: %+v", cs)
	}
	hb.c.mustError(proto.CmdCodexServerSet, proto.CodexServerSetArgs{Enabled: ptr(true)}, proto.ErrUnsupported)
	hb.c.mustAck(proto.CmdCodexServerSet, proto.CodexServerSetArgs{Enabled: ptr(false)})
}

// The switch on: a Codex hire starts its own server from its pane, then
// the TUI attached to it; no socket or server setup is asked of anyone.
func TestSharedCodexHire(t *testing.T) {
	sb := startSharedBridge(t, true)
	args := codexHire(2)
	args.Prompt = "fix it"
	_, m := sb.c.command(proto.CmdWorkerHire, "h", args)
	res := ackData[proto.HireResult](t, m)
	if res.Codex == nil || res.Codex.Mode != proto.CodexModeShared || res.Codex.Server != proto.CodexServerRunning {
		t.Fatalf("hire result %s", m.raw)
	}
	hex := strings.ReplaceAll(res.ID, "-", "")
	name := hex[:12]
	agent := "" // the slug of a generated name
	l := sb.launches(t)[res.ID]
	agent = l.AgentName
	sock := codexRun + "/" + name + ".sock"
	want := []string{
		"create s /home/u/repo " + l.AgentName[:strings.LastIndex(l.AgentName, "-")],
		"mark w1:p1 h3d-" + name,
		"codex-server w1:p1 " + codexRun + "/" + name + ".fish",
		"codex-remote w1:p1 " + agent + " gpt-6-sol low " + sock + " /home/u/repo",
		`prompt w1:p1 "fix it"`,
	}
	calls := sb.fl.Calls()
	if len(calls) != len(want) || !slices.Equal(calls[1:], want[1:]) {
		t.Fatalf("herdr calls =\n%q\nwant\n%q", calls, want)
	}
	if hc := sb.host.Calls(); !slices.Equal(hc, []string{"preflight /home/u/repo", "prepare " + name + " /home/u/repo", "ready " + sock}) {
		t.Fatalf("host calls = %q", hc)
	}
	if l.Mode != store.CodexShared || l.Name != name || l.RunDir != codexRun || len(l.Token) != 32 || l.ServerPID != 4001 ||
		l.ServerStart != 77 || l.Cwd != "/home/u/repo" || l.Model != "gpt-6-sol" || l.Effort != "low" || l.Thread != "" {
		t.Fatalf("launch = %+v", l)
	}
	w := workersOf(sb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && x.Codex.Server == proto.CodexServerRunning
	}), "s")["w1"]
	if w.Codex.Mode != proto.CodexModeShared || w.Codex.Note != "" {
		t.Fatalf("worker codex = %+v", w.Codex)
	}
	row := auditRow(t, sb.bridge, proto.CmdWorkerHire)
	if !row.OK || !strings.Contains(row.Result, `"codex":"shared"`) || !strings.Contains(row.Result, "started the codex server (pid 4001)") {
		t.Fatalf("audit = %+v", row)
	}
}

// The switch off: a Codex hire is launched exactly as before, and nothing
// of the feature is recorded or shown.
func TestCodexHireWithTheSwitchOff(t *testing.T) {
	sb := startSharedBridge(t, false)
	_, m := sb.c.command(proto.CmdWorkerHire, "h", codexHire(2))
	res := ackData[proto.HireResult](t, m)
	if res.Codex != nil || strings.Contains(string(m.raw), "codex\":{") {
		t.Fatalf("hire result %s", m.raw)
	}
	calls := sb.fl.Calls()
	if len(calls) != 3 || !strings.HasPrefix(calls[2], "start-agent w1:p1 ") || !strings.Contains(calls[2], " codex gpt-6-sol low ") {
		t.Fatalf("herdr calls = %q", calls)
	}
	if hc := sb.host.Calls(); len(hc) != 0 {
		t.Fatalf("host calls = %q", hc)
	}
	if l := sb.launches(t); len(l) != 0 {
		t.Fatalf("launches = %+v", l)
	}
	w := workersOf(sb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].AgentKind == "codex" }), "s")["w1"]
	if w.Codex != nil {
		t.Fatalf("worker codex = %+v", w.Codex)
	}
	// A Claude hire never takes the shared path either.
	sb.c.mustAck(proto.CmdCodexServerSet, proto.CodexServerSetArgs{Enabled: ptr(true)})
	sb.c.mustAck(proto.CmdWorkerHire, hireArgs(3))
	if hc := sb.host.Calls(); len(hc) != 0 {
		t.Fatalf("host calls after a claude hire = %q", hc)
	}
}

// Whatever keeps the server from starting starts the worker the usual way,
// with the reason on the hire's result and on the worker.
func TestSharedCodexHireFallsBack(t *testing.T) {
	for name, tc := range map[string]struct {
		setup func(*sharedBridge)
		cwd   string
		note  string
		stops bool
	}{
		"blocked envrc": {setup: func(sb *sharedBridge) {
			sb.host.preErr = fmt.Errorf("%w: /home/u/repo/.envrc (run `direnv allow` there)", codexapp.ErrEnvrcBlocked)
		}, note: ".envrc is blocked"},
		"unsupported codex": {setup: func(sb *sharedBridge) {
			sb.host.preErr = fmt.Errorf("%w: \"codex-cli 0.161.0\"", codexapp.ErrUnsupported)
		}, note: "unsupported Codex version"},
		"server does not answer": {setup: func(sb *sharedBridge) {
			sb.host.readyErr = errors.New("the app-server did not answer")
		}, note: "did not answer", stops: true},
		"unsupported server": {setup: func(sb *sharedBridge) { sb.host.ua = "herdr_3d/0.170.0 (x)" }, note: "unsupported", stops: true},
		"unplain path":       {cwd: "/home/u/my repo", note: "characters the shared launch does not pass"},
	} {
		t.Run(name, func(t *testing.T) {
			sb := startSharedBridge(t, true)
			if tc.setup != nil {
				tc.setup(sb)
			}
			args := codexHire(1)
			if tc.cwd != "" {
				args.Cwd = tc.cwd
			}
			_, m := sb.c.command(proto.CmdWorkerHire, "h", args)
			res := ackData[proto.HireResult](t, m)
			if res.Codex == nil || res.Codex.Mode != proto.CodexModeLegacy || !strings.Contains(res.Codex.Note, tc.note) ||
				!strings.Contains(res.Codex.Note, "started the usual way") {
				t.Fatalf("hire result %s", m.raw)
			}
			calls := sb.fl.Calls()
			if !strings.HasPrefix(calls[len(calls)-1], "start-agent w1:p1 ") {
				t.Fatalf("herdr calls = %q", calls)
			}
			if stopped := len(sb.host.stopped) > 0; stopped != tc.stops {
				t.Fatalf("server stopped = %v, want %v (host calls %q)", stopped, tc.stops, sb.host.Calls())
			}
			l := sb.launches(t)[res.ID]
			if l.Mode != store.CodexLegacy || l.Note != res.Codex.Note {
				t.Fatalf("launch = %+v", l)
			}
			w := workersOf(sb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].Codex != nil }), "s")["w1"]
			if w.Codex.Mode != proto.CodexModeLegacy || w.Codex.Note != res.Codex.Note || w.Codex.Server != "" {
				t.Fatalf("worker codex = %+v", w.Codex)
			}
		})
	}
}

// The thread herdr reports for a shared worker's pane is kept: a missing
// one (herdr forgets it when the TUI exits) changes nothing, and another
// worker's thread is never taken.
func TestSharedCodexThread(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	_, m = sb.c.command(proto.CmdWorkerHire, "b", codexHire(2))
	b := ackData[proto.HireResult](t, m)
	const th1, th2 = "01a11172-ac09-7aa0-ab6b-84485199ada3", "01a11172-ac09-7aa0-ab6b-000000000002"
	thread := func(id string) string { return sb.launches(t)[id].Thread }
	waitFor := func(what string, ok func() bool) {
		t.Helper()
		for end := time.Now().Add(2 * time.Second); !ok(); time.Sleep(10 * time.Millisecond) {
			if time.Now().After(end) {
				t.Fatalf("never: %s (a %q, b %q)", what, thread(a.ID), thread(b.ID))
			}
		}
	}
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = th1 })
	waitFor("a has th1", func() bool { return thread(a.ID) == th1 })
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "" })
	sb.fl.update("w2", func(w *world.WorkerObs) { w.AgentSession = th1 }) // a's thread, misrouted
	sb.fl.update("w2", func(w *world.WorkerObs) { w.AgentSession = th2 })
	waitFor("b has th2", func() bool { return thread(b.ID) == th2 })
	if thread(a.ID) != th1 {
		t.Fatalf("a's thread = %q", thread(a.ID))
	}
}

// Sleep: each shared worker's TUI quits (so herdr saves no session to
// resume it its own way) and its server stops, before the session; it is
// never backfilled. Wake: the bridge starts its server from its pane again
// and resumes its thread attached to it, without a permission override.
func TestSharedCodexSleepAndWake(t *testing.T) {
	sb := startSharedBridge(t, true, claudeW("w9", "sess-9"))
	sb.fl.setProcs("w9:p1", running("claude", "sess-9"))
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	sb.fl.update("w2", func(w *world.WorkerObs) { w.AgentSession = th })
	for end := time.Now().Add(2 * time.Second); sb.launches(t)[a.ID].Thread != th; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("thread not recorded")
		}
	}
	l := sb.launches(t)[a.ID]
	sock := codexRun + "/" + l.Name + ".sock"

	fh := sb.fl.fakeHerdr
	var awake []world.WorkerObs
	fh.onQuit = func(pane string) { // herdr releases the pane's agent and forgets its session
		sb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.AgentSession, w.AgentKind, w.Status = "", "", "unknown" })
	}
	fh.onStop = func() {
		sb.fl.mu.Lock()
		awake = slices.Clone(sb.fl.workers)
		sb.fl.mu.Unlock()
		sb.floorAt("s", false, withStatus(awake, "unknown"))
	}
	before := len(fh.Calls())
	sb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	calls := fh.Calls()[before:]
	if !slices.Equal(calls, []string{"exit w2:p1", "key w2:p1 enter", "stop s"}) {
		t.Fatalf("sleep calls = %q", calls)
	}
	if st := sb.host.stopped; len(st) != 1 || st[0].Token != l.Token || st[0].Name != l.Name {
		t.Fatalf("stopped = %+v", st)
	}
	l = sb.launches(t)[a.ID]
	if l.Thread != th || l.ServerPID != 0 {
		t.Fatalf("launch after sleep = %+v", l)
	}
	row := auditRow(t, sb.bridge, proto.CmdFloorSleep)
	if !strings.Contains(row.Result, `"shared":[{"worker":"`+a.ID) || !strings.Contains(row.Result, "stopped its codex server") {
		t.Fatalf("sleep audit = %+v", row)
	}

	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w9:p1", running("claude", "sess-9"))
		fh.setProcs("w2:p1", atShell())
		sb.floorAt("s", true, withStatus(awake, "idle"))
	}
	before = len(fh.Calls())
	_, ack := sb.c.mustAck(proto.CmdFloorWake, proto.FloorArgs{Session: "s"})
	calls = fh.Calls()[before:]
	l2 := sb.launches(t)[a.ID]
	wantResume := "codex-resume w2:p1 " + l.AgentName + " " + th + " gpt-6-sol low " + sock + " /home/u/repo"
	if !slices.Contains(calls, "codex-server w2:p1 "+codexRun+"/"+l.Name+".fish") || !slices.Contains(calls, wantResume) {
		t.Fatalf("wake calls = %q", calls)
	}
	for _, c := range calls {
		if strings.HasPrefix(c, "resume ") && strings.Contains(c, "w2:p1") {
			t.Fatalf("the shared worker got herdr's resume: %q", calls)
		}
	}
	if l2.ServerPID == 0 || l2.Token == l.Token || l2.Thread != th {
		t.Fatalf("launch after wake = %+v (before %+v)", l2, l)
	}
	resumes := map[string]string{}
	for _, w := range ack.Data.(map[string]any)["workers"].([]any) {
		w := w.(map[string]any)
		resumes[w["id"].(string)] = w["resume"].(string)
	}
	if resumes[a.ID] != proto.ResumeFallback {
		t.Fatalf("wake result = %+v", ack.Data)
	}
	w := workersOf(sb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w2"]
		return x.Codex != nil && x.Codex.Server == proto.CodexServerRunning
	}), "s")["w2"]
	if w.Resume != proto.ResumeFallback {
		t.Fatalf("worker after wake = %+v", w)
	}
}

// A shared worker herdr resumed its own way anyway (a plain `codex
// resume`, no --remote) is quit first, then relaunched attached.
func TestSharedCodexWakeQuitsHerdrsResume(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = th })
	for end := time.Now().Add(2 * time.Second); sb.launches(t)[a.ID].Thread != th; time.Sleep(10 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("thread not recorded")
		}
	}
	fh := sb.fl.fakeHerdr
	var awake []world.WorkerObs
	fh.onStop = func() {
		sb.fl.mu.Lock()
		awake = slices.Clone(sb.fl.workers)
		sb.fl.mu.Unlock()
		sb.floorAt("s", false, withStatus(awake, "unknown"))
	}
	sb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", running("codex", th)) // "codex --resume <th>": no --remote
		sb.floorAt("s", true, withStatus(awake, "idle"))
	}
	before := len(fh.Calls())
	sb.c.mustAck(proto.CmdFloorWake, proto.FloorArgs{Session: "s"})
	calls := fh.Calls()[before:]
	i, j := slices.Index(calls, "exit w1:p1"), slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-resume w1:p1 ") })
	if i < 0 || j < i {
		t.Fatalf("wake calls = %q", calls)
	}
	row := auditRow(t, sb.bridge, proto.CmdFloorWake)
	if !strings.Contains(row.Result, "herdr had resumed it without its server") {
		t.Fatalf("wake audit = %+v", row)
	}
}

// Send home stops the worker's server once its TUI quit, and forgets it.
func TestSharedCodexSendHome(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	l := sb.launches(t)[a.ID]
	before := len(sb.fl.Calls())
	sb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: a.ID})
	calls := sb.fl.Calls()[before:]
	if !slices.Equal(calls, []string{"exit w1:p1", "key w1:p1 enter", "close w1"}) {
		t.Fatalf("send home calls = %q", calls)
	}
	if st := sb.host.stopped; len(st) != 1 || st[0].Token != l.Token {
		t.Fatalf("stopped = %+v", st)
	}
	if all := sb.launches(t); len(all) != 0 {
		t.Fatalf("launches after send home = %+v", all)
	}
	row := auditRow(t, sb.bridge, proto.CmdWorkerFire)
	if !strings.Contains(row.Result, "stopped its codex server") {
		t.Fatalf("audit = %+v", row)
	}
}

// A server that dies is reported (herdr would show the TUI as working).
func TestSharedCodexServerDown(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	sb.host.kill(sb.launches(t)[a.ID].ServerPID)
	sb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && x.Codex.Server == proto.CodexServerDown
	})
}

// While a shared worker's transcript is open the bridge joins its thread
// (thread id and socket only), and leaves when it closes.
// #156: the bridge joins a shared worker's thread once herdr reported it
// and while its server runs, whether or not its transcript is open (so an
// async question asked meanwhile is seen and can be answered); the
// transcript closing leaves the join as it is.
func TestSharedCodexJoinsWithoutTheTranscript(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = th })
	w := workersOf(sb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && x.Codex.Attached
	}), "s")["w1"]
	if w.Codex.Server != proto.CodexServerRunning || w.Codex.Thread != th {
		t.Fatalf("worker codex = %+v", w.Codex)
	}
	sb.host.mu.Lock()
	joined := sb.host.watches[0].o
	sb.host.mu.Unlock()
	if joined.Thread != th || joined.Socket != codexRun+"/"+sb.launches(t)[a.ID].Name+".sock" {
		t.Fatalf("joined %+v", joined)
	}
	sb.c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: a.ID})
	sb.c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: a.ID})
	time.Sleep(100 * time.Millisecond) // several CodexPoll ticks
	sb.host.mu.Lock()
	n, closed := len(sb.host.watches), sb.host.watches[0].closed
	sb.host.mu.Unlock()
	if n != 1 || closed {
		t.Fatalf("the transcript's watch changed the join: %d joins, closed %v", n, closed)
	}
	if x := workersOf(sb.world(func(proto.World) bool { return true }), "s")["w1"]; x.Codex == nil || !x.Codex.Attached {
		t.Fatalf("worker codex = %+v", x.Codex)
	}
}

// hireAndSleep hires a shared worker at desk 1 (pane w1:p1), lets herdr
// report thread for it (none when ""), and puts the floor to sleep; the
// wake that follows brings the pane back at its shell.
func (sb *sharedBridge) hireAndSleep(t *testing.T, thread string) proto.HireResult {
	t.Helper()
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	if thread != "" {
		sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = thread })
		for end := time.Now().Add(2 * time.Second); sb.launches(t)[a.ID].Thread != thread; time.Sleep(10 * time.Millisecond) {
			if time.Now().After(end) {
				t.Fatal("thread not recorded")
			}
		}
	}
	fh := sb.fl.fakeHerdr
	var awake []world.WorkerObs
	fh.onQuit = func(pane string) {
		sb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.AgentSession, w.AgentKind, w.Status = "", "", "unknown" })
	}
	fh.onStop = func() {
		sb.fl.mu.Lock()
		awake = slices.Clone(sb.fl.workers)
		sb.fl.mu.Unlock()
		sb.floorAt("s", false, withStatus(awake, "unknown"))
	}
	sb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	if l := sb.launches(t)[a.ID]; l.ServerPID != 0 {
		t.Fatalf("launch after sleep = %+v", l)
	}
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", atShell())
		sb.floorAt("s", true, withStatus(awake, "idle"))
	}
	return a
}

// wakeResumes wakes the floor and returns the herdr calls the wake made and
// each worker's resume outcome.
func (sb *sharedBridge) wakeResumes(t *testing.T) ([]string, map[string]string) {
	t.Helper()
	before := len(sb.fl.Calls())
	_, ack := sb.c.mustAck(proto.CmdFloorWake, proto.FloorArgs{Session: "s"})
	resumes := map[string]string{}
	for _, w := range ack.Data.(map[string]any)["workers"].([]any) {
		w := w.(map[string]any)
		resumes[w["id"].(string)] = w["resume"].(string)
	}
	return sb.fl.Calls()[before:], resumes
}

// A shared worker that slept before herdr reported its thread (e.g. on
// Codex's hooks review) is relaunched on wake: its server, then a new TUI
// attached to it. No thread is resumed or guessed.
func TestSharedCodexWakeWithoutThread(t *testing.T) {
	sb := startSharedBridge(t, true)
	a := sb.hireAndSleep(t, "")
	l := sb.launches(t)[a.ID]
	calls, resumes := sb.wakeResumes(t)
	sock := codexRun + "/" + l.Name + ".sock"
	if !slices.Contains(calls, "codex-server w1:p1 "+codexRun+"/"+l.Name+".fish") ||
		!slices.Contains(calls, "codex-remote w1:p1 "+l.AgentName+" gpt-6-sol low "+sock+" /home/u/repo") {
		t.Fatalf("wake calls = %q", calls)
	}
	for _, c := range calls {
		if strings.HasPrefix(c, "codex-resume") || strings.HasPrefix(c, "resume ") {
			t.Fatalf("a thread was resumed: %q", calls)
		}
	}
	if l2 := sb.launches(t)[a.ID]; l2.ServerPID == 0 || l2.Thread != "" || l2.Mode != store.CodexShared {
		t.Fatalf("launch after wake = %+v", l2)
	}
	if resumes[a.ID] != proto.ResumeFallback {
		t.Fatalf("resumes = %+v", resumes)
	}
	if row := auditRow(t, sb.bridge, proto.CmdFloorWake); !strings.Contains(row.Result, "no thread was recorded") {
		t.Fatalf("wake audit = %+v", row)
	}
}

// A shared worker whose server does not come back on wake (or whose
// terminal does not attach to it) resumes its thread on Codex's embedded
// server with hire's model arguments, never an argument-free `codex
// resume`; it stays shared, with the reason on it, and the next wake tries
// its server again.
func TestSharedCodexWakeFallsBack(t *testing.T) {
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	for name, tc := range map[string]struct {
		thread string
		setup  func(*sharedBridge)
		want   string // the fallback's herdr call, after the pane and agent
		note   string
		trust  bool // the embedded Codex's trust dialog is answered
	}{
		"server does not answer": {thread: th, setup: func(sb *sharedBridge) {
			sb.host.readyErr = errors.New("app-server connection failed")
		}, want: "codex-resume-embedded w1:p1 %s " + th + " gpt-6-sol low", note: "app-server connection failed"},
		"unsupported server": {thread: th, setup: func(sb *sharedBridge) { sb.host.ua = "herdr_3d/0.170.0 (x)" },
			want: "codex-resume-embedded w1:p1 %s " + th + " gpt-6-sol low", note: "unsupported"},
		"terminal does not attach": {thread: th, setup: func(sb *sharedBridge) {
			sb.fl.fakeHerdr.remoteErr = errors.New("herdr control resume-codex-remote: timeout")
		}, want: "codex-resume-embedded w1:p1 %s " + th + " gpt-6-sol low", note: "did not attach"},
		"no thread": {setup: func(sb *sharedBridge) { sb.host.readyErr = errors.New("app-server connection failed") },
			want: "start-agent w1:p1 %s codex gpt-6-sol low ", note: "app-server connection failed"},
		// The embedded server has no in-memory trust: its dialog is
		// answered as a hire answers it.
		"trust dialog": {thread: th, setup: func(sb *sharedBridge) {
			sb.host.readyErr = errors.New("app-server connection failed")
			sb.fl.fakeHerdr.embeddedErr = &herdr.APIError{Code: "agent_not_ready", Message: "blocked during startup"}
			sb.fl.mu.Lock()
			sb.fl.screens["w1:p1"] = []string{"  Folder access\n  /home/u/repo\n  Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n  2. Quit"}
			sb.fl.mu.Unlock()
		}, want: "codex-resume-embedded w1:p1 %s " + th + " gpt-6-sol low", note: "app-server connection failed",
			trust: true},
	} {
		t.Run(name, func(t *testing.T) {
			sb := startSharedBridge(t, true)
			a := sb.hireAndSleep(t, tc.thread)
			l := sb.launches(t)[a.ID]
			tc.setup(sb)
			calls, resumes := sb.wakeResumes(t)
			if !slices.Contains(calls, fmt.Sprintf(tc.want, l.AgentName)) {
				t.Fatalf("wake calls = %q", calls)
			}
			for _, c := range calls {
				if strings.HasPrefix(c, "resume ") {
					t.Fatalf("an argument-free codex resume: %q", calls)
				}
			}
			if resumes[a.ID] != proto.ResumeFallback {
				t.Fatalf("resumes = %+v", resumes)
			}
			if i := slices.Index(calls, fmt.Sprintf(tc.want, l.AgentName)); tc.trust != slices.Contains(calls[i:], "key w1:p1 enter") {
				t.Fatalf("trust answered = %v: wake calls %q", !tc.trust, calls)
			}
			if row := auditRow(t, sb.bridge, proto.CmdFloorWake); tc.trust && !strings.Contains(row.Result, "answered the codex trust dialog") {
				t.Fatalf("wake audit = %+v", row)
			}
			l2 := sb.launches(t)[a.ID]
			if l2.Mode != store.CodexShared || l2.ServerPID != 0 || l2.Thread != tc.thread || !strings.Contains(l2.Note, tc.note) ||
				!strings.Contains(l2.Note, "without its own server") {
				t.Fatalf("launch after wake = %+v", l2)
			}
			if len(sb.host.stopped) != 2 { // sleep's, and the failed start's
				t.Fatalf("stopped = %+v", sb.host.stopped)
			}
			w := workersOf(sb.world(func(w proto.World) bool {
				x := workersOf(w, "s")["w1"]
				return x.Codex != nil && x.Codex.Note == l2.Note
			}), "s")["w1"]
			if w.Codex.Mode != proto.CodexModeShared || w.Codex.Server != proto.CodexServerStopped {
				t.Fatalf("worker codex = %+v", w.Codex)
			}
		})
	}
}

// A failed join (here a permanent refusal) is not retried while its target
// is unchanged; reopening the transcript, or a new server, tries again.
func TestSharedCodexFailedJoinIsKept(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = th })
	watches := func() int {
		sb.host.mu.Lock()
		defer sb.host.mu.Unlock()
		return len(sb.host.watches)
	}
	awaitWatches := func(n int) {
		t.Helper()
		for end := time.Now().Add(2 * time.Second); watches() < n; time.Sleep(10 * time.Millisecond) {
			if time.Now().After(end) {
				t.Fatalf("%d joins, want %d", watches(), n)
			}
		}
	}
	fail := func() {
		sb.host.mu.Lock()
		w := sb.host.watches[len(sb.host.watches)-1]
		sb.host.mu.Unlock()
		w.o.OnEvent(codexapp.Event{Kind: codexapp.EvFailed, Err: codexapp.ErrEphemeral})
		sb.world(func(w proto.World) bool {
			x := workersOf(w, "s")["w1"]
			return x.Codex != nil && !x.Codex.Attached
		})
		time.Sleep(150 * time.Millisecond) // several CodexPoll ticks
	}
	sb.c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: a.ID})
	awaitWatches(1)
	fail()
	if n := watches(); n != 1 {
		t.Fatalf("a failed join was retried: %d joins", n)
	}
	sb.c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: a.ID})
	sb.c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: a.ID})
	awaitWatches(2)
	fail()
	if n := watches(); n != 2 {
		t.Fatalf("a failed join was retried: %d joins", n)
	}
	// The new server of a sleep and wake is joined.
	fh := sb.fl.fakeHerdr
	var awake []world.WorkerObs
	fh.onStop = func() {
		sb.fl.mu.Lock()
		awake = slices.Clone(sb.fl.workers)
		sb.fl.mu.Unlock()
		sb.floorAt("s", false, withStatus(awake, "unknown"))
	}
	sb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	fh.onStart = func() {
		fh.setUp("sock-s", true)
		fh.setProcs("w1:p1", atShell())
		sb.floorAt("s", true, withStatus(awake, "idle"))
	}
	sb.c.mustAck(proto.CmdFloorWake, proto.FloorArgs{Session: "s"})
	sb.c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: a.ID}) // a sleep ends it
	awaitWatches(3)
	sb.host.mu.Lock()
	sock := sb.host.watches[2].o.Socket
	sb.host.mu.Unlock()
	if sock != codexRun+"/"+sb.launches(t)[a.ID].Name+".sock" {
		t.Fatalf("joined %s", sock)
	}
}

// A shared worker whose terminal does not quit is never sent Ctrl-C: on a
// dialog the bridge did not expect it opens Codex's agent command center,
// which lists the user's other threads (B10). Nothing is closed or
// stopped: its terminal stays usable, and it can be sent home again.
func TestSharedCodexSendHomeSendsNoCtrlC(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	sb.fl.exitWorks = false
	before := len(sb.fl.Calls())
	_, m = sb.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: a.ID})
	if e := errorOf(m); e.Code != proto.ErrFireFailed || !strings.Contains(e.Message, "still running") ||
		!strings.Contains(e.Message, "no Ctrl-C") || !strings.Contains(e.Message, "nothing was closed") {
		t.Fatalf("reply = %s", m.raw)
	}
	calls := sb.fl.Calls()[before:]
	if !slices.Equal(calls, []string{"exit w1:p1", "key w1:p1 enter", "key w1:p1 enter", "key w1:p1 enter", "key w1:p1 enter"}) {
		t.Fatalf("send home calls = %q", calls)
	}
	if len(sb.host.stopped) != 0 {
		t.Fatalf("stopped = %+v", sb.host.stopped)
	}
	if l := sb.launches(t)[a.ID]; l.ServerPID == 0 || l.Mode != store.CodexShared {
		t.Fatalf("launch = %+v", l)
	}
	row := auditRow(t, sb.bridge, proto.CmdWorkerFire)
	if row.OK || !strings.Contains(row.Result, "no Ctrl-C") {
		t.Fatalf("audit = %+v", row)
	}
	// Quit by the player, it goes home.
	sb.fl.exitWorks = true
	sb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: a.ID})
	if len(sb.host.stopped) != 1 || len(sb.launches(t)) != 0 {
		t.Fatalf("stopped = %+v, launches %+v", sb.host.stopped, sb.launches(t))
	}
}

// #158: a shared worker whose server died has a TUI that only waits to
// reconnect and ignores /quit. The sleep quits it with one Ctrl-C (what
// that TUI offers), so herdr forgets its session and the wake relaunches
// it attached; a TUI whose server still runs never gets one.
func TestSharedCodexSleepQuitsATerminalWhoseServerDied(t *testing.T) {
	for _, dead := range []bool{true, false} {
		t.Run(fmt.Sprintf("server dead %v", dead), func(t *testing.T) {
			sb := startSharedBridge(t, true)
			_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
			a := ackData[proto.HireResult](t, m)
			fh := sb.fl.fakeHerdr
			fh.quitOnCtrlC = true
			fh.onQuit = func(pane string) {
				sb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.AgentSession, w.AgentKind, w.Status = "", "", "unknown" })
			}
			fh.onStop = func() { sb.floorAt("s", false, nil) }
			if dead {
				sb.host.kill(sb.launches(t)[a.ID].ServerPID)
			}
			before := len(fh.Calls())
			sb.c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
			calls := fh.Calls()[before:]
			want := []string{"exit w1:p1", "key w1:p1 enter", "key w1:p1 enter", "key w1:p1 enter"}
			if dead {
				want = append(want, "key w1:p1 ctrl+c")
			}
			if !slices.Equal(calls, append(want, "stop s")) {
				t.Fatalf("sleep calls = %q", calls)
			}
			row := auditRow(t, sb.bridge, proto.CmdFloorSleep)
			if dead != strings.Contains(row.Result, "its terminal quit on Ctrl-C") ||
				dead == strings.Contains(row.Result, "its terminal did not quit") {
				t.Fatalf("sleep audit = %+v", row)
			}
		})
	}
}

// #158: send home quits a shared worker whose server died the way it quits
// a legacy one (Ctrl-C after /quit), then stops what is left of its server.
func TestSharedCodexSendHomeWhenItsServerDied(t *testing.T) {
	sb := startSharedBridge(t, true)
	_, m := sb.c.command(proto.CmdWorkerHire, "a", codexHire(1))
	a := ackData[proto.HireResult](t, m)
	l := sb.launches(t)[a.ID]
	sb.host.kill(l.ServerPID)
	sb.fl.exitWorks = false
	sb.fl.onKey = func(pane string, key herdr.Key) {
		if key == herdr.KeyCtrlC {
			sb.fl.setProcs(pane, atShell())
		}
	}
	before := len(sb.fl.Calls())
	sb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: a.ID})
	calls := sb.fl.Calls()[before:]
	if !slices.Contains(calls, "key w1:p1 ctrl+c") || calls[len(calls)-1] != "close w1" {
		t.Fatalf("send home calls = %q", calls)
	}
	if st := sb.host.stopped; len(st) != 1 || st[0].Token != l.Token || len(sb.launches(t)) != 0 {
		t.Fatalf("stopped = %+v, launches %+v", st, sb.launches(t))
	}
}
