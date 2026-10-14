package transcript

import (
	"encoding/json"
	"strings"
)

// Read-only helpers for #9's transcript reducer (internal/handoffllm): the
// same prompt and tool-input rules the trackers use, exported so the
// reducer reads a line the way the rest of the bridge does. No behaviour
// of their own.

// GenuinePrompt reports whether a Claude user text block is something a
// person sent (not a reminder or a notification Claude Code wraps in tags).
func GenuinePrompt(s string) bool { return genuinePrompt(s) }

// StripReminders takes Claude Code's <system-reminder> blocks out of text.
func StripReminders(s string) string { return systemReminder.ReplaceAllString(s, "") }

// UnwrapPasted takes Claude Code's paste wrapper out of a prompt, keeping
// what was pasted and what was typed around it.
func UnwrapPasted(s string) string { return unwrapPasted(s) }

// Interrupted reports whether a Claude user text block is Claude Code's
// "[Request interrupted by user…]" note.
func Interrupted(s string) bool { return strings.HasPrefix(strings.TrimSpace(s), interruptedText) }

// CodexInjected reports whether a Codex user message part is context Codex
// injected (AGENTS.md, the environment, a skill's text, an image wrapper),
// not the user's words.
func CodexInjected(s string) bool { return injected(s) || imageWrapper(s) }

// SummarizeToolInput describes a tool input: the first of its usual fields
// (command, file_path, path, pattern, url, …) that is a string, else the
// input itself.
func SummarizeToolInput(input json.RawMessage) string { return summarize(input) }

// CodexCall reads a Codex response_item payload that is a tool call
// (function_call, custom_tool_call, local_shell_call) the way the
// conversation view does: its call id, name (namespace.name), a one-line
// summary of its input, and the paths an apply_patch touches. ok is false
// for any other payload.
func CodexCall(payload []byte) (callID, name, summary string, paths []string, ok bool) {
	var it codexItem
	if json.Unmarshal(payload, &it) != nil {
		return "", "", "", nil, false
	}
	switch it.Type {
	case "function_call", "custom_tool_call", "local_shell_call":
	default:
		return "", "", "", nil, false
	}
	callID = it.CallID
	if callID == "" {
		callID = it.ID
	}
	name = it.Name
	if it.Namespace != "" {
		name = it.Namespace + "." + name
	}
	input := it.Input
	switch it.Type {
	case "function_call":
		input = callArguments(it.Arguments)
	case "local_shell_call":
		if name == "" {
			name = "shell"
		}
		var a struct {
			Action struct {
				Command []string `json:"command"`
			} `json:"action"`
		}
		_ = json.Unmarshal(payload, &a)
		return callID, name, strings.Join(a.Action.Command, " "), nil, true
	}
	summary = summarize(input)
	if it.Name == "exec" {
		var code string
		if json.Unmarshal(input, &code) == nil {
			summary = execSummary(code, summary)
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
		for _, d := range parsePatch(patch) {
			paths = append(paths, d.Path)
		}
		if len(paths) > 0 {
			summary = strings.Join(paths, ", ")
		}
	}
	return callID, name, summary, paths, true
}

// CodexCallOutput reads a Codex response_item payload that is a tool's
// output (function_call_output, custom_tool_call_output,
// local_shell_call_output): its call id, its text (image parts left out)
// and whether it says it failed (older rollouts' success: false). ok is
// false for any other payload.
func CodexCallOutput(payload []byte) (callID, text string, failed, ok bool) {
	var it codexItem
	if json.Unmarshal(payload, &it) != nil {
		return "", "", false, false
	}
	switch it.Type {
	case "function_call_output", "custom_tool_call_output", "local_shell_call_output":
	default:
		return "", "", false, false
	}
	return it.CallID, it.Output.text, it.Output.success != nil && !*it.Output.success, true
}

// CodexUserText is a Codex user message payload's text a person sent: its
// parts that are not injected context, joined by newlines ("" when it has
// none).
func CodexUserText(payload []byte) string {
	var it codexItem
	if json.Unmarshal(payload, &it) != nil || it.Type != "message" || it.Role != "user" || !codexPrompt(it) {
		return ""
	}
	list := it.Content.list
	if it.Content.isStr {
		list = []codexPart{{Text: it.Content.str}}
	}
	var parts []string
	for _, p := range list {
		if strings.TrimSpace(p.Text) != "" && !injected(p.Text) && !imageWrapper(p.Text) {
			parts = append(parts, p.Text)
		}
	}
	return strings.Join(parts, "\n")
}
