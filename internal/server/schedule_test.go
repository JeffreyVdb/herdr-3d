package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #62 scheduled agents. The bridge's clock is a test clock: the runner
// looks at it when the test says (CheckSchedules), the real ticker is an
// hour, so nothing here waits for wall time.

// t0 is when every schedule test starts: Friday 2026-10-16 10:00 UTC.
var t0 = time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)

type schedBridge struct {
	*hireBridge
	clk *clock
}

func startSchedBridge(t *testing.T, tweak func(*server.Options), workers ...world.WorkerObs) *schedBridge {
	t.Helper()
	return startSchedBridgeAt(t, "", newClock(t0.UnixMilli()), tweak, workers...)
}

// startSchedBridgeAt starts a hire bridge on db with clk, then lists its
// one session as discovery would (the runner's startup scan).
func startSchedBridgeAt(t *testing.T, db string, clk *clock, tweak func(*server.Options), workers ...world.WorkerObs) *schedBridge {
	t.Helper()
	hb := startHireBridgeAt(t, db, func(o *server.Options) {
		o.Now, o.ScheduleTick = clk.now, time.Hour
		if tweak != nil {
			tweak(o)
		}
	}, workers...)
	hb.publish(world.Listed{Sessions: []string{"s"}})
	for deadline := time.Now().Add(5 * time.Second); !hb.hub.FloorsKnown(context.Background()); {
		if time.Now().After(deadline) {
			t.Fatal("the runner never got the list")
		}
		time.Sleep(5 * time.Millisecond)
	}
	return &schedBridge{hb, clk}
}

// spec is a schedule of the floor "s" due at due: a Codex hire into
// /home/u/repo (its prompt is sent whole, so the fake records it).
func spec(due time.Time) proto.ScheduleSpec {
	return proto.ScheduleSpec{Floor: "s", Title: "Soak done", Prompt: "Delete the backups.", DueAt: due.UnixMilli(),
		Harness: "codex", Model: "gpt-6-astra", Effort: "ultra", Cwd: "/home/u/repo"}
}

func (sb *schedBridge) create(sp proto.ScheduleSpec) proto.Schedule {
	sb.t.Helper()
	_, m := sb.c.command(proto.CmdScheduleCreate, "create", sp)
	return ackData[proto.Schedule](sb.t, m)
}

// at sets the clock and has the runner look.
func (sb *schedBridge) at(t time.Time) {
	sb.t.Helper()
	sb.clk.set(t.UnixMilli())
	if err := sb.hub.CheckSchedules(context.Background()); err != nil {
		sb.t.Fatal(err)
	}
}

// schedule waits until schedule id is in view and ok.
func (sb *schedBridge) schedule(id string, ok func(proto.Schedule) bool) proto.Schedule {
	sb.t.Helper()
	var got proto.Schedule
	sb.world(func(w proto.World) bool {
		for _, s := range w.Schedules {
			if s.ID == id {
				got = s
				return ok(s)
			}
		}
		return false
	})
	return got
}

func inState(state string) func(proto.Schedule) bool {
	return func(s proto.Schedule) bool { return s.State == state }
}

// gone waits until schedule id is out of view.
func (sb *schedBridge) gone(id string) {
	sb.t.Helper()
	sb.world(func(w proto.World) bool {
		return !slices.ContainsFunc(w.Schedules, func(s proto.Schedule) bool { return s.ID == id })
	})
}

// prompts are the prompts herdr was asked to send (Codex), in order.
func (sb *schedBridge) prompts() []string {
	var out []string
	for _, c := range sb.fl.Calls() {
		if rest, ok := strings.CutPrefix(c, "prompt "); ok {
			_, q, _ := strings.Cut(rest, " ")
			text, err := strconv.Unquote(q)
			if err != nil {
				sb.t.Fatalf("prompt call %q: %v", c, err)
			}
			out = append(out, text)
		}
	}
	return out
}

func (sb *schedBridge) creates() []string {
	var out []string
	for _, c := range sb.fl.Calls() {
		if strings.HasPrefix(c, "create s ") || strings.HasPrefix(c, "worktree s ") {
			out = append(out, c)
		}
	}
	return out
}

