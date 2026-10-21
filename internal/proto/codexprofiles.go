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
	// Runs (#167): team preset roles and run.prepare / run.start's orch
	// take codex_profile too (Auto included).
	Runs bool `json:"runs,omitempty"`
	// Rules (#140): the Auto hire's, in order (the first that matches
	// wins). Always present on a bridge with Auto ([] when none).
	Rules []CodexRule `json:"rules"`
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
