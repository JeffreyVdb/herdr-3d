package server_test

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// fakeFloor is server.HireHerdr (and wake/sleep's FloorHerdr) playing one
// running herdr session: workspaces it creates or closes are published to
// the bridge like the watcher would, panes run what procs says.
type fakeFloor struct {
	*fakeHerdr
	b       *bridge
	session string

	mu      sync.Mutex
	next    int
	workers []world.WorkerObs
	screens map[string][]string // pane → screens ReadPane returns in turn (the last one sticks)
	keys    []string
	// hooks and failures
	startErr     error
	createErr    error // #62: CreateWorkspace fails with it (nothing made)
	markErr      error
	promptErrs   []error
	promptGate   chan struct{} // #108: Prompt waits for it, once recorded, before it returns
	typeErrs     []error       // #95: TypePrompt's results in turn
	typeDrops    int           // #95: typed prompts whose Enter the agent drops (it starts on the next one)
	startStatus  string        // #95: the status a started agent has (default idle)
	publishEarly bool          // publish a new workspace before CreateWorkspace returns
	createGate   chan struct{} // CreateWorkspace waits for it when set
	exitWorks    bool          // TypeExit + Enter bring the pane back to its shell
	// noMainCheckout: a worktree hire does not open the repository's main checkout
	noMainCheckout bool
	closeErrs      map[string]error // workspace → CloseWorkspace's error
	onKey          func(pane string, key herdr.Key)
	removeGate     chan struct{}            // #63: RemoveWorktree waits for it when set
	removeErr      error                    // #63: RemoveWorktree fails with it (nothing removed)
	decorate       func(w *world.WorkerObs) // sets what the watcher derives (role, run) of a new workspace
	// fresh is what a fresh read of herdr (Options.Fresh) returns instead of the floor as published.
	fresh func(published []world.WorkerObs) ([]world.WorkerObs, error)
}

func newFakeFloor(b *bridge, session string, fh *fakeHerdr, workers ...world.WorkerObs) *fakeFloor {
	f := &fakeFloor{fakeHerdr: fh, b: b, session: session, next: len(workers) + 1, workers: workers,
		screens: map[string][]string{}, exitWorks: true}
	return f
}

// publish sends the floor as it is now; generations follow the order the
// states were taken in, so a late publish never undoes a newer one.
func (f *fakeFloor) publish() {
	f.mu.Lock()
	obs := world.FloorObs{Session: f.session, Running: true, Gen: world.NextGen(), Socket: "sock-" + f.session,
		Workers: slices.Clone(f.workers)}
	f.mu.Unlock()
	f.b.publish(obs)
}

// Fresh is Options.Fresh: herdr's state right now.
func (f *fakeFloor) Fresh(_ context.Context, socket string) ([]world.WorkerObs, error) {
	f.mu.Lock()
	cur, fresh := slices.Clone(f.workers), f.fresh
	f.mu.Unlock()
	if fresh != nil {
		return fresh(cur)
	}
	return cur, nil
}

func (f *fakeFloor) create(dir, label string, wt *world.Worktree) herdr.Created {
	f.mu.Lock()
	ws := fmt.Sprintf("w%d", f.next)
	f.next++
	w := world.WorkerObs{WorkspaceID: ws, Label: label, Cwd: dir, IdentityCwd: dir, PaneID: ws + ":p1", Status: "unknown",
		Worktree: wt}
	if f.decorate != nil {
		f.decorate(&w)
	}
	f.workers = append(f.workers, w)
	f.mu.Unlock()
	f.setProcs(ws+":p1", atShell())
	cr := herdr.Created{WorkspaceID: ws, PaneID: ws + ":p1"}
	if wt != nil {
		cr.CheckoutPath = wt.CheckoutPath
	}
	return cr
}

func (f *fakeFloor) CreateWorkspace(ctx context.Context, session, dir, label string) (herdr.Created, error) {
	f.record("create %s %s %s", session, dir, label)
	if f.createGate != nil {
		select {
		case <-f.createGate:
		case <-ctx.Done():
			return herdr.Created{}, ctx.Err()
		}
	}
	if f.createErr != nil {
		return herdr.Created{}, f.createErr
	}
	cr := f.create(dir, label, nil)
	if f.publishEarly {
		f.publish()
		time.Sleep(20 * time.Millisecond) // the hub applies it before the hire binds
	} else {
		go f.publish()
	}
	return cr, nil
}

func (f *fakeFloor) CreateWorktree(_ context.Context, session, repo, branch, base, label string) (herdr.Created, error) {
	f.record("worktree %s %s %s %s %s", session, repo, branch, base, label)
	// Like herdr: the first worktree of a repository on a floor opens its
	// main checkout too (a shell, no agent).
	f.mu.Lock()
	mainOpen := slices.ContainsFunc(f.workers, func(w world.WorkerObs) bool { return w.IsMainCheckout() && w.Worktree.RepoRoot == repo })
	f.mu.Unlock()
	if !mainOpen && !f.noMainCheckout {
		f.create(repo, "repo", &world.Worktree{RepoRoot: repo, RepoName: "repo", CheckoutPath: repo})
	}
	path := "/home/u/.herdr/worktrees/repo/" + strings.ReplaceAll(branch, "/", "-")
	cr := f.create(path, label, &world.Worktree{RepoRoot: repo, RepoName: "repo", CheckoutPath: path, Linked: true})
	cr.Branch = branch
	go f.publish()
	return cr, nil
}

func (f *fakeFloor) update(ws string, fn func(*world.WorkerObs)) {
	f.mu.Lock()
	for i := range f.workers {
		if f.workers[i].WorkspaceID == ws {
			fn(&f.workers[i])
		}
	}
	f.mu.Unlock()
	f.publish()
}

func wsOf(pane string) string { ws, _, _ := strings.Cut(pane, ":"); return ws }

func (f *fakeFloor) MarkPane(_ context.Context, session, pane, marker string) error {
	f.record("mark %s %s", pane, marker)
	if f.markErr != nil {
		return f.markErr
	}
	f.update(wsOf(pane), func(w *world.WorkerObs) { w.PaneLabel, w.Markers = marker, []string{marker} })
	return nil
}

func (f *fakeFloor) StartAgent(_ context.Context, session, pane, name string, a herdr.Agent) error {
	f.record("start-agent %s %s %s %s %s %s", pane, name, a.Harness, a.Model, a.Effort, a.Label)
	f.setProcs(pane, running(a.Harness, ""))
	f.mu.Lock()
	status := cmp.Or(f.startStatus, "idle")
	f.mu.Unlock()
	f.update(wsOf(pane), func(w *world.WorkerObs) { w.AgentKind, w.Status, w.Harness = a.Harness, status, a.Harness })
	return f.startErr
}

// StartCodexRemote is StartAgent for a shared-server Codex hire (#155).
func (f *fakeFloor) StartCodexRemote(ctx context.Context, session, pane, name string, a herdr.Agent, r herdr.Remote) error {
	f.fakeHerdr.StartCodexRemote(ctx, session, pane, name, a, r)
	f.mu.Lock()
	status := cmp.Or(f.startStatus, "idle")
	f.mu.Unlock()
	f.update(wsOf(pane), func(w *world.WorkerObs) { w.AgentKind, w.Status, w.Harness = "codex", status, "codex" })
	return f.startErr
}

func (f *fakeFloor) ReadPane(_ context.Context, session, pane string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := f.screens[pane]
	if len(s) == 0 {
		return "❯ ", nil
	}
	if len(s) > 1 {
		f.screens[pane] = s[1:]
	}
	return s[0], nil
}

func (f *fakeFloor) SendKey(_ context.Context, session, pane string, key herdr.Key) error {
	f.record("key %s %s", pane, key)
	f.mu.Lock()
	f.keys = append(f.keys, string(key))
	// The dialog goes away once answered.
	if key == herdr.KeyEnter && len(f.screens[pane]) > 0 {
		f.screens[pane] = []string{"❯ "}
	}
	exitWorks, onKey := f.exitWorks, f.onKey
	f.mu.Unlock()
	if onKey != nil {
		onKey(pane, key)
	}
	if key == herdr.KeyEnter && exitWorks && slices.Contains(f.Calls(), "exit "+pane) {
		f.setProcs(pane, atShell())
	}
	return nil
}

func (f *fakeFloor) Prompt(_ context.Context, session, pane, text string) error {
	f.record("prompt %s %q", pane, text)
	f.mu.Lock()
	gate := f.promptGate
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.promptErrs) > 0 {
		err := f.promptErrs[0]
		f.promptErrs = f.promptErrs[1:]
		return err
	}
	return nil
}

// takeTurn is the agent of workspace ws taking a short turn: it works,
// then is back to its status.
func (f *fakeFloor) takeTurn(ws string) {
	var was string
	f.update(ws, func(w *world.WorkerObs) { was, w.Status = w.Status, "working" })
	f.update(ws, func(w *world.WorkerObs) { w.Status = was })
}

// TypePrompt is #95's typed prompt: the agent takes a turn, unless it
// drops the Enter (typeDrops): then it stays as it is.
func (f *fakeFloor) TypePrompt(_ context.Context, session, pane, text string) error {
	f.record("type %s %q", pane, text)
	f.mu.Lock()
	var err error
	if len(f.typeErrs) > 0 {
		err, f.typeErrs = f.typeErrs[0], f.typeErrs[1:]
	}
	drop := err == nil && f.typeDrops > 0
	if drop {
		f.typeDrops--
	}
	f.mu.Unlock()
	if err == nil && !drop {
		f.takeTurn(wsOf(pane))
	}
	return err
}

