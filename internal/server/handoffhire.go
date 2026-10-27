package server

// #219: Hire with handoff in the background. worker.handoff in mode agent
// (#224) or llm (#9) may carry the hire that follows the filing (Hire):
// checked as worker.hire checks its args before the ack (the task with room
// for the path, the desk, the caps, the task's own secrets review), the
// desk held for the op, then the handoff starts as without it. Once it is
// filed the bridge hires, on the hub goroutine and exactly once: the first
// prompt is #198's ("First read the handoff here: <path> and then follow
// these instructions:" and the task), through the internal hire entry
// (startInternalHire, worker.hire's checks and audit, answered to nobody),
// and only after a hire whose prompt went, the send home asked for. A
// handoff that fails, times out or is cancelled, a source worker gone, a
// floor gone: nobody is hired.
//
// The pending hires are the bridge's memory (handoffHireState): the record
// clients see (World.HandoffHires, handoff_hire.upsert / .removed; never the
// task, the instruction, a secret or review data), the protected task and
// its review, the desk hold. The agent request or LLM job keeps a marker
// (store.HandoffHireMarker; once the hire ended, how), so a restarted
// bridge says the hire was interrupted, a resumed request sends nobody
// home on its own, and a replay of the op is still compared; it never
// hires for an op from before the restart, and holds no desk for it.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

const (
	// DefaultHandoffHireKeep is how long an ended pending hire stays in the
	// world after it ended.
	DefaultHandoffHireKeep = 10 * time.Minute
	// handoffHireEnded is how many ended pending hires the world keeps.
	handoffHireEnded = 50
	// handoffPathReserve is the room a task keeps for the filed handoff's
	// path before it is known (the game's HANDOFF_PATH_RESERVE).
	handoffPathReserve = 1024
	// handoffHireClient is who the audit log says hired when the hire's
	// client is not known (an interrupted one's).
	handoffHireClient = "bridge:handoff"
)

var (
	errHireOtherArgs  = bad("This request was already sent with other settings.")
	handoffHireOrigin = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
	// The blank lines hireWithHandoffTask drops before and after the task
	// (game/src/world/handoff.ts).
	leadBlank  = regexp.MustCompile(`^(?:[ \t]*\r?\n)+`)
	trailBlank = regexp.MustCompile(`(?:\r?\n[ \t]*)+$`)
)

// hireWithHandoffTask is #198's first task of "Hire with handoff": the
// filed handoff's final path as it is, then the task with only its blank
// lines before and after dropped (game/src/world/handoff.ts, the same test
// vectors).
func hireWithHandoffTask(path, task string) string {
	return handoffPathLine(path) + handoffTaskBody(task)
}

// handoffPathLine is the first task's line with the path, and the blank
// line after it.
func handoffPathLine(path string) string {
	return "First read the handoff here: " + path + " and then follow these instructions:\n\n"
}

// handoffTaskBody is the task without its blank lines before and after.
func handoffTaskBody(task string) string {
	return trailBlank.ReplaceAllString(leadBlank.ReplaceAllString(task, ""), "")
}

// handoffHire is a pending handoff hire (hub goroutine): the record clients
// see, the identity of the request that made it (replays), the hire's args
// (Prompt: the task after its review, without the path line; no review
// fields), its review (nil: none) and the pending owners of its task's
// files (its review's, a hand-over's), who asked, and whether the hire
// began (launched: the desk is the hire's now, no longer the hold's).
type handoffHire struct {
	rec      proto.HandoffHire
	hash     string
	args     proto.WorkerHireArgs
	sec      *hireSecrets
	owners   []string
	by       string
	launched bool
}

// holds reports whether r holds its desk: waiting, or hiring before the
// hire took it.
func (r *handoffHire) holds() bool {
	return r.rec.State == proto.HandoffHireWaiting || (r.rec.State == proto.HandoffHireHiring && !r.launched)
}

// marker is what r's request or job keeps of it: once it ended, how.
func (r *handoffHire) marker() *store.HandoffHireMarker {
	m := &store.HandoffHireMarker{Floor: r.rec.Floor, Desk: r.rec.DeskIndex, Label: r.rec.Label, Harness: r.rec.Harness,
		Model: r.rec.Model, Effort: r.rec.Effort, Origin: r.rec.Origin, WorkerName: r.rec.WorkerName, SendHome: r.rec.SendHome,
		StartedAt: r.rec.StartedAt}
	if r.rec.Ended() {
		m.State, m.Code, m.Reason = r.rec.State, r.rec.Code, r.rec.Reason
	} else {
		m.Owners = r.owners
	}
	return m
}