// harmless fails the test if anything was ever sent home, closed or
// deleted: no schedule path may.
func (sb *schedBridge) harmless() {
	sb.t.Helper()
	for _, c := range sb.fl.Calls() {
		for _, p := range []string{"close ", "remove-worktree ", "exit "} {
			if strings.HasPrefix(c, p) {
				sb.t.Fatalf("a schedule %s: %v", strings.TrimSpace(p), sb.fl.Calls())
			}
		}
	}
	for _, c := range sb.git.Calls() {
		if strings.HasPrefix(c, "branch -D") {
			sb.t.Fatalf("a schedule deleted a branch: %v", sb.git.Calls())
		}
	}
	if row := auditRow(sb.t, sb.bridge, proto.CmdWorkerFire); row.Done || row.Error != "" {
		sb.t.Fatalf("a schedule sent a worker home: %+v", row)
	}
}

// Create, update, cancel, run now, retry and dismiss follow the state
// rules; invalid transitions answer invalid_state; schedules survive a
// restart.
func TestScheduleCommands(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	c := sb.c
	due := t0.Add(time.Hour)

	refused := map[string]func(*proto.ScheduleSpec){
		"due now":             func(s *proto.ScheduleSpec) { s.DueAt = t0.UnixMilli() },
		"no title":            func(s *proto.ScheduleSpec) { s.Title = "  " },
		"unknown harness":     func(s *proto.ScheduleSpec) { s.Harness = "nope" },
		"unknown model":       func(s *proto.ScheduleSpec) { s.Model = "gpt-0" },
		"unknown effort":      func(s *proto.ScheduleSpec) { s.Effort = "maximal" },
		"relative cwd":        func(s *proto.ScheduleSpec) { s.Cwd = "repo" },
		"prompt over 32 KiB":  func(s *proto.ScheduleSpec) { s.Prompt = strings.Repeat("x", herdr.MaxPrompt+1) },
		"no prompt":           func(s *proto.ScheduleSpec) { s.Prompt = "" },
		"flag prompt":         func(s *proto.ScheduleSpec) { s.Prompt = "--yolo" },
		"unknown on_miss":     func(s *proto.ScheduleSpec) { s.OnMiss = "later" },
		"skip with a limit":   func(s *proto.ScheduleSpec) { s.OnMiss, s.MaxLatenessMS = "skip", ptr(int64(1000)) },
		"zero limit":          func(s *proto.ScheduleSpec) { s.MaxLatenessMS = ptr(int64(0)) },
		"relative handoff":    func(s *proto.ScheduleSpec) { s.HandoffPath = "h/a.md" },
		"unknown source kind": func(s *proto.ScheduleSpec) { s.Source = &proto.ScheduleSource{Kind: "email"} },
	}
	for name, mut := range refused {
		sp := spec(due)
		mut(&sp)
		_, m := c.command(proto.CmdScheduleCreate, "bad", sp)
		if e := errorOf(m); e.Code != proto.ErrBadRequest {
			t.Fatalf("%s: %s", name, m.raw)
		}
	}
	sp := spec(due)
	sp.Floor = "nope"
	c.mustError(proto.CmdScheduleCreate, sp, proto.ErrUnknownSession)
	sp = spec(due)
	sp.MaxLatenessMS = ptr(int64(2 * time.Hour / time.Millisecond))
	sp.Source = &proto.ScheduleSource{Kind: proto.ScheduleFromTranscript, Worker: "u1", Message: "m-7"}
	evs, m := c.command(proto.CmdScheduleCreate, "c", sp)
	s := ackData[proto.Schedule](t, m)
	if s.State != proto.ScheduleScheduled || s.OnMiss != proto.ScheduleRunLate || !s.WakeFloor || s.Worktree ||
		*s.MaxLatenessMS != 7200000 || s.Source != *sp.Source || s.DueAt != due.UnixMilli() || s.CreatedAt != t0.UnixMilli() ||
		!strings.HasPrefix(s.ID, "sch_") {
		t.Fatalf("created %+v", s)
	}
	if len(evs) != 1 || evs[0].T != proto.EvScheduleUpsert || evs[0].Schedule.ID != s.ID {
		t.Fatalf("create events %+v", evs)
	}

	// Update replaces the spec, only while scheduled; floor and source stay.
	up := proto.ScheduleUpdateArgs{ID: s.ID, ScheduleSpec: spec(due.Add(time.Hour))}
	up.Title, up.WakeFloor = "Soak over", ptr(false)
	_, m = c.command(proto.CmdScheduleUpdate, "u", up)
	if got := ackData[proto.Schedule](t, m); got.Title != "Soak over" || got.WakeFloor || got.DueAt != due.Add(time.Hour).UnixMilli() ||
		got.MaxLatenessMS != nil || got.Source != *sp.Source {
		t.Fatalf("updated %+v", got)
	}
	moved := up
	moved.Floor = "elsewhere"
	c.mustError(proto.CmdScheduleUpdate, moved, proto.ErrBadRequest)
	past := up
	past.DueAt = t0.Add(-time.Minute).UnixMilli()
	c.mustError(proto.CmdScheduleUpdate, past, proto.ErrBadRequest)
	c.mustError(proto.CmdScheduleCancel, proto.ScheduleArgs{ID: "sch_nope"}, proto.ErrNotFound)
	for _, cmd := range []string{proto.CmdScheduleRetry, proto.CmdScheduleDismiss} {
		c.mustError(cmd, proto.ScheduleArgs{ID: s.ID}, proto.ErrInvalidState)
	}

	// It survives a restart, and only the schedules in view are in the snapshot.
	sb.stop()
	sb = startSchedBridgeAt(t, sb.db, sb.clk, nil, worker("w1", "CODE|a", "", "idle"))
	c = sb.c
	got := sb.schedule(s.ID, inState(proto.ScheduleScheduled))
	if got.Title != "Soak over" || got.Source != *sp.Source {
		t.Fatalf("after a restart %+v", got)
	}

	// Run now fires it at once (no grace check), and then it is done:
	// nothing but a retry-free view is left to do with it.
	_, m = c.command(proto.CmdScheduleRunNow, "r", proto.ScheduleArgs{ID: s.ID})
	if st := ackData[proto.Schedule](t, m).State; st != proto.ScheduleRunning {
		t.Fatalf("run now acked %s", m.raw)
	}
	done := sb.schedule(s.ID, inState(proto.ScheduleDone))
	if done.WorkerID == "" || done.FiredAt == nil || *done.FiredAt != t0.UnixMilli() {
		t.Fatalf("done %+v", done)
	}
	for _, cmd := range []string{proto.CmdScheduleCancel, proto.CmdScheduleRunNow, proto.CmdScheduleRetry, proto.CmdScheduleDismiss} {
		c.mustError(cmd, proto.ScheduleArgs{ID: s.ID}, proto.ErrInvalidState)
	}
	c.mustError(proto.CmdScheduleUpdate, up, proto.ErrInvalidState)

	// Cancel (scheduled or waiting) removes it from view; it stays cancelled.
	other := sb.create(spec(due))
	evs, m = c.command(proto.CmdScheduleCancel, "x", proto.ScheduleArgs{ID: other.ID})
	if st := ackData[proto.Schedule](t, m).State; st != proto.ScheduleCancelled || len(evs) != 1 ||
		evs[0].T != proto.EvScheduleRemoved || evs[0].ID != other.ID || evs[0].FloorID != "s" {
		t.Fatalf("cancel: %+v %s", evs, m.raw)
	}
	for _, cmd := range []string{proto.CmdScheduleCancel, proto.CmdScheduleRunNow, proto.CmdScheduleRetry} {
		c.mustError(cmd, proto.ScheduleArgs{ID: other.ID}, proto.ErrInvalidState)
	}
	sb.at(due.Add(time.Minute))
	sb.gone(other.ID)
	if n := len(sb.creates()); n != 1 {
		t.Fatalf("hires = %v", sb.creates())
	}
	sb.harmless()
}

