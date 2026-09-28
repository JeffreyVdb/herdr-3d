// Package proto is herdr-world's WebSocket protocol, version 1: JSON text
// messages with a `t` type field. See docs/protocol.md.
package proto

import "encoding/json"

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
	ErrInternal         = "internal"
)

// Commands lists every command a client may send.
var Commands = []string{CmdBuildingCreate, CmdBuildingRename, CmdBuildingDelete, CmdBuildingReorder, CmdFloorAssign}

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
//	worker.status    id, session, workspace_id, status, prev_status
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
