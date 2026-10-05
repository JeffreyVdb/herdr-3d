package harness

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #138: the composer keeps harness-neutral text (/skill, @path); the bridge
// rewrites the tokens the user picked for the worker's harness when the
// prompt is sent. Translate is the pure part: no I/O, the catalog and the
// file check come in as arguments.

// promptRules is how one harness spells what the composer picked. A harness
// with no row gets its text untouched (Claude Code reads /skill and @path
// itself).
type promptRules struct {
	// skillSigil replaces the "/" of a known skill ("" keeps it).
	skillSigil string
	// bareFiles drops the "@" of a file mention that resolves.
	bareFiles bool
	// retryKeys are the keys to press, for a prompt whose submit stalled,
	// instead of a lone Enter (nil: Enter).
	retryKeys func(text string) []string
}

// harnessRules is keyed by harness kind. Add a row here, not an `if kind`
// in the prompt path.
var harnessRules = map[string]promptRules{
	// Codex runs a skill from "$name" and reads a path as plain text; a
	// pasted "/name" is a built-in or an unknown command to it.
	//
	// A prompt that ends in a "$skill" token (even "use $skill.") leaves
	// Codex's skill popup open, which takes the submitting Enter: Esc closes
	// it, then Enter submits (checked on codex-cli 0.160.0, #138).
	"codex": {skillSigil: "$", bareFiles: true, retryKeys: func(text string) []string {
		if endsInSkillToken(text, "$") {
			return []string{"esc", "enter"}
		}
		return nil
	}},
}

// RetryKeys are the keys that press submit again for a prompt to harness
// whose Enter was dropped: a lone Enter, unless the harness's rules know
// the text needs more (a popup to close first).
func RetryKeys(kind, text string) []string {
	if r, ok := harnessRules[kind]; ok && r.retryKeys != nil {
		if keys := r.retryKeys(text); keys != nil {
			return keys
		}
	}
	return []string{"enter"}
}

// endsInSkillToken reports whether the last word of text is a sigil+name
// token, with the prose punctuation after it that Translate leaves outside
// a name: "$zzprobe", "(use $zzprobe.", "and $caveman:caveman-commit!".
func endsInSkillToken(text, sigil string) bool {
	word := text[strings.LastIndexFunc(text, unicode.IsSpace)+1:]
	word = strings.TrimRight(word, trailingProse)
	i := strings.LastIndex(word, sigil)
	if i < 0 || i+len(sigil) == len(word) || (i > 0 && !startsWord(word, i)) {
		return false
	}
	for _, r := range word[i+len(sigil):] {
		if !nameRune(r) {
			return false
		}
	}
	return true
}

// Rewrites reports whether Translate may change a prompt for this harness
// kind: false lets the caller skip the lookups it would feed Translate.
func Rewrites(kind string) bool {
	_, ok := harnessRules[kind]
	return ok
}

// Composer spellings of a file with spaces in its name: "@"path with spaces"".
// A path without spaces is "@path". Both end at the end of the token (a
// quoted one at its closing quote), so a trailing "." or ")" is prose.
const fileQuote = '"'

// Translate rewrites text for the harness kind:
//
//   - "/name" becomes sigil+name when name is a skill in cmds (not a
//     built-in, not a name a built-in also has) and the "/" starts a word:
//     at the start of the text or after a space or an opening quote or
//     bracket. "/usr/bin/env", "http://x/y", "a/b" and "/name/more" stay.
//     The whole name token is looked up, so a skill that is a prefix of
//     another never changes the longer one; trailing "." ":" "-" are tried
//     off the token ("use /review.").
//   - "@path" loses its "@" when resolveFile says path is a file or
//     directory of the worker's checkout, and the "@" starts a word.
//     "@someone" and "me@example.com" stay. A path with spaces is written
//     @"a b/c.go" and comes out as the plain path, a b/c.go.
//
// A kind with no rules, empty text, or nothing that matches gives text back
// as it is. A nil resolveFile resolves nothing.
func Translate(kind, text string, cmds []proto.CommandEntry, resolveFile func(path string) bool) string {
	r, ok := harnessRules[kind]
	if !ok || text == "" {
		return text
	}
	var skills map[string]bool
	if r.skillSigil != "" {
		skills = skillNames(cmds)
	}
	var b strings.Builder
	done := 0 // text[:done] is in b
	for i := 0; i < len(text); {
		c := text[i]
		if c == '[' { // #64: an image marker is the game's, byte for byte
			if n := imageMarker(text[i:]); n > 0 {
				i += n
				continue
			}
		}
		if (c != '/' && c != '@') || !startsWord(text, i) {
			i++
			continue
		}
		var end int
		var out string
		var hit bool
		switch {
		case c == '/' && len(skills) > 0:
			end, out, hit = slashToken(text, i, r.skillSigil, skills)
		case c == '@' && r.bareFiles && resolveFile != nil:
			end, out, hit = atToken(text, i, resolveFile)
		}
		if !hit {
			i++
			continue
		}
		b.WriteString(text[done:i])
		b.WriteString(out)
		done, i = end, end
	}
	if done == 0 {
		return text
	}
	b.WriteString(text[done:])
	return b.String()
}