// A failed or skipped schedule waits in view until dismissed; retry fires
// the same spec now.
func TestScheduleRetryAndDismiss(t *testing.T) {
	t.Parallel()
	var vanished atomic.Bool
	sb := startSchedBridge(t, func(o *server.Options) {
		o.StatDir = func(dir string) error {
			if vanished.Load() && dir == "/home/u/repo" {
				return &fs.PathError{Op: "stat", Path: dir, Err: fs.ErrNotExist}
			}
			return nil
		}
	})
	c := sb.c
	due := t0.Add(time.Hour)
	s := sb.create(spec(due))
	skip := spec(due.Add(-20 * time.Minute))
	skip.OnMiss = proto.ScheduleSkip
	k := sb.create(skip)
	vanished.Store(true)
	sb.at(due)
	failed := sb.schedule(s.ID, inState(proto.ScheduleFailed))
	if failed.StateReason != "working directory /home/u/repo no longer exists" {
		t.Fatalf("failed %+v", failed)
	}
	if calls := sb.creates(); len(calls) != 0 {
		t.Fatalf("hired elsewhere: %v", calls)
	}

	// Retry: the same spec, now (the directory is back).
	vanished.Store(false)
	sb.clk.set(due.Add(time.Hour).UnixMilli())
	c.mustAck(proto.CmdScheduleRetry, proto.ScheduleArgs{ID: s.ID})
	done := sb.schedule(s.ID, inState(proto.ScheduleDone))
	if p := sb.prompts(); len(p) != 1 || !strings.HasSuffix(p[0], "\n\nDelete the backups.") ||
		!strings.Contains(p[0], "1h late") || done.StateReason != "" {
		t.Fatalf("retried: %+v prompts %q", done, p)
	}

	// The skipped one (seen 20 minutes late) waits in view until
	// dismissed, which takes it out of view for good.
	if got := sb.schedule(k.ID, inState(proto.ScheduleSkipped)); !strings.HasPrefix(got.StateReason, "missed: ") {
		t.Fatalf("skipped %+v", got)
	}
	evs, _ := c.mustAck(proto.CmdScheduleDismiss, proto.ScheduleArgs{ID: k.ID})
	if last := evs[len(evs)-1]; last.T != proto.EvScheduleRemoved || last.ID != k.ID { // after the retry's hire events
		t.Fatalf("dismiss events %+v", evs)
	}
	for _, cmd := range []string{proto.CmdScheduleRetry, proto.CmdScheduleDismiss} {
		c.mustError(cmd, proto.ScheduleArgs{ID: k.ID}, proto.ErrInvalidState)
	}
	sb.gone(k.ID)
	sb.harmless()
}

