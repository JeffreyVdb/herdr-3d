//go:build integration

package codexshare

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/app"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #158: the full stack. herdr-world itself (app.Serve: the hub, its
// herdr.Control, its CodexHost) aimed at the fixture's throwaway Herdr
// session, driven through its own WebSocket protocol as the game drives it,
// against the real Codex TUI and mock inference. The evidence is the
// bridge's acks, events and worker.codex view, the TUI's screen and the
// mock's classified requests.
//
// The fixture's workspaces for these suites are "bare-*": no .envrc. The
// bridge's preflight runs `direnv status` with the bridge's own
// environment, whose allow list is the user's, not the fixture's.

// fixtureSystemdRun stands in for systemd-run in the bridge's Control: a
// floor wake starts the session through it. The fixture starts its own
// session server instead (the same herdr, the same session name, the
// fixture's pinned environment), so a woken pane keeps the throwaway
// CODEX_HOME and owner marker instead of a login environment's ~/.codex.
const fixtureSystemdRun = "h3d-fixture-systemd-run"

// bridgeOptions are what a suite changes in the bridge.
type bridgeOptions struct {
	codexCLI string   // the codex the preflight and the command catalog run ("": "codex", herdr-world's default)
	sessions string   // the Codex rollout directory ("": the fixture's CODEX_HOME/sessions)
	db       string   // the store ("": a new one under the fixture's root)
	models   []string // Codex models hire accepts besides herdr-world's own list ("mock" always)
}

// bridge is one herdr-world run aimed at the fixture's session.
type bridge struct {
	f      *fx
	o      bridgeOptions
	run    string // --codex-run
	sock   string
	cancel context.CancelFunc
	served chan error
	ctl    *herdr.Control
}

// startBridge serves herdr-world on a socket under the fixture's root.
func (f *fx) startBridge(o bridgeOptions) *bridge {
	f.t.Helper()
	if o.db == "" {
		o.db = filepath.Join(f.root, "world.db")
	}
	if o.sessions == "" {
		o.sessions = filepath.Join(f.home, "sessions")
	}
	if o.codexCLI == "" {
		o.codexCLI = "codex"
	}
	if f.home != "" {
		// What herdr-world runs itself (the preflight's `codex --version`,
		// the command catalog's `codex app-server` over stdio, which #138's
		// prompt translation asks for a text with a "/") runs in its own
		// environment: the fixture's CODEX_HOME, never ~/.codex.
		f.t.Setenv("CODEX_HOME", f.home)
	}
	b := &bridge{f: f, o: o, run: filepath.Join(f.root, "run"), sock: filepath.Join(f.root, "bridge", "w.sock")}
	b.start()
	f.t.Cleanup(func() {
		b.stop()
		if f.t.Failed() {
			log, _ := os.ReadFile(filepath.Join(f.root, "bridge.log"))
			if len(log) > 64<<10 {
				log = log[len(log)-64<<10:]
			}
			f.t.Logf("herdr-world's log (tail):\n%s", log)
		}
	})
	return b
}

