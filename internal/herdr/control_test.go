package herdr

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// TestControlAllowlist is the tripwire for the bridge's write path to herdr:
// the complete set of commands Control can run, and their exact argv.
// Changing either must be a deliberate, reviewed change to this test.
func TestControlAllowlist(t *testing.T) {
	want := map[string][]string{
		"start": {"{systemd-run}", "--user", "--unit=herdr-s-{session}", "--collect", "-p", "KillMode=process",
			"--working-directory={home}", "/bin/fish", "-l", "-c", "exec herdr --session '{session}' server"},
		"stop":          {"{herdr}", "session", "stop", "{session}", "--json"},
		"resume-claude": {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "claude --resume {id}"},
		"resume-codex":  {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "codex resume {id}"},
		"report-codex-session": {"{herdr}", "--session", "{session}", "pane", "report-agent-session", "{pane}",
			"--source", "herdr:codex", "--agent", "codex", "--agent-session-id", "{id}"},
		"process-info": {"{herdr}", "--session", "{session}", "pane", "process-info", "--pane", "{pane}"},
	}
	if !reflect.DeepEqual(controlShapes, want) {
		t.Fatalf("controlShapes = %q", controlShapes)
	}
	// Every exported operation, and nothing else, reaches the runner.
	var methods []string
	typ := reflect.TypeOf(&Control{})
	for i := range typ.NumMethod() {
		methods = append(methods, typ.Method(i).Name)
	}
	if w := []string{"PaneProcesses", "ReportCodexSession", "ResumeAgent", "StartSession", "StopSession"}; !slices.Equal(methods, w) {
		t.Fatalf("Control methods = %v, want %v", methods, w)
	}

	var got [][]string
	c := &Control{Herdr: "/opt/herdr", SystemdRun: "/usr/bin/systemd-run", Home: "/home/u",
		Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
			got = append(got, argv)
			return []byte(`{"result":{"process_info":{"pane_id":"w1:p2"}}}`), nil, nil
		}}
	ctx := context.Background()
	id := "01a0663b-61cd-73a0-a3a0-034ca9fc6c48"
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(c.StartSession(ctx, "h3d-it-1"))
	_, err := c.StopSession(ctx, "h3d-it-1")
	must(err)
	must(c.ResumeAgent(ctx, "h3d-it-1", "w1:p2", "claude", id))
	must(c.ResumeAgent(ctx, "h3d-it-1", "w1:p2", "codex", id))
	must(c.ReportCodexSession(ctx, "h3d-it-1", "w1:p2", id))
	_, err = c.PaneProcesses(ctx, "h3d-it-1", "w1:p2")
	must(err)
	wantArgv := [][]string{
		{"/usr/bin/systemd-run", "--user", "--unit=herdr-s-h3d-it-1", "--collect", "-p", "KillMode=process",
			"--working-directory=/home/u", "/bin/fish", "-l", "-c", "exec herdr --session 'h3d-it-1' server"},
		{"/opt/herdr", "session", "stop", "h3d-it-1", "--json"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "run", "w1:p2", "claude --resume " + id},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "run", "w1:p2", "codex resume " + id},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "report-agent-session", "w1:p2",
			"--source", "herdr:codex", "--agent", "codex", "--agent-session-id", id},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "process-info", "--pane", "w1:p2"},
	}
	if !reflect.DeepEqual(got, wantArgv) {
		t.Fatalf("argv =\n%q\nwant\n%q", got, wantArgv)
	}
}

