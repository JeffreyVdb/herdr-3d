// Package usage reads coding agents' transcripts incrementally for their
// token usage and prices it: Claude Code session transcripts (and their
// subagents') and Codex rollouts. It only reads files.
package usage

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strings"
)

// Harnesses.
const (
	Claude = "claude"
	Codex  = "codex"
)

//go:embed pricing.json
var builtinPricing []byte

// Price is one model's rates in USD per million tokens.
type Price struct {
	Harness string  `json:"harness,omitempty"` // claude | codex (default: claude for claude-…, else codex)
	Input   float64 `json:"input"`             // uncached input
	Output  float64 `json:"output"`
	// CacheWrite prices cache writes (Claude: 5-minute ones); CacheWrite1h
	// Claude's 1-hour cache writes (default CacheWrite).
	CacheWrite   float64  `json:"cache_write"`
	CacheWrite1h *float64 `json:"cache_write_1h,omitempty"`
	CacheRead    float64  `json:"cache_read"`
	// ContextWindow is the model's context window in tokens (Claude; Codex
	// rollouts carry their own). 0: unknown.
	ContextWindow int64 `json:"context_window,omitempty"`
}

func (p Price) write1h() float64 {
	if p.CacheWrite1h != nil {
		return *p.CacheWrite1h
	}
	return p.CacheWrite
}

// Pricing is the pricing table: known models, and per harness the most
// expensive one, which prices unknown models.
type Pricing struct {
	models map[string]Price
	top    map[string]string
}

// PricingFile is the pricing table's JSON form (pricing.json, and the
// --pricing override).
type PricingFile struct {
	Source string           `json:"source,omitempty"`
	Models map[string]Price `json:"models"`
}

// DefaultPricing is the built-in table (pricing.json).
func DefaultPricing() *Pricing {
	p, err := parsePricing(builtinPricing, nil)
	if err != nil {
		panic("usage: built-in pricing: " + err.Error())
	}
	return p
}

// LoadPricing reads a pricing file and merges it over the built-in table:
// its models replace built-in ones of the same name and add new ones.
func LoadPricing(path string) (*Pricing, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	p, err := parsePricing(b, DefaultPricing().models)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return p, nil
}

func parsePricing(b []byte, base map[string]Price) (*Pricing, error) {
	var f PricingFile
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&f); err != nil {
		return nil, err
	}
	p := &Pricing{models: map[string]Price{}, top: map[string]string{}}
	for name, pr := range base {
		p.models[name] = pr
	}
	for name, pr := range f.Models {
		if name == "" || len(name) > 200 || strings.TrimSpace(name) != name {
			return nil, fmt.Errorf("model %q: bad name", name)
		}
		if pr.Harness == "" {
			pr.Harness = Codex
			if strings.HasPrefix(name, "claude-") {
				pr.Harness = Claude
			}
		}
		if pr.Harness != Claude && pr.Harness != Codex {
			return nil, fmt.Errorf("model %q: harness %q is not claude or codex", name, pr.Harness)
		}
		for _, r := range []float64{pr.Input, pr.Output, pr.CacheWrite, pr.write1h(), pr.CacheRead} {
			if r < 0 || math.IsNaN(r) || math.IsInf(r, 0) {
				return nil, fmt.Errorf("model %q: rates must be finite and >= 0", name)
			}
		}
		if pr.ContextWindow < 0 {
			return nil, fmt.Errorf("model %q: context_window must be >= 0", name)
		}
		p.models[name] = pr
	}
	names := make([]string, 0, len(p.models))
	for name := range p.models {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		pr := p.models[name]
		if cur, ok := p.top[pr.Harness]; !ok || dearer(pr, p.models[cur]) {
			p.top[pr.Harness] = name
		}
	}
	return p, nil
}

// dearer orders models by output, then input, then cache read price.
func dearer(a, b Price) bool {
	if a.Output != b.Output {
		return a.Output > b.Output
	}
	if a.Input != b.Input {
		return a.Input > b.Input
	}
	return a.CacheRead > b.CacheRead
}

// oneM marks a Claude model id run with the 1M context window.
const oneM = "[1m]"

// Lookup returns the price of model for harness: the model's own
// (known), else the harness's most expensive model's.
func (p *Pricing) Lookup(harness, model string) (pr Price, known bool) {
	base := strings.TrimSuffix(model, oneM)
	if pr, ok := p.models[base]; ok && pr.Harness == harness {
		if base != model {
			pr.ContextWindow = 1_000_000
		}
		return pr, true
	}
	pr = p.models[p.top[harness]]
	pr.ContextWindow = 0 // an unknown model's window is unknown
	if base != model {
		pr.ContextWindow = 1_000_000
	}
	return pr, false
}

// Claude windows: 200k is the base window; the current families run 1M
// natively (a 200k plan or a gateway can still cap them).
const (
	claudeBaseWindow = 200_000
	claudeLongWindow = 1_000_000
)

// claudeFamilyWindows are the windows assumed for a Claude model the table
// does not list, by id prefix. Window only: the price stays unknown.
var claudeFamilyWindows = []struct {
	prefix string
	window int64
}{
	{"claude-opus-", claudeLongWindow},
	{"claude-sonnet-", claudeLongWindow},
	{"claude-fable-", claudeLongWindow},
	{"claude-haiku-", claudeBaseWindow},
}

// ClaudeWindow resolves the context window of a Claude session whose main
// model is model, and whether it was assumed. In order: an explicit [1m]
// on the model; observed, context seen above 200k (proves the long
// window); the table's window for the model (an entry without one stays
// unknown: an override's say); the model family's. 0: unknown.
func (p *Pricing) ClaudeWindow(model string, observedOver200k bool) (window int64, estimated bool) {
	base := strings.TrimSuffix(model, oneM)
	switch {
	case base != model, observedOver200k:
		return claudeLongWindow, false
	case model == "":
		return 0, false
	}
	if pr, ok := p.models[base]; ok && pr.Harness == Claude {
		return pr.ContextWindow, pr.ContextWindow > 0
	}
	for _, f := range claudeFamilyWindows {
		if strings.HasPrefix(base, f.prefix) {
			return f.window, true
		}
	}
	return 0, false
}

// Models is the table: model → price.
func (p *Pricing) Models() map[string]Price {
	out := make(map[string]Price, len(p.models))
	for k, v := range p.models {
		out[k] = v
	}
	return out
}
