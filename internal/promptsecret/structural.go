package promptsecret

// The structural rules (#108): candidates the Gitleaks rules miss, each at
// its value's exact bytes as typed (docs/decisions.md, the byte contract per
// syntax). They are this repository's own, not the research probe's:
//
//   - pem: a PEM private key block, BEGIN to END line, newlines kept;
//   - auth-header: an Authorization (or Proxy-Authorization) header's
//     credentials after its scheme (Bearer, Basic as typed, Token, …), and a
//     bare long "Bearer <token>": to the next blank or quote, symbols kept;
//   - url-password: the password of a URL's userinfo, percent-encoding kept;
//   - url-query: the value of a credential-named query (or form) parameter;
//   - assignment: env, shell (export), YAML, JSON, TOML, INI, CLI flags and
//     code: a credential-like name (password, passwd, pwd, secret, token,
//     api_key, access_key, private_key, client_secret, auth, …) and its
//     value: the bytes inside the quotes, or an unquoted value; and curl's
//     -u user:password: the password, never what the shell computes;
//   - yaml-block: a YAML block scalar (| or >) under such a name;
//   - prose: "the password is X", "API key: X", "the secret X", in a few
//     languages, a quoted value a few words after the word, its subject
//     ("the password used by the job is «X»"), and a line of one value a
//     later sentence names ("The preceding line is the actual password.");
//     and fenced: a code fence of one value after a line that names a
//     credential and ends in a colon;
//   - repeat: another exact occurrence of a value found above (one with a
//     digit, a symbol or 16 bytes), each its own candidate.
//
// Never a candidate: a template or reference (${X}, $X, {{ … }}, <your-token>,
// %X%, os.getenv("X"), process.env.X, a dotted name in code), a redaction
// (****, REDACTED, xxxx), a name without a value, a path, the bridge's own
// file reference (exactly: Scan). An unquoted value loses trailing sentence punctuation
// (. , ; : and an unbalanced closing bracket or quote); a quoted one keeps
// every byte between its quotes. A weak password is a candidate when it is
// plainly the value assigned (password=example).

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Kinds of the structural candidates.
const (
	KindPEM         = "pem"
	KindAuthHeader  = "auth-header"
	KindURLPassword = "url-password"
	KindURLQuery    = "url-query"
	KindAssignment  = "assignment"
	KindYAMLBlock   = "yaml-block"
	KindProse       = "prose"
	KindFenced      = "fenced"
	KindRepeat      = "repeat"
)

// span is one detector's candidate, before overlaps are resolved: lower
// rank wins an overlap (resolve).
type span struct {
	start, end int
	kind       string
	rank       int
	encoded    bool   // stored as typed: a YAML block's indented lines
	shaped     bool   // found for its value's shape (a token format, a length, a digit), not only its place
	borrowed   bool   // owes its match to a reference: ranks after every other (Scan)
	whole      [2]int // a part resolve kept of a losing span: the range that span was found at
}

// found is the range a detector found s at (a part's whole's).
func (s span) found() [2]int {
	if s.whole != [2]int{} {
		return s.whole
	}
	return [2]int{s.start, s.end}
}

// Ranks: a provider's exact format, then the structural families in this
// order, then Gitleaks' generic rules, then repeats.
const (
	rankProvider = iota
	rankPEM
	rankAuthHeader
	rankURLPassword
	rankURLQuery
	rankAssignment
	rankYAMLBlock
	rankProse
	rankFenced
	rankGeneric
	rankRepeat
)

// structural are the structural rules' spans in text; refs are the own
// references masked in it (Scan; nil as typed): a value that runs into one
// is a value, never code (notASecret).
func structural(text string, refs []span) []span {
	lower := strings.ToLower(text)
	var out []span
	out = append(out, pemSpans(text)...)
	out = append(out, headerSpans(text, lower, refs)...)
	out = append(out, urlSpans(text, refs)...)
	out = append(out, assignmentSpans(text, refs)...)
	out = append(out, proseSpans(text, refs)...)
	out = append(out, lineSpans(text, lower, refs)...)
	return out
}

// pem

var pemBegin = regexp.MustCompile(`-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----`)

func pemSpans(text string) []span {
	var out []span
	next := 0
	for _, m := range pemBegin.FindAllStringSubmatchIndex(text, -1) {
		if m[0] < next {
			continue
		}
		end := "-----END " + text[m[2]:m[3]] + "-----"
		i := strings.Index(text[m[1]:], end)
		if i < 0 {
			continue
		}
		next = m[1] + i + len(end)
		out = append(out, span{start: m[0], end: next, kind: KindPEM, rank: rankPEM})
	}
	return out
}

// auth-header

var (
	authHeader = regexp.MustCompile(`(?i)(?:^|[^\w-])((?:proxy-)?authorization)["']?[ \t]*[:=][ \t]*["']?` +
		`(?:(bearer|basic|token|apikey|api-key|key|negotiate|ntlm|digest|aws4-hmac-sha256|hoba|mutual)[ \t]+)?`)
	bareBearer = regexp.MustCompile(`(?i)(?:^|[^\w-])bearer[ \t]+`)
)

// credentialAt is the end of a header's credentials at i: the next blank,
// quote or backslash (a token with a symbol in it is whole), less a
// sentence's punctuation when the sentence goes on (a blank follows) or
// ends there, unless the header is its line's own (line): then its line's
// bytes are the value's (Authorization: Bearer abc!.:\r\n).
func credentialAt(text string, i int, line bool) int {
	j := i
	for j < len(text) {
		r, n := utf8.DecodeRuneInString(text[j:])
		if unicode.IsSpace(r) || strings.ContainsRune("\"'`\\", r) {
			break
		}
		j += n
	}
	switch r, _ := utf8.DecodeRuneInString(text[j:]); {
	case j == len(text) || r == '\r' || r == '\n':
		if line {
			return j
		}
		return trimUnquoted(text, i, j)
	case unicode.IsSpace(r):
		return trimUnquoted(text, i, j)
	}
	return j // a quote or a backslash closes it: its bytes are the value's
}

