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
	// CmdWorkerHandoffCancel (#224) cancels a worker's pending agent
	// handoff request, or dismisses its failed one.
	CmdWorkerHandoffCancel = "worker.handoff_cancel"
)

// Events: a handoff was filed (Handoff, HandoffCount) or deleted
// (HandoffID, Session: its floor, HandoffCount).
const (
	EvHandoffAdded   = "handoff.added"
	EvHandoffRemoved = "handoff.removed"
)

func init() {
	Commands = append(Commands, CmdWorkerHandoffPreview, CmdWorkerHandoff, CmdHandoffList, CmdHandoffGet, CmdHandoffDelete,
		CmdWorkerHandoffCancel)
}

// Handoff modes: literal (#223), agent (#224: the worker's agent writes it
// with its own handoff skill), llm (#9: the configured LLM writes it from the
// reduced transcript; the worker is not prompted).
const (
	HandoffModeLiteral = "literal"
	HandoffModeAgent   = "agent"
	HandoffModeLLM     = "llm"
)

// HandoffSkill is the skill an agent handoff runs (#224), and
// DefaultHandoffInstruction its instruction when none is given.
const (
	HandoffSkill              = "handoff"
	DefaultHandoffInstruction = "summarize the conversation"
)

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
	// ErrHandoffSkillMissing (#224): the worker's harness lists no handoff
	// skill in its checkout; nothing was sent.
	ErrHandoffSkillMissing = "handoff_skill_missing"
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
	// MaxHandoffInstruction bounds an agent handoff's instruction (bytes).
	MaxHandoffInstruction = 4 << 10
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

// WorkerHandoffPreviewArgs are the args of worker.handoff_preview. #224:
// with mode "agent" no candidate is needed: the preview is what asking the
// agent would do (Agent, Cache), with the candidate's text when Candidate
// names the current one.
type WorkerHandoffPreviewArgs struct {
	Worker    string `json:"worker"`
	Candidate string `json:"candidate,omitempty"`
	Mode      string `json:"mode,omitempty"`
}

// AgentHandoffPreview is what asking the worker's agent would do (#224):
// the skill call its harness gets ("/handoff", "$handoff"; "" when it has
// no handoff skill), whether it can be asked now (CannotAsk says why not:
// not idle or done, a question, a request running, no skill, the skills
// could not be listed), the provider and model that receive the request,
// and the instruction used when none is given.
type AgentHandoffPreview struct {
	Call        string `json:"call,omitempty"`
	CanAsk      bool   `json:"can_ask"`
	CannotAsk   string `json:"cannot_ask,omitempty"`
	Harness     string `json:"harness,omitempty"`
	Model       string `json:"model,omitempty"`
	Instruction string `json:"instruction"`
}

// WorkerHandoffPreviewResult is its ack: the candidate, its text (the first
// HandoffPreviewBytes of it, Truncated when cut), the title a handoff would
// get, the provenance, and whether "send home after filing" can be offered
// now (SendHomeBlocked says why not).
type WorkerHandoffPreviewResult struct {
	// Candidate, Text, Truncated and Title: the literal candidate (#224:
	// absent in an agent preview without one).
	Candidate       *HandoffCandidate `json:"candidate,omitempty"`
	Text            string            `json:"text,omitempty"`
	Truncated       bool              `json:"truncated,omitempty"`
	Title           string            `json:"title,omitempty"`
	Provenance      HandoffProvenance `json:"provenance"`
	CanSendHome     bool              `json:"can_send_home"`
	SendHomeBlocked string            `json:"send_home_blocked,omitempty"`
	// #224, agent previews: what asking the agent would do, and the
	// agent's prompt cache as estimated now (absent: no evidence read).
	Agent *AgentHandoffPreview `json:"agent,omitempty"`
	Cache *CacheEstimate       `json:"cache,omitempty"`
	// #9, llm previews: what the LLM handoff would send, and to whom.
	LLM *LLMHandoffPreview `json:"llm,omitempty"`
}

