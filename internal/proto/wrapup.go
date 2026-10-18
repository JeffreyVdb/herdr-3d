package proto

// #83: wrap up, then send home (docs/protocol.md "Wrap up"). The bridge
// prompts a worker's agent with a last cleanup task and a footer asking for
// a result line, reads that line from its transcript, and sends the worker
// home (the same worker.fire teardown) only on CLEAN.

// Wrap-up commands.
const (
	CmdWorkerWrapUp       = "worker.wrapup"
	CmdWorkerWrapUpCancel = "worker.wrapup.cancel"
)

func init() { Commands = append(Commands, CmdWorkerWrapUp, CmdWorkerWrapUpCancel) }

// Wrap-up states (WrapUp.State).
const (
	// WrapUpArmed: the prompt went out, the bridge waits for the result
	// line.
	WrapUpArmed = "armed"
	// WrapUpNeedsYou: disarmed without a send home (BLOCKED, no result, a
	// time-out, a check that failed); Reason says why. Only an explicit
	// worker.wrapup arms it again.
	WrapUpNeedsYou = "needs_you"
)

// MaxWrapUpReason bounds WrapUp.Reason, in bytes.
const MaxWrapUpReason = 1000

// WrapUp is a worker's wrap-up, on its upserts while it lasts.
type WrapUp struct {
	State string `json:"state"`
	// Worktree is the send home's worktree choice, made up front: FireKeep,
	// FireDelete or FireDeleteBranch.
	Worktree string `json:"worktree"`
	// ArmedAt is when it was armed, unix ms (bridge clock).
	ArmedAt int64  `json:"armed_at"`
	Reason  string `json:"reason,omitempty"`
}

// WorkerWrapUpArgs are the args of worker.wrapup. Prompt is the cleanup
// task (the bridge appends its footer); Worktree is as in worker.fire.
type WorkerWrapUpArgs struct {
	ID       string `json:"id"`
	Prompt   string `json:"prompt"`
	Worktree string `json:"worktree,omitempty"`
	// Secrets (#108 round 2, optional): the review of Prompt's possible
	// secrets.
	Secrets *SecretsReview `json:"secrets,omitempty"`
}

// WrapUpResult is the ack data of worker.wrapup: the prompt went out, now
// (Queued false) or for the agent's next turn.
type WrapUpResult struct {
	Queued bool `json:"queued,omitempty"`
}
