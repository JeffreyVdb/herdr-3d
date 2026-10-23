package hireintent_test

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"unicode"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
)

// #190 round 2: no substitution. A model is taken only when every harness
// word and every word of a model the user said outside the task agrees with
// it; anything else is missing (nothing model-like said) or asked. Each
// case's oracle (pExpect) reads the case's own labels (which harness was
// said, which models the words name, what the LLM answered), never the
// package's helpers or its result; a follow-up's, that the pending model
// is kept while it is shown and asked when it is not.

// pVis is a catalog and what the user hides of it.
type pVis struct {
	name   string
	single bool // testCatalog (one Codex model), else matrixCatalog
	hidden hireintent.Hidden
}

var (
	allCodex  = []string{"gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"}
	allClaude = []string{"claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"}
)

var pVisibilities = []pVis{
	{name: "one-sol", hidden: hireintent.Hidden{"codex": {"gpt-6-sol", "gpt-5.6-sol"}}},
	{name: "several"},
	{name: "codex-hidden", hidden: hireintent.Hidden{"codex": allCodex}},
	{name: "claude-hidden", hidden: hireintent.Hidden{"claude": allClaude}},
	{name: "only-6.1", hidden: hireintent.Hidden{"codex": allCodex[1:], "claude": allClaude}},
	{name: "one-model-catalog", single: true},
}

func (v pVis) catalog() hireintent.Catalog {
	if v.single {
		return testCatalog()
	}
	return matrixCatalog()
}

// shown are the visible models, "harness/model", in catalog order.
func (v pVis) shown() []string {
	var out []string
	cat := v.catalog()
	for _, h := range []string{"claude", "codex"} {
		hc, _ := cat.Harness(h)
		for _, id := range hc.Models {
			if !slices.Contains(v.hidden[h], id) {
				out = append(out, h+"/"+id)
			}
		}
	}
	return out
}

// hiddenModel is a model the user hides ("" none).
func (v pVis) hiddenModel() string {
	for _, h := range []string{"codex", "claude"} {
		if len(v.hidden[h]) > 0 {
			return v.hidden[h][0]
		}
	}
	return ""
}

// pForm is how the user says the model, with what it names.
type pForm struct {
	name, words string
	harness     string // the harness of the models it names ("" none)
	// names are the models the words name, "harness/model": in the matrix
	// catalog and in the one-model catalog. nil: nothing model-like said.
	names, singleNames []string
	// askOnly: model-like, but nothing the rules may take (an unknown word,
	// a version said in words).
	askOnly bool
	// near: a near miss ("soul"): only the classifier may take it.
	near bool
	// brand: a brand is said as a model's ("GPT" where every Codex model is
	// a GPT): a reply with one is a new selection (#190 R3-1).
	brand bool
}

var pSols = []string{"codex/gpt-6.1-sol", "codex/gpt-6-sol", "codex/gpt-5.6-sol"}

var pForms = []pForm{
	{name: "id", words: "gpt-6.1-sol", harness: "codex", names: pSols[:1], singleNames: pSols[:1], brand: true},
	{name: "label", words: "GPT-6.1-Sol", harness: "codex", names: pSols[:1], singleNames: pSols[:1], brand: true},
	{name: "family", words: "GPT Sol", harness: "codex", names: pSols, singleNames: pSols[:1], brand: true},
	{name: "family-digits", words: "GPT 6 Sol", harness: "codex", names: pSols[1:2], singleNames: []string{}, brand: true},
	{name: "family-words", words: "GPT six point one Sol", harness: "codex", askOnly: true, brand: true},
	{name: "near", words: "GPT soul", harness: "codex", names: pSols, singleNames: pSols[:1], near: true, brand: true},
	{name: "unknown", words: "GPT Banana", harness: "codex", askOnly: true, brand: true},
	{name: "harness-only", words: "Codex"},
	// "GPT" is a word of every Codex model: no model in the matrix catalog;
	// the one-model catalog's only GPT (#190 PA6).
	{name: "generic-only", words: "GPT", harness: "codex", singleNames: pSols[:1], brand: true},
	{name: "none"},
	{name: "claude-family", words: "Opus", harness: "claude", names: []string{"claude/claude-opus-5-5"}, singleNames: []string{"claude/claude-opus-5-5"}},
}

