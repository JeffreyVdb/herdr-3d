package server_test

// #108 round 5: the protected files' lifecycle (docs/protocol.md "Prompt
// secrets" → "Round 5"): prompt_secrets.revoke, Worker.secret_files, the
// lease of a handoff's files to its successor, a hand-over to a wrap-up,
// and the files kept or removed across sleep, a gone session, a bridge
// restart, a reboot and the janitor.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents/childagentstest"
	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// secretFilesOf waits until worker id's secret_files is n (an upsert c
// hears) and returns that worker.
func secretFilesOf(c *client, id string, n int) *proto.Worker {
	c.t.Helper()
	return upsertFor(c, id, func(w *proto.Worker) bool { return w.SecretFiles == n })
}

// protect sends text to worker id with every candidate protected: the
// text sent.
func (sb *secretsBridge) protect(t *testing.T, id, text string) string {
	t.Helper()
	_, m := sb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: id, Text: text, Secrets: reviewOf(t, sb.c, text)})
	return ackData[proto.PromptResult](t, m).Sent
}

// prompt_secrets.revoke removes every file the worker holds and nothing
// else, with the switch on or off; the worker is untouched; the count is
// published before the ack; the audit row has the worker and the count,
// never a path or a byte; an unknown worker is not_found. World.prompt_
// secrets has the directory, and so does prompt_secrets.update.
func TestPromptSecretsRevoke(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, false, nil)
	probe := sb.connect(proto.Hello{})
	snap := probe.snapshot()
	if ps := snap.World.PromptSecrets; ps == nil || !ps.Available || ps.Dir != sb.dir {
		t.Fatalf("switch %+v", ps)
	}
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	for {
		m := probe.next()
		if m.env.T != proto.EvPromptSecretsUpdate {
			continue
		}
		var u proto.PromptSecretsUpdate
		if err := json.Unmarshal(m.raw, &u); err != nil || !u.Enabled || u.Dir != sb.dir {
			t.Fatalf("update %s", m.raw)
		}
		break
	}
	sent1 := sb.protect(t, sb.id1, "PASSWORD=Revoke-One-1 and TOKEN=Revoke-Two-22")
	sb.protect(t, sb.id2, "PASSWORD=Revoke-Keep-3")
	secretFilesOf(probe, sb.id1, 2)
	if w := secretFilesOf(probe, sb.id2, 1); w.SecretFiles != 1 {
		t.Fatal(w)
	}
	before := sb.files(t)

	// Switched off, a revoke still works: w1's files go, w2's stay.
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	evs, m := sb.c.command(proto.CmdPromptSecretsRevoke, "r", proto.PromptSecretsRevokeArgs{Worker: sb.id1})
	if res := ackData[proto.PromptSecretsRevoke](t, m); res.Removed != 2 {
		t.Fatalf("ack %s", m.raw)
	}
	published := false
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == sb.id1 && ev.Worker.SecretFiles == 0 {
			published = true
		}
	}
	if !published {
		t.Fatalf("no upsert of w1 without files before the ack: %+v", evs)
	}
	after := sb.files(t)
	if len(after) != 1 || !slices.Contains(slices.Collect(mapValues(after)), "Revoke-Keep-3") {
		t.Fatalf("files %v", after)
	}
	for _, r := range refRe.FindAllStringSubmatch(sent1, -1) {
		if _, err := os.Stat(r[1]); !os.IsNotExist(err) {
			t.Errorf("%s: %v", r[1], err)
		}
	}
	if rows := ownersOf(t, sb.st, "worker", sb.id1); len(rows) != 0 {
		t.Fatalf("w1's rows %+v", rows)
	}
	w := idWorker(t, sb.connect(proto.Hello{}).snapshot(), sb.id1)
	if w.SecretFiles != 0 || w.Status != "idle" || w.AgentKind != "claude" {
		t.Fatalf("w1 after the revoke %+v", w)
	}
	// Again: nothing held.
	_, m = sb.c.command(proto.CmdPromptSecretsRevoke, "r2", proto.PromptSecretsRevokeArgs{Worker: sb.id1})
	if res := ackData[proto.PromptSecretsRevoke](t, m); res.Removed != 0 {
		t.Fatalf("again %s", m.raw)
	}
	sb.c.mustError(proto.CmdPromptSecretsRevoke, proto.PromptSecretsRevokeArgs{Worker: "nobody"}, proto.ErrNotFound)
	sb.c.mustError(proto.CmdPromptSecretsRevoke, proto.PromptSecretsRevokeArgs{}, proto.ErrBadRequest)

	// The audit rows: the worker and the count, never a path or a value.
	log, err := sb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows []store.AuditEntry
	for _, e := range log {
		if e.Cmd == proto.CmdPromptSecretsRevoke {
			rows = append(rows, e)
		}
	}
	if len(rows) != 4 || !strings.Contains(rows[0].Args, sb.id1) || rows[0].Result != `{"removed":2}` {
		t.Fatalf("audit %+v", rows)
	}
	for p := range before {
		rel, _ := filepath.Rel(sb.dir, p)
		dir, name, _ := strings.Cut(rel, "/")
		for _, e := range rows {
			if strings.Contains(e.Args+e.Result+e.Error, dir) || strings.Contains(e.Args+e.Result+e.Error, name) {
				t.Fatalf("a path in the audit %+v", e)
			}
		}
	}
	sb.noTrace(t, "Revoke-One-1", "Revoke-Two-22", "Revoke-Keep-3")
}

