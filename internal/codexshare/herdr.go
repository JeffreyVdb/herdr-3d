package codexshare

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// SessionPrefix starts every Herdr session the fixture creates. Herdr runs
// only against such a session: it never names another one.
const SessionPrefix = "h3d-it-154-"

// Herdr is a throwaway named Herdr session the fixture owns: a headless
// `herdr --session h3d-it-154-<rand> server` and the CLI aimed only at it.
type Herdr struct {
	Bin  string
	Name string
	Env  []string // the server's and the CLI's environment

	dir    string
	srv    *exec.Cmd
	exited chan struct{}
}

// StartHerdr starts a fresh session whose panes run fish (as herdr-3d's
// supervised server does) with env (CleanEnv applied, then set). Its log
// goes to dir. Pass the fixture's CODEX_HOME in set: Herdr restores a
// workspace without its --env, so a restored pane only has the server's.
func StartHerdr(ctx context.Context, dir string, env []string, set ...string) (*Herdr, error) {
	bin, err := exec.LookPath("herdr")
	if err != nil {
		return nil, err
	}
	var rnd [4]byte
	_, _ = rand.Read(rnd[:])
	h := &Herdr{Bin: bin, Name: SessionPrefix + hex.EncodeToString(rnd[:]), Env: CleanEnv(env, append([]string{"SHELL=/bin/fish"}, set...)...), dir: dir}
	return h, h.start(ctx)
}

