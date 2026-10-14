package proto

import "github.com/JeffreyVdb/herdr-3d/internal/handoffllm"

// #9 LLM handoffs (docs/protocol.md "LLM handoffs"): worker.handoff in mode
// "llm" has the configured LLM (#92) write a handoff from the worker's
// transcript, reduced and scrubbed by the bridge, without prompting the
// worker. The feature is off until switched on (World.HandoffLLM); every
// change of its settings or state is a handoff_llm.update event
// (HandoffLLMUpdate: the fields of HandoffLLMState flat in it).

// EvHandoffLLMUpdate carries the feature's settings and state.
const EvHandoffLLMUpdate = "handoff_llm.update"

// Commands of the LLM handoffs' settings.
const (
	CmdHandoffLLMGet  = "handoff_llm.get"
	CmdHandoffLLMSet  = "handoff_llm.set"
	CmdHandoffLLMTest = "handoff_llm.test"
)

func init() { Commands = append(Commands, CmdHandoffLLMGet, CmdHandoffLLMSet, CmdHandoffLLMTest) }

// HandoffLLMState is the feature's settings and state: handoff_llm.get's and
// handoff_llm.set's ack, World.HandoffLLM, and flat in handoff_llm.update.
type HandoffLLMState = handoffllm.View

// Feature states (HandoffLLMState.State).
const (
	HandoffLLMOff        = handoffllm.StateOff
	HandoffLLMIncomplete = handoffllm.StateIncomplete
	HandoffLLMUntested   = handoffllm.StateUntested
	HandoffLLMReady      = handoffllm.StateReady
)

// HandoffLLMUpdate is the handoff_llm.update event (not an Event: the fields
// of HandoffLLMState would collide with the other flat ones).
type HandoffLLMUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	HandoffLLMState
}

// HandoffLLMSetArgs are the args of handoff_llm.set (a field left out is
// kept): the switch, the transcript budget (bytes), the completion budget
// (tokens, reasoning included) and the reasoning effort ("": the
// provider's default).
type HandoffLLMSetArgs struct {
	Enabled         *bool   `json:"enabled,omitempty"`
	InputBytes      *int    `json:"input_bytes,omitempty"`
	MaxTokens       *int    `json:"max_tokens,omitempty"`
	ReasoningEffort *string `json:"reasoning_effort,omitempty"`
}

// HandoffLLMTestResult is handoff_llm.test's ack.
type HandoffLLMTestResult = handoffllm.TestResult

// Error codes of the LLM handoffs.
const (
	// ErrHandoffLLMUnavailable: the feature is off, its LLM not ready or
	// untested; nothing was sent.
	ErrHandoffLLMUnavailable = handoffllm.CodeUnavailable
	// ErrHandoffLLMInvalid: the model's answer is not a handoff of the
	// agreed shape; nothing was filed.
	ErrHandoffLLMInvalid = handoffllm.CodeInvalid
	// ErrHandoffLLMStale: the LLM config, the worker's agent session or the
	// worker changed while the handoff was written; nothing was filed.
	ErrHandoffLLMStale = "handoff_llm_stale"
	// ErrHandoffLLMInterrupted: the bridge restarted while the handoff was
	// written; it was not sent again and nothing was filed.
	ErrHandoffLLMInterrupted = "handoff_llm_interrupted"
)

// HandoffCoverage is what of the transcript snapshot an LLM handoff's
// reduced input holds (handoffllm.Coverage).
type HandoffCoverage struct {
	Messages     int            `json:"messages"`
	Kept         int            `json:"kept"`
	Omitted      []HandoffRange `json:"omitted"`
	Compaction   string         `json:"compaction"`
	Gaps         []string       `json:"gaps"`
	Abandoned    int            `json:"abandoned,omitempty"`
	Sidechains   int            `json:"sidechains,omitempty"`
	Deduplicated int            `json:"deduplicated,omitempty"`
	Skipped      int            `json:"skipped,omitempty"`
	Complete     bool           `json:"complete"`
}

// HandoffRange is a run of messages left out (ordinals from 1, inclusive).
type HandoffRange struct {
	From int    `json:"from"`
	To   int    `json:"to"`
	Why  string `json:"why"`
}

