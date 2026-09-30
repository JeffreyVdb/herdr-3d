package transcript

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Caps of an item in lists (watch acks, pages, pushes); transcript.item
// has everything.
const (
	// MaxText caps a tool's output_text, a thinking or message text part
	// and a notice.
	MaxText = 64 << 10
	// MaxInput is the largest raw tool input sent in lists.
	MaxInput = 4 << 10
	// MaxHiddenText caps a hidden notice's text.
	MaxHiddenText = 512
	// MaxDiffBytes caps the lines of a tool's diffs.
	MaxDiffBytes = 64 << 10
	// maxSummary caps an input_summary, in runes.
	maxSummary = 200
)

// link is how a line's contribution joins the timeline.
type link uint8

const (
	// linkOwn: an item of its own, by id (a repeated id adds to it).
	linkOwn link = iota
	// linkBlock: a Claude assistant block: consecutive text (or thinking)
	// blocks of one message are one item.
	linkBlock
	// linkResult: the result of the call with id.
	linkResult
	// linkAbort: an interruption: every call still running is
	// interrupted.
	linkAbort
)

// contrib is what one line gives one item. Parsing is deterministic, so
// an item is rebuilt from its lines by parsing them again and applying the
// same contributions (by their index in the line) in order.
type contrib struct {
	link   link
	id     string // the item's id; linkResult: the call's
	msg    string // linkBlock: the message
	block  int    // linkBlock: the block's index in the message
	kind   string
	hidden bool
	ts     int64
	apply  func(b *builder)
}

// builder assembles an item from its contributions.
type builder struct {
	it     proto.TranscriptItem
	blocks []blockParts // linkBlock parts, by block
	diffs  []proto.TranscriptDiff
}

type blockParts struct {
	block int
	parts []proto.TranscriptPart
}

func newBuilder(id string, seq int64, c *contrib) *builder {
	return &builder{it: proto.TranscriptItem{ID: id, Seq: seq, TS: c.ts, Kind: c.kind, Hidden: c.hidden}}
}

// add applies one contribution.
func (b *builder) add(c *contrib) {
	if c.apply != nil {
		c.apply(b)
	}
}

// setBlock puts the parts of one block (replacing that block's).
func (b *builder) setBlock(block int, parts ...proto.TranscriptPart) {
	for i := range b.blocks {
		if b.blocks[i].block == block {
			b.blocks[i].parts = parts
			return
		}
	}
	b.blocks = append(b.blocks, blockParts{block, parts})
}

func (b *builder) tool() *proto.TranscriptTool {
	if b.it.Tool == nil {
		b.it.Tool = &proto.TranscriptTool{}
	}
	return b.it.Tool
}

// call sets what a tool call says: its name and input; running until its
// result comes.
func (b *builder) call(name string, input json.RawMessage, summary string) {
	t := b.tool()
	t.Name, t.Input, t.InputSummary = name, input, clipSummary(summary)
	if t.Status == "" {
		t.Status = proto.ToolRunning
	}
}

// result sets a call's result.
func (b *builder) result(status, text string, images int) {
	t := b.tool()
	if t.Status == "" || t.Status == proto.ToolRunning || status != proto.ToolOK {
		t.Status = status
	}
	if text != "" {
		t.OutputText = text
	}
	for range images {
		t.Images = append(t.Images, proto.TranscriptPart{ImageOmitted: true})
	}
	if b.it.Subagent != nil && b.it.Subagent.Status == proto.ToolRunning && status != proto.ToolOK {
		b.it.Subagent.Status = status
	}
}

// interrupt marks a call that is still running interrupted.
func (b *builder) interrupt() {
	if t := b.it.Tool; t != nil && t.Status == proto.ToolRunning {
		t.Status = proto.ToolInterrupted
		if s := b.it.Subagent; s != nil && s.Status == proto.ToolRunning {
			s.Status = proto.ToolInterrupted
		}
	}
}

func (b *builder) notice(source, text string) {
	b.it.Notice = &proto.TranscriptNotice{Text: text, Source: source}
}

