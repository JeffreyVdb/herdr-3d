package usage

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// The prompt-cache evidence (#224). Times are fake: the clock is the test's.

const (
	cacheOpus   = "claude-opus-5-5"
	cacheSonnet = "claude-sonnet-5-0"
)

func cacheAt(ts string) time.Time {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		panic(err)
	}
	return t
}

func cacheMS(ts string) int64 { return cacheAt(ts).UnixMilli() }

// cUser is a main prompt (or tool result) at ts.
func cUser(ts string) string {
	return `{"type":"user","isSidechain":false,"timestamp":"` + ts + `","message":{"role":"user","content":"go"}}` + "\n"
}

// cReq is one record of a request (requestId req, message msg) with input 10
// tokens, m5 and h1 cache writes (as the cache_creation split) and read.
func cReq(req, msg, model, ts string, m5, h1, read int64) string {
	return `{"type":"assistant","isSidechain":false,"timestamp":"` + ts + `","requestId":"` + req + `","message":{"id":"` + msg +
		`","model":"` + model + `","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":` + itoa(m5+h1) +
		`,"cache_read_input_tokens":` + itoa(read) + `,"cache_creation":{"ephemeral_5m_input_tokens":` + itoa(m5) +
		`,"ephemeral_1h_input_tokens":` + itoa(h1) + `}}}}` + "\n"
}

// cSide marks a line as a sidechain's.
func cSide(line string) string {
	return strings.Replace(line, `"isSidechain":false`, `"isSidechain":true`, 1)
}

func cCompact(ts string) string {
	return `{"type":"system","subtype":"compact_boundary","timestamp":"` + ts + `"}` + "\n"
}

// feedClaude gives lines to a parser as main (or a subagent's) lines.
func feedClaude(c *claudeUsage, main bool, lines ...string) {
	for _, l := range lines {
		c.line(main, []byte(l))
	}
}

// claudeCache is the main thread's cache evidence after lines.
func claudeCache(lines ...string) *proto.UsageCache {
	c := newClaudeUsage()
	feedClaude(c, true, lines...)
	return c.usage(DefaultPricing()).Cache
}

func anthropicCache(model, policy string, lo, hi int64, from, to, read, ctx int64) proto.UsageCache {
	want := proto.UsageCache{Estimated: true, Provider: proto.CacheProviderAnthropic, Model: model, Policy: policy,
		TTLMin: lo, TTLMax: hi, RequestFrom: from, RequestTo: to, CacheRead: read, ContextTokens: ctx}
	if from > 0 && lo > 0 {
		want.ExpiresFrom = from + lo
	}
	if to > 0 && hi > 0 {
		want.ExpiresTo = to + hi
	}
	return want
}

func TestClaudeCacheRetention(t *testing.T) {
	const (
		prompt = "2026-10-11T10:00:00Z"
		first  = "2026-10-11T10:00:02Z"
	)
	cases := []struct {
		name  string
		lines []string
		want  proto.UsageCache
	}{
		{"1h only", []string{cUser(prompt), cReq("req_1", "msg_1", cacheOpus, first, 0, 1000, 0)},
			anthropicCache(cacheOpus, proto.CachePolicyObserved1h, ttl1h, ttl1h, cacheMS(prompt), cacheMS(first), 0, 1010)},
		{"5m only", []string{cUser(prompt), cReq("req_1", "msg_1", cacheOpus, first, 1000, 0, 0)},
			anthropicCache(cacheOpus, proto.CachePolicyObserved5m, ttl5m, ttl5m, cacheMS(prompt), cacheMS(first), 0, 1010)},
		{"5m and 1h", []string{cUser(prompt), cReq("req_1", "msg_1", cacheOpus, first, 600, 400, 0)},
			anthropicCache(cacheOpus, proto.CachePolicyObservedMixed, ttl5m, ttl1h, cacheMS(prompt), cacheMS(first), 0, 1010)},
		{"read only: documented", []string{cUser(prompt), cReq("req_1", "msg_1", cacheOpus, first, 0, 0, 5000)},
			anthropicCache(cacheOpus, proto.CachePolicyDocumented, ttl5m, ttl1h, cacheMS(prompt), cacheMS(first), 5000, 5010)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := claudeCache(tc.lines...)
			if got == nil || *got != tc.want {
				t.Fatalf("cache = %+v\nwant    %+v", got, tc.want)
			}
		})
	}
}