// headerValue reports the credentials [s, e) of the header named at name
// that are a value: not a template inside them (templated), what the shell
// computes there (read from the header's argument, headerArg; review T4
// (p2), T3P-1: -H "Authorization: Bearer abc$TOKEN", $$, never '$HOME' nor
// 'P@$$w0rd '), a placeholder in brackets ([token]), a URL, nor what
// notASecret says (literal: it runs into a reference).
func headerValue(text string, name, s, e int, refs []span) bool {
	v := text[s:e]
	if v == "" || notASecret(v, overlapsAny(s, e, refs)) || templated(v) || strings.Contains(v, "://") ||
		bracketed.MatchString(v) {
		return false
	}
	// The argument starts headerReach bytes before the name at most: with
	// no '$' or backquote from there on, the shell computes nothing.
	if w := text[max(0, name-headerReach):e]; strings.IndexByte(w, '$') < 0 && strings.IndexByte(w, '`') < 0 {
		return true
	}
	_, computed := shellRead(text, headerArg(text, name), e, false)
	return !overlapsAny(s, e, computed)
}

// headerFlag is curl's header option, before its argument; headerReach is
// how far before a header's name it is looked for.
var headerFlag = regexp.MustCompile(`(?:^|[ \t])(?:-H[ \t]*|--header(?:[ \t]+|=))`)

const headerReach = 256

// headerArg is where the shell argument holding the header name at i
// starts: the quote right before the name ($'…' from its '$': -H
// 'Authorization: …', "Authorization": "…"); else the argument of the last
// -H or --header before it on its line (-H 'X-Token: Bearer …'); else the
// name. So a header further into another argument reads as unquoted (echo
// 'Authorization: …'), never as the byte after its credential says.
func headerArg(text string, i int) int {
	if i > 0 && (text[i-1] == '\'' || text[i-1] == '"') {
		i--
		if text[i] == '\'' && i > 0 && text[i-1] == '$' {
			i--
		}
		return i
	}
	w := max(0, i-headerReach)
	if nl := strings.LastIndexByte(text[w:i], '\n'); nl >= 0 {
		w += nl + 1
	}
	if m := headerFlag.FindAllStringIndex(text[w:i], -1); m != nil {
		return w + m[len(m)-1][1]
	}
	return i
}

// templated reports a template or a command anywhere in a value, not only
// at its start (notASecret's): sk-${KEY}, abc$(cmd), pw-{{ .X }}.
func templated(v string) bool {
	return strings.Contains(v, "${") || strings.Contains(v, "$(") || strings.Contains(v, "{{")
}

// bracketed is a placeholder in square brackets: [token], [your key].
var bracketed = regexp.MustCompile(`^\[[\w .-]*\]$`)

// headerSpans are the header credentials in text (lower: text in lower
// case; a regexp runs only where its word is: most text has neither).
func headerSpans(text, lower string, refs []span) []span {
	var out []span
	var headers, bearers [][]int
	if strings.Contains(lower, "authorization") {
		headers = authHeader.FindAllStringSubmatchIndex(text, -1)
	}
	if strings.Contains(lower, "bearer") {
		bearers = bareBearer.FindAllStringIndex(text, -1)
	}
	for _, m := range headers {
		scheme := ""
		if m[4] >= 0 {
			scheme = strings.ToLower(text[m[4]:m[5]])
		}
		switch scheme {
		case "digest", "aws4-hmac-sha256", "hoba", "mutual":
			continue // parameters, not one credential: a manual mark
		}
		end := credentialAt(text, m[1], atLineStart(text, m[2]))
		v := text[m[1]:end]
		if !headerValue(text, m[2], m[1], end, refs) || (scheme == "" && !tokenish(v, 8)) {
			continue
		}
		out = append(out, span{start: m[1], end: end, kind: KindAuthHeader, rank: rankAuthHeader, shaped: scheme == ""})
	}
	for _, m := range bearers {
		end := credentialAt(text, m[1], false)
		name := m[1]
		for text[name-1] == ' ' || text[name-1] == '\t' {
			name--
		}
		if tokenish(text[m[1]:end], 16) && headerValue(text, name-len("bearer"), m[1], end, refs) {
			out = append(out, span{start: m[1], end: end, kind: KindAuthHeader, rank: rankAuthHeader, shaped: true})
		}
	}
	return out
}

// url-password, url-query

var (
	urlScheme  = regexp.MustCompile(`\b[A-Za-z][A-Za-z0-9+.\-]{0,30}://`)
	queryParam = regexp.MustCompile(`[?&]([A-Za-z0-9_.\-\[\]]{1,64})=`)
)

// queryCredential are parameter names that carry a credential in a URL even
// though they are not credential-like names elsewhere.
var queryCredential = map[string]bool{"key": true, "sig": true, "signature": true, "x-amz-signature": true,
	"x-goog-signature": true, "code_verifier": true}

func urlSpans(text string, refs []span) []span {
	var out []span
	var schemes, params [][]int // a regexp runs only where its literal is: most text has no URL
	if strings.Contains(text, "://") {
		schemes = urlScheme.FindAllStringIndex(text, -1)
	}
	if strings.IndexByte(text, '=') >= 0 {
		params = queryParam.FindAllStringSubmatchIndex(text, -1)
	}
	for _, m := range schemes {
		// The authority runs to the first / ? # or a blank; its userinfo to
		// its last @ (a raw @ in a password), the password after the first :.
		end := m[1]
		for end < len(text) && !strings.ContainsRune("/?#\"'<>`", rune(text[end])) && !isSpace(text[end]) {
			end++
		}
		auth := text[m[1]:end]
		at := strings.LastIndexByte(auth, '@')
		if at < 0 {
			continue
		}
		colon := strings.IndexByte(auth[:at], ':')
		if colon < 0 {
			continue
		}
		s, e := m[1]+colon+1, m[1]+at
		if s < e && !notASecret(text[s:e], overlapsAny(s, e, refs)) {
			out = append(out, span{start: s, end: e, kind: KindURLPassword, rank: rankURLPassword})
		}
	}
	for _, m := range params {
		name := text[m[2]:m[3]]
		if !credentialKey(name) && !queryCredential[strings.ToLower(name)] {
			continue
		}
		end := m[1]
		for end < len(text) && !strings.ContainsRune("&#\"'<>`", rune(text[end])) && !isSpace(text[end]) {
			end++
		}
		e := trimUnquoted(text, m[1], end)
		if m[1] < e && !notASecret(text[m[1]:e], overlapsAny(m[1], e, refs)) {
			out = append(out, span{start: m[1], end: e, kind: KindURLQuery, rank: rankURLQuery})
		}
	}
	return out
}

// assignment, yaml-block

