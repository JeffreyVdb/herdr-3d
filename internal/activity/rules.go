package activity

// The tool rules: a Claude or Codex tool call's name first, then its shell
// commands (Claude's Bash, Codex's exec_command and legacy shell, and every
// nested tools.<name>( call of a Codex code-mode exec script).

import (
	"encoding/json"
	"path"
	"reflect"
	"regexp"
	"strconv"
	"strings"

	"github.com/dop251/goja/ast"
	"github.com/dop251/goja/parser"
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
	// Command is an exec_command's cmd, Chars what a write_stdin types ("":
	// a poll); only CodexTerminals sets them (#132).
	Command, Chars string
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

// bareName is a tool's name without the namespace Codex may give it.
func bareName(name string) string {
	if i := strings.LastIndexByte(name, '.'); i >= 0 && !strings.HasPrefix(name, "mcp__") {
		if ns := name[:i]; ns == "functions" || ns == "multi_tool_use" || ns == "tools" {
			return name[i+1:]
		}
	}
	return name
}

// Analyze places a tool call (the rules' whole answer).
func Analyze(harness, name string, input json.RawMessage) Call {
	name = bareName(name)
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
	charsArgRe   = regexp.MustCompile(`["']?\bchars["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + "`[^`]*`" + `)`)
	pathArgRe    = regexp.MustCompile(`["']?\bpath["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`)
	patchArgRe   = regexp.MustCompile(`\*\*\* (?:Update|Add|Delete) File: ([^\n"\\]+)`)
)

// codexScript places a Codex code-mode exec script by every call in it:
// view_image is an image, apply_patch writing, then the shell rules over
// every exec_command's cmd; only write_stdin, wait or sleep is waiting
// (or a polled session's label); web is researching, update_plan planning.
func codexScript(script string) Call {
	calls := scriptCalls(script)
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
			cmd := scriptArg(cmdArgRe, x.args)
			cmds = append(cmds, cmd)
			sc := shellCall("exec_command", cmd)
			c.Nested = append(c.Nested, Nested{Kind: sc.Kind, Detail: sc.Detail, OK: sc.OK})
		case x.name == "write_stdin":
			id := scriptSession(x.args)
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

// scriptCall is one tools.<name>( call of a Codex script: its name and the
// script after it, up to the next call. What a write_stdin types (chars)
// and what an exec_command runs (cmd) is text, not code: a call written in
// it is not one (#132: typed code, a grep for a call). Other matches count,
// except a confirmed fake owner that would otherwise hide a later match.
// An unparseable script never excludes a match.
type scriptCall struct{ name, args string }

// textKeys are the argument of a call whose string value is text.
var textKeys = map[string]string{"write_stdin": "chars", "exec_command": "cmd"}

func scriptCalls(script string) []scriptCall {
	var texts [][2]int // the text of the calls kept so far, still ahead
	locs := toolCallRe.FindAllStringSubmatchIndex(script, -1)
	// Parse only when a value could actually hide another match.
	var owners map[int]bool
	parsed := false
	kept := locs[:0]
	for n, l := range locs {
		if inText(&texts, l[0]) {
			continue
		}
		if key, ok := textKeys[script[l[2]:l[3]]]; ok {
			if start, end, ok := textArg(script, l[1], key); ok {
				if n+1 < len(locs) && locs[n+1][0] < end {
					if !parsed {
						owners = realScriptCalls(script)
						parsed = true
					}
					if owners != nil && !owners[l[0]] {
						// This bogus owner would also mislabel the real call.
						continue
					}
					if owners[l[0]] {
						texts = append(texts, [2]int{start, end})
					}
				}
			}
		}
		kept = append(kept, l)
	}
	var calls []scriptCall
	for i, l := range kept {
		end := len(script)
		if i+1 < len(kept) {
			end = kept[i+1][0]
		}
		calls = append(calls, scriptCall{name: script[l[2]:l[3]], args: script[l[1]:end]})
	}
	return calls
}

// realScriptCalls finds actual calls, while leaving all other matches visible.
// A parse error makes every owner uncertain, so no text is excluded. Wrapping
// the script in an async function permits code mode's top-level await.
func realScriptCalls(script string) map[int]bool {
	const prefix = "async function __scan() {\n"
	program, err := parser.ParseFile(nil, "", prefix+script+"\n}", 0, parser.WithDisableSourceMaps)
	if err != nil {
		return nil
	}
	owners := make(map[int]bool)
	var visit func(reflect.Value)
	visit = func(v reflect.Value) {
		if !v.IsValid() {
			return
		}
		switch v.Kind() {
		case reflect.Interface, reflect.Pointer:
			if v.IsNil() {
				return
			}
			var callee ast.Expression
			switch call := v.Interface().(type) {
			case *ast.CallExpression:
				callee = call.Callee
			case *ast.NewExpression:
				callee = call.Callee
			}
			if dot, ok := callee.(*ast.DotExpression); ok {
				var id *ast.Identifier
				switch left := dot.Left.(type) {
				case *ast.Identifier:
					id = left
				case *ast.DotExpression:
					id = &left.Identifier // e.g. namespace.tools.exec_command
				}
				if id != nil && id.Name.String() == "tools" {
					owners[int(id.Idx)-1-len(prefix)] = true
				}
			}
			visit(v.Elem())
		case reflect.Slice:
			for i := 0; i < v.Len(); i++ {
				visit(v.Index(i))
			}
		case reflect.Struct:
			if v.Type().PkgPath() != "github.com/dop251/goja/ast" {
				return
			}
			for i := 0; i < v.NumField(); i++ {
				if v.Field(i).CanInterface() {
					visit(v.Field(i))
				}
			}
		}
	}
	visit(reflect.ValueOf(program))
	return owners
}

// inText says whether at is inside one of texts, dropping those that end
// before it (the matches come in order).
func inText(texts *[][2]int, at int) bool {
	in := false
	kept := (*texts)[:0]
	for _, t := range *texts {
		if t[1] <= at {
			continue
		}
		kept = append(kept, t)
		in = in || t[0] <= at
	}
	*texts = kept
	return in
}

// textArg is where the string value of key is in a call's argument object,
// read from i (just after the call's paren) one key: value pair at a time:
// bare or quoted keys, shorthand, values that are a string, a template
// without ${…}, a number or a name. ok is false for anything else (an
// expression, a regex, a nested object, a value with a newline, no such
// key, a key that is not a string): then nothing in the call is text.
func textArg(s string, i int, key string) (start, end int, ok bool) {
	i = skipSpace(s, i)
	if i >= len(s) || s[i] != '{' {
		return 0, 0, false
	}
	for i++; ; i++ {
		i = skipSpace(s, i)
		if i >= len(s) {
			return 0, 0, false
		}
		var k string
		switch c := s[i]; {
		case c == '"' || c == '\'':
			e := jsQuoted(s, i)
			if e < 0 {
				return 0, 0, false
			}
			k, i = s[i+1:e-1], e
		case c == '_' || c == '$' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z':
			j := i + 1
			for j < len(s) && jsNamePart(s[j]) {
				j++
			}
			k, i = s[i:j], j
		default:
			return 0, 0, false
		}
		i = skipSpace(s, i)
		if i < len(s) && s[i] == ',' {
			continue // shorthand
		}
		if i >= len(s) || s[i] != ':' {
			return 0, 0, false
		}
		i = skipSpace(s, i+1)
		if i >= len(s) {
			return 0, 0, false
		}
		v, e := i, -1
		switch s[i] {
		case '"', '\'':
			e = jsQuoted(s, i)
		case '`':
			e = jsTemplate(s, i)
		default:
			if k == key {
				return 0, 0, false
			}
			for e = i; e < len(s) && (jsNamePart(s[e]) || s[e] == '.' || s[e] == '-' || s[e] == '+'); e++ {
			}
			if e == i {
				return 0, 0, false
			}
		}
		if e < 0 {
			return 0, 0, false
		}
		i = skipSpace(s, e)
		if i >= len(s) || s[i] != ',' && s[i] != '}' {
			return 0, 0, false
		}
		if k == key {
			return v, e, true
		}
		if s[i] == '}' {
			return 0, 0, false
		}
	}
}

// jsQuoted is the end of the "…" or '…' string at i (-1: a newline in it,
// or no end).
func jsQuoted(s string, i int) int {
	for j := i + 1; j < len(s); j++ {
		switch s[j] {
		case s[i]:
			return j + 1
		case '\\':
			j++
		case '\n', '\r':
			return -1
		}
	}
	return -1
}

// jsTemplate is the end of the `…` template at i (-1: a ${…} in it, or no
// end).
func jsTemplate(s string, i int) int {
	for j := i + 1; j < len(s); j++ {
		switch {
		case s[j] == '`':
			return j + 1
		case s[j] == '\\':
			j++
		case s[j] == '$' && j+1 < len(s) && s[j+1] == '{':
			return -1
		}
	}
	return -1
}

func jsNamePart(c byte) bool {
	return c == '_' || c == '$' || 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9'
}

func skipSpace(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	return i
}

// scriptArg is the string argument re finds in a call's args ("": none).
func scriptArg(re *regexp.Regexp, args string) string {
	if m := re.FindStringSubmatch(args); m != nil {
		return jsString(m[1])
	}
	return ""
}

// scriptSession is a write_stdin's session in a call's args (0: none).
func scriptSession(args string) int64 {
	var id int64
	if m := sessionArgRe.FindStringSubmatch(args); m != nil {
		id, _ = strconv.ParseInt(m[1], 10, 64)
	}
	return id
}

// Terminals is what a Codex call does with background terminals (#132),
// read without the shell rules: its exec_command and write_stdin calls in
// order (Nested, with their Command and Chars, never a Kind; a session that
// is not a literal is -1), the sessions it polls, and Other: it calls some
// other tool than these and view_image.
type Terminals struct {
	Nested []Nested
	Polls  []int64
	Other  bool
}

// CodexTerminals reads a Codex call (a direct exec_command or write_stdin,
// or a code-mode exec script) as Terminals; any other call is Other.
func CodexTerminals(name string, input json.RawMessage) Terminals {
	var t Terminals
	switch bareName(name) {
	case "exec_command":
		var in struct {
			Cmd string `json:"cmd"`
		}
		_ = json.Unmarshal(input, &in)
		t.Nested = []Nested{{Command: in.Cmd}}
	case "write_stdin":
		var in struct {
			Session int64  `json:"session_id"`
			Chars   string `json:"chars"`
		}
		_ = json.Unmarshal(input, &in)
		t.Nested, t.Polls = []Nested{{Session: in.Session, Chars: in.Chars}}, []int64{in.Session}
	case "exec":
		var script string
		_ = json.Unmarshal(input, &script)
		for _, x := range scriptCalls(script) {
			switch x.name {
			case "exec_command":
				t.Nested = append(t.Nested, Nested{Command: scriptArg(cmdArgRe, x.args)})
			case "write_stdin":
				id := scriptSession(x.args)
				if id == 0 {
					id = -1 // not a literal (a variable): unknown, and not a command's
				}
				t.Nested = append(t.Nested, Nested{Session: id, Chars: scriptArg(charsArgRe, x.args)})
				t.Polls = append(t.Polls, id)
			case "view_image":
			default:
				t.Other = true
			}
		}
	default:
		t.Other = true
	}
	return t
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
	// running.
	runningRe = regexp.MustCompile(`Process running with session ID (\d+)`)
	sidRe     = regexp.MustCompile(`"session_id"\s*:\s*(\d+)`)
)

// Chunk is a code-mode call's result in its script's output (#132): a line
// of compact JSON, alone, after Codex's note that it cut the output, or
// wrapped by the script (Promise.allSettled's {status, value}, {i, result}).
type Chunk struct {
	Session  int64    // the session still running (0: none)
	ExitCode *int64   // the process exited, with this code
	Wall     *float64 // seconds the call waited
	Output   string
	// Cut: the line itself was cut; Output is what was whole of it, "…"
	// after it.
	Cut bool
}

type chunkJSON struct {
	ChunkID  *string  `json:"chunk_id"`
	Wall     *float64 `json:"wall_time_seconds"`
	Session  *int64   `json:"session_id"`
	ExitCode *int64   `json:"exit_code"`
	Output   *string  `json:"output"`
	// A wrapper's chunk.
	Value  json.RawMessage `json:"value"`
	Result json.RawMessage `json:"result"`
}

func (c *chunkJSON) chunk() bool {
	return c.Output != nil && (c.ChunkID != nil || c.Session != nil || c.ExitCode != nil)
}

// ReadChunk reads one line of a script's output as a chunk.
func ReadChunk(line string) (Chunk, bool) {
	if !strings.HasPrefix(line, "{") {
		return Chunk{}, false
	}
	var c chunkJSON
	cut := false
	if json.Unmarshal([]byte(line), &c) != nil {
		// A cut line: its fields before the output, and as much of the
		// output as is whole.
		head, rest, ok := strings.Cut(line, `"output":"`)
		c = chunkJSON{}
		if !ok || json.Unmarshal([]byte(strings.TrimSuffix(head, ",")+"}"), &c) != nil {
			return Chunk{}, false
		}
		rest = strings.TrimSuffix(rest, "…")
		for range 8 { // an escape the cut split
			var o string
			if json.Unmarshal([]byte(`"`+rest+`"`), &o) == nil {
				c.Output, cut = &o, true
				break
			}
			if rest == "" {
				break
			}
			rest = rest[:len(rest)-1]
		}
	}
	if !c.chunk() {
		inner := c.Value
		if len(inner) == 0 {
			inner = c.Result
		}
		c = chunkJSON{}
		if len(inner) == 0 || inner[0] != '{' || json.Unmarshal(inner, &c) != nil || !c.chunk() {
			return Chunk{}, false
		}
	}
	out := Chunk{ExitCode: c.ExitCode, Wall: c.Wall, Output: *c.Output, Cut: cut}
	if c.Session != nil {
		out.Session = *c.Session
	}
	if cut {
		out.Output += "…"
	}
	return out, true
}

// Chunks are the chunks of a script's output, in order.
func Chunks(output string) []Chunk {
	var out []Chunk
	for line := range strings.SplitSeq(output, "\n") {
		if c, ok := ReadChunk(line); ok {
			out = append(out, c)
		}
	}
	return out
}

// Started notes the sessions a call's output says are running: a direct
// exec_command's, or a script's, its results matched to its calls in order.
func (s *Sessions) Started(c Call, output string) {
	for _, st := range Starts(c.Nested, c.Polls, output) {
		s.put(st.Session, c.Nested[st.Nested])
	}
}

// Start is a session a call's output says is running, and the call that
// started it: its index in the call's Nested.
type Start struct {
	Session int64
	Nested  int
}

// Starts are the sessions output says the calls nested (a call's Nested,
// polling polls) started, in order: a direct exec_command's, or a
// script's, its results matched to its calls in order (several when they
// do not line up but only one call starts sessions).
func Starts(nested []Nested, polls []int64, output string) []Start {
	if len(nested) == 0 || output == "" {
		return nil
	}
	if m := runningRe.FindStringSubmatch(output); m != nil && len(nested) == 1 && nested[0].Session == 0 {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		return []Start{{id, 0}}
	}
	var out []Start
	chunks := Chunks(output)
	if len(chunks) == len(nested) {
		for i, ch := range chunks {
			if ch.Session == 0 || nested[i].Session != 0 {
				continue
			}
			out = append(out, Start{ch.Session, i})
		}
		return out
	}
	// The results do not line up: with one command, every new session is
	// its.
	only := -1
	for i := range nested {
		if nested[i].Session == 0 {
			if only >= 0 {
				return nil
			}
			only = i
		}
	}
	if only < 0 {
		return nil
	}
	for _, m := range append(sidRe.FindAllStringSubmatch(output, -1), runningRe.FindAllStringSubmatch(output, -1)...) {
		id, _ := strconv.ParseInt(m[1], 10, 64)
		if !contains64(polls, id) {
			out = append(out, Start{id, only})
		}
	}
	return out
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