// EraseTyped is #95 R1's erase of a partly typed prompt.
func (f *fakeFloor) EraseTyped(_ context.Context, session, pane string, n int) error {
	f.record("erase %s %d", pane, n)
	return nil
}

func (f *fakeFloor) TypeExit(_ context.Context, session, pane, harness string) error {
	f.record("exit %s", pane)
	return nil
}

func (f *fakeFloor) close(ws string) {
	f.mu.Lock()
	f.workers = slices.DeleteFunc(f.workers, func(w world.WorkerObs) bool { return w.WorkspaceID == ws })
	f.mu.Unlock()
	f.publish()
}

func (f *fakeFloor) CloseWorkspace(_ context.Context, session, ws string) error {
	f.record("close %s", ws)
	f.mu.Lock()
	err := f.closeErrs[ws]
	f.mu.Unlock()
	if err != nil {
		return err
	}
	f.close(ws)
	return nil
}

func (f *fakeFloor) RemoveWorktree(_ context.Context, session, ws string) error {
	f.record("remove-worktree %s", ws)
	f.mu.Lock()
	gate, err := f.removeGate, f.removeErr
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	if err != nil {
		return err
	}
	f.close(ws)
	return nil
}

// fakeGit plays git for a few directories.
type fakeGit struct {
	mu       sync.Mutex
	calls    []string
	repos    map[string]string   // dir → top level
	mains    map[string]string   // dir in a linked worktree → its main checkout
	dirty    map[string][]string // top ("*": any) → porcelain lines
	unpushed map[string]int
	current  map[string]string // checkout → branch, else as named by its path
	ahead    map[string]int    // branch → commits on no remote
	tips     map[string]string // branch ("*": any) → commit, else sha
	fetchErr error
	def      string
	sha      string
	onStatus func(dir string) // called before each Status, outside mu
	onBranch func(dir string) // #63: called before each CurrentBranch, outside mu
}

func newFakeGit() *fakeGit {
	return &fakeGit{repos: map[string]string{}, mains: map[string]string{}, dirty: map[string][]string{}, unpushed: map[string]int{},
		current: map[string]string{}, ahead: map[string]int{}, tips: map[string]string{}, def: "main",
		sha: "8739ddc5f3e1d0c4b2a8e7f6d5c4b3a2918e7d6c"}
}

func (g *fakeGit) record(format string, args ...any) {
	g.mu.Lock()
	g.calls = append(g.calls, fmt.Sprintf(format, args...))
	g.mu.Unlock()
}

func (g *fakeGit) Calls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.calls)
}

func (g *fakeGit) TopLevel(_ context.Context, dir string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if top, ok := g.repos[dir]; ok {
		return top, nil
	}
	return "", gitops.ErrNotRepo
}

func (g *fakeGit) MainCheckout(_ context.Context, dir string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if main, ok := g.mains[dir]; ok {
		return main, nil
	}
	if top, ok := g.repos[dir]; ok {
		return top, nil
	}
	return "", gitops.ErrNotRepo
}

func (g *fakeGit) Fetch(_ context.Context, dir string) error {
	g.record("fetch %s", dir)
	return g.fetchErr
}

func (g *fakeGit) DefaultBranch(context.Context, string) string { return g.def }

func (g *fakeGit) Commit(_ context.Context, dir, ref string) (string, time.Time, error) {
	g.record("commit %s %s", dir, ref)
	return g.sha, time.UnixMilli(1790600000000), nil
}

func (g *fakeGit) Status(_ context.Context, dir string) ([]string, error) {
	g.mu.Lock()
	hook := g.onStatus
	g.mu.Unlock()
	if hook != nil {
		hook(dir)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if d, ok := g.dirty[dir]; ok {
		return slices.Clone(d), nil
	}
	return slices.Clone(g.dirty["*"]), nil
}

func (g *fakeGit) Unpushed(_ context.Context, dir string) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.unpushed[dir], nil
}

func (g *fakeGit) CurrentBranch(_ context.Context, dir string) (string, error) {
	g.mu.Lock()
	hook := g.onBranch
	g.mu.Unlock()
	if hook != nil {
		hook(dir)
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if b, ok := g.current[dir]; ok {
		return b, nil
	}
	_, b, _ := strings.Cut(dir, "/repo/")
	return strings.Replace(b, "h3d-", "h3d/", 1), nil
}

func (g *fakeGit) BranchUnpushed(_ context.Context, dir, branch string) (int, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.ahead[branch], nil
}

func (g *fakeGit) BranchTip(_ context.Context, dir, branch string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if tip, ok := g.tips[branch]; ok {
		return tip, nil
	}
	if tip, ok := g.tips["*"]; ok {
		return tip, nil
	}
	return g.sha, nil
}

func (g *fakeGit) DeleteBranch(_ context.Context, dir, branch string) error {
	g.record("branch -D %s %s", dir, branch)
	return nil
}

// hireBridge is a bridge with one running floor "s" played by a fakeFloor.
type hireBridge struct {
	*bridge
	fl  *fakeFloor
	git *fakeGit
	c   *client
	db  string
}

func startHireBridge(t *testing.T, tweak func(*server.Options), workers ...world.WorkerObs) *hireBridge {
	t.Helper()
	return startHireBridgeAt(t, "", tweak, workers...)
}

// startHireBridgeAt is startHireBridge on the database at db ("": a new one),
// for a test that restarts the bridge.
func startHireBridgeAt(t *testing.T, db string, tweak func(*server.Options), workers ...world.WorkerObs) *hireBridge {
	t.Helper()
	fh := newFakeHerdr()
	git := newFakeGit()
	opts := fastOps(fh)
	opts.Git = git
	opts.HomeDir = "/home/u"
	opts.StatDir = func(string) error { return nil }
	opts.TrustTimeout, opts.SeenTimeout, opts.ExitTimeout = 2*time.Second, 2*time.Second, 300*time.Millisecond
	opts.HirePoll, opts.ExitPause = 5*time.Millisecond, time.Millisecond
	opts.PromptAckWait = 200 * time.Millisecond // #95
	opts.Load = func() *proto.HostLoad { return &proto.HostLoad{Load1: 1.5, CPUs: 32, MemUsedPct: 40} }
	opts.BranchOf = func(checkout string) string {
		_, b, _ := strings.Cut(checkout, "/repo/")
		return strings.Replace(b, "h3d-", "h3d/", 1)
	}
	hb := &hireBridge{git: git, db: db}
	if hb.db == "" {
		hb.db = filepath.Join(t.TempDir(), "world.db")
	}
	// The floor needs the bridge, the bridge needs the floor as Options.Hire.
	var fl *fakeFloor
	opts.Hire = hireProxy{get: func() *fakeFloor { return fl }}
	opts.Fresh = func(ctx context.Context, socket string) ([]world.WorkerObs, error) { return fl.Fresh(ctx, socket) }
	if tweak != nil {
		tweak(&opts)
	}
	hb.bridge = startBridge(t, hb.db, opts)
	fl = newFakeFloor(hb.bridge, "s", fh, workers...)
	hb.fl = fl
	fl.publish()
	hb.c = hb.connect(proto.Hello{Client: "hire-test"})
	hb.c.snapshot()
	return hb
}

// hireProxy forwards to the fakeFloor made after the bridge.
type hireProxy struct{ get func() *fakeFloor }

func (p hireProxy) CreateWorkspace(ctx context.Context, s, d, l string) (herdr.Created, error) {
	return p.get().CreateWorkspace(ctx, s, d, l)
}
func (p hireProxy) CreateWorktree(ctx context.Context, s, r, b, base, l string) (herdr.Created, error) {
	return p.get().CreateWorktree(ctx, s, r, b, base, l)
}
func (p hireProxy) MarkPane(ctx context.Context, s, pane, m string) error {
	return p.get().MarkPane(ctx, s, pane, m)
}
func (p hireProxy) StartAgent(ctx context.Context, s, pane, n string, a herdr.Agent) error {
	return p.get().StartAgent(ctx, s, pane, n, a)
}
func (p hireProxy) ReadPane(ctx context.Context, s, pane string) (string, error) {
	return p.get().ReadPane(ctx, s, pane)
}
func (p hireProxy) SendKey(ctx context.Context, s, pane string, k herdr.Key) error {
	return p.get().SendKey(ctx, s, pane, k)
}
func (p hireProxy) Prompt(ctx context.Context, s, pane, text string) error {
	return p.get().Prompt(ctx, s, pane, text)
}
func (p hireProxy) TypePrompt(ctx context.Context, s, pane, text string) error {
	return p.get().TypePrompt(ctx, s, pane, text)
}
func (p hireProxy) EraseTyped(ctx context.Context, s, pane string, n int) error {
	return p.get().EraseTyped(ctx, s, pane, n)
}
func (p hireProxy) TypeExit(ctx context.Context, s, pane, h string) error {
	return p.get().TypeExit(ctx, s, pane, h)
}
func (p hireProxy) StartCodexServer(ctx context.Context, s, pane, l string) error {
	return p.get().StartCodexServer(ctx, s, pane, l)
}
func (p hireProxy) StartCodexRemote(ctx context.Context, s, pane, n string, a herdr.Agent, r herdr.Remote) error {
	return p.get().StartCodexRemote(ctx, s, pane, n, a, r)
}
func (p hireProxy) CloseWorkspace(ctx context.Context, s, ws string) error {
	return p.get().CloseWorkspace(ctx, s, ws)
}
func (p hireProxy) RemoveWorktree(ctx context.Context, s, ws string) error {
	return p.get().RemoveWorktree(ctx, s, ws)
}
func (p hireProxy) PaneProcesses(ctx context.Context, s, pane string) (*herdr.ProcessInfo, error) {
	return p.get().PaneProcesses(ctx, s, pane)
}

func hireArgs(desk int) proto.WorkerHireArgs {
	return proto.WorkerHireArgs{Session: "s", DeskIndex: &desk, Harness: "claude", Model: "claude-opus-5-5", Effort: "medium"}
}

func auditRow(t *testing.T, b *bridge, cmd string) (row struct {
	OK, Done      bool
	Error, Result string
}) {
	t.Helper()
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range log {
		if e.Cmd == cmd {
			row.OK, row.Done, row.Error, row.Result = e.OK, e.Done, e.Error, e.Result
		}
	}
	return row
}

func TestHirePrepare(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, func(o *server.Options) {
		o.Caps = server.Caps{FloorSoft: 1, FloorHard: 3, HostSoft: 5, HostHard: 9}
	}, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	hb.git.repos["/home/u"] = "/home/u"

	_, m := c.command(proto.CmdHirePrepare, "p1", proto.HirePrepareArgs{Session: "s"})
	res := ackData[proto.HirePrepareResult](t, m)
	if res.Cwd != "/home/u" || res.Choice != nil || res.ChoiceSource != proto.ChoiceNone || !world.IsName(res.Label) {
		t.Fatalf("prepare = %+v", res)
	}
	if res.Git == nil || res.Git.RepoRoot != "/home/u" || res.Git.DefaultBranch != "main" || !res.Git.Fetched ||
		res.Git.BaseSHA != hb.git.sha || res.Git.BaseTime != 1790600000000 {
		t.Fatalf("git = %+v", res.Git)
	}
	want := proto.Capacity{Floor: proto.CapacityCount{Count: 1, Soft: 1, Hard: 3}, Host: proto.CapacityCount{Count: 1, Soft: 5, Hard: 9},
		Load: &proto.HostLoad{Load1: 1.5, CPUs: 32, MemUsedPct: 40}}
	if !jsonEqual(res.Capacity, want) {
		t.Fatalf("capacity = %+v", res.Capacity)
	}

	// A fetch failure is reported, not fatal; a directory outside git has no git.
	hb.git.fetchErr = errors.New("git fetch: could not resolve host")
	_, m = c.command(proto.CmdHirePrepare, "p2", proto.HirePrepareArgs{Session: "s", Cwd: "/home/u/"})
	if res := ackData[proto.HirePrepareResult](t, m); res.Git.Fetched || !strings.Contains(res.Git.FetchError, "resolve host") || res.Cwd != "/home/u" {
		t.Fatalf("fetch failure: %+v", res.Git)
	}
	_, m = c.command(proto.CmdHirePrepare, "p3", proto.HirePrepareArgs{Session: "s", Cwd: "/tmp"})
	if res := ackData[proto.HirePrepareResult](t, m); res.Git != nil || res.Cwd != "/tmp" {
		t.Fatalf("no repo: %+v", res)
	}
	hb.git.fetchErr = nil

	// The last hire is remembered per floor; the floor's default hire wins.
	c.mustAck(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: "s", DeskIndex: ptr(2), Harness: "codex", Model: "gpt-6-sol",
		Effort: "ultra", Cwd: "/tmp"})
	_, m = c.command(proto.CmdHirePrepare, "p4", proto.HirePrepareArgs{Session: "s"})
	if res := ackData[proto.HirePrepareResult](t, m); res.ChoiceSource != proto.ChoiceLast ||
		*res.Choice != (proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "ultra"}) || res.Capacity.Floor.Count != 2 {
		t.Fatalf("last choice: %+v", res)
	}
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some("/srv"),
		DefaultHire: proto.Some(proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "high"})})
	_, m = c.command(proto.CmdHirePrepare, "p5", proto.HirePrepareArgs{Session: "s"})
	if res := ackData[proto.HirePrepareResult](t, m); res.ChoiceSource != proto.ChoiceFloorDefault ||
		*res.Choice != (proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "high"}) || res.Cwd != "/srv" {
		t.Fatalf("floor default: %+v", res)
	}
	// Survives a bridge restart (SQLite).
	last, err := hb.st.LastHires(context.Background())
	if err != nil || last["s"].Model != "gpt-6-sol" {
		t.Fatalf("stored last hire = %+v, %v", last, err)
	}

	c.mustError(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: "nope"}, proto.ErrUnknownSession)
	c.mustError(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: "s", Cwd: "rel/dir"}, proto.ErrBadRequest)
	c.mustError(proto.CmdHirePrepare, map[string]any{"session": "s", "handoff": true}, proto.ErrBadRequest)
	hb.floorAt("t", false, nil)
	c.mustError(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: "t"}, proto.ErrInvalidState)
	if row := auditRow(t, hb.bridge, proto.CmdHirePrepare); !row.Done || row.OK {
		t.Fatalf("last prepare audit = %+v", row)
	}
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

