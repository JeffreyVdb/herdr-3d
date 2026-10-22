package hireintent

import (
	"context"
	"fmt"
	"maps"
	"slices"
	"sort"
	"sync"
	"time"

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

// Classifier constants (TODO(#190 live): the live matrix's).
const (
	// PickScore is the least score of a pick.
	PickScore = 0.5
	// PickMargin is how far a pick must score above the runner-up.
	PickMargin = 0.2
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
		name := m.Model
		if m.Label != "" {
			name = m.Label + " (" + m.Model + ")"
		}
		qs = append(qs, q{"model:" + modelKey(m), fmt.Sprintf(modelQuestion, name)})
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

// The questions (the issue's experiment: one per candidate; spoken
// aliases, a name misheard, nothing chosen and a contradiction are said).
const (
	modelQuestion = "The request was dictated by voice, so a name may be misheard (\"soul\" for \"Sol\"). " +
		"Does it choose the AI model %s for the new agent? Answer no when it names no model, a different model, " +
		"another version, or a harness this model does not run on."
	effortQuestion = "The request was dictated by voice. Does it choose %s reasoning effort for the new agent? " +
		"Answer no when it names no effort level or a different one."
)

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
