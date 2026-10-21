package server

// #155 shared Codex server: a Codex worker hired with the switch on runs
// Codex's own terminal against an app-server of its own, started from its
// pane (docs/research/codex-shared-tui.md D1–D8). The bridge owns that
// server: it records it (store.CodexLaunch), stops it on send home, fire
// and sleep (it outlives its pane and herdr's session stop), resumes the
// worker itself on wake (herdr's own resume drops --remote), reports a dead
// one, and joins the worker's thread as a second client while its server
// runs (codexapp.Watcher; #156: whether or not its transcript is open, so
// its async questions are seen and can be answered: codexquestions.go).
// Workers keep the mode they were launched with: the switch never touches
// a running worker.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// CodexHost is what a shared Codex launch needs besides herdr: the checks
// before it, its launch files and processes, and the protocol adapter
// (codexapp). Tests pass a fake.
type CodexHost interface {
	// Preflight refuses an unsupported Codex or a blocked .envrc in dir.
	Preflight(ctx context.Context, dir string, policy codexapp.VersionPolicy) error
	// Prepare writes the launch's launcher.
	Prepare(l codexapp.Launch) error
	// WaitReady waits until the launch's server answers on its socket and
	// returns its userAgent.
	WaitReady(ctx context.Context, sock string) (string, error)
	// FindServer finds the launch's running app-server process.
	FindServer(l codexapp.Launch) (codexapp.Server, error)
	// Alive reports whether the recorded server still runs.
	Alive(l codexapp.Launch, s codexapp.Server) bool
	// Stop ends the launch's processes (only those carrying its marker)
	// and removes its files; it returns the processes that survived.
	Stop(l codexapp.Launch) []int
	// Watch joins a thread as a passive second client.
	Watch(o codexapp.Options) (CodexWatch, error)
	// #139: ReadProfile asks a launch's server (its socket) which account
	// it signed in to and which workspace policy applies; HomeProfile asks
	// the same of Codex run with env (a profile's CODEX_HOME) on its own.
	ReadProfile(ctx context.Context, sock string) (codexapp.Account, codexapp.Requirements, error)
	HomeProfile(ctx context.Context, env []string) (codexapp.Account, codexapp.Requirements, error)
	// #139 S1e: RootThread asks a launch's server (its socket) for the one
	// root thread it has loaded ("": none, or more than one).
	RootThread(ctx context.Context, sock string) (string, error)
}

// CodexChildren is #27's observer of a shared worker's child threads
// (codexchild.Source), keyed by the worker's root thread: the join's
// connection subscribed (Joined, with its observational reads), each of
// its notifications (Notify) and its end (Lost: a disconnect, a failure,
// the join left or replaced). Called on the hub goroutine; none blocks.
type CodexChildren interface {
	Joined(thread string, r codexapp.ChildReader)
	Notify(thread, method string, params json.RawMessage)
	Lost(thread string)
}

// CodexWatch is a running codexapp.Watcher: its two sends (#156), each on
// an explicit request, and leaving. The real one is also a
// codexapp.ChildReader (#27).
type CodexWatch interface {
	Steer(ctx context.Context, expectedTurn, text, clientID string) (string, error)
	StartTurn(ctx context.Context, text, clientID string) (string, error)
	Close()
}

// Defaults of the shared Codex server's Options.
const (
	DefaultCodexPoll         = 3 * time.Second
	DefaultCodexStartTimeout = 20 * time.Second
	DefaultCodexRejoin       = 60 * time.Second
	defaultCodexStopGrace    = 2 * time.Second
	// codexResumeTimeout bounds one shared worker's resume on wake: its pane
	// back at its shell, its server up, the TUI resumed (agent start waits up
	// to 30 s itself).
	codexResumeTimeout = 75 * time.Second
)

// NewCodexHost is the real CodexHost: codex and direnv are the executables
// its checks run.
func NewCodexHost(codex, direnv string) CodexHost {
	return codexHost{pre: codexapp.Preflight{Codex: codex, Direnv: direnv, Run: codexapp.ExecRunner(herdr.CleanEnv(os.Environ()))}}
}

type codexHost struct{ pre codexapp.Preflight }

