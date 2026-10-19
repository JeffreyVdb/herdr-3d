//go:build integration

package codexshare

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/codexchild"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// #27: a shared worker's child threads through its own app-server, with
// mock inference spawning and steering real Codex children (MOCK:spawn,
// MOCK:followup, …). The bridge side is the production pieces wired as the
// hub wires them: a codexapp.Watcher joined to the root thread, its events
// to a codexchild.Source (Joined, Notify, Lost), the root's rollouts read by
// a usage.Session into the same source, its evidence applied to a
// childagents.Registry.

// proxy forwards a unix socket to the server's, so a test can cut the
// bridge's connection (a lost connection, not a closed watcher).
type proxy struct {
	ln    net.Listener
	mu    sync.Mutex
	conns []net.Conn
}

func newProxy(t *testing.T, path, target string) *proxy {
	t.Helper()
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	p := &proxy{ln: ln}
	t.Cleanup(func() { _ = ln.Close(); p.cut() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			s, err := net.Dial("unix", target)
			if err != nil {
				_ = c.Close()
				continue
			}
			p.mu.Lock()
			p.conns = append(p.conns, c, s)
			p.mu.Unlock()
			go func() { _, _ = io.Copy(s, c); _ = s.Close() }()
			go func() { _, _ = io.Copy(c, s); _ = c.Close() }()
		}
	}()
	return p
}

// cut closes every connection through the proxy.
func (p *proxy) cut() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.conns {
		_ = c.Close()
	}
	p.conns = nil
}

// cbridge is the bridge's side for one shared worker.
type cbridge struct {
	f      *hfx
	root   string
	src    *codexchild.Source
	reg    *childagents.Registry
	mu     sync.Mutex
	evs    []childagents.Evidence
	w      *codexapp.Watcher
	sess   *usage.Session
	l      *codexchild.Listener
	cancel context.CancelFunc
	joins  chan struct{}
}

// newBridge starts the bridge's side on sock (the server's, or a proxy's)
// for root, reading its rollouts too.
func (f *hfx) newBridge(sock, root string, stable bool) *cbridge {
	f.t.Helper()
	b := &cbridge{f: f, root: root, src: codexchild.New(codexchild.Options{Settle: 500 * time.Millisecond, Log: f.t.Logf}),
		reg: childagents.New(), joins: make(chan struct{}, 16)}
	b.reg.Worker("w", root)
	ctx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	go func() {
		_ = b.src.Run(ctx, func(e childagents.Evidence) {
			b.mu.Lock()
			defer b.mu.Unlock()
			b.evs = append(b.evs, e)
			_, _ = b.reg.Apply(e)
		})
	}()
	b.sess = usage.NewSession(usage.Codex, root, usage.Roots{CodexSessions: filepath.Join(f.home, "sessions")}, usage.DefaultPricing())
	b.l = b.src.Listener(root)
	b.sess.SetChildren(b.l)
	go func() {
		t := time.NewTicker(200 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-t.C:
				b.sess.Poll(now)
			}
		}
	}()
	b.join(sock, stable)
	f.t.Cleanup(b.stop)
	return b
}

// join starts the watcher (the hub's codexEvent wiring) and waits for it.
func (b *cbridge) join(sock string, stable bool) {
	b.f.t.Helper()
	w, err := codexapp.Watch(codexapp.Options{Socket: sock, Thread: b.root, StableAPI: stable, MinBackoff: 100 * time.Millisecond,
		MaxBackoff: 500 * time.Millisecond, MaxRetries: 50, OnEvent: func(e codexapp.Event) {
			switch e.Kind {
			case codexapp.EvJoined:
				b.src.Joined(b.root, b.w)
				b.joins <- struct{}{}
			case codexapp.EvNotification:
				b.src.Notify(b.root, e.Method, e.Params)
			case codexapp.EvDisconnected, codexapp.EvClosed, codexapp.EvFailed:
				b.src.Lost(b.root)
			}
		}})
	if err != nil {
		b.f.t.Fatal(err)
	}
	b.w = w
	b.waitJoin()
}

