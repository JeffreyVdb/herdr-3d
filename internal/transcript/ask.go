package transcript

// #57: the structured questions the agents ask (Claude Code's
// AskUserQuestion, Codex's request_user_input), their answers, and which
// one a transcript's latest turn still waits on (AskTracker).
//
// Shapes checked against Claude Code 2.1.285 and codex-cli 0.159.2
// (testdata/*/ask*.jsonl): Claude's call is an assistant tool_use {id,
// name: "AskUserQuestion", input: {questions: [{question, header,
// multiSelect, options: [{label, description, preview?}]}]}} answered by a
// user tool_result of that tool_use_id, the line's toolUseResult an object
// {questions, answers: {<question text>: "<label>[, <label>…]" or typed
// text}, annotations: {<question text>: {preview?, notes?}}} or, dismissed,
// a string (Esc: "User rejected tool use", then a "[Request interrupted by
// user for tool use]" line; "Chat about this": a clarification request).
// Codex's is a response_item function_call {name: "request_user_input",
// call_id, arguments: "<JSON {questions: [{id, header, question, isOther?,
// isSecret?, options: [{label, description}]}]}>"} answered by a
// function_call_output of that call_id, output "<JSON {answers: {<id>:
// {answers: [label…, "user_note: <text>"]}}}>" or a string (cancelled); Esc
// on its dialog interrupts the turn (event_msg turn_aborted).

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// The ask tools, by harness.
const (
	ClaudeAskTool = "AskUserQuestion"
	CodexAskTool  = "request_user_input"
)

const (
	codexOtherLabel = "None of the above"
	codexNotePrefix = "user_note: "
	claudeClarify   = "The user wants to clarify"
)

// IsAskTool reports whether name is harness's ask tool.
func IsAskTool(harness, name string) bool {
	return (harness == Claude && name == ClaudeAskTool) || (harness == Codex && name == CodexAskTool)
}

type rawAskOption struct {
	Label       string `json:"label"`
	Description string `json:"description"`
	Preview     string `json:"preview"`
}

type rawAskQuestion struct {
	ID          string         `json:"id"`
	Header      string         `json:"header"`
	Question    string         `json:"question"`
	MultiSelect bool           `json:"multiSelect"`
	IsOther     *bool          `json:"isOther"`
	IsSecret    bool           `json:"isSecret"`
	Options     []rawAskOption `json:"options"`
}

// askCall is a parsed ask: the questions as sent (capped) and their full
// texts (answers are keyed by them).
type askCall struct {
	questions []proto.AskQuestion
	texts     []string // full question texts
	labels    [][]string
}

// clipAsk cuts s to n bytes (at a rune boundary), noting when it did.
func clipAsk(s string, n int, truncated *bool) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	*truncated = true
	return cut(s, n)
}

// parseAsk reads an ask call's input (Claude's tool_use input, Codex's
// decoded function_call arguments); false when it asks nothing a dialog
// shows (no question, or a question without options).
func parseAsk(harness string, input json.RawMessage) (askCall, bool) {
	var in struct {
		Questions []rawAskQuestion `json:"questions"`
	}
	if json.Unmarshal(input, &in) != nil || len(in.Questions) == 0 {
		return askCall{}, false
	}
	var c askCall
	for i, rq := range in.Questions {
		if len(rq.Options) == 0 || strings.TrimSpace(rq.Question) == "" {
			return askCall{}, false // Codex refuses it; Claude never shows it
		}
		if i >= proto.MaxAskQuestions {
			break
		}
		q := proto.AskQuestion{Options: []proto.AskOption{}}
		q.Header = clipAsk(rq.Header, proto.MaxAskHeader, &q.Truncated)
		q.Question = clipAsk(rq.Question, proto.MaxAskQuestion, &q.Truncated)
		var labels []string
		preview := false
		for j, o := range rq.Options {
			labels = append(labels, strings.TrimSpace(o.Label))
			if j >= proto.MaxAskOptions {
				q.Truncated = true
				continue
			}
			op := proto.AskOption{Label: clipAsk(o.Label, proto.MaxAskLabel, &q.Truncated),
				Description: clipAsk(o.Description, proto.MaxAskDescription, &q.Truncated)}
			if o.Preview != "" {
				preview = true
				op.Preview = clipAsk(o.Preview, proto.MaxAskPreview, &q.Truncated)
			}
			q.Options = append(q.Options, op)
		}
		switch harness {
		case Claude:
			// The dialog adds "Type something" (never offered by the model);
			// the side-by-side preview dialog has none.
			q.Multi, q.Other = rq.MultiSelect, !preview
		case Codex:
			// Codex's handler shows "None of the above" (with notes) on every
			// question; it has no multi-select.
			q.ID = clipAsk(rq.ID, proto.MaxAskHeader, &q.Truncated)
			q.Other, q.Secret = true, rq.IsSecret
		}
		c.questions = append(c.questions, q)
		c.texts = append(c.texts, strings.TrimSpace(rq.Question))
		c.labels = append(c.labels, labels)
	}
	return c, true
}

