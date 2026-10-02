// Package proto is herdr-world's WebSocket protocol, version 1: JSON text
// messages with a `t` type field. See docs/protocol.md.
package proto

import (
	"bytes"
	"encoding/json"
)

// Version is the protocol version this package speaks.
const Version = 1

// VersionHeader carries the bridge's build version on GET /healthz. The body
// stays "ok" so a helper from an older release still reads it as healthy.
const VersionHeader = "X-H3D-Version"

// Message types.
const (
	THello    = "hello"
	TWelcome  = "welcome"
	TSnapshot = "world.snapshot"
	TAck      = "ack"
	TError    = "error"

	EvBuildingUpsert  = "building.upsert"
	EvBuildingRemoved = "building.removed"
	EvFloorUpsert     = "floor.upsert"
	EvFloorRemoved    = "floor.removed"
	EvWorkerUpsert    = "worker.upsert"
	EvWorkerRemoved   = "worker.removed"
	EvWorkerStatus    = "worker.status"

	CmdBuildingCreate  = "building.create"
	CmdBuildingRename  = "building.rename"
	CmdBuildingDelete  = "building.delete"
	CmdBuildingReorder = "building.reorder"
	CmdFloorAssign     = "floor.assign"
	CmdFloorWake       = "floor.wake"
	CmdFloorSleep      = "floor.sleep"
	CmdFloorSettings   = "floor.settings.set"
	CmdHirePrepare     = "hire.prepare"
	CmdWorkerHire      = "worker.hire"
	CmdFirePrepare     = "worker.fire.prepare"
	CmdWorkerFire      = "worker.fire"
)

// Welcome resume modes.
const (
	ResumeSnapshot = "snapshot"
	ResumeReplay   = "replay"
)

// Error codes.
const (
	ErrBadRequest       = "bad_request"
	ErrUnknownCommand   = "unknown_command"
	ErrHelloRequired    = "hello_required"
	ErrUnsupportedProto = "unsupported_proto"
	ErrNotFound         = "not_found"
	ErrNameTaken        = "name_taken"
	ErrUnknownSession   = "unknown_session"
	ErrBusy             = "busy"          // a wake or sleep of that floor is in progress
	ErrInvalidState     = "invalid_state" // waking a running floor, sleeping an asleep one
	ErrWakeFailed       = "wake_failed"   // the server did not start or answer ping in time
	ErrSleepFailed      = "sleep_failed"  // herdr session stop failed
	ErrUnknownWorker    = "unknown_worker"
	ErrDeskTaken        = "desk_taken" // worker.hire at a held, reserved or out-of-range desk
	ErrCapacity         = "capacity"   // worker.hire above a hard worker cap
	ErrNotClean         = "not_clean"  // worker.fire deleting a dirty or unpushed worktree
	ErrHireFailed       = "hire_failed"
	ErrFireFailed       = "fire_failed"
	ErrFetchFailed      = "fetch_failed" // worker.hire into a worktree whose git fetch origin failed
	ErrTooLarge         = "too_large"    // transcript.image full over 12 MiB of base64
	// M3d logos (the /logo HTTP routes; not WebSocket commands).
	ErrLogoTooLarge    = "logo_too_large"   // over 1 MiB, or over the pixel budget
	ErrLogoUnsupported = "logo_unsupported" // not PNG, WebP or a plain SVG; animated; an SVG feature that is not rendered
	ErrLogoInvalid     = "logo_invalid"     // cannot be decoded
	ErrLogoBusy        = "logo_busy"        // the conversion found no free slot, or ran too long
	ErrInternal        = "internal"
)

// RemovedSentHome is worker.removed's reason when worker.fire removed it.
const RemovedSentHome = "sent_home"

// Where hire.prepare's choice comes from.
const (
	ChoiceFloorDefault = "floor_default"
	ChoiceLast         = "last"
	ChoiceNone         = "none"
)

