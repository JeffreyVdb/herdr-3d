package handoffllm

// Validation of a model's handoff (#9): the structure the prompt asks for,
// checked before anything is filed. It proves the shape, never the facts
// (the quality spike, docs/research/handoff-summarizer.md, is that gate).
// Its errors name what is wrong, never quote the answer.

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// Limits of a handoff document; MaxTitle and MaxBody equal internal/handoff's
// (TestHandoffLLMLimitsMatchTheCabinet).
const (
	MaxTitle = 80
	MaxBody  = 1 << 20
)

// ErrInvalid is an answer that is not a handoff of the agreed shape; the
// error says which rule it broke.
var ErrInvalid = errors.New("the LLM's answer is not a valid handoff")

// Validate checks a model's answer and returns the document to file: one
// leading H1 title of at most MaxTitle characters and no other, every
// heading of Sections as an H2, some text under them, valid UTF-8, at most
// maxBytes (0: MaxBody) bytes. A document the model wrapped whole in one
// Markdown code fence is unwrapped; nothing else is changed.
func Validate(text string, maxBytes int) (string, error) {
	if maxBytes <= 0 || maxBytes > MaxBody {
		maxBytes = MaxBody
	}
	doc := strings.TrimSpace(unfence(strings.TrimSpace(text)))
	switch {
	case doc == "":
		return "", fmt.Errorf("%w: it is empty", ErrInvalid)
	case !utf8.ValidString(doc):
		return "", fmt.Errorf("%w: it is not valid UTF-8", ErrInvalid)
	case len(doc) > maxBytes:
		return "", fmt.Errorf("%w: it is %d bytes, above the %d allowed", ErrInvalid, len(doc), maxBytes)
	}
	lines := strings.Split(doc, "\n")
	if t, ok := heading(lines[0], 1); !ok {
		return "", fmt.Errorf("%w: it does not start with a \"# \" title", ErrInvalid)
	} else if t == "" {
		return "", fmt.Errorf("%w: its title is empty", ErrInvalid)
	} else if n := utf8.RuneCountInString(t); n > MaxTitle {
		return "", fmt.Errorf("%w: its title is %d characters, above %d", ErrInvalid, n, MaxTitle)
	}
	want := map[string]bool{}
	for _, s := range Sections {
		want[strings.ToLower(s)] = true
	}
	seen := map[string]bool{}
	text0 := false
	fence := ""
	for _, l := range lines[1:] {
		tl := strings.TrimSpace(l)
		if f := fenceMark(tl); f != "" {
			switch {
			case fence == "":
				fence = f
			case strings.HasPrefix(tl, fence) && strings.TrimLeft(tl, fence[:1]) == "":
				fence = ""
			}
			text0 = true
			continue
		}
		if fence != "" {
			text0 = text0 || tl != ""
			continue
		}
		if _, ok := heading(l, 1); ok {
			return "", fmt.Errorf("%w: it has more than one \"# \" title", ErrInvalid)
		}
		if h, ok := heading(l, 2); ok {
			if k := strings.ToLower(strings.TrimRight(h, ":")); want[k] {
				seen[k] = true
			}
			continue
		}
		if tl != "" {
			text0 = true
		}
	}
	var missing []string
	for _, s := range Sections {
		if !seen[strings.ToLower(s)] {
			missing = append(missing, s)
		}
	}
	if len(missing) > 0 {
		return "", fmt.Errorf("%w: sections missing: %s", ErrInvalid, strings.Join(missing, ", "))
	}
	if !text0 {
		return "", fmt.Errorf("%w: its sections are empty", ErrInvalid)
	}
	return doc + "\n", nil
}

// heading is the text of an ATX heading of exactly level (at most 3 spaces
// in), and whether l is one.
func heading(l string, level int) (string, bool) {
	t := strings.TrimLeft(l, " ")
	if len(l)-len(t) > 3 {
		return "", false
	}
	mark := strings.Repeat("#", level)
	if !strings.HasPrefix(t, mark) {
		return "", false
	}
	rest := t[level:]
	if rest != "" && rest[0] != ' ' && rest[0] != '\t' {
		return "", false // "##" for level 1, or "#title"
	}
	rest = strings.TrimSpace(rest)
	rest = strings.TrimSpace(strings.TrimRight(rest, "#")) // closing marks
	return strings.Join(strings.Fields(rest), " "), true
}

// fenceMark is the fence a line opens or closes (``` or ~~~, and longer),
// "" when it is none.
func fenceMark(tl string) string {
	for _, c := range []string{"`", "~"} {
		n := len(tl) - len(strings.TrimLeft(tl, c))
		if n >= 3 {
			return strings.Repeat(c, n)
		}
	}
	return ""
}

// unfence takes off one code fence wrapping the whole text (```markdown …
// ```), as models are wont to add; a text not wholly fenced is returned as
// it is.
func unfence(s string) string {
	first, rest, ok := strings.Cut(s, "\n")
	if !ok {
		return s
	}
	f := fenceMark(first)
	info := strings.ToLower(strings.TrimSpace(strings.TrimLeft(first, f[:min(1, len(f))])))
	if f == "" || (info != "" && info != "markdown" && info != "md") {
		return s
	}
	body := strings.TrimRight(rest, " \n\t")
	i := strings.LastIndex(body, "\n")
	last := body[i+1:]
	if strings.TrimSpace(last) != f {
		return s
	}
	if i < 0 {
		return ""
	}
	return body[:i]
}
