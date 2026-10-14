package handoffllm

import (
	"cmp"
	"regexp"
	"slices"
	"strings"
)

// The outgoing-text policy (#9): what Scrub removes before anything goes to
// the configured LLM. It is not ai.Scrub (that one is for error text, and
// its catch-all for any 32+ character run would erase the commit SHAs,
// UUIDs and session ids a handoff needs as evidence). Every rule is
// anchored on a known prefix, a key name or a fixed shape; there is no
// generic "long random string" rule. All patterns are RE2 (linear time),
// so no input makes Scrub hang.

// Redaction categories, in the order the rules run (configured_secret, the
// caller's literals, runs first).
const (
	catConfigured  = "configured_secret"
	catDataURI     = "data_uri"
	catPrivateKey  = "private_key"
	catURLCreds    = "url_credentials"
	catSlackHook   = "slack_webhook"
	catAWSKeyID    = "aws_access_key"
	catAWSSecret   = "aws_secret_key"
	catGitHub      = "github_token"
	catAnthropic   = "anthropic_key"
	catOpenAI      = "openai_key"
	catStripe      = "stripe_key"
	catSlack       = "slack_token"
	catGoogle      = "google_api_key"
	catJWT         = "jwt"
	catAuthHeader  = "auth_header"
	catAssignment  = "secret_assignment"
	redactedPrefix = "[redacted:"
)

// scrubCategories are every category Scrub can count.
var scrubCategories = []string{catConfigured, catDataURI, catPrivateKey, catURLCreds, catSlackHook, catAWSKeyID,
	catAWSSecret, catGitHub, catAnthropic, catOpenAI, catStripe, catSlack, catGoogle, catJWT, catAuthHeader, catAssignment}

// scrubRule replaces submatch group of each match of re with the category's
// marker, unless keep says the matched value is not a secret.
type scrubRule struct {
	cat   string
	re    *regexp.Regexp
	group int
	keep  func(value string) bool
	// hints: the rule runs only when the text (lower-cased when fold) holds
	// one of them; Go's regexp has no literal prefix to skip ahead with
	// for most rules, and most text holds no secret.
	hints []string
	fold  bool
}

// assignKey is a key name that holds a secret: password, secret, token,
// api key, access key, private key, credential(s), auth token, passphrase.
const assignKey = `(?:passw(?:or)?d|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth[_-]?token)`

// assignHints are assignKey's words, lower case.
var assignHints = []string{"passw", "passphrase", "secret", "token", "api", "access", "private", "credential", "auth"}

var scrubRules = []scrubRule{
	// An inline image or file: never text; the reducer replaces images
	// before this, so this is the belt to its braces.
	{cat: catDataURI, re: regexp.MustCompile(`data:[A-Za-z0-9.+/-]{1,100}(?:;[A-Za-z0-9=.+-]{1,100}){0,5};base64,[A-Za-z0-9+/]{16,}={0,2}`), hints: []string{";base64,"}},
	// PEM private keys (RSA, EC, DSA, OPENSSH, PGP, ENCRYPTED…), whole
	// block; then a block cut before its END line, to the end of the run
	// of key-like characters (bodies hold / and +).
	{cat: catPrivateKey, re: regexp.MustCompile(`-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----`), hints: []string{"PRIVATE KEY"}},
	{cat: catPrivateKey, re: regexp.MustCompile(`-----BEGIN[ A-Z0-9]{0,40}PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s:,\\-]*`), hints: []string{"PRIVATE KEY"}},
	// scheme://user:password@host: the password only.
	{cat: catURLCreds, re: regexp.MustCompile(`\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\s:/@\[\]]{1,200}:([^\s/@]{1,200})@`), group: 1, keep: placeholder, hints: []string{"://"}},
	{cat: catSlackHook, re: regexp.MustCompile(`(?:https?://)?hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/_-]{20,300}`), hints: []string{"hooks.slack.com"}},
	{cat: catAWSKeyID, re: regexp.MustCompile(`\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b`), hints: []string{"AKIA", "ASIA", "ABIA", "ACCA", "A3T"}},
	{cat: catAWSSecret, re: regexp.MustCompile(`(?i)\b(?:aws)?_?secret(?:_?access)?_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?:[^A-Za-z0-9/+=]|$)`), group: 1, hints: []string{"secret"}, fold: true},
	{cat: catGitHub, re: regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{16,255}|github_pat_[A-Za-z0-9_]{20,255})\b`), hints: []string{"ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"}},
	{cat: catAnthropic, re: regexp.MustCompile(`\bsk-ant-[a-z0-9]{2,12}-[A-Za-z0-9_-]{16,300}`), hints: []string{"sk-ant-"}},
	{cat: catOpenAI, re: regexp.MustCompile(`\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,300}`), keep: notKeyLike, hints: []string{"sk-"}},
	{cat: catStripe, re: regexp.MustCompile(`\b[sr]k_(?:test|live|prod)_[A-Za-z0-9]{6,99}\b`), hints: []string{"k_test_", "k_live_", "k_prod_"}},
	{cat: catSlack, re: regexp.MustCompile(`\bxox[a-z]-[A-Za-z0-9-]{6,250}`), hints: []string{"xox"}},
	{cat: catGoogle, re: regexp.MustCompile(`\bAIza[0-9A-Za-z_-]{30,40}`), hints: []string{"AIza"}},
	{cat: catJWT, re: regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]{4,})?`), hints: []string{"eyJ"}},
	// Authorization headers (Bearer, Basic, token…), then a bearer token
	// in prose (with a digit: "the bearer of" is not one).
	{cat: catAuthHeader, re: regexp.MustCompile(`(?i)\bauthorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|bot)\s+)?([A-Za-z0-9._~+/=-]{8,})`), group: 1, keep: placeholder, hints: []string{"authorization"}, fold: true},
	{cat: catAuthHeader, re: regexp.MustCompile(`(?i)\bbearer\s+([A-Za-z0-9._~+/=-]{16,})`), group: 1, keep: notKeyLike, hints: []string{"bearer"}, fold: true},
	// key = value, key: value, "key": "value" (also .env lines) where the
	// key names a secret; the value only.
	{cat: catAssignment, re: regexp.MustCompile(`(?i)` + assignKey + `[A-Za-z0-9_.-]{0,40}["']?\s*[:=]\s*["']?([^\s"'` + "`" + `;,]{6,200})`), group: 1, keep: notAssignedSecret, hints: assignHints, fold: true},
}

