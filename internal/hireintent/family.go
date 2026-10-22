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
// words are checked against the selection (sayName), and the words the user
// said with them are added (sayAround), so a word the LLM left out or
// "normalized" still has to agree ("GPT Banana" answered "GPT", "GPT six
// Sol" answered gpt-6.1-sol: asked). A brand alone ("Codex", "GPT") names no
// model. A near miss ("soul" for "sol": nearWord) is never taken as it is:
// the classifier confirms it (Select), or it is asked.

// nameTokens are the lower-case words of a name or a sentence: runs of
// letters, runs of digits with the dots between them ("6.1"); a digit run
// joins the next one across a hyphen when both are short, as ids write a
// version ("claude-haiku-5-5" is claude, haiku, 5.5; a date stays apart).
func nameTokens(s string) []string {
	var out []string
	for _, t := range tokens(s) {
		out = append(out, t.w)
	}
	return out
}

// token is a word of a sentence (nameTokens): lower case, its runes
// [at, end) in the sentence, and brk when a clause ends before it (see
// clauseBreak).
type token struct {
	w       string
	at, end int
	brk     bool
}

// clauseBreak reports whether r ends a clause: a model's words never run
// across it. A full stop counts before a space or the end ("Sol. Then",
// not "6.1").
func clauseBreak(rs []rune, i int) bool {
	switch rs[i] {
	case ',', ';', ':', '!', '?', '\n', '(', ')':
		return true
	case '.':
		return i+1 == len(rs) || unicode.IsSpace(rs[i+1])
	}
	return false
}

