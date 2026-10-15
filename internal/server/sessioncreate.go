package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #58 session.create: the Add floor dialog's "New herdr session". herdr has
// no create verb: the bridge starts a server under a new name, and the
// floor comes in through discovery like any other. The new session is not
// a floor yet, so this never goes through floorFor; it has its own checks
// (docs/decisions.md "New herdr sessions"):
//
//   - the name: herdr.CheckNewSessionName, with the length cap of this
//     host's sessions folder (sun_path), and inside --sessions when set;
//   - free: not a floor, not in `herdr session list` in any state (starting
//     a known name wakes that session), no folder by it in the sessions
//     folder, no transient unit herdr-s-<name> still loaded;
//   - one create per name at a time (a second one is busy).
//
// The ack comes once the floor is seen running (its floor.upsert went out
// first). A server that does not come up within WakeTimeout is stopped and
// the session folder this call made is removed again.

// createOp is a session.create in progress. The hub goroutine owns its
// fields; the goroutine doing the slow work only reads them through do.
type createOp struct {
	name    string
	client  *Client
	cmd     proto.Command
	auditID int64
	// notify wakes the op's goroutine when its floor may have come up (cap
	// 1, never blocks the hub).
	notify chan struct{}
	// running: the new session's floor was seen running.
	running bool
}

func (op *createOp) signal() {
	select {
	case op.notify <- struct{}{}:
	default:
	}
}

// createReport is the audit-log result of a session.create.
type createReport struct {
	SessionsDir string `json:"sessions_dir,omitempty"`
	Started     bool   `json:"started"`
	SeenAfterMs int64  `json:"seen_after_ms,omitempty"`
	// Rollback is what was undone after a failed start.
	Rollback string `json:"rollback,omitempty"`
}

// rescanEvery is how often a create asks the watcher to look again until
// its floor is seen (herdr lists a new session ~90 ms after the start).
const rescanEvery = 250 * time.Millisecond

// startSessionCreate validates session.create on the hub goroutine and,
// when accepted, starts it; the ack or error comes when it is done.
func (h *Hub) startSessionCreate(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.SessionCreateArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if h.opts.Herdr == nil {
		return &codedError{proto.ErrUnsupported, errors.New("this bridge cannot start herdr sessions (no herdr control configured)")}
	}
	// The format first; the host's length cap is known once herdr is asked.
	if err := herdr.CheckNewSessionName(a.Name, herdr.MaxSessionName); err != nil {
		return &badArgsError{err}
	}
	if h.opts.Sessions != nil && !h.opts.Sessions.MatchString(a.Name) {
		return &badArgsError{fmt.Errorf("“%s” is outside the sessions this bridge watches (--sessions %s): its floor would never show.",
			a.Name, h.opts.Sessions)}
	}
	if h.creating[a.Name] != nil {
		return &codedError{proto.ErrBusy, fmt.Errorf("“%s” is being created already.", a.Name)}
	}
	if _, ok := h.floors[a.Name]; ok {
		return &codedError{proto.ErrNameTaken, fmt.Errorf("“%s” is already a floor.", a.Name)}
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, cmd.Args)
	if err != nil {
		return err
	}
	op := &createOp{name: a.Name, client: c, cmd: cmd, auditID: auditID, notify: make(chan struct{}, 1)}
	h.creating[a.Name] = op
	h.log.Info("session create started", "client", c.name, "req_id", cmd.ReqID, "session", a.Name)
	h.wg.Add(1)
	go h.runSessionCreate(ctx, op)
	return nil
}

// createdFloor tells a create in progress that its floor was observed.
func (h *Hub) createdFloor(session string, running bool) {
	if op := h.creating[session]; op != nil && running {
		op.running = true
		op.signal()
	}
}

func (h *Hub) runSessionCreate(ctx context.Context, op *createOp) {
	defer h.wg.Done()
	report := &createReport{}
	err := h.createSession(ctx, op, time.Now().Add(h.opts.WakeTimeout), report)
	if ctx.Err() != nil {
		return
	}
	h.finishCreate(ctx, op, err, report)
}

