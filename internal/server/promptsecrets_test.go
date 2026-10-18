package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// secretsBridge is a term bridge (w1 Claude idle, w2 Codex idle) with a
// protected secrets directory and its database's path.
type secretsBridge struct {
	*termBridge
	c        *client
	dir, db  string
	id1, id2 string
}

func startSecretsBridge(t *testing.T, on bool, tweak func(*server.Options)) *secretsBridge {
	t.Helper()
	base := t.TempDir()
	sb := &secretsBridge{dir: filepath.Join(base, "run", "secrets"), db: filepath.Join(base, "world.db")}
	if err := os.Mkdir(filepath.Join(base, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	sb.termBridge = startTermBridgeAt(t, sb.db, func(o *server.Options) {
		o.SecretsDir = sb.dir
		if tweak != nil {
			tweak(o)
		}
	}, agentW("w1", "claude", "idle"), agentW("w2", "codex", "idle"))
	sb.c = sb.connect(proto.Hello{Client: "game"})
	snap := sb.c.snapshot()
	sb.id1, sb.id2 = idOf(t, snap, "w1"), idOf(t, snap, "w2")
	if on {
		sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	}
	return sb
}

func (sb *secretsBridge) scan(t *testing.T, text string) proto.PromptSecretsScan {
	t.Helper()
	_, m := sb.c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
	return ackData[proto.PromptSecretsScan](t, m)
}

// files are the protected files under dir: path → bytes.
func (sb *secretsBridge) files(t *testing.T) map[string]string {
	t.Helper()
	out := map[string]string{}
	owners, err := os.ReadDir(sb.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range owners {
		if o.Name() == ".lock" {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(sb.dir, o.Name()))
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			p := filepath.Join(sb.dir, o.Name(), e.Name())
			b, err := os.ReadFile(p)
			if err != nil {
				t.Fatal(err)
			}
			out[p] = string(b)
		}
	}
	return out
}

// noTrace checks that none of the values is in an audit row, anything a
// client heard, or the database's bytes (its WAL too).
func (sb *secretsBridge) noTrace(t *testing.T, values ...string) {
	t.Helper()
	log, err := sb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var rows strings.Builder
	for _, e := range log {
		rows.WriteString(e.Cmd + " " + e.Args + " " + e.Error + " " + e.Result + "\n")
	}
	var db []byte
	for _, suffix := range []string{"", "-wal", "-shm"} {
		b, _ := os.ReadFile(sb.db + suffix)
		db = append(db, b...)
	}
	for _, v := range values {
		switch {
		case strings.Contains(rows.String(), v):
			t.Errorf("%q in the audit log:\n%s", v, rows.String())
		case strings.Contains(sb.c.heard.String(), v) || strings.Contains(sb.c.heard.String(), jsonEscaped(v)):
			t.Errorf("%q in what the client heard", v)
		case bytes.Contains(db, []byte(v)):
			t.Errorf("%q in the database", v)
		}
	}
}

func jsonEscaped(v string) string {
	b, _ := json.Marshal(v)
	return string(b[1 : len(b)-1])
}

// u16 is the UTF-16 offset of the first sub in text.
func u16(text, sub string) int {
	i := strings.Index(text, sub)
	if i < 0 {
		panic("no " + sub)
	}
	return len(utf16.Encode([]rune(text[:i])))
}

func u16Len(s string) int { return len(utf16.Encode([]rune(s))) }

var refRe = regexp.MustCompile(`\[secret in file (/[^\]\s]+)\]`)

// The switch: off by default, published to every client, in the snapshot,
// kept over a restart; available with a usable directory.
func TestPromptSecretsSwitch(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, false, nil)
	other := sb.connect(proto.Hello{Client: "other"})
	if ps := other.snapshot().World.PromptSecrets; ps == nil || ps.Enabled || !ps.Available {
		t.Fatalf("fresh %+v", ps)
	}
	_, ack := sb.c.mustAck(proto.CmdPromptSecretsGet, nil)
	if d := ack.Data.(map[string]any); d["enabled"] != false || d["available"] != true {
		t.Fatalf("get %+v", d)
	}
	evs, _ := sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	if len(evs) != 1 || evs[0].T != proto.EvPromptSecretsUpdate {
		t.Fatalf("set events %+v", evs)
	}
	if m := other.next(); m.env.T != proto.EvPromptSecretsUpdate || !strings.Contains(string(m.raw), `"enabled":true`) {
		t.Fatalf("other heard %s", m.raw)
	}
	if evs, _ := sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)}); len(evs) != 0 {
		t.Fatalf("no-op events %+v", evs)
	}
	sb.c.mustError(proto.CmdPromptSecretsSet, map[string]any{}, proto.ErrBadRequest)
	if row := auditRow(t, sb.bridge, proto.CmdPromptSecretsSet); !row.Done {
		t.Errorf("audit %+v", row)
	}
	sb.stop()
	b2 := startBridge(t, sb.db, server.Options{})
	if ps := b2.connect(proto.Hello{}).snapshot().World.PromptSecrets; ps == nil || !ps.Enabled || ps.Available {
		t.Fatalf("after restart, without a directory: %+v", ps)
	}
}

