package ai

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// DefaultClassifierURL is Jev's API (TypeSafe).
const DefaultClassifierURL = "https://api.typesafe.ai"

// questionKey names the one question of a request and its answer.
const questionKey = "question"

// jev is the client of the classification model: one POST per question to
// /v1/systemone, the model list at /v1/models. Both Bearer-authenticated.
type jev struct {
	hc   *http.Client
	base string
}

// ModelInfo is one model of a list.
type ModelInfo struct {
	ID          string `json:"id"`
	Description string `json:"description,omitempty"`
}

func (j jev) models(ctx context.Context, key string) ([]ModelInfo, error) {
	r, err := do(ctx, j.hc, http.MethodGet, j.base+"/v1/models", key, nil, maxListBytes)
	if err != nil {
		return nil, err
	}
	if err := statusErr(r, key); err != nil {
		return nil, err
	}
	var body struct {
		Models []struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		} `json:"models"`
	}
	if json.Unmarshal(r.body, &body) != nil || body.Models == nil {
		return nil, newErr(KindBadResponse, "the model list is not the expected shape")
	}
	out := make([]ModelInfo, 0, len(body.Models))
	for _, m := range body.Models {
		if m.Name != "" {
			out = append(out, ModelInfo{ID: m.Name, Description: clip(m.Description, 200)})
		}
	}
	return out, nil
}

func (j jev) classify(ctx context.Context, key, model string, state map[string]any, question string) (float64, error) {
	if state == nil {
		state = map[string]any{}
	}
	body := map[string]any{
		"model": model,
		"state": state,
		"questions": map[string]any{
			questionKey: map[string]any{"type": "noul", "instructions": question},
		},
	}
	r, err := do(ctx, j.hc, http.MethodPost, j.base+"/v1/systemone", key, body, maxAnswerBytes)
	if err != nil {
		return 0, err
	}
	if err := statusErr(r, key); err != nil {
		return 0, err
	}
	var out struct {
		Answers map[string]struct {
			Noul *float64 `json:"noul"`
		} `json:"answers"`
	}
	if json.Unmarshal(r.body, &out) != nil {
		return 0, newErr(KindBadResponse, "the answer is not JSON")
	}
	a, ok := out.Answers[questionKey]
	if !ok || a.Noul == nil || *a.Noul < 0 || *a.Noul > 1 || *a.Noul != *a.Noul {
		return 0, newErr(KindBadResponse, "the answer has no score in [0,1]")
	}
	return *a.Noul, nil
}

func trimSlash(s string) string { return strings.TrimRight(s, "/") }
