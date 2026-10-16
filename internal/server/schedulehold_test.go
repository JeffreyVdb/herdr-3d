package server_test

import (
	"context"
	"errors"
	"io/fs"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #63: a scheduled or waiting schedule holds the linked worktree its cwd is
// in. The bridge's clock is in CEST here, so the reasons say local times.

var cest = time.FixedZone("CEST", 2*60*60)

// startHoldBridge is a schedule bridge whose clock reads in CEST, with
// linked workers whose checkouts are git work trees and whose agents exit.
// missing makes every cwd stat as gone.
func startHoldBridge(t *testing.T, missing *atomic.Bool, workers ...world.WorkerObs) (*schedBridge, map[string]proto.Worker) {
	t.Helper()
	clk := newClock(t0.UnixMilli())
	sb := startSchedBridgeAt(t, "", clk, func(o *server.Options) {
		o.Now = func() time.Time { return clk.now().In(cest) }
		o.StatDir = func(string) error {
			if missing != nil && missing.Load() {
				return fs.ErrNotExist
			}
			return nil
		}
	}, workers...)
	for _, w := range workers {
		top := w.Worktree.CheckoutPath
		if top == "" {
			top = w.IdentityCwd
		}
		sb.git.repos[w.Cwd], sb.git.repos[top] = top, top
		sb.fl.setProcs(w.WorkspaceID+":p1", atShell())
	}
	ws := workersOf(sb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == len(workers) }), "s")
	return sb, ws
}

func (sb *schedBridge) prepare(id string) proto.FirePrepareResult {
	sb.t.Helper()
	_, m := sb.c.command(proto.CmdFirePrepare, "prep", proto.WorkerArgs{ID: id})
	return ackData[proto.FirePrepareResult](sb.t, m)
}

func (sb *schedBridge) held(id, reason string) {
	sb.t.Helper()
	if p := sb.prepare(id); p.CanDelete || p.CanDeleteBranch || p.Reason != reason || !p.CanFire {
		sb.t.Fatalf("prepare while held: %+v, want reason %q", p, reason)
	}
}

func (sb *schedBridge) free(id string) {
	sb.t.Helper()
	if p := sb.prepare(id); !p.CanDelete || !p.CanDeleteBranch || p.Reason != "" {
		sb.t.Fatalf("prepare once released: %+v", p)
	}
}

const (
	holdWT1 = "/home/u/.herdr/worktrees/repo/h3d-pixel"
	holdWT2 = "/home/u/.herdr/worktrees/repo/h3d-pixel2" // a sibling path, not inside holdWT1
)

