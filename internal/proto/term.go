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
	// #176: the seated laptop's controller: the real PTY's size and herdr's
	// history.
	CmdTerminalResize = "terminal.resize"
	CmdTerminalScroll = "terminal.scroll"

	// TTerminalFrame and TTerminalClosed go only to the watching
	// connection: no seq, not in the replay ring.
	TTerminalFrame  = "terminal.frame"
	TTerminalClosed = "terminal.closed"
	// TTerminalState (#74) is a followed watch's zoom, focus or size
	// changing: connection-scoped like the frames.
	TTerminalState = "terminal.state"
	// #176: a control watch's ownership (TerminalControl) and where its view
	// is in herdr's history (TerminalHistory): connection-scoped like the frames.
	TTerminalControl = "terminal.control"
	TTerminalHistory = "terminal.history"
)

func init() {
	Commands = append(Commands, CmdTerminalWatch, CmdTerminalUnwatch, CmdWorkerKeys, CmdWorkerPrompt, CmdWorkerAnswer, CmdTerminalZoom,
		CmdTerminalResize, CmdTerminalScroll)
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
	// Control (#176): own the pane while it is watched (the seated laptop):
	// the bridge runs herdr's terminal controller instead of an observer, the
	// real PTY at Cols × Rows (absent: the pane's size), and terminal.resize
	// and terminal.scroll act on it. At most one per connection. When herdr
	// refuses (another client owns the pane) the watch observes read only
	// (terminal.control says so).
	Control bool `json:"control,omitempty"`
}

// terminal.control modes and read-only reasons (#176).
const (
	ControlOwned    = "control" // the bridge owns the pane for this watch
	ControlReadOnly = "observe" // it observes the pane read only
	// ReadOnlyBusy: another client owns the pane (herdr refused the controller).
	ReadOnlyBusy = "busy"
	// ReadOnlyTakenOver: another client took the pane over.
	ReadOnlyTakenOver = "taken_over"
	// ReadOnlyFailed: the controller kept failing to start or ended at once.
	ReadOnlyFailed = "failed"
)

// TerminalControl (#176) tells a control watch who owns its pane: Mode
// ControlOwned once the controller's first frame came, ControlReadOnly (with
// Reason) when the watch fell back to a read-only observer. Cols × Rows is the
// size its frames come at from now on. Sent when the mode changes, before the
// next frame.
type TerminalControl struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	Pane   string `json:"pane"`
	Mode   string `json:"mode"`
	Reason string `json:"reason,omitempty"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

// TerminalHistory (#176) is where a controlled pane's view is in herdr's
// history: Offset lines above the live bottom (0: live), at most Max, Rows
// rows shown. Sent when it changes (herdr's `pane.get`, read after a scroll and
// about once a second while the view is above the live bottom).
type TerminalHistory struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	Pane   string `json:"pane"`
	Offset int    `json:"offset"`
	Max    int    `json:"max"`
	Rows   int    `json:"rows"`
}

// TerminalResizeArgs are the args of terminal.resize (#176): the PTY's new
// size (cols 40-300, rows 10-100) and, optionally, a cell's size in pixels
// (0-256).
type TerminalResizeArgs struct {
	ID         string `json:"id"`
	Cols       int    `json:"cols"`
	Rows       int    `json:"rows"`
	CellWidth  int    `json:"cell_width_px,omitempty"`
	CellHeight int    `json:"cell_height_px,omitempty"`
}

// TerminalResizeResult is the ack data of terminal.resize.
type TerminalResizeResult struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

// TerminalScrollArgs are the args of terminal.scroll (#176): exactly one of a
// wheel (Direction "up" or "down", Lines 1-1000, over cell Column × Row with
// Modifiers: Shift 1, Ctrl 2, Alt 4) and Bottom (back to the live bottom).
type TerminalScrollArgs struct {
	ID        string `json:"id"`
	Direction string `json:"direction,omitempty"`
	Lines     int    `json:"lines,omitempty"`
	Column    int    `json:"column,omitempty"`
	Row       int    `json:"row,omitempty"`
	Modifiers int    `json:"modifiers,omitempty"`
	Bottom    bool   `json:"bottom,omitempty"`
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
	// Control (#176): the watch asked for control and the bridge can give it
	// (terminal.control follows with who owns the pane).
	Control bool `json:"control,omitempty"`
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
	// Op (#224, optional): the operation id of a "/handoff [instruction]"
	// prompt (1–64 of [A-Za-z0-9_-]), which becomes an agent handoff
	// request: a repeated submit with it answers the first.
	Op string `json:"op,omitempty"`
	// Secrets (#108, optional): the review of Text's possible secrets
	// (docs/protocol.md "Prompt secrets").
	Secrets *SecretsReview `json:"secrets,omitempty"`
	// SecretsPending (#108 round 2, optional): packup.detect's
	// secrets_pending for this text: its reviewed text needs no review
	// again, and its files become the worker's once the prompt is sent.
	SecretsPending string `json:"secrets_pending,omitempty"`
}

// PromptResult is the ack data of worker.prompt.
type PromptResult struct {
	// Queued: the agent was working, so it takes the prompt next.
	Queued bool `json:"queued"`
	// Retried: the first Enter was dropped and pressed again.
	Retried bool `json:"retried"`
	// Sent is the text the bridge sent, when it rewrote the typed one for the
	// worker's harness (#138) or (#108) put file references in place of the
	// protected secrets; absent when it sent the text as typed. The agent's
	// transcript shows this text. A /handoff's (#108): the composer's text
	// with its references, once the request is sent (not when Existing).
	Sent string `json:"sent,omitempty"`
	// Protected (#108): how many ranges went to private files (absent: none).
	Protected int `json:"protected,omitempty"`
	// Terminal (#140): the prompt is a built-in whose output or dialog shows
	// only in the worker's terminal (harness.TerminalOnly); absent otherwise.
	Terminal bool `json:"terminal,omitempty"`
	// Via (#156): "app_server" when the prompt went through a shared Codex
	// worker's app-server (herdr refuses a prompt while Codex's async
	// question shows the worker as blocked); absent when herdr sent it.
	Via string `json:"via,omitempty"`
	// Handoff (#224): the prompt was "/handoff [instruction]" and became
	// this agent handoff request (Existing: one with its op, or the
	// worker's pending one, was answered; nothing was sent again).
	Handoff  *AgentHandoff `json:"handoff,omitempty"`
	Existing bool          `json:"existing,omitempty"`
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
