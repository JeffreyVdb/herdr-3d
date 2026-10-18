package promptsecret

// The generated Gitleaks rules (gitleaks_rules.go) run as Gitleaks v8.30.1's
// DetectString runs them on a fragment with no path, no commit and no
// decoding pass (detect/detect.go:276–565, the filter in detect/utils.go),
// with the standard library's regexp (Gitleaks' default build):
//
//   - a rule with keywords runs only when one of them is in the lowercased
//     text (anywhere: an Aho-Corasick prefilter, not a token match);
//   - each non-overlapping match is trimmed of LFs at both ends and matched
//     again; the secret is its secretGroup, else its first non-empty group,
//     else the trimmed match;
//   - a rule's entropy threshold must be strictly exceeded by the secret's
//     (runes counted, divided by bytes, as upstream);
//   - the global allowlists, then the rule's, drop a finding: regexes
//     (joined as upstream, tested on the secret, the match or the line) or
//     case-insensitive stopword substrings of the secret, OR or AND; a path
//     or commit criterion is false for a prompt;
//   - a finding of a rule whose id holds "generic" is dropped when a
//     non-generic rule found a secret containing it on the same line.
//
// One deliberate difference (docs/decisions.md, #108): `gitleaks:allow` on a
// line suppresses nothing, as a prompt is not a reviewed source file. And
// every finding keeps the byte range of its own occurrence (never a search
// for its text), which upstream's report does not carry.

import (
	"math"
	"regexp"
	"strings"
	"sync"
)

// glRule and glAllowlist are the generated data.
type glRule struct {
	ID          string
	Regex       string
	SecretGroup int
	Entropy     float64
	Keywords    []string
	Allowlists  []glAllowlist
}

type glAllowlist struct {
	And bool
	// PathOrCommit: the allowlist also names paths or commits, which a
	// prompt never matches (under AND it can never apply).
	PathOrCommit bool
	Target       string // "" (the secret), "match" or "line"
	Regexes      []string
	StopWords    []string
}

type compiledRule struct {
	glRule
	re    *regexp.Regexp
	allow []compiledAllowlist
}

type compiledAllowlist struct {
	glAllowlist
	re *regexp.Regexp // the regexes joined (nil: none)
}

var (
	rulesOnce      sync.Once
	compiledRules  []compiledRule
	compiledGlobal []compiledAllowlist
)

// loadRules compiles the generated rules once, on the first scan (the
// feature is off by default: nothing is compiled until it is used).
func loadRules() {
	rulesOnce.Do(func() {
		compiledGlobal = compileAllowlists(gitleaksGlobal)
		compiledRules = make([]compiledRule, len(gitleaksRules))
		for i, r := range gitleaksRules {
			compiledRules[i] = compiledRule{glRule: r, re: regexp.MustCompile(r.Regex), allow: compileAllowlists(r.Allowlists)}
		}
	})
}

func compileAllowlists(as []glAllowlist) []compiledAllowlist {
	out := make([]compiledAllowlist, len(as))
	for i, a := range as {
		out[i] = compiledAllowlist{glAllowlist: a}
		if len(a.Regexes) > 0 {
			// As config.joinRegexOr: a flag group in one pattern reaches
			// the alternatives after it, as upstream.
			out[i].re = regexp.MustCompile("(?:" + strings.Join(a.Regexes, "|") + ")")
		}
	}
	return out
}

// RuleMatch is one finding of the generated Gitleaks rules: the rule's id and
// the secret's byte range [Start, End) in the text.
type RuleMatch struct {
	Rule       string
	Start, End int
}

// glFinding is a finding before the generic filter.
type glFinding struct {
	RuleMatch
	secret    string
	startLine int
}

// Gitleaks runs the generated rules alone over text, as Gitleaks'
// DetectString would (see above): the findings, in no particular order,
// before the structural rules and before overlaps are resolved. A finding
// whose secret is empty (an empty capture group) is not returned. The parity
// check (tools/secretrules) compares this with Gitleaks itself.
func Gitleaks(text string) []RuleMatch {
	loadRules()
	lower := strings.ToLower(text)
	nl := newlines(text)
	var fs []glFinding
	for i := range compiledRules {
		r := &compiledRules[i]
		if len(r.Keywords) > 0 && !anyContains(lower, r.Keywords) {
			continue
		}
		fs = r.detect(text, nl, fs)
	}
	var out []RuleMatch
	for _, f := range fs {
		if f.secret != "" && !genericShadowed(f, fs) {
			out = append(out, f.RuleMatch)
		}
	}
	return out
}

func anyContains(s string, subs []string) bool {
	for _, k := range subs {
		if strings.Contains(s, k) {
			return true
		}
	}
	return false
}