// Prepare and fire are refused for a held worktree (a subdirectory cwd and
// a worktree: true schedule hold it too; a sibling path does not); the
// earliest holder is named with the count; cancelling, firing, failing and
// dismissing release it, and the delete then goes through.
func TestScheduleHoldsItsWorktree(t *testing.T) {
	t.Parallel()
	var missing atomic.Bool
	sb, ws := startHoldBridge(t, &missing, linkedWorker("w1", "h3d/pixel"), linkedWorker("w2", "h3d/pixel2"))
	w1 := ws["w1"].ID
	if err := sb.st.RecordHireBranch(context.Background(), store.HireBranch{WorkerID: w1, Session: "s", RepoRoot: "/home/u/repo",
		Branch: "h3d/pixel", BaseSHA: sb.git.sha}); err != nil {
		t.Fatal(err)
	}
	sb.free(w1)

	a := spec(t0.Add(3 * time.Hour)) // 13:00 UTC
	a.Cwd = holdWT1 + "/internal/server"
	sa := sb.create(a)
	held := "used by scheduled agent 'Soak done' at 2026-10-16 15:00 CEST"
	sb.held(w1, held)
	if p := sb.prepare(ws["w2"].ID); !p.CanDelete || p.Reason != "" {
		t.Fatalf("sibling worktree: %+v", p)
	}

	b := spec(t0.Add(time.Hour))
	b.Title, b.Cwd, b.Worktree = "Rebase", holdWT1, true
	sbb := sb.create(b)
	c := spec(t0.Add(5 * time.Hour))
	c.Title, c.Cwd = "Last", holdWT1
	sc := sb.create(c)
	several := "used by scheduled agent 'Rebase' at 2026-10-16 13:00 CEST and 2 more"
	sb.held(w1, several)
	for _, choice := range []string{proto.FireDelete, proto.FireDeleteBranch} {
		_, m := sb.c.command(proto.CmdWorkerFire, "fire-"+choice, proto.WorkerFireArgs{ID: w1, Worktree: choice})
		if e := errorOf(m); e.Code != proto.ErrInvalidState || !strings.HasSuffix(e.Message, ": "+several) {
			t.Fatalf("fire %s while held: %s", choice, m.raw)
		}
	}
	if calls := sb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("a refused send home ran herdr: %q", calls)
	}

	// Cancelling releases: the next one is named, then none.
	sb.c.mustAck(proto.CmdScheduleCancel, proto.ScheduleArgs{ID: sbb.ID})
	sb.c.mustAck(proto.CmdScheduleCancel, proto.ScheduleArgs{ID: sc.ID})
	sb.held(w1, held)
	sb.c.mustAck(proto.CmdScheduleCancel, proto.ScheduleArgs{ID: sa.ID})
	sb.free(w1)

	// Firing releases: running, then done.
	d := spec(t0.Add(time.Hour))
	d.Title, d.Cwd = "Follow-up", holdWT1
	sd := sb.create(d)
	sb.held(w1, "used by scheduled agent 'Follow-up' at 2026-10-16 13:00 CEST")
	sb.at(t0.Add(time.Hour))
	sb.schedule(sd.ID, inState(proto.ScheduleDone))
	sb.free(w1)

	// So does failing (its cwd gone), and dismissing it.
	e := spec(t0.Add(2 * time.Hour))
	e.Title, e.Cwd = "Doomed", holdWT1
	se := sb.create(e)
	sb.held(w1, "used by scheduled agent 'Doomed' at 2026-10-16 14:00 CEST")
	missing.Store(true)
	sb.at(t0.Add(2 * time.Hour))
	sb.schedule(se.ID, inState(proto.ScheduleFailed))
	sb.free(w1)
	sb.c.mustAck(proto.CmdScheduleDismiss, proto.ScheduleArgs{ID: se.ID})
	sb.gone(se.ID)
	sb.free(w1)

	_, m := sb.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: w1, Worktree: proto.FireDeleteBranch})
	if res := ackData[proto.FireResult](t, m); res.Worktree != proto.WorktreeDelBranch {
		t.Fatalf("delete once released: %s", m.raw)
	}
}

// Keeping the worktree still sends a held worker home. A worker whose cwd
// is under its worktree's top is held by a schedule at that top (read from
// git before anything is touched), and a schedule made while the agent
// exits keeps the worktree, with a note.
func TestScheduleHoldStillSendsHome(t *testing.T) {
	t.Parallel()
	sub := linkedWorker("w2", "h3d/mochi")
	wt2 := sub.Cwd
	sub.Cwd, sub.Worktree.CheckoutPath = wt2+"/web", "" // read from the cwd: git says where its top is
	sb, ws := startHoldBridge(t, nil, linkedWorker("w1", "h3d/pixel"), sub, linkedWorker("w3", "h3d/tofu"))

	a := spec(t0.Add(time.Hour))
	a.Cwd = holdWT1
	sb.create(a)
	_, m := sb.c.command(proto.CmdWorkerFire, "keep", proto.WorkerFireArgs{ID: ws["w1"].ID, Worktree: proto.FireKeep})
	if res := ackData[proto.FireResult](t, m); res.Worktree != proto.WorktreeKept {
		t.Fatalf("keep while held: %s", m.raw)
	}
	if calls := sb.fl.Calls(); !slices.Contains(calls, "close w1") || slices.Contains(calls, "remove-worktree w1") {
		t.Fatalf("herdr calls = %q", calls)
	}

	b := spec(t0.Add(2 * time.Hour))
	b.Title, b.Cwd = "At the top", wt2
	sb.create(b)
	held := "used by scheduled agent 'At the top' at 2026-10-16 14:00 CEST"
	sb.held(ws["w2"].ID, held)
	before := len(sb.fl.Calls())
	_, m = sb.c.command(proto.CmdWorkerFire, "sub", proto.WorkerFireArgs{ID: ws["w2"].ID, Worktree: proto.FireDelete})
	if e := errorOf(m); e.Code != proto.ErrInvalidState || !strings.HasSuffix(e.Message, ": "+held) {
		t.Fatalf("fire from a subdirectory while held: %s", m.raw)
	}
	if calls := sb.fl.Calls(); len(calls) != before {
		t.Fatalf("a refused send home ran herdr: %q", calls[before:])
	}

	// w3's agent exits, and meanwhile a schedule is made in its worktree:
	// the workspace closes, the worktree stays.
	other := sb.connect(proto.Hello{Client: "other"})
	other.snapshot()
	wt3 := ws["w3"].Worktree.CheckoutPath
	var once sync.Once
	made := make(chan string, 1)
	sb.fl.onKey = func(pane string, key herdr.Key) {
		if pane != "w3:p1" || key != herdr.KeyEnter {
			return
		}
		once.Do(func() {
			c := spec(t0.Add(4 * time.Hour))
			c.Title, c.Cwd = "Late comer", wt3
			_, m := other.command(proto.CmdScheduleCreate, "late", c)
			made <- string(m.raw)
		})
	}
	sb.fl.setProcs("w3:p1", running("claude", ""))
	_, m = sb.c.command(proto.CmdWorkerFire, "late", proto.WorkerFireArgs{ID: ws["w3"].ID, Worktree: proto.FireDelete})
	if raw := <-made; !strings.Contains(raw, `"t":"ack"`) {
		t.Fatalf("schedule.create during the exit: %s", raw)
	}
	res := ackData[proto.FireResult](t, m)
	if res.Worktree != proto.WorktreeKept || res.Note != "used by scheduled agent 'Late comer' at 2026-10-16 16:00 CEST: the worktree is kept" {
		t.Fatalf("held while exiting: %s", m.raw)
	}
	if calls := sb.fl.Calls(); !slices.Contains(calls, "close w3") || slices.Contains(calls, "remove-worktree w3") {
		t.Fatalf("herdr calls = %q", calls)
	}
}

