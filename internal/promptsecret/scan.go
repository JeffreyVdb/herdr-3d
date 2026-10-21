// Package promptsecret finds possible secrets in a prompt for the user to
// review before it is sent (#108, docs/protocol.md "Prompt secrets"), and
// holds the review's contract: candidates at exact byte ranges, a revision
// that binds them to the text, the decisions checked against a fresh scan,
// and the text with the protected ranges replaced by file references.
//
// Detection is Gitleaks v8.30.1's default rules, generated (gitleaks.go,
// tools/secretrules, the parity check), and this package's structural
// rules (structural.go). Every candidate is only a proposal: nothing here
// decides what is protected. The standard library only
// (TestPromptSecretIsALeaf).
package promptsecret

import (
	"regexp"
	"slices"
	"strings"
	"sync"
)

// RulesVersion names the rule set: it is part of every revision, so a
// review made under other rules is stale.
const RulesVersion = "gitleaks-" + gitleaksVersion + "+" + "structural-1" + "+" + "entropy-1"

// Candidate is one possible secret: the bytes [Start, End) of the text, the
// detectors that found exactly that range (gitleaks:<rule id> or a Kind*),
// and Encoded: its bytes hold a JSON or shell escape, percent-encoding or a
// YAML block's indentation, which the file keeps as typed.
type Candidate struct {
	Start, End int
	Kinds      []string
	Encoded    bool
}

// Scan finds the candidates in text (valid UTF-8): sorted, never
// overlapping. own reports the paths the bridge's own file references hold
// (nil: none): such a reference, exactly "[secret in file <path>]", is never
// part of a candidate, and only its bytes are left out (outside). The
// detectors read the text as typed and, when it holds one, again with each
// reference masked as one word, so a value that runs into a reference, on
// either side of it, is found as if a value stood in its place. The mask
// stands for a value's place, not its content: a span the masked text gave
// for its value's shape (a token format, a length, a digit) that runs into a
// reference may owe that shape to the mask's bytes, and one found as typed
// that a reference's own bytes cut short (clipped) has a false edge. Such a
// span is borrowed: it ranks after every other (resolve), and a span it wins
// over keeps the bytes no winner has, so it never takes another's typed
// bytes. Overlaps are resolved on the whole ranges; then each candidate keeps
// its parts outside the references. The first call compiles the rules.
func Scan(text string, own func(path string) bool) []Candidate {
	refs := references(text, own)
	spans := detect(text, nil)
	mtext := text
	if len(refs) > 0 {
		for i := range spans {
			spans[i].borrowed = clipped(spans[i], refs)
		}
		mtext = masked(text, refs)
		for _, s := range detect(mtext, refs) {
			s.borrowed = s.shaped && overlapsAny(s.start, s.end, refs)
			spans = append(spans, s)
		}
	}
	spans = slices.DeleteFunc(spans, func(s span) bool { return s.start >= s.end || insideOne(s, refs) })
	byRange := kindsBySpan(spans)
	kinds := map[[2]int]spanKinds{}
	var won []span
	for _, w := range resolve(text, mtext, spans, refs) {
		for _, p := range outside(text, []span{w}, refs) {
			kinds[[2]int{p.start, p.end}] = byRange[w.found()]
			won = append(won, p)
		}
	}
	// The other occurrences of a value another rule found are repeats as
	// before: the entropy rule's spans are not one of those values, and give
	// way to a repeat over them.
	known := slices.DeleteFunc(slices.Clone(won), func(s span) bool { return s.kind == KindEntropy })
	more := outside(text, repeats(text, known), refs)
	won = slices.DeleteFunc(won, func(s span) bool { return s.kind == KindEntropy && overlapsAny(s.start, s.end, more) })
	for r, k := range kindsBySpan(more) {
		kinds[r] = k
	}
	won = append(won, more...)
	slices.SortFunc(won, func(a, b span) int { return a.start - b.start })
	out := make([]Candidate, 0, len(won))
	for _, s := range won {
		k := kinds[[2]int{s.start, s.end}]
		out = append(out, Candidate{Start: s.start, End: s.end, Kinds: k.kinds, Encoded: k.encoded || encoded(text[s.start:s.end])})
	}
	return out
}

// detect is every detector's spans in text: Gitleaks' rules (and its
// provider rules again before a sentence's punctuation), then the
// structural ones, then the entropy rule's (entropyKept). refs are the own
// references masked in text (nil: as typed).
func detect(text string, refs []span) []span {
	var spans []span
	for _, m := range append(Gitleaks(text), punctuated(text, refs)...) {
		rank := rankProvider
		if strings.Contains(strings.ToLower(m.Rule), "generic") {
			rank = rankGeneric
		}
		spans = append(spans, span{start: m.Start, end: m.End, kind: "gitleaks:" + m.Rule, rank: rank, shaped: true})
	}
	spans = append(spans, structural(text, refs)...)
	return append(spans, entropyKept(text, entropySpans(text, refs), spans)...)
}

