package hireintent_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
)

// #190's matrix: the command bar's sentence in every combination of how a
// model and an effort are said, what the LLM answers for them, what the
// user hides, what the task holds and what the classifier does. Each case's
// expected outcome comes from what the user said and sees (expect), never
// from the code under test: a model is taken only when what was said names
// exactly one visible model, asked among exactly the visible models it
// names when it names several, and asked (never substituted) otherwise; a
// near miss ("soul") only with the classifier's pick.

// matrixCatalog is the live catalog's shape: three Sols, a Luna, four Claude
// models. gpt-5.6-sol has no xhigh; ultra is gpt-6-sol's only.
func matrixCatalog() hireintent.Catalog {
	extra := []string{"xhigh", "max"}
	return hireintent.Catalog{
		Claude: hireintent.HarnessCatalog{
			Models:  []string{"claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"},
			Efforts: []string{"low", "medium", "high"},
			ExtraEfforts: map[string][]string{"claude-sonnet-5-5": extra, "claude-opus-5-5": extra, "claude-fable-5-1": extra,
				"claude-haiku-5-5": extra},
			ModelLabels: map[string]string{"claude-sonnet-5-5": "Sonnet 5.5", "claude-opus-5-5": "Opus 5.5",
				"claude-fable-5-1": "Fable 5.1", "claude-haiku-5-5": "Haiku 5.5"},
		},
		Codex: hireintent.HarnessCatalog{
			Models:       []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"},
			Efforts:      []string{"low", "medium", "high"},
			ExtraEfforts: map[string][]string{"gpt-6.1-sol": {"xhigh", "max"}, "gpt-6-sol": {"xhigh", "ultra"}, "gpt-6-luna": {"xhigh"}},
			ModelLabels:  map[string]string{"gpt-6.1-sol": "GPT-6.1-Sol", "gpt-6-sol": "GPT-6-Sol", "gpt-5.6-sol": "GPT-5.6-Sol", "gpt-6-luna": "GPT-6-Luna"},
		},
	}
}

var sols = []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"}

type visibility struct {
	name   string
	hidden hireintent.Hidden
}

var visibilities = []visibility{
	// The screenshot's: one Sol shown (and ids the catalog does not have).
	{"one-sol", hireintent.Hidden{"codex": {"gpt-6-sol", "gpt-5.6-sol", "gpt-9-nova"}, "gemini": {"g-1"}}},
	{"several", nil},
	{"codex-all-hidden", hireintent.Hidden{"codex": {"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"}}},
	{"hidden-6.1", hireintent.Hidden{"codex": {"gpt-6.1-sol"}}},
	{"one-sol-no-xhigh", hireintent.Hidden{"codex": {"gpt-6.1-sol", "gpt-6-sol"}}},
}

// shown is whether model is visible under v.
func (v visibility) shown(model string) bool {
	for _, ids := range v.hidden {
		if slices.Contains(ids, model) {
			return false
		}
	}
	return true
}

// form is how the user says the model.
type form struct {
	name, words string
	version     string // the Sol said by version ("" none)
	family      bool   // a Sol said without its version
	near        bool   // misheard: only the classifier may take it
	unknown     bool
}

var forms = []form{
	{name: "id", words: "gpt-6.1-sol", version: "gpt-6.1-sol"},
	{name: "label", words: "GPT-6.1-Sol", version: "gpt-6.1-sol"},
	{name: "versioned", words: "GPT 6.1 Sol", version: "gpt-6.1-sol"},
	{name: "other-version", words: "GPT 6 Sol", version: "gpt-6-sol"},
	{name: "family", words: "GPT Sol", family: true},
	{name: "bare", words: "Sol", family: true},
	{name: "misheard", words: "GPT soul", family: true, near: true},
	{name: "omitted"},
	{name: "unknown", words: "GPT Banana", unknown: true},
}

// llmModel is what the LLM answers for the model: the user's words, a
// normalized name, or nothing. ok false: a variant that would lose a
// version the user said (the rules cannot see it: the report lists it).
type llmModel struct {
	name string
	of   func(f form) (answer string, ok bool)
}