// Off: a prompt full of secrets goes as today, nothing scanned, no file;
// a scan is refused, and so is a review from a stale tab.
func TestPromptSecretsOffSendsAsToday(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, false, nil)
	text := "PASSWORD=Off-Sentinel-7! token ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	_, m := sb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: sb.id2, Text: text})
	if pr := ackData[proto.PromptResult](t, m); pr.Sent != "" || pr.Protected != 0 {
		t.Fatalf("ack %s", m.raw)
	}
	if calls := sb.term.Calls(); !slices.Equal(calls, []string{"submit w2:p1 " + strconv.Quote(text)}) {
		t.Fatalf("calls %q", calls)
	}
	if f := sb.files(t); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
	sb.c.mustError(proto.CmdPromptSecretsScan, proto.PromptSecretsScanArgs{Text: text}, proto.ErrSecretsReviewOff)
	sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: sb.id2, Text: text,
		Secrets: &proto.SecretsReview{Revision: "r"}}, proto.ErrSecretsReviewStale)
	if len(sb.term.Calls()) != 1 {
		t.Fatalf("calls %q", sb.term.Calls())
	}
}

func TestPromptSecretsScan(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	text := "é🙂 password: Zeven9! and PASSWORD=Zeven9!"
	s := sb.scan(t, text)
	if len(s.Candidates) != 2 || s.Revision == "" {
		t.Fatalf("scan %+v", s)
	}
	c := s.Candidates[0]
	if c.ID != "c1" || c.Start != u16(text, "Zeven9!") || c.End != c.Start+7 || !slices.Contains(c.Kinds, "assignment") {
		t.Fatalf("candidate %+v", c)
	}
	if again := sb.scan(t, text); again.Revision != s.Revision {
		t.Fatal("two scans of one text differ")
	}
	if none := sb.scan(t, "nothing to see"); len(none.Candidates) != 0 || none.Candidates == nil {
		t.Fatalf("clean %+v", none)
	}
	sb.c.mustError(proto.CmdPromptSecretsScan, proto.PromptSecretsScanArgs{Text: strings.Repeat("x", herdr.MaxPrompt+1)}, proto.ErrBadRequest)
	sb.c.mustAck(proto.CmdPromptSecretsScan, proto.PromptSecretsScanArgs{Text: strings.Repeat("x", herdr.MaxPrompt)})
	if row := auditRow(t, sb.bridge, proto.CmdPromptSecretsScan); strings.Contains(row.Result+row.Error, "Zeven") {
		t.Fatalf("audit %+v", row)
	}
	sb.noTrace(t, "Zeven9!")
}

