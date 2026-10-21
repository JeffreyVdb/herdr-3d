package server_test

// #163: a prefixless random token ("Actually, token is this one: <64
// letters>") that no known format or phrase finds is proposed by the entropy
// rule, and every route reviews it through the one shared scan: the review
// is required, the protected token is a file reference and the token is
// nowhere else; ignored, it goes as typed.

import (
	"math/rand/v2"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// entropyToken is a synthetic 64-letter token (letters only: Gitleaks'
// generic rule drops it, and no prefix names it).
func entropyToken() string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
	r := rand.New(rand.NewPCG(163, 1))
	b := make([]byte, 64)
	for i := range b {
		b[i] = letters[r.IntN(len(letters))]
	}
	return string(b)
}

// entropyReview scans text and protects the one candidate (or ignores it),
// checking it is the token's exact range, found by the entropy rule alone.
func entropyReview(t *testing.T, c *client, text, tok string, protect bool) *proto.SecretsReview {
	t.Helper()
	_, m := c.command(proto.CmdPromptSecretsScan, "scan", proto.PromptSecretsScanArgs{Text: text})
	s := ackData[proto.PromptSecretsScan](t, m)
	if len(s.Candidates) != 1 {
		t.Fatalf("candidates %+v", s.Candidates)
	}
	if cand := s.Candidates[0]; cand.Start != u16(text, tok) || cand.End != cand.Start+len(tok) || len(cand.Kinds) != 1 || cand.Kinds[0] != "entropy" {
		t.Fatalf("candidate %+v", cand)
	}
	action := proto.SecretIgnore
	if protect {
		action = proto.SecretProtect
	}
	return &proto.SecretsReview{Revision: s.Revision, Decisions: []proto.SecretDecision{{Candidate: "c1", Action: action}}}
}

// worker.hire: refused without a review, protected as a reference with the
// token's bytes in the new worker's file, ignored as typed.
func TestPromptSecretsEntropyHire(t *testing.T) {
	t.Parallel()
	hb, dir := startSecretsHireBridge(t, true, nil)
	tok := entropyToken()
	text := "Deploy it.\nActually, token is this one: " + tok
	a := hireArgs(0)
	a.Prompt = text
	_, m := hb.c.command(proto.CmdWorkerHire, "h0", a)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr was called: %q", calls)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, tok)

	a.Secrets = entropyReview(t, hb.c, text, tok, true)
	_, m = hb.c.command(proto.CmdWorkerHire, "h1", a)
	res := ackData[proto.HireResult](t, m)
	sent := sentPrompt(t, hb, res.WorkspaceID+":p1")
	refs := refRe.FindAllStringSubmatch(sent, -1)
	if res.Protected != 1 || len(refs) != 1 || strings.Contains(sent, tok) || sent != strings.Replace(text, tok, refs[0][0], 1) {
		t.Fatalf("sent %q, ack %s", sent, m.raw)
	}
	if files := protectedFiles(t, dir); len(files) != 1 || files[refs[0][1]] != tok {
		t.Fatalf("files %v", files)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, tok)

	a.DeskIndex, a.Secrets = ptr(1), entropyReview(t, hb.c, text, tok, false)
	_, m = hb.c.command(proto.CmdWorkerHire, "h2", a)
	res = ackData[proto.HireResult](t, m)
	if got := sentPrompt(t, hb, res.WorkspaceID+":p1"); got != text || res.Protected != 0 {
		t.Fatalf("ignored: sent %q, ack %s", got, m.raw)
	}
}

// hire.interpret (a dictated hire): the sentence is refused without a
// review, the model reads a reference, the hire of its task needs no review.
func TestPromptSecretsEntropyHireInterpret(t *testing.T) {
	t.Parallel()
	llm := hireTaskLLM()
	hb, dir := startSecretsInterpretBridge(t, llm, nil)
	tok := entropyToken()
	text := "Hire a Claude Code agent on Haiku 5.5 to deploy it. Actually, token is this one: " + tok
	_, m := hb.c.command(proto.CmdHireInterpret, "i0", proto.HireInterpretArgs{Text: text})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired || len(llm.Calls()) != 0 {
		t.Fatalf("no review: %s", m.raw)
	}
	res := interpretCmd(t, hb.c, "i1", proto.HireInterpretArgs{Text: text, Secrets: entropyReview(t, hb.c, text, tok, true)})
	if res.Hire == nil || res.Protected != 1 || res.SecretsPending == "" || strings.Contains(res.Text, tok) || !strings.Contains(res.Hire.Task.Value, "[secret in file ") {
		t.Fatalf("interpreted %+v", res)
	}
	for _, call := range llm.Calls() {
		if strings.Contains(call.Messages[1].Content, tok) {
			t.Fatal("the LLM read the token")
		}
	}
	if files := protectedFiles(t, dir); len(files) != 1 {
		t.Fatalf("files %v", files)
	}
	traceFree(t, hb.st, hb.db, []*client{hb.c}, tok)
}

// schedule.create (a stored prompt): refused without a review; a protecting
// one is refused as a stored prompt cannot hold references; left as typed it
// is stored with its record.
func TestPromptSecretsEntropySchedule(t *testing.T) {
	t.Parallel()
	dir := secretsDirFor(t)
	sb := startSchedBridge(t, func(o *server.Options) { o.SecretsDir = dir })
	sb.c.mustAck(proto.CmdPromptSecretsSet, proto.PromptSecretsSetArgs{Enabled: ptr(true)})
	tok := entropyToken()
	text := "Rotate it. Actually, token is this one: " + tok
	sp := spec(t0.Add(2 * time.Hour))
	sp.Prompt = text
	_, m := sb.c.command(proto.CmdScheduleCreate, "c1", sp)
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	sp.Secrets = entropyReview(t, sb.c, text, tok, true)
	_, m = sb.c.command(proto.CmdScheduleCreate, "c2", sp)
	if code := codeOf(m); code != proto.ErrSecretsReviewStored {
		t.Fatalf("protected: %s", m.raw)
	}
	sp.Secrets = entropyReview(t, sb.c, text, tok, false)
	if s := sb.create(sp); s.Prompt != text {
		t.Fatalf("stored %+v", s)
	}
	if f := protectedFiles(t, dir); len(f) != 0 {
		t.Fatalf("files %v", f)
	}
}

// worker.prompt: refused without a review; the confirmed send types the
// reference.
func TestPromptSecretsEntropyPrompt(t *testing.T) {
	t.Parallel()
	sb := startSecretsBridge(t, true, nil)
	tok := entropyToken()
	text := "Check the deploy. Actually, token is this one: " + tok
	_, m := sb.c.command(proto.CmdWorkerPrompt, "p0", proto.WorkerPromptArgs{ID: sb.id1, Text: text})
	if code := codeOf(m); code != proto.ErrSecretsReviewRequired {
		t.Fatalf("no review: %s", m.raw)
	}
	_, m = sb.c.command(proto.CmdWorkerPrompt, "p1", proto.WorkerPromptArgs{ID: sb.id1, Text: text, Secrets: entropyReview(t, sb.c, text, tok, true)})
	if pr := ackData[proto.PromptResult](t, m); pr.Protected != 1 {
		t.Fatalf("ack %s", m.raw)
	}
	files := sb.files(t)
	if len(files) != 1 {
		t.Fatalf("files %v", files)
	}
	for _, b := range files {
		if b != tok {
			t.Fatalf("file holds %q", b)
		}
	}
	for _, call := range sb.term.Calls() {
		if strings.Contains(call, tok) {
			t.Fatalf("the terminal got the token: %q", call)
		}
	}
	sb.noTrace(t, tok)
}
