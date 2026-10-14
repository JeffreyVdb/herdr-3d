package transcript

import (
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #21: Codex's code changes. What a patch did comes from what Codex
// recorded of it (a FileChange item, codex-cli 0.147+; a patch_apply_end
// event, 0.145-0.146): the files with their real line numbers. A patch's
// own text (a direct apply_patch's input, the string literals an exec
// script passes to tools.apply_patch) only says what it proposes.

// codexChange is one file of a recorded patch (codex-rs FileChange):
// {type: add, content} | {type: delete, content} | {type: update,
// unified_diff, move_path}.
type codexChange struct {
	Type        string  `json:"type"`
	Content     string  `json:"content"`
	UnifiedDiff string  `json:"unified_diff"`
	MovePath    *string `json:"move_path"`
}

// fileChangeDiffs are a recorded patch's files as diffs, sorted by path:
// the record is a map, so the patch's own order is lost (Go's decoding
// loses it too). A created file is its content added, a deleted one its
// content removed, an update its unified diff's hunks.
func fileChangeDiffs(changes map[string]codexChange) []proto.TranscriptDiff {
	paths := make([]string, 0, len(changes))
	for p := range changes {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	out := make([]proto.TranscriptDiff, 0, len(paths))
	for _, p := range paths {
		c := changes[p]
		d := proto.TranscriptDiff{Path: p, Hunks: []proto.TranscriptHunk{}}
		switch c.Type {
		case "add":
			d.Op = proto.DiffCreate
			if lines := contentLines(c.Content, "+"); len(lines) > 0 {
				d.Hunks = append(d.Hunks, proto.TranscriptHunk{NewStart: 1, NewLines: len(lines), Lines: lines})
			}
		case "delete":
			d.Op = proto.DiffDelete
			if lines := contentLines(c.Content, "-"); len(lines) > 0 {
				d.Hunks = append(d.Hunks, proto.TranscriptHunk{OldStart: 1, OldLines: len(lines), Lines: lines})
			}
		default: // update
			d.Op = proto.DiffEdit
			if c.MovePath != nil && *c.MovePath != "" {
				d.Op, d.To = proto.DiffRename, *c.MovePath
			}
			d.Hunks = unifiedHunks(c.UnifiedDiff)
		}
		out = append(out, d)
	}
	return out
}

// contentLines is a file's content as diff lines, each with prefix (none
// for an empty file).
func contentLines(content, prefix string) []string {
	if content == "" {
		return nil
	}
	lines := strings.Split(strings.TrimSuffix(content, "\n"), "\n")
	for i, s := range lines {
		lines[i] = prefix + s
	}
	return lines
}

// unifiedHunks reads a unified diff's hunks ("@@ -a,b +c,d @@" and their
// lines; a count left out is 1). File headers and anything before the
// first hunk are skipped.
func unifiedHunks(diff string) []proto.TranscriptHunk {
	out := []proto.TranscriptHunk{}
	var cur *proto.TranscriptHunk
	for _, line := range strings.Split(strings.TrimSuffix(diff, "\n"), "\n") {
		if strings.HasPrefix(line, "@@") {
			h, ok := hunkHeader(line)
			if !ok {
				cur = nil
				continue
			}
			out = append(out, h)
			cur = &out[len(out)-1]
			continue
		}
		if cur == nil || line == "" {
			continue
		}
		switch line[0] {
		case ' ', '-', '+', '\\':
			cur.Lines = append(cur.Lines, line)
		}
	}
	return out
}

// hunkHeader reads "@@ -a[,b] +c[,d] @@[ section]".
func hunkHeader(line string) (proto.TranscriptHunk, bool) {
	f := strings.Fields(line)
	if len(f) < 4 || f[0] != "@@" || f[3] != "@@" {
		return proto.TranscriptHunk{}, false
	}
	os, ol, ok1 := hunkRange(f[1], '-')
	ns, nl, ok2 := hunkRange(f[2], '+')
	if !ok1 || !ok2 {
		return proto.TranscriptHunk{}, false
	}
	return proto.TranscriptHunk{OldStart: os, OldLines: ol, NewStart: ns, NewLines: nl, Lines: []string{}}, true
}

func hunkRange(s string, sign byte) (start, n int, ok bool) {
	if len(s) < 2 || s[0] != sign {
		return 0, 0, false
	}
	a, b, has := strings.Cut(s[1:], ",")
	start, err := strconv.Atoi(a)
	if err != nil || start < 0 {
		return 0, 0, false
	}
	n = 1
	if has {
		if n, err = strconv.Atoi(b); err != nil || n < 0 {
			return 0, 0, false
		}
	}
	return start, n, true
}

// parsePatch reads apply_patch's patch format ("*** Begin Patch", "***
// Update File: p", "*** Move to: q", "@@ …", "-old", "+new", " ctx") into
// diffs, one per file, in the patch's order: what it proposes. Its hunks
// have no line numbers (0), and a deleted file's lines are not in it
// (NoDiff).
func parsePatch(patch string) []proto.TranscriptDiff {
	var out []proto.TranscriptDiff
	var cur *proto.TranscriptDiff
	var hunk *proto.TranscriptHunk
	flush := func() {
		if cur != nil && hunk != nil && len(hunk.Lines) > 0 {
			cur.Hunks = append(cur.Hunks, *hunk)
		}
		hunk = nil
	}
	file := func(path, op string) {
		flush()
		out = append(out, proto.TranscriptDiff{Path: strings.TrimSpace(path), Op: op, NoDiff: op == proto.DiffDelete, Hunks: []proto.TranscriptHunk{}})
		cur = &out[len(out)-1]
	}
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "*** Update File: "):
			file(strings.TrimPrefix(line, "*** Update File: "), proto.DiffEdit)
		case strings.HasPrefix(line, "*** Add File: "):
			file(strings.TrimPrefix(line, "*** Add File: "), proto.DiffCreate)
		case strings.HasPrefix(line, "*** Delete File: "):
			file(strings.TrimPrefix(line, "*** Delete File: "), proto.DiffDelete)
		case strings.HasPrefix(line, "*** Move to: "):
			if cur != nil {
				cur.Op, cur.To = proto.DiffRename, strings.TrimSpace(strings.TrimPrefix(line, "*** Move to: "))
			}
		case strings.HasPrefix(line, "***"): // Begin/End Patch, End of File
		case cur == nil:
		case strings.HasPrefix(line, "@@"):
			flush()
			hunk = &proto.TranscriptHunk{}
		case line != "" && (line[0] == '+' || line[0] == '-' || line[0] == ' '):
			if hunk == nil {
				hunk = &proto.TranscriptHunk{}
			}
			hunk.Lines = append(hunk.Lines, line)
			switch line[0] {
			case '+':
				hunk.NewLines++
			case '-':
				hunk.OldLines++
			default:
				hunk.OldLines++
				hunk.NewLines++
			}
		}
	}
	flush()
	return out
}

