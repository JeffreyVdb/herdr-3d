package proto

// M5 term: laptop screens, input and blocked workers' questions (see
// docs/protocol.md "Laptops").

// Commands and connection-scoped messages.
const (
	CmdTerminalWatch   = "terminal.watch"
	CmdTerminalUnwatch = "terminal.unwatch"
	CmdWorkerKeys      = "worker.keys"
	CmdWorkerPrompt    = "worker.prompt"
	CmdWorkerAnswer    = "worker.answer"

	// TTerminalFrame and TTerminalClosed go only to the watching
	// connection: no seq, not in the replay ring.
	TTerminalFrame  = "terminal.frame"
	TTerminalClosed = "terminal.closed"
)

func init() {
	Commands = append(Commands, CmdTerminalWatch, CmdTerminalUnwatch, CmdWorkerKeys, CmdWorkerPrompt, CmdWorkerAnswer)
}

// Error codes.
const (
	ErrInputFailed  = "input_failed"  // herdr refused keys or text
	ErrPromptFailed = "prompt_failed" // a prompt was not submitted
	ErrStale        = "stale"         // worker.answer for a question the screen no longer asks
)

// terminal.closed reasons.
const (
	ClosedWorkerRemoved  = "worker_removed"
	ClosedAsleep         = "asleep"
	ClosedPaneChanged    = "pane_changed"
	ClosedObserverFailed = "observer_failed"
)

// Question kinds.
const (
	QuestionPermission = "permission"
	QuestionChoice     = "choice"
	QuestionTrust      = "trust"
	QuestionOther      = "other"
)

// TerminalWatchArgs are the args of terminal.watch. Fps, Cols and Rows
// are optional (0: the bridge's defaults).
type TerminalWatchArgs struct {
	ID   string `json:"id"`
	Fps  int    `json:"fps,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

// TerminalWatchResult is the ack data of terminal.watch: the pane watched
// and the observer's size.
type TerminalWatchResult struct {
	Pane string `json:"pane"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

// TerminalFrame is a watched pane's screen: a full frame or an ANSI diff
// to apply on top of the previous ones (base64 in Data). N counts frames
// per watch from 1.
type TerminalFrame struct {
	T    string `json:"t"`
	ID   string `json:"id"`
	Pane string `json:"pane"`
	N    uint64 `json:"n"`
	Full bool   `json:"full"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	Data string `json:"data"`
}

// TerminalClosed ends a watch the client did not unwatch.
type TerminalClosed struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// WorkerKeysArgs are the args of worker.keys.
type WorkerKeysArgs struct {
	ID    string      `json:"id"`
	Input []InputItem `json:"input"`
}

// InputItem is exactly one of literal text or a key name.
type InputItem struct {
	Text *string `json:"text,omitempty"`
	Key  *string `json:"key,omitempty"`
}

// WorkerPromptArgs are the args of worker.prompt.
type WorkerPromptArgs struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

// PromptResult is the ack data of worker.prompt.
type PromptResult struct {
	// Queued: the agent was working, so it takes the prompt next.
	Queued bool `json:"queued"`
	// Retried: the first Enter was dropped and pressed again.
	Retried bool `json:"retried"`
}

// Question is what a blocked worker's screen asks.
type Question struct {
	Kind     string   `json:"kind"`
	Text     string   `json:"text"`
	Excerpt  []string `json:"excerpt"`
	Choices  []Choice `json:"choices"`
	Selected int      `json:"selected,omitempty"`
	Hash     string   `json:"hash"`
}

// Choice is one choice of a question's menu.
type Choice struct {
	N     int    `json:"n"`
	Label string `json:"label"`
}

// WorkerAnswerArgs are the args of worker.answer: exactly one of Choice
// and Cancel.
type WorkerAnswerArgs struct {
	ID     string `json:"id"`
	Hash   string `json:"hash"`
	Choice int    `json:"choice,omitempty"`
	Cancel bool   `json:"cancel,omitempty"`
}

// AnswerResult is the ack data of worker.answer: the keys pressed and
// whether the worker left blocked within 3 s.
type AnswerResult struct {
	Sent     []string `json:"sent"`
	Resolved bool     `json:"resolved"`
}
