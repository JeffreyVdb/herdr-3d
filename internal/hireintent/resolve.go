package hireintent

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"unicode"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// Resolve turns the parser's answer into a Result: the intent, and for a
// hire the proposal, every value checked against cat. sources are the
// sentences, the pending proposal's then the one interpreted (the last, at
// least one); pending is that
// proposal (nil: none), already checked. Nothing is hidden and no
// classifier is asked (Interpret's Request has both).
//
// The rules:
//   - not a hire: the intent, nothing else; more than one action or worker:
//     unsupported, nothing else (never a part of it);
//   - a harness named that has no (visible) models is Invalid;
//   - a model counts only where its words were said outside the task (else
//     Missing), and never when the parser named a model word that was not
//     said at all (Invalid). Said as an exact id or readable label, it is
//     that model, of the harness named, else of its own harness (which is
//     then resolved): a hidden one, or one of another harness than named,
//     is Invalid. Said otherwise, it is the visible model of the harness
//     named (else of any) whose words cover the words said (#190: "GPT
//     Sol", "Sol"): one is that model, several are Invalid and asked among
//     exactly those. A near miss ("GPT soul") goes to the classifier
//     (Select), which may pick it; anything else is Invalid, never another
//     model or harness;
//   - an effort's spoken forms ("x high", "extra-high", "maximum") are its
//     level, in the answer too; it counts only when its word is in the
//     dictation outside the task, and is checked against the model's
//     levels;
//   - the task is an exact part of a source: its span is in the latest
//     source holding it, at its last occurrence there. A task that is in no
//     source is an error (CodeBadSpan);
//   - with a pending proposal, a field the answer leaves out keeps the
//     pending one, and its task changes only to a part of the reply. An
//     effort kept from it that the newly chosen model does not support is
//     Missing again. Every kept value is resolved again, against the
//     current catalog and visibility.
func Resolve(a *Answer, pending *Interpretation, sources []string, cat Catalog) Result {
	return resolve(context.Background(), a, pending, sources, scope{full: cat, vis: cat})
}

// scope is what a resolution reads: the bridge's whole catalog, the visible
// part of it (the whole one minus Request.Hidden), and the classifier (nil:
// none).
type scope struct {
	full, vis Catalog
	cls       ai.Classifier
}

