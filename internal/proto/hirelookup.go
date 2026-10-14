package proto

// #39 completion before a hire (docs/protocol.md "Completion before a
// hire"): the Hire worker and Start run dialogs complete `/` skills, `@`
// files and `@r:` repositories with no worker yet, so the lookups are keyed
// by the floor, the harness and the folder the hire would get instead of a
// worker id. They answer what worker.commands, worker.files and worker.repos
// answer (WorkerCommands, WorkerFiles, WorkerRepos), from the same caches.

// Commands of the feature.
const (
	CmdHireCommands = "hire.commands"
	CmdHireFiles    = "hire.files"
	CmdHireRepos    = "hire.repos"
)

func init() { Commands = append(Commands, CmdHireCommands, CmdHireFiles, CmdHireRepos) }

// HireCommandsArgs are the args of hire.commands: the skills and commands
// harness offers in the folder a hire on session would get (Cwd, else the
// floor's default, as worker.hire); with Worktree, in that folder's
// repository root (the worktree does not exist yet).
type HireCommandsArgs struct {
	Session  string `json:"session"`
	Harness  string `json:"harness"`
	Cwd      string `json:"cwd,omitempty"`
	Worktree bool   `json:"worktree,omitempty"`
}

// HireFilesArgs are the args of hire.files: the files of the folder a hire
// on session would get (as HireCommandsArgs), ranked against Query with
// worker.files's limits.
type HireFilesArgs struct {
	Session  string `json:"session"`
	Cwd      string `json:"cwd,omitempty"`
	Worktree bool   `json:"worktree,omitempty"`
	Query    string `json:"query"`
	Limit    int    `json:"limit,omitempty"`
}

// HireReposArgs are the args of hire.repos: the repositories of the other
// floors, scoped as worker.repos is for a worker of Session.
type HireReposArgs struct {
	Session string `json:"session"`
}
