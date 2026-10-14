package handoffllm

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// Claude Code (<projects>/<project>/<session>.jsonl). Lines form a tree:
// uuid / parentUuid. The active branch is the ancestry of the snapshot's
// last main-thread row; a compact_boundary has no parent and links the rows
// before it with logicalParentUuid. One API message is split over rows (one
// block each) sharing message.id and requestId.

// claudeLine is what the reducer reads of a Claude Code line.
type claudeLine struct {
	Type              string          `json:"type"`
	Subtype           string          `json:"subtype"`
	UUID              string          `json:"uuid"`
	ParentUUID        *string         `json:"parentUuid"`
	LogicalParentUUID string          `json:"logicalParentUuid"`
	LeafUUID          string          `json:"leafUuid"`
	IsSidechain       bool            `json:"isSidechain"`
	IsMeta            bool            `json:"isMeta"`
	IsCompactSummary  bool            `json:"isCompactSummary"`
	TranscriptOnly    bool            `json:"isVisibleInTranscriptOnly"`
	Timestamp         string          `json:"timestamp"`
	RequestID         string          `json:"requestId"`
	APIBlockIndex     *int            `json:"apiBlockIndex"`
	Attachment        json.RawMessage `json:"attachment"`
	Message           *struct {
		ID         string          `json:"id"`
		StopReason *string         `json:"stop_reason"`
		Content    json.RawMessage `json:"content"`
	} `json:"message"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

type claudeAttach struct {
	Type        string `json:"type"`
	Prompt      string `json:"prompt"`
	CommandMode string `json:"commandMode"`
	Origin      *struct {
		Kind string `json:"kind"`
	} `json:"origin"`
}

// Kinds of Claude row the reducer keeps.
const (
	crOther = iota
	crUser
	crAssistant
	crSummary
	crBoundary
)

// claudeRow is a main-thread row, read once (no line bytes are kept).
type claudeRow struct {
	pos                   int
	kind                  int
	uuid, parent, logical string
	ts                    string
	msgID, block          string // message.id and its blocks (apiBlockIndex, types, ids, text): a copy's identity
	turnFinal             bool
	prompts               []string // a person's text (user)
	texts                 []string // assistant text blocks
	images                int
	uses                  []claudeUse
	results               []claudeResult
	summary               string
}

type claudeUse struct {
	id, name string
	input    json.RawMessage
}

type claudeResult struct {
	id, text string
	failed   bool
}

type claudeParser struct {
	rows       []*claudeRow
	byUUID     map[string]*claudeRow
	leaf       string
	sidechains int
	dups       int
}

func newClaudeParser() *claudeParser { return &claudeParser{byUUID: map[string]*claudeRow{}} }

func (p *claudeParser) line(_ int64, b []byte) bool {
	var l claudeLine
	if json.Unmarshal(b, &l) != nil {
		return false
	}
	switch {
	case l.IsSidechain:
		p.sidechains++
		return true
	case l.Type == "last-prompt":
		if l.LeafUUID != "" {
			p.leaf = l.LeafUUID
		}
		return true
	case l.UUID == "" && (l.Type == "user" || l.Type == "assistant"):
		// An older line without ids: it follows the line before it.
		l.UUID = "line:" + strconv.Itoa(len(p.rows))
		if n := len(p.rows); n > 0 {
			l.ParentUUID = &p.rows[n-1].uuid
		}
	case l.UUID == "":
		return true // bookkeeping (titles, modes, snapshots…)
	case p.byUUID[l.UUID] != nil:
		p.dups++ // the same row written twice
		return true
	}
	r := &claudeRow{pos: len(p.rows), uuid: l.UUID, logical: l.LogicalParentUUID, ts: l.Timestamp}
	if l.ParentUUID != nil {
		r.parent = *l.ParentUUID
	}
	p.read(r, &l)
	p.rows = append(p.rows, r)
	p.byUUID[r.uuid] = r
	return true
}

// read fills a row from its line: what a person wrote, the assistant's
// text and tool calls, tool results, a compaction summary or boundary.
func (p *claudeParser) read(r *claudeRow, l *claudeLine) {
	switch l.Type {
	case "system":
		if l.Subtype == "compact_boundary" {
			r.kind = crBoundary
		}
		return
	case "attachment":
		var a claudeAttach
		if json.Unmarshal(l.Attachment, &a) == nil && a.Type == "queued_command" && a.CommandMode == "prompt" &&
			(a.Origin == nil || a.Origin.Kind == "human") && strings.TrimSpace(a.Prompt) != "" {
			r.kind = crUser
			r.prompts = append(r.prompts, prompt(a.Prompt))
		}
		return
	case "user", "assistant":
	default:
		return
	}
	if l.Message == nil {
		return
	}
	blocks := claudeBlocks(l.Message.Content)
	if l.Type == "user" {
		switch {
		case l.IsCompactSummary:
			r.kind = crSummary
			var texts []string
			for _, bl := range blocks {
				if bl.Type == "text" {
					texts = append(texts, bl.Text)
				}
			}
			r.summary = strings.TrimSpace(transcript.StripReminders(strings.Join(texts, "\n")))
			return
		case l.IsMeta || l.TranscriptOnly:
			return
		}
		r.kind = crUser
		for _, bl := range blocks {
			switch {
			case bl.Type == "tool_result":
				r.results = append(r.results, claudeResult{id: bl.ToolUseID, text: claudeResultText(bl.Content), failed: bl.IsError})
			case bl.Type == "image":
				r.images++
			case bl.Type != "text", transcript.Interrupted(bl.Text):
			case transcript.GenuinePrompt(bl.Text):
				r.prompts = append(r.prompts, prompt(bl.Text))
			}
		}
		return
	}
	r.kind = crAssistant
	r.msgID = l.Message.ID
	if sr := l.Message.StopReason; sr != nil && *sr != "" && *sr != "tool_use" {
		r.turnFinal = true
	}
	var sig strings.Builder // the row's blocks: a row written twice has the same
	if l.APIBlockIndex != nil {
		sig.WriteString(strconv.Itoa(*l.APIBlockIndex))
	}
	for _, bl := range blocks {
		sig.WriteString("\x00" + bl.Type + "\x00" + bl.ID + "\x00" + bl.Text)
		switch bl.Type {
		case "text":
			r.texts = append(r.texts, bl.Text)
		case "tool_use":
			r.uses = append(r.uses, claudeUse{id: bl.ID, name: bl.Name, input: bl.Input})
		case "image":
			r.images++
		}
		// thinking, redacted_thinking: never text.
	}
	r.block = sig.String()
}

// prompt is a person's text as they wrote it: no reminders, no paste wrapper.
func prompt(s string) string {
	return strings.TrimSpace(transcript.UnwrapPasted(transcript.StripReminders(s)))
}

// claudeBlocks reads message.content: a string (one text block) or blocks.
func claudeBlocks(raw json.RawMessage) []claudeBlock {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return nil
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil
		}
		return []claudeBlock{{Type: "text", Text: s}}
	}
	var bs []claudeBlock
	_ = json.Unmarshal(raw, &bs)
	return bs
}

// claudeResultText is a tool_result's text: a string, or its text parts
// (images are never evidence).
func claudeResultText(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return ""
	}
	if raw[0] == '"' {
		var s string
		_ = json.Unmarshal(raw, &s)
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	_ = json.Unmarshal(raw, &parts)
	var texts []string
	for _, p := range parts {
		if p.Type == "text" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// claudeEditTools change the file named by their input's file_path or
// notebook_path.
var claudeEditTools = map[string]bool{"Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true}

func (p *claudeParser) build(b *builder) error {
	b.cov.Sidechains = p.sidechains
	b.cov.Deduplicated = p.dups
	// The active branch: the ancestry of the last conversation row (a
	// trailing turn_duration, attachment or meta row descends from it),
	// through compaction boundaries by their logical parent.
	var tip *claudeRow
	for i := len(p.rows) - 1; i >= 0 && tip == nil; i-- {
		if p.rows[i].kind != crOther {
			tip = p.rows[i]
		}
	}
	if tip == nil {
		return nil
	}
	chain := map[*claudeRow]bool{}
	var boundaries []*claudeRow // on the chain, newest first
	var orphan *claudeRow       // the oldest row reached, when its parent is not in the file
	for r := tip; r != nil && !chain[r]; {
		chain[r] = true
		next := r.parent
		if r.kind == crBoundary {
			boundaries = append(boundaries, r)
			if next == "" {
				next = r.logical
			}
		}
		if next == "" {
			break
		}
		parent := p.byUUID[next]
		if parent == nil {
			orphan = r
		}
		r = parent
	}
	if p.leaf != "" {
		if leaf := p.byUUID[p.leaf]; leaf != nil && !chain[leaf] {
			b.gap("branch tip uncertain: Claude Code's last-prompt names a row off the latest branch; the latest row's branch was used")
		}
	}

	// Compaction: seed with the latest boundary's readable summary (and
	// the person's prompts from before it); without one, keep what the
	// transcript still holds before the boundary.
	cut := -1 // rows of the chain before this position are covered by the summary
	b.cov.Compaction = CompactionNone
	if len(boundaries) > 0 {
		last := boundaries[0]
		var sum *claudeRow
		for _, r := range p.rows[last.pos+1:] {
			if chain[r] && r.kind == crSummary {
				sum = r
				break
			}
			if chain[r] && r.kind == crBoundary {
				break
			}
		}
		switch {
		case sum != nil && readableSummary(sum.summary):
			b.cov.Compaction = CompactionClaudeSummary
			cut = last.pos
		default:
			b.cov.Compaction = CompactionMissing
			b.gap("compaction summary missing or unreadable (Claude); the history before it is reduced from the rows the transcript still holds")
		}
	}
	if orphan != nil && orphan.pos > cut {
		b.gap("earlier history is not in this transcript (a parent row is missing)")
	}

	// Before a summary: the person's own words (the first goal, later
	// corrections) are kept too, unless a kept prompt says the same.
	early := map[*claudeRow]bool{}
	if cut >= 0 {
		said := map[string]bool{}
		for _, r := range p.rows[cut:] {
			if chain[r] && r.kind == crUser && len(r.prompts) > 0 {
				said[norm(strings.Join(r.prompts, "\n\n"))] = true
			}
		}
		for _, r := range p.rows[:cut] {
			if !chain[r] || r.kind != crUser || len(r.prompts) == 0 {
				continue
			}
			if k := norm(strings.Join(r.prompts, "\n\n")); said[k] {
				b.cov.Deduplicated++
			} else {
				said[k], early[r] = true, true
			}
		}
	}

	// Rows off the chain: a streamed block of a message on it, or the
	// result of a call on it, joins; anything else said is abandoned.
	onMsg, onUse := map[string]bool{}, map[string]bool{}
	for r := range chain {
		if r.kind == crAssistant && r.msgID != "" {
			onMsg[r.msgID] = true
		}
	}
	keep := func(r *claudeRow) bool {
		switch {
		case chain[r]:
			return r.pos >= cut || early[r]
		case r.kind == crAssistant && r.msgID != "" && onMsg[r.msgID]:
			return r.pos >= cut
		}
		return false
	}
	var kept []*claudeRow
	for _, r := range p.rows {
		if keep(r) {
			kept = append(kept, r)
			for _, u := range r.uses {
				onUse[u.id] = true
			}
		}
	}
	msgs := map[string]*msg{}
	blocks := map[string]bool{}
	k := 0
	for _, r := range p.rows {
		if k < len(kept) && kept[k] == r {
			k++
			if early[r] {
				b.early(strings.Join(r.prompts, "\n\n"), r.ts)
				continue
			}
			p.emit(b, r, msgs, blocks)
			continue
		}
		switch {
		case r.pos < cut: // before the compaction: the summary covers it
		case len(r.results) > 0 && len(r.prompts) == 0 && allUsed(r.results, onUse):
			p.emit(b, r, msgs, blocks) // results of kept calls on a row of their own
		case r.kind == crUser || r.kind == crAssistant || r.kind == crSummary:
			b.cov.Abandoned++
		}
	}
	return nil
}

func allUsed(rs []claudeResult, used map[string]bool) bool {
	for _, r := range rs {
		if !used[r.id] {
			return false
		}
	}
	return true
}

// readableSummary: a compaction summary with text, not the display note.
func readableSummary(s string) bool {
	s = strings.TrimSpace(s)
	return s != "" && !strings.HasPrefix(strings.ToLower(s), "conversation compacted")
}

// emit adds a kept row's messages to b, merging an assistant message's
// rows (one message.id) into one.
func (p *claudeParser) emit(b *builder, r *claudeRow, msgs map[string]*msg, blocks map[string]bool) {
	switch r.kind {
	case crBoundary:
		b.note("conversation compacted here")
	case crSummary:
		if readableSummary(r.summary) {
			b.summary(r.summary, r.ts)
		}
	case crUser:
		for _, res := range r.results {
			b.result(res.id, res.text, res.failed)
		}
		if len(r.prompts) > 0 || r.images > 0 {
			b.user(strings.Join(r.prompts, "\n\n"), r.ts, r.images)
		}
	case crAssistant:
		m := msgs[r.msgID]
		if m == nil || r.msgID == "" {
			m = b.assistant(r.ts)
			msgs[r.msgID] = m
		} else {
			b.cov.Deduplicated++ // a streamed block of a message already read
			if r.block != "" && blocks[r.msgID+"\x00"+r.block] {
				return
			}
		}
		if r.block != "" {
			blocks[r.msgID+"\x00"+r.block] = true
		}
		for _, t := range r.texts {
			m.addText(t)
		}
		m.images += r.images
		m.turnFinal = m.turnFinal || r.turnFinal
		for _, u := range r.uses {
			t := b.call(m, u.id, u.name, transcript.SummarizeToolInput(u.input))
			if claudeEditTools[u.name] {
				var in struct {
					FilePath     string `json:"file_path"`
					NotebookPath string `json:"notebook_path"`
				}
				_ = json.Unmarshal(u.input, &in)
				b.editsFiles(t, in.FilePath, in.NotebookPath)
			}
			if u.name == "Bash" {
				var in struct {
					Command string `json:"command"`
				}
				_ = json.Unmarshal(u.input, &in)
				b.runsTests(t, in.Command)
			}
		}
	}
}
