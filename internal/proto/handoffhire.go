package proto

// #219: Hire with handoff in the background. worker.handoff in modes agent
// and llm may carry the hire that follows the filing (Hire): the bridge
// holds the desk, hires once the handoff is filed with the first prompt of
// #198 and publishes the pending hire and its outcome in
// World.HandoffHires (docs/protocol.md "Hire with handoff in the
// background").

// Events of the pending handoff hires.
const (
	// EvHandoffHireUpsert: a record changed (HandoffHire).
	EvHandoffHireUpsert = "handoff_hire.upsert"
	// EvHandoffHireRemoved: a record left the view (Op).
	EvHandoffHireRemoved = "handoff_hire.removed"
)

// MaxHandoffHireOrigin bounds HandoffHire.Origin (of [A-Za-z0-9_-]).
const MaxHandoffHireOrigin = 80

// WorkerHandoffHire is worker.handoff's hire: every field of worker.hire's
// args with the same meaning (Prompt is the human task without the path
// line: required, not blank; Secrets / SecretsPending its review), and the
// client's opaque Origin (the browser that announces the outcome).
type WorkerHandoffHire struct {
	WorkerHireArgs
	Origin string `json:"origin,omitempty"`
}

// Pending handoff hire states (HandoffHire.State).
const (
	HandoffHireWaiting   = "waiting"   // the handoff is being written; the desk is held
	HandoffHireHiring    = "hiring"    // filed; the hire runs
	HandoffHireHired     = "hired"     // the hire started (Hired, Prompted, Delivery)
	HandoffHireFailed    = "failed"    // nobody hired (Code, Reason); with Path: filed, not hired
	HandoffHireCancelled = "cancelled" // worker.handoff_cancel cancelled the handoff and its hire
)

// Codes of a failed or cancelled pending handoff hire (HandoffHire.Code).
const (
	HandoffHireHandoffFailed = "handoff_failed"
	HandoffHireTimeout       = "timeout"
	HandoffHireCancelledCode = "cancelled"
	HandoffHireSourceGone    = "source_gone"
	HandoffHireFloorGone     = "floor_gone"
	HandoffHireDeskTaken     = "desk_taken"
	HandoffHireCapacity      = "capacity"
	HandoffHireTooLong       = "too_long"
	HandoffHireSecretsStale  = "secrets_stale"
	HandoffHireHireFailed    = "hire_failed"
	HandoffHireInterrupted   = "interrupted"
)

// HandoffHire is a pending handoff hire (#219), keyed by the handoff's op:
// the source worker and its name (kept after it leaves), the mode, the
// target floor and desk (0-based), the requested label and harness, model
// and effort, the client's origin, the state and, once ended, why (Code,
// Reason), the filed handoff (Handoff, Path), the new worker and how its
// first prompt went, and the send home's outcome. Never the task, the
// instruction, a secret or review data.
type HandoffHire struct {
	Op             string `json:"op"`
	Worker         string `json:"worker"`
	WorkerName     string `json:"worker_name"`
	Mode           string `json:"mode"`
	Floor          string `json:"floor"`
	DeskIndex      int    `json:"desk_index"`
	Label          string `json:"label,omitempty"`
	Harness        string `json:"harness"`
	Model          string `json:"model"`
	Effort         string `json:"effort"`
	Origin         string `json:"origin,omitempty"`
	State          string `json:"state"`
	Code           string `json:"code,omitempty"`
	Reason         string `json:"reason,omitempty"`
	Handoff        int64  `json:"handoff,omitempty"`
	Path           string `json:"path,omitempty"`
	Hired          string `json:"hired,omitempty"`
	Prompted       *bool  `json:"prompted,omitempty"`
	Delivery       string `json:"delivery,omitempty"`
	PromptError    string `json:"prompt_error,omitempty"`
	SendHome       bool   `json:"send_home,omitempty"`
	SendHomeResult string `json:"send_home_result,omitempty"`
	SendHomeReason string `json:"send_home_reason,omitempty"`
	StartedAt      int64  `json:"started_at"`
	EndedAt        int64  `json:"ended_at,omitempty"`
}

// Ended reports a terminal record.
func (r HandoffHire) Ended() bool {
	return r.State == HandoffHireHired || r.State == HandoffHireFailed || r.State == HandoffHireCancelled
}
