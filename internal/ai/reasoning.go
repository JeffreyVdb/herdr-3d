package ai

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

// #174: the reasoning effort of a completion, what a model's catalog entry
// says about it, and the sanitized account of one call (Diagnostics).

// Efforts a gateway knows, lowest first. A model's list is a subset; the
// settings accept these when nothing narrower is known.
var allEfforts = []string{"none", "minimal", "low", "medium", "high", "xhigh", "max"}

// genericEfforts is what is offered when effort selection is unknown (an
// undescribed endpoint, or parameters without a reasoning object).
var genericEfforts = []string{"low", "medium", "high"}

// ValidEffort reports whether e is a reasoning effort the bridge can send
// ("" is not one: it is the provider's default, nothing sent).
func ValidEffort(e string) bool {
	for _, k := range allEfforts {
		if e == k {
			return true
		}
	}
	return false
}

// Support is whether a model supports reasoning, independently of effort selection.
type Support string

const (
	SupportUnknown Support = "unknown" // the catalog says nothing: no /models, or no metadata
	SupportYes     Support = "supported"
	SupportNo      Support = "unsupported"
)

// Reasoning is what is known of a model's reasoning effort. OpenRouter's
// catalog lists it per model (`reasoning.supported_efforts`, the model's
// default, whether it is mandatory); other endpoints list the model's id only
// (Support unknown).
type Reasoning struct {
	Support Support `json:"support"`
	// Model is the model it is of ("" when it is not of any one).
	Model string `json:"model,omitempty"`
	// Efforts are the values to offer, lowest first: the catalog's list
	// (Listed), else the generic set. Empty when reasoning or effort
	// selection is unsupported.
	Efforts []string `json:"efforts"`
	// Listed: Efforts is constrained by the catalog, so another value is
	// refused. An omitted supported_efforts in a reasoning object means
	// an empty allowlist; explicit null allows every gateway effort.
	// When false, any effort the gateway knows may be tried.
	Listed bool `json:"listed"`
	// Default is the effort the provider applies when none is sent ("" when
	// the catalog does not say).
	Default string `json:"default_effort,omitempty"`
	// Mandatory: reasoning cannot be turned off ("none" is not offered).
	Mandatory bool `json:"mandatory,omitempty"`
}

// Allows reports whether the model takes effort e: never when it has no
// reasoning, only the catalog's own list when it has one, else any effort the
// gateway knows.
func (r Reasoning) Allows(e string) bool {
	switch {
	case !ValidEffort(e), r.Support == SupportNo:
		return false
	case r.Listed:
		for _, k := range r.Efforts {
			if k == e {
				return true
			}
		}
		return false
	}
	return !(r.Mandatory && e == "none")
}

// UnknownReasoning is what is known of a model nobody has asked about.
func UnknownReasoning() Reasoning {
	return Reasoning{Support: SupportUnknown, Efforts: append([]string(nil), genericEfforts...)}
}

var effortRe = regexp.MustCompile(`^[a-z0-9_-]{1,16}$`)

// reasoningOf reads a catalog entry (OpenRouter's /models). raw is the
// entry's `reasoning` object, params its `supported_parameters` (nil: not
// listed).
func reasoningOf(raw json.RawMessage, params []string) Reasoning {
	r := UnknownReasoning()
	if s := strings.TrimSpace(string(raw)); s != "" && s != "null" {
		var m struct {
			Efforts   json.RawMessage `json:"supported_efforts"`
			Default   string          `json:"default_effort"`
			Mandatory bool            `json:"mandatory"`
		}
		if json.Unmarshal(raw, &m) == nil {
			r.Support, r.Mandatory = SupportYes, m.Mandatory
			// A reasoning object without supported_efforts explicitly exposes
			// no effort selector. Do not inherit the unknown endpoint's guesses.
			r.Efforts, r.Listed = []string{}, true
			if d := strings.ToLower(strings.TrimSpace(m.Default)); effortRe.MatchString(d) && !(m.Mandatory && d == "none") {
				r.Default = d
			}
			switch e := strings.TrimSpace(string(m.Efforts)); {
			case e == "null":
				r.Efforts, r.Listed = append([]string(nil), allEfforts...), true // every gateway effort
			case e != "":
				var list []string
				if json.Unmarshal(m.Efforts, &list) == nil {
					r.Efforts, r.Listed = orderEfforts(list), true
				}
			}
			if r.Mandatory {
				r.Efforts = without(r.Efforts, "none")
			}
			return r
		}
	}
	if params == nil {
		return r
	}
	r.Support, r.Efforts = SupportNo, []string{}
	for _, p := range params {
		if p == "reasoning" || p == "reasoning_effort" || p == "include_reasoning" {
			r.Support, r.Efforts = SupportYes, append([]string(nil), genericEfforts...)
			break
		}
	}
	return r
}