// A read-only request refreshes the timer (it is the last relevant request)
// but keeps the observed policy: zero 1h writes in it prove nothing.
func TestClaudeCacheReadRefresh(t *testing.T) {
	got := claudeCache(cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 0, 1000, 0),
		cUser("2026-10-11T10:30:00Z"), cReq("req_2", "msg_2", cacheOpus, "2026-10-11T10:30:03Z", 0, 0, 5000))
	want := anthropicCache(cacheOpus, proto.CachePolicyObserved1h, ttl1h, ttl1h, cacheMS("2026-10-11T10:30:00Z"),
		cacheMS("2026-10-11T10:30:03Z"), 5000, 5010)
	if got == nil || *got != want {
		t.Fatalf("cache = %+v\nwant    %+v", got, want)
	}
	if s := CacheState(got, cacheAt("2026-10-11T11:20:00Z")); s != proto.CacheWarm {
		t.Errorf("at 11:20 (50 min after the refresh, before its 1h ends): %s", s)
	}
}

// Without a prompt before the request, its start is unknown: never warm,
// and expired only after its first record plus the longest retention.
func TestClaudeCacheRequestStartUnknown(t *testing.T) {
	got := claudeCache(cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 1000, 0, 0))
	want := anthropicCache(cacheOpus, proto.CachePolicyObserved5m, ttl5m, ttl5m, 0, cacheMS("2026-10-11T10:00:02Z"), 0, 1010)
	want.Reason = "no prompt or tool result before the last request: its start is unknown"
	if got == nil || *got != want {
		t.Fatalf("cache = %+v\nwant    %+v", got, want)
	}
	if s := CacheState(got, cacheAt("2026-10-11T10:00:03Z")); s != proto.CacheUnknown {
		t.Errorf("right after: %s, want unknown (never warm without a start)", s)
	}
	if s := CacheState(got, cacheAt("2026-10-11T10:05:03Z")); s != proto.CacheExpired {
		t.Errorf("after the first record plus 5m: %s, want expired", s)
	}
}

