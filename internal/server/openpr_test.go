package server_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// fakePRGit is server.PRGit: the checkout of a worktree hire, as it is now.
type fakePRGit struct {
	mu       sync.Mutex
	calls    []string
	dirty    []string
	cur      map[string]string // checkout → branch, else as named by its path
	ahead    int
	subjects []string
	pushErr  error
	def      string
}

func (g *fakePRGit) record(format string, args ...any) {
	g.mu.Lock()
	g.calls = append(g.calls, fmt.Sprintf(format, args...))
	g.mu.Unlock()
}

func (g *fakePRGit) Calls() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.calls)
}

func (g *fakePRGit) set(fn func(g *fakePRGit)) {
	g.mu.Lock()
	fn(g)
	g.mu.Unlock()
}

func (g *fakePRGit) Fetch(_ context.Context, dir string) error { g.record("fetch %s", dir); return nil }

func (g *fakePRGit) Status(context.Context, string) ([]string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	return slices.Clone(g.dirty), nil
}

func (g *fakePRGit) CurrentBranch(_ context.Context, dir string) (string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if b, ok := g.cur[dir]; ok {
		return b, nil
	}
	_, b, _ := strings.Cut(dir, "/repo/")
	return strings.Replace(b, "h3d-", "h3d/", 1), nil
}

func (g *fakePRGit) DefaultBranch(context.Context, string) string { return g.def }

func (g *fakePRGit) Push(_ context.Context, dir, branch string) error {
	g.record("push %s %s", dir, branch)
	return g.pushErr
}

func (g *fakePRGit) AheadOf(_ context.Context, dir, base string) (int, error) {
	g.record("ahead %s %s", dir, base)
	return g.ahead, nil
}

func (g *fakePRGit) Subjects(_ context.Context, dir, base string) ([]string, error) {
	g.record("subjects %s %s", dir, base)
	return slices.Clone(g.subjects), nil
}

// prBridge is a board bridge with a plain worker in a worktree of /home/u/lab.
type prBridge struct {
	*boardBridge
	tr     *fakeTracker
	host   *fakeHost
	pg     *fakePRGit
	origin *atomic.Value // the repo the checkout's origin is
	worker string        // the worker's id
	branch string
	dir    string // its checkout
}

func startPRBridge(t *testing.T) *prBridge {
	t.Helper()
	pg := &fakePRGit{ahead: 2, subjects: []string{"feat: greet by name", "test: cover the flag"}, def: "main", cur: map[string]string{}}
	origin := &atomic.Value{}
	origin.Store("JeffreyVdb/lab")
	bb := startBoardBridge(t, func(o *server.Options) {
		o.PRGit = pg
		o.RepoOf = func(context.Context, string) string { return origin.Load().(string) }
	})
	p := &prBridge{boardBridge: bb, pg: pg, origin: origin}
	p.tr, p.host = bb.fb.repo("JeffreyVdb/lab")
	bb.git.repos["/home/u/lab"] = "/home/u/lab"
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"), DefaultCwd: proto.Some("/home/u/lab")})
	bb.polled("s")
	desk := 2
	_, m := bb.c.command(proto.CmdWorkerHire, "hire", proto.WorkerHireArgs{Session: "s", DeskIndex: &desk, Harness: "codex", Model: "gpt-6-luna",
		Effort: "low", Cwd: "/home/u/lab", Worktree: true})
	res := ackData[proto.HireResult](t, m)
	p.worker, p.branch = res.ID, res.Branch
	p.dir = "/home/u/.herdr/worktrees/repo/" + strings.ReplaceAll(res.Branch, "/", "-")
	if p.branch == "" {
		t.Fatalf("hire = %s", m.raw)
	}
	return p
}

func (p *prBridge) prepare() proto.OpenPRPrepareResult {
	p.t.Helper()
	_, m := p.c.command(proto.CmdOpenPRPrepare, "prep", proto.WorkerArgs{ID: p.worker})
	return ackData[proto.OpenPRPrepareResult](p.t, m)
}

