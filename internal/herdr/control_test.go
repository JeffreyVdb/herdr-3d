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
	"time"
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

		"workspace-create": {"{herdr}", "--session", "{session}", "workspace", "create", "--cwd", "{dir}",
			"--label", "{label}", "--no-focus"},
		"worktree-create": {"{herdr}", "--session", "{session}", "worktree", "create", "--cwd", "{dir}",
			"--branch", "{branch}", "--base", "{base}", "--label", "{label}", "--no-focus"},
		"mark-pane": {"{herdr}", "--session", "{session}", "pane", "rename", "{pane}", "{marker}"},
		"start-claude": {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "claude",
			"--pane", "{pane}", "--timeout", "30000", "--",
			"--model", "{model}", "--effort", "{effort}", "--permission-mode", "bypassPermissions", "--name", "{label}"},
		"start-codex": {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
			"--pane", "{pane}", "--timeout", "30000", "--",
			"-m", "{model}", "-c", "model_reasoning_effort={effort}", "--dangerously-bypass-approvals-and-sandbox"},
		"read-pane":  {"{herdr}", "--session", "{session}", "pane", "read", "{pane}", "--source", "visible"},
		"key-down":   {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "down"},
		"key-enter":  {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "enter"},
		"key-ctrl-c": {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "ctrl+c"},
		"prompt": {"{herdr}", "--session", "{session}", "agent", "prompt", "{pane}", "{text}",
			"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"},
		"exit-claude":     {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "/exit"},
		"exit-codex":      {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "/quit"},
		"workspace-close": {"{herdr}", "--session", "{session}", "workspace", "close", "{workspace}"},
		"worktree-remove": {"{herdr}", "--session", "{session}", "worktree", "remove", "--workspace", "{workspace}"},

		// M5 term
		"observe": {"{herdr}", "--session", "{session}", "terminal", "session", "observe", "{pane}",
			"--cols", "{cols}", "--rows", "{rows}"},
		"send-keys":     {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "{keys}"},
		"send-text":     {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "{input}"},
		"send-sequence": {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "{seq}"},
		"prompt-wait": {"{herdr}", "--session", "{session}", "agent", "prompt", "{pane}", "{message}",
			"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"},
		"prompt-queued": {"{herdr}", "--session", "{session}", "agent", "prompt", "{pane}", "{message}"},
		// #95
		"type-text": {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "{chunk}"},

		// #74
		"zoom-on":  {"{herdr}", "--session", "{session}", "pane", "zoom", "{pane}", "--on"},
		"zoom-off": {"{herdr}", "--session", "{session}", "pane", "zoom", "{pane}", "--off"},

		// #155
		"start-codex-server": {"{herdr}", "--session", "{session}", "pane", "run", "{pane}",
			"setsid -f fish {launcher} </dev/null >/dev/null 2>&1"},
		"start-codex-remote": {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
			"--pane", "{pane}", "--timeout", "30000", "--", "--remote", "unix://{socket}", "-C", "{cwd}",
			"-m", "{model}", "-c", "model_reasoning_effort={effort}", "--dangerously-bypass-approvals-and-sandbox"},
		"resume-codex-remote": {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
			"--pane", "{pane}", "--timeout", "30000", "--", "resume", "{id}", "--remote", "unix://{socket}", "-C", "{cwd}",
			"-m", "{model}", "-c", "model_reasoning_effort={effort}"},
		"resume-codex-embedded": {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
			"--pane", "{pane}", "--timeout", "30000", "--", "resume", "{id}",
			"-m", "{model}", "-c", "model_reasoning_effort={effort}", "--dangerously-bypass-approvals-and-sandbox"},
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
	if w := []string{"CloseWorkspace", "CreateWorkspace", "CreateWorktree", "EraseTyped", "MarkPane", "Observe", "PaneProcesses", "Prompt",
		"QueuePrompt", "ReadPane", "RemoveWorktree", "ReportCodexSession", "ResumeAgent", "ResumeCodexEmbedded", "ResumeCodexRemote", "SendKey", "SendKeys",
		"SendSequence", "SendText", "SetZoom", "StartAgent", "StartCodexRemote", "StartCodexServer", "StartSession", "StopSession",
		"SubmitPrompt", "TypeExit", "TypePrompt"}; !slices.Equal(methods, w) {
		t.Fatalf("Control methods = %v, want %v", methods, w)
	}

	var got [][]string
	c := &Control{Herdr: "/opt/herdr", SystemdRun: "/usr/bin/systemd-run", Home: "/home/u", CodexRun: "/run/user/7/herdr-world/codex",
		Run: func(_ context.Context, argv []string) ([]byte, []byte, error) {
			got = append(got, argv)
			if slices.Contains(argv, "create") {
				return []byte(`{"result":{"workspace":{"workspace_id":"w7"},"root_pane":{"pane_id":"w7:p1"}}}`), nil, nil
			}
			return []byte(`{"result":{"process_info":{"pane_id":"w1:p2"}}}`), nil, nil
		},
		Stream: func(argv []string) (Proc, error) {
			got = append(got, argv)
			return fakeProc{strings.NewReader("")}, nil
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
	_, err = c.CreateWorkspace(ctx, "h3d-it-1", "/home/u/repo", "Mochi")
	must(err)
	_, err = c.CreateWorktree(ctx, "h3d-it-1", "/home/u/repo", "h3d/mochi-a58752", "origin/main", "Mochi")
	must(err)
	must(c.MarkPane(ctx, "h3d-it-1", "w7:p1", "h3d-a58752ea6511"))
	must(c.StartAgent(ctx, "h3d-it-1", "w7:p1", "mochi-a58752", Agent{Harness: "claude", Model: "claude-opus-5-5", Effort: "xhigh", Label: "Mochi the 2nd"}))
	must(c.StartAgent(ctx, "h3d-it-1", "w7:p1", "mochi-a58752", Agent{Harness: "codex", Model: "gpt-6-sol", Effort: "ultra", Label: "ignored"}))
	_, err = c.ReadPane(ctx, "h3d-it-1", "w7:p1")
	must(err)
	must(c.SendKey(ctx, "h3d-it-1", "w7:p1", KeyDown))
	must(c.SendKey(ctx, "h3d-it-1", "w7:p1", KeyEnter))
	must(c.SendKey(ctx, "h3d-it-1", "w7:p1", KeyCtrlC))
	must(c.Prompt(ctx, "h3d-it-1", "w7:p1", "-x fix it; rm -rf ~ $(id)\nplease"))
	must(c.TypeExit(ctx, "h3d-it-1", "w7:p1", "claude"))
	must(c.TypeExit(ctx, "h3d-it-1", "w7:p1", "codex"))
	must(c.CloseWorkspace(ctx, "h3d-it-1", "w7"))
	must(c.RemoveWorktree(ctx, "h3d-it-1", "w7"))
	// M5 term
	obs, err := c.Observe(ctx, "h3d-it-1", "w7:p1", 120, 40)
	must(err)
	must(obs.Close())
	must(c.SendKeys(ctx, "h3d-it-1", "w7:p1", "ctrl+c", "up", "enter"))
	must(c.SendKeys(ctx, "h3d-it-1", "w7:p1", "2"))
	must(c.SendText(ctx, "h3d-it-1", "w7:p1", "--help; rm -rf ~ $(id) ✓"))
	must(c.SendSequence(ctx, "h3d-it-1", "w7:p1", "delete"))
	must(c.SendSequence(ctx, "h3d-it-1", "w7:p1", "home"))
	must(c.SubmitPrompt(ctx, "h3d-it-1", "w7:p1", "--wait fix it\nplease"))
	must(c.QueuePrompt(ctx, "h3d-it-1", "w7:p1", "then run the tests"))
	must(c.SetZoom(ctx, "h3d-it-1", "w7:p1", true)) // #74
	must(c.SetZoom(ctx, "h3d-it-1", "w7:p1", false))
	c.TypeGap = time.Nanosecond
	must(c.TypePrompt(ctx, "h3d-it-1", "w7:p1", "--help\r\n/run it; rm -rf ~ $(id)")) // #95
	must(c.EraseTyped(ctx, "h3d-it-1", "w7:p1", 2))                                   // #95 R1
	// #155
	run := "/run/user/7/herdr-world/codex/"
	remote := Remote{Socket: run + "a58752ea6511.sock", Cwd: "/home/u/.herdr/worktrees/r/h3d-mochi-a58752"}
	codex := Agent{Harness: "codex", Model: "gpt-6-sol", Effort: "low"}
	must(c.StartCodexServer(ctx, "h3d-it-1", "w7:p1", run+"a58752ea6511.fish"))
	must(c.StartCodexRemote(ctx, "h3d-it-1", "w7:p1", "mochi-a58752", codex, remote))
	must(c.ResumeCodexRemote(ctx, "h3d-it-1", "w7:p1", "mochi-a58752", id, codex, remote))
	must(c.ResumeCodexEmbedded(ctx, "h3d-it-1", "w7:p1", "mochi-a58752", id, codex))
	wantArgv := [][]string{
		{"/usr/bin/systemd-run", "--user", "--unit=herdr-s-h3d-it-1", "--collect", "-p", "KillMode=process",
			"--working-directory=/home/u", "/bin/fish", "-l", "-c", "exec herdr --session 'h3d-it-1' server"},
		{"/opt/herdr", "session", "stop", "h3d-it-1", "--json"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "run", "w1:p2", "claude --resume " + id},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "run", "w1:p2", "codex resume " + id},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "report-agent-session", "w1:p2",
			"--source", "herdr:codex", "--agent", "codex", "--agent-session-id", id},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "process-info", "--pane", "w1:p2"},
		{"/opt/herdr", "--session", "h3d-it-1", "workspace", "create", "--cwd", "/home/u/repo", "--label", "Mochi", "--no-focus"},
		{"/opt/herdr", "--session", "h3d-it-1", "worktree", "create", "--cwd", "/home/u/repo", "--branch", "h3d/mochi-a58752",
			"--base", "origin/main", "--label", "Mochi", "--no-focus"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "rename", "w7:p1", "h3d-a58752ea6511"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "start", "mochi-a58752", "--kind", "claude", "--pane", "w7:p1",
			"--timeout", "30000", "--", "--model", "claude-opus-5-5", "--effort", "xhigh",
			"--permission-mode", "bypassPermissions", "--name", "Mochi the 2nd"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "start", "mochi-a58752", "--kind", "codex", "--pane", "w7:p1",
			"--timeout", "30000", "--", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=ultra",
			"--dangerously-bypass-approvals-and-sandbox"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "read", "w7:p1", "--source", "visible"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "down"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "enter"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "ctrl+c"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "prompt", "w7:p1", "-x fix it; rm -rf ~ $(id)\nplease",
			"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", "/exit"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", "/quit"},
		{"/opt/herdr", "--session", "h3d-it-1", "workspace", "close", "w7"},
		{"/opt/herdr", "--session", "h3d-it-1", "worktree", "remove", "--workspace", "w7"},
		{"/opt/herdr", "--session", "h3d-it-1", "terminal", "session", "observe", "w7:p1", "--cols", "120", "--rows", "40"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "ctrl+c", "up", "enter"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "2"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", "--help; rm -rf ~ $(id) ✓"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", "\x1b[3~"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", "\x1b[H"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "prompt", "w7:p1", "--wait fix it\nplease",
			"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "prompt", "w7:p1", "then run the tests"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "zoom", "w7:p1", "--on"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "zoom", "w7:p1", "--off"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-text", "w7:p1", "--help\n/run it; rm -rf ~ $(id)"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "enter"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "send-keys", "w7:p1", "ctrl+u", "backspace", "ctrl+u", "backspace"},
		{"/opt/herdr", "--session", "h3d-it-1", "pane", "run", "w7:p1",
			"setsid -f fish /run/user/7/herdr-world/codex/a58752ea6511.fish </dev/null >/dev/null 2>&1"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "start", "mochi-a58752", "--kind", "codex", "--pane", "w7:p1",
			"--timeout", "30000", "--", "--remote", "unix:///run/user/7/herdr-world/codex/a58752ea6511.sock",
			"-C", "/home/u/.herdr/worktrees/r/h3d-mochi-a58752", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=low",
			"--dangerously-bypass-approvals-and-sandbox"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "start", "mochi-a58752", "--kind", "codex", "--pane", "w7:p1",
			"--timeout", "30000", "--", "resume", id, "--remote", "unix:///run/user/7/herdr-world/codex/a58752ea6511.sock",
			"-C", "/home/u/.herdr/worktrees/r/h3d-mochi-a58752", "-m", "gpt-6-sol", "-c", "model_reasoning_effort=low"},
		{"/opt/herdr", "--session", "h3d-it-1", "agent", "start", "mochi-a58752", "--kind", "codex", "--pane", "w7:p1",
			"--timeout", "30000", "--", "resume", id, "-m", "gpt-6-sol", "-c", "model_reasoning_effort=low",
			"--dangerously-bypass-approvals-and-sandbox"},
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
		"unknown resume harness": func() error { return c.ResumeAgent(ctx, "h3d-it-1", "w1:p1", "opencode", id) },
		"process-info unwatched": func() error { _, err := c.PaneProcesses(ctx, "depot-manager", "w1:p1"); return err },

		"create unwatched": func() error { _, err := c.CreateWorkspace(ctx, "herdr-3d", "/tmp", "x"); return err },
		"relative cwd":     func() error { _, err := c.CreateWorkspace(ctx, "h3d-it-1", "tmp/x", "x"); return err },
		"unclean cwd":      func() error { _, err := c.CreateWorkspace(ctx, "h3d-it-1", "/tmp/../etc", "x"); return err },
		"newline cwd":      func() error { _, err := c.CreateWorkspace(ctx, "h3d-it-1", "/tmp/a\nb", "x"); return err },
		"flag label":       func() error { _, err := c.CreateWorkspace(ctx, "h3d-it-1", "/tmp", "--focus"); return err },
		"empty label":      func() error { _, err := c.CreateWorkspace(ctx, "h3d-it-1", "/tmp", ""); return err },
		"control in label": func() error { _, err := c.CreateWorkspace(ctx, "h3d-it-1", "/tmp", "a\x1b[2Jb"); return err },
		"long label": func() error {
			_, err := c.CreateWorkspace(ctx, "h3d-it-1", "/tmp", strings.Repeat("x", 65))
			return err
		},
		"foreign branch": func() error {
			_, err := c.CreateWorktree(ctx, "h3d-it-1", "/r", "main", "origin/main", "x")
			return err
		},
		"branch injection": func() error {
			_, err := c.CreateWorktree(ctx, "h3d-it-1", "/r", "h3d/x --force", "origin/main", "x")
			return err
		},
		"local base": func() error { _, err := c.CreateWorktree(ctx, "h3d-it-1", "/r", "h3d/x", "HEAD", "x"); return err },
		"dotdot base": func() error {
			_, err := c.CreateWorktree(ctx, "h3d-it-1", "/r", "h3d/x", "origin/a..b", "x")
			return err
		},
		"lock base": func() error {
			_, err := c.CreateWorktree(ctx, "h3d-it-1", "/r", "h3d/x", "origin/m.lock", "x")
			return err
		},
		"not a marker":     func() error { return c.MarkPane(ctx, "h3d-it-1", "w1:p1", "rm -rf") },
		"uppercase marker": func() error { return c.MarkPane(ctx, "h3d-it-1", "w1:p1", "h3d-ABCDEF") },
		"unknown harness": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "x", Agent{Harness: "opencode", Model: "m", Effort: "low"})
		},
		"flag model": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "x", Agent{Harness: "codex", Model: "--yolo", Effort: "low"})
		},
		"model with space": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "x", Agent{Harness: "codex", Model: "a b", Effort: "low"})
		},
		"effort injection": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "x", Agent{Harness: "codex", Model: "m", Effort: "low -c x=y"})
		},
		"claude flag label": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "x", Agent{Harness: "claude", Model: "m", Effort: "low", Label: "-p"})
		},
		"claude no label": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "x", Agent{Harness: "claude", Model: "m", Effort: "low"})
		},
		"bad agent name": func() error {
			return c.StartAgent(ctx, "h3d-it-1", "w1:p1", "X y", Agent{Harness: "codex", Model: "m", Effort: "low"})
		},
		"unknown key":         func() error { return c.SendKey(ctx, "h3d-it-1", "w1:p1", Key("y")) },
		"flag prompt":         func() error { return c.Prompt(ctx, "h3d-it-1", "w1:p1", "--wait") },
		"empty prompt":        func() error { return c.Prompt(ctx, "h3d-it-1", "w1:p1", " \n") },
		"NUL prompt":          func() error { return c.Prompt(ctx, "h3d-it-1", "w1:p1", "a\x00b") },
		"huge prompt":         func() error { return c.Prompt(ctx, "h3d-it-1", "w1:p1", strings.Repeat("x", MaxPrompt+1)) },
		"exit unknown":        func() error { return c.TypeExit(ctx, "h3d-it-1", "w1:p1", "opencode") },
		"flag workspace":      func() error { return c.CloseWorkspace(ctx, "h3d-it-1", "--group") },
		"workspace path":      func() error { return c.RemoveWorktree(ctx, "h3d-it-1", "w1/../w2") },
		"close unwatched":     func() error { return c.CloseWorkspace(ctx, "herdr-3d", "w1") },
		"prompt unwatched":    func() error { return c.Prompt(ctx, "code-review", "w1:p1", "hi") },
		"read pane unwatched": func() error { _, err := c.ReadPane(ctx, "code-review", "w1:p1"); return err },
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

