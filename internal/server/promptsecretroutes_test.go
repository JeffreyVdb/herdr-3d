package server_test

// #108 round 2: the review gate on every route other than worker.prompt
// (docs/protocol.md "Prompt secrets"). Each route family: without a review
// the text is refused and the sentinel is nowhere (herdr, the language
// model, the files, the audit log, what the clients heard, the database
// and its WAL); with a review the agent or the model gets references, the
// files hold the exact bytes and an ignored copy of a protected repeated
// value stays plain; the switch off is today's behaviour.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/handoffllm"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// routeText is a sentinel prompt: c1 (DB_PASSWORD's value) and c2 (TOKEN's)
// are protected by routeReview, c3 (TOKEN2's, the same value) is ignored.
// routeSentinel must be nowhere after; twinValue stays once, as typed.
const (
	routeSentinel = "Route-Sentinel-41!"
	twinValue     = "Twin-Value-77#"
	routeText     = "Deploy it.\nDB_PASSWORD=" + routeSentinel + "\nexport TOKEN='" + twinValue + "' then TOKEN2='" + twinValue + "'"
	// previewText is routeText and c4, a value left as typed that the scan
	// still finds once the others are references (a follow-up without the
	// hand-over needs its review again).
	keptValue   = "Ignored-Kept-55"
	previewText = routeText + "\nAPI_KEY=" + keptValue
)

// secretsDirFor is a protected secrets directory for a test bridge, in a
// private parent as a runtime directory is.
func secretsDirFor(t *testing.T) string {
	t.Helper()
	run := filepath.Join(t.TempDir(), "run")
	if err := os.Mkdir(run, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(run, "secrets")
}

// traceFree checks that none of the values is in an audit row, anything the
// clients heard, or the database's bytes (its WAL too).
func traceFree(t *testing.T, st *store.Store, db string, cs []*client, values ...string) {
	t.Helper()
	log, err := st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows strings.Builder
	for _, e := range log {
		rows.WriteString(e.Cmd + " " + e.Args + " " + e.Error + " " + e.Result + "\n")
	}
	var dbBytes []byte
	for _, suffix := range []string{"", "-wal", "-shm"} {
		b, _ := os.ReadFile(db + suffix)
		dbBytes = append(dbBytes, b...)
	}
	for _, v := range values {
		if strings.Contains(rows.String(), v) {
			t.Errorf("%q in the audit log:\n%s", v, rows.String())
		}
		for _, c := range cs {
			if strings.Contains(c.heard.String(), v) || strings.Contains(c.heard.String(), jsonEscaped(v)) {
				t.Errorf("%q in what a client heard", v)
			}
		}
		if bytes.Contains(dbBytes, []byte(v)) {
			t.Errorf("%q in the database", v)
		}
	}
}

// reviewOf scans text through c and decides every candidate: protected,
// but those ignore names (ids) left as typed.
func reviewOf(t *testing.T, c *client, text string, ignore ...string) *proto.SecretsReview {
	t.Helper()
	_, m := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
	s := ackData[proto.PromptSecretsScan](t, m)
	r := &proto.SecretsReview{Revision: s.Revision, Decisions: []proto.SecretDecision{}}
	for _, cand := range s.Candidates {
		action := proto.SecretProtect
		if slices.Contains(ignore, cand.ID) {
			action = proto.SecretIgnore
		}
		r.Decisions = append(r.Decisions, proto.SecretDecision{Candidate: cand.ID, Action: action})
	}
	return r
}

// routeReview is routeText's review: c1 and c2 protected, c3 ignored.
func routeReview(t *testing.T, c *client) *proto.SecretsReview {
	t.Helper()
	r := reviewOf(t, c, routeText, "c3")
	if len(r.Decisions) != 3 {
		t.Fatalf("routeText has %d candidates", len(r.Decisions))
	}
	return r
}

// codeOf is a reply's error code ("": an ack).
func codeOf(m msg) string {
	if m.env.T != proto.TError {
		return ""
	}
	return errorOf(m).Code
}

// checkRouteSent checks what an agent or model got for routeText: the
// protected values as references to files holding their exact bytes, the
// ignored copy as typed, the rest as typed. It returns the files' paths.
func checkRouteSent(t *testing.T, sent string) []string {
	t.Helper()
	refs := refRe.FindAllStringSubmatch(sent, -1)
	want := []string{routeSentinel, twinValue}
	if len(refs) != len(want) || strings.Contains(sent, routeSentinel) || strings.Count(sent, twinValue) != 1 ||
		!strings.Contains(sent, "TOKEN2='"+twinValue+"'") {
		t.Fatalf("sent %q", sent)
	}
	restored := sent
	var paths []string
	for i, r := range refs {
		b, err := os.ReadFile(r[1])
		if err != nil || string(b) != want[i] {
			t.Fatalf("file %d holds %q (%v), want %q", i, b, err, want[i])
		}
		if fi, _ := os.Lstat(r[1]); fi.Mode() != 0o600 {
			t.Errorf("file mode %v", fi.Mode())
		}
		restored = strings.Replace(restored, r[0], string(b), 1)
		paths = append(paths, r[1])
	}
	if !strings.Contains(restored, routeText) {
		t.Fatalf("not the typed text with references: %q", sent)
	}
	return paths
}

// ownersOf are the owner directories' rows of kind and id.
func ownersOf(t *testing.T, st *store.Store, kind, id string) []store.SecretOwner {
	t.Helper()
	rows, err := st.SecretOwnersOf(context.Background(), kind, id)
	if err != nil {
		t.Fatal(err)
	}
	return rows
}

// startSecretsHireBridge is a hire bridge with a protected secrets
// directory, the switch on or off.
func startSecretsHireBridge(t *testing.T, on bool, tweak func(*server.Options)) (*hireBridge, string) {
	t.Helper()
	dir := secretsDirFor(t)
	hb := startHireBridge(t, func(o *server.Options) {
		o.SecretsDir = dir
		if tweak != nil {
			tweak(o)
		}
	})
	if on {
		hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	}
	return hb, dir
}

// worker.hire: refused without a review (no workspace, no file, no
// trace); with one, the first prompt holds references to files the new
// worker owns; the herdr hiring instructions follow the protected task;
// the switch off hires as today.
func TestPromptSecretsHire(t *testing.T) {
	t.Parallel()
	hb, dir := startSecretsHireBridge(t, true, nil)
	a := hireArgs(0)
	a.Prompt = routeText
	_, m := hb.c.command(proto.CmdWorkerHire, "h0", a)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr was called: %q", calls)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, routeSentinel, twinValue)

	a.Secrets = routeReview(t, hb.c)
	_, m = hb.c.command(proto.CmdWorkerHire, "h1", a)
	res := ackData[proto.HireResult](t, m)
	if res.Protected != 2 || res.Prompted == nil || !*res.Prompted {
		t.Fatalf("ack %s", m.raw)
	}
	paths := checkRouteSent(t, sentPrompt(t, hb, res.WorkspaceID+":p1"))
	if rows := ownersOf(t, hb.st, "worker", res.ID); len(rows) != 1 || !strings.Contains(paths[0], rows[0].Dir) {
		t.Fatalf("the worker owns %+v", rows)
	}
	if rows, _ := hb.st.SecretOwners(context.Background()); len(rows) != 1 {
		t.Fatalf("owners %+v", rows)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, routeSentinel)
	// The identical hire again (its ack lost): the desk is the first one's,
	// so it is refused as today, and no file is left beside the first's.
	_, m = hb.c.command(proto.CmdWorkerHire, "h1", a)
	if code := codeOf(m); code != proto.ErrDeskTaken {
		t.Fatalf("retry: %s", m.raw)
	}
	waitFor(t, "only the first hire's files", func() bool { return len(protectedFiles(t, dir)) == 2 })

	// The herdr hiring instructions go after the protected task.
	a.DeskIndex, a.HerdrInstructions, a.Secrets = ptr(1), true, routeReview(t, hb.c)
	_, m = hb.c.command(proto.CmdWorkerHire, "h2", a)
	res = ackData[proto.HireResult](t, m)
	task, lines, _ := strings.Cut(sentPrompt(t, hb, res.WorkspaceID+":p1"), "\n\n")
	if !strings.Contains(lines, "herdr") || res.Protected != 2 {
		t.Fatalf("no hiring instructions after the task: %q", lines)
	}
	checkRouteSent(t, task)
	traceFree(t, hb.st, hb.db, []*client{hb.c}, routeSentinel)

	// A review while the switch is off is stale, and off hires as today.
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	a.DeskIndex, a.HerdrInstructions = ptr(2), false
	_, m = hb.c.command(proto.CmdWorkerHire, "h3", a)
	if code := codeOf(m); code != proto.ErrSecretsReviewStale {
		t.Fatalf("a review while off: %s", m.raw)
	}
	a.Secrets = nil
	before := len(protectedFiles(t, dir))
	_, m = hb.c.command(proto.CmdWorkerHire, "h4", a)
	res = ackData[proto.HireResult](t, m)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != routeText || res.Protected != 0 {
		t.Fatalf("off: sent %q, ack %s", got, m.raw)
	}
	if n := len(protectedFiles(t, dir)); n != before {
		t.Fatalf("off: %d files, was %d", n, before)
	}
}

// A hire that fails removes the files its review made, before its
// workspace (refused, herdr failing) or after it (rolled back); limits
// apply to the prompt with its references.
func TestPromptSecretsHireFailureReleases(t *testing.T) {
	t.Parallel()
	hb, dir := startSecretsHireBridge(t, true, nil)
	hire := func(req string, a proto.WorkerHireArgs) msg {
		t.Helper()
		_, m := hb.c.command(proto.CmdWorkerHire, req, a)
		return m
	}
	a := hireArgs(0)
	a.Prompt = routeText

	// The desk is taken by the time the gate is done: refused, files gone.
	busy := hireArgs(0)
	if m := hire("b", busy); m.env.T != proto.TAck {
		t.Fatalf("first hire %s", m.raw)
	}
	a.Secrets = routeReview(t, hb.c)
	if code := codeOf(hire("taken", a)); code != proto.ErrDeskTaken {
		t.Fatal("a taken desk was not refused")
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })

	// herdr fails before the workspace exists, and after (rolled back).
	hb.fl.mu.Lock()
	hb.fl.createErr = errors.New("boom")
	hb.fl.mu.Unlock()
	a.DeskIndex, a.Secrets = ptr(1), routeReview(t, hb.c)
	if code := codeOf(hire("create", a)); code == "" {
		t.Fatal("the failed create was acked")
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })
	hb.fl.mu.Lock()
	hb.fl.createErr, hb.fl.startErr = nil, errors.New("no agent")
	hb.fl.mu.Unlock()
	a.Secrets = routeReview(t, hb.c)
	if code := codeOf(hire("start", a)); code == "" {
		t.Fatal("the failed start was acked")
	}
	waitFor(t, "the rolled back hire's files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })
	if rows, _ := hb.st.SecretOwners(context.Background()); len(rows) != 0 {
		t.Fatalf("owners left %+v", rows)
	}

	// Too long with its references (it fits as typed): bad_request, no file.
	hb.fl.mu.Lock()
	hb.fl.startErr = nil
	hb.fl.mu.Unlock()
	long := routeText + "\n" + strings.Repeat("x", 32<<10-len(routeText)-2)
	a.Prompt, a.Secrets = long, nil
	if code := codeOf(hire("long0", a)); code != proto.ErrSecretsReviewRequired { // it fits as typed
		t.Fatal("the long prompt did not fit as typed")
	}
	a.Secrets = reviewOf(t, hb.c, long, "c3")
	if code := codeOf(hire("long", a)); code != proto.ErrBadRequest {
		t.Fatal("over the limit with references was not refused")
	}
	// A prompt herdr would read as a flag is refused before any scan.
	a.Prompt, a.Secrets = "--"+routeText, nil
	if code := codeOf(hire("flag", a)); code != proto.ErrBadRequest {
		t.Fatal("a -- prompt was not refused")
	}
	waitFor(t, "no files", func() bool { return len(protectedFiles(t, dir)) == 0 })
	traceFree(t, hb.st, hb.db, []*client{hb.c}, routeSentinel)
}

