package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
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
	return protectedFiles(t, sb.dir)
}

// protectedFiles are the protected files under dir: path → bytes. One
// removed while they are read (a release or a sweep going on) is not there.
func protectedFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	owners, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, o := range owners {
		if o.Name() == ".lock" {
			continue
		}
		entries, err := os.ReadDir(filepath.Join(dir, o.Name()))
		if errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			p := filepath.Join(dir, o.Name(), e.Name())
			b, err := os.ReadFile(p)
			if errors.Is(err, os.ErrNotExist) {
				continue
			} else if err != nil {
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

// Off, a /handoff goes as today too: its ack has no sent or protected, its
// request's prompt holds the instruction as typed, and no file is made.
func TestPromptSecretsOffHandoffAsToday(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "secrets")
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	_, m := c.command(proto.CmdWorkerPrompt, "off", proto.WorkerPromptArgs{ID: ab.ids["w2"], Text: "/handoff password=Off-Handoff-Sentinel-73x", Op: "op-off"})
	if pr := ackData[proto.PromptResult](t, m); pr.Handoff == nil || pr.Sent != "" || pr.Protected != 0 ||
		strings.Contains(string(m.raw), `"sent":`) || strings.Contains(string(m.raw), `"protected":`) {
		t.Fatalf("ack %s", m.raw)
	}
	if prompt, _, _, n := ab.requested("w2:p1"); n != 1 || !strings.Contains(prompt, "handoff password=Off-Handoff-Sentinel-73x\n") {
		t.Fatalf("%d requests: %q", n, prompt)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
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
	sb.publish(world.FloorGone{Session: "s", Gen: world.NextGen()})
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
	if pr.Handoff == nil || !strings.HasPrefix(pr.Handoff.Instruction, "note that the staging API key is [secret in file "+dir+"/") ||
		pr.Sent != "/handoff "+pr.Handoff.Instruction || pr.Protected != 1 { // review R2: the composer's text as sent
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
	// The composer's resend of the same submission: the request answers it,
	// and its file is the one already written.
	_, m = c.command(proto.CmdWorkerPrompt, "p2", proto.WorkerPromptArgs{ID: id, Text: text, Op: "op-s", Secrets: &proto.SecretsReview{
		Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
	if pr2 := ackData[proto.PromptResult](t, m); pr2.Handoff == nil || !pr2.Existing || pr2.Handoff.Instruction != pr.Handoff.Instruction ||
		pr2.Sent != "" || pr2.Protected != 0 {
		t.Fatalf("resend %s", m.raw)
	}
	n := 0
	owners, _ := os.ReadDir(dir)
	for _, o := range owners {
		if o.IsDir() {
			files, _ := os.ReadDir(filepath.Join(dir, o.Name()))
			n += len(files)
		}
	}
	if n != 1 {
		t.Fatalf("%d files after the resend", n)
	}
	if strings.Contains(c.heard.String(), sentinel) {
		t.Fatal("a message holds the secret")
	}
	// A plain shell is refused before anything is scanned.
	c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: ab.ids["w3"], Text: "PASSWORD=x9"}, proto.ErrInvalidState)
}

// A /handoff's files are its request's until the request is sent (review
// R1): one that fails after they were written (the skill missing, the
// request over Claude's typing limit with its reference, a cancel while it
// starts), or that the worker's pending request answers, removes the files
// it made, never another submission's; nothing is sent.
func TestPromptSecretsHandoffFailureRemovesFiles(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "secrets")
	ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
	c := ab.connect(proto.Hello{})
	c.snapshot()
	c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	w1, w2 := ab.ids["w1"], ab.ids["w2"]
	prompt := func(id, op, text string) proto.WorkerPromptArgs {
		t.Helper()
		_, m := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
		s := ackData[proto.PromptSecretsScan](t, m)
		if len(s.Candidates) != 1 {
			t.Fatalf("scan %+v", s)
		}
		return proto.WorkerPromptArgs{ID: id, Text: text, Op: op, Secrets: &proto.SecretsReview{Revision: s.Revision,
			Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}}
	}
	gone := func(what string, keep map[string]string) {
		t.Helper()
		waitFor(t, what+": the files it made removed", func() bool { return maps.Equal(protectedFiles(t, dir), keep) })
	}
	ab.cat.mu.Lock()
	ab.cat.missing = true
	ab.cat.mu.Unlock()
	c.mustError(proto.CmdWorkerPrompt, prompt(w2, "op-1", "/handoff password=Ho-Sentinel-1x"), proto.ErrHandoffSkillMissing)
	gone("the skill missing", map[string]string{})
	ab.cat.mu.Lock()
	ab.cat.missing = false
	ab.cat.mu.Unlock()

	// The instruction with its reference fits; the request's prompt, its
	// tabs typed as four spaces, does not.
	ref := len(fmt.Sprintf("[secret in file %s/%s/%s]", dir, strings.Repeat("A", 26), strings.Repeat("A", 26)))
	text := "/handoff x" + strings.Repeat("\t", proto.MaxHandoffInstruction-len("x password=")-ref) + " password=Ho-Sentinel-2x"
	_, m := c.command(proto.CmdWorkerPrompt, "typed", prompt(w1, "op-2", text))
	if !strings.Contains(string(m.raw), `"code":"bad_request"`) || !strings.Contains(string(m.raw), "16384 bytes as typed") {
		t.Fatalf("typed limit: %s", m.raw)
	}
	gone("the typed limit", map[string]string{})

	gate := make(chan struct{})
	ab.cat.mu.Lock()
	ab.cat.gate, ab.cat.entered = gate, make(chan struct{}, 1)
	ab.cat.mu.Unlock()
	cmd := func(typ, reqID string, args any) proto.Command {
		b, _ := json.Marshal(args)
		return proto.Command{T: typ, ReqID: reqID, Args: b}
	}
	c.send(cmd(proto.CmdWorkerPrompt, "p3", prompt(w2, "op-3", "/handoff password=Ho-Sentinel-3x")))
	<-ab.cat.entered
	if f := protectedFiles(t, dir); len(f) != 1 {
		t.Fatalf("written before the lookup: %v", f)
	}
	c.send(cmd(proto.CmdWorkerHandoffCancel, "x3", proto.WorkerHandoffCancelArgs{Worker: w2, Op: "op-3"}))
	replies := map[string]msg{}
	for len(replies) < 2 {
		if m := c.next(); m.env.T == proto.TAck || m.env.T == proto.TError {
			replies[m.env.ReqID] = m
		}
	}
	if replies["p3"].env.T != proto.TError || replies["x3"].env.T != proto.TAck {
		t.Fatalf("cancel %s %s", replies["p3"].raw, replies["x3"].raw)
	}
	ab.cat.mu.Lock()
	ab.cat.gate = nil
	ab.cat.mu.Unlock()
	close(gate)
	gone("a cancel", map[string]string{})

	// A request sent keeps its file; a /handoff its pending request answers
	// (the text unused) removes its own.
	_, m = c.command(proto.CmdWorkerPrompt, "p4", prompt(w2, "op-4", "/handoff password=Ho-Sentinel-4x"))
	if pr := ackData[proto.PromptResult](t, m); pr.Existing || pr.Protected != 1 {
		t.Fatalf("sent %s", m.raw)
	}
	kept := protectedFiles(t, dir)
	_, m = c.command(proto.CmdWorkerPrompt, "p5", prompt(w2, "op-5", "/handoff password=Ho-Sentinel-5x"))
	if pr := ackData[proto.PromptResult](t, m); !pr.Existing || pr.Handoff.Op != "op-4" || pr.Sent != "" || pr.Protected != 0 {
		t.Fatalf("existing %s", m.raw)
	}
	gone("an existing request", kept)
	if len(kept) != 1 || !slices.Contains(slices.Collect(maps.Values(kept)), "Ho-Sentinel-4x") {
		t.Fatalf("kept %v", kept)
	}
	if _, _, _, n := ab.requested("w2:p1"); n != 1 {
		t.Fatalf("%d requests sent to w2", n)
	}
	if _, _, _, n := ab.requested("w1:p1"); n != 0 {
		t.Fatalf("%d requests sent to w1", n)
	}
}

// With no usable private runtime directory a review that protects anything
// is refused, never sent raw; one that protects nothing goes as typed.
func TestPromptSecretsUnavailable(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	tb := startTermBridgeAt(t, db, nil, agentW("w2", "codex", "idle"))
	sb := &secretsBridge{termBridge: tb, db: db, c: tb.connect(proto.Hello{Client: "game"})}
	snap := sb.c.snapshot()
	if ps := snap.World.PromptSecrets; ps == nil || ps.Enabled || ps.Available {
		t.Fatalf("switch %+v", ps)
	}
	id := idOf(t, snap, "w2")
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	const sentinel = "Unav-Sentinel-6x"
	text := "PASSWORD=" + sentinel
	s := sb.scan(t, text)
	review := func(action string) *proto.SecretsReview {
		return &proto.SecretsReview{Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: action}}}
	}
	sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: id, Text: text, Secrets: review(proto.SecretProtect)}, proto.ErrSecretsUnavailable)
	if calls := sb.term.Calls(); len(calls) != 0 {
		t.Fatalf("sent %q", calls)
	}
	sb.noTrace(t, sentinel)
	_, m := sb.c.command(proto.CmdWorkerPrompt, "ign", proto.WorkerPromptArgs{ID: id, Text: text, Secrets: review(proto.SecretIgnore)})
	if pr := ackData[proto.PromptResult](t, m); pr.Sent != "" || !slices.Equal(sb.term.Calls(), []string{"submit w2:p1 " + strconv.Quote(text)}) {
		t.Fatalf("ignored: %s %q", m.raw, sb.term.Calls())
	}
}