// idWorker is worker id in a snapshot.
func idWorker(t *testing.T, snap proto.Snapshot, id string) proto.Worker {
	t.Helper()
	for _, w := range snap.World.Workers {
		if w.ID == id {
			return w
		}
	}
	t.Fatalf("no worker %s", id)
	return proto.Worker{}
}

// Without a private runtime directory a revoke is secrets_unavailable.
func TestPromptSecretsRevokeUnavailable(t *testing.T) {
	t.Parallel()
	tb := startTermBridge(t, nil, agentW("w2", "codex", "idle"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	if ps := snap.World.PromptSecrets; ps.Available || ps.Dir != "" {
		t.Fatalf("switch %+v", ps)
	}
	c.mustError(proto.CmdPromptSecretsRevoke, proto.PromptSecretsRevokeArgs{Worker: idOf(t, snap, "w2")}, proto.ErrSecretsUnavailable)
}

// A revoke that comes while a reviewed prompt waits to be typed (its files
// written, the agent not ready): the prompt is not sent once its turn
// comes (secrets_review_stale), nothing is left of its files, and the same
// submission sent again is protected anew (new files, not the revoked
// ones).
func TestPromptSecretsRevokeWhileSending(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, func(o *server.Options) { o.PromptReadyWait = 5 * time.Second })
	text := "PASSWORD=Race-Sentinel-7!"
	review := reviewOf(t, sb.c, text)
	sb.setStatus("w1", "unknown")
	sb.c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "p", Args: mustRaw(proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review})})
	waitFor(t, "the file", func() bool { return len(sb.files(t)) == 1 })
	time.Sleep(100 * time.Millisecond) // the lane job checked the review, and waits for the agent
	revoked := sb.c.reply
	sb.c.send(proto.Command{T: proto.CmdPromptSecretsRevoke, ReqID: "r", Args: mustRaw(proto.PromptSecretsRevokeArgs{Worker: sb.id1})})
	if m := revoked("r"); ackData[proto.PromptSecretsRevoke](t, m).Removed != 1 {
		t.Fatalf("revoke %s", m.raw)
	}
	sb.setStatus("w1", "idle")
	m := sb.c.reply("p")
	if codeOf(m) != proto.ErrSecretsReviewStale || !strings.Contains(errorOf(m).Message, "revoked") {
		t.Fatalf("prompt: %s", m.raw)
	}
	if calls := sb.term.Calls(); len(calls) != 0 {
		t.Fatalf("sent %q", calls)
	}
	if f := sb.files(t); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
	filesOf(sb.bridge, map[string]int{sb.id1: 0})
	// Sent again: new files, and it goes.
	sent := sb.protect(t, sb.id1, text)
	refs := refRe.FindAllStringSubmatch(sent, -1)
	if len(refs) != 1 {
		t.Fatalf("sent %q", sent)
	}
	if b, err := os.ReadFile(refs[0][1]); err != nil || string(b) != "Race-Sentinel-7!" {
		t.Fatalf("the new file: %q %v", b, err)
	}
	filesOf(sb.bridge, map[string]int{sb.id1: 1})
	sb.noTrace(t, "Race-Sentinel-7!")
}

