package proto

// #138 Codex profiles (docs/protocol.md "Codex profiles"): a Codex account
// is a Codex home folder with its own sign-in. The bridge finds its own
// home ($CODEX_HOME, else ~/.codex) and every ~/.codex-* folder with an
// auth.json, plus the folders the user added; the user names and hides
// them. The list is in the snapshot (World.CodexProfiles) and every change
// is a codex_profiles.update event (the fields of CodexProfiles flat in it).
// Each visible profile's plan limits are their own limits.update
// (Limits.Account).

// Commands and the event of the feature.
const (
	CmdCodexProfilesGet   = "codex_profiles.get"
	CmdCodexProfilesSet   = "codex_profiles.set"
	EvCodexProfilesUpdate = "codex_profiles.update"
)

func init() { Commands = append(Commands, CmdCodexProfilesGet, CmdCodexProfilesSet) }

// Limits of the settings (codexaccount's).
const (
	CodexProfilesMaxAdded = 16 // folders the user can add
	CodexProfileMaxName   = 40 // characters of a name
	CodexRulesMax         = 32 // #140: the Auto hire's rules
)

// CodexProfileAuto (#140) is worker.hire's and a hire preset's
// codex_profile that leaves the profile to the bridge: resolved once, at
// hire, to a concrete key (CodexProfiles.Rules first, then the remaining
// limits of the profiles that may be used for anything). Never stored on a
// worker.
const CodexProfileAuto = "auto"

// CodexProfiles is the list: codex_profiles.get's and .set's ack,
// World.CodexProfiles, and flat in codex_profiles.update.
type CodexProfiles struct {
	// Profiles: the bridge's own first, then the found folders by path,
	// then the added ones in the order added. Hidden ones included.
	Profiles []CodexProfile `json:"profiles"`
	// Hire (#139): worker.hire and hire presets take codex_profile.
	Hire bool `json:"hire,omitempty"`
	// Auto (#140): they also take CodexProfileAuto, and Rules and
	// CodexProfile.Anything are the settings it follows.
	Auto bool `json:"auto,omitempty"`
	// Rules (#140): the Auto hire's, in order (the first that matches
	// wins). Always present on a bridge with Auto ([] when none).
	Rules []CodexRule `json:"rules"`
	// Share (#167): codex_profiles.share and .move_skill are there, and
	// CodexProfile.Share and Drift are sent.
	Share bool `json:"share,omitempty"`
}

// CodexRule (#140) sends an Auto hire that matches to a profile. Match is
// github.com/<owner>/* (any repo of that owner on the hire's origin),
// github.com/<owner>/<repo>, or a folder, absolute or under ~/, that the
// hire's folder is in (on whole path segments). Profile is a key; one that
// is gone, hidden or not signed in at hire is passed over, with a note.
type CodexRule struct {
	Match   string `json:"match"`
	Profile string `json:"profile"`
}

// CodexProfile is one Codex home folder.
type CodexProfile struct {
	// Key names it for good (from the folder's name: ~/.codex-work is
	// "work"); a rename does not change it. Limits.Account.Key.
	Key  string `json:"key"`
	Name string `json:"name"`
	// Path is the folder on the bridge host, absolute; Display the same
	// with ~ for the bridge user's home folder.
	Path    string `json:"path"`
	Display string `json:"display"`
	// Plan is the plan its last limits reading reported ("" unknown).
	Plan string `json:"plan"`
	// SignedIn: it has an auth.json, or a reading had a plan.
	SignedIn bool `json:"signed_in"`
	// Default is the bridge's own home (it cannot be hidden).
	Default bool `json:"default"`
	// Hidden profiles are not read and have no limits.
	Hidden bool `json:"hidden"`
	// Added: a folder the user added (it can be removed).
	Added bool `json:"added"`
	// Missing: an added folder that is not there (not read).
	Missing bool `json:"missing,omitempty"`
	// Anything (#140): "May be used for anything": an Auto hire no rule
	// decides may land on it. Off by default.
	Anything bool `json:"anything,omitempty"`
	// Share (#167): "Share setup with <default>" is on (never on the
	// default). Drift is how its setup differs from the default's now, in
	// plain words (only on a visible profile with Share on; absent:
	// nothing). Items name files, MCP servers and skills, never a value.
	Share bool         `json:"share,omitempty"`
	Drift []CodexDrift `json:"drift,omitempty"`
}