func TestHireAtDesk(t *testing.T) {
	// Not parallel: it bounds a hire in wall-clock.
	hb := startHireBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	label := "Mochi"
	if workersOf(hb.world(func(w proto.World) bool { return len(w.Workers) == 1 }), "s")["w1"].Name == label {
		label = "Pixel"
	}
	args := hireArgs(3)
	args.Label, args.Prompt, args.Cwd = label, "Read CONTRIBUTING.md", "/home/u/repo"
	start := time.Now()
	evs, m := c.command(proto.CmdWorkerHire, "h1", args)
	res := ackData[proto.HireResult](t, m)
	if took := time.Since(start); took > 2*time.Second {
		t.Errorf("hire took %v", took)
	}
	var first *proto.Worker
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == res.ID && first == nil {
			first = ev.Worker
		}
		if ev.T == proto.EvWorkerRemoved {
			t.Errorf("unexpected removal %+v", ev)
		}
	}
	if first == nil {
		t.Fatalf("no worker.upsert for %s before the ack: %+v", res.ID, evs)
	}
	if first.DeskIndex != 3 || first.Name != label || first.Label != label || first.HiredAt == 0 ||
		first.Harness != "claude" || first.Model != "claude-opus-5-5" || first.Effort != "medium" || first.WorkspaceID != "w2" {
		t.Fatalf("hired worker = %+v", first)
	}
	if res.WorkspaceID != "w2" || res.Trust != proto.TrustNone || res.Prompted == nil || !*res.Prompted || res.Branch != "" {
		t.Fatalf("ack = %s", m.raw)
	}
	marker := "h3d-" + strings.ReplaceAll(res.ID, "-", "")[:12]
	agent := strings.ToLower(label) + "-" + strings.ReplaceAll(res.ID, "-", "")[:6]
	wantCalls := []string{
		"create s /home/u/repo " + label,
		"mark w2:p1 " + marker,
		"start-agent w2:p1 " + agent + " claude claude-opus-5-5 medium " + label,
		`type w2:p1 "Read CONTRIBUTING.md"`, // #95: typed into Claude
	}
	if calls := hb.fl.Calls(); !slices.Equal(calls, wantCalls) {
		t.Fatalf("herdr calls =\n%q\nwant\n%q", calls, wantCalls)
	}
	// The worker keeps its desk, and its marker reconciles it after a
	// bridge restart; hired_at is stored.
	w := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")["w2"].PaneLabel == marker }), "s")["w2"]
	if w.ID != res.ID || w.DeskIndex != 3 || w.AgentKind != "claude" {
		t.Fatalf("worker after the hire = %+v", w)
	}
	recs, _ := hb.st.SessionWorkers(context.Background(), "s")
	for _, r := range recs {
		if r.ID == res.ID && (r.HiredAt != first.HiredAt || r.Model != "claude-opus-5-5") {
			t.Fatalf("stored = %+v", r)
		}
	}
	row := auditRow(t, hb.bridge, proto.CmdWorkerHire)
	if !row.OK || !row.Done || !strings.Contains(row.Result, `"desk":3`) || !strings.Contains(row.Result, marker) ||
		!strings.Contains(row.Result, `"prompt":"typed"`) {
		t.Fatalf("audit = %+v", row)
	}

	// The next newcomer does not take a hired desk; a free generated name
	// that is taken is not reused as a name.
	c.mustError(proto.CmdWorkerHire, hireArgs(3), proto.ErrDeskTaken)
	c.mustError(proto.CmdWorkerHire, hireArgs(0), proto.ErrDeskTaken) // w1's
	args = hireArgs(1)
	args.Label = label
	_, ack := c.mustAck(proto.CmdWorkerHire, args)
	id2 := ack.Data.(map[string]any)["id"].(string)
	w2 := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")["w3"].ID == id2 }), "s")["w3"]
	if w2.Name == label || w2.Label != label || w2.DeskIndex != 1 {
		t.Fatalf("second hire = %+v", w2)
	}
}

// A desk offered when the form opened must still accept its hire after
// workers leave and the rendered floor shrinks while the prompt is written.
func TestHireAtDeskAfterFloorShrinks(t *testing.T) {
	t.Parallel()
	var obs []world.WorkerObs
	for i := range 7 {
		obs = append(obs, agent(fmt.Sprintf("existing%d", i), "idle"))
	}
	hb := startHireBridge(t, nil, obs...)
	w := hb.world(hasWorkers("s", 7))
	if n := floorOf(w, "s").Desks; n != 9 {
		t.Fatalf("initial desks = %d, want 9", n)
	}
	hb.fl.mu.Lock()
	hb.fl.workers = hb.fl.workers[:6]
	hb.fl.mu.Unlock()
	hb.fl.publish()
	w = hb.world(hasWorkers("s", 6))
	if n := floorOf(w, "s").Desks; n != 8 {
		t.Fatalf("shrunk desks = %d, want 8", n)
	}
	// The user is still composing at Desk 9, the last spare before the shrink.
	a := hireArgs(8)
	a.Prompt = "Keep the task I spent time writing"
	_, m := hb.c.command(proto.CmdWorkerHire, "after-shrink", a)
	res := ackData[proto.HireResult](t, m)
	if res.Prompted == nil || !*res.Prompted {
		t.Fatalf("expanded hire did not receive its task: %+v", res)
	}
	hb.world(func(w proto.World) bool {
		for _, wk := range w.Workers {
			if wk.DeskIndex == 8 {
				return floorOf(w, "s").Desks >= 9
			}
		}
		return false
	})
}