// entropyKept are the entropy spans that no other detector found a part of:
// the entropy rule fills the gaps, and every other finding keeps its bytes
// and its kinds (the same range found twice would add a kind to it). One
// exception: a Gitleaks generic rule's finding is no known format, only a
// value after a name, and its value runs on through a sentence's '.'
// ("<tok>." and "<tok>..."): where the bytes it has past the run are only
// that punctuation, and it starts where the run does, the run replaces it at
// the run's exact bytes (rankEntropy comes before rankGeneric). Any other
// overlap keeps the generic finding whole and drops the run: a prefix
// ("foo=<tok>", where the run starts after the '='), a longer value, a
// generic span inside the run, a partial overlap; so does "foo=<tok>." (the
// finding is the whole value, period included, as before). The same range
// stays the generic rule's.
func entropyKept(text string, found, others []span) []span {
	return slices.DeleteFunc(found, func(e span) bool {
		return slices.ContainsFunc(others, func(o span) bool {
			if o.start >= e.end || e.start >= o.end {
				return false
			}
			if o.rank != rankGeneric {
				return true
			}
			return !(o.start == e.start && o.end > e.end && strings.Trim(text[e.end:o.end], ".!?:") == "")
		})
	})
}

// gitleaksBoundary ends most Gitleaks rules: after the token a blank, a
// quote, a ';', an escaped newline or the end.
const gitleaksBoundary = `(?:[\x60'"\s;]|\\[nr]|$)`

// gitleaksSeparator is what stands between a name and its value in
// Gitleaks' keyword rules: the only colon a rule punctuated runs may read
// (TestPunctColonRules).
const gitleaksSeparator = `(?:=|>|:{1,3}=|\|\||:|=>|\?=|,)`

var (
	punctOnce  sync.Once
	punctRules []*compiledRule
	namedRules []*compiledRule // punctRules with a name before the value
)

// sentencePunct may end a sentence right after a token (not ']': a
// reference ends in one).
const sentencePunct = ".,:!?)"

// punctuated are the findings of the provider rules that ask for
// gitleaksBoundary after their token where a sentence's punctuation stands
// instead: a run of sentencePunct right after a token-like word (tokenBefore),
// before a blank or the end ("Use sk_live_….", "(hf_…).", "(hf_…: then").
// Those rules run again over a copy of text with each such run blanked (the
// same length, so the ranges hold), and a finding counts when its token ends
// at one. A colon alone before a word a rule's value may be (nameColon) may
// be a name's instead (adafruit_io_key: k3jd….), which a keyword's rule
// needs: those rules run again on a second copy that keeps such colons, a
// finding there counting when it ends at the run after the word that
// follows one (review T5, E2).
// Gitleaks itself, and its parity, are untouched (decisions.md, #108 row 1).
// They run on a window per run, from punctMargin bytes before its word
// (however long the token: review T5) to the run, their keywords looked
// for there: each rule's keyword is in its own match (a token's prefix,
// the name before a value). When the windows are most of the text, once on
// the whole text.
func punctuated(text string, refs []span) []RuleMatch {
	var all, kept punctCopy // every run blanked; every run but a name's colon
	name := -1              // the end of the last name's colon
	for i := 1; i < len(text); i++ {
		if !wordAt(text, i-1) || strings.IndexByte(sentencePunct, text[i]) < 0 {
			continue
		}
		j := i
		for j < len(text) && strings.IndexByte(sentencePunct, text[j]) >= 0 {
			j++
		}
		if j < len(text) && !isSpace(text[j]) {
			i = j // inside a word
			continue
		}
		if ws, ok := tokenBefore(text, i, refs); ok {
			w := max(0, ws-punctMargin)
			all.add(w, i, j, true)
			switch {
			case strings.Trim(text[i:j], ":") == "" && nameColon(text, j):
				name = j
			case name >= 0 && strings.TrimRight(text[name:ws], " \t\r\n\v\f") == "":
				kept.add(w, i, j, true) // its word may be that name's value
			default:
				kept.add(w, i, j, false)
			}
		}
		i = j
	}
	if len(all.ends) == 0 {
		return nil
	}
	loadRules()
	punctOnce.Do(func() {
		for i := range compiledRules {
			r := &compiledRules[i]
			if strings.HasSuffix(r.Regex, gitleaksBoundary) && !strings.Contains(strings.ToLower(r.ID), "generic") {
				punctRules = append(punctRules, r)
				if strings.Contains(r.Regex, gitleaksSeparator) {
					namedRules = append(namedRules, r)
				}
			}
		}
	})
	out := all.find(text, punctRules)
	if len(kept.wins) > 0 {
		for _, m := range kept.find(text, namedRules) {
			if !slices.Contains(out, m) {
				out = append(out, m)
			}
		}
	}
	return out
}