// A long response expires from its first record, not its last; and a first
// record that comes after the expiry is not warm.
func TestClaudeCacheLongResponse(t *testing.T) {
	got := claudeCache(cUser("2026-10-11T10:00:00Z"),
		cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:03Z", 1000, 0, 0),
		cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:01:50Z", 1000, 0, 0))
	if got == nil || got.RequestTo != cacheMS("2026-10-11T10:00:03Z") || got.ExpiresTo != cacheMS("2026-10-11T10:05:03Z") {
		t.Fatalf("cache = %+v, want the first record's bounds", got)
	}
	if s := CacheState(got, cacheAt("2026-10-11T10:05:04Z")); s != proto.CacheExpired {
		t.Errorf("at 10:05:04: %s, want expired (the last record would say unknown)", s)
	}

	late := claudeCache(cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:06:00Z", 1000, 0, 0))
	if s := CacheState(late, cacheAt("2026-10-11T10:06:30Z")); s != proto.CacheUnknown {
		t.Errorf("first record after the expiry, at 10:06:30: %s, want unknown (not warm)", s)
	}
	if s := CacheState(late, cacheAt("2026-10-11T10:12:00Z")); s != proto.CacheExpired {
		t.Errorf("at 10:12: %s, want expired", s)
	}
}

// Subagents' lines and sidechain lines never refresh the cache nor set its
// policy; with only them, there is no evidence.
func TestClaudeCacheSubagentsAndSidechains(t *testing.T) {
	c := newClaudeUsage()
	feedClaude(c, true, cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 0, 1000, 0))
	feedClaude(c, false, cUser("2026-10-11T10:30:00Z"), cReq("req_s", "msg_s", "claude-haiku-4-5", "2026-10-11T10:30:05Z", 1000, 0, 0))
	feedClaude(c, true, cSide(cUser("2026-10-11T10:40:00Z")), cSide(cReq("req_x", "msg_x", cacheOpus, "2026-10-11T10:40:05Z", 2000, 0, 0)),
		cSide(cReq("req_y", "msg_y", cacheOpus, "2026-10-11T10:40:09Z", 0, 0, 9000)))
	// (The sidechain's context still counts as the main thread's context, as
	// Usage.ContextTokens always did: only the evidence ignores it.)
	u := c.usage(DefaultPricing())
	want := anthropicCache(cacheOpus, proto.CachePolicyObserved1h, ttl1h, ttl1h, cacheMS("2026-10-11T10:00:00Z"),
		cacheMS("2026-10-11T10:00:02Z"), 0, u.ContextTokens)
	if u.Cache == nil || *u.Cache != want {
		t.Fatalf("cache = %+v\nwant    %+v", u.Cache, want)
	}

	sub := newClaudeUsage()
	feedClaude(sub, false, cUser("2026-10-11T10:30:00Z"), cReq("req_s", "msg_s", "claude-haiku-4-5", "2026-10-11T10:30:05Z", 1000, 0, 0))
	if got := sub.usage(DefaultPricing()).Cache; got != nil {
		t.Fatalf("subagent only: cache = %+v, want none", got)
	}
}

// A compaction forgets the evidence until the next relevant request; that
// request's writes set the policy, and a read-only one leaves it documented.
func TestClaudeCacheCompaction(t *testing.T) {
	c := newClaudeUsage()
	feedClaude(c, true, cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 0, 1000, 0),
		cCompact("2026-10-11T10:20:00Z"))
	got := c.usage(DefaultPricing()).Cache
	want := proto.UsageCache{Estimated: true, Provider: proto.CacheProviderAnthropic, Model: cacheOpus,
		Policy: proto.CachePolicyUnknown, Reason: "compacted"}
	if got == nil || *got != want {
		t.Fatalf("after the compaction: cache = %+v\nwant    %+v", got, want)
	}
	if s := CacheState(got, cacheAt("2026-10-11T10:21:00Z")); s != proto.CacheUnknown {
		t.Errorf("after the compaction: %s, want unknown", s)
	}

	feedClaude(c, true, cUser("2026-10-11T10:21:00Z"), cReq("req_2", "msg_2", cacheOpus, "2026-10-11T10:21:02Z", 0, 0, 9000))
	want = anthropicCache(cacheOpus, proto.CachePolicyDocumented, ttl5m, ttl1h, cacheMS("2026-10-11T10:21:00Z"),
		cacheMS("2026-10-11T10:21:02Z"), 9000, 9010)
	if got = c.usage(DefaultPricing()).Cache; got == nil || *got != want {
		t.Fatalf("read after the compaction: cache = %+v\nwant    %+v", got, want)
	}

	feedClaude(c, true, cUser("2026-10-11T10:22:00Z"), cReq("req_3", "msg_3", cacheOpus, "2026-10-11T10:22:01Z", 1000, 0, 0))
	want = anthropicCache(cacheOpus, proto.CachePolicyObserved5m, ttl5m, ttl5m, cacheMS("2026-10-11T10:22:00Z"),
		cacheMS("2026-10-11T10:22:01Z"), 0, 1010)
	if got = c.usage(DefaultPricing()).Cache; got == nil || *got != want {
		t.Fatalf("write after the compaction: cache = %+v\nwant    %+v", got, want)
	}
}

// A model change drops the old model's write evidence: the new model's own
// writes set the policy, else it is documented.
func TestClaudeCacheModelChange(t *testing.T) {
	c := newClaudeUsage()
	feedClaude(c, true, cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 0, 1000, 0),
		cUser("2026-10-11T10:10:00Z"), cReq("req_2", "msg_2", cacheSonnet, "2026-10-11T10:10:01Z", 0, 0, 5000))
	want := anthropicCache(cacheSonnet, proto.CachePolicyDocumented, ttl5m, ttl1h, cacheMS("2026-10-11T10:10:00Z"),
		cacheMS("2026-10-11T10:10:01Z"), 5000, 5010)
	if got := c.usage(DefaultPricing()).Cache; got == nil || *got != want {
		t.Fatalf("after the switch: cache = %+v\nwant    %+v", got, want)
	}

	feedClaude(c, true, cUser("2026-10-11T10:20:00Z"), cReq("req_3", "msg_3", cacheSonnet, "2026-10-11T10:20:01Z", 1000, 0, 0))
	want = anthropicCache(cacheSonnet, proto.CachePolicyObserved5m, ttl5m, ttl5m, cacheMS("2026-10-11T10:20:00Z"),
		cacheMS("2026-10-11T10:20:01Z"), 0, 1010)
	if got := c.usage(DefaultPricing()).Cache; got == nil || *got != want {
		t.Fatalf("new model's write: cache = %+v\nwant    %+v", got, want)
	}
}

