package ai_test

// #9: the per-request bounds of one feature's call: its own timeout, no
// second paid attempt after an uncertain outcome, the key kept out of the
// messages. None of them changes a call that does not ask for it.

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
)

func msgs(s string) []ai.Message { return []ai.Message{{Role: "user", Content: s}} }

func TestARequestTimeoutOverridesTheSharedOneForThatCallOnly(t *testing.T) {
	llm := newOpenAI(t, "")
	s := newSvc(t, nil, ai.Options{LLMTimeout: 80 * time.Millisecond})
	configureLLM(t, s, llm.URL)
	llm.delay = 200 * time.Millisecond
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("x"), Timeout: 2 * time.Second}); err != nil {
		t.Fatalf("a call with its own longer timeout: %v", err)
	}
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("x")}); kind(t, err) != ai.KindTimeout {
		t.Fatalf("a call without one keeps the shared timeout: %v", err)
	}
	time.Sleep(300 * time.Millisecond) // the abandoned handlers
}

func TestNoUncertainRetryMakesOneAttemptAfterATimeoutOrA5xx(t *testing.T) {
	llm := newOpenAI(t, "")
	s := newSvc(t, nil, ai.Options{LLMTimeout: 80 * time.Millisecond})
	configureLLM(t, s, llm.URL)

	llm.delay = 200 * time.Millisecond
	base := llm.chats.Load()
	_, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("x"), NoUncertainRetry: true})
	if kind(t, err) != ai.KindTimeout {
		t.Fatalf("%v", err)
	}
	time.Sleep(300 * time.Millisecond)
	if n := llm.chats.Load() - base; n != 1 {
		t.Fatalf("a timed-out call was sent %d times, want once", n)
	}

	llm.delay = 0
	base = llm.chats.Load()
	llm.fail5xx.Store(1)
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("x"), NoUncertainRetry: true}); kind(t, err) != ai.KindFailed {
		t.Fatalf("%v", err)
	}
	if n := llm.chats.Load() - base; n != 1 {
		t.Fatalf("a 5xx call was sent %d times, want once", n)
	}

	// Without the flag the shared rule stands: a 5xx is tried again.
	llm.fail5xx.Store(1)
	base = llm.chats.Load()
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("x")}); err != nil {
		t.Fatal(err)
	}
	if n := llm.chats.Load() - base; n != 2 {
		t.Fatalf("%d calls, want the shared retry", n)
	}
}

func TestNoUncertainRetryKeepsTheResponseFormatFallback(t *testing.T) {
	llm := newOpenAI(t, "")
	llm.rejectJSON = true
	s := newSvc(t, nil, ai.Options{})
	configureLLM(t, s, llm.URL)
	base := llm.chats.Load()
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("x"), JSON: true, NoUncertainRetry: true}); err != nil {
		t.Fatalf("a rejected response_format is no uncertain outcome: %v", err)
	}
	if n := llm.chats.Load() - base; n > 2 {
		t.Fatalf("%d calls", n)
	}
}

func TestRedactKeyKeepsTheKeyOutOfTheMessages(t *testing.T) {
	llm := newOpenAI(t, "")
	s := newSvc(t, nil, ai.Options{})
	configureLLM(t, s, llm.URL)
	llm.mu.Lock()
	llm.bodies = nil
	llm.mu.Unlock()
	if _, err := s.LLM().Complete(context.Background(), ai.Request{Messages: msgs("pasted: " + llmKey + " end"), RedactKey: true}); err != nil {
		t.Fatal(err)
	}
	body := llm.bodyAt(0)
	got := body["messages"].([]any)[0].(map[string]any)["content"].(string)
	if strings.Contains(got, llmKey) || got != "pasted: [key] end" {
		t.Fatalf("sent %q", got)
	}
}
