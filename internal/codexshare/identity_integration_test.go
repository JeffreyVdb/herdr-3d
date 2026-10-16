//go:build integration

package codexshare

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// installHerdrHook installs Herdr's Codex integration (the SessionStart
// hook that reports the session id to the pane in HERDR_PANE_ID) into the
// fixture's CODEX_HOME only.
func (f *fx) installHerdrHook() {
	f.t.Helper()
	fake := filepath.Join(f.root, "hookhome")
	if err := os.MkdirAll(fake, 0o700); err != nil {
		f.t.Fatal(err)
	}
	cmd := exec.Command(f.h.Bin, "integration", "install", "codex")
	cmd.Env = CleanEnv(os.Environ(), "CODEX_HOME="+f.home, "HOME="+fake, "XDG_CONFIG_HOME="+filepath.Join(fake, ".config"))
	out, err := cmd.CombinedOutput()
	f.record("herdr-integration-install.txt", string(out))
	if err != nil {
		f.t.Fatalf("herdr integration install codex: %v", err)
	}
}

// trustHooks answers Codex's "Hooks need review" startup dialog with
// "Trust all and continue" when it shows (Herdr reports the agent idle
// while it does).
func (f *fx) trustHooks(label, agent, pane string) {
	f.t.Helper()
	screen := f.waitScreen(label+"-startup", pane, 10*time.Second, func(s string) bool {
		return strings.Contains(s, "Hooks need review") || strings.Contains(s, "Ask Codex")
	})
	if !strings.Contains(screen, "Hooks need review") {
		return
	}
	a, _, _ := f.h.AgentGet(f.ctx, agent)
	f.recordJSON(label+"-herdr-state-during-hook-review", a)
	_ = f.h.SendKeys(f.ctx, pane, "down")
	time.Sleep(300 * time.Millisecond)
	_ = f.h.SendKeys(f.ctx, pane, "enter")
	f.waitScreen(label+"-after-trust", pane, 15*time.Second, func(s string) bool {
		return !strings.Contains(s, "Hooks need review") && strings.Contains(s, "Ask Codex")
	})
	// Direct fixture launches use native Herdr rather than Control's startup
	// recovery. Herdr may have discarded their pending name during review.
	// Restore it explicitly, as the production adapter does, for named CLI tests.
	if agent != pane {
		if _, _, err := f.h.AgentGet(f.ctx, agent); err != nil {
			if _, err := f.h.Run(f.ctx, "agent", "rename", pane, agent); err != nil {
				f.t.Fatal(err)
			}
			f.record(label+"-name-restored.txt", agent+" -> "+pane+"\n")
		}
	}
}

// agentRaw records `herdr agent get` for target as evidence.
func (f *fx) agentRaw(label, target string) string {
	_, raw, err := f.h.AgentGet(f.ctx, target)
	if err != nil {
		raw = []byte(err.Error())
	}
	f.record(label+".json", string(raw))
	return string(raw)
}

