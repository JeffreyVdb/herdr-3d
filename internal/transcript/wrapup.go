package transcript

// #83: a worker's wrap-up verdict. The bridge prompts the agent with a
// cleanup task and a footer asking it to end its final message with exactly
// one line, `H3D-WRAPUP <nonce> CLEAN` or `H3D-WRAPUP <nonce> BLOCKED:
// <reason>`; WrapUpTracker reads that line from the transcript. Only lines
// from the armed offset on count, only after the bridge's own prompt (the
// user line holding the nonce) was read, and only the last non-empty line
// of the final assistant message of a turn: a quoted marker, a stale nonce,
// a marker mid-message or followed by more text, or the prompt's own copy of
// the footer never match.
//
// Turn ends, checked against Claude Code 2.1.285 and codex-cli 0.159.2:
// Claude's final message is the assistant message (one message id, its
// blocks on several lines) whose stop_reason is not tool_use, and a
// system/turn_duration line follows the turn; Codex's turn ends with
// event_msg task_complete (last_agent_message: the final message's text),
// turn_aborted when it was interrupted.

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
)

// WrapUpPrefix starts the line an agent ends its wrap-up with.
const WrapUpPrefix = "H3D-WRAPUP"

// Wrap-up verdicts (WrapUpState.Verdict).
const (
	WrapUpClean   = "clean"
	WrapUpBlocked = "blocked"
	WrapUpNone    = "none" // the turn ended without a (well-formed, single) result line
)

// MaxWrapUpReason bounds a BLOCKED reason, in characters.
const MaxWrapUpReason = 200

var (
	wrapUpNonceRe = regexp.MustCompile(`^[0-9a-f]{16,64}$`)
	wrapUpLineRe  = regexp.MustCompile(`^H3D-WRAPUP ([0-9a-f]{16,64}) (CLEAN|BLOCKED: (.{1,200}))$`)
)

// ValidWrapUpNonce reports whether s can be a wrap-up nonce (lower-case hex).
func ValidWrapUpNonce(s string) bool { return wrapUpNonceRe.MatchString(s) }

// WrapUpFooter is what the bridge appends to a wrap-up prompt.
func WrapUpFooter(nonce string) string {
	return "When you are done, end your final message with exactly one line:\n" +
		WrapUpPrefix + " " + nonce + " CLEAN\n" +
		"or, if anything could not be stopped or needs a decision:\n" +
		WrapUpPrefix + " " + nonce + " BLOCKED: <one-line reason>"
}

// WrapUpVerdict reads an assistant message's text: CLEAN or BLOCKED (with
// its reason) when its last non-empty line is exactly the result line of
// nonce and no other line of it carries that nonce's marker; else
// WrapUpNone.
func WrapUpVerdict(text, nonce string) (verdict, reason string) {
	if !ValidWrapUpNonce(nonce) {
		return WrapUpNone, ""
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	last := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			last = i
			break
		}
	}
	if last < 0 {
		return WrapUpNone, ""
	}
	m := wrapUpLineRe.FindStringSubmatch(strings.TrimSpace(lines[last]))
	if m == nil || m[1] != nonce {
		return WrapUpNone, ""
	}
	mark := WrapUpPrefix + " " + nonce
	for _, l := range lines[:last] {
		if strings.Contains(l, mark) {
			return WrapUpNone, "" // two markers: never guess which one is meant
		}
	}
	if m[2] == "CLEAN" {
		return WrapUpClean, ""
	}
	reason = strings.TrimSpace(m[3])
	if reason == "" {
		return WrapUpNone, ""
	}
	return WrapUpBlocked, reason
}

// WrapUpState is what a WrapUpTracker read so far.
type WrapUpState struct {
	// Prompted: the bridge's prompt (a user line holding the nonce) was read.
	Prompted bool
	// TookOver: a person prompted the agent or interrupted it after the
	// bridge's prompt (a prompt without the nonce, an interruption).
	TookOver bool
	// Ended: the latest turn after the prompt ended; Verdict and Reason are
	// its final message's result.
	Ended   bool
	Verdict string
	Reason  string
	// Void: the lines read were void (the file was replaced or went), so
	// the offset means nothing any more.
	Void bool
	// Lines counts the lines read from the offset on: unchanged across two
	// looks, the transcript was quiet in between.
	Lines int
}

// WrapUpTracker follows one transcript's lines (with their byte offsets, as
// its tail reads them) for one armed wrap-up. Not safe for concurrent use.
type WrapUpTracker struct {
	harness string
	nonce   string
	from    int64
	st      WrapUpState
	msgID   string          // Claude: the message the text is of
	text    strings.Builder // the latest assistant message's text, this turn
	hasText bool
}

// NewWrapUpTracker follows a harness's (claude or codex) transcript for
// nonce from byte offset from; nil for another harness or a bad nonce.
func NewWrapUpTracker(harness, nonce string, from int64) *WrapUpTracker {
	if (harness != Claude && harness != Codex) || !ValidWrapUpNonce(nonce) || from < 0 {
		return nil
	}
	return &WrapUpTracker{harness: harness, nonce: nonce, from: from}
}

// Nonce is the nonce it looks for.
func (t *WrapUpTracker) Nonce() string { return t.nonce }

// From is the offset it reads from.
func (t *WrapUpTracker) From() int64 { return t.from }

// State is what it read so far.
func (t *WrapUpTracker) State() WrapUpState { return t.st }

// Reset says the lines read are void: the transcript was replaced (or went).
// What it read is forgotten, and it is void for good.
func (t *WrapUpTracker) Reset() {
	t.st = WrapUpState{Void: true}
	t.newTurn()
}