var (
	// A name (bare, "quoted" or 'quoted'; a CLI flag's -- included) and its
	// separator: = : := => ?=.
	assignKey = regexp.MustCompile(`(?:^|[^\w\-/\\@])(--)?(?:"([A-Za-z_][\w.\-]{0,63})"|'([A-Za-z_][\w.\-]{0,63})'|` +
		`([A-Za-z_][\w.\-]{0,63}))[ \t]*(=>|:=|\?=|=|:)`)
	// A CLI flag with its value after a blank: --password hunter2.
	flagKey = regexp.MustCompile(`(?:^|[ \t])--([A-Za-z][\w\-]{0,63})[ \t]`)
	// A YAML block scalar's header after the key: | or >, indicators, a
	// comment.
	blockHeader = regexp.MustCompile(`^[|>](?:[1-9][-+]?|[-+][1-9]?)?[ \t]*(?:#[^\n]*)?\r?(?:\n|$)`)
	// Where an unquoted value ends early: the next name=value of a list
	// (a connection string's ;Password=, a form's &user=).
	nextPair = regexp.MustCompile(`[;&,][A-Za-z_][\w.\-]{0,63}=`)
	// curl's user and password: -u user:password, --user user:password;
	// and the curl command before it.
	curlUser    = regexp.MustCompile(`(?:^|[ \t])(?:-u[ \t]*|--user(?:[ \t]+|=))`)
	curlCommand = regexp.MustCompile(`(?:^|[\s(\x60])curl[ \t]`)
)

func assignmentSpans(text string, refs []span) []span {
	var out []span
	for _, m := range assignKey.FindAllStringSubmatchIndex(text, -1) {
		var name string
		quotedKey := false
		switch {
		case m[4] >= 0:
			name, quotedKey = text[m[4]:m[5]], true
		case m[6] >= 0:
			name, quotedKey = text[m[6]:m[7]], true
		default:
			name = text[m[8]:m[9]]
		}
		if !credentialKey(name) {
			continue
		}
		sep := text[m[10]:m[11]]
		switch {
		case sep == "=" && strings.HasPrefix(text[m[11]:], "="): // ==
			continue
		case sep == ":" && strings.HasPrefix(text[m[11]:], "//"), sep == ":" && strings.HasPrefix(text[m[11]:], ":"):
			continue
		}
		v := skipBlanks(text, m[11])
		keyStart := m[8]
		if quotedKey {
			keyStart = min(nonNeg(m[4]), nonNeg(m[6])) - 1
		}
		lineStart := sep == ":" && atLineStart(text, keyStart)
		if sep == ":" && lineStart && v < len(text) && (text[v] == '|' || text[v] == '>') {
			if sp, ok := yamlBlock(text, keyStart, v); ok {
				out = append(out, sp)
			}
			continue
		}
		if sp, ok := valueAt(text, v, KindAssignment, rankAssignment, refs); ok {
			out = append(out, sp)
		}
	}
	for _, m := range flagKey.FindAllStringSubmatchIndex(text, -1) {
		v := skipBlanks(text, m[1])
		if !credentialKey(text[m[2]:m[3]]) || v >= len(text) || text[v] == '-' {
			continue
		}
		if sp, ok := valueAt(text, v, KindAssignment, rankAssignment, refs); ok {
			out = append(out, sp)
		}
	}
	if strings.Contains(text, "curl") {
		for _, m := range curlUser.FindAllStringIndex(text, -1) {
			if sp, ok := curlPassword(text, m[1], refs); ok && inCurl(text, m[1]) {
				out = append(out, sp)
			}
		}
	}
	return out
}

// curlPassword is the password in curl's user:password, the shell word at
// v: after its first colon, as typed (quotes and escapes kept; a word that
// is one quoted string without its quotes). Not a placeholder: a credential
// word (user:pass) or one in brackets; nor what the shell computes in it
// (shellRead: a byte of it or of the rest of its word, review T4).
func curlPassword(text string, v int, refs []span) (span, bool) {
	le := strings.IndexByte(text[v:], '\n')
	if le < 0 {
		le = len(text)
	} else {
		le += v
	}
	word, computed := shellRead(text, v, le, true)
	s, e := v, word
	quoted := false
	if qs, qe, ok := quotedAt(text, v); ok && qe+1 == e {
		s, e, quoted = qs, qe, true
	} else if !strings.ContainsAny(text[s:e], "\"'\\") {
		e = trimUnquoted(text, s, e)
	}
	c := strings.IndexByte(text[s:e], ':')
	if c < 0 || s+c+1 >= e {
		return span{}, false
	}
	pw := text[s+c+1 : e]
	if notASecret(pw, quoted || overlapsAny(s+c+1, e, refs)) || credentialKey(pw) || bracketed.MatchString(pw) ||
		overlapsAny(s+c+1, word, computed) {
		return span{}, false
	}
	return span{start: s + c + 1, end: e, kind: KindAssignment, rank: rankAssignment}, true
}

// shellRead reads text from i, to end at most, as bash reads it from
// outside any quote, for curl's password and a header's credential (review
// T4 (p2), T3P-1): '…' as is; "…" with backslash escapes; $'…' too, whose
// escapes the shell rewrites; a backslash outside them escaping the next
// byte. An expansion (expands: $NAME, a digit, a special parameter, ${…},
// $(…) and $((…)), $[…], an unquoted $"…") or a backquote is read to its
// close (to end when it has none), its own quotes, escapes and brackets
// nested, so a blank or an operator inside it is its own. word: it stops
// where the word at i ends, at an unquoted blank or ; | & < > ( ) outside
// all of those, or at a quote left open; else it reads all of [i, end), a
// quote left open quoting the rest. Its stop, and the ranges whose bytes
// the shell computes: never "\$HOME", '$HOME', "ab$'c" nor a '$' before
// nothing it expands ("abc$", "a$%b"), which it keeps.
func shellRead(text string, i, end int, word bool) (int, []span) {
	var computed []span
	for i < end {
		switch c := text[i]; {
		case c == '\\':
			i += 2
		case c == '\'':
			k := strings.IndexByte(text[i+1:end], '\'')
			if k < 0 && word {
				return i, computed
			} else if k < 0 {
				return end, computed
			}
			i += k + 2
		case c == '"' || c == '$' && i+1 < end && text[i+1] == '\'':
			n := len(computed)
			j, ok := shellQuoted(text, i, end, &computed)
			if !ok && word {
				return i, computed[:n]
			}
			i = j
		case c == '`' || c == '$' && i+1 < end && expands(text[i+1], false):
			j := shellExpansion(text, i, end)
			computed = append(computed, span{start: i, end: j})
			i = j
		case word && (isSpace(c) || strings.IndexByte(";|&<>()", c) >= 0):
			return i, computed
		default:
			i++
		}
	}
	return min(i, end), computed
}

