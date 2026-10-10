package proto

// #223 handoffs (docs/protocol.md "Handoffs"): a worker's latest completed
// final reply filed literally as Markdown, and the filing cabinet that lists,
// searches, shows and deletes the floor's handoffs. The literal mode makes no
// model call and sends the worker nothing.

// Commands of the handoffs.
const (
	// CmdWorkerHandoffPreview is the dialog's preview of a candidate: its
	// exact text up to HandoffPreviewBytes and its provenance.
	CmdWorkerHandoffPreview = "worker.handoff_preview"
	// CmdWorkerHandoff files a handoff (and may then send the worker home).
	CmdWorkerHandoff = "worker.handoff"
	CmdHandoffList   = "handoff.list"
	CmdHandoffGet    = "handoff.get"
	CmdHandoffDelete = "handoff.delete"
)

// Events: a handoff was filed (Handoff, HandoffCount) or deleted
// (HandoffID, Session: its floor, HandoffCount).
const (
	EvHandoffAdded   = "handoff.added"
	EvHandoffRemoved = "handoff.removed"
)

func init() {
	Commands = append(Commands, CmdWorkerHandoffPreview, CmdWorkerHandoff, CmdHandoffList, CmdHandoffGet, CmdHandoffDelete)
}

// Handoff modes: literal (#223); agent and llm are later parts of #11.
const HandoffModeLiteral = "literal"

// Handoff sources, kept with each handoff.
const (
	HandoffSourceLiteral = "literal"
	HandoffSourceAgent   = "agent"
	HandoffSourceLLM     = "llm"
)

// Candidate text sources.
const (
	CandidateMessage          = "message"
	CandidateLastAgentMessage = "last_agent_message"
)

// Error codes of the handoffs.
const (
	// ErrHandoffUnavailable: the worker has no candidate (none, a turn runs,
	// a new prompt came) or the one named is not its current one (stale).
	ErrHandoffUnavailable = "handoff_unavailable"
	// ErrHandoffSource: the candidate's text cannot be read back as it was
	// (the transcript was replaced, truncated or changed).
	ErrHandoffSource = "handoff_source"
	// ErrHandoffFailed: writing the file or registering it failed; nothing
	// was filed.
	ErrHandoffFailed = "handoff_failed"
)

// Limits.
const (
	// HandoffPreviewBytes is the most text a preview carries (64 KiB, cut
	// on a character); the handoff itself is the whole text.
	HandoffPreviewBytes = 64 << 10
	// MaxHandoffBytes is the most text a handoff may have (1 MiB): a
	// larger reply is refused, never clipped.
	MaxHandoffBytes = 1 << 20
	// MaxHandoffOp bounds an operation id.
	MaxHandoffOp = 64
)

// HandoffCandidate is a worker's latest completed final reply that a literal
// handoff can file (Worker.Handoff): the bridge's identity of it, never its
// text. Message names the transcript row it is: Claude's message id (the
// row's item id is "<message>#<n>"), Codex's message item id.
type HandoffCandidate struct {
	ID       string `json:"id"`
	Session  string `json:"session"`
	Revision string `json:"revision"`
	Harness  string `json:"harness"`
	Message  string `json:"message,omitempty"`
	Turn     string `json:"turn,omitempty"`
	Source   string `json:"source"`
	Bytes    int    `json:"bytes"`
	// Images counts image blocks of the message a handoff leaves out.
	Images int `json:"images,omitempty"`
	// TooLarge: the text is above MaxHandoffBytes and cannot be filed.
	TooLarge bool `json:"too_large,omitempty"`
}

// HandoffCabinet is the snapshot's filing cabinet: how many handoffs each
// floor's drawer holds (floors with none left out).
type HandoffCabinet struct {
	Counts map[string]int `json:"counts"`
}

// HandoffEntry is a filed handoff, without its text.
type HandoffEntry struct {
	ID           int64  `json:"id"`
	Floor        string `json:"floor"`
	WorkerID     string `json:"worker_id,omitempty"`
	WorkerName   string `json:"worker_name"`
	Label        string `json:"label,omitempty"`
	Harness      string `json:"harness,omitempty"`
	Model        string `json:"model,omitempty"`
	Cwd          string `json:"cwd,omitempty"`
	Branch       string `json:"branch,omitempty"`
	AgentSession string `json:"agent_session,omitempty"`
	Path         string `json:"path"`
	Title        string `json:"title"`
	CreatedAt    int64  `json:"created_at"` // unix ms
	Source       string `json:"source"`
	Bytes        int64  `json:"bytes"`
	// Snippet (handoff.list with a query): the body's matching text, each
	// match between U+E000 and U+E001, cuts marked "…". Text, never markup.
	Snippet string `json:"snippet,omitempty"`
}