func TestHireGrowsFloorBeforeWorkspaceAppears(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, floor              string
		workers, desk, want, max int
	}{
		{"real", "s", 0, 8, 9, 96},
		{"virtual", vWeb, 0, 8, 9, 96},
		{"spares", "s", 5, 6, 8, 96},
		{"capped spares", "s", 5, 6, 7, 7},
	} {
		t.Run(tc.name, func(t *testing.T) {
			floor := tc.floor
			db := seedFloors(t, map[string]string{vWeb: "Web"}, nil)
			var obs []world.WorkerObs
			for i := range tc.workers {
				obs = append(obs, agent(fmt.Sprintf("existing%d", i), "idle"))
			}
			hb := startHireBridgeAt(t, db, func(o *server.Options) { o.MaxDesks = tc.max }, obs...)
			hb.fl.createGate = make(chan struct{})
			defer close(hb.fl.createGate)
			a := hireArgs(tc.desk)
			a.Session, a.Floor = "", floor
			hb.c.send(proto.Command{T: proto.CmdWorkerHire, ReqID: "growing", Args: mustRaw(a)})
			// Holding CreateWorkspace makes the reservation itself responsible
			// for the growth; no worker observation can hide the bug.
			deadline := time.Now().Add(2 * time.Second)
			for len(hb.fl.Calls()) == 0 && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if len(hb.fl.Calls()) == 0 {
				t.Fatal("hire never reached CreateWorkspace")
			}
			w := hb.connect(proto.Hello{}).snapshot().World
			f, ok := floorByID(w, floor)
			if !ok || f.Desks != tc.want {
				t.Fatalf("pending hire must provide %d desks before a worker appears: %+v", tc.want, f)
			}
			// The other floor in this session does not grow with this hire.
			other := vWeb
			if floor == vWeb {
				other = "s"
			}
			if f, _ := floorByID(w, other); f.Desks != 6 {
				t.Fatalf("unrelated floor grew: %+v", f)
			}
		})
	}
}

func TestHireValidation(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, func(o *server.Options) { o.Caps = server.Caps{FloorSoft: 1, FloorHard: 2, HostSoft: 1, HostHard: 5} },
		worker("w1", "a", "", "idle"))
	c := hb.c
	bad := func(mut func(*proto.WorkerHireArgs), code string) {
		t.Helper()
		a := hireArgs(2)
		mut(&a)
		c.mustError(proto.CmdWorkerHire, a, code)
	}
	bad(func(a *proto.WorkerHireArgs) { a.DeskIndex = nil }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Model = "claude-haiku-4-5-20251001" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Harness, a.Model = "opencode", "x" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Effort = "ultra" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Label = "--name" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Label = "a\nb" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Prompt = "--wait" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Cwd = "relative" }, proto.ErrBadRequest)
	bad(func(a *proto.WorkerHireArgs) { a.Session = "other" }, proto.ErrUnknownSession)
	bad(func(a *proto.WorkerHireArgs) { a.DeskIndex = ptr(-1) }, proto.ErrDeskTaken)
	bad(func(a *proto.WorkerHireArgs) { a.DeskIndex = ptr(server.DefaultMaxDesks) }, proto.ErrDeskTaken)
	c.mustError(proto.CmdWorkerHire, map[string]any{"session": "s", "desk_index": 2, "harness": "claude",
		"model": "claude-opus-5-5", "effort": "low", "stop_services": true}, proto.ErrBadRequest)

	// The capacity guard: the second worker fits (floor hard 2), a third does not.
	c.mustAck(proto.CmdWorkerHire, hireArgs(2))
	_, m := c.command(proto.CmdWorkerHire, "cap", hireArgs(3))
	if e := errorOf(m); e.Code != proto.ErrCapacity || !strings.Contains(e.Message, "--max-workers-per-floor") {
		t.Fatalf("capacity: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != 3 { // create, mark, start of the one hire
		t.Fatalf("refused hires ran herdr: %q", calls)
	}
}

// Two hires to one desk: the first accepted wins. Wake and sleep wait.
func TestHireReservesItsDesk(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	c := hb.c
	hb.fl.createGate = make(chan struct{})
	c.send(proto.Command{T: proto.CmdWorkerHire, ReqID: "first", Args: mustRaw(hireArgs(4))})
	other := hb.connect(proto.Hello{Client: "other"})
	other.snapshot()
	deadline := time.Now().Add(2 * time.Second)
	for len(hb.fl.Calls()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	other.mustError(proto.CmdWorkerHire, hireArgs(4), proto.ErrDeskTaken)
	other.mustError(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"}, proto.ErrBusy)
	close(hb.fl.createGate)
	for {
		m := c.next()
		if m.env.T == proto.TAck || m.env.T == proto.TError {
			if m.env.T != proto.TAck || m.env.ReqID != "first" {
				t.Fatalf("first hire: %s", m.raw)
			}
			break
		}
	}
}

func mustRaw(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// herdr's event can reach the bridge before the create call returns: the
// new workspace still becomes the hired worker, at its desk, without a
// stranger showing up first.
func TestHireWorkspaceSeenBeforeCreateReturns(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, worker("w1", "a", "", "idle"))
	hb.fl.publishEarly = true
	evs, m := hb.c.command(proto.CmdWorkerHire, "h", hireArgs(5))
	res := ackData[proto.HireResult](t, m)
	for _, ev := range evs {
		if (ev.T == proto.EvWorkerUpsert && ev.Worker.ID != res.ID) || ev.T == proto.EvWorkerRemoved {
			t.Fatalf("a stranger came and went: %+v", ev)
		}
		if ev.T == proto.EvWorkerUpsert && ev.Worker.DeskIndex != 5 {
			t.Fatalf("hired worker at desk %d", ev.Worker.DeskIndex)
		}
	}
}

func TestHireAnswersTrustDialogs(t *testing.T) {
	t.Parallel()
	claudeTrust := "❯ claude --model x\n Accessing workspace:\n\n /home/u/repo\n\n Quick safety check: Is this a project you created or one you trust?\n ❯ No, exit\n   Yes, I trust this folder\n Enter to confirm · Esc to cancel"
	codexTrust := "  Folder access\n  /home/u/repo\n  Trust this folder? Codex can read, edit, and run files here.\n› 1. Trust and continue\n  2. Quit"
	for _, tc := range []struct {
		name, harness, model, screen string
		startErr                     error
		keys                         []string
		trust                        string
	}{
		{"claude blocked", "claude", "claude-opus-5-5", claudeTrust,
			fmt.Errorf("herdr control start-claude: %w", &herdr.APIError{Code: "agent_not_ready", Message: "blocked during startup"}),
			[]string{"down", "enter"}, proto.TrustApproved},
		{"codex idle on its dialog", "codex", "gpt-6-luna", codexTrust, nil, []string{"enter"}, proto.TrustApproved},
		{"another directory", "codex", "gpt-6-luna", strings.ReplaceAll(codexTrust, "/home/u/repo", "/etc"), nil, nil, proto.TrustNone},
		{"a sibling directory", "claude", "claude-opus-5-5", strings.ReplaceAll(claudeTrust, "/home/u/repo", "/home/u/repo-other"),
			nil, nil, proto.TrustNone},
		{"no dialog", "claude", "claude-opus-5-5", "❯ Try \"write a test\"", nil, nil, proto.TrustNone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hb := startHireBridge(t, nil)
			hb.fl.startErr = tc.startErr
			hb.fl.screens["w1:p1"] = []string{tc.screen}
			a := hireArgs(0)
			a.Harness, a.Model, a.Effort, a.Cwd = tc.harness, tc.model, "low", "/home/u/repo"
			_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
			if res := ackData[proto.HireResult](t, m); res.Trust != tc.trust {
				t.Fatalf("trust = %q, want %q (%s)", res.Trust, tc.trust, m.raw)
			}
			hb.fl.mu.Lock()
			keys := slices.Clone(hb.fl.keys)
			hb.fl.mu.Unlock()
			if !slices.Equal(keys, tc.keys) {
				t.Fatalf("keys = %v, want %v", keys, tc.keys)
			}
		})
	}
}

func TestHireIntoWorktree(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	hb.git.repos["/home/u/repo/sub"] = "/home/u/repo"
	a := hireArgs(1)
	a.Cwd, a.Worktree, a.Label = "/home/u/repo/sub", true, "Pixel"
	evs, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	res := ackData[proto.HireResult](t, m)
	branch := "h3d/pixel-" + strings.ReplaceAll(res.ID, "-", "")[:6]
	if res.Branch != branch || res.BaseSHA != hb.git.sha || res.FetchError != "" {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); calls[0] != "worktree s /home/u/repo "+branch+" origin/main Pixel" {
		t.Fatalf("herdr calls = %q", calls)
	}
	// Fetched first, based on the fetched origin/main.
	if g := hb.git.Calls(); !slices.Equal(g[:2], []string{"fetch /home/u/repo", "commit /home/u/repo origin/main"}) {
		t.Fatalf("git calls = %q", g)
	}
	var w *proto.Worker
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == res.ID {
			w = ev.Worker
		}
	}
	if w == nil || w.Branch != branch || w.Worktree == nil || !w.Worktree.Linked {
		t.Fatalf("worker = %+v", w)
	}

	// The fetch fails: refused with git's error, nothing made; the stale
	// origin/main is never used. A plain hire does not fetch.
	hb.git.fetchErr = errors.New("git fetch: fatal: unable to access origin: Could not resolve host")
	before := len(hb.fl.Calls())
	a.DeskIndex = ptr(2)
	_, m = hb.c.command(proto.CmdWorkerHire, "stale", a)
	if e := errorOf(m); e.Code != proto.ErrFetchFailed || e.Message != hb.git.fetchErr.Error() {
		t.Fatalf("fetch failure: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != before {
		t.Fatalf("a hire without a fresh base ran herdr: %q", calls[before:])
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHire); row.OK || !strings.Contains(row.Result, `"fetched":false`) {
		t.Fatalf("audit = %+v", row)
	}
	plain := a
	plain.Worktree = false
	hb.c.mustAck(proto.CmdWorkerHire, plain)
	hb.git.fetchErr = nil

	// Outside a repository, or without a default branch: refused.
	a.Cwd, a.DeskIndex = "/tmp", ptr(3)
	hb.c.mustError(proto.CmdWorkerHire, a, proto.ErrBadRequest)
	hb.git.def = ""
	a.Cwd = "/home/u/repo/sub"
	hb.c.mustError(proto.CmdWorkerHire, a, proto.ErrBadRequest)
}

// A worktree hire from inside a linked worktree branches from the
// repository's main checkout: herdr makes no worktree from a linked one.
func TestHireIntoWorktreeFromALinkedWorktree(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	linked := "/home/u/.herdr/worktrees/repo/h3d-crumpet-613421"
	hb.git.repos[linked] = linked
	hb.git.mains[linked] = "/home/u/repo"
	a := hireArgs(1)
	a.Cwd, a.Worktree, a.Label = linked, true, "Pixel"
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	res := ackData[proto.HireResult](t, m)
	branch := "h3d/pixel-" + strings.ReplaceAll(res.ID, "-", "")[:6]
	if calls := hb.fl.Calls(); calls[0] != "worktree s /home/u/repo "+branch+" origin/main Pixel" {
		t.Fatalf("herdr calls = %q", calls)
	}
	if g := hb.git.Calls(); !slices.Equal(g[:2], []string{"fetch /home/u/repo", "commit /home/u/repo origin/main"}) {
		t.Fatalf("git calls = %q", g)
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHire); !row.OK || !strings.Contains(row.Result, `"repo_root":"/home/u/repo"`) {
		t.Fatalf("audit = %+v", row)
	}
}

func TestHireRollsBack(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	hb.fl.markErr = errors.New("pane not found")
	evs, m := hb.c.command(proto.CmdWorkerHire, "h", hireArgs(0))
	if e := errorOf(m); e.Code != proto.ErrHireFailed || !strings.Contains(e.Message, "pane rename") {
		t.Fatalf("reply = %s", m.raw)
	}
	if calls := hb.fl.Calls(); !slices.Contains(calls, "close w1") {
		t.Fatalf("no rollback: %q", calls)
	}
	_ = evs
	w := hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 0 })
	if len(w.Workers) != 0 {
		t.Fatalf("workers left: %+v", w.Workers)
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHire); row.OK || !row.Done || !strings.Contains(row.Result, "herdr workspace close") {
		t.Fatalf("audit = %+v", row)
	}
	// The desk is free again.
	hb.fl.markErr = nil
	hb.c.mustAck(proto.CmdWorkerHire, hireArgs(0))
}

