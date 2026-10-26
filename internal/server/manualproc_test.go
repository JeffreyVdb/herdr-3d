package server_test

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"

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

func (f *fakeManual) CreateManualTab(_ context.Context, _, _, _, _ string) (herdr.ManualTab, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates++
	return herdr.ManualTab{TabID: "w1:t2", PaneID: "w1:p2"}, nil
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
	manual.Effects = fakeEffects{conflict: true}
	t.Cleanup(func() { manual.Effects = nil })
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
	manual.Effects = fakeEffects{}
	t.Cleanup(func() { manual.Effects = nil })
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
	fake := &fakeManual{}
	dir := t.TempDir()
	tb := startTermBridge(t, func(o *server.Options) { o.Manual = fake; o.ManualDir = dir; o.ManualShell = "/bin/bash" }, worker("w1", "agent", "", "idle"))
	c := tb.connect(proto.Hello{})
	id := idOf(t, c.snapshot(), "w1")
	c.mustError(proto.CmdManualProcessStart, proto.ManualProcessStartArgs{Op: "askpass", Worker: id, Cwd: dir, Command: "sudo id", Askpass: true}, proto.ErrManualBadArgs)
}
