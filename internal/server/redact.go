package server

// #106: what an operation's text loses before it leaves the bridge. A
// carrier (curl's -u, an auth header, a secret-looking assignment or long
// option, MySQL's and sshpass's -p, a URL's user) is found as written; its
// value is read as bash reads its shell word (shText): a backslash escapes
// what follows it, outside quotes and inside "…" and $'…'; '…' has no
// escapes; runs side by side are one word. A quote or a backslash left
// open (a command cut, a dialog's line cut) hides all after it. Every
// carrier is found in the text as it is, and what they all hide is hidden
// at once (replace), so one's hiding never keeps another from being found.
// The text is read once into tables (reading), so redacting costs as much
// as the text is long, however many carriers it has, and no more of it is
// read than a card could need (redactMax).

import (
	"cmp"
	"regexp"
	"slices"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/digest"
)

// shText is an operation's text read as bash reads its words: s, its lines
// joined by newlines; soft, a screen's, where a line break may be the
// screen's wrap inside a word, not a newline; cut, only the start of the
// text, so a word that reaches its end may go on. q and lq are the quote
// each byte of s is in, read from s's start and from its line's. The rest
// are tables made when a carrier first needs them.
type shText struct {
	s         string
	soft, cut bool
	q, lq     []byte
	// ends and hardEnds: where a word ends (wordEnd); cuts: where a -u
	// value's password starts (userPass).
	ends, hardEnds, cuts reading
	// skips: past the blanks between words (skip); quotes: the next quote
	// or newline (quoteOrLine).
	skips, quotes []int32
}

// shANSI is $'…' as a quote shStep reads (the others are their own quote
// characters, 0 none).
const shANSI = '$'

// redactMax is how many bytes of an operation's text are read for its card
// (#106): far more than a card shows (aboutMax runes), and the hub renders
// it itself, so a hostile command costs it little. Past them all is hidden
// (redactLines).
const redactMax = 16 << 10

func newShText(s string, soft, cut bool) *shText {
	t := &shText{s: s, soft: soft, cut: cut, q: make([]byte, len(s)+1), lq: make([]byte, len(s)+1)}
	for _, line := range []bool{false, true} {
		dst := t.q
		if line {
			dst = t.lq
		}
		var q byte
		i := 0
		for i < len(s) {
			if line && i > 0 && s[i-1] == '\n' {
				q = 0
			}
			j, next := shStep(s, i, q)
			for k := i; k < j && k < len(s); k++ {
				dst[k] = q
			}
			i, q = j, next
		}
		dst[len(s)] = q
	}
	return t
}

// shStep reads s[i] in quote q: the next index (past what a backslash
// escapes, which in "…" and $'…' too is all that finds their end) and the
// quote after it.
func shStep(s string, i int, q byte) (int, byte) {
	switch c := s[i]; {
	case c == '\\' && q != '\'':
		return i + 2, q
	case q == 0 && c == '$' && i+1 < len(s) && s[i+1] == '\'':
		return i + 2, shANSI
	case q == 0 && (c == '\'' || c == '"'):
		return i + 1, c
	case c == '\'' && (q == '\'' || q == shANSI), c == '"' && q == '"':
		return i + 1, 0
	}
	return i + 1, q
}

// shQuotes are the quotes shStep reads, at their index in a reading.
var shQuotes = [4]byte{0, '\'', '"', shANSI}

func quoteIndex(q byte) int {
	switch q {
	case '\'':
		return 1
	case '"':
		return 2
	case shANSI:
		return 3
	}
	return 0
}

// A reading is, for each quote and each byte of s, where bash's reading of
// s from that byte in that quote, step by step (shStep), first stops, and
// its quote there: at<<2 | the quote's index. Never stopped, at is len(s)
// with the quote it is left in, or len(s)+1 when its last step is past the
// end (a backslash at the end). A step's stop is the stop of where it
// leads, so one pass from s's end makes it all: s is read once, not once
// for each place a value may start. (Its places fit: s is at most
// redactMax bytes.)
type reading [4][]int32

// read is the reading that stops where stop holds (s[i], read in q).
func (t *shText) read(stop func(i int, q byte) bool) reading {
	n := len(t.s)
	var r reading
	for k := range r {
		r[k] = make([]int32, n+1)
		r[k][n] = int32(n<<2 | k)
	}
	for i := n - 1; i >= 0; i-- {
		for k, q := range shQuotes {
			j, next := shStep(t.s, i, q)
			switch {
			case stop(i, q):
				r[k][i] = int32(i<<2 | k)
			case j > n:
				r[k][i] = int32((n+1)<<2 | quoteIndex(next))
			default:
				r[k][i] = r[quoteIndex(next)][j]
			}
		}
	}
	return r
}