// How a hire dealt with the agent's trust dialog (HireResult.Trust).
const (
	TrustNone     = "none"     // no dialog showed
	TrustAvoided  = "avoided"  // reserved
	TrustApproved = "approved" // the bridge answered it for the hire's directory
)

// worker.fire worktree choices, and what happened (FireResult.Worktree).
const (
	FireKeep          = "keep"
	FireDelete        = "delete"
	FireDeleteBranch  = "delete_branch"
	WorktreeKept      = "kept"
	WorktreeDeleted   = "deleted"
	WorktreeDelBranch = "deleted_branch"
)

// Floor transitions (Floor.Transition).
const (
	TransitionWaking   = "waking"
	TransitionSleeping = "sleeping"
)

// Worker resume states (Worker.Resume, and "none" in the floor.wake ack
// for workers that cannot resume).
const (
	ResumePending   = "pending"
	ResumeConfirmed = "confirmed"
	ResumeFallback  = "fallback"
	ResumeFailed    = "failed"
	ResumeNone      = "none"
)

// Commands lists every command a client may send.
var Commands = []string{CmdBuildingCreate, CmdBuildingRename, CmdBuildingDelete, CmdBuildingReorder, CmdFloorAssign,
	CmdFloorWake, CmdFloorSleep, CmdFloorSettings, CmdHirePrepare, CmdWorkerHire, CmdFirePrepare, CmdWorkerFire}

// Envelope is the part every message shares.
type Envelope struct {
	T     string `json:"t"`
	Seq   uint64 `json:"seq,omitempty"`
	ReqID string `json:"req_id,omitempty"`
}

// Hello is the first client message.
type Hello struct {
	T      string `json:"t"`
	Proto  int    `json:"proto"`
	Client string `json:"client,omitempty"`
	// SinceSeq asks for a replay of every event after it (the last seq the
	// client applied). Epoch must then be the welcome epoch it came from.
	SinceSeq *uint64 `json:"since_seq,omitempty"`
	Epoch    string  `json:"epoch,omitempty"`
}

// Welcome answers hello. It is followed by a world.snapshot (resume
// "snapshot") or by the replayed events up to ServerSeq (resume "replay").
type Welcome struct {
	T         string `json:"t"`
	Proto     int    `json:"proto"`
	ServerSeq uint64 `json:"server_seq"`
	Epoch     string `json:"epoch"`
	Resume    string `json:"resume"`
	Server    string `json:"server"`
}

// Snapshot is the full world as of Seq.
type Snapshot struct {
	T     string `json:"t"`
	Seq   uint64 `json:"seq"`
	World World  `json:"world"`
}

// World is the snapshot body. Buildings are in sort order and list their
// floors in floor order; Unassigned is the lot of sessions not in any
// building, by name. Floors and Workers follow the same order.
type World struct {
	Buildings  []Building `json:"buildings"`
	Unassigned []string   `json:"unassigned"`
	Floors     []Floor    `json:"floors"`
	Workers    []Worker   `json:"workers"`
	// HireOptions are the harness/model/effort choices the bridge accepts
	// (floor.settings.set default_hire, and hiring later).
	HireOptions *HireOptions `json:"hire_options,omitempty"`
	// M6 launch: Presets are the team presets, by name ignoring case.
	Presets []Preset `json:"presets"`
	// M10 limits: the latest reading of each provider (Claude, Codex) the
	// bridge has; [] before its first. nil (the key is left out) when the
	// bridge does not read limits (--no-limits): the client shows no widget.
	Limits []Limits `json:"limits,omitzero"`
	// M13 screen: whether a game shares its screen (docs/protocol.md
	// "Screen share").
	Screen *ScreenState `json:"screen,omitempty"`
	// #92 AI integration: the settings of the classification model and the
	// LLM (never a key). nil (left out) when the bridge has no AI service.
	AI *AI `json:"ai,omitempty"`
	// #90 follow-up questions: the feature's settings and state. nil (left
	// out) when the bridge has no AI service.
	Followups *Followups `json:"followups,omitempty"`
	// #98 activity: "Classify unknown commands", its settings and state.
	// nil (left out) when the bridge has no AI service.
	Activity *ActivityState `json:"activity,omitempty"`
}

