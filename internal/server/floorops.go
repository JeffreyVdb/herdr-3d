package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// FloorHerdr is what the hub needs from herdr to wake floors and put them
// to sleep: *herdr.Control (the allowlisted write path) plus a read-only
// ping.
type FloorHerdr interface {
	Ping(ctx context.Context, socket string) error
	StartSession(ctx context.Context, session string) error
	StopSession(ctx context.Context, session string) (string, error)
	// #58 session.create: what herdr lists (any state), and a server
	// started under a new name.
	ListSessions(ctx context.Context) ([]herdr.Session, error)
	CreateSession(ctx context.Context, session string) error
	PaneProcesses(ctx context.Context, session, pane string) (*herdr.ProcessInfo, error)
	ResumeAgent(ctx context.Context, session, pane, harness, agentSession string) error
	ReportCodexSession(ctx context.Context, session, pane, agentSession string) error
	// #155: a shared-server Codex worker's TUI exits at sleep (so herdr
	// keeps no session to resume it with), and on wake its server starts
	// from its pane again and the bridge resumes its thread attached to it.
	TypeExit(ctx context.Context, session, pane, harness string) error
	SendKey(ctx context.Context, session, pane string, key herdr.Key) error
	StartCodexServer(ctx context.Context, session, pane, launcher string) error
	ResumeCodexRemote(ctx context.Context, session, pane, name, thread string, a herdr.Agent, r herdr.Remote) error
	// A shared worker that slept before it had a thread starts afresh; one
	// whose server does not start resumes on Codex's embedded server.
	StartCodexRemote(ctx context.Context, session, pane, name string, a herdr.Agent, r herdr.Remote) error
	ResumeCodexEmbedded(ctx context.Context, session, pane, name, thread string, a herdr.Agent) error
	// #139: a Codex worker on a profile: its home exported in its pane's
	// shell before its server or its resume starts there.
	ExportCodexHome(ctx context.Context, session, pane, home string) error
}

// Defaults of the wake/sleep Options.
const (
	DefaultWakeTimeout   = 10 * time.Second
	DefaultResumeTimeout = 10 * time.Second
	DefaultSleepTimeout  = 15 * time.Second
	defaultResumePoll    = 500 * time.Millisecond
	defaultResumeSettle  = 1500 * time.Millisecond
	// unitPoll is how often a wake looks whether the last server's unit
	// has unloaded (a stat of its unit file).
	unitPoll = 100 * time.Millisecond
)

var (
	errBusy         = errors.New("busy")
	errInvalidState = errors.New("invalid state")
	errWakeFailed   = errors.New("wake failed")
	errSleepFailed  = errors.New("sleep failed")
)

// floorOp is a wake or sleep in progress. The hub goroutine owns its
// fields; the goroutine doing the slow work only reads them through do.
type floorOp struct {
	kind    string // proto.TransitionWaking or proto.TransitionSleeping
	session string
	client  *Client
	cmd     proto.Command
	auditID int64
	// notify wakes the op's goroutine when something it waits for may have
	// happened (cap 1, never blocks the hub).
	notify chan struct{}
	// waits are the workers a wake expects back, by worker id.
	waits map[string]*resumeWait
	// asleep: a sleep has seen the floor asleep; its transition is over.
	asleep bool
	// running: a wake has seen the floor running.
	running bool
	// then, if set, is a hire's wake (#58 decision 3): it runs instead of
	// the wake's reply, on the hub goroutine, with the wake's error.
	then func(ctx context.Context, err error)
}

// resumeWait is one worker a wake expects to resume.
type resumeWait struct {
	pane, harness, agentSession string
	state                       string // proto.Resume*
	fallback                    bool   // the bridge ran the resume command itself
	note                        string // what happened, for the audit log
	shared                      bool   // #155: the bridge resumes it attached to its own server
}

func (op *floorOp) signal() {
	select {
	case op.notify <- struct{}{}:
	default:
	}
}

// notBusy refuses commands on a floor while it wakes or sleeps.
func (h *Hub) notBusy(session string, f *floorState) error {
	if f.op != nil {
		return fmt.Errorf("%w: floor %q is %s", errBusy, session, f.op.kind)
	}
	return nil
}

