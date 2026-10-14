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
