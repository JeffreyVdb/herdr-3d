package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

type fakeManual struct {
	mu                sync.Mutex
	creates, launches int
	closed            []string
	onLaunch          func(string) error
}

func (f *fakeManual) CreateManualTab(_ context.Context, _, workspace, _, _ string) (herdr.ManualTab, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates++
	return herdr.ManualTab{TabID: workspace + ":t2", PaneID: workspace + ":p2"}, nil
}
func (f *fakeManual) CloseManualTab(_ context.Context, _, tab string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = append(f.closed, tab)
	return nil
}
func (f *fakeManual) LaunchManual(_ context.Context, _, _, dir string) error {
	f.mu.Lock()
	f.launches++
	fn := f.onLaunch
	f.mu.Unlock()
	if fn != nil {
		return fn(dir)
	}
	return nil
}

func TestManualStartIdempotentAndAudit(t *testing.T) {
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	}, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := idOf(t, snap, "w1")
	original := snap.World.Workers[0].PaneID
	args := proto.ManualProcessStartArgs{Op: "same-op", Worker: id, Command: "echo private-command-marker", Cwd: dir}
	_, m := c.command(proto.CmdManualProcessStart, "start", args)
	if m.env.T != proto.TAck {
		t.Fatalf("start: %s", m.raw)
	}
	first := ackData[proto.ManualProcessResult](t, m).Process
	_, m = c.command(proto.CmdManualProcessStart, "retry", args)
	if m.env.T != proto.TAck || ackData[proto.ManualProcessResult](t, m).Process.ID != first.ID {
		t.Fatalf("retry: %s", m.raw)
	}
	fake.mu.Lock()
	creates, launches := fake.creates, fake.launches
	fake.mu.Unlock()
	if creates != 1 || launches != 1 {
		t.Fatalf("calls: %d %d", creates, launches)
	}
	if got := tb.connect(proto.Hello{}).snapshot().World.Workers[0].PaneID; got != original {
		t.Fatalf("worker pane changed: %s", got)
	}
	zero := 0
	if err := manual.WriteStatus(filepath.Join(dir, first.ID), manual.Status{PID: 99999999, StartTicks: 123, ExitCode: &zero, EndedAt: 1}); err != nil {
		t.Fatal(err)
	}
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == first.ID {
				return p.State == "exited"
			}
		}
		return false
	})
	c.mustAck(proto.CmdManualProcessDismiss, proto.ManualProcessIDArgs{ID: first.ID})
	_, m = c.command(proto.CmdManualProcessStart, "retry-dismissed", args)
	if ackData[proto.ManualProcessResult](t, m).Process.ID != first.ID {
		t.Fatal("dismissed op launched twice")
	}
	if len(tb.connect(proto.Hello{}).snapshot().World.ManualProcesses) != 0 {
		t.Fatal("dismissed process remains visible")
	}
	fake.mu.Lock()
	launches = fake.launches
	fake.mu.Unlock()
	if launches != 1 {
		t.Fatalf("duplicate launches: %d", launches)
	}
	rows, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Cmd == proto.CmdManualProcessStart && (strings.Contains(row.Args, args.Command) || !strings.Contains(row.Args, "command_sha256_prefix")) {
			t.Fatalf("audit: %s", row.Args)
		}
	}
}

func TestManualSuggestionMustBeCurrent(t *testing.T) {
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) { o.Manual = fake; o.ManualDir = dir; o.ManualShell = "/bin/bash" }, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "stale", Worker: id, Cwd: dir, Command: "echo stale", Source: &proto.ManualSource{Kind: "suggestion", Key: "old"}}, proto.ErrStale)
}

type fakeEffects struct{ conflict bool }