// #167: sharing a profile's setup with the default profile (docs/protocol.md
// "Sharing a profile's setup").
const (
	CmdCodexProfilesShare     = "codex_profiles.share"
	CmdCodexProfilesMoveSkill = "codex_profiles.move_skill"
)

func init() { Commands = append(Commands, CmdCodexProfilesShare, CmdCodexProfilesMoveSkill) }

// The kinds of CodexDrift.
const (
	CodexDriftLinkMissing      = "link_missing"
	CodexDriftLinkElsewhere    = "link_elsewhere"
	CodexDriftLinkReplaced     = "link_replaced"
	CodexDriftTargetMissing    = "target_missing"
	CodexDriftHooksMissing     = "hooks_missing"
	CodexDriftHooksDiffer      = "hooks_differ"
	CodexDriftSkillOnlyProfile = "skill_only_profile"
	CodexDriftSkillOnlyDefault = "skill_only_default"
)

// CodexDrift is one way a shared profile differs from the default: Name
// is the entry (config.toml, AGENTS.md, AGENTS.override.md, rules/,
// hooks.json) or the skill; Text the plain words.
type CodexDrift struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
	Text string `json:"text"`
}

// CodexShareArgs are codex_profiles.share's: Share turns sharing on (also a
// Fix) or off for the profile Key. DryRun (on only) writes nothing and
// answers the plan; Replace (on only) are the names of the plan's replace
// steps the person confirmed.
type CodexShareArgs struct {
	Key     string   `json:"key"`
	Share   *bool    `json:"share"`
	DryRun  bool     `json:"dry_run,omitempty"`
	Replace []string `json:"replace,omitempty"`
}

// CodexMoveSkillArgs are codex_profiles.move_skill's: the skill folder
// Skill in the profile Key's skills/ (the default's too) goes to
// ~/.agents/skills.
type CodexMoveSkillArgs struct {
	Key   string `json:"key"`
	Skill string `json:"skill"`
}

// What a CodexShareStep does.
const (
	CodexStepLink    = "link"
	CodexStepKeep    = "keep"
	CodexStepReplace = "replace"
	CodexStepWrite   = "write"
	CodexStepSkip    = "skip"
	CodexStepCopy    = "copy"
	CodexStepLeft    = "left"
)

// CodexShareStep is one entry of a plan or of what was done: Name as shown
// (rules/ ends in /); a replace says what is there (Was: file, folder,
// link) and the name it is backed up to.
type CodexShareStep struct {
	Name   string `json:"name"`
	Action string `json:"action"`
	Was    string `json:"was,omitempty"`
	Backup string `json:"backup,omitempty"`
}

// CodexShareAck is codex_profiles.share's and .move_skill's ack: the list
// (flat), the plan or what was done, the report in plain words (none for
// a dry run), and Failed when it stopped on an error (the report says
// where).
type CodexShareAck struct {
	CodexProfiles
	Steps  []CodexShareStep `json:"steps"`
	Report string           `json:"report,omitempty"`
	Failed bool             `json:"failed,omitempty"`
}

// CodexProfilesUpdate is the codex_profiles.update event.
type CodexProfilesUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	CodexProfiles
}

// CodexProfilesSetArgs are the args of codex_profiles.set, one change a
// command: Add or Rules alone, or Key with one of Name, Hidden, Anything
// and Remove.
type CodexProfilesSetArgs struct {
	Key    string  `json:"key,omitempty"`
	Name   *string `json:"name,omitempty"`
	Hidden *bool   `json:"hidden,omitempty"`
	// Anything (#140) turns "May be used for anything" on or off.
	Anything *bool `json:"anything,omitempty"`
	// Rules (#140) replaces the rules, in order ([] clears them).
	Rules *[]CodexRule `json:"rules,omitempty"`
	// Remove removes an added folder.
	Remove bool `json:"remove,omitempty"`
	// Add is a folder to add: an absolute path or ~/… on the bridge host.
	Add *string `json:"add,omitempty"`
}
