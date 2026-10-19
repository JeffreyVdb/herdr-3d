// Package schedsuggest offers to schedule what an agent's final message
// leaves for later (#66, part 5 of #61): "24h soak, until about 10:45 UTC
// tomorrow; then delete the backups". When a turn ends, the bridge asks the
// AI integration (#92) whether the message says a step must wait, and the LLM
// drafts the schedule: when, a title and the first prompt of a fresh agent.
// The game shows it as a chip on the reply; nothing is ever scheduled without
// a save in the schedule form.
//
// Two models do the work, as for the follow-up questions (#90), on the same
// turn end and the same message:
//
//  1. the gate: the classifier scores GateQuestion for the message's tail;
//     below the threshold nothing else happens;
//  2. the extraction: the LLM gets the message, the current time in UTC and
//     the user's time zone, and answers {due_at, title, draft_prompt} or
//     {none: true}, validated (Parse). Anything invalid, cut off or late is
//     no suggestion: a positive gate alone never makes one.
//
// The package takes only the ai.Classifier and ai.LLM interfaces, never a
// vendor client (TestScheduleSuggestUsesOnlyAIInterfaces). Nothing is called
// unless the feature is switched on and both roles are ready (Service.Detect,
// Service.Extract).
package schedsuggest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// GateQuestion is the yes/no question the classifier scores.
const GateQuestion = "Does the message say that a step must be done later, after a waiting period or at a specific future time?"

// MaxMessageChars bounds what is sent of a message: its last ~24k tokens, as
// for the follow-up questions (the end of a message is where its next steps
// are).
const MaxMessageChars = 96_000

// Bounds of a suggestion. MaxTitle is proto.ScheduleMaxTitle and MaxPrompt
// herdr.MaxPrompt (this package imports neither: TestScheduleSuggestBounds
// keeps them equal), so a suggestion always fits the schedule form.
const (
	MaxTitle  = 200      // bytes: a longer title is cut
	MaxPrompt = 32 << 10 // bytes: a longer draft prompt is no suggestion
	// MaxAhead is how far ahead a suggestion may be: a later due_at is no
	// suggestion.
	MaxAhead = 30 * 24 * time.Hour
)

// The extraction's call: a small JSON answer, but a reasoning model spends
// its budget on reasoning first, so the budget and effort follow the
// follow-up extraction's (#60); a timeout of its own, never tried again (it
// may have been billed). Cut off or empty, once more with less reasoning.
const (
	ExtractMaxTokens = 4096
	ExtractEffort    = "low"
	ExtractTimeout   = 45 * time.Second
	retryNone        = "none"
	retryMinimal     = "minimal"
)

// Suggestion is a worker's suggested schedule (proto.Worker.ScheduleSuggestion).
type Suggestion struct {
	// ID is the turn it is of (transcript.Turn.ID): what
	// worker.dismiss_schedule_suggestion names.
	ID string `json:"id"`
	// Message is the transcript row it is of: the handoff candidate's message
	// id (Claude's message id, Codex's message item id).
	Message string `json:"message,omitempty"`
	// DueAt is when the deferred steps can start (unix ms, UTC).
	DueAt       int64   `json:"due_at"`
	Title       string  `json:"title"`
	DraftPrompt string  `json:"draft_prompt"`
	Score       float64 `json:"score"`
	At          int64   `json:"at"` // unix ms: when it was made
}

// Draft is what the LLM drafted, validated.
type Draft struct {
	DueAt  time.Time // UTC
	Title  string
	Prompt string
}

// Result is what Detect made of a message.
type Result struct {
	Score float64
	// Flag: the score reached the threshold (the LLM was asked).
	Flag bool
	Extraction
}

// Extraction is the LLM's draft of a flagged message, or why there is none.
type Extraction struct {
	// Draft is nil when there is no suggestion: Why says why.
	Draft *Draft
	// Why is why there is none: the LLM's "none", or what was wrong with its
	// answer or its call.
	Why string
	// Efforts are the reasoning efforts of the LLM calls made, in order.
	Efforts []string
}

// WhyNone is Extraction.Why when the LLM found nothing to schedule.
const WhyNone = "the LLM found nothing to schedule"