// punctCopy is the runs one copy of text blanks: where a finding may end,
// and the windows the rules run on.
type punctCopy struct {
	runs [][2]int
	ends map[int]bool
	wins [][2]int
}

// add blanks the run [i, j) and, when a finding may end there (end), adds
// its window from ws.
func (c *punctCopy) add(ws, i, j int, end bool) {
	c.runs = append(c.runs, [2]int{i, j})
	if !end {
		return
	}
	if c.ends == nil {
		c.ends = map[int]bool{}
	}
	c.ends[i] = true
	if n := len(c.wins); n > 0 && ws <= c.wins[n-1][1] {
		c.wins[n-1][1] = j
	} else {
		c.wins = append(c.wins, [2]int{ws, j})
	}
}

// find runs rules over the copy's windows of text, its runs blanked.
func (c *punctCopy) find(text string, rules []*compiledRule) []RuleMatch {
	if len(c.wins) == 0 {
		return nil
	}
	b := []byte(text)
	for _, r := range c.runs {
		for k := r[0]; k < r[1]; k++ {
			b[k] = ' '
		}
	}
	wins, total := c.wins, 0
	for _, w := range wins {
		total += w[1] - w[0]
	}
	if total > len(text)/2 {
		wins = [][2]int{{0, len(text)}}
	}
	blanked := string(b)
	var out []RuleMatch
	for _, w := range wins {
		part := blanked[w[0]:w[1]]
		lower, nl := strings.ToLower(part), newlines(part)
		var fs []glFinding
		for _, r := range rules {
			if len(r.Keywords) == 0 || anyContains(lower, r.Keywords) {
				fs = r.detect(part, nl, fs)
			}
		}
		for _, f := range fs {
			if m := (RuleMatch{Rule: f.Rule, Start: f.Start + w[0], End: f.End + w[0]}); f.secret != "" && c.ends[m.End] {
				out = append(out, m)
			}
		}
	}
	return out
}

// nameColon reports a word after a colon run ending at j, past blanks,
// quotes and '=', that a rule's value may be (minPunctSecret bytes or
// more): the colon may be a name's (adafruit_io_key:\n  k3jd…).
func nameColon(text string, j int) bool {
	for j < len(text) && (isSpace(text[j]) || strings.IndexByte("`'\"=", text[j]) >= 0) {
		j++
	}
	k := j
	for k < len(text) && k-j < minPunctSecret && !isSpace(text[k]) {
		k++
	}
	return k-j >= minPunctSecret
}

// punctMargin is how far before a token-like word a rule's match may start:
// a keyword-anchored rule's name and separator (at most about 110 bytes:
// [\w.-]{0,50}? before the keyword, about 30 after it).
const punctMargin = 256

// minPunctSecret is the shortest secret a rule punctuated runs can find.
const minPunctSecret = 14

// tokenBefore is the start of the word before i when it may end a
// provider's token: at least minPunctSecret bytes with no blank, and a
// digit, an '_' or both cases (a long plain word, "internationalization.",
// is none). One that an own reference ends (refs, masked) ends no typed
// token.
func tokenBefore(text string, i int, refs []span) (int, bool) {
	s := i
	for s > 0 && !isSpace(text[s-1]) {
		s--
	}
	w := text[s:i]
	if len(w) < minPunctSecret || overlapsAny(i-1, i, refs) {
		return 0, false
	}
	return s, hasDigit(w) || strings.Contains(w, "_") || strings.ToLower(w) != w && strings.ToUpper(w) != w
}

type spanKinds struct {
	kinds   []string
	encoded bool
}

// kindsBySpan is every detector that found each exact range, sorted.
func kindsBySpan(lists ...[]span) map[[2]int]spanKinds {
	out := map[[2]int]spanKinds{}
	for _, l := range lists {
		for _, s := range l {
			k := out[[2]int{s.start, s.end}]
			if !slices.Contains(k.kinds, s.kind) {
				k.kinds = append(k.kinds, s.kind)
			}
			k.encoded = k.encoded || s.encoded
			out[[2]int{s.start, s.end}] = k
		}
	}
	for r, k := range out {
		slices.Sort(k.kinds)
		out[r] = k
	}
	return out
}