// The runner and the grace, with an injected clock: on time, under the
// grace, missed with skip, run_late without and past max_lateness.
func TestScheduleGrace(t *testing.T) {
	t.Parallel()
	due := t0.Add(time.Hour) // 11:00 UTC
	cases := []struct {
		name    string
		onMiss  string
		maxLate time.Duration
		seen    time.Duration // after due
		state   string
		reason  string
		prompt  string
	}{
		{name: "on time", seen: 0, state: proto.ScheduleDone, prompt: "Delete the backups."},
		{name: "under grace", seen: 5 * time.Minute, state: proto.ScheduleDone, prompt: "Delete the backups."},
		{name: "missed with skip", onMiss: proto.ScheduleSkip, seen: 20 * time.Minute, state: proto.ScheduleSkipped,
			reason: "missed: bridge was offline at 2026-10-16 11:00 UTC (seen 2026-10-16 11:20 UTC)"},
		{name: "run_late without a limit", seen: 26*time.Hour + 5*time.Minute, state: proto.ScheduleDone,
			prompt: "This task was scheduled for 2026-10-16 11:00 UTC and is running at 2026-10-17 13:05 UTC, 1d 2h 5m late. " +
				"Check whether anything below is stale before acting.\n\nDelete the backups."},
		{name: "run_late within max_lateness", maxLate: time.Hour, seen: 30 * time.Minute, state: proto.ScheduleDone,
			prompt: "This task was scheduled for 2026-10-16 11:00 UTC and is running at 2026-10-16 11:30 UTC, 30m late. " +
				"Check whether anything below is stale before acting.\n\nDelete the backups."},
		{name: "run_late past max_lateness", maxLate: time.Hour, seen: 2*time.Hour + time.Second, state: proto.ScheduleSkipped,
			reason: "missed: 2h late, more than its max_lateness of 1h (due 2026-10-16 11:00 UTC, seen 2026-10-16 13:00 UTC)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			sb := startSchedBridge(t, nil)
			sp := spec(due)
			sp.OnMiss = tc.onMiss
			if tc.maxLate > 0 {
				sp.MaxLatenessMS = ptr(tc.maxLate.Milliseconds())
			}
			s := sb.create(sp)
			sb.at(due.Add(-time.Millisecond)) // not due yet
			if got := sb.schedule(s.ID, inState(proto.ScheduleScheduled)); got.FiredAt != nil {
				t.Fatalf("early: %+v", got)
			}
			sb.at(due.Add(tc.seen))
			got := sb.schedule(s.ID, inState(tc.state))
			if got.StateReason != tc.reason {
				t.Fatalf("reason %q, want %q", got.StateReason, tc.reason)
			}
			if p := sb.prompts(); tc.prompt == "" && len(p) != 0 || tc.prompt != "" && !slices.Equal(p, []string{tc.prompt}) {
				t.Fatalf("prompts %q, want %q", p, tc.prompt)
			}
			if tc.state == proto.ScheduleSkipped && len(sb.creates()) != 0 {
				t.Fatalf("a skipped schedule hired: %v", sb.creates())
			}
			// One fire: another look changes nothing.
			sb.at(due.Add(tc.seen + time.Hour))
			if n := len(sb.creates()); tc.state == proto.ScheduleDone && n != 1 {
				t.Fatalf("hires = %v", sb.creates())
			}
			sb.harmless()
		})
	}
}

