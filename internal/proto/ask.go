package proto

// #57: a structured question an agent asks (Claude's AskUserQuestion,
// Codex's request_user_input), read from its transcript, and answering it
// (docs/protocol.md "Laptops: asks").

// CmdWorkerAnswerAsk answers a worker's ask: the bridge drives the dialog
// on the worker's input lane.
const CmdWorkerAnswerAsk = "worker.answer_ask"

func init() { Commands = append(Commands, CmdWorkerAnswerAsk) }

// Ask sources and agents.
const (
	AskSourceTranscript = "transcript"
	AskClaude           = "claude"
	AskCodex            = "codex"
)

// Caps of an ask (Worker.Ask is in every snapshot; a transcript item's is
// in lists).
const (
	MaxAskQuestions   = 4
	MaxAskOptions     = 8
	MaxAskHeader      = 64      // bytes
	MaxAskQuestion    = 2000    // bytes
	MaxAskLabel       = 200     // bytes
	MaxAskDescription = 1000    // bytes
	MaxAskPreview     = 1024    // bytes
	MaxAskAnswer      = 2000    // bytes of one answer or its notes
	MaxAskOther       = 4 << 10 // bytes of an Other text in worker.answer_ask
	MaxAskPrompt      = 16 << 10
)

// Ask is a question an agent's latest turn waits on, from its transcript:
// the call (its tool_use id, or Codex's call_id) has no result yet, and no
// later prompt or interruption ended the turn. It is on the worker whatever
// herdr says of its status.
type Ask struct {
	ToolUseID string        `json:"tool_use_id"`
	Source    string        `json:"source"` // "transcript"
	Agent     string        `json:"agent"`  // "claude" | "codex"
	Questions []AskQuestion `json:"questions"`
	// Since is when the agent asked (the call's timestamp, else when the
	// bridge first read it), unix milliseconds.
	Since int64 `json:"since"`
}

// AskQuestion is one question of an ask.
type AskQuestion struct {
	// ID is Codex's question id (its answers are keyed by it); "" for Claude
	// (keyed by the question text).
	ID       string `json:"id,omitempty"`
	Header   string `json:"header"`
	Question string `json:"question"`
	// Multi: several options may be picked (Claude's multiSelect).
	Multi bool `json:"multi"`
	// Other: the dialog takes a typed answer too (Claude's "Type
	// something", Codex's "None of the above" with notes).
	Other bool `json:"other"`
	// Secret: the typed answer is masked on the screen (Codex isSecret).
	Secret    bool        `json:"secret,omitempty"`
	Options   []AskOption `json:"options"`
	Truncated bool        `json:"truncated,omitempty"` // a text was cut to its cap
}

// AskOption is one suggested answer.
type AskOption struct {
	Label       string `json:"label"`
	Description string `json:"description,omitempty"`
	// Preview is Claude's markdown preview of the option (capped).
	Preview string `json:"preview,omitempty"`
}

// Outcomes of an ask in the transcript.
const (
	AskPending     = "pending"
	AskAnswered    = "answered"
	AskDeclined    = "declined"    // Esc (Claude: "User rejected tool use"), or Codex's cancelled call
	AskClarify     = "clarify"     // Claude's "Chat about this"
	AskInterrupted = "interrupted" // the turn was interrupted before an answer
)

// TranscriptAsk is an AskUserQuestion / request_user_input tool item's
// question card: the questions and, once the call has its result, what was
// answered (TranscriptTool.Ask).
type TranscriptAsk struct {
	Agent     string        `json:"agent"`
	Questions []AskQuestion `json:"questions"`
	Outcome   string        `json:"outcome"`
	Answers   []AskAnswer   `json:"answers,omitempty"`
}

// AskAnswer is the recorded answer to one question.
type AskAnswer struct {
	Question int `json:"question"` // index into Questions
	// Answer is what the agent was told: the picked labels (Claude joins
	// several with ", "), or the typed text.
	Answer string `json:"answer"`
	// Labels are the picked options' labels when they can be told apart
	// (Codex lists them; Claude's that equal an option's label).
	Labels []string `json:"labels,omitempty"`
	// Other is the typed text (Codex's notes, Claude's answer that is no
	// option's label).
	Other string `json:"other,omitempty"`
	Notes string `json:"notes,omitempty"`
}

// WorkerAnswerAskArgs are the args of worker.answer_ask: an answer for
// every question, or Cancel (Esc) with an optional Prompt sent once the
// dialog is gone.
type WorkerAnswerAskArgs struct {
	ID        string         `json:"id"`
	ToolUseID string         `json:"tool_use_id"`
	Answers   []AskAnswerArg `json:"answers,omitempty"`
	Cancel    bool           `json:"cancel,omitempty"`
	Prompt    string         `json:"prompt,omitempty"`
}

// AskAnswerArg answers one question: option numbers (1-based; several only
// for a multi question) and/or an Other text.
type AskAnswerArg struct {
	Question int     `json:"question"` // index into the ask's questions
	Choices  []int   `json:"choices,omitempty"`
	Other    *string `json:"other,omitempty"`
}

// AnswerAskResult is the ack data of worker.answer_ask: the steps taken
// (key names; typed text is "text", never the text) and whether the
// transcript recorded the call's result within the answer timeout.
type AnswerAskResult struct {
	Sent     []string `json:"sent"`
	Resolved bool     `json:"resolved"`
	Prompted bool     `json:"prompted,omitempty"`
}