func (b *cbridge) waitJoin() {
	b.f.t.Helper()
	select {
	case <-b.joins:
	case <-time.After(30 * time.Second):
		b.f.t.Fatal("the bridge never joined the root thread")
	}
}

func (b *cbridge) stop() {
	if b.w != nil {
		b.w.Close()
	}
	b.cancel()
	b.l.Close()
}

func (b *cbridge) rows() []proto.Child {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.reg.Children("w")
}

// row waits until the child's row satisfies ok.
func (b *cbridge) row(native, what string, ok func(proto.Child) bool) proto.Child {
	b.f.t.Helper()
	deadline := time.Now().Add(45 * time.Second)
	for {
		for _, c := range b.rows() {
			if c.NativeID == native && ok(c) {
				return c
			}
		}
		if time.Now().After(deadline) {
			b.f.t.Fatalf("%s: child %s never %s; rows %+v", b.f.t.Name(), native, what, b.rows())
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (b *cbridge) state(native, state string) proto.Child {
	b.f.t.Helper()
	return b.row(native, state, func(c proto.Child) bool { return c.State == state })
}

// states are the states the evidence gave a child, in order, repeats
// dropped.
func (b *cbridge) states(native string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, e := range b.evs {
		if e.NativeID == native && e.State != "" && (len(out) == 0 || out[len(out)-1] != e.State) {
			out = append(out, e.State)
		}
	}
	return out
}

// spawned waits for the parent's subAgentActivity started for a task on c
// and returns the child's thread id and the spawn call's id.
func (f *hfx) spawned(c *Client, from int, task string) (string, string) {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 30*time.Second)
	defer cancel()
	m, err := c.WaitNotificationFrom(ctx, from, "item/completed", func(m Message) bool {
		var n codexapp.ChildNote
		_ = json.Unmarshal(m.Params, &n)
		return n.Item.Type == codexapp.ItemSubAgentActivity && n.Item.Kind == codexapp.ActivityStarted && strings.HasSuffix(n.Item.AgentPath, "/"+task)
	})
	if err != nil {
		f.t.Fatal(err)
	}
	n, _ := codexapp.DecodeChildNote(m.Params)
	return n.Item.AgentThreadID, n.Item.ID
}

// rootThread starts the terminal's thread on the driver with a first turn
// (a thread has no rollout to join before it).
func (f *hfx) rootThread(d *Client) string {
	f.t.Helper()
	th := f.startThread(d)
	turn := f.turn(d, th, "MOCK:say hello")
	f.waitTurn(d, th, turn)
	return th
}

// waitTurn waits for thread's turn to complete on c.
func (f *hfx) waitTurn(c *Client, thread, turn string) {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(f.ctx, 60*time.Second)
	defer cancel()
	if _, err := c.WaitNotification(ctx, "turn/completed", func(m Message) bool {
		var p struct {
			ThreadID string `json:"threadId"`
			Turn     struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(m.Params, &p)
		return p.ThreadID == thread && p.Turn.ID == turn
	}); err != nil {
		f.t.Fatal(err)
	}
}

// childSettings is a thread's model and effort, as thread/read shows them.
func (f *hfx) childSettings(c *Client, id string) string {
	f.t.Helper()
	var res struct {
		Thread struct {
			Model  string `json:"model"`
			Effort string `json:"reasoningEffort"`
			Status struct {
				Type string `json:"type"`
			} `json:"status"`
		} `json:"thread"`
	}
	if err := c.Call(f.ctx, "thread/read", map[string]any{"threadId": id}, &res); err != nil {
		f.t.Fatal(err)
	}
	return res.Thread.Model + "/" + res.Thread.Effort
}

// goalCleared counts thread/goal/cleared notifications of thread on c: a
// thread/resume of it emits one to its subscribers (the live probe).
func goalCleared(c *Client, thread string) int {
	n := 0
	for _, m := range c.Notifications("thread/goal/cleared") {
		if m.Param("threadId") == thread {
			n++
		}
	}
	return n
}

// TestCodexShareChildren: spawn, wait, follow-up, message, interrupt and a
// nested spawn resolve to their own child threads, live, from a join of
// the parent alone; two children stay apart; the parent-subscription scope
// (a connection initialized before a spawn gets the child's own events, one
// joined after it only the broadcasts and the parent's items); no read of
// the bridge starts a turn, resumes a child or changes its settings.
func TestCodexShareChildren(t *testing.T) {
	f := newHeadless(t)
	d := f.client("terminal")
	root := f.rootThread(d)
	b := f.newBridge(f.sock, root, false)
	early := f.client("early")
	if err := early.Call(f.ctx, "thread/resume", map[string]any{"threadId": root, "excludeTurns": true}, nil); err != nil {
		t.Fatal(err)
	}

	// Spawn: a child held at its first model request (running).
	from := d.Mark()
	turn := f.turn(d, root, "MOCK:spawn alpha MOCK:hold a1")
	alpha, call := f.spawned(d, from, "alpha")
	if err := f.mock.WaitHeld(f.ctx, "a1"); err != nil {
		t.Fatal(err)
	}
	f.waitTurn(d, root, turn) // the parent's turn ends; the child runs on
	c := b.state(alpha, proto.ChildRunning)
	if c.Source != proto.ChildFromAppServer || c.Parent != proto.ParentRoot || c.Description != "alpha" || c.Name == "" {
		t.Fatalf("spawned: %+v", c)
	}
	b.mu.Lock()
	dispatched := slices.ContainsFunc(b.evs, func(e childagents.Evidence) bool { return e.NativeID == alpha && e.DispatchID == call })
	b.mu.Unlock()
	if !dispatched {
		t.Errorf("no evidence names the spawn call %s", call)
	}
	settings := f.childSettings(d, alpha)

	// A late connection joined to the parent after the spawn: the child's
	// status (a broadcast) and the parent's items, never the child's turns.
	late := f.client("late")
	if err := late.Call(f.ctx, "thread/resume", map[string]any{"threadId": root, "excludeTurns": true}, nil); err != nil {
		t.Fatal(err)
	}

	// A wait that times out completes; the child is still running.
	turn = f.turn(d, root, "MOCK:wait 300")
	f.waitTurn(d, root, turn)
	time.Sleep(time.Second)
	if c := b.row(alpha, "running", func(proto.Child) bool { return true }); c.State != proto.ChildRunning {
		t.Fatalf("a timed-out wait ended the child: %+v", c)
	}

	// Two concurrent children stay apart.
	from = d.Mark()
	turn = f.turn(d, root, "MOCK:spawn beta MOCK:hold b1")
	beta, _ := f.spawned(d, from, "beta")
	f.waitTurn(d, root, turn)
	b.state(beta, proto.ChildRunning)
	if beta == alpha {
		t.Fatal("one thread for two children")
	}

	// alpha completes: its row only.
	if err := f.mock.Release("a1"); err != nil {
		t.Fatal(err)
	}
	b.state(alpha, proto.ChildCompleted)
	if c := b.row(beta, "still running", func(proto.Child) bool { return true }); c.State != proto.ChildRunning {
		t.Fatalf("beta: %+v", c)
	}
	if !slices.ContainsFunc(late.Notifications("thread/status/changed"), func(m Message) bool { return m.Param("threadId") == alpha }) {
		t.Error("the late connection got no status of the child")
	}
	for _, m := range late.Notifications("turn/completed") {
		if m.Param("threadId") == alpha {
			t.Error("the late connection got the child's own turn/completed: it is subscribed to it")
		}
	}
	if !slices.ContainsFunc(early.Notifications("turn/completed"), func(m Message) bool { return m.Param("threadId") == alpha }) {
		t.Error("the early connection did not get the child's own turn/completed")
	}

	// A follow-up: the same row runs again, then completes.
	turn = f.turn(d, root, "MOCK:followup alpha MOCK:hold a2")
	if err := f.mock.WaitHeld(f.ctx, "a2"); err != nil {
		t.Fatal(err)
	}
	f.waitTurn(d, root, turn)
	if c := b.state(alpha, proto.ChildRunning); c.EndedAt != 0 {
		t.Fatalf("follow-up: %+v", c)
	}
	_ = f.mock.Release("a2")
	b.state(alpha, proto.ChildCompleted)

	// A message to an idle child: the same row, never a new one.
	turn = f.turn(d, root, "MOCK:message alpha MOCK:say queued")
	f.waitTurn(d, root, turn)

	// interrupt_agent: beta interrupted.
	turn = f.turn(d, root, "MOCK:interrupt beta")
	f.waitTurn(d, root, turn)
	b.state(beta, proto.ChildInterrupted)

	// A nested spawn: alpha's own child attaches to alpha.
	from = d.Mark()
	turn = f.turn(d, root, "MOCK:followup alpha MOCK:spawn inner MOCK:hold n1")
	f.waitTurn(d, root, turn)
	if err := f.mock.WaitHeld(f.ctx, "n1"); err != nil {
		t.Fatal(err)
	}
	var inner string
	deadline := time.Now().Add(30 * time.Second)
	for inner == "" && time.Now().Before(deadline) {
		for _, r := range b.rows() {
			if r.Description == "inner" {
				inner = r.NativeID
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if inner == "" {
		t.Fatalf("no nested row: %+v", b.rows())
	}
	ar := b.row(alpha, "known", func(proto.Child) bool { return true })
	b.row(inner, "under alpha", func(c proto.Child) bool { return c.Parent == proto.ParentChild && c.ParentID == ar.ID })
	_ = f.mock.Release("n1")
	b.state(inner, proto.ChildCompleted)

	if n := len(b.rows()); n != 3 {
		t.Errorf("%d rows, want alpha, beta, inner: %+v", n, b.rows())
	}
	for _, id := range []string{alpha, beta, inner} {
		if n := goalCleared(d, id); n != 0 {
			t.Errorf("child %s was resumed (%d thread/goal/cleared)", id, n)
		}
		t.Logf("%s states %v", id, b.states(id))
	}
	if s := f.childSettings(d, alpha); s != settings {
		t.Errorf("alpha's settings %s, were %s", s, settings)
	}
	f.dump("terminal", d)
	f.dump("late", late)
}

// TestCodexShareChildrenNoExtraTurns: the bridge's joins and recoveries
// (with children running, completed and not loaded) make no model request
// and start no turn: the mock's requests are the terminal's alone.
func TestCodexShareChildrenNoExtraTurns(t *testing.T) {
	f := newHeadless(t)
	d := f.client("terminal")
	root := f.rootThread(d)
	from := d.Mark()
	turn := f.turn(d, root, "MOCK:spawn done MOCK:say finished")
	done, _ := f.spawned(d, from, "done")
	f.waitTurn(d, root, turn)
	from = d.Mark()
	turn = f.turn(d, root, "MOCK:spawn held MOCK:hold h1")
	held, _ := f.spawned(d, from, "held")
	f.waitTurn(d, root, turn)
	if err := f.mock.WaitHeld(f.ctx, "h1"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Second)
	before := f.mock.ModelRequests()
	settings := f.childSettings(d, held)
	turns := len(d.Notifications("turn/started"))
	for range 3 {
		b := f.newBridge(f.sock, root, false)
		b.state(held, proto.ChildRunning)
		b.row(done, "completed", func(c proto.Child) bool { return c.State == proto.ChildCompleted })
		b.stop()
	}
	time.Sleep(time.Second)
	if n := f.mock.ModelRequests(); n != before {
		t.Errorf("model requests %d, were %d: %+v", n, before, f.mock.Requests()[before:])
	}
	if n := len(d.Notifications("turn/started")); n != turns {
		t.Errorf("turns started %d, were %d", n, turns)
	}
	if s := f.childSettings(d, held); s != settings {
		t.Errorf("settings %s, were %s", s, settings)
	}
	for _, id := range []string{done, held} {
		if n := goalCleared(d, id); n != 0 {
			t.Errorf("child %s was resumed", id)
		}
	}
	_ = f.mock.Release("h1")
}

// TestCodexShareChildrenStableAPI: a connection without the experimental
// capability is refused thread/list's ancestorThreadId; joined after the
// spawn, the bridge still recovers the live child (the loaded threads) and
// follows it to its end.
func TestCodexShareChildrenStableAPI(t *testing.T) {
	f := newHeadless(t)
	d := f.client("terminal")
	root := f.rootThread(d)
	stable, err := Dial(f.ctx, f.sock)
	if err != nil {
		t.Fatal(err)
	}
	defer stable.Close()
	if err := stable.Call(f.ctx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "stable", "version": "0"},
		"capabilities": map[string]any{"experimentalApi": false}}, nil); err != nil {
		t.Fatal(err)
	}
	_ = stable.Notify(f.ctx, "initialized", nil)
	err = stable.Call(f.ctx, "thread/list", map[string]any{"ancestorThreadId": root}, nil)
	if err == nil || !strings.Contains(err.Error(), "requires experimentalApi capability") {
		t.Fatalf("not refused: %v", err)
	}
	t.Logf("refused: %v", err)
	from := d.Mark()
	turn := f.turn(d, root, "MOCK:spawn solo MOCK:hold s1")
	solo, _ := f.spawned(d, from, "solo")
	f.waitTurn(d, root, turn)
	b := f.newBridge(f.sock, root, true)
	ctx, cancel := context.WithTimeout(f.ctx, 10*time.Second)
	defer cancel()
	if d, err := b.w.Descendants(ctx, root); err != nil || d.Filtered || !slices.ContainsFunc(d.Threads, func(th codexapp.Thread) bool { return th.ID == solo }) {
		t.Fatalf("descendants without the filter: %+v, %v", d, err)
	}
	c := b.state(solo, proto.ChildRunning)
	if c.Parent != proto.ParentRoot {
		t.Fatalf("%+v", c)
	}
	_ = f.mock.Release("s1")
	b.state(solo, proto.ChildCompleted)
}

// TestCodexShareChildrenReconnect: the bridge's connection is cut while a
// child runs: its row is unknown until the watcher's own rejoin recovers
// it (running again, the same row), and it is followed to its end. Then a
// bridge restart (a new source, registry and reader) rebuilds it.
func TestCodexShareChildrenReconnect(t *testing.T) {
	f := newHeadless(t)
	d := f.client("terminal")
	root := f.rootThread(d)
	px := newProxy(t, filepath.Join(f.root, "p.sock"), f.sock)
	b := f.newBridge(filepath.Join(f.root, "p.sock"), root, false)
	from := d.Mark()
	turn := f.turn(d, root, "MOCK:spawn long MOCK:hold l1")
	long, _ := f.spawned(d, from, "long")
	f.waitTurn(d, root, turn)
	row := b.state(long, proto.ChildRunning)
	px.cut()
	b.state(long, proto.ChildUnknown)
	b.waitJoin()
	if c := b.state(long, proto.ChildRunning); c.ID != row.ID {
		t.Fatalf("another row: %+v", c)
	}
	if got := b.states(long); !slices.Equal(got[len(got)-3:], []string{proto.ChildRunning, proto.ChildUnknown, proto.ChildRunning}) {
		t.Errorf("states %v", got)
	}
	_ = f.mock.Release("l1")
	b.state(long, proto.ChildCompleted)

	b.stop()
	b2 := f.newBridge(f.sock, root, false)
	c := b2.state(long, proto.ChildCompleted)
	if c.ID != row.ID || c.Transcript != proto.TranscriptAvailable {
		t.Fatalf("after a restart: %+v (was %+v)", c, row)
	}
}

// TestCodexShareChildrenServerLoss: the server is killed (SIGKILL) while a
// child runs: no running claim survives (unknown), and after a restart the
// child is not loaded and its rollout has no end: unknown, never running.
func TestCodexShareChildrenServerLoss(t *testing.T) {
	f := newHeadless(t)
	d := f.client("terminal")
	root := f.rootThread(d)
	from := d.Mark()
	turn := f.turn(d, root, "MOCK:spawn doomed MOCK:hold k1")
	doomed, _ := f.spawned(d, from, "doomed")
	f.waitTurn(d, root, turn)
	if err := f.mock.WaitHeld(f.ctx, "k1"); err != nil {
		t.Fatal(err)
	}
	b := f.newBridge(f.sock, root, false)
	b.state(doomed, proto.ChildRunning)
	time.Sleep(time.Second) // the child's rollout read
	f.stopServer(syscall.SIGKILL)
	b.state(doomed, proto.ChildUnknown)
	f.startServer()
	b.waitJoin()
	time.Sleep(2 * time.Second) // recovery, and the rollouts polled again
	c := b.row(doomed, "unknown", func(proto.Child) bool { return true })
	got := b.states(doomed)
	t.Logf("states %v", got)
	if i := slices.Index(got, proto.ChildUnknown); i < 0 || slices.Contains(got[i:], proto.ChildRunning) {
		t.Errorf("a running claim after the loss: %v", got)
	}
	if c.State != proto.ChildUnknown || c.Source != proto.ChildFromAppServer {
		t.Fatalf("after the restart: %+v (states %v)", c, b.states(doomed))
	}
	// A fresh bridge after the restart: the same.
	b.stop()
	b2 := f.newBridge(f.sock, root, false)
	time.Sleep(2 * time.Second)
	if c := b2.row(doomed, "known", func(proto.Child) bool { return true }); c.State != proto.ChildUnknown {
		t.Fatalf("a fresh bridge: %+v (states %v)", c, b2.states(doomed))
	}
}

// TestCodexShareChildrenEphemeral records what an ephemeral child is on
// the real server. A child inherits ephemeral from its spawner's config, so
// a shared worker's persistent thread never has one (asserted); an
// ephemeral thread's child is ephemeral itself: not listed, no turns to
// read, refused a resume (the bridge never resumes one anyway), its
// metadata readable while loaded. The bridge's side of one is
// codexchild's TestServerEphemeralChild (the watcher refuses an ephemeral
// root, so no join of such a tree exists).
func TestCodexShareChildrenEphemeral(t *testing.T) {
	f := newHeadless(t)
	d := f.client("terminal")
	root := f.rootThread(d)
	from := d.Mark()
	turn := f.turn(d, root, "MOCK:spawn kept MOCK:say ok")
	kept, _ := f.spawned(d, from, "kept")
	f.waitTurn(d, root, turn)
	var res struct {
		Thread codexapp.Thread `json:"thread"`
	}
	if err := d.Call(f.ctx, "thread/read", map[string]any{"threadId": kept}, &res); err != nil || res.Thread.Ephemeral {
		t.Fatalf("a persistent thread's child: %+v, %v", res.Thread, err)
	}

	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := d.Call(f.ctx, "thread/start", map[string]any{"cwd": f.ws, "ephemeral": true}, &started); err != nil {
		t.Fatal(err)
	}
	eroot := started.Thread.ID
	from = d.Mark()
	turn = f.turn(d, eroot, "MOCK:spawn eph MOCK:hold e1")
	eph, _ := f.spawned(d, from, "eph")
	f.waitTurn(d, eroot, turn)
	if err := f.mock.WaitHeld(f.ctx, "e1"); err != nil {
		t.Fatal(err)
	}
	if err := d.Call(f.ctx, "thread/read", map[string]any{"threadId": eph}, &res); err != nil {
		t.Fatal(err)
	}
	t.Logf("ephemeral root's child: ephemeral=%v parent=%s status=%s", res.Thread.Ephemeral, res.Thread.ParentID(), res.Thread.Status.Type)
	if !res.Thread.Ephemeral || res.Thread.ParentID() != eroot {
		t.Fatalf("%+v", res.Thread)
	}
	var page struct {
		Data []codexapp.Thread `json:"data"`
	}
	if err := d.Call(f.ctx, "thread/list", map[string]any{"ancestorThreadId": eroot}, &page); err == nil && len(page.Data) != 0 {
		t.Errorf("an ephemeral child listed: %+v", page.Data)
	}
	errTurns := d.Call(f.ctx, "thread/turns/list", map[string]any{"threadId": eph, "limit": 1, "itemsView": "notLoaded"}, nil)
	errResume := f.client("late").Call(f.ctx, "thread/resume", map[string]any{"threadId": eph, "excludeTurns": true}, nil)
	t.Logf("turns/list: %v; resume from another connection: %v", errTurns, errResume)
	if errTurns == nil || errResume == nil {
		t.Error("thread/turns/list or thread/resume of an ephemeral child answered")
	}
	_ = f.mock.Release("e1")
}
