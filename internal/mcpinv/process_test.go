package mcpinv

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/harness"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// harnessRun is the app's Runner (test imports are in no package's graph).
func harnessRun(ctx context.Context, sp Spawn, fn func(Stream) error) error {
	_, err := harness.Run(ctx, harness.Spawn{Bin: sp.Bin, Dir: sp.Dir, Args: sp.Args, Env: sp.Env, Timeout: sp.Timeout},
		func(s *harness.Stream) (struct{}, error) { return struct{}{}, fn(s) })
	return err
}

// The test executable stands in for the Codex and Claude Code CLIs: no
// installed harness, credential or real MCP server is used. It traces its
// argv, cwd, environment and every message it reads to H3D_MCPINV_TRACE,
// and "starts" a server by appending its name to H3D_MCPINV_STARTS.
func TestMain(m *testing.M) {
	if scenario := os.Getenv("H3D_MCPINV_FAKE"); scenario != "" {
		fakeCLI(scenario)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeCLI(scenario string) {
	trace, err := os.OpenFile(os.Getenv("H3D_MCPINV_TRACE"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		os.Exit(2)
	}
	cwd, _ := os.Getwd()
	_ = json.NewEncoder(trace).Encode(map[string]any{"pid": os.Getpid(), "args": os.Args[1:], "cwd": cwd,
		"codex_home": os.Getenv("CODEX_HOME"), "claude_config_dir": os.Getenv("CLAUDE_CONFIG_DIR"), "herdr": os.Getenv("HERDR_SESSION")})
	start := func(name string) {
		f, err := os.OpenFile(os.Getenv("H3D_MCPINV_STARTS"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err == nil {
			_, _ = f.WriteString(name + "\n")
			f.Close()
		}
	}
	// A child in the process group, like an MCP server: it must die with it.
	if strings.HasSuffix(scenario, "-child") {
		child := exec.Command("sleep", "60")
		if child.Start() == nil {
			_ = json.NewEncoder(trace).Encode(map[string]any{"child": child.Process.Pid})
		}
	}
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64<<10), 1<<20)
	out := json.NewEncoder(os.Stdout)
	reply := func(id any, result any) { _ = out.Encode(map[string]any{"id": id, "result": result}) }

	if strings.HasPrefix(scenario, "claude") {
		fakeClaude(scenario, in, out, trace, start)
		return
	}
	statusCalls := 0
	for in.Scan() {
		var msg map[string]any
		if json.Unmarshal(in.Bytes(), &msg) != nil {
			os.Exit(4)
		}
		_ = json.NewEncoder(trace).Encode(msg)
		if strings.HasPrefix(scenario, "codex-hang") {
			continue
		}
		id := msg["id"]
		switch msg["method"] {
		case "initialize":
			_ = out.Encode(map[string]any{"method": "some/notification", "params": map[string]any{}})
			reply(id, map[string]any{"userAgent": "herdr_3d/0.163.0 (Linux; x86_64) fake", "codexHome": "/secret/home"})
		case "initialized":
		case "config/read":
			if scenario == "codex-refuse-config" {
				_ = out.Encode(map[string]any{"id": id, "error": map[string]any{"code": -32600, "message": "raw SECRET refusal"}})
				continue
			}
			reply(id, codexConfigFixture())
		case "skills/list":
			reply(id, map[string]any{"data": []any{map[string]any{"cwd": cwd, "skills": []any{
				map[string]any{"name": "good", "description": "Good one", "path": "/h/.codex/skills/good/SKILL.md", "scope": "user", "enabled": true},
				map[string]any{"name": "off", "description": "Off", "path": "/h/.codex/skills/off/SKILL.md", "scope": "repo", "enabled": false},
				map[string]any{"name": "plug", "description": "long", "interface": map[string]any{"shortDescription": "short"},
					"path": "/p/skills/plug/SKILL.md", "scope": "user", "enabled": true, "pluginId": "tools@market"},
			}, "errors": []any{map[string]any{"path": "/h/.codex/skills/bad/SKILL.md", "message": "missing field `description` at line 2: SECRET"}}}}})
		case "mcpServerStatus/list":
			statusCalls++
			for _, name := range []string{"good", "fail", "auth"} {
				start(name)
			}
			next := strconv.Itoa(statusCalls) // always more: the check stops after 5 pages
			reply(id, map[string]any{"nextCursor": next, "data": []any{
				map[string]any{"name": "good", "runtimeStatus": nil, "serverInfo": map[string]any{"name": "x", "version": "1"}, "authStatus": "unsupported",
					"httpOrigin": "https://SECRETORIGIN.example.com", "tools": map[string]any{}, "resources": []any{}, "resourceTemplates": []any{}},
				map[string]any{"name": "fail", "runtimeStatus": nil, "serverInfo": nil, "toolsError": "MCP startup failed: connection closed: SECRET stderr",
					"authStatus": "unsupported", "tools": map[string]any{}, "resources": []any{}, "resourceTemplates": []any{}},
				map[string]any{"name": "auth", "runtimeStatus": nil, "serverInfo": nil, "authStatus": "notLoggedIn",
					"tools": map[string]any{}, "resources": []any{}, "resourceTemplates": []any{}},
				map[string]any{"name": "plugin-srv", "runtimeStatus": nil, "pluginId": "tools@market", "serverInfo": nil, "authStatus": "unsupported",
					"tools": map[string]any{}, "resources": []any{}, "resourceTemplates": []any{}},
			}})
		default:
			_ = out.Encode(map[string]any{"id": id, "error": map[string]any{"code": -32601, "message": "unexpected"}})
		}
	}
}

func codexConfigFixture() map[string]any {
	origin := func(t string) map[string]any {
		return map[string]any{"name": map[string]any{"type": t, "file": "/secret/path"}, "version": "x"}
	}
	return map[string]any{
		"config": map[string]any{"mcp_servers": map[string]any{
			"good":     map[string]any{"command": "/opt/secret-command", "args": []string{"--secret-arg"}, "env": map[string]string{"TOKEN": "sk-live-SECRETENV"}, "enabled": true},
			"remote":   map[string]any{"url": "https://user:SECRETPASS@mcp.example.com/path?token=SECRETQUERY", "http_headers": map[string]string{"Authorization": "Bearer SECRETHEADER"}, "enabled": true},
			"disabled": map[string]any{"command": "x", "enabled": false},
			"proj":     map[string]any{"command": "x", "enabled": true},
			"sys":      map[string]any{"command": "x"},
		}},
		"origins": map[string]any{
			"mcp_servers.good.command": origin("user"), "mcp_servers.good.env.TOKEN": origin("project"),
			"mcp_servers.remote.url": origin("user"), "mcp_servers.disabled.enabled": origin("user"),
			"mcp_servers.proj.command": origin("project"), "mcp_servers.sys.command": origin("enterpriseManaged"),
		},
	}
}

// fakeClaude is Claude Code's SDK control protocol: the configured servers
// "start" on their own (a project .mcp.json server unless --settings lists
// it in disabledMcpjsonServers; a user server of $CLAUDE_CONFIG_DIR's
// .claude.json too; either unless --settings denies its name in
// deniedMcpServers, as measured on 2.1.309), and mcp_status reports them
// pending first.
func fakeClaude(scenario string, in *bufio.Scanner, out *json.Encoder, trace *os.File, start func(string)) {
	var disabled, denied []string
	for i, a := range os.Args {
		if a == "--settings" && i+1 < len(os.Args) {
			var s struct {
				Disabled []string            `json:"disabledMcpjsonServers"`
				Denied   []map[string]string `json:"deniedMcpServers"`
			}
			_ = json.Unmarshal([]byte(os.Args[i+1]), &s)
			disabled = s.Disabled
			for _, d := range s.Denied {
				denied = append(denied, d["serverName"])
			}
		}
	}
	var names []string
	add := func(path string, skip []string) {
		var file struct {
			MCPServers map[string]any `json:"mcpServers"`
		}
		if b, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(b, &file)
		}
		for name := range file.MCPServers {
			if !slices.Contains(skip, name) && !slices.Contains(denied, name) && !slices.Contains(names, name) {
				names = append(names, name)
			}
		}
	}
	cwd, _ := os.Getwd()
	for d := cwd; ; d = filepath.Dir(d) { // every .mcp.json from cwd up
		add(filepath.Join(d, ".mcp.json"), disabled)
		if filepath.Dir(d) == d {
			break
		}
	}
	if dir := os.Getenv("CLAUDE_CONFIG_DIR"); dir != "" {
		add(filepath.Join(dir, ".claude.json"), nil)
	}
	slices.Sort(names)
	for _, n := range names {
		start(n)
	}
	polls := 0
	for in.Scan() {
		var msg map[string]any
		if json.Unmarshal(in.Bytes(), &msg) != nil {
			os.Exit(4)
		}
		_ = json.NewEncoder(trace).Encode(msg)
		req, _ := msg["request"].(map[string]any)
		id := msg["request_id"]
		respond := func(r any) {
			_ = out.Encode(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": id, "response": r}})
		}
		switch {
		case msg["type"] != "control_request":
			os.Exit(6) // a user message: never
		case req["subtype"] == "initialize":
			_ = out.Encode(map[string]any{"type": "system", "subtype": "init"})
			respond(map[string]any{"claude_code_version": "2.1.309", "commands": []any{}, "account": map[string]any{"email": "SECRET@example.com"}})
		case req["subtype"] == "mcp_status":
			polls++
			rows := []any{}
			for _, n := range names {
				status := "pending"
				if polls > 1 && scenario != "claude-pending" {
					status = "connected"
				}
				rows = append(rows, map[string]any{"name": n, "status": status, "scope": "project", "transport": "stdio",
					"config": map[string]any{"command": "/opt/project-secret", "env": map[string]string{"K": "sk-live-SECRETENV"}}})
			}
			if polls > 1 {
				rows = append(rows,
					map[string]any{"name": "fail", "status": "failed", "error": "Connection closed: SECRET stderr", "scope": "user", "transport": "stdio"},
					map[string]any{"name": "auth", "status": "needs-auth", "scope": "user", "transport": "http",
						"config": map[string]any{"url": "https://user:SECRETPASS@mcp.example.com/path?token=SECRETQUERY"}},
					map[string]any{"name": "claude.ai Gmail", "status": "connected", "scope": "claudeai", "transport": "claudeai-proxy"},
					map[string]any{"name": "plugin:tools:db", "status": "connected", "scope": "plugin", "transport": "stdio"})
			}
			respond(map[string]any{"mcpServers": rows})
		default:
			os.Exit(7) // any other control request: never
		}
	}
}

type fakeRun struct {
	bin, trace, starts string
}

func fakeBin(t *testing.T, scenario string) fakeRun {
	t.Helper()
	dir := t.TempDir()
	r := fakeRun{bin: os.Args[0], trace: filepath.Join(dir, "trace.jsonl"), starts: filepath.Join(dir, "starts.log")}
	t.Setenv("H3D_MCPINV_FAKE", scenario)
	t.Setenv("H3D_MCPINV_TRACE", r.trace)
	t.Setenv("H3D_MCPINV_STARTS", r.starts)
	t.Setenv("HERDR_SESSION", "parent-session")
	return r
}

type traced struct {
	PID             int      `json:"pid"`
	Args            []string `json:"args"`
	Cwd             string   `json:"cwd"`
	CodexHome       string   `json:"codex_home"`
	ClaudeConfigDir string   `json:"claude_config_dir"`
	Herdr           string   `json:"herdr"`
}

// read is the trace: the process, the messages it read, its child's pid.
func (r fakeRun) read(t *testing.T) (meta traced, msgs []map[string]any, child int) {
	t.Helper()
	b, err := os.ReadFile(r.trace)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if err := json.Unmarshal([]byte(lines[0]), &meta); err != nil {
		t.Fatal(err)
	}
	for _, l := range lines[1:] {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatal(err)
		}
		if c, ok := m["child"].(float64); ok {
			child = int(c)
			continue
		}
		msgs = append(msgs, m)
	}
	return meta, msgs, child
}

func (r fakeRun) started(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(r.starts)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Fields(string(b))
}

func methods(msgs []map[string]any) []string {
	var out []string
	for _, m := range msgs {
		if s, ok := m["method"].(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// gone fails when pid is still a live process (not a zombie of ours).
func gone(t *testing.T, pid int) {
	t.Helper()
	for range 100 {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		if b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat"); err == nil {
			if f := strings.Fields(string(b)); len(f) > 2 && f[2] == "Z" {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d still runs", pid)
}

// A Codex read sends initialize, config/read and skills/list only (no MCP
// server starts), under the profile's CODEX_HOME, in the checkout, and its
// process is gone afterwards; nothing secret is in the provider.
func TestReadCodex(t *testing.T) {
	r := fakeBin(t, "codex")
	cwd := t.TempDir()
	c := CodexRunner{Run: harnessRun, Bin: r.bin, UserHome: "/h"}
	p, err := c.ReadCodex(context.Background(), CodexHome{Home: "/h/.codex-work"}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	meta, msgs, _ := r.read(t)
	if got := methods(msgs); !slices.Equal(got, []string{"initialize", "initialized", "config/read", "skills/list"}) {
		t.Fatalf("methods = %v", got)
	}
	if !reflect.DeepEqual(msgs[2]["params"], map[string]any{"cwd": cwd, "includeLayers": false}) ||
		!reflect.DeepEqual(msgs[3]["params"], map[string]any{"cwds": []any{cwd}}) {
		t.Fatalf("params = %v / %v", msgs[2]["params"], msgs[3]["params"])
	}
	if !slices.Equal(meta.Args, []string{"app-server"}) || meta.Cwd != cwd || meta.CodexHome != "/h/.codex-work" || meta.Herdr != "" {
		t.Fatalf("process = %+v", meta)
	}
	gone(t, meta.PID)
	if len(r.started(t)) != 0 {
		t.Fatalf("a read started %v", r.started(t))
	}

	if p.Version != "0.163.0" || p.Config.State != proto.MCPStateOK || !p.Available {
		t.Fatalf("provider = %+v", p)
	}
	want := []row{
		{"disabled", "user", "", "stdio", "n/a", "disabled"},
		{"good", "user", "", "stdio", "n/a", "not_checked"},
		{"proj", "project", "", "stdio", "n/a", "not_checked"},
		{"remote", "user", "", "http", "n/a", "not_checked"},
		{"sys", "managed", "", "stdio", "n/a", "not_checked"},
	}
	if got := rows(p); !reflect.DeepEqual(got, want) {
		t.Fatalf("servers = %v", got)
	}
	if p.Servers[3].Enabled == nil || !*p.Servers[3].Enabled || p.Servers[4].Enabled != nil {
		t.Fatalf("enabled = %+v", p.Servers)
	}
	sk := p.Skills
	if sk.State != proto.MCPStateOK || !sk.Complete || len(sk.Items) != 3 || *sk.Items[1].Enabled || sk.Items[1].Source != "repo" ||
		sk.Items[0].Where != "~/.codex/skills/good" || sk.Items[2].Source != "plugin" || sk.Items[2].Plugin != "tools" || sk.Items[2].Description != "short" {
		t.Fatalf("skills = %+v", sk)
	}
	if len(sk.Errors) != 1 || sk.Errors[0] != (proto.MCPSkillError{Where: "~/.codex/skills/bad", Message: "Invalid SKILL.md front matter"}) {
		t.Fatalf("errors = %+v", sk.Errors)
	}
	assertSafe(t, p)

	// The default profile gets no CODEX_HOME of the bridge's; user scope runs
	// in an empty private dir and asks config/read without a cwd.
	if err := os.Remove(r.trace); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CODEX_HOME", "")
	if _, err := c.ReadCodex(context.Background(), CodexHome{Home: "/h/.codex", Default: true}, ""); err != nil {
		t.Fatal(err)
	}
	meta, msgs, _ = r.read(t)
	if meta.CodexHome != "" || meta.Cwd == cwd || !strings.Contains(meta.Cwd, "h3d-mcp-") || msgs[2]["params"].(map[string]any)["cwd"] != nil {
		t.Fatalf("user scope = %+v %v", meta, msgs[2])
	}
	if _, err := os.Stat(meta.Cwd); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the private dir is removed")
	}
}

// A refused config/read fails that half only.
func TestReadCodexRefused(t *testing.T) {
	r := fakeBin(t, "codex-refuse-config")
	p, err := CodexRunner{Run: harnessRun, Bin: r.bin}.ReadCodex(context.Background(), CodexHome{Home: "/h/.codex", Default: true}, t.TempDir())
	if err != nil || p.Config.State != proto.MCPStateFailed || p.Config.Note != "Codex app-server refused config/read" || p.Skills.State != proto.MCPStateOK {
		t.Fatalf("refused = %+v, %v", p, err)
	}
	assertSafe(t, p)
}

// A hung app-server is ended at the timeout, its process group (an MCP
// server child too) killed and reaped; the failure says so, nothing raw.
func TestCodexTimeoutKillsTheGroup(t *testing.T) {
	r := fakeBin(t, "codex-hang-child")
	c := CodexRunner{Run: harnessRun, Bin: r.bin, ReadTimeout: 300 * time.Millisecond, CheckTimeout: 300 * time.Millisecond}
	start := time.Now()
	_, err := c.ReadCodex(context.Background(), CodexHome{Home: "/h/.codex", Default: true}, t.TempDir())
	var f *Failure
	if !errors.As(err, &f) || f.Note != "Codex app-server did not answer in time" || time.Since(start) > 3*time.Second {
		t.Fatalf("hung read = %v after %v", err, time.Since(start))
	}
	meta, _, child := r.read(t)
	if child == 0 {
		t.Fatal("no child traced")
	}
	gone(t, meta.PID)
	gone(t, child)

	if err := os.Remove(r.trace); err != nil {
		t.Fatal(err)
	}
	res, err := c.CheckCodex(context.Background(), CodexHome{Home: "/h/.codex", Default: true}, t.TempDir())
	if err != nil || res.State != proto.MCPCheckTimeout {
		t.Fatalf("hung check = %+v, %v", res, err)
	}
	meta, _, child = r.read(t)
	gone(t, meta.PID)
	gone(t, child)
}

// A Codex check asks mcpServerStatus/list without a thread, limit 100,
// toolsAndAuthOnly, and follows nextCursor at most 4 more pages.
func TestCheckCodex(t *testing.T) {
	r := fakeBin(t, "codex")
	res, err := CodexRunner{Run: harnessRun, Bin: r.bin}.CheckCodex(context.Background(), CodexHome{Home: "/h/.codex-work"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	meta, msgs, _ := r.read(t)
	got := methods(msgs)
	if !slices.Equal(got, []string{"initialize", "initialized", "mcpServerStatus/list", "mcpServerStatus/list", "mcpServerStatus/list",
		"mcpServerStatus/list", "mcpServerStatus/list"}) {
		t.Fatalf("methods = %v", got)
	}
	for i, m := range msgs[2:] {
		p := m["params"].(map[string]any)
		if p["limit"] != float64(100) || p["detail"] != "toolsAndAuthOnly" || p["threadId"] != nil || (i > 0) != (p["cursor"] != nil) {
			t.Fatalf("page %d params = %v", i, p)
		}
	}
	if meta.CodexHome != "/h/.codex-work" {
		t.Fatalf("process = %+v", meta)
	}
	gone(t, meta.PID)
	want := []Observed{
		{Name: "good", Status: "connected", Source: "unknown", Transport: "unknown"},
		{Name: "fail", Status: "failed", Reason: "Connection closed", Source: "unknown", Transport: "unknown"},
		{Name: "auth", Status: "auth_required", Reason: "Authentication required", Source: "unknown", Transport: "unknown"},
		{Name: "plugin-srv", Status: "unknown", Source: "plugin", Plugin: "tools", Transport: "unknown"},
	}
	if res.State != proto.MCPCheckOK || res.Version != "0.163.0" || !reflect.DeepEqual(res.Rows, want) || res.Note == "" {
		t.Fatalf("check = %+v", res)
	}
	assertSafe(t, res)
}

// A worker's runtimeStatus is mapped directly.
func TestMapCodexStatuses(t *testing.T) {
	s := func(v string) *string { return &v }
	got := MapCodexStatuses([]CodexStatus{
		{Name: "a", RuntimeStatus: s("connected")}, {Name: "b", RuntimeStatus: s("starting")}, {Name: "c", RuntimeStatus: s("authenticationRequired")},
		{Name: "d", RuntimeStatus: s("failed"), ToolsError: s("timed out after 30s: SECRET")}, {Name: "e", RuntimeStatus: s("cancelled")},
		{Name: "f", RuntimeStatus: s("disabled")}, {Name: "g", RuntimeStatus: s("notStarted")}, {Name: "h", RuntimeStatus: s("someday")},
		{Name: "a", RuntimeStatus: s("failed")}, {Name: "bad\x00name"},
	})
	var st []string
	for _, o := range got {
		st = append(st, o.Name+"="+o.Status+"/"+o.Reason)
	}
	want := []string{"a=connected/", "b=connecting/", "c=auth_required/Authentication required", "d=failed/Timed out", "e=failed/Startup cancelled",
		"f=disabled/", "g=not_checked/Not started yet", "h=unknown/"}
	if !slices.Equal(st, want) {
		t.Fatalf("statuses = %v", st)
	}
}

// The Claude check never starts a project server the user has not approved:
// it is passed as disabledMcpjsonServers in --settings (the fake starts what
// is not listed, as Claude Code 2.1.309 does). It sends initialize and
// mcp_status only, polls until nothing is pending, and maps the rows.
func TestCheckClaude(t *testing.T) {
	r := fakeBin(t, "claude-child")
	f, cwd := claudeFixture(t)
	c := ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: f, ConfigDirEnv: "/cfg/claude", Poll: 10 * time.Millisecond}
	res, err := c.CheckClaude(context.Background(), cwd)
	if err != nil {
		t.Fatal(err)
	}
	if got := r.started(t); !slices.Equal(got, []string{"approved"}) {
		t.Fatalf("started = %v (pending and rejected must never start)", got)
	}
	meta, msgs, child := r.read(t)
	gone(t, meta.PID)
	gone(t, child)
	if slices.Contains(meta.Args, "--strict-mcp-config") || !slices.Contains(meta.Args, "--no-session-persistence") || meta.Cwd != cwd ||
		meta.ClaudeConfigDir != "/cfg/claude" || meta.Herdr != "" {
		t.Fatalf("process = %+v", meta)
	}
	i := slices.Index(meta.Args, "--tools")
	j := slices.Index(meta.Args, "--settings")
	if i < 0 || meta.Args[i+1] != "" || j < 0 || meta.Args[j+1] != `{"disableAllHooks":true,"disabledMcpjsonServers":["ancestor","pending","rejected"]}` {
		t.Fatalf("args = %q", meta.Args)
	}
	var subtypes []string
	for _, m := range msgs {
		subtypes = append(subtypes, m["request"].(map[string]any)["subtype"].(string))
	}
	if !slices.Equal(subtypes, []string{"initialize", "mcp_status", "mcp_status"}) {
		t.Fatalf("requests = %v", subtypes)
	}
	want := []Observed{
		{Name: "approved", Status: "connected", Source: "project", Transport: "stdio"},
		{Name: "fail", Status: "failed", Reason: "Connection closed", Source: "user", Transport: "stdio"},
		{Name: "auth", Status: "auth_required", Reason: "Authentication required", Source: "user", Transport: "http"},
		{Name: "claude.ai Gmail", Status: "connected", Source: "connector", Transport: "unknown"},
		{Name: "plugin:tools:db", Status: "connected", Source: "plugin", Plugin: "tools", Transport: "stdio"},
	}
	if res.State != proto.MCPCheckOK || res.Version != "2.1.309" || !reflect.DeepEqual(res.Rows, want) {
		t.Fatalf("check = %+v", res)
	}
	assertSafe(t, res)

	// On the provider: the unapproved servers keep their config status.
	p := ReadClaude(f, cwd)
	applyCheck(&p, res, time.Now())
	for _, s := range p.Servers {
		if s.Name == "pending" && (s.Status != proto.MCPStatusApprovalRequired || s.StatusScope != proto.MCPScopeConfig) ||
			s.Name == "approved" && s.Status != proto.MCPStatusConnected {
			t.Fatalf("server %+v", s)
		}
	}
	assertSafe(t, p)
}

// The review's case: user settings approve every project server and the
// checkout's settings.local.json revokes it, so the check starts none.
func TestCheckClaudeLocalRevocation(t *testing.T) {
	r := fakeBin(t, "claude-child")
	f := DefaultClaudeFiles("", t.TempDir())
	f.Managed = ""
	cwd := filepath.Join(f.Home, "proj")
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{"enableAllProjectMcpServers": true})
	writeJSON(t, filepath.Join(cwd, ".claude", "settings.local.json"), map[string]any{"enableAllProjectMcpServers": false})
	writeJSON(t, filepath.Join(cwd, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"unapproved": stdio("fixture")}})
	if _, err := (ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: f, Poll: time.Millisecond}).CheckClaude(context.Background(), cwd); err != nil {
		t.Fatal(err)
	}
	if starts := r.started(t); len(starts) != 0 {
		t.Fatalf("started %v", starts)
	}
}

// A user-scope check starts no project server: not one of a .mcp.json above
// its private dir, approved or not, nor of ~/.mcp.json.
func TestCheckClaudeUserScopeStartsNoProjectServer(t *testing.T) {
	r := fakeBin(t, "claude-child")
	clean, otherHome := t.TempDir(), t.TempDir()
	f := DefaultClaudeFiles("", t.TempDir())
	f.Managed = ""
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{"enableAllProjectMcpServers": true})
	writeJSON(t, filepath.Join(f.Home, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"project-only": stdio("fixture")}})
	tmp := filepath.Join(f.Home, "tmp")
	writeJSON(t, filepath.Join(tmp, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"above-probe": stdio("fixture")}})
	t.Setenv("TMPDIR", tmp)
	if _, err := (ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: f, Poll: time.Millisecond}).CheckClaude(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if starts := r.started(t); len(starts) != 0 {
		t.Fatalf("user-scope check started %v", starts)
	}
	meta, _, _ := r.read(t)
	if filepath.Dir(meta.Cwd) != tmp {
		t.Fatalf("ran in %s", meta.Cwd)
	}
	// Another home's .mcp.json, not above the probe dir, is kept out too.
	r = fakeBin(t, "claude")
	t.Setenv("TMPDIR", clean)
	other := DefaultClaudeFiles("", otherHome)
	other.Managed = ""
	writeJSON(t, filepath.Join(other.Home, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"home-only": stdio("fixture")}})
	if _, err := (ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: other, Poll: time.Millisecond}).CheckClaude(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	meta, _, _ = r.read(t)
	j := slices.Index(meta.Args, "--settings")
	if j < 0 || !strings.Contains(meta.Args[j+1], `"disabledMcpjsonServers":["home-only"]`) {
		t.Fatalf("args = %q", meta.Args)
	}
}

// A server the MCP policy blocks is denied by name in --settings, so the
// check never starts it, whatever its scope.
func TestCheckClaudeStartsNoBlockedServer(t *testing.T) {
	r := fakeBin(t, "claude-child")
	home := t.TempDir()
	f := DefaultClaudeFiles(filepath.Join(home, "cfg"), home)
	f.Managed = ""
	cwd := filepath.Join(home, "proj")
	writeJSON(t, f.JSON, map[string]any{"mcpServers": map[string]any{"user-ok": stdio("ok"), "user-denied": stdio("bad")},
		"projects": map[string]any{cwd: map[string]any{"hasTrustDialogAccepted": true}}})
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{"enableAllProjectMcpServers": true,
		"deniedMcpServers": []any{map[string]any{"serverCommand": []string{"bad", "--secret-arg"}}, map[string]any{"serverName": "proj-denied"}}})
	writeJSON(t, filepath.Join(cwd, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"proj-ok": stdio("ok"), "proj-denied": stdio("ok")}})
	c := ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: f, ConfigDirEnv: f.Dir, Poll: time.Millisecond}
	if _, err := c.CheckClaude(context.Background(), cwd); err != nil {
		t.Fatal(err)
	}
	if got := r.started(t); !slices.Equal(got, []string{"proj-ok", "user-ok"}) {
		t.Fatalf("started %v", got)
	}
	meta, _, _ := r.read(t)
	j := slices.Index(meta.Args, "--settings")
	if j < 0 || meta.Args[j+1] != `{"deniedMcpServers":[{"serverName":"proj-denied"},{"serverName":"user-denied"}],"disableAllHooks":true,"disabledMcpjsonServers":[]}` {
		t.Fatalf("args = %q", meta.Args)
	}
	gone(t, meta.PID)
}

