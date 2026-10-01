package herdr

// #95: prompts to Claude Code are typed, not pasted. `agent prompt` sends
// a bracketed paste, which Claude Code (v2.1.287) wraps in
// <pasted_content> and tells the model may hold instructions the user did
// not write; a slash command in a paste is never run. Typed text is the
// user's own. Measured on v2.1.287 (issue #95): any input burst of more
// than 800 characters is taken as a paste anyway, so a prompt goes in
// chunks of at most 700 characters, 50 ms apart (10 ms already kept them
// apart); a typed LF is a new line, a typed CR is Enter (it would split
// the prompt) and a typed tab is dropped. Codex keeps `agent prompt`.

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	// MaxTypedChunk bounds one `pane send-text` of a typed prompt, in
	// characters (Claude Code's paste threshold is a burst of 801).
	MaxTypedChunk = 700
	// DefaultTypeGap is the pause after each chunk of a typed prompt.
	DefaultTypeGap = 50 * time.Millisecond
	// MaxTyped bounds a typed prompt as it is typed (NormalizeTyped's
	// result): the largest prompt cap (MaxPrompt), about 2.5 s of typing.
	MaxTyped = MaxPrompt
	// typedTab is what a tab is typed as.
	typedTab = "    "
)

// NormalizeTyped returns text as it is typed into Claude Code: line ends
// ("\r\n", a lone "\r") as "\n", each tab as four spaces. ok is false for
// text that cannot be typed: blank, invalid UTF-8, or with any other
// control character (ESC, NUL, DEL, a C1 control, …), which the terminal
// would read as a key.
func NormalizeTyped(text string) (string, bool) {
	if strings.TrimSpace(text) == "" || !utf8.ValidString(text) {
		return "", false
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.ReplaceAll(text, "\t", typedTab)
	for _, r := range text {
		if r != '\n' && unicode.IsControl(r) {
			return "", false
		}
	}
	return text, true
}

// typedChunks splits text into pieces of at most n characters, never
// inside a UTF-8 sequence.
func typedChunks(text string, n int) []string {
	var out []string
	for text != "" {
		i, runes := 0, 0
		for i < len(text) && runes < n {
			_, size := utf8.DecodeRuneInString(text[i:])
			i += size
			runes++
		}
		out = append(out, text[:i])
		text = text[i:]
	}
	return out
}

// validTypedChunk reports whether v may be one chunk of a typed prompt:
// 1 to MaxTypedChunk characters of UTF-8 whose only control character is
// "\n".
func validTypedChunk(v string) bool {
	if v == "" || !utf8.ValidString(v) || utf8.RuneCountInString(v) > MaxTypedChunk {
		return false
	}
	for _, r := range v {
		if r != '\n' && unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// TypePrompt types a prompt into the Claude Code agent in a pane and
// presses Enter (#95): the text normalized (NormalizeTyped), in chunks of
// at most MaxTypedChunk characters (one `pane send-text` each, TypeGap
// apart), then `pane send-keys enter`. It does not wait: the caller makes
// sure the agent is ready first (idle or done, else working to queue it;
// text typed before its input box is up is lost) and watches it start.
// Every chunk is validated before the first is typed.
func (c *Control) TypePrompt(ctx context.Context, session, pane, text string) error {
	norm, ok := NormalizeTyped(text)
	if !ok || len(norm) > MaxTyped {
		return fmt.Errorf("%w: invalid prompt to type (%d bytes)", ErrNotAllowed, len(text))
	}
	chunks := typedChunks(norm, MaxTypedChunk)
	vars := func(chunk string) map[string]string {
		return map[string]string{"session": session, "pane": pane, "chunk": chunk}
	}
	for _, ch := range chunks {
		if _, err := c.argv(opTypeText, vars(ch)); err != nil {
			return err
		}
	}
	gap := c.TypeGap
	if gap <= 0 {
		gap = DefaultTypeGap
	}
	for i, ch := range chunks {
		if _, err := c.run(ctx, opTypeText, vars(ch)); err != nil {
			return fmt.Errorf("typing part %d of %d: %w", i+1, len(chunks), err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(gap):
		}
	}
	_, err := c.run(ctx, opKeyEnter, map[string]string{"session": session, "pane": pane})
	return err
}
