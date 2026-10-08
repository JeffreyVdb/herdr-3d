package proto

import "encoding/json"

// M6 launch: team presets (preset.*) and starting a write-code run from
// the game (run.prepare, run.start).

// Events of team presets.
const (
	EvPresetUpsert  = "preset.upsert"  // preset
	EvPresetRemoved = "preset.removed" // id
)

// Commands of team presets and runs.
const (
	CmdPresetCreate = "preset.create"
	CmdPresetUpdate = "preset.update"
	CmdPresetDelete = "preset.delete"
	CmdRunPrepare   = "run.prepare"
	CmdRunStart     = "run.start"
)

// Ticket kinds (RunTicket.Kind).
const (
	TicketIssue = "issue"
	TicketText  = "text"
	// TicketItem (#184) is an item of an issue provider that numbers no
	// GitHub issues (a Kaneo task): RunTicket.Item names it.
	TicketItem = "item"
)

func init() {
	Commands = append(Commands, CmdPresetCreate, CmdPresetUpdate, CmdPresetDelete, CmdRunPrepare, CmdRunStart)
}

// Preset is a team preset: the harness/model/effort of each role of a
// write-code run.
type Preset struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Seeded marks the "Build team" the bridge made once.
	Seeded bool        `json:"seeded"`
	Roles  PresetRoles `json:"roles"`
}

// PresetRoles are a preset's five roles, all required.
type PresetRoles struct {
	Orch       Hire `json:"orch"`
	Coder      Hire `json:"coder"`
	Reviewer   Hire `json:"reviewer"`
	UX         Hire `json:"ux"`
	Researcher Hire `json:"researcher"`
}

// PresetCreateArgs are the args of preset.create.
type PresetCreateArgs struct {
	Name  string      `json:"name"`
	Roles PresetRoles `json:"roles"`
}

// PresetUpdateArgs are the args of preset.update; Roles replaces all five.
type PresetUpdateArgs struct {
	ID    string       `json:"id"`
	Name  *string      `json:"name,omitempty"`
	Roles *PresetRoles `json:"roles,omitempty"`
}

// PresetDeleteArgs are the args of preset.delete.
type PresetDeleteArgs struct {
	ID string `json:"id"`
}

// RunPrepareArgs are the args of run.prepare. Issue is an int, or a string
// "#3", "3" or "https://github.com/<owner>/<repo>/issues/<n>".
type RunPrepareArgs struct {
	Session string          `json:"session"`
	Issue   json.RawMessage `json:"issue,omitempty"`
	Text    string          `json:"text,omitempty"`
	// WorkItem (M7) is a third, exclusive way to name the ticket: an item of
	// the floor's issue provider, as a board card's id.
	WorkItem *WorkItemRef `json:"work_item,omitempty"`
	Preset   string       `json:"preset,omitempty"`
	Orch     *Hire        `json:"orch,omitempty"`
	Extra    string       `json:"extra,omitempty"`
}

// RunTicket is what a run works on: a GitHub issue, free text, or (#184)
// an item of the floor's issue provider.
type RunTicket struct {
	Kind   string `json:"kind"`
	Repo   string `json:"repo,omitempty"`
	Number int    `json:"number,omitempty"`
	URL    string `json:"url,omitempty"`
	Text   string `json:"text,omitempty"`
	// Item is the item of an "item" ticket: provider and id, with the key,
	// title and URL the provider gave (its URL is URL too); ProviderName
	// names the provider ("Kaneo").
	Item         *WorkItemRef `json:"item,omitempty"`
	ProviderName string       `json:"provider_name,omitempty"`
	// Body is an item's description as the provider gave it, for the
	// prompt only (never on the wire).
	Body string `json:"-"`
}

// RunPrepareResult is the ack data of run.prepare: what the start-run
// dialog and its prompt preview show. Prompt is "" (and Label, Ticket
// empty) until an issue or a text is given.
type RunPrepareResult struct {
	Prompt   string     `json:"prompt"`
	Label    string     `json:"label"`
	Ticket   *RunTicket `json:"ticket"`
	Preset   string     `json:"preset"`
	Orch     *Hire      `json:"orch"`
	Cwd      string     `json:"cwd"`
	Git      *HireGit   `json:"git"`
	Capacity Capacity   `json:"capacity"`
}

// RunStartArgs are the args of run.start. Worktree defaults to true;
// Prompt, when set, is sent instead of the composed one.
type RunStartArgs struct {
	Session   string          `json:"session"`
	DeskIndex *int            `json:"desk_index"`
	Issue     json.RawMessage `json:"issue,omitempty"`
	Text      string          `json:"text,omitempty"`
	WorkItem  *WorkItemRef    `json:"work_item,omitempty"`
	Orch      *Hire           `json:"orch"`
	Preset    string          `json:"preset"`
	Extra     string          `json:"extra,omitempty"`
	Worktree  *bool           `json:"worktree,omitempty"`
	Label     string          `json:"label,omitempty"`
	Prompt    string          `json:"prompt,omitempty"`
}

// RunStartResult is the ack data of run.start: worker.hire's, plus the
// launch and the prompt that was sent.
type RunStartResult struct {
	HireResult
	LaunchID string `json:"launch_id"`
	Prompt   string `json:"prompt"`
}
