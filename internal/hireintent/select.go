package hireintent

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

// #190: the classifier's part. Resolve takes every value it can by exact
// words (an id, a readable name, a family, an effort's spoken forms). What
// is left is a near miss of a value said outside the task ("GPT soul" for
// gpt-6.1-sol): Select asks the classifier, with only the selection text
// (the dictation without the task) and the near candidates, whether the
// user chose each one. It picks only above an absolute score and a margin
// over the runner-up; anything else is asked.

// Outcomes of a field (Pick.Outcome).
const (
	Picked    = "picked"    // Value is the choice
	NotAsked  = "missing"   // no candidates: nothing to ask the classifier
	Ambiguous = "ambiguous" // more than one candidate scored high: Candidates
	Unknown   = "unknown"   // no candidate scored high enough
)

// Classifier constants, from the live matrix (docs/decisions.md #190; the
// configured jev-preview, 2026-10-22, the issue's 12 sentences as the
// tuning set, three runs each). With modelQuestion, a misheard name
// ("GPT soul" for GPT-6.1-Sol) scored 0.39-0.48, a name said right 0.90-0.96,
// and every sentence that names no model or another one (omitted, "GPT
// Banana", the model only in the task) at most 0.15. A contradiction ("Claude
// Code … GPT Sol") scored 0.8, but never reaches the classifier: a harness
// named restricts the candidates to its models. A universal 0.5 would refuse
// every misheard name.
const (
	// PickScore is the least score of a pick: between 0.15 and 0.39.
	PickScore = 0.3
	// PickMargin is how far a pick must score above the runner-up (two
	// near candidates the words tell apart; with one, its score is its
	// margin).
	PickMargin = 0.15
	// SelectTimeout bounds the classifier's calls of one interpretation
	// (they run in parallel, ai.DefaultClassifierTimeout each).
	SelectTimeout = 2 * ai.DefaultClassifierTimeout
)

// Pick is the classifier's outcome for one field.
type Pick struct {
	Outcome string
	// Value is the pick (Picked).
	Value string
	// Candidates scored at least PickScore, best first (Ambiguous).
	Candidates []string
	// Scores are every candidate's score.
	Scores map[string]float64
}

// Selection is Select's outcome: the model's (a Choice's Harness/Model as
// "harness/model"), the effort's, and how many classifier calls it made.
type Selection struct {
	Model  Pick
	Effort Pick
	Calls  int
}

// Select asks cls which of models and efforts the selection text chooses:
// one yes/no question per candidate, in calls of at most ai.MaxQuestions,
// in parallel. No candidates for a field: NotAsked, and no question. Any
// call failing fails the whole (no pick, never a guess).
func Select(ctx context.Context, cls ai.Classifier, selection string, models []Choice, efforts []string) (Selection, error) {
	type q struct{ key, text string }
	var qs []q
	for _, m := range models {
		name, short := m.Model, familyName(m.Model)
		if m.Label != "" {
			name, short = m.Label+", id "+m.Model, familyName(m.Label)
		}
		qs = append(qs, q{"model:" + modelKey(m), fmt.Sprintf(modelQuestion, name, short)})
	}
	for _, e := range efforts {
		qs = append(qs, q{"effort:" + e, fmt.Sprintf(effortQuestion, effortSpoken(e))})
	}
	sel := Selection{Model: Pick{Outcome: NotAsked}, Effort: Pick{Outcome: NotAsked}}
	if len(qs) == 0 {
		return sel, nil
	}
	if cls == nil {
		return sel, ai.ErrNotReady
	}
	state := map[string]any{"request": selection}
	scores := map[string]float64{}
	var mu sync.Mutex
	var firstErr error
	var wg sync.WaitGroup
	for batch := range slices.Chunk(qs, ai.MaxQuestions) {
		m := make(map[string]string, len(batch))
		for _, x := range batch {
			m[x.key] = x.text
		}
		sel.Calls++
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, err := cls.ClassifyMany(ctx, state, m)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				for k := range m {
					if _, ok := got[k]; !ok {
						err = fmt.Errorf("no score for a question")
					}
				}
			}
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			maps.Copy(scores, got)
		}()
	}
	wg.Wait()
	if firstErr != nil {
		return sel, firstErr
	}
	pick := func(prefix string, keys []string) Pick {
		if len(keys) == 0 {
			return Pick{Outcome: NotAsked}
		}
		p := Pick{Scores: map[string]float64{}}
		for _, k := range keys {
			p.Scores[k] = scores[prefix+k]
		}
		return decide(p)
	}
	var mk []string
	for _, m := range models {
		mk = append(mk, modelKey(m))
	}
	sel.Model, sel.Effort = pick("model:", mk), pick("effort:", efforts)
	return sel, nil
}

// decide is p's outcome from its scores: the best when it scores PickScore
// and beats the runner-up by PickMargin; else Ambiguous with every
// candidate at PickScore or more when there are two, else Unknown.
func decide(p Pick) Pick {
	keys := slices.Sorted(maps.Keys(p.Scores))
	sort.SliceStable(keys, func(i, j int) bool { return p.Scores[keys[i]] > p.Scores[keys[j]] })
	best, second := p.Scores[keys[0]], 0.0
	if len(keys) > 1 {
		second = p.Scores[keys[1]]
	}
	switch {
	case best >= PickScore && best-second >= PickMargin:
		p.Outcome, p.Value = Picked, keys[0]
	case second >= PickScore:
		p.Outcome = Ambiguous
		for _, k := range keys {
			if p.Scores[k] >= PickScore {
				p.Candidates = append(p.Candidates, k)
			}
		}
	default:
		p.Outcome = Unknown
	}
	return p
}

// modelKey is a model's key in a Selection: "harness/model".
func modelKey(c Choice) string { return c.Harness + "/" + c.Model }

// The questions: one per candidate. modelQuestion names the model by its
// family ("GPT Sol") and its full name; it was the best of ten wordings on
// the tuning set (one that said "answer no for another version" scored a
// correct "GPT Sol" 0.1).
const (
	modelQuestion = "This request was transcribed from speech and may misspell model names. Which AI model does it ask for? " +
		"Answer yes if it asks for %[2]s (%[1]s), spelled correctly or as a similar-sounding word; no otherwise."
	effortQuestion = "The request was dictated by voice. Does it choose %s reasoning effort for the new agent? " +
		"Answer no when it names no effort level or a different one."
)

// familyName is a model name without its versions: "GPT-6.1-Sol" is "GPT
// Sol".
func familyName(name string) string {
	return strings.Join(strings.FieldsFunc(name, func(r rune) bool { return !unicode.IsLetter(r) }), " ")
}

// effortSpoken is how an effort level is said: its word and its spoken
// forms.
func effortSpoken(e string) string {
	if ws := effortWords[e]; len(ws) > 0 {
		return fmt.Sprintf("%q (also said %q)", e, ws[0])
	}
	return fmt.Sprintf("%q", e)
}

// selectTimeout bounds Select within ctx's own deadline.
func selectTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if d, ok := ctx.Deadline(); ok && time.Until(d) < SelectTimeout {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, SelectTimeout)
}
