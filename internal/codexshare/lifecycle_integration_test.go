//go:build integration

package codexshare

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// settings is the part of a thread/resume response that must survive a join.
type settings struct {
	Model          string          `json:"model"`
	ModelProvider  string          `json:"modelProvider"`
	Cwd            string          `json:"cwd"`
	ApprovalPolicy json.RawMessage `json:"approvalPolicy"`
	Sandbox        json.RawMessage `json:"sandbox"`
	Instructions   json.RawMessage `json:"instructionSources"`
}

func asSettings(res map[string]any) settings {
	b, _ := json.Marshal(res)
	var s settings
	_ = json.Unmarshal(b, &s)
	return s
}

// lastModelRequest is the newest non-title request body as text.
func (f *fx) lastModelRequest() string {
	reqs := f.mock.Requests()
	for i := len(reqs) - 1; i >= 0; i-- {
		if reqs[i].Kind != KindTitle {
			return string(reqs[i].Body)
		}
	}
	return ""
}

// TestCodexShareLifecycle: joining keeps the thread's settings and starts no
// model turn; typing, slash commands, skills and Ctrl+C keep working; the
// bridge disconnecting, reconnecting, the TUI closing and reopening, the
// 60 s unload, the server restarting and the worker stopping.
func TestCodexShareLifecycle(t *testing.T) {
	f := newFx(t, fxOptions{top: `developer_instructions = "H3D_DEV_INSTRUCTIONS stay"`}, "ws-a")
	w := f.sharedWorker("ws-a", "worker")
	c, th := w.bridge, w.thread.ID
	ws := filepath.Join(f.root, "ws-a")

	var questionID string
	t.Run("join keeps settings and starts no turn", func(t *testing.T) {
		f.mark(c)
		f.prompt(w.name, "MOCK:ask-options")
		questionID = f.questionItem(c, QuestionColor).Item.ID
		f.settle(w.name)
		models := f.mock.ModelRequests()
		first := f.resume(c, th)
		// A third client asks for other settings while the TUI and the
		// bridge are subscribed: the loaded settings must win.
		other := f.client(w.sock, "h3d-other")
		var res map[string]any
		err := other.Call(f.ctx, "thread/resume", map[string]any{
			"threadId": th, "model": "gpt-other", "cwd": f.root, "approvalPolicy": "untrusted",
			"sandbox": "read-only", "developerInstructions": "H3D_OVERRIDE_INSTRUCTIONS",
		}, &res)
		if err != nil {
			t.Fatal(err)
		}
		f.recordJSON("join-settings", map[string]any{"bridge": asSettings(first), "conflicting-join": asSettings(res)})
		got, want := asSettings(res), asSettings(first)
		if got.Model != "mock" || got.Cwd != ws || string(got.ApprovalPolicy) != string(want.ApprovalPolicy) ||
			string(got.Sandbox) != string(want.Sandbox) || string(got.Instructions) != string(want.Instructions) {
			t.Errorf("a conflicting join changed settings: %+v vs %+v", got, want)
		}
		time.Sleep(2 * time.Second)
		if n := f.mock.ModelRequests(); n != models {
			t.Errorf("joining made %d model requests", n-models)
		}
		other.Close()
		f.prompt(w.name, "MOCK:say after-joins")
		body := f.lastModelRequest()
		if !strings.Contains(body, "H3D_DEV_INSTRUCTIONS stay") || strings.Contains(body, "H3D_OVERRIDE_INSTRUCTIONS") || !strings.Contains(body, `"model":"mock"`) {
			t.Errorf("the next model request lost the thread's instructions or model")
		}
	})

	t.Run("bridge sees terminal turns and the terminal sees bridge turns", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		f.prompt(w.name, "MOCK:say typed-in-terminal")
		f.waitItem(c, 30*time.Second, func(e itemEvent) bool { return e.Item.Text == "typed-in-terminal" })
		turn := f.startTurn(c, th, "MOCK:say sent-by-bridge")
		f.waitTurnCompleted(c, turn, 60*time.Second)
		f.waitScreen("bridge-turn-in-terminal", w.tui, 10*time.Second, func(s string) bool {
			return strings.Contains(s, "› MOCK:say sent-by-bridge") && strings.Contains(s, "• sent-by-bridge")
		})
	})

	t.Run("slash command and skill", func(t *testing.T) {
		f.settle(w.name)
		models := f.mock.ModelRequests()
		if _, err := f.h.AgentPrompt(f.ctx, w.name, "/status", 0); err != nil {
			t.Fatal(err)
		}
		screen := f.waitScreen("slash-status", w.tui, 10*time.Second, func(s string) bool { return strings.Contains(s, th) })
		if !strings.Contains(screen, "unix://"+w.sock) {
			t.Errorf("/status does not name the shared server")
		}
		if f.mock.ModelRequests() != models {
			t.Errorf("/status made a model request")
		}
		_ = f.h.SendKeys(f.ctx, w.tui, "esc")
		f.settle(w.name)
		f.prompt(w.name, "$h3d-fixture MOCK:say skill-turn")
		f.snap("skill-turn", w.tui)
		if body := f.lastModelRequest(); !strings.Contains(body, "H3D_SKILL_BODY") {
			t.Errorf("the skill's body did not reach the model")
		}
	})

	t.Run("ctrl+c interrupts a turn", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		f.promptWorking(w.name, "MOCK:hold ctrlc")
		f.held("ctrlc")
		if err := f.h.SendKeys(f.ctx, w.tui, "ctrl+c"); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := f.within(30 * time.Second)
		defer cancel()
		m, err := c.WaitNotificationFrom(ctx, f.marks[c], "turn/completed", nil)
		if err != nil {
			t.Fatal(err)
		}
		f.record("ctrlc-turn-completed.json", string(m.Params))
		if !strings.Contains(string(m.Params), `"status":"interrupted"`) {
			t.Errorf("turn after ctrl+c: %s", m.Params)
		}
		a, err := f.h.AgentWait(f.ctx, w.name, 20*time.Second, "idle", "done")
		f.recordJSON("ctrlc-herdr-state", a)
		if err != nil {
			t.Error(err)
		}
		f.snap("ctrlc", w.tui)
		_ = f.mock.Release("ctrlc")
	})

	t.Run("bridge disconnect leaves the terminal usable; reconnect finds the thread", func(t *testing.T) {
		f.settle(w.name)
		// Disconnect during an active turn.
		f.promptWorking(w.name, "MOCK:hold disconnect")
		f.held("disconnect")
		c.Close()
		_ = f.mock.Release("disconnect")
		f.settle(w.name)
		f.prompt(w.name, "MOCK:say after-bridge-left")
		f.waitScreen("terminal-after-bridge-left", w.tui, 10*time.Second, func(s string) bool { return strings.Contains(s, "• after-bridge-left") })

		c = f.client(w.sock, "h3d-bridge-2")
		got := f.tuiThread(c)
		if got.ID != th {
			t.Fatalf("reconnect found thread %s, want %s", got.ID, th)
		}
		res := f.resume(c, th)
		b, _ := json.Marshal(res)
		if !strings.Contains(string(b), "after-bridge-left") || !strings.Contains(string(b), `"id":"`+questionID+`"`) {
			t.Errorf("rejoined history lacks the latest turn or the live question id %s", questionID)
		}
		f.mark(c)
		f.prompt(w.name, "MOCK:say seen-by-new-bridge")
		f.waitItem(c, 30*time.Second, func(e itemEvent) bool { return e.Item.Text == "seen-by-new-bridge" })
	})

	t.Run("closing the TUI keeps the thread for the bridge; resume reopens it", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		f.exitTUI(w.tui)
		if !contains(f.loaded(c), th) {
			t.Fatal("thread unloaded although the bridge is subscribed")
		}
		turn := f.startTurn(c, th, "MOCK:say while-tui-closed")
		f.waitTurnCompleted(c, turn, 60*time.Second)
		f.startTUI(w.name, w.tui, "resume", th, "--remote", "unix://"+w.sock, "-C", ws)
		f.waitScreen("tui-resumed", w.tui, 20*time.Second, func(s string) bool { return strings.Contains(s, "while-tui-closed") })
		f.prompt(w.name, "MOCK:say after-resume")
		f.waitItem(c, 30*time.Second, func(e itemEvent) bool { return e.Item.Text == "after-resume" })
	})

	t.Run("unload after 60 s without subscribers, cold resume", func(t *testing.T) {
		f.settle(w.name)
		f.exitTUI(w.tui)
		var un struct {
			Status string `json:"status"`
		}
		if err := c.Call(f.ctx, "thread/unsubscribe", map[string]any{"threadId": th}, &un); err != nil {
			t.Fatal(err)
		}
		f.record("unsubscribe.txt", un.Status+"\n")
		time.Sleep(30 * time.Second)
		if !contains(f.loaded(c), th) {
			t.Errorf("unloaded before 60 s")
		}
		deadline := time.Now().Add(60 * time.Second)
		for contains(f.loaded(c), th) && time.Now().Before(deadline) {
			time.Sleep(2 * time.Second)
		}
		if contains(f.loaded(c), th) {
			t.Fatal("still loaded 90 s after the last subscriber left")
		}
		models := f.mock.ModelRequests()
		res := f.resume(c, th)
		f.recordJSON("cold-resume", res)
		b, _ := json.Marshal(res)
		f.record("cold-resume-question-id.txt", "live id "+questionID+"; present in cold resume: "+boolText(strings.Contains(string(b), `"id":"`+questionID+`"`))+"\n")
		if f.mock.ModelRequests() != models {
			t.Errorf("cold resume made a model request")
		}
		f.startTUI(w.name, w.tui, "resume", th, "--remote", "unix://"+w.sock, "-C", ws)
		f.prompt(w.name, "MOCK:say after-cold-resume")
		f.snap("after-cold-resume", w.tui)
	})

	t.Run("server restart and worker stop", func(t *testing.T) {
		f.settle(w.name)
		pid := f.serverPID(w.sock)
		_ = syscall.Kill(pid, syscall.SIGTERM)
		time.Sleep(3 * time.Second)
		f.snap("tui-after-server-killed", w.tui)
		a, _, _ := f.h.AgentGet(f.ctx, w.name)
		f.recordJSON("herdr-after-server-killed", a)
		info, _ := f.h.ProcessInfo(f.ctx, w.tui)
		f.recordJSON("tui-pane-processes-after-server-killed", info)

		// Restart from the same initialized shell, resume the thread.
		_ = os.Remove(w.sock)
		f.startServer(w.server, "srv-"+w.name)
		if len(info.Foreground) > 0 && info.Foreground[0].Name == "codex" {
			f.exitTUI(w.tui)
		}
		f.startTUI(w.name, w.tui, "resume", th, "--remote", "unix://"+w.sock, "-C", ws)
		f.prompt(w.name, "MOCK:say after-server-restart")
		f.snap("after-server-restart", w.tui)

		// Stopping the worker's Herdr workspaces does not stop a detached server.
		pid = f.serverPID(w.sock)
		f.exitTUI(w.tui)
		if _, err := f.h.Run(f.ctx, "pane", "close", w.server); err != nil {
			t.Logf("pane close: %v", err)
		}
		time.Sleep(2 * time.Second)
		alive := syscall.Kill(pid, 0) == nil
		f.record("server-after-panes-closed.txt", "detached app-server alive after its pane closed: "+boolText(alive)+"\n")
	})
}

// exitTUI quits the Codex TUI in pane (idle Ctrl+C twice) and waits for the shell.
func (f *fx) exitTUI(pane string) {
	f.t.Helper()
	for range 3 {
		info, err := f.h.ProcessInfo(f.ctx, pane)
		if err == nil && (len(info.Foreground) == 0 || info.Foreground[0].Name != "codex") {
			return
		}
		_ = f.h.SendKeys(f.ctx, pane, "ctrl+c")
		time.Sleep(300 * time.Millisecond)
		_ = f.h.SendKeys(f.ctx, pane, "ctrl+c")
		time.Sleep(2 * time.Second)
	}
	f.snap("tui-would-not-exit", pane)
	f.t.Fatal("the TUI did not exit")
}

func contains(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func boolText(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}
