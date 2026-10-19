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
	CmdTranscriptImage   = "transcript.image"
	CmdTranscriptImages  = "transcript.images"

	// TTranscriptItems and TTranscriptClosed go only to the watching
	// connection: no seq, not in the replay ring.
	TTranscriptItems  = "transcript.items"
	TTranscriptClosed = "transcript.closed"
)

func init() {
	Commands = append(Commands, CmdTranscriptWatch, CmdTranscriptUnwatch, CmdTranscriptPage, CmdTranscriptItem, CmdTranscriptImage, CmdTranscriptImages)
}

// transcript.closed reasons (worker_removed and asleep as for terminals).
const (
	ClosedSessionChanged = "session_changed"
	ClosedResync         = "resync"
	ClosedNotFound       = "not_found"
	// ClosedEvicted (#26): a child watch the connection's newer child watch
	// replaced (at most MaxChildTranscriptWatches each).
	ClosedEvicted = "evicted"
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
	// ToolDenied (#171): the call never ran: the user rejected it (Claude
	// Code's permission prompt). Older bridges sent it as error.
	ToolDenied = "denied"
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
	Hidden bool             `json:"hidden,omitempty"`
	Parts  []TranscriptPart `json:"parts,omitempty"`
	// Answers (#183, user): the item is the reply to Codex's async questions,
	// Parts holding the native envelope's text as it was sent; one entry per
	// answer, in the envelope's order, for the view to show instead of Parts.
	Answers   []TranscriptAnswer  `json:"answers,omitempty"`
	Truncated bool                `json:"truncated,omitempty"` // a part's text was cut (transcript.item has it all)
	Tool      *TranscriptTool     `json:"tool,omitempty"`
	Subagent  *TranscriptSubagent `json:"subagent,omitempty"`
	// Collab (#56): a Codex collaboration call (a tool item) or an
	// inter-agent message (a notice item), read for the view.
	Collab  *TranscriptCollab `json:"collab,omitempty"`
	Notice  *TranscriptNotice `json:"notice,omitempty"`
	RawType string            `json:"raw_type,omitempty"` // unknown: the line or block type not recognised
}

// TranscriptAnswer is one answer of a Codex async-question reply: the
// question's title and the answer text, both plain text (not markdown), never
// the question's id.
type TranscriptAnswer struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// TranscriptPart is text (markdown) or an image.
type TranscriptPart struct {
	Text  string    `json:"text,omitempty"`
	Image *ImageRef `json:"image,omitempty"`
}

// Image origins: who put the image in the conversation.
const (
	// OriginInput is an image the user attached to a prompt (a paste, an
	// [Image #n: path] marker in a user message).
	OriginInput = "input"
	// OriginAgent is every other: what the agent viewed or generated.
	OriginAgent = "agent"
)

// Image kinds of an agent image (a detail for the view: a badge).
const (
	KindGenerated = "generated"
	KindViewed    = "viewed"
)

// Image sources.
const (
	ImageInline = "inline" // base64 in the transcript
	ImagePath   = "path"   // a file the transcript names
)

// ImageMimeBinary is the mime of inline bytes that are not an image the
// bridge serves (no thumbnail, no download).
const ImageMimeBinary = "binary"