// orderEfforts is a list as the gateway orders them (lowest first), without
// duplicates or anything that is not a plain token; values it does not know
// follow, as the catalog gave them.
func orderEfforts(list []string) []string {
	have := map[string]bool{}
	for _, e := range list {
		if e = strings.ToLower(strings.TrimSpace(e)); effortRe.MatchString(e) {
			have[e] = true
		}
	}
	out := []string{}
	for _, e := range allEfforts {
		if have[e] {
			out = append(out, e)
			delete(have, e)
		}
	}
	for _, e := range list {
		if e = strings.ToLower(strings.TrimSpace(e)); have[e] {
			out = append(out, e)
			delete(have, e)
		}
	}
	return out
}

func without(list []string, drop string) []string {
	out := make([]string, 0, len(list))
	for _, e := range list {
		if e != drop {
			out = append(out, e)
		}
	}
	return out
}

// Diagnostics is the sanitized account of one completion's HTTP answer: how
// it ended and what it cost, never a key, a prompt, an answer or any
// reasoning text. A count the provider did not report stays nil, apart from
// a zero.
type Diagnostics struct {
	// Outbound controls, normalized to safe values; no endpoint extra_body is retained.
	MaxTokens       int    `json:"max_tokens,omitempty"`
	ReasoningEffort string `json:"reasoning_effort,omitempty"`

	// Status is the HTTP status.
	Status int `json:"status"`
	// FinishReason and NativeFinishReason are the first choice's (the
	// gateway's, then the provider's own): a known one (finishReasons), else
	// "other".
	FinishReason       string `json:"finish_reason,omitempty"`
	NativeFinishReason string `json:"native_finish_reason,omitempty"`
	PromptTokens       *int   `json:"prompt_tokens,omitempty"`
	CompletionTokens   *int   `json:"completion_tokens,omitempty"`
	TotalTokens        *int   `json:"total_tokens,omitempty"`
	// ReasoningTokens are the completion tokens spent on reasoning.
	ReasoningTokens *int `json:"reasoning_tokens,omitempty"`
	// Content is the message's text: ContentAbsent (none, null or not a
	// string), ContentEmpty (blank) or ContentNonempty; ContentChars its
	// length in characters.
	Content      string `json:"content"`
	ContentChars int    `json:"content_chars"`
}

// States of Diagnostics.Content.
const (
	ContentAbsent   = "absent"
	ContentEmpty    = "empty"
	ContentNonempty = "nonempty"
)

// finishReasons are the finish reasons kept in a Diagnostics: the gateway's
// normalized set (OpenAI/OpenRouter) and the common native ones, lowercase.
// Anything else is kept as finishOther: a provider's word is never retained
// as it came, since a reflecting or malformed one could put a key in it.
var finishReasons = map[string]bool{
	"stop": true, "length": true, "tool_calls": true, "content_filter": true, "error": true, "function_call": true,
	"end_turn": true, "max_tokens": true, "max_output_tokens": true, "stop_sequence": true, "tool_use": true,
	"safety": true, "recitation": true, "refusal": true, "pause_turn": true, "complete": true, "eos": true,
	"model_length": true, "blocklist": true, "prohibited_content": true, "spii": true, "malformed_function_call": true,
	"other": true, "unknown": true, "finish_reason_unspecified": true,
}

// finishOther stands for a finish reason that is not in finishReasons.
const finishOther = "other"

// finishReason is a provider's finish reason, canonicalized (lowercase) when
// it is a known one, else finishOther; "" for none.
func finishReason(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	switch {
	case s == "":
		return ""
	case finishReasons[s]:
		return s
	}
	return finishOther
}

func rawFinish(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return finishReason(s)
}

// diagnose reads an answer's body. content is the first choice's message
// text ("" unless it is a string); hasChoice is false for an answer with no
// choices.
func diagnose(status int, body []byte) (d Diagnostics, content string, hasChoice bool) {
	d = Diagnostics{Status: status, Content: ContentAbsent}
	var out struct {
		Choices []struct {
			FinishReason       json.RawMessage `json:"finish_reason"`
			NativeFinishReason json.RawMessage `json:"native_finish_reason"`
			Message            struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage *struct {
			Prompt     *int `json:"prompt_tokens"`
			Completion *int `json:"completion_tokens"`
			Total      *int `json:"total_tokens"`
			Details    *struct {
				Reasoning *int `json:"reasoning_tokens"`
			} `json:"completion_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(body, &out) != nil {
		return d, "", false
	}
	if u := out.Usage; u != nil {
		d.PromptTokens, d.CompletionTokens, d.TotalTokens = u.Prompt, u.Completion, u.Total
		if u.Details != nil {
			d.ReasoningTokens = u.Details.Reasoning
		}
	}
	if len(out.Choices) == 0 {
		return d, "", false
	}
	c := out.Choices[0]
	d.FinishReason, d.NativeFinishReason = rawFinish(c.FinishReason), rawFinish(c.NativeFinishReason)
	if len(c.Message.Content) > 0 && string(c.Message.Content) != "null" && json.Unmarshal(c.Message.Content, &content) == nil {
		d.ContentChars = utf8.RuneCountInString(content)
		d.Content = ContentNonempty
		if strings.TrimSpace(content) == "" {
			d.Content = ContentEmpty
		}
	}
	return d, content, true
}
