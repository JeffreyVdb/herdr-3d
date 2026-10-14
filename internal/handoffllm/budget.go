package handoffllm

import (
	"context"
	"maps"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// EstimateTokens is a conservative, tokenizer-free token estimate of s:
// ceil(ASCII bytes / 3) + one token per non-ASCII rune. It is an estimate,
// not a count: real tokenizers differ by model and usually need fewer
// (English is about 4 characters a token), CJK text and emoji about one a
// character; a provider's reported prompt tokens are the only exact number.
func EstimateTokens(s string) int {
	ascii, other := 0, 0
	for i := 0; i < len(s); {
		if s[i] < utf8.RuneSelf {
			ascii++
			i++
			continue
		}
		_, n := utf8.DecodeRuneInString(s[i:])
		i += n
		other++
	}
	return (ascii+2)/3 + other
}

// Reduction levels of a message, from whole to left out.
const (
	lvFull    = iota // everything kept
	lvBrief          // tool evidence left out (tool name, input and status kept)
	lvExcerpt        // text excerpted, tool calls reduced to a count
	lvOmitted        // left out: an omitted-range marker stands for it
)

// Why a message (or part of it) was left out: Range.Why.
const (
	whyEvidence      = "tool evidence"
	whyDetail        = "older assistant detail"
	whyMiddle        = "middle history"
	whySummaryCut    = "compaction summary excerpted"
	whySummaryOmit   = "compaction summary"
	whyEarly         = "prompt before compaction"
	excerptBytes     = 400  // an excerpted assistant message's text head
	summaryHeadBytes = 1536 // an excerpted compaction summary's head…
	summaryTailBytes = 512  // …and tail
)

// item is one entry of the reduced transcript while it is fitted to the
// budget: its level and its renders, made once per level.
type item struct {
	e       entry
	secrets []string
	ord     int // the message's ordinal (0 for a note)
	level   int
	render  [lvOmitted]string
	red     [lvOmitted]map[string]int
	done    [lvOmitted]bool
	// The omitted run this item ends or starts (valid at the run's ends).
	runFrom, runTo int
}

func (it *item) text(level int) (string, map[string]int) {
	if !it.done[level] {
		it.render[level], it.red[level] = renderEntry(it.e, it.ord, level, it.secrets)
		it.done[level] = true
	}
	return it.render[level], it.red[level]
}

func (it *item) size(level int) int {
	s, _ := it.text(level)
	return len(s)
}

// fitter brings the entries' Text to the budget: total is the Text's length
// as it stands (each block ends with a blank line; the last newline is not
// part of Text).
type fitter struct {
	items []*item
	total int
}

// fit reduces entries to at most budget bytes of Text, deterministically:
// older tool evidence first, then older assistant text (intermediate
// messages before turns' final replies), then the compaction summary, then
// whole messages of the middle history, oldest first. User messages and the
// final reply's text are pinned: when they alone do not fit, ErrTooLarge.
func fit(ctx context.Context, entries []entry, budget int, secrets []string) (text string, kept int, omitted []Range, red map[string]int, err error) {
	f := &fitter{}
	ord := 0
	for _, e := range entries {
		it := &item{e: e, secrets: secrets}
		if e.m != nil {
			ord++
			it.ord = ord
		}
		f.items = append(f.items, it)
		f.total += it.size(lvFull)
	}
	f.total-- // Text has no trailing newline
	steps := f.plan()
	var dropped []int // items omitted, in order
	for n, st := range steps {
		if f.total <= budget {
			break
		}
		if n%256 == 0 && ctx.Err() != nil {
			return "", 0, nil, nil, ctx.Err()
		}
		if st.level == lvOmitted && f.items[st.i].level < lvOmitted {
			dropped = append(dropped, st.i)
		}
		f.apply(st)
	}
	if f.total > budget {
		return "", 0, nil, nil, ErrTooLarge
	}
	f.backfill(dropped, budget)
	text, kept, omitted, red = f.result()
	if len(text) > budget { // by construction never; never send more than asked
		return "", 0, nil, nil, ErrTooLarge
	}
	return text, kept, omitted, red, nil
}

// maxBackfill bounds how many dropped messages backfill tries to restore.
const maxBackfill = 64

// backfill gives room the last reductions left back: the messages dropped
// last (the most valuable ones dropped) are restored, whole or excerpted,
// when they fit after all.
func (f *fitter) backfill(dropped []int, budget int) {
	for n := 0; n < maxBackfill && n < len(dropped); n++ {
		it := f.items[dropped[len(dropped)-1-n]]
		for _, lv := range []int{lvFull, lvBrief, lvExcerpt} {
			if !f.allowed(it, lv) {
				continue
			}
			it.level = lv
			if f.recount() <= budget {
				break
			}
			it.level = lvOmitted
			f.recount()
		}
	}
}

// allowed: the levels plan can put a message at (an excerpt only where
// plan excerpts).
func (f *fitter) allowed(it *item, lv int) bool {
	m := it.e.m
	switch lv {
	case lvBrief:
		return m.role == roleAssistant
	case lvExcerpt:
		return m.role == roleSummary || (m.role == roleAssistant && !m.final)
	}
	return true
}

// recount sets total and the omitted runs from the items' levels.
func (f *fitter) recount() int {
	f.total = -1
	for i := 0; i < len(f.items); i++ {
		it := f.items[i]
		if it.level != lvOmitted {
			f.total += it.size(it.level)
			continue
		}
		why, to := omitWhy(it.e.m), i
		for to+1 < len(f.items) && f.joins(to+1, why) {
			to++
		}
		f.items[to].runFrom, f.items[i].runTo = i, to
		f.total += f.markerSize(i, to)
		i = to
	}
	return f.total
}

type step struct{ i, level int }

// plan lists the reductions in the order they are tried.
func (f *fitter) plan() []step {
	var steps []step
	each := func(level int, ok func(m *msg) bool) {
		for i, it := range f.items {
			if m := it.e.m; m != nil && ok(m) {
				steps = append(steps, step{i, level})
			}
		}
	}
	asst := func(m *msg) bool { return m.role == roleAssistant }
	each(lvBrief, func(m *msg) bool { return asst(m) && m.hasEvidence() })
	each(lvExcerpt, func(m *msg) bool { return asst(m) && !m.final && !m.turnFinal })
	each(lvExcerpt, func(m *msg) bool { return asst(m) && !m.final && m.turnFinal })
	each(lvExcerpt, func(m *msg) bool { return m.role == roleSummary })
	each(lvOmitted, func(m *msg) bool { return asst(m) && !m.final && !m.turnFinal })
	each(lvOmitted, func(m *msg) bool { return asst(m) && !m.final && m.turnFinal })
	// Prompts from before a compaction summary: corrections first, newest
	// first, the first goal last; then the summary itself.
	var early []int
	for i, it := range f.items {
		if m := it.e.m; m != nil && m.early {
			early = append(early, i)
		}
	}
	for j := len(early) - 1; j >= 1; j-- {
		steps = append(steps, step{early[j], lvOmitted})
	}
	if len(early) > 0 {
		steps = append(steps, step{early[0], lvOmitted})
	}
	each(lvOmitted, func(m *msg) bool { return m.role == roleSummary })
	return steps
}

func (f *fitter) apply(st step) {
	it := f.items[st.i]
	if st.level <= it.level {
		return
	}
	if st.level < lvOmitted {
		if d := it.size(st.level) - it.size(it.level); d < 0 {
			f.total += d
			it.level = st.level
		}
		return
	}
	f.total -= it.size(it.level)
	it.level = lvOmitted
	why := omitWhy(it.e.m)
	from, to := st.i, st.i
	if l := st.i - 1; l >= 0 && f.joins(l, why) {
		from = f.items[l].runFrom
		f.total -= f.markerSize(from, l)
	}
	if r := st.i + 1; r < len(f.items) && f.joins(r, why) {
		to = f.items[r].runTo
		f.total -= f.markerSize(r, to)
	}
	f.items[to].runFrom, f.items[from].runTo = from, to
	f.total += f.markerSize(from, to)
}

// joins reports whether item i is omitted for why (so a run grows into it).
func (f *fitter) joins(i int, why string) bool {
	it := f.items[i]
	return it.level == lvOmitted && omitWhy(it.e.m) == why
}

func omitWhy(m *msg) string {
	switch {
	case m.role == roleSummary:
		return whySummaryOmit
	case m.early:
		return whyEarly
	}
	return whyMiddle
}

func (f *fitter) markerSize(from, to int) int {
	return len(omittedMarker(f.items[from].ord, f.items[to].ord, omitWhy(f.items[from].e.m)))
}

func omittedMarker(from, to int, why string) string {
	n := to - from + 1
	span, msgs := "#"+strconv.Itoa(from), " messages"
	if n > 1 {
		span += "-#" + strconv.Itoa(to)
	} else {
		msgs = " message"
	}
	return "=== omitted " + span + " (" + strconv.Itoa(n) + msgs + "): " + why + " ===\n\n"
}

// result renders Text and says what was left out.
func (f *fitter) result() (string, int, []Range, map[string]int) {
	var b strings.Builder
	red := map[string]int{}
	kept := 0
	var ranges []Range
	for i := 0; i < len(f.items); i++ {
		it := f.items[i]
		if it.level == lvOmitted {
			to := it.runTo
			b.WriteString(omittedMarker(it.ord, f.items[to].ord, omitWhy(it.e.m)))
			ranges = addRange(ranges, it.ord, f.items[to].ord, omitWhy(it.e.m))
			i = to
			continue
		}
		s, r := it.text(it.level)
		b.WriteString(s)
		for k, v := range r {
			red[k] += v
		}
		if it.e.m == nil {
			continue
		}
		kept++
		switch {
		case it.level == lvBrief:
			ranges = addRange(ranges, it.ord, it.ord, whyEvidence)
		case it.level == lvExcerpt && it.e.m.role == roleSummary:
			ranges = addRange(ranges, it.ord, it.ord, whySummaryCut)
		case it.level == lvExcerpt:
			ranges = addRange(ranges, it.ord, it.ord, whyDetail)
		}
	}
	sort.SliceStable(ranges, func(i, j int) bool { return ranges[i].From < ranges[j].From })
	return strings.TrimSuffix(b.String(), "\n"), kept, ranges, red
}

// addRange appends a range, merged into the last one when it continues it
// for the same reason.
func addRange(rs []Range, from, to int, why string) []Range {
	if n := len(rs); n > 0 && rs[n-1].Why == why && rs[n-1].To+1 == from {
		rs[n-1].To = to
		return rs
	}
	return append(rs, Range{From: from, To: to, Why: why})
}

// renderEntry renders an entry at a level: a header line, the text, the
// tool lines, and a blank line. Pieces were scrubbed when they were read;
// an excerpt is scrubbed again after the cut (the counts are the source
// pieces', so an excerpt can count a redaction its cut left out).
func renderEntry(e entry, ord, level int, secrets []string) (string, map[string]int) {
	if e.m == nil {
		return "=== note: " + e.note + " ===\n\n", nil
	}
	m := e.m
	red := map[string]int{}
	var b strings.Builder
	b.WriteString("=== #" + strconv.Itoa(ord) + " " + m.label())
	if m.ts != "" {
		b.WriteString(" " + m.ts)
	}
	b.WriteString(" ===\n")
	maps.Copy(red, m.red)
	text := m.text
	if level == lvExcerpt {
		if m.role == roleSummary {
			text = excerpt(text, summaryHeadBytes, summaryTailBytes)
		} else {
			text = excerpt(text, excerptBytes, 0)
		}
		var r map[string]int
		text, r = Scrub(text, secrets...)
		addCounts(red, r)
	}
	if text != "" {
		b.WriteString(text)
		b.WriteByte('\n')
	}
	if m.images > 0 {
		b.WriteString("[" + plural(m.images, "image") + " omitted]\n")
	}
	if level == lvExcerpt {
		if len(m.tools) > 0 {
			b.WriteString("[tools] " + toolCounts(m.tools) + " (detail omitted)\n")
		}
	} else {
		for _, t := range m.tools {
			addCounts(red, t.red)
			b.WriteString("[tool] " + t.name)
			if t.input != "" {
				b.WriteString(": " + t.input)
			}
			if t.status != "" {
				b.WriteString(" -> " + t.status)
			}
			if level == lvBrief && len(t.evidence) > 0 {
				b.WriteString(" [output omitted]")
			}
			b.WriteByte('\n')
			if level == lvFull {
				addCounts(red, t.evRed)
				for _, l := range t.evidence {
					b.WriteString("  | " + l + "\n")
				}
			}
		}
	}
	b.WriteByte('\n')
	return b.String(), red
}

func addCounts(dst, src map[string]int) {
	for k, v := range src {
		dst[k] += v
	}
}

func plural(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return strconv.Itoa(n) + " " + what + "s"
}

// toolCounts is "Bash x3, Edit x1": each tool's calls, in first-use order.
func toolCounts(ts []*tool) string {
	var names []string
	n := map[string]int{}
	for _, t := range ts {
		if n[t.name] == 0 {
			names = append(names, t.name)
		}
		n[t.name]++
	}
	parts := make([]string, len(names))
	for i, name := range names {
		parts[i] = name + " x" + strconv.Itoa(n[name])
	}
	return strings.Join(parts, ", ")
}

// excerpt keeps the first head bytes and the last tail bytes of s (cut at
// rune boundaries) with a marker saying how much was left out; s itself
// when it fits.
func excerpt(s string, head, tail int) string {
	if len(s) <= head+tail+64 {
		return s
	}
	h, t := cutHead(s, head), cutTail(s, tail)
	marker := "… [" + strconv.Itoa(len(s)-len(h)-len(t)) + " bytes omitted]"
	if t == "" {
		return h + marker
	}
	return h + "\n" + marker + "\n" + t
}

// cutHead is at most n bytes of s's start, never inside a rune.
func cutHead(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// cutTail is at most n bytes of s's end, never inside a rune.
func cutTail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	i := len(s) - n
	for i < len(s) && !utf8.RuneStart(s[i]) {
		i++
	}
	return s[i:]
}

// clip is s cut to at most n bytes at a rune boundary, with "…" (counted in
// n) when cut.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const ell = "…"
	return cutHead(s, n-len(ell)) + ell
}