// waitSession waits until Herdr's agent info for target names session id.
func (f *fx) waitSession(label, target, id string, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for {
		_, raw, _ := f.h.AgentGet(f.ctx, target)
		if strings.Contains(string(raw), id) {
			f.record(label+".json", string(raw))
			return true
		}
		if time.Now().After(deadline) {
			f.record(label+".json", string(raw))
			return false
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// TestCodexShareIdentity: Herdr's session-id hook runs in the app-server,
// so it reports to whichever pane started the server; and Herdr's own
// resume after a session restart drops --remote.
func TestCodexShareIdentity(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a", "ws-b", "ws-c")
	f.installHerdrHook()

	t.Run("embedded launch reports to its pane", func(t *testing.T) {
		pane := f.pane("ws-c")
		f.startTUI("emb", pane, "-m", "mock", "-c", "model_reasoning_effort=low", "--dangerously-bypass-approvals-and-sandbox")
		f.trustHooks("embedded", "emb", pane)
		f.prompt("emb", "MOCK:say embedded")
		f.snap("embedded-after-prompt", pane)
		if !f.waitSession("embedded-agent", "emb", "-", 10*time.Second) {
			t.Logf("no session id reported for the embedded launch")
		}
		f.exitTUI(pane)
		cfg, _ := os.ReadFile(filepath.Join(f.home, "config.toml"))
		f.record("config-after-hook-trust.toml", string(cfg))
	})

	var sameID, sameSock, samePane string
	t.Run("server started from the TUI's own pane reports to it", func(t *testing.T) {
		samePane = f.pane("ws-a")
		sameSock = f.startServer(samePane, "same")
		f.startTUI("same", samePane, "--remote", "unix://"+sameSock, "-C", filepath.Join(f.root, "ws-a"))
		f.trustHooks("same-pane", "same", samePane)
		f.prompt("same", "MOCK:say same-pane")
		c := f.client(sameSock, "h3d-id")
		sameID = f.tuiThread(c).ID
		c.Close()
		if !f.waitSession("same-pane-agent", "same", sameID, 15*time.Second) {
			t.Errorf("Herdr did not get session %s for the TUI's pane", sameID)
		}
	})

	t.Run("server started from another pane reports there", func(t *testing.T) {
		srv := f.pane("ws-b")
		sock := f.startServer(srv, "other")
		tui := f.pane("ws-b")
		f.startTUI("split", tui, "--remote", "unix://"+sock, "-C", filepath.Join(f.root, "ws-b"))
		f.trustHooks("split", "split", tui)
		f.prompt("split", "MOCK:say split-panes")
		c := f.client(sock, "h3d-id")
		id := f.tuiThread(c).ID
		c.Close()
		got := f.waitSession("split-tui-agent", "split", id, 10*time.Second)
		raw, _ := f.h.Run(f.ctx, "pane", "get", srv)
		f.record("split-server-pane.json", string(raw))
		f.record("split-summary.txt", "TUI pane got the session id: "+boolText(got)+"; server pane record names it: "+boolText(strings.Contains(string(raw), id))+"\n")
		f.exitTUI(tui)
	})

	t.Run("herdr session restart resumes without --remote", func(t *testing.T) {
		if sameID == "" {
			t.Skip("no session from the same-pane case")
		}
		serverPID := f.serverPID(sameSock)
		t.Cleanup(f.daemonStop)
		if err := f.h.Restart(f.ctx); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Second)
		f.record("server-survived-herdr-stop.txt", "worker-owned server alive after herdr session stop: "+boolText(processAlive(serverPID))+"\n")
		info, err := f.h.ProcessInfo(f.ctx, samePane)
		f.recordJSON("restored-pane-processes", info)
		if err != nil {
			t.Fatal(err)
		}
		f.snap("restored-pane", samePane)
		var argv []string
		for _, p := range info.Foreground {
			if p.Name == "codex" {
				argv = p.Argv
			}
		}
		f.record("restored-argv.txt", strings.Join(argv, " ")+"\n")
		if len(argv) == 0 {
			t.Logf("Herdr did not resume Codex in the restored pane")
			return
		}
		if strings.Contains(strings.Join(argv, " "), "--remote") {
			t.Errorf("Herdr kept --remote: %v", argv)
		}
		f.record("daemon-after-herdr-resume.txt", f.daemonStatus())
		// The orphaned worker-owned server still has the thread loaded;
		// the resumed TUI now runs it in a second server.
		c := f.client(sameSock, "h3d-orphan")
		f.record("orphan-server-still-loads-thread.txt", "thread loaded in the old worker-owned server: "+boolText(contains(f.loaded(c), sameID))+"\n")
		c.Close()
	})
}

func processAlive(pid int) bool {
	_, err := os.Stat(filepath.Join("/proc", strconv.Itoa(pid)))
	return err == nil
}