func (f fakeEffects) Parse(command string) (proto.ManualEffect, bool) {
	if !strings.Contains(command, "tailscale serve --bg") {
		return proto.ManualEffect{}, false
	}
	return proto.ManualEffect{Kind: "tailscale_serve", Endpoint: "https:8443"}, true
}
func (f fakeEffects) Conflict(_ []byte, _ proto.ManualEffect) (bool, error) { return f.conflict, nil }
func (f fakeEffects) CleanupCommand(proto.ManualEffect) string {
	return "tailscale serve --bg --https=8443 off"
}

func TestManualEffectConflictDoesNotLaunch(t *testing.T) {
	previous := manual.Effects
	manual.Effects = fakeEffects{conflict: true}
	t.Cleanup(func() { manual.Effects = previous })
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
		o.ManualEffectStatus = func(context.Context) ([]byte, error) { return []byte(`{"TCP":{"8443":{}}}`), nil }
	}, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, m := c.command(proto.CmdManualProcessStart, "start-conflict", proto.ManualProcessStartArgs{Op: "conflict", Worker: id, Cwd: dir, Command: "tailscale serve --bg --https=8443 http://127.0.0.1:9999"})
	p := ackData[proto.ManualProcessResult](t, m).Process
	if p.State != "failed" || !strings.Contains(p.Error, "already served") || len(p.Effects) != 1 || p.Effects[0].State != "conflict" {
		t.Fatalf("process: %+v", p)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.launches != 0 || fake.creates != 0 {
		t.Fatalf("unexpected launch")
	}
}

func TestManualRestrictedServerDoesNotLaunch(t *testing.T) {
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return true, nil }
	}, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, m := c.command(proto.CmdManualProcessStart, "restricted", proto.ManualProcessStartArgs{Op: "restricted", Worker: id, Cwd: dir, Command: "echo test"})
	p := ackData[proto.ManualProcessResult](t, m).Process
	if p.State != "failed" || !strings.Contains(p.Error, "NoNewPrivileges") {
		t.Fatalf("process: %+v", p)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.launches != 0 || fake.creates != 0 {
		t.Fatal("restricted server launched")
	}
}

func TestManualSendHomeRefusesUnverifiedProcess(t *testing.T) {
	fake := &fakeManual{}
	dir := t.TempDir()
	hb := startHireBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	}, worker("w1", "notes", "", "idle"))
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")
	_, m := hb.c.command(proto.CmdManualProcessStart, "start-manual", proto.ManualProcessStartArgs{Op: "uncertain", Worker: ws["w1"].ID, Cwd: dir, Command: "sleep 10"})
	_ = ackData[proto.ManualProcessResult](t, m)
	_, m = hb.c.command(proto.CmdWorkerFire, "send-home", proto.WorkerFireArgs{ID: ws["w1"].ID})
	if m.env.T != proto.TError || !strings.Contains(string(m.raw), "nothing was closed") {
		t.Fatalf("send-home: %s", m.raw)
	}
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("agent/workspace touched: %v", calls)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.closed) != 0 {
		t.Fatalf("manual tab closed: %v", fake.closed)
	}
}

