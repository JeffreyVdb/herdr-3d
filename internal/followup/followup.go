// Package followup finds the open questions in an agent's final message
// (#90). When a turn ends with free text that asks the user something (not an
// AskUserQuestion, which #57 covers), the bridge flags the worker as needing
// you and offers the questions on a card.
//
// Two models do the work, both from the generic AI integration (#92):
//
//  1. the gate: the classifier scores "is the agent asking the user something?"
//     for the message's tail; below the threshold nothing else happens;
//  2. the extraction: the LLM lists the questions as JSON, validated strictly.
//     When it fails or answers something invalid, the worker is still flagged
//     with one open item: a positive gate is never dropped.
//
// The package takes only the ai.Classifier and ai.LLM interfaces, never a
// vendor client (TestFollowupUsesOnlyAIInterfaces). Nothing is called unless
// the feature is switched on and both roles are ready (Service.Detect).
package followup

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// GateQuestion is the yes/no question the classifier scores.
const GateQuestion = "Is the agent asking the user for information, a decision, or an answer before it can continue?"

// MaxMessageChars bounds what is sent of a message: its last ~24k tokens,
// approximated as 4 characters per token (the end of a message is where its
// questions are).
const MaxMessageChars = 96_000

// Bounds of the extracted questions.
const (
	MaxQuestions   = 8
	MaxQuestionLen = 300 // characters
	MinOptions     = 2
	MaxOptions     = 8
	MaxOptionLen   = 120 // characters
	// TailChars is how much of the message a fallback item carries for the
	// card to show.
	TailChars = 1200
)

// Question kinds.
const (
	KindYesNo  = "yes_no"
	KindChoice = "choice"
	KindOpen   = "open"
)

// Sources of a Followup's questions.
const (
	SourceModel    = "model"
	SourceFallback = "fallback"
)

// FallbackQuestion is the one open item of a fallback.
const FallbackQuestion = "The agent asked you something"

// Question is one open question.
type Question struct {
	ID       string   `json:"id"`
	Question string   `json:"question"`
	Kind     string   `json:"kind"`
	Options  []string `json:"options,omitempty"`
}

// Followup is a worker's open questions (proto.Worker.Followup).
type Followup struct {
	// TurnID is the turn they were asked in: an answer names it.
	TurnID    string     `json:"turn_id"`
	Questions []Question `json:"questions"`
	Score     float64    `json:"score"`
	Source    string     `json:"source"`
	At        int64      `json:"at"` // unix ms
	// Tail is the end of the message, for a fallback's card.
	Tail string `json:"tail,omitempty"`
}

// Result is what Run made of a message.
type Result struct {
	Score float64
	// Flag: the score reached the threshold.
	Flag      bool
	Questions []Question
	Source    string
	// ExtractErr is why the extraction fell back ("" when it did not).
	ExtractErr string
}

// Tail is the end of text, at most n characters, cut at a rune boundary.
func Tail(text string, n int) string {
	if utf8.RuneCountInString(text) <= n {
		return text
	}
	r := []rune(text)
	return string(r[len(r)-n:])
}

// Run gates text with the classifier and, when the score reaches threshold,
// extracts its questions with the LLM. Only a failure of the classifier is
// an error: a failed extraction is the fallback item.
func Run(ctx context.Context, c ai.Classifier, l ai.LLM, text string, threshold float64) (*Result, error) {
	return run(ctx, c, l, text, threshold, nil)
}

// run is Run; with ready, a positive gate goes to the LLM only while ready
// still holds (the feature may have been switched off, or a role gone
// invalid, during the classification): else no call, ai.ErrNotReady.
func run(ctx context.Context, c ai.Classifier, l ai.LLM, text string, threshold float64, ready func() bool) (*Result, error) {
	tail := Tail(text, MaxMessageChars)
	score, err := c.Classify(ctx, map[string]any{"last_agent_message": tail}, GateQuestion)
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
	res.Flag = true
	qs, err := Extract(ctx, l, tail)
	if err != nil {
		res.Questions, res.Source, res.ExtractErr = Fallback(), SourceFallback, err.Error()
		return res, nil
	}
	res.Questions, res.Source = qs, SourceModel
	return res, nil
}

