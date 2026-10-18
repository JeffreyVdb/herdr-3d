package server

// #62 scheduled agents: the bridge's schedule store and runner. A schedule
// is a one-shot hire at a wall-clock time. The runner looks at the wall
// clock (Options.Now) every ScheduleTick, once discovery first listed the
// sessions, and when a floor is first seen; never one long timer, which
// would stop while the host is suspended. A due schedule fires as a hire the
// bridge starts itself (beginHire, worker.hire's path, with no client):
// the bridge picks the desk, wakes the floor if allowed and types the
// prompt. Nothing here sends a worker home or deletes anything.

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

const (
	// DefaultScheduleTick is the default Options.ScheduleTick.
	DefaultScheduleTick = 30 * time.Second
	// ScheduleGrace is how late a schedule first seen due still fires as
	// if on time; past it, it was missed and its on_miss applies.
	ScheduleGrace = 5 * time.Minute
	// scheduleClient is who the audit log says fired a schedule.
	scheduleClient = "bridge:schedule"
)

// scheduleState is the runner's (hub goroutine).
type scheduleState struct {
	all    map[string]store.Schedule // the schedules in view (Store.Schedules), by id
	client *Client                   // the bridge's own identity for its fires: never connected, gets no reply
	// listed is the sessions discovery last listed (nil: none yet, so
	// the floors are not known and nothing fires).
	listed map[string]bool
	// #63: worker id → the canonical top of the worktree its send home is
	// removing now (reserveRemoval).
	removing map[string]string
}

// loadSchedules reads the schedules in view and resolves the ones a
// crash left running: done if their worker was seen, else failed. Each
// floor keeps its last ScheduleKeepDone done ones.
func (h *Hub) loadSchedules(ctx context.Context) error {
	h.sc = scheduleState{all: map[string]store.Schedule{}, client: &Client{name: scheduleClient, kick: func(error) {}}}
	all, err := h.st.Schedules(ctx)
	if err != nil {
		return err
	}
	floors := map[string]bool{}
	for _, s := range all {
		if s.State == store.ScheduleRunning {
			ok := false
			if s.WorkerID != "" {
				if ok, err = h.st.WorkerExists(ctx, s.WorkerID); err != nil {
					return err
				}
			}
			s.State, s.StateReason, s.UpdatedAt = store.ScheduleDone, "", h.opts.Now().UnixMilli()
			if !ok {
				s.State, s.StateReason = store.ScheduleFailed, "bridge stopped while hiring"
			}
			if err := h.st.SaveSchedule(ctx, s); err != nil {
				return err
			}
			h.log.Info("schedule resolved after a restart", "schedule", s.ID, "state", s.State, "worker", s.WorkerID)
		}
		h.sc.all[s.ID] = s
		floors[s.Floor] = true
	}
	for floor := range floors {
		gone, err := h.st.PruneDoneSchedules(ctx, floor, proto.ScheduleKeepDone)
		if err != nil {
			return err
		}
		for _, id := range gone {
			delete(h.sc.all, id)
		}
	}
	return nil
}

func scheduleView(s store.Schedule) proto.Schedule {
	v := proto.Schedule{ID: s.ID, Floor: s.Floor, Title: s.Title, Prompt: s.Prompt, DueAt: s.DueAt, OnMiss: s.OnMiss,
		Harness: s.Harness, Model: s.Model, Effort: s.Effort, Cwd: s.Cwd, Worktree: s.Worktree, WakeFloor: s.WakeFloor,
		HandoffPath: s.HandoffPath, Source: proto.ScheduleSource{Kind: s.Source, Worker: s.SourceWorker, Message: s.SourceMessage},
		State: s.State, StateReason: s.StateReason, WorkerID: s.WorkerID, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt}
	opt := func(ms int64) *int64 {
		if ms == 0 {
			return nil
		}
		return &ms
	}
	v.MaxLatenessMS, v.FiredAt, v.DismissedAt = opt(s.MaxLateness), opt(s.FiredAt), opt(s.DismissedAt)
	return v
}

