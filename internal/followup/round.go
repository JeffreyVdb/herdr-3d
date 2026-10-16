package followup

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// #60: a grill round read without a model. Agents that grill the user (the
// grill-me / grilling skills) write their questions in one regular shape:
//
//	❓ **Q9** - **Asleep floor at fire time**: A hire on an asleep floor returns `invalid_state`. …
//	- (a) Auto-wake the floor, then hire.
//	- (b) Mark the schedule `failed: floor_asleep` and notify.
//	- (c) Per-schedule checkbox "wake floor if asleep", default on.
//
//	➡️ (c), default on. The whole point is not having to remember. …
//
// A message in that shape is read here, deterministically and whole: every
// block is a question with its own label (Q9), its title as the question,
// the rest of what it says as Markdown context, its options and the agent's
// recommendation. Nothing goes to the LLM. What it tolerates:
//
//   - the header: `❓ **Qn** <sep> **Title**[:] body` or `❓ **Qn <sep> Title[.:]** body`, <sep> a hyphen, en or
//     em dash, colon or period; the title's trailing colon or period is dropped;
//   - options: lettered bullets (`- (a) …`, also `**(a)**`), else letters inline in the body (`(a) … (b) …`, from
//     (a), in order), else plain bullets when none of them is itself a question (a bullet with a `?` is a
//     sub-question: it stays in the context and the question is open); 2–8 of them, or none;
//   - the recommendation: the `➡️` line and the lines right under it, up to a blank line; one that starts with a
//     letter (`(c), default on.`) names that option;
//   - text before the first block, between a recommendation and the next block, and after the last one is not a
//     question (the full message keeps it).
//
// Anything else that starts with ❓ (outside a code fence) makes the message
// no round: the LLM reads it instead, so a block is never dropped silently.
// Over MaxRoundQuestions blocks, the rest are counted (Followup.Unlisted).

// MaxRoundQuestions bounds the questions read from one round.
const MaxRoundQuestions = 30

// Bounds of a question's Markdown parts, in characters (longer is cut, with
// "…": the full message has the rest).
const (
	MaxContextLen        = 1200
	MaxRecommendationLen = 1200
	MaxWhyLen            = 600
	MaxLabelLen          = 12
)

// ErrNotARound: the message has no ❓ block.
var ErrNotARound = errors.New("not a grill round")

var (
	// ❓ **Q9** - **Title**: body
	headerApart = regexp.MustCompile(`^\*\*([Qq]\d{1,3})\*\*\s*[-–—:.]?\s*\*\*(.+?)\*\*(.*)$`)
	// ❓ **Q17 - Title.** body
	headerJoint = regexp.MustCompile(`^\*\*([Qq]\d{1,3})\s*[-–—:.]\s*(.+?)\*\*(.*)$`)
	// - (a) text, **(a)** text
	letterBullet = regexp.MustCompile(`^(?:[-*+]\s+)?\*{0,2}\(([a-z])\)\*{0,2}\s+(.*)$`)
	plainBullet  = regexp.MustCompile(`^[-*+]\s+(.*)$`)
	inlineLetter = regexp.MustCompile(`\(([a-h])\)\s`)
	recLetter    = regexp.MustCompile(`^[*_\s]*\(([a-z])\)`)
	fence        = regexp.MustCompile("^\\s*(```|~~~)")
)

// question mark and arrow, each with or without the emoji variation selector
const (
	markQuestion = "❓"
	markArrow    = "➡"
	selector     = "️"
)

// ParseRound reads text as a grill round: its questions (ids q1…), and how
// many blocks were over MaxRoundQuestions. ErrNotARound when it has no ❓
// block; another error says which block is not in the round's shape.
func ParseRound(text string) ([]Question, int, error) {
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	type block struct {
		label, title string
		lines        []string // the header's rest, then the lines under it
	}
	var blocks []block
	seen := map[string]bool{}
	inFence := false
	for _, ln := range lines {
		if fence.MatchString(ln) {
			inFence = !inFence
		}
		t := strings.TrimSpace(ln)
		if inFence || !strings.HasPrefix(t, markQuestion) {
			if len(blocks) > 0 {
				b := &blocks[len(blocks)-1]
				b.lines = append(b.lines, ln)
			}
			continue
		}
		h := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(t, markQuestion), selector))
		m := headerApart.FindStringSubmatch(h)
		if m == nil {
			m = headerJoint.FindStringSubmatch(h)
		}
		if m == nil {
			return nil, 0, fmt.Errorf("block %d does not start like ❓ **Q1** - **Title**: %q", len(blocks)+1, clip(h, 60))
		}
		label := strings.ToUpper(m[1])
		if seen[label] {
			return nil, 0, fmt.Errorf("%s is asked twice", label)
		}
		seen[label] = true
		title := strings.TrimRight(oneLine(m[2]), ":.")
		if title == "" {
			return nil, 0, fmt.Errorf("%s has no title", label)
		}
		rest := strings.TrimLeft(strings.TrimSpace(m[3]), ":.–—- ")
		blocks = append(blocks, block{label: label, title: title, lines: []string{rest}})
	}
	if len(blocks) == 0 {
		return nil, 0, ErrNotARound
	}
	unlisted := 0
	if len(blocks) > MaxRoundQuestions {
		unlisted = len(blocks) - MaxRoundQuestions
		blocks = blocks[:MaxRoundQuestions]
	}
	out := make([]Question, 0, len(blocks))
	for i, b := range blocks {
		q := roundQuestion(b.lines)
		q.ID, q.Label, q.Question = fmt.Sprintf("q%d", i+1), b.label, clip(b.title, MaxQuestionLen)
		out = append(out, q)
	}
	return out, unlisted, nil
}