// HandoffProvenance is where a candidate comes from, for the dialog.
type HandoffProvenance struct {
	Floor      string `json:"floor"`
	WorkerName string `json:"worker_name"`
	Label      string `json:"label,omitempty"`
	Harness    string `json:"harness,omitempty"`
	Model      string `json:"model,omitempty"`
	Branch     string `json:"branch,omitempty"`
	Cwd        string `json:"cwd,omitempty"`
	Session    string `json:"session,omitempty"`
}

// WorkerHandoffPreviewArgs are the args of worker.handoff_preview.
type WorkerHandoffPreviewArgs struct {
	Worker    string `json:"worker"`
	Candidate string `json:"candidate"`
}

// WorkerHandoffPreviewResult is its ack: the candidate, its text (the first
// HandoffPreviewBytes of it, Truncated when cut), the title a handoff would
// get, the provenance, and whether "send home after filing" can be offered
// now (SendHomeBlocked says why not).
type WorkerHandoffPreviewResult struct {
	Candidate       HandoffCandidate  `json:"candidate"`
	Text            string            `json:"text"`
	Truncated       bool              `json:"truncated,omitempty"`
	Title           string            `json:"title"`
	Provenance      HandoffProvenance `json:"provenance"`
	CanSendHome     bool              `json:"can_send_home"`
	SendHomeBlocked string            `json:"send_home_blocked,omitempty"`
}

// WorkerHandoffArgs are the args of worker.handoff: the worker, the mode
// (literal), the candidate's session, id and revision as the bridge gave
// them, whether to send the worker home after filing, and the operation id
// (1–64 characters of [A-Za-z0-9_-], one per dialog: a repeated submit with
// it files nothing again and answers the first handoff).
type WorkerHandoffArgs struct {
	Worker    string `json:"worker"`
	Mode      string `json:"mode"`
	Session   string `json:"session"`
	Candidate string `json:"candidate"`
	Revision  string `json:"revision"`
	SendHome  bool   `json:"send_home,omitempty"`
	Op        string `json:"op"`
}

// Send-home outcomes of worker.handoff.
const (
	HandoffSendStarted = "started" // the send home began (worker.fire's path); worker.removed follows
	HandoffSendSkipped = "skipped" // not now: SendHomeReason says why; the handoff is filed
)

// WorkerHandoffResult is worker.handoff's ack. Existing: the operation (or
// the same reply) was filed before; that handoff is answered.
type WorkerHandoffResult struct {
	Handoff        HandoffEntry `json:"handoff"`
	Existing       bool         `json:"existing,omitempty"`
	SendHome       string       `json:"send_home,omitempty"`
	SendHomeReason string       `json:"send_home_reason,omitempty"`
}

// HandoffListArgs are the args of handoff.list: a floor's handoffs, newest
// first, or with q the matches by relevance (limit 0: 100, at most 500).
type HandoffListArgs struct {
	Floor string `json:"floor"`
	Q     string `json:"q,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

// HandoffListResult is its ack.
type HandoffListResult struct {
	Floor    string         `json:"floor"`
	Handoffs []HandoffEntry `json:"handoffs"`
}

// HandoffGetArgs are the args of handoff.get and handoff.delete (confirm
// must be true for a delete).
type HandoffGetArgs struct {
	ID int64 `json:"id"`
}

// HandoffGetResult is handoff.get's ack: the handoff and its body (the file
// without its front matter; Markdown, to be sanitized before it is shown).
type HandoffGetResult struct {
	Handoff HandoffEntry `json:"handoff"`
	Body    string       `json:"body"`
}

// HandoffDeleteArgs are the args of handoff.delete.
type HandoffDeleteArgs struct {
	ID      int64 `json:"id"`
	Confirm bool  `json:"confirm"`
}

// HandoffDeleteResult is its ack: the handoff deleted (its file is in the
// trash).
type HandoffDeleteResult struct {
	Handoff HandoffEntry `json:"handoff"`
}
