package promptsecret

// The structural rules (#108): candidates the Gitleaks rules miss, each at
// its value's exact bytes as typed (docs/decisions.md, the byte contract per
// syntax). They are this repository's own, not the research probe's:
//
//   - pem: a PEM private key block, BEGIN to END line, newlines kept;
//   - auth-header: an Authorization (or Proxy-Authorization) header's
//     credentials after its scheme (Bearer, Basic as typed, Token, …), and a
//     bare long "Bearer <token>";
//   - url-password: the password of a URL's userinfo, percent-encoding kept;
//   - url-query: the value of a credential-named query (or form) parameter;
//   - assignment: env, shell (export), YAML, JSON, TOML, INI, CLI flags and
//     code: a credential-like name (password, passwd, pwd, secret, token,
//     api_key, access_key, private_key, client_secret, auth, …) and its
//     value: the bytes inside the quotes, or an unquoted value;
//   - yaml-block: a YAML block scalar (| or >) under such a name;
//   - prose: "the password is X", "API key: X", "the secret X", in a few
//     languages; and fenced: a code fence of one value after a line that
//     names a credential and ends in a colon;
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
	encoded    bool // stored as typed: a YAML block's indented lines
	shaped     bool // found for its value's shape (a token format, a length, a digit), not only its place
	borrowed   bool // owes its match to a reference: ranks after every other (Scan)
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

func structural(text string) []span {
	var out []span
	out = append(out, pemSpans(text)...)
	out = append(out, headerSpans(text)...)
	out = append(out, urlSpans(text)...)
	out = append(out, assignmentSpans(text)...)
	out = append(out, proseSpans(text)...)
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
	authHeader = regexp.MustCompile(`(?i)(?:^|[^\w-])(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?` +
		`(?:(bearer|basic|token|apikey|api-key|key|negotiate|ntlm|digest|aws4-hmac-sha256|hoba|mutual)[ \t]+)?`)
	bareBearer = regexp.MustCompile(`(?i)(?:^|[^\w-])bearer[ \t]+`)
)

// isToken68 reports a byte of an HTTP token68 credential (RFC 7235), '='
// only as its padding.
func isToken68(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		c == '-' || c == '.' || c == '_' || c == '~' || c == '+' || c == '/'
}

// token68At is the token68 credential at i: its end.
func token68At(text string, i int) int {
	j := i
	for j < len(text) && isToken68(text[j]) {
		j++
	}
	if j == i {
		return i
	}
	for j < len(text) && text[j] == '=' {
		j++
	}
	return j
}

