// Package handoffllm reduces a worker's main-session transcript (Claude or
// Codex JSONL) into bounded, scrubbed source data for an LLM-written handoff,
// and owns the outgoing scrub policy for anything sent to that model.
//
// The reduction policy and the exact Text layout are documented here once the
// reducer lands.
package handoffllm
