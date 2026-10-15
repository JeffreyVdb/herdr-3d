package proto

// #58 New herdr session (docs/protocol.md "New herdr sessions"): the Add
// floor dialog's "New herdr session" starts a herdr server under a new
// name. The ack comes once the new floor is in the world (its floor.upsert
// went out first), so the client can assign it to a building at once.

// CmdSessionCreate creates a herdr session (and with it a floor).
const CmdSessionCreate = "session.create"

func init() { Commands = append(Commands, CmdSessionCreate) }

// SessionCreateArgs are session.create's arguments: the new session's name
// (^[a-z0-9_-]+$, no leading "-", not "default", within the host's length
// cap, and free: no herdr session, session folder or server unit by it).
type SessionCreateArgs struct {
	Name string `json:"name"`
}

// SessionCreated is session.create's ack: the new floor's session.
type SessionCreated struct {
	Session string `json:"session"`
}

// ErrSessionCreateFailed: herdr was asked to start the session, but its
// floor did not come up in time (the message says why; whatever the call
// created is stopped and removed again).
const ErrSessionCreateFailed = "session_create_failed"
