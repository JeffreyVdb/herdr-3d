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
)

// RulesVersion names the rule set: it is part of every revision, so a
// review made under other rules is stale.
const RulesVersion = "gitleaks-" + gitleaksVersion + "+" + "structural-1"

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
// part of a candidate; the bytes around it are scanned as usual, and a
// value that runs into one is a candidate for its bytes outside it. The
// first call compiles the rules.
func Scan(text string, own func(path string) bool) []Candidate {
	var spans []span
	for _, m := range Gitleaks(text) {
		rank := rankProvider
		if strings.Contains(strings.ToLower(m.Rule), "generic") {
			rank = rankGeneric
		}
		spans = append(spans, span{start: m.Start, end: m.End, kind: "gitleaks:" + m.Rule, rank: rank})
	}
	spans = append(spans, structural(text)...)
	refs := references(text, own)
	spans = outside(text, slices.DeleteFunc(spans, func(s span) bool { return s.start >= s.end }), refs)
	won := resolve(spans)
	more := outside(text, repeats(text, won), refs)
	won = append(won, more...)
	slices.SortFunc(won, func(a, b span) int { return a.start - b.start })
	out := make([]Candidate, 0, len(won))
	kinds := kindsBySpan(spans, more)
	for _, s := range won {
		k := kinds[[2]int{s.start, s.end}]
		out = append(out, Candidate{Start: s.start, End: s.end, Kinds: k.kinds, Encoded: k.encoded || encoded(text[s.start:s.end])})
	}
	return out
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
// same range found twice is one candidate; of overlapping ones, the lower
// rank wins (a provider's exact format, then the structural families in
// rank order, which take a value's own boundary over Gitleaks' generic
// rules), then the earlier start, then the longer range.
func resolve(spans []span) []span {
	sorted := slices.Clone(spans)
	slices.SortFunc(sorted, func(a, b span) int {
		switch {
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
		dup := false
		for _, w := range won {
			if s.start == w.start && s.end == w.end {
				dup = true
				break
			}
		}
		if !dup && !overlapsAny(s.start, s.end, won) {
			won = append(won, s)
		}
	}
	return won
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

// outside cuts the spans to their bytes outside refs (sorted, apart): one
// that runs into a reference keeps each part around it, without the blanks
// at the cut, when a letter or a digit is left in it (a bracket or a quote
// next to a reference is no secret); one inside a reference goes.
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
// (cutStart, cutEnd: a reference is there), when it holds a letter or a
// digit.
func appendPart(out []span, text string, s span, start, end int, cutStart, cutEnd bool) []span {
	for cutStart && start < end && isSpace(text[start]) {
		start++
	}
	for cutEnd && end > start && isSpace(text[end-1]) {
		end--
	}
	if v := text[start:end]; !hasLetter(v) && !hasDigit(v) {
		return out
	}
	s.start, s.end = start, end
	return append(out, s)
}
