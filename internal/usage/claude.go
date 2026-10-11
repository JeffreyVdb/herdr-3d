package usage

import (
	"bytes"
	"encoding/json"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// MaxMessages bounds the message ids a Claude session remembers for
// de-duplication. Records of one message follow each other closely, so
// forgetting the oldest ids changes nothing; their tokens stay counted.
const MaxMessages = 8192

// tokens are one usage's token counts.
type tokens struct {
	input, output, write5m, write1h, read int64
}

func (a *tokens) add(b tokens, sign int64) {
	a.input += sign * b.input
	a.output += sign * b.output
	a.write5m += sign * b.write5m
	a.write1h += sign * b.write1h
	a.read += sign * b.read
}

func (a tokens) zero() bool { return a == tokens{} }

func (a tokens) cost(p Price) float64 {
	return (float64(a.input)*p.Input + float64(a.output)*p.Output + float64(a.write5m)*p.CacheWrite +
		float64(a.write1h)*p.write1h() + float64(a.read)*p.CacheRead) / 1e6
}

// claudeLine is what the bridge reads of a Claude Code transcript line:
// assistant messages' usage, cost-state snapshots and compact boundaries.
type claudeLine struct {
	Type        string `json:"type"`
	Subtype     string `json:"subtype"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	RequestID   string `json:"requestId"`
	Message     *struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			Input         int64 `json:"input_tokens"`
			Output        int64 `json:"output_tokens"`
			CacheCreation int64 `json:"cache_creation_input_tokens"`
			CacheRead     int64 `json:"cache_read_input_tokens"`
			Split         *struct {
				M5 int64 `json:"ephemeral_5m_input_tokens"`
				H1 int64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
	TotalCostUSD        *float64 `json:"totalCostUSD"`
	HasUnknownModelCost bool     `json:"hasUnknownModelCost"`
}

// claudeUser is what the cache evidence reads of a user line: a prompt or a
// tool result (not a meta line, not a subagent's).
type claudeUser struct {
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	IsMeta      bool   `json:"isMeta"`
}

// cacheCounts are a main request's cache tokens: the cache read, the writes
// as the cache_creation split reports them (m5, h1) and the total created.
type cacheCounts struct {
	read, creation, m5, h1 int64
}

// relevant: the request read or wrote the cache, so it refreshed it.
func (k cacheCounts) relevant() bool { return k.read > 0 || k.creation > 0 }

// claudeReq is a main request as its records show it: the time of its first
// record, the latest prompt or tool result before that (it started between
// the two), and its cache counts (the latest record's).
type claudeReq struct {
	model       string
	from, first time.Time
	cacheCounts
	applied bool // its cache evidence was taken
}

type claudeMsg struct {
	model string
	t     tokens
	post  bool // first seen after the cost-state snapshot
}

// claudeSnapshot is a session's last cost-state line: Claude Code's own
// cost of everything up to it (subagents and side calls included), as of
// the main transcript's last assistant message before it.
type claudeSnapshot struct {
	total   float64
	unknown bool
	at      time.Time
}

// claudeUsage sums a Claude Code session's usage from its main transcript
// and its subagents' (their message ids never overlap). Each assistant
// message is counted once, with its last record (a streamed message's
// records repeat with growing output). With a cost-state snapshot the cost
// is the snapshot's plus an estimate of the messages after it.
type claudeUsage struct {
	msgs    map[string]*claudeMsg
	order   []string          // message ids, oldest first (to forget)
	all     map[string]tokens // by model
	post    map[string]tokens // messages after the snapshot, by model
	snap    *claudeSnapshot
	lastTS  time.Time // the main transcript's latest assistant message
	model   string    // the main transcript's last model
	any     string    // the last model anywhere
	context int64     // the main transcript's last prompt (input, cache writes and reads)
	// ctxOK: context is a measure. A /compact boundary clears it (the summary's
	// size is not known, and preTokens is the old context's) until the next
	// main assistant message.
	ctxOK bool
	// long: the main model's context was seen above 200k, which only the long
	// window allows. Kept across a compact; dropped when the model changes.
	long    bool
	longFor string // the model (without [1m]) it was seen on

	// The prompt cache's evidence (#224), from the main thread only.
	trigger  time.Time             // the latest prompt or tool result: a request starts after it
	reqs     map[string]*claudeReq // main requests by requestId (message id without one)
	reqOrder []string              // their keys, oldest first (to forget)
	last     *claudeReq            // the last relevant request: it read or wrote the cache
	wpol     string                // the policy the latest writing request showed ("": none since a reset)
	reason   string                // why unknown with no request since a compaction: "compacted"
}

func newClaudeUsage() *claudeUsage {
	return &claudeUsage{msgs: map[string]*claudeMsg{}, all: map[string]tokens{}, post: map[string]tokens{},
		reqs: map[string]*claudeReq{}}
}

var (
	assistantTag       = []byte(`"assistant"`)
	costStateTag       = []byte(`"cost-state"`)
	compactBoundaryTag = []byte(`"compact_boundary"`)
	userTag            = []byte(`"user"`)
)

func (c *claudeUsage) line(main bool, b []byte) {
	if main && bytes.Contains(b, userTag) {
		c.user(b)
	}
	if !bytes.Contains(b, assistantTag) && !bytes.Contains(b, costStateTag) && !bytes.Contains(b, compactBoundaryTag) {
		return // most lines: skip without decoding
	}
	var l claudeLine
	if json.Unmarshal(b, &l) != nil {
		return
	}
	switch l.Type {
	case "system":
		if main && l.Subtype == "compact_boundary" {
			c.ctxOK = false
			c.last, c.wpol, c.reason = nil, "", "compacted"
		}
	case "cost-state":
		if !main || l.TotalCostUSD == nil {
			return
		}
		c.snap = &claudeSnapshot{total: *l.TotalCostUSD, unknown: l.HasUnknownModelCost, at: c.lastTS}
		c.post = map[string]tokens{}
		for _, m := range c.msgs {
			m.post = false
		}
	case "assistant":
		m := l.Message
		if m == nil || m.Usage == nil || m.ID == "" || m.Model == "" || m.Model == "<synthetic>" {
			return // <synthetic>: Claude Code's own error messages, no usage
		}
		u := m.Usage
		t := tokens{input: u.Input, output: u.Output, read: u.CacheRead}
		// The 5m/1h split of cache writes; what it leaves out is priced as
		// 1h writes (the dearer).
		if u.Split != nil {
			t.write5m = min(max(u.Split.M5, 0), u.CacheCreation)
		}
		t.write1h = u.CacheCreation - t.write5m
		ts, _ := time.Parse(time.RFC3339Nano, l.Timestamp)
		if main {
			if ts.After(c.lastTS) {
				c.lastTS = ts
			}
			c.model, c.context, c.ctxOK = m.Model, u.Input+u.CacheCreation+u.CacheRead, true
			if base := strings.TrimSuffix(m.Model, oneM); base != c.longFor {
				c.long = false
			}
			if c.context > claudeBaseWindow {
				c.long, c.longFor = true, strings.TrimSuffix(m.Model, oneM)
			}
			if !l.IsSidechain {
				k := cacheCounts{read: u.CacheRead, creation: u.CacheCreation}
				if u.Split != nil {
					k.m5, k.h1 = u.Split.M5, u.Split.H1
				}
				key := l.RequestID
				if key == "" {
					key = m.ID
				}
				c.request(key, ts, m.Model, k)
			}
		}
		c.any = m.Model
		post := c.snap != nil && ts.After(c.snap.at)
		if old := c.msgs[m.ID]; old != nil {
			c.addTo(old.model, old.t, old.post, -1)
			post = old.post
		} else {
			c.order = append(c.order, m.ID)
			if len(c.order) > MaxMessages {
				delete(c.msgs, c.order[0])
				c.order = c.order[1:]
			}
		}
		c.msgs[m.ID] = &claudeMsg{model: m.Model, t: t, post: post}
		c.addTo(m.Model, t, post, 1)
	}
}

func (c *claudeUsage) addTo(model string, t tokens, post bool, sign int64) {
	a := c.all[model]
	a.add(t, sign)
	c.all[model] = a
	if post {
		p := c.post[model]
		p.add(t, sign)
		c.post[model] = p
	}
}

// user takes a main prompt or tool result as the start of the next request.
func (c *claudeUsage) user(b []byte) {
	var l claudeUser
	if json.Unmarshal(b, &l) != nil || l.Type != "user" || l.IsSidechain || l.IsMeta {
		return
	}
	if ts, err := time.Parse(time.RFC3339Nano, l.Timestamp); err == nil {
		c.trigger = ts
	}
}

// request takes one record of a main request (key: its requestId). The
// first record fixes when it started; its cache counts are the latest
// record's. The first relevant one makes it the last relevant request: its
// writes set the policy, and a model change forgets the old one's.
func (c *claudeUsage) request(key string, at time.Time, model string, k cacheCounts) {
	r := c.reqs[key]
	if r == nil {
		r = &claudeReq{model: model, from: c.trigger, first: at}
		if !at.IsZero() && r.from.After(at) {
			r.from = time.Time{} // a prompt stamped after the response: no bound
		}
		c.reqs[key] = r
		c.reqOrder = append(c.reqOrder, key)
		if len(c.reqOrder) > MaxMessages {
			delete(c.reqs, c.reqOrder[0])
			c.reqOrder = c.reqOrder[1:]
		}
	}
	r.cacheCounts = k
	if r.applied || !k.relevant() {
		return
	}
	r.applied = true
	if c.last != nil && c.last.model != model {
		c.wpol = ""
	}
	c.last, c.reason = r, ""
	switch {
	case k.m5 > 0 && k.h1 > 0:
		c.wpol = proto.CachePolicyObservedMixed
	case k.h1 > 0:
		c.wpol = proto.CachePolicyObserved1h
	case k.m5 > 0:
		c.wpol = proto.CachePolicyObserved5m
	}
}

// cacheEvidence is the main thread's prompt-cache evidence; nil before any
// relevant request or compaction.
func (c *claudeUsage) cacheEvidence() *proto.UsageCache {
	if c.last == nil && c.reason == "" {
		return nil
	}
	u := &proto.UsageCache{Estimated: true, Provider: proto.CacheProviderAnthropic, Model: c.model}
	if c.last == nil {
		u.Policy, u.Reason = proto.CachePolicyUnknown, c.reason
		return u
	}
	r := c.last
	u.Model, u.CacheRead = r.model, r.read
	u.RequestFrom, u.RequestTo = unixMS(r.from), unixMS(r.first)
	if u.RequestFrom == 0 {
		u.Reason = "no prompt or tool result before the last request: its start is unknown"
	}
	switch c.wpol {
	case proto.CachePolicyObserved1h:
		setRetention(u, c.wpol, ttl1h, ttl1h)
	case proto.CachePolicyObserved5m:
		setRetention(u, c.wpol, ttl5m, ttl5m)
	case proto.CachePolicyObservedMixed:
		setRetention(u, c.wpol, ttl5m, ttl1h)
	default: // no writes seen: the documented range (1h with a subscription, 5m on the API)
		setRetention(u, proto.CachePolicyDocumented, ttl5m, ttl1h)
	}
	return u
}

func (c *claudeUsage) usage(p *Pricing) proto.Usage {
	var sum tokens
	for _, t := range c.all {
		sum.add(t, 1)
	}
	u := proto.Usage{Input: sum.input, Output: sum.output, CacheWrite: sum.write5m + sum.write1h, CacheRead: sum.read}
	u.Tokens = u.Input + u.Output + u.CacheWrite
	priced, base, unknown := c.all, 0.0, false
	if c.snap != nil {
		priced, base, unknown = c.post, c.snap.total, c.snap.unknown
	}
	cost, unknownModel := priceModels(p, Claude, priced, func(t tokens, pr Price) float64 { return t.cost(pr) })
	u.CostUSDEst = roundCost(base + cost)
	u.Model = c.model
	if u.Model == "" {
		u.Model = c.any
	}
	switch {
	case u.Model == "" && c.snap == nil:
		u.Priced = proto.PricedNone
	case unknown || unknownModel:
		u.Priced = proto.PricedUnknownModel
	default:
		u.Priced = proto.PricedKnown
	}
	if c.model != "" {
		u.ContextWindow, u.ContextWindowEstimated = p.ClaudeWindow(c.model, c.long)
		if c.ctxOK {
			u.ContextTokens = c.context
			if u.ContextWindow > 0 {
				u.ContextPct = pct(float64(c.context) / float64(u.ContextWindow))
			}
		}
	}
	if u.Cache = c.cacheEvidence(); u.Cache != nil {
		u.Cache.ContextTokens = u.ContextTokens
	}
	return u
}

// priceModels prices per-model counts (in model order, so the sum is
// stable) and reports whether a model with tokens was unknown.
func priceModels[T interface{ zero() bool }](p *Pricing, harness string, by map[string]T, cost func(T, Price) float64) (float64, bool) {
	models := make([]string, 0, len(by))
	for m := range by {
		models = append(models, m)
	}
	sort.Strings(models)
	total, unknown := 0.0, false
	for _, m := range models {
		t := by[m]
		if t.zero() {
			continue
		}
		pr, known := p.Lookup(harness, m)
		unknown = unknown || !known
		total += cost(t, pr)
	}
	return total, unknown
}

func roundCost(usd float64) float64 { return math.Round(usd*1e6) / 1e6 }

// pct is a share as a percentage with one decimal, capped at 100.
func pct(share float64) *float64 {
	v := math.Round(min(max(share, 0), 1)*1000) / 10
	return &v
}