// Rows still pending at the deadline are connecting, and the check says it
// timed out.
func TestCheckClaudeStillPending(t *testing.T) {
	r := fakeBin(t, "claude-pending")
	f, cwd := claudeFixture(t)
	res, err := ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: f, Poll: 10 * time.Millisecond, Timeout: 100 * time.Millisecond}.CheckClaude(context.Background(), cwd)
	if err != nil || res.State != proto.MCPCheckTimeout || len(res.Rows) != 5 || res.Rows[0] != (Observed{Name: "approved", Status: proto.MCPStatusConnecting,
		Source: "project", Transport: "stdio"}) {
		t.Fatalf("check = %+v, %v", res, err)
	}
	meta, _, _ := r.read(t)
	gone(t, meta.PID)
}

// An unreadable .mcp.json skips the check: no process starts.
func TestCheckClaudeSkipsUnknownApprovals(t *testing.T) {
	r := fakeBin(t, "claude")
	f, cwd := claudeFixture(t)
	writeText(t, filepath.Join(cwd, ".mcp.json"), "{")
	res, err := ClaudeRunner{Run: harnessRun, Bin: r.bin, Files: f}.CheckClaude(context.Background(), cwd)
	if err != nil || res.State != proto.MCPCheckSkipped || res.Note == "" {
		t.Fatalf("check = %+v, %v", res, err)
	}
	if _, err := os.Stat(r.trace); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a skipped check ran Claude Code")
	}
}

// A missing CLI: Codex unavailable (the read), both checks skipped.
func TestMissingCLI(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	p, err := CodexRunner{Bin: missing}.ReadCodex(context.Background(), CodexHome{}, "")
	if err != nil || p.Available || p.Config.State != proto.MCPStateUnavailable || p.Skills.State != proto.MCPStateUnavailable || p.Reason == "" {
		t.Fatalf("codex = %+v, %v", p, err)
	}
	if res, err := (CodexRunner{Bin: missing}).CheckCodex(context.Background(), CodexHome{}, ""); err != nil || res.State != proto.MCPCheckSkipped {
		t.Fatalf("codex check = %+v, %v", res, err)
	}
	if res, err := (ClaudeRunner{Bin: missing}).CheckClaude(context.Background(), ""); err != nil || res.State != proto.MCPCheckSkipped {
		t.Fatalf("claude check = %+v, %v", res, err)
	}
}
