package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codexaccount"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/mcpinv"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// fakeMCP is Options.MCP: each answer names its key in one server, and
// every key asked is recorded.
type fakeMCP struct {
	mu        sync.Mutex
	inventory []mcpinv.Key
	checks    []mcpinv.Key
}

func (f *fakeMCP) provider(key mcpinv.Key, scope string) proto.MCPProvider {
	return proto.MCPProvider{Available: true, Config: proto.MCPRead{State: proto.MCPStateOK}, Check: proto.MCPCheck{State: proto.MCPCheckNone},
		Servers: []proto.MCPServer{{Name: "good", Source: "user", Transport: "stdio", Approval: "n/a", Status: proto.MCPStatusNotChecked,
			StatusScope: scope, Reason: key.Cwd + "|" + key.Home}},
		Skills: proto.MCPSkills{State: proto.MCPStateOK, Items: []proto.MCPSkill{}, Errors: []proto.MCPSkillError{}}}
}

func (f *fakeMCP) Inventory(_ context.Context, key mcpinv.Key) proto.MCPProvider {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inventory = append(f.inventory, key)
	return f.provider(key, proto.MCPScopeConfig)
}

func (f *fakeMCP) Check(_ context.Context, key mcpinv.Key) proto.MCPProvider {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checks = append(f.checks, key)
	p := f.provider(key, proto.MCPScopeProbe)
	p.Check.State = proto.MCPCheckOK
	return p
}

func (f *fakeMCP) asked() (inventory, checks []mcpinv.Key) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.inventory), slices.Clone(f.checks)
}

func snapshotOf(t *testing.T, m msg) proto.MCPSnapshot {
	t.Helper()
	return ackData[proto.MCPSnapshot](t, m)
}