var llmModels = []llmModel{
	{"echo", func(f form) (string, bool) { return f.words, true }},
	{"canonical", func(f form) (string, bool) {
		if f.version != "" {
			return f.version, true
		}
		return "gpt-6.1-sol", true // a version picked by the LLM, or invented
	}},
	{"GPT Sol", func(f form) (string, bool) { return "GPT Sol", f.version == "" }},
	{"Sol", func(f form) (string, bool) { return "Sol", f.version == "" }},
	{"GPT soul", func(f form) (string, bool) { return "GPT soul", f.version == "" }},
	{"gpt sol", func(f form) (string, bool) { return "gpt sol", f.version == "" }},
	{"null", func(f form) (string, bool) { return "", true }},
}

// harnessSaid is the harness in the sentence and in the LLM's answer.
type harnessSaid struct{ words, answer string }

var harnessesSaid = []harnessSaid{{"", ""}, {"Codex", "codex"}, {"Claude Code", "claude"}}

// effortSaid is how the effort is said ("" not at all) and its level.
type effortSaid struct{ words, level string }

var effortsSaid = []effortSaid{
	{"high", "high"}, {"X high", "xhigh"}, {"x high", "xhigh"}, {"x-high", "xhigh"}, {"extra high", "xhigh"},
	{"extra-high", "xhigh"}, {"xhigh", "xhigh"}, {"maximum", "max"}, {"ultra", "ultra"}, {"", ""},
}

// llmEffort is what the LLM answers for the effort: the level, the words
// as said, or nothing.
var llmEfforts = []string{"level", "as said", "null"}

var tasks = []string{
	"solve the issue with the frontend.",
	"port the Sol tests to the high effort profile.",
	"fix the login bug. Then write the release notes!",
	"check why GPT Sol is slow at x high effort?",
}

// phrasing builds the sentence: harness, model, effort (any may be ""),
// task.
type phrasing func(h, m, e, task string) string

func join(ws ...string) string {
	return strings.Join(slices.DeleteFunc(ws, func(w string) bool { return w == "" }), " ")
}

var phrasings = []phrasing{
	func(h, m, e, task string) string { // the screenshot's
		eff := ""
		if e != "" {
			eff = "on " + e + " reasoning"
		}
		return join("Please spawn a", h, m, "agent", eff, "to", task)
	},
	func(h, m, e, task string) string {
		eff := ""
		if e != "" {
			eff = "with " + e + " effort."
		}
		return join("Hire a", h, m, "agent"+map[bool]string{true: "", false: "."}[eff != ""], eff, "Task:", task)
	},
	func(h, m, e, task string) string {
		eff := ""
		if e != "" {
			eff = "at " + e + " effort"
		}
		return join("Can you hire a", h, m, "worker", eff, "to", task)
	},
	func(h, m, e, task string) string {
		sel := join(h, m)
		if sel != "" {
			sel = "using " + sel + ","
		}
		eff := ""
		if e != "" {
			eff = e + " effort,"
		}
		return join("Spawn an agent", sel, eff, "to", task)
	},
}

// classifierState is the classifier the interpretation has.
type classifierState struct {
	name string
	make func() *ai.FakeClassifier // nil: none
	// picks: a near candidate is taken.
	picks bool
}

var classifierStates = []classifierState{
	{"eager", func() *ai.FakeClassifier { return &ai.FakeClassifier{Score: 0.95} }, true},
	{"borderline", func() *ai.FakeClassifier { return &ai.FakeClassifier{Score: hireintent.PickScore - 0.01} }, false},
	{"low", func() *ai.FakeClassifier { return &ai.FakeClassifier{Score: 0.1} }, false},
	{"off", nil, false},
	{"failing", func() *ai.FakeClassifier {
		return &ai.FakeClassifier{Err: &ai.Error{Kind: ai.KindFailed, Msg: "boom"}}
	}, false},
}

// mcase is one case of the matrix.
type mcase struct {
	phrasing  int
	harness   harnessSaid
	form      form
	llm       llmModel
	vis       visibility
	effort    effortSaid
	llmEffort string
	task      string
	cls       classifierState
}

