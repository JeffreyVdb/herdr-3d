// Package followup finds the open questions in an agent's final message
// (#90). When a turn ends with free text that asks the user something (not an
// AskUserQuestion, which #57 covers), the bridge flags the worker as needing
// you and offers the questions on a card.
//
// Two models do the work, both from the generic AI integration (#92):
//
//  1. the gate: the classifier scores "is the agent asking the user something?"
//     for the message's tail; below the threshold nothing else happens;
//  2. the extraction: a grill round (❓ **Q1** … ➡️ …) is read as it is
//     (ParseRound, #60); anything else, the LLM lists the questions as JSON,
//     validated (Parse). When it fails or answers something invalid, the
//     worker is still flagged with one open item: a positive gate is never
//     dropped.
//
// The package takes only the ai.Classifier and ai.LLM interfaces, never a
// vendor client (TestFollowupUsesOnlyAIInterfaces). Nothing is called unless
// the feature is switched on and both roles are ready (Service.Detect).
package followup

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// GateQuestion is the yes/no question the classifier scores.
const GateQuestion = "Does the message ask the user one or more questions or decisions they are expected to answer, even when the agent proposes a recommended answer for each?"

// MaxMessageChars bounds what is sent of a message: its last ~24k tokens,
// approximated as 4 characters per token (the end of a message is where its
// questions are).
const MaxMessageChars = 96_000

// Bounds of the extracted questions.
const (
	// MaxQuestions bounds the questions the LLM lists (#60: 8 dropped two of
	// a ten-question round). Over it, the rest are counted, not shown
	// (Followup.Unlisted); a deterministic round takes MaxRoundQuestions.
	MaxQuestions   = 16
	MaxQuestionLen = 300 // characters
	MinOptions     = 2
	MaxOptions     = 8
	MaxOptionLen   = 300 // characters
	// TailChars is how much of the message a fallback item carries for the
	// card to show.
	TailChars = 1200
)

// #60: the extraction's call. A ten-question round with options, context
// and recommendations is ~1.6-2k completion tokens of JSON, and a reasoning
// model spends its budget on reasoning first (the incident: 1200 of 1200
// tokens reasoning, no text). So: a budget with room for both, low effort
// when the model's catalog lists it, and a timeout of its own (measured
// 14-20 s at low on the incident's round, 34 s at the provider's default,
// over the shared 15 s). Cut off or empty, once more with no reasoning,
// then the fallback; a timeout is not tried again (it may have been
// billed). docs/decisions.md has the measurements.
const (
	ExtractMaxTokens = 8192
	ExtractEffort    = "low"
	ExtractTimeout   = 45 * time.Second
	// The second try's effort: the first of these the model takes.
	retryNone    = "none"
	retryMinimal = "minimal"
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
	// SourceParsed: read from a grill round without the LLM (ParseRound).
	SourceParsed = "parsed"
)

// FallbackQuestion is the one open item of a fallback.
const FallbackQuestion = "The agent asked you something"

// Question is one open question.
type Question struct {
	ID string `json:"id"`
	// Label is the message's own name for it ("Q9"), "" when it has none:
	// the answer names it.
	Label    string   `json:"label,omitempty"`
	Question string   `json:"question"`
	Kind     string   `json:"kind"`
	Options  []string `json:"options,omitempty"`
	// Context is the rest of what the message says about it (Markdown):
	// its sub-questions, constraints, an option list that is no choice.
	Context string `json:"context,omitempty"`
	// Recommendation is the agent's own answer, for the user to accept or
	// override.
	Recommendation *Recommendation `json:"recommendation,omitempty"`
}

// Recommendation is the answer the agent proposes to a question.
type Recommendation struct {
	// Text is the proposed answer as the agent wrote it (Markdown): an open
	// question's whole answer when accepted.
	Text string `json:"text"`
	// Why is the agent's reason when the message gives it apart ("": it is
	// in Text, or none).
	Why string `json:"why,omitempty"`
	// Option is the index of the option it names, for a choice.
	Option *int `json:"option,omitempty"`
	// Cut: the agent's text is over MaxRecommendationLen bytes, more than an
	// answer may be, so Text is its start (with "…"). It is shown, never
	// accepted as the answer (its Option, sent whole, still is).
	Cut bool `json:"cut,omitempty"`
}