func (c codexHost) Preflight(ctx context.Context, dir string, policy codexapp.VersionPolicy) error {
	c.pre.VersionPolicy = policy
	return c.pre.Check(ctx, dir)
}
func (codexHost) Prepare(l codexapp.Launch) error { return l.Write() }
func (codexHost) WaitReady(ctx context.Context, sock string) (string, error) {
	return codexapp.WaitReady(ctx, sock)
}
func (codexHost) FindServer(l codexapp.Launch) (codexapp.Server, error) {
	return codexapp.FindServer(l)
}
func (codexHost) Alive(l codexapp.Launch, s codexapp.Server) bool { return codexapp.Alive(l, s) }
func (codexHost) Stop(l codexapp.Launch) []int {
	left := codexapp.Stop(l, defaultCodexStopGrace)
	if len(left) == 0 {
		_ = l.Remove()
	}
	return left
}
func (codexHost) Watch(o codexapp.Options) (CodexWatch, error) { return codexapp.Watch(o) }
func (codexHost) ReadProfile(ctx context.Context, sock string) (codexapp.Account, codexapp.Requirements, error) {
	ctx, cancel := context.WithTimeout(ctx, codexProfileTimeout)
	defer cancel()
	return codexapp.ReadProfile(ctx, sock)
}

// HomeProfile runs Codex with the bridge's environment, the profile's
// variables in place of its own.
func (c codexHost) HomeProfile(ctx context.Context, env []string) (codexapp.Account, codexapp.Requirements, error) {
	ctx, cancel := context.WithTimeout(ctx, codexProfileTimeout)
	defer cancel()
	base := herdr.CleanEnv(os.Environ())
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		base = slices.DeleteFunc(base, func(e string) bool { return strings.HasPrefix(e, k+"=") })
	}
	return codexapp.ReadHomeProfile(ctx, c.pre.Codex, append(base, env...))
}

func (codexHost) RootThread(ctx context.Context, sock string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, codexProfileTimeout)
	defer cancel()
	return codexapp.RootThread(ctx, sock)
}

// codexProfileTimeout bounds one of #139's checks of a profile.
const codexProfileTimeout = 15 * time.Second

// codexState is the hub's part of the feature (hub goroutine).
type codexState struct {
	enabled  bool
	policy   codexapp.VersionPolicy
	last     string                          // the switch as last published
	launches map[string]store.CodexLaunch    // by worker id (mirrors codex_launch)
	server   map[string]string               // worker id → proto.CodexServer* of a shared worker
	watches  map[string]*codexWatch          // worker id → the bridge's join of its thread
	busy     map[string]bool                 // worker id → a launch, resume or stop is under way
	asking   map[string]bool                 // #139 S1e: worker id → its server is asked for its thread
	events   map[string]func(codexapp.Event) // test hook: a worker's adapter events
	// #156: worker id → its thread's async questions. Not the join's: they
	// outlive it (a reconnect, a sleep) and go with the thread.
	questions map[string]*codexapp.Questions
	// #158: worker id → the bridge's answers Codex may still hold
	// (codex_async_send): they outlive a restart (codexquestions.go).
	sends map[string]map[sendKey]store.CodexAsyncSend
}

// codexWatch is the bridge joined (or joining) a worker's thread on one
// server (its launch's token). A failed one stays, so it is not tried again
// while that target is unchanged: the transcript opened, another thread or
// a new server (a wake, a relaunch) replace it, and (#156) one that only
// gave up after its retries is tried again after CodexRejoin.
type codexWatch struct {
	w             CodexWatch
	thread, token string
	policy        codexapp.VersionPolicy
	attached      bool
	// #156, while attached: the running turn ("" when idle) and the server
	// requests (approvals, blocking questions) not resolved yet.
	turn     string
	requests map[string]bool
	// failed: the join ended for good (permanent: refused, not just out of
	// retries) at failedAt.
	failed, permanent bool
	failedAt          time.Time
	// #158: the join's history kept legacy item ids (unresolvedAt): it is
	// joined again after CodexRejoin, to read them again.
	unresolved   bool
	unresolvedAt time.Time
}

