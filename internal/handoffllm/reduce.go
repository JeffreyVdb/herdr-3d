package handoffllm

import (
	"context"
	"errors"
	"io/fs"
)

// Input is one reduction request: an immutable snapshot of a worker's
// main-session transcript that ends at a completed turn.
type Input struct {
	Harness string      // "claude" or "codex"
	Path    string      // the main-session JSONL (never a subagent/sidechain file)
	File    fs.FileInfo // the file as the bridge's tail saw it; a replaced/truncated file => ErrChanged
	Through int64       // snapshot end (byte offset): transcript.Candidate.Through of the current candidate
	Budget  int         // max bytes of Payload.Text
	Secrets []string    // extra literal secrets to scrub (e.g. the configured API key)
}

// Payload is the reduced, scrubbed transcript data to embed (as untrusted
// data) in the prompt.
type Payload struct {
	Text       string // reduced transcript, message-delimited; never cut inside a rune or a kept message
	Bytes      int    // len(Text)
	EstTokens  int    // conservative token estimate of Text (EstimateTokens)
	Coverage   Coverage
	Artifacts  []Artifact     // references actually observed in the snapshot
	Redactions map[string]int // category -> count; never the secret text
}

// Coverage says what of the snapshot made it into Payload.Text.
type Coverage struct {
	Messages     int      // main-thread messages in the snapshot after branch selection + dedup
	Kept         int      // messages (wholly or excerpted) in Text
	Omitted      []Range  // what was left out, for preview/provenance
	Compaction   string   // "none" | "claude_summary" | "codex_retained" | "opaque" | "missing"
	Gaps         []string // human-readable coverage gaps
	Abandoned    int      // rows on abandoned branches left out
	Sidechains   int      // sidechain/subagent rows left out
	Deduplicated int      // duplicate/streamed copies merged
	Skipped      int      // unreadable/oversized lines skipped
	Complete     bool     // true only when nothing material was omitted and no gap exists
}

// Range is a run of message ordinals left out of Text.
type Range struct {
	From, To int    // message ordinals (1-based, inclusive) within Coverage.Messages
	Why      string // short reason, e.g. "older assistant detail", "tool output"
}

// Artifact is a reference observed in the snapshot.
type Artifact struct {
	Kind     string // "file" | "commit" | "pr" | "issue" | "url" | "test"
	Ref      string // path, sha, URL, test name… (scrubbed)
	Verified bool   // true only when a result shows success; tool-call intent alone is false
}

var (
	// ErrChanged reports that the file was replaced/truncated/is not the snapshot any more.
	ErrChanged = errors.New("handoffllm: transcript changed since the snapshot")
	// ErrTooLarge reports that the pinned content (first goal, user corrections,
	// final reply) cannot fit the budget.
	ErrTooLarge = errors.New("handoffllm: pinned transcript content exceeds the budget")
	// ErrUnsupported reports an unknown harness or transcript format.
	ErrUnsupported = errors.New("handoffllm: unsupported transcript")
)

// Reduce reads the snapshot described by in and returns the reduced payload.
func Reduce(ctx context.Context, in Input) (Payload, error) {
	return Payload{}, ErrUnsupported
}
