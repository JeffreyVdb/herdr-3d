//go:build integration

package codexshare

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestCodexShareResumeSuppression is #155's gating check (D5): for a
// shared-mode Codex pane, which sleep-time step keeps Herdr's native resume
// off the pane on the next start, while the bridge keeps the thread id?
// Candidates: `pane release-agent` with the TUI still running, and the
// TUI's own exit (one Ctrl+C on an idle remote TUI). Each case stops the
// worker's server before the session stops (D2), reads the saved
// session.json, starts the session again and records what the restored
// pane runs.
func TestCodexShareResumeSuppression(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a", "ws-b", "ws-c")
	f.installHerdrHook()

	type outcome struct {
		pane, sock, id string
	}
	launch := func(ws, name string) outcome {
		pane := f.pane(ws)
		sock := f.startServer(pane, name)
		f.startTUI(name, pane, "--remote", "unix://"+sock, "-C", filepath.Join(f.root, ws))
		f.trustHooks(name, name, pane)
		f.prompt(name, "MOCK:say "+name)
		c := f.client(sock, "h3d-suppress")
		id := f.tuiThread(c).ID
		c.Close()
		if !f.waitSession(name+"-agent-before", name, id, 15*time.Second) {
			t.Fatalf("Herdr never got session %s for %s", id, name)
		}
		return outcome{pane: pane, sock: sock, id: id}
	}

	// release: `pane release-agent` while the TUI still runs.
	rel := launch("ws-a", "rel")
	out, err := f.h.Run(f.ctx, "pane", "release-agent", rel.pane, "--source", "herdr:codex", "--agent", "codex")
	f.record("rel-release-agent.txt", string(out)+errText(err))
	time.Sleep(time.Second)
	f.agentRaw("rel-agent-after-release", rel.pane)
	raw, _ := f.h.Run(f.ctx, "pane", "get", rel.pane)
	f.record("rel-pane-after-release.json", string(raw))

	// exit: the TUI's own exit (idle remote TUI: one Ctrl+C).
	ex := launch("ws-b", "ex")
	f.exitTUI(ex.pane)
	time.Sleep(time.Second)
	raw, _ = f.h.Run(f.ctx, "pane", "get", ex.pane)
	f.record("ex-pane-after-exit.json", string(raw))

	// control: nothing done; Herdr is expected to resume it natively.
	ctl := launch("ws-c", "ctl")

	// Stop every worker's server first (D2), then the session.
	for _, o := range []outcome{rel, ex, ctl} {
		pid := f.serverPID(o.sock)
		if err := killPID(pid); err != nil {
			t.Fatal(err)
		}
	}
	f.h.stop()
	dir := f.sessionDir()
	saved, _ := os.ReadFile(filepath.Join(dir, "session.json"))
	f.record("session-after-stop.json", string(saved))
	for _, o := range []outcome{rel, ex, ctl} {
		f.record("saved-has-id-"+o.id[:8]+".txt", boolText(strings.Contains(string(saved), o.id))+"\n")
	}
	if err := f.h.start(f.ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(6 * time.Second)
	for name, o := range map[string]outcome{"rel": rel, "ex": ex, "ctl": ctl} {
		info, err := f.h.ProcessInfo(f.ctx, o.pane)
		f.recordJSON(name+"-restored-processes", info)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		f.snap(name+"-restored", o.pane)
		resumed := false
		for _, p := range info.Foreground {
			if p.Name == "codex" {
				resumed = true
			}
		}
		f.record(name+"-summary.txt", "herdr resumed codex natively: "+boolText(resumed)+"\n")
		t.Logf("%s: herdr resumed codex natively: %v", name, resumed)
	}
	// Whatever Herdr resumed natively ran a plain `codex resume`, which
	// auto-starts the fixture home's daemon (B2, B4).
	f.daemonStop()
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return "\nerror: " + err.Error()
}

func killPID(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

// sessionDir is the fixture session's directory (session.json).
func (f *fx) sessionDir() string {
	f.t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		f.t.Fatal(err)
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "herdr", "sessions", f.h.Name)
	}
	return filepath.Join(home, ".config", "herdr", "sessions", f.h.Name)
}