// skillNames are the names Translate may rewrite: skills, minus any name
// that is also a built-in (the built-in is what /name runs).
func skillNames(cmds []proto.CommandEntry) map[string]bool {
	skills := map[string]bool{}
	builtin := map[string]bool{}
	for _, c := range cmds {
		switch c.Kind {
		case proto.CommandKindSkill:
			skills[c.Name] = true
		case proto.CommandKindBuiltin:
			builtin[c.Name] = true
		}
	}
	for n := range builtin {
		delete(skills, n)
	}
	return skills
}

// startsWord reports whether the token at i begins a word: the text starts
// there, or a space or an opening quote or bracket is before it.
func startsWord(text string, i int) bool {
	if i == 0 {
		return true
	}
	p, _ := utf8.DecodeLastRuneInString(text[:i])
	return unicode.IsSpace(p) || strings.ContainsRune("([{\"'", p)
}

// nameRune is what a skill name is made of ("caveman:caveman-commit").
func nameRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '-' || r == '.' || r == ':'
}

// slashToken reads the "/name" at text[i]: the end of the token it rewrites
// and what it becomes.
func slashToken(text string, i int, sigil string, skills map[string]bool) (end int, out string, hit bool) {
	j := i + 1
	for j < len(text) {
		r, n := utf8.DecodeRuneInString(text[j:])
		if !nameRune(r) {
			break
		}
		j += n
	}
	if j < len(text) && text[j] == '/' { // "/name/more" is a path
		return 0, "", false
	}
	name := text[i+1 : j]
	for name != "" {
		if skills[name] {
			return i + 1 + len(name), sigil + name, true
		}
		if !strings.HasSuffix(name, ".") && !strings.HasSuffix(name, ":") && !strings.HasSuffix(name, "-") {
			break
		}
		name = name[:len(name)-1]
	}
	return 0, "", false
}

// trailingProse is what ends a sentence or a bracket after a path.
const trailingProse = ".,;:!?)]}'\""

// atToken reads the "@path" or @"quoted path" at text[i].
func atToken(text string, i int, resolve func(string) bool) (end int, out string, hit bool) {
	rest := text[i+1:]
	if strings.HasPrefix(rest, string(fileQuote)) {
		q := strings.IndexAny(rest[1:], "\"\r\n")
		if q < 0 || rest[1+q] != '"' {
			return 0, "", false
		}
		path := rest[1 : 1+q]
		if !validPath(path) || !resolve(path) {
			return 0, "", false
		}
		return i + 1 + 1 + q + 1, path, true
	}
	j := strings.IndexFunc(rest, unicode.IsSpace)
	if j < 0 {
		j = len(rest)
	}
	tok := rest[:j]
	for tok != "" {
		if validPath(tok) && resolve(tok) {
			return i + 1 + len(tok), tok, true
		}
		if !strings.ContainsRune(trailingProse, rune(tok[len(tok)-1])) {
			break
		}
		tok = tok[:len(tok)-1]
	}
	return 0, "", false
}

func validPath(p string) bool {
	return p != "" && !strings.ContainsRune(p, 0) && utf8.ValidString(p)
}

// imageMarker is the length of the "[Image #n: path]" marker s starts with
// (0: it does not start with one). The path may hold spaces, "/" and "@",
// but no "]" (the game checks that before it sends).
func imageMarker(s string) int {
	const head = "[Image #"
	if !strings.HasPrefix(s, head) {
		return 0
	}
	i := len(head)
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i == len(head) || !strings.HasPrefix(s[i:], ": ") {
		return 0
	}
	end := strings.IndexAny(s[i:], "]\r\n")
	if end < 0 || s[i+end] != ']' {
		return 0
	}
	return i + end + 1
}
