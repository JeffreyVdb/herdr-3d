//go:build integration

package codexshare

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCodexShareApprovals: a command approval goes to every subscribed
// client; a passive bridge leaves it to the terminal, and the first answer
// wins when the bridge does answer.
func TestCodexShareApprovals(t *testing.T) {
	f := newFx(t, fxOptions{approval: "on-request", sandbox: "workspace-write"}, "ws-a")
	w := f.sharedWorker("ws-a", "worker")
	c := w.bridge
	ws := filepath.Join(f.root, "ws-a")

	t.Run("passive bridge, the terminal approves", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		before := len(c.ServerRequests(""))
		if _, err := f.h.AgentPrompt(f.ctx, w.name, "MOCK:approve touch approved-by-terminal.txt", 60*time.Second, "blocked"); err != nil {
			t.Fatalf("herdr never saw the approval as blocked: %v", err)
		}
		ctx, cancel := f.within(30 * time.Second)
		defer cancel()
		req, err := c.WaitServerRequest(ctx, "item/commandExecution/requestApproval")
		if err != nil || len(c.ServerRequests("")) <= before {
			t.Fatalf("the bridge got no approval request: %v", err)
		}
		f.record("approval-request-to-bridge.json", string(req.Params))
		f.snap("approval-modal", w.tui)
		if err := f.h.SendKeys(f.ctx, w.tui, "y"); err != nil {
			t.Fatal(err)
		}
		m, err := c.WaitNotificationFrom(ctx, f.marks[c], "serverRequest/resolved", nil)
		if err != nil {
			t.Fatalf("no serverRequest/resolved for the bridge: %v", err)
		}
		f.record("approval-resolved.json", string(m.Params))
		f.settle(w.name)
		f.snap("approval-done", w.tui)
		if _, err := os.Stat(filepath.Join(ws, "approved-by-terminal.txt")); err != nil {
			t.Errorf("the approved command did not run: %v", err)
		}
	})

	t.Run("the bridge answers first", func(t *testing.T) {
		f.settle(w.name)
		f.mark(c)
		n := len(c.ServerRequests("item/commandExecution/requestApproval"))
		if _, err := f.h.AgentPrompt(f.ctx, w.name, "MOCK:approve touch approved-by-bridge.txt", 60*time.Second, "blocked"); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(30 * time.Second)
		for len(c.ServerRequests("item/commandExecution/requestApproval")) <= n && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
		reqs := c.ServerRequests("item/commandExecution/requestApproval")
		if len(reqs) <= n {
			t.Fatal("no second approval request")
		}
		f.snap("bridge-approval-modal", w.tui)
		if err := c.Respond(f.ctx, reqs[len(reqs)-1].ID, map[string]any{"decision": "accept"}); err != nil {
			t.Fatal(err)
		}
		f.settle(w.name)
		screen := f.snap("bridge-approval-done", w.tui)
		if _, err := os.Stat(filepath.Join(ws, "approved-by-bridge.txt")); err != nil {
			t.Errorf("the bridge's approval did not run the command: %v", err)
		}
		if strings.Contains(screen, "Would you like to run") {
			t.Errorf("the TUI still shows the approval after the bridge answered")
		}
	})
}