// A failed worktree hire removes its checkout only when the tree is
// clean, and deletes its branch only while it still points at its base.
func TestHireRollsBackAWorktree(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name          string
		dirty         []string
		tip           string
		herdr         string // the rollback's herdr call
		deleted       bool
		kept          string // in the error
		stillRecorded bool
	}{
		{"fresh", nil, "", "remove-worktree w2", true, "", false},
		{"dirty", []string{"?? notes.txt"}, "", "close w2", false, "are kept (1 uncommitted change)", true},
		{"with commits", nil, "0123456789abcdef0123456789abcdef01234567", "remove-worktree w2", false,
			"is kept (it has commits since 8739ddc5f3e1: now at 0123456789ab)", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hb := startHireBridge(t, nil)
			hb.git.repos["/home/u/repo"] = "/home/u/repo"
			if tc.dirty != nil {
				hb.git.dirty["*"] = tc.dirty
			}
			if tc.tip != "" {
				hb.git.tips["*"] = tc.tip
			}
			hb.fl.markErr = errors.New("pane not found")
			a := hireArgs(0)
			a.Cwd, a.Worktree = "/home/u/repo", true
			_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
			e := errorOf(m)
			if e.Code != proto.ErrHireFailed || (tc.kept == "") != !strings.Contains(e.Message, "kept") ||
				!strings.Contains(e.Message, tc.kept) {
				t.Fatalf("reply = %s", m.raw)
			}
			// The worktree's workspace is w2; herdr opened the main
			// checkout (w1) for it, and the rollback closes that too.
			calls := hb.fl.Calls()
			if !slices.Contains(calls, tc.herdr) || !slices.Contains(calls, "close w1") || len(slices.DeleteFunc(slices.Clone(calls), func(c string) bool {
				return strings.HasPrefix(c, "remove-worktree") || strings.HasPrefix(c, "close")
			})) != len(calls)-2 {
				t.Fatalf("herdr calls = %q", calls)
			}
			if w := hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 0 }); len(w.Workers) != 0 {
				t.Fatalf("workers left: %+v", w.Workers)
			}
			deleted := slices.ContainsFunc(hb.git.Calls(), func(c string) bool { return strings.HasPrefix(c, "branch -D") })
			if deleted != tc.deleted {
				t.Fatalf("git calls = %q", hb.git.Calls())
			}
			row := auditRow(t, hb.bridge, proto.CmdWorkerHire)
			if row.OK || !strings.Contains(row.Result, `"rollback"`) || !strings.Contains(row.Result, tc.kept) {
				t.Fatalf("audit = %+v", row)
			}
			// The record goes with the branch.
			var id string
			if _, rest, ok := strings.Cut(row.Result, `"worker":"`); ok {
				id, _, _ = strings.Cut(rest, `"`)
			}
			if _, ok, err := hb.st.HireBranchOf(context.Background(), id); err != nil || ok != tc.stillRecorded {
				t.Fatalf("branch record of %q: %v %v", id, ok, err)
			}
		})
	}
}

// herdr opens the repository's main checkout with the first worktree of
// it on a floor, but that is no worker: a worktree hire needs room for one.
func TestWorktreeHireNeedsOneWorker(t *testing.T) {
	t.Parallel()
	caps := func(hard int) func(*server.Options) {
		return func(o *server.Options) {
			o.Caps = server.Caps{FloorSoft: 1, FloorHard: hard, HostSoft: 1, HostHard: 50}
		}
	}
	// Hard cap 1, an empty floor: the worktree hire fits, and so does
	// nothing else afterwards.
	hb := startHireBridge(t, caps(1))
	hb.git.repos["/home/u/repo"] = "/home/u/repo"
	a := hireArgs(0)
	a.Cwd, a.Worktree = "/home/u/repo", true
	_, m := hb.c.command(proto.CmdWorkerHire, "wt", a)
	res := ackData[proto.HireResult](t, m)
	if res.WorkspaceID != "w2" { // w1 is the hidden main checkout
		t.Fatalf("hire = %+v", res)
	}
	w := hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 })
	if len(w.Workers) != 1 || w.Workers[0].ID != res.ID {
		t.Fatalf("workers = %+v", w.Workers)
	}
	_, m = hb.c.command(proto.CmdHirePrepare, "p", proto.HirePrepareArgs{Session: "s"})
	if got := ackData[proto.HirePrepareResult](t, m).Capacity; got.Floor.Count != 1 || got.Host.Count != 1 {
		t.Fatalf("capacity = %+v", got)
	}
	a.DeskIndex = ptr(1)
	hb.c.mustError(proto.CmdWorkerHire, a, proto.ErrCapacity)

	// The main checkout already has a worker: still one more.
	main := claudeW("w1", "")
	main.Cwd = "/home/u/repo"
	main.Worktree = &world.Worktree{RepoRoot: "/home/u/repo", RepoName: "repo", CheckoutPath: "/home/u/repo"}
	hb = startHireBridge(t, caps(2), main)
	hb.git.repos["/home/u/repo/sub"] = "/home/u/repo"
	a = hireArgs(1)
	a.Cwd, a.Worktree = "/home/u/repo/sub", true
	hb.c.mustAck(proto.CmdWorkerHire, a)
	if w := hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 2 }); len(w.Workers) != 2 {
		t.Fatalf("workers = %+v", w.Workers)
	}
}

