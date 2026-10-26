package proto

const (
	CmdManualProcessStart   = "manual_process.start"
	CmdManualProcessStop    = "manual_process.stop"
	CmdManualProcessDismiss = "manual_process.dismiss"
	EvManualProcessUpsert   = "manual_process.upsert"
	EvManualProcessRemoved  = "manual_process.removed"
)

func init() {
	Commands = append(Commands, CmdManualProcessStart, CmdManualProcessStop, CmdManualProcessDismiss)
}

type ManualSource struct {
	Kind  string `json:"kind"`
	Key   string `json:"key,omitempty"`
	Index int    `json:"index,omitempty"`
}
type ManualCredential struct {
	Request   string `json:"request"`
	Prompt    string `json:"prompt"`
	User      string `json:"user"`
	Attempt   int    `json:"attempt"`
	ExpiresAt int64  `json:"expires_at"`
}
type ManualEffect struct {
	Kind           string `json:"kind"`
	Endpoint       string `json:"endpoint"`
	CleanupCommand string `json:"cleanup_command"`
	State          string `json:"state"`
}
type ManualProcess struct {
	ID          string            `json:"id"`
	Op          string            `json:"op"`
	Worker      string            `json:"worker"`
	WorkerName  string            `json:"worker_name"`
	Floor       string            `json:"floor"`
	Session     string            `json:"session"`
	WorkspaceID string            `json:"workspace_id"`
	TabID       string            `json:"tab_id"`
	PaneID      string            `json:"pane_id"`
	Host        string            `json:"host"`
	Cwd         string            `json:"cwd"`
	Command     string            `json:"command"`
	Launched    string            `json:"launched,omitempty"`
	Title       string            `json:"title"`
	Source      ManualSource      `json:"source"`
	State       string            `json:"state"`
	ExitCode    *int              `json:"exit_code,omitempty"`
	Error       string            `json:"error,omitempty"`
	Cleanup     string            `json:"cleanup"`
	CleanupNote string            `json:"cleanup_note,omitempty"`
	Effects     []ManualEffect    `json:"effects,omitempty"`
	Credential  *ManualCredential `json:"credential,omitempty"`
	CreatedAt   int64             `json:"created_at"`
	StartedAt   int64             `json:"started_at"`
	EndedAt     int64             `json:"ended_at"`
}
