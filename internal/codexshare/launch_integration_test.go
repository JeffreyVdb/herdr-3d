//go:build integration

package codexshare

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// #155: herdr-3d's shared launch, for real. Each step is the production
// code the bridge runs (herdr.Control's allowlisted shapes, codexapp's
// launcher, process ownership and passive Watcher) against the real Codex
// TUI in the fixture's throwaway Herdr session, mock inference.

// sharedLaunch is one worker launched the way herdr-3d's hire does.
type sharedLaunch struct {
	ws, name, pane, cwd string
	l                   codexapp.Launch
	server              codexapp.Server
	thread              string
}

// eventLog collects a Watcher's events.
type eventLog struct {
	mu     sync.Mutex
	events []codexapp.Event
}

func (e *eventLog) on(ev codexapp.Event) {
	e.mu.Lock()
	e.events = append(e.events, ev)
	e.mu.Unlock()
}

func (e *eventLog) wait(t *testing.T, kind codexapp.EventKind, d time.Duration) codexapp.Event {
	t.Helper()
	deadline := time.Now().Add(d)
	for {
		e.mu.Lock()
		for _, ev := range e.events {
			if ev.Kind == kind {
				e.mu.Unlock()
				return ev
			}
		}
		e.mu.Unlock()
		if time.Now().After(deadline) {
			t.Fatalf("no %s event", kind)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (e *eventLog) methods() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.events {
		out = append(out, string(ev.Kind)+" "+ev.Method)
	}
	return out
}

// control is the bridge's write path aimed at the fixture's session, with
// the fixture's run directory as its codex run directory.
func (f *fx) control(run string) *herdr.Control {
	return &herdr.Control{Herdr: f.h.Bin, CodexRun: run, Timeout: 90 * time.Second, Shell: f.sh, Run: f.runControl}
}

// runControl gives every fixture control command the session server's
// environment, including the private home used by Bash fixtures.
func (f *fx) runControl(ctx context.Context, argv []string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = herdr.CleanEnv(f.h.Env)
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	return []byte(out.String()), []byte(errb.String()), err
}

// startShared starts ws's server from its pane (the launcher typed with
// `pane run`), waits for a supported server and finds its process.
func (f *fx) startShared(ctl *herdr.Control, s *sharedLaunch) {
	f.t.Helper()
	l, err := codexapp.NewLaunchFor(ctl.Shell, ctl.CodexRun, s.l.Name, s.cwd)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := l.Write(); err != nil {
		f.t.Fatal(err)
	}
	s.l = l
	if err := ctl.StartCodexServer(f.ctx, f.h.Name, s.pane, l.Script()); err != nil {
		f.t.Fatal(err)
	}
	ctx, cancel := f.within(30 * time.Second)
	defer cancel()
	ua, err := codexapp.WaitReady(ctx, l.Socket())
	if err != nil {
		log, _ := os.ReadFile(l.Log())
		f.t.Fatalf("%v\nserver log:\n%s", err, log)
	}
	f.record(s.name+"-user-agent.txt", ua+"\n")
	if err := codexapp.CheckUserAgent(ua); err != nil {
		f.t.Fatal(err)
	}
	if s.server, err = codexapp.FindServer(l); err != nil {
		f.t.Fatal(err)
	}
}

// quitTUI exits the pane's TUI the way the bridge's sleep and send home
// do: /quit, a pause, Enter.
func (f *fx) quitTUI(ctl *herdr.Control, pane string) {
	f.t.Helper()
	if err := ctl.TypeExit(f.ctx, f.h.Name, pane, "codex"); err != nil {
		f.t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	for range 3 {
		if err := ctl.SendKey(f.ctx, f.h.Name, pane, herdr.KeyEnter); err != nil {
			f.t.Fatal(err)
		}
		for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
			if info, err := ctl.PaneProcesses(f.ctx, f.h.Name, pane); err == nil && info.AtShell() {
				return
			}
		}
	}
	f.snap("tui-would-not-quit", pane)
	f.t.Fatal("the TUI did not quit on /quit")
}

// waitThread waits until herdr reports a session id for target's pane and
// returns it ("" after d).
func (f *fx) waitThread(label, target string, d time.Duration) string {
	f.t.Helper()
	deadline := time.Now().Add(d)
	for {
		a, raw, _ := f.h.AgentGet(f.ctx, target)
		if a.Session != nil && a.Session.Value != "" {
			f.record(label+".json", string(raw))
			return a.Session.Value
		}
		if time.Now().After(deadline) {
			f.record(label+".json", string(raw))
			return ""
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// watch joins thread on sock with the bridge's adapter.
func watch(t *testing.T, sock, thread string) (*codexapp.Watcher, *eventLog) {
	t.Helper()
	ev := &eventLog{}
	w, err := codexapp.Watch(codexapp.Options{Socket: sock, Thread: thread, ClientVersion: "it", OnEvent: ev.on})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	return w, ev
}

// TestCodexShareSharedLaunch: two workers launched as herdr-3d's hire does,
// joined by the bridge's adapter, put to sleep as the bridge does (TUI
// quit, server stopped by its marker), the session restarted, and resumed
// as the bridge's wake does.
func TestCodexShareSharedLaunch(t *testing.T) {
	f := newFx(t, fxOptions{}, "ws-a", "ws-b")
	f.installHerdrHook()
	run := filepath.Join(f.root, "run")
	ctl := f.control(run)
	agent := herdr.Agent{Harness: "codex", Model: "mock", Effort: "low"}
	workers := []*sharedLaunch{
		{ws: "ws-a", name: "wa", l: codexapp.Launch{Name: "a00000000001"}},
		{ws: "ws-b", name: "wb", l: codexapp.Launch{Name: "b00000000002"}},
	}

	for _, s := range workers {
		s.cwd = filepath.Join(f.root, s.ws)
		s.pane = f.pane(s.ws)
		f.startShared(ctl, s)
		err := ctl.StartCodexRemote(f.ctx, f.h.Name, s.pane, s.name, agent, herdr.Remote{Socket: s.l.Socket(), Cwd: s.cwd})
		var api *herdr.APIError
		if err != nil && !(errors.As(err, &api) && api.Code == "agent_not_ready") {
			f.snap(s.name+"-start-failed", s.pane)
			t.Fatalf("%s: %v", s.name, err)
		}
		f.trustHooks(s.name, s.name, s.pane) // the player's part (B8): once per CODEX_HOME
		screen := f.snap(s.name+"-tui-started", s.pane)
		if strings.Contains(screen, "Trust this folder") {
			t.Fatalf("%s: the trust dialog showed despite the server's override", s.name)
		}
		f.prompt(s.name, "MOCK:say hello-"+s.ws)
	}

	t.Run("the bridge joins each worker's own thread", func(t *testing.T) {
		for _, s := range workers {
			if s.thread = f.waitThread(s.name+"-agent", s.name, 15*time.Second); s.thread == "" {
				t.Fatalf("%s: herdr has no session id", s.name)
			}
		}
		if workers[0].thread == workers[1].thread {
			t.Fatalf("two workers share thread %s", workers[0].thread)
		}
		for _, s := range workers {
			before := f.mock.ModelRequests()
			w, ev := watch(t, s.l.Socket(), s.thread)
			j := ev.wait(t, codexapp.EvJoined, 20*time.Second)
			f.record(s.name+"-joined.txt", fmt.Sprintf("thread %s ephemeral %v path %s ua %s\n", j.Thread.ID, j.Thread.Ephemeral, j.Thread.Path, j.UserAgent))
			if j.Thread.ID != s.thread || j.Thread.Ephemeral || !strings.HasPrefix(j.Thread.Path, filepath.Join(f.home, "sessions")) {
				t.Fatalf("%s joined %+v", s.name, j.Thread)
			}
			time.Sleep(time.Second)
			if n := f.mock.ModelRequests(); n != before {
				t.Fatalf("%s: joining made %d model requests", s.name, n-before)
			}
			// The terminal and the bridge share the thread: a terminal turn
			// reaches the bridge.
			f.prompt(s.name, "MOCK:say seen-by-bridge-"+s.ws)
			deadline := time.Now().Add(20 * time.Second)
			for !strings.Contains(strings.Join(ev.methods(), "\n"), "turn/completed") && time.Now().Before(deadline) {
				time.Sleep(100 * time.Millisecond)
			}
			f.record(s.name+"-bridge-events.txt", strings.Join(ev.methods(), "\n")+"\n")
			if !strings.Contains(strings.Join(ev.methods(), "\n"), "turn/completed") {
				t.Fatalf("%s: the bridge saw no turn: %v", s.name, ev.methods())
			}
			// The bridge leaves (thread/unsubscribe, close); the terminal goes on.
			w.Close()
			f.prompt(s.name, "MOCK:say after-bridge-left-"+s.ws)
			f.snap(s.name+"-after-bridge-left", s.pane)
		}
	})

	t.Run("sleep: the TUI quits, the server stops, herdr resumes nothing", func(t *testing.T) {
		if workers[0].thread == "" {
			t.Skip("no threads")
		}
		for _, s := range workers {
			f.quitTUI(ctl, s.pane)
			// herdr releases the pane's agent and forgets its session a
			// moment after the TUI quit (the bridge's sleep waits for it).
			raw, _ := f.h.Run(f.ctx, "pane", "get", s.pane)
			f.record(s.name+"-pane-right-after-quit.json", string(raw))
			released := time.Now()
			for end := time.Now().Add(5 * time.Second); strings.Contains(string(raw), s.thread) && time.Now().Before(end); {
				time.Sleep(100 * time.Millisecond)
				raw, _ = f.h.Run(f.ctx, "pane", "get", s.pane)
			}
			f.record(s.name+"-pane-after-quit.json", fmt.Sprintf("released after %s\n%s", time.Since(released).Round(100*time.Millisecond), raw))
			if strings.Contains(string(raw), s.thread) {
				t.Errorf("%s: herdr kept the session id after the TUI quit", s.name)
			}
			if left := codexapp.Stop(s.l, 2*time.Second); len(left) != 0 {
				t.Fatalf("%s: processes %v survived", s.name, left)
			}
			if err := s.l.Remove(); err != nil {
				t.Fatal(err)
			}
			if pids := codexapp.MarkedPIDs(s.l.Token, ""); len(pids) != 0 || codexapp.Alive(s.l, s.server) {
				t.Fatalf("%s: still running %v", s.name, pids)
			}
			for _, p := range []string{s.l.Socket(), s.l.PIDFile(), s.l.Script()} {
				if _, err := os.Lstat(p); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("%s left behind", p)
				}
			}
		}
		f.h.stop()
		saved, _ := os.ReadFile(filepath.Join(f.sessionDir(), "session.json"))
		for _, s := range workers {
			if strings.Contains(string(saved), s.thread) {
				t.Errorf("session.json keeps %s's thread", s.name)
			}
		}
		if err := f.h.start(f.ctx); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Second)
		for _, s := range workers {
			info, err := ctl.PaneProcesses(f.ctx, f.h.Name, s.pane)
			if err != nil {
				t.Fatal(err)
			}
			f.recordJSON(s.name+"-restored-processes", info)
			if !info.AtShell() {
				t.Fatalf("%s: herdr resumed something: %+v", s.name, info.Foreground)
			}
		}
	})

	t.Run("wake: the server starts again and the thread resumes attached", func(t *testing.T) {
		if workers[0].thread == "" {
			t.Skip("no threads")
		}
		for _, s := range workers {
			old := s.l.Token
			f.startShared(ctl, s)
			if s.l.Token == old {
				t.Fatal("a restarted server reused the token")
			}
			err := ctl.ResumeCodexRemote(f.ctx, f.h.Name, s.pane, s.name, s.thread, agent,
				herdr.Remote{Socket: s.l.Socket(), Cwd: s.cwd})
			var api *herdr.APIError
			if err != nil && !(errors.As(err, &api) && api.Code == "agent_not_ready") {
				f.snap(s.name+"-resume-failed", s.pane)
				t.Fatalf("%s: %v", s.name, err)
			}
			screen := f.snap(s.name+"-tui-resumed", s.pane)
			if !strings.Contains(screen, "hello-"+s.ws) {
				t.Errorf("%s: the resumed TUI does not show the history", s.name)
			}
			f.prompt(s.name, "MOCK:say resumed-"+s.ws)
			if !f.waitSession(s.name+"-agent-after-resume", s.name, s.thread, 15*time.Second) {
				t.Errorf("%s: herdr did not report the same thread after the resume", s.name)
			}
			before := f.mock.ModelRequests()
			_, ev := watch(t, s.l.Socket(), s.thread)
			if j := ev.wait(t, codexapp.EvJoined, 20*time.Second); j.Thread.ID != s.thread {
				t.Fatalf("%s rejoined %s", s.name, j.Thread.ID)
			}
			time.Sleep(time.Second)
			if n := f.mock.ModelRequests(); n != before {
				t.Fatalf("%s: rejoining made %d model requests", s.name, n-before)
			}
		}
		for _, s := range workers {
			f.quitTUI(ctl, s.pane)
			codexapp.Stop(s.l, 2*time.Second)
			_ = s.l.Remove()
		}
	})

	// #155 review round 1 (R4): the wake of a worker whose server does not
	// start resumes its thread on Codex's embedded server, with hire's
	// arguments (the bypass flag included: only a remote resume refuses it),
	// and no daemon is started in the CODEX_HOME (B2).
	t.Run("wake without its server: the thread resumes on the embedded server", func(t *testing.T) {
		s := workers[0]
		if s.thread == "" {
			t.Skip("no threads")
		}
		if err := ctl.ResumeCodexEmbedded(f.ctx, f.h.Name, s.pane, s.name, s.thread, agent); err != nil {
			var api *herdr.APIError
			if !(errors.As(err, &api) && api.Code == "agent_not_ready") {
				f.snap(s.name+"-embedded-resume-failed", s.pane)
				t.Fatalf("%s: %v", s.name, err)
			}
		}
		screen := f.snap(s.name+"-tui-resumed-embedded", s.pane)
		if strings.Contains(screen, "f2 to view") { // what the embedded TUI warns about, for the evidence
			_, _ = f.h.Run(f.ctx, "pane", "send-keys", s.pane, "f2")
			time.Sleep(500 * time.Millisecond)
			f.snap(s.name+"-tui-resumed-embedded-warnings", s.pane)
			_, _ = f.h.Run(f.ctx, "pane", "send-keys", s.pane, "f2")
			time.Sleep(500 * time.Millisecond)
		}
		if !strings.Contains(screen, "resumed-"+s.ws) { // the last turn before (the screen is too short for the first)
			t.Errorf("%s: the embedded resume does not show the history", s.name)
		}
		info, err := ctl.PaneProcesses(f.ctx, f.h.Name, s.pane)
		if err != nil {
			t.Fatal(err)
		}
		f.recordJSON(s.name+"-embedded-processes", info)
		for _, p := range info.Foreground {
			if strings.Contains(p.Cmdline, "--remote") {
				t.Fatalf("%s: the embedded resume runs %q", s.name, p.Cmdline)
			}
		}
		f.prompt(s.name, "MOCK:say embedded-"+s.ws)
		if !f.waitSession(s.name+"-agent-after-embedded-resume", s.name, s.thread, 15*time.Second) {
			t.Errorf("%s: herdr did not report the same thread after the embedded resume", s.name)
		}
		if _, err := os.Stat(filepath.Join(f.home, "app-server-daemon", "app-server.pid")); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("the embedded resume started the CODEX_HOME daemon (%v)", err)
		}
		f.quitTUI(ctl, s.pane)
	})
}

// TestCodexShareSharedApprovals: the bridge's adapter is passive. On a
// worker server started with herdr-3d's launcher (and a TUI that asks for
// approvals), the approval reaches the adapter, which never answers it;
// the terminal does, and the adapter only sees it resolved.
func TestCodexShareSharedApprovals(t *testing.T) {
	f := newFx(t, fxOptions{approval: "on-request", sandbox: "workspace-write"}, "ws-a")
	ctl := f.control(filepath.Join(f.root, "run"))
	s := &sharedLaunch{ws: "ws-a", name: "ap", cwd: filepath.Join(f.root, "ws-a"), l: codexapp.Launch{Name: "c00000000003"}}
	s.pane = f.pane(s.ws)
	f.startShared(ctl, s)
	// No bypass flag, so the thread asks for approvals.
	f.startTUI(s.name, s.pane, "--remote", "unix://"+s.l.Socket(), "-C", s.cwd)
	f.prompt(s.name, "MOCK:say ready")
	c := f.client(s.l.Socket(), "h3d-find")
	s.thread = f.tuiThread(c).ID
	c.Close()

	_, ev := watch(t, s.l.Socket(), s.thread)
	ev.wait(t, codexapp.EvJoined, 20*time.Second)
	if _, err := f.h.AgentPrompt(f.ctx, s.name, "MOCK:approve touch approved-by-terminal.txt", 60*time.Second, "blocked"); err != nil {
		t.Fatalf("herdr never saw the approval as blocked: %v", err)
	}
	req := ev.wait(t, codexapp.EvServerRequest, 30*time.Second)
	f.record("approval-to-adapter.txt", req.Method+" "+string(req.RequestID)+"\n"+string(req.Params)+"\n")
	if req.Method != "item/commandExecution/requestApproval" {
		t.Fatalf("server request %s", req.Method)
	}
	// Left alone: the modal stays until the terminal answers.
	time.Sleep(2 * time.Second)
	if screen := f.snap("approval-modal-still-open", s.pane); !strings.Contains(screen, "Would you like to run") {
		t.Fatal("the approval was resolved without the terminal")
	}
	if err := f.h.SendKeys(f.ctx, s.pane, "y"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for !strings.Contains(strings.Join(ev.methods(), "\n"), "serverRequest/resolved") && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	f.record("adapter-events.txt", strings.Join(ev.methods(), "\n")+"\n")
	if !strings.Contains(strings.Join(ev.methods(), "\n"), "serverRequest/resolved") {
		t.Fatal("the adapter never saw the approval resolved")
	}
	f.settle(s.name)
	if _, err := os.Stat(filepath.Join(s.cwd, "approved-by-terminal.txt")); err != nil {
		t.Errorf("the approved command did not run: %v", err)
	}
}