// applyPatchCall is how a code-mode script calls the patch tool.
const applyPatchCall = "tools.apply_patch"

// patchLiterals are the patches a code-mode exec script passes to
// tools.apply_patch as one plain string literal ("…", '…', or `…` without
// a substitution), decoded, in order; unread counts the calls whose
// argument is anything else (a concatenation, a variable, an object): the
// script computes those, and nothing is made up for them. The script is
// only read, never run: a lexical pass finds the calls in its code, not in
// its comments, strings, templates or regular expressions, and a computed
// argument is skipped whole, so call text inside it is not a call. Where
// the script can't be read on (an argument with no end, a string with no
// close), the rest of it is not read.
func patchLiterals(code string) (patches []string, unread int) {
	s := patchScan{src: code}
	s.code(0, 0, true)
	return s.patches, s.unread
}

// patchScan reads a script's code for patchLiterals.
type patchScan struct {
	src     string
	patches []string
	unread  int
}

// code reads code from i up to the closer that ends its nesting level
// (none at the top) and returns the index just past it; false if the code
// ends first or a region in it can't be read. With count, the calls it
// finds are patches or unread; without (inside a computed argument), they
// are just code.
func (s *patchScan) code(i int, closer byte, count bool) (int, bool) {
	src := s.src
	last := "" // the previous token: a word, a number ("0") or punctuation
	for i < len(src) {
		c := src[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			i++
			continue
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			end := strings.IndexByte(src[i:], '\n')
			if end < 0 {
				return len(src), closer == 0
			}
			i += end + 1
			continue
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			end := strings.Index(src[i+2:], "*/")
			if end < 0 {
				return len(src), false
			}
			i += 2 + end + 2
			continue
		case c == '"' || c == '\'':
			end, ok := skipQuoted(src, i)
			if !ok {
				return len(src), false
			}
			i, last = end, "0"
		case c == '`':
			end, ok := s.template(i, count)
			if !ok {
				return len(src), false
			}
			i, last = end, "0"
		case c == '/' && regexAllowed(last):
			if end, ok := skipRegex(src, i); ok {
				i, last = end, "0"
			} else {
				i, last = i+1, "/"
			}
		case c >= '0' && c <= '9':
			for i < len(src) && (identByte(src[i]) || src[i] == '.') {
				i++
			}
			last = "0"
		case identByte(c) || c >= 0x80:
			j := i
			for j < len(src) && (identByte(src[j]) || src[j] >= 0x80) {
				j++
			}
			word := src[i:j]
			if count && word == "tools" && last != "." && strings.HasPrefix(src[j:], ".apply_patch") {
				if end, call, ok := s.call(j + len(".apply_patch")); call {
					if !ok {
						return len(src), false
					}
					i, last = end, ")"
					continue
				}
			}
			i, last = j, word
		case c == '(' || c == '[' || c == '{':
			end, ok := s.code(i+1, closing(c), count)
			if !ok {
				return len(src), false
			}
			i, last = end, string(closing(c))
		case c == ')' || c == ']' || c == '}':
			if closer == 0 {
				i, last = i+1, string(c) // a stray closer: not a script that runs
				continue
			}
			return i + 1, c == closer
		default:
			i, last = i+1, string(c)
		}
	}
	return len(src), closer == 0
}

