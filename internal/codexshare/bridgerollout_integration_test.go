//go:build integration

package codexshare

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// legacyArgs is how a Codex worker is started without its own server: the
// hire's arguments, as before #155.
var legacyArgs = []string{"-m", "mock", "-c", "model_reasoning_effort=low", "--dangerously-bypass-approvals-and-sandbox"}

// TestCodexShareBridgeWorkers (#158, scenario 13): two shared workers on
// one floor get two servers and two threads, and an answer never crosses
// from one to the other.
func TestCodexShareBridgeWorkers(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-a", "bare-b")
	f.installHerdrHook()
	b := f.startBridge(bridgeOptions{})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	c.setShared(true)
	ws := []*hired{c.hire("a", "bare-a", 0), c.hire("b", "bare-b", 1)}
	threads := map[string]string{}
	var servers []string
	for i, w := range ws {
		c.prompt(fmt.Sprintf("%d-first", i), w.id, "MOCK:say ready-"+filepath.Base(w.cwd))
		c.settle(w)
		threads[w.id] = c.attached(fmt.Sprintf("%d-joined", i), w.id).Thread
		l, _ := b.launchOf(w.id)
		servers = append(servers, fmt.Sprintf("pid %d socket %s", l.ServerPID, codexapp.Launch{Dir: l.RunDir, Name: l.Name}.Socket()))
	}
	f.record("servers-and-threads.txt", scrub(f, fmt.Sprintf("%s: %s, thread %s\n%s: %s, thread %s\n",
		ws[0].id, servers[0], threads[ws[0].id], ws[1].id, servers[1], threads[ws[1].id])))
	if servers[0] == servers[1] || threads[ws[0].id] == threads[ws[1].id] {
		t.Fatalf("two workers share a server or a thread")
	}

	batches := make([]proto.CodexBatch, 2)
	for i, w := range ws {
		c.prompt(fmt.Sprintf("%d-ask", i), w.id, fmt.Sprintf("MOCK:ask-options hold=x%d", i))
		f.held(fmt.Sprintf("x%d", i))
		batches[i] = c.batchWith(fmt.Sprintf("%d-batch", i), w.id, 1)
	}
	// One worker's batch named on the other: refused, nothing sent.
	cross := c.answer(ws[1].id, threads[ws[1].id], batches[0].Batch, 0, "Green")
	wrongThread := c.answer(ws[1].id, threads[ws[0].id], batches[1].Batch, 0, "Green")
	f.record("crossed-answers.txt", string(cross)+"\n"+string(wrongThread)+"\n")
	if errCode(cross) != proto.ErrStale || errCode(wrongThread) != proto.ErrStale {
		t.Errorf("a crossed answer was not refused: %s / %s", cross, wrongThread)
	}
	answers := []string{"Green", "Blue"}
	before := len(f.mock.Requests())
	for i, w := range ws {
		if raw := c.answer(w.id, threads[w.id], batches[i].Batch, 0, answers[i]); !isAck(raw) {
			t.Fatalf("answer %d: %s", i, raw)
		}
	}
	for i, w := range ws {
		if err := f.mock.Release(fmt.Sprintf("x%d", i)); err != nil {
			t.Fatal(err)
		}
		c.waitQuestion(fmt.Sprintf("%d-answered", i), w.id, batches[i].Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered && q.AnsweredBy == "bridge"
		})
		c.settle(w)
		f.snap(fmt.Sprintf("%d-tui", i), w.pane)
	}
	replies := f.repliesSince(before, 2)
	f.recordJSON("mock-replies", summarize(replies))
	if len(replies) != 2 {
		t.Fatalf("%d reply requests, want 2", len(replies))
	}
	for _, r := range replies {
		for i := range ws {
			own := answersIn(string(r.Body), batches[i].Batch, 0) == 1
			other := answersIn(string(r.Body), batches[1-i].Batch, 0) > 0
			if own && (other || !strings.Contains(r.UserText, answers[i])) {
				t.Errorf("a reply for worker %d carries %q (the other's answer in its input: %v)", i, r.UserText, other)
			}
		}
	}
}

