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
// Every user prompt after the bridge's is a person's: they took over. The
// turn ends and the final message are TurnEvents' (turn.go), shared with
// #90's FollowupTracker.

import (
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

// WrapUpFooter is what the bridge appends to a wrap-up prompt. A task
// that did not complete is BLOCKED (#110: a prompt's task goes first, so a
// failed task on a clean, pushed tree does not send the worker home).
func WrapUpFooter(nonce string) string {
	return "When you are done, end your final message with exactly one line:\n" +
		WrapUpPrefix + " " + nonce + " CLEAN\n" +
		"or, if the task did not complete, anything could not be stopped or needs a decision:\n" +
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
	// marker: #224, a prompt is the bridge's when it contains it (""
	// for a wrap-up: when it ends with the nonce's footer).
	marker string
	from   int64
	st     WrapUpState
	msg    lastMessage // the latest assistant message's text, this turn
	asked  string      // the bridge's prompt as read, once Prompted
}

// NewWrapUpTracker follows a harness's (claude or codex) transcript for
// nonce from byte offset from; nil for another harness or a bad nonce.
func NewWrapUpTracker(harness, nonce string, from int64) *WrapUpTracker {
	if (harness != Claude && harness != Codex) || !ValidWrapUpNonce(nonce) || from < 0 {
		return nil
	}
	return &WrapUpTracker{harness: harness, nonce: nonce, from: from, msg: lastMessage{harness: harness}}
}

// NewMarkerTracker follows a harness's transcript from byte offset from for
// the turn of a bridge prompt that contains marker (#224: an agent handoff
// request): the same rules as a wrap-up's (Prompted, TookOver, Ended,
// Void, Lines), with no result line to read. Nil for another harness, a bad
// nonce or an empty marker.
func NewMarkerTracker(harness, nonce, marker string, from int64) *WrapUpTracker {
	t := NewWrapUpTracker(harness, nonce, from)
	if t == nil || strings.TrimSpace(marker) == "" {
		return nil
	}
	t.marker = marker
	return t
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

// Harness is the harness whose transcript it reads.
func (t *WrapUpTracker) Harness() string { return t.harness }

// Line reads one line starting at byte offset off.
func (t *WrapUpTracker) Line(off int64, b []byte) {
	if off < t.from || t.st.Void {
		return
	}
	t.Events(off, TurnEvents(t.harness, b))
}

func (t *WrapUpTracker) newTurn() {
	t.st.Ended, t.st.Verdict, t.st.Reason = false, "", ""
	t.msg.reset()
}

// asking is a user prompt's text as the bridge's would read: without
// Claude's paste wrapper and reminders, line ends and the ends trimmed. A
// slash command Claude Code recorded as its tags (#224: "/handoff …" is
// <command-message>, <command-name> and <command-args>) reads as typed:
// its name, a space and its arguments.
func asking(text string) string {
	text = systemReminder.ReplaceAllString(unwrapPasted(strings.ReplaceAll(text, "\r\n", "\n")), "")
	if cmd, ok := slashCommand(text); ok {
		text = cmd
	}
	return strings.TrimSpace(text)
}

// slashCommand is a Claude user line's slash command as typed ("/name
// args"), when its text is Claude Code's command tags.
func slashCommand(text string) (string, bool) {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "<command-") {
		return "", false
	}
	tags := map[string]string{}
	for _, m := range xmlTag.FindAllStringSubmatch(t, -1) {
		if m[1] == m[3] {
			tags[m[1]] = m[2]
		}
	}
	name := strings.TrimSpace(tags["command-name"])
	if name == "" {
		return "", false
	}
	if a := strings.TrimSpace(tags["command-args"]); a != "" {
		name += " " + a
	}
	return name, true
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
	case !t.st.Prompted && t.bridges(s):
		t.st.Prompted, t.asked = true, s
		t.newTurn()
	case t.st.Prompted && s == t.asked:
		t.newTurn()
	default:
		t.interrupted()
	}
}

// bridges reports whether a prompt's text (as asking reads it) is the
// bridge's.
func (t *WrapUpTracker) bridges(s string) bool {
	if t.marker != "" {
		return strings.Contains(s, t.marker)
	}
	return strings.HasSuffix(s, WrapUpFooter(t.nonce))
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
	t.st.Verdict, t.st.Reason = WrapUpVerdict(t.msg.String(), t.nonce)
}

// Events applies one line's events (TurnEvents) read at byte offset off:
// txLines reads each line once for every tracker of its session.
func (t *WrapUpTracker) Events(off int64, evs []TurnEvent) {
	if off < t.from || t.st.Void {
		return
	}
	t.st.Lines++
	for _, ev := range evs {
		switch ev.Kind {
		case TurnPrompt:
			t.prompt(ev.Text)
		case TurnInterrupted:
			t.interrupted()
		case TurnToolResult:
			if t.st.Prompted {
				t.st.Ended = false // the turn goes on
			}
		case TurnAssistant:
			if !t.st.Prompted {
				continue // the turn before the bridge's prompt
			}
			t.msg.assistant(ev)
			t.st.Ended, t.st.Verdict, t.st.Reason = false, "", "" // it goes on
			if ev.Final && t.msg.has {
				t.end()
			}
		case TurnDone:
			if t.st.Prompted && !t.st.Ended {
				t.end()
			}
		case TurnStarted:
			if t.st.Prompted {
				t.newTurn()
			}
		case TurnComplete:
			if t.st.Prompted {
				t.msg.complete(ev)
				t.end()
			}
		}
	}
}