// initCodex loads the switch and the launches (NewHub).
func (h *Hub) initCodex(ctx context.Context) error {
	h.cx = codexState{launches: map[string]store.CodexLaunch{}, server: map[string]string{},
		watches: map[string]*codexWatch{}, busy: map[string]bool{}, asking: map[string]bool{}, questions: map[string]*codexapp.Questions{},
		sends: map[string]map[sendKey]store.CodexAsyncSend{}}
	en, _, err := h.st.LoadCodexServerSettings(ctx)
	if err != nil {
		return err
	}
	h.cx.enabled = en.Enabled && h.codexAvailable()
	h.cx.policy.AllowUnverified = en.AllowUnverified
	if h.cx.launches, err = h.st.CodexLaunches(ctx); err != nil {
		return err
	}
	if err := h.loadSends(ctx); err != nil {
		return err
	}
	for id, l := range h.cx.launches {
		if l.Mode != store.CodexShared {
			continue
		}
		h.cx.server[id] = proto.CodexServerStopped
		if l.ServerPID > 0 {
			h.cx.server[id] = proto.CodexServerDown
			if h.opts.CodexHost != nil && h.opts.CodexHost.Alive(launchOf(l), serverOf(l)) {
				h.cx.server[id] = proto.CodexServerRunning
			}
		}
	}
	h.cx.last = h.codexSwitchKey()
	return nil
}

func (h *Hub) codexAvailable() bool { return h.opts.CodexRun != "" && h.opts.CodexHost != nil }

func launchOf(l store.CodexLaunch) codexapp.Launch {
	return codexapp.Launch{Dir: l.RunDir, Name: l.Name, Token: l.Token, Cwd: l.Cwd}
}

func serverOf(l store.CodexLaunch) codexapp.Server {
	return codexapp.Server{PID: l.ServerPID, Start: l.ServerStart}
}

// codexServerView is the switch for the snapshot.
func (h *Hub) codexServerView() *proto.CodexServer {
	return &proto.CodexServer{Enabled: h.cx.enabled, Available: h.codexAvailable(), AllowUnverified: h.cx.policy.AllowUnverified}
}

func (h *Hub) codexSwitchKey() string {
	return fmt.Sprint(h.cx.enabled, h.codexAvailable(), h.cx.policy.AllowUnverified)
}

// publishCodexServer emits codex_server.update when the switch changed.
func (h *Hub) publishCodexServer() {
	if k := h.codexSwitchKey(); k != h.cx.last {
		h.cx.last = k
		h.seq++
		msg := mustJSON(proto.CodexServerUpdate{T: proto.EvCodexServerUpdate, Seq: h.seq, CodexServer: *h.codexServerView()})
		h.ring.add(h.seq, msg)
		for c := range h.clients {
			h.deliver(c, msg)
		}
	}
}

// startCodexServer answers codex_server.get and codex_server.set (on the
// hub goroutine: one row).
func (h *Hub) startCodexServer(ctx context.Context, c *Client, cmd proto.Command) error {
	if cmd.T == proto.CmdCodexServerSet {
		var a proto.CodexServerSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if a.Enabled == nil && a.AllowUnverified == nil {
			return bad("enabled or allow_unverified is required")
		}
		settings := store.CodexServerSettings{Enabled: h.cx.enabled, AllowUnverified: h.cx.policy.AllowUnverified}
		if a.Enabled != nil {
			settings.Enabled = *a.Enabled
		}
		if a.AllowUnverified != nil {
			settings.AllowUnverified = *a.AllowUnverified
		}
		if settings.Enabled && !h.codexAvailable() {
			return fmt.Errorf("%w: this bridge has no private run directory for Codex servers", errUnsupported)
		}
		if err := h.st.SaveCodexServerSettings(ctx, settings); err != nil {
			return err
		}
		h.cx.enabled = settings.Enabled
		h.cx.policy.AllowUnverified = settings.AllowUnverified
		// Refresh bridge connections under the new policy. This never
		// restarts a worker's terminal, server or model turn.
		h.syncCodexWatches(ctx)
		h.publishCodexServer()
	} else if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
		return err
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, *h.codexServerView(), nil)
	return nil
}

