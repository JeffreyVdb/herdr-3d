package handoffllm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// Codex rollouts (~/.codex/sessions/…/rollout-*.jsonl): {timestamp,
// ordinal, type, payload}. response_item messages are the conversation;
// event_msg user_message / agent_message mirror them (read only when no
// response_item copy exists in the turn). Reasoning (encrypted), token
// counts, turn context and world state are never text. A rollout is
// append-only: a compaction leaves the rows before it in the file.

// The line types and event_msg types the reducer reads.
var (
	codexRead       = map[string]bool{"session_meta": true, "compacted": true, "response_item": true}
	codexReadEvents = map[string]bool{"user_message": true, "agent_message": true, "task_started": true, "task_complete": true,
		"turn_aborted": true, "exec_command_end": true}
)

type codexLine struct {
	Timestamp string          `json:"timestamp"`
	Ordinal   *int64          `json:"ordinal"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Phase   string          `json:"phase"`
	Content json.RawMessage `json:"content"`
	// event_msg
	Message          string  `json:"message"`
	LastAgentMessage *string `json:"last_agent_message"`
	CallID           string  `json:"call_id"`
	ExitCode         *int    `json:"exit_code"`
	// session_meta
	ID                 string          `json:"id"`
	ForkedFromID       string          `json:"forked_from_id"`
	HistoryStart       *int64          `json:"subagent_history_start_ordinal"`
	Source             json.RawMessage `json:"source"`
	ReplacementHistory json.RawMessage `json:"replacement_history"`
}

// Kinds of Codex row the reducer keeps.
const (
	cxUser = iota + 1
	cxAssistant
	cxCall
	cxOutput
	cxEvUser
	cxEvAgent
	cxTurnStart
	cxTurnEnd
	cxExecEnd
	cxCompacted
)

type codexRow struct {
	kind     int
	ord      *int64
	ts       string
	text     string
	phase    string
	images   int
	callID   string
	name     string
	paths    []string
	failed   bool
	exit     int
	retained []string // a compaction's readable user messages
	opaque   bool     // a compaction carrying history it cannot show
}

type codexParser struct {
	rows       []*codexRow
	meta       bool // the first session_meta was read
	subagent   bool
	forkedFrom string
	start      *int64
	sidechains int
}

func newCodexParser() *codexParser { return &codexParser{} }

func (p *codexParser) line(_ int64, b []byte) bool {
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return false
	}
	var pl codexPayload
	if len(l.Payload) > 0 && json.Unmarshal(l.Payload, &pl) != nil {
		// A shape the reducer does not know: lost (skipped) when it is a
		// kind of line it reads, else not conversation.
		var kind struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(l.Payload, &kind)
		return !codexRead[l.Type] && !codexReadEvents[kind.Type]
	}
	r := &codexRow{ord: l.Ordinal, ts: l.Timestamp}
	switch l.Type {
	case "session_meta":
		if !p.meta {
			p.meta = true
			src := bytes.TrimSpace(pl.Source)
			p.subagent = len(src) > 0 && src[0] == '{' && bytes.Contains(src, []byte(`"subagent"`))
			p.forkedFrom, p.start = pl.ForkedFromID, pl.HistoryStart
		}
		return true
	case "compacted":
		r.kind = cxCompacted
		p.compacted(r, l.Payload, pl.ReplacementHistory)
	case "response_item":
		p.responseItem(r, &pl, l.Payload)
	case "event_msg":
		switch pl.Type {
		case "user_message":
			r.kind, r.text = cxEvUser, pl.Message
		case "agent_message":
			r.kind, r.text, r.phase = cxEvAgent, pl.Message, pl.Phase
		case "task_started":
			r.kind = cxTurnStart
		case "task_complete", "turn_aborted":
			r.kind = cxTurnEnd
			if pl.LastAgentMessage != nil {
				r.text = *pl.LastAgentMessage
			}
		case "exec_command_end":
			if pl.ExitCode != nil {
				r.kind, r.callID, r.exit = cxExecEnd, pl.CallID, *pl.ExitCode
			}
		case "sub_agent_activity":
			p.sidechains++
		}
	}
	if r.kind != 0 {
		p.rows = append(p.rows, r)
	}
	return true
}

func (p *codexParser) responseItem(r *codexRow, pl *codexPayload, raw json.RawMessage) {
	switch pl.Type {
	case "message":
		switch pl.Role {
		case "user":
			r.kind, r.text, r.images = cxUser, transcript.CodexUserText(raw), codexImages(pl.Content)
		case "assistant":
			r.kind, r.phase = cxAssistant, pl.Phase
			r.text = codexText(pl.Content)
		}
		// developer: harness instructions, never the conversation.
	case "agent_message":
		p.sidechains++ // another agent's message
	default:
		if id, name, summary, paths, ok := transcript.CodexCall(raw); ok {
			r.kind, r.callID, r.name, r.text, r.paths = cxCall, id, name, summary, paths
		} else if id, text, failed, ok := transcript.CodexCallOutput(raw); ok {
			r.kind, r.callID, r.text, r.failed = cxOutput, id, text, failed
		}
	}
}

// compacted reads a compaction: replacement_history's user messages are
// readable; its developer items are instructions and its compaction item
// is encrypted; message is always empty in practice and never a summary.
func (p *codexParser) compacted(r *codexRow, raw, history json.RawMessage) {
	var items []json.RawMessage
	_ = json.Unmarshal(history, &items)
	for _, it := range items {
		var h codexPayload
		if json.Unmarshal(it, &h) != nil {
			continue
		}
		if h.Type == "message" && h.Role == "user" {
			if t := transcript.CodexUserText(it); strings.TrimSpace(t) != "" {
				r.retained = append(r.retained, t)
				continue
			}
		}
		if h.Type != "message" || h.Role != "developer" {
			r.opaque = true
		}
	}
	if len(items) == 0 {
		var m map[string]json.RawMessage
		_ = json.Unmarshal(raw, &m)
		delete(m, "message")
		r.opaque = len(m) > 0 // metadata of history it does not carry
	}
}

// codexText is an assistant message's text parts.
func codexText(content json.RawMessage) string {
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		var s string
		_ = json.Unmarshal(content, &s)
		return s
	}
	var texts []string
	for _, p := range parts {
		if p.Type == "output_text" || p.Type == "text" || p.Type == "" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n")
}

func codexImages(content json.RawMessage) int {
	var parts []struct {
		Type string `json:"type"`
	}
	_ = json.Unmarshal(content, &parts)
	n := 0
	for _, p := range parts {
		if p.Type == "input_image" || p.Type == "image" {
			n++
		}
	}
	return n
}

// codexShells run a command line (their summary is it).
var codexShells = map[string]bool{"exec_command": true, "shell": true, "exec": true, "local_shell": true, "container.exec": true}

func (p *codexParser) build(b *builder) error {
	if p.subagent {
		return fmt.Errorf("%w: a subagent's rollout", ErrUnsupported)
	}
	b.cov.Sidechains = p.sidechains
	rows := p.rows
	if p.forkedFrom != "" {
		rows = p.ownRows(b)
	}

	// The turn of each row, and what the turn's response items say (an
	// event copy of one is a duplicate).
	turnOf := make([]int, len(rows))
	users, replies := map[int]map[string]bool{}, map[int]map[string]bool{}
	turn := 0
	for i, r := range rows {
		if r.kind == cxTurnStart {
			turn++
		}
		turnOf[i] = turn
		set := users
		switch r.kind {
		case cxAssistant:
			set = replies
		case cxUser:
		default:
			continue
		}
		if set[turn] == nil {
			set[turn] = map[string]bool{}
		}
		set[turn][norm(r.text)] = true
	}

	var cur *msg              // the assistant message calls join
	var turnMsgs []*msg       // the turn's assistant messages
	phased := false           // one of them has a phase (else: legacy, the last one is final)
	said := map[string]bool{} // user messages read so far
	replied := false          // an assistant reply was read
	endTurn := func(last string) {
		if len(turnMsgs) == 0 && strings.TrimSpace(last) != "" {
			m := b.assistant("")
			m.addText(last)
			turnMsgs = append(turnMsgs, m)
			m.turnFinal = true
		}
		if !phased && len(turnMsgs) > 0 {
			turnMsgs[len(turnMsgs)-1].turnFinal = true
		}
		cur, turnMsgs, phased = nil, nil, false
	}
	asst := func(r *codexRow) {
		m := b.assistant(r.ts)
		m.addText(r.text)
		m.turnFinal = r.phase == "final_answer"
		phased = phased || r.phase != ""
		cur = m
		turnMsgs = append(turnMsgs, m)
		replied = replied || strings.TrimSpace(r.text) != ""
	}
	label := ""
	for i, r := range rows {
		switch r.kind {
		case cxUser:
			if b.user(r.text, r.ts, r.images) != nil {
				said[norm(r.text)] = true
				cur = nil
			}
		case cxEvUser:
			if users[turnOf[i]][norm(r.text)] {
				b.cov.Deduplicated++
			} else if b.user(r.text, r.ts, 0) != nil {
				said[norm(r.text)] = true
				cur = nil
			}
		case cxAssistant:
			if strings.TrimSpace(r.text) != "" {
				asst(r)
			}
		case cxEvAgent:
			if replies[turnOf[i]][norm(r.text)] {
				b.cov.Deduplicated++
			} else if strings.TrimSpace(r.text) != "" {
				asst(r)
			}
		case cxCall:
			if cur == nil {
				cur = b.assistant(r.ts)
				turnMsgs = append(turnMsgs, cur)
			}
			t := b.call(cur, r.callID, r.name, r.text)
			if strings.HasSuffix(r.name, "apply_patch") {
				b.editsFiles(t, r.paths...)
			}
			if codexShells[r.name] {
				b.runsTests(t, r.text)
			}
		case cxOutput:
			b.result(r.callID, r.text, r.failed)
		case cxExecEnd:
			b.exit(r.callID, r.exit)
		case cxTurnStart:
			cur, turnMsgs, phased = nil, nil, false
		case cxTurnEnd:
			endTurn(r.text)
		case cxCompacted:
			label = p.compaction(b, r, said, replied)
			cur = nil
		}
	}
	if len(turnMsgs) > 0 {
		endTurn("")
	}
	b.cov.Compaction = label
	return nil
}

// ownRows is a forked rollout's own rows: those from its history start
// ordinal on. Without that ordinal on every row, the inherited history
// cannot be told apart: it is read once, with a gap.
func (p *codexParser) ownRows(b *builder) []*codexRow {
	split := p.start != nil
	for _, r := range p.rows {
		split = split && r.ord != nil
	}
	if !split {
		b.gap("forked session: the history inherited from the parent session could not be told apart and is included once")
		return p.rows
	}
	var own []*codexRow
	for _, r := range p.rows {
		if *r.ord >= *p.start {
			own = append(own, r)
		}
	}
	if len(own) < len(p.rows) {
		b.gap("forked session: the history inherited from the parent session is left out")
	}
	return own
}

// compaction notes a compaction where it happened and adds its readable
// user messages not already read; it returns the compaction state.
func (p *codexParser) compaction(b *builder, r *codexRow, said map[string]bool, replied bool) string {
	label := CompactionMissing
	switch {
	case len(r.retained) > 0:
		label = CompactionCodexRetained
		b.note("conversation compacted here (Codex): its summary is not readable; the user messages it kept follow")
	case r.opaque:
		label = CompactionOpaque
		b.note("conversation compacted here (Codex): its summary is not readable")
	default:
		b.note("conversation compacted here (Codex): no summary was recorded")
	}
	for _, t := range r.retained {
		if said[norm(t)] {
			b.cov.Deduplicated++
			continue
		}
		said[norm(t)] = true
		if m := b.user(t, "", 0); m != nil {
			m.retained = true
		}
	}
	if label != CompactionCodexRetained {
		b.gap("Codex compaction summary not readable; the history before it is reduced from the rows the transcript still holds")
	}
	if !replied {
		b.gap("pre-compaction assistant replies unavailable (Codex)")
	}
	return label
}