// mustRevoke revokes worker id's files through c: how many went.
func mustRevoke(t *testing.T, c *client, id string) int {
	t.Helper()
	_, m := c.command(proto.CmdPromptSecretsRevoke, "rv", proto.PromptSecretsRevokeArgs{Worker: id})
	return ackData[proto.PromptSecretsRevoke](t, m).Removed
}

// workerIn is worker id in w (nil: not there).
func workerIn(w proto.World, id string) *proto.Worker {
	for i := range w.Workers {
		if w.Workers[i].ID == id {
			return &w.Workers[i]
		}
	}
	return nil
}

// A literal handoff records the protected files its text names (as the
// agent's and the LLM's do with their instruction's: the round 2 tests of
// worker.handoff), for a worker hired from it to hold; a handoff that names
// none records none.
func TestPromptSecretsLiteralHandoffNamesFiles(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	svc := hoService(t, filepath.Join(t.TempDir(), "handoff"), db)
	dir := secretsDirFor(t)
	off := false
	fb := startFuBridgeWith(t, db, "", newFuRoles(), &off, "", func(o *server.Options) {
		o.Handoffs, o.SecretsDir = svc, dir
		o.DigestEnabled, o.PackupEnabled, o.ActivityModel = &off, &off, &off
	})
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id := fb.ids["w1"]
	text := "PASSWORD=Literal-Sentinel-4!"
	_, m := c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: id, Text: text, Secrets: reviewOf(t, c, text)})
	ref := refRe.FindStringSubmatch(ackData[proto.PromptResult](t, m).Sent)
	if ref == nil {
		t.Fatalf("ack %s", m.raw)
	}
	file := func(op, body string) store.Handoff {
		t.Helper()
		appendTo(t, fb.claude, wrapUser("Hand it over.")+claudeReply("msg_"+op, "u-"+op, body, "end_turn")+turnDone)
		cand := *upsertFor(c, id, func(w *proto.Worker) bool { return w.Handoff != nil && w.Handoff.Message == "msg_"+op }).Handoff
		_, m := c.command(proto.CmdWorkerHandoff, "h", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral,
			Session: cand.Session, Candidate: cand.ID, Revision: cand.Revision, Op: op})
		res := ackData[proto.WorkerHandoffResult](t, m)
		filed, err := fb.st.HandoffByID(context.Background(), res.Handoff.ID)
		if err != nil {
			t.Fatal(err)
		}
		return filed
	}
	filed := file("op-a", "# Deploy\n\nThe password is in "+ref[0]+".\n")
	named, err := fb.st.HandoffSecretsAt(context.Background(), filed.Path)
	rel, _ := filepath.Rel(dir, ref[1])
	if err != nil || len(named) != 1 || named[0].Dir+"/"+named[0].Name != rel {
		t.Fatalf("the handoff names %+v %v", named, err)
	}
	filed = file("op-b", "# Notes\n\nNothing secret here.\n")
	if named, _ := fb.st.HandoffSecretsAt(context.Background(), filed.Path); len(named) != 0 {
		t.Fatalf("a handoff naming none: %+v", named)
	}
	traceFree(t, fb.st, db, []*client{c}, "Literal-Sentinel-4!")
}

