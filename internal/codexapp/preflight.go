package codexapp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Runner runs argv in dir and returns its stdout (tests inject a fake).
type Runner func(ctx context.Context, dir string, argv ...string) ([]byte, error)

// stderrKept bounds the stderr an ExecError keeps (a mise diagnostic is a
// dozen lines).
const stderrKept = 4 << 10

// ExecError is a command that ran and failed: its name, the exec error and
// its stderr (trimmed, at most stderrKept bytes). Its text is
// "name: err: first 300 bytes of stderr", as it always was.
type ExecError struct {
	Name   string
	Err    error
	Stderr string
}

func (e *ExecError) Error() string { return fmt.Sprintf("%s: %v: %.300s", e.Name, e.Err, e.Stderr) }
func (e *ExecError) Unwrap() error { return e.Err }

// capped keeps the first stderrKept bytes written to it and takes the rest.
type capped struct{ buf bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := stderrKept - c.buf.Len(); room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// ExecRunner runs argv with env in dir, its output capped at 1 MiB. A
// failure is an *ExecError.
func ExecRunner(env []string) Runner {
	return func(ctx context.Context, dir string, argv ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		cmd.Dir, cmd.Env = dir, env
		var out bytes.Buffer
		var errb capped
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			return out.Bytes(), &ExecError{Name: argv[0], Err: err, Stderr: strings.TrimSpace(errb.buf.String())}
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

// DirenvUnselectedError means direnv is a mise shim that has no version
// selected for Dir, so it could not say whether the .envrc is allowed. Its
// text is one line for the worker's note; Detail is mise's own diagnostic
// (the exec error's stderr), for the bridge's log.
type DirenvUnselectedError struct {
	Dir, Detail string
	Err         error
}

func (e *DirenvUnselectedError) Error() string {
	return "direnv is installed through mise but has no version selected for " + e.Dir
}
func (e *DirenvUnselectedError) Unwrap() error { return e.Err }

// unselected reports whether err is mise saying a shim has no active version
// ("No version is set for shim: direnv", `mise which`'s "… is not currently
// active").
func unselected(err error) (string, bool) {
	var ee *ExecError
	if !errors.As(err, &ee) {
		return "", false
	}
	return ee.Stderr, strings.Contains(ee.Stderr, "No version is set for shim: direnv") ||
		strings.Contains(ee.Stderr, "is not currently active")
}

// Preflight checks a shared-server launch before anything starts: the
// installed Codex is a supported version and dir's .envrc, if any, is
// allowed. codex and direnv are the executables (direnv missing: nothing
// to check).
type Preflight struct {
	Codex, Direnv string
	Run           Runner
	VersionPolicy VersionPolicy
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
	if err := p.VersionPolicy.CheckVersion(string(out)); err != nil {
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
		if detail, ok := unselected(err); ok {
			return &DirenvUnselectedError{Dir: dir, Detail: detail, Err: err}
		}
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