// AskQuestions parses an ask call's input into its questions, capped;
// false when it is not a question a dialog shows.
func AskQuestions(harness string, input json.RawMessage) ([]proto.AskQuestion, bool) {
	c, ok := parseAsk(harness, input)
	return c.questions, ok
}

// splitLabels reads a Claude answer ("Logs, Metrics" or typed text) as the
// option labels it joins with ", " (labels may hold commas: the longest run
// that is a label is taken) and what is left (typed text).
func splitLabels(answer string, labels []string) (picked []string, other string) {
	is := map[string]bool{}
	for _, l := range labels {
		is[l] = true
	}
	if is[answer] {
		return []string{answer}, ""
	}
	toks := strings.Split(answer, ", ")
	var rest []string
	for i := 0; i < len(toks); {
		j := len(toks)
		for ; j > i && !is[strings.Join(toks[i:j], ", ")]; j-- {
		}
		if j == i {
			rest = append(rest, toks[i])
			i++
			continue
		}
		picked = append(picked, strings.Join(toks[i:j], ", "))
		i = j
	}
	return picked, strings.Join(rest, ", ")
}

// claudeAskResult reads an AskUserQuestion's result: the line's
// toolUseResult and whether its tool_result is an error.
func (c askCall) claudeResult(raw json.RawMessage, isError bool) (string, []proto.AskAnswer) {
	raw = bytes.TrimSpace(raw)
	if len(raw) > 0 && raw[0] == '{' {
		var r struct {
			Answers     map[string]string `json:"answers"`
			Annotations map[string]struct {
				Notes string `json:"notes"`
			} `json:"annotations"`
		}
		if json.Unmarshal(raw, &r) == nil && r.Answers != nil {
			var out []proto.AskAnswer
			for i, text := range c.texts {
				a, ok := r.Answers[text]
				if !ok {
					continue
				}
				var cutA bool
				ans := proto.AskAnswer{Question: i, Answer: clipAsk(a, proto.MaxAskAnswer, &cutA),
					Notes: clipAsk(r.Annotations[text].Notes, proto.MaxAskAnswer, &cutA)}
				labels, other := splitLabels(strings.TrimSpace(a), c.labels[i])
				ans.Labels, ans.Other = labels, clipAsk(other, proto.MaxAskAnswer, &cutA)
				out = append(out, ans)
			}
			return proto.AskAnswered, out
		}
	}
	var s string
	_ = json.Unmarshal(raw, &s)
	if strings.Contains(s, claudeClarify) {
		return proto.AskClarify, nil
	}
	if isError || s != "" {
		return proto.AskDeclined, nil
	}
	return proto.AskAnswered, nil
}

// codexResult reads a request_user_input's output.
func (c askCall) codexResult(output string) (string, []proto.AskAnswer) {
	var r struct {
		Answers map[string]struct {
			Answers []string `json:"answers"`
		} `json:"answers"`
	}
	if json.Unmarshal([]byte(output), &r) != nil || r.Answers == nil {
		return proto.AskDeclined, nil // "aborted by user after …", "… was cancelled …"
	}
	var out []proto.AskAnswer
	for i, q := range c.questions {
		got, ok := r.Answers[q.ID]
		if !ok {
			continue
		}
		var a proto.AskAnswer
		a.Question = i
		var cutA bool
		var note string
		for _, s := range got.Answers {
			if n, isNote := strings.CutPrefix(s, codexNotePrefix); isNote {
				note = n
				continue
			}
			if s != codexOtherLabel {
				a.Labels = append(a.Labels, clipAsk(s, proto.MaxAskLabel, &cutA))
			}
		}
		note = clipAsk(note, proto.MaxAskAnswer, &cutA)
		if q.Secret && note != "" { // masked on its screen: never shown in the game either
			note = "••••••"
		}
		switch {
		case len(a.Labels) == 0:
			a.Other, a.Answer = note, note
		default:
			a.Answer, a.Notes = strings.Join(a.Labels, ", "), note
		}
		out = append(out, a)
	}
	return proto.AskAnswered, out
}

// card is the call's TranscriptAsk, pending.
func (c askCall) card(harness string) *proto.TranscriptAsk {
	return &proto.TranscriptAsk{Agent: harness, Questions: c.questions, Outcome: proto.AskPending}
}

// ---------------------------------------------------------------------------------------------------------------
// AskTracker

// AskTracker follows one transcript's lines (all of them, from its start,
// as its tail reads them) and knows the ask its latest turn waits on: the
// last ask call of the main conversation with no result yet, no genuine
// prompt after it and no interruption. Claude's sidechain (subagent) lines
// are not the worker's dialog. Not safe for concurrent use.
type AskTracker struct {
	harness  string
	now      func() time.Time
	pending  *proto.Ask
	call     askCall
	resolved string // the last ask whose result was read
}

