//go:build integration

package codexshare

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// realBridgeModel is the model of #158's one real-model run, at low effort.
const realBridgeModel = "gpt-6.1-sol"

// TestCodexShareBridgeRealModelSmoke is #158's one bounded real-model run
// through the full stack (RealSmokeVar=1): herdr-world hires a shared
// Codex worker into a throwaway Herdr session on the user's own ~/.codex
// (its server per worker, started from its pane, as hire does), the model
// is asked to queue one async question, herdr-world answers it, and the
// answer is counted in the thread's rollout. At most three turns. Nothing
// connects to the CODEX_HOME daemon: every codex the run starts is the
// worker's own server or names its socket, and the daemon's pid file and
// the config's checksums are compared before and after.
func TestCodexShareBridgeRealModelSmoke(t *testing.T) {
	if os.Getenv(RealSmokeVar) != "1" {
		t.Skipf("set %s=1 to spend up to three real-model turns", RealSmokeVar)
	}
	requireTools(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	root, err := os.MkdirTemp("", "h3d158-")
	if err != nil {
		t.Fatal(err)
	}
	f := &fx{t: t, ctx: ctx, root: root, owner: NewOwner()}
	t.Cleanup(func() {
		f.killOwned()
		_ = os.RemoveAll(root)
	})
	if dir := os.Getenv("H3D_CODEXSHARE_EVIDENCE"); dir != "" {
		f.ev = filepath.Join(dir, t.Name())
		_ = os.RemoveAll(f.ev)
		if err := os.MkdirAll(f.ev, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	home, _ := os.UserHomeDir()
	codexHome := filepath.Join(home, ".codex")
	baseline := realBaseline(codexHome)
	f.record("baseline-before.txt", baseline)
	f.h, err = StartHerdr(ctx, root, fixtureShell(t), os.Environ(), OwnerVar+"="+f.owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.h.Close)
	ws := filepath.Join(root, "ws")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}

	b := f.startBridge(bridgeOptions{sessions: codex.DefaultSessionsDir(), models: []string{realBridgeModel}})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	c.setShared(true)
	desk := 0
	var res proto.HireResult
	raw := c.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: f.h.Name, DeskIndex: &desk, Harness: "codex", Model: realBridgeModel,
		Effort: "low", Cwd: ws}, 2*time.Minute, &res)
	f.record("hire-ack.json", scrub(f, string(raw)))
	w := &hired{id: res.ID, pane: res.WorkspaceID + ":p1", cwd: ws, res: res}
	screen := f.snap("tui-started", w.pane)
	if res.Codex == nil || res.Codex.Mode != proto.CodexModeShared {
		t.Fatalf("the hire is not shared: %+v", res.Codex)
	}
	if strings.Contains(screen, "Trust this folder") || strings.Contains(screen, hooksReviewText) {
		t.Fatal("a startup dialog showed: not answered (it would change ~/.codex)")
	}
	l, _ := b.launchOf(w.id)
	sock := codexapp.Launch{Dir: l.RunDir, Name: l.Name}.Socket()
	f.record("launch.txt", scrub(f, fmt.Sprintf("server pid %d, socket %s\n", l.ServerPID, sock)))
	var thread string
	// Whatever happens below: archive the thread through the worker's own
	// server, send the worker home, compare the CODEX_HOME daemon.
	defer func() {
		if thread != "" {
			pane, err := f.h.CreateWorkspace(ctx, ws, "archive")
			if err == nil {
				f.shell(pane, "true")
				f.shell(pane, "codex archive "+thread+" --remote unix://"+sock)
				f.snap("archive", pane)
			}
		}
		raw := c.ack(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: w.id}, 2*time.Minute, nil)
		f.record("fire-ack.json", string(raw))
		pids := codexapp.MarkedPIDs(l.Token, "")
		f.record("after-send-home.txt", fmt.Sprintf("marked processes %v, files %v\n", pids, launchFiles(l)))
		if len(pids) != 0 || len(launchFiles(l)) != 0 {
			t.Errorf("send home left processes %v or files", pids)
		}
		after := realBaseline(codexHome)
		f.record("baseline-after.txt", after)
		if after != baseline {
			t.Errorf("the CODEX_HOME daemon or the config changed:\nbefore\n%s\nafter\n%s", baseline, after)
		}
	}()

	turns := 0
	idle := func(label string) {
		t.Helper()
		if a, err := f.h.AgentWait(ctx, w.pane, 3*time.Minute, "idle", "done"); err != nil {
			f.snap(label+"-failed", w.pane)
			t.Fatalf("%s: %v (%+v)", label, err, a)
		}
		c.settle(w)
		f.snap(label, w.pane)
	}
	turns++
	c.prompt("turn1-ask", w.id, "Use the request_user_input_async tool once, to ask me one question titled Pick a color, "+
		"with the options Red and Blue. Do not wait for my answer: as soon as the tool returns, reply with the single "+
		"word ASKED. When my answer arrives later, reply with the single word GOT followed by the color I picked.")
	idle("turn1-ask")
	v := c.attached("joined", w.id)
	thread = v.Thread
	var batch proto.CodexBatch
	for end := time.Now().Add(30 * time.Second); batch.Batch == "" && time.Now().Before(end); time.Sleep(250 * time.Millisecond) {
		if x, _ := c.worker(w.id); x.Codex != nil && len(x.Codex.Questions) > 0 {
			batch = x.Codex.Questions[0]
		}
	}
	c.view("after-turn1", w.id)
	if batch.Batch == "" || len(batch.Questions) == 0 {
		// The model did not ask: a normal turn with a command instead, and
		// the limitation is recorded.
		f.record("no-question.txt", "the model did not call request_user_input_async\n")
		turns++
		c.prompt("turn2-command", w.id, "Run the shell command echo h3d-bridge-smoke and reply with its output only.")
		idle("turn2-command")
		f.record("turns.txt", fmt.Sprintf("turns: %d\n", turns))
		t.Error("no async question to answer: recorded as a limitation")
		return
	}
	q := batch.Questions[0]
	answer := ""
	for _, o := range q.Options {
		if answer == "" || strings.EqualFold(o, "Red") {
			answer = o
		}
	}
	if answer == "" {
		answer = "Red"
	}
	turns++
	raw = c.answer(w.id, thread, batch.Batch, 0, answer)
	f.record("answer-ack.json", string(raw))
	if !isAck(raw) {
		t.Fatalf("answer: %s", raw)
	}
	c.waitQuestion("answered", w.id, batch.Batch, 0, 3*time.Minute, func(q proto.CodexQuestion) bool {
		return q.State == proto.AsyncAnswered
	})
	// The answer is "answered" once Codex records it, as its turn starts:
	// wait for that turn's end (the join's view), not only for herdr's idle,
	// which it may still show then. (#158's run archived the thread, so
	// interrupted that turn, 0.26 s after it started: the reply to the
	// answer is not in its evidence.)
	c.waitWorker("the answer's turn", w.id, 3*time.Minute, func(x proto.Worker) bool {
		return x.Codex != nil && x.Codex.Attached && x.Codex.Turn == ""
	})
	idle("tui-answered")
	if q := c.question(w.id, batch.Batch, 0); q.AnsweredBy != "bridge" {
		t.Errorf("answered_by %q", q.AnsweredBy)
	}

	// The thread as the model saw it: its rollout's user messages.
	matches, _ := filepath.Glob(filepath.Join(codex.DefaultSessionsDir(), "*", "*", "*", "rollout-*-"+thread+".jsonl"))
	if len(matches) != 1 {
		t.Fatalf("rollout of %s: %v", thread, matches)
	}
	answers, tokens := rolloutAnswers(t, matches[0], batch.Batch)
	f.record("model-visible.txt", fmt.Sprintf("turns: %d\nanswers to %s/0 among the rollout's user messages: %d\ntotal tokens (last token_count): %d\n",
		turns, batch.Batch, answers, tokens))
	if answers != 1 {
		t.Errorf("the model got %d answers, want 1", answers)
	}
}

// rolloutAnswers counts the user messages of a rollout that carry a reply
// envelope naming batch (what reached the model), and reads the thread's
// last total token count.
func rolloutAnswers(t *testing.T, path, batch string) (answers, tokens int) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var line struct {
			Type    string `json:"type"`
			Payload struct {
				Type string `json:"type"`
				Role string `json:"role"`
				Info *struct {
					Total struct {
						Tokens int `json:"total_tokens"`
					} `json:"total_token_usage"`
				} `json:"info"`
			} `json:"payload"`
		}
		if json.Unmarshal(sc.Bytes(), &line) != nil {
			continue
		}
		switch {
		case line.Type == "response_item" && line.Payload.Type == "message" && line.Payload.Role == "user":
			if s := sc.Text(); strings.Contains(s, "send_user_message_question_reply") && strings.Contains(s, `\\\"`+batch+`\\\"`) {
				answers++
			}
		case line.Payload.Type == "token_count" && line.Payload.Info != nil:
			tokens = line.Payload.Info.Total.Tokens
		}
	}
	return answers, tokens
}