// A worker hired from a handoff (its first prompt names the handoff's
// path, the cabinet's Hire from handoff) holds the protected files the
// handoff names, and one whose prompt names a file holds that file: each
// file outlives its owner while a holder lives (the janitor too), goes
// when the last holder ends, and a revoke on a holder removes it for every
// holder.
func TestPromptSecretsHandoffLease(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	svc := hoService(t, filepath.Join(t.TempDir(), "handoff"), db)
	dir := secretsDirFor(t)
	hb := startHireBridgeAt(t, db, func(o *server.Options) {
		o.SecretsDir, o.Handoffs, o.SecretsSweep = dir, svc, 20*time.Millisecond
	})
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	ctx := context.Background()
	hire := func(desk int, prompt string, review *proto.SecretsReview) proto.HireResult {
		t.Helper()
		a := hireArgs(desk)
		a.Prompt, a.Secrets = prompt, review
		_, m := hb.c.command(proto.CmdWorkerHire, "h", a)
		res := ackData[proto.HireResult](t, m)
		if res.Prompted == nil || !*res.Prompted {
			t.Fatalf("hire %s", m.raw)
		}
		return res
	}
	// A owns two files.
	ra := hire(0, routeText, routeReview(t, hb.c))
	refs := refRe.FindAllStringSubmatch(sentPrompt(t, hb, ra.WorkspaceID+":p1"), -1)
	p0, p1 := refs[0][1], refs[1][1]
	// A's handoff names the first (as filing records it).
	filed, _, err := svc.File(ctx, handoff.Source{Floor: "s", WorkerID: ra.ID, Kind: store.HandoffLiteral, Op: "op-lease"},
		"# Deploy\n\nUse the credential in "+promptsecret.Reference(p0)+".\n")
	if err != nil {
		t.Fatal(err)
	}
	d0, n0, _ := strings.Cut(strings.TrimPrefix(p0, dir+"/"), "/")
	if n, err := hb.st.AddHandoffSecrets(ctx, filed.ID, []store.SecretFile{{Dir: d0, Name: n0}}); err != nil || n != 1 {
		t.Fatalf("handoff secrets %d %v", n, err)
	}
	// B, hired from the handoff, holds it; C's prompt names the second.
	rb := hire(1, handoff.HireTask(filed.Path), nil)
	rc := hire(2, "Deploy with "+promptsecret.Reference(p1)+" now.", nil)
	hb.world(func(w proto.World) bool {
		a, b, c := workerIn(w, ra.ID), workerIn(w, rb.ID), workerIn(w, rc.ID)
		return a != nil && b != nil && c != nil && a.SecretFiles == 2 && b.SecretFiles == 1 && c.SecretFiles == 1
	})
	if l, _ := hb.st.SecretLeasesOf(ctx, rb.ID); len(l) != 1 || l[0].Dir != d0 || l[0].Name != n0 {
		t.Fatalf("B's leases %+v", l)
	}

	// A revoke on C removes the second file for A too.
	if n := mustRevoke(t, hb.c, rc.ID); n != 1 {
		t.Fatalf("revoked %d", n)
	}
	if _, err := os.Stat(p1); !os.IsNotExist(err) {
		t.Fatalf("the revoked file: %v", err)
	}
	hb.world(func(w proto.World) bool { a := workerIn(w, ra.ID); return a != nil && a.SecretFiles == 1 })

	// A ends: the first file stays for B, the janitor keeps it while B lives.
	hb.fl.close(ra.WorkspaceID)
	hb.world(func(w proto.World) bool { return workerIn(w, ra.ID) == nil })
	time.Sleep(150 * time.Millisecond) // the release, and a few sweeps
	if b, err := os.ReadFile(p0); err != nil || string(b) != routeSentinel {
		t.Fatalf("the leased file after its owner ended: %q %v", b, err)
	}
	if w := workerIn(hb.world(func(proto.World) bool { return true }), rb.ID); w.SecretFiles != 1 {
		t.Fatalf("B %+v", w)
	}
	// B ends too: it goes, with A's directory.
	hb.fl.close(rb.WorkspaceID)
	waitFor(t, "the last holder's file to go", func() bool {
		_, err := os.Stat(filepath.Dir(p0))
		return os.IsNotExist(err)
	})
	waitFor(t, "no owner left", func() bool {
		rows, _ := hb.st.SecretOwners(ctx)
		leases, _ := hb.st.SecretLeases(ctx)
		return len(rows) == 0 && len(leases) == 0
	})
}

// filesOf waits until workers' secret_files are want (by id) in b's world.
func filesOf(b *bridge, want map[string]int) {
	b.t.Helper()
	b.world(func(w proto.World) bool {
		for id, n := range want {
			if x := workerIn(w, id); x == nil || x.SecretFiles != n {
				return false
			}
		}
		return true
	})
}