// CoverageOf is a reduction's coverage as the protocol says it.
func CoverageOf(c handoffllm.Coverage) HandoffCoverage {
	out := HandoffCoverage{Messages: c.Messages, Kept: c.Kept, Omitted: []HandoffRange{}, Compaction: c.Compaction,
		Gaps: append([]string{}, c.Gaps...), Abandoned: c.Abandoned, Sidechains: c.Sidechains, Deduplicated: c.Deduplicated,
		Skipped: c.Skipped, Complete: c.Complete}
	for _, r := range c.Omitted {
		out.Omitted = append(out.Omitted, HandoffRange{From: r.From, To: r.To, Why: r.Why})
	}
	return out
}

// LLMHandoffPreview is what an LLM handoff would send, and to whom
// (worker.handoff_preview in mode "llm"): the reducer ran, nothing was sent.
// Ready false: it cannot be asked for now (Unavailable says why; the sizes
// are still the reduction's when it ran).
type LLMHandoffPreview struct {
	Ready       bool   `json:"ready"`
	Unavailable string `json:"unavailable,omitempty"`
	// Model and Host are the configured LLM's model and endpoint host (never
	// its path or key).
	Model string `json:"model"`
	Host  string `json:"host"`
	// PayloadBytes and EstTokens are the reduced transcript's size and its
	// conservative token estimate; BudgetBytes the transcript budget,
	// MaxTokens the completion budget, TimeoutS the call's bound.
	PayloadBytes  int    `json:"payload_bytes"`
	EstTokens     int    `json:"est_tokens"`
	BudgetBytes   int    `json:"budget_bytes"`
	MaxTokens     int    `json:"max_tokens"`
	TimeoutS      int    `json:"timeout_s"`
	PromptVersion string `json:"prompt_version"`
	// Reduced false: the reduction failed (Unavailable says why: the
	// transcript changed, the pinned goal and corrections do not fit).
	Reduced  bool            `json:"reduced"`
	Coverage HandoffCoverage `json:"coverage"`
	// Redactions counts what the scrub took out, by category (never the
	// text); Categories are what a handoff sends.
	Redactions map[string]int `json:"redactions"`
	Categories []string       `json:"categories"`
	// Artifacts and Verified count the references observed in the snapshot
	// and those a result showed succeeded.
	Artifacts int `json:"artifacts"`
	Verified  int `json:"verified"`
}

// LLM handoff job states (LLMHandoff.State).
const (
	LLMHandoffQueued    = "queued"
	LLMHandoffRunning   = "running"
	LLMHandoffFiled     = "filed"
	LLMHandoffFailed    = "failed"
	LLMHandoffCancelled = "cancelled"
)

// LLMHandoff is an LLM handoff job (Worker.LLMHandoff, worker.handoff's ack
// in mode "llm"): its op, state, why it failed (Code: an error code of the
// handoffs, of the AI integration or handoff_llm_*, Message: a short,
// scrubbed sentence; never the model's text), when it started and last
// changed (unix ms), the model and endpoint host it was sent to, the
// handoff filed and how the send home went. A retry is a new job (a new op)
// and sends a new request.
type LLMHandoff struct {
	Op             string `json:"op"`
	State          string `json:"state"`
	Code           string `json:"code,omitempty"`
	Message        string `json:"message,omitempty"`
	StartedAt      int64  `json:"started_at"`
	UpdatedAt      int64  `json:"updated_at"`
	Model          string `json:"model,omitempty"`
	Host           string `json:"host,omitempty"`
	SendHome       bool   `json:"send_home,omitempty"`
	Handoff        int64  `json:"handoff,omitempty"`
	SendHomeResult string `json:"send_home_result,omitempty"`
	SendHomeReason string `json:"send_home_reason,omitempty"`
}

// WorkerHandoffJobResult is worker.handoff's ack in mode "llm": the job
// (Existing: its op was known; nothing was sent again).
type WorkerHandoffJobResult struct {
	Job      LLMHandoff `json:"job"`
	Existing bool       `json:"existing,omitempty"`
}

// HandoffLLMProvenance is an LLM handoff's provenance, from its front
// matter (handoff.get): the model and endpoint host that wrote it, the
// bridge's prompt version, the snapshot (candidate id and byte offset), the
// coverage summary and the redaction counts.
type HandoffLLMProvenance struct {
	Model         string         `json:"model,omitempty"`
	Host          string         `json:"host,omitempty"`
	PromptVersion string         `json:"prompt_version,omitempty"`
	Snapshot      string         `json:"snapshot,omitempty"`
	Coverage      string         `json:"coverage,omitempty"`
	Redactions    map[string]int `json:"redactions,omitempty"`
}