// Schedules keep no protected file: with the switch on, a prompt with
// possible secrets is refused without a review, and a review that protects
// one is secrets_review_stored; one that leaves all as typed is stored
// with its record, and its fire sends it as typed. A fire, a retry or a
// run now of a prompt that has no such record fails visibly and sends
// nothing; off, it fires as today.
func TestPromptSecretsSchedules(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	sb := startSchedBridge(t, func(o *server.Options) { o.SecretsDir = dir })
	const before = "Rotate it: DB_PASSWORD=Before-Switch-3!"
	sp := spec(t0.Add(time.Hour))
	sp.Prompt = before
	old := sb.create(sp) // saved while the switch was off
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})

	sb.at(t0.Add(time.Hour))
	failed := sb.schedule(old.ID, inState(store.ScheduleFailed))
	if !strings.Contains(failed.StateReason, "review") || len(sb.creates()) != 0 || len(sb.prompts()) != 0 {
		t.Fatalf("unreviewed fire: %+v, creates %q, prompts %q", failed, sb.creates(), sb.prompts())
	}
	sb.c.mustAck(proto.CmdScheduleRetry, proto.ScheduleArgs{ID: old.ID})
	sb.schedule(old.ID, func(s proto.Schedule) bool { return s.State == store.ScheduleFailed && s.FiredAt != nil })
	if len(sb.creates()) != 0 {
		t.Fatalf("a retry hired: %q", sb.creates())
	}

	// New ones: refused without a review, or with one that protects.
	sp = spec(t0.Add(2 * time.Hour))
	sp.Prompt = routeText
	_, m := sb.c.command(proto.CmdScheduleCreate, "c1", sp)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	sp.Secrets = routeReview(t, sb.c)
	_, m = sb.c.command(proto.CmdScheduleCreate, "c2", sp)
	if code := codeOf(m); code != proto.ErrSecretsReviewStored || !strings.Contains(errorOf(m).Message, "remove") {
		t.Fatalf("protected: %s", m.raw)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
	traceFree(t, sb.st, sb.db, []*client{sb.c}, routeSentinel, twinValue)

	// All left as typed: stored with its record, fired as typed.
	const kept = "Rotate it: DB_PASSWORD=Kept-As-Typed-8!"
	sp.Prompt, sp.Secrets = kept, reviewOf(t, sb.c, kept, "c1")
	s := sb.create(sp)
	if row, err := sb.st.ScheduleByID(context.Background(), s.ID); err != nil || row.SecretsReview == "" || s.Prompt != kept {
		t.Fatalf("stored %+v, %v", row, err)
	}
	sb.at(t0.Add(2 * time.Hour))
	sb.schedule(s.ID, inState(store.ScheduleDone))
	if p := sb.prompts(); !slices.Equal(p, []string{kept}) {
		t.Fatalf("prompts %q", p)
	}

	// The old one reviewed now (its update), then run again: sent as typed.
	upd := spec(t0.Add(5 * time.Hour))
	upd.Prompt, upd.Secrets = before, reviewOf(t, sb.c, before, "c1")
	_, m = sb.c.command(proto.CmdScheduleUpdate, "u", proto.ScheduleUpdateArgs{ID: old.ID, ScheduleSpec: upd})
	if code := codeOf(m); code != proto.ErrInvalidState { // a failed one is not updated, it is retried
		t.Fatalf("update of a failed one: %s", m.raw)
	}
	sp = spec(t0.Add(6 * time.Hour))
	sp.Prompt = before
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	unreviewed := sb.create(sp)
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	sb.c.mustAck(proto.CmdScheduleRunNow, proto.ScheduleArgs{ID: unreviewed.ID})
	sb.schedule(unreviewed.ID, inState(store.ScheduleFailed))
	if p := sb.prompts(); len(p) != 1 {
		t.Fatalf("run now sent %q", p)
	}

	// Switch off: an unreviewed one fires as today.
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	sb.c.mustAck(proto.CmdScheduleRetry, proto.ScheduleArgs{ID: old.ID})
	sb.schedule(old.ID, inState(store.ScheduleDone))
	if p := sb.prompts(); len(p) != 2 || !strings.HasSuffix(p[1], "\n\n"+before) {
		t.Fatalf("off: prompts %q", p)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
}

// A schedule's update needs the review of its prompt again (a due time
// changed alone included), and keeps the record of the text it stores.
func TestPromptSecretsScheduleUpdate(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	sb := startSchedBridge(t, func(o *server.Options) { o.SecretsDir = dir })
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	const kept = "Rotate it: DB_PASSWORD=Kept-As-Typed-8!"
	sp := spec(t0.Add(time.Hour))
	sp.Prompt, sp.Secrets = kept, reviewOf(t, sb.c, kept, "c1")
	s := sb.create(sp)
	row, _ := sb.st.ScheduleByID(context.Background(), s.ID)
	sp.DueAt, sp.Secrets = t0.Add(2*time.Hour).UnixMilli(), nil
	_, m := sb.c.command(proto.CmdScheduleUpdate, "u1", proto.ScheduleUpdateArgs{ID: s.ID, ScheduleSpec: sp})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("update without a review: %s", m.raw)
	}
	sp.Prompt = "Rotate it: DB_PASSWORD=Kept-As-Typed-9!"
	sp.Secrets = reviewOf(t, sb.c, sp.Prompt, "c1")
	_, m = sb.c.command(proto.CmdScheduleUpdate, "u2", proto.ScheduleUpdateArgs{ID: s.ID, ScheduleSpec: sp})
	if m.env.T != proto.TAck {
		t.Fatalf("update: %s", m.raw)
	}
	if now, _ := sb.st.ScheduleByID(context.Background(), s.ID); now.SecretsReview == "" || now.SecretsReview == row.SecretsReview {
		t.Fatalf("record %q, was %q", now.SecretsReview, row.SecretsReview)
	}
	// Edited while off: the old record no longer matches, the fire fails.
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	sp.Prompt, sp.Secrets = "Rotate it: DB_PASSWORD=Edited-While-Off-1!", nil
	sb.c.mustAck(proto.CmdScheduleUpdate, proto.ScheduleUpdateArgs{ID: s.ID, ScheduleSpec: sp})
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	sb.at(t0.Add(2 * time.Hour))
	sb.schedule(s.ID, inState(store.ScheduleFailed))
	if len(sb.prompts()) != 0 {
		t.Fatalf("prompts %q", sb.prompts())
	}
}