func TestManualSleepStopsAndWakeClosesRestoredTabs(t *testing.T) {
	fake := &fakeManual{onLaunch: func(dir string) error {
		return manual.WriteStatus(dir, manual.Status{PID: 99999999, StartTicks: 123, PGID: 99999999, StartedAt: 1})
	}}
	dir := t.TempDir()
	fh := newFakeHerdr()
	opts := fastOps(fh)
	opts.Manual = fake
	opts.ManualDir = dir
	opts.ManualShell = "/bin/bash"
	opts.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	opts.ManualSnapshot = func(context.Context, string) (*herdr.Snapshot, error) {
		return &herdr.Snapshot{Tabs: []herdr.TabInfo{{TabID: "w1:t2", WorkspaceID: "w1", Label: "⚙ command"}, {TabID: "w1:t3", WorkspaceID: "w1", Label: "notes"}}, Panes: []herdr.PaneInfo{{PaneID: "w1:p2", TabID: "w1:t2", WorkspaceID: "w1"}}}, nil
	}
	b := startBridge(t, "", opts)
	workers := []world.WorkerObs{worker("w1", "notes", "", "idle")}
	b.floorAt("s", true, workers)
	c := b.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, m := c.command(proto.CmdManualProcessStart, "manual", proto.ManualProcessStartArgs{Op: "sleep-test", Worker: id, Cwd: dir, Command: "echo hi"})
	p := ackData[proto.ManualProcessResult](t, m).Process
	fh.onStop = func() {
		fake.mu.Lock()
		n := len(fake.closed)
		fake.mu.Unlock()
		if n == 0 {
			t.Error("session stopped before manual tab")
		}
		b.floorAt("s", false, withStatus(workers, "unknown"))
	}
	c.mustAck(proto.CmdFloorSleep, proto.FloorArgs{Session: "s"})
	w := b.world(func(w proto.World) bool {
		for _, v := range w.ManualProcesses {
			if v.ID == p.ID {
				return v.State == "stopped" && strings.Contains(v.CleanupNote, "floor sleep")
			}
		}
		return false
	})
	_ = w
	fh.onStart = func() { fh.setUp("sock-s", true); b.floorAt("s", true, workers) }
	c.mustAck(proto.CmdFloorWake, proto.FloorArgs{Session: "s"})
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.closed) < 2 || fake.closed[len(fake.closed)-1] != "w1:t2" || fake.launches != 1 {
		t.Fatalf("wake calls: closed=%v launches=%d", fake.closed, fake.launches)
	}
}

func TestManualEffectCleanupNeedsSuccessfulExit(t *testing.T) {
	previous := manual.Effects
	manual.Effects = fakeEffects{}
	t.Cleanup(func() { manual.Effects = previous })
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
		o.ManualEffectStatus = func(context.Context) ([]byte, error) { return []byte(`{}`), nil }
	}, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, m := c.command(proto.CmdManualProcessStart, "bg", proto.ManualProcessStartArgs{Op: "bg", Worker: id, Cwd: dir, Command: "tailscale serve --bg --https=8443 http://127.0.0.1:9999"})
	parent := ackData[proto.ManualProcessResult](t, m).Process
	zero := 0
	if err := manual.WriteStatus(filepath.Join(dir, parent.ID), manual.Status{PID: 99999999, StartTicks: 123, StartedAt: 1, ExitCode: &zero, EndedAt: 2}); err != nil {
		t.Fatal(err)
	}
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.State == "exited" && p.Cleanup == "needed"
			}
		}
		return false
	})
	_, m = c.command(proto.CmdManualProcessStop, "cleanup", proto.ManualProcessIDArgs{ID: parent.ID})
	result := ackData[proto.ManualProcessResult](t, m).Process
	if result.Cleanup != "needed" {
		t.Fatalf("cleanup prematurely done: %+v", result)
	}
	var child proto.ManualProcess
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID != parent.ID && strings.HasPrefix(p.Op, "cleanup_") {
				child = p
				return true
			}
		}
		return false
	})
	one := 1
	if err := manual.WriteStatus(filepath.Join(dir, child.ID), manual.Status{PID: 99999998, StartTicks: 124, StartedAt: 3, ExitCode: &one, EndedAt: 4}); err != nil {
		t.Fatal(err)
	}
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.Cleanup == "failed" && p.Effects[0].State == "active"
			}
		}
		return false
	})
	firstChild := child.ID
	_, m = c.command(proto.CmdManualProcessStop, "retry-cleanup", proto.ManualProcessIDArgs{ID: parent.ID})
	result = ackData[proto.ManualProcessResult](t, m).Process
	if result.Cleanup != "needed" {
		t.Fatalf("retry: %+v", result)
	}
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID != firstChild && p.ID != parent.ID && strings.HasPrefix(p.Op, "cleanup_") {
				child = p
				return true
			}
		}
		return false
	})
	if err := manual.WriteStatus(filepath.Join(dir, child.ID), manual.Status{PID: 99999997, StartTicks: 125, StartedAt: 5, ExitCode: &zero, EndedAt: 6}); err != nil {
		t.Fatal(err)
	}
	w := tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.Cleanup == "done" && len(p.Effects) == 1 && p.Effects[0].State == "removed"
			}
		}
		return false
	})
	_ = w
}