// tokens are s's words (nameTokens) with where they are.
func tokens(s string) []token {
	var out []token
	rs := []rune(s)
	digits := func(i int) int { // the end of the digit run at i, dots between digits in it
		for i < len(rs) && (unicode.IsDigit(rs[i]) || rs[i] == '.' && i+1 < len(rs) && unicode.IsDigit(rs[i+1])) {
			i++
		}
		return i
	}
	join := false // the digit run next continues the last token's version
	brk := false
	for i := 0; i < len(rs); {
		switch r := rs[i]; {
		case unicode.IsLetter(r):
			j := i
			for j < len(rs) && unicode.IsLetter(rs[j]) {
				j++
			}
			out = append(out, token{w: strings.ToLower(string(rs[i:j])), at: i, end: j, brk: brk})
			i, join, brk = j, false, false
		case unicode.IsDigit(r):
			j := digits(i)
			n := string(rs[i:j])
			if join {
				out[len(out)-1].w += "." + n
				out[len(out)-1].end = j
			} else {
				out = append(out, token{w: n, at: i, end: j, brk: brk})
			}
			i, brk = j, false
			// "5-5": a short number, a hyphen, a short number.
			join = false
			if short := func(n string) bool { return len(n) <= 3 && !strings.Contains(n, ".") }; short(n) && i+1 < len(rs) && rs[i] == '-' && unicode.IsDigit(rs[i+1]) {
				join = short(string(rs[i+1 : digits(i+1)]))
			}
		default:
			brk = brk || clauseBreak(rs, i)
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
	// (strong) or as a near miss of a word there (weak); then the words
	// the user said with them that the name left out (sayAround).
	words []string
	weak  bool
	// whole: every word of the name was said, exactly, and nothing more.
	whole bool
	// alien: a word of the name that names a model (not a harness, not a
	// number, not generic) was not said at all: the LLM named something
	// the user did not.
	alien bool
	// unknown: a word said with the name's that names no model ("GPT
	// Banana", "GPT six Sol"): asked, never left out.
	unknown bool
	// said are the user's words for the model when they say more than the
	// name ("" else).
	said string
}

// sayName checks name's words against the selection's (sel: its words in
// order, lower case).
func sayName(name string, sel []string, gen map[string]bool) spoken {
	var sp spoken
	sp.whole = true
	for _, w := range nameWords(name) {
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
	return sp
}

// nameWords are a name's words without fillers.
func nameWords(name string) []string {
	return slices.DeleteFunc(nameTokens(name), func(w string) bool { return slices.Contains(fillers, w) })
}

// glue are the words a sentence puts around a model's name that name
// nothing: a model's words run between them ("a GPT Sol agent", "on Haiku
// 5.5 with"). The harnesses' words and the effort levels are glue too.
var glue = []string{
	"a", "an", "the", "this", "that", "another", "new", "some", "my", "your", "me", "i", "you", "we", "us", "it", "its",
	"please", "hire", "spawn", "start", "launch", "create", "make", "get", "give", "use", "using", "run", "running", "runs",
	"delegate", "assign", "put", "set", "let", "lets", "want", "need", "can", "could", "would", "will", "should", "is", "be",
	"with", "on", "at", "to", "for", "in", "of", "by", "via", "from", "and", "or", "but", "then", "also", "as", "so", "now",
	"maybe", "not", "no", "just", "actually", "instead", "rather", "than", "here", "there", "task",
	"model", "models", "agent", "agents", "worker", "workers", "instance", "session", "harness",
	"effort", "reasoning", "thinking", "level", "extra", "x",
}

// spelled are words that say how a version is written, not which: a
// model's words run across them, and they name nothing themselves.
var spelled = []string{"version", "point", "dot", "v"}

// numberWords are numbers said in words: a version said so is never
// matched ("GPT six point one Sol" is asked), so it is never left out.
// "one" is a number only next to another, or to "point": else it is glue
// ("spawn one GPT Sol agent", "the Sol one").
var numberWords = []string{"zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
	"eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
	"thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety", "hundred"}

// isGlue reports whether toks[i] is glue (see glue, numberWords), its
// clause running from cs to ce.
func isGlue(stop map[string]bool, toks []token, i, cs, ce int) bool {
	if toks[i].w != "one" {
		return stop[toks[i].w]
	}
	for _, j := range []int{i - 1, i + 1} {
		if j >= cs && j < ce && (isNumber(toks[j].w) || toks[j].w != "one" && slices.Contains(numberWords, toks[j].w) || slices.Contains(spelled, toks[j].w)) {
			return false
		}
	}
	return true
}

// sayAround adds to sp what the user said with the name: the words between
// and around the name's in one clause of the latest part of the selection
// that has them (parts: the sources without the task), up to glue. A
// number or a word of a model of the catalog joins the words (a version
// said must be the model's, "GPT 6 Sol" answered "GPT Sol"); a near miss
// of one joins as weak; any other word is unknown. The name's words that
// are glue (a harness's) do not place it.
func (sc scope) sayAround(sp *spoken, name string, parts []string) {
	nw := nameWords(name)
	anchor := func(w string) bool {
		return slices.ContainsFunc(nw, func(n string) bool { return n == w || nearWord(n, w) })
	}
	stop := sc.glueWords()
	seed := func(w string) bool { return anchor(w) && !stop[w] }
	var vocab []string
	for _, c := range choices(sc.full, "") {
		vocab = append(vocab, modelWords(sc.full, c)...)
	}
	for p := len(parts) - 1; p >= 0; p-- {
		toks := tokens(parts[p])
		if !slices.ContainsFunc(toks, func(t token) bool { return seed(t.w) }) {
			continue
		}
		rs := []rune(parts[p])
		for cs := 0; cs < len(toks); {
			ce := cs + 1
			for ce < len(toks) && !toks[ce].brk {
				ce++
			}
			lo, hi := -1, -1
			for i := cs; i < ce; i++ {
				if seed(toks[i].w) {
					if lo < 0 {
						lo = i
					}
					hi = i
				}
			}
			if lo >= 0 {
				for lo > cs && !isGlue(stop, toks, lo-1, cs, ce) {
					lo--
				}
				for hi < ce-1 && !isGlue(stop, toks, hi+1, cs, ce) {
					hi++
				}
				extra := false
				for i := lo; i <= hi; i++ {
					w := toks[i].w
					if isGlue(stop, toks, i, cs, ce) || anchor(w) || slices.Contains(spelled, w) {
						continue
					}
					extra = true
					switch {
					case isNumber(w) || slices.Contains(vocab, w):
					case slices.ContainsFunc(vocab, func(v string) bool { return nearWord(w, v) }):
						sp.weak = true
					default:
						sp.unknown = true
						continue
					}
					if !slices.Contains(sp.words, w) {
						sp.words = append(sp.words, w)
					}
				}
				if extra {
					sp.whole = false
					if sp.said == "" {
						sp.said = string(rs[toks[lo].at:toks[hi].end])
					}
				}
			}
			cs = ce
		}
		return
	}
}

// glueWords are glue, the harnesses' words and every effort level of the
// catalog and its spoken forms.
func (sc scope) glueWords() map[string]bool {
	out := map[string]bool{}
	for _, w := range glue {
		out[w] = true
	}
	for _, h := range Harnesses {
		for _, w := range harnessWords[h] {
			out[w] = true
		}
		hc, _ := sc.full.Harness(h)
		for _, l := range hc.Efforts {
			out[l] = true
		}
		for _, ls := range hc.ExtraEfforts {
			for _, l := range ls {
				out[l] = true
			}
		}
	}
	for l, ws := range effortWords {
		out[l] = true
		for _, w := range ws {
			for _, t := range nameTokens(w) {
				out[t] = true
			}
		}
	}
	return out
}

// brands are the words that name a harness rather than a model: its own
// ("codex", "claude", "code"), and the first word of every model id of a
// harness of two or more ("gpt" of gpt-6.1-sol and gpt-6-luna).
func brands(full Catalog) map[string]bool {
	out := map[string]bool{}
	for _, h := range Harnesses {
		for _, w := range harnessWords[h] {
			out[w] = true
		}
		hc, _ := full.Harness(h)
		if len(hc.Models) < 2 {
			continue
		}
		first := func(id string) string { return append(nameTokens(id), "")[0] }
		if b := first(hc.Models[0]); b != "" && !isNumber(b) && !slices.ContainsFunc(hc.Models, func(id string) bool { return first(id) != b }) {
			out[b] = true
		}
	}
	return out
}

// hasName reports whether words has a word that names a model: one that
// is not a brand ("Codex", "Claude Code", "GPT" where every Codex model is
// a GPT, name none).
func hasName(words []string, brand map[string]bool) bool {
	return slices.ContainsFunc(words, func(w string) bool { return !brand[w] })
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