// call reads a tools.apply_patch call whose name ends at i: call is false
// if it is a longer name or only a mention. A plain literal argument is a
// patch; any other is unread and skipped whole. ok is false if the
// argument has no end.
func (s *patchScan) call(i int) (end int, call, ok bool) {
	if i < len(s.src) && identByte(s.src[i]) {
		return 0, false, true // tools.apply_patches: another name
	}
	k := skipSpace(s.src, i)
	if k >= len(s.src) || s.src[k] != '(' {
		return 0, false, true // a mention, not a call
	}
	if lit, end, ok := jsString(s.src, skipSpace(s.src, k+1)); ok {
		if end = skipSpace(s.src, end); end < len(s.src) && s.src[end] == ')' {
			s.patches = append(s.patches, lit)
			return end + 1, true, true
		}
	}
	s.unread++
	end, ok = s.code(k+1, ')', false)
	return end, true, ok
}

// template skips the template literal at i, reading its substitutions as
// code, and returns the index just past it.
func (s *patchScan) template(i int, count bool) (int, bool) {
	src := s.src
	for i++; i < len(src); {
		switch {
		case src[i] == '\\':
			i += 2
		case src[i] == '`':
			return i + 1, true
		case src[i] == '$' && i+1 < len(src) && src[i+1] == '{':
			end, ok := s.code(i+2, '}', count)
			if !ok {
				return len(src), false
			}
			i = end
		default:
			i++
		}
	}
	return len(src), false
}

// skipQuoted skips the '…' or "…" string at i; false if it has no close
// on its line.
func skipQuoted(src string, i int) (int, bool) {
	q := src[i]
	for i++; i < len(src); {
		switch src[i] {
		case q:
			return i + 1, true
		case '\n', '\r':
			return len(src), false
		case '\\':
			if strings.HasPrefix(src[i+1:], "\r\n") {
				i++ // a line continuation
			}
			i += 2
		default:
			i++
		}
	}
	return len(src), false
}

// skipRegex skips the regular expression literal at i and its flags;
// false if it has no close on its line (then the / is a division).
func skipRegex(src string, i int) (int, bool) {
	class := false
	for i++; i < len(src); i++ {
		switch src[i] {
		case '\n', '\r':
			return 0, false
		case '\\':
			i++
		case '[':
			class = true
		case ']':
			class = false
		case '/':
			if !class {
				for i++; i < len(src) && identByte(src[i]); i++ {
				}
				return i, true
			}
		}
	}
	return 0, false
}

// regexAllowed is whether a / after the token last starts a regular
// expression rather than a division: not after a value.
func regexAllowed(last string) bool {
	switch last {
	case "", "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
		"throw", "case", "do", "else", "yield", "await":
		return true
	case "0", ")", "]", "}":
		return false
	}
	return !identByte(last[0]) && last[0] < 0x80
}

