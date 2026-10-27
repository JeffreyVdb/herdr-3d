package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #219 Hire with handoff in the background: worker.handoff's hire, against
// the agent handoffs' bridge (w1 Claude, w2 Codex, w3 a shell, at desks
// 0-2) and the LLM handoffs' one. The fake agent writes the reserved file
// and its turn; the hire is the hire bridge's fake floor.

// hhTask is a task with blank lines around it (the first prompt drops
// them) and a marker that must be nowhere but in the new worker's prompt.
const (
	hhMarker = "HHTASK-7f3c"
	hhTask   = "\n \n  Fix the " + hhMarker + " issue\n\n- keep it\n\n  \n"
	hhBody   = "  Fix the " + hhMarker + " issue\n\n- keep it"
)

// hhArgs is worker.handoff in mode agent with a hire of a Claude worker at
// desk for task.
func hhArgs(worker, op string, desk int, task string) proto.WorkerHandoffArgs {
	h := hireArgs(desk)
	h.Prompt = task
	return proto.WorkerHandoffArgs{Worker: worker, Mode: proto.HandoffModeAgent, Op: op,
		Hire: &proto.WorkerHandoffHire{WorkerHireArgs: h, Origin: "tab-1"}}
}

// handoffHire waits until op's record satisfies ok and returns it.
func (b *bridge) handoffHire(op string, ok func(proto.HandoffHire) bool) proto.HandoffHire {
	b.t.Helper()
	var got proto.HandoffHire
	b.world(func(w proto.World) bool {
		for _, r := range w.HandoffHires {
			if r.Op == op && ok(r) {
				got = r
				return true
			}
		}
		return false
	})
	return got
}

func hhState(state string) func(proto.HandoffHire) bool {
	return func(r proto.HandoffHire) bool { return r.State == state }
}

// hhCreates counts the workspaces the hire bridge made.
func hhCreates(fl *fakeFloor) int {
	n := 0
	for _, c := range fl.Calls() {
		if strings.HasPrefix(c, "create ") || strings.HasPrefix(c, "worktree ") {
			n++
		}
	}
	return n
}

// fileAgent plays the agent: it writes the reserved file and ends its turn.
func (ab *agBridge) fileAgent(t *testing.T, pane string) {
	t.Helper()
	text, path, _ := ab.mustRequest(t, pane)
	writeDoc(t, path, agentDoc)
	appendTo(t, ab.claude, claudeTurn(text, "Wrote the handoff."))
}