// The host is suspended past due_at: the wall clock jumps, and the first
// look after it sees the schedule late (no timer was counting meanwhile).
func TestScheduleSuspendResume(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	due := t0.Add(time.Hour)
	s := sb.create(spec(due))
	sb.at(t0.Add(10 * time.Minute))
	sb.at(t0.Add(20 * time.Minute))
	sb.at(due.Add(3 * time.Hour)) // resumed
	sb.schedule(s.ID, inState(proto.ScheduleDone))
	if p := sb.prompts(); len(p) != 1 || !strings.HasPrefix(p[0], "This task was scheduled for 2026-10-16 11:00 UTC and is running at 2026-10-16 14:00 UTC, 3h late.") {
		t.Fatalf("prompts %q", p)
	}
	sb.harmless()
}

// The bridge was down when a schedule came due: the startup scan, once
// discovery listed the sessions, fires it, once.
func TestScheduleRestartScan(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	due := t0.Add(time.Hour)
	s := sb.create(spec(due))
	sb.stop()
	sb.clk.set(due.Add(2 * time.Minute).UnixMilli())
	sb = startSchedBridgeAt(t, sb.db, sb.clk, nil) // no look but the startup scan's
	done := sb.schedule(s.ID, inState(proto.ScheduleDone))
	if p := sb.prompts(); !slices.Equal(p, []string{"Delete the backups."}) || done.WorkerID == "" {
		t.Fatalf("after the restart: %+v, prompts %q", done, p)
	}
	sb.stop()
	sb = startSchedBridgeAt(t, sb.db, sb.clk, nil)
	sb.at(due.Add(time.Hour))
	if got := sb.schedule(s.ID, inState(proto.ScheduleDone)); got.WorkerID != done.WorkerID || len(sb.creates()) != 0 {
		t.Fatalf("fired again: %+v, %v", got, sb.creates())
	}
}