func TestOpenPRPrepare(t *testing.T) {
	t.Parallel()
	p := startPRBridge(t)
	res := p.prepare()
	if !res.CanOpen || res.Reason != "" || res.Branch != p.branch || res.Base != "main" || res.Ahead != 2 || res.Dirty || res.Existing != nil ||
		res.Title != "feat: greet by name" || res.Body != "- feat: greet by name\n- test: cover the flag" {
		t.Fatalf("prepare = %+v", res)
	}
	if got := p.pg.Calls(); got[0] != "fetch "+p.dir || !slices.Contains(got, "ahead "+p.dir+" origin/main") || !slices.Contains(got, "subjects "+p.dir+" origin/main") {
		t.Fatalf("git calls = %q", got)
	}

	// An open pull request for the branch on the board is reported.
	pr := request("JeffreyVdb/lab#5", "#5", "Already", p.branch, "success")
	pr.URL = "https://example.test/pull/5"
	p.host.set(func(f *fakeHost) { f.board.Requests = []codehost.Request{pr} })
	w := p.watcher()
	w.watch("s")
	w.pair()
	p.clk.Advance(11 * 60 * 1e9)
	w.pair()
	if res = p.prepare(); res.Existing == nil || *res.Existing != (proto.OpenPRRef{ID: "JeffreyVdb/lab#5", Key: "#5", URL: "https://example.test/pull/5"}) {
		t.Fatalf("existing = %+v", res.Existing)
	}

	// Why it cannot be opened: still a result, with the reason.
	for name, tc := range map[string]struct {
		mut    func(g *fakePRGit)
		reason string
		dirty  bool
		ahead  int
	}{
		"dirty":        {func(g *fakePRGit) { g.dirty = []string{" M main.go"} }, "uncommitted changes", true, 2},
		"nothing new":  {func(g *fakePRGit) { g.ahead, g.subjects = 0, nil }, "no commits on top of origin/main", false, 0},
		"other branch": {func(g *fakePRGit) { g.cur = map[string]string{p.dir: "main"} }, `is on "main"`, false, 2},
	} {
		p.pg.set(func(g *fakePRGit) {
			g.dirty, g.ahead, g.subjects, g.cur = nil, 2, []string{"s"}, map[string]string{}
			tc.mut(g)
		})
		got := p.prepare()
		if got.CanOpen || !strings.Contains(got.Reason, tc.reason) || got.Dirty != tc.dirty || got.Ahead != tc.ahead {
			t.Errorf("%s: %+v", name, got)
		}
	}
}

func TestOpenPRPrepareRefusals(t *testing.T) {
	t.Parallel()
	p := startPRBridge(t)
	c := p.c
	c.mustError(proto.CmdOpenPRPrepare, proto.WorkerArgs{ID: "nobody"}, proto.ErrUnknownWorker)
	// A worker the bridge did not hire into a branch.
	p.fl.mu.Lock()
	p.fl.workers = append(p.fl.workers, worker("w9", "plain", "", "idle"))
	p.fl.mu.Unlock()
	p.fl.publish()
	ws := workersOf(p.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 2 }), "s")
	var plain string
	for _, w := range ws {
		if w.WorkspaceID == "w9" {
			plain = w.ID
		}
	}
	c.mustError(proto.CmdOpenPRPrepare, proto.WorkerArgs{ID: plain}, proto.ErrInvalidState)
	// An orchestrator (a role) never opens one.
	decorateRoles(p.boardBridge)
	desk := 3
	_, m := c.command(proto.CmdWorkerHire, "hire2", proto.WorkerHireArgs{Session: "s", DeskIndex: &desk, Harness: "codex", Model: "gpt-6-luna",
		Effort: "low", Cwd: "/home/u/lab", Worktree: true, Label: "ORCH|issue-3"})
	orch := ackData[proto.HireResult](t, m).ID
	c.mustError(proto.CmdOpenPRPrepare, proto.WorkerArgs{ID: orch}, proto.ErrInvalidState)
	c.mustError(proto.CmdWorkerOpenPR, proto.OpenPRArgs{ID: orch, Title: "t", Body: "b", Confirm: true}, proto.ErrInvalidState)
	// A floor with no board.
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/no-provider-for-this")})
	c.mustError(proto.CmdOpenPRPrepare, proto.WorkerArgs{ID: p.worker}, proto.ErrUnsupported)
	c.mustError(proto.CmdWorkerOpenPR, proto.OpenPRArgs{ID: p.worker, Title: "t", Body: "b", Confirm: true}, proto.ErrUnsupported)
	// The floor asleep.
	p.fb.repo("JeffreyVdb/lab")
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab")})
	p.floorAt("s", false, nil)
	p.world(func(w proto.World) bool { return floorOf(w, "s").State == "asleep" })
	c.mustError(proto.CmdOpenPRPrepare, proto.WorkerArgs{ID: p.worker}, proto.ErrUnknownWorker)
}