// A worker's files (and its secret_files) are kept, with the janitor
// sweeping, while its floor sleeps and wakes, while its herdr session is
// gone and when it resumes, and over a bridge restart with the worker
// still open in the store (herdr restores it, or never closed it: a
// directory that survived a reboot is the same case). A reboot that
// empties the runtime directory (tmpfs) leaves nothing: the rows are
// forgotten, the counts go, and the next review writes again.
func TestPromptSecretsKeptAcrossSleepRestartAndReboot(t *testing.T) {
	t.Parallel()
	sweep := func(o *server.Options) { o.SecretsSweep = 20 * time.Millisecond }
	sb := startSecretsBridge(t, true, sweep)
	sb.protect(t, sb.id1, "PASSWORD=Kept-Sentinel-1")
	sb.protect(t, sb.id2, "PASSWORD=Kept-Sentinel-2 TOKEN=Kept-Sentinel-22")
	counts := map[string]int{sb.id1: 1, sb.id2: 2}
	filesOf(sb.bridge, counts)
	kept := func(when string) {
		t.Helper()
		time.Sleep(100 * time.Millisecond) // a few sweeps
		if f := sb.files(t); len(f) != 3 {
			t.Fatalf("%s: files %v", when, f)
		}
	}
	sb.publishFloor(false) // asleep
	kept("asleep")
	sb.publishFloor(true) // awake
	filesOf(sb.bridge, counts)
	// An asleep floor's worker is shown: its files can be revoked.
	sb.protect(t, sb.id1, "PASSWORD=Asleep-Revoked-4")
	filesOf(sb.bridge, map[string]int{sb.id1: 2})
	sb.publishFloor(false)
	if n := mustRevoke(t, sb.c, sb.id1); n != 2 {
		t.Fatalf("revoked %d while asleep", n)
	}
	sb.publishFloor(true)
	sb.protect(t, sb.id1, "PASSWORD=Kept-Sentinel-1")
	sb.publish(world.FloorGone{Session: "s"})
	kept("the herdr session gone")
	sb.publishFloor(true) // back: the workers resume
	filesOf(sb.bridge, counts)

	// A bridge restart: the startup sweep keeps them, the counts come back.
	sb.stop()
	workers := []world.WorkerObs{agentW("w1", "claude", "idle"), agentW("w2", "codex", "idle")}
	b2 := startTermBridgeAt(t, sb.db, func(o *server.Options) { o.SecretsDir = sb.dir; sweep(o) }, workers...)
	filesOf(b2.bridge, counts)
	kept("restarted")

	// A reboot empties the runtime directory; herdr restores the workers.
	b2.stop()
	if err := os.RemoveAll(sb.dir); err != nil {
		t.Fatal(err)
	}
	b3 := startTermBridgeAt(t, sb.db, func(o *server.Options) { o.SecretsDir = sb.dir; sweep(o) }, workers...)
	waitFor(t, "the rows to be forgotten", func() bool {
		rows, _ := b3.st.SecretOwners(context.Background())
		return len(rows) == 0
	})
	filesOf(b3.bridge, map[string]int{sb.id1: 0, sb.id2: 0})
	sb3 := &secretsBridge{termBridge: b3, dir: sb.dir, db: sb.db, c: b3.connect(proto.Hello{Client: "game"}), id1: sb.id1, id2: sb.id2}
	sb3.c.snapshot()
	if sent := sb3.protect(t, sb.id1, "PASSWORD=Kept-Sentinel-3"); !strings.Contains(sent, "[secret in file "+sb.dir+"/") {
		t.Fatalf("after the reboot: %q", sent)
	}
	filesOf(b3.bridge, map[string]int{sb.id1: 1})
}