// createSession checks the name against what herdr has, starts the server
// and waits until deadline for the floor to be seen running.
func (h *Hub) createSession(ctx context.Context, op *createOp, deadline time.Time, rep *createReport) error {
	failed := func(format string, args ...any) error {
		return &codedError{proto.ErrSessionCreateFailed, fmt.Errorf(format, args...)}
	}
	lctx, cancel := context.WithDeadline(ctx, deadline)
	list, err := h.opts.Herdr.ListSessions(lctx)
	cancel()
	if err != nil {
		return failed("Could not read herdr's sessions: %v", err)
	}
	dir, err := herdr.SessionsDir(list)
	if err != nil {
		return failed("Could not find herdr's sessions folder: %v", err)
	}
	rep.SessionsDir = dir
	if err := herdr.CheckNewSessionName(op.name, herdr.MaxNewSessionName(dir)); err != nil {
		return &badArgsError{err}
	}
	if why := herdr.NewSessionTaken(list, dir, op.name, h.unitLoaded()); why != "" {
		return &codedError{proto.ErrNameTaken, errors.New(why)}
	}
	start := time.Now()
	sctx, cancel := context.WithDeadline(ctx, deadline)
	err = h.opts.Herdr.CreateSession(sctx, op.name)
	cancel()
	rep.Started = true
	if err != nil {
		rep.Rollback = h.rollbackCreate(ctx, op.name, dir)
		return failed("herdr did not start %s: %v", op.name, err)
	}
	if !h.awaitCreated(ctx, op, deadline) {
		rep.Rollback = h.rollbackCreate(ctx, op.name, dir)
		return failed("herdr started %s, but its floor was not seen running within %s; it was stopped and removed again.",
			op.name, h.opts.WakeTimeout)
	}
	rep.SeenAfterMs = time.Since(start).Milliseconds()
	return nil
}

// awaitCreated waits until deadline for the op's floor to be seen running,
// asking the watcher to look again meanwhile.
func (h *Hub) awaitCreated(ctx context.Context, op *createOp, deadline time.Time) bool {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	tick := time.NewTicker(rescanEvery)
	defer tick.Stop()
	h.requestRescan()
	for {
		if ok, _ := query(ctx, h, func() bool { return op.running }); ok {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			return false
		case <-tick.C:
			h.requestRescan()
		case <-op.notify:
		}
	}
}

// rollbackCreate stops a session this create started and removes the
// folder herdr made for it (there was none before: NewSessionTaken). It
// returns what it did, for the audit log.
func (h *Hub) rollbackCreate(ctx context.Context, name, sessionsDir string) string {
	sctx, cancel := context.WithTimeout(ctx, h.opts.SleepTimeout)
	out, err := h.opts.Herdr.StopSession(sctx, name)
	cancel()
	note := "stopped"
	if err != nil {
		note = "stop: " + err.Error()
	} else if out != "" {
		note = "stopped: " + out
	}
	// name passed CheckNewSessionName: one path component under sessionsDir.
	dir := filepath.Join(sessionsDir, name)
	if filepath.Dir(dir) != filepath.Clean(sessionsDir) {
		return note + "; folder kept: not in the sessions folder"
	}
	if _, err := os.Lstat(dir); errors.Is(err, os.ErrNotExist) {
		return note
	}
	if err := os.RemoveAll(dir); err != nil {
		h.log.Warn("removing a failed session's folder", "session", name, "dir", dir, "err", err)
		return note + "; removing " + dir + ": " + err.Error()
	}
	return note + "; removed " + dir
}

func (h *Hub) unitLoaded() func(unit string) bool {
	if h.opts.UnitLoaded != nil {
		return h.opts.UnitLoaded
	}
	return herdr.TransientUnitLoaded(herdr.RuntimeDir())
}

// finishCreate ends a session.create on the hub goroutine: the audit row is
// completed and the client gets its ack or error.
func (h *Hub) finishCreate(ctx context.Context, op *createOp, opErr error, report *createReport) {
	err := h.doWait(ctx, func() {
		if h.creating[op.name] == op {
			delete(h.creating, op.name)
		}
		var data any
		if opErr == nil {
			data = proto.SessionCreated{Session: op.name}
			h.log.Info("session created", "session", op.name, "seen_after_ms", report.SeenAfterMs)
		}
		if aerr := h.st.AuditEnd(ctx, op.auditID, opErr, report); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		h.reply(op.client, op.cmd, data, opErr)
	})
	if err != nil {
		h.log.Warn("session create abandoned", "session", op.name, "err", err)
	}
}