func (c mcase) String() string {
	return fmt.Sprintf("p%d h=%q m=%s llm=%s vis=%s e=%q llmE=%s task=%q cls=%s", c.phrasing, c.harness.words, c.form.name, c.llm.name,
		c.vis.name, c.effort.words, c.llmEffort, c.task, c.cls.name)
}

func (c mcase) sentence() string {
	return phrasings[c.phrasing](c.harness.words, c.form.words, c.effort.words, c.task)
}

func (c mcase) answer() map[string]any {
	m, _ := c.llm.of(c.form)
	e := ""
	switch c.llmEffort {
	case "level":
		e = c.effort.level
	case "as said":
		e = c.effort.words
	}
	return ans("hire", c.harness.answer, m, e, c.task)
}

// want is a case's expected outcome.
type want struct {
	model      string   // the model taken ("": none)
	missing    bool     // the model not said (outside the task)
	choices    []string // the model question's choices (model not taken)
	classifier bool     // the classifier is asked
	effort     string   // the effort taken ("": none)
	effortQ    bool     // the effort is asked
	efforts    []string // the effort question's levels (nil: no model yet)
}

// visibleModels are the models of harness h ("" all) visible under v.
func visibleModels(cat hireintent.Catalog, v visibility, h string) []string {
	var out []string
	for _, name := range hireintent.Harnesses {
		if h != "" && name != h {
			continue
		}
		hc, _ := cat.Harness(name)
		for _, id := range hc.Models {
			if v.shown(id) {
				out = append(out, id)
			}
		}
	}
	return out
}

// sharesWord reports whether a and b have a word in common, or nearly
// ("soul", "sol").
func sharesWord(a, b string) bool {
	split := func(s string) []string {
		return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return r == ' ' || r == '-' })
	}
	for _, x := range split(a) {
		for _, y := range split(b) {
			if x == y || len(x) >= 3 && len(y) >= 3 && len(x)-len(y) <= 1 && len(y)-len(x) <= 1 && (strings.HasPrefix(x, y) || strings.HasPrefix(y, x) || x[0] == y[0] && x[len(x)-1] == y[len(y)-1]) {
				return true
			}
		}
	}
	return false
}

// expect is what a case must give: from the words said and shown only.
func expect(cat hireintent.Catalog, c mcase) want {
	var w want
	harness := c.harness.answer
	if harness != "" && len(visibleModels(cat, c.vis, harness)) == 0 {
		harness = "" // named, with nothing to hire: invalid, its question offers every model
	}
	defaults := visibleModels(cat, c.vis, harness)
	llmSaid, _ := c.llm.of(c.form)
	switch {
	case llmSaid == "" || c.form.name == "omitted" || !sharesWord(llmSaid, c.form.words):
		w.missing = true // nothing the user said outside the task
	case c.form.unknown || c.harness.answer == "claude":
		w.choices = defaults // unknown, or a Sol with Claude Code: asked, never substituted
	case c.form.version != "":
		if c.vis.shown(c.form.version) {
			w.model = c.form.version
		} else {
			w.choices = defaults
		}
	default: // a Sol by its family
		var shownSols []string
		for _, s := range sols {
			if c.vis.shown(s) {
				shownSols = append(shownSols, s)
			}
		}
		near := c.form.near || llmSaid == "GPT soul"
		switch {
		case len(shownSols) > 1:
			w.choices = shownSols
		case len(shownSols) == 0:
			w.choices = defaults
		case near:
			w.classifier = c.cls.make != nil
			if c.cls.picks {
				w.model = shownSols[0]
			} else {
				w.choices = defaults
			}
		default:
			w.model = shownSols[0]
		}
	}
	// The effort.
	said := c.effort.words != "" && c.llmEffort != "null"
	if !said {
		w.effortQ = true
	} else {
		var levels []string
		if w.model != "" {
			levels = cat.Codex.EffortsFor(w.model)
		} else {
			for _, h := range hireintent.Harnesses {
				if harness != "" && h != harness {
					continue
				}
				hc, _ := cat.Harness(h)
				levels = append(levels, hc.Efforts...)
				for _, id := range visibleModels(cat, c.vis, h) {
					levels = append(levels, hc.ExtraEfforts[id]...)
				}
			}
		}
		if slices.Contains(levels, c.effort.level) {
			w.effort = c.effort.level
		} else {
			w.effortQ = true
		}
	}
	if w.effortQ && w.model != "" {
		w.efforts = cat.Codex.EffortsFor(w.model)
	}
	return w
}