func TestManualAskpassRequiresAdapter(t *testing.T) {
	rewrite, env := manual.AskpassRewrite, manual.AskpassEnv
	manual.AskpassRewrite, manual.AskpassEnv = nil, nil
	t.Cleanup(func() { manual.AskpassRewrite, manual.AskpassEnv = rewrite, env })
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) { o.Manual = fake; o.ManualDir = dir; o.ManualShell = "/bin/bash" }, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "askpass", Worker: id, Cwd: dir, Command: "sudo id", Askpass: true}, proto.ErrManualBadArgs)
}

func TestManualEffectCleanupAfterOwnerGone(t *testing.T) {
	previous := manual.Effects
	manual.Effects = fakeEffects{}
	t.Cleanup(func() { manual.Effects = previous })
	fake := &fakeManual{}
	dir := t.TempDir()
	hb := startHireBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
		o.ManualEffectStatus = func(context.Context) ([]byte, error) { return []byte(`{}`), nil }
	}, worker("w1", "notes", "", "idle"))
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")
	_, m := hb.c.command(proto.CmdManualProcessStart, "bg-owner", proto.ManualProcessStartArgs{Op: "bg-owner", Worker: ws["w1"].ID, Cwd: dir, Command: "tailscale serve --bg --https=8443 http://127.0.0.1:9999"})
	parent := ackData[proto.ManualProcessResult](t, m).Process
	zero := 0
	if err := manual.WriteStatus(filepath.Join(dir, parent.ID), manual.Status{PID: 99999999, StartTicks: 123, ExitCode: &zero, EndedAt: 1}); err != nil {
		t.Fatal(err)
	}
	hb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.State == "exited" && p.Cleanup == "needed"
			}
		}
		return false
	})
	hb.fl.close("w1")
	hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 0 })
	_, m = hb.c.command(proto.CmdManualProcessStop, "cleanup-gone", proto.ManualProcessIDArgs{ID: parent.ID})
	result := ackData[proto.ManualProcessResult](t, m).Process
	if result.Cleanup != "needed" {
		t.Fatalf("cleanup: %+v", result)
	}
	var child proto.ManualProcess
	hb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID != parent.ID && strings.HasPrefix(p.Op, "cleanup_") {
				child = p
				return true
			}
		}
		return false
	})
	if child.WorkspaceID == parent.WorkspaceID {
		t.Fatalf("cleanup reused vanished workspace: %+v", child)
	}
	if err := manual.WriteStatus(filepath.Join(dir, child.ID), manual.Status{PID: 99999998, StartTicks: 124, ExitCode: &zero, EndedAt: 2}); err != nil {
		t.Fatal(err)
	}
	hb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.Cleanup == "done"
			}
		}
		return false
	})
	calls := strings.Join(hb.fl.Calls(), "\n")
	if !strings.Contains(calls, "manual cleanup") || !strings.Contains(calls, "close "+child.WorkspaceID) {
		t.Fatalf("cleanup workspace calls: %s", calls)
	}
}

func TestManualBackgroundServeNeedsAdapter(t *testing.T) {
	previous := manual.Effects
	manual.Effects = nil
	t.Cleanup(func() { manual.Effects = previous })
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) { o.Manual = fake; o.ManualDir = dir; o.ManualShell = "/bin/bash" }, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "bg-unavailable", Worker: id, Cwd: dir, Command: "sudo tailscale serve --bg --https=8443 http://127.0.0.1:1"}, proto.ErrUnsupported)
}