func headerSpans(text string) []span {
	var out []span
	for _, m := range authHeader.FindAllStringSubmatchIndex(text, -1) {
		scheme := ""
		if m[2] >= 0 {
			scheme = strings.ToLower(text[m[2]:m[3]])
		}
		switch scheme {
		case "digest", "aws4-hmac-sha256", "hoba", "mutual":
			continue // parameters, not one credential: a manual mark
		}
		end := token68At(text, m[1])
		v := text[m[1]:end]
		if v == "" || notASecret(v, false) || (scheme == "" && !tokenish(v, 8)) {
			continue
		}
		out = append(out, span{start: m[1], end: end, kind: KindAuthHeader, rank: rankAuthHeader, shaped: scheme == ""})
	}
	for _, m := range bareBearer.FindAllStringIndex(text, -1) {
		end := token68At(text, m[1])
		if v := text[m[1]:end]; tokenish(v, 16) && !notASecret(v, false) {
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

func urlSpans(text string) []span {
	var out []span
	for _, m := range urlScheme.FindAllStringIndex(text, -1) {
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
		if s < e && !notASecret(text[s:e], false) {
			out = append(out, span{start: s, end: e, kind: KindURLPassword, rank: rankURLPassword})
		}
	}
	for _, m := range queryParam.FindAllStringSubmatchIndex(text, -1) {
		name := text[m[2]:m[3]]
		if !credentialKey(name) && !queryCredential[strings.ToLower(name)] {
			continue
		}
		end := m[1]
		for end < len(text) && !strings.ContainsRune("&#\"'<>`", rune(text[end])) && !isSpace(text[end]) {
			end++
		}
		e := trimUnquoted(text, m[1], end)
		if m[1] < e && !notASecret(text[m[1]:e], false) {
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
)

func assignmentSpans(text string) []span {
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
		if sp, ok := valueAt(text, v, KindAssignment, rankAssignment); ok {
			out = append(out, sp)
		}
	}
	for _, m := range flagKey.FindAllStringSubmatchIndex(text, -1) {
		v := skipBlanks(text, m[1])
		if !credentialKey(text[m[2]:m[3]]) || v >= len(text) || text[v] == '-' {
			continue
		}
		if sp, ok := valueAt(text, v, KindAssignment, rankAssignment); ok {
			out = append(out, sp)
		}
	}
	return out
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
func valueAt(text string, v int, kind string, rank int) (span, bool) {
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
	if end <= v || notASecret(text[v:end], false) {
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
// is YAML's escaped quote.
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
	// symbol) or a key word (a token-like value).
	proseWord = regexp.MustCompile(`(?i)(?:^|[^\pL\pN_])(password|passphrase|passwd|pwd|pass ?code|wachtwoord|passwort|kennwort|` +
		`contraseña|contrasena|senha|mot de passe|lösenord|losenord|salasana|hasło|haslo|пароль|` +
		`(?:api|access|secret|private|auth|bot|app|client|deploy|personal access|github|gitlab|npm|hf|openai)[ _-]?(?:key|token)|` +
		`key|token|secret)`)
	// What joins the word and its value: a copula, a colon or a blank; or
	// "for the database" and then a copula or a colon.
	proseCopula = `(?:[ \t]+(is|was|will be|is set to|=|->|→|to|ist|est|es|er|är|on|je):?[ \t]+|[ \t]*[:=][ \t]*)`
	proseLink   = regexp.MustCompile(`(?i)^(?:` + proseCopula + `|[ \t]+)`)
	proseFor    = regexp.MustCompile(`(?i)^[ \t]+(?:for|of|voor|für|pour|para)(?:[ \t]+[^\s.,;:!?"'` + "`" + `]{1,40}){1,4}?` + proseCopula)
	fence       = regexp.MustCompile("^```[\\w.+-]*[ \t]*\r?\n")
)

func isPasswordWord(w string) bool {
	w = strings.ToLower(w)
	return !strings.Contains(w, "key") && !strings.Contains(w, "token") && w != "secret"
}

func proseSpans(text string) []span {
	var out []span
	for _, m := range proseWord.FindAllStringSubmatchIndex(text, -1) {
		word := text[m[2]:m[3]]
		if r, _ := utf8.DecodeRuneInString(text[m[3]:]); m[3] < len(text) && isWordRune(r) {
			continue // a longer word
		}
		if publicKeyBefore(text, m[2]) {
			continue
		}
		pw := isPasswordWord(word)
		if sp, ok := fencedAfter(text, m[3]); ok {
			out = append(out, sp)
			continue
		}
		l := proseFor.FindStringSubmatchIndex(text[m[3]:])
		if l == nil {
			if l = proseLink.FindStringSubmatchIndex(text[m[3]:]); l == nil {
				continue
			}
		}
		copula := l[2] >= 0 || strings.ContainsAny(text[m[3]:m[3]+l[1]], ":=")
		v := m[3] + l[1]
		if v >= len(text) {
			continue
		}
		if s, e, ok := quotedAt(text, v); ok {
			if val := text[s:e]; s < e && !notASecret(val, true) && (pw || len(val) >= 8) {
				out = append(out, span{start: s, end: e, kind: KindProse, rank: rankProse, shaped: !pw})
			}
			continue
		}
		e := trimUnquoted(text, v, blankAt(text, v))
		val := text[v:e]
		if e <= v || notASecret(val, false) {
			continue
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
		if ok {
			out = append(out, span{start: v, end: e, kind: KindProse, rank: rankProse, shaped: true})
		}
	}
	return out
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
// quoted: it was between quotes (a dotted name is then a literal).
func notASecret(v string, quoted bool) bool {
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
	if !quoted {
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
