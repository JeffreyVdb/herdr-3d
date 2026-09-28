// Package proto is herdr-world's WebSocket protocol, version 1: JSON text
// messages with a `t` type field. See docs/protocol.md.
package proto

import (
	"bytes"
	"encoding/json"
)

// Version is the protocol version this package speaks.
const Version = 1

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
	ErrInternal         = "internal"
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
	CmdFloorWake, CmdFloorSleep, CmdFloorSettings}

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
}

// HireOptions lists what can be hired, per harness.
type HireOptions struct {
	Claude HarnessOptions `json:"claude"`
	Codex  HarnessOptions `json:"codex"`
}

// HarnessOptions are one harness's models and efforts. ExtraEfforts are
// efforts only some models take.
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
//	worker.removed   id, session, workspace_id
//	worker.status    id, session, workspace_id, status, prev_status, status_since, title
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
