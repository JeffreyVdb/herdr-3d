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

// orchestrateScript is the Codex orchestrator's tool for the reverse
// direction: Herdr CLI calls from the model's shell (no inference needed).
// It creates a worker workspace, has the stand-in worker publish a report
// and prints it with the orchestrator's own Herdr context.
const orchestrateScript = `#!/bin/sh
set -e
out=$(herdr workspace create --cwd "$1" --label reverse-worker --no-focus)
pane=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
sleep 1
herdr pane run "$pane" "printf '{\"worker\":\"stand-in\",\"pane\":\"%s\"}' \$HERDR_PANE_ID > $2"
for i in 1 2 3 4 5 6 7 8 9 10; do test -s "$2" && break; sleep 0.5; done
printf 'ORCH report=%s orchestrator-pane=%s\n' "$(cat "$2")" "$HERDR_PANE_ID"
`

// TestCodexShareMixedHarness: a scripted stand-in for a Claude orchestrator
// drives a Codex worker on a worker-owned server only through the Herdr CLI
// and a run directory, as write-code does: dispatch, report file, follow-up,
// read/wait, stop and resume with identity and environment intact (warm:
// the same server; cold: a new one). Then the
// reverse: the Codex worker orchestrates through Herdr from its model shell.
func TestCodexShareMixedHarness(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a", "ws-b")
	f.installHerdrHook()
	f.write(filepath.Join(f.root, "bin", "h3d-orchestrate"), orchestrateScript, 0o755)
	run := filepath.Join(f.root, "run")
	if err := os.MkdirAll(run, 0o755); err != nil {
		t.Fatal(err)
	}
	ws := filepath.Join(f.root, "ws-a")
	report := filepath.Join(run, "worker.json")
	resumed := filepath.Join(run, "worker-resumed.json")
	cold := filepath.Join(run, "worker-cold-resumed.json")
	// The worker's report: written to a temp name, then renamed into place.
	const reportCmd = `printf '{"status":"done","direnv":"%s","pane":"%s","herdr_pane":"%s"}' "$H3D_DIRENV_SENTINEL" "$H3D_PANE_SENTINEL" "$HERDR_PANE_ID" > REPORT.tmp && mv REPORT.tmp REPORT`

	// The orchestrator's launch: one worker pane, server and TUI in it.
	pane := f.pane("ws-a")
	sock := f.startServer(pane, "mixed")
	f.startTUI("codexworker", pane, "--remote", "unix://"+sock, "-C", ws)
	f.trustHooks("mixed", "codexworker", pane)

	var session string
	t.Run("dispatch, report, follow-up, read and wait", func(t *testing.T) {
		if _, err := f.h.AgentPrompt(f.ctx, "codexworker", "Do the task and publish your report. MOCK:shell "+strings.ReplaceAll(reportCmd, "REPORT", report), 0); err != nil {
			t.Fatal(err)
		}
		got := waitReport(t, report)
		f.record("worker-report.json", string(got))
		var r map[string]string
		_ = json.Unmarshal(got, &r)
		if r["direnv"] != "direnv-ws-a" || r["herdr_pane"] != pane {
			t.Errorf("worker report %v", r)
		}
		if _, err := f.h.AgentWait(f.ctx, "codexworker", 60*time.Second, "idle", "done"); err != nil {
			t.Fatal(err)
		}
		f.prompt("codexworker", "MOCK:say follow-up-acknowledged")
		out, err := f.h.Run(f.ctx, "agent", "read", "codexworker", "--source", "visible")
		if err != nil || !strings.Contains(string(out), "follow-up-acknowledged") {
			t.Errorf("agent read: %v\n%s", err, out)
		}
		f.record("agent-read.txt", string(out))
		a, raw, _ := f.h.AgentGet(f.ctx, "codexworker")
		f.record("agent-get.json", string(raw))
		if a.Session != nil {
			session = a.Session.Value
		}
		if session == "" {
			t.Fatal("Herdr has no session id for the worker")
		}
	})

	t.Run("stop and resume keep identity and environment", func(t *testing.T) {
		if session == "" {
			t.Skip("no session id")
		}
		f.exitTUI(pane)
		// What a resume needs: the same server, the session id from Herdr,
		// and --remote (which Herdr's own resume drops).
		f.startTUI("codexworker", pane, "resume", session, "--remote", "unix://"+sock, "-C", ws)
		f.snap("resumed", pane)
		if _, err := f.h.AgentPrompt(f.ctx, "codexworker", "MOCK:shell "+strings.ReplaceAll(reportCmd, "REPORT", resumed), 0); err != nil {
			t.Fatal(err)
		}
		got := waitReport(t, resumed)
		f.record("worker-report-after-resume.json", string(got))
		if !strings.Contains(string(got), `"direnv":"direnv-ws-a"`) || !strings.Contains(string(got), `"herdr_pane":"`+pane+`"`) {
			t.Errorf("environment after resume: %s", got)
		}
		// Known upstream gap (#186, findings §13 and §14): codex 0.161 and
		// 0.162 run no SessionStart hook when a TUI re-attaches to a server
		// that still has its thread loaded (0.160 runs it, source "resume",
		// at the first prompt), so Herdr's hook never reports the id again.
		// Kept as observed so a fix fails here and this check is made strict.
		_, raw, _ := f.h.AgentGet(f.ctx, "codexworker")
		kept := strings.Contains(string(raw), session)
		warmGap := strings.HasPrefix(f.codex, "codex-cli 0.161.") || strings.HasPrefix(f.codex, "codex-cli 0.162.")
		if !warmGap && !kept {
			t.Errorf("Herdr lost the session id after resume: %s", raw)
		} else if warmGap && kept {
			t.Errorf("%s: Herdr has the session id after a warm re-attach: the upstream gap (no SessionStart on warm resume) "+
				"looks fixed; make this check strict for that line and update findings §13/§14: %s", f.codex, raw)
		}
		c := f.client(sock, "h3d-mixed")
		if th := f.tuiThread(c); th.ID != session {
			t.Errorf("resumed thread %s, want %s", th.ID, session)
		}
	})

	// A cold resume (a new server, as a floor's wake does) reports the
	// identity on every verified Codex.
	t.Run("a cold resume on a new server keeps identity and environment", func(t *testing.T) {
		if session == "" {
			t.Skip("no session id")
		}
		f.exitTUI(pane)
		_ = syscall.Kill(f.serverPID(sock), syscall.SIGTERM)
		deadline := time.Now().Add(10 * time.Second)
		for len(f.owned("app-server --listen unix://"+sock)) > 0 && time.Now().Before(deadline) {
			time.Sleep(200 * time.Millisecond)
		}
		_ = os.Remove(sock)
		sock = f.startServer(pane, "mixed-cold")
		f.startTUI("codexworker", pane, "resume", session, "--remote", "unix://"+sock, "-C", ws)
		f.snap("cold-resumed", pane)
		if _, err := f.h.AgentPrompt(f.ctx, "codexworker", "MOCK:shell "+strings.ReplaceAll(reportCmd, "REPORT", cold), 0); err != nil {
			t.Fatal(err)
		}
		got := waitReport(t, cold)
		f.record("worker-report-after-cold-resume.json", string(got))
		if !strings.Contains(string(got), `"direnv":"direnv-ws-a"`) || !strings.Contains(string(got), `"herdr_pane":"`+pane+`"`) {
			t.Errorf("environment after the cold resume: %s", got)
		}
		_, raw, _ := f.h.AgentGet(f.ctx, "codexworker")
		f.record("agent-get-after-cold-resume.json", string(raw))
		if !strings.Contains(string(raw), session) {
			t.Errorf("Herdr lost the session id after a cold resume: %s", raw)
		}
		c := f.client(sock, "h3d-mixed-cold")
		if th := f.tuiThread(c); th.ID != session {
			t.Errorf("cold-resumed thread %s, want %s", th.ID, session)
		}
	})

	t.Run("reverse: the Codex worker orchestrates through Herdr", func(t *testing.T) {
		f.settle("codexworker")
		n := len(f.mock.Requests())
		f.prompt("codexworker", "MOCK:shell h3d-orchestrate "+filepath.Join(f.root, "ws-b")+" "+filepath.Join(run, "reverse.json"))
		var out string
		for _, r := range f.mock.Requests()[n:] {
			if r.Kind == KindTool && strings.Contains(r.Output, "ORCH ") {
				out = r.Output
			}
		}
		f.record("reverse-orchestration.txt", out)
		if !strings.Contains(out, `"worker":"stand-in"`) || !strings.Contains(out, "orchestrator-pane="+pane) {
			t.Errorf("reverse orchestration output: %q", out)
		}
		raw, _ := f.h.Run(f.ctx, "workspace", "list")
		f.record("workspaces-after-reverse.json", string(raw))
		if !strings.Contains(string(raw), "reverse-worker") {
			t.Errorf("the orchestrator's workspace is not in the session")
		}
	})
}

func waitReport(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(path); err == nil && json.Valid(b) {
			return b
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("no report at %s", path)
	return nil
}