// Only the bridge's own references are left alone (review S1): text that
// only looks like one, and a value around one, are reviewed, never sent
// raw; a sent prompt's own text, sent again, scans clean.
func TestPromptSecretsOwnReferencesOnly(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	const token = "ghp_GT2MQVTdhGOubkn5tfdOv4eYnhJvEkcAI167"
	for text, want := range map[string]string{
		"Use [secret in file /token=" + token + "]": token, // not a path of the bridge's
		`PASSWORD="Value-77! [secret in file /x]"`:  "Value-77! [secret in file /x]",
	} {
		s := sb.scan(t, text)
		if len(s.Candidates) != 1 || s.Candidates[0].Start != u16(text, want) || s.Candidates[0].End != u16(text, want)+u16Len(want) {
			t.Fatalf("%q: %+v", text, s)
		}
		sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: sb.id2, Text: text}, proto.ErrSecretsReviewRequired)
	}
	if calls := sb.term.Calls(); len(calls) != 0 {
		t.Fatalf("sent %q", calls)
	}
	text := "PASSWORD=Own-Sentinel-5x"
	s := sb.scan(t, text)
	_, m := sb.c.command(proto.CmdWorkerPrompt, "p", proto.WorkerPromptArgs{ID: sb.id2, Text: text, Secrets: &proto.SecretsReview{
		Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
	pr := ackData[proto.PromptResult](t, m)
	if again := sb.scan(t, pr.Sent); len(again.Candidates) != 0 {
		t.Fatalf("the sent text %q: %+v", pr.Sent, again)
	}
	around := `PASSWORD="Value-77! ` + refRe.FindString(pr.Sent) + `"`
	if s := sb.scan(t, around); len(s.Candidates) != 1 || s.Candidates[0].Start != u16(around, "Value-77!") ||
		s.Candidates[0].End != u16(around, "Value-77!")+len("Value-77!") {
		t.Fatalf("%q: %+v", around, s)
	}
}

// A value beside one of the bridge's own references is reviewed whatever
// it holds (review S1, pass 2: a symbol-only password before a reference
// was cut away as punctuation and sent raw): quoted or not, on either side.
func TestPromptSecretsSymbolsBesideOwnReference(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	seed := "PASSWORD=Seed-Sentinel-73x"
	s := sb.scan(t, seed)
	_, m := sb.c.command(proto.CmdWorkerPrompt, "seed", proto.WorkerPromptArgs{ID: sb.id2, Text: seed, Secrets: &proto.SecretsReview{
		Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
	ref := refRe.FindString(ackData[proto.PromptResult](t, m).Sent)
	if ref == "" {
		t.Fatal("no reference")
	}
	calls := len(sb.term.Calls())
	const value = "!@#%&+=?_-"
	for _, text := range []string{`PASSWORD="` + value + ` ` + ref + `"`, `PASSWORD=` + value + ref,
		`PASSWORD="` + ref + ` ` + value + `"`, `PASSWORD=` + ref + value} {
		s := sb.scan(t, text)
		if len(s.Candidates) != 1 || s.Candidates[0].Start != u16(text, value) || s.Candidates[0].End != u16(text, value)+len(value) {
			t.Fatalf("%q: %+v", text, s)
		}
		sb.c.mustError(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: sb.id2, Text: text}, proto.ErrSecretsReviewRequired)
	}
	if got := sb.term.Calls(); len(got) != calls {
		t.Fatalf("sent %q", got[calls:])
	}
	// A lone wrapper beside it is no secret: the text scans clean.
	if s := sb.scan(t, "secret=("+ref+")"); len(s.Candidates) != 0 {
		t.Fatalf("wrapped: %+v", s)
	}
}

// Once the lane has begun to send a reviewed /handoff's request, the send's
// result settles its files, whatever ended the request meanwhile (review
// P2-1): a cancel or a person taking over while the prompt is submitted,
// and a send that fails without knowing whether the agent took it, leave
// the file its prompt refers to with the worker. Before the send, the same
// ends remove it.
func TestPromptSecretsHandoffSettlesWithItsSend(t *testing.T) {
	t.Parallel()
	type held struct {
		ab      *agBridge
		c, x    *client
		dir, op string
		release func()
		path    string // the file the submitted prompt refers to
	}
	// start sends a reviewed /handoff to w2 (Codex) with the sentinel
	// protected, and returns once it is held: "submit" once the terminal
	// took its prompt, "lookup" while its skill is looked up (nothing
	// sent); "fail" fails the submission instead (it returns once tried).
	start := func(t *testing.T, sentinel, hold string) held {
		t.Helper()
		dir := filepath.Join(t.TempDir(), "secrets")
		ab := startAgentBridge(t, "", "", "", func(o *server.Options) { o.SecretsDir = dir })
		c, x := ab.connect(proto.Hello{}), ab.connect(proto.Hello{})
		c.snapshot()
		x.snapshot()
		c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
		text := "/handoff password=" + sentinel
		_, m := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
		s := ackData[proto.PromptSecretsScan](t, m)
		entered, gate := make(chan struct{}, 1), make(chan struct{})
		var once sync.Once
		release := func() { once.Do(func() { close(gate) }) }
		t.Cleanup(release)
		switch hold {
		case "submit":
			ab.term.mu.Lock()
			previous := ab.term.onPrompt
			ab.term.onPrompt = func(pane, how string) {
				if previous != nil {
					previous(pane, how)
				}
				if pane == "w2:p1" && how == "submit" {
					entered <- struct{}{}
					<-gate
				}
			}
			ab.term.mu.Unlock()
		case "lookup":
			ab.cat.mu.Lock()
			ab.cat.gate, ab.cat.entered = gate, entered
			ab.cat.mu.Unlock()
		case "fail":
			ab.term.mu.Lock()
			ab.term.submit = []error{errors.New("connection reset by peer")}
			ab.term.mu.Unlock()
		}
		op := "op-" + strings.ToLower(sentinel[:4])
		args, _ := json.Marshal(proto.WorkerPromptArgs{ID: ab.ids["w2"], Text: text, Op: op, Secrets: &proto.SecretsReview{
			Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: proto.SecretProtect}}}})
		c.send(proto.Command{T: proto.CmdWorkerPrompt, ReqID: "p", Args: args})
		h := held{ab: ab, c: c, x: x, dir: dir, op: op, release: release}
		if hold == "lookup" {
			<-entered
			if f := protectedFiles(t, dir); len(f) != 1 {
				t.Fatalf("written before the lookup: %v", f)
			}
			return h
		}
		if hold == "submit" {
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("no submission")
			}
		}
		var prompt string
		var n int
		eventually(t, "the request submitted", func() bool { prompt, _, _, n = ab.requested("w2:p1"); return n > 0 })
		refs := refRe.FindAllStringSubmatch(prompt, -1)
		if n != 1 || len(refs) != 1 || strings.Contains(prompt, sentinel) {
			t.Fatalf("submitted %d: %q", n, prompt)
		}
		if b, err := os.ReadFile(refs[0][1]); err != nil || string(b) != sentinel {
			t.Fatalf("the file %q %v", b, err)
		}
		h.path = refs[0][1]
		return h
	}
	// failed waits for the request's command to fail.
	failed := func(t *testing.T, h held) {
		t.Helper()
		for {
			if m := h.c.next(); m.env.ReqID == "p" {
				if m.env.T != proto.TError {
					t.Fatalf("the request's command: %s", m.raw)
				}
				return
			}
		}
	}
	// cancel cancels the request from x; keys sends worker.keys from x,
	// which takes over at once (on the hub) and then waits on the lane.
	cancel := func(h held) {
		h.x.mustAck(proto.CmdWorkerHandoffCancel, proto.WorkerHandoffCancelArgs{Worker: h.ab.ids["w2"], Op: h.op})
	}
	keys := func(h held) {
		args, _ := json.Marshal(proto.WorkerKeysArgs{ID: h.ab.ids["w2"], Input: []proto.InputItem{{Key: ptr("esc")}}})
		h.x.send(proto.Command{T: proto.CmdWorkerKeys, ReqID: "k", Args: args})
	}
	// kept: once the lane is done (keys acked), the file the prompt refers
	// to is still there, the only one.
	kept := func(t *testing.T, h held, sentinel string) {
		t.Helper()
		for {
			if m := h.x.next(); m.env.ReqID == "k" {
				if m.env.T != proto.TAck {
					t.Fatalf("keys %s", m.raw)
				}
				break
			}
		}
		if f := protectedFiles(t, h.dir); len(f) != 1 || f[h.path] != sentinel {
			t.Fatalf("the submitted prompt's file %s: files %v", h.path, f)
		}
	}
	t.Run("cancel after submission", func(t *testing.T) {
		t.Parallel()
		const sentinel = "Cancel-Sentinel-73x"
		h := start(t, sentinel, "submit")
		cancel(h)
		failed(t, h)
		keys(h)
		h.release()
		kept(t, h, sentinel)
	})
	t.Run("takeover after submission", func(t *testing.T) {
		t.Parallel()
		const sentinel = "Takeover-Sentinel-74x"
		h := start(t, sentinel, "submit")
		keys(h)
		failed(t, h)
		h.release()
		kept(t, h, sentinel)
	})
	t.Run("send failed without knowing", func(t *testing.T) {
		t.Parallel()
		const sentinel = "Unknown-Sentinel-75x"
		h := start(t, sentinel, "fail")
		failed(t, h)
		keys(h)
		kept(t, h, sentinel)
	})
	for _, end := range []string{"cancel", "takeover"} {
		t.Run(end+" before the send", func(t *testing.T) {
			t.Parallel()
			h := start(t, "Before-Sentinel-76x", "lookup")
			if end == "cancel" {
				cancel(h)
			} else {
				keys(h)
			}
			failed(t, h)
			h.release()
			waitFor(t, "the file removed", func() bool { return len(protectedFiles(t, h.dir)) == 0 })
			if _, _, _, n := h.ab.requested("w2:p1"); n != 0 {
				t.Fatalf("%d requests sent", n)
			}
		})
	}
}
