package proto

// #93 hire presets (docs/protocol.md "Hire presets"): a named first prompt
// with the harness, model and effort to hire it with, on one floor or global
// (every floor of the bridge). Using one is an ordinary worker.hire; these
// commands only keep them. Every preset is in the snapshot
// (World.HirePresets); each change is a hire_preset.upsert (HirePreset), a
// delete (or its virtual floor's) a hire_preset.removed (ID).

// Commands and events of the feature.
const (
	CmdHirePresetCreate = "hire_preset.create"
	CmdHirePresetUpdate = "hire_preset.update"
	CmdHirePresetDelete = "hire_preset.delete"
	// #95: whether a preset's prompt hands work to other agents (the
	// editor's nudge to tick "Add herdr hiring instructions").
	CmdHirePresetCheck  = "hire_preset.check"
	EvHirePresetUpsert  = "hire_preset.upsert"
	EvHirePresetRemoved = "hire_preset.removed"
)

func init() {
	Commands = append(Commands, CmdHirePresetCreate, CmdHirePresetUpdate, CmdHirePresetDelete, CmdHirePresetCheck)
}

// HirePreset is a stored hire preset. Floor is the floor id it belongs to;
// absent, it is global. CreatedAt and UpdatedAt are unix ms (an editor
// opened before a newer UpdatedAt is stale). HerdrInstructions (#95; left
// out when off): a hire from it gets the herdr hiring instructions for the
// floor it is used on (worker.hire's herdr_instructions).
type HirePreset struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Floor             string `json:"floor,omitempty"`
	Prompt            string `json:"prompt"`
	Harness           string `json:"harness"`
	Model             string `json:"model"`
	Effort            string `json:"effort"`
	HerdrInstructions bool   `json:"herdr_instructions,omitempty"`
	CreatedAt         int64  `json:"created_at"`
	UpdatedAt         int64  `json:"updated_at"`
}

// HirePresetSpec is what a preset holds: hire_preset.create's args (and
// hire_preset.update's, with its id). Floor "" (or absent) is global. Name:
// 1-40 bytes, no control characters, unique ignoring case in its scope;
// Prompt: a first prompt (worker.hire's rules, not empty); the tuple one of
// hire_options. HerdrInstructions (#95): "Add herdr hiring instructions";
// a client sends it only to a bridge whose snapshot has
// World.HerdrInstructions (an older one refuses the unknown field).
type HirePresetSpec struct {
	Name              string `json:"name"`
	Floor             string `json:"floor,omitempty"`
	Prompt            string `json:"prompt"`
	Harness           string `json:"harness"`
	Model             string `json:"model"`
	Effort            string `json:"effort"`
	HerdrInstructions bool   `json:"herdr_instructions,omitempty"`
}

// HirePresetUpdateArgs are hire_preset.update's: the whole spec replaces the
// preset's (its scope too).
type HirePresetUpdateArgs struct {
	ID string `json:"id"`
	HirePresetSpec
}

// HirePresetDeleteArgs are hire_preset.delete's.
type HirePresetDeleteArgs struct {
	ID string `json:"id"`
}

// HirePresetCheckArgs are hire_preset.check's: the prompt as the editor
// would save it.
type HirePresetCheckArgs struct {
	Prompt string `json:"prompt"`
}

// HirePresetCheckResult is hire_preset.check's ack: Delegates when the
// classifier's Score reaches the threshold. Delegates false also on any
// failure, a timeout or a classifier that is not ready: the preset saves as
// it is.
type HirePresetCheckResult struct {
	Delegates bool    `json:"delegates"`
	Score     float64 `json:"score"`
}