// sortedSchedules is the schedules in view by due time, then id.
func (h *Hub) sortedSchedules() []store.Schedule {
	out := make([]store.Schedule, 0, len(h.sc.all))
	for _, s := range h.sc.all {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DueAt != out[j].DueAt {
			return out[i].DueAt < out[j].DueAt
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (h *Hub) schedulesView() []proto.Schedule {
	out := []proto.Schedule{}
	for _, s := range h.sortedSchedules() {
		out = append(out, scheduleView(s))
	}
	return out
}

// saveSchedule writes s (stamped now) to the store, then to the view, and
// tells the clients: schedule.upsert, or schedule.removed once it left the
// view (cancelled, dismissed). A done one prunes its floor's oldest.
func (h *Hub) saveSchedule(ctx context.Context, s store.Schedule) error {
	s.UpdatedAt = h.opts.Now().UnixMilli()
	if err := h.st.SaveSchedule(ctx, s); err != nil {
		return fmt.Errorf("saving schedule %s: %w", s.ID, err)
	}
	if s.State == store.ScheduleCancelled || s.DismissedAt != 0 {
		delete(h.sc.all, s.ID)
		h.emit(proto.Event{T: proto.EvScheduleRemoved, ID: s.ID, FloorID: s.Floor})
		return nil
	}
	h.sc.all[s.ID] = s
	v := scheduleView(s)
	h.emit(proto.Event{T: proto.EvScheduleUpsert, Schedule: &v})
	if s.State == store.ScheduleDone {
		gone, err := h.st.PruneDoneSchedules(ctx, s.Floor, proto.ScheduleKeepDone)
		if err != nil {
			h.log.Error("pruning done schedules failed", "floor", s.Floor, "err", err)
		}
		for _, id := range gone {
			delete(h.sc.all, id)
			h.emit(proto.Event{T: proto.EvScheduleRemoved, ID: id, FloorID: s.Floor})
		}
	}
	return nil
}

// moveSchedule puts s in state with reason, unless that changes nothing
// (logged; a write that fails is logged too, the runner has no one to
// tell).
func (h *Hub) moveSchedule(ctx context.Context, s store.Schedule, state, reason string) store.Schedule {
	s.State, s.StateReason = state, reason
	if cur, ok := h.sc.all[s.ID]; ok {
		cur.UpdatedAt = s.UpdatedAt
		if cur == s {
			return s
		}
	}
	h.log.Info("schedule", "schedule", s.ID, "floor", s.Floor, "state", state, "reason", reason, "worker", s.WorkerID)
	if err := h.saveSchedule(ctx, s); err != nil {
		h.log.Error("schedule transition not saved", "schedule", s.ID, "state", state, "err", err)
	}
	return s
}

// listed applies discovery's list of sessions: the floors are known from
// the first one on, so the runner looks right away.
func (h *Hub) listed(ctx context.Context, u world.Listed) {
	first := h.sc.listed == nil
	h.sc.listed = map[string]bool{}
	for _, s := range u.Sessions {
		h.sc.listed[s] = true
	}
	if first {
		h.checkSchedules(ctx)
	}
}

// checkSchedules is the runner's look at the wall clock: a scheduled one
// due now is decided (on time, under grace, or missed), a waiting one is
// fired again.
func (h *Hub) checkSchedules(ctx context.Context) {
	if h.sc.listed == nil {
		return
	}
	now := h.opts.Now()
	for _, s := range h.sortedSchedules() {
		switch {
		case s.State == store.ScheduleScheduled && s.DueAt <= now.UnixMilli():
			h.dueSchedule(ctx, s, now)
		case s.State == store.ScheduleWaiting:
			h.fireSchedule(ctx, s, now)
		}
	}
}

// dueSchedule decides a schedule first seen due at now: within the grace
// it fires; past it, on_miss skip skips it, run_late fires it late unless
// it is later than its max lateness.
func (h *Hub) dueSchedule(ctx context.Context, s store.Schedule, now time.Time) {
	s.SeenAt = now.UnixMilli()
	if late := lateness(s.DueAt, now); late > ScheduleGrace {
		switch {
		case s.OnMiss == proto.ScheduleSkip:
			h.moveSchedule(ctx, s, store.ScheduleSkipped, fmt.Sprintf("missed: bridge was offline at %s (seen %s)",
				utc(time.UnixMilli(s.DueAt)), utc(now)))
			return
		case s.MaxLateness > 0 && late > time.Duration(s.MaxLateness)*time.Millisecond:
			h.moveSchedule(ctx, s, store.ScheduleSkipped, fmt.Sprintf("missed: %s late, more than its max_lateness of %s (due %s, seen %s)",
				span(late), span(time.Duration(s.MaxLateness)*time.Millisecond), utc(time.UnixMilli(s.DueAt)), utc(now)))
			return
		}
	}
	h.fireSchedule(ctx, s, now)
}

func lateness(dueAt int64, now time.Time) time.Duration { return now.Sub(time.UnixMilli(dueAt)) }

// utc is an instant as a schedule's reasons and prompts say it.
func utc(t time.Time) string { return t.UTC().Format("2006-01-02 15:04 UTC") }

// span is a duration in days, hours and minutes ("1d 2h 5m", "45m",
// "under a minute").
func span(d time.Duration) string {
	m := int64(d / time.Minute)
	if m < 1 {
		return "under a minute"
	}
	var parts []string
	for _, u := range []struct {
		n    int64
		unit string
	}{{m / (24 * 60), "d"}, {m / 60 % 24, "h"}, {m % 60, "m"}} {
		if u.n > 0 {
			parts = append(parts, fmt.Sprintf("%d%s", u.n, u.unit))
		}
	}
	return strings.Join(parts, " ")
}

// scheduleFloor is where a schedule's floor stands: f when the bridge sees
// it; gone when it knows the floor is no more (discovery no longer lists its
// session, or it was a virtual floor since deleted); neither while it is
// listed but not seen yet.
func (h *Hub) scheduleFloor(floor string) (f *floorState, gone bool) {
	if f, err := h.floorFor(floor); err == nil {
		return f, false
	}
	session := floor
	if v, ok := h.vfloors[floor]; ok {
		session = v.BaseSession
	}
	if h.sc.listed == nil || h.sc.listed[session] {
		return nil, false
	}
	return nil, true
}

// freeDesk is the first desk of floor that no worker holds and no hire is
// on its way to (the game's first free desk); the hire grows the floor's
// desks as any hire does.
func (h *Hub) freeDesk(floor string, f *floorState) (int, bool) {
	taken := map[int]bool{}
	for _, d := range h.desks[floor] {
		taken[d] = true
	}
	for _, op := range f.hires {
		if op.floor == floor {
			taken[op.desk] = true
		}
	}
	for d := range h.deskCount(floor, f) {
		if !taken[d] {
			return d, true
		}
	}
	return 0, false
}

// fireSchedule fires s now (run now and retry come here directly, without
// the grace): a floor that cannot take the hire yet makes it wait for the
// next look, one that never will fails it; else the hire begins and s runs
// until it ends.
func (h *Hub) fireSchedule(ctx context.Context, s store.Schedule, now time.Time) {
	fail := func(reason string) { h.moveSchedule(ctx, s, store.ScheduleFailed, reason) }
	wait := func(reason string) { h.moveSchedule(ctx, s, store.ScheduleWaiting, reason) }
	f, gone := h.scheduleFloor(s.Floor)
	switch {
	case gone:
		fail(fmt.Sprintf("floor %s is gone", s.Floor))
		return
	case f == nil:
		wait(fmt.Sprintf("floor %s is not seen yet", s.Floor))
		return
	case f.op != nil:
		wait(fmt.Sprintf("floor “%s” is %s", h.floorName(f), f.op.kind))
		return
	case !f.running && !s.WakeFloor:
		fail("floor asleep: wake_floor is off")
		return
	case !f.running:
		h.wakeForSchedule(ctx, s, f)
		return
	}
	if err := h.opts.StatDir(s.Cwd); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			fail(fmt.Sprintf("working directory %s no longer exists", s.Cwd))
		} else {
			fail(fmt.Sprintf("working directory %s: %v", s.Cwd, err))
		}
		return
	}
	if err := h.checkCaps(s.Floor, 1); err != nil {
		fail(err.Error())
		return
	}
	desk, ok := h.freeDesk(s.Floor, f)
	if !ok {
		wait(fmt.Sprintf("no free desk on floor “%s”", h.floorName(f)))
		return
	}
	a := proto.WorkerHireArgs{Floor: s.Floor, DeskIndex: &desk, Harness: s.Harness, Model: s.Model, Effort: s.Effort,
		Cwd: s.Cwd, Worktree: s.Worktree, Prompt: h.schedulePrompt(s, now)}
	cmd := proto.Command{T: proto.CmdWorkerHire, ReqID: "schedule:" + s.ID, Args: mustJSON(struct {
		Schedule string `json:"schedule"`
		proto.WorkerHireArgs
	}{s.ID, a})}
	sid := s.ID
	// #108 round 2: with prompt secrets reviewed, the stored prompt goes
	// only as its review left it (runHire checks it before anything else).
	var sec *hireSecrets
	if h.ps.enabled && s.Prompt != "" {
		sec = &hireSecrets{rev: h.ps.rev, stored: &storedPrompt{text: s.Prompt, record: s.SecretsReview}}
	}
	err := h.beginHire(ctx, h.sc.client, cmd, a, nil, nil, &hireWatch{
		begun: func(ctx context.Context, id string) error {
			s.State, s.StateReason, s.FiredAt, s.WorkerID = store.ScheduleRunning, "", now.UnixMilli(), id
			h.log.Info("schedule fired", "schedule", sid, "floor", s.Floor, "desk", desk, "worker", id)
			return h.saveSchedule(ctx, s)
		},
		settled: func(ctx context.Context, id string, res *proto.HireResult, err error) {
			h.scheduleSettled(ctx, sid, id, res, err)
		},
	}, sec)
	if err != nil {
		fail(err.Error()) // s as begun left it, if it ran
	}
}

// wakeForSchedule wakes s's asleep floor (floor.wake's path, audited as the
// bridge's) and makes s wait; the runner looks again once the wake ended,
// and a failed wake fails every schedule waiting on it.
func (h *Hub) wakeForSchedule(ctx context.Context, s store.Schedule, f *floorState) {
	name := h.floorName(f)
	switch {
	case h.opts.Herdr == nil:
		h.moveSchedule(ctx, s, store.ScheduleFailed, fmt.Sprintf("floor asleep: “%s” cannot be woken (waking floors is not configured)", name))
		return
	case !herdr.ValidSessionName(f.session):
		h.moveSchedule(ctx, s, store.ScheduleFailed, fmt.Sprintf("floor asleep: “%s” (session %s) cannot be woken by the bridge", name, f.session))
		return
	}
	cmd := proto.Command{T: proto.CmdWorkerHire, ReqID: "schedule:" + s.ID}
	session := f.session
	err := h.wakeFor(ctx, h.sc.client, cmd, s.Floor, f, func(ctx context.Context, err error) {
		if err != nil {
			for _, w := range h.sortedSchedules() {
				if w.State != store.ScheduleWaiting {
					continue
				}
				if wf, _ := h.scheduleFloor(w.Floor); wf != nil && wf.session == session {
					h.moveSchedule(ctx, w, store.ScheduleFailed, fmt.Sprintf("waking floor “%s” failed: %v", name, err))
				}
			}
		}
		h.checkSchedules(ctx)
	})
	if err != nil {
		h.moveSchedule(ctx, s, store.ScheduleFailed, fmt.Sprintf("waking floor “%s” failed: %v", name, err))
		return
	}
	h.log.Info("waking a floor for a schedule", "schedule", s.ID, "session", session, "floor", s.Floor)
	h.moveSchedule(ctx, s, store.ScheduleWaiting, fmt.Sprintf("waking floor “%s”", name))
}

// scheduleSettled ends a schedule's fire with its hire: done with the
// worker it hired, failed with the hire's error, or failed when the worker
// was hired but never got its prompt (it stays; the reason names it).
func (h *Hub) scheduleSettled(ctx context.Context, sid, worker string, res *proto.HireResult, err error) {
	s, ok := h.sc.all[sid]
	if !ok || s.State != store.ScheduleRunning || s.WorkerID != worker {
		return
	}
	switch {
	case err != nil:
		h.moveSchedule(ctx, s, store.ScheduleFailed, err.Error())
	case res != nil && res.PromptError != "":
		name := worker
		if w := h.workers[worker]; w != nil {
			name = w.Name
		}
		h.moveSchedule(ctx, s, store.ScheduleFailed, fmt.Sprintf("hired %s, but its prompt was not sent: %s", name, res.PromptError))
	default:
		h.moveSchedule(ctx, s, store.ScheduleDone, "")
	}
}

// schedulePrompt is the fired worker's first prompt: a late run's notice,
// the schedule's prompt, then the handoff to read (or that it was deleted).
func (h *Hub) schedulePrompt(s store.Schedule, now time.Time) string {
	var parts []string
	if s.SeenAt != 0 && lateness(s.DueAt, time.UnixMilli(s.SeenAt)) > ScheduleGrace {
		parts = append(parts, fmt.Sprintf("This task was scheduled for %s and is running at %s, %s late. "+
			"Check whether anything below is stale before acting.", utc(time.UnixMilli(s.DueAt)), utc(now), span(lateness(s.DueAt, now))))
	}
	if s.Prompt != "" {
		parts = append(parts, s.Prompt)
	}
	if s.HandoffPath != "" {
		if _, err := os.Stat(s.HandoffPath); errors.Is(err, fs.ErrNotExist) {
			parts = append(parts, handoff.GoneTask(s.HandoffPath))
		} else {
			parts = append(parts, handoff.HireTask(s.HandoffPath))
		}
	}
	return strings.Join(parts, "\n\n")
}

// startSchedule runs the schedule.* commands (hub goroutine).
func (h *Hub) startSchedule(ctx context.Context, c *Client, cmd proto.Command) error {
	s, err := h.scheduleCommand(ctx, cmd)
	if err != nil {
		return err
	}
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, scheduleView(s), nil)
	return nil
}

