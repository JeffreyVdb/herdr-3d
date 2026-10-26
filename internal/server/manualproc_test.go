package server_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

type fakeManual struct {
	mu                sync.Mutex
	creates, launches int
}

func (f *fakeManual) CreateManualTab(_ context.Context, _, _, _, _ string) (herdr.ManualTab, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.creates++
	return herdr.ManualTab{TabID: "w1:t2", PaneID: "w1:p2"}, nil
}
func (f *fakeManual) CloseManualTab(context.Context, string, string) error { return nil }
func (f *fakeManual) LaunchManual(context.Context, string, string, string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.launches++
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