func (b *bridge) start() {
	f := b.f
	f.t.Helper()
	only := regexp.MustCompile("^" + regexp.QuoteMeta(f.h.Name) + "$")
	b.ctl = &herdr.Control{Herdr: f.h.Bin, SystemdRun: fixtureSystemdRun, Only: only, CodexRun: b.run, Run: b.runner()}
	opts := server.HireOptions()
	opts.Codex.Models = append(append(opts.Codex.Models, "mock"), b.o.models...)
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	logf, err := os.OpenFile(filepath.Join(f.root, "bridge.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		f.t.Fatal(err)
	}
	go func() {
		defer logf.Close()
		served <- app.Serve(ctx, app.ServeConfig{
			Socket: b.sock, DB: b.o.db, Herdr: &herdr.Client{Bin: f.h.Bin}, Only: only,
			Log:  slog.New(slog.NewTextHandler(logf, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: b.ctl, Git: &gitops.Git{}, CodexRun: b.run, ClaudeCLI: "claude", CodexCLI: b.o.codexCLI, CodexSessions: b.o.sessions,
			Caps: server.Caps{FloorSoft: 10, FloorHard: 20, HostSoft: 100, HostHard: 200}, HireOptions: &opts,
			ExitTimeout: 10 * time.Second,
		})
	}()
	select {
	case <-ready:
	case err := <-served:
		f.t.Fatalf("herdr-world did not start: %v", err)
	case <-time.After(30 * time.Second):
		f.t.Fatal("herdr-world did not start within 30 s")
	}
	b.cancel, b.served = cancel, served
}

// stop ends herdr-world (the bridge going away; its workers' servers and
// terminals are theirs).
func (b *bridge) stop() {
	if b.cancel == nil {
		return
	}
	b.cancel()
	if err := <-b.served; err != nil {
		b.f.t.Errorf("herdr-world: %v", err)
	}
	b.cancel = nil
}

// restart stops herdr-world and serves it again on the same store.
func (b *bridge) restart() {
	b.f.t.Helper()
	b.stop()
	b.start()
}

// runner is the bridge's Control runner: herdr's commands as the bridge
// runs them, except the session start (fixtureSystemdRun).
func (b *bridge) runner() herdr.Runner {
	return func(ctx context.Context, argv []string) ([]byte, []byte, error) {
		if argv[0] == fixtureSystemdRun {
			if !slices.Contains(argv, "exec herdr --session '"+b.f.h.Name+"' server") {
				return nil, nil, fmt.Errorf("fixture: unexpected session start %q", argv)
			}
			return nil, nil, b.f.h.start(ctx)
		}
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		cmd.Env = herdr.CleanEnv(os.Environ())
		var out, errb strings.Builder
		cmd.Stdout, cmd.Stderr = &out, &errb
		err := cmd.Run()
		return []byte(out.String()), []byte(errb.String()), err
	}
}

// bclient is one protocol client of the bridge (a game).
type bclient struct {
	t    *testing.T
	f    *fx
	name string
	conn *proto.Conn
	ctx  context.Context
	stop context.CancelFunc

	mu      sync.Mutex
	workers map[string]proto.Worker
	floors  map[string]proto.Floor
	server  *proto.CodexServer
	events  []string // every event's type and worker, for evidence
	replies map[string]chan []byte
	changed chan struct{}
	closed  bool
	n       int
}

// dial connects a client and waits for its snapshot.
func (b *bridge) dial(name string) *bclient {
	f := b.f
	f.t.Helper()
	ctx, cancel := context.WithCancel(f.ctx)
	dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := proto.Dial(dctx, b.sock)
	dcancel()
	if err != nil {
		cancel()
		f.t.Fatal(err)
	}
	c := &bclient{t: f.t, f: f, name: name, conn: conn, ctx: ctx, stop: cancel, workers: map[string]proto.Worker{},
		floors: map[string]proto.Floor{}, replies: map[string]chan []byte{}, changed: make(chan struct{})}
	if _, err := conn.Hello(ctx, proto.Hello{Client: name}); err != nil {
		cancel()
		f.t.Fatal(err)
	}
	go c.read()
	f.t.Cleanup(c.close)
	c.wait("the snapshot", 15*time.Second, func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.server != nil
	})
	return c
}

// close drops the connection without a goodbye (a game tab going away).
func (c *bclient) close() {
	c.stop()
	_ = c.conn.CloseNow()
}

func (c *bclient) read() {
	defer func() {
		c.mu.Lock()
		c.closed = true
		c.notifyLocked()
		c.mu.Unlock()
	}()
	for {
		env, raw, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		c.mu.Lock()
		switch env.T {
		case proto.TAck, proto.TError:
			if ch := c.replies[env.ReqID]; ch != nil {
				ch <- raw
				delete(c.replies, env.ReqID)
			}
		case proto.TSnapshot:
			var s proto.Snapshot
			if json.Unmarshal(raw, &s) == nil {
				clear(c.workers)
				for _, w := range s.World.Workers {
					c.workers[w.ID] = w
				}
				for _, fl := range s.World.Floors {
					c.floors[fl.Session] = fl
				}
				c.server = s.World.CodexServer
				if c.server == nil {
					c.server = &proto.CodexServer{}
				}
			}
		case proto.EvCodexServerUpdate:
			var u proto.CodexServerUpdate
			if json.Unmarshal(raw, &u) == nil {
				c.server = &u.CodexServer
			}
		default:
			var ev proto.Event
			if json.Unmarshal(raw, &ev) != nil {
				break
			}
			switch ev.T {
			case proto.EvWorkerUpsert:
				c.workers[ev.Worker.ID] = *ev.Worker
				c.events = append(c.events, ev.T+" "+ev.Worker.ID)
			case proto.EvWorkerStatus:
				if w, ok := c.workers[ev.ID]; ok {
					w.Status = ev.Status
					c.workers[ev.ID] = w
				}
				c.events = append(c.events, ev.T+" "+ev.ID+" "+ev.PrevStatus+"→"+ev.Status)
			case proto.EvWorkerRemoved:
				delete(c.workers, ev.ID)
				c.events = append(c.events, ev.T+" "+ev.ID+" "+ev.Reason)
			case proto.EvFloorUpsert:
				c.floors[ev.Floor.Session] = *ev.Floor
			}
		}
		c.notifyLocked()
		c.mu.Unlock()
	}
}

func (c *bclient) notifyLocked() {
	close(c.changed)
	c.changed = make(chan struct{})
}

// wait waits until ok (called with nothing locked) holds.
func (c *bclient) wait(what string, d time.Duration, ok func() bool) {
	c.t.Helper()
	deadline := time.After(d)
	for {
		c.mu.Lock()
		ch, closed := c.changed, c.closed
		c.mu.Unlock()
		if ok() {
			return
		}
		if closed {
			c.t.Fatalf("%s: connection closed waiting for %s", c.name, what)
		}
		select {
		case <-ch:
		case <-time.After(250 * time.Millisecond):
		case <-deadline:
			c.t.Fatalf("%s: no %s within %s", c.name, what, d)
		}
	}
}

// worker is the latest view of a worker (false: none).
func (c *bclient) worker(id string) (proto.Worker, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w, ok := c.workers[id]
	return w, ok
}

// waitWorker waits until the worker's view satisfies ok and returns it.
func (c *bclient) waitWorker(what, id string, d time.Duration, ok func(proto.Worker) bool) proto.Worker {
	c.t.Helper()
	var got proto.Worker
	c.wait(what, d, func() bool {
		w, found := c.worker(id)
		got = w
		return found && ok(w)
	})
	return got
}

// codexServer is the switch as the client last heard it.
func (c *bclient) codexServer() proto.CodexServer {
	c.mu.Lock()
	defer c.mu.Unlock()
	return *c.server
}

// floor is the latest view of a floor.
func (c *bclient) floor(session string) proto.Floor {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.floors[session]
}

// eventLog lists the events so far.
func (c *bclient) eventLog() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.events)
}

