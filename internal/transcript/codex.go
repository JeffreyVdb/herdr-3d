package transcript

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/codexreply"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Codex rollout lines (<--codex-sessions>/YYYY/MM/DD/rollout-*.jsonl),
// codex-rs RolloutItem: {timestamp, type, payload}. Internal too: anything
// not recognised is an unknown item.

// codexHidden are line types that are only metadata: hidden notices.
var codexHidden = map[string]bool{
	"session_meta": true, "turn_context": true, "world_state": true, "token_usage_record": true,
	"inter_agent_communication_metadata": true,
}

// codexHiddenEvents are event_msg types that repeat what response items
// say (or are bookkeeping): hidden notices.
var codexHiddenEvents = map[string]bool{
	"token_count": true, "item_completed": true, "item_started": true, "thread_settings_applied": true,
	"task_started": true, "user_message": true, "agent_message": true, "agent_reasoning": true,
	"agent_reasoning_raw_content": true, "agent_reasoning_section_break": true, "exec_command_begin": true,
	"exec_command_end": true, "patch_apply_begin": true, "patch_apply_end": true, "mcp_tool_call_begin": true,
	"mcp_tool_call_end": true, "web_search_begin": true, "web_search_end": true, "turn_diff": true,
	"context_compacted": true, "view_image_tool_call": true, "entered_review_mode": true, "exited_review_mode": true,
	// #25: a legacy-history rollout's SubAgentActivity (the call's own row
	// says it; internal/codexchild reads it).
	"sub_agent_activity": true,
}

type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// codexPart is a content or output item.
type codexPart struct {
	Type     string `json:"type"`
	Text     string `json:"text"`
	ImageURL string `json:"image_url"`
}

// codexImage is an image part's ref: a data URL is inline, anything else
// (a remote URL) is text the view shows, never fetched.
func (pc *parseCtx) codexImage(url, origin, kind string) imgRef {
	if mime, b64, ok := dataURL(url); ok {
		return pc.inline(mime, b64, origin, kind)
	}
	return pc.external(url, origin, kind)
}

type codexItem struct {
	Type      string           `json:"type"`
	ID        string           `json:"id"`
	Role      string           `json:"role"`
	CallID    string           `json:"call_id"`
	Name      string           `json:"name"`
	Namespace string           `json:"namespace"`
	Content   strOr[codexPart] `json:"content"`
	Summary   strOr[codexPart] `json:"summary"`
	Input     json.RawMessage  `json:"input"`
	Arguments json.RawMessage  `json:"arguments"`
	Output    codexOutput      `json:"output"`
	Author    string           `json:"author"`
	Recipient string           `json:"recipient"`
	Status    string           `json:"status"`
}

// codexOutput is a call's output: a string, a list of parts, or (older
// rollouts) {"content", "success"}.
type codexOutput struct {
	text    string
	images  []string // image_url of each image part
	success *bool
}

func (o *codexOutput) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 {
		return nil
	}
	switch b[0] {
	case '"':
		return json.Unmarshal(b, &o.text)
	case '[':
		var ps []codexPart
		if err := json.Unmarshal(b, &ps); err != nil {
			return err
		}
		var ss []string
		for _, p := range ps {
			switch p.Type {
			case "input_image", "output_image", "image":
				o.images = append(o.images, p.ImageURL)
			default:
				if p.Text != "" {
					ss = append(ss, p.Text)
				}
			}
		}
		o.text = strings.Join(ss, "\n")
	case '{':
		var v struct {
			Content string `json:"content"`
			Success *bool  `json:"success"`
		}
		if err := json.Unmarshal(b, &v); err != nil {
			return err
		}
		o.text, o.success = v.Content, v.Success
	}
	return nil
}

type codexMeta struct {
	ID         string `json:"id"`
	CliVersion string `json:"cli_version"`
}