// check is what is wrong with r for c ("": nothing).
func check(c mcase, w want, r hireintent.Result, cls *ai.FakeClassifier) string {
	if r.Error != nil || r.Hire == nil || r.Intent != hireintent.IntentHire {
		return fmt.Sprintf("not a hire: %+v %+v", r, r.Error)
	}
	in := r.Hire
	var probs []string
	bad := func(f string, a ...any) { probs = append(probs, fmt.Sprintf(f, a...)) }
	var modelQ, effortQ *hireintent.Question
	for i, q := range in.Questions {
		switch q.Field {
		case hireintent.AskModel:
			modelQ = &in.Questions[i]
		case hireintent.AskEffort:
			effortQ = &in.Questions[i]
		default:
			bad("asks %s", q.Field)
		}
	}
	switch {
	case w.model != "":
		if !in.Model.Valid() || in.Model.Value != w.model || in.Harness.Value != "codex" || modelQ != nil {
			bad("model %+v harness %+v, want %s", in.Model, in.Harness, w.model)
		}
	case w.missing:
		if in.Model.Provenance != hireintent.Missing || modelQ == nil {
			bad("model %+v, want missing", in.Model)
		}
	default:
		if in.Model.Provenance != hireintent.Invalid || modelQ == nil {
			bad("model %+v, want invalid", in.Model)
		}
	}
	if modelQ != nil && w.choices != nil {
		var got []string
		for _, ch := range modelQ.Choices {
			got = append(got, ch.Model)
		}
		if !slices.Equal(got, w.choices) {
			bad("model choices %q, want %q", got, w.choices)
		}
	}
	for _, ch := range append(slices.Clone(func() []hireintent.Choice {
		if modelQ == nil {
			return nil
		}
		return modelQ.Choices
	}()), hireintent.Choice{Harness: "codex", Model: in.Model.Value}) {
		if ch.Model != "" && !c.vis.shown(ch.Model) {
			bad("a hidden model offered or taken: %s", ch.Model)
		}
	}
	switch {
	case w.effort != "":
		if !in.Effort.Valid() || in.Effort.Value != w.effort || effortQ != nil {
			bad("effort %+v, want %s", in.Effort, w.effort)
		}
	case w.effortQ:
		if in.Effort.Valid() || effortQ == nil {
			bad("effort %+v, want asked", in.Effort)
		} else if !slices.Equal(effortQ.Efforts, w.efforts) {
			bad("effort levels %q, want %q", effortQ.Efforts, w.efforts)
		}
	}
	if in.Task.Provenance != hireintent.Dictated || in.Task.Value != c.task || in.Task.Span == nil {
		bad("task %+v", in.Task)
	} else if src := in.Sources[in.Task.Span.Source]; utf16Slice(src, in.Task.Span.Start, in.Task.Span.End) != c.task {
		bad("task span %+v", in.Task.Span)
	}
	ready := w.model != "" && w.effort != ""
	if in.ReadyForReview != ready || (ready && len(in.Questions) != 0) {
		bad("ready_for_review %v, want %v", in.ReadyForReview, ready)
	}
	if cls != nil {
		calls := cls.Calls()
		if (len(calls) > 0) != w.classifier {
			bad("%d classifier calls, want any: %v", len(calls), w.classifier)
		}
		for _, call := range calls {
			if s, _ := call.State["request"].(string); len(call.State) != 1 || strings.Contains(s, c.task) || !strings.Contains(strings.ToLower(s), "soul") && !strings.Contains(strings.ToLower(s), "sol") {
				bad("the classifier read %v", call.State)
			}
			if len(call.Questions) == 0 || len(call.Questions) > ai.MaxQuestions {
				bad("%d questions in a call", len(call.Questions))
			}
		}
	}
	return strings.Join(probs, "; ")
}

func utf16Slice(s string, start, end int) string {
	u := utf16Of(s)
	if start < 0 || end > len(u) || start > end {
		return "\x00out of range"
	}
	return string(utf16Decode(u[start:end]))
}

