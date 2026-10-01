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
// is the config's extra_body.
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
		} `json:"data"`
	}
	if json.Unmarshal(r.body, &body) != nil || body.Data == nil {
		return nil, newErr(KindBadResponse, "the model list is not the expected shape")
	}
	out := make([]ModelInfo, 0, len(body.Data))
	for _, m := range body.Data {
		if m.ID != "" {
			out = append(out, ModelInfo{ID: m.ID})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// complete runs one chat completion. jsonMode says whether to send
// response_format (false: it is known not to work). It returns the text and
// whether response_format was what the endpoint rejected (a 400), so the
// caller can remember and try again without it.
func (o openAI) complete(ctx context.Context, base, key, model string, extra json.RawMessage, req Request, jsonMode bool) (text string, formatRejected bool, err error) {
	body := map[string]any{"model": model, "messages": req.Messages}
	if req.Temperature != nil {
		body["temperature"] = *req.Temperature
	}
	if req.MaxTokens > 0 {
		body["max_tokens"] = req.MaxTokens
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
	r, err := do(ctx, o.hc, http.MethodPost, base+"/chat/completions", key, body, maxAnswerBytes)
	if err != nil {
		return "", false, err
	}
	if r.status == http.StatusBadRequest && req.JSON && jsonMode {
		return "", true, statusErr(r, key)
	}
	if err := statusErr(r, key); err != nil {
		return "", false, err
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(r.body, &out) != nil || len(out.Choices) == 0 {
		return "", false, newErr(KindBadResponse, "the answer has no choices")
	}
	var content string
	if json.Unmarshal(out.Choices[0].Message.Content, &content) != nil || strings.TrimSpace(content) == "" {
		return "", false, newErr(KindBadResponse, "the answer has no text")
	}
	return content, false, nil
}