// ImageRef is an image in a transcript item. It never has bytes:
// transcript.image serves them by hash.
type ImageRef struct {
	// Hash is the sha256 of the image bytes, in hex ("" when Unavailable):
	// the key of transcript.image, and the same image twice has the same.
	Hash string `json:"hash,omitempty"`
	// Mime is image/png, image/jpeg, image/gif or image/webp; "binary" for
	// bytes that are none of them.
	Mime   string `json:"mime,omitempty"`
	Bytes  int64  `json:"bytes,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
	Source string `json:"source"`
	// Path is the file a path image names (Source "path"): text for the
	// view, never fetched by the client.
	Path   string `json:"path,omitempty"`
	Origin string `json:"origin"`
	Kind   string `json:"kind,omitempty"`
	// ItemID, Seq and TS are the item the image is in.
	ItemID string `json:"item_id,omitempty"`
	Seq    int64  `json:"seq,omitempty"`
	TS     int64  `json:"ts,omitempty"`
	// Unavailable: the bridge did not take the image (a path outside its
	// roots, a file that is gone, too large or not an image); Reason says
	// which: not_allowed, missing, too_large, not_image, invalid.
	Unavailable bool   `json:"unavailable,omitempty"`
	Reason      string `json:"reason,omitempty"`
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
	Images          []TranscriptPart `json:"images,omitempty"` // images in the output ({image: ImageRef})
	Diff            *TranscriptDiff  `json:"diff,omitempty"`
	// Diffs has every file of a patch that changes more than one (Diff is
	// the first).
	Diffs []TranscriptDiff `json:"diffs,omitempty"`
	// Ask is an AskUserQuestion / request_user_input call's question card
	// (#57): its questions and, once answered, the answers.
	Ask *TranscriptAsk `json:"ask,omitempty"`
	// Changes (#171) is what a Claude Bash call's bashEditDiff says beyond
	// its diffs: files it changed without a diff, and how complete and how
	// much its own the list is. Absent: the source said nothing (an older
	// Claude Code, recording off, not a Bash call): unknown, not "no changes".
	// #21: a running Codex exec script's patches it cannot show (Computed).
	Changes *TranscriptChanges `json:"changes,omitempty"`
}

// TranscriptChanges is a command's file changes as Claude Code recorded them
// (bashEditDiff, best effort): Diffs hold the files with a diff (at most 5),
// these the rest.
type TranscriptChanges struct {
	// Paths are changed files with no diff (changedFiles less the diffed
	// ones; the source lists at most 200 changed files).
	Paths []string `json:"paths,omitempty"`
	// MoreFiles is how many changed files have no diff (moreFiles): it can be
	// more than len(Paths) when the source's list was cut.
	MoreFiles int `json:"more_files,omitempty"`
	// Unavailable: the record is incomplete or could not be taken; diffs it
	// has are still real.
	Unavailable bool `json:"unavailable,omitempty"`
	// Skipped: a git command that moves the working tree (checkout, stash):
	// no diff was taken at all.
	Skipped bool `json:"skipped,omitempty"`
	// Shared: another Bash call ran in the same repository at the same time,
	// so some of the listed changes may be its.
	Shared bool `json:"shared,omitempty"`
	// Computed (#21) is how many patches a Codex exec script that is still
	// running passes to apply_patch in a form not read from its text (built
	// by the script: a concatenation, a variable): their changes show once
	// Codex records them, nothing is made up before.
	Computed int `json:"computed,omitempty"`
}

// TranscriptDiff is a file's change as unified diff hunks.
type TranscriptDiff struct {
	Path      string           `json:"path"`
	Hunks     []TranscriptHunk `json:"hunks"`
	Truncated bool             `json:"truncated,omitempty"` // lines were left out (transcript.item has them)
	// Op (#171) is what happened to the file, when the source says: edit,
	// create, overwrite (a Write over a file that was there), delete or
	// (#21) rename; "" is not known (older bridges).
	Op string `json:"op,omitempty"`
	// To (#21) is a renamed file's new path (Op rename; Path is the old one).
	To string `json:"to,omitempty"`
	// NoDiff (#171): the source recorded the change but no lines for it
	// (Hunks is empty): Claude Code's Write over a file with no patch (no
	// change, too large or timed out). Not a cut of ours (Truncated is).
	NoDiff bool `json:"no_diff,omitempty"`
}

// Diff operations (#171).
const (
	DiffEdit      = "edit"
	DiffCreate    = "create"
	DiffOverwrite = "overwrite"
	DiffDelete    = "delete"
	DiffRename    = "rename" // #21: a Codex patch's "Move to"
)

// TranscriptHunk is one hunk: its lines start with ' ', '-' or '+' (or a
// backslash: "\ No newline at end of file"). A Codex patch's own text has no line
// numbers (0); what Codex recorded it did has them (#21).
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

// Collaboration kinds (#56): the Codex call (spawn_agent, send_message,
// followup_task, wait_agent, close_agent) or an inter-agent message.
const (
	CollabSpawn    = "spawn"
	CollabSend     = "send"
	CollabFollowup = "followup"
	CollabWait     = "wait"
	CollabClose    = "close"
	CollabInbound  = "inbound"
)

// TranscriptCollab (#56) is what a Codex collaboration call or inter-agent
// message says in plain text. Multi-agent v2 encrypts the message itself
// (the Responses API does; nothing local can read it): Encrypted, and no
// Prompt. Every field is "" when the source does not say it.
type TranscriptCollab struct {
	Kind string `json:"kind"`
	// TaskName is a spawn's task name ("gpu_research"); Target the agent a
	// send, followup or close is for, as the call names it.
	TaskName string `json:"task_name,omitempty"`
	Target   string `json:"target,omitempty"`
	// AgentPath is the agent's path ("/root/gpu_research"): the call's
	// output or its SubAgentActivity event. Inbound: the sender.
	AgentPath string `json:"agent_path,omitempty"`
	// AgentType is a spawn's role (agent_type), when enabled.
	AgentType string `json:"agent_type,omitempty"`
	Model     string `json:"model,omitempty"`
	Effort    string `json:"effort,omitempty"`
	// ForkTurns is how much of the parent's history a spawn takes: "none",
	// "all" or a number of turns, as Codex wrote it.
	ForkTurns string `json:"fork_turns,omitempty"`
	// ThreadID is the child's thread (agent_thread_id; a v1 agent_id).
	ThreadID string `json:"thread_id,omitempty"`
	Nickname string `json:"nickname,omitempty"`
	// Recipient and MessageType (NEW_TASK, MESSAGE, FINAL_ANSWER, …) are an
	// inbound message's header.
	Recipient   string `json:"recipient,omitempty"`
	MessageType string `json:"message_type,omitempty"`
	Encrypted   bool   `json:"encrypted,omitempty"`
	// Prompt is the message in plain text (a v1 spawn, a plain payload).
	Prompt string `json:"prompt,omitempty"`
}

// TranscriptNotice is a notice's text and where it came from.
type TranscriptNotice struct {
	Text   string `json:"text"`
	Source string `json:"source,omitempty"` // the line type ("system/turn_duration", "attachment/date", …)
}

// TranscriptChild (#26) makes a transcript command's target one of the
// worker's native children (docs/protocol.md "Native child agents"): its
// row id (Child.ID), the worker's child generation the client saw (its
// Child.Generation) and its provider. The bridge finds the child's log
// itself, from the worker's own registry row and session; a generation that
// is not the worker's now, a row that is not the worker's or another
// provider is refused. Absent: the worker's own transcript.
type TranscriptChild struct {
	ID         string `json:"id"`
	Generation uint64 `json:"generation"`
	Provider   string `json:"provider"`
}

// TranscriptWatchArgs are the args of transcript.watch (limit 0: 200).
type TranscriptWatchArgs struct {
	ID    string           `json:"id"`
	Limit int              `json:"limit,omitempty"`
	Child *TranscriptChild `json:"child,omitempty"` // #26
}

// TranscriptUnwatchArgs are the args of transcript.unwatch (#26: child, the
// child watch of the worker; absent, its own).
type TranscriptUnwatchArgs struct {
	ID    string           `json:"id"`
	Child *TranscriptChild `json:"child,omitempty"`
}

// TranscriptHead is what a watch says of the transcript it reads.
type TranscriptHead struct {
	Harness string `json:"harness"`
	Session string `json:"session"`
	Version string `json:"version"`
	Cursor  string `json:"cursor"`
	HasMore bool   `json:"has_more"`
	Pending bool   `json:"pending"`
	// Availability (#26, a child watch's only) is TranscriptAvailable once
	// its log is read; while Pending, TranscriptPending (a provisional child,
	// or its log not written or not found yet) or TranscriptUnavailable (the
	// provider says it has none, or it went).
	Availability string `json:"availability,omitempty"`
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
	Child   *TranscriptChild `json:"child,omitempty"` // #26: the child watch's
	Items   []TranscriptItem `json:"items"`
	Updates []TranscriptItem `json:"updates"`
	*TranscriptHead
}

// TranscriptClosed ends a watch the client did not unwatch.
type TranscriptClosed struct {
	T      string           `json:"t"`
	ID     string           `json:"id"`
	Child  *TranscriptChild `json:"child,omitempty"` // #26: the child watch's
	Reason string           `json:"reason"`
}

// TranscriptPageArgs are the args of transcript.page: the items before a
// cursor, or with agent a Claude subagent's timeline (before "": its
// newest).
type TranscriptPageArgs struct {
	ID     string           `json:"id"`
	Before string           `json:"before,omitempty"`
	Limit  int              `json:"limit,omitempty"`
	Agent  string           `json:"agent,omitempty"`
	Child  *TranscriptChild `json:"child,omitempty"` // #26: a page of the child watch's log
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
	ID    string           `json:"id"`
	Item  string           `json:"item"`
	Agent string           `json:"agent,omitempty"`
	Child *TranscriptChild `json:"child,omitempty"` // #26
}

// TranscriptItemResult is the ack data of transcript.item.
type TranscriptItemResult struct {
	Item TranscriptItem `json:"item"`
}

// Transcript image sizes.
const (
	ImageThumb = "thumb"
	ImageFull  = "full"
)

// MaxFullImageBase64 is the most base64 a full image may take in an ack
// (12 MiB): above it transcript.image answers too_large and the view keeps
// the thumbnail.
const MaxFullImageBase64 = 12 << 20

// TranscriptImageArgs are the args of transcript.image: an image by the
// hash of an ImageRef this connection was sent (agent: of that subagent's
// timeline).
type TranscriptImageArgs struct {
	ID    string           `json:"id"`
	Hash  string           `json:"hash"`
	Size  string           `json:"size"`
	Agent string           `json:"agent,omitempty"`
	Child *TranscriptChild `json:"child,omitempty"` // #26: a hash sent on the child watch
}

// TranscriptImageResult is the ack data of transcript.image.
type TranscriptImageResult struct {
	Mime   string `json:"mime"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	// Bytes is the size of the decoded image sent.
	Bytes int `json:"bytes"`
	// Size is what was sent: thumb or full.
	Size string `json:"size"`
	// Data is the image, base64.
	Data string `json:"data"`
}

// TranscriptImagesArgs are the args of transcript.images: the newest images
// (before "") or the ones before a cursor of an earlier answer. Limit is
// about how many refs to send at most (default DefaultSessionImages); a page
// is whole items, and is also bounded in bytes.
type TranscriptImagesArgs struct {
	ID     string           `json:"id"`
	Before string           `json:"before,omitempty"`
	Limit  int              `json:"limit,omitempty"`
	Child  *TranscriptChild `json:"child,omitempty"` // #26
}

// TranscriptImagesResult is the ack data of transcript.images: a run of the
// session's images (oldest first), without bytes. HasMore: there are older
// ones, from Cursor.
type TranscriptImagesResult struct {
	Images  []ImageRef `json:"images"`
	Cursor  string     `json:"cursor,omitempty"`
	HasMore bool       `json:"has_more,omitempty"`
}

// Image list limits: the default and the most one transcript.images sends.
const (
	DefaultSessionImages = 500
	MaxSessionImages     = 2000
)