// matrixInterpret is one interpretation of the matrix: the sentence, the
// pending proposal, the visibility and the classifier.
func matrixInterpret(text string, pending *hireintent.Interpretation, cat hireintent.Catalog, hidden hireintent.Hidden, cls *ai.FakeClassifier, a any) hireintent.Result {
	req := hireintent.Request{Text: text, Pending: pending, Catalog: cat, Hidden: hidden}
	if cls != nil {
		req.Classifier = cls
	}
	return hireintent.Interpret(context.Background(), answerLLM(a), req)
}

// failures collects a matrix's failures, the first few in full.
type failures struct {
	t     *testing.T
	n, of int
}

func (f *failures) add(c fmt.Stringer, text, prob string) {
	f.of++
	if prob == "" {
		return
	}
	f.n++
	if f.n <= 25 {
		f.t.Errorf("%s\n  %q\n  %s", c, text, prob)
	}
}

func (f *failures) done() {
	if f.n > 0 {
		f.t.Errorf("%d of %d cases fail", f.n, f.of)
	}
	f.t.Logf("%d cases", f.of)
}

// Every model form, LLM answer, harness, visibility and classifier state;
// the phrasing, effort and task rotate through theirs.
func TestMatrixModels(t *testing.T) {
	cat := matrixCatalog()
	f := &failures{t: t}
	i := 0
	for _, fm := range forms {
		for _, lm := range llmModels {
			if _, ok := lm.of(fm); !ok {
				continue
			}
			for _, h := range harnessesSaid {
				for _, v := range visibilities {
					for _, cs := range classifierStates {
						i++
						c := mcase{phrasing: i % len(phrasings), harness: h, form: fm, llm: lm, vis: v,
							effort: effortsSaid[i%len(effortsSaid)], llmEffort: llmEfforts[(i/3)%len(llmEfforts)], task: tasks[(i/7)%len(tasks)], cls: cs}
						runCase(t, f, cat, c)
					}
				}
			}
		}
	}
	f.done()
}

// Every effort spelling, LLM answer for it, phrasing and task, for a model
// with xhigh (one Sol shown) and one without (gpt-5.6-sol), said by family
// and by id.
func TestMatrixEfforts(t *testing.T) {
	cat := matrixCatalog()
	f := &failures{t: t}
	for _, e := range effortsSaid {
		for _, le := range llmEfforts {
			for p := range phrasings {
				for _, task := range tasks {
					for _, v := range []visibility{visibilities[0], visibilities[4]} {
						for _, fm := range []form{forms[0], forms[4]} {
							c := mcase{phrasing: p, harness: harnessesSaid[1], form: fm, llm: llmModels[0], vis: v, effort: e, llmEffort: le, task: task, cls: classifierStates[0]}
							runCase(t, f, cat, c)
						}
					}
				}
			}
		}
	}
	f.done()
}

func runCase(t *testing.T, f *failures, cat hireintent.Catalog, c mcase) {
	t.Helper()
	w := expect(cat, c)
	var cls *ai.FakeClassifier
	if c.cls.make != nil {
		cls = c.cls.make()
	}
	text := c.sentence()
	r := matrixInterpret(text, nil, cat, c.vis.hidden, cls, c.answer())
	f.add(c, text, check(c, w, r, cls))
}

