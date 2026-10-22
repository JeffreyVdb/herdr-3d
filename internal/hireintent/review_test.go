package hireintent_test

import (
	"context"
	"errors"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
)

// #190 review round 1: the reviewers' reproductions, as they ran them
// (fakes only). Each picked or kept a model the user did not say on
// 9941737.

// R2 / UX1: a harness said binds, whatever the LLM's harness says.
func TestReviewContradictionAsks(t *testing.T) {
	cat := matrixCatalog()
	in := mustHire(t, matrixInterpret("Hire a Claude Code GPT Sol agent at high effort to fix it.", nil, cat, visibilities[0].hidden,
		&ai.FakeClassifier{Score: .99}, ans("hire", "", "GPT Sol", "high", "fix it.")))
	if in.Model.Valid() {
		t.Fatalf("contradiction picked: %s ready=%v", fields(in), in.ReadyForReview)
	}
}

// R1: a pending model keeps its identity; hidden now, it is asked, never
// another version of its family.
func TestReviewPendingModelHidden(t *testing.T) {
	cat := matrixCatalog()
	first := mustHire(t, matrixInterpret("Hire a GPT Sol agent to fix it.", nil, cat, visibilities[0].hidden, nil, ans("hire", "", "GPT Sol", "", "fix it.")))
	in := mustHire(t, matrixInterpret("Use high effort.", roundTrip(t, first), cat, hireintent.Hidden{"codex": {"gpt-6.1-sol", "gpt-5.6-sol"}}, nil,
		ans("hire", "", "", "high", "")))
	if in.Model.Provenance != hireintent.Invalid {
		t.Fatalf("hidden pending model substituted: first=%s said=%q second=%s ready=%v", fields(first), first.Model.Said, fields(in), in.ReadyForReview)
	}
}

// Review round 2, F1: an effort-only reply where the LLM repeats a model
// (the pending words, its id, another id) keeps the pending model: that
// very id while shown, else asked. Only the reply's own words change it.
func TestR2PendingEchoKeepsIdentity(t *testing.T) {
	cat := matrixCatalog()
	first := mustHire(t, matrixInterpret("Hire a GPT Sol agent to fix it.", nil, cat, visibilities[0].hidden, nil, ans("hire", "", "GPT Sol", "", "fix it.")))
	for _, model := range []string{"GPT Sol", "gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"} {
		t.Run(model, func(t *testing.T) {
			in := mustHire(t, matrixInterpret("Use high effort.", roundTrip(t, first), cat, hireintent.Hidden{"codex": {"gpt-6.1-sol", "gpt-5.6-sol"}}, nil, ans("hire", "", model, "high", "")))
			if in.Model.Provenance != hireintent.Invalid || in.ReadyForReview {
				t.Errorf("hidden pending model substituted: LLM model=%q => %s ready=%v", model, fields(in), in.ReadyForReview)
			}
			kept := mustHire(t, matrixInterpret("Use high effort.", roundTrip(t, first), cat, visibilities[0].hidden, nil, ans("hire", "", model, "high", "")))
			if kept.Model.Value != "gpt-6.1-sol" || !kept.ReadyForReview {
				t.Errorf("shown pending model not kept: LLM model=%q => %s ready=%v", model, fields(kept), kept.ReadyForReview)
			}
		})
	}
	// The reply's own words do change it.
	in := mustHire(t, matrixInterpret("Use GPT 6 Sol with high effort.", roundTrip(t, first), cat, hireintent.Hidden{"codex": {"gpt-6.1-sol", "gpt-5.6-sol"}}, nil, ans("hire", "", "gpt-6.1-sol", "high", "")))
	if in.Model.Value != "gpt-6-sol" || !in.ReadyForReview {
		t.Errorf("the reply's model not taken: %s ready=%v", fields(in), in.ReadyForReview)
	}
}

// R4 / UX2: a version said in words is never another version.
func TestReviewSpokenVersions(t *testing.T) {
	cat := matrixCatalog()
	for _, m := range []string{"GPT Sol", "gpt-6-sol"} {
		in := mustHire(t, matrixInterpret("Hire a GPT six point one Sol agent at high effort to fix it.", nil, cat,
			hireintent.Hidden{"codex": {"gpt-6.1-sol", "gpt-5.6-sol"}}, nil, ans("hire", "", m, "high", "fix it.")))
		if in.Model.Valid() {
			t.Errorf("verbal 6.1 becomes 6: answer=%q %s ready=%v", m, fields(in), in.ReadyForReview)
		}
	}
}

// R3: a harness word alone is no model.
func TestReviewHarnessWordIsNoModel(t *testing.T) {
	cat := matrixCatalog()
	in := mustHire(t, matrixInterpret("Hire a Codex agent at high effort to fix it.", nil, cat, hireintent.Hidden{"codex": {"gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"}}, nil,
		ans("hire", "codex", "codex", "high", "fix it.")))
	if in.Model.Valid() {
		t.Errorf("harness-only becomes model: %s ready=%v", fields(in), in.ReadyForReview)
	}
}

// R4: a word the LLM dropped ("Banana") is never the visible model.
func TestReviewUnknownPrefix(t *testing.T) {
	cat := matrixCatalog()
	in := mustHire(t, matrixInterpret("Hire a GPT Banana agent on high reasoning to fix it.", nil, cat, hireintent.Hidden{"codex": {"gpt-6-sol", "gpt-5.6-sol", "gpt-6-luna"}},
		&ai.FakeClassifier{Score: .99}, ans("hire", "", "GPT", "high", "fix it.")))
	if in.Model.Valid() {
		t.Fatalf("unknown model replaced: %s ready=%v", fields(in), in.ReadyForReview)
	}
	// The same with GPT naming one model only (a catalog where it is no
	// generic word): Banana is still unexplained.
	in = mustHire(t, interpret(t, "Hire a GPT Banana agent on high reasoning to fix it.", nil, testCatalog(), ans("hire", "", "GPT", "high", "fix it.")))
	if in.Model.Valid() {
		t.Fatalf("unknown model replaced (one GPT): %s ready=%v", fields(in), in.ReadyForReview)
	}
}

// UX1, UX2: with every classifier state.
func TestReviewRequiredAsks(t *testing.T) {
	for _, tc := range []struct{ name, text, model string }{
		{"contradiction", "Hire Claude Code GPT Sol on high effort. Task: fix it.", "GPT Sol"},
		{"spoken-version", "Hire GPT six Sol on high effort. Task: fix it.", "gpt-6.1-sol"},
	} {
		for _, mode := range []string{"off", "ready", "failing"} {
			t.Run(tc.name+"/"+mode, func(t *testing.T) {
				req := hireintent.Request{Text: tc.text, Catalog: matrixCatalog(), Hidden: hireintent.Hidden{"codex": {"gpt-6-sol", "gpt-5.6-sol"}}}
				if mode != "off" {
					cls := &ai.FakeClassifier{Score: 0.99}
					if mode == "failing" {
						cls.Err = errors.New("fake unavailable")
					}
					req.Classifier = cls
				}
				in := mustHire(t, hireintent.Interpret(context.Background(), answerLLM(ans("hire", "", tc.model, "high", "fix it.")), req))
				if in.ReadyForReview || in.Model.Valid() {
					t.Errorf("picked %s", fields(in))
				}
			})
		}
	}
}