// Codex (#95: only Codex's prompts are pasted with agent prompt).
func TestHirePromptRetriesUntilReady(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	notReady := &herdr.APIError{Code: "agent_not_ready", Message: "starting"}
	hb.fl.promptErrs = []error{notReady, notReady}
	a := hireArgs(0)
	a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
	a.Prompt = "hi"
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	hb.fl.promptErrs = []error{errors.New("boom")}
	a.DeskIndex = ptr(1)
	_, m = hb.c.command(proto.CmdWorkerHire, "h2", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || *res.Prompted || res.PromptError != "boom" {
		t.Fatalf("failed prompt ack = %s", m.raw)
	}
}

func linkedWorker(ws, branch string) world.WorkerObs {
	w := claudeW(ws, "")
	path := "/home/u/.herdr/worktrees/repo/" + strings.ReplaceAll(branch, "/", "-")
	w.Cwd, w.IdentityCwd = path, path
	w.Worktree = &world.Worktree{RepoRoot: "/home/u/repo", RepoName: "repo", CheckoutPath: path, Linked: true}
	return w
}

func TestFirePrepare(t *testing.T) {
	t.Parallel()
	main := claudeW("w1", "")
	main.Cwd = "/home/u/repo"
	main.Worktree = &world.Worktree{RepoRoot: "/home/u/repo", RepoName: "repo", CheckoutPath: "/home/u/repo"}
	hb := startHireBridge(t, nil, main, linkedWorker("w2", "h3d/pixel-a1b2c3"), linkedWorker("w3", "h3d/mochi-d4e5f6"))
	g := hb.git
	wt2, wt3 := "/home/u/.herdr/worktrees/repo/h3d-pixel-a1b2c3", "/home/u/.herdr/worktrees/repo/h3d-mochi-d4e5f6"
	g.repos["/home/u/repo"], g.repos[wt2], g.repos[wt3] = "/home/u/repo", wt2, wt3
	g.dirty[wt2] = []string{" M hub.go", "?? notes.txt"}
	g.unpushed[wt2] = 2
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 3 }), "s")

	_, m := hb.c.command(proto.CmdFirePrepare, "f1", proto.WorkerArgs{ID: ws["w2"].ID})
	res := ackData[proto.FirePrepareResult](t, m)
	if res.Name != ws["w2"].Name || res.Branch != "h3d/pixel-a1b2c3" || res.Worktree == nil || res.Worktree.Path != wt2 ||
		!res.Worktree.Linked || len(res.Dirty) != 2 || res.Unpushed != 2 || res.CanDelete || !res.CanFire ||
		res.Reason != "2 uncommitted changes, 2 commits not on any remote" {
		t.Fatalf("dirty prepare = %s", m.raw)
	}
	// Clean, but the bridge made no branch for w3 (whatever its name):
	// only the worktree may go.
	_, m = hb.c.command(proto.CmdFirePrepare, "f2", proto.WorkerArgs{ID: ws["w3"].ID})
	if res := ackData[proto.FirePrepareResult](t, m); !res.CanDelete || res.CanDeleteBranch || res.Reason != "" || len(res.Dirty) != 0 {
		t.Fatalf("clean prepare = %s", m.raw)
	}
	ctx := context.Background()
	if err := hb.st.RecordHireBranch(ctx, store.HireBranch{WorkerID: ws["w3"].ID, Session: "s", RepoRoot: "/home/u/repo",
		Branch: "h3d/mochi-d4e5f6", BaseSHA: g.sha}); err != nil {
		t.Fatal(err)
	}
	_, m = hb.c.command(proto.CmdFirePrepare, "f2b", proto.WorkerArgs{ID: ws["w3"].ID})
	if res := ackData[proto.FirePrepareResult](t, m); !res.CanDelete || !res.CanDeleteBranch {
		t.Fatalf("clean prepare of a recorded branch = %s", m.raw)
	}
	// The checkout moved to another branch: shown as it is now, and the
	// recorded one is not offered.
	g.mu.Lock()
	g.current[wt3] = "feature/y"
	g.mu.Unlock()
	_, m = hb.c.command(proto.CmdFirePrepare, "f2c", proto.WorkerArgs{ID: ws["w3"].ID})
	if res := ackData[proto.FirePrepareResult](t, m); res.Branch != "feature/y" || !res.CanDelete || res.CanDeleteBranch {
		t.Fatalf("prepare after a branch switch = %s", m.raw)
	}
	// The main checkout cannot go while its worktrees are open (herdr only
	// closes the group).
	_, m = hb.c.command(proto.CmdFirePrepare, "f3", proto.WorkerArgs{ID: ws["w1"].ID})
	if res := ackData[proto.FirePrepareResult](t, m); res.CanFire || !strings.Contains(res.FireBlocked, "send those home first") ||
		res.CanDelete || res.Worktree == nil || res.Worktree.Linked {
		t.Fatalf("main checkout prepare = %s", m.raw)
	}
	hb.c.mustError(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: ws["w1"].ID}, proto.ErrFireFailed)
	hb.c.mustError(proto.CmdFirePrepare, proto.WorkerArgs{ID: "nobody"}, proto.ErrUnknownWorker)
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("prepare ran herdr: %q", calls)
	}
}

func TestSendHome(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, claudeW("w1", "sess-1"), worker("w2", "notes", "", "unknown"))
	hb.fl.setProcs("w1:p1", running("claude", "sess-1"))
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 2 }), "s")
	id := ws["w1"].ID
	desk := ws["w1"].DeskIndex

	evs, m := hb.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: id})
	res := ackData[proto.FireResult](t, m)
	if res.Worktree != proto.WorktreeKept || !res.Released {
		t.Fatalf("ack = %s", m.raw)
	}
	var removed *proto.Event
	for i := range evs {
		if evs[i].T == proto.EvWorkerRemoved {
			removed = &evs[i]
		}
	}
	if removed == nil || removed.ID != id || removed.Reason != proto.RemovedSentHome {
		t.Fatalf("events = %+v", evs)
	}
	if calls := hb.fl.Calls(); !slices.Equal(calls, []string{"exit w1:p1", "key w1:p1 enter", "close w1"}) {
		t.Fatalf("herdr calls = %q", calls)
	}
	row := auditRow(t, hb.bridge, proto.CmdWorkerFire)
	if !row.OK || !row.Done || !strings.Contains(row.Result, `"exit":"/exit + Enter"`) || !strings.Contains(row.Result, `"released":true`) {
		t.Fatalf("audit = %+v", row)
	}
	// The desk is free: a hire may take it.
	hb.c.mustAck(proto.CmdWorkerHire, hireArgs(desk))
	// Gone: unknown now.
	hb.c.mustError(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: id}, proto.ErrUnknownWorker)
	hb.c.mustError(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: ws["w2"].ID, Worktree: "delete"}, proto.ErrBadRequest)
	hb.c.mustError(proto.CmdWorkerFire, map[string]any{"id": ws["w2"].ID, "handoff": true}, proto.ErrBadRequest)
}

func TestSendHomeAgentThatDoesNotExit(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, withKind(worker("w1", "x", "", "working"), "codex"))
	hb.fl.exitWorks = false
	hb.fl.setProcs("w1:p1", running("codex", ""))
	id := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")["w1"].ID
	_, m := hb.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: id})
	if e := errorOf(m); e.Code != proto.ErrFireFailed || !strings.Contains(e.Message, "still running") ||
		!strings.Contains(e.Message, "nothing was closed") {
		t.Fatalf("reply = %s", m.raw)
	}
	// Enter once, three more times while it does not go, then Ctrl-C
	// twice; nothing is closed.
	if calls := hb.fl.Calls(); !slices.Equal(calls, []string{"exit w1:p1", "key w1:p1 enter", "key w1:p1 enter",
		"key w1:p1 enter", "key w1:p1 enter", "key w1:p1 ctrl+c", "key w1:p1 ctrl+c"}) {
		t.Fatalf("herdr calls = %q", calls)
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerFire); row.OK || !row.Done || !strings.Contains(row.Error, "still running") ||
		!strings.Contains(row.Result, `"released":false`) {
		t.Fatalf("audit = %+v", row)
	}
	// Still there, and may be sent home again: Ctrl-C takes this time. It
	// did not leave by itself, but it left: the workspace closes.
	if w := workersOf(hb.world(func(proto.World) bool { return true }), "s")["w1"]; w.ID != id {
		t.Fatalf("worker gone: %+v", w)
	}
	hb.fl.onKey = func(pane string, key herdr.Key) {
		if key == herdr.KeyCtrlC {
			hb.fl.setProcs(pane, atShell())
		}
	}
	_, m = hb.c.command(proto.CmdWorkerFire, "again", proto.WorkerFireArgs{ID: id})
	if res := ackData[proto.FireResult](t, m); res.Released {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); calls[len(calls)-1] != "close w1" {
		t.Fatalf("herdr calls = %q", calls)
	}
}

func withKind(w world.WorkerObs, kind string) world.WorkerObs {
	w.AgentKind = kind
	return w
}