// Hire presets keep no protected file either; hire_preset.check gives the
// classifier a prompt only as a preset would store it.
func TestPromptSecretsHirePresets(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, dir := startSecretsHireBridge(t, true, func(o *server.Options) { o.HirePresetRoles = roles })
	ps := proto.HirePresetSpec{Name: "Deploy", Prompt: routeText, Harness: "claude", Model: "claude-opus-5-5", Effort: "medium"}
	_, m := hb.c.command(proto.CmdHirePresetCreate, "p1", ps)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	_, m = hb.c.command(proto.CmdHirePresetCheck, "k1", proto.HirePresetCheckArgs{Prompt: routeText})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("check without a review: %s", m.raw)
	}
	ps.Secrets = routeReview(t, hb.c)
	_, m = hb.c.command(proto.CmdHirePresetCreate, "p2", ps)
	if code := codeOf(m); code != proto.ErrSecretsReviewStored {
		t.Fatalf("protected: %s", m.raw)
	}
	_, m = hb.c.command(proto.CmdHirePresetCheck, "k2", proto.HirePresetCheckArgs{Prompt: routeText, Secrets: ps.Secrets})
	if code := codeOf(m); code != proto.ErrSecretsReviewStored {
		t.Fatalf("check, protected: %s", m.raw)
	}
	if cl, _ := roles.calls(); cl != 0 {
		t.Fatalf("the classifier was asked %d times", cl)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, routeSentinel, twinValue)

	const kept = "Rotate it: DB_PASSWORD=Kept-As-Typed-8!"
	ps.Prompt, ps.Secrets = kept, reviewOf(t, hb.c, kept, "c1")
	_, m = hb.c.command(proto.CmdHirePresetCheck, "k3", proto.HirePresetCheckArgs{Prompt: kept, Secrets: ps.Secrets})
	if m.env.T != proto.TAck || len(roles.cls.Calls()) != 1 || roles.cls.Calls()[0].State["prompt"] != kept {
		t.Fatalf("check, all ignored: %s %+v", m.raw, roles.cls.Calls())
	}
	_, m = hb.c.command(proto.CmdHirePresetCreate, "p3", ps)
	p := ackData[proto.HirePreset](t, m)
	stored, _ := hb.st.HirePresets(context.Background())
	if len(stored) != 1 || stored[0].SecretsReview == "" || p.Prompt != kept {
		t.Fatalf("stored %+v", stored)
	}
	// An update with the same prompt and its review keeps a record; off, a
	// prompt full of secrets is saved as today.
	ps.Name, ps.Secrets = "Deploy 2", reviewOf(t, hb.c, kept, "c1")
	hb.c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: p.ID, HirePresetSpec: ps})
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	ps.Prompt, ps.Secrets = routeText, nil
	hb.c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: p.ID, HirePresetSpec: ps})
	_, m = hb.c.command(proto.CmdHirePresetCheck, "k4", proto.HirePresetCheckArgs{Prompt: routeText})
	if m.env.T != proto.TAck || len(roles.cls.Calls()) != 2 {
		t.Fatalf("off: check %s", m.raw)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
}

// run.start: a review per text field (the ticket's text, the extra, an
// edited prompt). The orchestrator gets references; the launch keeps the
// ticket's text with its references and is named from it; nothing raw is
// sent, stored, audited or echoed.
func TestPromptSecretsRunStart(t *testing.T) {
	t.Parallel()
	hb, dir := startSecretsHireBridge(t, true, nil)
	hb.git.repos["/home/u/lab"] = "/home/u/lab"
	hb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"),
		DefaultCwd: proto.Some("/home/u/lab")})
	c := hb.c
	seed := hb.connect(proto.Hello{}).snapshot().World.Presets[0].ID
	orch := proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "high"}
	const ticketSentinel = "Ticket-Sentinel-5!"
	ticket := "Fix login with DB_PASSWORD=" + ticketSentinel
	args := proto.RunStartArgs{Session: "s", DeskIndex: ptr(3), Text: ticket, Extra: routeText, Orch: &orch, Preset: seed, Worktree: ptr(false)}
	_, m := c.command(proto.CmdRunStart, "r0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || !strings.HasPrefix(errorOf(m).Message, "text: ") {
		t.Fatalf("no review: %s", m.raw)
	}
	args.Secrets = proto.SecretsReviews{"text": reviewOf(t, c, ticket)}
	_, m = c.command(proto.CmdRunStart, "r1", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || !strings.HasPrefix(errorOf(m).Message, "extra: ") {
		t.Fatalf("no review of the extra: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr was called: %q", calls)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
	traceFree(t, hb.st, hb.db, []*client{c}, ticketSentinel, routeSentinel, twinValue)

	args.Secrets["extra"] = routeReview(t, c)
	_, m = c.command(proto.CmdRunStart, "r2", args)
	res := ackData[proto.RunStartResult](t, m)
	if res.Protected != 3 || strings.Contains(res.Prompt, ticketSentinel) {
		t.Fatalf("ack %s", m.raw)
	}
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != res.Prompt {
		t.Fatalf("sent %q, acked %q", got, res.Prompt)
	}
	_, extra, _ := strings.Cut(res.Prompt, "Deploy it.")
	checkRouteSent(t, "Deploy it."+extra)
	l, _, _ := hb.st.RunLaunchByWorker(context.Background(), res.ID)
	if !strings.HasPrefix(l.TicketText, "Fix login with DB_PASSWORD=[secret in file ") {
		t.Fatalf("ticket text %q", l.TicketText)
	}
	w := workersOf(hb.world(func(w proto.World) bool { _, ok := workersOf(w, "s")[res.WorkspaceID]; return ok }), "s")[res.WorkspaceID]
	if w.Label != "ORCH|fix-login" {
		t.Fatalf("label %q", w.Label)
	}
	if rows := ownersOf(t, hb.st, "worker", res.ID); len(rows) != 1 {
		t.Fatalf("the orchestrator owns %+v", rows)
	}
	traceFree(t, hb.st, hb.db, []*client{c}, ticketSentinel, routeSentinel)

	// An edited prompt is reviewed whole; the extra beside it is not sent,
	// so a review of it names no text the start sends.
	args = proto.RunStartArgs{Session: "s", DeskIndex: ptr(4), Text: "Tidy the lobby", Extra: routeText, Orch: &orch, Preset: seed,
		Worktree: ptr(false), Prompt: routeText, Secrets: proto.SecretsReviews{"prompt": routeReview(t, c), "extra": routeReview(t, c)}}
	_, m = c.command(proto.CmdRunStart, "r3", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("a review of the unused extra: %s", m.raw)
	}
	delete(args.Secrets, "extra")
	_, m = c.command(proto.CmdRunStart, "r4", args)
	res = ackData[proto.RunStartResult](t, m)
	checkRouteSent(t, res.Prompt)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != res.Prompt || res.Protected != 2 {
		t.Fatalf("sent %q, ack %s", got, m.raw)
	}
	traceFree(t, hb.st, hb.db, []*client{c}, ticketSentinel, routeSentinel)

	// Off: the composed prompt goes as typed, the ticket as typed, no file.
	files := len(protectedFiles(t, dir))
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	_, m = c.command(proto.CmdRunStart, "r5", proto.RunStartArgs{Session: "s", DeskIndex: ptr(5), Text: "Rotate it", Extra: routeText,
		Orch: &orch, Preset: seed, Worktree: ptr(false)})
	res = ackData[proto.RunStartResult](t, m)
	if !strings.HasSuffix(res.Prompt, "\n\n"+routeText) || res.Protected != 0 || len(protectedFiles(t, dir)) != files {
		t.Fatalf("off: %s", m.raw)
	}
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})

	// run.prepare sends nothing anywhere: not reviewed, audited by lengths.
	_, m = c.command(proto.CmdRunPrepare, "rp", proto.RunPrepareArgs{Session: "s", Text: ticket, Extra: routeText})
	if m.env.T != proto.TAck {
		t.Fatalf("prepare %s", m.raw)
	}
	log, _ := hb.st.AuditLog(context.Background())
	for _, e := range log {
		if strings.Contains(e.Args, ticketSentinel) || strings.Contains(e.Args, routeSentinel) {
			t.Fatalf("audited %s %s", e.Cmd, e.Args)
		}
	}
}