// HireOptions lists what can be hired, per harness.
type HireOptions struct {
	Claude HarnessOptions `json:"claude"`
	Codex  HarnessOptions `json:"codex"`
}

// HarnessOptions are one harness's models and their common efforts.
// ExtraEfforts are additional efforts supported by each individual model.
type HarnessOptions struct {
	Models       []string            `json:"models"`
	Efforts      []string            `json:"efforts"`
	ExtraEfforts map[string][]string `json:"extra_efforts,omitempty"`
}

// Building groups floors. Floors is derived: known sessions assigned to it,
// in floor order.
type Building struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Sort   int      `json:"sort"`
	Floors []string `json:"floors"`
	// M3d logo: the hash (sha256, hex) of the building's logo PNG; absent
	// without one. The image itself is GET /logo/{id}, never in an event.
	Logo string `json:"logo,omitempty"`
}

// Floor is one herdr session.
type Floor struct {
	Session  string  `json:"session"`
	State    string  `json:"state"` // running | asleep
	Default  bool    `json:"default,omitempty"`
	Building *string `json:"building"` // null: in the unassigned lot
	Index    *int    `json:"index"`    // position in the building; null when unassigned
	Error    string  `json:"error,omitempty"`
	// Desks is how many desks the floor renders:
	// max(highest desk_index+1, min(max desks, max(6, workers+2))).
	Desks int `json:"desks"`
	// Transition is set while a wake or sleep is in progress.
	Transition string `json:"transition,omitempty"`
	// Settings are the stored settings, only the keys that are set.
	Settings *FloorSettings `json:"settings,omitempty"`
	// Suggested are bridge-derived defaults for unset settings.
	Suggested *Suggested `json:"suggested,omitempty"`
	// M6 launch: LastPreset is the preset of the floor's last successful
	// run.start (absent when none, or deleted).
	LastPreset string `json:"last_preset,omitempty"`
}

// FloorSettings are a floor's stored settings; unset keys are absent.
type FloorSettings struct {
	Repo        string       `json:"repo,omitempty"` // GitHub "owner/repo"
	Project     *Project     `json:"project,omitempty"`
	StatusField *StatusField `json:"status_field,omitempty"`
	DefaultCwd  string       `json:"default_cwd,omitempty"`
	DefaultHire *Hire        `json:"default_hire,omitempty"`
}

// Project is a GitHub Project (v2).
type Project struct {
	Owner  string `json:"owner"`
	Number int    `json:"number"`
}

// StatusField is the project's status field and its options, in order.
type StatusField struct {
	Name    string   `json:"name"`
	Options []string `json:"options"`
}

// Hire is a harness, model and effort.
type Hire struct {
	Harness string `json:"harness"`
	Model   string `json:"model"`
	Effort  string `json:"effort"`
}

// Suggested are the bridge's defaults for a floor: the most common GitHub
// repo of its workers' cwds, and the root checkout of a worker of the
// effective repo (settings.repo, else suggested.repo).
type Suggested struct {
	Repo       string `json:"repo,omitempty"`
	DefaultCwd string `json:"default_cwd,omitempty"`
}