// herdr reports server errors as JSON on stderr; Control surfaces them as
// *APIError so callers can tell agent_not_ready and friends apart.
func TestControlAPIErrors(t *testing.T) {
	c := &Control{Run: func(context.Context, []string) ([]byte, []byte, error) {
		return nil, []byte(`{"error":{"code":"agent_not_ready","message":"agent x is blocked during startup"},"id":"cli:agent:start"}` + "\n"),
			errors.New("exit status 1")
	}}
	err := c.StartAgent(context.Background(), "s", "w1:p1", "x", Agent{Harness: "codex", Model: "gpt-6-luna", Effort: "low"})
	var api *APIError
	if !errors.As(err, &api) || api.Code != "agent_not_ready" {
		t.Fatalf("err = %v", err)
	}
	c.Run = func(context.Context, []string) ([]byte, []byte, error) {
		return []byte(`{"result":{"type":"worktree_created","workspace":{"workspace_id":"w2"},"root_pane":{"pane_id":"w2:p1"},
			"worktree":{"branch":"h3d/mochi-a58752","path":"/home/u/.herdr/worktrees/r/h3d-mochi-a58752"}}}`), nil, nil
	}
	cr, err := c.CreateWorktree(context.Background(), "s", "/r", "h3d/mochi-a58752", "origin/main", "Mochi")
	if err != nil || cr != (Created{WorkspaceID: "w2", PaneID: "w2:p1", Branch: "h3d/mochi-a58752",
		CheckoutPath: "/home/u/.herdr/worktrees/r/h3d-mochi-a58752"}) {
		t.Fatalf("created = %+v, %v", cr, err)
	}
	c.Run = func(context.Context, []string) ([]byte, []byte, error) { return []byte(`{"result":{}}`), nil, nil }
	if _, err := c.CreateWorkspace(context.Background(), "s", "/r", "x"); err == nil {
		t.Fatal("missing ids accepted")
	}
}