// TestCodexShareBridgeRollout (#158, scenarios 14–16): the switch is off by
// default and a Codex hire then runs exactly as before; on, hires get their
// own server; switched off again (rollback) the running shared worker keeps
// its server and answers while the next hire is legacy; on again changes
// only later hires. A Codex the bridge does not support (a fake
// codex-cli 0.999.0, a line not verified, as the bridge's codex) falls back with a note that says
// what is supported. A Claude hire is untouched by the switch.
func TestCodexShareBridgeRollout(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-l1", "bare-s1", "bare-l2", "bare-s2", "bare-u")
	f.installHerdrHook()
	b := f.startBridge(bridgeOptions{})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })

	legacy := func(label string, h *hired) {
		t.Helper()
		argv := f.argv(b.ctl, h.pane)
		f.record(label+"-argv.txt", scrub(f, strings.Join(argv, " "))+"\n")
		if len(argv) < 2 || !slices.Equal(argv[1:], legacyArgs) {
			t.Errorf("%s: argv %q, want codex %q", label, argv, legacyArgs)
		}
	}
	noRecord := func(label string, h *hired) {
		t.Helper()
		w, _ := c.worker(h.id)
		_, rec := b.launchOf(h.id)
		f.record(label+"-record.txt", fmt.Sprintf("hire ack codex: %+v\nworker codex view: %+v\ncodex_launch record: %v\n", h.res.Codex, w.Codex, rec))
		if h.res.Codex != nil || w.Codex != nil || rec {
			t.Errorf("%s: a Codex hire with the switch off has a codex view or record", label)
		}
	}

	var s1 *hired
	var s1Launch string
	t.Run("14 off by default: a Codex hire runs as before", func(t *testing.T) {
		sw := c.codexServer()
		f.recordJSON("14-switch-default", sw)
		if sw.Enabled || !sw.Available {
			t.Fatalf("the switch on a fresh store: %+v", sw)
		}
		l1 := c.hire("14-l1", "bare-l1", 0)
		noRecord("14-l1", l1)
		legacy("14-l1", l1)
		c.prompt("14-l1-turn", l1.id, "MOCK:say legacy-ok")
		c.settle(l1)
	})

	t.Run("16 on, then rolled back: the live shared worker is untouched, the next hire is legacy", func(t *testing.T) {
		f.record("16-switch-on.json", string(c.setShared(true)))
		s1 = c.hire("16-s1", "bare-s1", 1)
		if s1.res.Codex == nil || s1.res.Codex.Mode != proto.CodexModeShared {
			t.Fatalf("hire with the switch on: %+v", s1.res.Codex)
		}
		c.prompt("16-s1-ask", s1.id, "MOCK:ask-free")
		c.settle(s1)
		thread := c.attached("16-s1-joined", s1.id).Thread
		batch := c.batchWith("16-s1-pending", s1.id, 1)
		l, _ := b.launchOf(s1.id)
		s1Launch = l.Token

		f.record("16-switch-off.json", string(c.setShared(false)))
		time.Sleep(4 * time.Second) // more than a codex tick
		v := c.view("16-s1-after-rollback", s1.id)
		pids := codexapp.MarkedPIDs(l.Token, "")
		f.record("16-s1-server-after-rollback.txt", fmt.Sprintf("mode %s server %s attached %v, marked processes %v\n", v.Mode, v.Server, v.Attached, pids))
		if v.Mode != proto.CodexModeShared || v.Server != proto.CodexServerRunning || !v.Attached || len(pids) == 0 {
			t.Fatalf("rolling back touched the running shared worker")
		}
		if raw := c.answer(s1.id, thread, batch.Batch, 0, "answered-after-rollback"); !isAck(raw) {
			t.Fatalf("answer after the rollback: %s", raw)
		}
		c.waitQuestion("16-s1-answered", s1.id, batch.Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		c.settle(s1)
		l2 := c.hire("16-l2", "bare-l2", 2)
		noRecord("16-l2", l2)
		legacy("16-l2", l2)

		f.record("16-switch-on-again.json", string(c.setShared(true)))
		time.Sleep(4 * time.Second)
		if l, _ := b.launchOf(s1.id); l.Token != s1Launch {
			t.Errorf("switching on again relaunched the shared worker")
		}
		w2, _ := c.worker(l2.id)
		if _, rec := b.launchOf(l2.id); rec || w2.Codex != nil {
			t.Errorf("switching on again changed the legacy worker")
		}
		legacy("16-l2-after-on", l2)
		s2 := c.hire("16-s2", "bare-s2", 3)
		if s2.res.Codex == nil || s2.res.Codex.Mode != proto.CodexModeShared {
			t.Fatalf("a hire after switching on again: %+v", s2.res.Codex)
		}
	})

	t.Run("15 an unsupported Codex falls back with an actionable note", func(t *testing.T) {
		fake := filepath.Join(f.root, "fakebin", "codex")
		if err := os.MkdirAll(filepath.Dir(fake), 0o755); err != nil {
			t.Fatal(err)
		}
		f.write(fake, "#!/bin/sh\necho 'codex-cli 0.999.0'\n", 0o755)
		b.o.codexCLI = fake
		b.restart()
		c = b.dial("game-after-restart")
		c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
		if !c.codexServer().Enabled {
			t.Fatal("the switch did not survive the restart")
		}
		u := c.hire("15-u", "bare-u", 4)
		if u.res.Codex == nil {
			t.Fatal("an unsupported Codex: no codex in the hire's ack")
		}
		f.record("15-note.txt", u.res.Codex.Note+"\n")
		if u.res.Codex.Mode != proto.CodexModeLegacy ||
			!strings.Contains(u.res.Codex.Note, "0.999.0") || !strings.Contains(u.res.Codex.Note, "supported: codex-cli "+codexapp.Supported()) ||
			!strings.Contains(u.res.Codex.Note, "the usual way") {
			t.Fatalf("an unsupported Codex: %+v", u.res.Codex)
		}
		v := c.view("15-u-view", u.id)
		if v.Note != u.res.Codex.Note {
			t.Errorf("the seat bar's note %q", v.Note)
		}
		legacy("15-u", u)
		c.prompt("15-u-turn", u.id, "MOCK:say unsupported-runs-the-usual-way")
		c.settle(u)
		f.snap("15-u-tui", u.pane)
		if s1 != nil {
			c.attached("15-s1-rejoined-after-restart", s1.id)
		}
	})

	t.Run("15 accepting unverified versions survives a restart and keeps shared transcripts", func(t *testing.T) {
		allow := true
		c.ack(proto.CmdCodexServerSet, proto.CodexServerSetArgs{AllowUnverified: &allow}, 10*time.Second, nil)
		b.restart()
		c = b.dial("game-with-unverified-allowed")
		c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
		if cs := c.codexServer(); !cs.Enabled || !cs.AllowUnverified {
			t.Fatalf("preferences after restart: %+v", cs)
		}
		u := c.hire("15-accepted", "bare-u", 6)
		if u.res.Codex == nil || u.res.Codex.Mode != proto.CodexModeShared || u.res.Codex.Note != "" {
			t.Fatalf("accepted unverified CLI fell back: %+v", u.res.Codex)
		}
		c.prompt("15-accepted-turn", u.id, "MOCK:say unverified-shared-still-works")
		c.settle(u)
		c.attached("15-accepted-joined", u.id)
		var tr proto.TranscriptWatchResult
		raw := c.ack(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: u.id, Limit: 50}, 30*time.Second, &tr)
		if !strings.Contains(string(raw), "unverified-shared-still-works") {
			t.Fatal("shared transcript lost the conversation")
		}
		f.record("15-accepted-transcript.json", scrub(f, string(raw)))
		c.ack(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: u.id}, 10*time.Second, nil)
	})

	t.Run("14 a Claude hire is untouched by the switch", func(t *testing.T) {
		if _, err := exec.LookPath("claude"); err != nil {
			t.Skip("claude is not installed")
		}
		c.setShared(true)
		dir := t.TempDir()
		desk := 5
		model := server.HireOptions().Claude.Models[0]
		var res proto.HireResult
		raw := c.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: f.h.Name, DeskIndex: &desk, Harness: "claude", Model: model,
			Effort: "low", Cwd: dir}, 2*time.Minute, &res)
		f.record("14-claude-hire-ack.json", scrub(f, string(raw)))
		w := c.waitWorker("14-claude", res.ID, 30*time.Second, func(w proto.Worker) bool { return w.AgentKind == "claude" })
		_, rec := b.launchOf(res.ID)
		argv := f.argv(b.ctl, res.WorkspaceID+":p1")
		f.record("14-claude-argv.txt", scrub(f, strings.Join(argv, " "))+"\n")
		if res.Codex != nil || w.Codex != nil || rec || !containsRun(argv, "--model", model) || slices.Contains(argv, "--remote") {
			t.Errorf("a Claude hire with the switch on: codex %+v, record %v, argv %q", res.Codex, rec, argv)
		}
		f.snap("14-claude-tui", res.WorkspaceID+":p1")
		// The private HOME has no Claude onboarding/auth state. This check
		// verifies launch isolation; fixture session cleanup stops the TUI.
		// /exit is not a command while Claude is still choosing its theme.
	})
	f.record("bridge-events.txt", strings.Join(c.eventLog(), "\n")+"\n")
}
