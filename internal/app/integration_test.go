//go:build integration

// Integration test against a real herdr. It creates its own throwaway
// session (h3d-it-<random>), drives it with the herdr CLI, and deletes it
// afterwards, even on failure. It never touches any other session: every
// herdr invocation names the throwaway session explicitly and runs with the
// herdr pane / Claude variables stripped, and the bridge under test only
// watches that session. Run with `make integration`.
package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

const eventDeadline = 2 * time.Second

// throwaway is a herdr session owned by the test.
type throwaway struct {
	t    *testing.T
	bin  string
	env  []string
	name string
	info herdr.Session
}

// run executes herdr against the throwaway session only.
func (s *throwaway) run(args ...string) []byte {
	s.t.Helper()
	targeted := false
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "--session" && args[i+1] == s.name {
			targeted = true
		}
	}
	if len(args) >= 3 && args[0] == "session" && (args[1] == "stop" || args[1] == "delete") && args[2] == s.name {
		targeted = true
	}
	if !targeted || !strings.HasPrefix(s.name, "h3d-it-") {
		panic("integration test tried to run herdr outside its throwaway session: " + strings.Join(args, " "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.bin, args...)
	cmd.Env = s.env
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			s.t.Fatalf("herdr %s: %v: %s", strings.Join(args, " "), err, ee.Stderr)
		}
		s.t.Fatalf("herdr %s: %v", strings.Join(args, " "), err)
	}
	return out
}

