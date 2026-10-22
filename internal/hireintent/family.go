package hireintent

import (
	"slices"
	"strings"
	"unicode"
)

// #190: a model said by its family ("GPT Sol", "Sol", "Opus") rather than
// its exact id or readable name. Every name is cut into words (nameTokens):
// gpt-6.1-sol and "GPT-6.1-Sol" are gpt, 6.1, sol. A model matches a name
// when every word of the name is one of the model's words, so a version said
// must be the model's version: "GPT 6 Sol" is gpt-6-sol, never gpt-6.1-sol.
// A word only counts where the user said it, outside the task: the LLM's
// words are checked against the selection (said). A near miss ("soul" for
// "sol": nearWord) is never taken as it is: the classifier confirms it
// (Select), or it is asked.

// nameTokens are the lower-case words of a name or a sentence: runs of
// letters, runs of digits with the dots between them ("6.1"); a digit run
// joins the next one across a hyphen when both are short, as ids write a
// version ("claude-haiku-5-5" is claude, haiku, 5.5; a date stays apart).
func nameTokens(s string) []string {
	var out []string
	rs := []rune(strings.ToLower(s))
	digits := func(i int) int { // the end of the digit run at i, dots between digits in it
		for i < len(rs) && (unicode.IsDigit(rs[i]) || rs[i] == '.' && i+1 < len(rs) && unicode.IsDigit(rs[i+1])) {
			i++
		}
		return i
	}
	join := false // the digit run next continues the last token's version
	for i := 0; i < len(rs); {
		switch r := rs[i]; {
		case unicode.IsLetter(r):
			j := i
			for j < len(rs) && unicode.IsLetter(rs[j]) {
				j++
			}
			out = append(out, string(rs[i:j]))
			i, join = j, false
		case unicode.IsDigit(r):
			j := digits(i)
			n := string(rs[i:j])
			if join {
				out[len(out)-1] += "." + n
			} else {
				out = append(out, n)
			}
			i = j
			// "5-5": a short number, a hyphen, a short number.
			join = false
			if short := func(n string) bool { return len(n) <= 3 && !strings.Contains(n, ".") }; short(n) && i+1 < len(rs) && rs[i] == '-' && unicode.IsDigit(rs[i+1]) {
				join = short(string(rs[i+1 : digits(i+1)]))
			}
		default:
			i++
		}
	}
	return out
}

// isNumber reports whether a token is a number (a version).
func isNumber(t string) bool { return t != "" && unicode.IsDigit([]rune(t)[0]) }

// nearWord reports whether a and b are the same word misheard: words of
// letters, three or more long, one edit apart ("soul" and "sol").
func nearWord(a, b string) bool {
	if a == b || isNumber(a) || isNumber(b) {
		return false
	}
	ra, rb := []rune(a), []rune(b)
	if len(ra) < 3 || len(rb) < 3 {
		return false
	}
	return editDistance(ra, rb) <= 1
}

// editDistance is the Levenshtein distance of a and b.
func editDistance(a, b []rune) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(a); i++ {
		cur[0] = i
		for j := 1; j <= len(b); j++ {
			cost := 1
			if a[i-1] == b[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

// fillers are words of a name the LLM may add that name nothing.
var fillers = []string{"a", "an", "the", "model", "agent", "worker"}

// harnessWords are the words that name a harness rather than a model.
var harnessWords = map[string][]string{"claude": {"claude", "code"}, "codex": {"codex"}}

// modelWords are the words of a model: its id's, its readable name's and
// its harness's.
func modelWords(cat Catalog, c Choice) []string {
	hc, _ := cat.Harness(c.Harness)
	w := append(nameTokens(c.Model), nameTokens(hc.ModelLabels[c.Model])...)
	return append(w, harnessWords[c.Harness]...)
}

// generic are the words that name no model in particular: a harness's, and
// those every model of a harness of two or more has ("claude", "gpt").
func generic(full Catalog) map[string]bool {
	out := map[string]bool{}
	for _, h := range Harnesses {
		for _, w := range harnessWords[h] {
			out[w] = true
		}
		hc, _ := full.Harness(h)
		if len(hc.Models) < 2 {
			continue
		}
		var common []string
		for i, id := range hc.Models {
			ws := modelWords(full, Choice{Harness: h, Model: id})
			if i == 0 {
				common = slices.Clone(ws)
				continue
			}
			common = slices.DeleteFunc(common, func(w string) bool { return !slices.Contains(ws, w) })
		}
		for _, w := range common {
			if !isNumber(w) {
				out[w] = true
			}
		}
	}
	return out
}

// spoken is what a name the LLM read says, checked against the selection.
type spoken struct {
	// words are the name's words said in the selection, in order: exactly
	// (strong) or as a near miss of a word there (weak).
	words []string
	weak  bool
	// whole: every word of the name was said, exactly.
	whole bool
	// alien: a word of the name that names a model (not a harness, not a
	// number, not generic) was not said at all: the LLM named something
	// the user did not.
	alien bool
}

// sayName checks name's words against the selection's (sel: its words in
// order, lower case).
func sayName(name string, sel []string, gen map[string]bool) spoken {
	var sp spoken
	sp.whole = true
	for _, w := range nameTokens(name) {
		if slices.Contains(fillers, w) {
			continue
		}
		switch {
		case slices.Contains(sel, w):
			sp.words = append(sp.words, w)
			continue
		case slices.ContainsFunc(sel, func(s string) bool { return nearWord(w, s) }):
			sp.words = append(sp.words, w)
			sp.weak = true
		case !isNumber(w) && !gen[w]:
			sp.alien = true
		}
		sp.whole = false
	}
	// A version said next to a word of the name is said too, whatever the
	// name has: "GPT 6 Sol" answered "gpt-6.1-sol" or "GPT Sol" is gpt, 6,
	// sol (an LLM that reads only the visible models normalizes to them).
	for i, s := range sel {
		if isNumber(s) || !slices.ContainsFunc(sp.words, func(w string) bool { return w == s || nearWord(w, s) }) {
			continue
		}
		for _, j := range []int{i - 1, i + 1} {
			if j >= 0 && j < len(sel) && isNumber(sel[j]) && !slices.Contains(sp.words, sel[j]) {
				sp.words = append(sp.words, sel[j])
				sp.whole = false
			}
		}
	}
	return sp
}

// hasName reports whether words has a word that names something: a word of
// letters.
func hasName(words []string) bool {
	return slices.ContainsFunc(words, func(w string) bool { return !isNumber(w) })
}

// match is how a model's words cover the words said: each said word's
// model word, ok false when one has none. near allows near misses.
func match(said, model []string, near bool) (sig string, ok bool) {
	var b strings.Builder
	for _, w := range said {
		switch {
		case slices.Contains(model, w):
			b.WriteString(w)
		case near && slices.ContainsFunc(model, func(m string) bool { return nearWord(w, m) }):
			b.WriteString(model[slices.IndexFunc(model, func(m string) bool { return nearWord(w, m) })])
		default:
			return "", false
		}
		b.WriteByte(' ')
	}
	return b.String(), true
}

// familyMatches are the models of cands whose words cover said (near: with
// near misses), with the signature of each match.
func familyMatches(cat Catalog, cands []Choice, said []string, near bool) ([]Choice, []string) {
	var out []Choice
	var sigs []string
	for _, c := range cands {
		if sig, ok := match(said, modelWords(cat, c), near); ok {
			out = append(out, c)
			sigs = append(sigs, sig)
		}
	}
	return out, sigs
}
