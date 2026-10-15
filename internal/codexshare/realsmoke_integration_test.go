//go:build integration

package codexshare

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// RealSmokeVar must be "1" for TestCodexShareRealModelSmoke to run: it
// spends real inference (two short turns) on the user's own ~/.codex.
const RealSmokeVar = "H3D_CODEXSHARE_REAL"

// realSmokeModel is the cheapest Codex model of the pricing table, at low
// effort.
const realSmokeModel, realSmokeEffort = "gpt-6-luna", "low"

// TestCodexShareRealModelSmoke is #155's bounded real-model check of the
// shared launch and resume: one worker launched exactly as herdr-3d's hire
// does (production Control shapes, launcher and adapter) in a throwaway
// Herdr session on the user's real ~/.codex, one turn, the bridge's join,
// the bridge's sleep (TUI quit, server stopped, session restarted with
// nothing resumed), the bridge's wake (server again, remote resume), one
// more turn, the join again, then the thread archived and everything
// stopped. Every codex call names the worker's own socket or is that
// server: the CODEX_HOME daemon is never connected to (its pid file and
// the config's checksums are recorded before and after).
func TestCodexShareRealModelSmoke(t *testing.T) {
	if os.Getenv(RealSmokeVar) != "1" {
		t.Skipf("set %s=1 to spend two real-model turns", RealSmokeVar)
	}
	requireTools(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	root, err := os.MkdirTemp("", "h3d155-")
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

	// The user's own login environment, minus Herdr, Codex and Claude
	// variables, plus the owner marker: no CODEX_HOME, so the real one.
	f.h, err = StartHerdr(ctx, root, fixtureShell(t), os.Environ(), OwnerVar+"="+f.owner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.h.Close)
	ws := filepath.Join(root, "ws")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	pane, err := f.h.CreateWorkspace(ctx, ws, "smoke")
	if err != nil {
		t.Fatal(err)
	}
	f.shell(pane, "true")

	ctl := f.control(filepath.Join(root, "run"))
	s := &sharedLaunch{ws: "ws", name: "smoke", pane: pane, cwd: ws, l: codexapp.Launch{Name: "d00000000155"}}
	agent := herdr.Agent{Harness: "codex", Model: realSmokeModel, Effort: realSmokeEffort}

	// Launch: the server from the pane (the cwd trusted in memory), the TUI.
	f.startShared(ctl, s)
	start := time.Now()
	err = ctl.StartCodexRemote(ctx, f.h.Name, pane, s.name, agent, herdr.Remote{Socket: s.l.Socket(), Cwd: ws})
	f.record("agent-start.txt", fmt.Sprintf("after %s: %v\n", time.Since(start).Round(10*time.Millisecond), err))
	screen := f.snap("tui-started", pane)
	if err != nil {
		t.Fatalf("agent start: %v", err)
	}
	if strings.Contains(screen, "Trust this folder") || strings.Contains(screen, hooksReviewText) {
		t.Fatal("a startup dialog showed")
	}

	// Turn 1.
	if _, err := f.h.AgentPrompt(ctx, s.name, "Reply with the single word OK.", 120*time.Second, "idle", "done"); err != nil {
		f.snap("turn1-failed", pane)
		t.Fatalf("turn 1: %v", err)
	}
	f.snap("turn1", pane)
	if s.thread = f.waitThread("agent-after-turn1", s.name, 20*time.Second); s.thread == "" {
		t.Fatal("herdr has no session id after turn 1")
	}

	// The bridge's join: the same thread, no turn started.
	join := func(label string) {
		t.Helper()
		w, ev := watch(t, s.l.Socket(), s.thread)
		j := ev.wait(t, codexapp.EvJoined, 30*time.Second)
		time.Sleep(3 * time.Second)
		f.record(label+".txt", fmt.Sprintf("joined %s ephemeral %v\nuser agent %s\nevents:\n%s\n", j.Thread.ID, j.Thread.Ephemeral,
			j.UserAgent, strings.Join(ev.methods(), "\n")))
		if j.Thread.ID != s.thread || j.Thread.Ephemeral {
			t.Fatalf("joined %+v, herdr says %s", j.Thread, s.thread)
		}
		for _, m := range ev.methods() {
			if strings.Contains(m, "turn/started") {
				t.Fatalf("joining started a turn: %v", ev.methods())
			}
		}
		w.Close()
	}
	join("bridge-join")

	// Sleep, as the bridge does it.
	f.quitTUI(ctl, pane)
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		if raw, _ := f.h.Run(ctx, "pane", "get", pane); !strings.Contains(string(raw), s.thread) {
			break
		}
	}
	raw, _ := f.h.Run(ctx, "pane", "get", pane)
	f.record("pane-after-quit.json", string(raw))
	if left := codexapp.Stop(s.l, 3*time.Second); len(left) != 0 {
		t.Fatalf("server processes %v survived", left)
	}
	if err := s.l.Remove(); err != nil {
		t.Fatal(err)
	}
	f.h.stop()
	saved, _ := os.ReadFile(filepath.Join(f.sessionDir(), "session.json"))
	if strings.Contains(string(saved), s.thread) {
		// Restarting now would let herdr run a plain `codex resume`, which
		// starts the user's CODEX_HOME daemon: never.
		t.Fatal("session.json still names the thread: not restarting the session")
	}
	f.record("saved-session-has-thread.txt", "no\n")
	if err := f.h.start(ctx); err != nil {
		t.Fatal(err)
	}
	time.Sleep(4 * time.Second)
	info, err := ctl.PaneProcesses(ctx, f.h.Name, pane)
	f.recordJSON("restored-pane-processes", info)
	if err != nil || !info.AtShell() {
		t.Fatalf("the restored pane is not at its shell: %+v %v", info, err)
	}

	// Wake, as the bridge does it.
	f.startShared(ctl, s)
	start = time.Now()
	err = ctl.ResumeCodexRemote(ctx, f.h.Name, pane, s.name, s.thread, agent, herdr.Remote{Socket: s.l.Socket(), Cwd: ws})
	f.record("resume.txt", fmt.Sprintf("after %s: %v\n", time.Since(start).Round(10*time.Millisecond), err))
	screen = f.snap("tui-resumed", pane)
	var api *herdr.APIError
	if err != nil && !(errors.As(err, &api) && api.Code == "agent_not_ready") {
		t.Fatalf("resume: %v", err)
	}
	if !strings.Contains(screen, "OK") {
		t.Errorf("the resumed TUI does not show turn 1's answer")
	}

	// Turn 2, then the same thread in herdr and in the bridge's join.
	if _, err := f.h.AgentPrompt(ctx, s.name, "Reply with the single word AGAIN.", 120*time.Second, "idle", "done"); err != nil {
		f.snap("turn2-failed", pane)
		t.Fatalf("turn 2: %v", err)
	}
	f.snap("turn2", pane)
	if !f.waitSession("agent-after-turn2", s.name, s.thread, 20*time.Second) {
		t.Error("herdr did not report the same thread after the resume")
	}
	join("bridge-rejoin")

	// Clean up: archive the thread through its own server, quit, stop.
	f.quitTUI(ctl, pane)
	f.shell(pane, "codex archive "+s.thread+" --remote unix://"+s.l.Socket())
	f.snap("archive", pane)
	if left := codexapp.Stop(s.l, 3*time.Second); len(left) != 0 {
		t.Errorf("server processes %v survived", left)
	}
	_ = s.l.Remove()
	after := realBaseline(codexHome)
	f.record("baseline-after.txt", after)
	if after != baseline {
		t.Errorf("the CODEX_HOME daemon or the config changed:\nbefore\n%s\nafter\n%s", baseline, after)
	}
}