func (h *Hub) scheduleCommand(ctx context.Context, cmd proto.Command) (store.Schedule, error) {
	now := h.opts.Now()
	if cmd.T == proto.CmdScheduleCreate {
		var a proto.ScheduleCreateArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return store.Schedule{}, err
		}
		if a.Floor == "" {
			return store.Schedule{}, bad("floor is required")
		}
		if _, err := h.floorFor(a.Floor); err != nil {
			if _, defined := h.vfloors[a.Floor]; !defined {
				return store.Schedule{}, err
			}
		}
		s := store.Schedule{ID: "sch_" + randHex(8), Floor: a.Floor, Source: proto.ScheduleFromManual, State: store.ScheduleScheduled,
			CreatedAt: now.UnixMilli(), UpdatedAt: now.UnixMilli()}
		if src := a.Source; src != nil {
			switch src.Kind {
			case proto.ScheduleFromManual, proto.ScheduleFromTranscript, proto.ScheduleFromSuggestion:
			default:
				return store.Schedule{}, bad("source.kind must be manual, transcript or suggestion, got %q", src.Kind)
			}
			if len(src.Worker) > 128 || len(src.Message) > 256 || !utf8.ValidString(src.Worker+src.Message) {
				return store.Schedule{}, bad("source.worker and source.message must be ids (at most 128 and 256 bytes)")
			}
			s.Source, s.SourceWorker, s.SourceMessage = src.Kind, src.Worker, src.Message
		}
		if err := h.applyScheduleSpec(&s, a, now); err != nil {
			return store.Schedule{}, err
		}
		if err := h.removingRefusal(s.Cwd); err != nil {
			return store.Schedule{}, err
		}
		if err := h.st.AddSchedule(ctx, s); err != nil {
			return store.Schedule{}, fmt.Errorf("saving the schedule: %w", err)
		}
		h.sc.all[s.ID] = s
		v := scheduleView(s)
		h.emit(proto.Event{T: proto.EvScheduleUpsert, Schedule: &v})
		h.log.Info("schedule created", "schedule", s.ID, "floor", s.Floor, "due_at", s.DueAt)
		return s, nil
	}

	var id string
	var spec proto.ScheduleSpec
	if cmd.T == proto.CmdScheduleUpdate {
		var a proto.ScheduleUpdateArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return store.Schedule{}, err
		}
		id, spec = a.ID, a.ScheduleSpec
	} else {
		var a proto.ScheduleArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return store.Schedule{}, err
		}
		id = a.ID
	}
	s, ok := h.sc.all[id]
	if !ok { // cancelled or dismissed (kept, out of view), or unknown
		old, err := h.st.ScheduleByID(ctx, id)
		if err != nil {
			return store.Schedule{}, fmt.Errorf("schedule %q: %w", id, err)
		}
		state := old.State
		if old.DismissedAt != 0 {
			state = "dismissed"
		}
		return store.Schedule{}, fmt.Errorf("%w: schedule %s is %s", errInvalidState, id, state)
	}
	// Each command's states it may act in.
	allowed := map[string][]string{
		proto.CmdScheduleUpdate:  {store.ScheduleScheduled},
		proto.CmdScheduleCancel:  {store.ScheduleScheduled, store.ScheduleWaiting},
		proto.CmdScheduleRunNow:  {store.ScheduleScheduled},
		proto.CmdScheduleRetry:   {store.ScheduleFailed, store.ScheduleSkipped},
		proto.CmdScheduleDismiss: {store.ScheduleFailed, store.ScheduleSkipped},
	}[cmd.T]
	ok = false
	for _, st := range allowed {
		ok = ok || s.State == st
	}
	if !ok {
		return store.Schedule{}, fmt.Errorf("%w: schedule %s is %s; %s needs it %s", errInvalidState, id, s.State, cmd.T,
			strings.Join(allowed, " or "))
	}
	switch cmd.T {
	case proto.CmdScheduleUpdate:
		if spec.Floor != "" && spec.Floor != s.Floor {
			return store.Schedule{}, bad("a schedule's floor cannot change (it is %s)", s.Floor)
		}
		if spec.Source != nil {
			return store.Schedule{}, bad("a schedule's source cannot change")
		}
		spec.Floor = s.Floor
		if err := h.applyScheduleSpec(&s, spec, now); err != nil {
			return store.Schedule{}, err
		}
		if err := h.removingRefusal(s.Cwd); err != nil {
			return store.Schedule{}, err
		}
	case proto.CmdScheduleCancel:
		s.State, s.StateReason = store.ScheduleCancelled, ""
	case proto.CmdScheduleDismiss:
		s.DismissedAt = now.UnixMilli()
	case proto.CmdScheduleRunNow, proto.CmdScheduleRetry:
		// #63: a retry that waits would hold its worktree again.
		if cmd.T == proto.CmdScheduleRetry {
			if err := h.removingRefusal(s.Cwd); err != nil {
				return store.Schedule{}, err
			}
		}
		// The same spec, now: no grace, no on_miss. The fire writes where
		// it got (running, waiting or failed).
		h.log.Info("schedule fired by hand", "schedule", s.ID, "cmd", cmd.T)
		s.SeenAt, s.FiredAt, s.WorkerID = now.UnixMilli(), 0, ""
		h.fireSchedule(ctx, s, now)
		if cur, ok := h.sc.all[s.ID]; ok {
			s = cur
		}
		return s, nil
	}
	if err := h.saveSchedule(ctx, s); err != nil {
		return store.Schedule{}, err
	}
	h.log.Info("schedule changed", "schedule", s.ID, "cmd", cmd.T, "state", s.State)
	return s, nil
}