// At start the janitor removes what a crash or a bridge that was down left:
// the files of a worker whose close was seen but not released, except one
// an open worker holds by a lease (kept until that worker ends too), a
// lease of a worker the store does not know, an expired pending owner, a
// row whose file is gone and a file with no row.
func TestPromptSecretsStartupSweepLeasesAndExpiry(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	sb.stop()
	ctx := context.Background()
	st, err := store.Open(ctx, sb.db)
	if err != nil {
		t.Fatal(err)
	}
	f, err := secretfiles.Open(secretfiles.Options{Dir: sb.dir, Store: st})
	if err != nil {
		t.Fatal(err)
	}
	a, err := f.Write(ctx, secretfiles.Worker(sb.id1), time.Time{}, [][]byte{[]byte("held"), []byte("unheld"), []byte("stranger")})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := f.Lease(ctx, sb.id2, a[:1]); err != nil || n != 1 {
		t.Fatalf("lease %d %v", n, err)
	}
	if n, err := f.Lease(ctx, "a-worker-never-seen", a[2:]); err != nil || n != 1 {
		t.Fatalf("lease %d %v", n, err)
	}
	pending, err := f.Write(ctx, secretfiles.NewPending(), time.Now().Add(-time.Minute), [][]byte{[]byte("expired")})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.AddSecretFile(ctx, a[0].Dir, "ROWONLYROWONLYROWONLYROWO2"); err != nil {
		t.Fatal(err)
	}
	stray := filepath.Join(sb.dir, a[0].Dir, "STRAYSTRAYSTRAYSTRAYSTRAY2")
	if err := os.WriteFile(stray, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := st.CloseWorker(ctx, sb.id1); err != nil { // its close was seen, its release never ran
		t.Fatal(err)
	}
	f.Close()
	st.Close()

	b2 := startBridge(t, sb.db, server.Options{SecretsDir: sb.dir})
	b2.connect(proto.Hello{}).snapshot()
	waitFor(t, "the startup sweep", func() bool {
		files := protectedFiles(t, sb.dir)
		_, held := files[a[0].Path]
		_, err := os.Stat(filepath.Dir(pending[0].Path))
		return len(files) == 1 && held && os.IsNotExist(err)
	})
	if names, _ := b2.st.SecretFiles(ctx, a[0].Dir); !slices.Equal(names, []string{a[0].Name}) {
		t.Fatalf("rows %q", names)
	}
	if l, _ := b2.st.SecretLeases(ctx); len(l) != 1 || l[0].WorkerID != sb.id2 {
		t.Fatalf("leases %+v", l)
	}
	// Its holder closed too (while the bridge was down): gone at the next start.
	b2.stop()
	st, err = store.Open(ctx, sb.db)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CloseWorker(ctx, sb.id2); err != nil {
		t.Fatal(err)
	}
	st.Close()
	b3 := startBridge(t, sb.db, server.Options{SecretsDir: sb.dir})
	b3.connect(proto.Hello{}).snapshot()
	waitFor(t, "the last holder's file to go", func() bool {
		rows, _ := b3.st.SecretOwners(ctx)
		return len(protectedFiles(t, sb.dir)) == 0 && len(rows) == 0
	})
}

// Native child agents (#22) are conversations inside their worker's
// session and share its lifetime: a child starting, ending, being dropped
// with a replaced agent session (its generation), or the janitor sweeping
// meanwhile, never releases or sweeps the worker's files; only the worker
// ending does.
func TestPromptSecretsChildAgentsShareTheirWorkersFiles(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := filepath.Join(t.TempDir(), "world.db")
	dir := secretsDirFor(t)
	first := startBridge(t, db, server.Options{SecretsDir: dir})
	first.connect(proto.Hello{}).snapshot()
	first.floor("s", true, worker("w1", "w1", "sess-1", "working"))
	id := workersOf(first.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")["w1"].ID
	first.stop()
	st, err := store.Open(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	f, err := secretfiles.Open(secretfiles.Options{Dir: dir, Store: st})
	if err != nil {
		t.Fatal(err)
	}
	files, err := f.Write(ctx, secretfiles.Worker(id), time.Time{}, [][]byte{[]byte("parent-secret")})
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	st.Close()

	src := childagentstest.NewFixtureSource()
	b := startBridge(t, db, server.Options{SecretsDir: dir, SecretsSweep: 20 * time.Millisecond, ChildSources: []childagents.Source{src}})
	c := b.connect(proto.Hello{})
	c.snapshot()
	b.floor("s", true, worker("w1", "w1", "sess-1", "working"))
	src.Wait()
	filesOf(b, map[string]int{id: 1})
	for _, state := range []string{proto.ChildRunning, proto.ChildShutDown} {
		src.Emit(childagents.Evidence{Session: "sess-1", Provider: proto.ChildClaude, NativeID: "a1", State: state, Source: proto.ChildFromHook})
		c.until(proto.EvChildUpsert)
	}
	src.Emit(childagents.Evidence{Session: "sess-1", Provider: proto.ChildClaude, NativeID: "a2", State: proto.ChildRunning, Source: proto.ChildFromHook})
	c.until(proto.EvChildUpsert)
	b.floor("s", true, worker("w1", "w1", "sess-2", "working")) // the agent session replaced: its children go
	upsertFor(c, id, func(w *proto.Worker) bool { return w.AgentSession == "sess-2" })
	time.Sleep(100 * time.Millisecond) // a few sweeps
	if got, err := os.ReadFile(files[0].Path); err != nil || string(got) != "parent-secret" {
		t.Fatalf("the worker's file: %q %v", got, err)
	}
	w := idWorker(t, b.connect(proto.Hello{}).snapshot(), id)
	if w.SecretFiles != 1 || len(b.connect(proto.Hello{}).snapshot().World.Children) != 0 {
		t.Fatalf("worker %+v", w)
	}
	b.floor("s", true) // the worker ends: its files go
	waitFor(t, "the ended worker's file to go", func() bool {
		_, err := os.Stat(files[0].Path)
		return os.IsNotExist(err)
	})
}

// worker.wrapup with packup.detect's hand-over for its worker: a prompt
// that is the hand-over's task, a blank line and more needs no review for
// the task (the rest is reviewed alone), and the hand-over's files become
// the worker's before it arms; another worker's, an expired hand-over and
// one while the switch is off are secrets_review_stale.
func TestPromptSecretsWrapUpHandOver(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	roles := newPkRoles()
	wb := startWrapBridge(t, "", "", func(o *server.Options) {
		o.SecretsDir, o.PackupRoles, o.PackupEnabled, o.SecretPendingTTL = dir, roles, on(), 1500*time.Millisecond
	})
	c := wb.connect(proto.Hello{Client: "wrap-test"})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	w1, w2 := wb.ids["w1"], wb.ids["w2"]
	text := previewText + " and end your turn"
	_, m := c.command(proto.CmdPackupDetect, "d", proto.PackupDetectArgs{ID: w1, Text: text, Secrets: reviewOf(t, c, text, "c3", "c4")})
	pk := ackData[proto.PackupDetectResult](t, m)
	if pk.SecretsPending == "" || pk.Protected != 2 {
		t.Fatalf("packup %s", m.raw)
	}
	filesOf(wb.bridge, map[string]int{w1: 0}) // pending: nobody's yet
	// The rest after the task has a candidate of its own: reviewed alone.
	rest := "Then rotate PASSWORD=Cleanup-Sentinel-8 and tidy up."
	args := proto.WorkerWrapUpArgs{ID: w1, Prompt: pk.Task + "\n\n" + rest, Worktree: proto.FireKeep, SecretsPending: pk.SecretsPending}
	_, m = c.command(proto.CmdWorkerWrapUp, "w0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("the rest unreviewed: %s", m.raw)
	}
	if rows := ownersOf(t, wb.st, "worker", w1); len(rows) != 0 {
		t.Fatalf("claimed by a refused wrap-up: %+v", rows)
	}
	// Another worker's wrap-up with w1's hand-over: stale.
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: w2, Prompt: pk.Task, Worktree: proto.FireKeep,
		SecretsPending: pk.SecretsPending}, proto.ErrSecretsReviewStale)

	args.Secrets = reviewOf(t, c, rest)
	_, m = c.command(proto.CmdWorkerWrapUp, "w1", args)
	if m.env.T != proto.TAck {
		t.Fatalf("wrap-up: %s", m.raw)
	}
	typed, _ := wb.prompted(t, "w1:p1")
	task, after, ok := strings.Cut(typed, "\n\nThen rotate PASSWORD=")
	if !ok || task != pk.Task || strings.Contains(typed, "Cleanup-Sentinel-8") || !refRe.MatchString(after) {
		t.Fatalf("typed %q", typed)
	}
	checkRouteSent(t, task) // the hand-over's references and ignored copy; API_KEY as typed
	// w1 owns the hand-over's directory (claimed) and the rest's.
	if rows := ownersOf(t, wb.st, "worker", w1); len(rows) != 2 {
		t.Fatalf("w1 owns %+v", rows)
	}
	if rows, _ := wb.st.SecretOwners(context.Background()); len(rows) != 2 {
		t.Fatalf("owners %+v", rows)
	}
	filesOf(wb.bridge, map[string]int{w1: 3}) // claimed (2) and written (1)

	// An expired hand-over: stale, nothing armed or claimed.
	text2 := "PASSWORD=Expiring-Sentinel-5 and end your turn"
	_, m = c.command(proto.CmdPackupDetect, "d2", proto.PackupDetectArgs{ID: w2, Text: text2, Secrets: reviewOf(t, c, text2)})
	pk2 := ackData[proto.PackupDetectResult](t, m)
	time.Sleep(1600 * time.Millisecond)
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: w2, Prompt: pk2.Task, Worktree: proto.FireKeep,
		SecretsPending: pk2.SecretsPending}, proto.ErrSecretsReviewStale)
	if rows := ownersOf(t, wb.st, "worker", w2); len(rows) != 0 {
		t.Fatalf("w2 owns %+v", rows)
	}
	// Switched off: a hand-over is stale.
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	c.mustError(proto.CmdWorkerWrapUp, proto.WorkerWrapUpArgs{ID: w2, Prompt: "tidy up", Worktree: proto.FireKeep,
		SecretsPending: pk2.SecretsPending}, proto.ErrSecretsReviewStale)
	traceFree(t, wb.st, wb.db, []*client{c}, routeSentinel, "Cleanup-Sentinel-8", "Expiring-Sentinel-5")
}