// shellQuoted reads the "…" or $'…' at i, to end at most: the index after
// its closing quote (end and false when it has none), what the shell
// computes in it added to computed when that is not nil (in "…" an
// expansion or a backquote, a '$' before a quote being a byte; in $'…' each
// escape).
func shellQuoted(text string, i, end int, computed *[]span) (int, bool) {
	ansi := text[i] == '$'
	if ansi {
		i++
	}
	for i++; i < end; {
		switch c := text[i]; {
		case c == '\\':
			if ansi && computed != nil {
				*computed = append(*computed, span{start: i, end: min(i+2, end)})
			}
			i += 2
		case c == '\'' && ansi || c == '"' && !ansi:
			return i + 1, true
		case !ansi && (c == '`' || c == '$' && i+1 < end && expands(text[i+1], true)):
			j := shellExpansion(text, i, end)
			if computed != nil {
				*computed = append(*computed, span{start: i, end: j})
			}
			i = j
		default:
			i++
		}
	}
	return end, false
}

// quoteEnd is the index of the quote that closes the shell quote at i
// before end ('…' as is, "…" with backslash escapes), or -1.
func quoteEnd(text string, i, end int) int {
	if text[i] == '\'' {
		if k := strings.IndexByte(text[i+1:end], '\''); k >= 0 {
			return i + 1 + k
		}
		return -1
	}
	for j := i + 1; j < end; j++ {
		switch text[j] {
		case '\\':
			j++
		case '"':
			return j
		}
	}
	return -1
}

// expands reports a '$' before c that the shell expands, in double quotes
// or none: a name, a digit, a special parameter (@ * # ? - $ !), ${…},
// $(…) or $[…]; outside double quotes also $"…" (and $'…', which
// shellRead reads as a quote).
func expands(c byte, double bool) bool {
	return isASCIILetter(c) || c >= '0' && c <= '9' || strings.IndexByte("_{([@*#?-$!", c) >= 0 || !double && (c == '\'' || c == '"')
}

// shellExpansion is the end of the expansion or backquote at i, to end at
// most: its close, or its name's end.
func shellExpansion(text string, i, end int) int {
	if text[i] == '`' {
		return shellClose(text, i+1, end, 0, '`')
	}
	switch c := text[i+1]; c {
	case '{':
		return shellClose(text, i+2, end, '{', '}')
	case '(':
		return shellClose(text, i+2, end, '(', ')')
	case '[':
		return shellClose(text, i+2, end, '[', ']')
	case '\'':
		j, _ := shellQuoted(text, i, end, nil)
		return j
	case '"':
		j, _ := shellQuoted(text, i+1, end, nil)
		return j
	}
	j := i + 2
	if c := text[i+1]; isASCIILetter(c) || c == '_' {
		for j < end && (isASCIILetter(text[j]) || text[j] == '_' || text[j] >= '0' && text[j] <= '9') {
			j++
		}
	}
	return j
}

// shellClose is the index after the closer that ends a run from j, to end
// at most (end when none does). With an opener (${…}, $(…), $[…]) its
// opens nest, and the quotes and expansions in it are read whole; without
// one (backquotes) a backslash only escapes the next byte.
func shellClose(text string, j, end int, opener, closer byte) int {
	for depth := 0; j < end; {
		switch c := text[j]; {
		case c == '\\':
			j += 2
			continue
		case c == closer && depth == 0:
			return j + 1
		case opener == 0:
		case c == closer:
			depth--
		case c == opener:
			depth++
		case c == '\'':
			k := strings.IndexByte(text[j+1:end], '\'')
			if k < 0 {
				return end
			}
			j += k + 1
		case c == '"':
			j, _ = shellQuoted(text, j, end, nil)
			continue
		case c == '`' || c == '$' && j+1 < end && expands(text[j+1], false):
			j = shellExpansion(text, j, end)
			continue
		}
		j++
	}
	return end
}

func isASCIILetter(c byte) bool { return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' }

// inCurl reports a curl command before i, in its own part of the line (no
// unquoted | ; & between: review T1) or of the lines a trailing backslash
// continues.
func inCurl(text string, i int) bool {
	start := i
	for {
		ls := strings.LastIndexByte(text[:start], '\n') + 1
		if ls == 0 || !strings.HasSuffix(strings.TrimRight(text[:ls-1], " \t\r"), "\\") {
			start = ls
			break
		}
		start = ls - 1
	}
	cmd := start
	for k := start; k < i; k++ {
		switch c := text[k]; {
		case c == '\\':
			k++
		case c == '\'' || c == '"':
			if k = quoteEnd(text, k, i); k < 0 {
				return false // i is inside the quote
			}
		case strings.IndexByte("|;&", c) >= 0:
			cmd = k + 1
		}
	}
	return curlCommand.MatchString(text[cmd:i])
}

// skipBlanks is the first byte at or after i that is not a space or tab.
func skipBlanks(text string, i int) int {
	for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
		i++
	}
	return i
}

func nonNeg(i int) int {
	if i < 0 {
		return 1 << 30
	}
	return i
}

// atLineStart reports whether only blanks (and a YAML list's "- ") come
// before i on its line.
func atLineStart(text string, i int) bool {
	j := i
	for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
		j--
	}
	if j > 0 && text[j-1] == '-' {
		j--
		for j > 0 && (text[j-1] == ' ' || text[j-1] == '\t') {
			j--
		}
	}
	return j == 0 || text[j-1] == '\n'
}

// valueAt is the value at v: quoted (the bytes between the quotes), or
// unquoted: to the next blank or pair, trailing punctuation off (a YAML
// plain scalar with blanks is cut at its first: the review corrects it).
// refs: the own references masked in text (structural).
func valueAt(text string, v int, kind string, rank int, refs []span) (span, bool) {
	if v >= len(text) {
		return span{}, false
	}
	if s, e, ok := quotedAt(text, v); ok {
		if s == e || notASecret(text[s:e], true) {
			return span{}, false
		}
		return span{start: s, end: e, kind: kind, rank: rank}, true
	}
	switch text[v] {
	case '"', '\'', '`', '[', '{', '\r', '\n', '|', '>':
		return span{}, false // unterminated, a flow collection, nothing
	}
	end := blankAt(text, v)
	if loc := nextPair.FindStringIndex(text[v:end]); loc != nil {
		end = v + loc[0]
	}
	end = trimUnquoted(text, v, end)
	if end <= v || notASecret(text[v:end], overlapsAny(v, end, refs)) {
		return span{}, false
	}
	return span{start: v, end: end, kind: kind, rank: rank}, true
}