// finish returns the item, capped for lists unless full.
func (b *builder) finish(full bool) proto.TranscriptItem {
	it := b.it
	if len(b.blocks) > 0 {
		sort.SliceStable(b.blocks, func(i, j int) bool { return b.blocks[i].block < b.blocks[j].block })
		it.Parts = nil
		for _, bp := range b.blocks {
			it.Parts = append(it.Parts, bp.parts...)
		}
	}
	if len(b.diffs) > 0 {
		t := b.tool()
		t.Diff = &b.diffs[0]
		if len(b.diffs) > 1 {
			t.Diffs = b.diffs
		}
	}
	if full {
		return it
	}
	it.Parts = slices.Clone(it.Parts)
	for i := range it.Parts {
		if p := &it.Parts[i]; len(p.Text) > MaxText {
			p.Text, it.Truncated = cut(p.Text, MaxText), true
		}
	}
	if n := it.Notice; n != nil {
		limit := MaxText
		if it.Hidden {
			limit = MaxHiddenText
		}
		if len(n.Text) > limit {
			it.Notice = &proto.TranscriptNotice{Text: cut(n.Text, limit), Source: n.Source}
			it.Truncated = true
		}
	}
	if t := it.Tool; t != nil {
		c := *t
		if len(c.OutputText) > MaxText {
			c.OutputText, c.OutputTruncated = cut(c.OutputText, MaxText), true
		}
		if len(c.Input) > MaxInput {
			c.Input = nil
		}
		budget := MaxDiffBytes
		if c.Diff != nil {
			d := capDiff(*c.Diff, &budget)
			c.Diff = &d
		}
		if len(c.Diffs) > 0 {
			ds := make([]proto.TranscriptDiff, len(c.Diffs))
			budget = MaxDiffBytes
			for i, d := range c.Diffs {
				ds[i] = capDiff(d, &budget)
			}
			c.Diffs, c.Diff = ds, &ds[0]
		}
		it.Tool = &c
	}
	return it
}

// capDiff keeps a diff's lines within what is left of budget.
func capDiff(d proto.TranscriptDiff, budget *int) proto.TranscriptDiff {
	out := proto.TranscriptDiff{Path: d.Path, Truncated: d.Truncated, Hunks: make([]proto.TranscriptHunk, 0, len(d.Hunks))}
	for _, h := range d.Hunks {
		kept := h
		kept.Lines = nil
		for _, l := range h.Lines {
			if *budget < len(l)+1 {
				out.Truncated = true
				break
			}
			*budget -= len(l) + 1
			kept.Lines = append(kept.Lines, l)
		}
		if kept.Lines == nil {
			kept.Lines = []string{}
		}
		out.Hunks = append(out.Hunks, kept)
		if out.Truncated {
			break
		}
	}
	return out
}

// cut shortens s to at most n bytes, at a rune boundary.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// clipSummary is a summary's first non-empty line, at most maxSummary
// runes.
func clipSummary(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	if utf8.RuneCountInString(s) > maxSummary {
		s = string([]rune(s)[:maxSummary-1]) + "…"
	}
	return s
}

// summarize describes a tool input: the first of its usual fields that is
// a string, else the input itself.
func summarize(input json.RawMessage) string {
	var m map[string]json.RawMessage
	if json.Unmarshal(input, &m) != nil {
		var s string
		if json.Unmarshal(input, &s) == nil {
			return s
		}
		return string(input)
	}
	for _, k := range []string{"command", "cmd", "file_path", "notebook_path", "path", "pattern", "url", "query",
		"description", "task_name", "skill", "prompt", "subject", "target", "message"} {
		var s string
		if json.Unmarshal(m[k], &s) == nil && strings.TrimSpace(s) != "" {
			if k == "pattern" {
				var p string
				if json.Unmarshal(m["path"], &p) == nil && p != "" {
					return s + " in " + p
				}
			}
			return s
		}
	}
	return string(input)
}

// textParts turns text into parts, each "[Image #n: path]" marker an
// omitted image (the path is never looked at).
func textParts(s string) []proto.TranscriptPart {
	var out []proto.TranscriptPart
	for s != "" {
		loc := imageMarker.FindStringIndex(s)
		if loc == nil {
			break
		}
		if t := s[:loc[0]]; strings.TrimSpace(t) != "" {
			out = append(out, proto.TranscriptPart{Text: t})
		}
		out = append(out, proto.TranscriptPart{ImageOmitted: true})
		s = s[loc[1]:]
	}
	if strings.TrimSpace(s) != "" {
		out = append(out, proto.TranscriptPart{Text: s})
	}
	return out
}