// Line reads one line starting at byte offset off.
func (t *WrapUpTracker) Line(off int64, b []byte) {
	if off < t.from || t.st.Void {
		return
	}
	t.st.Lines++
	if t.harness == Claude {
		t.claudeLine(b)
	} else {
		t.codexLine(b)
	}
}

func (t *WrapUpTracker) newTurn() {
	t.st.Ended, t.st.Verdict, t.st.Reason = false, "", ""
	t.msgID, t.hasText = "", false
	t.text.Reset()
}

// mark reports whether s holds the nonce's marker (the bridge's prompt).
func (t *WrapUpTracker) mark(s string) bool { return strings.Contains(s, WrapUpPrefix+" "+t.nonce) }

// prompt reads a user's text: the bridge's prompt, or a person's (one
// before the bridge's was answered before it, in the turns that do not
// count).
func (t *WrapUpTracker) prompt(text string) {
	if t.mark(text) {
		t.st.Prompted = true
		t.newTurn()
		return
	}
	t.interrupted()
}

// interrupted notes a person stepping in after the bridge's prompt.
func (t *WrapUpTracker) interrupted() {
	if t.st.Prompted {
		t.st.TookOver = true
	}
}

// end closes the turn with the latest message's text.
func (t *WrapUpTracker) end() {
	t.st.Ended = true
	t.st.Verdict, t.st.Reason = WrapUpVerdict(t.text.String(), t.nonce)
}

type wrapUpClaudeLine struct {
	Type             string `json:"type"`
	Subtype          string `json:"subtype"`
	IsSidechain      bool   `json:"isSidechain"`
	IsMeta           bool   `json:"isMeta"`
	IsCompactSummary bool   `json:"isCompactSummary"`
	Message          *struct {
		ID         string             `json:"id"`
		StopReason *string            `json:"stop_reason"`
		Content    strOr[claudeBlock] `json:"content"`
	} `json:"message"`
}

func (t *WrapUpTracker) claudeLine(b []byte) {
	var l wrapUpClaudeLine
	if json.Unmarshal(b, &l) != nil || l.IsSidechain {
		return
	}
	switch l.Type {
	case "system":
		if l.Subtype == "turn_duration" && t.st.Prompted && !t.st.Ended {
			t.end()
		}
		return
	case "user", "assistant":
	default:
		// Attachments (a prompt queued while the agent worked, …): the
		// bridge's prompt shows by its nonce.
		if !t.st.Prompted && t.mark(string(b)) {
			t.prompt(string(b))
		}
		return
	}
	if l.Message == nil {
		return
	}
	blocks := l.Message.Content.list
	if l.Message.Content.isStr {
		blocks = []claudeBlock{{Type: "text", Text: l.Message.Content.str}}
	}
	if l.Type == "user" {
		if l.IsMeta || l.IsCompactSummary {
			return
		}
		for _, bl := range blocks {
			switch {
			case bl.Type == "tool_result":
				if t.st.Prompted {
					t.st.Ended = false // the turn goes on
				}
			case bl.Type != "text":
			case strings.HasPrefix(strings.TrimSpace(bl.Text), interruptedText):
				t.interrupted()
			case t.mark(bl.Text) || genuinePrompt(bl.Text):
				t.prompt(bl.Text)
			}
		}
		return
	}
	if !t.st.Prompted {
		return // the turn before the bridge's prompt
	}
	if l.Message.ID != t.msgID {
		// The next message: only the final one's text counts.
		t.msgID, t.hasText = l.Message.ID, false
		t.text.Reset()
	}
	t.st.Ended, t.st.Verdict, t.st.Reason = false, "", "" // it goes on
	for _, bl := range blocks {
		if bl.Type == "text" {
			if t.hasText {
				t.text.WriteByte('\n')
			}
			t.text.WriteString(bl.Text)
			t.hasText = true
		}
	}
	if sr := l.Message.StopReason; sr != nil && *sr != "" && *sr != "tool_use" && t.hasText {
		t.end()
	}
}

type wrapUpCodexEvent struct {
	Type             string `json:"type"`
	LastAgentMessage string `json:"last_agent_message"`
}

func (t *WrapUpTracker) codexLine(b []byte) {
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return
	}
	switch l.Type {
	case "response_item":
		var it codexItem
		if json.Unmarshal(l.Payload, &it) != nil || it.Type != "message" {
			return
		}
		list := it.Content.list
		if it.Content.isStr {
			list = []codexPart{{Text: it.Content.str}}
		}
		switch it.Role {
		case "user":
			if !codexPrompt(it) {
				return
			}
			var text strings.Builder
			for _, p := range list {
				text.WriteString(p.Text)
				text.WriteByte('\n')
			}
			t.prompt(text.String())
		case "assistant":
			if !t.st.Prompted {
				return
			}
			t.st.Ended, t.st.Verdict, t.st.Reason, t.hasText = false, "", "", false
			t.text.Reset()
			for _, p := range list {
				if p.Type == "output_text" || p.Type == "text" || p.Type == "" {
					if t.hasText {
						t.text.WriteByte('\n')
					}
					t.text.WriteString(p.Text)
					t.hasText = true
				}
			}
		}
	case "event_msg":
		if !bytes.Contains(l.Payload, []byte(`"task_`)) && !bytes.Contains(l.Payload, []byte(`"turn_aborted"`)) {
			return
		}
		var ev wrapUpCodexEvent
		if json.Unmarshal(l.Payload, &ev) != nil {
			return
		}
		switch ev.Type {
		case "task_started":
			if t.st.Prompted {
				t.newTurn()
			}
		case "turn_aborted":
			t.interrupted()
		case "task_complete":
			if !t.st.Prompted {
				return
			}
			if !t.hasText && ev.LastAgentMessage != "" {
				t.text.WriteString(ev.LastAgentMessage)
				t.hasText = true
			}
			t.end()
		}
	}
}
