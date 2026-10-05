package harness

import (
	"strings"
	"unicode"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #140: built-ins whose output or dialog shows only in the worker's
// terminal. Their result never reaches the transcript (the JSONL of Claude
// Code, the rollout of Codex), and herdr reports the agent done while a
// dialog is open, so nothing the bridge reads can tell. Neither CLI says
// which commands these are (Claude's supportedCommands() rows have no such
// field), so the list is static, per harness.
//
// Observed on Claude Code 2.1.289 and codex-cli 0.160.0 (2026-10-05):
//   - Claude: usage (aliases cost, stats), status, config, mcp and help open
//     a modal window (Esc closes it) and append nothing to the JSONL. A bare
//     model opens the model picker (only "Kept model as X" after Esc);
//     "/model <name>" switches inline. context prints inline and is
//     transcribed: not listed.
//   - Codex: status prints an inline card, pwd, ps and mcp inline lines, diff
//     opens a full-screen viewer (q closes it); none of them writes to the
//     rollout. The other built-ins (codex_builtins.go) start a turn or act,
//     and their effect shows in the rollout.
//
// A name is matched exactly, aliases included: the rows the bridge lists
// carry the mark of their name (CommandEntry.Terminal), and a prompt typed
// by hand is checked with TerminalOnly.
var terminalOnly = map[string]map[string]string{
	"claude": {
		"usage":  proto.TerminalAlways,
		"cost":   proto.TerminalAlways,
		"stats":  proto.TerminalAlways,
		"status": proto.TerminalAlways,
		"config": proto.TerminalAlways,
		"mcp":    proto.TerminalAlways,
		"help":   proto.TerminalAlways,
		"model":  proto.TerminalBare,
	},
	"codex": {
		"status": proto.TerminalAlways,
		"diff":   proto.TerminalAlways,
		"pwd":    proto.TerminalAlways,
		"ps":     proto.TerminalAlways,
		"mcp":    proto.TerminalAlways,
	},
}

// terminalMode is CommandEntry.Terminal of the built-in name of harness
// kind ("" for any other).
func terminalMode(kind, name string) string {
	return terminalOnly[kind][name]
}

// TerminalOnly reports whether text, sent as a prompt to an agent of kind,
// runs one of those built-ins: it is "/name" (leading and trailing
// whitespace aside), with or without arguments as the built-in's mark
// allows. A "/name" later in the text is prose, not a command.
func TerminalOnly(kind, text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "/") {
		return false
	}
	// The name ends at the first whitespace of any kind (a tab, a line
	// end): all of what follows is the argument.
	name, rest := t[1:], ""
	if i := strings.IndexFunc(name, unicode.IsSpace); i >= 0 {
		name, rest = name[:i], name[i:]
	}
	switch terminalMode(kind, name) {
	case proto.TerminalAlways:
		return true
	case proto.TerminalBare:
		return strings.TrimSpace(rest) == ""
	}
	return false
}