func TestManualConcurrentOpDoesNotLaunchTwice(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	fake := &fakeManual{onLaunch: func(string) error { close(entered); <-release; return nil }}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	}, worker("w1", "agent", "", "idle"))
	first := tb.connect(proto.Hello{})
	id := idOf(t, first.snapshot(), "w1")
	second := tb.connect(proto.Hello{})
	second.snapshot()
	args := proto.ManualProcessStartArgs{Op: "simultaneous", Worker: id, Cwd: dir, Command: "echo once"}
	raw, _ := json.Marshal(args)
	first.send(proto.Command{T: proto.CmdManualProcessStart, ReqID: "first", Args: raw})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("launch did not begin")
	}
	_, m := second.command(proto.CmdManualProcessStart, "second", args)
	secondResult := ackData[proto.ManualProcessResult](t, m).Process
	once.Do(func() { close(release) })
	for {
		m = first.next()
		if m.env.ReqID == "first" {
			break
		}
	}
	firstResult := ackData[proto.ManualProcessResult](t, m).Process
	fake.mu.Lock()
	calls := fake.launches
	fake.mu.Unlock()
	if firstResult.ID != secondResult.ID || calls != 1 {
		t.Fatalf("results: %s %s, launches %d", firstResult.ID, secondResult.ID, calls)
	}
}

func TestManualEffectCleanupReportsUncertainLaunch(t *testing.T) {
	previous := manual.Effects
	manual.Effects = fakeEffects{}
	t.Cleanup(func() { manual.Effects = previous })
	var calls atomic.Int32
	fake := &fakeManual{onLaunch: func(string) error {
		if calls.Add(1) == 2 {
			return errors.New("ambiguous launch")
		}
		return nil
	}}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
		o.ManualEffectStatus = func(context.Context) ([]byte, error) { return []byte(`{}`), nil }
	}, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, m := c.command(proto.CmdManualProcessStart, "bg", proto.ManualProcessStartArgs{Op: "uncertain-effect", Worker: id, Cwd: dir, Command: "tailscale serve --bg --https=8443 http://127.0.0.1:9999"})
	parent := ackData[proto.ManualProcessResult](t, m).Process
	zero := 0
	if err := manual.WriteStatus(filepath.Join(dir, parent.ID), manual.Status{PID: 99999999, StartTicks: 123, ExitCode: &zero, EndedAt: 1}); err != nil {
		t.Fatal(err)
	}
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.State == "exited" && p.Cleanup == "needed"
			}
		}
		return false
	})
	_, m = c.command(proto.CmdManualProcessStop, "cleanup", proto.ManualProcessIDArgs{ID: parent.ID})
	got := ackData[proto.ManualProcessResult](t, m).Process
	if got.Cleanup != "needed" || !strings.Contains(got.CleanupNote, "uncertain launch") {
		t.Fatalf("cleanup: %+v", got)
	}
}

