package harness

import "github.com/JeffreyVdb/herdr-3d/internal/proto"

// codexBuiltins are the Codex TUI's own slash commands that worker.commands
// offers. Codex has no API listing them, so this list is static.
//
// Source: openai/codex codex-rs/tui/src/slash_command.rs at tag rust-v0.160.0
// (commit a956835d020762cb2b570053af06f643a11c0ecc), checked 2026-10-04
// against the installed codex-cli 0.160.0. Descriptions are upstream's,
// verbatim. A pasted "/name args" dispatches as that command on Enter
// (under 1000 characters), so only commands that do their work from a pasted
// prompt are here: none that only open a TUI picker or editor (model,
// permissions, skills, resume, ...), none that end or replace the session
// (quit, exit, logout, new, clear, ...), no side conversations (side, btw),
// no debug or platform-specific ones.
//
// Gated commands: goal needs the "goals" feature, which `codex features
// list` shows stable and enabled by default. plan needs collaboration
// modes: that feature shows as "removed" (default true) because 0.160.0 no
// longer gates on it; the TUI always enables collaboration modes
// (chatwidget/constructor.rs set_collaboration_modes_enabled(true),
// chatwidget/settings.rs collaboration_modes_enabled() == true).
//
// review, rename and goal open a picker, an editor or a menu without
// arguments, so their hints say the argument is required.
//
// #140: diff opens a full-screen viewer (q closes it, Esc does not, and it
// takes the prompts typed meanwhile), unlike the rule above. It is kept: it
// does its work from a pasted prompt, and its row is marked terminal-only
// (terminal.go), so the game shows the worker's terminal once it is sent.
// status, pwd, ps and mcp print inline but write nothing to the rollout:
// marked terminal-only too.
var codexBuiltins = []proto.CommandEntry{
	{Name: "init", Description: "create an AGENTS.md file with instructions for Codex"},
	{Name: "compact", Description: "summarize conversation to prevent hitting the context limit"},
	{Name: "recap", Description: "summarize the current conversation now"},
	{Name: "review", Description: "review my current changes and find issues", ArgumentHint: "<instructions>"},
	{Name: "rename", Description: "rename the current thread", ArgumentHint: "<name>"},
	{Name: "plan", Description: "switch to Plan mode", ArgumentHint: "[prompt]"},
	{Name: "goal", Description: "set or view the goal for a long-running task", ArgumentHint: "<objective|pause|resume|clear>"},
	{Name: "diff", Description: "show git diff (including untracked files)"},
	{Name: "status", Description: "show current session configuration and token usage"},
	{Name: "pwd", Description: "show the current working directory"},
	{Name: "mcp", Description: "list configured MCP tools; use /mcp verbose for details", ArgumentHint: "[verbose]"},
	{Name: "ps", Description: "list background terminals"},
	{Name: "stop", Description: "stop all background terminals"},
}

// CodexBuiltins returns a copy of the static Codex built-in commands, each of
// kind command.
func CodexBuiltins() []proto.CommandEntry {
	out := make([]proto.CommandEntry, len(codexBuiltins))
	for i, c := range codexBuiltins {
		c.Kind = proto.CommandKindBuiltin
		c.Terminal = terminalMode("codex", c.Name)
		out[i] = c
	}
	return out
}
