package usage

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// codexBaseline is the part of the context window Codex keeps for its own
// prompt; its TUI reports the rest (codex-rs tui token_usage.rs).
const codexBaseline = 12000

// codexTokens are a Codex token_count's counts. Input includes cached
// input and cache writes; output includes reasoning.
type codexTokens struct {
	Input  int64 `json:"input_tokens"`
	Cached int64 `json:"cached_input_tokens"`
	Write  int64 `json:"cache_write_input_tokens"`
	Output int64 `json:"output_tokens"`
	Total  int64 `json:"total_tokens"`
}

func (a codexTokens) zero() bool { return a == codexTokens{} }

func (a codexTokens) uncached() int64 { return max(a.Input-a.Cached-a.Write, 0) }

// covers reports whether a counts at least b in every field.
func (a codexTokens) covers(b codexTokens) bool {
	return a.Input >= b.Input && a.Cached >= b.Cached && a.Write >= b.Write && a.Output >= b.Output
}

func (a codexTokens) minus(b codexTokens) codexTokens {
	return codexTokens{Input: a.Input - b.Input, Cached: a.Cached - b.Cached, Write: a.Write - b.Write, Output: a.Output - b.Output,
		Total: a.Total - b.Total}
}

func (a codexTokens) plus(b codexTokens) codexTokens {
	return codexTokens{Input: a.Input + b.Input, Cached: a.Cached + b.Cached, Write: a.Write + b.Write, Output: a.Output + b.Output,
		Total: a.Total + b.Total}
}

func (a codexTokens) cost(p Price) float64 {
	return (float64(a.uncached())*p.Input + float64(a.Cached)*p.CacheRead + float64(a.Write)*p.CacheWrite +
		float64(a.Output)*p.Output) / 1e6
}

type codexLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type          string  `json:"type"`
		Model         string  `json:"model"`
		ModelProvider string  `json:"model_provider"`
		StartedAt     float64 `json:"started_at"`
		CompletedAt   float64 `json:"completed_at"`
		Info          *struct {
			Total  codexTokens `json:"total_token_usage"`
			Last   codexTokens `json:"last_token_usage"`
			Window int64       `json:"model_context_window"`
		} `json:"info"`
	} `json:"payload"`
}

// codexUsage follows a Codex rollout: the last token_count with info
// holds the session's totals (an info-less one changes nothing), the last
// turn_context the model. Growth between token_counts is priced at the
// model active then; a counter that goes down starts the sums over.
type codexUsage struct {
	model   string
	total   *codexTokens
	byModel map[string]codexTokens // sums to total
	context int64                  // the last request's tokens
	window  int64
	// ctxOK: context is a measure. A compaction clears it until the next
	// token_count, which counts the history that replaced the old.
	ctxOK bool

	// The prompt cache's evidence (#224).
	provider string     // the session_meta's model_provider ("": openai)
	auth     string     // Codex's auth_mode ("": unknown)
	turn     *codexTurn // the current (or latest) turn
	last     *codexReq  // the last relevant request: it read cached input or wrote the cache
	reason   string     // why unknown with no request since a compaction: "compacted"
}

// codexTurn is a turn's start and completion, unix ms (0: unknown; end 0
// while it runs).
type codexTurn struct{ start, end int64 }

// codexReq is a request that read or wrote the cache: its model, its cached
// input tokens and the turn it was in.
type codexReq struct {
	model string
	read  int64
	turn  *codexTurn
}

func newCodexUsage(auth string) *codexUsage {
	return &codexUsage{byModel: map[string]codexTokens{}, auth: auth}
}

var (
	tokenCountTag   = []byte(`"token_count"`)
	turnContextTag  = []byte(`"turn_context"`)
	compactedTag    = []byte(`"compacted"`)
	ctxCompactTag   = []byte(`"context_compacted"`)
	sessionMetaTag  = []byte(`"session_meta"`)
	taskStartedTag  = []byte(`"task_started"`)
	taskCompleteTag = []byte(`"task_complete"`)
)

func (c *codexUsage) line(_ bool, b []byte) {
	if !bytes.Contains(b, tokenCountTag) && !bytes.Contains(b, turnContextTag) && !bytes.Contains(b, compactedTag) &&
		!bytes.Contains(b, ctxCompactTag) && !bytes.Contains(b, sessionMetaTag) && !bytes.Contains(b, taskStartedTag) &&
		!bytes.Contains(b, taskCompleteTag) {
		return
	}
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return
	}
	switch {
	case l.Type == "compacted" || l.Type == "event_msg" && l.Payload.Type == "context_compacted":
		c.ctxOK = false
		c.last, c.reason = nil, "compacted"
	case l.Type == "session_meta":
		c.provider = l.Payload.ModelProvider
	case l.Type == "event_msg" && l.Payload.Type == "task_started":
		c.turn = &codexTurn{start: secondsMS(l.Payload.StartedAt)}
	case l.Type == "event_msg" && l.Payload.Type == "task_complete":
		if c.turn == nil {
			c.turn = &codexTurn{}
		}
		if c.turn.start == 0 {
			c.turn.start = secondsMS(l.Payload.StartedAt)
		}
		c.turn.end = secondsMS(l.Payload.CompletedAt)
	case l.Type == "turn_context":
		if l.Payload.Model != "" {
			c.model = l.Payload.Model
		}
	case l.Type == "event_msg" && l.Payload.Type == "token_count" && l.Payload.Info != nil:
		cur := l.Payload.Info.Total
		switch {
		case c.total == nil:
			c.byModel[c.model] = cur
		case cur.covers(*c.total):
			c.byModel[c.model] = c.byModel[c.model].plus(cur.minus(*c.total))
		default: // the counters were reset
			c.byModel = map[string]codexTokens{c.model: cur}
		}
		c.total = &cur
		c.context, c.window = l.Payload.Info.Last.Total, l.Payload.Info.Window
		c.ctxOK = c.context > 0
		if last := l.Payload.Info.Last; last.Cached > 0 || last.Write > 0 {
			c.last, c.reason = &codexReq{model: c.model, read: last.Cached, turn: c.turn}, ""
		}
	}
}