// A crash while a schedule's hire ran: on startup it is done if its worker
// was seen, else failed.
func TestScheduleCrashWhileRunning(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "world.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveWorker(ctx, store.Worker{ID: "u-seen", Session: "s", WorkspaceID: "w9", Label: "x"}); err != nil {
		t.Fatal(err)
	}
	row := func(id, worker string) store.Schedule {
		return store.Schedule{ID: id, Floor: "s", Title: id, Prompt: "p", DueAt: t0.UnixMilli(), OnMiss: "run_late", Harness: "codex",
			Model: "gpt-6-astra", Effort: "ultra", Cwd: "/home/u/repo", WakeFloor: true, Source: "manual", State: store.ScheduleRunning,
			SeenAt: t0.UnixMilli(), FiredAt: t0.UnixMilli(), WorkerID: worker, CreatedAt: 1, UpdatedAt: 1}
	}
	for _, s := range []store.Schedule{row("sch_seen", "u-seen"), row("sch_lost", "u-lost"), row("sch_early", "")} {
		if err := st.AddSchedule(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	sb := startSchedBridgeAt(t, db, newClock(t0.Add(time.Minute).UnixMilli()), nil)
	if got := sb.schedule("sch_seen", inState(proto.ScheduleDone)); got.WorkerID != "u-seen" || got.StateReason != "" {
		t.Fatalf("seen worker: %+v", got)
	}
	for _, id := range []string{"sch_lost", "sch_early"} {
		if got := sb.schedule(id, inState(proto.ScheduleFailed)); got.StateReason != "bridge stopped while hiring" {
			t.Fatalf("%s: %+v", id, got)
		}
	}
	sb.at(t0.Add(time.Hour))
	if len(sb.creates()) != 0 {
		t.Fatalf("fired again: %v", sb.creates())
	}
	sb.harmless()
}

// An asleep floor is woken (wake_floor, the default): the schedule waits
// while it wakes, then fires. Without wake_floor it fails.
func TestScheduleAsleepFloor(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	sleepHireFloor(t, sb.hireBridge)
	due := t0.Add(time.Hour)
	stay := spec(due)
	stay.WakeFloor = ptr(false)
	asleep := sb.create(stay)
	wake := sb.create(spec(due.Add(time.Minute)))

	sb.at(due)
	if got := sb.schedule(asleep.ID, inState(proto.ScheduleFailed)); got.StateReason != "floor asleep: wake_floor is off" {
		t.Fatalf("no wake: %+v", got)
	}
	if slices.Contains(sb.fl.Calls(), "start s") {
		t.Fatalf("woken without wake_floor: %v", sb.fl.Calls())
	}
	sb.at(due.Add(time.Minute))
	sb.schedule(wake.ID, inState(proto.ScheduleDone))
	calls := sb.fl.Calls()
	start := slices.Index(calls, "start s")
	create := slices.IndexFunc(calls, func(c string) bool { return strings.HasPrefix(c, "create s ") })
	if start < 0 || create < start {
		t.Fatalf("herdr calls = %v", calls)
	}
	if row := auditRow(t, sb.bridge, proto.CmdFloorWake); !row.OK || !row.Done {
		t.Fatalf("wake audit = %+v", row)
	}
	sb.harmless()
}

// While the floor's wake is busy (started by someone else), a due schedule
// waits and is fired on the next look after it.
func TestScheduleWaitsForABusyFloor(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil, worker("w1", "CODE|a", "", "idle"))
	sleepHireFloor(t, sb.hireBridge)
	gate := make(chan struct{})
	sb.fl.fakeHerdr.gate = gate
	due := t0.Add(time.Hour)
	s := sb.create(spec(due))
	cancelled := sb.create(spec(due))
	sb.c.send(proto.Command{T: proto.CmdFloorWake, ReqID: "wake", Args: json.RawMessage(`{"session":"s"}`)})
	sb.world(func(w proto.World) bool { f, _ := floorByID(w, "s"); return f.Transition == proto.TransitionWaking })
	sb.at(due)
	if got := sb.schedule(s.ID, inState(proto.ScheduleWaiting)); !strings.Contains(got.StateReason, "is waking") {
		t.Fatalf("busy: %+v", got)
	}
	sb.c.mustAck(proto.CmdScheduleCancel, proto.ScheduleArgs{ID: cancelled.ID}) // a waiting one may be cancelled
	close(gate)
	sb.world(func(w proto.World) bool { f, _ := floorByID(w, "s"); return f.State == "running" && f.Transition == "" })
	sb.at(due.Add(30 * time.Second))
	sb.schedule(s.ID, inState(proto.ScheduleDone))
	if n := len(sb.creates()); n != 1 {
		t.Fatalf("hires = %v", sb.creates())
	}
	sb.harmless()
}