// startSecretsPkBridge is the pack-up bridge (w1 Claude, w2 Codex) with a
// protected secrets directory, the switch on, and its terminal.
func startSecretsPkBridge(t *testing.T, roles *pkRoles, tweak func(*server.Options)) (*hireBridge, map[string]string, *fakeTerm, string) {
	t.Helper()
	dir, term := secretsDirFor(t), newFakeTerm()
	hb, ids := startPkBridge(t, roles, on(), "", func(o *server.Options) {
		o.SecretsDir, o.Term = dir, term
		if tweak != nil {
			tweak(o)
		}
	})
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	return hb, ids, term, dir
}

// packup.detect: the models read the text only with its references; the
// ack says what they read and hands it to the worker.prompt that follows,
// which needs no review again and gives the files to the worker. Another
// worker's prompt cannot use the hand-over.
func TestPromptSecretsPackup(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, ids, term, dir := startSecretsPkBridge(t, roles, nil)
	c := hb.c
	text := previewText + " and end your turn"
	_, m := c.command(proto.CmdPackupDetect, "d0", proto.PackupDetectArgs{ID: ids["w2"], Text: text})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	if cl, l := roles.calls(); cl+l != 0 {
		t.Fatalf("models called %d, %d", cl, l)
	}
	traceFree(t, hb.st, hb.db, []*client{c}, routeSentinel, twinValue)

	_, m = c.command(proto.CmdPackupDetect, "d1", proto.PackupDetectArgs{ID: ids["w2"], Text: text, Secrets: reviewOf(t, c, text, "c3", "c4")})
	res := ackData[proto.PackupDetectResult](t, m)
	if !res.Matched || res.Protected != 2 || res.SecretsPending == "" || !strings.HasSuffix(res.Sent, " and end your turn") ||
		res.Task != strings.TrimSuffix(res.Sent, " and end your turn") {
		t.Fatalf("ack %s", m.raw)
	}
	checkRouteSent(t, res.Sent)
	if calls := roles.cls.Calls(); len(calls) != 1 || calls[0].State["prompt"] != res.Sent {
		t.Fatalf("the classifier read %+v", calls)
	}
	for _, call := range roles.llm.Calls() {
		for _, msg := range call.Messages {
			if strings.Contains(msg.Content, routeSentinel) {
				t.Fatalf("the LLM read the secret: %q", msg.Content)
			}
		}
	}
	if len(ownersOf(t, hb.st, "worker", ids["w2"])) != 0 || len(protectedFiles(t, dir)) != 2 {
		t.Fatal("the preview's files are not pending")
	}
	traceFree(t, hb.st, hb.db, []*client{c}, routeSentinel)

	// Another worker's prompt with the hand-over: stale, nothing sent.
	_, m = c.command(proto.CmdWorkerPrompt, "p0", proto.WorkerPromptArgs{ID: ids["w1"], Text: res.Task, SecretsPending: res.SecretsPending})
	if code := codeOf(m); code != proto.ErrSecretsReviewStale || len(term.Calls()) != 0 {
		t.Fatalf("another worker: %s %q", m.raw, term.Calls())
	}
	// Without the hand-over the ignored copy needs its review again.
	_, m = c.command(proto.CmdWorkerPrompt, "p1", proto.WorkerPromptArgs{ID: ids["w2"], Text: res.Task})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no hand-over: %s", m.raw)
	}
	// The follow-up: sent as the preview answered it, its files the worker's.
	_, m = c.command(proto.CmdWorkerPrompt, "p2", proto.WorkerPromptArgs{ID: ids["w2"], Text: res.Task, SecretsPending: res.SecretsPending})
	pr := ackData[proto.PromptResult](t, m)
	if calls := term.Calls(); len(calls) != 1 || !strings.Contains(calls[0], refRe.FindString(res.Task)) || pr.Protected != 0 {
		t.Fatalf("follow-up: %s %q", m.raw, calls)
	}
	if rows := ownersOf(t, hb.st, "worker", ids["w2"]); len(rows) != 1 {
		t.Fatalf("w2 owns %+v", rows)
	}
	// Its retry to the same worker is fine; the files stay one set.
	_, m = c.command(proto.CmdWorkerPrompt, "p3", proto.WorkerPromptArgs{ID: ids["w2"], Text: res.Task, SecretsPending: res.SecretsPending})
	if m.env.T != proto.TAck || len(protectedFiles(t, dir)) != 2 {
		t.Fatalf("retry: %s", m.raw)
	}
	traceFree(t, hb.st, hb.db, []*client{c}, routeSentinel)
}

// A preview never followed up leaves nothing once its hand-over expired,
// and the hand-over is refused after.
func TestPromptSecretsPreviewExpires(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, ids, term, dir := startSecretsPkBridge(t, roles, func(o *server.Options) {
		o.SecretPendingTTL, o.SecretsSweep = 300*time.Millisecond, 20*time.Millisecond
	})
	text := previewText + " and end your turn"
	res := ackData[proto.PackupDetectResult](t, func() msg {
		_, m := hb.c.command(proto.CmdPackupDetect, "d", proto.PackupDetectArgs{ID: ids["w1"], Text: text, Secrets: reviewOf(t, hb.c, text, "c3", "c4")})
		return m
	}())
	if res.SecretsPending == "" || res.Protected != 2 {
		t.Fatalf("ack %+v", res)
	}
	waitFor(t, "the unclaimed files to expire", func() bool { return len(protectedFiles(t, dir)) == 0 })
	if rows, _ := hb.st.SecretOwners(context.Background()); len(rows) != 0 {
		t.Fatalf("owners %+v", rows)
	}
	_, m := hb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: ids["w1"], Text: res.Task, SecretsPending: res.SecretsPending})
	if code := codeOf(m); code != proto.ErrSecretsReviewStale || len(term.Calls()) != 0 {
		t.Fatalf("expired hand-over: %s", m.raw)
	}
}

// A worker.prompt with a hand-over that expires while it waits on the
// worker's lane is refused when its turn comes (review B1): nothing typed,
// for a hand-over with files (the janitor removed them) and for one whose
// review left everything as typed (no file to miss).
func TestPromptSecretsPendingExpiresWhileQueued(t *testing.T) {
	t.Parallel()
	ttl := time.Second
	hb, ids, term, dir := startSecretsPkBridge(t, newPkRoles(), func(o *server.Options) {
		o.SecretPendingTTL, o.SecretsSweep = ttl, 20*time.Millisecond
	})
	c := hb.c
	typed := previewText + " and end your turn"
	preview := func(req string, ignore ...string) proto.PackupDetectResult {
		t.Helper()
		_, m := c.command(proto.CmdPackupDetect, req, proto.PackupDetectArgs{ID: ids["w2"], Text: typed, Secrets: reviewOf(t, c, typed, ignore...)})
		return ackData[proto.PackupDetectResult](t, m)
	}
	files, plain := preview("d1", "c3", "c4"), preview("d2", "c1", "c2", "c3", "c4")
	made := time.Now()
	if files.Protected != 2 || plain.Protected != 0 || plain.SecretsPending == "" || !plain.Matched {
		t.Fatalf("previews %+v %+v", files, plain)
	}
	gate := make(chan struct{})
	defer close(gate)
	started := make(chan struct{}, 1)
	term.mu.Lock()
	term.textGate, term.textStarted = gate, started
	term.mu.Unlock()
	raw, _ := json.Marshal(proto.WorkerKeysArgs{ID: ids["w2"], Input: []proto.InputItem{text("slow hold")}})
	c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "hold", Args: raw})
	<-started
	for i, res := range []proto.PackupDetectResult{files, plain} {
		raw, _ = json.Marshal(proto.WorkerPromptArgs{ID: ids["w2"], Text: res.Task, SecretsPending: res.SecretsPending})
		c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "q" + itoa(i), Args: raw})
	}
	c.mustAck(proto.CmdPromptSecretsGet, nil) // both are queued, their hand-overs valid then
	waitFor(t, "the hand-overs to expire", func() bool { return len(protectedFiles(t, dir)) == 0 && time.Since(made) > ttl })
	gate <- struct{}{}
	for _, req := range []string{"q0", "q1"} {
		if m := c.reply(req); codeOf(m) != proto.ErrSecretsReviewStale {
			t.Fatalf("%s: %s", req, m.raw)
		}
	}
	if calls := term.Calls(); len(calls) != 1 || !strings.HasPrefix(calls[0], "text ") {
		t.Fatalf("typed %q", calls)
	}
	if rows := ownersOf(t, hb.st, "worker", ids["w2"]); len(rows) != 0 {
		t.Fatalf("w2 owns %+v", rows)
	}
}

