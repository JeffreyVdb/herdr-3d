package server

// #83: wrap up, then send home. worker.wrapup checks the worker can go home
// with the worktree choice made up front, arms a wrap-up (a fresh nonce, the
// transcript offset it starts at, persisted), and prompts the agent with the
// cleanup task and a footer asking for one result line. The usage tracker
// feeds the worker's transcript to a transcript.WrapUpTracker from that
// offset; once the agent's turn ended in the transcript and herdr reports
// it idle (both quiet for WrapUpDebounce), the hub decides: CLEAN sends it
// home through the same runFire (strict: the worktree is deleted or the
// worker stays), anything else disarms to needs_you. The verdict only ever
// comes from the transcript, and a wrap-up only touches its own worker.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// Wrap-up timings.
const (
	// DefaultWrapUpTimeout is how long an armed wrap-up waits for its
	// result before it needs you.
	DefaultWrapUpTimeout = 30 * time.Minute
	// DefaultWrapUpDebounce is how long the ended turn and herdr's idle
	// must hold before the result is read: a turn still being written is
	// not.
	DefaultWrapUpDebounce = 2 * time.Second
)

// Why a wrap-up needs you, besides BLOCKED's own reason.
const (
	wrapUpNoResult = "did not report a wrap-up result"
	wrapUpGone     = "its transcript is gone, so the wrap-up result cannot be read"
)

// wrapArming is a wrap-up checked and waiting for the tracker to take its
// transcript offset (not on the worker yet; then proto.WrapUpArmed).
const wrapArming = "arming"

// wrapUp is a worker's wrap-up (hub goroutine).
type wrapUp struct {
	id, session     string
	nonce, worktree string
	armedAt         int64  // unix ms
	key             string // the transcript the offset is in (harness/agent session)
	offset          int64  // -1 until the tracker took it
	state           string // wrapArming, proto.WrapUpArmed, proto.WrapUpNeedsYou
	reason          string
	checking        bool // arming: the arm-time check of the tree runs
	// Arming: the command, its client and audit row, and the text to prompt.
	client  *Client
	cmd     proto.Command
	auditID int64
	text    string
	// by is who armed it, for the send home's audit row.
	by string
	// The tracker's last look at the ended turn: its line count, since when.
	lines   int
	quietAt time.Time
	// deciding: a CLEAN's check or send home runs; firing: its send home
	// (beginFire) started. Until then a person stepping in disarms it.
	deciding, firing bool
}

// wrapWatch is what the usage tracker needs of an armed wrap-up.
type wrapWatch struct {
	nonce string
	// offset is where the tracker reads from, -1 for where its session's
	// tail is after this round's read (arming).
	offset int64
}

// wrapUpdate is the tracker's look at a wrap-up, every round.
type wrapUpdate struct {
	id, nonce string
	key       string // the session the tracker reads
	offset    int64
	found     bool // its transcript is read (not gone, never void)
	state     transcript.WrapUpState
}

// txLines feeds a session's lines to the worker's ask tracker and, while a
// wrap-up is armed, its wrap-up tracker (usage tracker goroutine).
type txLines struct {
	harness  string
	ask      *transcript.AskTracker
	wrap     *transcript.WrapUpTracker
	paste    *pasteWatch                 // #95
	followup *transcript.FollowupTracker // #90
}

func (l *txLines) Line(off int64, b []byte) {
	if l.ask != nil {
		l.ask.Line(b)
	}
	if l.paste != nil {
		l.paste.line(b)
	}
	if l.wrap == nil && l.followup == nil {
		return
	}
	// The turn boundaries and final message, read once for both.
	evs := transcript.TurnEvents(l.harness, b)
	if l.wrap != nil {
		l.wrap.Events(off, evs)
	}
	if l.followup != nil {
		l.followup.Events(evs)
	}
}

func (l *txLines) Reset() {
	if l.ask != nil {
		l.ask.Reset()
	}
	if l.wrap != nil {
		l.wrap.Reset()
	}
	if l.followup != nil {
		l.followup.Reset()
	}
}