// Tail is the end of text, at most n characters, cut at a rune boundary.
func Tail(text string, n int) string {
	if utf8.RuneCountInString(text) <= n {
		return text
	}
	r := []rune(text)
	return string(r[len(r)-n:])
}

// State is the classifier's state for a message: the follow-up questions'
// own, so one ClassifyMany can score both questions.
func State(text string) map[string]any {
	return map[string]any{"last_agent_message": Tail(text, MaxMessageChars)}
}

// run gates text with the classifier and, when the score reaches threshold
// and ready still holds (nil: no check), extracts the draft. Only a failure
// of the classifier is an error.
func run(ctx context.Context, c ai.Classifier, l ai.LLM, text string, threshold float64, ready func() bool, now func() time.Time, zone string, r ai.Reasoning) (*Result, error) {
	score, err := c.Classify(ctx, State(text), GateQuestion)
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
	res.Extraction = Extract(ctx, l, text, now, zone, r)
	return res, nil
}

// Extract asks the LLM for the draft of a flagged message and validates it
// against now() as it is when the answer came. Any failure is no draft, with
// why: a call that failed or timed out, an answer cut off, unparseable or
// invalid.
func Extract(ctx context.Context, l ai.LLM, text string, now func() time.Time, zone string, r ai.Reasoning) Extraction {
	tail := Tail(text, MaxMessageChars)
	asked := now()
	first, second := efforts(r)
	out, err := l.Complete(ctx, request(tail, asked, zone, first))
	ex := Extraction{Efforts: []string{first}}
	if k := ai.KindOf(err); (k == ai.KindTruncated || k == ai.KindEmpty) && second != "" {
		out, err = l.Complete(ctx, request(tail, asked, zone, second))
		ex.Efforts = append(ex.Efforts, second)
	}
	if err != nil {
		ex.Why = fmt.Sprintf("the LLM call failed (%s): %v", cmpOr(string(ai.KindOf(err)), "error"), err)
		return ex
	}
	d, err := Parse(out, now())
	switch {
	case errors.Is(err, ErrNone):
		ex.Why = WhyNone
	case err != nil:
		ex.Why = err.Error()
	default:
		ex.Draft = &d
	}
	return ex
}