func TestManualAuditSurvivesClientDisconnect(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	fake := &fakeManual{onLaunch: func(string) error { close(entered); <-release; return nil }}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	}, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	command := "echo private-disconnect-marker"
	args, _ := json.Marshal(proto.ManualProcessStartArgs{Op: "disconnect", Worker: id, Cwd: dir, Command: command})
	c.send(proto.Command{T: proto.CmdManualProcessStart, ReqID: "disconnect", Args: args})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("launch did not start")
	}
	rows, err := tb.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range rows {
		if row.Cmd == proto.CmdManualProcessStart {
			found = true
			if row.Done || strings.Contains(row.Args, command) {
				t.Fatalf("in-flight audit: %+v", row)
			}
		}
	}
	if !found {
		t.Fatal("accepted command was not audited")
	}
	_ = c.conn.CloseNow()
	once.Do(func() { close(release) })
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		rows, err = tb.st.AuditLog(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if row.Cmd == proto.CmdManualProcessStart && row.Done {
				if !row.OK || strings.Contains(row.Args, command) || strings.Contains(row.Result, command) {
					t.Fatalf("completed audit: %+v", row)
				}
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("audit did not complete after disconnect")
}

type cleanupGateHire struct {
	server.HireHerdr
	entered, release chan struct{}
	once             sync.Once
}

func (g *cleanupGateHire) CloseWorkspace(ctx context.Context, session, workspace string) error {
	if workspace != "w1" {
		g.once.Do(func() { close(g.entered) })
		select {
		case <-g.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return g.HireHerdr.CloseWorkspace(ctx, session, workspace)
}

func TestManualEffectCleanupDoesNotDuplicateWhileCompleting(t *testing.T) {
	previous := manual.Effects
	manual.Effects = fakeEffects{}
	t.Cleanup(func() { manual.Effects = previous })
	fake := &fakeManual{}
	dir := t.TempDir()
	gate := &cleanupGateHire{entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(gate.release) })
	hb := startHireBridge(t, func(o *server.Options) {
		gate.HireHerdr = o.Hire
		o.Hire = gate
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
		o.ManualEffectStatus = func(context.Context) ([]byte, error) { return []byte(`{}`), nil }
	}, worker("w1", "notes", "", "idle"))
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")
	_, m := hb.c.command(proto.CmdManualProcessStart, "bg", proto.ManualProcessStartArgs{Op: "bg-concurrent", Worker: ws["w1"].ID, Cwd: dir, Command: "tailscale serve --bg --https=8443 http://127.0.0.1:9999"})
	parent := ackData[proto.ManualProcessResult](t, m).Process
	zero := 0
	if err := manual.WriteStatus(filepath.Join(dir, parent.ID), manual.Status{PID: 99999999, StartTicks: 123, ExitCode: &zero, EndedAt: 1}); err != nil {
		t.Fatal(err)
	}
	hb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.State == "exited" && p.Cleanup == "needed"
			}
		}
		return false
	})
	hb.fl.close("w1")
	hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 0 })
	hb.c.mustAck(proto.CmdManualProcessStop, proto.ManualProcessIDArgs{ID: parent.ID})
	var child proto.ManualProcess
	hb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID != parent.ID && strings.HasPrefix(p.Op, "cleanup_") {
				child = p
				return true
			}
		}
		return false
	})
	c := hb.connect(proto.Hello{})
	c.snapshot()
	if err := manual.WriteStatus(filepath.Join(dir, child.ID), manual.Status{PID: 99999998, StartTicks: 124, ExitCode: &zero, EndedAt: 2}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup did not reach workspace close")
	}
	raw, _ := json.Marshal(proto.ManualProcessIDArgs{ID: parent.ID})
	c.send(proto.Command{T: proto.CmdManualProcessStop, ReqID: "again", Args: raw})
	release.Do(func() { close(gate.release) })
	for {
		m = c.next()
		if m.env.ReqID == "again" {
			break
		}
	}
	got := ackData[proto.ManualProcessResult](t, m).Process
	if got.Cleanup != "done" {
		t.Fatalf("cleanup: %+v", got)
	}
	fake.mu.Lock()
	calls := fake.launches
	fake.mu.Unlock()
	if calls != 2 {
		t.Fatalf("expected one process and one cleanup, got %d launches", calls)
	}
}

type manualFireGate struct {
	server.FloorHerdr
	entered, release chan struct{}
	once             sync.Once
}