func TestMCPInventoryContext(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	def, other, wdir := filepath.Join(home, "repos", "def"), filepath.Join(home, "repos", "other"), filepath.Join(home, "repos", "w")
	for _, d := range []string{def, other, wdir, filepath.Join(home, ".codex"), filepath.Join(home, ".codex-work")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(home, ".codex-work", "auth.json"), nil, 0o600); err != nil { // a sibling profile
		t.Fatal(err)
	}
	inv := &fakeMCP{}
	b := startBridge(t, "", server.Options{MCP: inv, HomeDir: home, MCPClaudeDir: filepath.Join(home, ".claude"), MCPCodexHome: filepath.Join(home, ".codex"),
		CodexProfiles: codexaccount.New(home, filepath.Join(home, ".codex"))})
	w := worker("w1", "CODE|w1", "", "idle")
	w.Cwd = wdir
	b.floor("s", true, w)
	b.floor("asleep", false)
	c := b.connect(proto.Hello{Client: "mcp"})
	c.snapshot()

	// Without a default checkout: the first worker's.
	_, m := c.command(proto.CmdMCPInventory, "first", proto.MCPInventoryArgs{Session: "s"})
	snap := snapshotOf(t, m)
	if snap.Context.Cwd == nil || *snap.Context.Cwd != wdir || snap.Context.CwdDisplay != "~/repos/w" || snap.Context.ClaudeConfig != "~/.claude" ||
		snap.Context.Floor != "s" || snap.Expected == nil || len(snap.Expected) != 0 || snap.GeneratedAt == "" {
		t.Fatalf("context = %+v", snap)
	}

	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some(def), ExpectedMCP: proto.Some([]string{"github"})})
	c.mustAck(proto.CmdCodexProfilesGet, nil)
	_, m = c.command(proto.CmdMCPInventory, "default", proto.MCPInventoryArgs{Session: "s"})
	snap = snapshotOf(t, m)
	wantCheckouts := []proto.MCPCheckout{{Path: def, Display: "~/repos/def", Label: "def (default)"}, {Path: wdir, Display: "~/repos/w", Label: "w"}}
	if *snap.Context.Cwd != def || !slices.Equal(snap.Checkouts, wantCheckouts) || !slices.Equal(snap.Expected, []string{"github"}) ||
		snap.Context.CodexProfile != "codex" || snap.Context.CodexProfileName != "codex" {
		t.Fatalf("snapshot = %+v", snap)
	}
	if p := snap.Providers; p.Claude.Servers[0].Reason != def+"|"+filepath.Join(home, ".claude") || p.Codex.Servers[0].Reason != def+"|"+filepath.Join(home, ".codex") {
		t.Fatalf("keys = %+v", p)
	}

	// Another checkout and profile: their own keys. null: user scope.
	_, m = c.command(proto.CmdMCPInventory, "other", map[string]any{"session": "s", "cwd": other, "codex_profile": "work"})
	snap = snapshotOf(t, m)
	if *snap.Context.Cwd != other || snap.Context.CodexProfile != "work" || snap.Providers.Codex.Servers[0].Reason != other+"|"+filepath.Join(home, ".codex-work") {
		t.Fatalf("other = %+v", snap)
	}
	_, m = c.command(proto.CmdMCPInventory, "user", map[string]any{"floor": "s", "cwd": nil, "codex_profile": nil})
	snap = snapshotOf(t, m)
	if snap.Context.Cwd != nil || snap.Context.CwdDisplay != "" || snap.Context.CodexProfile != "codex" || snap.Providers.Claude.Servers[0].Reason != "|"+filepath.Join(home, ".claude") {
		t.Fatalf("user scope = %+v", snap)
	}
	if !strings.Contains(string(m.raw), `"cwd":null`) {
		t.Fatalf("user scope's cwd is null: %s", m.raw)
	}

	// An asleep floor answers too.
	_, m = c.command(proto.CmdMCPInventory, "asleep", proto.MCPInventoryArgs{Session: "asleep"})
	if snapshotOf(t, m).Context.Cwd != nil {
		t.Fatalf("asleep = %s", m.raw)
	}

	for name, c2 := range map[string]struct {
		args any
		code string
	}{
		"relative cwd":  {map[string]any{"session": "s", "cwd": "repos/def"}, proto.ErrBadRequest},
		"missing cwd":   {map[string]any{"session": "s", "cwd": filepath.Join(home, "nope")}, proto.ErrBadRequest},
		"unknown key":   {map[string]any{"session": "s", "harness": "codex"}, proto.ErrBadRequest},
		"profile":       {map[string]any{"session": "s", "codex_profile": "nope"}, proto.ErrNotFound},
		"unknown floor": {map[string]any{"session": "nope"}, proto.ErrUnknownSession},
	} {
		_, m := c.command(proto.CmdMCPInventory, name, c2.args)
		if e := errorOf(m); m.env.T != proto.TError || e.Code != c2.code {
			t.Errorf("%s: %s", name, m.raw)
		}
	}
	for name, args := range map[string]any{
		"harness": map[string]any{"session": "s", "harness": "opencode"},
		"none":    map[string]any{"session": "s"},
	} {
		_, m := c.command(proto.CmdMCPCheck, name, args)
		if e := errorOf(m); m.env.T != proto.TError || e.Code != proto.ErrBadRequest {
			t.Errorf("check %s: %s", name, m.raw)
		}
	}

	// A check runs that harness's check in the key, the other's inventory.
	_, m = c.command(proto.CmdMCPCheck, "check", map[string]any{"session": "s", "harness": "codex", "codex_profile": "work"})
	snap = snapshotOf(t, m)
	if snap.Providers.Codex.Check.State != proto.MCPCheckOK || snap.Providers.Claude.Check.State != proto.MCPCheckNone {
		t.Fatalf("check = %+v", snap.Providers)
	}
	_, checks := inv.asked()
	if len(checks) != 1 || checks[0] != (mcpinv.Key{Harness: "codex", Cwd: def, Home: filepath.Join(home, ".codex-work")}) {
		t.Fatalf("checks = %+v", checks)
	}

	// mcp.inventory is never audited (refused or not); mcp.check is.
	log, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var cmds []string
	for _, e := range log {
		if strings.HasPrefix(e.Cmd, "mcp.") {
			cmds = append(cmds, e.Cmd)
		}
	}
	if !slices.Equal(cmds, []string{proto.CmdMCPCheck, proto.CmdMCPCheck, proto.CmdMCPCheck}) { // two refused, one run
		t.Fatalf("audited = %v", cmds)
	}
}