// The agent's handoff with a hire: acked with the record (waiting, the desk
// held); another client sees the hold and cannot hire into the desk, nor
// can another pending hire; once filed the new worker is hired with #198's
// first prompt (the filed path, then the task, its blank lines around it
// dropped), once; a replay answers the record, another hire is refused;
// the task is in no record, event, ack, row or audit.
func TestHandoffHireAgentHires(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{Client: "tab-a"})
	c.snapshot()
	id := ab.ids["w1"]
	name := workersOf(ab.world(func(proto.World) bool { return true }), "s")["w1"].Name
	args := hhArgs(id, "op-h", 5, hhTask)
	_, m := c.command(proto.CmdWorkerHandoff, "h1", args)
	res := ackData[proto.WorkerHandoffRequestResult](t, m)
	if r := res.HandoffHire; r == nil || r.State != proto.HandoffHireWaiting || r.Op != "op-h" || r.Worker != id || r.WorkerName != name ||
		r.Mode != proto.HandoffModeAgent || r.Floor != "s" || r.DeskIndex != 5 || r.Origin != "tab-1" || r.Harness != "claude" ||
		r.StartedAt == 0 || r.EndedAt != 0 || res.Request.State != proto.AgentHandoffPending {
		t.Fatalf("ack %s", m.raw)
	}

	other := ab.connect(proto.Hello{Client: "tab-b"})
	snap := other.snapshot().World
	if len(snap.HandoffHires) != 1 || snap.HandoffHires[0].State != proto.HandoffHireWaiting || floorOf(snap, "s").Desks < 6 {
		t.Fatalf("the other client sees %+v, %d desks", snap.HandoffHires, floorOf(snap, "s").Desks)
	}
	_, em := other.command(proto.CmdWorkerHire, "x", hireArgs(5))
	if e := errorOf(em); e.Code != proto.ErrDeskTaken || e.Message != "Desk 6 is held for "+name+"'s handoff hire." {
		t.Fatalf("a hire into the held desk: %s", em.raw)
	}
	other.mustError(proto.CmdWorkerHandoff, hhArgs(ab.ids["w2"], "op-2", 5, "x"), proto.ErrDeskTaken)
	if hhCreates(ab.fl) != 0 {
		t.Fatal("hired before the handoff was filed")
	}

	ab.fileAgent(t, "w1:p1")
	rec := ab.handoffHire("op-h", hhState(proto.HandoffHireHired))
	all, _ := ab.st.AllHandoffs(context.Background())
	if len(all) != 1 {
		t.Fatalf("%d handoffs", len(all))
	}
	filed := all[0]
	if rec.Path != filed.Path || rec.Handoff != filed.ID || rec.Hired == "" || rec.Prompted == nil || !*rec.Prompted ||
		rec.Delivery != "accepted" || rec.EndedAt == 0 || rec.Code != "" || strings.Contains(rec.Path, ".pending") {
		t.Fatalf("hired %+v (filed %+v)", rec, filed)
	}
	hired := ab.world(func(w proto.World) bool {
		return slices.ContainsFunc(w.Workers, func(w proto.Worker) bool { return w.ID == rec.Hired })
	})
	var ws string
	for _, w := range hired.Workers {
		if w.ID == rec.Hired {
			ws = w.WorkspaceID
			if w.DeskIndex != 5 {
				t.Fatalf("hired at desk %d", w.DeskIndex)
			}
		}
	}
	want := "First read the handoff here: " + filed.Path + " and then follow these instructions:\n\n" + hhBody
	if got := sentPrompt(t, ab.hireBridge, ws+":p1"); got != want {
		t.Fatalf("first prompt\n%q, want\n%q", got, want)
	}

	// The same request again: its request and record, nothing again.
	_, m = c.command(proto.CmdWorkerHandoff, "h2", args)
	if r := ackData[proto.WorkerHandoffRequestResult](t, m); !r.Existing || r.HandoffHire == nil || r.HandoffHire.State != proto.HandoffHireHired {
		t.Fatalf("replay %s", m.raw)
	}
	// Other settings, or none, under the op: refused.
	moved := args
	h := *args.Hire
	h.DeskIndex = ptr(4)
	moved.Hire = &h
	c.mustError(proto.CmdWorkerHandoff, moved, proto.ErrBadRequest)
	plain := args
	plain.Hire = nil
	c.mustError(proto.CmdWorkerHandoff, plain, proto.ErrBadRequest)
	// A reconnect replaying the events from before the hire hires nothing.
	since := c.welcome.ServerSeq
	re := ab.connect(proto.Hello{Client: "tab-a", SinceSeq: &since, Epoch: c.welcome.Epoch})
	re.seq = since
	seen := false
	for !seen {
		ev := re.event()
		seen = ev.T == proto.EvHandoffHireUpsert && ev.HandoffHire.State == proto.HandoffHireHired
	}
	time.Sleep(100 * time.Millisecond)
	if n := hhCreates(ab.fl); n != 1 {
		t.Fatalf("%d hires", n)
	}
	if _, _, _, n := ab.requested("w1:p1"); n != 1 {
		t.Fatalf("%d handoff requests", n)
	}

	// The task is the new worker's prompt only.
	log, _ := ab.st.AuditLog(context.Background())
	var rows strings.Builder
	for _, e := range log {
		rows.WriteString(e.Cmd + " " + e.Args + " " + e.Error + " " + e.Result + "\n")
	}
	req, _ := ab.st.HandoffRequestByOp(context.Background(), "op-h")
	rb, _ := json.Marshal(req)
	for where, text := range map[string]string{"a client": c.heard.String() + other.heard.String() + re.heard.String(),
		"the audit log": rows.String(), "the request's row": string(rb)} {
		if strings.Contains(text, hhMarker) {
			t.Errorf("%s holds the task", where)
		}
	}
	if !strings.Contains(rows.String(), `"prompt_bytes"`) || !strings.Contains(rows.String(), "worker.hire") {
		t.Errorf("no hire audit row: %s", rows.String())
	}
	if req.Hire != nil {
		t.Errorf("the marker stays after the hire: %+v", req.Hire)
	}
}