// applyScheduleSpec checks a and writes it into s: what a fire hires
// (worker.hire's checks of harness, model, effort and prompt), when, and
// its missed-window policy.
func (h *Hub) applyScheduleSpec(s *store.Schedule, a proto.ScheduleSpec, now time.Time) error {
	title := strings.TrimSpace(a.Title)
	if title == "" || len(title) > proto.ScheduleMaxTitle || !utf8.ValidString(title) || strings.ContainsFunc(title, unicode.IsControl) {
		return bad("title must be 1-%d bytes of text without control characters", proto.ScheduleMaxTitle)
	}
	if a.DueAt <= now.UnixMilli() {
		return bad("due_at must be in the future (now %d, got %d)", now.UnixMilli(), a.DueAt)
	}
	onMiss := a.OnMiss
	if onMiss == "" {
		onMiss = proto.ScheduleRunLate
	}
	var maxLate int64
	switch {
	case onMiss != proto.ScheduleRunLate && onMiss != proto.ScheduleSkip:
		return bad("on_miss must be run_late or skip, got %q", onMiss)
	case a.MaxLatenessMS != nil && onMiss != proto.ScheduleRunLate:
		return bad("max_lateness_ms is for on_miss run_late only")
	case a.MaxLatenessMS != nil && *a.MaxLatenessMS <= 0:
		return bad("max_lateness_ms must be positive")
	case a.MaxLatenessMS != nil:
		maxLate = *a.MaxLatenessMS
	}
	if err := validHireIn(h.hireOptions(), proto.Hire{Harness: a.Harness, Model: a.Model, Effort: a.Effort}); err != nil {
		return &badArgsError{err}
	}
	if !herdr.CanStart(a.Harness) {
		return bad("cannot start harness %q", a.Harness)
	}
	if a.Prompt == "" && a.HandoffPath == "" {
		return bad("prompt is required without a handoff_path")
	}
	if a.Prompt != "" {
		if !herdr.ValidPrompt(a.Prompt) {
			return bad("prompt must be 1-%d bytes of text, not starting with \"--\"", herdr.MaxPrompt)
		}
		if err := checkTyped(a.Harness, a.Prompt, herdr.MaxPrompt, "prompt"); err != nil {
			return err
		}
	}
	if !filepath.IsAbs(a.Cwd) || !herdr.ValidDir(filepath.Clean(a.Cwd)) {
		return bad("cwd must be an absolute path, got %q", a.Cwd)
	}
	cwd := filepath.Clean(a.Cwd)
	if err := h.opts.StatDir(cwd); err != nil {
		return bad("cwd %q: %v", cwd, err)
	}
	path := a.HandoffPath
	if path != "" {
		if !filepath.IsAbs(path) || !herdr.ValidDir(filepath.Clean(path)) {
			return bad("handoff_path must be an absolute path, got %q", path)
		}
		path = filepath.Clean(path)
	}
	wake := true
	if a.WakeFloor != nil {
		wake = *a.WakeFloor
	}
	s.Title, s.Prompt, s.DueAt, s.OnMiss, s.MaxLateness = title, a.Prompt, a.DueAt, onMiss, maxLate
	s.Harness, s.Model, s.Effort, s.Cwd, s.Worktree, s.WakeFloor, s.HandoffPath = a.Harness, a.Model, a.Effort, cwd, a.Worktree, wake, path
	return nil
}