// End to end with the real cache: Claude's files with secret-shaped values
// and a Codex CLI that is not installed. The Snapshot names neither a
// secret nor a path outside the display forms; Codex is unavailable and
// Claude's read is intact.
func TestMCPInventorySnapshotIsSafe(t *testing.T) {
	t.Parallel()
	home := t.TempDir()
	cwd := filepath.Join(home, "repos", "x")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(path string, v any) {
		b, _ := json.Marshal(v)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, b, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(home, ".claude.json"), map[string]any{"mcpServers": map[string]any{
		"github": map[string]any{"type": "http", "url": "https://user:SECRETPASS@mcp.example.com/?token=SECRETQUERY", "headers": map[string]string{"Authorization": "Bearer SECRETHEADER"}},
		"local":  map[string]any{"command": "/opt/secret-command", "args": []string{"--secret-arg"}, "env": map[string]string{"TOKEN": "sk-live-SECRETENV"}},
	}})
	write(filepath.Join(cwd, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"proj": map[string]any{"command": "/opt/project-secret"}}})
	files := mcpinv.DefaultClaudeFiles("", home)
	files.Managed = ""
	codex := mcpinv.CodexRunner{Bin: filepath.Join(home, "no-codex"), UserHome: home}
	ctx, cancel := context.WithCancel(context.Background())
	svc := mcpinv.New(ctx, mcpinv.Options{Read: map[string]mcpinv.Reader{
		mcpinv.Claude: func(_ context.Context, key mcpinv.Key) (proto.MCPProvider, error) { return mcpinv.ReadClaude(files, key.Cwd), nil },
		mcpinv.Codex: func(ctx context.Context, key mcpinv.Key) (proto.MCPProvider, error) {
			return codex.ReadCodex(ctx, mcpinv.CodexHome{Home: key.Home, Default: true}, key.Cwd)
		},
	}})
	t.Cleanup(func() { cancel(); svc.Wait() })
	b := startBridge(t, "", server.Options{MCP: svc, HomeDir: home, MCPClaudeDir: files.Dir, MCPCodexHome: filepath.Join(home, ".codex")})
	b.floor("s", true)
	c := b.connect(proto.Hello{Client: "mcp"})
	c.snapshot()
	_, m := c.command(proto.CmdMCPInventory, "inv", map[string]any{"session": "s", "cwd": cwd})
	snap := snapshotOf(t, m)
	if p := snap.Providers.Codex; p.Available || p.Config.State != proto.MCPStateUnavailable || p.Reason == "" {
		t.Fatalf("codex = %+v", p)
	}
	if p := snap.Providers.Claude; !p.Available || p.Config.State != proto.MCPStateOK || len(p.Servers) != 3 || p.Config.ReadAt == nil {
		t.Fatalf("claude = %+v", p)
	}
	for _, s := range []string{"SECRET", "mcp.example.com", "secret-command", "secret-arg", "project-secret", "sk-live", "token="} {
		if strings.Contains(string(m.raw), s) {
			t.Fatalf("%q in %s", s, m.raw)
		}
	}
}