// detect appends rule r's findings in text (detect.go detectRule).
func (r *compiledRule) detect(text string, nl [][]int, fs []glFinding) []glFinding {
	for _, m := range r.re.FindAllStringIndex(text, -1) {
		full := text[m[0]:m[1]]
		match := strings.Trim(full, "\n")
		lead := len(full) - len(strings.TrimLeft(full, "\n"))
		// Upstream keeps the start and moves the end (gitleaks#1352).
		loc := location(nl, text, m[0], m[0]+len(match))
		line := text[loc.startLineIndex:loc.endLineIndex]
		start := m[0] + lead
		secret, from, to := match, 0, len(match)
		if g := r.re.FindStringSubmatchIndex(match); len(g) >= 4 {
			if r.SecretGroup > 0 {
				if 2*r.SecretGroup+1 >= len(g) {
					continue
				}
				from, to = g[2*r.SecretGroup], g[2*r.SecretGroup+1]
				if from < 0 { // an unmatched group: upstream's secret is ""
					from, to = 0, 0
				}
				secret = match[from:to]
			} else {
				for k := 1; 2*k+1 < len(g); k++ {
					if g[2*k] >= 0 && g[2*k+1] > g[2*k] {
						from, to = g[2*k], g[2*k+1]
						secret = match[from:to]
						break
					}
				}
			}
		}
		if r.Entropy != 0 && shannonEntropy(secret) <= r.Entropy {
			continue
		}
		if allowed(compiledGlobal, secret, match, line) || allowed(r.allow, secret, match, line) {
			continue
		}
		fs = append(fs, glFinding{RuleMatch: RuleMatch{Rule: r.ID, Start: start + from, End: start + to}, secret: secret,
			startLine: loc.startLine})
	}
	return fs
}

// allowed reports whether one of the allowlists drops a finding
// (detect.go checkFindingAllowed, with no path and no commit).
func allowed(as []compiledAllowlist, secret, match, line string) bool {
	for _, a := range as {
		target := secret
		switch a.Target {
		case "match":
			target = match
		case "line":
			target = line
		}
		regex := a.re != nil && target != "" && a.re.MatchString(target)
		stop := secret != "" && len(a.StopWords) > 0 && anyContains(strings.ToLower(secret), a.StopWords)
		if a.And {
			if a.PathOrCommit {
				continue
			}
			if (len(a.Regexes) == 0 || regex) && (len(a.StopWords) == 0 || stop) {
				return true
			}
		} else if regex || stop {
			return true
		}
	}
	return false
}

// genericShadowed is upstream's filter: a generic rule's finding goes when
// another, non-generic rule found a secret containing it on the same line.
func genericShadowed(f glFinding, fs []glFinding) bool {
	if !strings.Contains(strings.ToLower(f.Rule), "generic") {
		return false
	}
	for _, p := range fs {
		if f.startLine == p.startLine && f.Rule != p.Rule && strings.Contains(p.secret, f.secret) &&
			!strings.Contains(strings.ToLower(p.Rule), "generic") {
			return true
		}
	}
	return false
}

// shannonEntropy is upstream's (detect/utils.go): the runes' frequencies
// over the length in bytes.
func shannonEntropy(data string) (entropy float64) {
	if data == "" {
		return 0
	}
	counts := make(map[rune]int)
	for _, c := range data {
		counts[c]++
	}
	inv := 1.0 / float64(len(data))
	for _, n := range counts {
		freq := float64(n) * inv
		entropy -= freq * math.Log2(freq)
	}
	return entropy
}

// newlines are the LF positions as upstream's newLineRegexp finds them.
func newlines(text string) [][]int {
	var out [][]int
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, []int{i, i + 1})
		}
	}
	return out
}

// glLocation is upstream's Location (detect/location.go).
type glLocation struct {
	startLine, endLine, startColumn, endColumn int
	startLineIndex, endLineIndex               int
}

// location is upstream's location(), quirks kept (the preceding LF is a
// line's anchor, so its Line starts with that LF; the last-line fallback),
// as the line allowlists and the generic filter read it. Then the end of the
// line is moved to the match's end when that is further (detectRule).
// Copyright (c) 2019 Zachary Rice, MIT (LICENSE-gitleaks.txt).
func location(newlineIndices [][]int, raw string, start, end int) glLocation {
	var (
		prevNewLine int
		loc         glLocation
		lineSet     bool
		lineNum     int
	)
	if len(newlineIndices) == 0 {
		newlineIndices = [][]int{{len(raw), len(raw) + 1}}
	}
	for n, pair := range newlineIndices {
		lineNum = n
		newLineByteIndex := pair[0]
		if prevNewLine <= start && start < newLineByteIndex {
			lineSet = true
			loc.startLine = n
			loc.endLine = n
			loc.startColumn = (start - prevNewLine) + 1
			loc.startLineIndex = prevNewLine
			loc.endLineIndex = newLineByteIndex
		}
		if prevNewLine < end && end <= newLineByteIndex {
			loc.endLine = n
			loc.endColumn = end - prevNewLine
			loc.endLineIndex = newLineByteIndex
		}
		prevNewLine = pair[0]
	}
	if !lineSet {
		loc.startColumn = (start - prevNewLine) + 1
		loc.endColumn = end - prevNewLine
		loc.startLine = lineNum + 1
		loc.endLine = lineNum + 1
		i := 0
		for end+i < len(raw) {
			if raw[end+i] == '\n' || raw[end+i] == '\r' {
				break
			}
			i++
		}
		loc.endLineIndex = end + i
	}
	if end > loc.endLineIndex {
		loc.endLineIndex = end
	}
	return loc
}
