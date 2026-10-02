package transcript

// The turn boundaries of a Claude or Codex transcript and the text of a
// turn's final assistant message, read once per line and shared by the
// trackers that need them: #83's WrapUpTracker and #90's FollowupTracker.
//
// Turn ends, checked against Claude Code 2.1.285 and codex-cli 0.159.2:
// Claude's final message is the assistant message (one message id, its
// blocks on several lines) whose stop_reason is not tool_use, and a
// system/turn_duration line follows the turn; Codex's turn ends with
// event_msg task_complete (last_agent_message: the final message's text),
// turn_aborted when it was interrupted.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// TurnEventKind is what a transcript line says about the turn.
type TurnEventKind int

const (
	// TurnPrompt is a user prompt (Text): typed, or queued while the agent
	// worked (Claude's queued_command attachment).
	TurnPrompt TurnEventKind = iota + 1
	// TurnInterrupted is a person stopping the turn: Claude's
	// "[Request interrupted by user…]", Codex's turn_aborted.
	TurnInterrupted
	// TurnToolResult is a tool's result (Claude): the turn goes on.
	TurnToolResult
	// TurnAssistant is (a part of) an assistant message: MsgID (Claude:
	// its blocks come on several lines; Codex: ""), Texts, and Final when
	// its stop_reason ends the turn (Claude).
	TurnAssistant
	// TurnStarted is Codex's task_started.
	TurnStarted
	// TurnDone is Claude's system/turn_duration.
	TurnDone
	// TurnComplete is Codex's task_complete (Text: last_agent_message).
	TurnComplete
)

// TurnEvent is one thing a line says about the turn.
type TurnEvent struct {
	Kind  TurnEventKind
	Text  string
	MsgID string
	Texts []string
	Final bool
}

// TurnEvents reads one line of a harness's (claude or codex) main
// transcript: what it says about the turn, in order (a Claude user line
// can carry several blocks). Sidechain (subagent) lines say nothing.
func TurnEvents(harness string, b []byte) []TurnEvent {
	switch harness {
	case Claude:
		return claudeTurnEvents(b)
	case Codex:
		return codexTurnEvents(b)
	}
	return nil
}

