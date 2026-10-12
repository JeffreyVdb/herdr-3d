//go:build integration

package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// HandoffRealVar opts in to #224's one real-model smoke.
const HandoffRealVar = "H3D_HANDOFF_REAL"

// smokeClaude is the smoke's model, at low effort.
const smokeClaude = "claude-haiku-5-5"

// TestIntegrationAgentHandoffClaudeSmoke is #224's one bounded real-model run
// (H3D_HANDOFF_REAL=1): herdr-world, in a throwaway herdr session, asks a real
// Claude Code (haiku, low effort) for a handoff through the user's own
// handoff skill, typed as "/handoff …" with the reserved path; the agent
// writes the file and its turn ends; the bridge files it as an agent
// handoff with its own front matter. One request, one turn's worth of
// tokens; nothing is retried. The handoff directory is a temporary one.
func TestIntegrationAgentHandoffClaudeSmoke(t *testing.T) {
	if os.Getenv(HandoffRealVar) != "1" {
		t.Skipf("set %s=1 to spend one real Claude turn (%s)", HandoffRealVar, smokeClaude)
	}
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("claude is not installed")
	}
	s := startThrowaway(t)
	t.Logf("throwaway session %s", s.name)
	work := t.TempDir()
	hdir := filepath.Join(t.TempDir(), "handoff")
	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	only := regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$")
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: filepath.Join(t.TempDir(), "world.db"), Herdr: &herdr.Client{Bin: s.bin}, Only: only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelInfo})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: s.bin, Only: only}, ClaudeCLI: "claude", ClaudeProjects: usage.DefaultClaudeProjects(),
			HandoffDir: hdir,
		})
	}()
	t.Cleanup(func() {
		cancel()
		<-served
	})
	<-ready
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := proto.Dial(dctx, sock)
	dcancel()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := conn.Hello(ctx, proto.Hello{Client: "handoff-smoke"}); err != nil {
		t.Fatal(err)
	}
	st := &stream{t: t, msgs: make(chan []byte, 4096)}
	go func() {
		defer close(st.msgs)
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			st.msgs <- raw
		}
	}()
	b := &bridgeConn{t: t, conn: conn, st: st}

	s.run("--session", s.name, "workspace", "create", "--cwd", work, "--label", "claude", "--no-focus")
	cl := b.workerOf("claude", 10*time.Second)
	out, err := s.runErr("--session", s.name, "agent", "start", "h3d-handoff", "--kind", "claude", "--pane", cl.PaneID,
		"--timeout", "30000", "--", "--model", smokeClaude, "--effort", "low", "--permission-mode", "bypassPermissions")
	t.Logf("agent start: %v %s", err, out)
	// The folder's trust dialog (and any start-up confirmation): yes; then
	// idle with its agent session known.
	var w proto.Worker
	b.st.waitFor("claude idle with a session", 120*time.Second, func(ev proto.Event) bool {
		if ev.T != proto.EvWorkerUpsert || ev.Worker.ID != cl.ID {
			return false
		}
		w = *ev.Worker
		if q := w.Question; q != nil && w.Status == "blocked" {
			for _, c := range q.Choices {
				if strings.HasPrefix(c.Label, "Yes") {
					t.Logf("answering %q with %q", q.Text, c.Label)
					b.ack(proto.CmdWorkerAnswer, proto.WorkerAnswerArgs{ID: cl.ID, Hash: q.Hash, Choice: c.N}, 15*time.Second, nil)
					break
				}
			}
			return false
		}
		return (w.Status == "idle" || w.Status == "done") && w.AgentSession != ""
	})
	time.Sleep(3 * time.Second) // Claude drops an Enter right after its trust dialog
	// A session to hand off: Claude Code writes its transcript with the first
	// prompt (a never-prompted agent has none, and is refused).
	evs := b.ack(proto.CmdWorkerPrompt, proto.WorkerPromptArgs{ID: cl.ID, Text: "Reply with exactly the word: ready. Use no tools."}, 30*time.Second, nil)
	b.status(evs, cl.ID, 15*time.Second, "working")
	b.status(nil, cl.ID, 120*time.Second, "idle", "done")
	time.Sleep(3 * time.Second)

	var pv proto.WorkerHandoffPreviewResult
	b.ack(proto.CmdWorkerHandoffPreview, proto.WorkerHandoffPreviewArgs{Worker: cl.ID, Mode: proto.HandoffModeAgent}, 60*time.Second, &pv)
	pj, _ := json.Marshal(pv.Agent)
	t.Logf("agent preview: %s", pj)
	if pv.Agent == nil || !pv.Agent.CanAsk || pv.Agent.Call != "/handoff" {
		t.Fatalf("cannot ask: %s", pj)
	}
	var res proto.WorkerHandoffRequestResult
	b.ack(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: cl.ID, Mode: proto.HandoffModeAgent, Op: "smoke-1",
		Instruction: "This is a smoke test of a fresh session with no history: write a handoff of at most five lines saying so."},
		60*time.Second, &res)
	t.Logf("request: %+v", res.Request)
	var got proto.AgentHandoff
	b.st.waitFor("the request filed or failed", 6*time.Minute, func(ev proto.Event) bool {
		if ev.T != proto.EvWorkerUpsert || ev.Worker.ID != cl.ID || ev.Worker.AgentHandoff == nil {
			return false
		}
		got = *ev.Worker.AgentHandoff
		return got.State == proto.AgentHandoffFiled || got.State == proto.AgentHandoffFailed
	})
	t.Logf("outcome: %+v", got)
	if got.State != proto.AgentHandoffFiled {
		t.Fatalf("not filed: %s", got.Reason)
	}
	files, _ := filepath.Glob(filepath.Join(hdir, handoff.FloorDir(s.name), "*.md"))
	if len(files) != 1 {
		t.Fatalf("cabinet files: %v", files)
	}
	body, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("filed %s:\n%s", files[0], body)
	fm, text := handoff.SplitFrontMatter(string(body))
	if fm["source"] != "agent" || fm["op"] != "smoke-1" || fm["harness"] != "claude" || strings.TrimSpace(text) == "" {
		t.Fatalf("filed file:\n%s", body)
	}
	if left, _ := filepath.Glob(filepath.Join(hdir, handoff.PendingDir, "*", "*")); len(left) != 0 {
		t.Fatalf("pending files left: %v", left)
	}
}
