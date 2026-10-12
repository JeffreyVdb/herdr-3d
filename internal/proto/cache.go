package proto

// #224: the main thread's prompt-cache evidence, Usage.Cache. It is what the
// transcript showed, never a measurement or a promise: no request is made to
// learn it, and the state (CacheWarm, CacheExpired, CacheUnknown) is an
// estimate the reader computes at display time from the expiry interval
// (usage.CacheState in the bridge, cacheEstimate in the game), so a
// published Usage never has to be sent again as time passes.

// Cache states (estimated: "likely warm", "may have expired", "unknown").
const (
	CacheWarm    = "warm"
	CacheExpired = "expired"
	CacheUnknown = "unknown"
)

// Cache providers.
const (
	CacheProviderAnthropic = "anthropic"
	CacheProviderOpenAI    = "openai"
)

// Where a cache retention comes from.
const (
	// CachePolicyObserved1h: the latest request that wrote the cache wrote
	// 1-hour entries only (Claude's cache_creation.ephemeral_1h_input_tokens).
	CachePolicyObserved1h = "observed_1h"
	// CachePolicyObserved5m: it wrote 5-minute entries only.
	CachePolicyObserved5m = "observed_5m"
	// CachePolicyObservedMixed: it wrote both (the range is 5m–1h).
	CachePolicyObservedMixed = "observed_mixed"
	// CachePolicyDocumented: no write evidence; the provider's documented
	// defaults for this route and model give the range.
	CachePolicyDocumented = "documented"
	// CachePolicyAssumed: a route whose retention is not documented (Codex
	// signed in with ChatGPT); the range is an assumption, said so.
	CachePolicyAssumed = "assumed"
	// CachePolicyUnknown: nothing to go on (no request seen since a
	// compaction or a model change, or no timing).
	CachePolicyUnknown = "unknown"
)

// UsageCache is the evidence (all value fields: Usage stays comparable).
// Times are unix ms, durations ms; 0 is unknown. The last relevant request
// (the main thread's latest that read or wrote the cache; never a
// subagent's, a compaction's or a title's) started somewhere in
// [RequestFrom, RequestTo]; the cache expires somewhere in [ExpiresFrom,
// ExpiresTo] = [RequestFrom + TTLMin, RequestTo + TTLMax].
type UsageCache struct {
	// Estimated is always true: it is an estimate.
	Estimated bool   `json:"estimated"`
	Provider  string `json:"provider,omitempty"`
	Model     string `json:"model,omitempty"`
	// Auth is the account route when known: Codex's auth_mode ("chatgpt",
	// "apikey"); "" unknown (Claude Code's is not in its transcript).
	Auth   string `json:"auth,omitempty"`
	Policy string `json:"policy"`
	// TTLMin and TTLMax bound the retention (equal when one is known).
	TTLMin int64 `json:"ttl_min_ms,omitempty"`
	TTLMax int64 `json:"ttl_max_ms,omitempty"`
	// RequestFrom and RequestTo bound the last relevant request's start.
	RequestFrom int64 `json:"request_from,omitempty"`
	RequestTo   int64 `json:"request_to,omitempty"`
	ExpiresFrom int64 `json:"expires_from,omitempty"`
	ExpiresTo   int64 `json:"expires_to,omitempty"`
	// CacheRead is the last relevant request's cache-read tokens: what the
	// previous call reused, not what the next one will.
	CacheRead int64 `json:"cache_read,omitempty"`
	// ContextTokens is the main thread's context the estimate's "about N
	// tokens" uses (Usage.ContextTokens; not the transcript file's size).
	ContextTokens int64 `json:"context_tokens,omitempty"`
	// Reason says why it is unknown when it is ("compacted", "model
	// changed", "no request timing", …).
	Reason string `json:"reason,omitempty"`
}

// CacheEstimate is a UsageCache's state at a time (computed, never sent in
// Usage): State is CacheWarm only before ExpiresFrom, CacheExpired only
// after ExpiresTo, else CacheUnknown.
type CacheEstimate struct {
	State     string     `json:"state"`
	Estimated bool       `json:"estimated"`
	Evidence  UsageCache `json:"evidence"`
}