type codexEvent struct {
	Type       string   `json:"type"`
	Message    string   `json:"message"`
	DurationMs *float64 `json:"duration_ms"`
	Reason     string   `json:"reason"`
	// image_generation_end: the image as base64 and where Codex saved it.
	CallID    string `json:"call_id"`
	Result    string `json:"result"`
	SavedPath string `json:"saved_path"`
	// Item is item_started / item_completed's item (#151); an McpToolCall
	// and (#21) a FileChange are read.
	Item json.RawMessage `json:"item"`
	// patch_apply_end (#21, codex-cli 0.145-0.146): what a patch did.
	Stdout  string                 `json:"stdout"`
	Stderr  string                 `json:"stderr"`
	Success *bool                  `json:"success"`
	Status  string                 `json:"status"`
	Changes map[string]codexChange `json:"changes"`
}

// codexFileChange is the FileChange item of an item_completed event (#21,
// codex-cli 0.147+): what a patch did. Its id is the call's for a direct
// apply_patch, a nested id ("exec-<uuid>") for an exec script's
// tools.apply_patch, which no field links to the script.
type codexFileChange struct {
	Type    string                 `json:"type"`
	ID      string                 `json:"id"`
	Changes map[string]codexChange `json:"changes"`
	Status  string                 `json:"status"`
	Stdout  string                 `json:"stdout"`
	Stderr  string                 `json:"stderr"`
}

// codexMCPCall is the McpToolCall item of an item_started / item_completed
// event: a call an exec script (code mode) made, which has no response
// item of its own (#151). codex-cli 0.160.0.
type codexMCPCall struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	Status    string          `json:"status"`
	// Result is the MCP result: {content: [parts], isError, structuredContent}.
	Result json.RawMessage `json:"result"`
	// Error is a call that failed with no result: {message} (or a string).
	Error json.RawMessage `json:"error"`
}

// CodexHistoryStart reads a Codex subagent's rollout (#25): its records
// before ordinal start (its subagent_history_start_ordinal, codex.Meta) are
// its parent's copied history, the copy of the parent's session_meta among
// them, and are hidden notices, never the child's conversation (0: none).
func CodexHistoryStart(start int64) Option {
	return func(l *Log) {
		if start > 0 && l.harness == Codex {
			l.parse = func(off int64, b []byte) ([]contrib, string) { return parseCodexFrom(start, off, b) }
		}
	}
}

// parseCodexFrom is parseCodex of a rollout whose records before ordinal
// start are inherited.
func parseCodexFrom(start, off int64, b []byte) ([]contrib, string) {
	var l struct {
		Timestamp string `json:"timestamp"`
		Ordinal   *int64 `json:"ordinal"`
		Type      string `json:"type"`
	}
	if json.Unmarshal(b, &l) == nil && off > 0 && (l.Ordinal == nil || *l.Ordinal < start) {
		return []contrib{hiddenNotice(offID(off), "inherited/"+l.Type, "", parseTS(l.Timestamp))}, ""
	}
	return parseCodex(off, b)
}

// parseCodex reads one line of a Codex rollout.
func parseCodex(off int64, b []byte) (cs []contrib, version string) {
	var l codexLine
	if err := json.Unmarshal(b, &l); err != nil {
		return []contrib{unknownItem(offID(off), "(invalid line)", 0)}, ""
	}
	ts := parseTS(l.Timestamp)
	id := offID(off)
	pc := newParseCtx(off, b)
	switch l.Type {
	case "response_item":
		var it codexItem
		if err := json.Unmarshal(l.Payload, &it); err != nil {
			return []contrib{unknownItem(id, "response_item", ts)}, ""
		}
		return codexResponse(&it, id, ts, pc), ""
	case "event_msg":
		var ev codexEvent
		_ = json.Unmarshal(l.Payload, &ev)
		cs := codexEventItems(&ev, id, ts, pc)
		if ev.Type == "turn_aborted" {
			cs = append(cs, contrib{link: linkAbort, ts: ts, apply: func(b *builder) { b.interrupt() }})
		}
		return cs, ""
	case "compacted":
		var c struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(l.Payload, &c)
		note := strings.TrimSpace(c.Message)
		if note == "" {
			note = "Conversation compacted"
		}
		return []contrib{{id: id, kind: proto.ItemCompaction, ts: ts, apply: func(b *builder) { b.notice("compacted", note) }}}, ""
	case "session_meta":
		var m codexMeta
		_ = json.Unmarshal(l.Payload, &m)
		return []contrib{hiddenNotice(id, l.Type, "", ts)}, m.CliVersion
	}
	if codexHidden[l.Type] {
		return []contrib{hiddenNotice(id, l.Type, "", ts)}, ""
	}
	raw := l.Type
	if raw == "" {
		raw = "(no type)"
	}
	return []contrib{unknownItem(id, raw, ts)}, ""
}