// A switch to another model with a request that neither read nor wrote
// the cache: the old model's evidence is not the new one's (another
// prefix), so the estimate is unknown, never warm or expired from it, and
// the evidence names the model Usage does.
func TestClaudeCacheModelChangeUncached(t *testing.T) {
	c := newClaudeUsage()
	feedClaude(c, true, cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 0, 1000, 0),
		cUser("2026-10-11T10:00:30Z"), cReq("req_2", "msg_2", cacheSonnet, "2026-10-11T10:00:31Z", 0, 0, 0))
	u := c.usage(DefaultPricing())
	want := proto.UsageCache{Estimated: true, Provider: proto.CacheProviderAnthropic, Model: cacheSonnet,
		Policy: proto.CachePolicyUnknown, Reason: "model changed", ContextTokens: u.ContextTokens}
	if u.Cache == nil || *u.Cache != want {
		t.Fatalf("after the switch: cache = %+v\nwant    %+v", u.Cache, want)
	}
	if u.Cache.Model != u.Model {
		t.Errorf("cache model %q, usage model %q", u.Cache.Model, u.Model)
	}
	for _, at := range []string{"2026-10-11T10:01:00Z", "2026-10-11T12:00:00Z"} {
		if st := CacheState(u.Cache, cacheAt(at)); st != proto.CacheUnknown {
			t.Errorf("at %s: %s, want unknown", at, st)
		}
	}
	// The new model's first relevant request is evidence again.
	feedClaude(c, true, cUser("2026-10-11T10:02:00Z"), cReq("req_3", "msg_3", cacheSonnet, "2026-10-11T10:02:01Z", 1000, 0, 0))
	if got := c.usage(DefaultPricing()).Cache; got == nil || got.Policy != proto.CachePolicyObserved5m || got.Model != cacheSonnet {
		t.Fatalf("the new model's write: cache = %+v", got)
	}
}

// No relevant request (no cache read or write) is no evidence.
func TestClaudeCacheNoEvidence(t *testing.T) {
	if got := claudeCache(cUser("2026-10-11T10:00:00Z"), cReq("req_1", "msg_1", cacheOpus, "2026-10-11T10:00:02Z", 0, 0, 0)); got != nil {
		t.Fatalf("cache = %+v, want none", got)
	}
}

func TestCacheStateBoundaries(t *testing.T) {
	at := func(ms int64) time.Time { return time.UnixMilli(ms) }
	bounded := &proto.UsageCache{ExpiresFrom: 1000, ExpiresTo: 2000}
	for _, tc := range []struct {
		name string
		c    *proto.UsageCache
		ms   int64
		want string
	}{
		{"before ExpiresFrom", bounded, 999, proto.CacheWarm},
		{"at ExpiresFrom", bounded, 1000, proto.CacheUnknown},
		{"between", bounded, 1500, proto.CacheUnknown},
		{"at ExpiresTo", bounded, 2000, proto.CacheUnknown},
		{"after ExpiresTo", bounded, 2001, proto.CacheExpired},
		{"no bounds", &proto.UsageCache{}, 1500, proto.CacheUnknown},
		{"no lower bound", &proto.UsageCache{ExpiresTo: 2000}, 1, proto.CacheUnknown},
		{"no upper bound: never expired", &proto.UsageCache{ExpiresFrom: 1000}, 1 << 40, proto.CacheUnknown},
		{"nil", nil, 1, proto.CacheUnknown},
	} {
		if got := CacheState(tc.c, at(tc.ms)); got != tc.want {
			t.Errorf("%s at %d: %s, want %s", tc.name, tc.ms, got, tc.want)
		}
	}
	if e := EstimateCache(nil, at(1)); e.State != proto.CacheUnknown || !e.Estimated || e.Evidence != (proto.UsageCache{}) {
		t.Errorf("EstimateCache(nil) = %+v", e)
	}
	if e := EstimateCache(bounded, at(999)); e.State != proto.CacheWarm || !e.Estimated || e.Evidence != *bounded {
		t.Errorf("EstimateCache = %+v", e)
	}
}