// worker.wrapup with a delete is refused for a held worktree (here from a
// subdirectory); keep may still be armed.
func TestWrapUpRefusesAHeldWorktree(t *testing.T) {
	t.Parallel()
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	sp := spec(time.Now().Add(time.Hour))
	sp.Cwd = wrapWT1 + "/docs"
	c.mustAck(proto.CmdScheduleCreate, sp)
	for _, choice := range []string{proto.FireDelete, proto.FireDeleteBranch} {
		_, m := c.command(proto.CmdWorkerWrapUp, "wrap-"+choice, proto.WorkerWrapUpArgs{ID: wb.ids["w1"], Prompt: cleanup, Worktree: choice})
		if e := errorOf(m); e.Code != proto.ErrInvalidState || !strings.Contains(e.Message, ": used by scheduled agent 'Soak done' at ") {
			t.Fatalf("wrapup %s while held: %s", choice, m.raw)
		}
	}
	if calls := wb.term.Calls(); len(calls) != 0 {
		t.Fatalf("a refused wrap-up prompted: %q", calls)
	}
	wb.arm(t, c, "w1", proto.FireKeep)
}

// A wrap-up armed with delete before the schedule was made: its CLEAN sends
// the worker home keeping the worktree, with the note in the send home's
// audit row. Also when the schedule comes while the CLEAN's check runs.
func TestWrapUpCleanKeepsAHeldWorktree(t *testing.T) {
	t.Parallel()
	for _, during := range []bool{false, true} {
		wb := startWrapBridge(t, "", "", nil)
		c := wb.connect(proto.Hello{})
		c.snapshot()
		id := wb.ids["w1"]
		nonce := wb.arm(t, c, "w1", proto.FireDelete)
		sp := spec(time.Now().Add(time.Hour))
		sp.Cwd = wrapWT1
		text, _ := wb.prompted(t, "w1:p1")
		if during {
			release := wb.holdCleanCheck(t)
			wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
			wb.waitHeld(t)
			c.mustAck(proto.CmdScheduleCreate, sp)
			release()
		} else {
			c.mustAck(proto.CmdScheduleCreate, sp)
			wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
		}
		removedSentHome(c, id)
		if calls := wb.fl.Calls(); !slices.Equal(calls, []string{"exit w1:p1", "key w1:p1 enter", "close w1"}) {
			t.Fatalf("during %v: herdr calls = %q", during, calls)
		}
		row := doneRow(t, wb.bridge, proto.CmdWorkerFire)
		if !row.OK || !strings.Contains(row.Result, `"choice":"keep"`) || !strings.Contains(row.Result, `"worktree":"kept"`) ||
			!strings.Contains(row.Result, `"wrapup":{"nonce":"`+nonce+`","verdict":"clean","reason":"used by scheduled agent 'Soak done' at `) ||
			!strings.Contains(row.Result, `: the worktree is kept"}`) {
			t.Fatalf("during %v: fire audit = %+v", during, row)
		}
	}
}