// execCmd is an exec_command's cmd in a code-mode script.
var execCmd = regexp.MustCompile(`\bcmd:\s*"((?:[^"\\]|\\.)*)"`)

// Injected context Codex sends as user messages (AGENTS.md, the
// environment; #224: a "$skill" prompt's skill text, a user message of its
// own after the prompt, checked on codex-cli 0.162.1): not the user's words.
var codexInjected = []string{"# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<INSTRUCTIONS>",
	"<user_shell_command>", "<turn_aborted>", "<skill>\n<name>"}

// execSummary is a code-mode script's summary: its first exec_command's
// cmd, plus how many more the script runs (Codex lists each as its own
// row; the script is in the row's input). fallback if it has no cmd.
func execSummary(code, fallback string) string {
	var cmds []string
	for _, m := range execCmd.FindAllStringSubmatch(code, -1) {
		if cmd, err := strconv.Unquote(`"` + m[1] + `"`); err == nil {
			cmds = append(cmds, cmd)
		}
	}
	if len(cmds) == 0 {
		return fallback
	}
	more := ""
	if len(cmds) > 1 {
		more = " (+" + strconv.Itoa(len(cmds)-1) + " more)"
	}
	return clipSummaryWith(cmds[0], more)
}

func injected(s string) bool {
	s = strings.TrimSpace(s)
	for _, p := range codexInjected {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// imageWrapper is the text Codex puts around a pasted image.
func imageWrapper(s string) bool {
	s = strings.TrimSpace(s)
	return s == "</image>" || (strings.HasPrefix(s, "<image") && strings.HasSuffix(s, ">") && !strings.Contains(s, "\n"))
}

func codexResponse(it *codexItem, lineID string, ts int64, pc *parseCtx) []contrib {
	id := it.ID
	if id == "" {
		id = lineID
	}
	switch it.Type {
	case "message":
		return []contrib{codexMessage(it, id, ts, pc)}
	case "reasoning":
		var parts []proto.TranscriptPart
		for _, p := range append(it.Summary.list, it.Content.list...) {
			if strings.TrimSpace(p.Text) != "" {
				parts = append(parts, proto.TranscriptPart{Text: p.Text})
			}
		}
		return []contrib{{id: id, kind: proto.ItemThinking, ts: ts, apply: func(b *builder) { b.it.Parts = parts }}}
	case "function_call", "custom_tool_call", "local_shell_call":
		callID := it.CallID
		if callID == "" {
			callID = id
		}
		name := it.Name
		collab := collabKind(it)
		if it.Namespace != "" && collab == "" { // #56: a collaboration call is its bare name
			name = it.Namespace + "." + name
		}
		if it.Type == "local_shell_call" && name == "" {
			name = "shell"
		}
		input := it.Input
		if it.Type == "function_call" {
			input = callArguments(it.Arguments)
		}
		summary := summarize(input)
		var co *proto.TranscriptCollab
		if collab != "" { // #56: never the message, which is encrypted
			c, sum := collabCall(collab, input)
			co, summary = &c, sum
		}
		var diffs []proto.TranscriptDiff
		var changes *proto.TranscriptChanges
		script := it.Name == "exec"
		if script { // code mode: a script; its first command says most
			var code string
			if json.Unmarshal(input, &code) == nil {
				// #21: the patches it passes as plain literals, proposed until its output; the others it computes.
				patches, computed := patchLiterals(code)
				for _, p := range patches {
					diffs = append(diffs, parsePatch(p)...)
				}
				if computed > 0 {
					changes = &proto.TranscriptChanges{Computed: computed}
				}
				if cmd := execSummary(code, ""); cmd != "" {
					summary = cmd
				} else if len(diffs) > 0 {
					summary = diffPaths(diffs)
				}
			}
		}
		if it.Name == "apply_patch" {
			var patch string
			if json.Unmarshal(input, &patch) != nil {
				var in struct {
					Input string `json:"input"`
				}
				_ = json.Unmarshal(input, &in)
				patch = in.Input
			}
			diffs = parsePatch(patch)
			if len(diffs) > 0 {
				summary = diffPaths(diffs)
			}
		}
		viewPath := ""
		if it.Name == "view_image" {
			var in struct {
				Path string `json:"path"`
			}
			_ = json.Unmarshal(input, &in)
			viewPath = in.Path
		}
		// #132: the background terminals it starts or polls.
		terms, poll := codexTerminals(it.Name, input)
		var ask *askCall // #57: the question card
		if it.Name == CodexAskTool && it.Namespace == "" {
			if a, ok := parseAsk(Codex, input); ok {
				ask = &a
			}
		}
		return []contrib{{id: callID, kind: proto.ItemTool, ts: ts, maybeImg: viewPath != "", script: script, terms: terms, poll: poll, apply: func(b *builder) {
			if poll != nil {
				b.call(name, input, poll.summary(b.pollCmd))
				b.poll = poll
			} else {
				b.call(name, input, summary)
			}
			b.script = script
			if co != nil {
				c := *co
				b.it.Collab = &c
			}
			if ask != nil {
				b.ask = ask
				b.tool().Ask = ask.card(Codex)
			}
			if diffs != nil {
				b.diffs, b.literal = diffs, true
			}
			if changes != nil {
				b.changes = changes
			}
			if viewPath != "" {
				b.viewPath = viewPath
			}
		}}}
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
		status := proto.ToolOK
		if s := it.Output.success; s != nil && !*s {
			status = proto.ToolError
		}
		text := it.Output.text
		// #21: a script that threw (a patch that failed verification among
		// others), and a direct patch that failed verification.
		patchFailed := strings.HasPrefix(text, "apply_patch verification failed")
		if patchFailed || strings.HasPrefix(text, "Script failed\n") {
			status = proto.ToolError
		}
		var images []imgRef
		for _, u := range it.Output.images {
			images = append(images, pc.codexImage(u, proto.OriginAgent, proto.KindViewed))
		}
		return []contrib{{link: linkResult, id: it.CallID, kind: proto.ItemTool, ts: ts, imgs: images, out: text,
			apply: func(b *builder) {
				if p := b.poll; p != nil { // #132: the process, and only the new output
					r := p.pollOutput(text)
					b.result(r.status(status), r.body, images)
					b.tool().Terminal = r.term
				} else {
					b.result(status, text, images)
				}
				if b.it.Collab != nil {
					collabOutput(b.it.Collab, text)
				}
				// #21: a script's own patches were only proposed: what it did is
				// what Codex recorded (its own rows), never the script's text.
				// A direct patch that failed verification changed nothing.
				if b.literal && (b.script || patchFailed) {
					b.diffs, b.literal = nil, false
				}
				if b.script {
					b.changes = nil
				}
				if b.ask != nil && b.it.Tool.Ask != nil {
					a := *b.it.Tool.Ask
					a.Outcome, a.Answers = b.ask.codexResult(text)
					b.it.Tool.Ask = &a
				}
			}}}
	case "agent_message": // #56: a message from another agent, a notice
		c := collabInbound(it)
		n := noticeItem(id, "agent_message", collabNotice(c), ts)
		set := n.apply
		n.apply = func(b *builder) {
			set(b)
			c := c
			b.it.Collab = &c
		}
		return []contrib{n}
	}
	return []contrib{unknownItem(id, "response_item/"+it.Type, ts)}
}

func codexMessage(it *codexItem, id string, ts int64, pc *parseCtx) contrib {
	var parts []proto.TranscriptPart
	var imgs []imgRef
	var dropped []string
	list := it.Content.list
	if it.Content.isStr {
		list = []codexPart{{Type: "input_text", Text: it.Content.str}}
	}
	if it.Role == "user" {
		if answers, raw, ok := codexAnswers(list); ok {
			// #183: the reply to an async question. Parts keep the envelope as sent (a plain part: an
			// "[Image #n: path]" inside an answer is not an image), Answers are what the view shows.
			return contrib{id: id, kind: proto.ItemUser, ts: ts, apply: func(b *builder) {
				b.it.Parts, b.it.Answers = []proto.TranscriptPart{{Text: raw}}, answers
			}}
		}
	}
	for _, p := range list {
		switch p.Type {
		case "input_image", "output_image", "image":
			origin, kind := proto.OriginInput, ""
			if it.Role != "user" {
				origin, kind = proto.OriginAgent, proto.KindGenerated
			}
			ir := pc.codexImage(p.ImageURL, origin, kind)
			imgs = append(imgs, ir)
			parts = append(parts, proto.TranscriptPart{Image: ir.ref})
		default:
			switch {
			case strings.TrimSpace(p.Text) == "":
			case it.Role == "user" && injected(p.Text):
				dropped = append(dropped, p.Text)
			case it.Role == "user" && imageWrapper(p.Text):
			default:
				var ps []proto.TranscriptPart
				var is []imgRef
				if it.Role == "user" {
					ps, is = textParts(pc, p.Text)
				} else {
					ps = []proto.TranscriptPart{{Text: p.Text}}
				}
				parts = append(parts, ps...)
				imgs = append(imgs, is...)
			}
		}
	}
	switch it.Role {
	case "user":
		if len(parts) == 0 {
			return hiddenNotice(id, "message/user", strings.Join(dropped, "\n"), ts)
		}
		return contrib{id: id, kind: proto.ItemUser, ts: ts, imgs: imgs, apply: func(b *builder) { b.it.Parts = parts }}
	case "assistant":
		return contrib{id: id, kind: proto.ItemAssistant, ts: ts, imgs: imgs, apply: func(b *builder) { b.it.Parts = parts }}
	}
	if it.Role == "developer" || it.Role == "system" {
		return hiddenNotice(id, "message/"+it.Role, partsText(parts), ts)
	}
	return unknownItem(id, "message/"+it.Role, ts)
}

// codexAnswers reads a user message as the reply to Codex's async questions
// (#183): its text parts, joined as the bridge joins a user message's text
// inputs (codexapp.Item.UserText), are one complete validated envelope
// (codexreply.ParseReply: nothing before or after it, every id the async
// tool's). A message with an image, a prompt that quotes an envelope and a
// malformed or cut one are not answers: the caller shows them as the text
// they are.
func codexAnswers(list []codexPart) (answers []proto.TranscriptAnswer, raw string, ok bool) {
	var b strings.Builder
	for _, p := range list {
		switch p.Type {
		case "input_image", "output_image", "image":
			return nil, "", false
		}
		b.WriteString(p.Text)
	}
	raw = b.String()
	as, ok := codexreply.ParseReply(raw)
	if !ok {
		return nil, "", false
	}
	for _, a := range as {
		answers = append(answers, proto.TranscriptAnswer{Question: a.Question, Answer: a.Answer})
	}
	return answers, raw, true
}

// callArguments is a function call's arguments: a JSON string holding JSON
// (then that JSON), or JSON itself.
func callArguments(raw json.RawMessage) json.RawMessage {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if json.Valid([]byte(s)) {
			return json.RawMessage(s)
		}
		b, _ := json.Marshal(s)
		return b
	}
	return raw
}

// codexEventItems is what an event_msg line gives: a patch's record (#21),
// else one item.
func codexEventItems(ev *codexEvent, id string, ts int64, pc *parseCtx) []contrib {
	switch ev.Type {
	case "item_completed", "patch_apply_end":
		if cs, ok := codexPatchEvent(ev, ts); ok {
			return cs
		}
		// #56: still a hidden notice of its own, and more of its call's row.
		if c, ok := codexSubAgentEvent(ev, ts); ok {
			return []contrib{codexEventItem(ev, id, ts, pc), c}
		}
	}
	return []contrib{codexEventItem(ev, id, ts, pc)}
}

func codexEventItem(ev *codexEvent, id string, ts int64, pc *parseCtx) contrib {
	src := "event_msg/" + ev.Type
	switch ev.Type {
	case "image_generation_end":
		// The image Codex generated: its base64, else the file it saved.
		var ir imgRef
		switch {
		case ev.Result != "":
			ir = pc.inline("", ev.Result, proto.OriginAgent, proto.KindGenerated)
		case ev.SavedPath != "":
			ir = pc.path(ev.SavedPath, proto.OriginAgent, proto.KindGenerated)
		default:
			return hiddenNotice(id, src, "", ts)
		}
		if ev.CallID != "" {
			id = "img:" + ev.CallID
		}
		return contrib{id: id, kind: proto.ItemAssistant, ts: ts, imgs: []imgRef{ir},
			apply: func(b *builder) { b.it.Parts = []proto.TranscriptPart{{Image: ir.ref}} }}
	case "task_complete":
		note := "Turn done"
		if ev.DurationMs != nil {
			note = "Turn took " + formatDuration(int64(*ev.DurationMs))
		}
		return noticeItem(id, src, note, ts)
	case "turn_aborted":
		note := "Turn interrupted"
		if ev.Reason != "" && ev.Reason != "interrupted" {
			note += " (" + ev.Reason + ")"
		}
		return noticeItem(id, src, note, ts)
	case "error", "stream_error", "warning":
		return noticeItem(id, src, ev.Message, ts)
	case "item_started", "item_completed":
		if c, ok := codexMCPEvent(ev, ts); ok {
			return c
		}
	}
	if codexHiddenEvents[ev.Type] {
		return hiddenNotice(id, src, ev.Message, ts)
	}
	return unknownItem(id, src, ts)
}

// codexMCPEvent is the tool row of an McpToolCall item event: the call
// (running) of an item_started, the call and its result of an
// item_completed. A completion alone is enough; the row's id is the item's,
// so a start joins it, and a response item with the same call id too. Other
// item types repeat response items: not ok.
func codexMCPEvent(ev *codexEvent, ts int64) (contrib, bool) {
	var m codexMCPCall
	if !bytes.Contains(ev.Item, []byte(`"McpToolCall"`)) || json.Unmarshal(ev.Item, &m) != nil || m.Type != "McpToolCall" || m.ID == "" ||
		(m.Server == "" && m.Tool == "") {
		return contrib{}, false
	}
	name := m.Tool
	if m.Server != "" {
		name = m.Server + "." + name
	}
	input := callArguments(m.Arguments)
	summary := summarize(input)
	call := func(b *builder) {
		// A response item of the same call (its id the item's) names it.
		t := b.tool()
		if t.Name == "" {
			t.Name, t.Input, t.InputSummary = name, input, clipSummary(summary)
		}
		if t.Status == "" {
			t.Status = proto.ToolRunning
		}
	}
	if ev.Type == "item_started" {
		return contrib{id: m.ID, kind: proto.ItemTool, ts: ts, apply: call}, true
	}
	status, text := codexMCPResult(&m)
	return contrib{link: linkResult, id: m.ID, kind: proto.ItemTool, ts: ts, apply: func(b *builder) {
		call(b)
		if status == proto.ToolRunning {
			return
		}
		out := text
		if b.tool().OutputText != "" { // the response item's output came first
			out = ""
		}
		b.result(status, out, nil)
	}}, true
}

// codexMCPResult is an McpToolCall's status (running while the item says it
// is in progress) and result text: the text parts of the result's content,
// else its structuredContent, else the error's message.
func codexMCPResult(m *codexMCPCall) (status, text string) {
	status = proto.ToolOK
	switch m.Status {
	case "", "completed":
	case "inProgress", "in_progress", "running":
		status = proto.ToolRunning
	default: // failed, declined, …
		status = proto.ToolError
	}
	var r struct {
		Content           []codexPart     `json:"content"`
		IsError           bool            `json:"isError"`
		StructuredContent json.RawMessage `json:"structuredContent"`
	}
	if len(m.Result) > 0 && json.Unmarshal(m.Result, &r) == nil {
		var ss []string
		for _, p := range r.Content {
			if p.Text != "" {
				ss = append(ss, p.Text)
			}
		}
		text = strings.Join(ss, "\n")
		if text == "" && len(r.StructuredContent) > 0 && string(r.StructuredContent) != "null" {
			text = string(r.StructuredContent)
		}
		if r.IsError {
			status = proto.ToolError
		}
	}
	if e := bytes.TrimSpace(m.Error); len(e) > 0 && string(e) != "null" {
		status = proto.ToolError
		var v struct {
			Message string `json:"message"`
		}
		var s string
		switch {
		case json.Unmarshal(e, &s) == nil:
			text = s
		case json.Unmarshal(e, &v) == nil && v.Message != "":
			text = v.Message
		default:
			text = string(e)
		}
	}
	return status, text
}

// codexPatchEvent is what Codex recorded a patch did (#21): a FileChange
// item_completed (codex-cli 0.147+) or a patch_apply_end (0.145-0.146).
// Its row is the item's id: a direct apply_patch's call (whose diffs it
// replaces: these are real, the patch's text only proposed them), else a
// row of its own named apply_patch, where the line is: after the exec
// script that ran it, before the script's output. A nested one also
// tells that script (linkScript) that its proposed patches are done.
func codexPatchEvent(ev *codexEvent, ts int64) ([]contrib, bool) {
	var id, status, stdout, stderr string
	var changes map[string]codexChange
	switch ev.Type {
	case "patch_apply_end":
		id, stdout, stderr, changes = ev.CallID, ev.Stdout, ev.Stderr, ev.Changes
		status = codexPatchStatus(ev.Status, ev.Success)
	default:
		var fc codexFileChange
		if !bytes.Contains(ev.Item, []byte(`"FileChange"`)) || json.Unmarshal(ev.Item, &fc) != nil || fc.Type != "FileChange" {
			return nil, false
		}
		id, stdout, stderr, changes = fc.ID, fc.Stdout, fc.Stderr, fc.Changes
		status = codexPatchStatus(fc.Status, nil)
	}
	if id == "" {
		return nil, false
	}
	diffs := fileChangeDiffs(changes)
	text := strings.TrimRight(stdout, "\n")
	if e := strings.TrimRight(stderr, "\n"); e != "" {
		text = strings.TrimLeft(text+"\n"+e, "\n")
	}
	cs := []contrib{{link: linkResult, id: id, kind: proto.ItemTool, ts: ts, apply: func(b *builder) {
		t := b.tool()
		if t.Name == "" {
			t.Name, t.InputSummary = "apply_patch", clipSummary(diffPaths(diffs))
		}
		b.diffs, b.literal = diffs, false
		out := text
		if t.OutputText != "" { // the call's own output came first
			out = ""
		}
		b.result(status, out, nil)
	}}}
	if strings.HasPrefix(id, "exec-") {
		cs = append(cs, contrib{link: linkScript, kind: proto.ItemTool, ts: ts, apply: func(b *builder) {
			if b.script && b.literal {
				b.diffs, b.literal = nil, false
			}
			if b.script {
				b.changes = nil
			}
		}})
	}
	return cs, true
}

// codexPatchStatus is a patch's status (codex-rs PatchApplyStatus):
// completed is ok, declined denied, failed (and anything else) an error;
// none (an older patch_apply_end) is its success.
func codexPatchStatus(status string, success *bool) string {
	switch status {
	case "completed":
		return proto.ToolOK
	case "declined":
		return proto.ToolDenied
	case "":
		if success != nil && *success {
			return proto.ToolOK
		}
	}
	return proto.ToolError
}

// diffPaths are a patch's files, for a summary.
func diffPaths(diffs []proto.TranscriptDiff) string {
	paths := make([]string, len(diffs))
	for i, d := range diffs {
		paths[i] = d.Path
	}
	return strings.Join(paths, ", ")
}