// No handoff, no hire: the turn ends without the file, the request times
// out, is cancelled (the record at once, in the cancel's step), the source
// leaves, the target floor goes. Each ends the record with its code, the
// hold released.
func TestHandoffHireAgentNoHire(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, state, code string
		tweak             func(*server.Options)
		end               func(t *testing.T, ab *agBridge, c *client, id string)
	}{
		{name: "no file", state: proto.HandoffHireFailed, code: proto.HandoffHireHandoffFailed,
			end: func(t *testing.T, ab *agBridge, c *client, id string) {
				text, _, _ := ab.mustRequest(t, "w1:p1")
				appendTo(t, ab.claude, claudeTurn(text, "I could not write it."))
			}},
		{name: "timeout", state: proto.HandoffHireFailed, code: proto.HandoffHireTimeout,
			tweak: func(o *server.Options) { o.AgentHandoffTimeout = 500 * time.Millisecond },
			end:   func(*testing.T, *agBridge, *client, string) {}},
		{name: "cancel", state: proto.HandoffHireCancelled, code: proto.HandoffHireCancelledCode,
			end: func(t *testing.T, ab *agBridge, c *client, id string) {
				evs, m := c.command(proto.CmdWorkerHandoffCancel, "x", proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-n"})
				if m.env.T != proto.TAck || !slices.ContainsFunc(evs, func(ev proto.Event) bool {
					return ev.T == proto.EvHandoffHireUpsert && ev.HandoffHire.State == proto.HandoffHireCancelled
				}) {
					t.Fatalf("cancel: %s, events %+v", m.raw, evs)
				}
			}},
		{name: "source gone", state: proto.HandoffHireFailed, code: proto.HandoffHireSourceGone,
			end: func(t *testing.T, ab *agBridge, c *client, id string) {
				ab.fl.close("w1")
			}},
		{name: "floor gone", state: proto.HandoffHireFailed, code: proto.HandoffHireFloorGone,
			end: func(t *testing.T, ab *agBridge, c *client, id string) {
				ab.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ab := startAgentBridge(t, "", "", "", tc.tweak)
			c := ab.connect(proto.Hello{})
			c.snapshot()
			id := ab.ids["w1"]
			c.mustAck(proto.CmdWorkerHandoff, hhArgs(id, "op-n", 5, hhTask))
			tc.end(t, ab, c, id)
			rec := ab.handoffHire("op-n", func(r proto.HandoffHire) bool { return r.Ended() })
			if rec.State != tc.state || rec.Code != tc.code || rec.Reason == "" || rec.Hired != "" || rec.Path != "" || rec.EndedAt == 0 {
				t.Fatalf("record %+v", rec)
			}
			if tc.name == "floor gone" {
				return
			}
			// The desk is free again.
			if _, m := c.command(proto.CmdWorkerHire, "after", hireArgs(5)); m.env.T != proto.TAck {
				t.Fatalf("the desk is still held: %s", m.raw)
			}
			if n := hhCreates(ab.fl); n != 1 {
				t.Fatalf("%d hires", n)
			}
		})
	}
}

// Checks after filing are the hire's: a floor that filled up while the
// handoff was written refuses it (capacity), and the record keeps the
// filed handoff's path: it stays in the cabinet, nobody is hired, the
// source is not sent home.
func TestHandoffHireRefusedAfterFiling(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) {
		o.Caps = server.Caps{FloorSoft: 4, FloorHard: 4, HostSoft: 10, HostHard: 10}
	})
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	args := hhArgs(id, "op-c", 5, hhTask)
	args.SendHome = true
	c.mustAck(proto.CmdWorkerHandoff, args) // 3 workers + 1, the source not counted: room
	// Workers opened in herdr meanwhile fill the floor; none is seated at
	// the held desk.
	ab.fl.create("/home/u/ext", "ext", nil)
	ab.fl.create("/home/u/ext2", "ext2", nil)
	ab.fl.publish()
	w := ab.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 5 })
	for _, ws := range []string{"w4", "w5"} {
		if d := workersOf(w, "s")[ws].DeskIndex; d == 5 {
			t.Fatal("a newcomer was seated at the held desk")
		}
	}
	ab.fileAgent(t, "w1:p1")
	rec := ab.handoffHire("op-c", func(r proto.HandoffHire) bool { return r.Ended() })
	all, _ := ab.st.AllHandoffs(context.Background())
	if rec.State != proto.HandoffHireFailed || rec.Code != proto.HandoffHireCapacity || len(all) != 1 || rec.Path != all[0].Path ||
		rec.Handoff != all[0].ID || rec.SendHomeResult != proto.HandoffSendSkipped || !strings.Contains(rec.SendHomeReason, "not hired") {
		t.Fatalf("record %+v", rec)
	}
	if hhCreates(ab.fl) != 0 {
		t.Fatal("hired")
	}
	wv := upsertFor(c, id, agentState(proto.AgentHandoffFiled))
	if wv.AgentHandoff.SendHomeResult != proto.HandoffSendSkipped {
		t.Fatalf("the source's view %+v", wv.AgentHandoff)
	}
	if _, ok := workersOf(ab.world(func(proto.World) bool { return true }), "s")["w1"]; !ok {
		t.Fatal("the source was sent home")
	}
}

