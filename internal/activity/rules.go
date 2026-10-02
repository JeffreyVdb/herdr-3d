package activity

// The tool rules: a Claude or Codex tool call's name first, then its shell
// commands (Claude's Bash, Codex's exec_command and legacy shell, and every
// nested tools.<name>( call of a Codex code-mode exec script).

import (
	"encoding/json"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Harnesses the rules know.
const (
	Claude = "claude"
	Codex  = "codex"
)

// Call is what the rules make of one tool call.
type Call struct {
	Kind   Kind
	Detail string
	// OK: the rules placed it. Not OK is Working, and Command (when set) is
	// what the model may be asked about.
	OK bool
	// Keep: a meta tool (Skill, ToolSearch…), an ask (the needs-you path),
	// or a poll of a session the rules know nothing of: the current label
	// stays.
	Keep bool
	// Tool and Command are what the model is asked about (Command "": the
	// call has no command, it stays Working).
	Tool, Command string
	// Image is the image file a Read or view_image call names ("": none).
	Image string
	// Polls are the Codex sessions the call polls (write_stdin); Nested are
	// its exec_command and write_stdin calls in order, for the sessions it
	// starts (Sessions).
	Polls  []int64
	Nested []Nested
	// Background: Claude's Bash with run_in_background (the task it starts
	// is awaited later, §3b).
	Background bool
}

// Nested is one exec_command or write_stdin call of a Codex script (or the
// call itself).
type Nested struct {
	Session int64 // write_stdin: the session it writes to (0: exec_command)
	Kind    Kind
	Detail  string
	OK      bool
}

// Classify places a tool call: its kind, a short and safe detail, and
// whether the rules placed it (false: Working, the model's to try).
func Classify(harness, name string, input json.RawMessage) (Kind, string, bool) {
	c := Analyze(harness, name, input)
	return c.Kind, c.Detail, c.OK
}

// metaTools never change the label.
var metaTools = set("Skill", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
	"SendUserFile", "PushNotification", "SendFeedback", "ExitWorktree", "EnterWorktree", "ShareOnboardingGuide",
	"Artifact", "ArtifactComments", "ArtifactData", "SendMessage", "ListAgents", "FetchInboxMessage", "ReadNotifications",
	"ReportFindings", "EndConversation", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "DesignSync",
	"AskUserQuestion", "request_user_input", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource",
	"tool_search", "skill")

// Analyze places a tool call (the rules' whole answer).
func Analyze(harness, name string, input json.RawMessage) Call {
	if i := strings.LastIndexByte(name, '.'); i >= 0 && !strings.HasPrefix(name, "mcp__") {
		if ns := name[:i]; ns == "functions" || ns == "multi_tool_use" || ns == "tools" {
			name = name[i+1:]
		}
	}
	if metaTools[name] {
		return Call{Keep: true, OK: true}
	}
	var in map[string]json.RawMessage
	_ = json.Unmarshal(input, &in)
	str := func(k string) string {
		var s string
		_ = json.Unmarshal(in[k], &s)
		return s
	}
	switch name {
	case "Write", "Edit", "MultiEdit", "NotebookEdit", "create_file", "edit_file", "write_file", "str_replace_editor":
		p := str("file_path")
		if p == "" {
			p = str("notebook_path")
		}
		if p == "" {
			p = str("path")
		}
		return Call{Kind: KindWriting, Detail: fileDetail([]string{p}), OK: true}
	case "Read", "read_file":
		p := str("file_path")
		if p == "" {
			p = str("path")
		}
		c := Call{Kind: KindInvestigating, Detail: fileDetail([]string{p}), OK: true}
		if imageFile(p) {
			c.Image = p
		}
		return c
	case "Grep", "Glob", "LS", "grep", "glob", "list_dir", "find_files":
		d := str("pattern")
		if d == "" {
			d = baseOf(str("path"))
		}
		return Call{Kind: KindInvestigating, Detail: safeDetail(d, MaxDetail), OK: true}
	case "WebSearch", "web_search", "web__run", "web_search_preview", "search", "web.run":
		return Call{Kind: KindResearching, Detail: safeDetail(str("query"), MaxDetail), OK: true}
	case "WebFetch", "web_fetch", "fetch":
		return Call{Kind: KindResearching, Detail: hostOf(str("url")), OK: true}
	case "Agent", "Task", "spawn_agent", "Workflow", "delegate":
		d := str("description")
		if d == "" {
			d = str("task_name")
		}
		return Call{Kind: KindDelegating, Detail: safeDetail(d, MaxDetail), OK: true}
	case "TodoWrite", "TodoRead", "EnterPlanMode", "ExitPlanMode", "update_plan", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet":
		return Call{Kind: KindPlanning, OK: true}
	case "Monitor":
		d := str("description")
		if d == "" {
			d = firstLine(str("command"))
		}
		return Call{Kind: KindWaiting, Detail: safeDetail(d, MaxDetail), OK: true}
	case "TaskOutput", "BashOutput", "wait_agent", "wait", "ScheduleWakeup", "sleep":
		return Call{Kind: KindWaiting, OK: true}
	case "TaskStop", "KillShell", "KillBash", "close_agent", "kill_agent":
		return Call{Kind: KindWaiting, OK: true}
	case "apply_patch":
		return Call{Kind: KindWriting, Detail: fileDetail(patchFiles(patchText(input))), OK: true}
	case "view_image":
		p := str("path")
		return Call{Kind: KindInvestigating, Detail: fileDetail([]string{p}), OK: true, Image: p}
	case "Bash", "bash":
		var bg bool
		_ = json.Unmarshal(in["run_in_background"], &bg)
		c := shellCall("Bash", str("command"))
		c.Background = bg
		return c
	case "exec_command", "shell_command", "run_command", "container.exec":
		cmd := str("cmd")
		if cmd == "" {
			cmd = str("command")
		}
		if cmd == "" { // container.exec / shell: an argv
			cmd = argvCommand(in["cmd"], in["command"])
		}
		c := shellCall("exec_command", cmd)
		c.Nested = []Nested{{Kind: c.Kind, Detail: c.Detail, OK: c.OK}}
		return c
	case "shell", "local_shell":
		return shellCall("shell", argvCommand(in["command"], in["cmd"]))
	case "write_stdin":
		var id int64
		_ = json.Unmarshal(in["session_id"], &id)
		return Call{Keep: true, OK: true, Polls: []int64{id}, Nested: []Nested{{Session: id}}}
	case "exec":
		if harness == Codex || harness == "" {
			var script string
			if json.Unmarshal(input, &script) != nil {
				script = str("input")
			}
			return codexScript(script)
		}
	}
	if strings.HasPrefix(name, "mcp__") || strings.Contains(name, "__") {
		return Call{Kind: KindWorking, Detail: safeDetail(mcpName(name), MaxDetail)}
	}
	return Call{Kind: KindWorking}
}

// shellCall places a shell command.
func shellCall(tool, cmd string) Call {
	r := classifyShell(cmd)
	if r.kind == "" { // nothing but cd, echo…: Working, nothing to ask
		return Call{Kind: KindWorking, Detail: headDetail(strings.Fields(firstLine(cmd))), OK: true}
	}
	c := Call{Kind: r.kind, Detail: r.detail, OK: r.ok, Tool: tool}
	if !r.ok {
		c.Command = cmd
	}
	return c
}

// argvCommand is a legacy argv as a command line: ["bash", "-lc", cmd] is
// cmd.
func argvCommand(raws ...json.RawMessage) string {
	for _, raw := range raws {
		var argv []string
		if json.Unmarshal(raw, &argv) != nil || len(argv) == 0 {
			continue
		}
		if len(argv) >= 3 && isShell(path.Base(argv[0])) && strings.HasPrefix(argv[1], "-") && strings.Contains(argv[1], "c") {
			return argv[2]
		}
		q := make([]string, len(argv))
		for i, a := range argv {
			q[i] = shellQuote(a)
		}
		return strings.Join(q, " ")
	}
	return ""
}

func isShell(s string) bool {
	return s == "bash" || s == "sh" || s == "zsh" || s == "dash" || s == "fish"
}

func shellQuote(s string) string {
	if s != "" && !strings.ContainsAny(s, " \t\n'\"\\$`;&|<>(){}*?[]#~") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// toolCallRe finds the nested calls of a Codex script: tools.<name>(.
var toolCallRe = regexp.MustCompile(`\btools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(`)

// cmdArgRe is an exec_command's cmd in a script (a JS string).
var cmdArgRe = regexp.MustCompile(`["']?\bcmd["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + "`[^`]*`" + `)`)

// sessionArgRe and charsArgRe are a write_stdin's session and its input.
var (
	sessionArgRe = regexp.MustCompile(`["']?\bsession_id["']?\s*:\s*(\d+)`)
	charsArgRe   = regexp.MustCompile(`["']?\bchars["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`)
	pathArgRe    = regexp.MustCompile(`["']?\bpath["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`)
	patchArgRe   = regexp.MustCompile(`\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)`)
)

// codexScript places a Codex code-mode exec script by every call in it:
// view_image is an image, apply_patch writing, then the shell rules over
// every exec_command's cmd; only write_stdin, wait or sleep is waiting
// (or a polled session's label); web is researching, update_plan planning.
func codexScript(script string) Call {
	locs := toolCallRe.FindAllStringSubmatchIndex(script, -1)
	type call struct{ name, args string }
	var calls []call
	for i, l := range locs {
		end := len(script)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}
		calls = append(calls, call{name: script[l[2]:l[3]], args: script[l[1]:end]})
	}
	var c Call
	var image string
	var patches []string
	var cmds []string
	research, plan, delegate, wait := false, false, false, false
	for _, x := range calls {
		switch {
		case x.name == "view_image":
			if m := pathArgRe.FindStringSubmatch(x.args); m != nil {
				image = jsString(m[1])
			} else if image == "" {
				image = "image"
			}
		case x.name == "apply_patch":
			patches = append(patches, patchFiles(jsUnescape(x.args))...)
			if len(patches) == 0 {
				patches = append(patches, "")
			}
		case x.name == "exec_command":
			cmd := ""
			if m := cmdArgRe.FindStringSubmatch(x.args); m != nil {
				cmd = jsString(m[1])
			}
			cmds = append(cmds, cmd)
			sc := shellCall("exec_command", cmd)
			c.Nested = append(c.Nested, Nested{Kind: sc.Kind, Detail: sc.Detail, OK: sc.OK})
		case x.name == "write_stdin":
			var id int64
			if m := sessionArgRe.FindStringSubmatch(x.args); m != nil {
				id, _ = strconv.ParseInt(m[1], 10, 64)
			}
			c.Polls = append(c.Polls, id)
			c.Nested = append(c.Nested, Nested{Session: id})
		case x.name == "wait" || x.name == "sleep" || x.name == "wait_agent":
			wait = true
		case strings.HasPrefix(x.name, "web"):
			research = true
		case x.name == "update_plan":
			plan = true
		case x.name == "spawn_agent":
			delegate = true
		}
	}
	switch {
	case image != "":
		c.Kind, c.Detail, c.OK, c.Image = KindImage, fileDetail([]string{image}), true, image
	case len(patches) > 0:
		c.Kind, c.Detail, c.OK = KindWriting, fileDetail(patches), true
	case len(cmds) > 0:
		r := classifyShell(strings.Join(cmds, "\n"))
		c.Kind, c.Detail, c.OK, c.Tool = r.kind, r.detail, r.ok, "exec_command"
		if r.kind == "" {
			c.Kind, c.OK = KindWorking, true
		}
		if !r.ok {
			c.Command = strings.Join(cmds, "\n")
		}
	case research:
		c.Kind, c.OK = KindResearching, true
	case delegate:
		c.Kind, c.OK = KindDelegating, true
	case plan:
		c.Kind, c.OK = KindPlanning, true
	case len(c.Polls) > 0:
		c.Keep, c.OK = true, true // the polled session's label (Sessions), else the current one
	case wait:
		c.Kind, c.OK = KindWaiting, true
	default:
		c.Kind = KindWorking
	}
	return c
}

// jsString is a JS string literal's value (best effort).
func jsString(lit string) string {
	if len(lit) < 2 {
		return lit
	}
	q, body := lit[0], lit[1:len(lit)-1]
	switch q {
	case '"':
		if s, err := strconv.Unquote(lit); err == nil {
			return s
		}
	case '\'':
		if s, err := strconv.Unquote(`"` + strings.ReplaceAll(strings.ReplaceAll(body, `\'`, `'`), `"`, `\"`) + `"`); err == nil {
			return s
		}
	case '`':
		return body
	}
	return jsUnescape(body)
}

func jsUnescape(s string) string {
	r := strings.NewReplacer(`\n`, "\n", `\t`, "\t", `\"`, `"`, `\'`, `'`, `\\`, `\`)
	return r.Replace(s)
}

// patchText is an apply_patch call's patch (a string, or {input}).
func patchText(input json.RawMessage) string {
	var patch string
	if json.Unmarshal(input, &patch) == nil {
		return patch
	}
	var in struct {
		Input string `json:"input"`
		Patch string `json:"patch"`
	}
	_ = json.Unmarshal(input, &in)
	if in.Input != "" {
		return in.Input
	}
	return in.Patch
}

// patchFiles are the files a patch changes.
func patchFiles(patch string) []string {
	var out []string
	for _, m := range patchArgRe.FindAllStringSubmatch(patch, -1) {
		out = append(out, strings.TrimSpace(m[1]))
	}
	return out
}

// fileDetail is the first file's basename, "+N" for the others.
func fileDetail(paths []string) string {
	var ps []string
	for _, p := range paths {
		if p = strings.TrimSpace(p); p != "" {
			ps = append(ps, p)
		}
	}
	if len(ps) == 0 {
		return ""
	}
	d := path.Base(ps[0])
	if len(ps) > 1 {
		suffix := " +" + strconv.Itoa(len(ps)-1)
		return safeDetail(d, MaxDetail-len(suffix)) + suffix
	}
	return safeDetail(d, MaxDetail)
}

func imageFile(p string) bool {
	switch strings.ToLower(path.Ext(p)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp":
		return true
	}
	return false
}

// hostOf is a URL's host.
func hostOf(u string) string {
	u = strings.TrimSpace(u)
	if i := strings.Index(u, "://"); i >= 0 {
		u = u[i+3:]
	}
	if i := strings.IndexAny(u, "/?#"); i >= 0 {
		u = u[:i]
	}
	if i := strings.LastIndexByte(u, '@'); i >= 0 {
		u = u[i+1:]
	}
	return safeDetail(u, MaxDetail)
}

func mcpName(name string) string {
	parts := strings.Split(strings.TrimPrefix(name, "mcp__"), "__")
	return parts[len(parts)-1]
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// ---------------------------------------------------------------------------------------------------------------
// Codex sessions

// Sessions knows the label of each Codex exec_command session still running
// (the one that started it), so a write_stdin poll of a long pytest keeps
// showing Testing. Not safe for concurrent use.
type Sessions struct {
	m     map[int64]Nested
	order []int64
}

// maxSessions bounds the sessions remembered.
const maxSessions = 64

var (
	// runningRe is a direct exec_command's output for a process still
	// running; chunkRe a code-mode call's result (one JSON object per call).
	runningRe = regexp.MustCompile(`Process running with session ID (\d+)`)
	chunkRe   = regexp.MustCompile(`\{"chunk_id"[^{}]*\}|\{[^{}]*"session_id"\s*:\s*\d+[^{}]*\}|\{[^{}]*"exit_code"[^{}]*\}`)
	sidRe     = regexp.MustCompile(`"session_id"\s*:\s*(\d+)`)
)

// Started notes the sessions a call's output says are running: a direct
// exec_command's, or a script's, its results matched to its calls in order.
func (s *Sessions) Started(c Call, output string) {
	if len(c.Nested) == 0 || output == "" {
		return
	}
	if m := runningRe.FindStringSubmatch(output); m != nil && len(c.Nested) == 1 && c.Nested[0].Session == 0 {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		s.put(id, c.Nested[0])
		return
	}
	chunks := chunkRe.FindAllString(output, -1)
	if len(chunks) == len(c.Nested) {
		for i, ch := range chunks {
			m := sidRe.FindStringSubmatch(ch)
			if m == nil || c.Nested[i].Session != 0 {
				continue
			}
			id, _ := strconv.ParseInt(m[1], 10, 64)
			s.put(id, c.Nested[i])
		}
		return
	}
	// The results do not line up: with one command, every new session is
	// its.
	var only *Nested
	for i := range c.Nested {
		if c.Nested[i].Session == 0 {
			if only != nil {
				return
			}
			only = &c.Nested[i]
		}
	}
	if only == nil {
		return
	}
	for _, m := range append(sidRe.FindAllStringSubmatch(output, -1), runningRe.FindAllStringSubmatch(output, -1)...) {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		if !contains64(c.Polls, id) {
			s.put(id, *only)
		}
	}
}

func (s *Sessions) put(id int64, n Nested) {
	if id <= 0 || n.Kind == "" {
		return
	}
	if s.m == nil {
		s.m = map[int64]Nested{}
	}
	if _, ok := s.m[id]; !ok {
		s.order = append(s.order, id)
		if len(s.order) > maxSessions {
			delete(s.m, s.order[0])
			s.order = s.order[1:]
		}
	}
	s.m[id] = n
}

// Resolve gives a call that only polls sessions its sessions' label (the
// strongest known); one of unknown sessions stays Keep.
func (s *Sessions) Resolve(c Call) Call {
	if !c.Keep || len(c.Polls) == 0 {
		return c
	}
	var best *Nested
	for _, id := range c.Polls {
		if n, ok := s.m[id]; ok && (best == nil || strength[n.Kind] > strength[best.Kind]) {
			n := n
			best = &n
		}
	}
	if best == nil {
		return c
	}
	c.Keep, c.Kind, c.Detail, c.OK = false, best.Kind, best.Detail, best.OK
	return c
}

func contains64(xs []int64, x int64) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// Awaited is the label of what a background command or a Monitor waits on:
// the shell rules' when they say more than reading or waiting (a poll loop
// on a test log is testing), else waiting.
func Awaited(command string) Kind {
	r := classifyShell(command)
	if r.ok && strong(r.kind) {
		return r.kind
	}
	return KindWaiting
}
