package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// boardClock is the bridge boardClock of the board tests.
type boardClock struct {
	mu sync.Mutex
	t  time.Time
}

func newBoardClock() *boardClock {
	return &boardClock{t: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)}
}

func (c *boardClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *boardClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// fakeTracker is a tracker.Tracker (and RunLinker) in memory.
type fakeTracker struct {
	mu    sync.Mutex
	id    string // Info's id ("": fake)
	repo  string
	caps  tracker.Capabilities
	board tracker.Board
	err   error
	gate  chan struct{} // Board waits for it when set
	early bool          // Board reads its answer before it waits (a poll that read before a write)
	polls int
	calls []string
	// answers of the other calls
	detail  tracker.Detail
	failOn  map[string]error // by method name
	missing map[string]bool  // ids that Get does not find
}

func (f *fakeTracker) Info() tracker.Info {
	if f.id == "kaneo" {
		return tracker.Info{ID: "kaneo", Name: "Kaneo", Capabilities: f.caps}
	}
	return tracker.Info{ID: "fake", Name: "Fake", Capabilities: f.caps}
}

func (f *fakeTracker) Board(ctx context.Context) (tracker.Board, error) {
	f.mu.Lock()
	gate := f.gate
	f.polls++
	read, rerr := f.board, f.err
	early := f.early
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
		}
	}
	if early {
		return read, rerr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return tracker.Board{}, f.err
	}
	return f.board, nil
}

func (f *fakeTracker) record(method, format string, args ...any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method+" "+fmt.Sprintf(format, args...))
	return f.failOn[method]
}

func (f *fakeTracker) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeTracker) Polls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.polls
}

func (f *fakeTracker) set(fn func(f *fakeTracker)) {
	f.mu.Lock()
	fn(f)
	f.mu.Unlock()
}

func (f *fakeTracker) Get(_ context.Context, id string) (tracker.Detail, error) {
	if err := f.record("get", "%s", id); err != nil {
		return tracker.Detail{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.missing[id] {
		return tracker.Detail{}, provider.Errorf(provider.ErrNotFound, "%s is not on %s", id, f.repo)
	}
	return f.detail, nil
}

func (f *fakeTracker) Comment(_ context.Context, id, body string) (provider.Comment, error) {
	if err := f.record("comment", "%s %s", id, body); err != nil {
		return provider.Comment{}, err
	}
	return provider.Comment{ID: "c1", Author: provider.Person{Name: "bot"}, Body: body, CreatedAt: 1790670000000}, nil
}

func (f *fakeTracker) Close(_ context.Context, id, reason string) error {
	return f.record("close", "%s %s", id, reason)
}

// SetStatus records the move and, unless it fails, makes it on the board
// (like a provider: the next poll has the card in its new column).
func (f *fakeTracker) SetStatus(_ context.Context, id, column string, at *tracker.Anchor) error {
	var err error
	if at == nil {
		err = f.record("set_status", "%s %s", id, column)
	} else {
		err = f.record("set_status", "%s %s after=%q", id, column, at.After)
	}
	if err == nil {
		f.mu.Lock()
		cards := slices.Clone(f.board.Cards)
		for i := range cards {
			if cards[i].ID == id {
				cards[i].Column = column
			}
		}
		f.board.Cards = cards
		f.mu.Unlock()
	}
	return err
}

func (f *fakeTracker) ItemFromRun(repo string, n int) (string, bool) {
	return repo + "#" + strconv.Itoa(n), n > 0
}

func (f *fakeTracker) RunFromItem(id string) (string, int, string, bool) {
	repo, num, ok := strings.Cut(id, "#")
	n, err := strconv.Atoi(num)
	if !ok || err != nil || repo != f.repo {
		return "", 0, "", false
	}
	return repo, n, "https://example.test/" + repo + "/issues/" + num, true
}

// fakeHost is a codehost.Host in memory.
type fakeHost struct {
	mu     sync.Mutex
	caps   codehost.Capabilities
	board  codehost.Board
	err    error
	prevs  []codehost.PrevState
	detail codehost.Detail
	calls  []string
	failOn map[string]error
	opened codehost.Opened
	// mergedFor returns the merges of the previous ids that this list holds
	// (like a provider that looks the previous ones up).
	mergedNow []codehost.Merged
	// always returns them whatever prev says (a provider whose merge stays visible).
	always bool
}

func (f *fakeHost) Info() codehost.Info {
	return codehost.Info{ID: "fake", Name: "Fake", Capabilities: f.caps}
}

func (f *fakeHost) Board(_ context.Context, prev codehost.PrevState) (codehost.Board, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prevs = append(f.prevs, codehost.PrevState{OpenIDs: slices.Clone(prev.OpenIDs)})
	if f.err != nil {
		return codehost.Board{}, f.err
	}
	b := f.board
	b.Merged = nil
	for _, m := range f.mergedNow {
		if f.always || slices.Contains(prev.OpenIDs, m.ID) {
			b.Merged = append(b.Merged, m)
		}
	}
	return b, nil
}

func (f *fakeHost) record(method, format string, args ...any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, method+" "+fmt.Sprintf(format, args...))
	return f.failOn[method]
}

func (f *fakeHost) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeHost) set(fn func(f *fakeHost)) {
	f.mu.Lock()
	fn(f)
	f.mu.Unlock()
}