// placeholder reports a value that stands for a secret without being one:
// $VAR, ${VAR}, <name>, %s, {{x}}, ***, xxxx, an earlier marker.
func placeholder(v string) bool {
	if v == "" || strings.HasPrefix(v, redactedPrefix) {
		return true
	}
	switch v[0] {
	case '$', '<', '%', '{', '*', '[':
		return true
	}
	l := strings.ToLower(v)
	switch l {
	case "password", "pass", "passwd", "secret", "token", "changeme", "example":
		return true
	}
	return strings.Trim(l, "x") == ""
}

// notKeyLike: a key has letters and digits ("sk-learn-is-nice" and "bearer
// tokens-are-useful" are prose).
func notKeyLike(v string) bool {
	return placeholder(v) || !strings.ContainsAny(v, "0123456789") ||
		!strings.ContainsAny(strings.ToLower(v), "abcdefghijklmnopqrstuvwxyz")
}

// notAssignedSecret: values an assignment to a secret-named key holds in
// code and config without being a secret: numbers (max_tokens: 1024),
// booleans, type names (token: string), calls and environment lookups.
func notAssignedSecret(v string) bool {
	if placeholder(v) || strings.ContainsAny(v, "()") {
		return true
	}
	if strings.Trim(v, "0123456789.-_") == "" {
		return true
	}
	l := strings.ToLower(v)
	switch l {
	case "true", "false", "null", "nil", "none", "undefined", "string", "number", "boolean", "bool", "int", "str",
		"bytes", "any", "object", "required", "optional", "unknown", "redacted", "hidden", "inherit":
		return true
	}
	for _, p := range []string{"process.env", "os.environ", "os.getenv", "env.", "secrets.", "vars.", "self.", "this."} {
		if strings.HasPrefix(l, p) {
			return true
		}
	}
	return false
}

// Scrub is the dedicated outgoing-text policy for anything sent to the
// configured LLM (transcript text, the user's focus instruction, provenance
// strings). Each secret becomes "[redacted:<category>]"; it returns the
// scrubbed text and the count of redactions by category, never the secret
// text. secrets are extra literals to remove (e.g. the configured API key);
// blank ones remove nothing. Scrubbing scrubbed text changes nothing.
func Scrub(text string, secrets ...string) (string, map[string]int) {
	counts := map[string]int{}
	lits := make([]string, 0, len(secrets))
	for _, s := range secrets {
		if strings.TrimSpace(s) != "" && !slices.Contains(lits, s) {
			lits = append(lits, s)
		}
	}
	// Longest first, so a secret holding another goes whole.
	slices.SortFunc(lits, func(a, b string) int { return cmp.Or(len(b)-len(a), strings.Compare(a, b)) })
	for _, s := range lits {
		if n := strings.Count(text, s); n > 0 {
			text = strings.ReplaceAll(text, s, marker(catConfigured))
			counts[catConfigured] += n
		}
	}
	lower := strings.ToLower(text) // for hints only: markers added below never make a match
	for _, r := range scrubRules {
		if r.hinted(text, lower) {
			text = r.apply(text, counts)
		}
	}
	return text, counts
}

func marker(cat string) string { return redactedPrefix + cat + "]" }

func (r scrubRule) hinted(text, lower string) bool {
	if r.fold {
		text = lower
	}
	for _, h := range r.hints {
		if strings.Contains(text, h) {
			return true
		}
	}
	return len(r.hints) == 0
}

func (r scrubRule) apply(s string, counts map[string]int) string {
	ms := r.re.FindAllStringSubmatchIndex(s, -1)
	if len(ms) == 0 {
		return s
	}
	var b strings.Builder
	last := 0
	for _, m := range ms {
		from, to := m[2*r.group], m[2*r.group+1]
		if from < 0 || (r.keep != nil && r.keep(s[from:to])) {
			continue
		}
		b.WriteString(s[last:from])
		b.WriteString(marker(r.cat))
		last = to
		counts[r.cat]++
	}
	if last == 0 {
		return s
	}
	b.WriteString(s[last:])
	return b.String()
}
