// Package hireintent turns one dictated sentence into a hire proposal for
// review (#211, phase 2 of #209): "Hire a Claude Code agent on Haiku 5.5 with
// high effort. Task: fix the login bug." becomes a harness, a model, an
// effort and a task, each with where it came from, or the answer that the
// sentence is not a hire (unsupported, unclear). It never hires: a complete,
// valid proposal is only ready for review, and the human's confirmation in
// the game's Hire dialog is what sends worker.hire (phase 3 and 4).
//
// One call to the LLM (the AI integration's llm role, #92) reads the
// sentence with the prompt the research measured (prompt.txt, from
// docs/research/dictation-hiring-bench) and answers seven fields. Everything
// after that is deterministic: the answer is parsed strictly (any schema
// violation is an error, never a guess), every value is resolved against the
// bridge's current hire catalog (exact ids, readable labels; never a default,
// never a substitution) and the task is cut from the dictation itself, a
// source span in UTF-16 code units, so its text is the user's own words. A
// follow-up reply ("high") is merged into the pending proposal the client
// sends back: the bridge keeps no state, so that proposal carries its source
// sentences and is checked again in full on every call.
//
// Only hiring is understood. Room is left for other explicit intents (the
// Intent field) without implementing any: no general planner, no command
// executor.
//
// The package takes only the ai.LLM interface, never a vendor client
// (TestHireIntentUsesOnlyAIInterfaces).
package hireintent

import (
	"fmt"
	"slices"
	"strings"
)

// Intents (Result.Intent).
const (
	IntentHire        = "hire"        // a request to hire one new worker
	IntentUnsupported = "unsupported" // a clear request for something else (or for more than one thing)
	IntentUnclear     = "unclear"     // no clear request
)

// Provenances of a field (Field.Provenance).
const (
	// Dictated: said, and valid as said (the launch value itself is in the
	// dictation, as a word).
	Dictated = "dictated"
	// Resolved: taken from the catalog for what was said (a readable label,
	// an alias such as "extra high"), or the harness of an unambiguous model.
	Resolved = "resolved"
	// Missing: not said.
	Missing = "missing"
	// Invalid: said, but not valid: unknown, unsupported, contradictory or
	// ambiguous. Said keeps the words for the question; there is no Value.
	Invalid = "invalid"
)

// Field is one of harness, model and effort as the dictation gave it.
type Field struct {
	Provenance string `json:"provenance"`
	// Value is the exact catalog value (launch id): set only when Dictated or
	// Resolved. An effort's Value is checked against the model's levels only
	// once the model is valid.
	Value string `json:"value,omitempty"`
	// Said is what the parser read from the dictation: the model's readable
	// name or alias, the unrecognised words of an Invalid field. Display only.
	Said string `json:"said,omitempty"`
}

// Valid reports whether f has a launchable value.
func (f Field) Valid() bool { return f.Provenance == Dictated || f.Provenance == Resolved }

// Span is where a text is in the sources: Sources[Source][Start:End] in
// UTF-16 code units, as JavaScript indexes a string (packup.Range's units).
type Span struct {
	Source int `json:"source"`
	Start  int `json:"start"`
	End    int `json:"end"`
}

// Task is the worker's task: Dictated with its Span, or Missing.
type Task struct {
	Provenance string `json:"provenance"`
	Value      string `json:"value,omitempty"`
	Span       *Span  `json:"span,omitempty"`
}

// Question fields (Question.Field).
const (
	AskModel     = "model"     // harness and model: missing, unknown or contradictory
	AskEffort    = "effort"    // missing or unsupported
	AskTask      = "task"      // missing
	AskSelection = "selection" // the parser found the selection unclear though every value validated
)

// EffortQuestion is the question for a missing effort, word for word.
const EffortQuestion = "What effort level should this agent use?"

// Question is something to ask before the proposal can go to review.
type Question struct {
	Field string `json:"field"`
	Text  string `json:"text"`
	// Efforts are the levels to choose from (AskEffort): the selected model's.
	Efforts []string `json:"efforts,omitempty"`
	// Choices are the models to choose from (AskModel, AskSelection).
	Choices []Choice `json:"choices,omitempty"`
}