// blankAt is the end of the run of non-blank text at i.
func blankAt(text string, i int) int {
	for i < len(text) {
		r, n := utf8.DecodeRuneInString(text[i:])
		if unicode.IsSpace(r) {
			break
		}
		i += n
	}
	return i
}

// quotePairs are the quotes a value may be in, opening to closing.
var quotePairs = map[rune]rune{'"': '"', '\'': '\'', '`': '`', '“': '”', '‘': '’', '«': '»'}

// quotedAt reads a quoted value at v, on one line: the range between the
// quotes. In "…" a backslash escapes the next byte; in '…' a doubled ”
// is YAML's escaped quote, and a quote, a backslash and two quotes are a
// shell's (the word goes on).
func quotedAt(text string, v int) (start, end int, ok bool) {
	open, n := utf8.DecodeRuneInString(text[v:])
	closing, ok := quotePairs[open]
	if !ok {
		return 0, 0, false
	}
	i := v + n
	for i < len(text) {
		r, w := utf8.DecodeRuneInString(text[i:])
		switch {
		case r == '\n' || r == '\r':
			return 0, 0, false
		case open == '"' && r == '\\' && i+1 < len(text):
			i += 2
			continue
		case r == closing:
			if open == '\'' && i+1 < len(text) && text[i+1] == '\'' {
				i += 2
				continue
			}
			if open == '\'' && strings.HasPrefix(text[i:], `'\''`) {
				i += 4
				continue
			}
			return v + n, i, true
		}
		i += w
	}
	return 0, 0, false
}

// trimUnquoted drops an unquoted value's trailing sentence punctuation and
// an unbalanced closing bracket or quote: its new end.
func trimUnquoted(text string, s, e int) int {
	for e > s {
		c := text[e-1]
		switch c {
		case '.', ',', ';', ':':
			e--
			continue
		case ')', ']', '}':
			o := map[byte]byte{')': '(', ']': '[', '}': '{'}[c]
			if strings.Count(text[s:e], string(c)) > strings.Count(text[s:e], string(o)) {
				e--
				continue
			}
		case '"', '\'', '`':
			if strings.Count(text[s:e], string(c))%2 == 1 {
				e--
				continue
			}
		}
		break
	}
	return e
}

// yamlBlock is the block scalar whose header is at v, under the key at
// keyStart: its content lines, from the first one's first character to the
// end of the last non-blank one. Continuation lines keep their indentation
// (encoded: stored as typed).
func yamlBlock(text string, keyStart, v int) (span, bool) {
	hdr := blockHeader.FindStringIndex(text[v:])
	if hdr == nil {
		return span{}, false
	}
	indent := 0
	for j := keyStart; j > 0 && text[j-1] != '\n'; j-- {
		indent++
	}
	i := v + hdr[1]
	start, end, lines := -1, -1, 0
	for i < len(text) {
		le := strings.IndexByte(text[i:], '\n')
		lineEnd := len(text)
		if le >= 0 {
			lineEnd = i + le
		}
		line := strings.TrimRight(text[i:lineEnd], "\r")
		if strings.TrimSpace(line) != "" {
			ind := len(line) - len(strings.TrimLeft(line, " "))
			if ind <= indent {
				break
			}
			if start < 0 {
				start = i + ind
			}
			end = i + len(line)
			lines++
		}
		if le < 0 {
			break
		}
		i = lineEnd + 1
	}
	if start < 0 || notASecret(strings.TrimSpace(text[start:end]), true) {
		return span{}, false
	}
	return span{start: start, end: end, kind: KindYAMLBlock, rank: rankYAMLBlock, encoded: lines > 1}, true
}

// prose, fenced

var (
	// A credential word: a password word (any value with a digit or a
	// symbol) or a key word (a token-like value); and "credential"
	// (credentialWords: one more alternative here costs every byte).
	proseWord = regexp.MustCompile(`(?i)(?:^|[^\pL\pN_])(password|passphrase|passwd|pwd|pass ?code|wachtwoord|passwort|kennwort|` +
		`contraseña|contrasena|senha|mot de passe|lösenord|losenord|salasana|hasło|haslo|пароль|` +
		`(?:api|access|secret|private|auth|bot|app|client|deploy|personal access|github|gitlab|npm|hf|openai)[ _-]?(?:key|token)|` +
		`key|token|secret)`)
	// What joins the word and its value: a copula ("is", "was set to",
	// "has been changed to", "is now"), a colon or a blank; or "for the
	// database" and then a copula or a colon.
	proseCopula = `(?:[ \t]+((?:is|was|has been|had been|will be)(?: (?:set|changed|reset|updated) to| now)?|` +
		`=|->|→|to|ist|est|es|er|är|on|je):?[ \t]+|[ \t]*[:=][ \t]*)`
	proseLink = regexp.MustCompile(`(?i)^(?:` + proseCopula + `|[ \t]+)`)
	proseFor  = regexp.MustCompile(`(?i)^[ \t]+(?:for|of|voor|für|pour|para)(?:[ \t]+[^\s.,;:!?"'` + "`" + `]{1,40}){1,4}?` + proseCopula)
	// A few words more (after a comma too), then a copula or a colon and a
	// quote.
	proseGap = regexp.MustCompile(`(?i)^(,?(?:[ \t]+[^\s.!?:="'` + "`" + `“‘«„]{1,40}){1,10}?)` + proseCopula + "[\"'`“‘«„]")
	fence    = regexp.MustCompile("^```[\\w.+-]*[ \t]*\r?\n")
)

// gapNouns name what a password has rather than what it is ("the password
// field is "required"" names no password); a copula in the gap says
// something else of it ("the key is only ever sent to "…"").
var gapNouns = map[string]bool{"is": true, "was": true, "are": true, "were": true,
	"field": true, "policy": true, "rule": true, "rules": true, "requirement": true,
	"requirements": true, "validation": true, "message": true, "error": true, "label": true, "hint": true,
	"placeholder": true, "prompt": true, "column": true, "parameter": true, "param": true, "variable": true, "name": true,
	"hash": true, "length": true, "format": true, "pattern": true, "regex": true, "setting": true, "settings": true,
	"option": true, "flag": true, "attribute": true, "type": true, "input": true, "reset": true, "expiry": true,
	"expiration": true, "strength": true, "complexity": true, "file": true, "path": true, "env": true, "header": true,
	"endpoint": true, "url": true, "scope": true, "prefix": true, "suffix": true, "example": true, "template": true,
	"result": true, "check": true, "status": true, "state": true, "mode": true, "comparison": true, "identifier": true,
	"id": true, "algorithm": true, "encoding": true, "count": true, "score": true, "rating": true, "level": true}