func closing(c byte) byte {
	switch c {
	case '(':
		return ')'
	case '[':
		return ']'
	}
	return '}'
}

func identByte(c byte) bool {
	return c == '_' || c == '$' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}

func skipSpace(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r') {
		i++
	}
	return i
}

// jsString decodes the JavaScript string literal at s[i:] (quoted with ",
// ' or a backtick without ${…}) and returns where it ends. Escapes: \n \r
// \t \b \f \v \0, \xXX, \uXXXX, \u{X…}, a line continuation, and any other
// character escaping itself (\+). A legacy octal escape, a raw line break
// in a quoted string and a substitution are not read.
func jsString(s string, i int) (string, int, bool) {
	if i >= len(s) || (s[i] != '"' && s[i] != '\'' && s[i] != '`') {
		return "", 0, false
	}
	q := s[i]
	var b strings.Builder
	for i++; i < len(s); {
		c := s[i]
		switch {
		case c == q:
			return b.String(), i + 1, true
		case q == '`' && c == '$' && i+1 < len(s) && s[i+1] == '{':
			return "", 0, false
		case q != '`' && (c == '\n' || c == '\r'):
			return "", 0, false
		case c != '\\':
			b.WriteByte(c)
			i++
			continue
		}
		// An escape.
		i++
		if i >= len(s) {
			return "", 0, false
		}
		e := s[i]
		i++
		switch e {
		case 'n':
			b.WriteByte('\n')
		case 'r':
			b.WriteByte('\r')
		case 't':
			b.WriteByte('\t')
		case 'b':
			b.WriteByte('\b')
		case 'f':
			b.WriteByte('\f')
		case 'v':
			b.WriteByte('\v')
		case '0':
			if i < len(s) && s[i] >= '0' && s[i] <= '9' {
				return "", 0, false // legacy octal
			}
			b.WriteByte(0)
		case '1', '2', '3', '4', '5', '6', '7', '8', '9':
			return "", 0, false // legacy octal (\8 \9 are not allowed in templates either)
		case 'x':
			if i+2 > len(s) {
				return "", 0, false
			}
			n, err := strconv.ParseUint(s[i:i+2], 16, 8)
			if err != nil {
				return "", 0, false
			}
			b.WriteRune(rune(n))
			i += 2
		case 'u':
			r, next, ok := jsUnicode(s, i)
			if !ok {
				return "", 0, false
			}
			// A surrogate pair is two escapes.
			if r >= 0xD800 && r <= 0xDBFF && next+1 < len(s) && s[next] == '\\' && s[next+1] == 'u' {
				if lo, after, ok := jsUnicode(s, next+2); ok && lo >= 0xDC00 && lo <= 0xDFFF {
					r, next = (r-0xD800)<<10+(lo-0xDC00)+0x10000, after
				}
			}
			if !utf8.ValidRune(r) {
				r = utf8.RuneError
			}
			b.WriteRune(r)
			i = next
		case '\r': // a line continuation (\r\n is one)
			if i < len(s) && s[i] == '\n' {
				i++
			}
		case '\n':
		default:
			// Any other character escapes itself; a multi-byte one is copied whole.
			_, size := utf8.DecodeRuneInString(s[i-1:])
			if r, _ := utf8.DecodeRuneInString(s[i-1:]); r == ' ' || r == ' ' {
				i += size - 1 // a line continuation
				continue
			}
			b.WriteString(s[i-1 : i-1+size])
			i += size - 1
		}
	}
	return "", 0, false
}

// jsUnicode reads the XXXX or {X…} of a \u escape at s[i:].
func jsUnicode(s string, i int) (rune, int, bool) {
	if i < len(s) && s[i] == '{' {
		end := strings.IndexByte(s[i:], '}')
		if end < 2 || end > 7 {
			return 0, 0, false
		}
		n, err := strconv.ParseUint(s[i+1:i+end], 16, 32)
		if err != nil || n > 0x10FFFF {
			return 0, 0, false
		}
		return rune(n), i + end + 1, true
	}
	if i+4 > len(s) {
		return 0, 0, false
	}
	n, err := strconv.ParseUint(s[i:i+4], 16, 16)
	if err != nil {
		return 0, 0, false
	}
	return rune(n), i + 4, true
}
