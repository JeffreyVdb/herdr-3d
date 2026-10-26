package manual

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Status is the launcher's durable identity and, when complete, exit result.
type Status struct {
	PID        int    `json:"pid"`
	StartTicks uint64 `json:"start_ticks"`
	PGID       int    `json:"pgid"`
	StartedAt  int64  `json:"started_at"`
	ExitCode   *int   `json:"exit_code,omitempty"`
	EndedAt    int64  `json:"ended_at,omitempty"`
	Error      string `json:"error,omitempty"`
}

func ReadStatus(dir string) (Status, error) {
	var s Status
	b, err := os.ReadFile(filepath.Join(dir, "status.json"))
	if err != nil {
		return s, err
	}
	err = json.Unmarshal(b, &s)
	return s, err
}

// WriteStatus publishes a complete status with an atomic rename.
func WriteStatus(dir string, s Status) (err error) {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".status-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err = f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), filepath.Join(dir, "status.json"))
}

var AskpassEnv func(dir, id string) ([]string, error)
var AskpassRewrite func(cmd string) (string, bool)