func (f *fakeHost) Prevs() []codehost.PrevState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.prevs)
}

func (f *fakeHost) Get(_ context.Context, id string) (codehost.Detail, error) {
	if err := f.record("get", "%s", id); err != nil {
		return codehost.Detail{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.detail, nil
}

func (f *fakeHost) Comment(_ context.Context, id, body string) (provider.Comment, error) {
	if err := f.record("comment", "%s %s", id, body); err != nil {
		return provider.Comment{}, err
	}
	return provider.Comment{ID: "pc1", Body: body}, nil
}

func (f *fakeHost) Merge(_ context.Context, id, method string, override bool) error {
	return f.record("merge", "%s %s override=%v", id, method, override)
}

func (f *fakeHost) OpenFromBranch(_ context.Context, b codehost.Branch) (codehost.Opened, error) {
	if err := f.record("open", "%s base=%s title=%q body=%q", b.Name, b.Base, b.Title, b.Body); err != nil {
		return codehost.Opened{}, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.opened, nil
}

// fakeBoards is the BoardFactory of the tests: a tracker and a host per
// repo, created on first use.
type fakeBoards struct {
	mu     sync.Mutex
	repos  map[string]*fakeTracker
	hosts  map[string]*fakeHost
	noHost bool
	seen   []server.BoardSource
	// #184: Kaneo floors' trackers, by project and connection generation.
	kaneo map[string]*fakeTracker
	keys  []string // the BoardSet keys handed out
}

func newFakeBoards() *fakeBoards {
	return &fakeBoards{repos: map[string]*fakeTracker{}, hosts: map[string]*fakeHost{}, kaneo: map[string]*fakeTracker{}}
}

// kaneoTracker makes (or returns) the Kaneo tracker of a project for the
// connection's generation gen: like a provider built from that key.
func (fb *fakeBoards) kaneoTracker(project string, gen int64) *fakeTracker {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	k := fmt.Sprintf("%s@%d", project, gen)
	tr := fb.kaneo[k]
	if tr == nil {
		tr = &fakeTracker{id: "kaneo", caps: tracker.Capabilities{Comment: true, SetStatus: true, Order: true}, failOn: map[string]error{},
			board: tracker.Board{Columns: []tracker.Column{{ID: "to-do", Name: "To Do"}, {ID: "done", Name: "Done", Done: true},
				{ID: "planned", Name: "Planned", Kind: "planned"}, {ID: "archived", Name: "Archived", Kind: "archived"}}}}
		fb.kaneo[k] = tr
	}
	return tr
}

// repo makes (or returns) the provider pair of a repo with the usual capabilities.
func (fb *fakeBoards) repo(repo string) (*fakeTracker, *fakeHost) {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	tr := fb.repos[repo]
	if tr == nil {
		tr = &fakeTracker{repo: repo, caps: tracker.Capabilities{Comment: true, Close: true, SetStatus: true}, failOn: map[string]error{},
			board: tracker.Board{Columns: []tracker.Column{{ID: "todo", Name: "Todo"}, {ID: "done", Name: "Done", Done: true}}}}
		fb.repos[repo] = tr
		fb.hosts[repo] = &fakeHost{caps: codehost.Capabilities{Comment: true, Merge: true, OpenFromBranch: true}, failOn: map[string]error{}}
	}
	return tr, fb.hosts[repo]
}

func (fb *fakeBoards) factory(src server.BoardSource) (server.BoardSet, bool) {
	if src.Tracker == server.TrackerKaneo { // #184: like app.Boards
		fb.mu.Lock()
		fb.seen = append(fb.seen, src)
		tr := fb.kaneo[fmt.Sprintf("%s@%d", src.KaneoProject, src.KaneoGeneration)]
		host := fb.hosts[src.Repo]
		fb.mu.Unlock()
		if tr == nil {
			return server.BoardSet{}, false
		}
		set := server.BoardSet{Key: fmt.Sprintf("kaneo:%s:%s:%s:g%d", src.KaneoAPIBase, src.KaneoWorkspace, src.KaneoProject, src.KaneoGeneration),
			Tracker: tr}
		if host != nil {
			set.Host, set.Key = host, set.Key+"|fake:"+src.Repo
		}
		fb.mu.Lock()
		fb.keys = append(fb.keys, set.Key)
		fb.mu.Unlock()
		return set, true
	}
	fb.mu.Lock()
	fb.seen = append(fb.seen, src)
	tr, host, ok := fb.repos[src.Repo], fb.hosts[src.Repo], false
	noHost := fb.noHost
	fb.mu.Unlock()
	if tr == nil {
		return server.BoardSet{}, false
	}
	set := server.BoardSet{Key: "fake:" + src.Repo, Tracker: tr}
	if !noHost {
		set.Host = host
	}
	_ = ok
	return set, true
}

func card(id, key, title, col string) tracker.Card {
	return tracker.Card{ID: id, Key: key, Title: title, State: "open", Column: col, Labels: []tracker.Label{}, Assignees: []provider.Person{},
		Author: "dev", UpdatedAt: 1790670000000}
}

func request(id, key, title, head, checks string) codehost.Request {
	return codehost.Request{ID: id, Key: key, Title: title, State: "open", HeadBranch: head, BaseBranch: "main", Author: "dev",
		Checks: checks, Review: "none", Mergeable: "mergeable", Closes: []string{}, UpdatedAt: 1790670000000}
}

// boardBridge is a hire bridge (floor "s") with fake boards and a boardClock.
type boardBridge struct {
	*hireBridge
	fb  *fakeBoards
	clk *boardClock
}

func startBoardBridge(t *testing.T, tweak func(o *server.Options), workers ...world.WorkerObs) *boardBridge {
	t.Helper()
	bb := &boardBridge{fb: newFakeBoards(), clk: newBoardClock()}
	bb.hireBridge = startHireBridge(t, func(o *server.Options) {
		o.Boards = bb.fb.factory
		o.Now = bb.clk.Now
		o.BoardTick = 3 * time.Millisecond
		if tweak != nil {
			tweak(o)
		}
	}, workers...)
	return bb
}

// link points floor "s" at repo (the fake providers must exist first).
func (bb *boardBridge) link(repo string) {
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some(repo)})
}

// polled waits until floor session's first poll is applied (its cache is stored).
func (bb *boardBridge) polled(session string) {
	bb.t.Helper()
	eventually(bb.t, "the first poll of "+session, func() bool {
		c, err := bb.st.BoardCaches(context.Background())
		return err == nil && c[session].IssuesAt != 0
	})
}

// watcher is a connection that watches floor "s" and reads its boards.
type watcher struct{ *client }

func (bb *boardBridge) watcher() *watcher {
	c := bb.connect(proto.Hello{Client: "watcher"})
	c.snapshot()
	return &watcher{c}
}

// boardMsg reads until a message of type typ, skipping the world's events.
func (w *watcher) boardMsg(typ string) msg {
	w.t.Helper()
	for {
		m := w.next()
		if m.env.T == typ {
			if m.env.Seq != 0 {
				w.t.Fatalf("a board message with a seq: %s", m.raw)
			}
			return m
		}
	}
}

func (w *watcher) issues() proto.BoardIssues {
	w.t.Helper()
	var b proto.BoardIssues
	if err := json.Unmarshal(w.boardMsg(proto.TBoardIssues).raw, &b); err != nil {
		w.t.Fatal(err)
	}
	return b
}

func (w *watcher) prs() proto.BoardPRs {
	w.t.Helper()
	var b proto.BoardPRs
	if err := json.Unmarshal(w.boardMsg(proto.TBoardPRs).raw, &b); err != nil {
		w.t.Fatal(err)
	}
	return b
}

// pair reads the two messages of one poll, the issues first.
func (w *watcher) pair() (proto.BoardIssues, proto.BoardPRs) {
	w.t.Helper()
	var is proto.BoardIssues
	var ps proto.BoardPRs
	for {
		m := w.next()
		switch m.env.T {
		case proto.TBoardIssues:
			if err := json.Unmarshal(m.raw, &is); err != nil {
				w.t.Fatal(err)
			}
		case proto.TBoardPRs:
			if is.T == "" {
				w.t.Fatalf("board.prs before board.issues: %s", m.raw)
			}
			if err := json.Unmarshal(m.raw, &ps); err != nil {
				w.t.Fatal(err)
			}
			return is, ps
		}
	}
}

// watch sends board.watch and returns its ack data.
func (w *watcher) watch(session string) proto.BoardWatchResult {
	w.t.Helper()
	_, m := w.command(proto.CmdBoardWatch, "watch", proto.BoardArgs{Session: session})
	return ackData[proto.BoardWatchResult](w.t, m)
}

// quiet checks that no board message arrives within d: it waits, then asks
// for something harmless and reads up to its ack (messages arrive in order).
func (w *watcher) quiet(d time.Duration) {
	w.t.Helper()
	time.Sleep(d)
	cmd := proto.Command{T: proto.CmdBoardUnwatch, ReqID: "quiet", Args: []byte(`{"session":"no-such-floor"}`)}
	w.send(cmd)
	for {
		m := w.next()
		if m.env.T == proto.TAck && m.env.ReqID == "quiet" {
			return
		}
		if m.env.T == proto.TBoardIssues || m.env.T == proto.TBoardPRs {
			w.t.Fatalf("an unexpected board message: %s", m.raw)
		}
	}
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
