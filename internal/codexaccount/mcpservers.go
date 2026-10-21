package codexaccount

// #167: the MCP server names a config.toml declares, for the drift words
// and the hire note. The file holds API keys (an MCP server's env, a URL's
// token), so the names come from keys alone: the file is scanned as TOML,
// every value (the four kinds of string, an array, an inline table, a
// number, a date) is skipped whole, and text inside a value that looks like
// a [mcp_servers.<name>] header is never taken. A file that does not scan to
// its end names none: a guess could name a value.

import (
	"bytes"
	"os"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// mcpServers are the MCP servers the config.toml at path declares, sorted:
// the <name> of each key path that starts mcp_servers.<name> (a table
// header, a sub-table, a dotted key, or a key of an inline table); none
// when there is no such file. ok is false when the file cannot be read or
// is not TOML as scanned here.
func mcpServers(path string) (names []string, ok bool) {
	if _, err := os.Stat(path); isNotExist(err) {
		return []string{}, true
	}
	b, ok := readRegular(path)
	if !ok {
		return nil, false
	}
	names = []string{}
	s := tomlScan{b: b, seen: func(p []string) {
		if len(p) >= 2 && p[0] == "mcp_servers" && !slices.Contains(names, p[1]) {
			names = append(names, p[1])
		}
	}}
	if !s.document() {
		return nil, false
	}
	slices.Sort(names)
	return names, true
}

// tomlScan walks a TOML document's keys, skipping its values: seen gets
// each table header's key path and each key's full path (its table's, then
// its own; inside an inline table, the table's key first). Keys inside an
// array are not paths and are not passed.
type tomlScan struct {
	b    []byte
	i    int
	seen func(path []string)
}

func (s *tomlScan) peek() byte {
	if s.i < len(s.b) {
		return s.b[s.i]
	}
	return 0
}

func (s *tomlScan) has(p string) bool { return bytes.HasPrefix(s.b[s.i:], []byte(p)) }

// blank skips spaces and tabs.
func (s *tomlScan) blank() {
	for s.peek() == ' ' || s.peek() == '\t' {
		s.i++
	}
}

// comment skips a comment up to its line's end.
func (s *tomlScan) comment() {
	if s.peek() != '#' {
		return
	}
	if n := bytes.IndexByte(s.b[s.i:], '\n'); n >= 0 {
		s.i += n
	} else {
		s.i = len(s.b)
	}
}

// newline skips one line end.
func (s *tomlScan) newline() bool {
	switch {
	case s.has("\r\n"):
		s.i += 2
	case s.peek() == '\n':
		s.i++
	default:
		return false
	}
	return true
}

// eol ends a line: blanks, a comment, then a line end or the file's end.
func (s *tomlScan) eol() bool {
	s.blank()
	s.comment()
	return s.i == len(s.b) || s.newline()
}

// gap skips blanks, comments and line ends (between lines, and between the
// items of an array or inline table).
func (s *tomlScan) gap() {
	for {
		s.blank()
		s.comment()
		if !s.newline() {
			return
		}
	}
}

// document scans the whole file: headers and key = value lines.
func (s *tomlScan) document() bool {
	if s.has("\xef\xbb\xbf") {
		s.i += len("\xef\xbb\xbf")
	}
	var table []string
	for {
		s.gap()
		if s.i == len(s.b) {
			return true
		}
		if s.peek() == '[' {
			end := "]"
			if s.has("[[") {
				end = "]]"
			}
			s.i += len(end)
			s.blank()
			path, ok := s.key()
			if !ok || !s.has(end) {
				return false
			}
			s.i += len(end)
			if !s.eol() {
				return false
			}
			table = path
			s.seen(path)
			continue
		}
		k, ok := s.keyValue()
		if !ok {
			return false
		}
		path := append(slices.Clone(table), k...)
		s.seen(path)
		if !s.value(path) || !s.eol() {
			return false
		}
	}
}

// keyValue scans "key =" up to its value: the key.
func (s *tomlScan) keyValue() ([]string, bool) {
	k, ok := s.key()
	if !ok || s.peek() != '=' {
		return nil, false
	}
	s.i++
	s.blank()
	return k, true
}

// key scans a dotted key (blanks around its dots, and after it).
func (s *tomlScan) key() ([]string, bool) {
	var out []string
	for {
		var part string
		var ok bool
		switch {
		case s.has(`"""`), s.has("'''"):
			return nil, false
		case s.peek() == '"':
			part, ok = s.basic()
		case s.peek() == '\'':
			part, ok = s.literal()
		default:
			start := s.i
			for s.i < len(s.b) && bareKey(s.b[s.i]) {
				s.i++
			}
			part, ok = string(s.b[start:s.i]), s.i > start
		}
		if !ok {
			return nil, false
		}
		out = append(out, part)
		s.blank()
		if s.peek() != '.' {
			return out, true
		}
		s.i++
		s.blank()
	}
}

func bareKey(c byte) bool {
	return 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || c == '_' || c == '-'
}

// basic scans a one-line "basic string", its escapes decoded.
func (s *tomlScan) basic() (string, bool) {
	s.i++
	var out strings.Builder
	for s.i < len(s.b) {
		switch c := s.b[s.i]; c {
		case '"':
			s.i++
			return out.String(), true
		case '\n', '\r':
			return "", false
		case '\\':
			r, n, ok := escape(s.b[s.i+1:])
			if !ok {
				return "", false
			}
			out.WriteRune(r)
			s.i += 1 + n
		default:
			out.WriteByte(c)
			s.i++
		}
	}
	return "", false
}

// escape decodes the escape after a backslash in b: its rune and length.
func escape(b []byte) (rune, int, bool) {
	if len(b) == 0 {
		return 0, 0, false
	}
	var n int
	switch b[0] {
	case 'b':
		return '\b', 1, true
	case 't':
		return '\t', 1, true
	case 'n':
		return '\n', 1, true
	case 'f':
		return '\f', 1, true
	case 'r':
		return '\r', 1, true
	case 'e':
		return '\x1b', 1, true
	case '"', '\\':
		return rune(b[0]), 1, true
	case 'x':
		n = 2
	case 'u':
		n = 4
	case 'U':
		n = 8
	}
	if n == 0 || len(b) < 1+n {
		return 0, 0, false
	}
	v, err := strconv.ParseUint(string(b[1:1+n]), 16, 32)
	if err != nil || !utf8.ValidRune(rune(v)) {
		return 0, 0, false
	}
	return rune(v), 1 + n, true
}

// literal scans a one-line 'literal string'.
func (s *tomlScan) literal() (string, bool) {
	s.i++
	start := s.i
	for s.i < len(s.b) {
		switch s.b[s.i] {
		case '\'':
			s.i++
			return string(s.b[start : s.i-1]), true
		case '\n', '\r':
			return "", false
		}
		s.i++
	}
	return "", false
}

// multi skips a multi-line string opened by quote (""" or ”', escapes only
// in the first): it ends at the first closing quote that is not escaped,
// with up to two more quote marks of its content just before it.
func (s *tomlScan) multi(quote string, escapes bool) bool {
	s.i += len(quote)
	for s.i < len(s.b) {
		switch {
		case s.has(quote):
			s.i += len(quote)
			for n := 0; n < 2 && s.peek() == quote[0]; n++ {
				s.i++
			}
			return true
		case escapes && s.peek() == '\\':
			s.i += 2
		default:
			s.i++
		}
	}
	return false
}

// value skips one value. Under path (nil: inside an array) the keys of an
// inline table are paths too.
func (s *tomlScan) value(path []string) bool {
	switch {
	case s.has(`"""`):
		return s.multi(`"""`, true)
	case s.has("'''"):
		return s.multi("'''", false)
	case s.peek() == '"':
		_, ok := s.basic()
		return ok
	case s.peek() == '\'':
		_, ok := s.literal()
		return ok
	case s.peek() == '[':
		s.i++
		for {
			s.gap()
			if s.peek() == ']' {
				s.i++
				return true
			}
			if !s.value(nil) {
				return false
			}
			s.gap()
			switch s.peek() {
			case ',':
				s.i++
			case ']':
				s.i++
				return true
			default:
				return false
			}
		}
	case s.peek() == '{':
		s.i++
		for {
			s.gap()
			if s.peek() == '}' {
				s.i++
				return true
			}
			k, ok := s.keyValue()
			if !ok {
				return false
			}
			var sub []string
			if path != nil {
				sub = append(slices.Clone(path), k...)
				s.seen(sub)
			}
			if !s.value(sub) {
				return false
			}
			s.gap()
			switch s.peek() {
			case ',':
				s.i++
			case '}':
				s.i++
				return true
			default:
				return false
			}
		}
	}
	// A number, a boolean, a date or a time (a date-time may have a space).
	start := s.i
	for s.i < len(s.b) && scalar(s.b[s.i]) {
		s.i++
	}
	return len(bytes.TrimSpace(s.b[start:s.i])) > 0
}

func scalar(c byte) bool {
	return bareKey(c) || c == '+' || c == '.' || c == ':' || c == ' ' || c == '\t'
}
