//go:build integration

package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// This fixture never uses ambient Herdr configuration or a non-test session.
func TestIntegrationManualProcess(t *testing.T) {
	herdrBin, err := exec.LookPath("herdr")
	if err != nil {
		t.Skip("herdr unavailable")
	}
	base := os.Getenv("H3D_E2E_TMPDIR")
	if base == "" {
		base = os.TempDir()
	}
	root, err := os.MkdirTemp(base, "a-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			if data, err := os.ReadFile(filepath.Join(root, "herdr.log")); err == nil {
				t.Logf("isolated server log: %s", data)
			}
		}
		_ = os.RemoveAll(root)
	})
	for _, key := range []string{"XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"} {
		dir := filepath.Join(root, strings.ToLower(strings.TrimPrefix(key, "XDG_")))
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		t.Setenv(key, dir)
	}
	var random [5]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	session := "h3d207a-" + hex.EncodeToString(random[:])
	config := filepath.Join(root, "herdr.toml")
	if err := os.WriteFile(config, []byte("onboarding = false\n[terminal]\ndefault_shell = \"/bin/bash\"\nshell_mode = \"non_login\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_CONFIG_PATH", config)
	logPath := filepath.Join(root, "herdr.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	hs := exec.Command(herdrBin, "--session", session, "server")
	hs.Dir = root
	hs.Stdout = log
	hs.Stderr = log
	hs.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := hs.Start(); err != nil {
		t.Fatal(err)
	}
	hsDone := make(chan error, 1)
	go func() { hsDone <- hs.Wait() }()
	var processIDs []string
	t.Cleanup(func() {
		dirs, _ := os.ReadDir(filepath.Join(os.Getenv("XDG_STATE_HOME"), "herdr-world", "manual"))
		for _, d := range dirs {
			if d.IsDir() && strings.HasPrefix(d.Name(), "mp_") {
				processIDs = append(processIDs, d.Name())
			}
		}
		for _, id := range processIDs {
			ps, _ := manual.TaggedProcesses(id)
			for _, p := range ps {
				if manual.IdentityAlive(p.PID, p.StartTicks) {
					_ = syscall.Kill(p.PID, syscall.SIGKILL)
				}
			}
		}
		for _, args := range [][]string{{"session", "stop", session, "--json"}, {"session", "delete", session, "--json"}} {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = exec.CommandContext(ctx, herdrBin, args...).Run()
			cancel()
		}
		select {
		case <-hsDone:
		case <-time.After(4 * time.Second):
			_ = hs.Process.Kill()
			<-hsDone
		}
	})
	cli := func(args ...string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return exec.CommandContext(ctx, herdrBin, append([]string{"--session", session}, args...)...).CombinedOutput()
	}
	waitManual(t, 20*time.Second, func() bool { _, err := cli("workspace", "list"); return err == nil }, "herdr server")
	out, err := cli("workspace", "create", "--cwd", root, "--label", "manual owner", "--no-focus")
	if err != nil {
		t.Fatalf("create workspace: %v: %s", err, out)
	}
	var created struct {
		Result struct {
			Workspace struct {
				ID string `json:"workspace_id"`
			} `json:"workspace"`
			Root struct {
				ID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &created); err != nil || created.Result.Workspace.ID == "" {
		t.Fatalf("workspace: %s %v", out, err)
	}
	bridgeBin := filepath.Join(root, "herdr-world")
	build := exec.Command("go", "build", "-o", bridgeBin, "../../cmd/herdr-world")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build bridge: %v: %s", err, out)
	}
	sock := filepath.Join(root, "bridge.sock")
	db := filepath.Join(root, "world.db")
	var bridge *exec.Cmd
	var bridgeDone chan error
	startBridge := func() {
		bridge = exec.Command(bridgeBin, "serve", "--socket", sock, "--db", db, "--sessions", "^h3d207a-", "--poll", "200ms", "--no-limits", "--shell", "bash")
		bridge.Stdout = log
		bridge.Stderr = log
		if err := bridge.Start(); err != nil {
			t.Fatal(err)
		}
		bridgeDone = make(chan error, 1)
		go func(c *exec.Cmd, ch chan error) { ch <- c.Wait() }(bridge, bridgeDone)
		waitManual(t, 30*time.Second, func() bool {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			c, e := proto.Dial(ctx, sock)
			if e != nil {
				return false
			}
			_ = c.CloseNow()
			return true
		}, "private bridge")
	}
	stopBridge := func() {
		if bridge == nil {
			return
		}
		_ = bridge.Process.Signal(syscall.SIGTERM)
		select {
		case <-bridgeDone:
		case <-time.After(10 * time.Second):
			_ = bridge.Process.Kill()
			<-bridgeDone
		}
		bridge = nil
	}
	t.Cleanup(stopBridge)
	startBridge()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	snapshot := func() proto.World {
		c, err := proto.Dial(ctx, sock)
		if err != nil {
			return proto.World{}
		}
		defer c.CloseNow()
		if _, err := c.Hello(ctx, proto.Hello{Client: "manual-integration"}); err != nil {
			return proto.World{}
		}
		env, raw, err := c.Read(ctx)
		if err != nil || env.T != proto.TSnapshot {
			return proto.World{}
		}
		var snap proto.Snapshot
		_ = json.Unmarshal(raw, &snap)
		return snap.World
	}
	var worker proto.Worker
	waitManual(t, 30*time.Second, func() bool {
		for _, w := range snapshot().Workers {
			if w.WorkspaceID == created.Result.Workspace.ID {
				worker = w
				return true
			}
		}
		return false
	}, "worker")
	if worker.PaneID != created.Result.Root.ID {
		t.Fatalf("owner pane changed: %+v", worker)
	}
	send := func(typ string, args any) proto.ManualProcess {
		c, err := proto.Dial(ctx, sock)
		if err != nil {
			t.Fatal(err)
		}
		defer c.CloseNow()
		if _, err := c.Hello(ctx, proto.Hello{Client: "manual-integration"}); err != nil {
			t.Fatal(err)
		}
		if _, _, err := c.Read(ctx); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(args)
		if err := c.Send(ctx, proto.Command{T: typ, ReqID: "request", Args: raw}); err != nil {
			t.Fatal(err)
		}
		for {
			env, b, err := c.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if env.ReqID != "request" {
				continue
			}
			if env.T != proto.TAck {
				t.Fatalf("%s: %s", typ, b)
			}
			var result struct {
				Data proto.ManualProcessResult `json:"data"`
			}
			if err := json.Unmarshal(b, &result); err != nil {
				t.Fatal(err)
			}
			return result.Data.Process
		}
	}
	start := func(op, command string) proto.ManualProcess {
		p := send(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: op, Worker: worker.ID, Cwd: root, Command: command})
		processIDs = append(processIDs, p.ID)
		return p
	}
	state := func(id string, predicate func(proto.ManualProcess) bool) proto.ManualProcess {
		var result proto.ManualProcess
		waitManual(t, 25*time.Second, func() bool {
			for _, p := range snapshot().ManualProcesses {
				if p.ID == id {
					result = p
					return predicate(p)
				}
			}
			return false
		}, "process "+id)
		return result
	}
	childFile := filepath.Join(root, "child.pid")
	first := start("ordinary", fmt.Sprintf("sleep 120 & echo $! > %q; wait", childFile))
	state(first.ID, func(p proto.ManualProcess) bool { return p.State == "running" })
	waitManual(t, 10*time.Second, func() bool { _, err := os.Stat(childFile); return err == nil }, "child pid")
	bytes, err := os.ReadFile(childFile)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(string(bytes)))
	if err != nil {
		t.Fatal(err)
	}
	childTicks, err := manual.StartTicks(childPID)
	if err != nil {
		t.Fatal(err)
	}
	stopped := send(proto.CmdManualProcessStop, proto.ManualProcessIDArgs{ID: first.ID})
	if stopped.State != "stopped" || stopped.Cleanup != "done" {
		t.Fatalf("stop: %+v", stopped)
	}
	if manual.IdentityAlive(childPID, childTicks) {
		t.Fatal("ordinary child survived stop")
	}
	detachedFile := filepath.Join(root, "detached.pid")
	detached := start("detached", fmt.Sprintf("setsid sh -c 'trap \"\" HUP; echo $$ > %s; exec sleep 120' </dev/null >/dev/null 2>&1 & wait", detachedFile))
	state(detached.ID, func(p proto.ManualProcess) bool { return p.State == "running" })
	waitManual(t, 10*time.Second, func() bool { _, err := os.Stat(detachedFile); return err == nil }, "detached pid")
	bytes, err = os.ReadFile(detachedFile)
	if err != nil {
		t.Fatal(err)
	}
	detachedPID, err := strconv.Atoi(strings.TrimSpace(string(bytes)))
	if err != nil {
		t.Fatal(err)
	}
	detachedTicks, err := manual.StartTicks(detachedPID)
	if err != nil {
		t.Fatal(err)
	}
	result := send(proto.CmdManualProcessStop, proto.ManualProcessIDArgs{ID: detached.ID})
	if result.Cleanup != "needed" || !strings.Contains(result.CleanupNote, strconv.Itoa(detachedPID)) {
		t.Fatalf("detached cleanup: %+v", result)
	}
	result = send(proto.CmdManualProcessStop, proto.ManualProcessIDArgs{ID: detached.ID})
	if result.Cleanup != "done" || manual.IdentityAlive(detachedPID, detachedTicks) {
		t.Fatalf("detached retry: %+v", result)
	}
	closed := start("external", "sleep 120")
	state(closed.ID, func(p proto.ManualProcess) bool { return p.State == "running" })
	if out, err := cli("tab", "close", closed.TabID); err != nil {
		t.Fatalf("external close: %s %v", out, err)
	}
	state(closed.ID, func(p proto.ManualProcess) bool { return p.State == "stopped" })
	restart := start("restart", "sleep 120")
	before := state(restart.ID, func(p proto.ManualProcess) bool { return p.State == "running" })
	oldStatus, err := manual.ReadStatus(filepath.Join(os.Getenv("XDG_STATE_HOME"), "herdr-world", "manual", before.ID))
	if err != nil {
		t.Fatal(err)
	}
	stopBridge()
	startBridge()
	after := state(restart.ID, func(p proto.ManualProcess) bool { return p.State == "running" })
	newStatus, err := manual.ReadStatus(filepath.Join(os.Getenv("XDG_STATE_HOME"), "herdr-world", "manual", after.ID))
	if err != nil || oldStatus.PID != newStatus.PID || oldStatus.StartTicks != newStatus.StartTicks {
		t.Fatalf("restart relaunched: %+v %+v %v", oldStatus, newStatus, err)
	}
	send(proto.CmdManualProcessStop, proto.ManualProcessIDArgs{ID: restart.ID})
	if !regexp.MustCompile(`^h3d207a-[0-9a-f]+$`).MatchString(session) {
		t.Fatal("unexpected session name")
	}
}

func waitManual(t *testing.T, timeout time.Duration, fn func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