// hireTaskLLM interprets "… to <task>" as a Claude hire on Haiku 5.5 of
// that task, and any other sentence as its effort high.
func hireTaskLLM() *ai.FakeLLM {
	return &ai.FakeLLM{Func: func(_ context.Context, req ai.Request) (string, error) {
		var p struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal([]byte(req.Messages[1].Content), &p)
		if _, task, ok := strings.Cut(p.Command, " to "); ok {
			b, _ := json.Marshal(task)
			return `{"intent":"hire","harness":"claude","model":"claude-haiku-5-5","effort":null,"task":` + string(b) +
				`,"multiple":false,"selection_unclear":false}`, nil
		}
		return `{"intent":"hire","harness":null,"model":null,"effort":"high","task":null,"multiple":false,"selection_unclear":false}`, nil
	}}
}

// startSecretsInterpretBridge is a hire bridge whose hire.interpret reads
// with llm, with a protected secrets directory and the switch on.
func startSecretsInterpretBridge(t *testing.T, llm *ai.FakeLLM, tweak func(*server.Options)) (*hireBridge, string) {
	t.Helper()
	dir := secretsDirFor(t)
	hb := startHireBridge(t, func(o *server.Options) {
		cat := hiCatalog
		o.HireOptions, o.HireIntentRoles, o.SecretsDir = &cat, &hiRoles{state: ai.StateReady, llm: llm}, dir
		if tweak != nil {
			tweak(o)
		}
	})
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	return hb, dir
}

// hireCreating sends a hire, held at its workspace's create: it waits until
// herdr was asked, and close(gate) lets it go on.
func hireCreating(t *testing.T, hb *hireBridge, req string, a proto.WorkerHireArgs) (gate chan struct{}) {
	t.Helper()
	gate = make(chan struct{})
	hb.fl.createGate = gate
	hb.c.send(proto.Command{T: proto.CmdWorkerHire, ReqID: req, Args: mustRaw(a)})
	waitFor(t, "the hire to reach herdr", func() bool {
		return slices.ContainsFunc(hb.fl.Calls(), func(s string) bool { return strings.HasPrefix(s, "create ") })
	})
	return gate
}

// hire.interpret: the LLM reads the sentence with its references; the
// proposal's sources and task hold them; the follow-up sentence and the
// hire of the task need no review again; the hire's worker claims the
// files. A pending sentence nobody reviewed is refused.
func TestPromptSecretsHireInterpret(t *testing.T) {
	t.Parallel()
	llm := hireTaskLLM()
	hb, dir := startSecretsInterpretBridge(t, llm, nil)
	c := hb.c
	text := "Hire a Claude Code agent on Haiku 5.5 to " + previewText
	_, m := c.command(proto.CmdHireInterpret, "i0", proto.HireInterpretArgs{Text: text})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || len(llm.Calls()) != 0 {
		t.Fatalf("no review: %s", m.raw)
	}
	res := interpretCmd(t, c, "i1", proto.HireInterpretArgs{Text: text, Secrets: reviewOf(t, c, text, "c3", "c4")})
	if res.Hire == nil || res.Protected != 2 || res.SecretsPending == "" {
		t.Fatalf("first: %+v", res)
	}
	checkRouteSent(t, res.Text)
	task := res.Hire.Task.Value
	if res.Hire.Sources[0] != res.Text || !strings.HasPrefix(task, "Deploy it.") || !strings.Contains(task, "[secret in file ") {
		t.Fatalf("proposal %+v", res.Hire)
	}
	for _, call := range llm.Calls() {
		if strings.Contains(call.Messages[1].Content, routeSentinel) {
			t.Fatal("the LLM read the secret")
		}
	}

	// The follow-up: its sources need no review again with the hand-over;
	// without it the ignored copy is a possible secret nobody reviewed, and
	// so is a sentence the client made up.
	_, m = c.command(proto.CmdHireInterpret, "i2", proto.HireInterpretArgs{Text: "high", Pending: res.Hire})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || !strings.HasPrefix(errorOf(m).Message, "pending.sources[0]: ") {
		t.Fatalf("follow-up without the hand-over: %s", m.raw)
	}
	forged := *res.Hire
	forged.Sources = []string{"Hire a Claude Code agent on Haiku 5.5 to deploy with PASSWORD=Forged-Source-3!"}
	forged.Task = hireintent.Task{Provenance: hireintent.Missing}
	_, m = c.command(proto.CmdHireInterpret, "i3", proto.HireInterpretArgs{Text: "high", Pending: &forged, SecretsPending: res.SecretsPending})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("a forged source: %s", m.raw)
	}
	next := interpretCmd(t, c, "i4", proto.HireInterpretArgs{Text: "high", Pending: res.Hire, SecretsPending: res.SecretsPending})
	if next.Hire == nil || !next.Hire.ReadyForReview || next.Hire.Task.Value != task || next.SecretsPending != res.SecretsPending {
		t.Fatalf("follow-up: %+v", next)
	}

	// The hire of its task: no review again, the files the new worker's.
	a := hireArgs(0)
	a.Harness, a.Model, a.Effort, a.Prompt, a.SecretsPending = "claude", "claude-haiku-5-5", "high", task, res.SecretsPending
	_, m = c.command(proto.CmdWorkerHire, "h1", a)
	hired := ackData[proto.HireResult](t, m)
	if got := sentPrompt(t, hb, hired.WorkspaceID+":p1"); got != task || hired.Protected != 0 {
		t.Fatalf("sent %q, ack %s", got, m.raw)
	}
	if rows := ownersOf(t, hb.st, "worker", hired.ID); len(rows) != 1 || len(protectedFiles(t, dir)) != 2 {
		t.Fatalf("the worker owns %+v", rows)
	}
	// The hand-over went with that worker: another hire cannot take it.
	a.DeskIndex = ptr(1)
	_, m = c.command(proto.CmdWorkerHire, "h2", a)
	if code := codeOf(m); code != proto.ErrSecretsReviewStale {
		t.Fatalf("a second hire with it: %s", m.raw)
	}
	traceFree(t, hb.st, hb.db, []*client{c}, routeSentinel, "Forged-Source-3!")
}

// A hire with hire.interpret's hand-over that expires before its worker is
// seen keeps the worker and sends no prompt (review B1), also when the
// review left everything as typed (no file the claim could miss).
func TestPromptSecretsHireHandOverExpires(t *testing.T) {
	t.Parallel()
	ttl := 300 * time.Millisecond
	hb, _ := startSecretsInterpretBridge(t, hireTaskLLM(), func(o *server.Options) { o.SecretPendingTTL = ttl })
	c := hb.c
	text := "Hire a Claude Code agent on Haiku 5.5 to " + previewText
	res := interpretCmd(t, c, "i", proto.HireInterpretArgs{Text: text, Secrets: reviewOf(t, c, text, "c1", "c2", "c3", "c4")})
	made := time.Now()
	if res.Hire == nil || res.Protected != 0 || res.SecretsPending == "" {
		t.Fatalf("interpreted %+v", res)
	}
	a := hireArgs(0)
	a.Harness, a.Model, a.Effort, a.Prompt, a.SecretsPending = "claude", "claude-haiku-5-5", "high", res.Hire.Task.Value, res.SecretsPending
	gate := hireCreating(t, hb, "h", a)
	waitFor(t, "the hand-over to expire", func() bool { return time.Since(made) > ttl })
	close(gate)
	m := c.reply("h")
	hired := ackData[proto.HireResult](t, m)
	if hired.Prompted == nil || *hired.Prompted || !strings.Contains(hired.PromptError, "secrets_pending") {
		t.Fatalf("ack %s", m.raw)
	}
	for _, call := range hb.fl.Calls() {
		if strings.HasPrefix(call, "prompt ") || strings.HasPrefix(call, "type ") {
			t.Fatalf("prompted: %q", call)
		}
	}
}

