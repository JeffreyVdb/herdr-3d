// Package packup finds, in a prompt you send a worker, the part that tells
// it to leave once the task is done ("make a PR, then go home and clean up
// the worktree"), so the game can send only the task and the worker home
// after it (#110).
//
// Two models do the work, both from the generic AI integration (#92):
//
//  1. the gate: the classifier scores "does the prompt ask the worker to go
//     home or finish its session after the task?"; below the threshold
//     nothing else happens and the prompt goes as written;
//  2. the extraction: the LLM lists the spans to remove, as JSON. It never
//     rewrites: each span must be an exact substring of the prompt, found in
//     order, and is cut out; only whitespace and punctuation at the joins are
//     tidied. Anything invalid (bad JSON, a span not in the prompt, one over
//     an image) is no match: a failure never eats a prompt.
//
// Image markers ("[Image #n: path]") are protected: the models see each as
// "[Image #n]", never its path, and a span over one is invalid. A prompt is
// capped (its tail) before it goes to a model, and never logged.
//
// The package takes only the ai.Classifier and ai.LLM interfaces, never a
// vendor client (TestPackupUsesOnlyAIInterfaces). Nothing is called unless
// the feature is switched on and both roles are ready (Service.Detect).
package packup

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// GateQuestion is the yes/no question the classifier scores.
const GateQuestion = "After the task, does the prompt tell the AI coding agent to wrap up and leave (go home, leave the office, clean up its worktree, end its session)?"

// MaxPromptChars bounds what is sent of a prompt: its last 8000 characters
// (a prompt is at most 16 KiB; the leaving part ends it).
const MaxPromptChars = 8000

// MaxSpans bounds the spans the LLM may list.
const MaxSpans = 8

// Range is a removed part of the prompt: [Start, End) in UTF-16 code units,
// as JavaScript indexes a string.
type Range struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Result is what Run made of a prompt.
type Result struct {
	Score float64
	// Matched: the gate passed and the extraction was valid. Task is then
	// the prompt with the leaving part cut out ("" when nothing is left),
	// Removed the parts cut.
	Matched bool
	Task    string
	Removed []Range
	// ExtractErr is why a passing gate is no match ("" when it is one, or
	// the gate did not pass). It may carry the provider's words, which can
	// echo the prompt: never log it, log ExtractCode.
	ExtractErr string
	// ExtractCode is ExtractErr as a fixed code, safe to log: "llm_<kind>"
	// (the LLM's call failed, ai.Kind), "bad_answer" (its answer is not a
	// list of parts) or "bad_part" (a part not in the prompt, or over an
	// image).
	ExtractCode string
}

// imageMarker is an image in a prompt: "[Image #n: path]" (#64), or a bare
// "[Image #n]".
var imageMarker = regexp.MustCompile(`\[Image #(\d+)(?:: [^\]\n]+)?\]`)

// view is what a model sees of a prompt: its tail from byte base, each
// image marker in it shown as "[Image #n]".
type view struct {
	text  string
	base  int
	marks []mark
}

// mark is one image marker: where its stand-in is in the view, and where
// the marker is in the prompt.
type mark struct{ vStart, vEnd, pStart, pEnd int }

// modelView makes the view of prompt: its last MaxPromptChars characters
// (never starting inside an image marker), the markers masked.
func modelView(prompt string) view {
	base := 0
	if n := utf8.RuneCountInString(prompt); n > MaxPromptChars {
		for i := range prompt {
			if n == MaxPromptChars {
				base = i
				break
			}
			n--
		}
	}
	locs := imageMarker.FindAllStringSubmatchIndex(prompt, -1)
	for _, l := range locs {
		if l[0] < base && base < l[1] {
			base = l[1]
		}
	}
	v := view{base: base}
	var b strings.Builder
	at := base
	for _, l := range locs {
		if l[0] < base {
			continue
		}
		b.WriteString(prompt[at:l[0]])
		stand := "[Image #" + prompt[l[2]:l[3]] + "]"
		start := b.Len()
		b.WriteString(stand)
		v.marks = append(v.marks, mark{vStart: start, vEnd: b.Len(), pStart: l[0], pEnd: l[1]})
		at = l[1]
	}
	b.WriteString(prompt[at:])
	v.text = b.String()
	return v
}

// at is the prompt's byte offset of view offset i (never inside a stand-in).
func (v view) at(i int) int {
	d := v.base
	for _, m := range v.marks {
		if m.vEnd <= i {
			d += (m.pEnd - m.pStart) - (m.vEnd - m.vStart)
		}
	}
	return i + d
}

// Run gates prompt with the classifier and, when the score reaches
// threshold, has the LLM say what to cut. Only a failure of the classifier
// is an error: a failed or invalid extraction is no match.
func Run(ctx context.Context, c ai.Classifier, l ai.LLM, prompt string, threshold float64) (*Result, error) {
	return run(ctx, c, l, prompt, threshold, nil)
}

// run is Run; with ready, a passing gate goes to the LLM only while ready
// still holds (the feature switched off, or a role gone invalid, during the
// classification): else no call, ai.ErrNotReady.
func run(ctx context.Context, c ai.Classifier, l ai.LLM, prompt string, threshold float64, ready func() bool) (*Result, error) {
	v := modelView(prompt)
	score, err := c.Classify(ctx, map[string]any{"prompt": v.text}, GateQuestion)
	if err != nil {
		return nil, err
	}
	res := &Result{Score: score}
	if score < threshold {
		return res, nil
	}
	if ready != nil && !ready() {
		return nil, ai.ErrNotReady
	}
	spans, err := Extract(ctx, l, v.text)
	code := "bad_answer"
	if k := ai.KindOf(err); k != "" {
		code = "llm_" + string(k)
	}
	if err == nil {
		code = "bad_part"
		res.Task, res.Removed, err = cut(prompt, v, spans)
	}
	if err != nil {
		res.Task, res.Removed, res.ExtractErr, res.ExtractCode = "", nil, err.Error(), code
		return res, nil
	}
	res.Matched = true
	return res, nil
}