// The bridge picks the first free desk and the floor grows a desk, as with
// any hire; every client sees the hire exactly like a normal one.
func TestScheduleDeskGrowthSeenByClients(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil, worker("w1", "CODE|a", "", "idle"), worker("w2", "CODE|b", "", "idle"),
		worker("w3", "CODE|c", "", "idle"), worker("w4", "CODE|d", "", "idle"))
	before := sb.world(hasWorkers("s", 4))
	if f := floorOf(before, "s"); f.Desks != 6 {
		t.Fatalf("desks before = %d", f.Desks)
	}
	obs := sb.connect(proto.Hello{Client: "watcher"})
	obs.snapshot()
	s := sb.create(spec(t0.Add(time.Hour)))
	sb.at(t0.Add(time.Hour))
	var hired *proto.Worker
	desks := 0
	for {
		ev := obs.event()
		switch {
		case ev.T == proto.EvWorkerUpsert && ev.Worker.HiredAt != 0:
			hired = ev.Worker
		case ev.T == proto.EvFloorUpsert && ev.Floor.ID == "s":
			desks = ev.Floor.Desks
		}
		if ev.T == proto.EvScheduleUpsert && ev.Schedule.ID == s.ID && ev.Schedule.State == proto.ScheduleDone {
			if hired == nil || hired.ID != ev.Schedule.WorkerID || hired.DeskIndex != 4 || hired.Floor != "s" || desks != 7 {
				t.Fatalf("seen: worker %+v, desks %d", hired, desks)
			}
			break
		}
	}
	sb.harmless()
}

// The hard caps fail a schedule with the hire's message naming the flag.
func TestScheduleHardCap(t *testing.T) {
	t.Parallel()
	for flag, caps := range map[string]server.Caps{
		"--max-workers-per-floor": {FloorSoft: 1, FloorHard: 1, HostSoft: 5, HostHard: 9},
		"--max-workers":           {FloorSoft: 1, FloorHard: 9, HostSoft: 1, HostHard: 1},
	} {
		sb := startSchedBridge(t, func(o *server.Options) { o.Caps = caps }, worker("w1", "CODE|a", "", "idle"))
		s := sb.create(spec(t0.Add(time.Hour)))
		sb.at(t0.Add(time.Hour))
		if got := sb.schedule(s.ID, inState(proto.ScheduleFailed)); !strings.HasSuffix(got.StateReason, "("+flag+")") {
			t.Fatalf("%s: %+v", flag, got)
		}
		if len(sb.creates()) != 0 {
			t.Fatalf("%s: hired %v", flag, sb.creates())
		}
		sb.harmless()
	}
}

// worktree: true hires into a fresh h3d/ branch of cwd's repository.
func TestScheduleWorktreeHire(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	sb.git.repos["/home/u/repo/sub"] = "/home/u/repo"
	sp := spec(t0.Add(time.Hour))
	sp.Cwd, sp.Worktree = "/home/u/repo/sub", true
	s := sb.create(sp)
	sb.at(t0.Add(time.Hour))
	sb.schedule(s.ID, inState(proto.ScheduleDone))
	c := sb.creates()
	if f := strings.Fields(strings.Join(c, " ")); len(c) != 1 || len(f) < 5 || f[2] != "/home/u/repo" ||
		!strings.HasPrefix(f[3], "h3d/") || f[4] != "origin/main" {
		t.Fatalf("hire = %v", c)
	}
	if !slices.Contains(sb.git.Calls(), "fetch /home/u/repo") {
		t.Fatalf("git = %v", sb.git.Calls())
	}
	sb.harmless()
}