// #155: the shared Codex launch's paths and working directory are typed
// into a shell (or the TUI's command line): each is refused before anything
// runs unless it is plain, and the launcher and socket sit directly in
// CodexRun.
func TestControlRefusesUnsafeCodexLaunch(t *testing.T) {
	ran := false
	run := "/run/user/7/herdr-world/codex"
	c := &Control{CodexRun: run, Run: func(context.Context, []string) ([]byte, []byte, error) { ran = true; return nil, nil, nil }}
	ctx := context.Background()
	codex := Agent{Harness: "codex", Model: "gpt-6-sol", Effort: "low"}
	sock := run + "/a1.sock"
	id := "01a0663b-61cd-73a0-a3a0-034ca9fc6c48"
	for name, call := range map[string]func() error{
		"launcher outside run": func() error { return c.StartCodexServer(ctx, "s", "w1:p1", "/tmp/a1.fish") },
		"launcher in a subdir": func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/x/a1.fish") },
		"launcher not fish":    func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/a1.sh") },
		"launcher with space":  func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/a 1.fish") },
		"launcher with ;":      func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/a;rm.fish") },
		"launcher with $":      func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/$(id).fish") },
		"launcher dotdot":      func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/../a1.fish") },
		"launcher too long":    func() error { return c.StartCodexServer(ctx, "s", "w1:p1", run+"/"+strings.Repeat("a", 80)+".fish") },
		"no run dir":           func() error { return (&Control{Run: c.Run}).StartCodexServer(ctx, "s", "w1:p1", run+"/a1.fish") },
		"socket outside run": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: "/tmp/a1.sock", Cwd: "/r"})
		},
		"socket not sock": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: run + "/a1.fish", Cwd: "/r"})
		},
		"cwd with space": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: sock, Cwd: "/r/a b"})
		},
		"cwd with quote": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: sock, Cwd: "/r/a'b"})
		},
		"cwd with backtick": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: sock, Cwd: "/r/`id`"})
		},
		"cwd relative": func() error { return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: sock, Cwd: "r"}) },
		"cwd unclean": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: sock, Cwd: "/r/../etc"})
		},
		"cwd newline": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", codex, Remote{Socket: sock, Cwd: "/r\n/x"})
		},
		"remote claude": func() error {
			return c.StartCodexRemote(ctx, "s", "w1:p1", "x", Agent{Harness: "claude", Model: "m", Effort: "low"}, Remote{Socket: sock, Cwd: "/r"})
		},
		"resume flag id": func() error {
			return c.ResumeCodexRemote(ctx, "s", "w1:p1", "x", "--yolo", codex, Remote{Socket: sock, Cwd: "/r"})
		},
		"resume shell id": func() error {
			return c.ResumeCodexRemote(ctx, "s", "w1:p1", "x", id+";rm", codex, Remote{Socket: sock, Cwd: "/r"})
		},
		"embedded flag id":  func() error { return c.ResumeCodexEmbedded(ctx, "s", "w1:p1", "x", "--yolo", codex) },
		"embedded shell id": func() error { return c.ResumeCodexEmbedded(ctx, "s", "w1:p1", "x", id+";rm", codex) },
		"embedded no id":    func() error { return c.ResumeCodexEmbedded(ctx, "s", "w1:p1", "x", "", codex) },
		"embedded effort override": func() error {
			return c.ResumeCodexEmbedded(ctx, "s", "w1:p1", "x", id, Agent{Harness: "codex", Model: "m", Effort: "low -c x"})
		},
		"embedded claude": func() error {
			return c.ResumeCodexEmbedded(ctx, "s", "w1:p1", "x", id, Agent{Harness: "claude", Model: "m", Effort: "low"})
		},
		"resume effort override": func() error {
			return c.ResumeCodexRemote(ctx, "s", "w1:p1", "x", id, Agent{Harness: "codex", Model: "m", Effort: "low -c x"}, Remote{Socket: sock, Cwd: "/r"})
		},
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if ran {
		t.Fatal("a refused command ran")
	}
	for _, ok := range []string{"/home/u/repo", "/home/u/.herdr/worktrees/r/h3d-mochi-a58752", "/srv/a+b@c,d=e:f"} {
		if !ValidPlainDir(ok) {
			t.Errorf("!ValidPlainDir(%q)", ok)
		}
	}
}