// NewAskTracker follows a harness's (claude or codex) transcript; nil for
// another harness.
func NewAskTracker(harness string) *AskTracker {
	if harness != Claude && harness != Codex {
		return nil
	}
	return &AskTracker{harness: harness, now: time.Now}
}

// Reset forgets everything: the transcript is read again from its start.
func (t *AskTracker) Reset() { t.pending, t.call, t.resolved = nil, askCall{}, "" }

// Pending is the ask waiting now (a copy), or nil.
func (t *AskTracker) Pending() *proto.Ask {
	if t.pending == nil {
		return nil
	}
	a := *t.pending
	return &a
}

// Resolved is the id of the last ask whose result the transcript recorded.
func (t *AskTracker) Resolved() string { return t.resolved }

// Line reads one line.
func (t *AskTracker) Line(b []byte) {
	if t.harness == Claude {
		t.claudeLine(b)
	} else {
		t.codexLine(b)
	}
}

func (t *AskTracker) since(ts string) int64 {
	if ms := parseTS(ts); ms > 0 {
		return ms
	}
	return t.now().UnixMilli()
}

func (t *AskTracker) ask(id string, c askCall, ts string) {
	t.call = c
	t.pending = &proto.Ask{ToolUseID: id, Source: proto.AskSourceTranscript, Agent: t.harness, Questions: c.questions, Since: t.since(ts)}
}

func (t *AskTracker) end(result bool) {
	if result {
		t.resolved = t.pending.ToolUseID
	}
	t.pending, t.call = nil, askCall{}
}

type askClaudeLine struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
	Timestamp   string `json:"timestamp"`
	Message     *struct {
		Content strOr[claudeBlock] `json:"content"`
	} `json:"message"`
}

func (t *AskTracker) claudeLine(b []byte) {
	if t.pending == nil && !bytes.Contains(b, []byte(ClaudeAskTool)) {
		return // the common case: nothing to follow
	}
	var l askClaudeLine
	if json.Unmarshal(b, &l) != nil || l.IsSidechain || l.Message == nil {
		return
	}
	blocks := l.Message.Content.list
	if l.Message.Content.isStr {
		blocks = []claudeBlock{{Type: "text", Text: l.Message.Content.str}}
	}
	switch l.Type {
	case "assistant":
		for _, bl := range blocks {
			if bl.Type == "tool_use" && bl.Name == ClaudeAskTool && bl.ID != "" {
				if c, ok := parseAsk(Claude, bl.Input); ok {
					t.ask(bl.ID, c, l.Timestamp)
				}
			}
		}
	case "user":
		if t.pending == nil {
			return
		}
		for _, bl := range blocks {
			switch {
			case bl.Type == "tool_result" && bl.ToolUseID == t.pending.ToolUseID:
				t.end(true)
				return
			case bl.Type == "text" && strings.HasPrefix(strings.TrimSpace(bl.Text), interruptedText):
				t.end(false)
				return
			case bl.Type == "text" && !l.IsMeta && genuinePrompt(bl.Text):
				t.end(false) // a new prompt: the turn it asked in is over
				return
			}
		}
	}
}

// genuinePrompt reports whether a user text block is something a person
// sent (not a reminder or a notification Claude Code wraps in tags).
func genuinePrompt(s string) bool {
	s = strings.TrimSpace(systemReminder.ReplaceAllString(s, ""))
	if s == "" {
		return false
	}
	for _, tag := range []string{"<task-notification>", "<local-command-caveat>", "<local-command-stdout>", "<local-command-stderr>",
		"<bash-stdout>", "<bash-stderr>"} {
		if strings.HasPrefix(s, tag) {
			return false
		}
	}
	return true
}

func (t *AskTracker) codexLine(b []byte) {
	if t.pending == nil && !bytes.Contains(b, []byte(CodexAskTool)) {
		return
	}
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return
	}
	switch l.Type {
	case "response_item":
		var it codexItem
		if json.Unmarshal(l.Payload, &it) != nil {
			return
		}
		switch {
		case it.Type == "function_call" && it.Name == CodexAskTool && it.CallID != "":
			if c, ok := parseAsk(Codex, callArguments(it.Arguments)); ok {
				t.ask(it.CallID, c, l.Timestamp)
			}
		case t.pending == nil:
		case it.Type == "function_call_output" && it.CallID == t.pending.ToolUseID:
			t.end(true)
		case it.Type == "message" && it.Role == "user" && codexPrompt(it):
			t.end(false)
		}
	case "event_msg":
		if t.pending == nil {
			return
		}
		var ev codexEvent
		if json.Unmarshal(l.Payload, &ev) == nil && ev.Type == "turn_aborted" {
			t.end(false)
		}
	}
}

// codexPrompt reports whether a user message has text a person sent (not
// injected context).
func codexPrompt(it codexItem) bool {
	list := it.Content.list
	if it.Content.isStr {
		list = []codexPart{{Text: it.Content.str}}
	}
	for _, p := range list {
		if strings.TrimSpace(p.Text) != "" && !injected(p.Text) && !imageWrapper(p.Text) {
			return true
		}
	}
	return false
}
