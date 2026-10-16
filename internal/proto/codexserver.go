package proto

// #155 shared Codex server (docs/protocol.md "Shared Codex server"): when
// switched on, a new or restarted Codex worker runs Codex's terminal against
// an app-server of its own that the bridge can join as a second client. The
// switch is in the snapshot (World.CodexServer) and every change is a
// codex_server.update event (CodexServerUpdate: the fields of CodexServer
// flat in it). Each Codex worker the bridge hired says how it was launched
// (Worker.Codex).

// EvCodexServerUpdate carries the switch.
const EvCodexServerUpdate = "codex_server.update"

// Commands of the shared Codex server switch.
const (
	CmdCodexServerGet = "codex_server.get"
	CmdCodexServerSet = "codex_server.set"
)

// #156: answering and dismissing a shared Codex worker's async questions
// (docs/protocol.md "Codex async questions").
const (
	CmdWorkerAnswerAsync  = "worker.answer_async"
	CmdWorkerDismissAsync = "worker.dismiss_async"
)

func init() {
	Commands = append(Commands, CmdCodexServerGet, CmdCodexServerSet, CmdWorkerAnswerAsync, CmdWorkerDismissAsync)
}

// CodexServer is the switch: codex_server.get's and codex_server.set's
// ack, World.CodexServer, and flat in codex_server.update.
type CodexServer struct {
	// Enabled: new Codex workers get their own app-server.
	Enabled bool `json:"enabled"`
	// Available: this bridge can launch them (it knows a private run
	// directory); without it codex_server.set refuses to switch on.
	Available bool `json:"available"`
	// AllowUnverified accepts the compatibility risk of untested Codex releases.
	AllowUnverified bool `json:"allow_unverified"`
}

// CodexServerUpdate is the codex_server.update event.
type CodexServerUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	CodexServer
}

// CodexServerSetArgs are the args of codex_server.set.
type CodexServerSetArgs struct {
	Enabled         *bool `json:"enabled,omitempty"`
	AllowUnverified *bool `json:"allow_unverified,omitempty"`
}

// Codex launch modes (WorkerCodex.Mode).
const (
	CodexModeShared = "shared"
	CodexModeLegacy = "legacy"
)

// Shared server states (WorkerCodex.Server).
const (
	CodexServerStarting = "starting"
	CodexServerRunning  = "running"
	CodexServerDown     = "down"
	CodexServerStopped  = "stopped"
)

// WorkerCodex is how a Codex worker the bridge hired was launched.
type WorkerCodex struct {
	// Mode is shared (its own app-server) or legacy (Codex's embedded
	// server, as before the switch; also a shared hire that fell back).
	Mode string `json:"mode"`
	// Server is a shared worker's app-server: starting, running, down (it
	// died: the terminal shows "Reconnecting…" and herdr still says
	// working) or stopped (the floor sleeps).
	Server string `json:"server,omitempty"`
	// Note says why a worker hired with the switch on runs legacy (an
	// unsupported Codex, a blocked .envrc, a failed start), or what last
	// went wrong with its server.
	Note string `json:"note,omitempty"`
	// Attached: the bridge has joined the worker's thread as a second
	// client (#156: whenever its server runs and its thread is known).
	Attached bool `json:"attached,omitempty"`
	// #156: Thread is the worker's thread as the bridge keeps it (what
	// worker.answer_async names); Turn its running turn while attached
	// ("" when idle or not attached).
	Thread string `json:"thread,omitempty"`
	Turn   string `json:"turn,omitempty"`
	// Questions are the thread's async question batches, oldest first.
	Questions []CodexBatch `json:"questions,omitempty"`
	// #157: AsyncBlocked: herdr's blocked, if it says so, is only an async
	// question's (attached, its running turn asked a question Codex still
	// holds, no server request open): the worker goes on working and takes
	// prompts (through the app-server). False with an approval or a
	// blocking question open, while idle and while not attached.
	AsyncBlocked bool `json:"async_blocked,omitempty"`
}

// Async question states (CodexQuestion.State).
const (
	AsyncPending   = "pending"
	AsyncSending   = "sending"
	AsyncSent      = "sent"
	AsyncAnswered  = "answered"
	AsyncDismissed = "dismissed"
)

// CodexBatch is one async question message of a shared Codex worker's
// thread.
type CodexBatch struct {
	// Batch is the message's id, Codex's function call_id.
	Batch string `json:"batch"`
	Turn  string `json:"turn"`
	// Seen: live, history, or both, in the order seen.
	Seen []string `json:"seen"`
	// Twin: another batch of the same turn with the same questions seen
	// only the other way under another id. Conflict: live and history gave
	// this id different questions (it cannot be answered).
	Twin     string `json:"twin,omitempty"`
	Conflict bool   `json:"conflict,omitempty"`
	// At is when the bridge first saw it (unix ms, bridge clock).
	At        int64           `json:"at"`
	Questions []CodexQuestion `json:"questions"`
}

// CodexQuestion is one question of a batch.
type CodexQuestion struct {
	Index int    `json:"index"`
	Title string `json:"title"`
	// Options are the suggested answers; none: free text.
	Options []string `json:"options,omitempty"`
	State   string   `json:"state"`
	// Answer, AnsweredBy ("bridge" | "other"): answered's envelope.
	Answer     string `json:"answer,omitempty"`
	AnsweredBy string `json:"answered_by,omitempty"`
	// Unconfirmed: sent, but no response came from the server.
	Unconfirmed bool `json:"unconfirmed,omitempty"`
	// Undelivered: sent, but the turn it went to ended without it (Codex
	// dropped it); worker.answer_async may send it again.
	Undelivered bool `json:"undelivered,omitempty"`
	// Error: why the bridge's last answer was refused (pending again).
	Error string `json:"error,omitempty"`
	// Truncated: the title, an option or the answer was cut for the wire.
	Truncated bool `json:"truncated,omitempty"`
}

// WorkerAnswerAsyncArgs are the args of worker.answer_async.
type WorkerAnswerAsyncArgs struct {
	ID      string           `json:"id"`
	Thread  string           `json:"thread"`
	Batch   string           `json:"batch"`
	Answers []AsyncAnswerArg `json:"answers"`
}

// AsyncAnswerArg answers one question of the batch.
type AsyncAnswerArg struct {
	Index  *int   `json:"index"`
	Answer string `json:"answer"`
}

// AsyncAnswerResult is worker.answer_async's ack: the server took the
// answer (sent), which is not yet answered.
type AsyncAnswerResult struct {
	State string `json:"state"`
	// Via is turn/steer (the running turn) or turn/start (none ran).
	Via  string `json:"via"`
	Turn string `json:"turn,omitempty"`
	// Fallback: turn/steer was refused (the turn had ended), so a turn was
	// started instead.
	Fallback bool `json:"fallback,omitempty"`
	// Unconfirmed: no response came; it is not sent again.
	Unconfirmed bool `json:"unconfirmed,omitempty"`
}

// WorkerDismissAsyncArgs are the args of worker.dismiss_async: indexes of
// the batch's questions, none for every one that can be.
type WorkerDismissAsyncArgs struct {
	ID      string `json:"id"`
	Thread  string `json:"thread"`
	Batch   string `json:"batch"`
	Indexes []int  `json:"indexes,omitempty"`
}