// Worker is one herdr workspace, keyed by a bridge-owned id.
type Worker struct {
	ID           string            `json:"id"`
	Session      string            `json:"session"`
	WorkspaceID  string            `json:"workspace_id"`
	Label        string            `json:"label"`
	Cwd          string            `json:"cwd,omitempty"`
	PaneID       string            `json:"pane_id,omitempty"`
	PaneLabel    string            `json:"pane_label,omitempty"`
	AgentKind    string            `json:"agent_kind,omitempty"`
	AgentName    string            `json:"agent_name,omitempty"`
	AgentSession string            `json:"agent_session,omitempty"`
	Status       string            `json:"status"`
	Title        string            `json:"title,omitempty"`
	Tokens       map[string]string `json:"tokens,omitempty"`
	Worktree     *Worktree         `json:"worktree,omitempty"`
	Role         string            `json:"role,omitempty"`
	Run          string            `json:"run,omitempty"`
	// Name is a display name, unique among the workers of its floor; it
	// never changes while the worker keeps its desk.
	Name string `json:"name"`
	// DeskIndex is the worker's persistent desk slot on its floor.
	DeskIndex int `json:"desk_index"`
	// Harness, Model and Effort come from the h3d_harness / h3d_model /
	// h3d_effort tokens (harness falls back to agent_kind claude|codex) and
	// are remembered after the tokens are gone.
	Harness string `json:"harness,omitempty"`
	Model   string `json:"model,omitempty"`
	Effort  string `json:"effort,omitempty"`
	// StatusSince is when Status last changed, unix milliseconds (bridge
	// clock).
	StatusSince int64 `json:"status_since"`
	// Resume is set during and after a wake for workers that can resume
	// (pending, confirmed, fallback, failed); cleared on the next sleep.
	Resume string `json:"resume,omitempty"`
	// HiredAt is when the bridge hired this worker, unix milliseconds.
	HiredAt int64 `json:"hired_at,omitempty"`
	// Branch is the checked-out branch of a worker in a linked worktree.
	Branch string `json:"branch,omitempty"`
	// M5 usage: Usage is the agent session's token usage and cost estimate
	// (absent without an agent_session, or before the bridge read it).
	Usage *Usage `json:"usage,omitempty"`
	// M5 term: Question is what a blocked worker's screen asks, while it
	// is blocked and the bridge could read it.
	Question *Question `json:"question,omitempty"`
	// #57: Ask is the structured question the agent's latest turn waits on,
	// read from its transcript (whatever Status herdr reports).
	Ask *Ask `json:"ask,omitempty"`
	// #83: WrapUp is the worker's wrap-up, armed or needing you.
	WrapUp *WrapUp `json:"wrapup,omitempty"`
	// #90: Followup is the open questions of the agent's final message,
	// until they are answered, dismissed or the agent is prompted again.
	Followup *Followup `json:"followup,omitempty"`
	// #98: Activity is what the agent is doing right now: while Status is
	// working, and while idle or done only as waiting on background tasks.
	// Absent otherwise, and for harnesses other than claude and codex.
	Activity *Activity `json:"activity,omitempty"`

	// M6 runs: the worker's place in a write-code run.
	// Round is the h3d_round token, else the label's trailing |r<N>.
	Round int `json:"round,omitempty"`
	// Ticket is the h3d_ticket token, else the label's ticket field.
	Ticket string `json:"ticket,omitempty"`
	// Issue is the GitHub issue the run works on, when a repo is known.
	Issue *IssueRef `json:"issue,omitempty"`
	// M7 boards: WorkItem is Issue in the neutral form (the provider and the
	// item's opaque id), present whenever Issue is.
	WorkItem *WorkItemRef `json:"work_item,omitempty"`
	// OrchID is a freelancer's orchestrator (a worker id).
	OrchID string `json:"orch_id,omitempty"`
	// Phase and Pass are an orchestrator's h3d_phase / h3d_pass tokens,
	// remembered after the tokens are gone; OverCap is set past the
	// review-pass cap.
	Phase   string `json:"phase,omitempty"`
	Pass    *int   `json:"pass,omitempty"`
	OverCap bool   `json:"over_cap,omitempty"`
	// Report is a freelancer's report in its run directory.
	Report *RunReport `json:"report,omitempty"`
}

// M6 runs