func cmpOr(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// efforts are the reasoning efforts of the first try and of the second, after
// one cut off or empty: sent only when the model's catalog says it has
// reasoning and takes them.
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

const extractSystem = `You read the final message an AI coding agent wrote to its user at the end of a turn. Decide whether it says that a step must be done later: after a waiting period (a soak, a bake, a cool-down, a CI or deploy window, a scheduled job) or at a specific future time. If it does, draft the schedule that hires a fresh agent to do those steps then.

Reply with only a JSON object, no prose and no code fence. Either
{"due_at":"<RFC 3339 time with an explicit offset or Z>","title":"...","draft_prompt":"..."}
or
{"none":true}

Rules:
- "due_at": when the deferred steps can start. Resolve relative times ("in 2 hours", "after the 24h soak", "tomorrow morning") against the current time given below, counting from when the message says the wait started, else from now. A clock time the message gives without a zone is in the user's time zone. Always write an explicit offset or Z.
- Answer {"none":true} when the message gives no wait and no time (a plain list of next steps, things the user may do whenever), when the only thing left is a question or decision for the user, or when the time it names has already passed. Never invent a time.
- "title": what will be done, one line of at most 80 characters (e.g. "Post-soak cleanup: Vector 0.59 rollout").
- "draft_prompt": the first prompt of a fresh agent that has never seen this conversation. Address it directly ("You are picking up …"). Describe the deferred steps concretely: what to check first, what to do, and how to know it is done, with the names, paths, hosts, tickets and PRs the message gives. Say that the original agent's message is attached as a handoff, to read first. At most 4000 characters, plain Markdown.`

// request is the extraction's call for text at now in zone ("": unknown,
// read as UTC), with a reasoning effort.
func request(text string, now time.Time, zone, effort string) ai.Request {
	temp := 0.0
	return ai.Request{
		Messages: []ai.Message{
			{Role: "system", Content: extractSystem},
			{Role: "user", Content: timeContext(now, zone) + "\n\nThe agent's final message:\n\n" + text},
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

// timeContext tells the LLM the current time in UTC and on the user's clock
// (zone "" or unknown: UTC, and it says so).
func timeContext(now time.Time, zone string) string {
	u := now.UTC()
	line := "Current time: " + u.Format(time.RFC3339) + " (" + u.Format("Monday") + ")."
	loc, err := LoadZone(zone)
	if zone == "" || err != nil {
		return line + "\nThe user's time zone is not known: read clock times without a zone as UTC."
	}
	l := now.In(loc)
	return line + "\nThe user's time zone: " + zone + " (now " + l.Format("Monday 2006-01-02 15:04") + " there, UTC" + l.Format("-07:00") + ")."
}

// LoadZone loads an IANA zone name for the user's time zone: not empty, not
// "Local" (the bridge host's), a name the time package knows.
func LoadZone(zone string) (*time.Location, error) {
	if zone == "" || zone == "Local" || len(zone) > 64 || strings.ContainsFunc(zone, func(r rune) bool { return r <= ' ' || r > '~' }) {
		return nil, fmt.Errorf("not an IANA time zone name: %q", clip(zone, 64))
	}
	loc, err := time.LoadLocation(zone)
	if err != nil {
		return nil, fmt.Errorf("unknown time zone %q", zone)
	}
	return loc, nil
}

// ErrNone is Parse's answer to {"none": true}.
var ErrNone = errors.New("none")

// Parse reads the LLM's answer (the first JSON object in it) and validates
// it at now:
//   - {"none": true} is ErrNone;
//   - due_at must be RFC 3339 with an explicit offset or Z, after now and at
//     most MaxAhead later; it is kept in UTC;
//   - the title is folded to one line without control characters and cut to
//     MaxTitle bytes; empty, it is invalid;
//   - the draft prompt keeps its lines (tabs become spaces, other control
//     characters go); empty, over MaxPrompt bytes or starting with "--" (a
//     herdr flag), it is invalid: never cut, a cut prompt would lose steps.
func Parse(text string, now time.Time) (Draft, error) {
	obj, ok := ai.FirstJSONObject(text)
	if !ok {
		return Draft{}, fmt.Errorf("the LLM did not answer with a JSON object")
	}
	var raw struct {
		None   bool   `json:"none"`
		DueAt  string `json:"due_at"`
		Title  string `json:"title"`
		Prompt string `json:"draft_prompt"`
	}
	if err := json.Unmarshal([]byte(obj), &raw); err != nil {
		return Draft{}, fmt.Errorf("the LLM's JSON is not a suggestion: %v", err)
	}
	if raw.None {
		return Draft{}, ErrNone
	}
	at := strings.TrimSpace(raw.DueAt)
	due, err := time.Parse(time.RFC3339, at)
	if err != nil {
		return Draft{}, fmt.Errorf("due_at %q is not an RFC 3339 time with an offset", clip(at, 40))
	}
	switch {
	case !due.After(now):
		return Draft{}, fmt.Errorf("due_at %s is not in the future (now %s)", due.UTC().Format(time.RFC3339), now.UTC().Format(time.RFC3339))
	case due.After(now.Add(MaxAhead)):
		return Draft{}, fmt.Errorf("due_at %s is more than 30 days ahead", due.UTC().Format(time.RFC3339))
	}
	title := clipBytes(strings.Join(strings.FieldsFunc(raw.Title, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }), " "), MaxTitle)
	if title == "" {
		return Draft{}, fmt.Errorf("the title is empty")
	}
	prompt := promptText(raw.Prompt)
	switch {
	case prompt == "":
		return Draft{}, fmt.Errorf("the draft prompt is empty")
	case len(prompt) > MaxPrompt:
		return Draft{}, fmt.Errorf("the draft prompt has %d bytes (at most %d)", len(prompt), MaxPrompt)
	case strings.HasPrefix(prompt, "--"):
		return Draft{}, fmt.Errorf("the draft prompt starts with \"--\"")
	}
	return Draft{DueAt: due.UTC(), Title: title, Prompt: prompt}, nil
}

// promptText is a draft prompt as a prompt can be typed: \n line ends, tabs
// as four spaces, no other control character, its ends trimmed.
func promptText(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\t", "    ")
	s = strings.Map(func(r rune) rune {
		if r != '\n' && unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return strings.TrimSpace(s)
}

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
	return strings.TrimSpace(s[:end]) + more
}
