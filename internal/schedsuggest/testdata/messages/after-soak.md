The canary for the new rate limiter (`ratelimit-v2`) is live on `edge-eu-1` since 07:30 this morning, per the deploy log.

Plan from here:
1. Let it soak for 24h on the canary.
2. After the 24h soak, if `edge_429_ratio` stayed under 0.5 % and there were no `RateLimiterPanic` alerts, promote it to the remaining edges with `deploy promote ratelimit-v2 --all`.
3. Remove the `ratelimit_v1_fallback` feature flag in the same change.