// A worker's own servers: the attached shared Codex worker of the floor in
// the checkout is asked while mcp.inventory is (at most once per 30 s); a
// check, another checkout or nobody asking reads nothing.
func TestMCPWorkerObservation(t *testing.T) {
	t.Parallel()
	host := newFakeCodexHost()
	connected := "connected"
	host.mcp = func() ([]codexapp.MCPServerStatus, error) {
		return []codexapp.MCPServerStatus{{Name: "good", RuntimeStatus: &connected}, {Name: "worker-only", ToolsError: &connected}}, nil
	}
	clk := &mcpClock{now: time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)}
	inv := &fakeMCP{}
	sb := startSharedBridgeWith(t, "", host, true, "", func(o *server.Options) {
		o.MCP, o.MCPClaudeDir, o.MCPCodexHome, o.Now = inv, "/home/u/.claude", "/home/u/.codex", clk.Now
	})
	_, m := sb.c.command(proto.CmdWorkerHire, "h", codexHire(1))
	res := ackData[proto.HireResult](t, m)
	const th = "01a11172-ac09-7aa0-ab6b-84485199ada3"
	sb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = th })
	sb.world(func(w proto.World) bool {
		x := workersOf(w, "s")["w1"]
		return x.Codex != nil && x.Codex.Attached
	})
	if calls := host.mcpCount(); calls != 0 {
		t.Fatalf("read with nobody asking: %d", calls)
	}

	_, m = sb.c.command(proto.CmdMCPInventory, "inv", map[string]any{"session": "s", "cwd": "/home/u/repo"})
	snap := snapshotOf(t, m)
	byName := map[string]proto.MCPServer{}
	for _, s := range snap.Providers.Codex.Servers {
		byName[s.Name] = s
	}
	g := byName["good"]
	if g.Status != proto.MCPStatusConnected || g.StatusScope != proto.MCPScopeWorker || g.Worker == nil || g.Worker.ID != res.ID || g.StatusAt == nil {
		t.Fatalf("observed = %+v", g)
	}
	if o := byName["worker-only"]; o.Status != proto.MCPStatusFailed || o.StatusScope != proto.MCPScopeWorker || o.Reason == "" || strings.Contains(o.Reason, "connected") {
		t.Fatalf("worker-only = %+v", o)
	}
	for _, s := range snap.Providers.Claude.Servers {
		if s.StatusScope != proto.MCPScopeConfig {
			t.Fatalf("claude has no worker observations: %+v", s)
		}
	}
	if host.mcpCount() != 1 {
		t.Fatalf("reads = %d", host.mcpCount())
	}

	// Inside 30 s: the last read again, no call; a check, another checkout
	// and user scope read nothing.
	clk.add(29 * time.Second)
	_, m = sb.c.command(proto.CmdMCPInventory, "again", map[string]any{"session": "s", "cwd": "/home/u/repo"})
	if s := snapshotOf(t, m).Providers.Codex.Servers[0]; s.StatusScope != proto.MCPScopeWorker {
		t.Fatalf("cached observation = %+v", s)
	}
	sb.c.command(proto.CmdMCPCheck, "check", map[string]any{"session": "s", "cwd": "/home/u/repo", "harness": "codex"})
	sb.c.command(proto.CmdMCPInventory, "elsewhere", map[string]any{"session": "s", "cwd": "/home/u/other"})
	sb.c.command(proto.CmdMCPInventory, "user", map[string]any{"session": "s", "cwd": nil})
	if host.mcpCount() != 1 {
		t.Fatalf("reads = %d", host.mcpCount())
	}
	clk.add(time.Second)
	sb.c.command(proto.CmdMCPInventory, "later", map[string]any{"session": "s", "cwd": "/home/u/repo"})
	if host.mcpCount() != 2 {
		t.Fatalf("reads = %d", host.mcpCount())
	}
}

// The worker's rows convert to mcpinv's field for field: a drift of either
// struct fails to compile here.
func TestCodexStatusRowsConvert(t *testing.T) {
	_ = mcpinv.CodexStatus(codexapp.MCPServerStatus{})
}

type mcpClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *mcpClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *mcpClock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}