// Fallback is the one open item a worker gets when the extraction failed.
func Fallback() []Question {
	return []Question{{ID: "q1", Question: FallbackQuestion, Kind: KindOpen}}
}

const extractSystem = `You read the final message an AI coding agent wrote to its user at the end of a turn, and list the questions it asks the user: things it needs the user to answer, decide or confirm.

Reply with only a JSON object, no prose and no code fence:
{"questions":[{"question":"...","kind":"yes_no"|"choice"|"open","options":["..."]}]}

Rules:
- At most 8 questions, in the order the message asks them. Merge duplicates.
- Each question is one self-contained sentence of at most 300 characters, in the agent's words where possible.
- kind "yes_no": it can be answered with yes or no. No options.
- kind "choice": the agent offers or clearly implies alternatives. List them in "options": 2 to 8 short labels (at most 120 characters each). A choice between doing something now or later counts.
- kind "open": anything else. No options.
- Rhetorical questions, offers like "let me know if you need anything", and questions the agent answers itself are not questions.`

// Extract asks the LLM for the questions of text and validates them.
func Extract(ctx context.Context, l ai.LLM, text string) ([]Question, error) {
	temp := 0.0
	out, err := l.Complete(ctx, ai.Request{
		Messages: []ai.Message{
			{Role: "system", Content: extractSystem},
			{Role: "user", Content: "The agent's final message:\n\n" + text},
		},
		Temperature: &temp,
		MaxTokens:   1200,
		JSON:        true,
	})
	if err != nil {
		return nil, err
	}
	return Parse(out)
}

// Parse reads the LLM's answer (the first JSON object in it) and validates it
// strictly: 1-8 questions; each one non-empty and at most 300 characters, of
// a known kind; a choice with 2-8 non-empty options of at most 120
// characters each. Options of the other kinds are dropped (they are
// implied). Anything else rejects the whole answer.
func Parse(text string) ([]Question, error) {
	obj, ok := ai.FirstJSONObject(text)
	if !ok {
		return nil, fmt.Errorf("the LLM did not answer with a JSON object")
	}
	var raw struct {
		Questions []struct {
			Question string   `json:"question"`
			Kind     string   `json:"kind"`
			Options  []string `json:"options"`
		} `json:"questions"`
	}
	if err := json.Unmarshal([]byte(obj), &raw); err != nil {
		return nil, fmt.Errorf("the LLM's JSON is not a question list: %v", err)
	}
	switch n := len(raw.Questions); {
	case n == 0:
		return nil, fmt.Errorf("the LLM listed no question")
	case n > MaxQuestions:
		return nil, fmt.Errorf("the LLM listed %d questions (at most %d)", n, MaxQuestions)
	}
	out := make([]Question, 0, len(raw.Questions))
	for i, r := range raw.Questions {
		q := Question{ID: fmt.Sprintf("q%d", i+1), Question: oneLine(r.Question), Kind: r.Kind}
		switch n := utf8.RuneCountInString(q.Question); {
		case n == 0:
			return nil, fmt.Errorf("question %d is empty", i+1)
		case n > MaxQuestionLen:
			return nil, fmt.Errorf("question %d has %d characters (at most %d)", i+1, n, MaxQuestionLen)
		}
		switch q.Kind {
		case KindYesNo, KindOpen:
		case KindChoice:
			if n := len(r.Options); n < MinOptions || n > MaxOptions {
				return nil, fmt.Errorf("question %d is a choice of %d options (%d-%d)", i+1, n, MinOptions, MaxOptions)
			}
			for j, o := range r.Options {
				o = oneLine(o)
				if n := utf8.RuneCountInString(o); n == 0 || n > MaxOptionLen {
					return nil, fmt.Errorf("option %d of question %d has %d characters (1-%d)", j+1, i+1, n, MaxOptionLen)
				}
				q.Options = append(q.Options, o)
			}
		default:
			return nil, fmt.Errorf("question %d has kind %q (yes_no, choice or open)", i+1, clip(r.Kind, 20))
		}
		out = append(out, q)
	}
	return out, nil
}

// oneLine trims s and folds its whitespace runs (line ends included) into
// single spaces.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}