// blockAfterExit holds the first CurrentBranch that comes after pane's
// agent was sent its exit's Enter: the check before the worktree is
// removed (its hold already read). held closes when it is reached; the
// check goes on once release is called (at the latest on cleanup).
func blockAfterExit(t *testing.T, git *fakeGit, fl *fakeFloor, pane string) (held chan struct{}, release func()) {
	t.Helper()
	held, gate := make(chan struct{}), make(chan struct{})
	var once, opened sync.Once
	release = func() { opened.Do(func() { close(gate) }) }
	t.Cleanup(release)
	git.mu.Lock()
	git.onBranch = func(string) {
		if slices.Contains(fl.Calls(), "key "+pane+" enter") {
			once.Do(func() { close(held); <-gate })
		}
	}
	git.mu.Unlock()
	return held, release
}

func waitClosed(t *testing.T, ch chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("%s not reached", what)
	}
}

// R1: a schedule acknowledged while the last git checks before a removal
// run (after the hold was read) is seen by the hub step that reserves the
// worktree: worker.fire delete_branch keeps it, with the note.
func TestScheduleDuringTheLastCheckKeepsTheWorktree(t *testing.T) {
	t.Parallel()
	sb, ws := startHoldBridge(t, nil, linkedWorker("w1", "h3d/pixel"))
	w1 := ws["w1"].ID
	if err := sb.st.RecordHireBranch(context.Background(), store.HireBranch{WorkerID: w1, Session: "s", RepoRoot: "/home/u/repo",
		Branch: "h3d/pixel", BaseSHA: sb.git.sha}); err != nil {
		t.Fatal(err)
	}
	other := sb.connect(proto.Hello{Client: "other"})
	other.snapshot()
	sb.fl.setProcs("w1:p1", running("claude", ""))
	held, release := blockAfterExit(t, sb.git, sb.fl, "w1:p1")
	fired := make(chan msg, 1)
	go func() {
		_, m := sb.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: w1, Worktree: proto.FireDeleteBranch})
		fired <- m
	}()
	waitClosed(t, held, "the check after the exit")
	a := spec(t0.Add(time.Hour))
	a.Title, a.Cwd = "Just in time", holdWT1+"/docs"
	other.mustAck(proto.CmdScheduleCreate, a)
	release()
	m := <-fired
	res := ackData[proto.FireResult](t, m)
	if res.Worktree != proto.WorktreeKept || res.Note != "used by scheduled agent 'Just in time' at 2026-10-16 13:00 CEST: the worktree is kept" {
		t.Fatalf("held during the last check: %s", m.raw)
	}
	if calls := sb.fl.Calls(); !slices.Contains(calls, "close w1") || slices.Contains(calls, "remove-worktree w1") {
		t.Fatalf("herdr calls = %q", calls)
	}
	if slices.ContainsFunc(sb.git.Calls(), func(c string) bool { return strings.HasPrefix(c, "branch -D") }) {
		t.Fatalf("git calls = %q", sb.git.Calls())
	}
}

// R1: so does an armed wrap-up's CLEAN: it falls back to keep.
func TestWrapUpScheduleDuringTheLastCheckKeeps(t *testing.T) {
	t.Parallel()
	wb := startWrapBridge(t, "", "", nil)
	c := wb.connect(proto.Hello{})
	c.snapshot()
	nonce := wb.arm(t, c, "w1", proto.FireDeleteBranch)
	text, _ := wb.prompted(t, "w1:p1")
	held, release := blockAfterExit(t, wb.git, wb.fl, "w1:p1")
	wb.reply(t, text, "H3D-WRAPUP "+nonce+" CLEAN")
	waitClosed(t, held, "the check after the exit")
	sp := spec(time.Now().Add(time.Hour))
	sp.Cwd = wrapWT1
	c.mustAck(proto.CmdScheduleCreate, sp)
	release()
	removedSentHome(c, wb.ids["w1"])
	if calls := wb.fl.Calls(); slices.Contains(calls, "remove-worktree w1") || !slices.Contains(calls, "close w1") {
		t.Fatalf("herdr calls = %q", calls)
	}
	row := doneRow(t, wb.bridge, proto.CmdWorkerFire)
	if !row.OK || !strings.Contains(row.Result, `"worktree":"kept"`) ||
		!strings.Contains(row.Result, `"wrapup":{"nonce":"`+nonce+`","verdict":"clean","reason":"used by scheduled agent 'Soak done' at `) {
		t.Fatalf("fire audit = %+v", row)
	}
}