// IssueRef is a GitHub issue.
type IssueRef struct {
	Repo   string `json:"repo"`
	Number int    `json:"number"`
}

// Report states.
const (
	ReportPending = "pending"
	ReportReady   = "ready"
	ReportInvalid = "invalid"
)

// Reviewer verdicts.
const (
	VerdictPass            = "PASS"
	VerdictChangesRequired = "CHANGES_REQUIRED"
	VerdictIncomplete      = "INCOMPLETE"
)

// RunReport is a freelancer's write-code report as the bridge read it.
type RunReport struct {
	State string `json:"state"`
	// At is the file's mtime, unix ms.
	At int64 `json:"at,omitempty"`
	// Verdict, Blockers and Issues: reviewers only.
	Verdict  string `json:"verdict,omitempty"`
	Blockers *int   `json:"blockers,omitempty"`
	Issues   *int   `json:"issues,omitempty"`
	// InputRequired is what the worker needs to go on (≤ 500 bytes).
	InputRequired *string `json:"input_required,omitempty"`
	// Summary is a coder's or researcher's summary (≤ 300 bytes).
	Summary string `json:"summary,omitempty"`
	// Error is why an invalid report is invalid.
	Error string `json:"error,omitempty"`
}

// Worktree is a worker's git worktree provenance.
type Worktree struct {
	RepoRoot     string `json:"repo_root"`
	RepoName     string `json:"repo_name,omitempty"`
	CheckoutPath string `json:"checkout_path"`
	Linked       bool   `json:"linked"`
}

// Event is every server event. Which fields are set depends on T:
//
//	building.upsert  building
//	building.removed id
//	floor.upsert     floor
//	floor.removed    session
//	worker.upsert    worker
//	worker.removed   id, session, workspace_id, reason
//	worker.status    id, session, workspace_id, status, prev_status, status_since, title
//	limits.update    the fields of Limits
//	screen.state     the fields of ScreenState
//	ai.update        the fields of AI (#92)
//	followups.update the fields of Followups (#90)
type Event struct {
	T           string    `json:"t"`
	Seq         uint64    `json:"seq"`
	Building    *Building `json:"building,omitempty"`
	Floor       *Floor    `json:"floor,omitempty"`
	Worker      *Worker   `json:"worker,omitempty"`
	ID          string    `json:"id,omitempty"`
	Session     string    `json:"session,omitempty"`
	WorkspaceID string    `json:"workspace_id,omitempty"`
	Status      string    `json:"status,omitempty"`
	PrevStatus  string    `json:"prev_status,omitempty"`
	StatusSince int64     `json:"status_since,omitempty"`
	// Title is set (possibly to "") on worker.status only.
	Title *string `json:"title,omitempty"`
	// Reason is set on worker.removed when worker.fire removed it
	// (RemovedSentHome).
	Reason string `json:"reason,omitempty"`
	// M5 usage: Usage is set on worker.usage.
	Usage *Usage `json:"usage,omitempty"`
	// #98: Activity is set on worker.activity (absent: cleared).
	Activity *Activity `json:"activity,omitempty"`
	// M6 launch: Preset is set on preset.upsert.
	Preset *Preset `json:"preset,omitempty"`
	// M10 limits: on limits.update the fields of Limits are flat in the
	// event.
	*Limits
	// M13 screen: on screen.state the fields of ScreenState are flat in the
	// event.
	*ScreenState
	// #92 AI integration: on ai.update the fields of AI are flat in the
	// event.
	*AI
	// #90 follow-up questions: on followups.update the fields of Followups
	// are flat in the event.
	*Followups
}

// Command is a client request. Args depend on T (see the *Args types).
type Command struct {
	T     string          `json:"t"`
	ReqID string          `json:"req_id"`
	Args  json.RawMessage `json:"args,omitempty"`
}

// BuildingCreateArgs are the args of building.create.
type BuildingCreateArgs struct {
	Name string `json:"name"`
}