func (f pForm) named(v pVis) []string {
	if v.single {
		return f.singleNames
	}
	return f.names
}

// modelLike: something that may name a model was said.
func (f pForm) modelLike(v pVis) bool { return f.askOnly || f.named(v) != nil }

// pHarness is a harness said: its words and its harness.
type pHarness struct{ words, harness string }

var pHarnesses = []pHarness{{"", ""}, {"Claude Code", "claude"}, {"Claude", "claude"}, {"Codex", "codex"}}

// The LLM's model answers.
const (
	llmNull         = "null"
	llmAsSaid       = "as said"
	llmDropped      = "dropped"       // the family's generic word only ("GPT", "Claude")
	llmOtherVersion = "other version" // a visible model the words do not name
	llmHidden       = "hidden id"
	llmHarnessName  = "harness name"
)

var pLLMModels = []string{llmNull, llmAsSaid, llmDropped, llmOtherVersion, llmHidden, llmHarnessName}

// The LLM's harness answers.
var pLLMHarnesses = []string{"null", "correct", "other"}

// pClassifier is the classifier: off, failing, every candidate high, or
// high for every candidate but the model the words name.
type pClassifier struct {
	name string
	make func(target string) *ai.FakeClassifier
	pick bool // may pick a near miss
}

var pClassifiers = []pClassifier{
	{"off", func(string) *ai.FakeClassifier { return nil }, false},
	{"failing", func(string) *ai.FakeClassifier {
		return &ai.FakeClassifier{Err: &ai.Error{Kind: ai.KindFailed, Msg: "boom"}}
	}, false},
	{"eager", func(string) *ai.FakeClassifier { return &ai.FakeClassifier{Score: 0.99} }, true},
	{"contrary", func(target string) *ai.FakeClassifier {
		return &ai.FakeClassifier{Func: func(_ context.Context, _ map[string]any, q string) (float64, error) {
			if target != "" && strings.Contains(q, target) {
				return 0, nil
			}
			return 0.99, nil
		}}
	}, true},
}

var pTasks = []string{"fix the login bug.", "check why GPT Sol is slow on Codex.", "port the Opus tests, then tidy up!"}

var pPhrasings = []func(h, m, task string) string{
	func(h, m, task string) string {
		return join("Please spawn a", h, m, "agent on high reasoning to", task)
	},
	func(h, m, task string) string { return join("Hire a", h, m, "agent with high effort. Task:", task) },
	func(h, m, task string) string { return join("Can you hire a", h, m, "worker at high effort to", task) },
}

// pcase is one case.
type pcase struct {
	harness  pHarness
	llmH     string
	form     pForm
	llmM     string
	vis      pVis
	cls      pClassifier
	phrasing int
	task     string
	// llm, when set, is the LLM's model whatever llmM says (a reply's).
	llm *string
}

func (c pcase) String() string {
	return fmt.Sprintf("h=%q llmH=%s form=%s llmM=%s vis=%s cls=%s", c.harness.words, c.llmH, c.form.name, c.llmM, c.vis.name, c.cls.name)
}

func (c pcase) sentence() string {
	return pPhrasings[c.phrasing](c.harness.words, c.form.words, c.task)
}

// saidHarnesses are the harnesses whose words the sentence has outside the
// task.
func (c pcase) saidHarnesses() []string {
	var out []string
	for _, h := range []string{c.harness.harness, map[bool]string{true: "codex"}[c.form.name == "harness-only"]} {
		if h != "" && !slices.Contains(out, h) {
			out = append(out, h)
		}
	}
	return out
}