func TestSendHomeWorktree(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, linkedWorker("w1", "h3d/pixel-a1b2c3"), linkedWorker("w2", "h3d/mochi-d4e5f6"),
		withKind(linkedWorker("w3", "feature/x"), "claude"), linkedWorker("w4", "h3d/tofu-0f0f0f"),
		linkedWorker("w5", "h3d/miso-123456"))
	wt := func(branch string) string {
		return "/home/u/.herdr/worktrees/repo/" + strings.ReplaceAll(branch, "/", "-")
	}
	wt1, wt2, wt3, wt4, wt5 := wt("h3d/pixel-a1b2c3"), wt("h3d/mochi-d4e5f6"), wt("feature/x"), wt("h3d/tofu-0f0f0f"),
		wt("h3d/miso-123456")
	g := hb.git
	for i, p := range []string{wt1, wt2, wt3, wt4, wt5} {
		g.repos[p] = p
		hb.fl.setProcs(fmt.Sprintf("w%d:p1", i+1), atShell())
	}
	g.unpushed[wt1] = 1
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 5 }), "s")
	// The bridge made the branches of w2 and w5 (and w1's), not w4's
	// h3d/… one.
	ctx := context.Background()
	for w, b := range map[string]string{"w1": "h3d/pixel-a1b2c3", "w2": "h3d/mochi-d4e5f6", "w5": "h3d/miso-123456"} {
		if err := hb.st.RecordHireBranch(ctx, store.HireBranch{WorkerID: ws[w].ID, Session: "s", RepoRoot: "/home/u/repo",
			Branch: b, BaseSHA: g.sha}); err != nil {
			t.Fatal(err)
		}
	}

	// Dirty or unpushed: refused, nothing happens.
	hb.c.mustError(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: ws["w1"].ID, Worktree: "delete"}, proto.ErrNotClean)
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("not_clean ran herdr: %q", calls)
	}
	// Clean: the worktree and its branch go, and so does the record.
	_, m := hb.c.command(proto.CmdWorkerFire, "f", proto.WorkerFireArgs{ID: ws["w2"].ID, Worktree: "delete_branch"})
	if res := ackData[proto.FireResult](t, m); res.Worktree != proto.WorktreeDelBranch {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); !slices.Contains(calls, "remove-worktree w2") || slices.Contains(calls, "close w2") {
		t.Fatalf("herdr calls = %q", calls)
	}
	if gc := g.Calls(); !slices.Contains(gc, "branch -D /home/u/repo h3d/mochi-d4e5f6") {
		t.Fatalf("git calls = %q", gc)
	}
	if _, ok, err := hb.st.HireBranchOf(ctx, ws["w2"].ID); err != nil || ok {
		t.Fatalf("record after delete: %v %v", ok, err)
	}
	// Only branches the bridge recorded making for that worker are
	// deleted: not feature/x, and not an h3d/… branch made elsewhere.
	for _, w := range []string{"w3", "w4"} {
		hb.c.mustError(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: ws[w].ID, Worktree: "delete_branch"}, proto.ErrBadRequest)
	}
	// The checkout switched away from the recorded branch since it was
	// shown: refused, nothing happens.
	g.mu.Lock()
	g.current[wt5] = "main"
	g.mu.Unlock()
	before := len(hb.fl.Calls())
	_, m = hb.c.command(proto.CmdWorkerFire, "sw", proto.WorkerFireArgs{ID: ws["w5"].ID, Worktree: "delete_branch"})
	if e := errorOf(m); e.Code != proto.ErrNotClean || !strings.Contains(e.Message, "on branch main, not h3d/miso-123456") {
		t.Fatalf("switched branch: %s", m.raw)
	}
	// Back on it, but the branch has commits on no remote (HEAD's are
	// pushed): refused too.
	g.mu.Lock()
	delete(g.current, wt5)
	g.ahead["h3d/miso-123456"] = 2
	g.mu.Unlock()
	_, m = hb.c.command(proto.CmdWorkerFire, "ahead", proto.WorkerFireArgs{ID: ws["w5"].ID, Worktree: "delete_branch"})
	if e := errorOf(m); e.Code != proto.ErrNotClean || !strings.Contains(e.Message, "2 commits of h3d/miso-123456 not on any remote") {
		t.Fatalf("unpushed branch: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != before {
		t.Fatalf("refused send homes ran herdr: %q", calls[before:])
	}
	if gc := g.Calls(); slices.Contains(gc, "branch -D /home/u/repo h3d/miso-123456") ||
		slices.Contains(gc, "branch -D /home/u/repo h3d/tofu-0f0f0f") {
		t.Fatalf("git calls = %q", gc)
	}
	// Keep is always possible, dirty or not.
	_, m = hb.c.command(proto.CmdWorkerFire, "k", proto.WorkerFireArgs{ID: ws["w1"].ID, Worktree: "keep"})
	if res := ackData[proto.FireResult](t, m); res.Worktree != proto.WorktreeKept {
		t.Fatalf("keep ack = %s", m.raw)
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerFire); !row.OK || !strings.Contains(row.Result, `"choice":"keep"`) {
		t.Fatalf("audit = %+v", row)
	}
}

func TestSendHomeWhileBusy(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, claudeW("w1", "sess-1"))
	id := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")["w1"].ID
	// A sleep in progress: busy.
	gate := make(chan struct{})
	hb.fl.fakeHerdr.onStop = func() { <-gate }
	hb.c.send(proto.Command{T: proto.CmdFloorSleep, ReqID: "sleep", Args: mustRaw(proto.FloorArgs{Session: "s"})})
	deadline := time.Now().Add(2 * time.Second)
	for !slices.Contains(hb.fl.Calls(), "stop s") && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	other := hb.connect(proto.Hello{})
	other.snapshot()
	other.mustError(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: id}, proto.ErrBusy)
	other.mustError(proto.CmdWorkerHire, hireArgs(3), proto.ErrBusy)
	other.mustError(proto.CmdHirePrepare, proto.HirePrepareArgs{Session: "s"}, proto.ErrBusy)
	close(gate)
}

// A hired worker comes back after bridge and herdr restarts as itself: its
// marker reconciles it (even on another workspace id), with its desk,
// name, hired_at and model.
func TestHiredWorkerSurvivesRestarts(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	a := hireArgs(4)
	a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	res := ackData[proto.HireResult](t, m)
	before := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")["w1"].PaneLabel != "" }), "s")["w1"]
	hb.fl.mu.Lock()
	obs := slices.Clone(hb.fl.workers)
	hb.fl.mu.Unlock()
	hb.stop()

	b := startBridge(t, hb.db, server.Options{})
	obs[0].WorkspaceID, obs[0].PaneID = "w7", "w7:p1" // herdr restarted and renumbered
	obs[0].Harness = ""                               // and tokens or kinds are gone
	b.publish(world.FloorObs{Session: "s", Running: true, Fresh: true, Gen: world.NextGen(), Workers: obs})
	after := workersOf(b.world(func(w proto.World) bool { return len(w.Workers) == 1 }), "s")["w7"]
	if after.ID != res.ID || after.DeskIndex != 4 || after.Name != before.Name || after.HiredAt != before.HiredAt ||
		after.Model != "gpt-6-astra" || after.Effort != "ultra" || after.Harness != "codex" {
		t.Fatalf("after restart %+v, before %+v", after, before)
	}
}

// An agent just past its trust dialog takes the prompt's text but drops
// the Enter: herdr reports agent_prompt_stalled, the bridge presses Enter
// until the worker works. Codex: agent prompt (#95).
func TestHirePromptStalled(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	hb.fl.promptErrs = []error{&herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000 ms"}}
	enters := 0
	hb.fl.onKey = func(pane string, key herdr.Key) {
		if key != herdr.KeyEnter {
			return
		}
		if enters++; enters == 2 { // the second Enter takes
			hb.fl.update(wsOf(pane), func(w *world.WorkerObs) { w.Status = "working" })
		}
	}
	a := hireArgs(0)
	a.Harness, a.Model, a.Effort = "codex", "gpt-6-astra", "ultra"
	a.Prompt = "hi"
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack = %s", m.raw)
	}
	if calls := hb.fl.Calls(); !slices.Equal(calls[len(calls)-3:], []string{`prompt w1:p1 "hi"`, "key w1:p1 enter", "key w1:p1 enter"}) {
		t.Fatalf("herdr calls = %q", calls)
	}

	// Never works: not prompted, with herdr's error.
	hb.fl.onKey = nil
	hb.fl.promptErrs = []error{&herdr.APIError{Code: "agent_prompt_stalled", Message: "no working state within 5000 ms"}}
	a.DeskIndex = ptr(1)
	_, m = hb.c.command(proto.CmdWorkerHire, "h2", a)
	if res := ackData[proto.HireResult](t, m); res.Prompted == nil || *res.Prompted || !strings.Contains(res.PromptError, "agent_prompt_stalled") {
		t.Fatalf("ack = %s", m.raw)
	}
}

// mainShell is a repository's main checkout with only a shell in it, as
// herdr opens it for the first worktree.
func mainShell(ws string) world.WorkerObs {
	w := worker(ws, "repo", "", "unknown")
	w.Cwd, w.IdentityCwd = "/home/u/repo", "/home/u/repo"
	w.Worktree = &world.Worktree{RepoRoot: "/home/u/repo", RepoName: "repo", CheckoutPath: "/home/u/repo"}
	return w
}

// eventWhere reads events until one satisfies ok.
func eventWhere(c *client, ok func(proto.Event) bool) proto.Event {
	c.t.Helper()
	for {
		if ev := c.event(); ok(ev) {
			return ev
		}
	}
}

// The main checkout herdr opened for a repository's worktrees is no
// worker while it has no agent: no desk, no count. It is one again when an
// agent runs in it or its last worktree is gone.
func TestIdleMainCheckoutIsNoWorker(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"))
	w := hb.world(hasWorkers("s", 1))
	if _, ok := workersOf(w, "s")["w2"]; !ok {
		t.Fatalf("workers = %+v", w.Workers)
	}
	desks := floorOf(w, "s").Desks
	capacity := func() proto.Capacity {
		_, m := hb.c.command(proto.CmdHirePrepare, "p", proto.HirePrepareArgs{Session: "s"})
		return ackData[proto.HirePrepareResult](t, m).Capacity
	}
	if c := capacity(); c.Floor.Count != 1 || c.Host.Count != 1 {
		t.Fatalf("capacity = %+v", c)
	}

	// An agent starts in it: a worker, at its own desk.
	hb.fl.update("w1", func(w *world.WorkerObs) { w.AgentKind, w.Status = "claude", "idle" })
	eventWhere(hb.c, func(ev proto.Event) bool { return ev.T == proto.EvWorkerUpsert && ev.Worker.WorkspaceID == "w1" })
	w = hb.world(hasWorkers("s", 2))
	if a, b := workersOf(w, "s")["w1"], workersOf(w, "s")["w2"]; a.DeskIndex == b.DeskIndex {
		t.Fatalf("desks = %d and %d", a.DeskIndex, b.DeskIndex)
	}
	if c := capacity(); c.Floor.Count != 2 {
		t.Fatalf("capacity = %+v", c)
	}

	// The agent goes: hidden again, and its desk is free.
	hb.fl.update("w1", func(w *world.WorkerObs) { w.AgentKind, w.Status = "", "unknown" })
	eventWhere(hb.c, func(ev proto.Event) bool { return ev.T == proto.EvWorkerRemoved && ev.WorkspaceID == "w1" })
	w = hb.world(hasWorkers("s", 1))
	if got := floorOf(w, "s").Desks; got != desks {
		t.Fatalf("desks = %d, want %d", got, desks)
	}

	// The last worktree goes: the shell is a worker like any other.
	hb.fl.close("w2")
	w = hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")["w1"]; return ok && len(workersOf(w, "s")) == 1 })
	if c := capacity(); c.Floor.Count != 1 {
		t.Fatalf("capacity = %+v", c)
	}
}

