package proto

// #155 shared Codex server (docs/protocol.md "Shared Codex server"): when
// switched on, a new or restarted Codex worker runs Codex's terminal against
// an app-server of its own that the bridge can join as a second client. The
// switch is in the snapshot (World.CodexServer) and every change is a
// codex_server.update event (CodexServerUpdate: the fields of CodexServer
// flat in it). Each Codex worker the bridge hired says how it was launched
// (Worker.Codex).

// EvCodexServerUpdate carries the switch.
const EvCodexServerUpdate = "codex_server.update"

// Commands of the shared Codex server switch.
const (
	CmdCodexServerGet = "codex_server.get"
	CmdCodexServerSet = "codex_server.set"
)

func init() {
	Commands = append(Commands, CmdCodexServerGet, CmdCodexServerSet)
}

// CodexServer is the switch: codex_server.get's and codex_server.set's
// ack, World.CodexServer, and flat in codex_server.update.
type CodexServer struct {
	// Enabled: new Codex workers get their own app-server.
	Enabled bool `json:"enabled"`
	// Available: this bridge can launch them (it knows a private run
	// directory); without it codex_server.set refuses to switch on.
	Available bool `json:"available"`
}

// CodexServerUpdate is the codex_server.update event.
type CodexServerUpdate struct {
	T   string `json:"t"`
	Seq uint64 `json:"seq"`
	CodexServer
}

// CodexServerSetArgs are the args of codex_server.set.
type CodexServerSetArgs struct {
	Enabled *bool `json:"enabled"`
}

// Codex launch modes (WorkerCodex.Mode).
const (
	CodexModeShared = "shared"
	CodexModeLegacy = "legacy"
)

// Shared server states (WorkerCodex.Server).
const (
	CodexServerStarting = "starting"
	CodexServerRunning  = "running"
	CodexServerDown     = "down"
	CodexServerStopped  = "stopped"
)

// WorkerCodex is how a Codex worker the bridge hired was launched.
type WorkerCodex struct {
	// Mode is shared (its own app-server) or legacy (Codex's embedded
	// server, as before the switch; also a shared hire that fell back).
	Mode string `json:"mode"`
	// Server is a shared worker's app-server: starting, running, down (it
	// died: the terminal shows "Reconnecting…" and herdr still says
	// working) or stopped (the floor sleeps).
	Server string `json:"server,omitempty"`
	// Note says why a worker hired with the switch on runs legacy (an
	// unsupported Codex, a blocked .envrc, a failed start), or what last
	// went wrong with its server.
	Note string `json:"note,omitempty"`
	// Attached: the bridge has joined the worker's thread as a second
	// client (while its transcript is open).
	Attached bool `json:"attached,omitempty"`
}