// wrapBefore gives a resumed wrap-up (its offset known) its tracker before
// the session reads, so it gets every line from the offset on; one whose
// lines from there were read already cannot resume and is void.
func (tr *usageTracker) wrapBefore(w usageWorker) {
	l := tr.lines[w.id]
	if w.wrap == nil {
		if l != nil {
			l.wrap = nil
		}
		return
	}
	if l == nil || w.wrap.offset < 0 || (l.wrap != nil && l.wrap.Nonce() == w.wrap.nonce) {
		return
	}
	t := transcript.NewWrapUpTracker(w.harness, w.wrap.nonce, w.wrap.offset)
	if t == nil {
		return
	}
	if s := tr.sessions[w.id]; s != nil && s.Delivered() > w.wrap.offset {
		t.Reset()
	}
	l.wrap = t
}

// offerWrapUp queues the tracker's look at the worker's wrap-up for the hub
// (after its session's read).
func (tr *usageTracker) offerWrapUp(w usageWorker) {
	if u := tr.wrapAfter(w); u != nil {
		tr.wrapUps = append(tr.wrapUps, *u)
	}
}

// wrapAfter arms a new wrap-up's tracker where the session's tail is now
// (after its read: nothing from there on was read yet) and returns the
// tracker's look, nil without a wrap-up.
func (tr *usageTracker) wrapAfter(w usageWorker) *wrapUpdate {
	if w.wrap == nil {
		return nil
	}
	u := &wrapUpdate{id: w.id, nonce: w.wrap.nonce, key: tr.keys[w.id], offset: w.wrap.offset}
	s, l := tr.sessions[w.id], tr.lines[w.id]
	if s == nil || l == nil || !s.Found() {
		return u
	}
	if l.wrap == nil || l.wrap.Nonce() != w.wrap.nonce {
		if w.wrap.offset >= 0 {
			return u // a resumed one whose tracker could not be made
		}
		if l.wrap = transcript.NewWrapUpTracker(w.harness, w.wrap.nonce, s.Delivered()); l.wrap == nil {
			return u
		}
	}
	u.offset, u.state = l.wrap.From(), l.wrap.State()
	u.found = !u.state.Void
	return u
}

// wrapWatchOf is what the tracker watches of worker id's wrap-up, nil for
// none (hub goroutine).
func (h *Hub) wrapWatchOf(id string) *wrapWatch {
	wu := h.wrapups[id]
	switch {
	case wu == nil || wu.checking:
		return nil
	case wu.state == wrapArming:
		return &wrapWatch{nonce: wu.nonce, offset: -1}
	case wu.state == proto.WrapUpArmed:
		return &wrapWatch{nonce: wu.nonce, offset: wu.offset}
	}
	return nil
}

// wrapUpView is worker id's wrap-up as clients see it.
func (h *Hub) wrapUpView(id string) *proto.WrapUp {
	wu := h.wrapups[id]
	if wu == nil || wu.state == wrapArming {
		return nil
	}
	return &proto.WrapUp{State: wu.state, Worktree: wu.worktree, ArmedAt: wu.armedAt, Reason: wu.reason}
}