// A main checkout with an agent stays a worker, and cannot go while its
// worktrees are open.
func TestIdleMainCheckoutDoesNotCountAgainstCaps(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, func(o *server.Options) {
		o.Caps = server.Caps{FloorSoft: 1, FloorHard: 2, HostSoft: 1, HostHard: 50}
	}, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"))
	hb.world(hasWorkers("s", 1))
	a := hireArgs(1)
	hb.c.mustAck(proto.CmdWorkerHire, a) // the second worker fits
	a.DeskIndex = ptr(2)
	hb.c.mustError(proto.CmdWorkerHire, a, proto.ErrCapacity) // a third does not
}

// Sending home the last worktree the bridge hired closes the main checkout
// herdr opened for it, when nothing else works there.
func TestSendHomeClosesTheIdleMainCheckout(t *testing.T) {
	t.Parallel()
	hired := func(t *testing.T, hb *hireBridge, ws string) {
		t.Helper()
		id := workersOf(hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")[ws]; return ok }), "s")[ws].ID
		if err := hb.st.RecordHireBranch(context.Background(), store.HireBranch{WorkerID: id, Session: "s",
			RepoRoot: "/home/u/repo", Branch: "h3d/pixel-a1b2c3", BaseSHA: hb.git.sha}); err != nil {
			t.Fatal(err)
		}
	}
	fire := func(t *testing.T, hb *hireBridge, ws string) {
		t.Helper()
		hb.fl.setProcs(ws+":p1", atShell())
		id := workersOf(hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")[ws]; return ok }), "s")[ws].ID
		hb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: id})
	}
	closed := func(hb *hireBridge, ws string) bool { return slices.Contains(hb.fl.Calls(), "close "+ws) }

	t.Run("closes it", func(t *testing.T) {
		hb := startHireBridge(t, nil, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"))
		hired(t, hb, "w2")
		fire(t, hb, "w2")
		if calls := hb.fl.Calls(); !slices.Equal(calls[len(calls)-2:], []string{"close w2", "close w1"}) {
			t.Fatalf("herdr calls = %q", calls)
		}
		hb.world(hasWorkers("s", 0))
		if row := auditRow(t, hb.bridge, proto.CmdWorkerFire); !row.OK || !strings.Contains(row.Result, "main checkout w1") {
			t.Fatalf("audit = %+v", row)
		}
	})
	t.Run("another worktree is still open", func(t *testing.T) {
		hb := startHireBridge(t, nil, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"), linkedWorker("w3", "h3d/mochi-d4e5f6"))
		hired(t, hb, "w2")
		fire(t, hb, "w2")
		if closed(hb, "w1") {
			t.Fatalf("closed the main checkout of an open worktree: %q", hb.fl.Calls())
		}
		hb.world(hasWorkers("s", 1))
	})
	t.Run("an agent works in it", func(t *testing.T) {
		main := claudeW("w1", "")
		main.Worktree = mainShell("w1").Worktree
		hb := startHireBridge(t, nil, main, linkedWorker("w2", "h3d/pixel-a1b2c3"))
		hired(t, hb, "w2")
		fire(t, hb, "w2")
		if closed(hb, "w1") {
			t.Fatalf("closed a main checkout with an agent: %q", hb.fl.Calls())
		}
		hb.world(hasWorkers("s", 1))
	})
	t.Run("not hired by the bridge", func(t *testing.T) {
		hb := startHireBridge(t, nil, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"))
		fire(t, hb, "w2")
		if closed(hb, "w1") {
			t.Fatalf("closed the main checkout of a worktree the bridge did not hire: %q", hb.fl.Calls())
		}
		// Nothing holds it hidden now: a worker.
		hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")["w1"]; return ok && len(workersOf(w, "s")) == 1 })
	})
	// What herdr shows when the bridge is about to close the workspace is
	// what counts, not what it showed at the last observation.
	skipped := func(t *testing.T, fresh func([]world.WorkerObs) ([]world.WorkerObs, error), why string) {
		t.Helper()
		hb := startHireBridge(t, nil, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"))
		hb.fl.fresh = fresh
		hired(t, hb, "w2")
		fire(t, hb, "w2") // still sent home
		if closed(hb, "w1") {
			t.Fatalf("closed the main checkout against herdr's fresh state: %q", hb.fl.Calls())
		}
		hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")["w1"]; return ok && len(workersOf(w, "s")) == 1 })
		if row := auditRow(t, hb.bridge, proto.CmdWorkerFire); !row.OK || !strings.Contains(row.Result, "main checkout w1 skipped: "+why) {
			t.Fatalf("audit = %+v", row)
		}
	}
	t.Run("an agent started in it after the last observation", func(t *testing.T) {
		skipped(t, func(cur []world.WorkerObs) ([]world.WorkerObs, error) {
			for i := range cur {
				if cur[i].WorkspaceID == "w1" {
					cur[i].AgentKind, cur[i].Status = "claude", "working"
				}
			}
			return cur, nil
		}, "an agent runs in it")
	})
	t.Run("a worktree was opened after the last observation", func(t *testing.T) {
		skipped(t, func(cur []world.WorkerObs) ([]world.WorkerObs, error) {
			return append(cur, linkedWorker("w9", "h3d/mochi-d4e5f6")), nil
		}, "a worktree of the repository is open again")
	})
	t.Run("herdr cannot be read", func(t *testing.T) {
		skipped(t, func([]world.WorkerObs) ([]world.WorkerObs, error) { return nil, errors.New("connection refused") },
			"herdr's state cannot be read: connection refused")
	})
	t.Run("closed meanwhile", func(t *testing.T) {
		skipped(t, func(cur []world.WorkerObs) ([]world.WorkerObs, error) {
			return slices.DeleteFunc(cur, func(w world.WorkerObs) bool { return w.WorkspaceID == "w1" }), nil
		}, "it is gone")
	})
	t.Run("close fails", func(t *testing.T) {
		hb := startHireBridge(t, nil, mainShell("w1"), linkedWorker("w2", "h3d/pixel-a1b2c3"))
		hb.fl.closeErrs = map[string]error{"w1": errors.New("workspace_group_close_required")}
		hired(t, hb, "w2")
		fire(t, hb, "w2") // still sent home
		hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")["w1"]; return ok && len(workersOf(w, "s")) == 1 })
		if row := auditRow(t, hb.bridge, proto.CmdWorkerFire); !row.OK || !strings.Contains(row.Result, "main checkout w1 failed") {
			t.Fatalf("audit = %+v", row)
		}
	})
}

// A worktree hire on an empty floor ends with one worker; sending it home
// closes the main checkout herdr opened for it.
func TestWorktreeHireOnAnEmptyFloor(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil)
	hb.git.repos["/home/u/repo"] = "/home/u/repo"
	a := hireArgs(0)
	a.Cwd, a.Worktree = "/home/u/repo", true
	_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
	res := ackData[proto.HireResult](t, m)
	w := hb.world(hasWorkers("s", 1))
	if got := workersOf(w, "s")[res.WorkspaceID]; got.ID != res.ID || got.DeskIndex != 0 {
		t.Fatalf("workers = %+v", w.Workers)
	}
	hb.fl.mu.Lock()
	open := len(hb.fl.workers)
	hb.fl.mu.Unlock()
	if open != 2 {
		t.Fatalf("herdr has %d workspaces, want the worktree and its main checkout", open)
	}

	hb.c.mustAck(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: res.ID})
	if calls := hb.fl.Calls(); calls[len(calls)-1] != "close w1" {
		t.Fatalf("herdr calls = %q", calls)
	}
	hb.world(hasWorkers("s", 0))
	hb.fl.mu.Lock()
	open = len(hb.fl.workers)
	hb.fl.mu.Unlock()
	if open != 0 {
		t.Fatalf("herdr still has %d workspaces", open)
	}
}

// A client label with a numeric suffix never becomes a worker's name.
func TestHireLabelWithDigitsGetsAPlainName(t *testing.T) {
	t.Parallel()
	hb := startHireBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	hb.world(func(w proto.World) bool { return len(w.Workers) == 1 })
	args := hireArgs(3)
	args.Label, args.Cwd = "Pixel 2", "/home/u/repo"
	_, ack := hb.c.mustAck(proto.CmdWorkerHire, args)
	id := ack.Data.(map[string]any)["id"].(string)
	w := workersOf(hb.world(func(w proto.World) bool { return workersOf(w, "s")["w2"].ID == id }), "s")["w2"]
	if strings.ContainsAny(w.Name, "0123456789") || !world.IsName(w.Name) {
		t.Fatalf("hired name = %q", w.Name)
	}
}