// resolve keeps candidates that never overlap (docs/decisions.md, #108): the
// same range found twice is one candidate; of overlapping ones, a span that
// is not borrowed wins (Scan), then the lower rank (a provider's exact
// format, then the structural families in rank order, which take a value's
// own boundary over Gitleaks' generic rules), then the earlier start, then
// the longer range. A span that loses keeps the parts kept says (mtext:
// text with refs masked).
func resolve(text, mtext string, spans, refs []span) []span {
	sorted := slices.Clone(spans)
	slices.SortFunc(sorted, func(a, b span) int {
		switch {
		case a.borrowed != b.borrowed:
			if a.borrowed {
				return 1
			}
			return -1
		case a.rank != b.rank:
			return a.rank - b.rank
		case a.start != b.start:
			return a.start - b.start
		default:
			return (b.end - b.start) - (a.end - a.start)
		}
	})
	var won []span
	for _, s := range sorted {
		var over []span
		dup := false
		for _, w := range won {
			if s.start == w.start && s.end == w.end {
				dup = true
				break
			}
			if s.start < w.end && w.start < s.end {
				over = append(over, w)
			}
		}
		switch {
		case dup:
		case len(over) == 0:
			won = append(won, s)
		default:
			won = append(won, kept(text, mtext, s, over, refs)...)
		}
	}
	return won
}

// valueKinds are the structural families whose span is a whole value
// (decisions.md, #108 row 3): a provider's format inside one is a part of it.
var valueKinds = map[string]bool{KindAuthHeader: true, KindAssignment: true, KindProse: true}

// kept are the parts of s, which lost to the winners over, that stay
// proposed (review S1, pass 4 and the tuning round's; the tuning round's
// class 2), each a part of s with its kinds:
//
//   - when every winner over it lends, every part no winner has. A winner
//     lends when it is borrowed (a match a reference helped), or when s is
//     a structural value that runs into a reference and the winner lies
//     inside it, its own range clear of every reference (a token, a
//     header's credential, a URL's password typed whole in the value): a
//     value that runs into a reference has every typed byte proposed;
//   - when each lends or is a provider's format inside s, a value
//     (valueKinds), only the bytes glued after such a format (in mtext,
//     text with refs masked: through a reference too): the value's rest it
//     cut short (to a blank or an escape's backslash), never a list's next
//     item, a URL's query or path (one led by , ; & / ? #), nor a
//     sentence's punctuation.
//
// Any other winner (a value's own boundary through a reference: url-query
// over prose "[…]&x=1"; a provider beside s) takes s's bytes, as rank says.
// A part is never only blanks; nor a wrapper or punctuation, unless s runs
// into a reference: then whatever it holds is proposed (outside drops a
// wrapper beside one).
func kept(text, mtext string, s span, over, refs []span) []span {
	beside := overlapsAny(s.start, s.end, refs)
	all := true
	for _, w := range over {
		inside := s.start <= w.start && w.end <= s.end
		switch {
		case w.borrowed:
		case beside && inside && s.rank > rankProvider && s.rank < rankGeneric && !overlapsAny(w.start, w.end, refs):
		case w.rank == rankProvider && valueKinds[s.kind] && inside:
			all = false
		default:
			return nil
		}
	}
	var out []span
	at := s.start
	for _, g := range append(slices.SortedFunc(slices.Values(over), func(a, b span) int { return a.start - b.start }),
		span{start: s.end, end: s.end}) {
		start, end := at, min(g.start, s.end)
		at = max(at, g.end)
		if start >= end {
			continue
		}
		cutStart, cutEnd := start != s.start, end != s.end
		if !all {
			if !cutStart || strings.IndexByte(",;&/?#\\", mtext[start]) >= 0 || isSpace(mtext[start]) {
				continue
			}
			end, cutEnd = min(end, blankAt(mtext, start)), false
			if k := strings.IndexByte(mtext[start:end], '\\'); k >= 0 {
				end = start + k
			}
		}
		for cutStart && start < end && isSpace(mtext[start]) {
			start++
		}
		for cutEnd && end > start && isSpace(mtext[end-1]) {
			end--
		}
		if strings.TrimSpace(text[start:end]) == "" || !beside &&
			(wrapper(text[start:end]) || !all && wrapper(strings.Trim(text[start:end], ".,;:"))) {
			continue
		}
		p := s
		p.start, p.end, p.whole = start, end, s.found()
		out = append(out, p)
	}
	return out
}