// publishWrapUp sends the worker's upsert when its wrap-up changed.
func (h *Hub) publishWrapUp(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	v := h.wrapUpView(id)
	if reflect.DeepEqual(w.WrapUp, v) {
		return
	}
	next := *w
	next.WrapUp = v
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// loadWrapUps reads the stored wrap-ups (NewHub): an armed one resumes from
// its offset once the worker is seen again.
func (h *Hub) loadWrapUps(ctx context.Context) error {
	h.wrapups = map[string]*wrapUp{}
	rows, err := h.st.WrapUps(ctx)
	if err != nil {
		return err
	}
	for _, r := range rows {
		if !transcript.ValidWrapUpNonce(r.Nonce) || (r.State != proto.WrapUpArmed && r.State != proto.WrapUpNeedsYou) {
			continue
		}
		h.wrapups[r.WorkerID] = &wrapUp{id: r.WorkerID, session: r.Session, nonce: r.Nonce, worktree: r.Worktree,
			armedAt: r.ArmedAt, key: r.Transcript, offset: r.Offset, state: r.State, reason: r.Reason, lines: -1}
	}
	return nil
}

func (h *Hub) saveWrapUp(ctx context.Context, wu *wrapUp) error {
	return h.st.SetWrapUp(ctx, store.WrapUp{WorkerID: wu.id, Session: wu.session, Nonce: wu.nonce, Worktree: wu.worktree,
		ArmedAt: wu.armedAt, Transcript: wu.key, Offset: max(wu.offset, 0), State: wu.state, Reason: wu.reason})
}

// wrapUpReport is the audit-log result of a worker.wrapup.
type wrapUpReport struct {
	Worker     string `json:"worker"`
	Nonce      string `json:"nonce,omitempty"`
	Worktree   string `json:"worktree"`
	Transcript string `json:"transcript,omitempty"`
	Offset     int64  `json:"offset"`
	Queued     bool   `json:"queued,omitempty"`
}

// startWrapUp validates worker.wrapup and arms the wrap-up: the tree is
// checked off the hub goroutine, then the tracker takes the transcript
// offset, then the prompt goes out on the worker's input lane; the reply
// follows the prompt.
func (h *Hub) startWrapUp(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerWrapUpArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	footer := transcript.WrapUpFooter(strings.Repeat("0", 16))
	room := herdr.MaxMessage - len(footer) - 2
	if strings.TrimSpace(a.Prompt) == "" || len(a.Prompt) > room || !herdr.ValidMessage(a.Prompt) {
		return bad("prompt must be 1-%d bytes of UTF-8 without NUL, got %d bytes", room, len(a.Prompt))
	}
	w, f, err := h.fireWorker(a.ID)
	if err != nil {
		return err
	}
	harness := w.AgentKind
	if harness == "" {
		harness = w.Harness
	}
	switch {
	case h.opts.Usage == nil:
		return errors.New("wrap-up needs the agents' transcripts, which this bridge does not read")
	case h.opts.Term == nil:
		return errors.New("laptops are not configured")
	case w.AgentKind == "" || (harness != transcript.Claude && harness != transcript.Codex):
		return fmt.Errorf("%w: %s runs no Claude or Codex agent: its wrap-up result could not be read", errInvalidState, w.Name)
	case w.PaneID == "":
		return fmt.Errorf("%w: %s has no pane", errInvalidState, w.Name)
	case w.Ask != nil:
		return fmt.Errorf("%w: %s waits on its question: answer it first", errInvalidState, w.Name)
	case w.Status == statusBlocked:
		return fmt.Errorf("%w: %s is blocked: answer its question first", errInvalidState, w.Name)
	}
	if err := checkTyped(w.AgentKind, a.Prompt, room, "prompt"); err != nil { // #95
		return err
	}
	if old := h.wrapups[a.ID]; old != nil && old.state != proto.WrapUpNeedsYou {
		return fmt.Errorf("%w: %s is wrapping up already", errBusy, w.Name)
	}
	op, err := h.newFireOp(ctx, w, f, a.Worktree)
	if err != nil {
		return err
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	prev := h.wrapups[a.ID]
	wu := &wrapUp{id: w.ID, session: w.Session, worktree: op.choice, offset: -1, state: wrapArming, checking: true,
		client: c, cmd: cmd, auditID: auditID, by: c.name, lines: -1}
	h.wrapups[w.ID] = wu
	h.log.Info("wrap-up arming", "client", c.name, "req_id", cmd.ReqID, "session", w.Session, "worker", w.ID, "worktree", op.choice)
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		// The first of the checks before a worktree is removed: clean and
		// pushed now (again after CLEAN, and twice in runFire).
		var why string
		var cerr error
		if op.choice != proto.FireKeep {
			why, cerr = h.fireCheck(ctx, op, &fireReport{})
		}
		_ = h.doWait(ctx, func() {
			if h.wrapups[wu.id] != wu {
				return // cancelled meanwhile
			}
			switch {
			case cerr != nil:
				h.failArm(ctx, wu, prev, fmt.Errorf("%w: %v", errFireFailed, cerr))
				return
			case why != "":
				h.failArm(ctx, wu, prev, fmt.Errorf("%w: %s: commit and push first, or keep the worktree", errNotClean, why))
				return
			}
			wu.checking = false
			wu.nonce = randHex(8)
			wu.text = a.Prompt + "\n\n" + transcript.WrapUpFooter(wu.nonce)
			h.kickUsage()
		})
	}()
	return nil
}

// failArm ends an arming that failed: the worker's wrap-up is what it was
// before (prev: a needs_you, or none).
func (h *Hub) failArm(ctx context.Context, wu, prev *wrapUp, err error) {
	if prev != nil {
		h.wrapups[wu.id] = prev
	} else {
		delete(h.wrapups, wu.id)
		if err := h.st.DeleteWrapUp(ctx, wu.id); err != nil { // a needs_you it replaced
			h.log.Error("forgetting the wrap-up failed", "worker", wu.id, "err", err)
		}
	}
	h.publishWrapUp(wu.id)
	h.endArm(ctx, wu, nil, err)
}

// endArm writes the arm's audit row and replies to its command.
func (h *Hub) endArm(ctx context.Context, wu *wrapUp, res *proto.WrapUpResult, err error) {
	if wu.client == nil {
		return
	}
	rep := wrapUpReport{Worker: wu.id, Nonce: wu.nonce, Worktree: wu.worktree, Transcript: wu.key, Offset: max(wu.offset, 0)}
	var data any
	if res != nil {
		rep.Queued, data = res.Queued, *res
	}
	if aerr := h.st.AuditEnd(ctx, wu.auditID, err, rep); aerr != nil {
		h.log.Error("audit log write failed", "err", aerr)
	}
	h.reply(wu.client, wu.cmd, data, err)
	wu.client = nil
}

// wrapUpSeen applies the tracker's look at a wrap-up (hub goroutine).
func (h *Hub) wrapUpSeen(ctx context.Context, u wrapUpdate) {
	wu := h.wrapups[u.id]
	if wu == nil || wu.nonce != u.nonce || wu.checking {
		return
	}
	switch {
	case wu.state == wrapArming:
		h.armed(ctx, wu, u)
		return
	case wu.state != proto.WrapUpArmed || wu.firing:
		return
	case wu.deciding:
		// A CLEAN's check runs: a person stepping in disarms it, and any
		// other line means the turn is not over (the check's end decides
		// again).
		switch {
		case u.state.TookOver:
			h.dropWrapUp(ctx, wu, "a person took over")
		case !u.state.Ended || u.state.Lines != wu.lines:
			wu.lines = -1
		}
		return
	}
	w := h.workers[u.id]
	if w == nil {
		return
	}
	now := h.opts.Now()
	st := u.state
	switch {
	case !u.found || u.key != wu.key || u.offset != wu.offset:
		h.needsYou(ctx, wu, wrapUpGone)
		return
	case st.TookOver:
		h.dropWrapUp(ctx, wu, "a person took over")
		return
	case now.Sub(time.UnixMilli(wu.armedAt)) >= h.opts.WrapUpTimeout:
		h.needsYou(ctx, wu, "no wrap-up result within "+h.opts.WrapUpTimeout.String())
		return
	case !st.Ended:
		wu.lines = -1
		return
	case st.Lines != wu.lines:
		wu.lines, wu.quietAt = st.Lines, now
		return
	}
	// The turn ended and the transcript kept quiet since; herdr must say
	// idle for as long, with no question pending.
	debounce := h.opts.WrapUpDebounce
	if now.Sub(wu.quietAt) < debounce || w.Ask != nil || (w.Status != "idle" && w.Status != "done") ||
		now.UnixMilli()-w.StatusSince < debounce.Milliseconds() {
		return
	}
	switch st.Verdict {
	case transcript.WrapUpClean:
		h.wrapUpClean(ctx, wu)
	case transcript.WrapUpBlocked:
		h.needsYou(ctx, wu, st.Reason)
	default:
		h.needsYou(ctx, wu, wrapUpNoResult)
	}
}

// armed records the offset the tracker took, persists the wrap-up and
// prompts the agent on its input lane.
func (h *Hub) armed(ctx context.Context, wu *wrapUp, u wrapUpdate) {
	if !u.found || u.offset < 0 {
		h.failArm(ctx, wu, nil, fmt.Errorf("%w: the worker's transcript cannot be read, so its wrap-up result could not be seen", errInvalidState))
		return
	}
	wu.key, wu.offset, wu.state, wu.armedAt = u.key, u.offset, proto.WrapUpArmed, h.opts.Now().UnixMilli()
	if err := h.saveWrapUp(ctx, wu); err != nil {
		h.failArm(ctx, wu, nil, err)
		return
	}
	h.publishWrapUp(wu.id)
	h.log.Info("wrap-up armed", "session", wu.session, "worker", wu.id, "offset", wu.offset, "transcript", wu.key)
	id, text := wu.id, wu.text
	h.queueLane(ctx, id, func(ctx context.Context) {
		t, err := query(ctx, h, func() laneTarget {
			w, _, err := h.termWorker(id)
			if err != nil {
				return laneTarget{err: err}
			}
			return laneTarget{session: w.Session, pane: w.PaneID}
		})
		var res any
		if err == nil {
			if err = t.err; err == nil {
				res, err = h.prompt(ctx, proto.WorkerPromptArgs{ID: id, Text: text}, t.session, t.pane)
			}
		}
		if err == nil {
			h.kickUsage()
		}
		_ = h.doWait(ctx, func() {
			if err != nil && h.wrapups[id] == wu {
				h.dropWrapUp(ctx, wu, "its prompt failed")
			}
			var out *proto.WrapUpResult
			if pr, ok := res.(proto.PromptResult); ok {
				out = &proto.WrapUpResult{Queued: pr.Queued}
			}
			h.endArm(ctx, wu, out, err)
		})
	})
}

// needsYou disarms a wrap-up without sending the worker home: its nonce is
// dead, and only an explicit worker.wrapup arms it again.
func (h *Hub) needsYou(ctx context.Context, wu *wrapUp, reason string) {
	reason = strings.TrimSpace(reason)
	if len(reason) > proto.MaxWrapUpReason {
		reason = reason[:proto.MaxWrapUpReason]
		for !utf8.ValidString(reason) {
			reason = reason[:len(reason)-1]
		}
	}
	wu.state, wu.reason, wu.deciding, wu.firing = proto.WrapUpNeedsYou, reason, false, false
	if err := h.saveWrapUp(ctx, wu); err != nil {
		h.log.Error("saving the wrap-up failed", "worker", wu.id, "err", err)
	}
	h.log.Info("wrap-up needs you", "session", wu.session, "worker", wu.id, "reason", reason)
	h.publishWrapUp(wu.id)
}

// dropWrapUp forgets a wrap-up (cancelled, taken over, its prompt failed).
func (h *Hub) dropWrapUp(ctx context.Context, wu *wrapUp, why string) {
	if h.wrapups[wu.id] != wu {
		return
	}
	delete(h.wrapups, wu.id)
	if err := h.st.DeleteWrapUp(ctx, wu.id); err != nil {
		h.log.Error("forgetting the wrap-up failed", "worker", wu.id, "err", err)
	}
	h.log.Info("wrap-up disarmed", "session", wu.session, "worker", wu.id, "why", why)
	h.publishWrapUp(wu.id)
}

// forgetWrapUp drops the wrap-up of a worker that is gone (closed in herdr
// or sent home).
func (h *Hub) forgetWrapUp(ctx context.Context, id string) {
	wu := h.wrapups[id]
	if wu == nil {
		return
	}
	delete(h.wrapups, id)
	if err := h.st.DeleteWrapUp(ctx, id); err != nil {
		h.log.Error("forgetting the wrap-up failed", "worker", id, "err", err)
	}
	if wu.state == wrapArming {
		h.endArm(ctx, wu, nil, fmt.Errorf("%w: %q is gone", errUnknownWorker, id))
	}
}

// tookOver disarms an armed wrap-up when a person prompts or types into the
// worker (worker.prompt, worker.keys): the person took over, also while a
// CLEAN's check runs. One that needs you stays (a reply never re-arms it),
// and one whose send home started goes on.
func (h *Hub) tookOver(ctx context.Context, id string) {
	wu := h.wrapups[id]
	switch {
	case wu == nil || wu.firing || wu.state == proto.WrapUpNeedsYou:
	case wu.state == wrapArming:
		h.failArm(ctx, wu, nil, fmt.Errorf("%w: a prompt or keys came first", errInvalidState))
	default:
		h.dropWrapUp(ctx, wu, "a person took over")
	}
}

// wrapUpClean checks the tree once more and sends the worker home with the
// armed choice: the same runFire as worker.fire, strict.
func (h *Hub) wrapUpClean(ctx context.Context, wu *wrapUp) {
	start := func() (*fireOp, *floorState, error) {
		w, f, err := h.fireWorker(wu.id)
		if err != nil {
			return nil, nil, err
		}
		op, err := h.newFireOp(ctx, w, f, wu.worktree)
		if err != nil {
			return nil, nil, err
		}
		op.strict = true
		op.wrapup = &fireWrapUp{Nonce: wu.nonce, Verdict: transcript.WrapUpClean}
		return op, f, nil
	}
	op, _, err := start()
	switch {
	case errors.Is(err, errBusy):
		return // a floor operation, a hire or a send home: next round
	case err != nil:
		h.needsYou(ctx, wu, "it reported CLEAN but cannot be sent home: "+err.Error())
		return
	}
	wu.deciding = true
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		var why string
		var cerr error
		if op.choice != proto.FireKeep {
			why, cerr = h.fireCheck(ctx, op, &fireReport{})
		}
		_ = h.doWait(ctx, func() {
			if h.wrapups[wu.id] != wu || wu.state != proto.WrapUpArmed {
				return // cancelled or taken over meanwhile
			}
			switch {
			case wu.lines < 0:
				wu.deciding = false // the transcript went on: decide again
				return
			case cerr != nil:
				h.needsYou(ctx, wu, "it reported CLEAN, but reading the git state failed: "+cerr.Error())
				return
			case why != "":
				h.needsYou(ctx, wu, "it reported CLEAN, but the worktree is not clean and pushed any more ("+why+"): nothing was removed")
				return
			}
			op, f, err := start()
			switch {
			case errors.Is(err, errBusy):
				wu.deciding = false
				return
			case err != nil:
				h.needsYou(ctx, wu, "it reported CLEAN but cannot be sent home: "+err.Error())
				return
			}
			by := wu.by
			if by == "" {
				by = "wrapup"
			}
			args, _ := json.Marshal(map[string]string{"id": op.id, "worktree": op.choice, "wrapup": wu.nonce})
			auditID, err := h.st.AuditBegin(ctx, by, proto.CmdWorkerFire, args)
			if err != nil {
				h.needsYou(ctx, wu, "it reported CLEAN, but the audit log could not be written: "+err.Error())
				return
			}
			op.auditID = auditID
			wu.firing = true
			h.beginFire(ctx, op, f)
			h.log.Info("send home after wrap-up started", "session", op.session, "worker", op.id, "worktree", op.choice)
		})
	}()
}

