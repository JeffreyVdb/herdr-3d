package hireintent

import (
	"fmt"
	"slices"
	"strings"
	"unicode"
)

// Resolve turns the parser's answer into a Result: the intent, and for a
// hire the proposal, every value checked against cat. sources are the
// sentences, the pending proposal's then the one interpreted (the last, at
// least one); pending is that
// proposal (nil: none), already checked.
//
// The rules:
//   - not a hire: the intent, nothing else; more than one action or worker:
//     unsupported, nothing else (never a part of it);
//   - a harness named that has no models in cat is Invalid;
//   - a model is an exact id or readable label of the harness named, or,
//     with no harness named, of exactly one harness (which is then
//     resolved); anything else is Invalid, never another model or harness;
//   - an effort counts only when its word is in the dictation outside the
//     task; it is checked against the model's levels;
//   - the task is an exact part of a source: its span is in the latest
//     source holding it, at its last occurrence there. A task that is in no
//     source is an error (CodeBadSpan);
//   - with a pending proposal, a field the answer leaves out keeps the
//     pending one, and its task changes only to a part of the reply. An
//     effort kept from it that the newly chosen model does not support is
//     Missing again.
func Resolve(a *Answer, pending *Interpretation, sources []string, cat Catalog) Result {
	text := sources[len(sources)-1]
	res := Result{Text: text, Intent: a.Intent}
	if a.Intent != IntentHire {
		return res
	}
	if a.Multiple {
		res.Intent, res.Reason = IntentUnsupported, ReasonMultiple
		return res
	}
	task, taskBytes, err := resolveTask(a.Task, pending, sources)
	if err != nil {
		return Result{Text: text, Error: &Failure{Code: CodeBadSpan, Message: err.Error()}}
	}
	sel := selection(sources, task, taskBytes)

	harness := word(a.Harness)
	model := word(a.Model)
	effort := strings.ToLower(word(a.Effort))
	keptEffort := false
	if pending != nil {
		if harness == "" && pending.Harness.Provenance == Dictated {
			harness = pending.Harness.Value
		}
		if model == "" {
			model = said(pending.Model)
		}
		if p := said(pending.Effort); effort == "" || effort == strings.ToLower(p) {
			effort, keptEffort = strings.ToLower(p), p != ""
		}
	}

	hf, mf := resolveModel(cat, harness, model, sel)
	ef := resolveEffort(cat, hf, mf, effort, sel)
	modelChanged := pending != nil && mf.Value != pending.Model.Value
	if ef.Provenance == Invalid && keptEffort && modelChanged && mf.Valid() {
		ef = Field{Provenance: Missing}
	}

	in := &Interpretation{Sources: sources, Harness: hf, Model: mf, Effort: ef, Task: task, Questions: []Question{}}
	in.Questions = questions(cat, in, a.SelectionUnclear)
	in.ReadyForReview = len(in.Questions) == 0 && hf.Valid() && mf.Valid() && ef.Valid() && task.Provenance == Dictated
	res.Hire = in
	return res
}

// word is a value the parser gave, trimmed ("" for none).
func word(p *string) string {
	if p == nil {
		return ""
	}
	return strings.TrimSpace(*p)
}

// said is what a pending field holds: its value, else the words of an
// invalid one.
func said(f Field) string {
	if f.Valid() {
		return f.Value
	}
	if f.Provenance == Invalid {
		return f.Said
	}
	return ""
}