// start runs the session's server and waits until it answers.
func (h *Herdr) start(ctx context.Context) error {
	logf, err := os.OpenFile(filepath.Join(h.dir, "herdr-server.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	h.exited = make(chan struct{})
	h.srv = exec.Command(h.Bin, "--session", h.Name, "server")
	h.srv.Env, h.srv.Dir = h.Env, h.dir
	h.srv.Stdout, h.srv.Stderr = logf, logf
	h.srv.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := h.srv.Start(); err != nil {
		logf.Close()
		return err
	}
	exited := h.exited
	go func() { _ = h.srv.Wait(); logf.Close(); close(exited) }()
	for {
		if _, err := h.Run(ctx, "workspace", "list"); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			h.Close()
			return fmt.Errorf("herdr session %s did not come up: %w", h.Name, ctx.Err())
		case <-exited:
			return fmt.Errorf("herdr session %s exited at startup", h.Name)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// Restart stops the session the way herdr-3d's floor sleep does (Herdr
// saves it and ends its panes) and starts it again, so Herdr restores its
// workspaces and resumes their agents.
func (h *Herdr) Restart(ctx context.Context) error {
	h.stop()
	return h.start(ctx)
}

func (h *Herdr) stop() {
	h.cli("session", "stop", h.Name, "--json")
	select {
	case <-h.exited:
	case <-time.After(10 * time.Second):
		_ = h.srv.Process.Signal(syscall.SIGTERM)
		select {
		case <-h.exited:
		case <-time.After(3 * time.Second):
			_ = h.srv.Process.Kill()
		}
	}
}

// Close stops and deletes the session (only this session, by name).
func (h *Herdr) Close() {
	h.stop()
	h.cli("session", "delete", h.Name, "--json")
}

// cli runs a session lifecycle command, which names the session as its
// argument instead of with --session.
func (h *Herdr) cli(args ...string) {
	if !strings.HasPrefix(h.Name, SessionPrefix) || !slices.Contains(args, h.Name) {
		panic("codexshare: herdr outside the fixture's session: " + strings.Join(args, " "))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, h.Bin, args...)
	cmd.Env = h.Env
	_ = cmd.Run()
}

// HerdrError is a failed herdr command with its JSON error code.
type HerdrError struct {
	Args   []string
	Code   string
	Stderr string
}

func (e *HerdrError) Error() string {
	return fmt.Sprintf("herdr %s: %s %s", strings.Join(e.Args, " "), e.Code, strings.TrimSpace(e.Stderr))
}

// Run runs `herdr --session <Name> args...` and returns stdout.
func (h *Herdr) Run(ctx context.Context, args ...string) ([]byte, error) {
	if !strings.HasPrefix(h.Name, SessionPrefix) || slices.Contains(args, "--session") {
		panic("codexshare: herdr outside the fixture's session: " + strings.Join(args, " "))
	}
	cmd := exec.CommandContext(ctx, h.Bin, append([]string{"--session", h.Name}, args...)...)
	cmd.Env = h.Env
	out, err := cmd.Output()
	if err != nil {
		he := &HerdrError{Args: args, Code: err.Error()}
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			he.Stderr = string(ee.Stderr)
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if json.Unmarshal(ee.Stderr, &body) == nil && body.Error.Code != "" {
				he.Code = body.Error.Code
			} else if json.Unmarshal(out, &body) == nil && body.Error.Code != "" {
				he.Code = body.Error.Code
			}
		}
		return out, he
	}
	return out, nil
}

// Agent is the part of Herdr's agent info the fixture reads.
type Agent struct {
	Agent            string `json:"agent"`
	Status           string `json:"agent_status"`
	Name             string `json:"name"`
	PaneID           string `json:"pane_id"`
	InteractiveReady bool   `json:"interactive_ready"`
	Cwd              string `json:"cwd"`
	Title            string `json:"terminal_title"`
	SessionID        string `json:"agent_session_id"`
	Session          *struct {
		ID string `json:"id"`
	} `json:"agent_session"`
}

func (h *Herdr) agentResult(ctx context.Context, args ...string) (Agent, []byte, error) {
	out, err := h.Run(ctx, args...)
	if err != nil {
		return Agent{}, out, err
	}
	var body struct {
		Result struct {
			Agent Agent `json:"agent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &body); err != nil {
		return Agent{}, out, fmt.Errorf("herdr %s: %w: %s", strings.Join(args, " "), err, out)
	}
	return body.Result.Agent, out, nil
}

// CreateWorkspace creates a workspace at cwd whose shell gets env (KEY=VALUE)
// and returns its root pane.
func (h *Herdr) CreateWorkspace(ctx context.Context, cwd, label string, env ...string) (string, error) {
	args := []string{"workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"}
	for _, kv := range env {
		args = append(args, "--env", kv)
	}
	out, err := h.Run(ctx, args...)
	if err != nil {
		return "", err
	}
	var body struct {
		Result struct {
			RootPane struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &body); err != nil || body.Result.RootPane.PaneID == "" {
		return "", fmt.Errorf("workspace create: %v: %s", err, out)
	}
	return body.Result.RootPane.PaneID, nil
}

// PaneRun types command and Enter into the pane's shell.
func (h *Herdr) PaneRun(ctx context.Context, pane, command string) error {
	_, err := h.Run(ctx, "pane", "run", pane, command)
	return err
}

// Read returns the pane's visible screen (source visible) or its recent
// unwrapped lines (source recent-unwrapped).
func (h *Herdr) Read(ctx context.Context, pane, source string, lines int) (string, error) {
	args := []string{"pane", "read", pane, "--source", source}
	if lines > 0 {
		args = append(args, "--lines", strconv.Itoa(lines))
	}
	out, err := h.Run(ctx, args...)
	return string(out), err
}

// WaitOutput waits until the pane's recent output contains match.
func (h *Herdr) WaitOutput(ctx context.Context, pane, match string, timeout time.Duration) error {
	_, err := h.Run(ctx, "pane", "wait-output", pane, "--match", match, "--source", "recent-unwrapped",
		"--timeout", strconv.Itoa(int(timeout.Milliseconds())))
	return err
}

// WaitVisible waits until the pane's visible screen contains match.
func (h *Herdr) WaitVisible(ctx context.Context, pane, match string, timeout time.Duration) error {
	_, err := h.Run(ctx, "pane", "wait-output", pane, "--match", match, "--source", "visible",
		"--timeout", strconv.Itoa(int(timeout.Milliseconds())))
	return err
}

// SendKeys sends key presses to a pane.
func (h *Herdr) SendKeys(ctx context.Context, pane string, keys ...string) error {
	_, err := h.Run(ctx, append([]string{"pane", "send-keys", pane}, keys...)...)
	return err
}

// SendText sends literal text to a pane.
func (h *Herdr) SendText(ctx context.Context, pane, text string) error {
	_, err := h.Run(ctx, "pane", "send-text", pane, text)
	return err
}

// AgentStart runs `herdr agent start <name> --kind codex --pane <pane> -- args...`.
func (h *Herdr) AgentStart(ctx context.Context, name, pane string, timeout time.Duration, args ...string) (Agent, error) {
	a, _, err := h.agentResult(ctx, append([]string{"agent", "start", name, "--kind", "codex", "--pane", pane,
		"--timeout", strconv.Itoa(int(timeout.Milliseconds())), "--"}, args...)...)
	return a, err
}

// AgentGet returns Herdr's view of an agent (name or pane).
func (h *Herdr) AgentGet(ctx context.Context, target string) (Agent, []byte, error) {
	return h.agentResult(ctx, "agent", "get", target)
}

// AgentPrompt submits a prompt; with until set it waits (--wait) for one of
// those states and returns the agent as Herdr saw it then.
func (h *Herdr) AgentPrompt(ctx context.Context, target, text string, timeout time.Duration, until ...string) (Agent, error) {
	args := []string{"agent", "prompt", target, text}
	if len(until) > 0 {
		args = append(args, "--wait", "--timeout", strconv.Itoa(int(timeout.Milliseconds())))
		for _, u := range until {
			args = append(args, "--until", u)
		}
	}
	a, _, err := h.agentResult(ctx, args...)
	return a, err
}

// AgentWait waits for the agent to reach one of states.
func (h *Herdr) AgentWait(ctx context.Context, target string, timeout time.Duration, states ...string) (Agent, error) {
	args := []string{"agent", "wait", target, "--timeout", strconv.Itoa(int(timeout.Milliseconds()))}
	for _, s := range states {
		args = append(args, "--until", s)
	}
	a, _, err := h.agentResult(ctx, args...)
	return a, err
}

// ProcessInfo returns `pane process-info` raw JSON.
func (h *Herdr) ProcessInfo(ctx context.Context, pane string) (ProcessInfo, error) {
	out, err := h.Run(ctx, "pane", "process-info", "--pane", pane)
	if err != nil {
		return ProcessInfo{}, err
	}
	var body struct {
		Result struct {
			ProcessInfo ProcessInfo `json:"process_info"`
		} `json:"result"`
	}
	err = json.Unmarshal(out, &body)
	return body.Result.ProcessInfo, err
}

// ProcessInfo is a pane's shell and foreground processes.
type ProcessInfo struct {
	ShellPID   int `json:"shell_pid"`
	Foreground []struct {
		PID     int      `json:"pid"`
		Name    string   `json:"name"`
		Argv    []string `json:"argv"`
		Cmdline string   `json:"cmdline"`
	} `json:"foreground_processes"`
}

// ProcEnv reads selected variables of a live process from /proc.
func ProcEnv(pid int, keys ...string) map[string]string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	out := map[string]string{}
	if err != nil {
		return out
	}
	for kv := range strings.SplitSeq(string(raw), "\x00") {
		k, v, ok := strings.Cut(kv, "=")
		if ok && slices.Contains(keys, k) {
			out[k] = v
		}
	}
	return out
}
