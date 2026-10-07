package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
)

// openAI is the client of an OpenAI-compatible endpoint: POST
// {base}/chat/completions, GET {base}/models. Nothing is vendor specific:
// what an endpoint needs beyond the standard body (MiMo's thinking:disabled)
// is the config's extra_body. The model list also reads, when present,
// OpenRouter's per-model reasoning metadata (read-only parsing, #174).
type openAI struct {
	hc *http.Client
}

// maxExtraBody caps the extra_body setting.
const maxExtraBody = 4 << 10

// ParseBaseURL checks and cleans a base URL: http or https, a host, no
// credentials, query or fragment, no trailing slash.
func ParseBaseURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", newErr(KindBadConfig, "the base URL must be an http:// or https:// address")
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(raw, " \t\r\n") {
		return "", newErr(KindBadConfig, "the base URL must not hold credentials, a query or a fragment")
	}
	return trimSlash(u.String()), nil
}

// ParseExtraBody checks the extra_body setting: a JSON object, small, that
// does not replace what the bridge owns. "" and null are no extra body.
func ParseExtraBody(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	if len(raw) > maxExtraBody {
		return nil, newErr(KindBadConfig, fmt.Sprintf("extra_body must be at most %d bytes", maxExtraBody))
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil, newErr(KindBadConfig, "extra_body must be a JSON object")
	}
	for _, k := range []string{"messages", "model", "stream"} {
		if _, ok := m[k]; ok {
			return nil, newErr(KindBadConfig, fmt.Sprintf("extra_body cannot set %q", k))
		}
	}
	if len(m) == 0 {
		return nil, nil
	}
	out, err := json.Marshal(m) // canonical: sorted keys, no spaces
	if err != nil {
		return nil, newErr(KindBadConfig, "extra_body must be a JSON object")
	}
	return out, nil
}

// models lists {base}/models.
func (o openAI) models(ctx context.Context, base, key string) ([]ModelInfo, error) {
	r, err := do(ctx, o.hc, http.MethodGet, base+"/models", key, nil, maxListBytes)
	if err != nil {
		return nil, err
	}
	if r.status == http.StatusNotFound || r.status == http.StatusMethodNotAllowed || r.status == http.StatusNotImplemented {
		return nil, newErr(KindNoModels, "the endpoint has no /models: type the model id")
	}
	if err := statusErr(r, key); err != nil {
		return nil, err
	}
	var body struct {
		Data []struct {
			ID string `json:"id"`
			// OpenRouter's catalog (#174): the model's reasoning controls and
			// the parameters it takes. Other endpoints list the id only.
			Reasoning           json.RawMessage `json:"reasoning"`
			SupportedParameters []string        `json:"supported_parameters"`
		} `json:"data"`
	}
	if json.Unmarshal(r.body, &body) != nil || body.Data == nil {
		return nil, newErr(KindBadResponse, "the model list is not the expected shape")
	}
	out := make([]ModelInfo, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID == "" {
			continue
		}
		mi := ModelInfo{ID: m.ID}
		if r := reasoningOf(m.Reasoning, m.SupportedParameters); r.Support != SupportUnknown {
			r.Model = m.ID
			mi.Reasoning = &r
		}
		out = append(out, mi)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// complete runs one chat completion. jsonMode says whether to send
// response_format (false: it is known not to work). It returns the text and
// whether response_format was what the endpoint rejected (a 400), so the
// caller can remember and try again without it. #174: an answer cut off at
// the token limit is KindTruncated (with no text at all, always; with some,
// when req.NoPartial), one with no text KindEmpty, a 400 to a request that
// set a reasoning effort KindBadConfig; req.Report gets each answer's
// Diagnostics.
func (o openAI) complete(ctx context.Context, base, key, model string, extra json.RawMessage, req Request, jsonMode bool) (text string, formatRejected bool, err error) {
	body := map[string]any{"model": model, "messages": req.Messages}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.JSON && jsonMode {
		body["response_format"] = map[string]string{"type": "json_object"}
	}
	if len(extra) > 0 {
		var m map[string]any
		if json.Unmarshal(extra, &m) == nil {
			for k, v := range m {
				body[k] = v
			}
		}
	}
	if req.ReasoningEffort != "" {
		// One effort control, the setting's: the extra_body's own are dropped.
		delete(body, "reasoning")
		body["reasoning_effort"] = req.ReasoningEffort
	}
	// The budget: the request's own bound wins over an extra_body's of the same
	// kind (it states what this call may spend, and what the settings and the
	// audit show), in the field the extra_body chose (max_completion_tokens is
	// the native OpenAI name), else max_tokens; never both.
	if _, ok := body["max_completion_tokens"]; ok {
		delete(body, "max_tokens")
		if req.MaxTokens > 0 {
			body["max_completion_tokens"] = req.MaxTokens
		}
	} else if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
	}
	r, err := do(ctx, o.hc, http.MethodPost, base+"/chat/completions", key, body, maxAnswerBytes)
	if err != nil {
		return "", false, err
	}
	report := func(d Diagnostics) {
		if req.Report != nil {
			req.Report(d)
		}
	}
	if r.status == http.StatusBadRequest && req.JSON && jsonMode {
		report(Diagnostics{Status: r.status, Content: ContentAbsent})
		return "", true, statusErr(r, key)
	}
	if err := statusErr(r, key); err != nil {
		report(Diagnostics{Status: r.status, Content: ContentAbsent})
		if r.status == http.StatusBadRequest && req.ReasoningEffort != "" {
			return "", false, newErr(KindBadConfig, fmt.Sprintf("the provider rejected the request (HTTP 400) with reasoning effort %q: the model may not take it; choose another effort or the provider default%s", req.ReasoningEffort, detail(r.body, key)))
		}
		return "", false, err
	}
	d, content, ok := diagnose(r.status, r.body)
	d.FinishReason, d.NativeFinishReason = Scrub(d.FinishReason, key), Scrub(d.NativeFinishReason, key)
	report(d)
	if !ok {
		return "", false, newErr(KindBadResponse, "the answer has no choices")
	}
	cut := d.FinishReason == "length"
	switch {
	case d.Content != ContentNonempty && cut:
		return "", false, newErr(KindTruncated, "the model used its whole completion budget"+spent(d, req.MaxTokens)+" before writing any text: raise the completion budget or lower the reasoning effort")
	case d.Content != ContentNonempty:
		why := ""
		if d.FinishReason != "" {
			why = " (finish_reason " + d.FinishReason + ")"
		}
		return "", false, newErr(KindEmpty, "the model returned no text"+why)
	case cut && req.NoPartial:
		return "", false, newErr(KindTruncated, "the answer was cut off at the completion budget"+spent(d, req.MaxTokens)+": raise the budget or lower the reasoning effort")
	}
	return content, false, nil
}

// spent is " (N of M tokens, R of them reasoning)" from what is known.
func spent(d Diagnostics, budget int) string {
	var parts []string
	switch {
	case d.CompletionTokens != nil && budget > 0:
		parts = append(parts, fmt.Sprintf("%d of %d tokens", *d.CompletionTokens, budget))
	case d.CompletionTokens != nil:
		parts = append(parts, fmt.Sprintf("%d tokens", *d.CompletionTokens))
	case budget > 0:
		parts = append(parts, fmt.Sprintf("%d tokens", budget))
	}
	if d.ReasoningTokens != nil {
		parts = append(parts, fmt.Sprintf("%d of them reasoning", *d.ReasoningTokens))
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}