// send sends a command and returns its ack or error, raw.
func (c *bclient) send(typ string, args any, within time.Duration) []byte {
	c.t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		c.t.Fatal(err)
	}
	c.mu.Lock()
	c.n++
	id := c.name + "-" + typ + "-" + strconv.Itoa(c.n)
	ch := make(chan []byte, 1)
	c.replies[id] = ch
	c.mu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	err = c.conn.Send(ctx, proto.Command{T: typ, ReqID: id, Args: raw})
	cancel()
	if err != nil {
		c.t.Fatalf("%s: sending %s: %v", c.name, typ, err)
	}
	select {
	case r := <-ch:
		return r
	case <-time.After(within):
		c.t.Fatalf("%s: no reply to %s within %s", c.name, typ, within)
	}
	return nil
}

// ack sends a command that must succeed, decodes its data into data (if
// not nil) and returns the raw ack.
func (c *bclient) ack(typ string, args any, within time.Duration, data any) []byte {
	c.t.Helper()
	raw := c.send(typ, args, within)
	var a struct {
		T    string          `json:"t"`
		Data json.RawMessage `json:"data"`
	}
	if json.Unmarshal(raw, &a) != nil || a.T != proto.TAck {
		c.t.Fatalf("%s: %s", typ, raw)
	}
	if data != nil && json.Unmarshal(a.Data, data) != nil {
		c.t.Fatalf("%s: bad ack %s", typ, raw)
	}
	return raw
}

// refused sends a command that must fail with code.
func (c *bclient) refused(typ string, args any, code string) proto.Error {
	c.t.Helper()
	raw := c.send(typ, args, 60*time.Second)
	var e proto.Error
	if json.Unmarshal(raw, &e) != nil || e.T != proto.TError || e.Code != code {
		c.t.Fatalf("%s: got %s, want error %s", typ, raw, code)
	}
	return e
}

// setShared turns the Codex workers switch on or off (Settings → Codex
// workers).
func (c *bclient) setShared(on bool) []byte {
	c.t.Helper()
	var got proto.CodexServer
	raw := c.ack(proto.CmdCodexServerSet, proto.CodexServerSetArgs{Enabled: &on}, 10*time.Second, &got)
	if got.Enabled != on || !got.Available {
		c.t.Fatalf("codex_server.set %v: %s", on, raw)
	}
	return raw
}