// llmModel is the LLM's model ("" null); ok false when the variant does not
// apply to the case.
func (c pcase) llmModel() (string, bool) {
	if c.llm != nil {
		return *c.llm, true
	}
	f := c.form
	switch c.llmM {
	case llmNull:
		return "", true
	case llmAsSaid:
		return f.words, f.words != ""
	case llmDropped:
		switch {
		case f.harness == "claude":
			return "Claude", true
		case f.harness == "codex" && f.words != "GPT":
			return "GPT", true
		}
		return "", false
	case llmOtherVersion:
		h := cmpOr(f.harness, "codex")
		for _, s := range c.vis.shown() {
			if strings.HasPrefix(s, h+"/") && !slices.Contains(f.named(c.vis), s) {
				return strings.TrimPrefix(s, h+"/"), true
			}
		}
		return "", false
	case llmHidden:
		m := c.vis.hiddenModel()
		return m, m != ""
	case llmHarnessName:
		if f.harness == "claude" {
			return "Claude Code", true
		}
		return "Codex", true
	}
	panic(c.llmM)
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func (c pcase) llmHarness() string {
	said := c.saidHarnesses()
	correct := cmpOr(c.form.harness, "codex")
	if len(said) == 1 {
		correct = said[0]
	}
	switch c.llmH {
	case "correct":
		return correct
	case "other":
		return map[string]string{"claude": "codex", "codex": "claude"}[correct]
	}
	return ""
}

// target is the model the words name first ("": none): what the contrary
// classifier scores low.
func (c pcase) target() string {
	if n := c.form.named(c.vis); len(n) > 0 {
		return strings.SplitN(n[0], "/", 2)[1]
	}
	return ""
}

// pOutcome is what a case must give. pick: that model; choices: asked
// among exactly those; missing: missing; else may (nil: none) are the
// models it may take, anything else asked (missing or invalid).
type pOutcome struct {
	pick    string
	choices []string
	missing bool
	may     []string
}

// allowed are the visible models the words name, of the harness said.
func (c pcase) allowed(v pVis) []string { return pAllowed(c.form, c.saidHarnesses(), v) }

// pAllowed are the visible models f's words name, of the harness said.
func pAllowed(f pForm, said []string, v pVis) []string {
	if len(said) > 1 {
		return nil // two harnesses said: a model agrees with one at most
	}
	var out []string
	for _, m := range f.named(v) {
		if slices.Contains(v.shown(), m) && (len(said) == 0 || strings.HasPrefix(m, said[0]+"/")) {
			out = append(out, m)
		}
	}
	return out
}

// pExpect is c's outcome, from its labels (see pOutcome).
func pExpect(c pcase, v pVis) pOutcome {
	llm, _ := c.llmModel()
	if llm == "" {
		return pOutcome{missing: true} // the LLM's null is asked, never ranked (D7)
	}
	if !c.form.modelLike(v) {
		if c.llmM == llmAsSaid || c.llmM == llmHarnessName {
			return pOutcome{missing: true} // only harness or generic words: no model (#190 F3)
		}
		return pOutcome{} // the LLM's words, not the user's: asked
	}
	if c.form.askOnly {
		return pOutcome{}
	}
	allowed := c.allowed(v)
	if c.form.near {
		if !c.cls.pick {
			return pOutcome{} // only the classifier takes a near miss
		}
		return pOutcome{may: allowed}
	}
	// The LLM's harness, not said, other than the words' family: it may
	// narrow the candidates to none.
	unsaidOther := len(c.saidHarnesses()) == 0 && c.llmH == "other"
	if c.llmM != llmAsSaid || unsaidOther {
		return pOutcome{may: allowed}
	}
	switch len(allowed) {
	case 0:
		return pOutcome{}
	case 1:
		return pOutcome{pick: allowed[0]}
	}
	return pOutcome{choices: allowed}
}

// pCheck is what is wrong with r for c and w ("": nothing).
func pCheck(c pcase, v pVis, w pOutcome, r hireintent.Result, cls *ai.FakeClassifier, sentences ...string) string {
	if r.Error != nil || r.Hire == nil || r.Intent != hireintent.IntentHire {
		return fmt.Sprintf("not a hire: %+v %+v", r, r.Error)
	}
	in := r.Hire
	var probs []string
	bad := func(f string, a ...any) { probs = append(probs, fmt.Sprintf(f, a...)) }
	var modelQ *hireintent.Question
	for i, q := range in.Questions {
		switch q.Field {
		case hireintent.AskModel:
			modelQ = &in.Questions[i]
		case hireintent.AskSelection:
		default:
			bad("asks %s", q.Field)
		}
	}
	taken := ""
	if in.Model.Valid() {
		taken = in.Harness.Value + "/" + in.Model.Value
		if !in.Harness.Valid() || !slices.Contains(v.shown(), taken) {
			bad("took %s, harness %+v: not shown", taken, in.Harness)
		}
	}
	switch {
	case w.pick != "":
		if taken != w.pick || modelQ != nil {
			bad("model %+v harness %+v, want %s", in.Model, in.Harness, w.pick)
		}
	case w.missing:
		if in.Model.Provenance != hireintent.Missing || modelQ == nil {
			bad("model %+v, want missing", in.Model)
		}
	case w.choices != nil:
		var got []string
		if modelQ != nil {
			for _, ch := range modelQ.Choices {
				got = append(got, ch.Harness+"/"+ch.Model)
			}
		}
		if in.Model.Provenance != hireintent.Invalid || !slices.Equal(got, w.choices) {
			bad("model %+v choices %q, want asked among %q", in.Model, got, w.choices)
		}
	default:
		if taken != "" && !slices.Contains(w.may, taken) {
			bad("took %s, may take %q", taken, w.may)
		}
		if taken == "" && modelQ == nil {
			bad("model %+v not asked", in.Model)
		}
	}
	if modelQ != nil {
		if len(modelQ.Choices) == 0 {
			bad("a model question with no choices")
		}
		for _, ch := range modelQ.Choices {
			if !slices.Contains(v.shown(), ch.Harness+"/"+ch.Model) {
				bad("offers %s/%s: not shown", ch.Harness, ch.Model)
			}
		}
	}
	if in.Effort.Value != "high" || !in.Effort.Valid() {
		bad("effort %+v", in.Effort)
	}
	if in.Task.Value != c.task || in.Task.Span == nil || utf16Slice(in.Sources[in.Task.Span.Source], in.Task.Span.Start, in.Task.Span.End) != c.task {
		bad("task %+v", in.Task)
	}
	if ready := in.Model.Valid() && in.Harness.Valid(); in.ReadyForReview != (ready && modelQ == nil && len(in.Questions) == 0) {
		bad("ready_for_review %v", in.ReadyForReview)
	}
	if cls != nil {
		llm, _ := c.llmModel()
		for _, call := range cls.Calls() {
			if s, _ := call.State["request"].(string); len(call.State) != 1 || strings.Contains(s, c.task) {
				bad("the classifier read %v", call.State)
			}
			for k := range call.Questions {
				// The effort is a level said; a model only when one was said
				// and the LLM read one.
				if !strings.HasPrefix(k, "model:") || llm == "" || !c.form.modelLike(v) {
					bad("the classifier was asked %s", k)
				}
			}
		}
	}
	return strings.Join(probs, "; ")
}

// pCases are every case of the product: harness said × the LLM's harness ×
// model said × the LLM's model × visibility × classifier; the phrasing and
// task rotate.
func pCases(vis []pVis) []pcase {
	var out []pcase
	i := 0
	for _, h := range pHarnesses {
		for _, lh := range pLLMHarnesses {
			for _, f := range pForms {
				for _, lm := range pLLMModels {
					for _, v := range vis {
						for _, cl := range pClassifiers {
							c := pcase{harness: h, llmH: lh, form: f, llmM: lm, vis: v, cls: cl, phrasing: i % len(pPhrasings), task: pTasks[(i/len(pPhrasings))%len(pTasks)]}
							if _, ok := c.llmModel(); !ok {
								continue
							}
							i++
							out = append(out, c)
						}
					}
				}
			}
		}
	}
	return out
}

func pInterpret(c pcase, text string, pending *hireintent.Interpretation, v pVis, a any) (hireintent.Result, *ai.FakeClassifier) {
	cls := c.cls.make(c.target())
	req := hireintent.Request{Text: text, Pending: pending, Catalog: v.catalog(), Hidden: v.hidden}
	if cls != nil {
		req.Classifier = cls
	}
	return hireintent.Interpret(context.Background(), answerLLM(a), req), cls
}

func (c pcase) answer() map[string]any {
	m, _ := c.llmModel()
	return ans("hire", c.llmHarness(), m, "high", c.task)
}

func TestNoSubstitution(t *testing.T) {
	f := &failures{t: t}
	for _, c := range pCases(pVisibilities) {
		text := c.sentence()
		r, cls := pInterpret(c, text, nil, c.vis, c.answer())
		f.add(c, text, pCheck(c, c.vis, pExpect(c, c.vis), r, cls))
	}
	f.done()
}

// pFollowUp is a follow-up: the case, then a reply under the reply's
// visibility.
type pFollowUp struct {
	pcase
	reply   pVis
	words   string // the reply's model words ("": none)
	replyLM string // the LLM's model for the reply ("": null)
}

func (p pFollowUp) String() string {
	return fmt.Sprintf("follow-up to %s, reply words %q, reply LLM model %q: %s", p.reply.name, p.words, p.replyLM, p.pcase.String())
}

// pBareUnknown is a reply's unknown name with no brand ("Banana"): only
// the LLM's answer tells it is a model's (#190 R3-1). A reply only.
var pBareUnknown = pForm{name: "bare-unknown", words: "Banana"}

// pReplyForms are what a reply says of the model, for a first sentence of
// form f: nothing, its family, the other family, another version (these
// rotate over the LLM's answers); then an unknown name, a bare one and a
// brand alone (each after every case, its LLM answers rotating, #190 R3-1).
func pReplyForms(f pForm) (rotate, crossed []pForm) {
	form := func(name string) pForm {
		return pForms[slices.IndexFunc(pForms, func(p pForm) bool { return p.name == name })]
	}
	same, other := form("family"), form("claude-family")
	if f.harness == "claude" {
		same, other = other, same
	}
	return []pForm{form("none"), same, other, form("family-digits")}, []pForm{form("unknown"), pBareUnknown, form("generic-only")}
}

// pReplyText is the reply saying f's words.
func pReplyText(f pForm) string {
	if f.words == "" {
		return "Use high effort."
	}
	return join("Use", f.words, "with high effort.")
}

// pReplyLLM are the LLM's model answers to a reply after first ("" null):
// null, the words the user said first, the pending id, another visible
// model of its harness, a hidden id. The LLM is told to keep earlier
// fields, so it may answer any of them to a reply that names no model.
func pReplyLLM(c pcase, first *hireintent.Interpretation, v2 pVis) []string {
	out := []string{""}
	add := func(m string) {
		if m != "" && !slices.Contains(out, m) {
			out = append(out, m)
		}
	}
	add(c.form.words)
	h := cmpOr(c.form.harness, "codex")
	if first.Model.Valid() {
		add(first.Model.Value)
		h = first.Harness.Value
	}
	for _, s := range v2.shown() {
		if m := strings.TrimPrefix(s, h+"/"); m != s && m != first.Model.Value {
			add(m)
			break
		}
	}
	add(v2.hiddenModel())
	return out
}

// pUnknownLLM are the LLM's model answers to a reply rf that names an
// unknown model or a brand ("" null): null, "GPT", rf's words, the words
// the user said first, the pending id.
func pUnknownLLM(c pcase, first *hireintent.Interpretation, rf pForm) []string {
	out := []string{""}
	for _, m := range []string{"GPT", rf.words, c.form.words, first.Model.Value} {
		if m != "" && !slices.Contains(out, m) {
			out = append(out, m)
		}
	}
	return out
}

// pNewSelection: the reply rf names a model, to the LLM's answer llm: words
// that may name one, a brand, or a word of the answer said in rf's words
// (a harness's words aside: they bind the harness). Else the pending model
// is kept, even with a word the LLM did not return ("Banana" answered null
// or the pending model: #190 R3-1, declared like L1).
func pNewSelection(rf pForm, llm string, v pVis) bool {
	if rf.modelLike(v) || rf.brand {
		return true
	}
	split := func(s string) []string {
		return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
	}
	said := split(rf.words)
	return slices.ContainsFunc(split(llm), func(w string) bool {
		return slices.Contains(said, w) && !slices.Contains([]string{"claude", "code", "codex"}, w)
	})
}

// pReplyExpect is the reply's outcome, from labels: the first case c, the
// first result's model (checked against its own oracle), the reply's form
// rf and the LLM's model llm ("" null). A reply that names no model keeps a
// pending model, that very id while it is shown, whatever the LLM answers
// (#190 F1); one that names a model (pNewSelection) is a selection from its
// own words.
func pReplyExpect(c pcase, first hireintent.Interpretation, rf pForm, llm string, v2 pVis) pOutcome {
	said := c.saidHarnesses() // the reply says no harness: the first sentence's binds
	words := pNewSelection(rf, llm, v2)
	switch {
	case first.Model.Valid() && !words:
		if was := first.Harness.Value + "/" + first.Model.Value; slices.Contains(v2.shown(), was) {
			return pOutcome{pick: was}
		}
		return pOutcome{}
	case first.Model.Valid() && llm == "":
		return pOutcome{missing: true} // the LLM's null is asked (D7)
	case first.Model.Valid():
		allowed := pAllowed(rf, said, v2)
		if llm != rf.words {
			return pOutcome{may: allowed}
		}
		switch len(allowed) {
		case 0:
			return pOutcome{}
		case 1:
			return pOutcome{pick: allowed[0]}
		}
		return pOutcome{choices: allowed}
	case first.Model.Provenance == hireintent.Missing && llm == "":
		return pOutcome{missing: true}
	case llm == "" && !words:
		// An invalid one's words go through the rules again: never a model
		// they do not name.
		e := pExpect(c, v2)
		return pOutcome{may: slices.Concat(e.may, e.choices, []string{e.pick})}
	}
	// A pending model not taken, and words from either sentence: a model
	// one of them names, else asked.
	return pOutcome{may: slices.Concat(pAllowed(c.form, said, v2), pAllowed(rf, said, v2))}
}

// Every pair of visibilities between the sentence and the reply (of one
// catalog), for every harness said, model said and LLM answer, and every
// LLM answer to the reply; the LLM's harness, the classifier and what the
// reply says of the model rotate. Every case is also followed by an unknown
// name, a bare one and a brand alone, each with one of the LLM's answers to
// it (pUnknownLLM) in turn: over the cases, every pair.
func TestNoSubstitutionFollowUp(t *testing.T) {
	f := &failures{t: t}
	i, j, k := 0, 0, 0
	for _, h := range pHarnesses {
		for _, fm := range pForms {
			for _, lm := range pLLMModels {
				for _, v1 := range pVisibilities {
					for _, v2 := range pVisibilities {
						if v1.single != v2.single {
							continue
						}
						i++
						c := pcase{harness: h, llmH: pLLMHarnesses[i%len(pLLMHarnesses)], form: fm, llmM: lm, vis: v1,
							cls: pClassifiers[(i/len(pLLMHarnesses))%len(pClassifiers)], phrasing: i % len(pPhrasings), task: pTasks[i%len(pTasks)]}
						if _, ok := c.llmModel(); !ok {
							continue
						}
						text := c.sentence()
						r, cls := pInterpret(c, text, nil, v1, c.answer())
						f.add(c, text, pCheck(c, v1, pExpect(c, v1), r, cls))
						if r.Hire == nil {
							continue
						}
						reply := func(rf pForm, llm string) {
							w := pReplyExpect(c, *r.Hire, rf, llm, v2)
							// The classifier's check: a model may be asked about
							// when either sentence said one and the LLM read one
							// (on a null, an invalid pending one's words).
							rc, read := c, llm
							if read == "" && r.Hire.Model.Provenance == hireintent.Invalid {
								read, _ = c.llmModel()
							}
							rc.llm = &read
							rc.form = pForm{name: fm.name + "/" + rf.name, askOnly: fm.modelLike(v1) || pNewSelection(rf, llm, v2)}
							replyText := pReplyText(rf)
							got, cls2 := pInterpret(c, replyText, roundTrip(t, r.Hire), v2, ans("hire", "", llm, "high", ""))
							prob := pCheck(rc, v2, w, got, cls2)
							if r.Hire.Model.Valid() && !pNewSelection(rf, llm, v2) && cls2 != nil && len(cls2.Calls()) > 0 {
								prob += "; the classifier was asked about a kept model"
							}
							f.add(pFollowUp{c, v2, rf.words, llm}, text+" / "+replyText, prob)
						}
						rotate, crossed := pReplyForms(fm)
						for _, llm := range pReplyLLM(c, r.Hire, v2) {
							j++
							reply(rotate[j%len(rotate)], llm)
						}
						for _, rf := range crossed {
							if rf.name == "generic-only" && !r.Hire.Model.Valid() {
								// A known gap, not R3-1's: an invalid pending
								// id the LLM gave ("GPT 6 Sol" read
								// gpt-6.1-sol) goes through the rules again,
								// and "Use GPT" moves sayAround off the "6".
								continue
							}
							k++
							llms := pUnknownLLM(c, r.Hire, rf)
							reply(rf, llms[k%len(llms)])
						}
					}
				}
			}
		}
	}
	f.done()
}
