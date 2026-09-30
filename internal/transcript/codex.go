package transcript

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"

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
}

type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// codexPart is a content or output item. Image data is never decoded.
type codexPart struct {
	Type string `json:"type"`
	Text string `json:"text"`
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
	images  int
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
				o.images++
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
}

// parseCodex reads one line of a Codex rollout.
func parseCodex(off int64, b []byte) (cs []contrib, version string) {
	var l codexLine
	if err := json.Unmarshal(b, &l); err != nil {
		return []contrib{unknownItem(offID(off), "(invalid line)", 0)}, ""
	}
	ts := parseTS(l.Timestamp)
	id := offID(off)
	switch l.Type {
	case "response_item":
		var it codexItem
		if err := json.Unmarshal(l.Payload, &it); err != nil {
			return []contrib{unknownItem(id, "response_item", ts)}, ""
		}
		return codexResponse(&it, id, ts), ""
	case "event_msg":
		var ev codexEvent
		_ = json.Unmarshal(l.Payload, &ev)
		cs := []contrib{codexEventItem(&ev, id, ts)}
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

// execCmd is the first exec_command's cmd in a code-mode script.
var execCmd = regexp.MustCompile(`\bcmd:\s*"((?:[^"\\]|\\.)*)"`)

// Injected context Codex sends as user messages (AGENTS.md, the
// environment): not the user's words.
var codexInjected = []string{"# AGENTS.md instructions", "<environment_context>", "<user_instructions>", "<INSTRUCTIONS>",
	"<user_shell_command>", "<turn_aborted>"}

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

func codexResponse(it *codexItem, lineID string, ts int64) []contrib {
	id := it.ID
	if id == "" {
		id = lineID
	}
	switch it.Type {
	case "message":
		return []contrib{codexMessage(it, id, ts)}
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
		if it.Namespace != "" {
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
		if it.Name == "exec" { // code mode: a script; its first command says most
			var code string
			if json.Unmarshal(input, &code) == nil {
				if m := execCmd.FindStringSubmatch(code); m != nil {
					if cmd, err := strconv.Unquote(`"` + m[1] + `"`); err == nil {
						summary = cmd
					}
				}
			}
		}
		var diffs []proto.TranscriptDiff
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
			var paths []string
			for _, d := range diffs {
				paths = append(paths, d.Path)
			}
			if len(paths) > 0 {
				summary = strings.Join(paths, ", ")
			}
		}
		return []contrib{{id: callID, kind: proto.ItemTool, ts: ts, apply: func(b *builder) {
			b.call(name, input, summary)
			if diffs != nil {
				b.diffs = diffs
			}
		}}}
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
		status := proto.ToolOK
		if s := it.Output.success; s != nil && !*s {
			status = proto.ToolError
		}
		text, images := it.Output.text, it.Output.images
		return []contrib{{link: linkResult, id: it.CallID, kind: proto.ItemTool, ts: ts,
			apply: func(b *builder) { b.result(status, text, images) }}}
	case "agent_message":
		var ss []string
		for _, p := range it.Content.list {
			if p.Text != "" {
				ss = append(ss, p.Text)
			}
		}
		text := strings.TrimSpace(strings.Join(ss, "\n"))
		if it.Author != "" || it.Recipient != "" {
			text = it.Author + " → " + it.Recipient + "\n" + text
		}
		return []contrib{noticeItem(id, "agent_message", text, ts)}
	}
	return []contrib{unknownItem(id, "response_item/"+it.Type, ts)}
}

func codexMessage(it *codexItem, id string, ts int64) contrib {
	var parts []proto.TranscriptPart
	var dropped []string
	list := it.Content.list
	if it.Content.isStr {
		list = []codexPart{{Type: "input_text", Text: it.Content.str}}
	}
	for _, p := range list {
		switch p.Type {
		case "input_image", "output_image", "image":
			parts = append(parts, proto.TranscriptPart{ImageOmitted: true})
		default:
			switch {
			case strings.TrimSpace(p.Text) == "":
			case it.Role == "user" && injected(p.Text):
				dropped = append(dropped, p.Text)
			case it.Role == "user" && imageWrapper(p.Text):
			default:
				parts = append(parts, textParts(p.Text)...)
			}
		}
	}
	switch it.Role {
	case "user":
		if len(parts) == 0 {
			return hiddenNotice(id, "message/user", strings.Join(dropped, "\n"), ts)
		}
		return contrib{id: id, kind: proto.ItemUser, ts: ts, apply: func(b *builder) { b.it.Parts = parts }}
	case "assistant":
		return contrib{id: id, kind: proto.ItemAssistant, ts: ts, apply: func(b *builder) { b.it.Parts = parts }}
	}
	if it.Role == "developer" || it.Role == "system" {
		return hiddenNotice(id, "message/"+it.Role, partsText(parts), ts)
	}
	return unknownItem(id, "message/"+it.Role, ts)
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

func codexEventItem(ev *codexEvent, id string, ts int64) contrib {
	src := "event_msg/" + ev.Type
	switch ev.Type {
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
	}
	if codexHiddenEvents[ev.Type] {
		return hiddenNotice(id, src, ev.Message, ts)
	}
	return unknownItem(id, src, ts)
}

// parsePatch reads apply_patch's patch format ("*** Begin Patch", "***
// Update File: p", "@@ …", "-old", "+new", " ctx") into diffs, one per
// file; its hunks have no line numbers.
func parsePatch(patch string) []proto.TranscriptDiff {
	var out []proto.TranscriptDiff
	var cur *proto.TranscriptDiff
	var hunk *proto.TranscriptHunk
	flush := func() {
		if cur != nil && hunk != nil && len(hunk.Lines) > 0 {
			cur.Hunks = append(cur.Hunks, *hunk)
		}
		hunk = nil
	}
	file := func(path string) {
		flush()
		out = append(out, proto.TranscriptDiff{Path: strings.TrimSpace(path), Hunks: []proto.TranscriptHunk{}})
		cur = &out[len(out)-1]
	}
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "*** Update File: "):
			file(strings.TrimPrefix(line, "*** Update File: "))
		case strings.HasPrefix(line, "*** Add File: "):
			file(strings.TrimPrefix(line, "*** Add File: "))
		case strings.HasPrefix(line, "*** Delete File: "):
			file(strings.TrimPrefix(line, "*** Delete File: "))
		case strings.HasPrefix(line, "*** Move to: "):
			if cur != nil {
				cur.Path += " → " + strings.TrimSpace(strings.TrimPrefix(line, "*** Move to: "))
			}
		case strings.HasPrefix(line, "***"): // Begin/End Patch, End of File
		case cur == nil:
		case strings.HasPrefix(line, "@@"):
			flush()
			hunk = &proto.TranscriptHunk{}
		case line != "" && (line[0] == '+' || line[0] == '-' || line[0] == ' '):
			if hunk == nil {
				hunk = &proto.TranscriptHunk{}
			}
			hunk.Lines = append(hunk.Lines, line)
			switch line[0] {
			case '+':
				hunk.NewLines++
			case '-':
				hunk.OldLines++
			default:
				hunk.OldLines++
				hunk.NewLines++
			}
		}
	}
	flush()
	return out
}