func listSessions(t *testing.T, c *herdr.Client) []herdr.Session {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	list, err := c.ListSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

// startThrowaway starts a headless herdr server for a fresh session and
// registers its stop + delete.
func startThrowaway(t *testing.T) *throwaway {
	bin, err := exec.LookPath("herdr")
	if err != nil {
		t.Skip("herdr is not installed")
	}
	return startThrowawayBin(t, bin)
}

// startThrowawayBin is startThrowaway with that herdr executable.
func startThrowawayBin(t *testing.T, bin string) *throwaway {
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	s := &throwaway{t: t, bin: bin, env: herdr.CleanEnv(os.Environ()), name: "h3d-it-" + hex.EncodeToString(rnd[:])}
	client := &herdr.Client{Bin: bin}
	for _, existing := range listSessions(t, client) {
		if existing.Name == s.name {
			t.Fatalf("session %s already exists", s.name)
		}
	}

	logf, err := os.Create(filepath.Join(t.TempDir(), "herdr-server.out"))
	if err != nil {
		t.Fatal(err)
	}
	srv := exec.Command(bin, "--session", s.name, "server")
	srv.Env = s.env
	srv.Dir = t.TempDir()
	srv.Stdout, srv.Stderr = logf, logf
	srv.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = srv.Wait(); close(exited) }()
	t.Cleanup(func() {
		// Stop the server herdr's way (saves state, ends pane processes),
		// then delete the session. Both are scoped to the throwaway name.
		stop := exec.Command(bin, "session", "stop", s.name, "--json")
		stop.Env = s.env
		_ = stop.Run()
		select {
		case <-exited:
		case <-time.After(10 * time.Second):
			t.Errorf("herdr server for %s did not exit; killing it", s.name)
			_ = srv.Process.Signal(syscall.SIGTERM)
			select {
			case <-exited:
			case <-time.After(3 * time.Second):
				_ = srv.Process.Kill()
			}
		}
		del := exec.Command(bin, "session", "delete", s.name, "--json")
		del.Env = s.env
		if out, err := del.CombinedOutput(); err != nil {
			t.Errorf("deleting throwaway session %s: %v: %s", s.name, err, out)
		}
		if s.info.SessionDir != "" {
			if _, err := os.Stat(s.info.SessionDir); !os.IsNotExist(err) {
				t.Errorf("throwaway session dir %s still exists", s.info.SessionDir)
			}
		}
		logf.Close()
	})

	deadline := time.Now().Add(15 * time.Second)
	for {
		for _, info := range listSessions(t, client) {
			if info.Name == s.name {
				s.info = info
			}
		}
		if s.info.SocketPath != "" {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, err := client.Ping(ctx, s.info.SocketPath)
			cancel()
			if err == nil {
				return s
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("throwaway herdr server %s did not come up", s.name)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// stream reads protocol messages in the background.
type stream struct {
	t    *testing.T
	msgs chan []byte
}

func (st *stream) waitFor(what string, within time.Duration, ok func(proto.Event) bool) proto.Event {
	st.t.Helper()
	deadline := time.After(within)
	for {
		select {
		case raw, open := <-st.msgs:
			if !open {
				st.t.Fatalf("connection closed while waiting for %s", what)
			}
			var ev proto.Event
			if json.Unmarshal(raw, &ev) == nil && ok(ev) {
				return ev
			}
		case <-deadline:
			st.t.Fatalf("no %s within %v", what, within)
		}
	}
}

func TestIntegrationThrowawaySession(t *testing.T) {
	s := startThrowaway(t)
	t.Logf("throwaway session %s at %s", s.name, s.info.SessionDir)

	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	sock := filepath.Join(sockDir, "herdr-world", "bridge.sock")
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	served := make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: sock, DB: filepath.Join(t.TempDir(), "world.db"), Herdr: &herdr.Client{Bin: s.bin},
			Only: regexp.MustCompile("^" + regexp.QuoteMeta(s.name) + "$"),
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
		})
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	<-ready

	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := proto.Dial(dctx, sock)
	dcancel()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration"}); err != nil {
		t.Fatal(err)
	}
	st := &stream{t: t, msgs: make(chan []byte, 1024)}
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
	floor := func(state string) func(proto.Event) bool {
		return func(ev proto.Event) bool {
			return ev.T == proto.EvFloorUpsert && ev.Floor.Session == s.name && ev.Floor.State == state
		}
	}
	st.waitFor("running floor", 10*time.Second, floor("running"))

	cwd := t.TempDir()
	var created struct {
		Result struct {
			Workspace struct {
				WorkspaceID string `json:"workspace_id"`
			} `json:"workspace"`
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", cwd, "--label", "CODE|it|2|r1", "--no-focus"), &created); err != nil {
		t.Fatal(err)
	}
	ws, pane := created.Result.Workspace.WorkspaceID, created.Result.RootPane.PaneID
	up := st.waitFor("worker.upsert for the new workspace", eventDeadline, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerUpsert && ev.Worker.WorkspaceID == ws
	})
	id := up.Worker.ID
	if up.Worker.Role != "code" || up.Worker.Run != "it" || up.Worker.Cwd != cwd || up.Worker.PaneID != pane {
		t.Errorf("worker = %+v", up.Worker)
	}

	// Start a (custom) agent in the pane through herdr's own agent-state
	// reporting API, the one agent integrations use: no real coding agent,
	// no credentials, deterministic states.
	report := func(state string) {
		s.run("--session", s.name, "pane", "report-agent", pane, "--source", "custom:h3d-it", "--agent", "h3d-it", "--state", state)
	}
	report("working")
	st.waitFor("worker working", eventDeadline, func(ev proto.Event) bool {
		return (ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.Status == "working" && ev.Worker.AgentKind == "h3d-it") ||
			(ev.T == proto.EvWorkerStatus && ev.ID == id && ev.Status == "working")
	})
	report("idle")
	if ev := st.waitFor("worker.status idle", eventDeadline, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerStatus && ev.ID == id && ev.Status == "idle"
	}); ev.PrevStatus != "working" {
		t.Errorf("prev_status = %q", ev.PrevStatus)
	}
	report("blocked")
	st.waitFor("worker.status blocked", eventDeadline, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerStatus && ev.ID == id && ev.Status == "blocked"
	})
	// Stop the agent.
	s.run("--session", s.name, "pane", "release-agent", pane, "--source", "custom:h3d-it", "--agent", "h3d-it")
	st.waitFor("agent gone", eventDeadline, func(ev proto.Event) bool {
		return (ev.T == proto.EvWorkerUpsert && ev.Worker.ID == id && ev.Worker.AgentKind == "" && ev.Worker.Status == "unknown") ||
			(ev.T == proto.EvWorkerStatus && ev.ID == id && ev.Status == "unknown")
	})

	// A second workspace stays for the sleep check; the first one closes.
	if err := json.Unmarshal(s.run("--session", s.name, "workspace", "create", "--cwd", cwd, "--label", "keeper", "--no-focus"), &created); err != nil {
		t.Fatal(err)
	}
	keeperWS := created.Result.Workspace.WorkspaceID
	keeper := st.waitFor("keeper worker", eventDeadline, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerUpsert && ev.Worker.WorkspaceID == keeperWS
	}).Worker.ID
	s.run("--session", s.name, "workspace", "close", ws)
	st.waitFor("worker.removed", eventDeadline, func(ev proto.Event) bool {
		return ev.T == proto.EvWorkerRemoved && ev.ID == id
	})

	// Stop the session: the floor goes to sleep, the keeper stays at its desk.
	s.run("session", "stop", s.name, "--json")
	st.waitFor("asleep floor", 5*time.Second, floor("asleep"))

	var out strings.Builder
	dumpCtx, dumpCancel := context.WithTimeout(ctx, 10*time.Second)
	defer dumpCancel()
	if err := dumpMain(dumpCtx, "herdr-world", []string{"-socket", sock, "-once"}, &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	var snap proto.Snapshot
	if err := json.Unmarshal([]byte(out.String()), &snap); err != nil {
		t.Fatal(err)
	}
	if len(snap.World.Floors) != 1 || snap.World.Floors[0].State != "asleep" || snap.World.Floors[0].Error != "" {
		t.Fatalf("floors = %+v", snap.World.Floors)
	}
	var ids []string
	for _, w := range snap.World.Workers {
		ids = append(ids, w.ID)
	}
	if !slices.Equal(ids, []string{keeper}) {
		t.Fatalf("asleep workers = %v, want the keeper %s with the same id", ids, keeper)
	}
}