// gapLeads may follow a credential word that is its sentence's subject, as
// does a participle (…ed) or a comma: a preposition, a determiner, a
// pronoun or an adverb ("the password in these quotes", "the password the
// job uses", "the token we rotated", "the password now"). Any other word
// makes the credential word a modifier of another noun ("the password
// comparison result is", "the password check is"): what is quoted after it
// is that noun's (review T2).
var gapLeads = map[string]bool{"for": true, "of": true, "in": true, "on": true, "at": true, "by": true, "to": true,
	"from": true, "with": true, "within": true, "inside": true, "into": true, "as": true, "via": true, "under": true,
	"after": true, "before": true, "behind": true, "between": true, "through": true, "per": true, "voor": true,
	"für": true, "pour": true, "para": true, "de": true, "van": true, "von": true, "du": true, "del": true,
	"the": true, "a": true, "an": true, "this": true, "that": true, "these": true, "those": true, "my": true, "our": true,
	"your": true, "their": true, "his": true, "her": true, "its": true, "i": true, "we": true, "you": true, "they": true,
	"he": true, "she": true, "it": true, "which": true, "who": true, "whose": true, "someone": true,
	"now": true, "currently": true, "here": true, "there": true, "again": true, "also": true, "still": true,
	"actually": true, "really": true, "originally": true, "previously": true, "today": true, "then": true,
	"finally": true, "just": true, "including": true, "containing": true, "ending": true, "starting": true,
	"beginning": true, "using": true, "following": true, "given": true, "chosen": true, "written": true,
	"taken": true, "hidden": true, "shown": true, "known": true, "sent": true, "set": true, "kept": true, "put": true,
	"got": true, "gotten": true, "stolen": true, "made": true, "built": true, "found": true, "held": true, "read": true}

// subjectLead reports a gap's first word (or a comma) after which the
// credential word is the subject (gapLeads).
func subjectLead(gap string) bool {
	if strings.HasPrefix(gap, ",") {
		return true
	}
	f := strings.Fields(gap)
	if len(f) == 0 {
		return false
	}
	w := strings.ToLower(strings.TrimRight(f[0], ",;"))
	return gapLeads[w] || len(w) >= 4 && strings.HasSuffix(w, "ed") && !strings.HasSuffix(w, "eed")
}

// named reports a value that names something rather than being one:
// letters of one case, in words joined by - _ or . (invalid-password,
// not-found, DB_PASSWORD, api.example.test).
func named(v string) bool {
	lower, upper := false, false
	for _, r := range v {
		switch {
		case unicode.IsLower(r):
			lower = true
		case unicode.IsUpper(r):
			upper = true
		case !strings.ContainsRune("-_.", r):
			return false
		}
	}
	return lower != upper
}

func isPasswordWord(w string) bool {
	w = strings.ToLower(w)
	return !strings.Contains(w, "key") && !strings.Contains(w, "token") && w != "secret" && !strings.HasPrefix(w, "credential")
}

func proseSpans(text string, refs []span) []span {
	var words [][2]int
	for _, m := range proseWord.FindAllStringSubmatchIndex(text, -1) {
		words = append(words, [2]int{m[2], m[3]})
	}
	var out []span
	for _, w := range append(words, credentialWords(text)...) {
		word := text[w[0]:w[1]]
		if r, _ := utf8.DecodeRuneInString(text[w[1]:]); w[1] < len(text) && isWordRune(r) {
			continue // a longer word
		}
		if publicKeyBefore(text, w[0]) {
			continue
		}
		if sp, ok := fencedAfter(text, w[1]); ok {
			out = append(out, sp)
			continue
		}
		if sp, ok := proseValue(text, w[1], word, refs); ok {
			out = append(out, sp)
		} else if sp, ok := proseQuotedAfter(text, w[1], isPasswordWord(word)); ok {
			out = append(out, sp)
		}
	}
	return out
}

// credentialWords are the words credential and credentials (Credential,
// CREDENTIALS), a key word: found apart from proseWord, by their bytes.
func credentialWords(text string) [][2]int {
	var out [][2]int
	for _, tail := range []string{"redential", "REDENTIAL"} {
		for i := 0; ; {
			j := strings.Index(text[i:], tail)
			if j < 0 {
				break
			}
			s, e := i+j-1, i+j+len(tail)
			i = e
			if s < 0 || text[s] != 'c' && text[s] != 'C' {
				continue
			}
			if r, _ := utf8.DecodeLastRuneInString(text[:s]); s > 0 && isWordRune(r) {
				continue
			}
			if e < len(text) && (text[e] == 's' || text[e] == 'S') {
				e++
			}
			out = append(out, [2]int{s, e})
		}
	}
	return out
}

// proseValue is the value after a credential word that ends at i: joined
// by a copula, a colon or a blank (or "for …" and a copula).
func proseValue(text string, i int, word string, refs []span) (span, bool) {
	pw := isPasswordWord(word)
	l := proseFor.FindStringSubmatchIndex(text[i:])
	if l == nil {
		if l = proseLink.FindStringSubmatchIndex(text[i:]); l == nil {
			return span{}, false
		}
	}
	copula := l[2] >= 0 || strings.ContainsAny(text[i:i+l[1]], ":=")
	v := i + l[1]
	if v >= len(text) {
		return span{}, false
	}
	if s, e, ok := quotedAt(text, v); ok {
		val := text[s:e]
		if s == e || notASecret(val, true) || !pw && len(val) < 8 ||
			strings.HasPrefix(strings.ToLower(word), "credential") && !tokenish(val, 8) {
			return span{}, false
		}
		return span{start: s, end: e, kind: KindProse, rank: rankProse, shaped: !pw}, true
	}
	e := trimUnquoted(text, v, blankAt(text, v))
	val := text[v:e]
	if e <= v || notASecret(val, overlapsAny(v, e, refs)) {
		return span{}, false
	}
	var ok bool
	switch {
	case pw && copula:
		ok = len(val) >= 4 && hasDigitOrSymbol(val)
	case pw:
		ok = len(val) >= 6 && hasDigitOrSymbol(val)
	case copula:
		ok = tokenish(val, 8)
	default:
		ok = len(val) >= 16 && hasLetter(val) && hasDigit(val)
	}
	if !ok {
		return span{}, false
	}
	return span{start: v, end: e, kind: KindProse, rank: rankProse, shaped: true}, true
}