// markedHire is the record a marker stands for, of op's request or job
// (mode, source worker): as it ended, else waiting.
func markedHire(op, mode, worker string, m store.HandoffHireMarker) proto.HandoffHire {
	r := proto.HandoffHire{Op: op, Worker: worker, WorkerName: m.WorkerName, Mode: mode, Floor: m.Floor, DeskIndex: m.Desk,
		Label: m.Label, Harness: m.Harness, Model: m.Model, Effort: m.Effort, Origin: m.Origin, State: proto.HandoffHireWaiting,
		SendHome: m.SendHome, StartedAt: m.StartedAt}
	if m.Ended() {
		r.State, r.Code, r.Reason = m.State, m.Code, m.Reason
	}
	return r
}

// sameHire reports whether a asks for the hire rec is, as far as what is
// kept of it tells (a restored record, or a pruned one's marker: no
// request identity): the source, the mode, the send home, the desk and
// the hire's settings.
func sameHire(rec proto.HandoffHire, a proto.WorkerHandoffArgs) bool {
	if a.Hire == nil || a.Hire.DeskIndex == nil {
		return false
	}
	x := a.Hire
	return rec.Worker == a.Worker && rec.Mode == a.Mode && rec.SendHome == a.SendHome && rec.Floor == floorArg(x.Floor, x.Session) &&
		rec.DeskIndex == *x.DeskIndex && rec.Label == x.Label && rec.Harness == x.Harness && rec.Model == x.Model &&
		rec.Effort == x.Effort && rec.Origin == x.Origin
}

// handoffHireState is the hub's part (hub goroutine): the records, and the
// pending owners of the task files of the hires a restart interrupted
// (released once the files are open, Run).
type handoffHireState struct {
	byOp    map[string]*handoffHire
	orphans []string
}

// deskHeldError refuses a hire into a desk a pending handoff hire holds,
// in the words the game shows.
type deskHeldError struct{ msg string }

func (e *deskHeldError) Error() string { return e.msg }
func (e *deskHeldError) Unwrap() error { return errDeskTaken }

// deskHold is the pending hire holding floor's desk (nil: none).
func (h *Hub) deskHold(floor string, desk int) *handoffHire {
	for _, r := range h.hh.byOp {
		if r.holds() && r.rec.Floor == floor && r.rec.DeskIndex == desk {
			return r
		}
	}
	return nil
}

// heldDesks marks floor's held desks in used: a newcomer is seated at
// none of them, a schedule picks none.
func (h *Hub) heldDesks(floor string, used map[int]bool) {
	for _, r := range h.hh.byOp {
		if r.holds() && r.rec.Floor == floor {
			used[r.rec.DeskIndex] = true
		}
	}
}

// deskHeld refuses a hire into a held desk (nil: not held).
func (h *Hub) deskHeld(floor string, desk int) error {
	if r := h.deskHold(floor, desk); r != nil {
		return &deskHeldError{fmt.Sprintf("Desk %d is held for %s's handoff hire.", desk+1, r.rec.WorkerName)}
	}
	return nil
}

// handoffHiresView is the world's list: oldest first.
func (h *Hub) handoffHiresView() []proto.HandoffHire {
	out := make([]proto.HandoffHire, 0, len(h.hh.byOp))
	for _, r := range h.hh.byOp {
		out = append(out, r.rec)
	}
	slices.SortFunc(out, func(a, b proto.HandoffHire) int {
		if a.StartedAt != b.StartedAt {
			return int(a.StartedAt - b.StartedAt)
		}
		return strings.Compare(a.Op, b.Op)
	})
	return out
}

// handoffHireView is op's record (nil: none), for an ack.
func (h *Hub) handoffHireView(op string) *proto.HandoffHire {
	r := h.hh.byOp[op]
	if r == nil {
		return nil
	}
	v := r.rec
	return &v
}

func (h *Hub) publishHandoffHire(r *handoffHire) {
	v := r.rec
	h.emit(proto.Event{T: proto.EvHandoffHireUpsert, HandoffHire: &v})
}

