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
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
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
	a.Prompt, a.Secrets = long, reviewOf(t, hb.c, long, "c3")
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

// hire.interpret: the LLM reads the sentence with its references; the
// proposal's sources and task hold them; the follow-up sentence and the
// hire of the task need no review again; the hire's worker claims the
// files. A pending sentence nobody reviewed is refused.
func TestPromptSecretsHireInterpret(t *testing.T) {
	t.Parallel()
	llm := &ai.FakeLLM{Func: func(_ context.Context, req ai.Request) (string, error) {
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
	dir := secretsDirFor(t)
	hb := startHireBridge(t, func(o *server.Options) {
		cat := hiCatalog
		o.HireOptions, o.HireIntentRoles, o.SecretsDir = &cat, &hiRoles{state: ai.StateReady, llm: llm}, dir
	})
	c := hb.c
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
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