// proseQuotedAfter is a quoted value a few words after a credential word
// that ends at i, then a copula or a colon ("the password used by the job
// is «X»", "the password in these quotes, including the last character:
// "X"", "the literal password, including its punctuation, is «X»"): the
// bytes between the quotes, shaped like one (no blank; a letter and a digit
// or a symbol; a key word's token-like; no name: named, credentialKey),
// only when the credential word is the subject (subjectLead), never after
// words that name what a password has (gapNouns).
func proseQuotedAfter(text string, i int, pw bool) (span, bool) {
	if !quoteAhead(text, i) {
		return span{}, false
	}
	l := proseGap.FindStringSubmatchIndex(text[i:min(len(text), i+proseReach)])
	if l == nil || !subjectLead(text[i+l[2]:i+l[3]]) {
		return span{}, false
	}
	for _, w := range strings.Fields(text[i+l[2] : i+l[3]]) {
		if gapNouns[strings.ToLower(strings.Trim(w, ",;()"))] {
			return span{}, false
		}
	}
	_, n := utf8.DecodeLastRuneInString(text[:i+l[1]])
	s, e, ok := quotedAt(text, i+l[1]-n)
	if !ok {
		return span{}, false
	}
	val := text[s:e]
	if notASecret(val, true) || templated(val) || strings.ContainsAny(val, " \t") || pathLike.MatchString(val) || strings.Contains(val, "://") {
		return span{}, false
	}
	if pw && !(len(val) >= 6 && hasLetter(val) && hasDigitOrSymbol(val)) || !pw && !tokenish(val, 8) || named(val) || credentialKey(val) {
		return span{}, false
	}
	return span{start: s, end: e, kind: KindProse, rank: rankProse, shaped: true}, true
}

// lineNamed is a sentence that names a line as a credential: "The
// preceding line is the actual deployment password." The credential word
// ends the phrase (never "the key to this bug", "the token check").
var lineNamed = regexp.MustCompile(`(?i)\b(?:(preceding|previous|first|above) line|line above) (?:is|was|holds|contains) (?:the |my |our |an? )?` +
	`((?:actual |real |exact )?(?:[a-z-]+ ){0,2}?)(password|passphrase|passwd|token|secret|key|credential)s?[ \t]*(?:[.!;:,]|\r?\n|$)`)

// lineSpans are the lines of one value a sentence names (lineNamed): the
// line before the sentence's (the text's first, for "first line"), its
// blanks off, shaped like a value (a key word's token-like, a password
// word's with a digit or a symbol) and no code (review T3). A key, token,
// secret or credential word needs a word before it ("the actual token",
// "our API key", never bare "the key").
func lineSpans(text, lower string, refs []span) []span {
	if !strings.Contains(lower, "line ") {
		return nil
	}
	var out []span
	for _, m := range lineNamed.FindAllStringSubmatchIndex(text, -1) {
		end := strings.LastIndexByte(text[:m[0]], '\n') // the line before the sentence's ends here
		if m[2] >= 0 && strings.EqualFold(text[m[2]:m[3]], "first") {
			end = strings.IndexByte(text, '\n')
		}
		for end > 0 && strings.TrimSpace(text[strings.LastIndexByte(text[:end], '\n')+1:end]) == "" {
			end = strings.LastIndexByte(text[:end], '\n') // blank lines between
		}
		if end <= 0 {
			continue
		}
		s, e := strings.LastIndexByte(text[:end], '\n')+1, end
		for s < e && isSpace(text[s]) {
			s++
		}
		for e > s && isSpace(text[e-1]) {
			e--
		}
		v := text[s:e]
		if s >= e || strings.ContainsAny(v, " \t") || notASecret(v, overlapsAny(s, e, refs)) || templated(v) || len(v) < 6 {
			continue
		}
		if pw := isPasswordWord(text[m[6]:m[7]]); pw && !hasDigitOrSymbol(v) || !pw && (m[4] == m[5] || !tokenish(v, 8)) {
			continue
		}
		out = append(out, span{start: s, end: e, kind: KindProse, rank: rankProse, shaped: true})
	}
	return out
}

// proseReach bounds what proseGap reads after a word: ten words and a
// copula.
const proseReach = 512

// quoteAhead reports an opening quote proseGap may reach from i on its line,
// so that it runs only then.
func quoteAhead(text string, i int) bool {
	ahead := text[i:min(len(text), i+proseReach)]
	if n := strings.IndexByte(ahead, '\n'); n >= 0 {
		ahead = ahead[:n]
	}
	for _, c := range []byte{'"', '\'', '`', 0xC2, 0xE2} { // « is C2 AB; “ ‘ „ are E2 80 …
		if strings.IndexByte(ahead, c) >= 0 {
			return true
		}
	}
	return false
}

func isWordRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }

// publicKeyBefore reports "public" just before the word at i (a public key
// is not a secret).
func publicKeyBefore(text string, i int) bool {
	before := strings.ToLower(text[max(0, i-24):i])
	return strings.Contains(before, "public")
}

// fencedAfter is a code fence of one value right after a credential word's
// line that ends in a colon ("API token:\n```\nvalue\n```"): its content,
// lines kept, when it holds no blank and at most 8 lines.
func fencedAfter(text string, i int) (span, bool) {
	le := strings.IndexByte(text[i:], '\n')
	if le < 0 {
		return span{}, false
	}
	if !strings.HasSuffix(strings.TrimRight(text[i:i+le], " \t\r"), ":") {
		return span{}, false
	}
	j := i + le + 1
	f := fence.FindStringIndex(text[j:])
	if f == nil {
		return span{}, false
	}
	s := j + f[1]
	c := strings.Index(text[s:], "```")
	if c < 0 {
		return span{}, false
	}
	e := s + c
	for e > s && (text[e-1] == '\n' || text[e-1] == '\r') {
		e--
	}
	body := text[s:e]
	if body == "" || strings.ContainsAny(body, " \t") || strings.Count(body, "\n") >= 8 || notASecret(body, true) {
		return span{}, false
	}
	return span{start: s, end: e, kind: KindFenced, rank: rankFenced}, true
}

// repeats are the other exact occurrences of the found values that have a
// digit, a symbol or 16 bytes, each on a word boundary and outside every
// span already found.
func repeats(text string, found []span) []span {
	var out []span
	seen := map[string]bool{}
	for _, f := range found {
		v := text[f.start:f.end]
		if seen[v] || len(v) < 6 || !(hasDigitOrSymbol(v) || len(v) >= 16) || isDigits(v) {
			continue
		}
		seen[v] = true
		for i := 0; ; {
			j := strings.Index(text[i:], v)
			if j < 0 {
				break
			}
			s, e := i+j, i+j+len(v)
			i = s + 1
			if wordAt(text, s-1) && wordAt(text, s) || wordAt(text, e-1) && wordAt(text, e) {
				continue
			}
			if !overlapsAny(s, e, found) && !overlapsAny(s, e, out) {
				out = append(out, span{start: s, end: e, kind: KindRepeat, rank: rankRepeat})
			}
		}
	}
	return out
}

