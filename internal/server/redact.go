package server

// #106: what an operation's text loses before it leaves the bridge. A
// carrier (curl's -u, an auth header, a secret-looking assignment or long
// option, MySQL's and sshpass's -p, a URL's user) is found as written; its
// value is read as bash reads its shell word (shText): a backslash escapes
// what follows it, outside quotes and inside "…" and $'…'; '…' has no
// escapes; runs side by side are one word. A quote or a backslash left
// open (a command cut, a dialog's line cut) hides all after it.

import (
	"regexp"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/digest"
)

// shText is an operation's text read as bash reads its words: s, its lines
// joined by newlines; soft, a screen's, where a line break may be the
// screen's wrap inside a word, not a newline. q and lq are the quote each
// byte of s is in, read from s's start and from its line's.
type shText struct {
	s     string
	soft  bool
	q, lq []byte
}

// shANSI is $'…' as a quote shStep reads (the others are their own quote
// characters, 0 none).
const shANSI = '$'

func newShText(s string, soft bool) shText {
	t := shText{s: s, soft: soft, q: make([]byte, len(s)+1), lq: make([]byte, len(s)+1)}
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

// wordEnd is where the shell word read from s[at], in quote q, ends, and
// whether it is closed there: not when a quote or a backslash is left
// open, and then it runs to s's end. Outside quotes a blank, ; | & or a
// newline ends it (on a screen not a newline: it may be a wrap).
func (t shText) wordEnd(at int, q byte) (int, bool) {
	i := at
	for i < len(t.s) {
		if c := t.s[i]; q == 0 && (c == ' ' || c == '\t' || c == ';' || c == '|' || c == '&' || c == '\n' && !t.soft) {
			return i, true
		}
		i, q = shStep(t.s, i, q)
	}
	return len(t.s), i == len(t.s) && q == 0
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

func (t shText) value(at int) value {
	v := value{at: at, end: -1}
	for _, q := range []byte{t.q[at], t.lq[at]} {
		if end, ok := t.wordEnd(at, q); end > v.end || !ok && !v.open {
			v.end, v.q, v.open = end, q, !ok
		}
	}
	return v
}

// hide is v hidden, the quote it starts in closed.
func (t shText) hide(v value) hiding {
	return hiding{v.at, v.end, hidden(t.s[v.at:v.end]) + closing(v.q)}
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

// words are where the shell words of the command from s[at] start and end
// (outside quotes), up to its end: ; | & or a newline outside quotes (on a
// screen not a newline: the command may wrap, and a line's start is a
// word's). A backslash and a newline between words go on to the next line.
func (t shText) words(at int) [][2]int {
	hard := shText{s: t.s}
	var out [][2]int
	for i := at; i < len(t.s); {
		switch c := t.s[i]; {
		case c == ' ' || c == '\t' || c == '\n' && t.soft:
			i++
		case c == '\\' && i+1 < len(t.s) && t.s[i+1] == '\n':
			i += 2
		case c == '\n' || c == ';' || c == '|' || c == '&':
			return out
		default:
			end, _ := hard.wordEnd(i, 0)
			out = append(out, [2]int{i, end})
			i = end
		}
	}
	return out
}

// A hiding is a span of the text a redaction replaces, and with what.
type hiding struct {
	from, to int
	with     string
}

// replace is s with each of hs (in order) replaced, one that overlaps
// the one before left out.
func (t shText) replace(hs []hiding) string {
	var b strings.Builder
	last := 0
	for _, sp := range hs {
		if sp.from < last {
			continue
		}
		b.WriteString(t.s[last:sp.from] + sp.with)
		last = sp.to
	}
	return b.String() + t.s[last:]
}

// redactions are the carriers, in turn, each its hidings of the text
// (TestRedactLine, TestRedactLineQuoted, TestRedactLineEscaped,
// TestRedactLines, TestCardMenuPasswordShellWords).
var redactions = []func(shText) []hiding{
	// A password given to curl and the like: -u user:password, --user,
	// --proxy-user (and -U), all after the first colon.
	after(regexp.MustCompile(`(?i)(?:^|[\s;|&(])(?:-u|--user|-U|--proxy-user)(?:\s+|=)?`), func(t shText, _ []int, v value) (hiding, bool) {
		with, ok := userPass(t.s[v.at:v.end], v.q)
		return hiding{v.at, v.end, with}, ok
	}),
	// An auth header's value: all of it, on through its line to a quote too
	// (a JSON key's closing quote may come before its colon).
	after(regexp.MustCompile(`(?i)\b(?:(?:proxy-)?authorization|x-api-key|api-key|x-auth-token|private-token|cookie)(?:\\?["'])?\s*:\s*`), func(t shText, _ []int, v value) (hiding, bool) {
		if i := strings.IndexAny(t.s[v.at:], "'\"\n"); i < 0 {
			v.end = len(t.s)
		} else {
			v.end = max(v.end, v.at+i)
		}
		return t.hide(v), v.end > v.at
	}),
	// A secret-looking assignment's value (a JSON key's too).
	after(regexp.MustCompile(`(?i)\b[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?|auth)(?:\\?["'])?\s*[=:]\s*`), func(t shText, _ []int, v value) (hiding, bool) {
		return t.hide(v), v.end > v.at
	}),
	// A secret-looking long option's value (after a blank, an option is
	// none).
	after(regexp.MustCompile(`(?i)--[a-z0-9-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?)(\s+|=)`), func(t shText, m []int, v value) (hiding, bool) {
		return t.hide(v), v.end > v.at && (t.s[m[2]] == '=' || t.s[v.at] != '-')
	}),
	passOption(regexp.MustCompile(`(?i)\b(?:mysql|mysqldump|mysqladmin|mariadb)\b`), false),
	passOption(regexp.MustCompile(`(?i)\bsshpass\b`), true),
	// A URL's password: up to the last @ before its host's end (all of it
	// when that end is not shown and a quote or a backslash is left open).
	after(regexp.MustCompile(`://[^/\s:@]+:`), func(t shText, _ []int, v value) (hiding, bool) {
		end, host := passwordEnd(t.s[v.at:v.end], v.q)
		switch {
		case v.open && !host:
			return t.hide(v), v.end > v.at
		case end <= 0:
			return hiding{}, false
		case v.at+end < v.end:
			return hiding{v.at, v.at + end, hidden(t.s[v.at : v.at+end])}, true
		}
		return t.hide(v), true
	}),
}

// after is a carrier whose value is read after each match of re; keep is
// its hiding, if any. A match inside the hiding before it is none.
func after(re *regexp.Regexp, keep func(t shText, m []int, v value) (hiding, bool)) func(shText) []hiding {
	return func(t shText) []hiding {
		var out []hiding
		last := 0
		for _, m := range re.FindAllStringSubmatchIndex(t.s, -1) {
			if m[0] < last {
				continue
			}
			if sp, ok := keep(t, m, t.value(m[1])); ok {
				out, last = append(out, sp), sp.to
			}
		}
		return out
	}
}

// passOption is a command's -p (MySQL's, sshpass's: a word of the command
// re names, each word as bash reads it, so none inside another's quotes, a
// -P none): its password the rest of its word, or with next, for a -p
// alone, the word after it.
func passOption(re *regexp.Regexp, next bool) func(shText) []hiding {
	return func(t shText) []hiding {
		var out []hiding
		last := 0
		for _, m := range re.FindAllStringIndex(t.s, -1) {
			words := t.words(m[1])
			for k, w := range words {
				if w[0] < last || !strings.HasPrefix(t.s[w[0]:], "-p") {
					continue
				}
				at := w[0] + 2
				if next && at == w[1] && k+1 < len(words) {
					at = words[k+1][0]
				}
				if v := t.value(at); v.end > v.at {
					out, last = append(out, t.hide(v)), v.end
				}
			}
		}
		return out
	}
}

// userPass is a -u user:password value w, read from quote q, without its
// password: all after its first colon (escaped or not) hidden, the quote
// that colon is in closed. In $'…' a backslash may write a colon, so the
// password may start there. ok false: no colon, a user only.
func userPass(w string, q byte) (string, bool) {
	for i := 0; i < len(w); {
		cut := -1
		switch {
		case w[i] == ':':
			cut = i + 1
		case w[i] == '\\' && q == shANSI:
			cut = i
		case w[i] == '\\' && i+1 < len(w) && w[i+1] == ':':
			cut = i + 2
		}
		if cut >= 0 {
			return w[:cut] + hidden(w[cut:]) + closing(q), true
		}
		i, q = shStep(w, i, q)
	}
	return "", false
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
// is scrubbed (digest.Scrub). No control character is left.
func redactLines(lines []string, soft bool) []string {
	if len(lines) == 0 {
		return nil
	}
	plain := make([]string, len(lines))
	for i, l := range lines {
		plain[i] = plainLine(l)
	}
	s := strings.Join(plain, "\n")
	for _, r := range redactions {
		t := newShText(s, soft)
		s = t.replace(r(t))
	}
	out := strings.Split(s, "\n")
	for i := range out {
		out[i] = digest.Scrub(out[i])
	}
	return out
}
