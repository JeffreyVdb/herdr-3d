package server_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// fakeCatalog plays harness.Catalog: a list per harness, recording each ask.
type fakeCatalog struct {
	mu   sync.Mutex
	asks []string // "harness dir"
	fail bool
}

func (f *fakeCatalog) Commands(_ context.Context, harness, dir string) (*proto.WorkerCommands, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asks = append(f.asks, harness+" "+dir)
	if f.fail {
		return nil, errors.New("no command catalog")
	}
	return &proto.WorkerCommands{Commands: []proto.CommandEntry{{Name: harness + "-skill", Kind: proto.CommandKindSkill}}}, nil
}

func TestWorkerCommands(t *testing.T) {
	fc := &fakeCatalog{}
	b := startBridge(t, "", server.Options{Commands: fc})
	c := b.connect(proto.Hello{})
	c.snapshot()
	cl := worker("w1", "a", "", "idle")
	cl.AgentKind = "claude"
	cx := worker("w2", "b", "", "idle")
	cx.Harness = "codex"
	cx.Worktree = &proto.Worktree{RepoRoot: "/home/u/repo", CheckoutPath: "/home/u/repo-wt", Linked: true}
	shell := worker("w3", "c", "", "idle")
	asleep := worker("w4", "d", "", "unknown")
	asleep.AgentKind = "claude"
	b.floor("s1", true, cl, cx, shell)
	b.floor("s2", false, asleep)
	ids := map[string]string{}
	for len(ids) < 4 {
		if ev := c.event(); ev.T == proto.EvWorkerUpsert {
			ids[ev.Worker.WorkspaceID] = ev.Worker.ID
		}
	}

	_, m := c.command(proto.CmdWorkerCommands, "c1", proto.WorkerArgs{ID: ids["w1"]})
	got := ackData[proto.WorkerCommands](t, m)
	if len(got.Commands) != 1 || got.Commands[0].Name != "claude-skill" || got.Partial {
		t.Fatalf("claude ack = %+v", got)
	}
	if !strings.Contains(string(m.raw), `"commands":[{"name":"claude-skill","description":"","argument_hint":"","kind":"skill"}],"partial":false`) {
		t.Errorf("shape: %s", m.raw)
	}
	_, m = c.command(proto.CmdWorkerCommands, "c2", proto.WorkerArgs{ID: ids["w2"]})
	if got := ackData[proto.WorkerCommands](t, m); got.Commands[0].Name != "codex-skill" {
		t.Fatalf("codex ack = %+v", got)
	}

	c.mustError(proto.CmdWorkerCommands, proto.WorkerArgs{ID: "nope"}, proto.ErrUnknownWorker)
	c.mustError(proto.CmdWorkerCommands, proto.WorkerArgs{ID: ids["w3"]}, proto.ErrInvalidState) // a plain shell
	c.mustError(proto.CmdWorkerCommands, proto.WorkerArgs{ID: ids["w4"]}, proto.ErrInvalidState) // floor asleep
	c.mustError(proto.CmdWorkerCommands, map[string]any{"id": ids["w1"], "cwd": "/etc"}, proto.ErrBadRequest)

	// The worker's harness, in its checkout (a worktree's, not its cwd).
	fc.mu.Lock()
	asks := strings.Join(fc.asks, ", ")
	fc.mu.Unlock()
	if asks != "claude /home/u/w1, codex /home/u/repo-wt" {
		t.Errorf("asks = %q", asks)
	}
	if row := auditRow(t, b, proto.CmdWorkerCommands); !row.Done || row.OK {
		t.Errorf("audit = %+v", row)
	}

	// A catalog failure: internal.
	fc.mu.Lock()
	fc.fail = true
	fc.mu.Unlock()
	c.mustError(proto.CmdWorkerCommands, proto.WorkerArgs{ID: ids["w1"]}, proto.ErrInternal)

	// Not configured: internal.
	b2 := startBridge(t, "", server.Options{})
	c2 := b2.connect(proto.Hello{})
	c2.snapshot()
	w := worker("w1", "a", "", "idle")
	w.AgentKind = "codex"
	b2.floor("s1", true, w)
	c2.mustError(proto.CmdWorkerCommands, proto.WorkerArgs{ID: c2.until(proto.EvWorkerUpsert).Worker.ID}, proto.ErrInternal)
}