// wrapUpFired ends a wrap-up's send home (hub goroutine, finishFire): a
// failure needs you; on success the worker is gone, and so is its wrap-up.
func (h *Hub) wrapUpFired(ctx context.Context, op *fireOp, err error) {
	wu := h.wrapups[op.id]
	if wu == nil || wu.nonce != op.wrapup.Nonce {
		return
	}
	if err != nil {
		h.needsYou(ctx, wu, "it reported CLEAN, but sending it home failed: "+err.Error())
		return
	}
	h.forgetWrapUp(ctx, op.id)
}

// startWrapUpCancel answers worker.wrapup.cancel: the wrap-up goes, armed or
// needing you; not once its send home started.
func (h *Hub) startWrapUpCancel(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	w := h.workers[a.ID]
	if w == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
	}
	wu := h.wrapups[a.ID]
	switch {
	case wu == nil:
		return fmt.Errorf("%w: %s is not wrapping up", errInvalidState, w.Name)
	case wu.firing:
		return fmt.Errorf("%w: %s reported CLEAN and is being sent home", errBusy, w.Name)
	case wu.state == wrapArming:
		h.failArm(ctx, wu, nil, fmt.Errorf("%w: the wrap-up was cancelled", errInvalidState))
	default:
		h.dropWrapUp(ctx, wu, "cancelled")
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}