// Choice is one model of the catalog.
type Choice struct {
	Harness string `json:"harness"`
	Model   string `json:"model"`
	Label   string `json:"label,omitempty"`
}

// Interpretation is a hire proposal.
type Interpretation struct {
	// Sources are the sentences it was read from, oldest first: a pending
	// proposal's, then the one just interpreted. Send the whole
	// Interpretation back as the pending one with a follow-up reply.
	Sources []string `json:"sources"`
	Harness Field    `json:"harness"`
	Model   Field    `json:"model"`
	Effort  Field    `json:"effort"`
	Task    Task     `json:"task"`
	// Questions are what to ask, in order; never null.
	Questions []Question `json:"questions"`
	// ReadyForReview: every field is valid and nothing is to be asked. The
	// proposal may open the review; it never authorizes a launch.
	ReadyForReview bool `json:"ready_for_review"`
}

// Failure is an operational error: the interpretation could not be made
// (the model not ready or failing, an answer that breaks the schema, a task
// not in the dictation). It is not an intent, and there is no proposal.
type Failure struct {
	// Code is an ai.Kind ("timeout", "provider_failed", "not_ready" …) or
	// one of CodeBadAnswer, CodeBadSpan, CodeBadPending.
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Failure codes of this package.
const (
	CodeBadAnswer  = "bad_answer"  // the LLM's answer is not the schema
	CodeBadSpan    = "bad_span"    // its task is not an exact part of the dictation
	CodeBadPending = "bad_pending" // the pending proposal sent back does not hold
)

// Result is one interpretation.
type Result struct {
	// Text is the sentence interpreted, always kept (also on an error).
	Text string `json:"text"`
	// Intent is "" exactly when Error is set.
	Intent string `json:"intent,omitempty"`
	// Reason says why a hire is unsupported: "multiple" (more than one
	// action or worker: none is done, not even a part).
	Reason string `json:"reason,omitempty"`
	// Hire is the proposal (Intent hire only).
	Hire  *Interpretation `json:"hire,omitempty"`
	Error *Failure        `json:"error,omitempty"`
}

// ReasonMultiple: more than one action or more than one new worker.
const ReasonMultiple = "multiple"

// Catalog is what can be hired: proto.HireOptions field for field (the same
// JSON, which the LLM reads as hire_options). The server converts its live
// catalog on every call; nothing here is a fixed list.
type Catalog struct {
	Claude HarnessCatalog `json:"claude"`
	Codex  HarnessCatalog `json:"codex"`
}

// HarnessCatalog is proto.HarnessOptions: the models, the efforts common to
// all of them, each model's extra efforts and readable names.
type HarnessCatalog struct {
	Models       []string            `json:"models"`
	Efforts      []string            `json:"efforts"`
	ExtraEfforts map[string][]string `json:"extra_efforts,omitempty"`
	ModelLabels  map[string]string   `json:"model_labels,omitempty"`
}

// Harnesses, in catalog order.
var Harnesses = []string{"claude", "codex"}

// Harness is the catalog of harness h, ok false for an unknown one.
func (c Catalog) Harness(h string) (HarnessCatalog, bool) {
	switch h {
	case "claude":
		return c.Claude, true
	case "codex":
		return c.Codex, true
	}
	return HarnessCatalog{}, false
}

// EffortsFor are the effort levels of model: the common ones, then its
// extras.
func (h HarnessCatalog) EffortsFor(model string) []string {
	return append(slices.Clone(h.Efforts), h.ExtraEfforts[model]...)
}

// Check reports whether harness, model and effort can be hired together: the
// one rule the bridge's worker.hire and settings use too.
func (c Catalog) Check(harness, model, effort string) error {
	h, ok := c.Harness(harness)
	if !ok {
		return fmt.Errorf("harness must be claude or codex, got %q", harness)
	}
	if !slices.Contains(h.Models, model) {
		return fmt.Errorf("model %q is not a %s model (%s)", model, harness, strings.Join(h.Models, ", "))
	}
	if !slices.Contains(h.EffortsFor(model), effort) {
		return fmt.Errorf("effort %q is not an effort of %s", effort, model)
	}
	return nil
}