// hired is a worker the bridge hired.
type hired struct {
	id, name, pane, cwd string
	res                 proto.HireResult
}

// hire hires a Codex worker (mock model) into the bare workspace ws at
// desk, answers Codex's hooks review as the player would (the bridge leaves
// it), and waits until herdr reports it idle.
func (c *bclient) hire(label, ws string, desk int) *hired {
	f := c.f
	c.t.Helper()
	h := &hired{cwd: filepath.Join(f.root, ws)}
	raw := c.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: f.h.Name, DeskIndex: &desk, Harness: "codex", Model: "mock",
		Effort: "low", Cwd: h.cwd}, 120*time.Second, &h.res)
	f.record(label+"-hire-ack.json", string(raw))
	h.id, h.pane = h.res.ID, h.res.WorkspaceID+":p1"
	w := c.waitWorker(label+" at its desk", h.id, 30*time.Second, func(w proto.Worker) bool { return w.AgentName != "" })
	h.name = w.AgentName
	f.trustHooks(label, h.pane, h.pane) // herdr takes a pane as an agent target
	f.settle(h.pane)
	return h
}

// settle waits until herdr and then the bridge (which polls herdr) see the
// worker idle or done.
func (c *bclient) settle(h *hired) {
	c.t.Helper()
	c.f.settle(h.pane)
	c.waitWorker("idle", h.id, 15*time.Second, func(w proto.Worker) bool { return w.Status == "idle" || w.Status == "done" })
}

// view records the worker's codex view and returns it.
func (c *bclient) view(label, id string) proto.WorkerCodex {
	c.t.Helper()
	w, ok := c.worker(id)
	if !ok || w.Codex == nil {
		c.f.recordJSON(label, w)
		c.t.Fatalf("%s: worker %s has no codex view", label, id)
	}
	c.f.recordJSON(label, struct {
		Status string            `json:"status"`
		Codex  proto.WorkerCodex `json:"codex"`
	}{w.Status, *w.Codex})
	return *w.Codex
}

// attached waits until the bridge has joined the worker's thread.
func (c *bclient) attached(label, id string) proto.WorkerCodex {
	c.t.Helper()
	w := c.waitWorker(label, id, 60*time.Second, func(w proto.Worker) bool {
		return w.Codex != nil && w.Codex.Attached && w.Codex.Thread != ""
	})
	return *w.Codex
}

// batchWith waits for a batch of the worker's thread that is not in seen
// and has n questions, and returns it.
func (c *bclient) batchWith(label, id string, n int, seen ...string) proto.CodexBatch {
	c.t.Helper()
	var got proto.CodexBatch
	c.waitWorker(label, id, 60*time.Second, func(w proto.Worker) bool {
		if w.Codex == nil {
			return false
		}
		for _, b := range w.Codex.Questions {
			if len(b.Questions) == n && !slices.Contains(seen, b.Batch) {
				got = b
				return true
			}
		}
		return false
	})
	c.view(label, id)
	return got
}

// question is the worker's view of one question.
func (c *bclient) question(id, batch string, index int) proto.CodexQuestion {
	w, _ := c.worker(id)
	if w.Codex != nil {
		for _, b := range w.Codex.Questions {
			if b.Batch == batch && index < len(b.Questions) {
				return b.Questions[index]
			}
		}
	}
	return proto.CodexQuestion{State: "absent"}
}

// waitQuestion waits until a question satisfies ok.
func (c *bclient) waitQuestion(label, id, batch string, index int, d time.Duration, ok func(proto.CodexQuestion) bool) proto.CodexQuestion {
	c.t.Helper()
	var q proto.CodexQuestion
	c.wait(label, d, func() bool {
		q = c.question(id, batch, index)
		return ok(q)
	})
	c.view(label, id)
	return q
}

// answer sends worker.answer_async for one question and returns the raw
// reply (ack or error).
func (c *bclient) answer(id, thread, batch string, index int, text string) []byte {
	c.t.Helper()
	return c.send(proto.CmdWorkerAnswerAsync, proto.WorkerAnswerAsyncArgs{ID: id, Thread: thread, Batch: batch,
		Answers: []proto.AsyncAnswerArg{{Index: &index, Answer: text}}}, 60*time.Second)
}

// prompt sends worker.prompt and returns the ack's data.
func (c *bclient) prompt(label, id, text string) proto.PromptResult {
	c.t.Helper()
	var res proto.PromptResult
	raw := c.ack(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: text}, 60*time.Second, &res)
	c.f.record(label+"-prompt-ack.json", string(raw))
	return res
}