// at is where r, read from s[i] in quote q, stops, and its quote there.
func (r reading) at(i int, q byte) (int, byte) {
	p := r[quoteIndex(q)][i]
	return int(p >> 2), shQuotes[p&3]
}

// wordEnd is where the shell word read from s[at], in quote q, ends, and
// whether it is closed there: not when a quote or a backslash is left
// open, and then it runs to s's end, nor when it reaches the end of a cut
// text. Outside quotes a blank, ; | & or a newline ends it (on a screen
// not a newline, it may be a wrap, unless hard: a command's words are read
// so).
func (t *shText) wordEnd(at int, q byte, hard bool) (int, bool) {
	soft, r := t.soft && !hard, &t.hardEnds
	if soft {
		r = &t.ends
	}
	if r[0] == nil {
		*r = t.read(func(i int, q byte) bool {
			c := t.s[i]
			return q == 0 && (c == ' ' || c == '\t' || c == ';' || c == '|' || c == '&' || c == '\n' && !soft)
		})
	}
	end, eq := r.at(at, q)
	if end > len(t.s) {
		return len(t.s), false
	}
	return end, end < len(t.s) || eq == 0 && !t.cut
}

// A value is a carrier's, read from s[at] to end: the rest of the shell
// word at is in, read from the text's start and from its line's (a quote
// above it may be no shell's: prose, a heredoc), the farther; s's end if
// either leaves a quote or a backslash open (open). q is the quote it
// starts in, by the reading that ends farther.
type value struct {
	at, end int
	q       byte
	open    bool
}

func (t *shText) value(at int) value {
	v := value{at: at, end: -1}
	for _, q := range [2]byte{t.q[at], t.lq[at]} {
		if end, ok := t.wordEnd(at, q, false); end > v.end || !ok && !v.open {
			v.end, v.q, v.open = end, q, !ok
		}
	}
	return v
}

// hide is v hidden, the quote it starts in closed.
func (t *shText) hide(v value) hiding {
	return hiding{v.at, v.end, closing(v.q)}
}

// hidden is what a secret's text s becomes: [key], one on each line it is
// on.
func hidden(s string) string { return "[key]" + strings.Repeat("\n[key]", strings.Count(s, "\n")) }

// closing is what closes quote q.
func closing(q byte) string {
	switch q {
	case 0:
		return ""
	case shANSI:
		return "'"
	}
	return string(q)
}

// skip is where the next word, or the command's end, is from s[i]: past
// blanks (on a screen newlines too: the command may wrap, and a line's
// start is a word's) and a backslash and a newline (they go on to the
// next line).
func (t *shText) skip(i int) int {
	if t.skips == nil {
		n := len(t.s)
		t.skips = make([]int32, n+1)
		t.skips[n] = int32(n)
		for j := n - 1; j >= 0; j-- {
			switch c := t.s[j]; {
			case c == ' ' || c == '\t' || c == '\n' && t.soft:
				t.skips[j] = t.skips[j+1]
			case c == '\\' && j+1 < n && t.s[j+1] == '\n':
				t.skips[j] = t.skips[j+2]
			default:
				t.skips[j] = int32(j)
			}
		}
	}
	return int(t.skips[i])
}

// quoteOrLine is where the first quote or newline from s[at] is, s's end
// if none.
func (t *shText) quoteOrLine(at int) int {
	if t.quotes == nil {
		n := len(t.s)
		t.quotes = make([]int32, n+1)
		t.quotes[n] = int32(n)
		for i := n - 1; i >= 0; i-- {
			t.quotes[i] = t.quotes[i+1]
			if c := t.s[i]; c == '\'' || c == '"' || c == '\n' {
				t.quotes[i] = int32(i)
			}
		}
	}
	return int(t.quotes[at])
}

// A hiding is a span of the text a carrier's value hides, and what closes
// the quote the span starts in (the hidden text may have closed it).
type hiding struct {
	from, to int
	close    string
}