// cacheEvidence is the prompt-cache evidence; nil before any relevant
// request or compaction. A request's start is in its turn's span; the
// retention is the model's and the auth route's (see codexRetention).
func (c *codexUsage) cacheEvidence() *proto.UsageCache {
	if c.last == nil && c.reason == "" {
		return nil
	}
	u := &proto.UsageCache{Estimated: true, Provider: c.provider, Model: c.model, Auth: c.auth}
	if u.Provider == "" {
		u.Provider = proto.CacheProviderOpenAI
	}
	if c.last == nil {
		u.Policy, u.Reason = proto.CachePolicyUnknown, c.reason
		return u
	}
	u.Model, u.CacheRead = c.last.model, c.last.read
	if t := c.last.turn; t != nil {
		u.RequestFrom, u.RequestTo = t.start, t.end
	}
	policy, lo, hi, why := codexRetention(u.Model, c.auth)
	setRetention(u, policy, lo, hi)
	if u.Reason = why; why == "" && u.RequestFrom == 0 {
		u.Reason = "no turn start before the last request: its start is unknown"
	}
	return u
}

// codexRetention is a model's cache retention (min, max ms; max 0: no
// documented bound) on an auth route: OpenAI documents 30 minutes or more
// for GPT-5.6 and later, and 5 to 60 minutes before that, on the API. A
// ChatGPT sign-in's lifetime is not documented, so it is assumed to be
// unknown; without auth.json, the model's range is assumed.
func codexRetention(model, auth string) (policy string, min, max int64, reason string) {
	later := gptFrom56(model)
	switch {
	case auth == "chatgpt":
		return proto.CachePolicyAssumed, 0, 0, "ChatGPT-subscription cache lifetime is not documented"
	case auth == "" && later:
		return proto.CachePolicyAssumed, ttl30m, 0, ""
	case auth == "":
		return proto.CachePolicyAssumed, ttl5m, ttl1h, ""
	case later:
		return proto.CachePolicyDocumented, ttl30m, 0, ""
	}
	return proto.CachePolicyDocumented, ttl5m, ttl1h, ""
}

// gptFrom56 reports whether model is GPT-5.6 or later ("gpt-5.6-…",
// "gpt-6-sol", "gpt-6.1-sol").
func gptFrom56(model string) bool {
	rest, ok := strings.CutPrefix(model, "gpt-")
	if !ok {
		return false
	}
	major, rest := leadingNum(rest)
	minor, _ := leadingNum(strings.TrimPrefix(rest, "."))
	return major > 5 || major == 5 && minor >= 6
}

// leadingNum is the number s starts with (0: none) and the rest of s.
func leadingNum(s string) (int, string) {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	n, _ := strconv.Atoi(s[:i])
	return n, s[i:]
}

// secondsMS is a unix time in seconds as ms (0: unknown).
func secondsMS(s float64) int64 {
	if s <= 0 {
		return 0
	}
	return int64(s * 1000)
}

// codexAuthMode is the auth_mode of CODEX_HOME's auth.json (the parent of
// the sessions directory): "" when it cannot be read. Nothing else in the
// file is kept.
func codexAuthMode(sessions string) string {
	if sessions == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(sessions), "auth.json"))
	if err != nil {
		return ""
	}
	var a struct {
		AuthMode string `json:"auth_mode"`
	}
	if json.Unmarshal(b, &a) != nil {
		return ""
	}
	return a.AuthMode
}

func (c *codexUsage) usage(p *Pricing) proto.Usage {
	u := proto.Usage{Model: c.model, Priced: proto.PricedNone}
	if c.total != nil {
		t := *c.total
		u.Input, u.CacheRead, u.CacheWrite, u.Output = t.uncached(), t.Cached, t.Write, t.Output
		u.Tokens = u.Input + u.Output + u.CacheWrite
	}
	cost, unknown := priceModels(p, Codex, c.byModel, func(t codexTokens, pr Price) float64 { return t.cost(pr) })
	u.CostUSDEst = roundCost(cost)
	switch {
	case unknown:
		u.Priced = proto.PricedUnknownModel
	case c.model != "" || c.total != nil:
		u.Priced = proto.PricedKnown
	}
	// The window is Codex's own (never assumed). The percentage leaves out
	// Codex's baseline, as its TUI does; the count is the raw one.
	if w := c.window; w > 0 {
		u.ContextWindow = w
		if c.ctxOK {
			u.ContextTokens = c.context
			if w > codexBaseline {
				u.ContextPct = pct(float64(max(c.context-codexBaseline, 0)) / float64(w-codexBaseline))
			} else {
				u.ContextPct = pct(float64(c.context) / float64(w))
			}
		}
	}
	if u.Cache = c.cacheEvidence(); u.Cache != nil {
		u.Cache.ContextTokens = u.ContextTokens
	}
	return u
}