// testWriter sends bridge logs to t.Log.
type testWriter struct{ t *testing.T }

func (w testWriter) Write(p []byte) (int, error) {
	w.t.Log(strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// TestIntegrationSleepWake puts a throwaway floor to sleep through the
// bridge (`herdr session stop`) and wakes it through the bridge's real
// systemd-run path (transient unit herdr-s-<name>): the workers keep their
// ids, desks and names both ways. Cleanup stops the session herdr's way,
// waits for the unit to go (stopping it as a last resort; it is ours) and
// deletes the session, also on failure.
func TestIntegrationSleepWake(t *testing.T) {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run is not installed")
	}
	s := startThrowaway(t)
	unit := wakeUnitCleanup(t, s)
	cwd := t.TempDir()
	for _, label := range []string{"CODE|it-sleep|1|r1", "notes"} {
		s.run("--session", s.name, "workspace", "create", "--cwd", cwd, "--label", label, "--no-focus")
	}

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
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: &herdr.Control{Herdr: s.bin, Only: only},
		})
	}()
	t.Cleanup(func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve: %v", err)
		}
	})
	<-ready

	world := func(ok func(proto.World) bool) proto.World {
		t.Helper()
		deadline := time.Now().Add(15 * time.Second)
		for {
			var out strings.Builder
			dctx, dcancel := context.WithTimeout(ctx, 10*time.Second)
			err := dumpMain(dctx, "herdr-world", []string{"-socket", sock, "-once"}, &out, io.Discard)
			dcancel()
			if err != nil {
				t.Fatal(err)
			}
			var snap proto.Snapshot
			if err := json.Unmarshal([]byte(out.String()), &snap); err != nil {
				t.Fatal(err)
			}
			if ok(snap.World) {
				return snap.World
			}
			if time.Now().After(deadline) {
				t.Fatalf("world never got there: %s", out.String())
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	state := func(want string, workers int) func(proto.World) bool {
		return func(w proto.World) bool {
			return len(w.Floors) == 1 && w.Floors[0].State == want && w.Floors[0].Transition == "" && len(w.Workers) == workers
		}
	}
	command := func(typ string) proto.Ack {
		t.Helper()
		var out strings.Builder
		cctx, ccancel := context.WithTimeout(ctx, time.Minute)
		defer ccancel()
		if err := cmdMain(cctx, "herdr-world", []string{"-socket", sock, typ, `{"session":"` + s.name + `"}`}, &out, io.Discard); err != nil {
			t.Fatalf("%s: %v: %s", typ, err, out.String())
		}
		var ack proto.Ack
		if err := json.Unmarshal([]byte(out.String()), &ack); err != nil {
			t.Fatal(err)
		}
		return ack
	}
	before := world(state("running", 2)).Workers

	command(proto.CmdFloorSleep)
	asleep := world(state("asleep", 2)).Workers
	sameDesks(t, "asleep", before, asleep)
	if unitActive(unit) {
		t.Fatalf("%s active before the wake", unit)
	}

	ack := command(proto.CmdFloorWake)
	// The ack comes after the floor is seen running.
	if w := world(func(proto.World) bool { return true }); w.Floors[0].State != "running" || w.Floors[0].Transition != "" {
		t.Errorf("floor right after the wake ack = %+v", w.Floors[0])
	}
	if !unitActive(unit) {
		t.Fatalf("no transient unit %s after the wake", unit)
	}
	raw, _ := json.Marshal(ack.Data)
	if want := `{"workers":[{"id":"` + before[0].ID + `","resume":"none"},{"id":"` + before[1].ID + `","resume":"none"}]}`; string(raw) != want {
		t.Errorf("wake ack = %s, want %s", raw, want)
	}
	sameDesks(t, "awake", before, world(state("running", 2)).Workers)
	// The woken server runs in the unit with a login environment, not ours.
	out, err := exec.Command("systemctl", "--user", "show", "-p", "MainPID", "--value", unit).Output()
	if err != nil {
		t.Fatal(err)
	}
	environ, err := os.ReadFile("/proc/" + strings.TrimSpace(string(out)) + "/environ")
	if err != nil {
		t.Fatal(err)
	}
	for _, kv := range strings.Split(string(environ), "\x00") {
		if strings.HasPrefix(kv, "CLAUDE") || strings.HasPrefix(kv, "HERDR_SOCKET_PATH=") {
			t.Errorf("woken server has %s", kv)
		}
	}
}

// wakeUnitCleanup registers the cleanup of the transient unit a bridge's
// wake starts the throwaway session's server in (herdr-s-<name>): stop the
// session herdr's way, wait for the unit to go (stopping it as a last
// resort; it is ours). It returns the unit's name.
func wakeUnitCleanup(t *testing.T, s *throwaway) string {
	unit := "herdr-s-" + s.name + ".service"
	t.Cleanup(func() {
		stop := exec.Command(s.bin, "session", "stop", s.name, "--json")
		stop.Env = s.env
		_ = stop.Run()
		for deadline := time.Now().Add(10 * time.Second); unitActive(unit) && time.Now().Before(deadline); {
			time.Sleep(100 * time.Millisecond)
		}
		if unitActive(unit) {
			t.Errorf("%s still active after herdr session stop; stopping the unit", unit)
			_ = exec.Command("systemctl", "--user", "stop", unit).Run()
		}
		_ = exec.Command("systemctl", "--user", "reset-failed", unit).Run()
		// --collect: the unit goes away once it is inactive.
		for deadline := time.Now().Add(10 * time.Second); unitLoaded(unit) && time.Now().Before(deadline); {
			time.Sleep(100 * time.Millisecond)
		}
		if unitLoaded(unit) {
			t.Errorf("transient unit %s is still loaded", unit)
		}
	})
	return unit
}

// unitLoaded reports whether systemd still knows a user unit.
func unitLoaded(unit string) bool {
	out, _ := exec.Command("systemctl", "--user", "show", "-p", "LoadState", "--value", unit).Output()
	return strings.TrimSpace(string(out)) != "not-found"
}

// unitActive reports whether a systemd user unit is active (or starting).
func unitActive(unit string) bool {
	out, _ := exec.Command("systemctl", "--user", "show", "-p", "ActiveState", "--value", unit).Output()
	st := strings.TrimSpace(string(out))
	return st == "active" || st == "activating" || st == "deactivating" || st == "reloading"
}