// A switch change while a reviewed preview waits for its scan (review B2)
// makes it stale before any model reads its text: packup.detect (the
// switch off, or off and on again), hire_preset.check and hire.interpret.
// Nothing is left of it.
func TestPromptSecretsSwitchCancelsQueuedPreviews(t *testing.T) {
	t.Parallel()
	roles, llm := newPkRoles(), hireTaskLLM()
	hb, ids, _, dir := startSecretsPkBridge(t, roles, func(o *server.Options) {
		o.HirePresetRoles, o.HireIntentRoles = roles, &hiRoles{state: ai.StateReady, llm: llm}
	})
	c := hb.c
	typed := previewText + " and end your turn"
	const kept = "Rotate it: DB_PASSWORD=Kept-As-Typed-8!"
	sentence := "Hire a Claude Code agent on Haiku 5.5 to " + previewText
	for i, tc := range []struct {
		cmd   string
		args  func() any
		again bool
	}{
		{proto.CmdPackupDetect, func() any {
			return proto.PackupDetectArgs{ID: ids["w2"], Text: typed, Secrets: reviewOf(t, c, typed, "c3", "c4")}
		}, false},
		{proto.CmdPackupDetect, func() any {
			return proto.PackupDetectArgs{ID: ids["w2"], Text: typed, Secrets: reviewOf(t, c, typed, "c3", "c4")}
		}, true},
		{proto.CmdHirePresetCheck, func() any { return proto.HirePresetCheckArgs{Prompt: kept, Secrets: reviewOf(t, c, kept, "c1")} }, false},
		{proto.CmdHireInterpret, func() any {
			return proto.HireInterpretArgs{Text: sentence, Secrets: reviewOf(t, c, sentence, "c3", "c4")}
		}, false},
	} {
		c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
		args := tc.args()
		release := hb.hub.HoldScanSlots()
		req := "q" + itoa(i)
		c.send(proto.Command{T: tc.cmd, ReqID: req, Args: mustRaw(args)})
		c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
		if tc.again {
			c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
		}
		release()
		if m := c.reply(req); codeOf(m) != proto.ErrSecretsReviewStale {
			t.Fatalf("%s (again %v): %s", tc.cmd, tc.again, m.raw)
		}
		if cl, l := roles.calls(); cl+l+len(llm.Calls()) != 0 {
			t.Fatalf("%s: the models were called", tc.cmd)
		}
		if f := protectedFiles(t, dir); len(f) != 0 {
			t.Fatalf("%s: files %v", tc.cmd, f)
		}
	}
	traceFree(t, hb.st, hb.db, []*client{c}, routeSentinel)
}

// A hire whose review the switch made stale while herdr created its
// workspace (review B2) keeps its worker but sends no prompt, and its
// files go.
func TestPromptSecretsHireSwitchWhileHiring(t *testing.T) {
	t.Parallel()
	hb, dir := startSecretsHireBridge(t, true, nil)
	a := hireArgs(0)
	a.Prompt, a.Secrets = routeText, routeReview(t, hb.c)
	gate := hireCreating(t, hb, "h", a)
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	hb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	close(gate)
	m := hb.c.reply("h")
	res := ackData[proto.HireResult](t, m)
	if res.Prompted == nil || *res.Prompted || res.Protected != 0 || !strings.Contains(res.PromptError, "setting changed") {
		t.Fatalf("ack %s", m.raw)
	}
	for _, call := range hb.fl.Calls() {
		if strings.HasPrefix(call, "prompt ") || strings.HasPrefix(call, "type ") {
			t.Fatalf("prompted: %q", call)
		}
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })
	if rows, _ := hb.st.SecretOwners(context.Background()); len(rows) != 0 {
		t.Fatalf("owners %+v", rows)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, routeSentinel)
}

// worker.answer_ask: a dismissal's prompt and an Other answer go through
// the gate on the worker's lane; refused without a review, nothing pressed
// or typed; an Other the dialog then fails to take removes its files.
func TestPromptSecretsAnswerAsk(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	ab := startAskBridgeAt(t, filepath.Join(t.TempDir(), "world.db"), "blocked", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	const tu = "toolu_01UYJ8PfzgPp69vD6PS9cA2K"
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{"q": readScreen(t, "claude-ask-esc"), "gone": "  ⎿  User declined to answer questions\n"},
		map[string]map[string]string{"q": {"esc": "gone"}}, map[string]func(){"gone": func() {
			appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 12)+fixtureLine(t, "claude", "ask.jsonl", 13))
			go func() { time.Sleep(100 * time.Millisecond); ab.setStatus("w1", "idle") }()
		}})
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 11))
	askOf(c, id, pendingID(tu))
	args := proto.WorkerAnswerAskArgs{ID: id, ToolUseID: tu, Cancel: true, Prompt: routeText}
	_, m := c.command(proto.CmdWorkerAnswerAsk, "a0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || !strings.HasPrefix(errorOf(m).Message, "prompt: ") || len(ab.term.Calls()) != 0 {
		t.Fatalf("no review: %s %q", m.raw, ab.term.Calls())
	}
	args.Secrets = proto.SecretsReviews{"prompt": routeReview(t, c)}
	r := answerAsk(t, c, args)
	if !r.Resolved || !r.Prompted {
		t.Fatalf("result %+v", r)
	}
	calls := ab.term.Calls()
	typed, ok := strings.CutPrefix(calls[len(calls)-1], "type w1:p1 ")
	var sent string
	if !ok || json.Unmarshal([]byte(typed), &sent) != nil {
		t.Fatalf("calls %q", calls)
	}
	checkRouteSent(t, sent)
	traceFree(t, ab.st, ab.db, []*client{c}, routeSentinel)

	// An Other answer: protected as typed into the dialog; the fixture's
	// dialog never shows that text, so the answer fails and its files go.
	const single = "toolu_012vhFKJwCHqKoQ1THGwjkLk"
	ab.setStatus("w1", "blocked")
	playDialog(ab.termBridge, "w1:p1", "q", map[string]string{
		"q": withCursor(readScreen(t, "claude-ask-other-selected"), "❯", 1), "type": readScreen(t, "claude-ask-other-selected"),
	}, map[string]map[string]string{"q": {"3": "type"}}, nil)
	appendLine(t, ab.claude, fixtureLine(t, "claude", "ask.jsonl", 7))
	askOf(c, id, pendingID(single))
	other := "use PASSWORD=" + routeSentinel
	before := len(ab.term.Calls())
	_, m = c.command(proto.CmdWorkerAnswerAsk, "a1", proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single,
		Answers: []proto.AskAnswerArg{{Question: 0, Other: &other}}})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || !strings.HasPrefix(errorOf(m).Message, "answers[0].other: ") {
		t.Fatalf("no review of the other: %s", m.raw)
	}
	files := len(protectedFiles(t, dir))
	_, m = c.command(proto.CmdWorkerAnswerAsk, "a2", proto.WorkerAnswerAskArgs{ID: id, ToolUseID: single,
		Answers: []proto.AskAnswerArg{{Question: 0, Other: &other}}, Secrets: proto.SecretsReviews{"answers[0].other": reviewOf(t, c, other)}})
	if code := codeOf(m); code != proto.ErrInputFailed {
		t.Fatalf("other: %s", m.raw)
	}
	var texts []string
	for _, call := range ab.term.Calls()[before:] {
		if rest, ok := strings.CutPrefix(call, "text w1:p1 "); ok {
			texts = append(texts, rest)
		}
	}
	if len(texts) != 1 || !strings.Contains(texts[0], "use PASSWORD=[secret in file ") {
		t.Fatalf("typed %q", texts)
	}
	waitFor(t, "the failed answer's file to go", func() bool { return len(protectedFiles(t, dir)) == files })
	traceFree(t, ab.st, ab.db, []*client{c}, routeSentinel)
}

// worker.answer_followup: each answer's value and note, and the note, are
// reviewed on their own; the prompt they make holds the references.
func TestPromptSecretsAnswerFollowup(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	fb := startFuBridgeWith(t, "", "", newFuRoles(), on(), "", func(o *server.Options) { o.SecretsDir = dir })
	c := fb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id := fb.ids["w1"]
	fb.turn(t, "claude", "followup_questions.jsonl")
	f := followupOf(c, id).Followup
	note := "PASSWORD=Note-Sentinel-6!"
	args := proto.WorkerAnswerFollowupArgs{ID: id, TurnID: f.TurnID,
		Answers: []proto.FollowupAnswer{{ID: "q1", Value: "No"}, {ID: "q2", Value: routeText, Note: note}}}
	_, m := c.command(proto.CmdWorkerAnswerFollowup, "f0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || !strings.HasPrefix(errorOf(m).Message, "answers[1].value: ") {
		t.Fatalf("no review: %s", m.raw)
	}
	args.Secrets = proto.SecretsReviews{"answers[1].value": routeReview(t, c), "answers[1].note": reviewOf(t, c, note)}
	_, m = c.command(proto.CmdWorkerAnswerFollowup, "f1", args)
	if m.env.T != proto.TAck {
		t.Fatalf("answer: %s", m.raw)
	}
	var typed []string
	for _, call := range fb.term.Calls() {
		if rest, ok := strings.CutPrefix(call, "type w1:p1 "); ok {
			var s string
			_ = json.Unmarshal([]byte(rest), &s)
			typed = append(typed, s)
		}
	}
	if len(typed) != 1 || !strings.Contains(typed[0], "→ No\n") || strings.Contains(typed[0], "Note-Sentinel-6!") {
		t.Fatalf("typed %q", typed)
	}
	_, answer, _ := strings.Cut(typed[0], "→ Deploy it.")
	checkRouteSent(t, "Deploy it."+answer[:strings.Index(answer, " PASSWORD=")])
	if rows := ownersOf(t, fb.st, "worker", id); len(rows) != 1 || len(protectedFiles(t, dir)) != 3 {
		t.Fatalf("w1 owns %+v", rows)
	}
	traceFree(t, fb.st, fb.db, []*client{c}, routeSentinel, "Note-Sentinel-6!")
}