// resolveTask finds the answer's task in the sources (see Resolve). It
// returns the task and its byte range in its source.
func resolveTask(t *string, pending *Interpretation, sources []string) (Task, [2]int, error) {
	kept := func() (Task, [2]int, error) {
		if pending == nil || pending.Task.Provenance != Dictated {
			return Task{Provenance: Missing}, [2]int{}, nil
		}
		sp := pending.Task.Span
		s, e, _ := byteRange(sources[sp.Source], sp.Start, sp.End)
		return pending.Task, [2]int{s, e}, nil
	}
	if t == nil || strings.TrimSpace(*t) == "" {
		return kept()
	}
	if pending != nil && pending.Task.Provenance == Dictated && *t == pending.Task.Value {
		return kept()
	}
	last := len(sources) - 1
	for i := last; i >= 0; i-- {
		j := strings.LastIndex(sources[i], *t)
		if j < 0 {
			continue
		}
		if pending != nil && i != last {
			// A task from an earlier sentence that is not the pending one:
			// the reply did not dictate it.
			return kept()
		}
		src := sources[i]
		sp := &Span{Source: i, Start: utf16Len(src[:j]), End: utf16Len(src[:j+len(*t)])}
		return Task{Provenance: Dictated, Value: *t, Span: sp}, [2]int{j, j + len(*t)}, nil
	}
	return Task{}, [2]int{}, fmt.Errorf("the task the language model read is not part of what was dictated")
}

// selection is the dictation without the task: where a harness, model or
// effort may have been said. The sources are joined by a line break.
func selection(sources []string, task Task, at [2]int) string {
	parts := slices.Clone(sources)
	if task.Span != nil {
		s := parts[task.Span.Source]
		parts[task.Span.Source] = s[:at[0]] + "\n" + s[at[1]:]
	}
	return strings.ToLower(strings.Join(parts, "\n"))
}

// hasWord reports whether w (lower case) is in text (lower case) as a word:
// not part of a longer name ("gpt-6" is not in "gpt-6.1-sol").
func hasWord(text, w string) bool {
	if w == "" {
		return false
	}
	for i := 0; ; {
		j := strings.Index(text[i:], w)
		if j < 0 {
			return false
		}
		s, e := i+j, i+j+len(w)
		if !joined([]rune(text[:s]), true) && !joined([]rune(text[e:]), false) {
			return true
		}
		i = s + 1
	}
}

// joined reports whether a match continues into rs (the text before it,
// back: the runes before it, or after it): a letter or digit next to it, or
// one of "-._" and then a letter or digit.
func joined(rs []rune, back bool) bool {
	at := func(k int) rune {
		if back {
			k = len(rs) - 1 - k
		}
		if k < 0 || k >= len(rs) {
			return ' '
		}
		return rs[k]
	}
	alnum := func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }
	return alnum(at(0)) || (strings.ContainsRune("-._", at(0)) && alnum(at(1)))
}

// provenance is Dictated when value was said as a word, else Resolved.
func provenance(value, sel string) string {
	if hasWord(sel, strings.ToLower(value)) {
		return Dictated
	}
	return Resolved
}

// lookup is the model id of hc that is said: an id or a readable label,
// either in any case.
func lookup(hc HarnessCatalog, said string) (string, bool) {
	norm := func(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }
	n := norm(said)
	for _, id := range hc.Models {
		if norm(id) == n || (hc.ModelLabels[id] != "" && norm(hc.ModelLabels[id]) == n) {
			return id, true
		}
	}
	return "", false
}

// resolveModel resolves the harness named and the model said (see Resolve).
func resolveModel(cat Catalog, harness, model string, sel string) (Field, Field) {
	hf := Field{Provenance: Missing}
	if hc, _ := cat.Harness(harness); harness != "" && len(hc.Models) == 0 {
		hf = Field{Provenance: Invalid, Said: harness} // nothing of it to hire now
	} else if harness != "" {
		hf = Field{Provenance: provenance(harness, sel), Value: harness}
	}
	if model == "" {
		return hf, Field{Provenance: Missing}
	}
	var found []Choice
	for _, h := range Harnesses {
		hc, _ := cat.Harness(h)
		if id, ok := lookup(hc, model); ok {
			found = append(found, Choice{Harness: h, Model: id})
		}
	}
	if harness != "" {
		found = slices.DeleteFunc(found, func(c Choice) bool { return c.Harness != harness })
	}
	if len(found) != 1 {
		return hf, Field{Provenance: Invalid, Said: model}
	}
	c := found[0]
	if harness == "" {
		hf = Field{Provenance: Resolved, Value: c.Harness}
	}
	mf := Field{Provenance: provenance(c.Model, sel), Value: c.Model}
	if model != c.Model {
		mf.Said = model
	}
	return hf, mf
}