// codexWorkerView is a worker's launch for its view (nil: not a Codex
// worker the bridge hired).
func (h *Hub) codexWorkerView(id string) *proto.WorkerCodex {
	l, ok := h.cx.launches[id]
	if !ok {
		return nil
	}
	v := &proto.WorkerCodex{Mode: l.Mode, Note: l.Note}
	profileView(v, l) // #139
	if l.Mode == store.CodexShared {
		v.Server = h.cx.server[id]
		v.Thread = l.Thread
		if w := h.cx.watches[id]; w != nil && w.attached {
			v.Attached, v.Turn = true, w.turn
		}
		v.Questions = h.questionsView(id)
		_, v.AsyncBlocked = h.asyncBlocked(id) // #157: every flip of it re-emits the worker (refreshCodex)
	}
	return v
}

// refreshCodex re-emits a worker whose Codex state changed.
func (h *Hub) refreshCodex(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	v := h.codexWorkerView(id)
	if reflect.DeepEqual(w.Codex, v) {
		return
	}
	next := *w
	next.Codex = v
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// setLaunch stores a worker's launch (hub goroutine) and refreshes it.
func (h *Hub) setLaunch(ctx context.Context, l store.CodexLaunch) {
	if err := h.st.RecordCodexLaunch(ctx, l); err != nil {
		h.log.Error("recording the codex launch failed", "worker", l.WorkerID, "err", err)
	}
	h.cx.launches[l.WorkerID] = l
	h.refreshCodex(l.WorkerID)
}

// updateLaunch changes a stored launch through fn (hub goroutine); false
// when the worker has none.
func (h *Hub) updateLaunch(ctx context.Context, id string, fn func(*store.CodexLaunch)) bool {
	l, ok := h.cx.launches[id]
	if !ok {
		return false
	}
	fn(&l)
	h.setLaunch(ctx, l)
	return true
}

// setCodexServer sets a shared worker's server state (hub goroutine).
func (h *Hub) setCodexServer(id, state string) {
	if h.cx.server[id] == state {
		return
	}
	h.cx.server[id] = state
	h.refreshCodex(id)
}

// noteCodexThread keeps the thread herdr reports for a shared worker's
// pane (syncWorkers, hub goroutine). herdr forgets the id when the TUI
// exits and reports it again only after a resumed thread's first turn, so
// an empty one changes nothing. A thread that is another worker's is never
// taken: two workers never share or swap a thread.
func (h *Hub) noteCodexThread(ctx context.Context, id, thread string) {
	l, ok := h.cx.launches[id]
	if !ok || l.Mode != store.CodexShared || thread == "" || thread == l.Thread || !herdr.ValidAgentSessionID(thread) {
		return
	}
	for other, o := range h.cx.launches {
		if other != id && o.Thread == thread {
			h.log.Warn("codex thread already belongs to another worker: ignored", "worker", id, "other", other, "thread", thread)
			return
		}
	}
	delete(h.cx.questions, id) // #156: the old thread's questions go with it
	h.forgetSends(ctx, id)
	h.updateLaunch(ctx, id, func(l *store.CodexLaunch) { l.Thread = thread })
}

// isShared reports whether a worker was launched with its own server.
func (h *Hub) isShared(id string) bool {
	l, ok := h.cx.launches[id]
	return ok && l.Mode == store.CodexShared
}

// codexTick checks the shared workers' servers and the bridge's joins
// (hub goroutine): a server that died is reported (herdr shows such a
// worker as working), and a worker whose server runs is joined.
func (h *Hub) codexTick(ctx context.Context) {
	if h.opts.CodexHost == nil {
		return
	}
	for id, l := range h.cx.launches {
		if l.Mode != store.CodexShared || h.cx.busy[id] || l.ServerPID <= 0 {
			continue
		}
		state := proto.CodexServerRunning
		if !h.opts.CodexHost.Alive(launchOf(l), serverOf(l)) {
			state = proto.CodexServerDown
		}
		if state == proto.CodexServerDown && h.cx.server[id] != proto.CodexServerDown {
			h.log.Warn("codex server died", "worker", id, "pid", l.ServerPID)
		}
		h.setCodexServer(id, state)
		if state == proto.CodexServerRunning {
			h.askCodexThread(ctx, id, l)
		}
	}
	h.syncCodexWatches(ctx)
}

// askCodexThread asks a running shared worker's server for its thread
// (#139 S1e; hub goroutine), when herdr has reported none and it runs on
// another Codex profile than the bridge's own: a home without herdr's
// hook never reports one. The answer goes through noteCodexThread's rules,
// and only while the worker still has none on the same server.
func (h *Hub) askCodexThread(ctx context.Context, id string, l store.CodexLaunch) {
	if l.Thread != "" || h.cx.asking[id] {
		return
	}
	if _, other := h.codexHomeOf(id); !other {
		return
	}
	h.cx.asking[id] = true
	sock := launchOf(l).Socket()
	go func() {
		thread, err := h.opts.CodexHost.RootThread(ctx, sock)
		_ = h.do(ctx, func(ctx context.Context) {
			delete(h.cx.asking, id)
			cur, ok := h.cx.launches[id]
			switch {
			case err != nil:
				h.log.Debug("asking the codex server for its thread failed", "worker", id, "err", err)
			case thread == "" || !ok || cur.Thread != "" || cur.Token != l.Token || h.cx.busy[id]:
			default:
				h.log.Info("codex thread learned from its own server", "worker", id, "thread", thread)
				h.noteCodexThread(ctx, id, thread)
			}
		})
	}()
}

// syncCodexWatches joins each shared worker's thread while its server runs,
// and leaves it otherwise (D3; #156: the transcript need not be open, see
// docs/decisions.md). A join that gave up after its retries is tried again
// after CodexRejoin; one refused for good is kept. So is (#158) a join whose
// history is unresolved, while it stays so.
func (h *Hub) syncCodexWatches(ctx context.Context) {
	for id, cw := range h.cx.watches {
		l := h.cx.launches[id]
		retry := cw.failed && !cw.permanent && time.Since(cw.failedAt) >= h.opts.CodexRejoin ||
			cw.attached && cw.unresolved && time.Since(cw.unresolvedAt) >= h.opts.CodexRejoin
		if retry || cw.policy != h.cx.policy || !h.wantsCodexWatch(id) || l.Thread != cw.thread || l.Token != cw.token {
			h.dropCodexWatch(id, cw)
			h.refreshCodex(id)
		}
	}
	for id, l := range h.cx.launches {
		if h.cx.watches[id] != nil || !h.wantsCodexWatch(id) {
			continue
		}
		cw := &codexWatch{thread: l.Thread, token: l.Token, policy: h.cx.policy, requests: map[string]bool{}}
		w, err := h.opts.CodexHost.Watch(codexapp.Options{Socket: launchOf(l).Socket(), Thread: cw.thread,
			ClientVersion: version.Version, VersionPolicy: cw.policy, OnEvent: func(e codexapp.Event) {
				_ = h.do(ctx, func(ctx context.Context) { h.codexEvent(ctx, id, cw, e) })
			}})
		if err != nil {
			h.log.Warn("joining the codex thread failed", "worker", id, "err", err)
			continue
		}
		cw.w = w
		h.cx.watches[id] = cw
	}
}

func (h *Hub) wantsCodexWatch(id string) bool {
	l, ok := h.cx.launches[id]
	return ok && l.Mode == store.CodexShared && l.Thread != "" && !h.cx.busy[id] &&
		h.cx.server[id] == proto.CodexServerRunning && h.workers[id] != nil
}

// retryCodexJoin drops a worker's failed join, so the next sync tries
// again (a transcript opened: the player is looking at it now).
func (h *Hub) retryCodexJoin(id string) {
	if cw := h.cx.watches[id]; cw != nil && cw.failed {
		h.dropCodexWatch(id, cw)
	}
}

// dropCodexWatch leaves a worker's join (hub goroutine). Its own events
// stop here (codexEvent drops a join that is not the worker's), so #27's
// observer is told now: no live claim of its children stands.
func (h *Hub) dropCodexWatch(id string, cw *codexWatch) {
	delete(h.cx.watches, id)
	go cw.w.Close() // never on the hub goroutine: its events go through do
	if h.opts.CodexChildren != nil {
		h.opts.CodexChildren.Lost(cw.thread)
	}
}

// codexEvent is one event of the bridge's join of a worker's thread (hub
// goroutine): whether it is joined, and (#156) its thread's async
// questions, running turn and open server requests.
func (h *Hub) codexEvent(ctx context.Context, id string, cw *codexWatch, e codexapp.Event) {
	if h.cx.watches[id] != cw { // a join that was left or replaced
		return
	}
	switch e.Kind {
	case codexapp.EvJoined:
		cw.attached = true
		h.codexJoined(ctx, id, cw, e.Thread)
		h.codexChildrenJoined(id, cw)
	case codexapp.EvNotification:
		h.codexNotification(ctx, id, cw, e.Method, e.Params)
	case codexapp.EvServerRequest:
		cw.requests[compactJSON(e.RequestID)] = true
	case codexapp.EvDisconnected, codexapp.EvClosed:
		cw.attached, cw.turn = false, ""
		clear(cw.requests)
		h.codexChildrenLost(cw)
	case codexapp.EvFailed:
		// Kept: refused for good (not tried again while the target is
		// unchanged), or its retries are spent (tried again after
		// CodexRejoin).
		cw.attached, cw.turn = false, ""
		clear(cw.requests)
		h.codexChildrenLost(cw)
		cw.failed, cw.failedAt = true, time.Now()
		cw.permanent = errors.Is(e.Err, codexapp.ErrUnsupported) || errors.Is(e.Err, codexapp.ErrEphemeral) ||
			errors.Is(e.Err, codexapp.ErrWrongThread)
		h.log.Warn("the bridge's join of a codex thread failed", "worker", id, "thread", cw.thread, "err", e.Err)
	}
	if fn := h.cx.events[id]; fn != nil {
		fn(e)
	}
	h.refreshCodex(id)
}

// codexChildrenJoined tells #27's observer the join is subscribed (on
// every connection: one made after a child was spawned is not subscribed
// to it, and a rejoin's thread/resume returns no children). Only for the
// worker's current thread, and only a watch that can read (the real
// Watcher).
func (h *Hub) codexChildrenJoined(id string, cw *codexWatch) {
	r, ok := cw.w.(codexapp.ChildReader)
	if h.opts.CodexChildren == nil || !ok || h.cx.launches[id].Thread != cw.thread {
		return
	}
	h.opts.CodexChildren.Joined(cw.thread, r)
}

// codexChildrenLost tells #27's observer the join's connection ended.
func (h *Hub) codexChildrenLost(cw *codexWatch) {
	if h.opts.CodexChildren != nil {
		h.opts.CodexChildren.Lost(cw.thread)
	}
}

// sharedLaunch is a shared launch in progress, off the hub goroutine.
type sharedLaunch struct {
	id, session, pane, agent string
	agentDef                 herdr.Agent
	rec                      store.CodexLaunch
	policy                   codexapp.VersionPolicy
	// #139: the Codex profile it starts on (nil: none asked for, the
	// default). Off the default its launcher sets the profile's
	// CODEX_HOME, and its server is checked once it answers.
	profile *codexProfileRun
}

// errNotShared means a shared launch did not get as far as the TUI: the
// worker is to be started the usual way (its reason is in the record's
// note).
var errNotShared = errors.New("the shared Codex server did not start")

// startSharedServer starts a shared worker's server from its pane at its
// shell prompt and records it: the launcher written, the server typed into
// the pane, its socket answering with a supported Codex, its process found.
// On failure nothing of it is left running. #139: on a profile other than
// the default, the server starts with the profile's CODEX_HOME and is
// checked once it answers (confirmProfile): a profile that refuses the
// worker is a *profileRefusedError.
func (h *Hub) startSharedServer(ctx context.Context, sl *sharedLaunch, hh interface {
	StartCodexServer(ctx context.Context, session, pane, launcher string) error
}) error {
	host := h.opts.CodexHost
	l, err := codexapp.NewLaunchFor(h.opts.CodexShell, h.opts.CodexRun, sl.rec.Name, sl.rec.Cwd)
	if err != nil {
		return err
	}
	if p := sl.profile; p != nil && !p.def {
		l.Env = p.env
	}
	sl.rec.RunDir, sl.rec.Token, sl.rec.ServerPID, sl.rec.ServerStart = l.Dir, l.Token, 0, 0
	if err := host.Prepare(l); err != nil {
		return fmt.Errorf("writing the launcher: %w", err)
	}
	// Recorded before anything starts: whatever runs carries the token the
	// bridge may stop.
	if err := h.doWait(ctx, func() {
		h.cx.busy[sl.id] = true
		h.cx.server[sl.id] = proto.CodexServerStarting
		h.setLaunch(ctx, sl.rec)
	}); err != nil {
		return err
	}
	stop := func(err error) error {
		host.Stop(l)
		return err
	}
	if err := hh.StartCodexServer(ctx, sl.session, sl.pane, l.Script()); err != nil {
		return stop(fmt.Errorf("starting the server: %w", err))
	}
	wctx, cancel := context.WithTimeout(ctx, h.opts.CodexStartTimeout)
	ua, err := host.WaitReady(wctx, l.Socket())
	cancel()
	if err != nil {
		return stop(err)
	}
	if err := sl.policy.CheckUserAgent(ua); err != nil {
		return stop(err)
	}
	if p := sl.profile; p != nil && !p.def {
		if err := h.confirmProfile(ctx, p, l.Socket(), &sl.rec); err != nil {
			return stop(err)
		}
	}
	s, err := host.FindServer(l)
	if err != nil {
		return stop(err)
	}
	sl.rec.ServerPID, sl.rec.ServerStart = s.PID, s.Start
	return h.doWait(ctx, func() { h.setLaunch(ctx, sl.rec) })
}

// codexDone ends a launch, resume or stop of a shared worker (hub
// goroutine): its server's state is state.
func (h *Hub) codexDone(id, state string) {
	delete(h.cx.busy, id)
	if h.isShared(id) {
		h.setCodexServer(id, state)
	}
}

// stopSharedServer stops a shared worker's server (off the hub goroutine):
// only its marked processes, then its files. The record keeps the thread.
func (h *Hub) stopSharedServer(ctx context.Context, id string) (note string) {
	l, err := query(ctx, h, func() store.CodexLaunch {
		l := h.cx.launches[id]
		if l.Mode == store.CodexShared {
			h.cx.busy[id] = true
			if cw := h.cx.watches[id]; cw != nil {
				h.dropCodexWatch(id, cw)
			}
		}
		return l
	})
	if err != nil || l.Mode != store.CodexShared || l.Token == "" || h.opts.CodexHost == nil {
		_ = h.doWait(ctx, func() { delete(h.cx.busy, id) })
		return ""
	}
	note = "stopped its codex server"
	if left := h.opts.CodexHost.Stop(launchOf(l)); len(left) > 0 {
		note = fmt.Sprintf("its codex server's processes %v survived SIGKILL", left)
		h.log.Error("codex server processes survived", "worker", id, "pids", left)
	}
	_ = h.doWait(ctx, func() {
		h.updateLaunch(ctx, id, func(l *store.CodexLaunch) { l.ServerPID, l.ServerStart = 0, 0 })
		h.codexDone(id, proto.CodexServerStopped)
	})
	return note
}

// forgetCodex drops a worker's launch once it was sent home (hub
// goroutine).
func (h *Hub) forgetCodex(ctx context.Context, id string) {
	if _, ok := h.cx.launches[id]; !ok {
		return
	}
	if cw := h.cx.watches[id]; cw != nil {
		h.dropCodexWatch(id, cw)
	}
	if err := h.st.ForgetCodexLaunch(ctx, id); err != nil {
		h.log.Error("forgetting the codex launch failed", "worker", id, "err", err)
	}
	delete(h.cx.questions, id)
	h.forgetSends(ctx, id)
	delete(h.cx.launches, id)
	delete(h.cx.server, id)
	delete(h.cx.busy, id)
}

// hooksReview is Codex's "Hooks need review" startup dialog (B8): herdr
// reads it as idle and ready, so a prompt sent then stalls in it.
const hooksReview = "Hooks need review"

// shellLine reports whether s is plain enough for codexapp and herdr's
// remote launch (its -C and the server's trust override).
func shellLine(s string) bool { return herdr.ValidPlainDir(s) }

// markerHex is a marker's hex (the launch's file name).
func markerHex(marker string) string { return strings.TrimPrefix(marker, "h3d-") }

// hireShared starts a shared-server Codex hire (runHire, off the hub
// goroutine): the checks, the server from the worker's pane, then the TUI
// attached to it. Whatever keeps the server from starting (an unsupported
// Codex, a blocked .envrc, a path the launch cannot pass, a server that
// does not answer) starts the worker the usual way instead, the reason in
// the hire's result and on the worker. A TUI that does not attach stops the
// server; the hire then falls back too if the pane is back at its shell,
// and fails otherwise. #139: prof is the Codex profile it runs on (nil:
// none asked for); one that refuses the worker (not signed in, a workspace
// policy) fails the hire, it never falls back.
func (h *Hub) hireShared(ctx context.Context, op *hireOp, pane, dir string, a herdr.Agent, rep *hireReport, res *proto.HireResult,
	prof *codexProfileRun) error {
	hh := h.opts.Hire
	rec := store.CodexLaunch{WorkerID: op.id, Session: op.session, Mode: store.CodexShared, AgentName: op.agent, Cwd: dir,
		Model: op.model, Effort: op.effort, Name: markerHex(op.marker)}
	profileOnRecord(prof, &rec)
	legacy := func(why error) error {
		note := "shared Codex server: " + why.Error() + "; started the usual way"
		rep.step("%s", note)
		rep.Codex = proto.CodexModeLegacy
		lrec := store.CodexLaunch{WorkerID: op.id, Session: op.session, Mode: store.CodexLegacy, Note: note,
			AgentName: op.agent, Cwd: dir, Model: op.model, Effort: op.effort}
		profileOnRecord(prof, &lrec)
		var refused error
		if prof != nil {
			refused = h.checkHomeProfile(ctx, prof, &lrec)
		}
		res.Codex = &proto.WorkerCodex{Mode: proto.CodexModeLegacy, Note: note}
		profileView(res.Codex, lrec)
		profileReport(rep, lrec)
		_ = h.doWait(ctx, func() {
			delete(h.cx.busy, op.id)
			delete(h.cx.server, op.id)
			h.setLaunch(ctx, lrec)
		})
		if refused != nil {
			return refused
		}
		return hh.StartAgent(ctx, op.session, pane, op.agent, a)
	}
	if !shellLine(dir) {
		return legacy(fmt.Errorf("the path %s has characters the shared launch does not pass", dir))
	}
	if err := h.opts.CodexHost.Preflight(ctx, dir, op.codexPolicy); err != nil {
		var du *codexapp.DirenvUnselectedError
		if errors.As(err, &du) {
			h.log.Warn("direnv has no version selected: the shared Codex server falls back", "worker", op.id, "dir", du.Dir, "detail", du.Detail)
		}
		return legacy(err)
	}
	sl := &sharedLaunch{id: op.id, session: op.session, pane: pane, agent: op.agent, agentDef: a, rec: rec, policy: op.codexPolicy, profile: prof}
	if err := h.startSharedServer(ctx, sl, hh); err != nil {
		if isProfileRefused(err) {
			rep.step("%v", err)
			return err
		}
		return legacy(err)
	}
	profileReport(rep, sl.rec)
	rep.step("started the codex server (pid %d) from %s", sl.rec.ServerPID, pane)
	l := launchOf(sl.rec)
	err := hh.StartCodexRemote(ctx, op.session, pane, op.agent, a, herdr.Remote{Socket: l.Socket(), Cwd: dir})
	var api *herdr.APIError
	if err != nil && !(errors.As(err, &api) && api.Code == "agent_not_ready") {
		h.stopSharedServer(ctx, op.id)
		if info, perr := h.opts.Hire.PaneProcesses(ctx, op.session, pane); perr == nil && info.AtShell() {
			return legacy(fmt.Errorf("the terminal did not attach (%v)", err))
		}
		return err
	}
	rep.Codex = proto.CodexModeShared
	res.Codex = &proto.WorkerCodex{Mode: proto.CodexModeShared, Server: proto.CodexServerRunning}
	profileView(res.Codex, sl.rec)
	_ = h.doWait(ctx, func() { h.codexDone(op.id, proto.CodexServerRunning) })
	return err
}

// hooksReviewShows reports whether Codex's "Hooks need review" dialog is on
// the screen of a shared hire (B8). It is left for the player: answering
// it trusts hooks for every thread of the CODEX_HOME.
func (h *Hub) hooksReviewShows(ctx context.Context, op *hireOp, pane string, rep *hireReport) bool {
	screen, err := h.opts.Hire.ReadPane(ctx, op.session, pane)
	if err != nil || !strings.Contains(screen, hooksReview) {
		return false
	}
	rep.step("Codex asks to review its hooks: left for the player")
	return true
}