// floorFor returns a known floor the bridge may act on, by floor id (#58):
// a session's real floor or a virtual floor on it. Its session (f.session,
// never a virtual floor's id) is what herdr is called with, and what
// --sessions must allow.
func (h *Hub) floorFor(floor string) (*floorState, error) {
	f, ok := h.floors[floor]
	if !ok || (h.opts.Sessions != nil && !h.opts.Sessions.MatchString(f.session)) {
		return nil, fmt.Errorf("%w: %q", errUnknownSession, floor)
	}
	return f, nil
}

func (h *Hub) requestRescan() {
	select {
	case h.rescan <- struct{}{}:
	default:
	}
}

// setResume sets (or with "" clears) a worker's resume state and emits
// its upsert when that changes what clients see.
func (h *Hub) setResume(id, state string) {
	if state == "" {
		delete(h.resume, id)
	} else {
		h.resume[id] = state
	}
	w := h.workers[id]
	if w == nil || w.Resume == state {
		return
	}
	next := *w
	next.Resume = state
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// startFloorOp validates floor.wake / floor.sleep and, when accepted,
// starts it: the transition goes out at once, the slow part runs off the
// hub goroutine and the ack or error comes when it is done.
func (h *Hub) startFloorOp(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.FloorArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	a.Floor = floorArg(a.Floor, a.Session) // #58: a client from before floor ids names the session
	f, err := h.floorFor(a.Floor)
	if err != nil {
		return err
	}
	if err := h.notBusy(a.Floor, f); err != nil {
		return err
	}
	if len(f.hires) > 0 || len(f.fires) > 0 {
		return fmt.Errorf("%w: floor %q is hiring or sending a worker home", errBusy, a.Floor)
	}
	wake := cmd.T == proto.CmdFloorWake
	switch {
	case wake && f.running:
		return fmt.Errorf("%w: floor %q is running", errInvalidState, a.Floor)
	case !wake && !f.running:
		return fmt.Errorf("%w: floor %q is asleep", errInvalidState, a.Floor)
	case !herdr.ValidSessionName(f.session):
		return &badArgsError{fmt.Errorf("session %q cannot be woken or put to sleep by the bridge", f.session)}
	case h.opts.Herdr == nil:
		return errors.New("waking and sleeping floors is not configured")
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, cmd.Args)
	if err != nil {
		return err
	}
	// #58: a floor's wake or sleep is its session's: every floor of it
	// wakes or sleeps (herdr is only ever called with the session).
	op := &floorOp{session: f.session, client: c, cmd: cmd, auditID: auditID, notify: make(chan struct{}, 1)}
	f.op = op
	h.log.Info("floor operation started", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID, "session", f.session,
		"floor", a.Floor)
	if wake {
		h.beginWake(ctx, op, f)
		return nil
	}
	op.kind = proto.TransitionSleeping
	h.syncLayout()
	known := map[string]bool{}
	var backfills []backfill
	var shared []sharedSleep
	for _, id := range f.all {
		h.setResume(id, "")
		w := h.workers[id]
		if w == nil {
			continue
		}
		if l, ok := h.cx.launches[id]; ok && l.Mode == store.CodexShared { // #155: never backfilled
			if l.Thread != "" {
				known[l.Thread] = true
			}
			if w.AgentSession != "" {
				known[w.AgentSession] = true
			}
			shared = append(shared, sharedSleep{Worker: id, Pane: w.PaneID})
			continue
		}
		if w.AgentSession != "" {
			known[w.AgentSession] = true
		} else if w.AgentKind == "codex" && w.PaneID != "" && w.Cwd != "" {
			backfills = append(backfills, backfill{Worker: id, Pane: w.PaneID, cwd: w.Cwd})
		}
	}
	h.wg.Add(1)
	go h.runSleep(ctx, op, shared, backfills, known)
	return nil
}

// beginWake starts a wake op on f (op holds f): the transition goes out at
// once, the resumable workers turn pending and runWake does the rest off
// the hub goroutine.
func (h *Hub) beginWake(ctx context.Context, op *floorOp, f *floorState) {
	op.kind = proto.TransitionWaking
	op.waits = map[string]*resumeWait{}
	h.syncLayout() // the transition first, then the workers
	for _, id := range f.all {
		w := h.workers[id]
		if l, ok := h.cx.launches[id]; ok && w != nil && l.Mode == store.CodexShared { // #155
			// Also without a thread (it slept before herdr reported
			// one): sleep quit its TUI, so it is launched afresh.
			op.waits[id] = &resumeWait{pane: w.PaneID, harness: "codex", agentSession: l.Thread,
				state: proto.ResumePending, shared: true}
			h.setResume(id, proto.ResumePending)
			continue
		}
		if w == nil || w.AgentSession == "" {
			continue
		}
		harness := w.AgentKind
		if harness == "" {
			harness = w.Harness
		}
		op.waits[id] = &resumeWait{pane: w.PaneID, harness: harness, agentSession: w.AgentSession, state: proto.ResumePending}
		h.setResume(id, proto.ResumePending)
	}
	h.wg.Add(1)
	go h.runWake(ctx, op, f.socket)
}

// agentDetected resolves a waking worker whose pane herdr reports its
// agent in. An event without an agent (herdr sends one when the agent
// process goes away) or with a release is no detection.
func (h *Hub) agentDetected(u world.AgentDetected) {
	h.log.Debug("agent detected", "session", u.Session, "pane", u.PaneID, "agent", u.Agent, "released", u.Released)
	f := h.floors[u.Session]
	if f == nil || f.op == nil || f.op.kind != proto.TransitionWaking || u.Released || u.Agent == "" {
		return
	}
	for id, w := range f.op.waits {
		cur := h.workers[id]
		if w.state == proto.ResumePending && !w.shared && (w.harness == "" || w.harness == u.Agent) &&
			(w.pane == u.PaneID || (cur != nil && cur.PaneID == u.PaneID)) {
			h.resolveWait(f.op, id, "pane.agent_detected")
		}
	}
}

// resolveWait marks a waking worker's agent as back: confirmed, or
// fallback when the bridge re-launched it.
func (h *Hub) resolveWait(op *floorOp, id, how string) {
	w := op.waits[id]
	if w == nil || w.state != proto.ResumePending {
		return
	}
	w.state = proto.ResumeConfirmed
	if w.fallback {
		w.state = proto.ResumeFallback
	}
	w.note = joinNote(w.note, how)
	h.setResume(id, w.state)
	op.signal()
}

func joinNote(a, b string) string {
	if a == "" {
		return b
	}
	return a + "; " + b
}

// pendingWait is a copy of a pending resumeWait for the op goroutine.
type pendingWait struct {
	id, pane, harness, agentSession string
}

func (h *Hub) pendingWaits(ctx context.Context, op *floorOp) []pendingWait {
	out, _ := query(ctx, h, func() []pendingWait {
		var out []pendingWait
		for _, id := range h.floorOrder(op) {
			if w := op.waits[id]; w != nil && w.state == proto.ResumePending && !w.shared {
				out = append(out, pendingWait{id: id, pane: w.pane, harness: w.harness, agentSession: w.agentSession})
			}
		}
		return out
	})
	return out
}

// floorOrder lists the op's workers in the floor's sidebar order, then any
// that left it.
func (h *Hub) floorOrder(op *floorOp) []string {
	var ids []string
	seen := map[string]bool{}
	if f := h.floors[op.session]; f != nil {
		for _, id := range f.all {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	for _, id := range sortedKeys(op.waits) {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	return ids
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// doWait runs fn on the hub goroutine and waits for it. When ctx ends
// first, fn may still run after doWait returns, so fn must only touch hub
// state; results come back through query.
func (h *Hub) doWait(ctx context.Context, fn func()) error {
	_, err := query(ctx, h, func() struct{} { fn(); return struct{}{} })
	return err
}

// query runs fn on the hub goroutine and returns its result. The result
// only crosses over through the channel, so a wait that ends early never
// reads what fn is still writing.
func query[T any](ctx context.Context, h *Hub, fn func() T) (T, error) {
	var zero T
	res := make(chan T, 1)
	if err := h.do(ctx, func(context.Context) { res <- fn() }); err != nil {
		return zero, err
	}
	select {
	case v := <-res:
		return v, nil
	case <-ctx.Done():
		return zero, ctx.Err()
	case <-h.done:
		return zero, errHubStopped
	}
}

// wakeReport is the audit-log result of a floor.wake.
type wakeReport struct {
	// #58: how long the wake waited for the last server's unit to unload.
	UnitWaitMs  int64          `json:"unit_wait_ms"`
	PingAfterMs int64          `json:"ping_after_ms,omitempty"`
	Workers     []workerReport `json:"workers"`
}

type workerReport struct {
	ID     string `json:"id"`
	Pane   string `json:"pane,omitempty"`
	Resume string `json:"resume"`
	Note   string `json:"note,omitempty"`
}

// runWake waits for the last server's unit to unload, starts the session's
// server, waits for it to answer and for its floor to be seen running (else
// wake_failed), then for each expected agent (herdr resumes them itself; a
// pane that is back at its shell gets the resume command once) and acks
// with the outcome. Each phase has one deadline, so the ack comes within
// about SleepTimeout + WakeTimeout + 2 × ResumeTimeout however many workers
// there are and however slowly herdr answers.
func (h *Hub) runWake(ctx context.Context, op *floorOp, socket string) {
	defer h.wg.Done()
	report := &wakeReport{}
	waited := time.Now()
	if err := h.awaitUnitGone(ctx, op.session, waited.Add(h.opts.SleepTimeout)); err != nil {
		report.UnitWaitMs = time.Since(waited).Milliseconds()
		h.finishOp(ctx, op, err, report)
		return
	}
	start := time.Now()
	report.UnitWaitMs = start.Sub(waited).Milliseconds()
	up := start.Add(h.opts.WakeTimeout)
	sctx, cancel := context.WithDeadline(ctx, up)
	err := h.opts.Herdr.StartSession(sctx, op.session)
	cancel()
	if err != nil {
		h.finishOp(ctx, op, fmt.Errorf("%w: starting the server: %v", errWakeFailed, err), report)
		return
	}
	if err := h.waitPing(ctx, op.session, socket, up); err != nil {
		h.finishOp(ctx, op, err, report)
		return
	}
	report.PingAfterMs = time.Since(start).Milliseconds()
	h.requestRescan() // follow the floor now, not at the next poll
	if !h.awaitFlag(ctx, op, up, func() bool { return op.running }) {
		h.finishOp(ctx, op, fmt.Errorf("%w: the %s server answers ping, but its floor was not seen running within %s",
			errWakeFailed, op.session, h.opts.WakeTimeout), report)
		return
	}
	sharedDone := h.resumeSharedAll(ctx, op) // #155: alongside herdr's own resumes
	h.resumePhase(ctx, op, nil)
	h.resumePhase(ctx, op, h.fallback)
	sharedDone()
	h.finishOp(ctx, op, nil, report)
}

// awaitUnitGone waits until deadline for the transient unit of the
// session's last server (herdr-s-<session>) to unload: systemd-run refuses
// to start a unit of that name while it is loaded. `herdr session stop`
// ends the server, but processes it started outside its panes (its update
// and agent-manifest curls) stay in the unit (KillMode=process) and keep it
// loaded until they exit, for up to their own timeouts. They are herdr's,
// not ours to kill, so the wake waits for them.
func (h *Hub) awaitUnitGone(ctx context.Context, session string, deadline time.Time) error {
	unit := herdr.SessionUnit(session)
	loaded := h.unitLoaded()
	if !loaded(unit) {
		return nil
	}
	h.log.Info("waiting for the last server's unit to unload", "session", session, "unit", unit)
	for loaded(unit) {
		if !time.Now().Before(deadline) {
			return fmt.Errorf("%w: the service %s is still loaded: processes the last %s server left are still running "+
				"after %s; wake the floor again in a moment", errWakeFailed, unit, session, h.opts.SleepTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(min(unitPoll, time.Until(deadline))):
		}
	}
	return nil
}

// waitPing polls the started server's socket until it answers, backing
// off up to a second, until deadline.
func (h *Hub) waitPing(ctx context.Context, session, socket string, deadline time.Time) error {
	if socket == "" {
		return fmt.Errorf("%w: no socket known for %q", errWakeFailed, session)
	}
	backoff := 50 * time.Millisecond
	for {
		pctx, cancel := context.WithTimeout(ctx, min(time.Second, time.Until(deadline)))
		err := h.opts.Herdr.Ping(pctx, socket)
		cancel()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if time.Now().Add(backoff).After(deadline) {
			return fmt.Errorf("%w: the %s server did not answer ping within %s (%v)", errWakeFailed, session, h.opts.WakeTimeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, time.Second)
	}
}

// resumePhase gives the pending workers ResumeTimeout to get their agents
// back, after prepare (the fallback), when set. Each worker's pane is
// watched on its own and every herdr call is bounded by the phase's
// deadline, so a stalled pane holds up neither the others nor the phase.
// It ends early once no worker is pending, also when pane.agent_detected
// (resolved on the hub goroutine) was the evidence.
func (h *Hub) resumePhase(ctx context.Context, op *floorOp, prepare func(ctx, phase context.Context, op *floorOp, p pendingWait)) {
	phase, cancel := context.WithTimeout(ctx, h.opts.ResumeTimeout)
	defer cancel()
	var wg sync.WaitGroup
	for _, p := range h.pendingWaits(phase, op) {
		wg.Go(func() {
			if prepare != nil {
				prepare(ctx, phase, op, p)
			}
			h.watchResume(phase, op, p)
		})
	}
	for phase.Err() == nil && len(h.pendingWaits(phase, op)) > 0 {
		select {
		case <-phase.Done():
		case <-op.notify:
		}
	}
	cancel()
	wg.Wait()
}

// watchResume confirms a pending worker once the pane's foreground process
// is its agent and still is ResumeSettle later (herdr 0.9 restores a
// pane's agent before the agent runs and reports no detection for a
// resume, so the process is the real evidence). It returns when the
// worker is no longer pending or ctx ends.
func (h *Hub) watchResume(ctx context.Context, op *floorOp, p pendingWait) {
	var since time.Time // the agent has been in the foreground since
	for h.isPending(ctx, op, p.id) {
		info, err := h.paneProcesses(ctx, op.session, p.pane)
		switch {
		case err != nil || !info.Runs(p.harness, p.agentSession):
			since = time.Time{}
		case since.IsZero():
			since = time.Now()
		case time.Since(since) >= h.opts.ResumeSettle:
			_ = h.doWait(ctx, func() { h.resolveWait(op, p.id, "agent process running") })
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(h.opts.ResumePoll):
		}
	}
}

func (h *Hub) isPending(ctx context.Context, op *floorOp, id string) bool {
	pending, _ := query(ctx, h, func() bool {
		w := op.waits[id]
		return w != nil && w.state == proto.ResumePending
	})
	return pending
}

// paneProcesses asks herdr what runs in a pane, for at most
// paneProcessesTimeout and never past ctx (a phase's deadline).
func (h *Hub) paneProcesses(ctx context.Context, session, pane string) (*herdr.ProcessInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, paneProcessesTimeout)
	defer cancel()
	return h.opts.Herdr.PaneProcesses(ctx, session, pane)
}

const paneProcessesTimeout = 2 * time.Second

// fallback re-launches a pending worker's agent with its resume command,
// only when its pane is back at the shell prompt. herdr calls end with
// phase; ctx is for the bookkeeping on the hub goroutine.
func (h *Hub) fallback(ctx, phase context.Context, op *floorOp, p pendingWait) {
	note := ""
	info, err := h.paneProcesses(phase, op.session, p.pane)
	switch {
	case err != nil:
		note = "no fallback: " + err.Error()
	case info.Runs(p.harness, p.agentSession):
		note = "agent process running, not settled"
	case !info.AtShell():
		note = "no fallback: the pane is not at its shell prompt"
	case !herdr.CanResume(p.harness):
		note = fmt.Sprintf("no fallback: cannot resume %q", p.harness)
	case p.harness == "codex" && h.exportProfileHome(phase, op.session, p.id, p.pane) != nil:
		note = "no fallback: its Codex profile's home could not be exported in its pane"
	default:
		_ = h.doWait(ctx, func() {
			if w := op.waits[p.id]; w != nil {
				w.fallback = true
			}
		})
		if err := h.opts.Herdr.ResumeAgent(phase, op.session, p.pane, p.harness, p.agentSession); err != nil {
			note = "fallback failed: " + err.Error()
			_ = h.doWait(ctx, func() {
				if w := op.waits[p.id]; w != nil {
					w.fallback = false
				}
			})
		} else {
			note = "fallback: ran the resume command"
			h.log.Info("resuming agent with the fallback", "session", op.session, "pane", p.pane, "harness", p.harness)
		}
	}
	_ = h.doWait(ctx, func() {
		if w := op.waits[p.id]; w != nil {
			w.note = joinNote(w.note, note)
		}
	})
}

// backfill is a Codex pane whose session id herdr does not know.
type backfill struct {
	Worker       string `json:"worker"`
	Pane         string `json:"pane"`
	AgentSession string `json:"agent_session,omitempty"`
	Skipped      string `json:"skipped,omitempty"`
	Error        string `json:"error,omitempty"`
	cwd          string
}

// sleepReport is the audit-log result of a floor.sleep.
type sleepReport struct {
	// Shared are the shared-server Codex workers (#155): their TUI exited
	// and their server stopped before the session.
	Shared    []sharedSleep `json:"shared,omitempty"`
	Backfills []backfill    `json:"backfills"`
	// Stop is herdr's `session stop` output (JSON when it is JSON).
	Stop       any  `json:"stop,omitempty"`
	SeenAsleep bool `json:"seen_asleep"`
}

// runSleep backfills Codex session ids, stops the session the way herdr
// does (agents keep their resume link) and acks once the floor is seen
// asleep; a floor not seen asleep in time is sleep_failed.
func (h *Hub) runSleep(ctx context.Context, op *floorOp, shared []sharedSleep, backfills []backfill, known map[string]bool) {
	defer h.wg.Done()
	report := &sleepReport{Backfills: []backfill{}}
	for _, s := range shared { // #155
		s.Note = h.sleepShared(ctx, op.session, s)
		report.Shared = append(report.Shared, s)
	}
	for _, b := range backfills {
		switch id, err := h.codexSession(b.cwd, known); {
		case err != nil:
			b.Error = "finding the codex session: " + err.Error()
		case id == "":
			b.Skipped = "no codex rollout for " + b.cwd
		default:
			b.AgentSession = id
			if err := h.opts.Herdr.ReportCodexSession(ctx, op.session, b.Pane, id); err != nil {
				b.Error = err.Error()
			} else {
				known[id] = true
			}
		}
		report.Backfills = append(report.Backfills, b)
	}
	out, err := h.opts.Herdr.StopSession(ctx, op.session)
	if json.Valid([]byte(out)) {
		report.Stop = json.RawMessage(out)
	} else if out != "" {
		report.Stop = out
	}
	if err != nil {
		h.finishOp(ctx, op, fmt.Errorf("%w: %v", errSleepFailed, err), report)
		return
	}
	h.requestRescan()
	report.SeenAsleep = h.awaitFlag(ctx, op, time.Now().Add(h.opts.SleepTimeout), func() bool { return op.asleep })
	if ctx.Err() != nil {
		return
	}
	if !report.SeenAsleep {
		h.finishOp(ctx, op, fmt.Errorf("%w: herdr stopped %s, but its floor was not seen asleep within %s",
			errSleepFailed, op.session, h.opts.SleepTimeout), report)
		return
	}
	h.finishOp(ctx, op, nil, report)
}

// awaitFlag waits until deadline for flag (read on the hub goroutine) to
// hold.
func (h *Hub) awaitFlag(ctx context.Context, op *floorOp, deadline time.Time, flag func() bool) bool {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	for {
		if ok, _ := query(ctx, h, flag); ok {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return false
		case <-op.notify:
		}
	}
}

func (h *Hub) codexSession(cwd string, known map[string]bool) (string, error) {
	if h.opts.CodexSession == nil {
		return "", nil
	}
	return h.opts.CodexSession(cwd, func(id string) bool { return known[id] })
}

// finishOp ends a floor operation on the hub goroutine: pending resumes
// fail (or clear, when the server never came up), the transition ends,
// the audit row is completed and the client gets its ack or error.
func (h *Hub) finishOp(ctx context.Context, op *floorOp, opErr error, report any) {
	err := h.doWait(ctx, func() {
		f := h.floors[op.session]
		var data any
		if op.kind == proto.TransitionWaking {
			res := proto.WakeResult{Workers: []proto.WorkerResume{}}
			rep := report.(*wakeReport)
			for _, id := range h.floorOrder(op) {
				w := op.waits[id]
				if w == nil {
					res.Workers = append(res.Workers, proto.WorkerResume{ID: id, Resume: proto.ResumeNone})
					continue
				}
				if w.state == proto.ResumePending {
					if opErr != nil {
						h.setResume(id, "")
						continue
					}
					w.state = proto.ResumeFailed
					h.setResume(id, w.state)
				}
				res.Workers = append(res.Workers, proto.WorkerResume{ID: id, Resume: w.state})
				rep.Workers = append(rep.Workers, workerReport{ID: id, Pane: w.pane, Resume: w.state, Note: w.note})
			}
			if opErr == nil {
				data = res
			}
		}
		if f != nil && f.op == op {
			f.op = nil
		}
		h.syncLayout()
		if aerr := h.st.AuditEnd(ctx, op.auditID, opErr, report); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		if op.then != nil {
			op.then(ctx, opErr)
			return
		}
		h.reply(op.client, op.cmd, data, opErr)
	})
	if err != nil {
		h.log.Warn("floor operation abandoned", "session", op.session, "cmd", op.cmd.T, "err", err)
	}
}