// Send home after a hire: a full floor takes the hire (the source is not
// counted, at acceptance and at launch); the new worker is hired first,
// then the source goes home. When the new worker did not get its task the
// source stays.
func TestHandoffHireSendHome(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) {
		o.Caps = server.Caps{FloorSoft: 3, FloorHard: 3, HostSoft: 10, HostHard: 10}
	})
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	ab.fl.setProcs("w1:p1", running("claude", wrapSess))
	args := hhArgs(id, "op-s", 5, hhTask)
	c.mustError(proto.CmdWorkerHandoff, args, proto.ErrCapacity) // without send home the floor is full
	args.SendHome = true
	c.mustAck(proto.CmdWorkerHandoff, args)
	ab.fileAgent(t, "w1:p1")
	hiredFirst := false
	for {
		ev := c.event()
		if ev.T == proto.EvHandoffHireUpsert && ev.HandoffHire.State == proto.HandoffHireHired {
			if ev.HandoffHire.SendHomeResult != proto.HandoffSendStarted {
				t.Fatalf("record %+v", ev.HandoffHire)
			}
			hiredFirst = true
		}
		if ev.T == proto.EvWorkerRemoved && ev.ID == id {
			if !hiredFirst {
				t.Fatal("sent home before the hire")
			}
			break
		}
	}

	// The task not delivered: hired, the source stays.
	ab2 := startAgentBridge(t, "", "", "", nil)
	c2 := ab2.connect(proto.Hello{})
	c2.snapshot()
	ab2.fl.typeErrs = []error{errors.New("typing failed"), errors.New("typing failed")}
	args2 := hhArgs(ab2.ids["w1"], "op-s2", 5, hhTask)
	args2.SendHome = true
	c2.mustAck(proto.CmdWorkerHandoff, args2)
	ab2.fileAgent(t, "w1:p1")
	rec := ab2.handoffHire("op-s2", func(r proto.HandoffHire) bool { return r.Ended() })
	if rec.State != proto.HandoffHireHired || rec.Prompted == nil || *rec.Prompted || rec.PromptError == "" ||
		rec.SendHomeResult != proto.HandoffSendSkipped || !strings.Contains(rec.SendHomeReason, "stays") {
		t.Fatalf("record %+v", rec)
	}
	if _, ok := workersOf(ab2.world(func(proto.World) bool { return true }), "s")["w1"]; !ok {
		t.Fatal("the source was sent home")
	}
}

// Acceptance refuses what a hire would refuse before the ack, nothing
// held, nothing sent: a literal handoff's hire, a blank task, a bad origin,
// a desk a worker sits at, a task too long with room for the path.
func TestHandoffHireAcceptance(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	lit := hhArgs(id, "op-l", 5, "x")
	lit.Mode = proto.HandoffModeLiteral
	c.mustError(proto.CmdWorkerHandoff, lit, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerHandoff, hhArgs(id, "op-b", 5, " \n "), proto.ErrBadRequest)
	origin := hhArgs(id, "op-o", 5, "x")
	origin.Hire.Origin = "no spaces allowed"
	c.mustError(proto.CmdWorkerHandoff, origin, proto.ErrBadRequest)
	c.mustError(proto.CmdWorkerHandoff, hhArgs(id, "op-d", 1, "x"), proto.ErrDeskTaken) // w2's
	long := strings.Repeat("y", 32<<10-500) // fits a prompt, not with the path's room
	c.mustError(proto.CmdWorkerHandoff, hhArgs(id, "op-t", 5, long), proto.ErrBadRequest)
	if _, _, _, n := ab.requested("w1:p1"); n != 0 {
		t.Fatal("a refused request was sent")
	}
	if w := ab.world(func(proto.World) bool { return true }); len(w.HandoffHires) != 0 {
		t.Fatalf("records %+v", w.HandoffHires)
	}
}

