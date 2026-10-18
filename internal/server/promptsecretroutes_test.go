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
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

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