// With the switch on, a prompt with candidates and no review (or a review
// that does not fit) is refused: the terminal got nothing, no file exists,
// and the audit log, every message and the database hold no trace of it.
func TestPromptSecretsReviewRequired(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	const sentinel = "Rq-Sentinel-93xQ!"
	text := "deploy, PASSWORD=" + sentinel + " and the note"
	check := func(name string, args proto.WorkerPromptArgs, code string) {
		t.Helper()
		sb.c.mustError(proto.CmdWorkerPrompt, args, code)
		if calls := sb.term.Calls(); len(calls) != 0 {
			t.Fatalf("%s: typed %q", name, calls)
		}
		if f := sb.files(t); len(f) != 0 {
			t.Fatalf("%s: files %v", name, f)
		}
	}
	check("no review", proto.WorkerPromptArgs{ID: sb.id1, Text: text}, proto.ErrSecretsReviewRequired)
	check("codex", proto.WorkerPromptArgs{ID: sb.id2, Text: text}, proto.ErrSecretsReviewRequired)
	s := sb.scan(t, text)
	review := func(ds ...proto.SecretDecision) *proto.SecretsReview {
		return &proto.SecretsReview{Revision: s.Revision, Decisions: ds}
	}
	protectC1 := proto.SecretDecision{Candidate: "c1", Action: proto.SecretProtect}
	n := u16Len(text)
	check("stale", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: &proto.SecretsReview{Revision: "made-up", Decisions: []proto.SecretDecision{protectC1}}},
		proto.ErrSecretsReviewStale)
	check("edited", proto.WorkerPromptArgs{ID: sb.id1, Text: text + "!", Secrets: review(protectC1)}, proto.ErrSecretsReviewStale)
	check("missing", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review()}, proto.ErrSecretsReviewRequired)
	check("bad action", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review(proto.SecretDecision{Candidate: "c1", Action: "keep"})},
		proto.ErrSecretsReviewRequired)
	check("overlap", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review(protectC1,
		proto.SecretDecision{Action: proto.SecretProtect, Start: ptr(u16(text, sentinel) - 3), End: ptr(u16(text, sentinel) + 2)})},
		proto.ErrSecretsReviewRequired)
	check("out of range", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review(protectC1,
		proto.SecretDecision{Action: proto.SecretProtect, Start: ptr(n - 2), End: ptr(n + 1)})}, proto.ErrSecretsReviewRequired)
	check("half a range", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review(protectC1,
		proto.SecretDecision{Action: proto.SecretProtect, Start: ptr(1)})}, proto.ErrSecretsReviewRequired)
	// The switch changed after the scan: stale.
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	check("switched", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: review(protectC1)}, proto.ErrSecretsReviewStale)
	// A clean prompt goes as today.
	_, m := sb.c.command(proto.CmdWorkerPrompt, "clean", proto.WorkerPromptArgs{ID: sb.id2, Text: "run the tests"})
	if pr := ackData[proto.PromptResult](t, m); pr.Sent != "" || !slices.Equal(sb.term.Calls(), []string{`submit w2:p1 "run the tests"`}) {
		t.Fatalf("clean: %s %q", m.raw, sb.term.Calls())
	}
	sb.noTrace(t, sentinel)
}

