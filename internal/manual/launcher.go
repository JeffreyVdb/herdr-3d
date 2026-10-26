package manual

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// LaunchConfig contains the resolved policy shell and non-secret environment additions.
type LaunchConfig struct {
	Shell   string   `json:"shell"`
	Command string   `json:"command,omitempty"`
	Env     []string `json:"env,omitempty"`
}

// Launch runs the reviewed command in the terminal's existing foreground group.
func Launch(dir string, out io.Writer) error {
	command, err := os.ReadFile(filepath.Join(dir, "command"))
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(dir, "launch.json"))
	if err != nil {
		return err
	}
	var cfg LaunchConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	if !filepath.IsAbs(cfg.Shell) {
		return fmt.Errorf("invalid shell")
	}
	ticks, err := StartTicks(os.Getpid())
	if err != nil {
		return err
	}
	pgid, err := syscall.Getpgid(0)
	if err != nil {
		return err
	}
	status := Status{PID: os.Getpid(), StartTicks: ticks, PGID: pgid, StartedAt: time.Now().UnixMilli()}
	if err := WriteStatus(dir, status); err != nil {
		return err
	}
	if cfg.Command != "" {
		command = []byte(cfg.Command)
	}
	cmd := exec.Command(cfg.Shell, "-c", string(command))
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, out, os.Stderr
	cmd.Env = append(os.Environ(), cfg.Env...)
	cmd.Env = append(cmd.Env, "H3D_MANUAL_PROCESS="+filepath.Base(dir))
	err = cmd.Run()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return err
		}
		code = exit.ExitCode()
		if code < 0 {
			code = 128
		}
	}
	status.ExitCode, status.EndedAt = &code, time.Now().UnixMilli()
	if err := WriteStatus(dir, status); err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "\x1b[2m[exited %d]\x1b[0m\n", code)
	return err
}
