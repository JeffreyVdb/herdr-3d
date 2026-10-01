package transcript

// #83: a worker's wrap-up verdict. The bridge prompts the agent with a
// cleanup task and a footer asking it to end its final message with exactly
// one line, `H3D-WRAPUP <nonce> CLEAN` or `H3D-WRAPUP <nonce> BLOCKED:
// <reason>`; WrapUpTracker reads that line from the transcript. Only lines
// from the armed offset on count, only after the bridge's own prompt (the
// first user prompt from there that ends with the nonce's footer) was read,
// and only the last non-empty line of the final assistant message of a
// turn, as it is (no trimming, but a trailing "\r"): a quoted or indented
// marker, one in a code fence, a stale nonce, a marker mid-message or
// followed by more text, or the prompt's own copy of the footer never match.
// Every user prompt after the bridge's is a person's: they took over.
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
// nonce, byte for byte (only a trailing "\r" is dropped: leading or trailing
// spaces, quotes, list markers, an indented code block or a code fence still
// open (see fenceOpen) are not it), and no other line of it carries that
// nonce's marker; else WrapUpNone.
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
	line := strings.TrimSuffix(lines[last], "\r")
	m := wrapUpLineRe.FindStringSubmatch(line)
	if m == nil || m[1] != nonce || strings.TrimRight(line, " \t") != line {
		return WrapUpNone, ""
	}
	mark := WrapUpPrefix + " " + nonce
	for _, l := range lines[:last] {
		if strings.Contains(l, mark) {
			return WrapUpNone, "" // two markers: never guess which one is meant
		}
	}
	if fenceOpen(lines[:last], false) || fenceOpen(lines[:last], true) {
		return WrapUpNone, "" // an example in a code block left open
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

// fenceOpen reports whether a code fence is still open after lines, read as
// CommonMark reads a fence: an opener is 3 or more backticks or tildes
// indented at most 3 spaces (a backtick one with no backtick after it); only
// a run of the same character, at least as long, indented at most 3 spaces
// and followed by nothing but spaces or tabs closes it. Lists and quotes are
// not parsed, and a fence in a list item closes where a top-level one would
// not, so callers read it both ways: plainly, and listed: a fence opened at
// or past a list item's content indent (that of any list marker line read
// before it, in a fence or not: where a list ends is not parsed) closes only
// at the opener's own indent, and a line left of that indent before its
// close may end the item: still open. Either one open is no result.
func fenceOpen(lines []string, listed bool) bool {
	var open struct {
		ch        byte // 0: no fence open
		n, indent int
		inItem    bool
	}
	item := -1 // the least content indent of a list item so far
	for _, l := range lines {
		if c, ok := listItem(l); ok && (item < 0 || c < item) {
			item = c
		}
		if open.ch != 0 && open.inItem && strings.TrimSpace(l) != "" && lineIndent(l) < open.indent {
			return true // it may end the item, and the fence with it: unsure
		}
		indent, ch, n, info, ok := fenceLine(l)
		switch {
		case !ok:
		case open.ch == 0:
			if ch != '`' || !strings.Contains(info, "`") {
				open.ch, open.n, open.indent = ch, n, indent
				open.inItem = listed && item >= 0 && indent >= item
			}
		case ch == open.ch && n >= open.n && strings.Trim(info, " \t\r") == "" && (!open.inItem || indent == open.indent):
			open.ch = 0
		}
	}
	return open.ch != 0
}

// lineIndent is a line's indent in columns (tab stops of 4).
func lineIndent(l string) int {
	w := 0
	for i := 0; i < len(l); i++ {
		switch l[i] {
		case ' ':
			w++
		case '\t':
			w += 4 - w%4
		default:
			return w
		}
	}
	return w
}

// listItem reads a line as a list item's first: the indent its content
// starts at (a tab after the marker counts as one space: never more than
// CommonMark's).
func listItem(l string) (content int, ok bool) {
	i := 0
	for i < len(l) && l[i] == ' ' {
		i++
	}
	switch {
	case i < len(l) && (l[i] == '-' || l[i] == '*' || l[i] == '+'):
		i++
	default:
		d := i
		for i < len(l) && i-d < 10 && l[i] >= '0' && l[i] <= '9' {
			i++
		}
		if i == d || i-d > 9 || i == len(l) || (l[i] != '.' && l[i] != ')') {
			return 0, false
		}
		i++
	}
	rest := strings.TrimRight(l[i:], "\r")
	sp := len(rest) - len(strings.TrimLeft(rest, " "))
	switch {
	case rest == "" || strings.TrimLeft(rest, " \t") == "":
		return i + 1, true // a blank item: its content starts one past it
	case sp == 0 && rest[0] != '\t':
		return 0, false
	case sp == 0 || sp > 4:
		return i + 1, true // a tab, or an indented code block in it
	}
	return i + sp, true
}

// fenceLine reads a line as a code fence: its indent, character, run length
// and what follows the run.
func fenceLine(l string) (indent int, ch byte, n int, info string, ok bool) {
	for indent < len(l) && l[indent] == ' ' {
		indent++
	}
	if indent > 3 || indent == len(l) || (l[indent] != '`' && l[indent] != '~') {
		return 0, 0, 0, "", false // a tab before it indents it 4 or more: code, no fence
	}
	ch = l[indent]
	rest := strings.TrimLeft(l[indent:], string(ch))
	if n = len(l) - indent - len(rest); n < 3 {
		return 0, 0, 0, "", false
	}
	return indent, ch, n, rest, true
}

// WrapUpState is what a WrapUpTracker read so far.
type WrapUpState struct {
	// Prompted: the bridge's prompt (the first user prompt from the offset
	// that ends with the nonce's footer) was read.
	Prompted bool
	// TookOver: a person prompted the agent or interrupted it after the
	// bridge's prompt (any later prompt, even one quoting the marker, or an
	// interruption).
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
	asked   string // the bridge's prompt as read, once Prompted
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

// asking is a user prompt's text as the bridge's would read: without
// Claude's paste wrapper and reminders, line ends and the ends trimmed.
func asking(text string) string {
	text = systemReminder.ReplaceAllString(unwrapPasted(strings.ReplaceAll(text, "\r\n", "\n")), "")
	return strings.TrimSpace(text)
}

// prompt reads a user's text. Before the bridge's prompt: the bridge's
// (it ends with the nonce's footer), or a person's (answered before it, in
// the turns that do not count). After it, every prompt is a person's, even
// one quoting the marker: they took over. Only the bridge's prompt read
// once more (the same text: Claude's queued prompt and its user line) is
// not.
func (t *WrapUpTracker) prompt(text string) {
	s := asking(text)
	switch {
	case !t.st.Prompted && strings.HasSuffix(s, WrapUpFooter(t.nonce)):
		t.st.Prompted, t.asked = true, s
		t.newTurn()
	case t.st.Prompted && s == t.asked:
		t.newTurn()
	default:
		t.interrupted()
	}
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
	Type             string          `json:"type"`
	Subtype          string          `json:"subtype"`
	IsSidechain      bool            `json:"isSidechain"`
	IsMeta           bool            `json:"isMeta"`
	IsCompactSummary bool            `json:"isCompactSummary"`
	Attachment       json.RawMessage `json:"attachment"`
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
	case "attachment":
		// A prompt queued while the agent worked: the bridge's, or a
		// person's.
		var a claudeAttach
		if json.Unmarshal(l.Attachment, &a) == nil && a.Type == "queued_command" && a.CommandMode == "prompt" &&
			strings.TrimSpace(a.Prompt) != "" {
			t.prompt(a.Prompt)
		}
		return
	case "user", "assistant":
	default:
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
			case genuinePrompt(bl.Text):
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