// Codex: the cache's retention is the model's and the auth route's; the
// request's start is its turn's start (its end, the turn's completion).
func TestCodexCacheRetention(t *testing.T) {
	start := cacheAt("2026-10-11T10:00:00Z").Unix()
	from, to := start*1000, (start+20)*1000
	cases := []struct {
		name, model, authJSON, auth, policy string
		lo, hi                              int64
		reason                              bool
	}{
		{"API, GPT-5.6", "gpt-5.6", `{"auth_mode":"apikey"}`, "apikey", proto.CachePolicyDocumented, ttl30m, 0, false},
		{"API, GPT-6 Sol", "gpt-6-sol", `{"auth_mode":"apikey"}`, "apikey", proto.CachePolicyDocumented, ttl30m, 0, false},
		{"API, GPT-6.1 Sol", "gpt-6.1-sol", `{"auth_mode":"apikey"}`, "apikey", proto.CachePolicyDocumented, ttl30m, 0, false},
		{"API, GPT-5.5", "gpt-5.5", `{"auth_mode":"apikey"}`, "apikey", proto.CachePolicyDocumented, ttl5m, ttl1h, false},
		{"API, GPT-5", "gpt-5-codex", `{"auth_mode":"apikey"}`, "apikey", proto.CachePolicyDocumented, ttl5m, ttl1h, false},
		{"ChatGPT, GPT-6 Sol", "gpt-6-sol", `{"auth_mode":"chatgpt"}`, "chatgpt", proto.CachePolicyAssumed, 0, 0, true},
		{"ChatGPT, GPT-5.5", "gpt-5.5", `{"auth_mode":"chatgpt"}`, "chatgpt", proto.CachePolicyAssumed, 0, 0, true},
		{"no auth.json, GPT-6 Sol", "gpt-6-sol", "", "", proto.CachePolicyAssumed, ttl30m, 0, false},
		{"no auth.json, GPT-5.5", "gpt-5.5", "", "", proto.CachePolicyAssumed, ttl5m, ttl1h, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			sessions := filepath.Join(root, "sessions")
			if tc.authJSON != "" {
				writeFile(t, filepath.Join(root, "auth.json"), tc.authJSON)
			}
			rollout := filepath.Join(sessions, "2026", "10", "11", "rollout-x-"+codexID+".jsonl")
			writeFile(t, rollout, cMeta("openai")+cTurn(tc.model)+cStart(start)+cCount(20000)+cDone(start+20))
			u := poll(t, NewSession(Codex, codexID, Roots{CodexSessions: sessions}, DefaultPricing()), cacheAt("2026-10-11T10:01:00Z"))
			want := proto.UsageCache{Estimated: true, Provider: proto.CacheProviderOpenAI, Model: tc.model, Auth: tc.auth,
				Policy: tc.policy, TTLMin: tc.lo, TTLMax: tc.hi, RequestFrom: from, RequestTo: to, CacheRead: 20000, ContextTokens: 50000}
			if tc.lo > 0 {
				want.ExpiresFrom = from + tc.lo
			}
			if tc.hi > 0 {
				want.ExpiresTo = to + tc.hi
			}
			if u.Cache == nil || (u.Cache.Reason != "") != tc.reason {
				t.Fatalf("cache = %+v, want a reason: %v", u.Cache, tc.reason)
			}
			want.Reason = u.Cache.Reason
			if *u.Cache != want {
				t.Fatalf("cache = %+v\nwant    %+v", u.Cache, want)
			}
			// Warm just after the turn when a lower bound is known; expired
			// two hours on only with a documented upper bound.
			if got := CacheState(u.Cache, cacheAt("2026-10-11T10:01:00Z")); (got == proto.CacheWarm) != (tc.lo > 0) {
				t.Errorf("a minute on: %s", got)
			}
			late := CacheState(u.Cache, cacheAt("2026-10-11T12:00:00Z"))
			if tc.hi > 0 && late != proto.CacheExpired || tc.hi == 0 && late != proto.CacheUnknown {
				t.Errorf("two hours on: %s", late)
			}
		})
	}
}