// A restart while the handoff is written: the record is published failed,
// interrupted; no desk is held; the resumed request still files, the
// record learns its path, and nobody is hired nor sent home.
func TestHandoffHireRestart(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", nil)
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	args := hhArgs(id, "op-r", 5, hhTask)
	args.SendHome = true
	c.mustAck(proto.CmdWorkerHandoff, args)
	text, path, _ := ab.mustRequest(t, "w1:p1")
	if r, _ := ab.st.HandoffRequestByOp(context.Background(), "op-r"); r.Hire == nil || r.Hire.Desk != 5 || r.Hire.Origin != "tab-1" {
		t.Fatalf("marker %+v", r.Hire)
	}
	ab.stop()
	ab2 := startAgentBridge(t, ab.db, ab.dir, ab.hdir, nil)
	c2 := ab2.connect(proto.Hello{})
	snap := c2.snapshot().World
	if len(snap.HandoffHires) != 1 || snap.HandoffHires[0].Code != proto.HandoffHireInterrupted ||
		snap.HandoffHires[0].State != proto.HandoffHireFailed || snap.HandoffHires[0].DeskIndex != 5 {
		t.Fatalf("after the restart %+v", snap.HandoffHires)
	}
	if r, _ := ab2.st.HandoffRequestByOp(context.Background(), "op-r"); r.Hire != nil {
		t.Fatalf("the marker stays %+v", r.Hire)
	}
	writeDoc(t, path, agentDoc)
	appendTo(t, ab2.claude, claudeTurn(text, "Done."))
	rec := ab2.handoffHire("op-r", func(r proto.HandoffHire) bool { return r.Path != "" })
	if rec.State != proto.HandoffHireFailed || rec.Code != proto.HandoffHireInterrupted || rec.SendHomeResult != proto.HandoffSendSkipped {
		t.Fatalf("filed after the restart %+v", rec)
	}
	upsertFor(c2, id, agentState(proto.AgentHandoffFiled))
	if _, m := c2.command(proto.CmdWorkerHire, "free", hireArgs(5)); m.env.T != proto.TAck {
		t.Fatalf("the desk is held after the restart: %s", m.raw)
	}
	if n := hhCreates(ab2.fl); n != 1 { // that hire only
		t.Fatalf("%d hires", n)
	}
	if _, ok := workersOf(ab2.world(func(proto.World) bool { return true }), "s")["w1"]; !ok {
		t.Fatal("the source was sent home")
	}
}

// An ended record stays for the keep, then handoff_hire.removed.
func TestHandoffHireRetention(t *testing.T) {
	t.Parallel()
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.HandoffHireKeep = 300 * time.Millisecond })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	id := ab.ids["w1"]
	c.mustAck(proto.CmdWorkerHandoff, hhArgs(id, "op-k", 5, hhTask))
	c.mustAck(proto.CmdWorkerHandoffCancel, proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-k"})
	ev := eventWhere(c, func(ev proto.Event) bool { return ev.T == proto.EvHandoffHireRemoved })
	if ev.Op != "op-k" {
		t.Fatalf("removed %+v", ev)
	}
	if w := ab.world(func(proto.World) bool { return true }); w.HandoffHires == nil || len(w.HandoffHires) != 0 {
		t.Fatalf("records %+v", w.HandoffHires)
	}
}

