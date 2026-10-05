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
	CmdTerminalZoom    = "terminal.zoom" // #74

	// TTerminalFrame and TTerminalClosed go only to the watching
	// connection: no seq, not in the replay ring.
	TTerminalFrame  = "terminal.frame"
	TTerminalClosed = "terminal.closed"
	// TTerminalState (#74) is a followed watch's zoom, focus or size
	// changing: connection-scoped like the frames.
	TTerminalState = "terminal.state"
)

func init() {
	Commands = append(Commands, CmdTerminalWatch, CmdTerminalUnwatch, CmdWorkerKeys, CmdWorkerPrompt, CmdWorkerAnswer, CmdTerminalZoom)
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
	// Fullscreen (#74) is a tri-state. true asks the bridge to zoom the
	// pane's tab on the pane while it is watched, and to put the tab back
	// after. false does not zoom. Both make the watch follow the pane's zoom,
	// focus and size (terminal.state). Absent (nil): the watch of an old
	// client, as before #74: no zoom, no state messages.
	Fullscreen *bool `json:"fullscreen,omitempty"`
}

// Zoom states of a watched pane (ZoomInfo.State).
const (
	ZoomSingle = "single" // the tab has one pane
	ZoomZoomed = "zoomed" // the tab is zoomed on this pane
	ZoomSplit  = "split"  // the pane shows at its split size
)

// ZoomInfo (#74) is what a watched pane's tab does with it. Applied: the
// bridge zoomed the tab and will put it back. Headless: the tab's area is
// herdr's headless 120 × 40, so most likely no client is attached and a
// zoom does not make the terminal any bigger.
type ZoomInfo struct {
	State    string `json:"state"`
	Applied  bool   `json:"applied"`
	Headless bool   `json:"headless,omitempty"`
}

// TerminalWatchResult is the ack data of terminal.watch: the pane watched
// and the observer's size. Zoom is absent when the bridge could not read
// the pane's tab.
type TerminalWatchResult struct {
	Pane string    `json:"pane"`
	Cols int       `json:"cols"`
	Rows int       `json:"rows"`
	Zoom *ZoomInfo `json:"zoom,omitempty"`
}

// TerminalZoomArgs are the args of terminal.zoom (#74): On is required.
type TerminalZoomArgs struct {
	ID string `json:"id"`
	On *bool  `json:"on"`
}

// TerminalState is sent to a watch that follows its pane's zoom when the
// zoom, the focus or the size changed. The next terminal.frame is a full
// one at Cols × Rows.
type TerminalState struct {
	T    string   `json:"t"`
	ID   string   `json:"id"`
	Pane string   `json:"pane"`
	Cols int      `json:"cols"`
	Rows int      `json:"rows"`
	Zoom ZoomInfo `json:"zoom"`
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
	// Sent is the text the bridge sent, when it rewrote the typed one for the
	// worker's harness (#138); absent when it sent the text as typed. The
	// agent's transcript shows this text.
	Sent string `json:"sent,omitempty"`
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