// worker.answer_async: each answer reviewed on its own, admitted and sent
// to the Codex thread with its references.
func TestPromptSecretsAnswerAsync(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	sb, a := asyncWorkerWith(t, func(o *server.Options) { o.SecretsDir = dir })
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	sb.emit(turnStarted("t1"), itemDone("t1", asyncItem("call_3", colorQ, contextQ)), turnCompleted("t1"))
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return len(c.Questions) == 1 && c.Turn == "" })
	args := answerArgs(a.ID, "call_3", ans(1, routeText), ans(0, "Blue"))
	_, m := sb.c.command(proto.CmdWorkerAnswerAsync, "a0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || len(sb.sent()) != 0 {
		t.Fatalf("no review: %s", m.raw)
	}
	args.Secrets = proto.SecretsReviews{"answers[0].answer": routeReview(t, sb.c)}
	_, m = sb.c.command(proto.CmdWorkerAnswerAsync, "a1", args)
	if res := ackData[proto.AsyncAnswerResult](t, m); res.Via != "turn/start" {
		t.Fatalf("ack %s", m.raw)
	}
	sends := sb.sent()
	answers, ok := codexapp.ParseReply(sends[0].text)
	if len(sends) != 1 || !ok || len(answers) != 2 || answers[1].Answer != "Blue" {
		t.Fatalf("sends %+v", sends)
	}
	checkRouteSent(t, answers[0].Answer)
	traceFree(t, sb.st, sb.db, []*client{sb.c}, routeSentinel)

	// Off: another batch's answer full of secrets goes as typed, no file.
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	files := len(protectedFiles(t, dir))
	sb.emit(turnStarted("t2"), itemDone("t2", asyncItem("call_4", contextQ)), turnCompleted("t2"))
	sb.codexWorker(t, func(c *proto.WorkerCodex) bool { return batchOf(*c, "call_4") != nil && c.Turn == "" })
	_, m = sb.c.command(proto.CmdWorkerAnswerAsync, "a2", answerArgs(a.ID, "call_4", ans(0, routeText)))
	if m.env.T != proto.TAck {
		t.Fatalf("off: %s", m.raw)
	}
	sends = sb.sent()
	if answers, _ = codexapp.ParseReply(sends[len(sends)-1].text); len(answers) != 1 || answers[0].Answer != routeText ||
		len(protectedFiles(t, dir)) != files {
		t.Fatalf("off sends %+v", sends)
	}
}

// worker.wrapup: the cleanup prompt is protected before it is armed, and
// sent with its references; refused without a review, nothing armed.
func TestPromptSecretsWrapUp(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	wb := startWrapBridge(t, "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := wb.connect(proto.Hello{Client: "wrap-test"})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	args := proto.WorkerWrapUpArgs{ID: wb.ids["w1"], Prompt: routeText, Worktree: proto.FireKeep}
	_, m := c.command(proto.CmdWorkerWrapUp, "w0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	if got, _ := wb.st.WrapUps(context.Background()); len(got) != 0 {
		t.Fatalf("armed %+v", got)
	}
	args.Secrets = routeReview(t, c)
	_, m = c.command(proto.CmdWorkerWrapUp, "w1", args)
	if m.env.T != proto.TAck {
		t.Fatalf("wrap-up: %s", m.raw)
	}
	text, _ := wb.prompted(t, "w1:p1")
	task, _, _ := strings.Cut(text, "\n\nWhen you are done")
	checkRouteSent(t, task)
	if rows := ownersOf(t, wb.st, "worker", wb.ids["w1"]); len(rows) != 1 {
		t.Fatalf("w1 owns %+v", rows)
	}
	traceFree(t, wb.st, wb.db, []*client{c}, routeSentinel)
}

// worker.handoff (agent): the instruction is protected before the request
// is stored or sent; an existing op's answer uses none of it.
func TestPromptSecretsWorkerHandoffAgent(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id := ab.ids["w2"]
	args := proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeAgent, Instruction: routeText, Op: "op-h"}
	_, m := c.command(proto.CmdWorkerHandoff, "h0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	if _, err := ab.st.HandoffRequestByOp(context.Background(), "op-h"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("stored: %v", err)
	}
	args.Secrets = routeReview(t, c)
	_, m = c.command(proto.CmdWorkerHandoff, "h1", args)
	res := ackData[proto.WorkerHandoffRequestResult](t, m)
	if res.Protected != 2 || res.Existing {
		t.Fatalf("ack %s", m.raw)
	}
	checkRouteSent(t, res.Request.Instruction)
	prompt, _, _ := ab.mustRequest(t, "w2:p1")
	if !strings.Contains(prompt, res.Request.Instruction) {
		t.Fatalf("request prompt %q", prompt)
	}
	req, err := ab.st.HandoffRequestByOp(context.Background(), "op-h")
	if err != nil || req.Instruction != res.Request.Instruction {
		t.Fatalf("stored %+v %v", req, err)
	}
	// The same op again: answered, its files the ones written.
	files := len(protectedFiles(t, dir))
	args.Secrets = routeReview(t, c)
	_, m = c.command(proto.CmdWorkerHandoff, "h2", args)
	if res := ackData[proto.WorkerHandoffRequestResult](t, m); !res.Existing || res.Protected != 0 {
		t.Fatalf("again %s", m.raw)
	}
	waitFor(t, "no new file", func() bool { return len(protectedFiles(t, dir)) == files })
	traceFree(t, ab.st, ab.db, []*client{c}, routeSentinel)
}

// worker.handoff (llm): the model reads the instruction with its
// references; the files stay the worker's once the job started.
func TestPromptSecretsWorkerHandoffLLM(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	lb := newLLMBridge(t, yes(), func(o *server.Options) { o.SecretsDir = dir })
	c := lb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id := lb.ids["w1"]
	lb.fl.setProcs("w1:p1", running("claude", wrapSess))
	cand := lb.candidate(t, c)
	args := llmArgs(id, cand, "op-llm")
	args.Instruction = routeText
	_, m := c.command(proto.CmdWorkerHandoff, "h0", args)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || len(lb.llm.llm.Calls()) != 0 {
		t.Fatalf("no review: %s", m.raw)
	}
	args.Secrets = routeReview(t, c)
	_, m = c.command(proto.CmdWorkerHandoff, "h1", args)
	if res := ackData[proto.WorkerHandoffJobResult](t, m); res.Existing {
		t.Fatalf("ack %s", m.raw)
	}
	waitFor(t, "the LLM call", func() bool { return len(lb.llm.llm.Calls()) == 1 })
	var read string
	for _, msg := range lb.llm.llm.Calls()[0].Messages {
		read += msg.Content
	}
	if strings.Contains(read, routeSentinel) || !strings.Contains(read, "[secret in file "+dir) {
		t.Fatalf("the LLM read %q", read)
	}
	if rows := ownersOf(t, lb.st, "worker", id); len(rows) != 1 || len(protectedFiles(t, dir)) != 2 {
		t.Fatalf("w1 owns %+v", rows)
	}
	traceFree(t, lb.st, lb.db, []*client{c}, routeSentinel)
}

// A wrap-up armed with a review whose prompt then waits on the worker's
// lane is refused when its turn comes if the switch changed meanwhile
// (review B2): nothing typed, its files gone.
func TestPromptSecretsWrapUpSwitchWhileQueued(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	wb := startWrapBridge(t, "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := wb.connect(proto.Hello{Client: "wrap-test"})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	gate, started := make(chan struct{}), make(chan struct{}, 1)
	defer close(gate)
	wb.term.mu.Lock()
	wb.term.textGate, wb.term.textStarted = gate, started
	wb.term.mu.Unlock()
	c.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "hold", Args: mustRaw(proto.WorkerKeysArgs{ID: wb.ids["w1"],
		Input: []proto.InputItem{text("slow hold")}})})
	<-started
	args := proto.WorkerWrapUpArgs{ID: wb.ids["w1"], Prompt: routeText, Worktree: proto.FireKeep, Secrets: routeReview(t, c)}
	c.send(proto.Command{T: proto.CmdWorkerWrapUp, ReqID: "w", Args: mustRaw(args)})
	waitFor(t, "the wrap-up to be armed", func() bool {
		got, _ := wb.st.WrapUps(context.Background())
		return len(got) == 1 && got[0].State == proto.WrapUpArmed
	})
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	gate <- struct{}{}
	if m := c.reply("w"); codeOf(m) != proto.ErrSecretsReviewStale {
		t.Fatalf("wrap-up: %s", m.raw)
	}
	if calls := wb.term.Calls(); slices.ContainsFunc(calls, func(s string) bool { return !strings.HasPrefix(s, "text ") && !strings.HasPrefix(s, "observe ") }) {
		t.Fatalf("typed %q", calls)
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })
	traceFree(t, wb.st, wb.db, []*client{c}, routeSentinel)
}

