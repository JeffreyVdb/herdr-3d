package proto

import "encoding/json"

// M16 transcript: a worker's agent conversation as one normalised
// timeline (see docs/protocol.md "Laptops: transcript").

// Commands and connection-scoped messages.
const (
	CmdTranscriptWatch   = "transcript.watch"
	CmdTranscriptUnwatch = "transcript.unwatch"
	CmdTranscriptPage    = "transcript.page"
	CmdTranscriptItem    = "transcript.item"

	// TTranscriptItems and TTranscriptClosed go only to the watching
	// connection: no seq, not in the replay ring.
	TTranscriptItems  = "transcript.items"
	TTranscriptClosed = "transcript.closed"
)

func init() {
	Commands = append(Commands, CmdTranscriptWatch, CmdTranscriptUnwatch, CmdTranscriptPage, CmdTranscriptItem)
}

// transcript.closed reasons (worker_removed and asleep as for terminals).
const (
	ClosedSessionChanged = "session_changed"
	ClosedResync         = "resync"
	ClosedNotFound       = "not_found"
)

// Item kinds.
const (
	ItemUser       = "user"
	ItemAssistant  = "assistant"
	ItemThinking   = "thinking"
	ItemTool       = "tool"
	ItemSubagent   = "subagent"
	ItemCompaction = "compaction"
	ItemNotice     = "notice"
	ItemUnknown    = "unknown"
)

// Tool statuses.
const (
	ToolRunning     = "running"
	ToolOK          = "ok"
	ToolError       = "error"
	ToolInterrupted = "interrupted"
)

// TranscriptItem is one entry of a transcript's timeline.
type TranscriptItem struct {
	// ID is stable for the transcript: Claude's message id plus the index
	// of its first block ("msg_…#0"), its line's uuid or its tool_use id;
	// Codex's item id or call_id; "o:<byte offset>" for a line without one.
	ID   string `json:"id"`
	Seq  int64  `json:"seq"` // order in the transcript, from 1
	TS   int64  `json:"ts"`  // unix ms, 0 when the line has no timestamp
	Kind string `json:"kind"`
	// Hidden is noise the game shows only with "show system": dropped
	// lines (as notices) and unknown ones.
	Hidden    bool                `json:"hidden,omitempty"`
	Parts     []TranscriptPart    `json:"parts,omitempty"`
	Truncated bool                `json:"truncated,omitempty"` // a part's text was cut (transcript.item has it all)
	Tool      *TranscriptTool     `json:"tool,omitempty"`
	Subagent  *TranscriptSubagent `json:"subagent,omitempty"`
	Notice    *TranscriptNotice   `json:"notice,omitempty"`
	RawType   string              `json:"raw_type,omitempty"` // unknown: the line or block type not recognised
}

// TranscriptPart is text (markdown) or an image, which phase 1 never
// decodes: just its place.
type TranscriptPart struct {
	Text         string `json:"text,omitempty"`
	ImageOmitted bool   `json:"image_omitted,omitempty"`
}

// TranscriptTool is a tool call and, once it came, its result.
type TranscriptTool struct {
	Name         string `json:"name"`
	InputSummary string `json:"input_summary"`
	// Input is the call's raw input (JSON): in lists only when at most
	// 4 KiB, always in transcript.item.
	Input           json.RawMessage  `json:"input,omitempty"`
	Status          string           `json:"status"`
	OutputText      string           `json:"output_text,omitempty"`
	OutputTruncated bool             `json:"output_truncated,omitempty"`
	Images          []TranscriptPart `json:"images,omitempty"` // images in the output ({image_omitted})
	Diff            *TranscriptDiff  `json:"diff,omitempty"`
	// Diffs has every file of a patch that changes more than one (Diff is
	// the first).
	Diffs []TranscriptDiff `json:"diffs,omitempty"`
}

// TranscriptDiff is a file's change as unified diff hunks.
type TranscriptDiff struct {
	Path      string           `json:"path"`
	Hunks     []TranscriptHunk `json:"hunks"`
	Truncated bool             `json:"truncated,omitempty"` // lines were left out (transcript.item has them)
}

// TranscriptHunk is one hunk: its lines start with ' ', '-' or '+'.
// Codex patches have no line numbers (0).
type TranscriptHunk struct {
	OldStart int      `json:"old_start"`
	OldLines int      `json:"old_lines"`
	NewStart int      `json:"new_start"`
	NewLines int      `json:"new_lines"`
	Lines    []string `json:"lines"`
}

// TranscriptSubagent is a Claude subagent the call started; its own
// timeline is transcript.page with agent.
type TranscriptSubagent struct {
	AgentID     string `json:"agent_id"`
	Description string `json:"description"`
	Status      string `json:"status"`
}

// TranscriptNotice is a notice's text and where it came from.
type TranscriptNotice struct {
	Text   string `json:"text"`
	Source string `json:"source,omitempty"` // the line type ("system/turn_duration", "attachment/date", …)
}

// TranscriptWatchArgs are the args of transcript.watch (limit 0: 200).
type TranscriptWatchArgs struct {
	ID    string `json:"id"`
	Limit int    `json:"limit,omitempty"`
}

// TranscriptHead is what a watch says of the transcript it reads.
type TranscriptHead struct {
	Harness string `json:"harness"`
	Session string `json:"session"`
	Version string `json:"version"`
	Cursor  string `json:"cursor"`
	HasMore bool   `json:"has_more"`
	Pending bool   `json:"pending"`
}

// TranscriptWatchResult is the ack data of transcript.watch.
type TranscriptWatchResult struct {
	TranscriptHead
	Items []TranscriptItem `json:"items"`
}

// TranscriptItems is a watch's push: new items and whole replacements of
// items sent before (by id). The first push after a pending ack also has
// the head.
type TranscriptItems struct {
	T       string           `json:"t"`
	ID      string           `json:"id"`
	Items   []TranscriptItem `json:"items"`
	Updates []TranscriptItem `json:"updates"`
	*TranscriptHead
}

// TranscriptClosed ends a watch the client did not unwatch.
type TranscriptClosed struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// TranscriptPageArgs are the args of transcript.page: the items before a
// cursor, or with agent a Claude subagent's timeline (before "": its
// newest).
type TranscriptPageArgs struct {
	ID     string `json:"id"`
	Before string `json:"before,omitempty"`
	Limit  int    `json:"limit,omitempty"`
	Agent  string `json:"agent,omitempty"`
}

// TranscriptPageResult is the ack data of transcript.page.
type TranscriptPageResult struct {
	Items   []TranscriptItem `json:"items"`
	Cursor  string           `json:"cursor"`
	HasMore bool             `json:"has_more"`
}

// TranscriptItemArgs are the args of transcript.item (agent: an item of
// that subagent's timeline).
type TranscriptItemArgs struct {
	ID    string `json:"id"`
	Item  string `json:"item"`
	Agent string `json:"agent,omitempty"`
}

// TranscriptItemResult is the ack data of transcript.item.
type TranscriptItemResult struct {
	Item TranscriptItem `json:"item"`
}