// BuildingRenameArgs are the args of building.rename.
type BuildingRenameArgs struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// BuildingDeleteArgs are the args of building.delete.
type BuildingDeleteArgs struct {
	ID string `json:"id"`
}

// BuildingReorderArgs are the args of building.reorder: every building id,
// in the new order.
type BuildingReorderArgs struct {
	IDs []string `json:"ids"`
}

// FloorAssignArgs are the args of floor.assign. A null building moves the
// floor to the unassigned lot; a missing index appends.
type FloorAssignArgs struct {
	Session  string  `json:"session"`
	Building *string `json:"building"`
	Index    *int    `json:"index,omitempty"`
}

// FloorArgs are the args of floor.wake and floor.sleep.
type FloorArgs struct {
	Session string `json:"session"`
}

// WakeResult is the ack data of floor.wake: every worker of the floor, in
// sidebar order, with how its agent came back (ResumeNone: it had none).
type WakeResult struct {
	Workers []WorkerResume `json:"workers"`
}

// WorkerResume is one worker's resume outcome.
type WorkerResume struct {
	ID     string `json:"id"`
	Resume string `json:"resume"`
}

// FloorSettingsArgs are the args of floor.settings.set: an absent key
// leaves that setting unchanged, null clears it, a value sets it.
type FloorSettingsArgs struct {
	Session     string                `json:"session"`
	Repo        Optional[string]      `json:"repo,omitzero"`
	Project     Optional[Project]     `json:"project,omitzero"`
	StatusField Optional[StatusField] `json:"status_field,omitzero"`
	DefaultCwd  Optional[string]      `json:"default_cwd,omitzero"`
	DefaultHire Optional[Hire]        `json:"default_hire,omitzero"`
}

// HirePrepareArgs are the args of hire.prepare.
type HirePrepareArgs struct {
	Session string `json:"session"`
	Cwd     string `json:"cwd,omitempty"`
}

// HirePrepareResult is the ack data of hire.prepare: what the hire dialog
// shows.
type HirePrepareResult struct {
	Cwd          string   `json:"cwd"`
	Choice       *Hire    `json:"choice"`
	ChoiceSource string   `json:"choice_source"`
	Label        string   `json:"label"`
	Git          *HireGit `json:"git"`
	Capacity     Capacity `json:"capacity"`
}

// HireGit is the git state of a hire's cwd: the base a worktree hire
// branches from (origin/<default branch>, after a fetch).
type HireGit struct {
	RepoRoot      string `json:"repo_root"`
	DefaultBranch string `json:"default_branch"`
	BaseSHA       string `json:"base_sha"`
	BaseTime      int64  `json:"base_time"` // unix ms, commit time
	Fetched       bool   `json:"fetched"`
	FetchError    string `json:"fetch_error,omitempty"`
}

// Capacity is the worker count and caps of a floor and of the host.
type Capacity struct {
	Floor CapacityCount `json:"floor"`
	Host  CapacityCount `json:"host"`
	Load  *HostLoad     `json:"load,omitempty"`
}

// CapacityCount is a worker count with its soft (warn) and hard (refuse)
// caps.
type CapacityCount struct {
	Count int `json:"count"`
	Soft  int `json:"soft"`
	Hard  int `json:"hard"`
}

// HostLoad is the bridge host's load.
type HostLoad struct {
	Load1      float64 `json:"load1"`
	CPUs       int     `json:"cpus"`
	MemUsedPct float64 `json:"mem_used_pct"`
}

// WorkerHireArgs are the args of worker.hire. DeskIndex is required.
type WorkerHireArgs struct {
	Session   string `json:"session"`
	DeskIndex *int   `json:"desk_index"`
	Harness   string `json:"harness"`
	Model     string `json:"model"`
	Effort    string `json:"effort"`
	Label     string `json:"label,omitempty"`
	Cwd       string `json:"cwd,omitempty"`
	Worktree  bool   `json:"worktree,omitempty"`
	Prompt    string `json:"prompt,omitempty"`
}