// A confirmed review: the terminal gets the text with references; each
// file holds the exact approved bytes, 0600 in a 0700 directory; ignored
// candidates stay as typed and get no file (one copy of a repeated value
// protected, the other ignored); a corrected range and a manual mark work;
// the ack shows what was sent; nothing protected is left anywhere else.
func TestPromptSecretsConfirmedSend(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	pem := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n" +
		"QyNTUxOQAAACDhBT6MWV0pNHNGhRbX0ZbUaVnT7oSPEKIn4dyBTnZu8wAAAJgtF1uYLRdb\n-----END OPENSSH PRIVATE KEY-----"
	shellish := `a!B@c#$e%F^g&H*(J)k=L+M;|x`
	text := "Deploy it.\nDB_PASSWORD=wólk🌧️Zeven9!\nThe key:\n" + pem + "\nexport TOKEN='" + shellish + "' then TOKEN2='" + shellish +
		"'\nand password: Ignored-Pw-4 with my phrase vortex-lake-11"
	for _, w := range []struct{ id, ws, how string }{{sb.id1, "w1", "type"}, {sb.id2, "w2", "submit"}} {
		before := len(sb.term.Calls())
		s := sb.scan(t, text)
		var ids []string
		for _, c := range s.Candidates {
			ids = append(ids, c.ID)
		}
		if len(s.Candidates) != 5 {
			t.Fatalf("candidates %+v", s.Candidates)
		}
		// c1 DB_PASSWORD (corrected: without its "!"), c2 the PEM, c3 TOKEN
		// protected; c4 TOKEN2 (the same value) and c5 ignored; a manual
		// mark on the phrase.
		c1 := s.Candidates[0]
		review := &proto.SecretsReview{Revision: s.Revision, Decisions: []proto.SecretDecision{
			{Candidate: "c1", Action: proto.SecretProtect, Start: ptr(c1.Start), End: ptr(c1.End - 1)},
			{Candidate: "c2", Action: proto.SecretProtect},
			{Candidate: "c3", Action: proto.SecretProtect},
			{Candidate: "c4", Action: proto.SecretIgnore},
			{Candidate: "c5", Action: proto.SecretIgnore},
			{Action: proto.SecretProtect, Start: ptr(u16(text, "vortex")), End: ptr(u16(text, "vortex") + u16Len("vortex-lake-11"))},
		}}
		_, m := sb.c.command(proto.CmdWorkerPrompt, "p-"+w.ws, proto.WorkerPromptArgs{ID: w.id, Text: text, Secrets: review})
		pr := ackData[proto.PromptResult](t, m)
		if pr.Protected != 4 || pr.Sent == "" {
			t.Fatalf("%s: ack %s", w.ws, m.raw)
		}
		if calls := sb.term.Calls()[before:]; len(calls) != 1 || calls[0] != w.how+" "+w.ws+":p1 "+strconv.Quote(pr.Sent) {
			t.Fatalf("%s: calls %q", w.ws, calls)
		}
		refs := refRe.FindAllStringSubmatch(pr.Sent, -1)
		want := []string{"wólk🌧️Zeven9", pem, shellish, "vortex-lake-11"}
		if len(refs) != len(want) {
			t.Fatalf("%s: sent %q", w.ws, pr.Sent)
		}
		restored := pr.Sent
		for i, r := range refs {
			b, err := os.ReadFile(r[1])
			if err != nil || string(b) != want[i] {
				t.Fatalf("%s: file %d holds %q (%v), want %q", w.ws, i, b, err, want[i])
			}
			if fi, _ := os.Lstat(r[1]); fi.Mode() != 0o600 {
				t.Errorf("file mode %v", fi.Mode())
			}
			if fi, _ := os.Lstat(filepath.Dir(r[1])); fi.Mode() != os.ModeDir|0o700 {
				t.Errorf("owner dir mode %v", fi.Mode())
			}
			restored = strings.Replace(restored, r[0], string(b), 1)
		}
		if restored != text {
			t.Fatalf("%s: the sent text is not the typed one with references:\n%q", w.ws, pr.Sent)
		}
		if !strings.Contains(pr.Sent, "TOKEN2='"+shellish+"'") || !strings.Contains(pr.Sent, "password: Ignored-Pw-4") ||
			!strings.Contains(pr.Sent, "]!\nThe key") || strings.Contains(pr.Sent, "@/") {
			t.Fatalf("%s: ignored text or the corrected range's tail is not as typed: %q", w.ws, pr.Sent)
		}
	}
	if f := sb.files(t); len(f) != 8 {
		t.Fatalf("files %d", len(f))
	}
	sb.noTrace(t, "wólk🌧️Zeven9", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAE", "vortex-lake-11")
	// The audit row counts decisions, never a range or a text.
	if row := auditRow(t, sb.bridge, proto.CmdWorkerPrompt); !row.OK {
		t.Fatalf("audit %+v", row)
	}
	log, _ := sb.st.AuditLog(context.Background())
	counted := 0
	for _, e := range log {
		if e.Cmd == proto.CmdWorkerPrompt && e.OK && strings.Contains(e.Args, `"secrets_protect":4,"secrets_ignore":2`) {
			counted++
		}
	}
	if counted != 2 {
		t.Fatalf("%d audit rows count the decisions", counted)
	}
	// Everything ignored: sent as typed, no file.
	before := len(sb.files(t))
	s := sb.scan(t, "PASSWORD=Plain-Kept-1")
	_, m := sb.c.command(proto.CmdWorkerPrompt, "ign", proto.WorkerPromptArgs{ID: sb.id2, Text: "PASSWORD=Plain-Kept-1",
		Secrets: &proto.SecretsReview{Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretIgnore}}}})
	if pr := ackData[proto.PromptResult](t, m); pr.Sent != "" || pr.Protected != 0 || len(sb.files(t)) != before {
		t.Fatalf("all ignored: %s", m.raw)
	}
	// Manual marks on a clean prompt.
	clean := "use my usual staging phrase"
	s = sb.scan(t, clean)
	_, m = sb.c.command(proto.CmdWorkerPrompt, "manual", proto.WorkerPromptArgs{ID: sb.id2, Text: clean, Secrets: &proto.SecretsReview{
		Revision: s.Revision, Decisions: []proto.SecretDecision{{Action: proto.SecretProtect, Start: ptr(u16(clean, "phrase")), End: ptr(u16Len(clean))}}}})
	if pr := ackData[proto.PromptResult](t, m); pr.Protected != 1 || !strings.HasPrefix(pr.Sent, "use my usual staging [secret in file ") {
		t.Fatalf("manual: %s", m.raw)
	}
}

