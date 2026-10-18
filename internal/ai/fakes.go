package ai

import (
	"context"
	"sync"
)

// FakeClassifier is a Classifier for the tests of features: it answers from
// Score (default 0.5) or Func (ClassifyMany: ManyFunc, else every question
// as Classify answers it), and records its calls: those ctx's gate
// (WithGate) lets go, as the Service sends them. No network.
type FakeClassifier struct {
	Score    float64
	Err      error
	Func     func(ctx context.Context, state map[string]any, question string) (float64, error)
	ManyFunc func(ctx context.Context, state map[string]any, questions map[string]string) (map[string]float64, error)

	mu    sync.Mutex
	calls []ClassifyCall
}

// ClassifyCall is one call a FakeClassifier saw: Question for Classify,
// Questions for ClassifyMany.
type ClassifyCall struct {
	State     map[string]any
	Question  string
	Questions map[string]string
}

// Classify implements Classifier.
func (f *FakeClassifier) Classify(ctx context.Context, state map[string]any, question string) (float64, error) {
	if err := passGate(ctx); err != nil {
		return 0, err
	}
	f.mu.Lock()
	f.calls = append(f.calls, ClassifyCall{State: state, Question: question})
	fn, score, err := f.Func, f.Score, f.Err
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, state, question)
	}
	return score, err
}

// ClassifyMany implements Classifier: one call recorded, its answers from
// ManyFunc, else each question's from Func or Score.
func (f *FakeClassifier) ClassifyMany(ctx context.Context, state map[string]any, questions map[string]string) (map[string]float64, error) {
	if err := passGate(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	f.calls = append(f.calls, ClassifyCall{State: state, Questions: questions})
	many, fn, score, err := f.ManyFunc, f.Func, f.Score, f.Err
	f.mu.Unlock()
	if many != nil {
		return many(ctx, state, questions)
	}
	if err != nil {
		return nil, err
	}
	out := make(map[string]float64, len(questions))
	for k, q := range questions {
		v := score
		if fn != nil {
			var err error
			if v, err = fn(ctx, state, q); err != nil {
				return nil, err
			}
		}
		out[k] = v
	}
	return out, nil
}

// Calls are the calls so far.
func (f *FakeClassifier) Calls() []ClassifyCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ClassifyCall(nil), f.calls...)
}

// FakeLLM is an LLM for the tests of features: it answers Text or Func, and
// records its requests: those ctx's gate (WithGate) lets go. No network.
type FakeLLM struct {
	Text string
	Err  error
	Func func(ctx context.Context, req Request) (string, error)

	mu    sync.Mutex
	calls []Request
}

// Complete implements LLM.
func (f *FakeLLM) Complete(ctx context.Context, req Request) (string, error) {
	if err := passGate(ctx); err != nil {
		return "", err
	}
	f.mu.Lock()
	f.calls = append(f.calls, req)
	fn, text, err := f.Func, f.Text, f.Err
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, req)
	}
	return text, err
}

// Calls are the requests so far.
func (f *FakeLLM) Calls() []Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Request(nil), f.calls...)
}

var (
	_ Classifier = (*FakeClassifier)(nil)
	_ LLM        = (*FakeLLM)(nil)
)