// HireResult is the ack data of worker.hire.
type HireResult struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	Branch      string `json:"branch,omitempty"`
	BaseSHA     string `json:"base_sha,omitempty"`
	// FetchError is reserved: a worktree hire whose fetch fails is
	// refused (ErrFetchFailed) instead.
	FetchError string `json:"fetch_error,omitempty"`
	Trust      string `json:"trust"`
	// Prompted is set when a prompt was asked for: whether it was sent.
	Prompted    *bool  `json:"prompted,omitempty"`
	PromptError string `json:"prompt_error,omitempty"`
}

// WorkerArgs are the args of worker.fire.prepare.
type WorkerArgs struct {
	ID string `json:"id"`
}

// FirePrepareResult is the ack data of worker.fire.prepare: what the
// send-home dialog shows.
type FirePrepareResult struct {
	Name      string        `json:"name"`
	Label     string        `json:"label"`
	Branch    string        `json:"branch,omitempty"`
	Worktree  *FireWorktree `json:"worktree"`
	Dirty     []string      `json:"dirty"`
	Unpushed  int           `json:"unpushed"`
	CanDelete bool          `json:"can_delete"`
	// CanDeleteBranch: CanDelete, and the checkout is on the branch the
	// bridge made for this worker, whose commits are all on a remote.
	CanDeleteBranch bool   `json:"can_delete_branch"`
	Reason          string `json:"reason,omitempty"`
	CanFire         bool   `json:"can_fire"`
	FireBlocked     string `json:"fire_blocked,omitempty"`
}

// FireWorktree is the git checkout a worker works in.
type FireWorktree struct {
	Path   string `json:"path"`
	Linked bool   `json:"linked"`
}

// WorkerFireArgs are the args of worker.fire. Worktree is FireKeep
// (default), FireDelete or FireDeleteBranch.
type WorkerFireArgs struct {
	ID       string `json:"id"`
	Worktree string `json:"worktree,omitempty"`
}

// FireResult is the ack data of worker.fire.
type FireResult struct {
	Worktree string `json:"worktree"`
	// Released: the agent exited by itself (or there was none).
	Released bool   `json:"released"`
	Note     string `json:"note,omitempty"`
}

// Optional is a value that can be absent (Set false), null (Set, Value
// nil) or a value. Objects inside it must not have unknown fields.
type Optional[T any] struct {
	Set   bool
	Value *T
}

// Some is a set Optional.
func Some[T any](v T) Optional[T] { return Optional[T]{Set: true, Value: &v} }

// Null is a cleared Optional.
func Null[T any]() Optional[T] { return Optional[T]{Set: true} }

// IsZero reports an absent value (for omitzero).
func (o Optional[T]) IsZero() bool { return !o.Set }

// MarshalJSON writes the value, or null.
func (o Optional[T]) MarshalJSON() ([]byte, error) {
	if o.Value == nil {
		return []byte("null"), nil
	}
	return json.Marshal(*o.Value)
}