func TestOpenPR(t *testing.T) {
	t.Parallel()
	p := startPRBridge(t)
	c := p.c
	p.host.set(func(f *fakeHost) {
		f.opened = codehost.Opened{ID: "JeffreyVdb/lab#7", Key: "#7", URL: "https://example.test/pull/7"}
	})
	args := func(mods ...func(*proto.OpenPRArgs)) proto.OpenPRArgs {
		a := proto.OpenPRArgs{ID: p.worker, Title: "feat: greet by name", Body: "the secret plan: hunter2", Confirm: true}
		for _, m := range mods {
			m(&a)
		}
		return a
	}
	c.mustError(proto.CmdWorkerOpenPR, args(func(a *proto.OpenPRArgs) { a.Confirm = false }), proto.ErrConfirmationRequired)
	c.mustError(proto.CmdWorkerOpenPR, args(func(a *proto.OpenPRArgs) { a.Title = "" }), proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerOpenPR, args(func(a *proto.OpenPRArgs) { a.Title = strings.Repeat("t", 257) }), proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerOpenPR, args(func(a *proto.OpenPRArgs) { a.Title = "two\nlines" }), proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerOpenPR, args(func(a *proto.OpenPRArgs) { a.Body = "a\x00b" }), proto.ErrBadRequest)
	if len(p.host.Calls()) != 0 || slices.ContainsFunc(p.pg.Calls(), func(s string) bool { return strings.HasPrefix(s, "push") }) {
		t.Fatal("a refused open_pr pushed or opened")
	}

	// Push first, then the pull request, against the hire's base.
	w := p.watcher()
	w.watch("s")
	w.pair()
	before := p.tr.Polls()
	_, m := c.command(proto.CmdWorkerOpenPR, "open", args())
	res := ackData[proto.OpenPRResult](t, m)
	if res.PR != (proto.OpenPRRef{ID: "JeffreyVdb/lab#7", Key: "#7", URL: "https://example.test/pull/7"}) || !res.Pushed || res.Existed {
		t.Fatalf("ack = %s", m.raw)
	}
	pushes := 0
	for _, call := range p.pg.Calls() {
		if call == "push "+p.dir+" "+p.branch {
			pushes++
		}
	}
	if pushes != 1 {
		t.Fatalf("git calls = %q", p.pg.Calls())
	}
	want := fmt.Sprintf("open %s base=main title=%q body=%q", p.branch, "feat: greet by name", "the secret plan: hunter2")
	if calls := p.host.Calls(); len(calls) != 1 || calls[0] != want {
		t.Fatalf("host calls = %q", calls)
	}
	// The audit row has the worker, the sizes and the outcome, no text.
	rows := auditRows(t, p.boardBridge, proto.CmdWorkerOpenPR)
	var ok store_row
	for _, r := range rows {
		if r.OK {
			ok = store_row{r.Args, r.Result}
		}
	}
	if strings.Contains(ok.args, "hunter2") || strings.Contains(ok.args, "greet") || strings.Contains(ok.result, "hunter2") || strings.Contains(ok.result, "greet") ||
		!strings.Contains(ok.args, `"body_bytes":24`) || !strings.Contains(ok.args, `"title_bytes":19`) || !strings.Contains(ok.result, `"pushed":true`) ||
		!strings.Contains(ok.result, `"pr":"JeffreyVdb/lab#7"`) {
		t.Fatalf("audit = %+v", ok)
	}
	if is, _ := w.pair(); is.Initial || p.tr.Polls() != before+1 {
		t.Fatalf("no refresh after open_pr: %d → %d", before, p.tr.Polls())
	}

	// An open pull request for the head is returned, not a second one.
	p.host.set(func(f *fakeHost) { f.opened.Existed = true })
	_, m = c.command(proto.CmdWorkerOpenPR, "again", args())
	if res = ackData[proto.OpenPRResult](t, m); !res.Existed || !res.Pushed {
		t.Fatalf("existing = %s", m.raw)
	}

	// The tree must be clean, ahead of the base, on its branch, in the floor's repo.
	before2 := len(p.pg.Calls())
	beforeHost := len(p.host.Calls())
	for name, tc := range map[string]func(g *fakePRGit){
		"dirty":        func(g *fakePRGit) { g.dirty = []string{"?? notes.txt"} },
		"nothing new":  func(g *fakePRGit) { g.ahead = 0 },
		"other branch": func(g *fakePRGit) { g.cur = map[string]string{p.dir: "h3d/other"} },
	} {
		p.pg.set(func(g *fakePRGit) { g.dirty, g.ahead, g.cur = nil, 2, map[string]string{}; tc(g) })
		c.mustError(proto.CmdWorkerOpenPR, args(), proto.ErrInvalidState)
		_ = name
	}
	p.pg.set(func(g *fakePRGit) { g.dirty, g.ahead, g.cur = nil, 2, map[string]string{} })
	for _, call := range p.pg.Calls()[before2:] {
		if strings.HasPrefix(call, "push") {
			t.Fatalf("pushed from a checkout that cannot open one: %q", call)
		}
	}
	if len(p.host.Calls()) != beforeHost {
		t.Fatal("opened a pull request from a checkout that cannot open one")
	}

	// A failed push: nothing is opened. A failed open after the push says so; asking again retries.
	p.pg.set(func(g *fakePRGit) { g.pushErr = errors.New("git push: remote: Permission to JeffreyVdb/lab denied") })
	n := len(p.host.Calls())
	_, m = c.command(proto.CmdWorkerOpenPR, "pushfail", args())
	if e := errorOf(m); e.Code != proto.ErrProviderFailed || !strings.Contains(e.Message, "git push failed") || len(p.host.Calls()) != n {
		t.Fatalf("push failure = %s", m.raw)
	}
	p.pg.set(func(g *fakePRGit) { g.pushErr = nil })
	p.host.set(func(f *fakeHost) { f.failOn["open"] = errors.New("boom") })
	_, m = c.command(proto.CmdWorkerOpenPR, "openfail", args())
	if e := errorOf(m); e.Code != proto.ErrInternal && e.Code != proto.ErrProviderFailed {
		t.Fatalf("open failure = %s", m.raw)
	}
	if !strings.Contains(errorOf(m).Message, "pushed "+p.branch+", but opening the pull request failed") {
		t.Fatalf("open failure says: %s", m.raw)
	}

}

type store_row struct{ args, result string }

// The checkout's origin must be the floor's repo.
func TestOpenPROrigin(t *testing.T) {
	t.Parallel()
	p := startPRBridge(t)
	p.origin.Store("someone-else/lab")
	if res := p.prepare(); res.CanOpen || !strings.Contains(res.Reason, "origin") {
		t.Fatalf("prepare = %+v", res)
	}
	p.c.mustError(proto.CmdWorkerOpenPR, proto.OpenPRArgs{ID: p.worker, Title: "t", Body: "b", Confirm: true}, proto.ErrInvalidState)
	p.origin.Store("JeffreyVdb/lab") // GitHub names are not case sensitive
	if res := p.prepare(); !res.CanOpen {
		t.Fatalf("prepare = %+v", res)
	}
	for _, call := range p.pg.Calls() {
		if strings.HasPrefix(call, "push") {
			t.Fatalf("pushed: %q", call)
		}
	}
}
