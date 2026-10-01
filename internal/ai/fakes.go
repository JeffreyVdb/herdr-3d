package ai

import (
	"context"
	"sync"
)

// FakeClassifier is a Classifier for the tests of features: it answers from
// Score (default 0.5) or Func, and records its calls. No network.
type FakeClassifier struct {
	Score float64
	Err   error
	Func  func(ctx context.Context, state map[string]any, question string) (float64, error)

	mu    sync.Mutex
	calls []ClassifyCall
}

// ClassifyCall is one call a FakeClassifier saw.
type ClassifyCall struct {
	State    map[string]any
	Question string
}

// Classify implements Classifier.
func (f *FakeClassifier) Classify(ctx context.Context, state map[string]any, question string) (float64, error) {
	f.mu.Lock()
	f.calls = append(f.calls, ClassifyCall{state, question})
	fn, score, err := f.Func, f.Score, f.Err
	f.mu.Unlock()
	if fn != nil {
		return fn(ctx, state, question)
	}
	return score, err
}

// Calls are the calls so far.
func (f *FakeClassifier) Calls() []ClassifyCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ClassifyCall(nil), f.calls...)
}

// FakeLLM is an LLM for the tests of features: it answers Text or Func, and
// records its requests. No network.
type FakeLLM struct {
	Text string
	Err  error
	Func func(ctx context.Context, req Request) (string, error)

	mu    sync.Mutex
	calls []Request
}

// Complete implements LLM.
func (f *FakeLLM) Complete(ctx context.Context, req Request) (string, error) {
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
