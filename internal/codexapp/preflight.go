package codexapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"
)

// Runner runs argv in dir and returns its stdout (tests inject a fake).
type Runner func(ctx context.Context, dir string, argv ...string) ([]byte, error)

// ExecRunner runs argv with env in dir, its output capped at 1 MiB.
func ExecRunner(env []string) Runner {
	return func(ctx context.Context, dir string, argv ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		cmd.Dir, cmd.Env = dir, env
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			return out.Bytes(), fmt.Errorf("%s: %w: %.300s", argv[0], err, bytes.TrimSpace(errb.Bytes()))
		}
		if out.Len() > 1<<20 {
			return nil, fmt.Errorf("%s: output too large", argv[0])
		}
		return out.Bytes(), nil
	}
}

// ErrEnvrcBlocked means the directory's .envrc is not allowed (or denied):
// a server started there would run without its variables, and Codex would
// say nothing about it (phase 1 §4).
var ErrEnvrcBlocked = errors.New(".envrc is blocked")

// Preflight checks a shared-server launch before anything starts: the
// installed Codex is a supported version and dir's .envrc, if any, is
// allowed. codex and direnv are the executables (direnv missing: nothing
// to check).
type Preflight struct {
	Codex, Direnv string
	Run           Runner
	Timeout       time.Duration // per command (default 5 s)
}

// Check runs `codex --version` and `direnv status --json` in dir.
func (p Preflight) Check(ctx context.Context, dir string) error {
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	run := p.Run
	if run == nil {
		run = ExecRunner(os.Environ())
	}
	cctx, cancel := context.WithTimeout(ctx, timeout)
	out, err := run(cctx, os.TempDir(), p.Codex, "--version")
	cancel()
	if err != nil {
		return fmt.Errorf("%w: codex --version: %v", ErrUnsupported, err)
	}
	if err := CheckVersion(string(out)); err != nil {
		return err
	}
	if p.Direnv == "" {
		return nil
	}
	if _, err := exec.LookPath(p.Direnv); err != nil {
		return nil
	}
	cctx, cancel = context.WithTimeout(ctx, timeout)
	out, err = run(cctx, dir, p.Direnv, "status", "--json")
	cancel()
	if err != nil {
		return fmt.Errorf("direnv status: %w", err)
	}
	return EnvrcState(out)
}

// EnvrcState reads `direnv status --json`: nil without a .envrc or with an
// allowed one, ErrEnvrcBlocked when the one found is not allowed (1) or
// denied (2).
func EnvrcState(out []byte) error {
	var st struct {
		State struct {
			FoundRC *struct {
				Allowed *int   `json:"allowed"`
				Path    string `json:"path"`
			} `json:"foundRC"`
		} `json:"state"`
	}
	if err := json.Unmarshal(out, &st); err != nil {
		return fmt.Errorf("direnv status: %w", err)
	}
	rc := st.State.FoundRC
	switch {
	case rc == nil:
		return nil
	case rc.Allowed == nil:
		return fmt.Errorf("direnv status: no allowed state for %s", rc.Path)
	case *rc.Allowed != 0:
		return fmt.Errorf("%w: %s (run `direnv allow` there)", ErrEnvrcBlocked, rc.Path)
	}
	return nil
}
