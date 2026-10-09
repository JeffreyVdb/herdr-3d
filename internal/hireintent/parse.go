package hireintent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Answer is the LLM's answer, the seven keys prompt.txt asks for. Values
// are the parser's words: nothing in it is trusted before Resolve.
type Answer struct {
	Intent           string  `json:"intent"`
	Harness          *string `json:"harness"`
	Model            *string `json:"model"`
	Effort           *string `json:"effort"`
	Task             *string `json:"task"`
	Multiple         bool    `json:"multiple"`
	SelectionUnclear bool    `json:"selection_unclear"`
}

// answerKeys are the keys an answer must have, no more.
var answerKeys = []string{"intent", "harness", "model", "effort", "task", "multiple", "selection_unclear"}

// maxWords bounds a model or effort the parser read (the unrecognised words
// are shown back in a question).
const maxWords = 100

// Parse reads the LLM's answer (the first JSON object in it) strictly: the
// seven keys and no other, intent one of the three, harness claude, codex or
// null, model and effort a short string or null, task a string or null,
// multiple and selection_unclear booleans. Any other shape is an error. A
// model or effort that is not in the catalog is not a schema violation: it
// is resolved (Resolve) into a question.
func Parse(text string) (*Answer, error) {
	obj, ok := ai.FirstJSONObject(text)
	if !ok {
		return nil, fmt.Errorf("the answer holds no JSON object")
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal([]byte(obj), &keys); err != nil {
		return nil, fmt.Errorf("the answer is not a JSON object")
	}
	for _, k := range answerKeys {
		if _, ok := keys[k]; !ok {
			return nil, fmt.Errorf("the answer has no %q", k)
		}
	}
	d := json.NewDecoder(bytes.NewReader([]byte(obj)))
	d.DisallowUnknownFields()
	var a Answer
	if err := d.Decode(&a); err != nil {
		return nil, fmt.Errorf("the answer breaks the schema: %v", err)
	}
	for _, k := range []string{"multiple", "selection_unclear"} {
		if string(keys[k]) == "null" {
			return nil, fmt.Errorf("%q is null", k)
		}
	}
	if string(keys["intent"]) == "null" || !slices.Contains([]string{IntentHire, IntentUnsupported, IntentUnclear}, a.Intent) {
		return nil, fmt.Errorf("intent must be hire, unsupported or unclear")
	}
	if a.Harness != nil && !slices.Contains(Harnesses, *a.Harness) {
		return nil, fmt.Errorf("harness must be claude, codex or null")
	}
	for name, v := range map[string]*string{"model": a.Model, "effort": a.Effort} {
		if v != nil && (utf8.RuneCountInString(*v) > maxWords || strings.ContainsAny(*v, "\x00\n\r")) {
			return nil, fmt.Errorf("%s is not a short line of text", name)
		}
	}
	return &a, nil
}
