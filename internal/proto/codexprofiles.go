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
)

// CodexProfiles is the list: codex_profiles.get's and .set's ack,
// World.CodexProfiles, and flat in codex_profiles.update.
type CodexProfiles struct {
	// Profiles: the bridge's own first, then the found folders by path,
	// then the added ones in the order added. Hidden ones included.
	Profiles []CodexProfile `json:"profiles"`
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
}

// CodexProfilesUpdate is the codex_profiles.update event.
type CodexProfilesUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	CodexProfiles
}

// CodexProfilesSetArgs are the args of codex_profiles.set: either Add
// alone, or Key with Name and/or Hidden, or Key with Remove.
type CodexProfilesSetArgs struct {
	Key    string  `json:"key,omitempty"`
	Name   *string `json:"name,omitempty"`
	Hidden *bool   `json:"hidden,omitempty"`
	// Remove removes an added folder.
	Remove bool `json:"remove,omitempty"`
	// Add is a folder to add: an absolute path or ~/… on the bridge host.
	Add *string `json:"add,omitempty"`
}