func TestControlRefusesBadArgumentsBeforeRunning(t *testing.T) {
	ran := false
	c := &Control{Home: "/home/u", Only: regexp.MustCompile(`^h3d-it-`),
		Run: func(context.Context, []string) ([]byte, []byte, error) { ran = true; return nil, nil, nil }}
	ctx := context.Background()
	id := "8cb4e8a5-0000-4000-8000-000000000000"
	for name, call := range map[string]func() error{
		"unwatched session":      func() error { return c.StartSession(ctx, "herdr-3d") },
		"stop unwatched":         func() error { _, err := c.StopSession(ctx, "code-review"); return err },
		"quote in session":       func() error { return c.StartSession(ctx, "h3d-it-'x") },
		"space in session":       func() error { return c.StartSession(ctx, "h3d-it- x") },
		"flag session":           func() error { _, err := c.StopSession(ctx, "--all"); return err },
		"long session":           func() error { return c.StartSession(ctx, "h3d-it-"+strings.Repeat("x", 60)) },
		"bad pane":               func() error { return c.ResumeAgent(ctx, "h3d-it-1", "w1:p1;rm", "claude", id) },
		"flag pane":              func() error { return c.ReportCodexSession(ctx, "h3d-it-1", "--x", id) },
		"shell in id":            func() error { return c.ResumeAgent(ctx, "h3d-it-1", "w1:p1", "claude", id+"; rm -rf ~") },
		"flag id":                func() error { return c.ResumeAgent(ctx, "h3d-it-1", "w1:p1", "claude", "-p") },
		"empty id":               func() error { return c.ReportCodexSession(ctx, "h3d-it-1", "w1:p1", "") },
		"unknown harness":        func() error { return c.ResumeAgent(ctx, "h3d-it-1", "w1:p1", "opencode", id) },
		"process-info unwatched": func() error { _, err := c.PaneProcesses(ctx, "depot-manager", "w1:p1"); return err },
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if ran {
		t.Fatal("a refused command ran")
	}
	bad := &Control{Home: "relative/home", Run: c.Run}
	if err := bad.StartSession(ctx, "h3d-it-1"); !errors.Is(err, ErrNotAllowed) || ran {
		t.Fatalf("relative home: %v", err)
	}
	for _, name := range []string{".", "..", "-x", ""} {
		if ValidSessionName(name) {
			t.Errorf("ValidSessionName(%q)", name)
		}
	}
	for _, name := range []string{"herdr-3d", "h3d-m3go-a1b2", "my.session_1"} {
		if !ValidSessionName(name) {
			t.Errorf("!ValidSessionName(%q)", name)
		}
	}
}

// The default runner executes the command itself with herdr's pane and
// Claude variables stripped (the bridge may run inside a herdr pane).
func TestControlExecsWithCleanEnv(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	fake := filepath.Join(dir, "herdr")
	script := "#!/bin/sh\n{ printf '%s\\n' \"$@\"; echo ---; env; } > " + out + "\necho '{\"session\":{\"running\":false},\"stopped\":true}'\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_SOCKET_PATH", "/elsewhere/herdr.sock")
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")
	t.Setenv("H3D_KEEP", "yes")
	c := &Control{Herdr: fake}
	res, err := c.StopSession(context.Background(), "h3d-it-x")
	if err != nil {
		t.Fatal(err)
	}
	if res != `{"session":{"running":false},"stopped":true}` {
		t.Fatalf("output = %q", res)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	args, env, _ := strings.Cut(string(b), "---\n")
	if args != "session\nstop\nh3d-it-x\n--json\n" {
		t.Fatalf("args = %q", args)
	}
	if strings.Contains(env, "HERDR_SOCKET_PATH") || strings.Contains(env, "CLAUDE_CODE_CHILD_SESSION") || !strings.Contains(env, "H3D_KEEP=yes") {
		t.Fatalf("env not cleaned:\n%s", env)
	}

	// A failing command reports its stderr.
	failing := filepath.Join(dir, "failing")
	if err := os.WriteFile(failing, []byte("#!/bin/sh\necho 'no such session' >&2\nexit 3\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	c.Herdr = failing
	if _, err := c.StopSession(context.Background(), "h3d-it-x"); err == nil || !strings.Contains(err.Error(), "no such session") {
		t.Fatalf("err = %v", err)
	}
}

func TestPaneProcesses(t *testing.T) {
	reply := func(out string, fail bool) Runner {
		return func(context.Context, []string) ([]byte, []byte, error) {
			if fail {
				return []byte(out), nil, errors.New("exit status 1")
			}
			return []byte(out), nil, nil
		}
	}
	ctx := context.Background()
	c := &Control{Run: reply(`{"id":"cli:pane:process_info","result":{"process_info":{"foreground_process_group_id":969511,
		"foreground_processes":[{"argv":["/home/u/.local/bin/claude","--resume","fbf86c1a"],"cmdline":"/home/u/.local/bin/claude --resume fbf86c1a","name":"claude","pid":969511},
		{"argv":["node","mcp"],"cmdline":"node mcp","name":"MainThread","pid":969904}],"pane_id":"w2:p1","shell_pid":969372},"type":"pane_process_info"}}`, false)}
	p, err := c.PaneProcesses(ctx, "s", "w2:p1")
	if err != nil {
		t.Fatal(err)
	}
	if p.AtShell() || !p.Runs("claude", "fbf86c1a") || !p.Runs("claude", "") || p.Runs("codex", "") {
		t.Fatalf("claude pane = %+v", p)
	}
	c.Run = reply(`{"result":{"process_info":{"foreground_process_group_id":962380,"foreground_processes":[{"argv":["/bin/fish"],"cmdline":"/bin/fish","name":"fish","pid":962380}],"pane_id":"w1:p1","shell_pid":962380}}}`, false)
	if p, err = c.PaneProcesses(ctx, "s", "w1:p1"); err != nil || !p.AtShell() || p.Runs("claude", "") {
		t.Fatalf("shell pane = %+v, %v", p, err)
	}
	c.Run = reply(`{"error":{"code":"pane_not_found","message":"pane not found"},"id":"cli:pane:process_info"}`, true)
	var api *APIError
	if _, err = c.PaneProcesses(ctx, "s", "w9:p1"); !errors.As(err, &api) || api.Code != "pane_not_found" {
		t.Fatalf("missing pane: %v", err)
	}
}