// recommendation is a Recommendation of text (trimmed Markdown, not empty):
// whole when an answer can hold it, else cut.
func recommendation(text string) *Recommendation {
	if len(text) <= MaxRecommendationLen {
		return &Recommendation{Text: text}
	}
	return &Recommendation{Text: clipBytes(text, MaxRecommendationLen), Cut: true}
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
	// Error is why the questions could not be read (a fallback's).
	Error string `json:"error,omitempty"`
	// Unlisted counts the questions the message asks that are not in
	// Questions (over the bounds, or unreadable): its full message has them.
	Unlisted int `json:"unlisted,omitempty"`
	// Retries counts the extractions tried again (worker.retry_followup).
	Retries int `json:"retries,omitempty"`
}

// Result is what Run made of a message.
type Result struct {
	Score float64
	// Flag: the score reached the threshold.
	Flag bool
	Extraction
}

// Extraction is what was made of a flagged message's questions.
type Extraction struct {
	Questions []Question
	Source    string
	Unlisted  int
	// ExtractErr is why the extraction fell back ("" when it did not).
	ExtractErr string
	// NotRound is why a message with ❓ blocks was not read as a round ("":
	// it was, or has none), for the log.
	NotRound string
	// Efforts are the reasoning efforts of the LLM calls made, in order
	// ("" for the provider's default): none for a round.
	Efforts []string
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
// extracts its questions (a grill round read as it is, else the LLM). Only a
// failure of the classifier is an error: a failed extraction is the fallback
// item. The model's reasoning efforts are not known here: none is sent.
func Run(ctx context.Context, c ai.Classifier, l ai.LLM, text string, threshold float64) (*Result, error) {
	return run(ctx, c, l, text, threshold, nil, ai.UnknownReasoning())
}

// run is Run; with ready, a positive gate goes to the LLM only while ready
// still holds (the feature may have been switched off, or a role gone
// invalid, during the classification): else no call, ai.ErrNotReady.
func run(ctx context.Context, c ai.Classifier, l ai.LLM, text string, threshold float64, ready func() bool, r ai.Reasoning) (*Result, error) {
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
	res.Extraction = Extract(ctx, l, text, r)
	return res, nil
}

// Extract reads the questions of a flagged message: a grill round as it is
// (no call), else with the LLM (ExtractLLM); failing that, the fallback item
// with why. r is what is known of the LLM's reasoning efforts.
func Extract(ctx context.Context, l ai.LLM, text string, r ai.Reasoning) Extraction {
	tail := Tail(text, MaxMessageChars)
	qs, unlisted, err := ParseRound(tail)
	if err == nil {
		return Extraction{Questions: qs, Source: SourceParsed, Unlisted: unlisted}
	}
	ex := Extraction{}
	if !errors.Is(err, ErrNotARound) {
		ex.NotRound = err.Error()
	}
	qs, unlisted, ex.Efforts, err = ExtractLLM(ctx, l, tail, r)
	if err != nil {
		ex.Questions, ex.Source, ex.ExtractErr = Fallback(), SourceFallback, err.Error()
		return ex
	}
	ex.Questions, ex.Source, ex.Unlisted = qs, SourceModel, unlisted
	return ex
}

// Fallback is the one open item a worker gets when the extraction failed.
func Fallback() []Question {
	return []Question{{ID: "q1", Question: FallbackQuestion, Kind: KindOpen}}
}

const extractSystem = `You read the final message an AI coding agent wrote to its user at the end of a turn, and list the questions it asks the user: things it needs the user to answer, decide or confirm.

Reply with only a JSON object, no prose and no code fence:
{"questions":[{"label":"...","question":"...","kind":"yes_no"|"choice"|"open","options":["..."],"context":"...","recommendation":"...","recommended_option":1,"why":"..."}],"more":0}

Rules:
- Every question the message asks, in its order, up to 16. Merge duplicates. If it asks more than 16, list the first 16 and put how many more in "more".
- When the message numbers its questions (Q8, Q9, 1., 2. …), list exactly one question per number: the sub-questions and bullets under a number belong to it (in its "context"), never questions of their own.
- "label": the name the message gives the question ("Q9", "3"), else "".
- "question": one self-contained sentence of at most 300 characters, in the agent's words where possible.
- kind "yes_no": it can be answered with yes or no. No options.
- kind "choice": the agent offers or clearly implies alternatives. List them in "options": 2 to 8 short labels (at most 300 characters each), keeping a letter like "(a)" when the message has one. A choice between doing something now or later counts. Sub-questions are not alternatives: never invent options.
- kind "open": anything else. No options.
- "context": what else the message says the user needs to answer it (sub-questions, constraints, facts), as Markdown, at most 1000 characters; "" when the question says it all.
- "recommendation": the answer the agent proposes, whole and in its words, as Markdown (it may span sentences or lines); "" when it proposes none. "recommended_option": for a choice, the 1-based number of the option it recommends, else 0. "why": its reason when the message gives it apart from the answer, else "".
- Rhetorical questions, offers like "let me know if you need anything", and questions the agent asks only to answer itself are not questions; a question the agent gives a recommended answer to, for the user to confirm or override, is one.`

// Reasoner is what the AI integration knows of the LLM's reasoning efforts
// (*ai.Service); Roles may implement it.
type Reasoner interface {
	ModelReasoning(ctx context.Context) ai.Reasoning
}

// efforts are the reasoning efforts of the first try and of the second, after
// one cut off or empty: sent only when the model's catalog says it has
// reasoning and takes them ("" each otherwise: the provider's default, and
// no second try).
func efforts(r ai.Reasoning) (first, second string) {
	if r.Support != ai.SupportYes {
		return "", ""
	}
	if r.Allows(ExtractEffort) {
		first = ExtractEffort
	}
	for _, e := range []string{retryNone, retryMinimal} {
		if r.Allows(e) {
			second = e
			break
		}
	}
	return first, second
}

// ExtractLLM asks the LLM for the questions of text and validates them
// (Parse). An answer cut off at the budget or empty is asked once more with
// less reasoning, when the model takes less. It returns the questions, how
// many it did not list, and the efforts of the calls made.
func ExtractLLM(ctx context.Context, l ai.LLM, text string, r ai.Reasoning) ([]Question, int, []string, error) {
	first, second := efforts(r)
	out, err := complete(ctx, l, text, first)
	tried := []string{first}
	if k := ai.KindOf(err); (k == ai.KindTruncated || k == ai.KindEmpty) && second != "" {
		out, err = complete(ctx, l, text, second)
		tried = append(tried, second)
	}
	if err != nil {
		return nil, 0, tried, err
	}
	qs, unlisted, err := Parse(out)
	return qs, unlisted, tried, err
}

func complete(ctx context.Context, l ai.LLM, text, effort string) (string, error) {
	return l.Complete(ctx, request(text, effort))
}

// request is the extraction's call for text with a reasoning effort.
func request(text, effort string) ai.Request {
	temp := 0.0
	return ai.Request{
		Messages: []ai.Message{
			{Role: "system", Content: extractSystem},
			{Role: "user", Content: "The agent's final message:\n\n" + text},
		},
		Temperature:      &temp,
		MaxTokens:        ExtractMaxTokens,
		ReasoningEffort:  effort,
		NoPartial:        true,
		JSON:             true,
		Timeout:          ExtractTimeout,
		NoUncertainRetry: true,
	}
}

// Parse reads the LLM's answer (the first JSON object in it) and validates
// it. The answer is rejected only as a whole when it is no question list,
// or none of its questions is valid; else (#60), bounded:
//   - over MaxQuestions, the rest are counted (unlisted), as is the "more"
//     the LLM reports (at most 100);
//   - a question that is empty, over 300 characters or of an unknown kind is
//     left out and counted;
//   - a choice with fewer than 2 or more than 8 options, or an option empty
//     or over 300 characters, is an open question, its options listed in
//     its context;
//   - options of yes_no and open are dropped (they are implied); a label
//     that is no short name is dropped; the context and why are cut to their
//     bounds, a recommendation over an answer's bound is cut and marked so
//     (Recommendation.Cut).
func Parse(text string) ([]Question, int, error) {
	obj, ok := ai.FirstJSONObject(text)
	if !ok {
		return nil, 0, fmt.Errorf("the LLM did not answer with a JSON object")
	}
	var raw struct {
		Questions []struct {
			Label          string   `json:"label"`
			Question       string   `json:"question"`
			Kind           string   `json:"kind"`
			Options        []string `json:"options"`
			Context        string   `json:"context"`
			Recommendation string   `json:"recommendation"`
			Option         int      `json:"recommended_option"`
			Why            string   `json:"why"`
		} `json:"questions"`
		More int `json:"more"`
	}
	if err := json.Unmarshal([]byte(obj), &raw); err != nil {
		return nil, 0, fmt.Errorf("the LLM's JSON is not a question list: %v", err)
	}
	if len(raw.Questions) == 0 {
		return nil, 0, fmt.Errorf("the LLM listed no question")
	}
	unlisted := min(max(raw.More, 0), 100)
	list := raw.Questions
	if len(list) > MaxQuestions {
		unlisted += len(list) - MaxQuestions
		list = list[:MaxQuestions]
	}
	out := make([]Question, 0, len(list))
	var why error
	for i, r := range list {
		q := Question{Question: oneLine(r.Question), Kind: r.Kind, Context: clip(markdown(r.Context), MaxContextLen)}
		if l := oneLine(r.Label); labelRe.MatchString(l) {
			q.Label = l
		}
		var bad error
		switch n := utf8.RuneCountInString(q.Question); {
		case n == 0:
			bad = fmt.Errorf("question %d is empty", i+1)
		case n > MaxQuestionLen:
			bad = fmt.Errorf("question %d has %d characters (at most %d)", i+1, n, MaxQuestionLen)
		}
		switch q.Kind {
		case KindYesNo, KindOpen:
		case KindChoice:
			q.Options = options(r.Options)
			if q.Options == nil {
				q.Kind = KindOpen
				var list []string
				for _, o := range r.Options {
					if o = oneLine(o); o != "" {
						list = append(list, "- "+clip(o, MaxOptionLen))
					}
				}
				q.Context = clip(strings.TrimSpace(q.Context+"\n\n"+strings.Join(list, "\n")), MaxContextLen)
			}
		default:
			bad = cmp.Or(bad, fmt.Errorf("question %d has kind %q (yes_no, choice or open)", i+1, clip(r.Kind, 20)))
		}
		if bad != nil {
			why = cmp.Or(why, bad)
			unlisted++
			continue
		}
		if t := markdown(r.Recommendation); t != "" {
			rec := recommendation(t)
			rec.Why = clip(markdown(r.Why), MaxWhyLen)
			if k := r.Option - 1; q.Kind == KindChoice && k >= 0 && k < len(q.Options) {
				rec.Option = &k
			}
			q.Recommendation = rec
		}
		q.ID = fmt.Sprintf("q%d", len(out)+1)
		out = append(out, q)
	}
	if len(out) == 0 {
		return nil, 0, fmt.Errorf("none of the LLM's %d questions is valid: %v", len(list), why)
	}
	return out, unlisted, nil
}

// options are a choice's options, one line each; nil when they are not 2-8
// of 1-300 characters.
func options(raw []string) []string {
	if n := len(raw); n < MinOptions || n > MaxOptions {
		return nil
	}
	out := make([]string, 0, len(raw))
	for _, o := range raw {
		o = oneLine(o)
		if n := utf8.RuneCountInString(o); n == 0 || n > MaxOptionLen {
			return nil
		}
		out = append(out, o)
	}
	return out
}

// labelRe is a question's own short name: Q9, 3, 2b.
var labelRe = regexp.MustCompile(`^[\p{L}#]{0,3}\d{1,3}[a-z]?$`)

// oneLine trims s and folds its whitespace runs (line ends included) into
// single spaces.
func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// markdown trims s and keeps its lines (Markdown), with \n line ends.
func markdown(s string) string { return strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n")) }

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n]) + "…"
}

// clipBytes cuts s to at most n bytes with its "…", never inside a UTF-8
// sequence.
func clipBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const more = "…"
	end := max(n-len(more), 0)
	for end > 0 && !utf8.RuneStart(s[end]) {
		end--
	}
	return s[:end] + more
}