var escapes = regexp.MustCompile(`\\[\\"'/bfnrtu$` + "`" + `\n]|%[0-9A-Fa-f]{2}`)

// encoded reports bytes that hold a JSON or shell escape or percent-encoding.
func encoded(b string) bool { return escapes.MatchString(b) }

// referencePrefix starts every file reference the bridge writes into a
// prompt (Reference).
const referencePrefix = "[secret in file "

// Reference is the text that takes a protected range's place: the file's
// absolute path in plain words, never an @mention (an agent would read the
// file into its context). A path holds no blank and no ']'.
func Reference(path string) string { return referencePrefix + path + "]" }

var referenceRe = regexp.MustCompile(regexp.QuoteMeta(referencePrefix) + `(/[^\]\s]+)\]`)

// references are the bridge's own file references in text, sorted: the
// exact reference to a path own says is the bridge's (nil: none). A scan
// never proposes them (a sent prompt edited and sent again); text that
// only looks like one, or another path, is scanned as any other.
func references(text string, own func(path string) bool) []span {
	if own == nil {
		return nil
	}
	var out []span
	for _, m := range referenceRe.FindAllStringSubmatchIndex(text, -1) {
		if own(text[m[2]:m[3]]) {
			out = append(out, span{start: m[0], end: m[1]})
		}
	}
	return out
}

// referenceMask stands in for a reference's bytes in masked: a word (no
// blank, bracket or punctuation to end a value at) shaped like a token.
const referenceMask = "Qz7"

// masked is text with each of refs as one word of the same length, so the
// detectors' byte ranges hold for text. Its bytes may complete a shape (a
// token's length, a digit) the typed bytes lack: a shaped span that runs
// into one is borrowed (Scan).
func masked(text string, refs []span) string {
	b := []byte(text)
	for _, r := range refs {
		for i := r.start; i < r.end; i++ {
			b[i] = referenceMask[(i-r.start)%len(referenceMask)]
		}
	}
	return string(b)
}

// insideOne reports a span within one reference, short of all of it: what
// a detector read of the reference's own words (a reference as a whole
// value takes part in resolve, and is cut away after).
func insideOne(s span, refs []span) bool {
	for _, r := range refs {
		if r.start <= s.start && s.end <= r.end {
			return s.start != r.start || s.end != r.end
		}
	}
	return false
}

// clipped reports a span found as typed that a reference's own bytes cut
// short: an edge inside one, or its end at one's start (the '[' ended a
// value that runs on into the reference).
func clipped(s span, refs []span) bool {
	for _, r := range refs {
		if r.start < s.start && s.start < r.end || r.start <= s.end && s.end < r.end {
			return true
		}
	}
	return false
}

// outside cuts the spans to their bytes outside refs (sorted, apart): one
// that runs into a reference keeps each part around it, without the blanks
// at the cut, unless all a part holds is blanks and at most one quote,
// bracket or comma (a wrapper: secret=([…]) proposes nothing, while
// PASSWORD="!@#%&+=?_- […]" proposes !@#%&+=?_-); one inside a reference
// goes.
func outside(text string, spans, refs []span) []span {
	var out []span
	for _, s := range spans {
		if !overlapsAny(s.start, s.end, refs) {
			out = append(out, s)
			continue
		}
		at := s.start
		for _, r := range refs {
			if r.end <= at || r.start >= s.end {
				continue
			}
			if r.start > at {
				out = appendPart(out, text, s, at, r.start, at != s.start, true)
			}
			at = r.end
		}
		if at < s.end {
			out = appendPart(out, text, s, at, s.end, true, false)
		}
	}
	return out
}

// appendPart appends the part [start, end) of s, without the blanks at a cut
// (cutStart, cutEnd: a reference is there), unless it is a wrapper.
func appendPart(out []span, text string, s span, start, end int, cutStart, cutEnd bool) []span {
	for cutStart && start < end && isSpace(text[start]) {
		start++
	}
	for cutEnd && end > start && isSpace(text[end-1]) {
		end--
	}
	if wrapper(text[start:end]) {
		return out
	}
	s.start, s.end = start, end
	return append(out, s)
}

// wrapper reports a part of a candidate beside a reference that is no
// secret: blanks and at most one quote, bracket or comma. Anything more
// (two brackets, a symbol, a letter) may be a password, so it is proposed.
func wrapper(v string) bool {
	n := 0
	for i := 0; i < len(v); i++ {
		switch {
		case isSpace(v[i]):
		case n == 0 && strings.IndexByte("\"'`()[]{},", v[i]) >= 0:
			n++
		default:
			return false
		}
	}
	return true
}