// The handoff line follows the prompt in the cabinet's words; a handoff
// deleted before the fire is named as such.
func TestScheduleHandoff(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	path := filepath.Join(t.TempDir(), "20261016-0900-pixel-soak.md")
	if err := os.WriteFile(path, []byte("# Soak\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	sp := spec(t0.Add(time.Hour))
	sp.HandoffPath = path
	present := sb.create(sp)
	sp.Prompt = "" // a handoff alone is a task too
	sp.DueAt = t0.Add(2 * time.Hour).UnixMilli()
	deleted := sb.create(sp)
	sb.at(t0.Add(time.Hour))
	sb.schedule(present.ID, inState(proto.ScheduleDone))
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	sb.at(t0.Add(2 * time.Hour))
	sb.schedule(deleted.ID, inState(proto.ScheduleDone))
	want := []string{"Delete the backups.\n\n" + handoff.HireTask(path), handoff.GoneTask(path)}
	if p := sb.prompts(); !slices.Equal(p, want) {
		t.Fatalf("prompts %q, want %q", p, want)
	}
	sb.harmless()
}

// A hire error fails the schedule with its message; a worker hired whose
// prompt never went fails it too, naming the worker (who stays).
func TestScheduleHireErrors(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	sb.fl.createErr = errors.New("herdr: no such session")
	s := sb.create(spec(t0.Add(time.Hour)))
	sb.at(t0.Add(time.Hour))
	if got := sb.schedule(s.ID, inState(proto.ScheduleFailed)); got.StateReason != "hire failed: herdr workspace create: herdr: no such session" {
		t.Fatalf("hire error: %+v", got)
	}
	sb.fl.createErr = nil
	sb.fl.promptErrs = []error{errors.New("boom")}
	s = sb.create(spec(t0.Add(2 * time.Hour)))
	sb.at(t0.Add(2 * time.Hour))
	got := sb.schedule(s.ID, inState(proto.ScheduleFailed))
	if got.WorkerID == "" || !strings.HasPrefix(got.StateReason, "hired ") || !strings.HasSuffix(got.StateReason, ", but its prompt was not sent: boom") {
		t.Fatalf("prompt error: %+v", got)
	}
	sb.harmless()
}

// A floor discovery no longer lists is gone: its schedule fails. One
// listed but not seen yet waits for it.
func TestScheduleFloorGone(t *testing.T) {
	t.Parallel()
	sb := startSchedBridge(t, nil)
	s := sb.create(spec(t0.Add(time.Hour)))
	later := sb.create(spec(t0.Add(2 * time.Hour)))
	sb.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
	sb.world(func(w proto.World) bool { _, ok := floorByID(w, "s"); return !ok })
	sb.at(t0.Add(time.Hour))
	if got := sb.schedule(s.ID, inState(proto.ScheduleWaiting)); got.StateReason != "floor s is not seen yet" {
		t.Fatalf("listed, not seen: %+v", got)
	}
	sb.publish(world.Listed{Sessions: []string{}})
	for deadline := time.Now().Add(5 * time.Second); len(sb.hub.ListedSessions(context.Background())) != 0; {
		if time.Now().After(deadline) {
			t.Fatal("the runner never got the new list")
		}
		time.Sleep(5 * time.Millisecond)
	}
	sb.at(t0.Add(2 * time.Hour))
	for _, id := range []string{s.ID, later.ID} {
		if got := sb.schedule(id, inState(proto.ScheduleFailed)); got.StateReason != "floor s is gone" {
			t.Fatalf("gone: %+v", got)
		}
	}
	sb.harmless()
}

// A floor keeps its last ScheduleKeepDone done schedules: a fire that
// makes another prunes the oldest (schedule.removed); other floors keep
// theirs.
func TestScheduleKeepsTheLastDone(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "world.db")
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	done := func(id, floor string, fired int64) store.Schedule {
		return store.Schedule{ID: id, Floor: floor, Title: id, Prompt: "p", DueAt: fired, OnMiss: "run_late", Harness: "codex",
			Model: "gpt-6-astra", Effort: "ultra", Cwd: "/home/u/repo", WakeFloor: true, Source: "manual", State: store.ScheduleDone,
			SeenAt: fired, FiredAt: fired, WorkerID: "u-" + id, CreatedAt: 1, UpdatedAt: 1}
	}
	for i := range proto.ScheduleKeepDone {
		if err := st.AddSchedule(ctx, done("sch_old"+strconv.Itoa(i), "s", int64(1000+i))); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.AddSchedule(ctx, done("sch_t", "t", 1)); err != nil {
		t.Fatal(err)
	}
	st.Close()
	sb := startSchedBridgeAt(t, db, newClock(t0.UnixMilli()), nil)
	obs := sb.connect(proto.Hello{Client: "watcher"})
	if n := len(obs.snapshot().World.Schedules); n != proto.ScheduleKeepDone+1 {
		t.Fatalf("snapshot has %d schedules", n)
	}
	s := sb.create(spec(t0.Add(time.Hour)))
	sb.at(t0.Add(time.Hour))
	for {
		ev := obs.event()
		if ev.T == proto.EvScheduleRemoved {
			if ev.ID != "sch_old0" || ev.FloorID != "s" {
				t.Fatalf("pruned %+v", ev)
			}
			break
		}
	}
	w := sb.world(func(w proto.World) bool { return len(w.Schedules) == proto.ScheduleKeepDone+1 })
	ids := map[string]bool{}
	for _, x := range w.Schedules {
		ids[x.ID] = true
	}
	if !ids[s.ID] || !ids["sch_t"] || ids["sch_old0"] || !ids["sch_old1"] {
		t.Fatalf("kept %v", ids)
	}
}