// While a send home removes a worktree, a schedule that would hold it is
// refused busy (create, update into it, retry of a failed one); one
// elsewhere is not. The reservation ends with the removal, whether it
// worked or not.
func TestScheduleRefusedWhileItsWorktreeIsRemoved(t *testing.T) {
	t.Parallel()
	for _, fails := range []bool{false, true} {
		var missing atomic.Bool
		sb, ws := startHoldBridge(t, &missing, linkedWorker("w1", "h3d/pixel"), linkedWorker("w2", "h3d/pixel2"))
		w1 := ws["w1"].ID

		// A schedule elsewhere to update, and a failed one in the tree to retry.
		u := spec(t0.Add(3 * time.Hour))
		u.Title, u.Cwd = "Elsewhere", holdWT2
		su := sb.create(u)
		f := spec(t0.Add(time.Hour))
		f.Title, f.Cwd = "Failed", holdWT1
		sf := sb.create(f)
		missing.Store(true)
		sb.at(t0.Add(time.Hour))
		sb.schedule(sf.ID, inState(proto.ScheduleFailed))
		missing.Store(false)

		gate := make(chan struct{})
		var opened sync.Once
		open := func() { opened.Do(func() { close(gate) }) }
		t.Cleanup(open) // a failure must not leave the removal waiting
		sb.fl.mu.Lock()
		sb.fl.removeGate = gate
		if fails {
			sb.fl.removeErr = errors.New("worktree is locked")
		}
		sb.fl.mu.Unlock()
		fired := make(chan msg, 1)
		go func() {
			_, m := sb.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: w1, Worktree: proto.FireDelete})
			fired <- m
		}()
		waitFor(t, "the removal", func() bool { return slices.Contains(sb.fl.Calls(), "remove-worktree w1") })

		other := sb.connect(proto.Hello{Client: "other"})
		other.snapshot()
		busy := "busy: cwd " + holdWT1 + "/web is in the worktree " + holdWT1 + ", which is being removed (sending " + ws["w1"].Name + " home)"
		in := spec(t0.Add(2 * time.Hour))
		in.Title, in.Cwd = "Too soon", holdWT1+"/web"
		_, m := other.command(proto.CmdScheduleCreate, "create", in)
		if e := errorOf(m); e.Code != proto.ErrBusy || e.Message != busy {
			t.Fatalf("fails %v: create during the removal: %s", fails, m.raw)
		}
		_, m = other.command(proto.CmdScheduleUpdate, "update", proto.ScheduleUpdateArgs{ID: su.ID, ScheduleSpec: in})
		if e := errorOf(m); e.Code != proto.ErrBusy || e.Message != busy {
			t.Fatalf("fails %v: update during the removal: %s", fails, m.raw)
		}
		_, m = other.command(proto.CmdScheduleRetry, "retry", proto.ScheduleArgs{ID: sf.ID})
		if e := errorOf(m); e.Code != proto.ErrBusy || !strings.Contains(e.Message, "which is being removed (sending "+ws["w1"].Name+" home)") {
			t.Fatalf("fails %v: retry during the removal: %s", fails, m.raw)
		}
		sib := spec(t0.Add(2 * time.Hour))
		sib.Title, sib.Cwd = "Sibling", holdWT2
		other.mustAck(proto.CmdScheduleCreate, sib)

		open()
		m = <-fired
		if fails {
			if e := errorOf(m); e.Code != proto.ErrFireFailed || !strings.Contains(e.Message, "worktree is locked") {
				t.Fatalf("failed removal: %s", m.raw)
			}
		} else if res := ackData[proto.FireResult](t, m); res.Worktree != proto.WorktreeDeleted {
			t.Fatalf("removal: %s", m.raw)
		}
		sb.create(in) // released
	}
}