const extractSystem = `You read a prompt a user sends to an AI coding agent. Besides the task, the prompt may tell the agent to leave once the task is done: go home, stop working, end its turn or session, sign off, clean up or remove its worktree, and the like.

List the exact parts of the prompt to remove so that only the task is left. Reply with only a JSON object, no prose and no code fence:
{"remove":["..."]}

Rules:
- Each entry is copied character for character from the prompt (same case, spaces and punctuation). Never reword, never add text.
- List them in the order they appear in the prompt, at most 8.
- Include the joining words and punctuation that belong to the leaving part (", then", " and", "After that,"), so what is left reads as the task alone.
- Never remove a part of the task itself, even when it stops or ends something inside the task (stopping a server, ending a function, deleting a branch the task is about).
- Never remove an image placeholder such as "[Image #1]".
- If the whole prompt is only about leaving, list all of it.
- If nothing asks the agent to leave, reply {"remove":[]}.`

// Extract asks the LLM for the spans to remove of text and validates their
// shape (Parse).
func Extract(ctx context.Context, l ai.LLM, text string) ([]string, error) {
	temp := 0.0
	out, err := l.Complete(ctx, ai.Request{
		Messages: []ai.Message{
			{Role: "system", Content: extractSystem},
			{Role: "user", Content: "The prompt:\n\n" + text},
		},
		Temperature: &temp,
		MaxTokens:   600,
		JSON:        true,
	})
	if err != nil {
		return nil, err
	}
	return Parse(out)
}

// Parse reads the LLM's answer (the first JSON object in it): 1-8 spans,
// each with something besides whitespace. Anything else rejects it.
func Parse(text string) ([]string, error) {
	obj, ok := ai.FirstJSONObject(text)
	if !ok {
		return nil, fmt.Errorf("the LLM did not answer with a JSON object")
	}
	var raw struct {
		Remove *[]string `json:"remove"`
	}
	if err := json.Unmarshal([]byte(obj), &raw); err != nil || raw.Remove == nil {
		return nil, fmt.Errorf("the LLM's JSON is not a list of parts to remove")
	}
	spans := *raw.Remove
	switch n := len(spans); {
	case n == 0:
		return nil, fmt.Errorf("the LLM found nothing to remove")
	case n > MaxSpans:
		return nil, fmt.Errorf("the LLM listed %d parts (at most %d)", n, MaxSpans)
	}
	for i, s := range spans {
		if strings.TrimSpace(s) == "" {
			return nil, fmt.Errorf("part %d is empty", i+1)
		}
	}
	return spans, nil
}

// cut finds each span in the view, in order and each after the one before,
// and cuts them out of prompt. A span not found, or over an image's
// stand-in, is an error.
func cut(prompt string, v view, spans []string) (string, []Range, error) {
	type br struct{ s, e int } // prompt byte offsets
	var cuts []br
	pos := 0
	for i, sp := range spans {
		j := strings.Index(v.text[pos:], sp)
		if j < 0 {
			return "", nil, fmt.Errorf("part %d is not in the prompt (in order)", i+1)
		}
		s, e := pos+j, pos+j+len(sp)
		for _, m := range v.marks {
			if s < m.vEnd && m.vStart < e {
				return "", nil, fmt.Errorf("part %d would remove an image", i+1)
			}
		}
		pos = e
		ps, pe := v.at(s), v.at(e)
		if n := len(cuts); n > 0 && cuts[n-1].e == ps {
			cuts[n-1].e = pe
			continue
		}
		cuts = append(cuts, br{ps, pe})
	}
	pieces := make([]string, 0, len(cuts)+1)
	removed := make([]Range, 0, len(cuts))
	at := 0
	for _, c := range cuts {
		pieces = append(pieces, prompt[at:c.s])
		removed = append(removed, Range{Start: utf16Len(prompt[:c.s]), End: utf16Len(prompt[:c.e])})
		at = c.e
	}
	pieces = append(pieces, prompt[at:])
	return tidy(pieces), removed, nil
}

// separators may be left dangling at a join.
const separators = ",;:–—-"

// tidy joins the pieces left of a prompt: at each join the spaces go, a
// separator left dangling before the end or before punctuation goes, and the
// pieces meet with one space (or the line break one of them has). The
// pieces' own text is never changed.
func tidy(pieces []string) string {
	acc := pieces[0]
	for i, p := range pieces[1:] {
		last := i == len(pieces)-2
		if strings.TrimSpace(p) == "" && !last {
			continue // between two cuts: nothing of the task
		}
		acc = join(acc, p)
	}
	return strings.TrimSpace(acc)
}

func join(left, right string) string {
	l := strings.TrimRight(left, " \t")
	r := strings.TrimLeft(right, " \t")
	switch {
	case strings.TrimSpace(l) == "":
		return strings.TrimLeft(r, " \t\r\n"+separators+".")
	case strings.TrimSpace(r) == "":
		return strings.TrimRight(l, " \t\r\n"+separators)
	case strings.ContainsAny(r[:1], ".,;:!?)"):
		return strings.TrimRight(l, " \t"+separators) + r
	case strings.HasSuffix(l, "\n") || strings.HasPrefix(r, "\n") || strings.HasPrefix(r, "\r"):
		return l + r
	}
	return l + " " + r
}

// utf16Len is how many UTF-16 code units s is (an invalid byte one, as
// U+FFFD).
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