// hooksReviewText is Codex's hooks dialog (server.hooksReview).
const hooksReviewText = "Hooks need review"

// realBaseline is what must not change: the CODEX_HOME daemon's pid file
// and its process's start ticks, and the checksums of config.toml and
// hooks.json. Read only.
func realBaseline(codexHome string) string {
	var b strings.Builder
	pidFile := filepath.Join(codexHome, "app-server-daemon", "app-server.pid")
	raw, err := os.ReadFile(pidFile)
	fmt.Fprintf(&b, "daemon pid file: %q (%v)\n", strings.TrimSpace(string(raw)), err)
	if pid := firstInt(string(raw)); pid > 0 {
		st, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		if err == nil {
			i := strings.LastIndexByte(string(st), ')')
			fields := strings.Fields(string(st[i+1:]))
			if len(fields) > 19 {
				fmt.Fprintf(&b, "daemon process %d start ticks %s\n", pid, fields[19])
			}
		} else {
			fmt.Fprintf(&b, "daemon process %d: not running\n", pid)
		}
	}
	for _, name := range []string{"config.toml", "hooks.json"} {
		data, err := os.ReadFile(filepath.Join(codexHome, name))
		sum := md5.Sum(data)
		fmt.Fprintf(&b, "%s md5 %s (%v)\n", name, hex.EncodeToString(sum[:]), err)
	}
	return b.String()
}

func firstInt(s string) int {
	n := 0
	seen := false
	for _, r := range s {
		if r >= '0' && r <= '9' {
			n = n*10 + int(r-'0')
			seen = true
		} else if seen {
			break
		}
	}
	return n
}
