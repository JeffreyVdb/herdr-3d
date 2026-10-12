package usage

import (
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Retention bounds, ms: Claude Code's 5-minute and 1-hour cache entries,
// and the 30 minutes OpenAI documents as a minimum for newer models.
const (
	ttl5m  = 5 * 60_000
	ttl30m = 30 * 60_000
	ttl1h  = 60 * 60_000
)

// unixMS is t as unix ms; 0 for the zero time (unknown).
func unixMS(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// setRetention sets c's policy and retention, and the expiry bounds from
// its request bounds: the cache expires in [RequestFrom + min, RequestTo +
// max], each bound only when both of its parts are known (max 0: none).
func setRetention(c *proto.UsageCache, policy string, min, max int64) {
	c.Policy, c.TTLMin, c.TTLMax = policy, min, max
	if c.RequestFrom > 0 && min > 0 {
		c.ExpiresFrom = c.RequestFrom + min
	}
	if c.RequestTo > 0 && max > 0 {
		c.ExpiresTo = c.RequestTo + max
	}
}

// CacheState is c's estimated state at now: proto.CacheWarm only when now
// is before ExpiresFrom (known), proto.CacheExpired only when it is after
// ExpiresTo (known), else proto.CacheUnknown. nil c is unknown.
func CacheState(c *proto.UsageCache, now time.Time) string {
	if c == nil {
		return proto.CacheUnknown
	}
	ms := now.UnixMilli()
	switch {
	case c.ExpiresFrom > 0 && ms < c.ExpiresFrom:
		return proto.CacheWarm
	case c.ExpiresTo > 0 && ms > c.ExpiresTo:
		return proto.CacheExpired
	}
	return proto.CacheUnknown
}

// EstimateCache is c's CacheState at now, with its evidence (zero when c is
// nil).
func EstimateCache(c *proto.UsageCache, now time.Time) proto.CacheEstimate {
	e := proto.CacheEstimate{State: CacheState(c, now), Estimated: true}
	if c != nil {
		e.Evidence = *c
	}
	return e
}