// handoffHireHash identifies a request with a hire (a replay must match it;
// never stored): its args, the reviews by their decisions (not the scan's
// revision: a scan again decides the same), the hand-over by its token.
func handoffHireHash(a proto.WorkerHandoffArgs) string {
	decisions := func(r *proto.SecretsReview) []proto.SecretDecision {
		if r == nil {
			return nil
		}
		return r.Decisions
	}
	var hire any
	if a.Hire != nil {
		x := *a.Hire
		x.Floor, x.Session = floorArg(x.Floor, x.Session), ""
		x.Secrets = nil
		hire = []any{x, decisions(a.Hire.Secrets)}
	}
	b, _ := json.Marshal([]any{a.Worker, a.Mode, a.Session, a.Candidate, a.Revision, strings.TrimSpace(a.Instruction), a.SendHome, hire,
		decisions(a.Secrets)})
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// handoffOpHire reports whether op names an agent request or an LLM job
// (known), and the record its marker stands for (nil: it had no hire).
func (h *Hub) handoffOpHire(ctx context.Context, op string) (rec *proto.HandoffHire, known bool, err error) {
	of := func(mode, worker string, m *store.HandoffHireMarker) (*proto.HandoffHire, bool, error) {
		if m == nil {
			return nil, true, nil
		}
		r := markedHire(op, mode, worker, *m)
		return &r, true, nil
	}
	if ah := h.ah.byOp[op]; ah != nil {
		return of(proto.HandoffModeAgent, ah.req.WorkerID, ah.req.Hire)
	}
	if h.ho.svc != nil {
		if r, err := h.st.HandoffRequestByOp(ctx, op); err == nil {
			return of(proto.HandoffModeAgent, r.WorkerID, r.Hire)
		} else if !errors.Is(err, store.ErrNotFound) {
			return nil, false, err
		}
	}
	if j, err := h.llmJobOf(ctx, op); err == nil {
		return of(proto.HandoffModeLLM, j.row.WorkerID, j.row.Hire)
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, false, err
	}
	return nil, false, nil
}

// handoffHireReplay answers a worker.handoff whose op is known (replay
// true): the same request with a pending hire answers it as without one
// (its ack carries the record), another one is refused. A record restored
// after a restart, or an op whose record was pruned, has no identity of
// its request: what is kept of its hire is compared. A request without a
// hire of an op that had none is not this one's (false).
func (h *Hub) handoffHireReplay(ctx context.Context, a proto.WorkerHandoffArgs) (replay bool, err error) {
	if r := h.hh.byOp[a.Op]; r != nil {
		if r.hash == "" && sameHire(r.rec, a) || r.hash != "" && r.hash == handoffHireHash(a) {
			return true, nil
		}
		return true, errHireOtherArgs
	}
	if a.Hire == nil {
		return false, nil
	}
	rec, known, err := h.handoffOpHire(ctx, a.Op)
	switch {
	case err != nil:
		return true, err
	case !known:
		return false, nil
	case rec == nil || !sameHire(*rec, a):
		return true, errHireOtherArgs
	}
	return true, nil
}

// answerHandoffHireReplay answers the same request again (its identity
// checked): its request or job as it is, existing, with its pending hire;
// nothing is sent, reviewed or hired again.
func (h *Hub) answerHandoffHireReplay(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffArgs) error {
	if a.Mode == proto.HandoffModeAgent {
		return h.startHandoffPlain(ctx, c, cmd, a, nil) // its op is known: answered as it is
	}
	j, err := h.llmJobOf(ctx, a.Op)
	if err != nil {
		return err
	}
	if j.row.WorkerID != a.Worker {
		return errHireOtherArgs
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, proto.WorkerHandoffJobResult{Job: j.view(), Existing: true, HandoffHire: h.handoffHireView(a.Op)}, nil)
	return nil
}

// startHandoffHire is worker.handoff with a hire (or a replay of an op that
// had one), modes agent and llm: the replay answered; else the hire's args
// checked (an asleep virtual floor woken first, as worker.hire does), then
// accepted.
func (h *Hub) startHandoffHire(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffArgs) error {
	if !handoffOp.MatchString(a.Op) {
		return bad("op must be 1–%d characters of A-Z, a-z, 0-9, _ and -", proto.MaxHandoffOp)
	}
	if replay, err := h.handoffHireReplay(ctx, a); err != nil {
		return err
	} else if replay {
		return h.answerHandoffHireReplay(ctx, c, cmd, a)
	}
	hire := &a.Hire.WorkerHireArgs
	hire.Floor = floorArg(hire.Floor, hire.Session)
	switch {
	case a.Hire.Origin != "" && !handoffHireOrigin.MatchString(a.Hire.Origin):
		return bad("hire.origin must be 1–%d characters of A-Z, a-z, 0-9, _ and -", proto.MaxHandoffHireOrigin)
	case strings.TrimSpace(hire.Prompt) == "":
		return bad("hire.prompt (the task) is required")
	case h.workers[a.Worker] == nil:
		return fmt.Errorf("%w: %q", errUnknownWorker, a.Worker)
	}
	if err := h.hireShape(handoffHireArgs(*hire, strings.Repeat("x", handoffPathReserve))); err != nil {
		return err
	}
	if waking, err := h.wakeForHire(ctx, c, cmd, hire.Floor, func(ctx context.Context) error {
		// The same request may have been accepted while the floor woke.
		if replay, err := h.handoffHireReplay(ctx, a); err != nil {
			return err
		} else if replay {
			return h.answerHandoffHireReplay(ctx, c, cmd, a)
		}
		return h.acceptHandoffHire(ctx, c, cmd, a)
	}); waking || err != nil {
		return err
	}
	return h.acceptHandoffHire(ctx, c, cmd, a)
}

// handoffHireArgs is a hire's args with its first prompt for the handoff
// at path, the herdr hiring instructions after it when asked (what
// beginHire checks).
func handoffHireArgs(a proto.WorkerHireArgs, path string) proto.WorkerHireArgs {
	a.Prompt = hireWithHandoffTask(path, a.Prompt)
	return withHireLines(a)
}

// handoffHireChecks are acceptance's checks that need the floor (hub
// goroutine): beginHire's, the caps counting the other holds and not the
// source when it goes home after.
func (h *Hub) handoffHireChecks(a proto.WorkerHandoffArgs) error {
	hire := a.Hire.WorkerHireArgs
	f, err := h.hireFloor(hire.Floor)
	if err != nil {
		return err
	}
	if hire.Label != "" && !herdr.ValidLabel(hire.Label) {
		return bad("label must be 1-%d bytes without control characters, not starting with \"-\"", herdr.MaxLabel)
	}
	if _, err := h.hireCwd(hire.Floor, f, hire.Cwd); err != nil {
		return err
	}
	if hire.Worktree && h.opts.Git == nil {
		return errors.New("worktree hires are not configured")
	}
	if err := h.hireRoom(hire.Floor, f, *hire.DeskIndex); err != nil {
		return err
	}
	leaving := ""
	if a.SendHome {
		leaving = a.Worker
	}
	if err := h.checkCapsWith(hire.Floor, leaving, true); err != nil {
		return err
	}
	if h.opts.Hire == nil {
		return errors.New("hiring is not configured")
	}
	return nil
}

// handoffGate is what the gate made of a request with a hire: the
// instruction's protected text (instr: there is one to protect) and the
// task's review.
type handoffGate struct {
	p     protected
	instr bool
	sec   *hireSecrets
}

// acceptHandoffHire checks a request with a hire (hub goroutine), runs the
// gate over the instruction and the task when the switch is on (#108), and
// starts the handoff with its pending hire; the checks run again after the
// gate, in the step that holds the desk.
func (h *Hub) acceptHandoffHire(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHandoffArgs) error {
	if err := h.handoffHireChecks(a); err != nil {
		return err
	}
	hire := a.Hire.WorkerHireArgs
	reviewed := a.Secrets != nil || hire.Secrets != nil || hire.SecretsPending != ""
	if !h.ps.enabled {
		if reviewed {
			return h.stillOn()
		}
		return h.startHandoffPlain(ctx, c, cmd, a, h.newHandoffHire(c, a, nil))
	}
	instr := strings.TrimSpace(a.Instruction) != ""
	if !instr && a.Secrets != nil {
		return fmt.Errorf("%w: a review needs the instruction it is of", errSecretsReviewRequired)
	}
	if instr {
		if err := scannable(a.Instruction, "instruction"); err != nil {
			return err
		}
	}
	if err := scannable(hire.Prompt, "hire.prompt"); err != nil {
		return err
	}
	rev, owner := h.ps.rev, secretfiles.Worker(a.Worker)
	var tok secretPending
	if hire.SecretsPending != "" {
		var err error
		if tok, err = h.pendingFor(hire.SecretsPending, rev, "", true); err != nil {
			return err
		}
	}
	undo := func(ctx context.Context, g handoffGate) {
		if g.instr {
			h.unprotect(ctx, g.p)
		}
		h.dropHireSecrets(ctx, g.sec)
	}
	startGated(h, ctx, c, cmd, rev, func(ctx context.Context) (handoffGate, error) {
		g := handoffGate{instr: instr, sec: &hireSecrets{rev: rev, token: hire.SecretsPending}}
		if instr {
			p, err := h.protectText(ctx, rev, owner, time.Time{}, a.Instruction, a.Secrets)
			if err != nil {
				return g, err
			}
			g.p = p
		}
		if hire.Secrets == nil && tok.reviewed(hire.Prompt) {
			return g, nil // hire.interpret's task as it answered it
		}
		g.sec.owner = secretfiles.NewPending()
		ps, err := h.protectFields(ctx, rev, g.sec.owner, h.opts.Now().Add(h.opts.SecretPendingTTL),
			[]secretField{{path: "hire.prompt", text: hire.Prompt, review: hire.Secrets}})
		if err != nil {
			if instr {
				h.unprotect(ctx, g.p)
			}
			return g, err
		}
		g.sec.ps = ps
		return g, nil
	}, undo, func(ctx context.Context, g handoffGate) error {
		// The hub moved on while the gate ran: the op, the desk and the
		// caps again, in the step that holds the desk. The same request
		// accepted meanwhile (sent twice at once) answers this one; what
		// this gate made goes.
		if replay, err := h.handoffHireReplay(ctx, a); err != nil {
			return err
		} else if replay {
			if err := h.answerHandoffHireReplay(ctx, c, cmd, a); err != nil {
				return err
			}
			h.wg.Add(1)
			go func() {
				defer h.wg.Done()
				undo(context.WithoutCancel(ctx), g)
			}()
			return nil
		}
		if err := h.handoffHireChecks(a); err != nil {
			return err
		}
		if g.sec.token != "" {
			if err := h.pendingHiring(g.sec.token, true); err != nil { // held for this hire while it waits
				return err
			}
			g.sec.hiring = true
		}
		r := h.newHandoffHire(c, a, g.sec)
		if !g.instr {
			return h.startHandoffPlain(ctx, c, cmd, a, r)
		}
		b := a
		b.Instruction, b.Secrets = g.p.text, nil
		return h.startHandoffProtected(ctx, c, cmd, b, rev, g.p, owner, r)
	})
	return nil
}

// newHandoffHire is a request's pending hire, not registered yet (the
// handoff's start registers it when it creates its request or job): sec is
// its task's review (the task in it protected), else the task as given.
func (h *Hub) newHandoffHire(c *Client, a proto.WorkerHandoffArgs, sec *hireSecrets) *handoffHire {
	hire := a.Hire.WorkerHireArgs
	if sec != nil && len(sec.ps) > 0 {
		hire.Prompt = sec.ps[0].text
	}
	hire.Secrets, hire.SecretsPending = nil, ""
	name := a.Worker
	if w := h.workers[a.Worker]; w != nil {
		name = w.Name
	}
	var owners []string
	if sec != nil {
		if sec.owner.Kind != "" && protectedCount(sec.ps) > 0 {
			owners = append(owners, sec.owner.ID)
		}
		if o, ok := h.pendingOwner(sec.token); ok && sec.token != "" {
			owners = append(owners, o.ID)
		}
	}
	return &handoffHire{hash: handoffHireHash(a), args: hire, sec: sec, owners: owners, by: c.name,
		rec: proto.HandoffHire{Op: a.Op, Worker: a.Worker, WorkerName: name, Mode: a.Mode, Floor: hire.Floor, DeskIndex: *hire.DeskIndex,
			Label: hire.Label, Harness: hire.Harness, Model: hire.Model, Effort: hire.Effort, Origin: a.Hire.Origin,
			State: proto.HandoffHireWaiting, SendHome: a.SendHome, StartedAt: h.opts.Now().UnixMilli()}}
}

// addHandoffHire registers r as its request or job is created (hub
// goroutine): waiting, its desk held.
func (h *Hub) addHandoffHire(r *handoffHire) {
	h.hh.byOp[r.rec.Op] = r
	h.publishHandoffHire(r)
	h.syncLayout() // the floor grows to the held desk
	h.log.Info("handoff hire waiting", "op", r.rec.Op, "worker", r.rec.Worker, "floor", r.rec.Floor, "desk", r.rec.DeskIndex)
}

// endHandoffHire ends r (hub goroutine): state with code and reason, its
// task's review undone unless the hire took it, its marker saying how it
// ended, the hold released.
func (h *Hub) endHandoffHire(ctx context.Context, r *handoffHire, state, code, reason string) {
	if r.rec.Ended() {
		return
	}
	held := r.holds()
	r.rec.State, r.rec.Code, r.rec.Reason, r.rec.EndedAt = state, code, clipReason(reason), h.opts.Now().UnixMilli()
	if state != proto.HandoffHireHired {
		h.skipHandoffHome(r, nil) // asked for, nobody hired: the source stays
	}
	if !r.launched {
		h.dropHireSecrets(ctx, r.sec)
	}
	if state != proto.HandoffHireHired && r.sec != nil && r.sec.token != "" {
		h.dropPending(r.sec.token) // a hand-over goes with it (§1.3), not back to pending
	}
	r.sec = nil
	r.args.Prompt = "" // the task is not kept past its end
	h.endHandoffMarker(ctx, r)
	h.publishHandoffHire(r)
	if held {
		h.syncLayout()
	}
	h.log.Info("handoff hire ended", "op", r.rec.Op, "state", state, "code", code, "hired", r.rec.Hired)
	h.trimHandoffHires()
}

// endHandoffMarker says in r's marker how it ended: stored, and on its
// request or job in memory (an agent request's row may not be stored yet:
// it is inserted with this marker).
func (h *Hub) endHandoffMarker(ctx context.Context, r *handoffHire) {
	m := r.marker()
	if ah := h.ah.byOp[r.rec.Op]; ah != nil && ah.hire {
		ah.req.Hire = m
	}
	for _, j := range h.llm.byWorker {
		if j.row.Op == r.rec.Op && j.hire {
			j.row.Hire = m
		}
	}
	if err := h.st.EndHandoffHire(ctx, r.rec.Op, *m); err != nil {
		h.log.Error("saving the handoff hire's end failed", "op", r.rec.Op, "err", err)
	}
}

// clipReason keeps a reason to a line's worth.
func clipReason(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > proto.MaxWrapUpReason {
		s = s[:proto.MaxWrapUpReason]
		for !utf8.ValidString(s) {
			s = s[:len(s)-1]
		}
	}
	return s
}

// because is a sentence's end from a reason: after a colon, its own final
// stop dropped.
func because(why string) string {
	return ": " + strings.TrimRight(strings.TrimSpace(why), ".") + "."
}

// handoffHireFailed ends op's waiting hire when its handoff ended without
// a file (hub goroutine): code is how (handoff_failed, timeout, cancelled,
// source_gone), why the handoff's reason.
func (h *Hub) handoffHireFailed(ctx context.Context, op, code, why string) {
	r := h.hh.byOp[op]
	if r == nil || r.rec.State != proto.HandoffHireWaiting {
		return
	}
	switch code {
	case proto.HandoffHireCancelledCode:
		h.endHandoffHire(ctx, r, proto.HandoffHireCancelled, code, "The handoff request was cancelled; nobody was hired.")
	case proto.HandoffHireSourceGone:
		h.endHandoffHire(ctx, r, proto.HandoffHireFailed, code, r.rec.WorkerName+" left before the handoff was filed; nobody was hired.")
	default:
		h.endHandoffHire(ctx, r, proto.HandoffHireFailed, code, "Nobody was hired, the handoff was not filed"+because(why))
	}
}

// handoffHireCancel ends op's waiting hire with its handoff's cancel (hub
// goroutine, in the cancel's own step).
func (h *Hub) handoffHireCancel(ctx context.Context, op string) {
	h.handoffHireFailed(ctx, op, proto.HandoffHireCancelledCode, "")
}

// handoffHireFiled takes over what follows op's filing (hub goroutine;
// handled false: op has no hire, the send home goes on as before): a
// waiting hire hires now, once; an ended one only learns where the handoff
// is, and the send home is skipped. marked: the request or job had a hire
// (its record may be gone).
func (h *Hub) handoffHireFiled(ctx context.Context, op string, marked bool, filed store.Handoff,
	sendHome func(result, why string)) (handled bool) {
	r := h.hh.byOp[op]
	if r == nil { // its record left the world: it ended
		if marked {
			if sendHome != nil {
				sendHome(proto.HandoffSendSkipped, "The new agent was not hired; the worker stays.")
			}
		}
		return marked
	}
	switch r.rec.State {
	case proto.HandoffHireWaiting:
	case proto.HandoffHireFailed, proto.HandoffHireCancelled: // it ended first: filed, not hired
		if r.rec.Path == "" {
			r.rec.Handoff, r.rec.Path = filed.ID, filed.Path
		}
		h.skipHandoffHome(r, sendHome)
		h.publishHandoffHire(r)
		return true
	default: // hiring or hired already: never twice
		return true
	}
	r.rec.State, r.rec.Handoff, r.rec.Path = proto.HandoffHireHiring, filed.ID, filed.Path
	h.publishHandoffHire(r)
	h.launchHandoffHire(ctx, r, sendHome)
	return true
}

// skipHandoffHome records the send home skipped (asked, no hire); sendHome
// (nil: none yet, before the filing) tells the request or job.
func (h *Hub) skipHandoffHome(r *handoffHire, sendHome func(result, why string)) {
	if !r.rec.SendHome {
		return
	}
	why := "The new agent was not hired; " + r.rec.WorkerName + " stays."
	r.rec.SendHomeResult, r.rec.SendHomeReason = proto.HandoffSendSkipped, why
	if sendHome != nil {
		sendHome(proto.HandoffSendSkipped, why)
	}
}

// launchHandoffHire hires for r, its handoff filed (hub goroutine, in the
// step that saw it filed): the task's review, the composed task's size, the
// desk and the caps checked again (the source not counted when it goes
// home after), then the hire, whose desk the hold becomes in this step.
// A refusal ends r failed, with the handoff's path: it stays filed.
func (h *Hub) launchHandoffHire(ctx context.Context, r *handoffHire, sendHome func(result, why string)) {
	fail := func(code, why string) {
		h.skipHandoffHome(r, sendHome)
		h.endHandoffHire(ctx, r, proto.HandoffHireFailed, code, why)
	}
	a := r.args
	var rev *promptsecret.Reviewer
	if r.sec != nil {
		rev = r.sec.rev
	}
	if err := h.reviewHolds(rev, a.Prompt); err != nil {
		fail(proto.HandoffHireSecretsStale, "The task's secrets review no longer holds (the setting changed or a protected file was revoked): review the task again and hire from the handoff.")
		return
	}
	full := handoffHireArgs(a, r.rec.Path)
	if !herdr.ValidPrompt(full.Prompt) || checkTyped(a.Harness, full.Prompt, herdr.MaxPrompt, "prompt") != nil {
		fail(proto.HandoffHireTooLong, fmt.Sprintf("The task with the handoff's path is %d bytes, more than a first prompt may have (%d): shorten the task.",
			len(full.Prompt), herdr.MaxPrompt))
		return
	}
	// The task alone is the user's (#39: translated for the harness); the
	// path line and the herdr lines go as they are.
	line, body := handoffPathLine(r.rec.Path), handoffTaskBody(a.Prompt)
	a.Prompt = line + body
	lines := strings.TrimPrefix(full.Prompt, a.Prompt)
	compose := func(tr func(string) string) string { return line + tr(body) + lines }
	leaving := ""
	if r.rec.SendHome {
		leaving = r.rec.Worker
	}
	if r.sec != nil && r.sec.hiring { // the hire takes the hand-over the hold kept
		_ = h.pendingHiring(r.sec.token, false)
		r.sec.hiring = false
	}
	r.launched = true
	cmd := proto.Command{T: proto.CmdWorkerHire, ReqID: "handoff:" + r.rec.Op, Args: mustJSON(struct {
		Handoff string `json:"handoff"`
		proto.WorkerHireArgs
	}{r.rec.Op, a})}
	watch := &hireWatch{leaving: leaving, settled: func(ctx context.Context, id string, res *proto.HireResult, delivery string, err error) {
		h.handoffHireSettled(ctx, r, id, res, delivery, err, sendHome)
	}}
	if err := h.beginInternalHire(ctx, r.by, cmd, full, compose, watch, r.sec); err != nil {
		r.launched = false
		code := proto.HandoffHireHireFailed
		switch {
		case errors.Is(err, errDeskTaken):
			code = proto.HandoffHireDeskTaken
		case errors.Is(err, errCapacity):
			code = proto.HandoffHireCapacity
		}
		fail(code, "The new agent was not hired"+because(err.Error()))
		return
	}
	h.log.Info("handoff hire launched", "op", r.rec.Op, "floor", r.rec.Floor, "desk", r.rec.DeskIndex)
}

// handoffHireSettled ends r with its hire (hub goroutine): hired (the new
// worker, how its first prompt went; then the send home asked for, only
// when the prompt went) or failed with the hire's error. An uncertain
// delivery is reported, never retried.
func (h *Hub) handoffHireSettled(ctx context.Context, r *handoffHire, id string, res *proto.HireResult, delivery string, err error,
	sendHome func(result, why string)) {
	if r.rec.State != proto.HandoffHireHiring {
		return
	}
	r.rec.Delivery = delivery
	if err != nil || res == nil {
		why := "the hire failed"
		if err != nil {
			why = err.Error()
		}
		h.skipHandoffHome(r, sendHome)
		code := proto.HandoffHireHireFailed
		if errors.Is(err, errDeskTaken) {
			code = proto.HandoffHireDeskTaken
		}
		h.endHandoffHire(ctx, r, proto.HandoffHireFailed, code, "The new agent was not hired"+because(why))
		return
	}
	r.rec.Hired, r.rec.Prompted, r.rec.Delivery, r.rec.PromptError = res.ID, res.Prompted, res.Delivery, res.PromptError
	if r.rec.SendHome {
		switch {
		case res.Prompted == nil || !*res.Prompted:
			why := "The new agent did not get its task; " + r.rec.WorkerName + " stays."
			r.rec.SendHomeResult, r.rec.SendHomeReason = proto.HandoffSendSkipped, why
		default:
			r.rec.SendHomeResult, r.rec.SendHomeReason = h.handoffSendHome(ctx, r.by, r.rec.Worker, r.rec.Handoff)
		}
		if sendHome != nil {
			sendHome(r.rec.SendHomeResult, r.rec.SendHomeReason)
		}
	}
	h.endHandoffHire(ctx, r, proto.HandoffHireHired, "", "")
}

// handoffHireFloorGone fails the hires that hold a desk on floors (gone):
// a later filing does not hire.
func (h *Hub) handoffHireFloorGone(ctx context.Context, floors ...string) {
	for _, op := range h.sortedHandoffHires() {
		r := h.hh.byOp[op]
		if r.holds() && slices.Contains(floors, r.rec.Floor) {
			h.endHandoffHire(ctx, r, proto.HandoffHireFailed, proto.HandoffHireFloorGone,
				fmt.Sprintf("The floor of Desk %d is gone; nobody was hired.", r.rec.DeskIndex+1))
		}
	}
}

// handoffHireSourcesGone fails the waiting hires of the agent requests
// whose source sits on floors (gone with their session): the request
// cannot go on without its agent (an LLM job still files, and hires).
func (h *Hub) handoffHireSourcesGone(ctx context.Context, floors ...string) {
	for _, op := range h.sortedHandoffHires() {
		r := h.hh.byOp[op]
		if w := h.workers[r.rec.Worker]; w != nil && r.rec.Mode == proto.HandoffModeAgent && slices.Contains(floors, w.Floor) {
			h.handoffHireFailed(ctx, op, proto.HandoffHireSourceGone, "")
		}
	}
}

// releaseInterruptedSecrets releases the task files of the hires a restart
// interrupted (Run, the files open), off the hub goroutine.
func (h *Hub) releaseInterruptedSecrets(ctx context.Context) {
	owners := h.hh.orphans
	h.hh.orphans = nil
	if len(owners) == 0 {
		return
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		for _, id := range owners {
			h.releaseOwner(ctx, secretfiles.Owner{Kind: secretfiles.OwnerPending, ID: id})
		}
	}()
}

func (h *Hub) sortedHandoffHires() []string {
	ops := make([]string, 0, len(h.hh.byOp))
	for op := range h.hh.byOp {
		ops = append(ops, op)
	}
	slices.Sort(ops)
	return ops
}

// pruneHandoffHires removes the ended records older than the keep (hub
// goroutine, every second).
func (h *Hub) pruneHandoffHires() {
	cut := h.opts.Now().Add(-h.opts.HandoffHireKeep).UnixMilli()
	for _, op := range h.sortedHandoffHires() {
		if r := h.hh.byOp[op]; r.rec.Ended() && r.rec.EndedAt <= cut {
			h.removeHandoffHire(op)
		}
	}
}

// trimHandoffHires keeps the newest handoffHireEnded ended records.
func (h *Hub) trimHandoffHires() {
	var ended []*handoffHire
	for _, r := range h.hh.byOp {
		if r.rec.Ended() {
			ended = append(ended, r)
		}
	}
	if len(ended) <= handoffHireEnded {
		return
	}
	slices.SortFunc(ended, func(a, b *handoffHire) int {
		if a.rec.EndedAt != b.rec.EndedAt {
			return int(a.rec.EndedAt - b.rec.EndedAt)
		}
		return strings.Compare(a.rec.Op, b.rec.Op)
	})
	for _, r := range ended[:len(ended)-handoffHireEnded] {
		h.removeHandoffHire(r.rec.Op)
	}
}

func (h *Hub) removeHandoffHire(op string) {
	delete(h.hh.byOp, op)
	h.emit(proto.Event{T: proto.EvHandoffHireRemoved, Op: op})
}

// loadHandoffHires reads the hires a restart interrupted (NewHub, after the
// agent requests and LLM jobs): each request or job whose hire had not
// ended is published as failed, interrupted, with its handoff's path when
// it was filed, and its marker says so; nothing is hired for it and no
// desk held. A pending agent request, which resumes, is published as its
// hire ended (interrupted by an earlier restart too) until it settles: its
// filing then sets the path and sends nobody home.
func (h *Hub) loadHandoffHires(ctx context.Context) error {
	rows, err := h.st.HandoffHireRows(ctx)
	if err != nil {
		return err
	}
	now := h.opts.Now().UnixMilli()
	for _, row := range rows {
		m := row.Marker
		r := &handoffHire{by: handoffHireClient, rec: markedHire(row.Op, row.Mode, row.WorkerID, m)}
		r.rec.EndedAt = now
		if !m.Ended() {
			h.hh.orphans = append(h.hh.orphans, m.Owners...)
			r.rec.State, r.rec.Code = proto.HandoffHireFailed, proto.HandoffHireInterrupted
			r.rec.Reason = "The bridge restarted while the handoff was being written; nobody was hired: hire again from the handoff once it is filed."
			if row.HandoffID != 0 {
				r.rec.Reason = "The bridge restarted while the new agent was being hired: check the floor before hiring again from the handoff."
			}
			if err := h.st.EndHandoffHire(ctx, row.Op, *r.marker()); err != nil {
				return err
			}
		}
		if row.HandoffID != 0 {
			r.rec.Handoff = row.HandoffID
			if e, err := h.st.HandoffByID(ctx, row.HandoffID); err == nil {
				r.rec.Path = e.Path
			}
		}
		if m.SendHome {
			r.rec.SendHomeResult, r.rec.SendHomeReason = proto.HandoffSendSkipped, "The new agent was not hired; "+m.WorkerName+" stays."
		}
		h.hh.byOp[row.Op] = r
		h.log.Info("handoff hire restored after the restart", "op", row.Op, "code", r.rec.Code, "floor", m.Floor, "desk", m.Desk)
	}
	h.trimHandoffHires()
	return nil
}
