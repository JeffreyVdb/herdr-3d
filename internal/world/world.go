// Package world turns what herdr shows (live snapshots, stopped sessions'
// session.json) into floor and worker observations, and decides which
// bridge-owned worker identity each observed workspace is.
package world

import (
	"regexp"
	"strings"
	"sync/atomic"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Floor states.
const (
	Running = "running"
	Asleep  = "asleep"
)

// Update is what watchers send to the hub: FloorObs, FloorGone,
// AgentDetected or Listed.
type Update interface{ isUpdate() }

// FloorObs is a complete observation of one herdr session.
type FloorObs struct {
	Session string
	Default bool
	Running bool
	// Gen orders observations of one session: the hub ignores an
	// observation older than the last one it applied. All observations from
	// one source instance (a watcher connection, one asleep read) share it.
	Gen uint64
	// Fresh means the source cannot vouch that nothing was missed since the
	// previous observation (bridge start, reconnect after EOF, a session that
	// ran unseen), so worker identities are reconciled from scratch.
	Fresh bool
	// KeepWorkers updates only the floor state and error; workers stay as
	// they are (used when a running session cannot be snapshotted).
	KeepWorkers bool
	// Err is shown on the floor, e.g. an unreadable session.json.
	Err     string
	Workers []WorkerObs
	// Socket is the session's herdr socket path.
	Socket string
}

// FloorGone means the session no longer exists in herdr.
type FloorGone struct {
	Session string
	Gen     uint64
}

// AgentDetected is herdr's pane_agent_detected event of a running
// session: an agent was detected in a pane (Agent set), or it went away
// (Agent empty: herdr 0.9 sends that when a detected agent process
// exits) or released the pane.
type AgentDetected struct {
	Session     string
	WorkspaceID string
	PaneID      string
	Agent       string
	Released    bool
}

// Listed is the herdr sessions discovery last listed (those it may watch),
// sent after their observations of that round and whenever the list
// changes (#62: a floor whose session is not listed is gone; until the first
// list the bridge does not know).
type Listed struct {
	Sessions []string
}

func (FloorObs) isUpdate()      {}
func (FloorGone) isUpdate()     {}
func (AgentDetected) isUpdate() {}
func (Listed) isUpdate()        {}

var gen atomic.Uint64

// NextGen returns a new, increasing observation generation.
func NextGen() uint64 { return gen.Add(1) }

// WorkerObs is one workspace as observed, before identity is assigned.
type WorkerObs struct {
	WorkspaceID string
	Label       string
	// Cwd is the primary pane's working directory (display).
	Cwd string
	// IdentityCwd is the workspace's identity directory, used for weak
	// identity matching: session.json identity_cwd when asleep, the
	// worktree checkout (else the primary pane cwd) when running.
	IdentityCwd  string
	PaneID       string // primary pane: the first agent pane, else the first pane
	PaneLabel    string
	AgentKind    string
	AgentName    string
	AgentSession string // native agent session id (agent_session.value)
	Status       string // herdr agent status of the primary pane
	Title        string
	Tokens       map[string]string // h3d_* workspace tokens only
	Worktree     *Worktree
	Markers      []string // pane labels of the form h3d-<hex>
	Role         string
	Run          string
	// Harness, Model and Effort as far as this observation shows them
	// (see HarnessOf); empty when unknown.
	Harness string
	Model   string
	Effort  string
	// M6 runs: RunInfo is the rest of its write-code run details.
	RunInfo Run
}

// Worktree is a workspace's git worktree provenance.
type Worktree = proto.Worktree

// Agent statuses herdr reports.
const (
	StatusUnknown = "unknown"
)

var (
	labelRole = regexp.MustCompile(`^(ORCH|CODE|REVIEW|UX|GROUND)\|(.*)$`)
	markerRe  = regexp.MustCompile(`^h3d-([0-9a-f]{6,32})$`)
)

// TokenPrefix marks write-code / herdr-3d workspace tokens.
const TokenPrefix = "h3d_"

// RoleRun derives a worker's role and run from its h3d_* tokens, falling
// back to the write-code label convention `ROLE|descr|…`. From a label the
// run is the descriptor segment (e.g. `bridge-ro` of `CODE|bridge-ro|2|r1`).
func RoleRun(label string, tokens map[string]string) (role, run string) {
	role, run = tokens["h3d_role"], tokens["h3d_run"]
	if m := labelRole.FindStringSubmatch(label); m != nil {
		if role == "" {
			role = strings.ToLower(m[1])
		}
		if run == "" {
			descr, _, _ := strings.Cut(m[2], "|")
			run = descr
		}
	}
	return role, run
}

// Harnesses the bridge recognises from a pane's agent kind.
const (
	HarnessClaude = "claude"
	HarnessCodex  = "codex"
)

// HarnessOf returns the harness, model and effort a workspace shows: the
// h3d_harness / h3d_model / h3d_effort tokens, the harness falling back to
// the agent kind when that is claude or codex.
func HarnessOf(tokens map[string]string, agentKind string) (harness, model, effort string) {
	harness, model, effort = tokens["h3d_harness"], tokens["h3d_model"], tokens["h3d_effort"]
	if harness == "" && (agentKind == HarnessClaude || agentKind == HarnessCodex) {
		harness = agentKind
	}
	return harness, model, effort
}

// IsMarker reports whether a pane label is an identity marker h3d-<hex>.
func IsMarker(label string) bool { return markerRe.MatchString(label) }

// markerHex returns the hex part of a marker label.
func markerHex(label string) string {
	if m := markerRe.FindStringSubmatch(label); m != nil {
		return m[1]
	}
	return ""
}

func h3dTokens(tokens map[string]string) map[string]string {
	var out map[string]string
	for k, v := range tokens {
		if strings.HasPrefix(k, TokenPrefix) {
			if out == nil {
				out = map[string]string{}
			}
			out[k] = v
		}
	}
	return out
}

// HasAgent reports whether an agent runs (or is saved) in the workspace's
// primary pane.
func (w WorkerObs) HasAgent() bool {
	return w.AgentKind != "" || w.AgentName != "" || w.AgentSession != ""
}

// IsMainCheckout reports whether the workspace is a repository's main
// checkout (not a linked worktree).
func (w WorkerObs) IsMainCheckout() bool {
	return w.Worktree != nil && !w.Worktree.Linked && w.Worktree.RepoRoot != ""
}

// IsLinked reports whether the workspace is a linked worktree of a
// repository.
func (w WorkerObs) IsLinked() bool {
	return w.Worktree != nil && w.Worktree.Linked && w.Worktree.RepoRoot != ""
}

// HiddenMainCheckouts picks the workspaces that are not workers: the main
// checkout of a repository with no agent in it while a linked worktree of
// that repository is open on the floor. herdr opens one with the first
// worktree of a repository (its worktree group needs it as the primary
// workspace); it is only a shell, so the game does not show it. holdRepos
// are repositories to treat as having a linked worktree open (one that is
// being made or sent home), exempt workspaces are never hidden (a hire's
// own). The rule is derived from the observation alone: an agent in the
// workspace, or the last linked worktree gone, makes it a worker again.
func HiddenMainCheckouts(obs []WorkerObs, holdRepos, exempt map[string]bool) map[string]bool {
	linked := map[string]bool{}
	for _, w := range obs {
		if w.IsLinked() {
			linked[w.Worktree.RepoRoot] = true
		}
	}
	var hidden map[string]bool
	for _, w := range obs {
		if !w.IsMainCheckout() || w.HasAgent() || exempt[w.WorkspaceID] {
			continue
		}
		if repo := w.Worktree.RepoRoot; linked[repo] || holdRepos[repo] {
			if hidden == nil {
				hidden = map[string]bool{}
			}
			hidden[w.WorkspaceID] = true
		}
	}
	return hidden
}