// roundQuestion reads one block's lines (after its title): the body up to
// the ➡️ line, the recommendation from there to a blank line.
func roundQuestion(lines []string) Question {
	var body, rec []string
	inRec, recDone := false, false
	for _, ln := range lines {
		t := strings.TrimSpace(ln)
		switch {
		case recDone:
		case inRec && t == "":
			recDone = len(rec) > 0
		case inRec:
			rec = append(rec, t)
		case strings.HasPrefix(t, markArrow):
			inRec = true
			if r := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(t, markArrow), selector)); r != "" {
				rec = append(rec, r)
			}
		default:
			body = append(body, ln)
		}
	}
	q := Question{Kind: KindOpen}
	context, options := roundOptions(body)
	if len(options) >= MinOptions {
		q.Kind, q.Options = KindChoice, options
	}
	q.Context = clip(strings.TrimSpace(context), MaxContextLen)
	if text := strings.TrimSpace(strings.Join(rec, "\n")); text != "" {
		r := &Recommendation{Text: clip(text, MaxRecommendationLen)}
		if m := recLetter.FindStringSubmatch(text); m != nil && q.Kind == KindChoice {
			if k := int(m[1][0] - 'a'); k < len(q.Options) {
				r.Option = &k
			}
		}
		q.Recommendation = r
	}
	return q
}

// roundOptions splits a block's body into its context (Markdown) and its
// options: lettered bullets, else letters inline, else plain bullets none of
// which asks something. Options are one line each, as written (letter kept).
func roundOptions(body []string) (string, []string) {
	var lettered, plain []item
	for i := 0; i < len(body); i++ {
		t := strings.TrimSpace(body[i])
		lead := len(body[i]) - len(strings.TrimLeft(body[i], " \t"))
		var it *item
		if m := letterBullet.FindStringSubmatch(t); m != nil && lead < 2 {
			lettered = append(lettered, item{letter: m[1], text: m[2], at: i, n: 1})
			it = &lettered[len(lettered)-1]
		} else if m := plainBullet.FindStringSubmatch(t); m != nil && lead < 2 {
			plain = append(plain, item{text: m[1], at: i, n: 1})
			it = &plain[len(plain)-1]
		}
		if it == nil {
			continue
		}
		// An item's own lines: indented, not blank.
		for i+1 < len(body) && strings.TrimSpace(body[i+1]) != "" && strings.HasPrefix(body[i+1], "  ") &&
			!plainBullet.MatchString(strings.TrimSpace(body[i+1])) {
			i++
			it.text += " " + strings.TrimSpace(body[i])
			it.n++
		}
	}
	without := func(items []item) string {
		drop := map[int]bool{}
		for _, it := range items {
			for k := range it.n {
				drop[it.at+k] = true
			}
		}
		var keep []string
		for i, ln := range body {
			if !drop[i] {
				keep = append(keep, ln)
			}
		}
		return strings.Join(keep, "\n")
	}
	labels := func(items []item, letters bool) []string {
		var out []string
		for _, it := range items {
			o := oneLine(it.text)
			if letters {
				o = "(" + it.letter + ") " + o
			}
			out = append(out, clip(o, MaxOptionLen))
		}
		return out
	}
	if inOrder(lettered) && len(lettered) >= MinOptions && len(lettered) <= MaxOptions {
		return without(lettered), labels(lettered, true)
	}
	if len(lettered) < MinOptions { // one "(a) …" line is the inline kind
		if ctx, opts := inlineOptions(strings.Join(body, "\n")); opts != nil {
			return ctx, opts
		}
	}
	if len(lettered) == 0 && len(plain) >= MinOptions && len(plain) <= MaxOptions {
		asks := false
		for _, it := range plain {
			asks = asks || strings.Contains(it.text, "?")
		}
		if !asks {
			return without(plain), labels(plain, false)
		}
	}
	return strings.Join(body, "\n"), nil
}

// item is an option bullet of a block's body.
type item struct {
	letter string
	text   string
	at     int // its first line in the body
	n      int // how many lines
}

// inOrder: the items' letters are a, b, c… in order.
func inOrder(items []item) bool {
	for i, it := range items {
		if it.letter != string(rune('a'+i)) {
			return false
		}
	}
	return true
}

// inlineOptions finds options written in one paragraph, `(a) … (b) …`, from
// (a) on in order: the text before (a) is the context. nil when there are
// fewer than two.
func inlineOptions(body string) (string, []string) {
	idx := inlineLetter.FindAllStringSubmatchIndex(body, -1)
	var at []int
	for _, m := range idx {
		if body[m[2]] == byte('a'+len(at)) {
			at = append(at, m[0])
		}
	}
	if len(at) < MinOptions || len(at) > MaxOptions {
		return "", nil
	}
	if strings.Contains(body[at[0]:], "\n\n") {
		return "", nil // not one paragraph
	}
	var opts []string
	for i, start := range at {
		end := len(body)
		if i+1 < len(at) {
			end = at[i+1]
		}
		opts = append(opts, clip(oneLine(body[start:end]), MaxOptionLen))
	}
	return body[:at[0]], opts
}