// UnmarshalJSON reads null or a value, refusing unknown object fields.
func (o *Optional[T]) UnmarshalJSON(b []byte) error {
	o.Set, o.Value = true, nil
	if string(bytes.TrimSpace(b)) == "null" {
		return nil
	}
	var v T
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(&v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// Ack answers a successful command.
type Ack struct {
	T     string `json:"t"`
	ReqID string `json:"req_id"`
	Data  any    `json:"data,omitempty"`
}

// Error answers a failed command or a bad message.
type Error struct {
	T       string `json:"t"`
	ReqID   string `json:"req_id,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// M5 usage: the Changes panel (worker.changes) and usage and cost (the
// worker's usage, worker.usage).

// CmdWorkerChanges reads a worker's git changes (read-only).
const CmdWorkerChanges = "worker.changes"

// EvWorkerUsage carries a worker's new usage (id, session, usage).
const EvWorkerUsage = "worker.usage"

// Error codes of worker.changes.
const (
	ErrChangesFailed = "changes_failed" // a git call failed or the 10 s deadline passed
	ErrNotARepo      = "not_a_repo"     // the worker's cwd is not in a git work tree
)

// How a usage's cost was priced (Usage.Priced).
const (
	PricedKnown        = "known"
	PricedUnknownModel = "unknown_model" // priced as the most expensive known model
	PricedNone         = "none"          // no model seen
)

func init() { Commands = append(Commands, CmdWorkerChanges) }

// WorkerChanges is the ack data of worker.changes: the worker's git state
// against its base, from read-only git in its cwd.
type WorkerChanges struct {
	Cwd string `json:"cwd"`
	// Branch is the checked-out branch, null when HEAD is detached.
	Branch *string `json:"branch"`
	// Head is HEAD's commit ("" on an unborn branch).
	Head string `json:"head"`
	// Upstream is the branch's upstream (null: none); Ahead and Behind
	// count commits against it.
	Upstream *string `json:"upstream"`
	Ahead    int     `json:"ahead"`
	Behind   int     `json:"behind"`
	// Base is the merge-base with origin/<default branch>, null when there
	// is no such ref (the diff is then against HEAD).
	Base  *ChangesBase  `json:"base"`
	Files []ChangedFile `json:"files"`
	// Stat totals git diff --stat <base> (tracked files; not untracked ones).
	Stat ChangesStat `json:"stat"`
	// Diff is the unified diff, whole files in Files order up to 256 KiB;
	// Omitted lists the files left out, DiffBytes is the uncapped size.
	Diff      string   `json:"diff"`
	DiffBytes int64    `json:"diff_bytes"`
	Truncated bool     `json:"truncated"`
	Omitted   []string `json:"omitted"`
}

// ChangesBase is the commit a worker's changes are diffed against.
type ChangesBase struct {
	Ref string `json:"ref"` // origin/<default branch>
	SHA string `json:"sha"` // its merge-base with HEAD
}

// ChangedFile is one changed path. Index and Worktree are git status's X
// and Y ("." unchanged), empty for an untracked file.
type ChangedFile struct {
	Path       string `json:"path"`
	OrigPath   string `json:"orig_path,omitempty"`
	Index      string `json:"index,omitempty"`
	Worktree   string `json:"worktree,omitempty"`
	Untracked  bool   `json:"untracked,omitempty"`
	Insertions int    `json:"insertions"`
	Deletions  int    `json:"deletions"`
	Binary     bool   `json:"binary"`
}

// ChangesStat is git diff --stat's summary line.
type ChangesStat struct {
	Files      int `json:"files"`
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
}

// Usage is a worker's agent session usage: token counts summed over the
// session and its subagents, and an API-equivalent cost estimate.
type Usage struct {
	// Tokens is the headline count: Input + Output + CacheWrite (cache
	// reads, the same context read again every turn, are not counted).
	Tokens     int64 `json:"tokens"`
	Input      int64 `json:"input"` // uncached input
	Output     int64 `json:"output"`
	CacheWrite int64 `json:"cache_write"`
	CacheRead  int64 `json:"cache_read"`
	// CostUSDEst is an estimate in USD; Priced says how it was priced.
	CostUSDEst float64 `json:"cost_usd_est"`
	Priced     string  `json:"priced"`
	// Model is the model the transcript reports (last seen).
	Model string `json:"model,omitempty"`
	// ContextPct is the share of the context window in use, 0–100 with one
	// decimal, null when unknown; ContextWindow is the window used (0:
	// unknown).
	ContextPct    *float64 `json:"context_pct"`
	ContextWindow int64    `json:"context_window"`
	// UpdatedAt is when the bridge saw it change, unix ms.
	UpdatedAt int64 `json:"updated_at"`
}