// The task's secrets review is applied at acceptance: without one the
// request is refused before anything is sent; with one the task's files
// are a pending owner's, released on a cancel, and the hire's prompt
// carries references after the path line.
func TestHandoffHireSecrets(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id := ab.ids["w1"]
	args := hhArgs(id, "op-x", 5, routeText)
	_, m := c.command(proto.CmdWorkerHandoff, "x0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	if _, _, _, n := ab.requested("w1:p1"); n != 0 {
		t.Fatal("sent without the task's review")
	}
	args.Hire.Secrets = routeReview(t, c)
	c.mustAck(proto.CmdWorkerHandoff, args)
	waitFor(t, "the task's files", func() bool { return len(protectedFiles(t, dir)) == 2 })
	c.mustAck(proto.CmdWorkerHandoffCancel, proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-x"})
	waitFor(t, "the task's files released", func() bool { return len(protectedFiles(t, dir)) == 0 })

	args.Op, args.Hire.Secrets = "op-y", routeReview(t, c)
	c.mustAck(proto.CmdWorkerHandoff, args)
	var text, path string
	eventually(t, "the second request", func() bool {
		var n int
		text, path, _, n = ab.requested("w1:p1")
		return n == 2
	})
	writeDoc(t, path, agentDoc)
	appendTo(t, ab.claude, claudeTurn(text, "Done."))
	rec := ab.handoffHire("op-y", hhState(proto.HandoffHireHired))
	var ws string
	for _, w := range ab.world(func(proto.World) bool { return true }).Workers {
		if w.ID == rec.Hired {
			ws = w.WorkspaceID
		}
	}
	sent := sentPrompt(t, ab.hireBridge, ws+":p1")
	head, task, _ := strings.Cut(sent, "\n\n")
	if head != "First read the handoff here: "+rec.Path+" and then follow these instructions:" {
		t.Fatalf("sent %q", sent)
	}
	checkRouteSent(t, task)
	traceFree(t, ab.st, ab.db, []*client{c}, routeSentinel)
}

// LLM mode: acked with the record, hired once the job filed; a cancel
// while the model writes cancels the record at once and nobody is hired; a
// failed job fails it; a replay with another hire is refused.
func TestHandoffHireLLM(t *testing.T) {
	t.Parallel()
	lb := newLLMBridge(t, yes(), nil)
	c := lb.connect(proto.Hello{})
	c.snapshot()
	cand := lb.candidate(t, c)
	id := lb.ids["w1"]
	llmHire := func(op string, desk int) proto.WorkerHandoffArgs {
		a := llmArgs(id, cand, op)
		h := hireArgs(desk)
		h.Prompt = hhTask
		a.Hire = &proto.WorkerHandoffHire{WorkerHireArgs: h, Origin: "tab-1"}
		return a
	}
	out, release := blockLLM(lb)
	_, m := c.command(proto.CmdWorkerHandoff, "l1", llmHire("op-l1", 5))
	res := ackData[proto.WorkerHandoffJobResult](t, m)
	if res.HandoffHire == nil || res.HandoffHire.State != proto.HandoffHireWaiting || res.HandoffHire.Mode != proto.HandoffModeLLM {
		t.Fatalf("ack %s", m.raw)
	}
	<-out
	other := llmHire("op-l1", 4)
	c.mustError(proto.CmdWorkerHandoff, other, proto.ErrBadRequest)
	_, m = c.command(proto.CmdWorkerHandoff, "l1b", llmHire("op-l1", 5))
	if r := ackData[proto.WorkerHandoffJobResult](t, m); !r.Existing || r.HandoffHire == nil {
		t.Fatalf("replay %s", m.raw)
	}
	evs, m := c.command(proto.CmdWorkerHandoffCancel, "lc", proto.WorkerHandoffCancelArgs{Worker: id, Op: "op-l1"})
	if m.env.T != proto.TAck || !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvHandoffHireUpsert && ev.HandoffHire.State == proto.HandoffHireCancelled
	}) {
		t.Fatalf("cancel %s %+v", m.raw, evs)
	}
	release()
	upsertFor(c, id, llmJobState(store.HandoffJobCancelled))
	if hhCreates(lb.fl) != 0 {
		t.Fatal("hired after a cancel")
	}

	// Filed: hired with the filed path.
	lb.llm.llm.Func = nil
	_, m = c.command(proto.CmdWorkerHandoff, "l2", llmHire("op-l2", 5))
	ackData[proto.WorkerHandoffJobResult](t, m)
	rec := lb.handoffHire("op-l2", func(r proto.HandoffHire) bool { return r.Ended() })
	all, _ := lb.st.AllHandoffs(context.Background())
	if rec.State != proto.HandoffHireHired || len(all) != 1 || rec.Path != all[0].Path || rec.Hired == "" {
		t.Fatalf("record %+v", rec)
	}

	// The model fails: nobody hired, the handoff's reason.
	lb.llm.llm.Func = func(context.Context, ai.Request) (string, error) { return "", &ai.Error{Kind: ai.KindTimeout, Msg: "slow"} }
	c.mustAck(proto.CmdWorkerHandoff, llmHire("op-l3", 6))
	rec = lb.handoffHire("op-l3", func(r proto.HandoffHire) bool { return r.Ended() })
	if rec.State != proto.HandoffHireFailed || rec.Code != proto.HandoffHireTimeout || !strings.Contains(rec.Reason, "did not answer") {
		t.Fatalf("record %+v", rec)
	}
	if n := hhCreates(lb.fl); n != 1 {
		t.Fatalf("%d hires", n)
	}
	lb.noLeak(t, c)
}