// replace is s with what hs hide hidden: each run of hidings that overlap
// one span, the quote its first starts in closed after it. What any of
// them hides is hidden, so a carrier inside another's value hides no less.
func (t *shText) replace(hs []hiding) string {
	slices.SortFunc(hs, func(a, b hiding) int { return cmp.Or(cmp.Compare(a.from, b.from), cmp.Compare(b.to, a.to)) })
	var b strings.Builder
	last := 0
	for i := 0; i < len(hs); {
		h := hs[i]
		for i++; i < len(hs) && hs[i].from < h.to; i++ {
			h.to = max(h.to, hs[i].to)
		}
		b.WriteString(t.s[last:h.from])
		b.WriteString(hidden(t.s[h.from:h.to]))
		b.WriteString(h.close)
		last = h.to
	}
	return b.String() + t.s[last:]
}

// redactions are the carriers, each its hidings of the text as it is
// (TestRedactLine, TestRedactLineQuoted, TestRedactLineEscaped,
// TestRedactLines, TestRedactLinesCarrierAfterCarrier,
// TestCardMenuPasswordShellWords, TestCardMenuPasswordPairs). Each match
// costs the same however long its value: what it reads is in tables.
var redactions = []func(*shText) []hiding{
	// A password given to curl and the like: -u user:password, --user,
	// --proxy-user (and -U), all after the first colon.
	after(regexp.MustCompile(`(?i)(?:^|[\s;|&(])(?:-u|--user|-U|--proxy-user)(?:\s+|=)?`), func(t *shText, _ []int, v value) (hiding, bool) {
		return t.userPass(v)
	}),
	// An auth header's value: all of it, on through its line to a quote too
	// (a JSON key's closing quote may come before its colon).
	after(regexp.MustCompile(`(?i)\b(?:(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|private-token|cookie)(?:\\?["'])?\s*:\s*`), func(t *shText, _ []int, v value) (hiding, bool) {
		v.end = max(v.end, t.quoteOrLine(v.at))
		return t.hide(v), v.end > v.at
	}),
	// A secret-looking assignment's value (a JSON key's too).
	after(regexp.MustCompile(`(?i)\b[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?|auth)(?:\\?["'])?\s*[=:]\s*`), func(t *shText, _ []int, v value) (hiding, bool) {
		return t.hide(v), v.end > v.at
	}),
	// A secret-looking long option's value (after a blank, an option is
	// none).
	after(regexp.MustCompile(`(?i)--[a-z0-9-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?)(\s+|=)`), func(t *shText, m []int, v value) (hiding, bool) {
		return t.hide(v), v.end > v.at && (t.s[m[2]] == '=' || t.s[v.at] != '-')
	}),
	passOption(regexp.MustCompile(`(?i)\b(?:mysql|mysqldump|mysqladmin|mariadb)\b`), false),
	passOption(regexp.MustCompile(`(?i)\bsshpass\b`), true),
	// A URL's password: up to the last @ before its host's end (all of it
	// when that end is not shown and a quote or a backslash is left open).
	// What it reads ends at the first / after it, which the next URL's ://
	// has: no byte is read for two.
	after(regexp.MustCompile(`://[^/\s:@]+:`), func(t *shText, _ []int, v value) (hiding, bool) {
		end, host := passwordEnd(t.s[v.at:v.end], v.q)
		switch {
		case v.open && !host:
			return t.hide(v), v.end > v.at
		case end <= 0:
			return hiding{}, false
		case v.at+end < v.end:
			return hiding{v.at, v.at + end, ""}, true
		}
		return t.hide(v), true
	}),
}

// after is a carrier whose value is read after each match of re; keep is
// its hiding, if any.
func after(re *regexp.Regexp, keep func(t *shText, m []int, v value) (hiding, bool)) func(*shText) []hiding {
	return func(t *shText) []hiding {
		var out []hiding
		for _, m := range re.FindAllStringSubmatchIndex(t.s, -1) {
			if h, ok := keep(t, m, t.value(m[1])); ok {
				out = append(out, h)
			}
		}
		return out
	}
}

