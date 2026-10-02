package proto

// #106 the inbox's dismissals (docs/protocol.md "Inbox"): a finished worker's
// row hidden until its next working → done. The map is World.InboxDismissed
// (worker id → the status_since of the done episode hidden); a dismissal is
// an inbox.dismissed event (id, status_since) to every client.

// EvInboxDismissed carries a new dismissal: id and status_since.
const EvInboxDismissed = "inbox.dismissed"

// CmdInboxDismiss dismisses a done worker's row.
const CmdInboxDismiss = "inbox.dismiss"

func init() { Commands = append(Commands, CmdInboxDismiss) }

// InboxDismissArgs are the args of inbox.dismiss.
type InboxDismissArgs struct {
	ID          string `json:"id"`
	StatusSince int64  `json:"status_since"`
}

// InboxDismissResult is inbox.dismiss's ack: whether the dismissal was
// recorded (false: the worker's present status_since is another, or it is
// not done; nothing changed).
type InboxDismissResult struct {
	Dismissed bool `json:"dismissed"`
}
