package proto

// #58 virtual floors (docs/protocol.md "Virtual floors"): user-defined
// floors on an existing base herdr session, with their own name, desks,
// settings, board and whiteboard. Every definition change goes out to every
// client as floor.upsert / floor.removed.

// Virtual floor commands.
const (
	CmdFloorCreate = "floor.create"
	CmdFloorRename = "floor.rename"
	CmdFloorDelete = "floor.delete"
)

func init() { Commands = append(Commands, CmdFloorCreate, CmdFloorRename, CmdFloorDelete) }

// FloorCreateArgs are floor.create's args: the display name (trimmed, 1-64
// bytes, no control characters) and the base session, a discovered session
// the bridge watches (--sessions).
type FloorCreateArgs struct {
	Name        string `json:"name"`
	BaseSession string `json:"base_session"`
}

// FloorRenameArgs are floor.rename's args (virtual floors only).
type FloorRenameArgs struct {
	Floor string `json:"floor"`
	Name  string `json:"name"`
}

// FloorDeleteArgs are floor.delete's args (virtual floors only). Without
// MoveWorkers it is refused while the floor has workers.
type FloorDeleteArgs struct {
	Floor       string `json:"floor"`
	MoveWorkers bool   `json:"move_workers,omitempty"`
}