func wordAt(text string, i int) bool {
	if i < 0 || i >= len(text) {
		return false
	}
	c := text[i]
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func overlapsAny(s, e int, ss []span) bool {
	for _, x := range ss {
		if s < x.end && x.start < e {
			return true
		}
	}
	return false
}

// credentialKey reports a credential-like name: its last part (split at
// separators and camelCase) is a password, secret, token or auth word, or
// a key with a qualifying part before it (api_key, accessKey, …), or ends in
// password, passwd, passphrase, token or secret (PGPASSWORD, authtoken).
func credentialKey(name string) bool {
	parts := nameParts(name)
	if len(parts) == 0 {
		return false
	}
	last := parts[len(parts)-1]
	switch last {
	case "password", "passwd", "pwd", "pass", "passphrase", "pw", "secret", "token", "auth", "apikey", "accesskey",
		"secretkey", "privatekey", "authkey":
		return true
	case "key":
		if len(parts) > 1 && keyQualifier[parts[len(parts)-2]] {
			return true
		}
	}
	for _, suf := range []string{"password", "passwd", "passphrase", "token", "secret"} {
		if strings.HasSuffix(last, suf) {
			return true
		}
	}
	return false
}

var keyQualifier = map[string]bool{"api": true, "access": true, "secret": true, "private": true, "client": true, "auth": true,
	"encryption": true, "signing": true, "master": true, "app": true, "account": true, "service": true, "license": true,
	"sas": true, "storage": true, "subscription": true, "admin": true, "session": true, "shared": true, "consumer": true,
	"webhook": true, "deploy": true, "ssh": true, "pgp": true, "gpg": true, "jwt": true, "hmac": true}

// nameParts splits a name into lowercase parts at non-alphanumerics and
// camelCase (APIKey: api, key).
func nameParts(name string) []string {
	var parts []string
	var cur []rune
	rs := []rune(name)
	flush := func() {
		if len(cur) > 0 {
			parts = append(parts, strings.ToLower(string(cur)))
			cur = cur[:0]
		}
	}
	for i, r := range rs {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			flush()
			continue
		}
		if i > 0 && unicode.IsUpper(r) && len(cur) > 0 {
			prev := rs[i-1]
			if unicode.IsLower(prev) || unicode.IsDigit(prev) ||
				(unicode.IsUpper(prev) && i+1 < len(rs) && unicode.IsLower(rs[i+1])) {
				flush()
			}
		}
		cur = append(cur, r)
	}
	flush()
	return parts
}

// Value classes.

var (
	templateRef = regexp.MustCompile(`^\$(?:[A-Za-z_{(]|\d)|\{\{.*\}\}|^%\(?[A-Za-z_]\w*\)?[%s]?$|^<[^<>\n]*>$|^\{[A-Za-z_]\w*\}$`)
	codeCall    = regexp.MustCompile(`^[A-Za-z_][\w.]*(?:\([^()]*\)|\[[^\[\]]*\])$`)
	dottedName  = regexp.MustCompile(`^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+(?:\(\))?$`)
	pathLike    = regexp.MustCompile(`^(?:~|\.{1,2})?/[\w.\-/@]*$`)
	xMask       = regexp.MustCompile(`^[xX]{3,}(?:[-_.: ][xX]{3,})*$`)
	placeholder = regexp.MustCompile(`(?i)^your[-_ ]|[-_ ]here$|^(?:replace|insert|enter)[-_ ]|^(?:todo|tbd|fixme|redacted|\[redacted\]|hidden|masked|none|null|nil|undefined|true|false|yes|no|on|off|n/a)$`)
	sshPublic   = regexp.MustCompile(`^(?:ssh-(?:rsa|dss|ed25519)|ecdsa-sha2-|sk-ssh-|sk-ecdsa-)`)
)

// notASecret reports a value that is no secret: a template or reference,
// code, a redaction or placeholder, a path or a public key (the bridge's
// own file references are Scan's to leave out, by their exact bytes).
// literal: it is no code, as it was between quotes (a dotted name is then
// a literal) or runs into an own reference (its range overlaps one masked:
// PASSWORD=[…]eyJ….eyJ….sig), never because of the bytes it holds.
func notASecret(v string, literal bool) bool {
	switch {
	case strings.TrimSpace(v) == "":
		return true
	case templateRef.MatchString(v), placeholder.MatchString(v), xMask.MatchString(v), sshPublic.MatchString(v):
		return true
	case strings.Contains(v, "***"), strings.Contains(v, "•••"), strings.Contains(v, "…"), strings.Trim(v, ".") == "":
		return true
	case strings.Contains(strings.ToLower(v), "redacted"):
		return true
	case strings.HasPrefix(v, "process.env"), strings.HasPrefix(v, "import.meta.env"), strings.HasPrefix(v, "os.environ"):
		return true
	}
	if !literal {
		if codeCall.MatchString(v) || dottedName.MatchString(v) || (pathLike.MatchString(v) && strings.Contains(v, "/")) {
			return true
		}
	}
	return false
}

// tokenish reports a token-like value: at least n bytes, no blank, a
// letter, and a digit (or both cases over 20 bytes: not a CamelCase name).
func tokenish(v string, n int) bool {
	if len(v) < n || !hasLetter(v) || strings.ContainsAny(v, " \t\r\n") {
		return false
	}
	if hasDigit(v) {
		return true
	}
	upper, lower := false, false
	for _, r := range v {
		upper = upper || unicode.IsUpper(r)
		lower = lower || unicode.IsLower(r)
	}
	return upper && lower && len(v) >= 20
}

func hasLetter(v string) bool { return strings.IndexFunc(v, unicode.IsLetter) >= 0 }
func hasDigit(v string) bool  { return strings.IndexFunc(v, unicode.IsDigit) >= 0 }

func hasDigitOrSymbol(v string) bool {
	return strings.IndexFunc(v, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsSpace(r) }) >= 0
}

func isDigits(v string) bool {
	return strings.IndexFunc(v, func(r rune) bool { return r < '0' || r > '9' }) < 0
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\v' || c == '\f'
}