// A follow-up reply re-resolves the pending proposal with the visibility
// sent with it: every form and LLM answer, every pair of visibilities
// (first, reply), every classifier state. The reply fills the effort; the
// model is what the first sentence said, under the reply's visibility.
func TestMatrixFollowUpVisibility(t *testing.T) {
	cat := matrixCatalog()
	f := &failures{t: t}
	i := 0
	for _, fm := range forms {
		for _, lm := range llmModels {
			if _, ok := lm.of(fm); !ok || lm.name == "null" {
				continue
			}
			for _, v1 := range visibilities {
				for _, v2 := range visibilities {
					for _, cs := range classifierStates {
						i++
						task := tasks[i%len(tasks)]
						first := mcase{phrasing: i % len(phrasings), harness: harnessesSaid[i%2], form: fm, llm: lm, vis: v1, effort: effortSaid{}, llmEffort: "null", task: task, cls: cs}
						var cls1 *ai.FakeClassifier
						if cs.make != nil {
							cls1 = cs.make()
						}
						text := first.sentence()
						r := matrixInterpret(text, nil, cat, v1.hidden, cls1, first.answer())
						if r.Hire == nil {
							f.add(first, text, fmt.Sprintf("first: %+v", r))
							continue
						}
						pending := roundTrip(t, r.Hire)
						// A harness named with nothing to hire is not carried (#211).
						h := first.harness
						if h.answer != "" && len(visibleModels(cat, v1, h.answer)) == 0 {
							h.answer = ""
						}
						// A model taken is sent back as its id: that is what is read again.
						rl := lm
						if m := r.Hire.Model; m.Valid() {
							rl = llmModel{"pending " + m.Value, func(form) (string, bool) { return m.Value, true }}
						}
						reply := mcase{phrasing: first.phrasing, harness: h, form: fm, llm: rl, vis: v2, effort: effortSaid{"high", "high"}, llmEffort: "level", task: task, cls: cs}
						var cls2 *ai.FakeClassifier
						if cs.make != nil {
							cls2 = cs.make()
						}
						got := matrixInterpret("Use high effort.", pending, cat, v2.hidden, cls2, ans("hire", "", "", "high", ""))
						w := expect(cat, reply)
						f.add(followUp{reply}, text+" / Use high effort.", check(reply, w, got, cls2))
					}
				}
			}
		}
	}
	f.done()
}

type followUp struct{ mcase }

func (f followUp) String() string { return "follow-up " + f.mcase.String() }

// The screenshot's sentence (AC1), word for word, with every LLM answer for
// the model: gpt-6.1-sol, high, the task with its period.
func TestScreenshotSentence(t *testing.T) {
	cat := matrixCatalog()
	text := "Please spawn a GPT Sol agent on high reasoning to solve the issue with the frontend."
	for _, model := range []string{"GPT Sol", "Sol", "GPT soul", "gpt sol", "gpt-6.1-sol"} {
		cls := &ai.FakeClassifier{Score: 0.95}
		r := matrixInterpret(text, nil, cat, visibilities[0].hidden, cls, ans("hire", "", model, "high", "solve the issue with the frontend."))
		in := mustHire(t, r)
		if fields(in) != "h=resolved:codex m=resolved:gpt-6.1-sol e=dictated:high t=dictated" || !in.ReadyForReview ||
			in.Task.Value != "solve the issue with the frontend." || in.Model.Said != model && model != "gpt-6.1-sol" {
			t.Fatalf("%s: %s ready=%v said=%q task=%q", model, fields(in), in.ReadyForReview, in.Model.Said, in.Task.Value)
		}
	}
	// "X high" in every spelling, in the answer as said or as its level.
	for _, e := range []string{"X high", "x high", "x-high", "extra high", "extra-high", "xhigh"} {
		s := strings.Replace(text, "on high reasoning", "on "+e+" reasoning", 1)
		for _, answered := range []string{e, "xhigh"} {
			in := mustHire(t, matrixInterpret(s, nil, cat, visibilities[0].hidden, nil, ans("hire", "", "GPT Sol", answered, "solve the issue with the frontend.")))
			if in.Effort.Value != "xhigh" || !in.ReadyForReview {
				t.Fatalf("%q answered %q: %s", e, answered, fields(in))
			}
			// gpt-5.6-sol has no xhigh: asked, with its levels.
			in = mustHire(t, matrixInterpret(s, nil, cat, visibilities[4].hidden, nil, ans("hire", "", "GPT Sol", answered, "solve the issue with the frontend.")))
			want := hireintent.Question{Field: "effort", Text: "GPT-5.6-Sol does not support “xhigh” effort. Which effort level should this agent use?",
				Efforts: []string{"low", "medium", "high"}}
			if in.Model.Value != "gpt-5.6-sol" || in.Effort.Provenance != hireintent.Invalid || len(in.Questions) != 1 || !questionEq(in.Questions[0], want) {
				t.Fatalf("%q answered %q without xhigh: %s %+v", e, answered, fields(in), in.Questions)
			}
		}
	}
}