// passOption is a command's -p (MySQL's, sshpass's: a word of the command
// re names, each word as bash reads it, so none inside another's quotes, a
// -P none): its password the rest of its word, or with next, for a -p
// alone, the word after it. A name's words are read on to its command's
// end, or to a word another name's reading came to: from there on they
// are the same words, already read, so each word is read once.
func passOption(re *regexp.Regexp, next bool) func(*shText) []hiding {
	return func(t *shText) []hiding {
		var out []hiding
		hide := func(at int) {
			if v := t.value(at); v.end > v.at {
				out = append(out, t.hide(v))
			}
		}
		var seen []bool
		for _, m := range re.FindAllStringIndex(t.s, -1) {
			if seen == nil {
				seen = make([]bool, len(t.s))
			}
			alone := -1 // the end of a -p alone: its password is the next word's
			for i := t.skip(m[1]); ; {
				if i == len(t.s) || strings.IndexByte("\n;|&", t.s[i]) >= 0 {
					if alone >= 0 {
						hide(alone)
					}
					break
				}
				if alone >= 0 {
					hide(i)
					alone = -1
				}
				if seen[i] {
					break
				}
				seen[i] = true
				end, _ := t.wordEnd(i, 0, true)
				if strings.HasPrefix(t.s[i:], "-p") {
					if next && i+2 == end {
						alone = end
					} else {
						hide(i + 2)
					}
				}
				i = t.skip(end)
			}
		}
		return out
	}
}

// userPass is a -u user:password value v without its password: all after
// its first colon (escaped or not) hidden, the quote that colon is in
// closed. In $'…' a backslash may write a colon, so the password may
// start there. ok false: no colon, a user only.
func (t *shText) userPass(v value) (hiding, bool) {
	if t.cuts[0] == nil {
		t.cuts = t.read(func(i int, q byte) bool {
			return t.s[i] == ':' || t.s[i] == '\\' && (q == shANSI || i+1 < len(t.s) && t.s[i+1] == ':')
		})
	}
	i, q := t.cuts.at(v.at, v.q)
	if i >= v.end {
		return hiding{}, false
	}
	cut := i + 1
	switch {
	case t.s[i] == '\\' && q == shANSI:
		cut = i
	case t.s[i] == '\\':
		cut = i + 2
	}
	return hiding{cut, v.end, closing(q)}, true
}

// passwordEnd is where a URL's password ends in w, the rest of its word
// read from quote q, as a URL is read: at the last @ (escaped or not)
// before its host's end, the first / ? or #; at that end when a backslash
// in $'…', which may write an @, follows the @; -1: no @ (a port). host:
// that end is in w.
func passwordEnd(w string, q byte) (end int, host bool) {
	at, esc := -1, -1
	for i := 0; i < len(w) && !host; {
		next, nq := shStep(w, i, q)
		for k := i; k < next && k < len(w); k++ {
			switch c := w[k]; {
			case c == '/' || c == '?' || c == '#':
				end, host = k, true
			case c == '@' && !host:
				at = k
			case c == '\\' && q == shANSI && !host:
				esc = k
			}
		}
		i, q = next, nq
	}
	if !host {
		end = len(w)
	}
	if esc <= at {
		end = at
	}
	return end, host
}

// redactLine is a line of an operation as it may leave the bridge: what
// looks like a secret removed, no control character.
func redactLine(s string) string { return redactLines([]string{s}, false)[0] }

// redactLines are an operation's lines (soft: a screen's, else a command's)
// as they may leave the bridge, read together as one text: a password's
// shell word goes on over a line break inside quotes or after a backslash
// (and on a screen, a word at a line's end goes on: the break may be a
// wrap), and each line of it is hidden; the lines stay as many. Then each
// is scrubbed (digest.Scrub). No control character is left. Only their
// first redactMax bytes are read: the lines after are [key], the word
// that goes past them is hidden (a token Scrub would know whole), and so
// is a value that reaches them, to them, as one left open
// (TestRedactLinesBounded).
func redactLines(lines []string, soft bool) []string {
	if len(lines) == 0 {
		return nil
	}
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = plainLine(l)
	}
	s, cut := strings.Join(plain, "\n"), false
	if len(s) > redactMax {
		s, cut = s[:redactMax], true
	}
	out := strings.Split(redactText(s, soft, cut), "\n")
	for i := range out {
		out[i] = digest.Scrub(out[i])
	}
	for len(out) < len(lines) {
		out = append(out, "[key]")
	}
	return out
}

// redactText is s, an operation's text (soft: a screen's), with what its
// carriers hide hidden; cut: s is only the text's start, so its last word,
// which may go on, is hidden too.
func redactText(s string, soft, cut bool) string {
	t := newShText(s, soft, cut)
	var hs []hiding
	for _, r := range redactions {
		hs = append(hs, r(t)...)
	}
	if cut {
		hs = append(hs, hiding{strings.LastIndexAny(s, " \t\n") + 1, len(s), ""})
	}
	return t.replace(hs)
}