func resolve(ctx context.Context, a *Answer, pending *Interpretation, sources []string, sc scope) Result {
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
	selText := selection(sources, task, taskBytes)
	sel := strings.ToLower(selText)

	harness := word(a.Harness)
	model := word(a.Model)
	effort := canonicalEffort(word(a.Effort))
	keptEffort := false
	if pending != nil {
		if harness == "" && pending.Harness.Provenance == Dictated {
			harness = pending.Harness.Value
		}
		if model == "" {
			model = said(pending.Model)
		}
		if p := canonicalEffort(said(pending.Effort)); effort == "" || effort == p {
			effort, keptEffort = p, p != ""
		}
	}

	m := sc.resolveModel(harness, model, sel)
	if pending != nil && word(a.Model) == "" && m.model.Provenance == Invalid && pending.Model.Valid() && pending.Model.Said != "" {
		m.model.Said = pending.Model.Said // asked again in the words the user said, not the id
	}
	hf, mf := m.harness, m.model
	ef, nearEfforts := sc.resolveEffort(hf, mf, effort, sel)
	if len(m.near) > 0 || len(nearEfforts) > 0 {
		hf, mf, ef, m.choices = sc.classify(ctx, selText, sel, m, ef, effort, nearEfforts)
		m.byFamily = m.byFamily || len(m.near) > 0 && mf.Valid()
	}
	modelChanged := pending != nil && mf.Value != pending.Model.Value
	if ef.Provenance == Invalid && keptEffort && modelChanged && mf.Valid() {
		ef = Field{Provenance: Missing}
	}

	in := &Interpretation{Sources: sources, Harness: hf, Model: mf, Effort: ef, Task: task, Questions: []Question{}}
	// The LLM finds the selection unclear when it cannot map a family to an
	// id itself ("GPT Sol" is in no hire_options): that is what the rules
	// did. It still counts when the model was said exactly, or when another
	// model is named outside the task ("GPT Sol or maybe Opus").
	unclear := a.SelectionUnclear && !(m.byFamily && mf.Valid() && !sc.otherModelSaid(sel, Choice{Harness: hf.Value, Model: mf.Value}))
	in.Questions = questions(sc.vis, in, unclear, m.choices)
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
// effort may have been said. The sources are joined by a line break (the
// task is one too). It is what the classifier reads (Select); the rules
// read it in lower case.
func selection(sources []string, task Task, at [2]int) string {
	parts := slices.Clone(sources)
	if task.Span != nil {
		s := parts[task.Span.Source]
		parts[task.Span.Source] = s[:at[0]] + "\n" + s[at[1]:]
	}
	return strings.Join(parts, "\n")
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

// modelRes is a model resolved: the harness and model fields, the choices
// of its question (nil: the harness's), and the near candidates the
// classifier is asked about (the model Invalid meanwhile).
type modelRes struct {
	harness, model Field
	choices        []Choice
	near           []Choice
	// byFamily: taken by this package's rules (a family, a near miss), not
	// as the exact id or label the LLM gave.
	byFamily bool
}

// resolveModel resolves the harness named and the model said (see Resolve).
func (sc scope) resolveModel(harness, model string, sel string) modelRes {
	r := modelRes{harness: Field{Provenance: Missing}, model: Field{Provenance: Missing}}
	if hc, _ := sc.vis.Harness(harness); harness != "" && len(hc.Models) == 0 {
		r.harness = Field{Provenance: Invalid, Said: harness} // nothing of it to hire now
	} else if harness != "" {
		r.harness = Field{Provenance: provenance(harness, sel), Value: harness}
	}
	if model == "" {
		return r
	}
	sp := sayName(model, nameTokens(sel), generic(sc.full))
	if !hasName(sp.words) {
		return r // said only inside the task, or not at all
	}
	invalid := func(choices []Choice) modelRes {
		r.model, r.choices = Field{Provenance: Invalid, Said: model}, choices
		return r
	}
	if sp.alien {
		return invalid(nil) // a model the user did not say
	}
	take := func(c Choice) modelRes {
		if harness == "" {
			r.harness = Field{Provenance: Resolved, Value: c.Harness}
		}
		r.model = Field{Provenance: provenance(c.Model, sel), Value: c.Model}
		if model != c.Model {
			r.model.Said = model
		}
		return r
	}
	if sp.whole {
		var found []Choice
		for _, h := range Harnesses {
			hc, _ := sc.full.Harness(h)
			if id, ok := lookup(hc, model); ok {
				found = append(found, Choice{Harness: h, Model: id})
			}
		}
		if harness != "" {
			found = slices.DeleteFunc(found, func(c Choice) bool { return c.Harness != harness })
		}
		switch {
		case len(found) == 1 && hiddenIn(sc.full, sc.vis, found[0].Harness, found[0].Model):
			return invalid(nil)
		case len(found) == 1:
			return take(found[0])
		case len(found) > 1 || slices.ContainsFunc(Harnesses, func(h string) bool {
			hc, _ := sc.full.Harness(h)
			_, ok := lookup(hc, model)
			return ok
		}):
			return invalid(nil) // another harness's model, never substituted
		}
	}
	cands := choices(sc.vis, harnessOf(r.harness))
	if !sp.weak {
		switch fam, _ := familyMatches(sc.vis, cands, sp.words, false); len(fam) {
		case 1:
			r.byFamily = true
			return take(fam[0])
		case 0:
		default:
			return invalid(fam) // never a version picked for the user
		}
	}
	near, sigs := familyMatches(sc.vis, cands, sp.words, true)
	if len(near) == 0 {
		return invalid(nil)
	}
	for i := range sigs {
		if slices.Contains(sigs[i+1:], sigs[i]) {
			return invalid(near) // the words said do not tell them apart
		}
	}
	r = invalid(nil)
	r.near = near
	return r
}

// otherModelSaid reports whether sel (the selection, lower case) has a word
// that names a model of the whole catalog other than c: one of its words
// that c does not have, not generic, not a number.
func (sc scope) otherModelSaid(sel string, c Choice) bool {
	words := nameTokens(sel)
	gen := generic(sc.full)
	mine := modelWords(sc.full, c)
	for _, o := range choices(sc.full, "") {
		if o == (Choice{Harness: c.Harness, Model: c.Model, Label: o.Label}) {
			continue
		}
		for _, w := range modelWords(sc.full, o) {
			if !isNumber(w) && !gen[w] && !slices.Contains(mine, w) && slices.Contains(words, w) {
				return true
			}
		}
	}
	return false
}

// harnessOf is f's value when it is valid, else "".
func harnessOf(f Field) string {
	if f.Valid() {
		return f.Value
	}
	return ""
}

// classify asks the classifier about the near candidates (Select) and
// applies its picks: a model picked is Resolved (its harness too, when none
// was named), an effort picked is checked against the model's levels.
// Ambiguous asks among the candidates it names; anything else (unknown, no
// classifier, a failure) leaves the fields as they are, Invalid and asked.
func (sc scope) classify(ctx context.Context, selText, sel string, m modelRes, ef Field, effort string, nearEfforts []string) (Field, Field, Field, []Choice) {
	hf, mf, choices := m.harness, m.model, m.choices
	if sc.cls == nil {
		return hf, mf, ef, choices
	}
	ctx, cancel := selectTimeout(ctx)
	defer cancel()
	got, err := Select(ctx, sc.cls, selText, m.near, nearEfforts)
	if err != nil {
		return hf, mf, ef, choices
	}
	switch got.Model.Outcome {
	case Picked:
		i := slices.IndexFunc(m.near, func(c Choice) bool { return modelKey(c) == got.Model.Value })
		c := m.near[i]
		if !hf.Valid() {
			hf = Field{Provenance: Resolved, Value: c.Harness}
		}
		mf = Field{Provenance: Resolved, Value: c.Model, Said: mf.Said}
		if len(nearEfforts) == 0 && effort != "" {
			ef, _ = sc.resolveEffort(hf, mf, effort, sel) // now checked against its levels
		}
	case Ambiguous:
		choices = slices.DeleteFunc(slices.Clone(m.near), func(c Choice) bool { return !slices.Contains(got.Model.Candidates, modelKey(c)) })
	}
	if got.Effort.Outcome == Picked {
		ef = sc.checkEffort(hf, mf, Field{Provenance: Resolved, Value: got.Effort.Value})
	}
	return hf, mf, ef, choices
}

// effortWords are the spoken forms of an effort level besides its own word.
var effortWords = map[string][]string{
	"xhigh": {"extra high", "extra-high", "x-high", "x high"},
	"max":   {"maximum"},
}

// canonicalEffort is an effort as the parser read it, in lower case, its
// spoken forms as their level (#190: "X high", "extra-high" are xhigh,
// "maximum" is max): before it is checked, whichever form the answer has.
func canonicalEffort(e string) string {
	e = strings.ToLower(strings.TrimSpace(e))
	norm := strings.Join(strings.FieldsFunc(e, func(r rune) bool { return r == '-' || unicode.IsSpace(r) }), " ")
	for level, words := range effortWords {
		for _, w := range words {
			if norm == strings.ReplaceAll(w, "-", " ") {
				return level
			}
		}
	}
	return e
}

// resolveEffort resolves the effort said (see Resolve): Missing unless one
// of its words is in sel, checked against the model's levels once the model
// is valid, else against every level the visible catalog knows. A word
// said that is no level, but a near miss of some ("medum"), is Invalid,
// with those levels for the classifier.
func (sc scope) resolveEffort(hf, mf Field, effort, sel string) (Field, []string) {
	if effort == "" {
		return Field{Provenance: Missing}, nil
	}
	prov := ""
	switch {
	case hasWord(sel, effort):
		prov = Dictated
	case slices.ContainsFunc(effortWords[effort], func(w string) bool { return hasWord(sel, w) }):
		prov = Resolved
	default:
		return Field{Provenance: Missing}, nil // said only inside the task, or not at all
	}
	f := sc.checkEffort(hf, mf, Field{Provenance: prov, Value: effort})
	if f.Provenance != Invalid || slices.Contains(sc.levels(Field{}, Field{}), effort) {
		return f, nil
	}
	var near []string
	for _, l := range sc.levels(hf, mf) {
		if nearWord(effort, l) || slices.ContainsFunc(effortWords[l], func(w string) bool { return nearWord(effort, w) }) {
			near = append(near, l)
		}
	}
	return f, near
}

// levels are the effort levels of the model when it is valid, else every
// level of the harness named (of all without one), in the visible catalog.
func (sc scope) levels(hf, mf Field) []string {
	var out []string
	add := func(ls ...string) {
		for _, l := range ls {
			if !slices.Contains(out, l) {
				out = append(out, l)
			}
		}
	}
	switch {
	case mf.Valid():
		hc, _ := sc.vis.Harness(hf.Value)
		add(hc.EffortsFor(mf.Value)...)
	default:
		for _, h := range Harnesses {
			if hf.Valid() && h != hf.Value {
				continue
			}
			hc, _ := sc.vis.Harness(h)
			add(hc.Efforts...)
			for _, id := range hc.Models {
				add(hc.ExtraEfforts[id]...)
			}
		}
	}
	return out
}

// checkEffort is f (a level said) checked against the levels (see levels):
// Invalid, its word kept, when it is not one of them.
func (sc scope) checkEffort(hf, mf Field, f Field) Field {
	if !slices.Contains(sc.levels(hf, mf), f.Value) {
		return Field{Provenance: Invalid, Said: f.Value}
	}
	return f
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

// withLabels is cs with their readable names.
func withLabels(cat Catalog, cs []Choice) []Choice {
	out := make([]Choice, len(cs))
	for i, c := range cs {
		hc, _ := cat.Harness(c.Harness)
		out[i] = Choice{Harness: c.Harness, Model: c.Model, Label: hc.ModelLabels[c.Model]}
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
// The model's choices are among (the models its words matched), else the
// harness's; every one visible (cat).
func questions(cat Catalog, in *Interpretation, unclear bool, among []Choice) []Question {
	qs := []Question{}
	h := harnessOf(in.Harness)
	offer := choices(cat, h)
	if among != nil {
		offer = withLabels(cat, among)
	}
	switch in.Model.Provenance {
	case Missing:
		qs = append(qs, Question{Field: AskModel, Text: "Which model should this agent use?", Choices: offer})
	case Invalid:
		qs = append(qs, Question{Field: AskModel, Text: fmt.Sprintf("Which model did you mean by “%s”?", in.Model.Said), Choices: offer})
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