// Codex: a running turn has no end (never expired), a finished one ends at
// its completion; a later turn without cache reads keeps the last one's
// timing.
func TestCodexCacheTurnTiming(t *testing.T) {
	start := cacheAt("2026-10-11T10:00:00Z").Unix()
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	rollout := filepath.Join(sessions, "2026", "10", "11", "rollout-x-"+codexID+".jsonl")
	writeFile(t, rollout, cMeta("openai")+cTurn("gpt-5.5")+cStart(start)+cCount(0))
	s := NewSession(Codex, codexID, Roots{CodexSessions: sessions}, DefaultPricing())
	if u := poll(t, s, cacheAt("2026-10-11T10:00:01Z")); u.Cache != nil {
		t.Fatalf("no cache read yet: cache = %+v", u.Cache)
	}

	appendFile(t, rollout, cCount(20000))
	running := poll(t, s, cacheAt("2026-10-11T10:00:02Z")).Cache
	if running == nil || running.RequestFrom != start*1000 || running.RequestTo != 0 || running.ExpiresTo != 0 ||
		running.ExpiresFrom != start*1000+ttl5m {
		t.Fatalf("running: cache = %+v", running)
	}
	if st := CacheState(running, cacheAt("2026-10-11T12:00:00Z")); st != proto.CacheUnknown {
		t.Errorf("running two hours on: %s, want unknown", st)
	}

	appendFile(t, rollout, cDone(start+30))
	done := poll(t, s, cacheAt("2026-10-11T10:00:31Z")).Cache
	if done == nil || done.RequestTo != (start+30)*1000 || done.ExpiresTo != (start+30)*1000+ttl1h {
		t.Fatalf("done: cache = %+v", done)
	}
	if st := CacheState(done, cacheAt("2026-10-11T11:00:31Z")); st != proto.CacheExpired {
		t.Errorf("an hour after the turn: %s, want expired", st)
	}

	appendFile(t, rollout, cStart(start+100)+cCount(0))
	if later := poll(t, s, cacheAt("2026-10-11T10:02:00Z")).Cache; later == nil || *later != *done {
		t.Fatalf("a later turn without a cache read changed the evidence: %+v", later)
	}
}

// Codex: a compaction forgets the evidence until the next cache read.
func TestCodexCacheCompaction(t *testing.T) {
	start := cacheAt("2026-10-11T10:00:00Z").Unix()
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	rollout := filepath.Join(sessions, "2026", "10", "11", "rollout-x-"+codexID+".jsonl")
	writeFile(t, rollout, cMeta("openai")+cTurn("gpt-5.5")+cStart(start)+cCount(20000)+cDone(start+20))
	s := NewSession(Codex, codexID, Roots{CodexSessions: sessions}, DefaultPricing())
	poll(t, s, cacheAt("2026-10-11T10:00:30Z"))

	appendFile(t, rollout, `{"type":"compacted","payload":{"message":""}}`+"\n")
	got := poll(t, s, cacheAt("2026-10-11T10:01:00Z")).Cache
	want := proto.UsageCache{Estimated: true, Provider: proto.CacheProviderOpenAI, Model: "gpt-5.5",
		Policy: proto.CachePolicyUnknown, Reason: "compacted"}
	if got == nil || *got != want {
		t.Fatalf("after the compaction: cache = %+v\nwant    %+v", got, want)
	}

	appendFile(t, rollout, cCount(15000))
	// No auth.json: the model's range, assumed.
	if got = poll(t, s, cacheAt("2026-10-11T10:02:00Z")).Cache; got == nil || got.Policy != proto.CachePolicyAssumed ||
		got.CacheRead != 15000 || got.Reason != "" {
		t.Fatalf("next read: cache = %+v", got)
	}
}

