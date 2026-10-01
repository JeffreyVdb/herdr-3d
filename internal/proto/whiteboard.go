package proto

// M13 whiteboard (#15): one Excalidraw board per floor. The scene, its image
// files and the PNG render travel over HTTP (/whiteboard/{floor}/…, a
// message is capped at 256 KiB); the WebSocket carries the state, the
// commands without bytes and whiteboard.updated. docs/protocol.md "Whiteboard".

// EvWhiteboardUpdated says a floor's board has a new version (the fields of
// WhiteboardState flat in the event).
const EvWhiteboardUpdated = "whiteboard.updated"

// Whiteboard commands.
const (
	CmdWhiteboardGet   = "whiteboard.get"
	CmdWhiteboardClear = "whiteboard.clear"
	CmdWhiteboardPin   = "whiteboard.pin"
	// CmdDropsList lists the newest files in Drop Zone's data directory.
	CmdDropsList = "drops.list"
)

func init() {
	Commands = append(Commands, CmdWhiteboardGet, CmdWhiteboardClear, CmdWhiteboardPin, CmdDropsList)
}

// Whiteboard error codes (the HTTP routes answer them too).
const (
	ErrWhiteboardConflict    = "whiteboard_conflict"      // a save on a version that is not the current one
	ErrWhiteboardInvalid     = "whiteboard_invalid"       // a scene, element or note that is not well-formed
	ErrWhiteboardTooLarge    = "whiteboard_too_large"     // over a cap (scene, elements, file, floor's files, render)
	ErrWhiteboardUnsupported = "whiteboard_unsupported"   // not a PNG, JPEG, GIF or WebP (a render: not a PNG)
	ErrWhiteboardHash        = "whiteboard_hash_mismatch" // a file whose id is not the sha256 of its bytes
	ErrWhiteboardMissingFile = "whiteboard_missing_file"  // a live image whose file was not uploaded first
	ErrDropsUnavailable      = "drops_unavailable"        // no Drop Zone data directory, or it cannot be read
)

// WhiteboardArgs are the args of whiteboard.get.
type WhiteboardArgs struct {
	Floor string `json:"floor"`
}

// WhiteboardClearArgs are the args of whiteboard.clear; Confirm must be true.
type WhiteboardClearArgs struct {
	Floor   string `json:"floor"`
	Confirm bool   `json:"confirm"`
	Author  string `json:"author,omitempty"`
}

// WhiteboardPinArgs are the args of whiteboard.pin: a note by Author (an
// image is pinned over HTTP, POST /whiteboard/{floor}/pin). RequestID makes
// a retry pin once.
type WhiteboardPinArgs struct {
	Floor     string `json:"floor"`
	Author    string `json:"author"`
	Note      string `json:"note"`
	RequestID string `json:"request_id,omitempty"`
}

// WhiteboardState is a floor's board without its content: the ack of
// whiteboard.get and whiteboard.clear, and whiteboard.updated.
type WhiteboardState struct {
	Floor   string `json:"floor"`
	Version int64  `json:"version"` // 0: never saved
	Author  string `json:"author"`
	At      int64  `json:"at"` // unix ms
	// RenderVersion is the version render.png shows; Render false: there is
	// none (an empty or cleared board). Stale: the render is behind Version
	// (agents pinned since), and StalePins lists what it does not show yet.
	RenderVersion int64           `json:"render_version"`
	Render        bool            `json:"render"`
	Stale         bool            `json:"stale"`
	StalePins     []WhiteboardPin `json:"stale_pins"`
}

// WhiteboardPin is one agent pin the render does not show yet.
type WhiteboardPin struct {
	ID      string `json:"id"`   // element id
	Kind    string `json:"kind"` // image | note
	Author  string `json:"author"`
	Note    string `json:"note,omitempty"`
	File    string `json:"file,omitempty"`
	Version int64  `json:"version"`
	At      int64  `json:"at"`
}

// WhiteboardUpdated is the whiteboard.updated event.
type WhiteboardUpdated struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	WhiteboardState
}

// WhiteboardPinResult is the ack of whiteboard.pin (and of the HTTP pin).
type WhiteboardPinResult struct {
	WhiteboardState
	Elements []string `json:"elements"` // the ids of the elements pinned
	Repeated bool     `json:"repeated,omitempty"`
}

// DropsListArgs are the args of drops.list: Limit 1–50 (default 20).
type DropsListArgs struct {
	Limit int `json:"limit,omitempty"`
}

// DropsList is the ack of drops.list.
type DropsList struct {
	Drops []Drop `json:"drops"`
}

// Drop is one file in Drop Zone's data directory, newest first. Image says
// it can be pinned (its bytes: GET /drops/file?path=…, a thumbnail with
// &thumb=1); Reason says why not (not_image, too_large).
type Drop struct {
	Path   string `json:"path"`
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"`
	Mime   string `json:"mime"`
	Image  bool   `json:"image"`
	Reason string `json:"reason,omitempty"`
}