type turnClaudeLine struct {
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

func claudeTurnEvents(b []byte) []TurnEvent {
	var l turnClaudeLine
	if json.Unmarshal(b, &l) != nil || l.IsSidechain {
		return nil
	}
	switch l.Type {
	case "system":
		if l.Subtype == "turn_duration" {
			return []TurnEvent{{Kind: TurnDone}}
		}
		return nil
	case "attachment":
		// A prompt queued while the agent worked.
		var a claudeAttach
		if json.Unmarshal(l.Attachment, &a) == nil && a.Type == "queued_command" && a.CommandMode == "prompt" &&
			strings.TrimSpace(a.Prompt) != "" {
			return []TurnEvent{{Kind: TurnPrompt, Text: a.Prompt}}
		}
		return nil
	case "user", "assistant":
	default:
		return nil
	}
	if l.Message == nil {
		return nil
	}
	blocks := l.Message.Content.list
	if l.Message.Content.isStr {
		blocks = []claudeBlock{{Type: "text", Text: l.Message.Content.str}}
	}
	var evs []TurnEvent
	if l.Type == "user" {
		if l.IsMeta || l.IsCompactSummary {
			return nil
		}
		for _, bl := range blocks {
			switch {
			case bl.Type == "tool_result":
				evs = append(evs, TurnEvent{Kind: TurnToolResult})
			case bl.Type != "text":
			case strings.HasPrefix(strings.TrimSpace(bl.Text), interruptedText):
				evs = append(evs, TurnEvent{Kind: TurnInterrupted})
			case genuinePrompt(bl.Text):
				evs = append(evs, TurnEvent{Kind: TurnPrompt, Text: bl.Text})
			}
		}
		return evs
	}
	ev := TurnEvent{Kind: TurnAssistant, MsgID: l.Message.ID}
	for _, bl := range blocks {
		if bl.Type == "text" {
			ev.Texts = append(ev.Texts, bl.Text)
		}
	}
	sr := l.Message.StopReason
	ev.Final = sr != nil && *sr != "" && *sr != "tool_use"
	return []TurnEvent{ev}
}

type turnCodexEvent struct {
	Type             string `json:"type"`
	LastAgentMessage string `json:"last_agent_message"`
}

func codexTurnEvents(b []byte) []TurnEvent {
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	switch l.Type {
	case "response_item":
		var it codexItem
		if json.Unmarshal(l.Payload, &it) != nil || it.Type != "message" {
			return nil
		}
		list := it.Content.list
		if it.Content.isStr {
			list = []codexPart{{Text: it.Content.str}}
		}
		switch it.Role {
		case "user":
			if !codexPrompt(it) {
				return nil
			}
			var text strings.Builder
			for _, p := range list {
				text.WriteString(p.Text)
				text.WriteByte('\n')
			}
			return []TurnEvent{{Kind: TurnPrompt, Text: text.String()}}
		case "assistant":
			ev := TurnEvent{Kind: TurnAssistant}
			for _, p := range list {
				if p.Type == "output_text" || p.Type == "text" || p.Type == "" {
					ev.Texts = append(ev.Texts, p.Text)
				}
			}
			return []TurnEvent{ev}
		}
	case "event_msg":
		if !bytes.Contains(l.Payload, []byte(`"task_`)) && !bytes.Contains(l.Payload, []byte(`"turn_aborted"`)) {
			return nil
		}
		var ev turnCodexEvent
		if json.Unmarshal(l.Payload, &ev) != nil {
			return nil
		}
		switch ev.Type {
		case "task_started":
			return []TurnEvent{{Kind: TurnStarted}}
		case "turn_aborted":
			return []TurnEvent{{Kind: TurnInterrupted}}
		case "task_complete":
			return []TurnEvent{{Kind: TurnComplete, Text: ev.LastAgentMessage}}
		}
	}
	return nil
}

// lastMessage is the text of a turn's latest assistant message, built from
// TurnEvents: Claude's message spans the lines of one message id, Codex's is
// one response_item; task_complete's last_agent_message stands in when no
// message was read.
type lastMessage struct {
	harness string
	msgID   string
	text    strings.Builder
	has     bool
}

func (m *lastMessage) reset() {
	m.msgID, m.has = "", false
	m.text.Reset()
}

// assistant adds an assistant message's part: the next message (Claude:
// another id; Codex: every message) replaces the text.
func (m *lastMessage) assistant(ev TurnEvent) {
	if m.harness != Claude || ev.MsgID != m.msgID {
		m.reset()
		m.msgID = ev.MsgID
	}
	for _, t := range ev.Texts {
		if m.has {
			m.text.WriteByte('\n')
		}
		m.text.WriteString(t)
		m.has = true
	}
}

// complete takes Codex's last_agent_message when no message was read.
func (m *lastMessage) complete(ev TurnEvent) {
	if !m.has && ev.Text != "" {
		m.text.WriteString(ev.Text)
		m.has = true
	}
}

func (m *lastMessage) String() string { return m.text.String() }

// Turn is a turn that ended, with its final assistant message.
type Turn struct {
	// ID is the first 16 hex digits of Hash: the same message is the same
	// turn, across re-reads and restarts.
	ID string
	// Hash is the hex SHA-256 of Text.
	Hash string
	// Text is the final message's text, its ends trimmed.
	Text string
}

// FollowupTracker follows one transcript's lines and knows the latest turn
// that ended and its final assistant message (#90): nil while a turn runs,
// after a new prompt, or when the turn was interrupted. Not safe for
// concurrent use.
type FollowupTracker struct {
	msg     lastMessage
	turn    *Turn
	aborted bool
	seq     int
}

// NewFollowupTracker follows a harness's (claude or codex) transcript; nil
// for another harness.
func NewFollowupTracker(harness string) *FollowupTracker {
	if harness != Claude && harness != Codex {
		return nil
	}
	return &FollowupTracker{msg: lastMessage{harness: harness}}
}

// Line reads one line.
func (t *FollowupTracker) Line(b []byte) { t.Events(TurnEvents(t.msg.harness, b)) }

// Reset forgets what was read: the transcript was replaced (or went).
func (t *FollowupTracker) Reset() {
	t.msg.reset()
	t.aborted = false
	t.set(nil)
}

// Turn is the latest ended turn (nil: none now).
func (t *FollowupTracker) Turn() *Turn { return t.turn }

// Seq counts the changes of Turn.
func (t *FollowupTracker) Seq() int { return t.seq }

func (t *FollowupTracker) set(turn *Turn) {
	if (t.turn == nil && turn == nil) || (t.turn != nil && turn != nil && *t.turn == *turn) {
		return
	}
	t.turn = turn
	t.seq++
}

// Events applies one line's events.
func (t *FollowupTracker) Events(evs []TurnEvent) {
	for _, ev := range evs {
		switch ev.Kind {
		case TurnPrompt, TurnStarted:
			t.msg.reset()
			t.aborted = false
			t.set(nil)
		case TurnInterrupted:
			t.msg.reset()
			t.aborted = true
			t.set(nil)
		case TurnToolResult:
			t.set(nil)
		case TurnAssistant:
			t.msg.assistant(ev)
			t.set(nil)
			if ev.Final && t.msg.has {
				t.end()
			}
		case TurnDone:
			if t.turn == nil && t.msg.has {
				t.end()
			}
		case TurnComplete:
			t.msg.complete(ev)
			t.end()
		}
	}
}

func (t *FollowupTracker) end() {
	text := strings.TrimSpace(t.msg.String())
	if t.aborted || text == "" {
		t.set(nil)
		return
	}
	sum := sha256.Sum256([]byte(text))
	h := hex.EncodeToString(sum[:])
	t.set(&Turn{ID: h[:16], Hash: h, Text: text})
}