// effortWords are the spoken forms of an effort level besides its own word.
var effortWords = map[string][]string{
	"xhigh": {"extra high", "extra-high", "x-high", "x high"},
	"max":   {"maximum"},
}

// resolveEffort resolves the effort said (see Resolve): Missing unless one
// of its words is in sel, checked against the model's levels once the model
// is valid, else against every level the catalog knows.
func resolveEffort(cat Catalog, hf, mf Field, effort, sel string) Field {
	if effort == "" {
		return Field{Provenance: Missing}
	}
	prov := ""
	switch {
	case hasWord(sel, effort):
		prov = Dictated
	case slices.ContainsFunc(effortWords[effort], func(w string) bool { return hasWord(sel, w) }):
		prov = Resolved
	default:
		return Field{Provenance: Missing} // said only inside the task, or not at all
	}
	var levels []string
	if mf.Valid() {
		hc, _ := cat.Harness(hf.Value)
		levels = hc.EffortsFor(mf.Value)
	} else {
		for _, h := range Harnesses {
			if hf.Valid() && h != hf.Value {
				continue
			}
			hc, _ := cat.Harness(h)
			levels = append(levels, hc.Efforts...)
			for _, extra := range hc.ExtraEfforts {
				levels = append(levels, extra...)
			}
		}
	}
	if !slices.Contains(levels, effort) {
		return Field{Provenance: Invalid, Said: effort}
	}
	return Field{Provenance: prov, Value: effort}
}

// choices are the models of harness h, every harness's for "".
func choices(cat Catalog, h string) []Choice {
	var out []Choice
	for _, name := range Harnesses {
		if h != "" && name != h {
			continue
		}
		hc, _ := cat.Harness(name)
		for _, id := range hc.Models {
			out = append(out, Choice{Harness: name, Model: id, Label: hc.ModelLabels[id]})
		}
	}
	return out
}

// label is a model's readable name, else its id.
func label(cat Catalog, h, model string) string {
	hc, _ := cat.Harness(h)
	if l := hc.ModelLabels[model]; l != "" {
		return l
	}
	return model
}

// questions are what in must ask, in order: the model, the effort, the
// task; the selection when the parser found it unclear though it validated.
func questions(cat Catalog, in *Interpretation, unclear bool) []Question {
	qs := []Question{}
	h := ""
	if in.Harness.Valid() {
		h = in.Harness.Value
	}
	switch in.Model.Provenance {
	case Missing:
		qs = append(qs, Question{Field: AskModel, Text: "Which model should this agent use?", Choices: choices(cat, h)})
	case Invalid:
		qs = append(qs, Question{Field: AskModel, Text: fmt.Sprintf("Which model did you mean by “%s”?", in.Model.Said), Choices: choices(cat, h)})
	default:
		if unclear && in.Effort.Provenance != Invalid {
			qs = append(qs, Question{Field: AskSelection, Text: "Which harness, model and effort did you mean?", Choices: choices(cat, "")})
		}
	}
	var levels []string
	if in.Model.Valid() {
		hc, _ := cat.Harness(h)
		levels = hc.EffortsFor(in.Model.Value)
	}
	switch in.Effort.Provenance {
	case Missing:
		qs = append(qs, Question{Field: AskEffort, Text: EffortQuestion, Efforts: levels})
	case Invalid:
		text := fmt.Sprintf("“%s” is not an effort level. Which effort level should this agent use?", in.Effort.Said)
		if in.Model.Valid() {
			text = fmt.Sprintf("%s does not support “%s” effort. Which effort level should this agent use?", label(cat, h, in.Model.Value), in.Effort.Said)
		}
		qs = append(qs, Question{Field: AskEffort, Text: text, Efforts: levels})
	}
	if in.Task.Provenance == Missing {
		qs = append(qs, Question{Field: AskTask, Text: "What should this agent work on?"})
	}
	return qs
}
