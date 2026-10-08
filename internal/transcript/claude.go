package transcript

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Claude Code transcript lines (<--claude-projects>/*/<session>.jsonl and
// its subagents' files). The format is internal and changes between
// releases: anything not recognised is an unknown item, never an error.

// claudeMeta are the metadata line types: hidden notices.
var claudeMeta = map[string]bool{
	"last-prompt": true, "mode": true, "permission-mode": true, "bridge-session": true, "atis-latch": true,
	"ai-title": true, "custom-title": true, "agent-name": true, "cost-state": true, "pr-link": true,
	"file-history-snapshot": true, "file-history-delta": true, "queue-operation": true, "frame-link": true,
	"artifact-autoreact-ledger": true, "artifact-comment-monitor": true, "summary": true, "progress": true, "tag": true,
}

// claudeSubagentTools start a subagent.
var claudeSubagentTools = map[string]bool{"Agent": true, "Task": true}

var (
	systemReminder = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)
	// pastedContent is the wrapper Claude Code puts around pasted text (also text sent as a bracketed paste) of 20 or more
	// characters: `<pasted_content id="bc45">\n…\n</pasted_content id="bc45">`, with a blank line before it and a line end after (what was
	// typed around it stays, blanks and all).
	// RE2 has no backreference, so the two ids are not compared: a paste does not hold a closing tag.
	pastedContent = regexp.MustCompile(`(?s)(?:\n\n)?<pasted_content id="[0-9a-f]+">\n?(.*?)\n?</pasted_content id="[0-9a-f]+">\n?`)
	imageMarker   = regexp.MustCompile(`\[Image #\d+: [^\]\n]+\]`)
	xmlTag        = regexp.MustCompile(`(?s)<([a-z][a-z0-9-]*)>(.*?)</([a-z][a-z0-9-]*)>`)
)

// strOr is a JSON value that is a string or a list of T.
type strOr[T any] struct {
	str   string
	isStr bool
	list  []T
}

func (s *strOr[T]) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	switch {
	case len(b) > 0 && b[0] == '"':
		s.isStr = true
		return json.Unmarshal(b, &s.str)
	case len(b) > 0 && b[0] == '[':
		return json.Unmarshal(b, &s.list)
	}
	return nil // null or anything else: nothing
}

type claudeLine struct {
	Type             string `json:"type"`
	Subtype          string `json:"subtype"`
	UUID             string `json:"uuid"`
	Timestamp        string `json:"timestamp"`
	Version          string `json:"version"`
	IsMeta           bool   `json:"isMeta"`
	IsCompactSummary bool   `json:"isCompactSummary"`
	APIBlockIndex    *int   `json:"apiBlockIndex"`
	Message          *struct {
		ID      string             `json:"id"`
		Content strOr[claudeBlock] `json:"content"`
	} `json:"message"`
	ToolUseResult   json.RawMessage      `json:"toolUseResult"`
	ToolDenialKind  string               `json:"toolDenialKind"` // #171: "user-rejected" on a refused call's result
	Content         strOr[claudeSubPart] `json:"content"`
	DurationMs      *float64             `json:"durationMs"`
	Attachment      json.RawMessage      `json:"attachment"`
	CompactMetadata *struct {
		Trigger   string `json:"trigger"`
		PreTokens int64  `json:"preTokens"`
	} `json:"compactMetadata"`
}

// claudeSource is an image block's source: base64 data or a URL.
type claudeSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	URL       string `json:"url"`
}

// image makes the ref of an image block.
func (pc *parseCtx) claudeImage(src *claudeSource, origin, kind string) imgRef {
	switch {
	case src == nil:
		return pc.external("", origin, kind)
	case src.Type == "url" || (src.Data == "" && src.URL != ""):
		return pc.external(src.URL, origin, kind)
	}
	return pc.inline(src.MediaType, src.Data, origin, kind)
}

// claudeBlock is a message content block.
type claudeBlock struct {
	Type      string               `json:"type"`
	Text      string               `json:"text"`
	Thinking  string               `json:"thinking"`
	ID        string               `json:"id"`
	Name      string               `json:"name"`
	Input     json.RawMessage      `json:"input"`
	ToolUseID string               `json:"tool_use_id"`
	Content   strOr[claudeSubPart] `json:"content"`
	IsError   bool                 `json:"is_error"`
	Source    *claudeSource        `json:"source"`
}

// claudeSubPart is a block inside a tool result.
type claudeSubPart struct {
	Type   string        `json:"type"`
	Text   string        `json:"text"`
	Source *claudeSource `json:"source"`
}

// claudeToolResult is what the bridge renders of a toolUseResult.
type claudeToolResult struct {
	Interrupted     bool            `json:"interrupted"`
	AgentID         string          `json:"agentId"`
	Status          string          `json:"status"`
	Type            string          `json:"type"`
	FilePath        string          `json:"filePath"`
	Content         json.RawMessage `json:"content"`
	StructuredPatch []claudeHunk    `json:"structuredPatch"`
	// BashEditDiff (#171) is what a Bash call changed in its repository, as
	// Claude Code (2.1.269+) recorded it: best effort, see the docs' hooks
	// reference ("Bash"). Absent: not recorded (unknown).
	BashEditDiff *struct {
		Files []struct {
			FilePath string       `json:"filePath"`
			Hunks    []claudeHunk `json:"hunks"`
			Created  bool         `json:"created"`
			Deleted  bool         `json:"deleted"`
		} `json:"files"`
		ChangedFiles []string `json:"changedFiles"`
		MoreFiles    int      `json:"moreFiles"`
		Unavailable  bool     `json:"unavailable"`
		Skipped      bool     `json:"skipped"`
		Shared       bool     `json:"shared"`
	} `json:"bashEditDiff"`
}

// claudeHunk is a structuredPatch (or bashEditDiff) hunk.
type claudeHunk struct {
	OldStart int      `json:"oldStart"`
	OldLines int      `json:"oldLines"`
	NewStart int      `json:"newStart"`
	NewLines int      `json:"newLines"`
	Lines    []string `json:"lines"`
}

func parseTS(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

// hiddenNotice is a dropped line, kept as a hidden notice.
func hiddenNotice(id, source, text string, ts int64) contrib {
	return contrib{id: id, kind: proto.ItemNotice, hidden: true, ts: ts, apply: func(b *builder) { b.notice(source, text) }}
}

func unknownItem(id, rawType string, ts int64) contrib {
	return contrib{id: id, kind: proto.ItemUnknown, hidden: true, ts: ts, apply: func(b *builder) { b.it.RawType = rawType }}
}

func noticeItem(id, source, text string, ts int64) contrib {
	return contrib{id: id, kind: proto.ItemNotice, ts: ts, apply: func(b *builder) { b.notice(source, text) }}
}

func offID(off int64) string { return fmt.Sprintf("o:%d", off) }

// parseClaude reads one line of a Claude Code transcript.
func parseClaude(off int64, b []byte) (cs []contrib, version string) {
	var l claudeLine
	if err := json.Unmarshal(b, &l); err != nil {
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(b, &head)
		raw := head.Type
		if raw == "" {
			raw = "(invalid line)"
		}
		return []contrib{unknownItem(offID(off), raw, 0)}, ""
	}
	ts := parseTS(l.Timestamp)
	id := l.UUID
	if id == "" {
		id = offID(off)
	}
	pc := newParseCtx(off, b)
	switch {
	case l.Type == "assistant" && l.Message != nil:
		return claudeAssistant(&l, id, ts, pc), l.Version
	case l.Type == "user" && l.Message != nil:
		return claudeUser(&l, id, ts, pc), l.Version
	case l.Type == "attachment":
		return []contrib{claudeAttachment(&l, id, ts, pc)}, l.Version
	case l.Type == "system":
		return []contrib{claudeSystem(&l, id, ts)}, l.Version
	case claudeMeta[l.Type]:
		return []contrib{hiddenNotice(id, l.Type, "", ts)}, l.Version
	}
	raw := l.Type
	if raw == "" {
		raw = "(no type)"
	}
	return []contrib{unknownItem(id, raw, ts)}, l.Version
}

func claudeAssistant(l *claudeLine, id string, ts int64, pc *parseCtx) []contrib {
	msg := l.Message.ID
	if msg == "" {
		msg = id
	}
	blocks := l.Message.Content.list
	if l.Message.Content.isStr {
		blocks = []claudeBlock{{Type: "text", Text: l.Message.Content.str}}
	}
	var cs []contrib
	for i, bl := range blocks {
		idx := i
		if l.APIBlockIndex != nil {
			idx = *l.APIBlockIndex + i
		}
		c := contrib{link: linkBlock, msg: msg, block: idx, id: fmt.Sprintf("%s#%d", msg, idx), ts: ts}
		switch bl.Type {
		case "text":
			if strings.TrimSpace(bl.Text) == "" {
				continue
			}
			text := bl.Text
			c.kind = proto.ItemAssistant
			c.apply = func(b *builder) { b.setBlock(idx, proto.TranscriptPart{Text: text}) }
		case "thinking", "redacted_thinking":
			text := bl.Thinking
			c.kind = proto.ItemThinking
			c.apply = func(b *builder) {
				if strings.TrimSpace(text) == "" {
					b.setBlock(idx)
					return
				}
				b.setBlock(idx, proto.TranscriptPart{Text: text})
			}
		case "image":
			ir := pc.claudeImage(bl.Source, proto.OriginAgent, proto.KindGenerated)
			c.kind = proto.ItemAssistant
			c.imgs = []imgRef{ir}
			c.apply = func(b *builder) { b.setBlock(idx, proto.TranscriptPart{Image: ir.ref}) }
		case "tool_use", "server_tool_use":
			if bl.ID != "" {
				c.id = bl.ID
			}
			name, input := bl.Name, bl.Input
			c.kind = proto.ItemTool
			var desc string
			if claudeSubagentTools[name] {
				c.kind = proto.ItemSubagent
				var in struct {
					Description string `json:"description"`
				}
				_ = json.Unmarshal(input, &in)
				desc = in.Description
			}
			var ask *askCall // #57: the question card
			if name == ClaudeAskTool {
				if a, ok := parseAsk(Claude, input); ok {
					ask = &a
				}
			}
			c.apply = func(b *builder) {
				b.call(name, input, summarize(input))
				if ask != nil {
					b.ask = ask
					b.tool().Ask = ask.card(Claude)
				}
				if b.it.Kind == proto.ItemSubagent && b.it.Subagent == nil {
					b.it.Subagent = &proto.TranscriptSubagent{Description: desc, Status: proto.ToolRunning}
				}
			}
		default:
			if strings.HasSuffix(bl.Type, "_tool_result") && bl.ToolUseID != "" {
				// A server tool's result (web search, advisor): its call's.
				text, images := subText(pc, bl.Content)
				status := proto.ToolOK
				if bl.IsError {
					status = proto.ToolError
				}
				cs = append(cs, contrib{link: linkResult, id: bl.ToolUseID, kind: proto.ItemTool, ts: ts, imgs: images,
					apply: func(b *builder) { b.result(status, text, images) }})
				continue
			}
			raw := "assistant/" + bl.Type
			c.kind, c.hidden = proto.ItemUnknown, true
			c.apply = func(b *builder) { b.it.RawType = raw }
		}
		cs = append(cs, c)
	}
	return cs
}

// subText is a tool result's text and its images (what the agent viewed).
func subText(pc *parseCtx, c strOr[claudeSubPart]) (string, []imgRef) {
	if c.isStr {
		return c.str, nil
	}
	var sb strings.Builder
	var images []imgRef
	for _, p := range c.list {
		switch p.Type {
		case "text":
			if sb.Len() > 0 {
				sb.WriteByte('\n')
			}
			sb.WriteString(p.Text)
		case "image":
			images = append(images, pc.claudeImage(p.Source, proto.OriginAgent, proto.KindViewed))
		}
	}
	return sb.String(), images
}

// unwrapPasted takes the paste wrapper out of a prompt, keeping what was pasted and what was typed around it. The
// transcript has it as the model got it (the "queued_command" attachment too); a person never typed it, and the
// prompt they sent from the laptop has none, so it would show twice.
func unwrapPasted(s string) string {
	if !strings.Contains(s, "<pasted_content ") {
		return s
	}
	return strings.TrimSpace(pastedContent.ReplaceAllString(s, "$1"))
}

const (
	interruptedText    = "[Request interrupted by user"
	deniedText         = "The user doesn't want to proceed with this tool use" // #171: a rejected call's result
	compactSummarySrc  = "user/compact_summary"
	interruptNoticeSrc = "user/interrupted"
)

func claudeUser(l *claudeLine, id string, ts int64, pc *parseCtx) []contrib {
	content := l.Message.Content
	if l.IsCompactSummary {
		text := content.str
		if !content.isStr {
			text = joinTexts(content.list)
		}
		return []contrib{noticeItem(id, compactSummarySrc, text, ts)}
	}
	var cs []contrib
	var parts []proto.TranscriptPart
	var imgs []imgRef
	var dropped []string // wrapper text taken out
	interrupted := false
	addText := func(s string) {
		if strings.HasPrefix(strings.TrimSpace(s), interruptedText) {
			interrupted = true
			return
		}
		stripped := systemReminder.ReplaceAllString(s, "")
		if stripped != s {
			dropped = append(dropped, s)
		}
		if strings.TrimSpace(stripped) == "" {
			return
		}
		ps, is := textParts(pc, unwrapPasted(stripped))
		parts = append(parts, ps...)
		imgs = append(imgs, is...)
	}
	blocks := content.list
	if content.isStr {
		blocks = []claudeBlock{{Type: "text", Text: content.str}}
	}
	firstResult := true
	for _, bl := range blocks {
		switch bl.Type {
		case "text":
			addText(bl.Text)
		case "image":
			ir := pc.claudeImage(bl.Source, proto.OriginInput, "")
			imgs = append(imgs, ir)
			parts = append(parts, proto.TranscriptPart{Image: ir.ref})
		case "tool_result":
			cs = append(cs, claudeResult(bl, l, firstResult, ts, pc))
			firstResult = false
		default:
			cs = append(cs, unknownItem(fmt.Sprintf("%s#%d", id, len(cs)), "user/"+bl.Type, ts))
		}
	}
	switch {
	case interrupted:
		cs = append(cs, noticeItem(id, interruptNoticeSrc, "Interrupted by user", ts), contrib{link: linkAbort, ts: ts,
			apply: func(b *builder) { b.interrupt() }})
	case len(parts) == 0 && len(dropped) > 0, len(parts) > 0 && l.IsMeta:
		cs = append(cs, hiddenNotice(id, "user/meta", strings.Join(append(dropped, partsText(parts)), "\n"), ts))
	case len(parts) > 0:
		if c, ok := claudeCommand(id, parts, ts); ok {
			cs = append(cs, c)
			break
		}
		cs = append(cs, contrib{id: id, kind: proto.ItemUser, ts: ts, imgs: imgs, apply: func(b *builder) { b.it.Parts = parts }})
	}
	return cs
}

// claudeCommand is a user line that is a slash command, its output or a
// shell command (Claude Code wraps them in tags).
func claudeCommand(id string, parts []proto.TranscriptPart, ts int64) (contrib, bool) {
	if len(parts) != 1 || parts[0].Text == "" {
		return contrib{}, false
	}
	text := strings.TrimSpace(parts[0].Text)
	if !strings.HasPrefix(text, "<") {
		return contrib{}, false
	}
	tags := map[string]string{}
	for _, m := range xmlTag.FindAllStringSubmatch(text, -1) {
		if m[1] == m[3] {
			tags[m[1]] = strings.TrimSpace(m[2])
		}
	}
	user := func(s string) contrib {
		return contrib{id: id, kind: proto.ItemUser, ts: ts,
			apply: func(b *builder) { b.it.Parts = []proto.TranscriptPart{{Text: s}} }}
	}
	switch {
	case tags["command-name"] != "":
		s := tags["command-name"]
		if a := tags["command-args"]; a != "" {
			s += " " + a
		}
		return user(s), true
	case tags["bash-input"] != "":
		return user("! " + tags["bash-input"]), true
	case hasTag(tags, "local-command-stdout", "local-command-stderr", "bash-stdout", "bash-stderr"):
		out := strings.TrimSpace(strings.Join(nonEmpty(tags["local-command-stdout"], tags["bash-stdout"],
			tags["local-command-stderr"], tags["bash-stderr"]), "\n"))
		if out == "" {
			return hiddenNotice(id, "user/command_output", "", ts), true
		}
		return noticeItem(id, "user/command_output", out, ts), true
	case hasTag(tags, "local-command-caveat", "task-notification"):
		return hiddenNotice(id, "user/meta", text, ts), true
	}
	return contrib{}, false
}

func hasTag(tags map[string]string, names ...string) bool {
	for _, n := range names {
		if _, ok := tags[n]; ok {
			return true
		}
	}
	return false
}

func nonEmpty(ss ...string) []string {
	var out []string
	for _, s := range ss {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func partsText(parts []proto.TranscriptPart) string {
	var ss []string
	for _, p := range parts {
		if p.Text != "" {
			ss = append(ss, p.Text)
		}
	}
	return strings.Join(ss, "\n")
}

func joinTexts(bs []claudeBlock) string {
	var ss []string
	for _, b := range bs {
		if b.Type == "text" {
			ss = append(ss, b.Text)
		}
	}
	return strings.Join(ss, "\n")
}

// claudeResult is a tool_result block: its call's result. The line's
// toolUseResult (structured: diffs, subagents, interruptions) goes with
// the first one.
func claudeResult(bl claudeBlock, l *claudeLine, first bool, ts int64, pc *parseCtx) contrib {
	text, images := subText(pc, bl.Content)
	status := proto.ToolOK
	switch {
	case strings.HasPrefix(strings.TrimSpace(text), interruptedText):
		status = proto.ToolInterrupted
	case bl.IsError && (first && l.ToolDenialKind != "" || strings.HasPrefix(strings.TrimSpace(text), deniedText)):
		status = proto.ToolDenied
	case bl.IsError:
		status = proto.ToolError
	}
	var tr *claudeToolResult
	var raw json.RawMessage // #57: an ask's answers
	if first {
		raw = l.ToolUseResult
	}
	if first && len(l.ToolUseResult) > 0 && l.ToolUseResult[0] == '{' {
		var r claudeToolResult
		if json.Unmarshal(l.ToolUseResult, &r) == nil {
			tr = &r
			if r.Interrupted {
				status = proto.ToolInterrupted
			}
		}
	}
	return contrib{link: linkResult, id: bl.ToolUseID, kind: proto.ItemTool, ts: ts, imgs: images, apply: func(b *builder) {
		b.result(status, text, images)
		if b.ask != nil && b.it.Tool.Ask != nil {
			a := *b.it.Tool.Ask
			a.Outcome, a.Answers = b.ask.claudeResult(raw, bl.IsError)
			b.it.Tool.Ask = &a
		}
		if tr == nil {
			return
		}
		if tr.AgentID != "" || b.it.Kind == proto.ItemSubagent {
			if b.it.Subagent == nil {
				b.it.Subagent = &proto.TranscriptSubagent{}
			}
			if ValidAgentID(tr.AgentID) {
				b.it.Subagent.AgentID = tr.AgentID
			}
			switch {
			case status != proto.ToolOK:
				b.it.Subagent.Status = status
			case tr.Status != "":
				b.it.Subagent.Status = tr.Status
			default:
				b.it.Subagent.Status = proto.ToolOK
			}
		}
		switch {
		case tr.BashEditDiff != nil: // #171
			b.diffs, b.changes = claudeBashChanges(tr)
		case tr.FilePath != "":
			if d, ok := claudeDiff(tr, b.tool().Name); ok {
				b.diffs = []proto.TranscriptDiff{d}
			}
		}
	}}
}

// claudeHunks are a patch's hunks for the wire (never nil: an empty list).
func claudeHunks(hs []claudeHunk) []proto.TranscriptHunk {
	out := []proto.TranscriptHunk{}
	for _, h := range hs {
		lines := h.Lines
		if lines == nil {
			lines = []string{}
		}
		out = append(out, proto.TranscriptHunk{OldStart: h.OldStart, OldLines: h.OldLines, NewStart: h.NewStart,
			NewLines: h.NewLines, Lines: lines})
	}
	return out
}

// claudeDiff is an Edit's or Write's structuredPatch; a created file is
// all added lines. #171: what happened to the file comes from the result's
// type (Write) or the tool (Edit), never from originalFile (null on most
// edits); an overwrite or edit recorded without hunks is NoDiff, never a
// new file and never removals made up.
func claudeDiff(tr *claudeToolResult, tool string) (proto.TranscriptDiff, bool) {
	d := proto.TranscriptDiff{Path: tr.FilePath, Hunks: claudeHunks(tr.StructuredPatch)}
	switch {
	case tr.Type == "create":
		d.Op = proto.DiffCreate
	case tr.Type == "update":
		d.Op = proto.DiffOverwrite
	case tool == "Edit" || tool == "MultiEdit":
		d.Op = proto.DiffEdit
	}
	if len(d.Hunks) > 0 {
		return d, true
	}
	if tr.Type == "create" {
		var content string
		if json.Unmarshal(tr.Content, &content) != nil {
			return d, false
		}
		if content != "" { // an empty file has no lines
			lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
			for i, s := range lines {
				lines[i] = "+" + s
			}
			d.Hunks = append(d.Hunks, proto.TranscriptHunk{NewStart: 1, NewLines: len(lines), Lines: lines})
		}
		return d, true
	}
	if tr.StructuredPatch == nil {
		return d, false
	}
	d.NoDiff = true
	return d, true
}

// claudeBashChanges is a Bash call's bashEditDiff (#171): a diff per file
// it has one for, and the rest (changed files without one, how complete and
// whose the list is). Changes is nil when the record says nothing more than
// its diffs.
func claudeBashChanges(tr *claudeToolResult) ([]proto.TranscriptDiff, *proto.TranscriptChanges) {
	e := tr.BashEditDiff
	var diffs []proto.TranscriptDiff
	diffed := map[string]bool{}
	for _, f := range e.Files {
		if f.FilePath == "" {
			continue
		}
		d := proto.TranscriptDiff{Path: f.FilePath, Hunks: claudeHunks(f.Hunks), Op: proto.DiffEdit}
		switch {
		case f.Created:
			d.Op = proto.DiffCreate
		case f.Deleted:
			d.Op = proto.DiffDelete
		case len(d.Hunks) == 0:
			d.NoDiff = true
		}
		diffs = append(diffs, d)
		diffed[f.FilePath] = true
	}
	c := proto.TranscriptChanges{MoreFiles: max(e.MoreFiles, 0), Unavailable: e.Unavailable, Skipped: e.Skipped, Shared: e.Shared}
	for _, p := range e.ChangedFiles {
		if p != "" && !diffed[p] {
			c.Paths = append(c.Paths, p)
			diffed[p] = true
		}
	}
	if len(c.Paths) == 0 && c.MoreFiles == 0 && !c.Unavailable && !c.Skipped && !c.Shared {
		return diffs, nil
	}
	return diffs, &c
}

type claudeAttach struct {
	Type        string `json:"type"`
	Prompt      string `json:"prompt"`
	CommandMode string `json:"commandMode"`
	Origin      *struct {
		Kind string `json:"kind"`
	} `json:"origin"`
	Content json.RawMessage `json:"content"`
}

// claudeAttachment is noise (reminders, hook context, tool lists…), with
// one exception: a prompt the user queued while the agent worked.
func claudeAttachment(l *claudeLine, id string, ts int64, pc *parseCtx) contrib {
	var a claudeAttach
	_ = json.Unmarshal(l.Attachment, &a)
	if a.Type == "queued_command" && a.CommandMode == "prompt" && a.Origin != nil && a.Origin.Kind == "human" &&
		strings.TrimSpace(a.Prompt) != "" {
		parts, imgs := textParts(pc, unwrapPasted(a.Prompt))
		return contrib{id: id, kind: proto.ItemUser, ts: ts, imgs: imgs, apply: func(b *builder) { b.it.Parts = parts }}
	}
	text := a.Prompt
	if text == "" {
		var c strOr[string]
		_ = json.Unmarshal(a.Content, &c)
		text = c.str
		if !c.isStr {
			text = strings.Join(c.list, "\n")
		}
	}
	return hiddenNotice(id, "attachment/"+a.Type, text, ts)
}

func claudeSystem(l *claudeLine, id string, ts int64) contrib {
	src := "system/" + l.Subtype
	text := l.Content.str
	if !l.Content.isStr {
		var ss []string
		for _, p := range l.Content.list {
			ss = append(ss, p.Text)
		}
		text = strings.Join(ss, "\n")
	}
	switch l.Subtype {
	case "compact_boundary":
		note := "Conversation compacted"
		if m := l.CompactMetadata; m != nil {
			if m.Trigger != "" {
				note += " (" + m.Trigger
				if m.PreTokens > 0 {
					note += fmt.Sprintf(", %d tokens", m.PreTokens)
				}
				note += ")"
			}
		}
		return contrib{id: id, kind: proto.ItemCompaction, ts: ts, apply: func(b *builder) { b.notice(src, note) }}
	case "turn_duration":
		note := "Turn done"
		if l.DurationMs != nil {
			note = "Turn took " + formatDuration(int64(*l.DurationMs))
		}
		return noticeItem(id, src, note, ts)
	case "local_command":
		for _, m := range xmlTag.FindAllStringSubmatch(text, -1) {
			if m[1] == m[3] {
				text = strings.TrimSpace(m[2])
			}
		}
		if strings.TrimSpace(text) == "" {
			return hiddenNotice(id, src, "", ts)
		}
		return noticeItem(id, src, text, ts)
	case "away_summary", "informational", "api_error":
		return noticeItem(id, src, text, ts)
	case "stop_hook_summary":
		return hiddenNotice(id, src, text, ts)
	}
	return unknownItem(id, src, ts)
}

// formatDuration is "4m 12s", "8.3s".
func formatDuration(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	case d < time.Hour:
		return fmt.Sprintf("%dm %ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
}

var agentIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ValidAgentID reports whether id can be a Claude subagent's agent id (it
// names the subagent's file).
func ValidAgentID(id string) bool { return agentIDRe.MatchString(id) }