func (g *manualFireGate) PaneProcesses(ctx context.Context, session, pane string) (*herdr.ProcessInfo, error) {
	g.once.Do(func() { close(g.entered) })
	select {
	case <-g.release:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return g.FloorHerdr.PaneProcesses(ctx, session, pane)
}

func TestManualStartRefusedWhileSendHomeIsPending(t *testing.T) {
	gate := &manualFireGate{entered: make(chan struct{}), release: make(chan struct{})}
	var release sync.Once
	defer release.Do(func() { close(gate.release) })
	fake := &fakeManual{}
	dir := t.TempDir()
	hb := startHireBridge(t, func(o *server.Options) {
		gate.FloorHerdr = o.Herdr
		o.Herdr = gate
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	}, worker("w1", "notes", "", "idle"))
	hb.fl.setProcs("w1:p1", atShell())
	ws := workersOf(hb.world(func(w proto.World) bool { return len(workersOf(w, "s")) == 1 }), "s")
	id := ws["w1"].ID
	c := hb.connect(proto.Hello{})
	c.snapshot()
	raw, _ := json.Marshal(proto.WorkerFireArgs{ID: id})
	hb.c.send(proto.Command{T: proto.CmdWorkerFire, ReqID: "fire-pending", Args: raw})
	select {
	case <-gate.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("send-home did not reach its exit check")
	}
	c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "during-fire", Worker: id, Cwd: dir, Command: "echo race"}, proto.ErrBusy)
	release.Do(func() { close(gate.release) })
	for {
		m := hb.c.next()
		if m.env.ReqID == "fire-pending" {
			if m.env.T != proto.TAck {
				t.Fatalf("send-home: %s", m.raw)
			}
			break
		}
	}
	fake.mu.Lock()
	calls := fake.launches
	fake.mu.Unlock()
	if calls != 0 {
		t.Fatalf("manual process launched during send-home")
	}
}

func TestManualRetrySignalsOnlyPreviouslyReportedDescendants(t *testing.T) {
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) {
		o.Manual = fake
		o.ManualDir = dir
		o.ManualShell = "/bin/bash"
		o.ManualNoNewPrivs = func(context.Context, string) (bool, error) { return false, nil }
	}, worker("w1", "notes", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	_, m := c.command(proto.CmdManualProcessStart, "start", proto.ManualProcessStartArgs{Op: "survivors", Worker: id, Cwd: dir, Command: "echo fixture"})
	parent := ackData[proto.ManualProcessResult](t, m).Process
	start := func() manual.Identity {
		cmd := exec.Command("sleep", "120")
		cmd.Env = append(os.Environ(), "H3D_MANUAL_PROCESS="+parent.ID)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		ticks, err := manual.StartTicks(cmd.Process.Pid)
		if err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			t.Fatal(err)
		}
		p := manual.Identity{PID: cmd.Process.Pid, StartTicks: ticks}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		t.Cleanup(func() {
			if manual.IdentityAlive(p.PID, p.StartTicks) {
				_ = syscall.Kill(p.PID, syscall.SIGKILL)
			}
			<-done
		})
		return p
	}
	first := start()
	zero := 0
	if err := manual.WriteStatus(filepath.Join(dir, parent.ID), manual.Status{PID: 99999999, StartTicks: 1, ExitCode: &zero, EndedAt: 1}); err != nil {
		t.Fatal(err)
	}
	tb.world(func(w proto.World) bool {
		for _, p := range w.ManualProcesses {
			if p.ID == parent.ID {
				return p.Cleanup == "needed" && strings.Contains(p.CleanupNote, fmt.Sprint(first.PID))
			}
		}
		return false
	})
	second := start()
	_, m = c.command(proto.CmdManualProcessStop, "retry-first", proto.ManualProcessIDArgs{ID: parent.ID})
	after := ackData[proto.ManualProcessResult](t, m).Process
	if manual.IdentityAlive(first.PID, first.StartTicks) || !manual.IdentityAlive(second.PID, second.StartTicks) || after.Cleanup != "needed" || !strings.Contains(after.CleanupNote, fmt.Sprint(second.PID)) {
		t.Fatalf("first retry: %+v", after)
	}
	_, m = c.command(proto.CmdManualProcessStop, "retry-second", proto.ManualProcessIDArgs{ID: parent.ID})
	after = ackData[proto.ManualProcessResult](t, m).Process
	if manual.IdentityAlive(second.PID, second.StartTicks) || after.Cleanup != "done" {
		t.Fatalf("second retry: %+v", after)
	}
}