// Select's outcomes: a pick needs the score and the margin; two close
// candidates are ambiguous, both offered; none high is unknown; no
// candidates asks nothing; a failure is an error, never a pick. More than
// ai.MaxQuestions candidates are asked in several calls.
func TestSelect(t *testing.T) {
	ctx := context.Background()
	sol := hireintent.Choice{Harness: "codex", Model: "gpt-6.1-sol", Label: "GPT-6.1-Sol"}
	six := hireintent.Choice{Harness: "codex", Model: "gpt-6-sol"}
	scores := func(m map[string]float64) *ai.FakeClassifier {
		return &ai.FakeClassifier{Func: func(_ context.Context, _ map[string]any, q string) (float64, error) {
			for k, v := range m {
				if strings.Contains(q, k) {
					return v, nil
				}
			}
			return 0, nil
		}}
	}
	got, err := hireintent.Select(ctx, scores(map[string]float64{"gpt-6.1-sol": 0.8, "gpt-6-sol": 0.75}), "spawn a gpt soul agent", []hireintent.Choice{sol, six}, nil)
	if err != nil || got.Model.Outcome != hireintent.Ambiguous || !slices.Equal(got.Model.Candidates, []string{"codex/gpt-6.1-sol", "codex/gpt-6-sol"}) || got.Effort.Outcome != hireintent.NotAsked {
		t.Fatalf("close: %+v %v", got, err)
	}
	got, _ = hireintent.Select(ctx, scores(map[string]float64{"gpt-6.1-sol": 0.8, "gpt-6-sol": 0.3}), "x", []hireintent.Choice{sol, six}, nil)
	if got.Model.Outcome != hireintent.Picked || got.Model.Value != "codex/gpt-6.1-sol" {
		t.Fatalf("clear: %+v", got)
	}
	got, _ = hireintent.Select(ctx, scores(map[string]float64{"gpt-6.1-sol": 0.4}), "x", []hireintent.Choice{sol}, nil)
	if got.Model.Outcome != hireintent.Unknown {
		t.Fatalf("low: %+v", got)
	}
	got, _ = hireintent.Select(ctx, scores(map[string]float64{`"medium"`: 0.9}), "x", nil, []string{"medium"})
	if got.Effort.Outcome != hireintent.Picked || got.Effort.Value != "medium" || got.Model.Outcome != hireintent.NotAsked {
		t.Fatalf("effort: %+v", got)
	}
	cls := &ai.FakeClassifier{Score: 0.9}
	if got, err := hireintent.Select(ctx, cls, "x", nil, nil); err != nil || got.Calls != 0 || len(cls.Calls()) != 0 {
		t.Fatalf("nothing to ask: %+v %v", got, err)
	}
	if _, err := hireintent.Select(ctx, &ai.FakeClassifier{Err: errors.New("down")}, "x", []hireintent.Choice{sol}, nil); err == nil {
		t.Fatal("a failure is an error")
	}
	if _, err := hireintent.Select(ctx, nil, "x", []hireintent.Choice{sol}, nil); err == nil {
		t.Fatal("no classifier is an error")
	}
	var many []hireintent.Choice
	for i := range 19 {
		many = append(many, hireintent.Choice{Harness: "codex", Model: fmt.Sprintf("m-%d", i)})
	}
	cls = &ai.FakeClassifier{Score: 0.1}
	got, err = hireintent.Select(ctx, cls, "x", many, []string{"high", "xhigh"})
	if err != nil || got.Calls != 2 || len(cls.Calls()) != 2 || got.Model.Outcome != hireintent.Unknown || len(got.Model.Scores) != 19 {
		t.Fatalf("batches: %+v %v", got, err)
	}
	for _, c := range cls.Calls() {
		if len(c.Questions) > ai.MaxQuestions {
			t.Fatalf("%d questions", len(c.Questions))
		}
	}
}