// Limits apply to the text with its references: a prompt that fits as
// typed but not after is refused, and its new files are removed (the
// typed Claude limit and Codex's alike).
func TestPromptSecretsLimitsAfterSubstitution(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	tail := " PASSWORD=Lim1t-Sentinel"
	text := strings.Repeat("x", herdr.MaxMessage-len(tail)-10) + tail
	for _, id := range []string{sb.id1, sb.id2} {
		s := sb.scan(t, text)
		if len(s.Candidates) != 1 {
			t.Fatalf("candidates %+v", s.Candidates)
		}
		sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: text, Secrets: &proto.SecretsReview{Revision: s.Revision,
			Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}}, proto.ErrBadRequest)
		if f := sb.files(t); len(f) != 0 {
			t.Fatalf("files left: %v", f)
		}
	}
	if calls := sb.term.Calls(); len(calls) != 0 {
		t.Fatalf("typed %q", calls)
	}
	// Over the scan's 32 KiB: refused whole, never cut (Codex's prompt
	// source may be longer when it is translated).
	sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: sb.id2, Text: strings.Repeat("y", herdr.MaxPrompt+1)}, proto.ErrBadRequest)
}

// The identical review retried reuses its files; a failed send removes the
// files it made, never those it reused.
func TestPromptSecretsRetryAndRollback(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	text := "PASSWORD=Retry-Sentinel-5 please"
	s := sb.scan(t, text)
	args := proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: &proto.SecretsReview{Revision: s.Revision,
		Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}}
	_, m := sb.c.command(proto.CmdWorkerPrompt, "p1", args)
	first := ackData[proto.PromptResult](t, m).Sent
	_, m = sb.c.command(proto.CmdWorkerPrompt, "p2", args)
	if again := ackData[proto.PromptResult](t, m).Sent; again != first || len(sb.files(t)) != 1 {
		t.Fatalf("retry: %q vs %q, %d files", again, first, len(sb.files(t)))
	}
	// The retry fails: its reused file stays.
	sb.term.typeErrs = []error{&herdr.APIError{Code: "pane_not_found", Message: "gone"}}
	sb.c.mustError(proto.CmdWorkerPrompt, args, proto.ErrPromptFailed)
	if len(sb.files(t)) != 1 {
		t.Fatalf("a failed retry removed the reused file")
	}
	// Another review (a manual mark more) that fails: its files go.
	args.Secrets.Decisions = append(args.Secrets.Decisions, proto.SecretDecision{Action: proto.SecretProtect, Start: ptr(u16(text, "please")), End: ptr(u16Len(text))})
	sb.term.typeErrs = []error{&herdr.APIError{Code: "pane_not_found", Message: "gone"}}
	sb.c.mustError(proto.CmdWorkerPrompt, args, proto.ErrPromptFailed)
	if f := sb.files(t); len(f) != 1 {
		t.Fatalf("a failed send left its files: %v", f)
	}
	sb.noTrace(t, "Retry-Sentinel-5")
}