// keys sends worker.keys, each item a key name or (prefixed "text:") text.
func (c *bclient) keys(id string, items ...string) {
	c.t.Helper()
	var in []proto.InputItem
	for _, it := range items {
		if text, ok := strings.CutPrefix(it, "text:"); ok {
			in = append(in, proto.InputItem{Text: &text})
		} else {
			key := it
			in = append(in, proto.InputItem{Key: &key})
		}
	}
	c.ack(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: id, Input: in}, 30*time.Second, nil)
}

// isAck reports whether a raw reply is an ack.
func isAck(raw []byte) bool {
	var env proto.Envelope
	return json.Unmarshal(raw, &env) == nil && env.T == proto.TAck
}

// errCode is a raw reply's error code ("" for an ack).
func errCode(raw []byte) string {
	var e proto.Error
	if json.Unmarshal(raw, &e) != nil || e.T != proto.TError {
		return ""
	}
	return e.Code
}

// launchOf is the worker's launch as the bridge stored it (read from the
// store while the bridge runs; ok false when it has none).
func (b *bridge) launchOf(id string) (store.CodexLaunch, bool) {
	b.f.t.Helper()
	st, err := store.Open(b.f.ctx, b.o.db)
	if err != nil {
		b.f.t.Fatal(err)
	}
	defer st.Close()
	all, err := st.CodexLaunches(b.f.ctx)
	if err != nil {
		b.f.t.Fatal(err)
	}
	l, ok := all[id]
	return l, ok
}

// audit records the audit rows of cmds (their steps and notes) from index
// from, and returns how many rows there are.
func (b *bridge) audit(label string, from int, cmds ...string) int {
	b.f.t.Helper()
	st, err := store.Open(b.f.ctx, b.o.db)
	if err != nil {
		b.f.t.Fatal(err)
	}
	defer st.Close()
	rows, err := st.AuditLog(b.f.ctx)
	if err != nil {
		b.f.t.Fatal(err)
	}
	var out []string
	for _, e := range rows[min(from, len(rows)):] {
		if slices.Contains(cmds, e.Cmd) {
			out = append(out, fmt.Sprintf("%s ok=%v %s %s", e.Cmd, e.OK, e.Error, e.Result))
		}
	}
	b.f.record(label+".txt", strings.Join(out, "\n")+"\n")
	return len(rows)
}

// launchFiles lists which of a launch's files exist.
func launchFiles(l store.CodexLaunch) []string {
	cl := codexapp.Launch{Dir: l.RunDir, Name: l.Name, Token: l.Token}
	var out []string
	for _, p := range []string{cl.Script(), cl.Socket(), cl.PIDFile(), cl.Log()} {
		if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
			out = append(out, filepath.Base(p))
		}
	}
	return out
}

// argv is the command line of the pane's foreground process with
// arguments.
func (f *fx) argv(ctl *herdr.Control, pane string) []string {
	f.t.Helper()
	info, err := ctl.PaneProcesses(f.ctx, f.h.Name, pane)
	if err != nil {
		f.t.Fatal(err)
	}
	for _, p := range info.Foreground {
		if len(p.Argv) > 1 {
			return p.Argv
		}
	}
	return nil
}

// replyRequests are the mock's reply-envelope requests from index from.
func (f *fx) replyRequests(from int) []Request {
	var out []Request
	for _, r := range f.mock.Requests()[from:] {
		if r.Kind == KindReply {
			out = append(out, r)
		}
	}
	return out
}

// repliesSince waits until the mock got n reply requests from index from
// (a bridge's question is answered once Codex records the user message,
// a moment before the model request), then a little longer for a stray
// one, and returns them all.
func (f *fx) repliesSince(from, n int) []Request {
	f.t.Helper()
	for end := time.Now().Add(30 * time.Second); len(f.replyRequests(from)) < n && time.Now().Before(end); {
		time.Sleep(100 * time.Millisecond)
	}
	time.Sleep(2 * time.Second)
	return f.replyRequests(from)
}

// answersIn counts the reply envelopes in a request body (the model's
// whole input) that answer (batch, index): what the model can see of them.
func answersIn(body, batch string, index int) int {
	return strings.Count(body, `\\\"request_user_input_async\\\",\\\"`+batch+`\\\",`+strconv.Itoa(index)+`]`)
}
