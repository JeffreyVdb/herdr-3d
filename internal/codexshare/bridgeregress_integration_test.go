//go:build integration

package codexshare

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// onePixelPNG is a valid 1×1 PNG.
const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

// requestShape is what a model request says of the thread's settings.
type requestShape struct {
	Model        string `json:"model"`
	Instructions string `json:"instructions"`
}

func shapeOf(body string) string {
	var s requestShape
	_ = json.Unmarshal([]byte(body), &s)
	sum := sha256.Sum256([]byte(s.Instructions))
	return fmt.Sprintf("model %s, instructions sha256 %s", s.Model, hex.EncodeToString(sum[:8]))
}

// TestCodexShareBridgeRegression (#158): a shared worker's normal terminal
// and transcript work through the bridge: typed prompts (also while an
// async question shows it blocked), a slash command, a skill, Ctrl+C, an
// image marker, settings untouched by the join, sleep and wake (the
// thread resumed attached, a pending question recovered), its server
// killed and recovered, and send home stopping its server.
func TestCodexShareBridgeRegression(t *testing.T) {
	f := newFx(t, fxOptions{noMCP: true}, "bare-a")
	f.installHerdrHook()
	b := f.startBridge(bridgeOptions{})
	c := b.dial("game")
	c.wait("the running floor", 30*time.Second, func() bool { return c.floor(f.h.Name).State == "running" })
	c.setShared(true)
	w := c.hire("w", "bare-a", 0)
	if w.res.Codex == nil || w.res.Codex.Mode != proto.CodexModeShared {
		t.Fatalf("hire with the switch on: %+v", w.res.Codex)
	}

	t.Run("9 a typed prompt, and the join changes no setting", func(t *testing.T) {
		res := c.prompt("9-typed", w.id, "MOCK:say typed-through-the-bridge")
		if res.Via != "" {
			t.Errorf("an idle worker's prompt went %q, want herdr's own", res.Via)
		}
		c.settle(w)
		before := f.lastModelRequest()
		models := f.mock.ModelRequests()
		v := c.attached("9-joined", w.id)
		time.Sleep(3 * time.Second)
		if n := f.mock.ModelRequests(); n != models {
			t.Errorf("the bridge's join made %d model requests", n-models)
		}
		c.prompt("9-after-join", w.id, "MOCK:say after-the-join")
		c.settle(w)
		after := f.lastModelRequest()
		f.record("9-settings.txt", fmt.Sprintf("thread %s\nbefore the join: %s\nafter the join:  %s\ncwd in both: %v\n", v.Thread,
			shapeOf(before), shapeOf(after), strings.Contains(before, w.cwd) && strings.Contains(after, w.cwd)))
		if shapeOf(before) != shapeOf(after) || !strings.Contains(after, w.cwd) {
			t.Errorf("the thread's settings changed after the join")
		}
		f.snap("9-tui-typed", w.pane)
	})

	t.Run("9 a prompt while an async question shows the worker blocked is steered", func(t *testing.T) {
		before := len(f.mock.Requests())
		c.prompt("9b-ask", w.id, "MOCK:ask-options hold=b1")
		f.held("b1")
		c.waitWorker("9b-blocked", w.id, 30*time.Second, func(w proto.Worker) bool {
			return w.Status == "blocked" && w.Codex != nil && w.Codex.AsyncBlocked
		})
		c.view("9b-blocked-view", w.id)
		res := c.prompt("9b-steered", w.id, "MOCK:say steered-while-blocked")
		if res.Via != "app_server" || !res.Queued {
			t.Errorf("a prompt to a worker an async question blocks: %+v, want queued via app_server", res)
		}
		f.mock.HoldNext(KindTurn, "b1-next")
		if err := f.mock.Release("b1"); err != nil {
			t.Fatal(err)
		}
		f.held("b1-next")
		got := f.mock.Requests()[len(f.mock.Requests())-1]
		_ = f.mock.Release("b1-next")
		c.settle(w)
		f.recordJSON("9b-mock-requests", summarize(f.mock.Requests()[before:]))
		if !strings.Contains(got.UserText, "steered-while-blocked") {
			t.Errorf("the model's next request after the steer: %q", got.UserText)
		}
		f.snap("9b-tui", w.pane)
	})

	t.Run("9 a slash command and a skill", func(t *testing.T) {
		models := f.mock.ModelRequests()
		res := c.prompt("9c-status", w.id, "/status")
		if !res.Terminal {
			t.Errorf("/status ack %+v, want terminal (its output shows only there)", res)
		}
		screen := f.waitScreen("9c-tui-status", w.pane, 15*time.Second, func(s string) bool { return strings.Contains(s, "unix://") })
		if !strings.Contains(screen, filepath.Base(w.cwd)) || f.mock.ModelRequests() != models {
			t.Errorf("/status: %+v, %d model requests", res, f.mock.ModelRequests()-models)
		}
		c.keys(w.id, "esc")
		time.Sleep(500 * time.Millisecond)
		c.prompt("9c-skill", w.id, "$h3d-fixture MOCK:say skill-ran")
		c.settle(w)
		if body := f.lastModelRequest(); !strings.Contains(body, "H3D_SKILL_BODY") {
			t.Error("the skill's SKILL.md did not reach the model")
		}
		f.snap("9c-tui-skill", w.pane)
	})

	t.Run("9 Ctrl+C from the game's terminal interrupts a turn", func(t *testing.T) {
		c.prompt("9d-hold", w.id, "MOCK:hold c1")
		f.held("c1")
		c.waitWorker("9d-working", w.id, 15*time.Second, func(w proto.Worker) bool { return w.Status == "working" })
		c.keys(w.id, "ctrl+c")
		f.waitScreen("9d-tui-interrupted", w.pane, 15*time.Second, func(s string) bool { return strings.Contains(s, "Conversation interrupted") })
		_ = f.mock.Release("c1")
		c.settle(w)
		c.waitWorker("9d-idle", w.id, 15*time.Second, func(w proto.Worker) bool { return w.Status == "idle" || w.Status == "done" })
	})

	t.Run("9 an approval: hire's arguments never ask", func(t *testing.T) {
		// Hire starts every Codex worker with the bypass flag (approval
		// policy never): an escalation is refused by Codex itself, and no
		// approval ever reaches the terminal or the bridge.
		c.prompt("9e-approve", w.id, "MOCK:approve touch approved-without-asking.txt")
		c.settle(w)
		screen := f.snap("9e-tui", w.pane)
		if strings.Contains(screen, "Would you like to run") || !strings.Contains(screen, "approval policy is Never") {
			t.Errorf("an escalation on a hired worker asked or was not refused")
		}
		if argv := f.argv(b.ctl, w.pane); !slices.Contains(argv, "--dangerously-bypass-approvals-and-sandbox") {
			t.Errorf("the hired TUI's argv %q", argv)
		}
	})

	t.Run("9 an image marker, typed and steered", func(t *testing.T) {
		img := filepath.Join(f.root, "img", "h3d-transcript-w-1.png")
		raw, _ := base64.StdEncoding.DecodeString(onePixelPNG)
		if err := os.MkdirAll(filepath.Dir(img), 0o755); err != nil {
			t.Fatal(err)
		}
		f.write(img, string(raw), 0o644)
		marker := "[Image #1: " + img + "]"
		if res := c.prompt("9f-typed", w.id, marker+" MOCK:say image-typed"); res.Sent != "" {
			t.Errorf("the prompt was rewritten: %q", res.Sent)
		}
		c.settle(w)
		typed := f.lastModelRequest()
		f.snap("9f-tui-typed", w.pane)

		c.prompt("9f-ask", w.id, "MOCK:ask-free hold=i1")
		f.held("i1")
		c.waitWorker("9f-blocked", w.id, 30*time.Second, func(w proto.Worker) bool {
			return w.Status == "blocked" && w.Codex != nil && w.Codex.AsyncBlocked
		})
		res := c.prompt("9f-steered", w.id, marker+" MOCK:say image-steered")
		f.mock.HoldNext(KindTurn, "i1-next")
		_ = f.mock.Release("i1")
		f.held("i1-next")
		steered := string(f.mock.Requests()[len(f.mock.Requests())-1].Body)
		_ = f.mock.Release("i1-next")
		c.settle(w)
		f.snap("9f-tui-steered", w.pane)
		f.record("9f-image.txt", fmt.Sprintf("marker %s\ntyped (herdr):   input_image %v, path in the text %v\nsteered (%s): input_image %v, path in the text %v\n",
			scrub(f, marker), strings.Contains(typed, "input_image"), strings.Contains(typed, img),
			res.Via, strings.Contains(steered, "input_image"), strings.Contains(steered, img)))
		if !strings.Contains(typed, img) || !strings.Contains(steered, img) || res.Via != "app_server" {
			t.Errorf("the image's path did not reach the model on both paths")
		}
	})

	t.Run("9 the transcript subscription: the same conversation, no turn, the image marker as an image", func(t *testing.T) {
		models := f.mock.ModelRequests()
		v := c.view("9g-before-watch", w.id)
		var tr proto.TranscriptWatchResult
		raw := c.ack(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: w.id, Limit: 200}, 30*time.Second, &tr)
		var lines []string
		images := 0
		for _, it := range tr.Items {
			text := ""
			for _, p := range it.Parts {
				if p.Image != nil {
					images++
					text += fmt.Sprintf("[image origin %s unavailable %v] ", p.Image.Origin, p.Image.Unavailable)
				}
				text += p.Text
			}
			if !it.Hidden && (it.Kind == proto.ItemUser || it.Kind == proto.ItemAssistant) {
				lines = append(lines, it.Kind+": "+oneLine(text, 120))
			}
		}
		f.record("9g-transcript.txt", scrub(f, fmt.Sprintf("head: harness %s session %s pending %v (thread %s)\n%s\n",
			tr.Harness, tr.Session, tr.Pending, v.Thread, strings.Join(lines, "\n"))))
		_ = raw
		time.Sleep(2 * time.Second)
		after := c.view("9g-after-watch", w.id)
		joined := strings.Join(lines, "\n")
		if tr.Harness != "codex" || tr.Session != v.Thread || !strings.Contains(joined, "typed-through-the-bridge") ||
			!strings.Contains(joined, "steered-while-blocked") || images == 0 {
			t.Errorf("the transcript is not the worker's conversation (or lost the image marker)")
		}
		if n := f.mock.ModelRequests(); n != models || !after.Attached || after.Thread != v.Thread {
			t.Errorf("opening the transcript: %d model requests, attached %v", n-models, after.Attached)
		}
		c.ack(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: w.id}, 10*time.Second, nil)
	})

	var pending proto.CodexBatch
	t.Run("10 sleep and wake: the thread resumes attached, a pending question recovered", func(t *testing.T) {
		seen := batchIDs(c, w.id, 1)
		c.prompt("10-ask", w.id, "MOCK:ask-free")
		c.settle(w)
		pending = c.batchWith("10-pending", w.id, 1, seen...)
		before := c.view("10-before-sleep", w.id)
		l, _ := b.launchOf(w.id)
		c.ack(proto.CmdFloorSleep, proto.FloorArgs{Session: f.h.Name}, 3*time.Minute, nil)
		c.wait("the floor asleep", 60*time.Second, func() bool { return c.floor(f.h.Name).State == "asleep" })
		asleep := c.view("10-asleep", w.id)
		pids := codexapp.MarkedPIDs(l.Token, "")
		files := launchFiles(l)
		f.record("10-asleep.txt", fmt.Sprintf("server %s, marked processes %v, files %v\n", asleep.Server, pids, files))
		if asleep.Server != proto.CodexServerStopped || len(pids) != 0 || len(files) != 0 {
			t.Errorf("asleep: server %s, processes %v, files %v", asleep.Server, pids, files)
		}
		saved, _ := os.ReadFile(filepath.Join(f.sessionDir(), "session.json"))
		if strings.Contains(string(saved), before.Thread) {
			t.Errorf("herdr saved the thread: it would resume it its own way")
		}

		var woke proto.WakeResult
		raw := c.ack(proto.CmdFloorWake, proto.FloorArgs{Session: f.h.Name}, 3*time.Minute, &woke)
		f.record("10-wake-ack.json", string(raw))
		after := c.attached("10-woken-attached", w.id)
		argv := f.argv(b.ctl, w.pane)
		f.record("10-resumed-argv.txt", scrub(f, strings.Join(argv, " "))+"\n")
		if after.Thread != before.Thread || after.Server != proto.CodexServerRunning ||
			!containsRun(argv, "resume", before.Thread, "--remote") || slices.Contains(argv, "--dangerously-bypass-approvals-and-sandbox") {
			t.Errorf("woken: thread %s server %s argv %q", after.Thread, after.Server, argv)
		}
		if q := c.question(w.id, pending.Batch, 0); q.State != proto.AsyncPending {
			t.Errorf("the pending question came back %s", q.State)
		}
		f.snap("10-tui-resumed", w.pane)
		reqs := len(f.mock.Requests())
		raw = c.answer(w.id, after.Thread, pending.Batch, 0, "answered-after-the-wake")
		f.record("10-answer-ack.json", string(raw))
		c.waitQuestion("10-answered", w.id, pending.Batch, 0, 30*time.Second, func(q proto.CodexQuestion) bool {
			return q.State == proto.AsyncAnswered
		})
		if n := len(f.repliesSince(reqs, 1)); n != 1 {
			t.Errorf("%d reply requests, want 1", n)
		}
		c.settle(w)
		f.snap("10-tui-answered", w.pane)
	})

	t.Run("11 the server killed: reported down, recovered by sleep and wake", func(t *testing.T) {
		l, _ := b.launchOf(w.id)
		if l.ServerPID <= 0 {
			t.Fatal("no server recorded")
		}
		if err := syscall.Kill(l.ServerPID, syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		down := c.waitWorker("11-down", w.id, 30*time.Second, func(w proto.Worker) bool {
			return w.Codex != nil && w.Codex.Server == proto.CodexServerDown
		})
		c.view("11-down-view", w.id)
		f.record("11-herdr-status.txt", "herdr status with the server down: "+down.Status+"\n")
		f.snap("11-tui-server-down", w.pane)
		audited := b.audit("11-audit-before", 0)
		raw := c.ack(proto.CmdFloorSleep, proto.FloorArgs{Session: f.h.Name}, 3*time.Minute, nil)
		f.record("11-sleep-ack.json", string(raw))
		c.wait("the floor asleep", 60*time.Second, func() bool { return c.floor(f.h.Name).State == "asleep" })
		c.view("11-asleep", w.id)
		raw = c.ack(proto.CmdFloorWake, proto.FloorArgs{Session: f.h.Name}, 3*time.Minute, nil)
		f.record("11-wake-ack.json", string(raw))
		b.audit("11-audit", audited, proto.CmdFloorSleep, proto.CmdFloorWake)
		c.view("11-woken", w.id)
		f.snap("11-tui-woken", w.pane)
		after := c.attached("11-recovered", w.id)
		if after.Server != proto.CodexServerRunning {
			t.Errorf("after the wake: server %s", after.Server)
		}
		c.prompt("11-turn", w.id, "MOCK:say after-recovery")
		c.settle(w)
		f.snap("11-tui-recovered", w.pane)
	})

	t.Run("12 send home stops the server and cleans its files", func(t *testing.T) {
		l, _ := b.launchOf(w.id)
		var fired proto.FireResult
		raw := c.ack(proto.CmdWorkerFire, proto.WorkerFireArgs{ID: w.id}, 2*time.Minute, &fired)
		f.record("12-fire-ack.json", string(raw))
		c.wait("the worker gone", 30*time.Second, func() bool { _, ok := c.worker(w.id); return !ok })
		pids := codexapp.MarkedPIDs(l.Token, "")
		files := launchFiles(l)
		_, kept := b.launchOf(w.id)
		f.record("12-after-send-home.txt", fmt.Sprintf("marked processes %v, files %v, launch record kept %v\n", pids, files, kept))
		if len(pids) != 0 || len(files) != 0 || kept {
			t.Errorf("after send home: processes %v, files %v, record %v", pids, files, kept)
		}
		f.record("bridge-events.txt", strings.Join(c.eventLog(), "\n")+"\n")
		f.recordJSON("mock-requests", summarize(f.mock.Requests()))
	})
}

// batchIDs lists the worker's batches of n questions.
func batchIDs(c *bclient, id string, n int) []string {
	w, _ := c.worker(id)
	var out []string
	if w.Codex != nil {
		for _, b := range w.Codex.Questions {
			if len(b.Questions) == n {
				out = append(out, b.Batch)
			}
		}
	}
	return out
}

// containsRun reports whether run appears in argv in order.
func containsRun(argv []string, run ...string) bool {
	for i := 0; i+len(run) <= len(argv); i++ {
		if slices.Equal(argv[i:i+len(run)], run) {
			return true
		}
	}
	return false
}