// A worker's files go when it really ends (closed in herdr), not when its
// floor sleeps or its herdr session goes, nor when the switch goes off.
func TestPromptSecretsLifecycle(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	send := func(id, text string) {
		t.Helper()
		s := sb.scan(t, text)
		_, m := sb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: id, Text: text, Secrets: &proto.SecretsReview{
			Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
		ackData[proto.PromptResult](t, m)
	}
	send(sb.id1, "PASSWORD=Life-One-1")
	send(sb.id2, "PASSWORD=Life-Two-2")
	if len(sb.files(t)) != 2 {
		t.Fatalf("files %v", sb.files(t))
	}
	sb.publishFloor(false) // asleep
	sb.publish(world.FloorGone{Session: "s"})
	sb.publishFloor(true)
	probe := sb.connect(proto.Hello{})
	probe.snapshot()
	if len(sb.files(t)) != 2 {
		t.Fatal("sleep or a gone session took files")
	}
	// Switched off: the files stay, and their lifecycle goes on.
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(false)})
	if len(sb.files(t)) != 2 {
		t.Fatal("switching off took files")
	}
	// w2's workspace closes while its floor runs: its files go.
	sb.workers = sb.workers[:1]
	sb.publishFloor(true)
	waitFor(t, "w2's files to go", func() bool {
		f := sb.files(t)
		return len(f) == 1 && slices.Contains(slices.Collect(mapValues(f)), "Life-One-1")
	})
}

func mapValues(m map[string]string) func(func(string) bool) {
	return func(yield func(string) bool) {
		for _, v := range m {
			if !yield(v) {
				return
			}
		}
	}
}

// At start the janitor removes a closed worker's files and what has no
// owner, and keeps an open (asleep) worker's.
func TestPromptSecretsStartupSweep(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	for _, id := range []string{sb.id1, sb.id2} {
		text := "PASSWORD=Sweep-" + id[:8]
		s := sb.scan(t, text)
		_, m := sb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: id, Text: text, Secrets: &proto.SecretsReview{
			Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
		ackData[proto.PromptResult](t, m)
	}
	sb.stop()
	st, err := store.Open(context.Background(), sb.db)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.CloseWorker(context.Background(), sb.id1); err != nil {
		t.Fatal(err)
	}
	st.Close()
	orphan := filepath.Join(sb.dir, "ORPHANORPHANORPHANORPHAN22")
	if err := os.Mkdir(orphan, 0o700); err != nil {
		t.Fatal(err)
	}
	b2 := startBridge(t, sb.db, server.Options{SecretsDir: sb.dir})
	b2.connect(proto.Hello{}).snapshot()
	waitFor(t, "the sweep", func() bool {
		f := sb.files(t)
		_, err := os.Stat(orphan)
		return len(f) == 1 && os.IsNotExist(err)
	})
	for _, v := range sb.files(t) {
		if v != "Sweep-"+sb.id2[:8] {
			t.Fatalf("kept %q", v)
		}
	}
}

// Send home removes the worker's files (finishFire and the worker's
// removal alike).
func TestPromptSecretsSendHome(t *testing.T) {
	t.Parallel()
	base := t.TempDir()
	dir := filepath.Join(base, "secrets")
	hb := startHireBridge(t, nil, claudeW("w1", "sess-1"))
	hb.fl.setProcs("w1:p1", running("claude", "sess-1"))
	id := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")["w1"].ID
	hb.stop()
	// Files of the worker from before (its id is known now).
	st, err := store.Open(context.Background(), hb.db)
	if err != nil {
		t.Fatal(err)
	}
	f, err := secretfiles.Open(secretfiles.Options{Dir: dir, Store: st})
	if err != nil {
		t.Fatal(err)
	}
	files, err := f.Write(context.Background(), secretfiles.Worker(id), time.Time{}, [][]byte{[]byte("home-secret")})
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	st.Close()
	hb2 := startHireBridgeAt(t, hb.db, func(o *server.Options) { o.SecretsDir = dir }, claudeW("w1", "sess-1"))
	hb2.fl.setProcs("w1:p1", running("claude", "sess-1"))
	hb2.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 })
	if _, err := os.Stat(files[0].Path); err != nil {
		t.Fatalf("the open worker's file went at start: %v", err)
	}
	_, m := hb2.c.command(proto.CmdWorkerFire, "fire", proto.WorkerFireArgs{ID: id})
	ackData[proto.FireResult](t, m)
	waitFor(t, "the sent home worker's file to go", func() bool {
		_, err := os.Stat(filepath.Dir(files[0].Path))
		return os.IsNotExist(err)
	})
}

