package usage

import (
	"bytes"
	"encoding/json"

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
		Type  string `json:"type"`
		Model string `json:"model"`
		Info  *struct {
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
}

func newCodexUsage() *codexUsage { return &codexUsage{byModel: map[string]codexTokens{}} }

var (
	tokenCountTag  = []byte(`"token_count"`)
	turnContextTag = []byte(`"turn_context"`)
)

func (c *codexUsage) line(_ bool, b []byte) {
	if !bytes.Contains(b, tokenCountTag) && !bytes.Contains(b, turnContextTag) {
		return
	}
	var l codexLine
	if json.Unmarshal(b, &l) != nil {
		return
	}
	switch {
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
	}
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
	if w := c.window; w > codexBaseline {
		u.ContextWindow = w
		u.ContextPct = pct(float64(max(c.context-codexBaseline, 0)) / float64(w-codexBaseline))
	} else if w > 0 {
		u.ContextWindow = w
		u.ContextPct = pct(float64(c.context) / float64(w))
	}
	return u
}