// WorkerHandoffArgs are the args of worker.handoff: the worker, the mode
// (literal), the candidate's session, id and revision as the bridge gave
// them, whether to send the worker home after filing, and the operation id
// (1–64 characters of [A-Za-z0-9_-], one per dialog: a repeated submit with
// it files nothing again and answers the first handoff).
//
// #224, mode "agent": no candidate; Instruction (optional, at most
// MaxHandoffInstruction bytes; blank: DefaultHandoffInstruction) is what
// the agent's handoff skill is asked to do. The ack is
// WorkerHandoffRequestResult.
//
// #9, mode "llm": the candidate names the snapshot (the transcript up to
// that completed turn); Instruction (optional, the same bound) is the focus
// the model is given, as data. The ack is WorkerHandoffJobResult, at once:
// the job is followed on Worker.LLMHandoff.
type WorkerHandoffArgs struct {
	Worker      string `json:"worker"`
	Mode        string `json:"mode"`
	Session     string `json:"session,omitempty"`
	Candidate   string `json:"candidate,omitempty"`
	Revision    string `json:"revision,omitempty"`
	Instruction string `json:"instruction,omitempty"`
	SendHome    bool   `json:"send_home,omitempty"`
	Op          string `json:"op"`
	// Secrets (#108 round 2, optional; modes agent and llm): the review of
	// Instruction's possible secrets.
	Secrets *SecretsReview `json:"secrets,omitempty"`
}

// Agent handoff request states (AgentHandoff.State).
const (
	// AgentHandoffStarting: checked, its prompt not sent yet.
	AgentHandoffStarting = "starting"
	// AgentHandoffPending: the prompt was sent; the bridge waits for the
	// agent's turn to end with the file written.
	AgentHandoffPending = "pending"
	// AgentHandoffFiling: both seen; the file is being filed.
	AgentHandoffFiling = "filing"
	// AgentHandoffFiled: filed (Handoff), and sent home when asked.
	AgentHandoffFiled = "filed"
	// AgentHandoffFailed: not filed (Reason); the worker stays. A retry is
	// a new request (a new op).
	AgentHandoffFailed = "failed"
)

// AgentHandoff is an agent handoff request (#224): its op, state, why it
// failed, when it started (unix ms), the instruction given, whether the
// worker goes home once it is filed, the handoff it was filed as, and how
// the send home went.
type AgentHandoff struct {
	Op             string `json:"op"`
	State          string `json:"state"`
	Reason         string `json:"reason,omitempty"`
	StartedAt      int64  `json:"started_at"`
	Instruction    string `json:"instruction,omitempty"`
	SendHome       bool   `json:"send_home,omitempty"`
	Handoff        int64  `json:"handoff,omitempty"`
	SendHomeResult string `json:"send_home_result,omitempty"`
	SendHomeReason string `json:"send_home_reason,omitempty"`
}

// WorkerHandoffRequestResult is worker.handoff's ack in mode "agent": the
// request (Existing: its op was known, or the worker's pending request
// answered; nothing was sent again) and, once filed, its handoff.
type WorkerHandoffRequestResult struct {
	Request  AgentHandoff  `json:"request"`
	Handoff  *HandoffEntry `json:"handoff,omitempty"`
	Existing bool          `json:"existing,omitempty"`
}

// WorkerHandoffCancelArgs are the args of worker.handoff_cancel (#224).
type WorkerHandoffCancelArgs struct {
	Worker string `json:"worker"`
	Op     string `json:"op"`
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
// #9: LLM is an LLM handoff's provenance (absent for the others).
type HandoffGetResult struct {
	Handoff HandoffEntry          `json:"handoff"`
	Body    string                `json:"body"`
	LLM     *HandoffLLMProvenance `json:"llm,omitempty"`
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