// #13's Telegram replies have no review: with the switch on, a reply with
// a possible secret is refused with a fixed answer (never its text) and
// nothing is typed; a clean one goes as today.
func TestPromptSecretsTelegramReply(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "secrets")
	rb := startReplyBridgeWith(t, func(o *server.Options) { o.SecretsDir = dir })
	rb.repliesOn(t)
	rb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	m1 := rb.finished(t, "w1")
	r := rb.reply(m1, "use PASSWORD=Tg-Sentinel-8 now")
	want := "Not sent: it may hold a password or another secret. Send it from the game, where you can review what is protected."
	if a := rb.answer(t, 1); a.To != r || a.Text != want {
		t.Fatalf("answer %+v", a)
	}
	if calls := rb.term.Calls(); len(calls) != 0 || len(rb.ch.Confirmed()) != 0 {
		t.Fatalf("typed %q", calls)
	}
	rows := waitNotifyRows(t, rb.st, notify.AuditReply, 1)
	if rows[0].OK || rows[0].Error != notify.ReplySecrets || strings.Contains(rows[0].Args, "Tg-Sentinel") {
		t.Fatalf("audit %+v", rows[0])
	}
	r2 := rb.reply(m1, "run the tests")
	waitFor(t, "the clean reply confirmed", func() bool { return slices.Contains(rb.ch.Confirmed(), r2) })
	if calls := rb.term.Calls(); !slices.Equal(calls, []string{`type w1:p1 "run the tests"`}) {
		t.Fatalf("calls %q", calls)
	}
	if f, _ := os.ReadDir(dir); len(f) != 1 { // the lock only
		t.Fatalf("files %v", f)
	}
}

// The composer's "/handoff <instruction>": its secrets are protected before
// it is a handoff request, so the request, its prompt and its stored
// instruction hold the reference.
func TestPromptSecretsHandoffInstruction(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "secrets")
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	const sentinel = "Hk-Sentinel-77xyz"
	text := "/handoff note that the staging API key is " + sentinel
	id := ab.ids["w2"]
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: text, Op: "op-s"}, proto.ErrSecretsReviewRequired)
	_, m := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
	s := ackData[proto.PromptSecretsScan](t, m)
	if len(s.Candidates) != 1 {
		t.Fatalf("scan %+v", s)
	}
	_, m = c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: id, Text: text, Op: "op-s", Secrets: &proto.SecretsReview{
		Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
	pr := ackData[proto.PromptResult](t, m)
	if pr.Handoff == nil || !strings.HasPrefix(pr.Handoff.Instruction, "note that the staging API key is [secret in file "+dir+"/") {
		t.Fatalf("ack %s", m.raw)
	}
	req, err := ab.st.HandoffRequestByOp(context.Background(), "op-s")
	if err != nil || req.Instruction != pr.Handoff.Instruction {
		t.Fatalf("stored %+v %v", req, err)
	}
	prompt, _, _ := ab.mustRequest(t, "w2:p1")
	if !strings.Contains(prompt, pr.Handoff.Instruction) || strings.Contains(prompt, sentinel) {
		t.Fatalf("request prompt %q", prompt)
	}
	ref := refRe.FindStringSubmatch(pr.Handoff.Instruction)
	if b, err := os.ReadFile(ref[1]); err != nil || string(b) != sentinel {
		t.Fatalf("file %q %v", b, err)
	}
	if strings.Contains(c.heard.String(), sentinel) {
		t.Fatal("a message holds the secret")
	}
}