// A scheduled agent with a handoff_path is a successor too: its fire's
// worker holds the files the handoff names.
func TestPromptSecretsScheduledSuccessorHoldsTheHandoffsFiles(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	svc := hoService(t, filepath.Join(t.TempDir(), "handoff"), db)
	dir := secretsDirFor(t)
	sb := startSchedBridgeAt(t, db, newClock(t0.UnixMilli()), func(o *server.Options) { o.SecretsDir, o.Handoffs = dir, svc })
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	ctx := context.Background()
	a := hireArgs(0)
	a.Prompt, a.Secrets = routeText, routeReview(t, sb.c)
	_, m := sb.c.command(proto.CmdWorkerHire, "h", a)
	ra := ackData[proto.HireResult](t, m)
	p0 := refRe.FindStringSubmatch(sentPrompt(t, sb.hireBridge, ra.WorkspaceID+":p1"))[1]
	filed, _, err := svc.File(ctx, handoff.Source{Floor: "s", WorkerID: ra.ID, Kind: store.HandoffLiteral, Op: "op-sched"},
		"# Rotate\n\nThe key is in "+promptsecret.Reference(p0)+".\n")
	if err != nil {
		t.Fatal(err)
	}
	d0, n0, _ := strings.Cut(strings.TrimPrefix(p0, dir+"/"), "/")
	if _, err := sb.st.AddHandoffSecrets(ctx, filed.ID, []store.SecretFile{{Dir: d0, Name: n0}}); err != nil {
		t.Fatal(err)
	}
	sp := spec(t0.Add(time.Hour))
	sp.Prompt, sp.HandoffPath = "Carry on.", filed.Path
	s := sb.create(sp)
	sb.c.mustAck(proto.CmdScheduleRunNow, proto.ScheduleArgs{ID: s.ID})
	done := sb.schedule(s.ID, inState(store.ScheduleDone))
	sb.world(func(w proto.World) bool { x := workerIn(w, done.WorkerID); return x != nil && x.SecretFiles == 1 })
	if l, _ := sb.st.SecretLeasesOf(ctx, done.WorkerID); len(l) != 1 || l[0].Dir != d0 || l[0].Name != n0 {
		t.Fatalf("the scheduled worker's leases %+v", l)
	}
}