// An LLM handoff whose instruction's review the switch made stale while
// its transcript was read (review B2) fails before the model reads it.
func TestPromptSecretsWorkerHandoffLLMSwitchWhileReading(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	var hold atomic.Bool
	reading, gate := make(chan struct{}, 1), make(chan struct{})
	defer close(gate)
	lb := newLLMBridge(t, yes(), func(o *server.Options) {
		o.SecretsDir = dir
		next := o.HandoffReduce
		o.HandoffReduce = func(ctx context.Context, in handoffllm.Input) (handoffllm.Payload, error) {
			if hold.Load() {
				reading <- struct{}{}
				<-gate
			}
			return next(ctx, in)
		}
	})
	c := lb.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	id := lb.ids["w1"]
	lb.fl.setProcs("w1:p1", running("claude", wrapSess))
	args := llmArgs(id, lb.candidate(t, c), "op-llm")
	args.Instruction, args.Secrets = routeText, routeReview(t, c)
	hold.Store(true)
	c.mustAck(proto.CmdWorkerHandoff, args)
	<-reading
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	gate <- struct{}{}
	w := upsertFor(c, id, llmJobState(proto.LLMHandoffFailed))
	if w.LLMHandoff.Code != proto.ErrSecretsReviewStale || len(lb.llm.llm.Calls()) != 0 {
		t.Fatalf("job %+v, %d LLM calls", w.LLMHandoff, len(lb.llm.llm.Calls()))
	}
	traceFree(t, lb.st, lb.db, []*client{c}, routeSentinel)
}

// fill is text padded with x to n bytes (n > len(text)).
func fill(text string, n int) string { return text + " " + strings.Repeat("x", n-len(text)-1) }

// Limits apply to a preview's text with its references (the 8 KiB of a
// dictated sentence, a prompt's 16 KiB): over them, refused, no model
// called, the files gone. Off, a text full of secrets is read as typed,
// nothing scanned or written.
func TestPromptSecretsPreviewLimitsAndOff(t *testing.T) {
	t.Parallel()
	roles := newPkRoles()
	hb, ids, _, dir := startSecretsPkBridge(t, roles, nil)
	c := hb.c
	long := fill(previewText+" and end your turn", herdr.MaxMessage-8)
	_, m := c.command(proto.CmdPackupDetect, "d0", proto.PackupDetectArgs{ID: ids["w2"], Text: long})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired { // it fits as typed
		t.Fatalf("as typed: %s", m.raw)
	}
	_, m = c.command(proto.CmdPackupDetect, "d", proto.PackupDetectArgs{ID: ids["w2"], Text: long, Secrets: reviewOf(t, c, long, "c3", "c4")})
	if code := codeOf(m); code != proto.ErrBadRequest {
		t.Fatalf("over the limit: %s", m.raw)
	}
	if cl, l := roles.calls(); cl+l != 0 {
		t.Fatalf("models called %d, %d", cl, l)
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })

	llm := &ai.FakeLLM{Text: `{"intent":"unclear","harness":null,"model":null,"effort":null,"task":null,"multiple":false,"selection_unclear":false}`}
	dir2 := secretsDirFor(t)
	hi := startHireBridge(t, func(o *server.Options) {
		cat := hiCatalog
		o.HireOptions, o.HireIntentRoles, o.SecretsDir = &cat, &hiRoles{state: ai.StateReady, llm: llm}, dir2
	})
	hi.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	long = fill("Hire a Claude Code agent to "+previewText, hireintent.MaxTextBytes-8)
	_, m = hi.c.command(proto.CmdHireInterpret, "i0", proto.HireInterpretArgs{Text: long})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired { // it fits as typed
		t.Fatalf("as typed: %s", m.raw)
	}
	_, m = hi.c.command(proto.CmdHireInterpret, "i", proto.HireInterpretArgs{Text: long, Secrets: reviewOf(t, hi.c, long, "c3", "c4")})
	if code := codeOf(m); code != proto.ErrBadRequest || len(llm.Calls()) != 0 {
		t.Fatalf("over 8 KiB: %s", m.raw)
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir2)) == 0 })

	// Off: as typed, no token, no file.
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	res := detect(t, c, ids["w2"], previewText+" and end your turn")
	if res.Sent != "" || res.SecretsPending != "" || res.Protected != 0 || !strings.Contains(roles.cls.Calls()[0].State["prompt"].(string), routeSentinel) {
		t.Fatalf("off: %+v", res)
	}
	hi.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	r := interpretCmd(t, hi.c, "i2", proto.HireInterpretArgs{Text: "Hire a Claude Code agent to " + previewText})
	if r.SecretsPending != "" || !strings.Contains(llm.Calls()[0].Messages[1].Content, jsonEscaped(routeSentinel)) {
		t.Fatalf("off: %+v", r)
	}
	if len(protectedFiles(t, dir))+len(protectedFiles(t, dir2)) != 0 {
		t.Fatal("files while off")
	}
}

// Limits apply to the worker-owned routes' texts with their references
// (a dismissal's prompt, a wrap-up's room, a handoff's instruction): over
// them, refused, nothing sent, the files gone. Off, as today.
func TestPromptSecretsWorkerRoutesLimitsAndOff(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	long := fill(routeText, proto.MaxHandoffInstruction-8)
	ho := proto.WorkerHandoffArgs{Worker: ab.ids["w2"], Mode: proto.HandoffModeAgent, Instruction: long, Op: "op-long"}
	_, m := c.command(proto.CmdWorkerHandoff, "h0", ho)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired { // it fits as typed
		t.Fatalf("as typed: %s", m.raw)
	}
	ho.Secrets = reviewOf(t, c, long, "c3")
	_, m = c.command(proto.CmdWorkerHandoff, "h", ho)
	if code := codeOf(m); code != proto.ErrBadRequest {
		t.Fatalf("a long instruction: %s", m.raw)
	}
	room := herdr.MaxMessage - len(transcript.WrapUpFooter(strings.Repeat("0", 16))) - 2
	long = fill(routeText, room-8)
	wu := proto.WorkerWrapUpArgs{ID: ab.ids["w1"], Prompt: long, Worktree: proto.FireKeep}
	_, m = c.command(proto.CmdWorkerWrapUp, "w0", wu)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired { // it fits as typed
		t.Fatalf("as typed: %s", m.raw)
	}
	wu.Secrets = reviewOf(t, c, long, "c3")
	_, m = c.command(proto.CmdWorkerWrapUp, "w", wu)
	if code := codeOf(m); code != proto.ErrBadRequest {
		t.Fatalf("a long wrap-up: %s", m.raw)
	}
	waitFor(t, "the files to go", func() bool { return len(protectedFiles(t, dir)) == 0 })
	if _, _, _, n := ab.requested("w2:p1"); n != 0 {
		t.Fatal("a request was sent")
	}
	if got, _ := ab.st.WrapUps(context.Background()); len(got) != 0 {
		t.Fatalf("armed %+v", got)
	}

	// Off: a wrap-up and a handoff full of secrets go as typed, no file.
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	_, m = c.command(proto.CmdWorkerHandoff, "h2", proto.WorkerHandoffArgs{Worker: ab.ids["w2"], Mode: proto.HandoffModeAgent,
		Instruction: routeText, Op: "op-off"})
	if res := ackData[proto.WorkerHandoffRequestResult](t, m); res.Request.Instruction != routeText || res.Protected != 0 {
		t.Fatalf("off handoff %s", m.raw)
	}
	_, m = c.command(proto.CmdWorkerWrapUp, "w2", proto.WorkerWrapUpArgs{ID: ab.ids["w1"], Prompt: routeText, Worktree: proto.FireKeep})
	if m.env.T != proto.TAck {
		t.Fatalf("off wrap-up %s", m.raw)
	}
	if text, _ := ab.prompted(t, "w1:p1"); !strings.HasPrefix(text, routeText+"\n\n") {
		t.Fatalf("off wrap-up sent %q", text)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files while off: %v", f)
	}
}
