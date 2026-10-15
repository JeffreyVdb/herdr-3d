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
	CmdFloorHide   = "floor.hide"
)

func init() {
	Commands = append(Commands, CmdFloorCreate, CmdFloorRename, CmdFloorDelete, CmdFloorHide)
}

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
// MoveWorkers it is refused while the floor has workers; with it, they move
// to the base session's own floor first.
type FloorDeleteArgs struct {
	Floor       string `json:"floor"`
	MoveWorkers bool   `json:"move_workers,omitempty"`
}

// FloorHideArgs are floor.hide's args: any floor (decision 2: a base
// session's floor once its workers are on virtual floors). The bridge only
// stores and broadcasts Floor.hidden; a client still shows a hidden floor
// that has workers.
type FloorHideArgs struct {
	Floor  string `json:"floor"`
	Hidden bool   `json:"hidden"`
}