// Codex: a switch to another model whose request read no cached input:
// the old model's evidence is not the new one's, so the estimate is unknown
// and names the model Usage does, until the new model reads the cache.
func TestCodexCacheModelChange(t *testing.T) {
	start := cacheAt("2026-10-11T10:00:00Z").Unix()
	root := t.TempDir()
	sessions := filepath.Join(root, "sessions")
	writeFile(t, filepath.Join(root, "auth.json"), `{"auth_mode":"apikey"}`)
	rollout := filepath.Join(sessions, "2026", "10", "11", "rollout-x-"+codexID+".jsonl")
	writeFile(t, rollout, cMeta("openai")+cTurn("gpt-5.5")+cStart(start)+cCount(20000)+cDone(start+20))
	s := NewSession(Codex, codexID, Roots{CodexSessions: sessions}, DefaultPricing())
	if u := poll(t, s, cacheAt("2026-10-11T10:00:25Z")); u.Cache == nil || CacheState(u.Cache, cacheAt("2026-10-11T10:00:25Z")) != proto.CacheWarm {
		t.Fatalf("before the switch: cache = %+v", u.Cache)
	}

	appendFile(t, rollout, cTurn("gpt-6-sol")+cStart(start+30)+cCount(0)+cDone(start+40))
	u := poll(t, s, cacheAt("2026-10-11T10:01:00Z"))
	want := proto.UsageCache{Estimated: true, Provider: proto.CacheProviderOpenAI, Model: "gpt-6-sol", Auth: "apikey",
		Policy: proto.CachePolicyUnknown, Reason: "model changed", ContextTokens: u.ContextTokens}
	if u.Cache == nil || *u.Cache != want {
		t.Fatalf("after the switch: cache = %+v\nwant    %+v", u.Cache, want)
	}
	if u.Cache.Model != u.Model {
		t.Errorf("cache model %q, usage model %q", u.Cache.Model, u.Model)
	}
	for _, at := range []string{"2026-10-11T10:01:00Z", "2026-10-11T12:00:00Z"} {
		if st := CacheState(u.Cache, cacheAt(at)); st != proto.CacheUnknown {
			t.Errorf("at %s: %s, want unknown", at, st)
		}
	}

	appendFile(t, rollout, cStart(start+100)+cCount(15000))
	if got := poll(t, s, cacheAt("2026-10-11T10:02:00Z")).Cache; got == nil || got.Model != "gpt-6-sol" ||
		got.Policy != proto.CachePolicyDocumented || got.TTLMin != ttl30m || got.CacheRead != 15000 {
		t.Fatalf("the new model's read: cache = %+v", got)
	}
}

// Codex: OpenAI's policies are OpenAI's; another provider (a local
// server) or none named has no known retention: unknown, no TTL, never
// warm, whatever the model and the auth route.
func TestCodexCacheProvider(t *testing.T) {
	start := cacheAt("2026-10-11T10:00:00Z").Unix()
	for _, tc := range []struct{ name, meta, provider string }{
		{"ollama", cMeta("ollama"), "ollama"},
		{"none named", `{"type":"session_meta","payload":{"id":"` + codexID + `","cwd":"/w"}}` + "\n", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			sessions := filepath.Join(root, "sessions")
			writeFile(t, filepath.Join(root, "auth.json"), `{"auth_mode":"apikey"}`)
			rollout := filepath.Join(sessions, "2026", "10", "11", "rollout-x-"+codexID+".jsonl")
			writeFile(t, rollout, tc.meta+cTurn("gpt-5.5")+cStart(start)+cCount(20000)+cDone(start+20))
			u := poll(t, NewSession(Codex, codexID, Roots{CodexSessions: sessions}, DefaultPricing()), cacheAt("2026-10-11T10:00:30Z"))
			c := u.Cache
			if c == nil || c.Provider != tc.provider || c.Policy != proto.CachePolicyUnknown || c.TTLMin != 0 || c.TTLMax != 0 ||
				c.ExpiresFrom != 0 || c.ExpiresTo != 0 || c.Reason == "" || c.CacheRead != 20000 {
				t.Fatalf("cache = %+v", c)
			}
			for _, at := range []string{"2026-10-11T10:00:30Z", "2026-10-11T12:00:00Z"} {
				if st := CacheState(c, cacheAt(at)); st != proto.CacheUnknown {
					t.Errorf("at %s: %s, want unknown", at, st)
				}
			}
		})
	}
}

// cMeta, cTurn, cStart, cDone and cCount are Codex rollout lines.
func cMeta(provider string) string {
	return `{"type":"session_meta","payload":{"id":"` + codexID + `","model_provider":"` + provider + `","cwd":"/w"}}` + "\n"
}

func cTurn(model string) string {
	return `{"type":"turn_context","payload":{"model":"` + model + `"}}` + "\n"
}

func cStart(secs int64) string {
	return `{"type":"event_msg","payload":{"type":"task_started","started_at":` + itoa(secs) + `}}` + "\n"
}

func cDone(secs int64) string {
	return `{"type":"event_msg","payload":{"type":"task_complete","completed_at":` + itoa(secs) + `}}` + "\n"
}

// cCount is a token_count whose last request read cached input tokens (and
// had 50000 tokens in all).
func cCount(cached int64) string {
	u := `{"input_tokens":50000,"cached_input_tokens":` + itoa(cached) + `,"cache_write_input_tokens":0,"output_tokens":0,` +
		`"reasoning_output_tokens":0,"total_tokens":50000}`
	return `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":` + u + `,"last_token_usage":` + u +
		`,"model_context_window":258400}}}` + "\n"
}