// A near miss of an effort level ("medum") is the classifier's to pick; a
// word that is no level and near none ("banana") never reaches it.
func TestNearEffort(t *testing.T) {
	cat := matrixCatalog()
	text := "Hire a Codex agent on GPT-6.1-Sol at medum effort. Task: fix it."
	cls := &ai.FakeClassifier{Score: 0.95}
	in := mustHire(t, matrixInterpret(text, nil, cat, nil, cls, ans("hire", "codex", "gpt-6.1-sol", "medum", "fix it.")))
	if in.Effort.Value != "medium" || in.Effort.Provenance != hireintent.Resolved || !in.ReadyForReview || len(cls.Calls()) != 1 {
		t.Fatalf("%s, %d calls", fields(in), len(cls.Calls()))
	}
	in = mustHire(t, matrixInterpret(text, nil, cat, nil, nil, ans("hire", "codex", "gpt-6.1-sol", "medum", "fix it.")))
	if in.Effort.Provenance != hireintent.Invalid || in.ReadyForReview {
		t.Fatalf("without a classifier: %s", fields(in))
	}
	cls = &ai.FakeClassifier{Score: 0.95}
	in = mustHire(t, matrixInterpret("Hire a Codex agent on GPT-6.1-Sol at banana effort. Task: fix it.", nil, cat, nil, cls, ans("hire", "codex", "gpt-6.1-sol", "banana", "fix it.")))
	if in.Effort.Provenance != hireintent.Invalid || len(cls.Calls()) != 0 {
		t.Fatalf("banana: %s, %d calls", fields(in), len(cls.Calls()))
	}
}

// The LLM reads the visible catalog: the hidden models, their labels and
// extra efforts are not in its hire_options. Catalog.Check still reads the
// whole one.
func TestHiddenModelsLeaveTheLLMsCatalog(t *testing.T) {
	cat := matrixCatalog()
	llm := answerLLM(ans("hire", "", "", "", ""))
	hireintent.Interpret(context.Background(), llm, hireintent.Request{Text: "Spawn an agent.", Catalog: cat, Hidden: visibilities[0].hidden})
	p := llm.Calls()[0].Messages[1].Content
	for _, gone := range []string{"gpt-6-sol", "GPT-6-Sol", "gpt-5.6-sol", "ultra"} {
		if strings.Contains(p, gone) {
			t.Fatalf("%q in %s", gone, p)
		}
	}
	if !strings.Contains(p, `"gpt-6.1-sol"`) || !strings.Contains(p, "gpt-6-luna") {
		t.Fatalf("payload %s", p)
	}
	if err := cat.Check("codex", "gpt-6-sol", "ultra"); err != nil {
		t.Fatalf("Check reads the whole catalog: %v", err)
	}
	// Every model of a harness hidden: a harness named with nothing to hire.
	r := hireintent.Interpret(context.Background(), answerLLM(ans("hire", "codex", "", "high", "fix it.")),
		hireintent.Request{Text: "Hire a Codex agent at high effort to fix it.", Catalog: cat, Hidden: visibilities[2].hidden})
	if in := mustHire(t, r); in.Harness.Provenance != hireintent.Invalid || len(in.Questions[0].Choices) != 4 {
		t.Fatalf("all hidden: %s %+v", fields(in), in.Questions)
	}
}

// CheckHidden bounds the list; unknown harnesses and ids are not errors.
func TestCheckHidden(t *testing.T) {
	ok := []hireintent.Hidden{nil, {}, {"codex": {"gpt-9"}, "gemini": {"x"}}, {"codex": {}}}
	for _, h := range ok {
		if err := hireintent.CheckHidden(h); err != nil {
			t.Fatalf("%v: %v", h, err)
		}
	}
	many := hireintent.Hidden{}
	for i := range hireintent.MaxHiddenHarnesses + 1 {
		many[fmt.Sprint("h", i)] = nil
	}
	for name, h := range map[string]hireintent.Hidden{
		"harnesses":  many,
		"ids":        {"codex": slices.Repeat([]string{"x"}, hireintent.MaxHiddenModels+1)},
		"empty id":   {"codex": {""}},
		"long id":    {"codex": {strings.Repeat("x", hireintent.MaxHiddenIDBytes+1)}},
		"nul":        {"codex": {"a\x00b"}},
		"bad utf8":   {"codex": {"\xff"}},
		"no harness": {"": {"x"}},
	} {
		if err := hireintent.CheckHidden(h); err == nil {
			t.Fatalf("%s: no error", name)
		}
	}
}
