package herdr

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Control is the bridge's only write path to herdr, for waking and putting
// floors to sleep. It is as narrow as Client is read-only: it runs exactly
// the commands in controlShapes, with every variable part validated and
// passed as its own argv element (no shell, except the one fish -c line
// that systemd-run starts, whose only variable is a validated session
// name in single quotes). It never closes, creates, renames or focuses
// anything, never types into a pane except to resume an agent, and never
// uses systemctl.
type Control struct {
	// Herdr is the herdr executable (default "herdr").
	Herdr string
	// SystemdRun is the systemd-run executable (default "systemd-run").
	SystemdRun string
	// Home is the working directory of started servers (default: the
	// user's home directory).
	Home string
	// Only, if set, is the set of sessions Control may act on; any other
	// session is refused before anything runs.
	Only *regexp.Regexp
	// Timeout bounds one command (default 15 s; stopping a session 45 s).
	Timeout time.Duration
	// Run executes argv (default: exec with CleanEnv(os.Environ()), output
	// capped at 1 MiB per stream). Tests inject a fake.
	Run Runner
}

// Runner runs one command and returns its stdout and stderr.
type Runner func(ctx context.Context, argv []string) (stdout, stderr []byte, err error)

// ErrNotAllowed is returned when an argument fails validation or a session
// is outside Control.Only.
var ErrNotAllowed = errors.New("herdr: control command not allowed")

// Control operations (keys of controlShapes).
const (
	opStart        = "start"
	opStop         = "stop"
	opResumeClaude = "resume-claude"
	opResumeCodex  = "resume-codex"
	opReportCodex  = "report-codex-session"
	opProcessInfo  = "process-info"
)

// controlShapes is the complete set of commands Control may run, as argv
// templates. {herdr} and {systemd-run} are the configured executables;
// {session}, {pane}, {id} and {home} are validated placeholders (see
// placeholders); everything else is literal. TestControlAllowlist is the
// tripwire: widening this needs review.
var controlShapes = map[string][]string{
	// Wake: a supervised headless server with Theo's login environment
	// (docs/research/herdr-followup.md §2b).
	opStart: {"{systemd-run}", "--user", "--unit=herdr-s-{session}", "--collect", "-p", "KillMode=process",
		"--working-directory={home}", "/bin/fish", "-l", "-c", "exec herdr --session '{session}' server"},
	// Sleep: herdr's orderly stop (saves state, keeps agent_session).
	opStop: {"{herdr}", "session", "stop", "{session}", "--json"},
	// Wake fallback for an agent herdr did not resume.
	opResumeClaude: {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "claude --resume {id}"},
	opResumeCodex:  {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "codex resume {id}"},
	// Sleep: backfill a Codex pane's session id so it can resume.
	opReportCodex: {"{herdr}", "--session", "{session}", "pane", "report-agent-session", "{pane}",
		"--source", "herdr:codex", "--agent", "codex", "--agent-session-id", "{id}"},
	// Read only: what runs in a pane (is the agent up? is it at a shell?).
	opProcessInfo: {"{herdr}", "--session", "{session}", "pane", "process-info", "--pane", "{pane}"},
}

var (
	sessionNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	paneIDRe      = regexp.MustCompile(`^[A-Za-z0-9]{1,32}:[A-Za-z0-9]{1,32}$`)
	agentIDRe     = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)
	placeholderRe = regexp.MustCompile(`\{[a-z-]+\}`)
)

// ValidSessionName reports whether name may be passed to Control: herdr's
// name characters, and no leading "-" (it would read as a flag) or dots
// only.
func ValidSessionName(name string) bool {
	return sessionNameRe.MatchString(name) && name[0] != '-' && strings.Trim(name, ".") != ""
}

// ValidPaneID reports whether id looks like a herdr pane id ("w1:p2").
func ValidPaneID(id string) bool { return paneIDRe.MatchString(id) }

// ValidAgentSessionID reports whether id may be resumed or reported: an
// agent's native session id (a UUID for Claude and Codex).
func ValidAgentSessionID(id string) bool { return agentIDRe.MatchString(id) && id[0] != '-' }

func validHome(dir string) bool {
	return filepath.IsAbs(dir) && filepath.Clean(dir) == dir && !strings.ContainsAny(dir, "\x00\n\r")
}

// Resumable harnesses and their resume shapes.
var resumeOps = map[string]string{"claude": opResumeClaude, "codex": opResumeCodex}

// CanResume reports whether Control knows how to resume an agent of this
// harness.
func CanResume(harness string) bool { _, ok := resumeOps[harness]; return ok }

// StartSession starts a stopped session's server as the transient user
// unit herdr-s-<session>, with a login fish environment.
func (c *Control) StartSession(ctx context.Context, session string) error {
	home := c.Home
	if home == "" {
		var err error
		if home, err = os.UserHomeDir(); err != nil {
			return err
		}
	}
	_, err := c.run(ctx, opStart, map[string]string{"session": session, "home": home})
	return err
}

// StopSession stops a session the way herdr does (`herdr session stop`),
// which keeps each pane's agent_session for the next start. It returns
// herdr's output.
func (c *Control) StopSession(ctx context.Context, session string) (string, error) {
	out, err := c.run(ctx, opStop, map[string]string{"session": session})
	return strings.TrimSpace(string(out)), err
}

// ResumeAgent types the harness's resume command into a pane (`pane run`).
// Only claude and codex can be resumed.
func (c *Control) ResumeAgent(ctx context.Context, session, pane, harness, agentSession string) error {
	op, ok := resumeOps[harness]
	if !ok {
		return fmt.Errorf("%w: cannot resume harness %q", ErrNotAllowed, harness)
	}
	_, err := c.run(ctx, op, map[string]string{"session": session, "pane": pane, "id": agentSession})
	return err
}

// ReportCodexSession tells herdr a Codex pane's session id
// (`pane report-agent-session`), so a later start resumes it.
func (c *Control) ReportCodexSession(ctx context.Context, session, pane, agentSession string) error {
	_, err := c.run(ctx, opReportCodex, map[string]string{"session": session, "pane": pane, "id": agentSession})
	return err
}

// PaneProcesses reports what runs in a pane (`pane process-info`).
func (c *Control) PaneProcesses(ctx context.Context, session, pane string) (*ProcessInfo, error) {
	out, err := c.run(ctx, opProcessInfo, map[string]string{"session": session, "pane": pane})
	var resp struct {
		Result *struct {
			ProcessInfo *ProcessInfo `json:"process_info"`
		} `json:"result"`
		Error *APIError `json:"error"`
	}
	if jerr := json.Unmarshal(out, &resp); jerr == nil && resp.Error != nil {
		return nil, resp.Error
	}
	if err != nil {
		return nil, err
	}
	if resp.Result == nil || resp.Result.ProcessInfo == nil {
		return nil, fmt.Errorf("herdr pane process-info: unexpected output %.200q", out)
	}
	return resp.Result.ProcessInfo, nil
}

// ProcessInfo is `pane process-info`: the pane's shell and the processes
// of its terminal's foreground process group.
type ProcessInfo struct {
	PaneID         string    `json:"pane_id"`
	ShellPID       *int      `json:"shell_pid"`
	ForegroundPGID *int      `json:"foreground_process_group_id"`
	Foreground     []Process `json:"foreground_processes"`
}

// Process is one foreground process of a pane.
type Process struct {
	PID     int      `json:"pid"`
	Name    string   `json:"name"`
	Argv    []string `json:"argv"`
	Cmdline string   `json:"cmdline"`
	Cwd     string   `json:"cwd"`
}

// AtShell reports whether the pane's shell itself is in the foreground
// (nothing runs in it).
func (p *ProcessInfo) AtShell() bool {
	return p.ShellPID != nil && p.ForegroundPGID != nil && *p.ShellPID == *p.ForegroundPGID
}

// Runs reports whether a foreground process of the pane is the harness's
// agent: its name or executable is the harness, or its command line has
// the agent session id.
func (p *ProcessInfo) Runs(harness, agentSession string) bool {
	if p.AtShell() {
		return false
	}
	for _, pr := range p.Foreground {
		if pr.Name == harness || (len(pr.Argv) > 0 && filepath.Base(pr.Argv[0]) == harness) ||
			(agentSession != "" && strings.Contains(pr.Cmdline, agentSession)) {
			return true
		}
	}
	return false
}

// placeholders validate the variable parts of controlShapes.
var placeholders = map[string]func(string) bool{
	"session": ValidSessionName,
	"pane":    ValidPaneID,
	"id":      ValidAgentSessionID,
	"home":    validHome,
}

// run is the single choke point for control commands: it expands the
// shape of op with vars after validating each one (and the session
// against Only), then runs it.
func (c *Control) run(ctx context.Context, op string, vars map[string]string) ([]byte, error) {
	shape, ok := controlShapes[op]
	if !ok {
		return nil, fmt.Errorf("%w: unknown operation %q", ErrNotAllowed, op)
	}
	for name, v := range vars {
		valid, known := placeholders[name]
		if !known || !valid(v) {
			return nil, fmt.Errorf("%w: invalid %s %q", ErrNotAllowed, name, v)
		}
	}
	if s := vars["session"]; c.Only != nil && !c.Only.MatchString(s) {
		return nil, fmt.Errorf("%w: session %q is not watched", ErrNotAllowed, s)
	}
	argv := make([]string, len(shape))
	var missing error
	for i, tmpl := range shape {
		argv[i] = placeholderRe.ReplaceAllStringFunc(tmpl, func(ph string) string {
			switch name := ph[1 : len(ph)-1]; name {
			case "herdr":
				return c.bin(c.Herdr, "herdr")
			case "systemd-run":
				return c.bin(c.SystemdRun, "systemd-run")
			default:
				v, ok := vars[name]
				if !ok {
					missing = fmt.Errorf("%w: %s needs %s", ErrNotAllowed, op, name)
				}
				return v
			}
		})
	}
	if missing != nil {
		return nil, missing
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
		if op == opStop {
			timeout = 45 * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	runner := c.Run
	if runner == nil {
		runner = execRunner
	}
	stdout, stderr, err := runner(ctx, argv)
	if err != nil {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = strings.TrimSpace(string(stdout))
		}
		return stdout, fmt.Errorf("%s: %w: %.500s", strings.Join(argv[:min(len(argv), 3)], " "), err, msg)
	}
	return stdout, nil
}

func (c *Control) bin(configured, def string) string {
	if configured == "" {
		return def
	}
	return configured
}

// maxOutput caps what is kept of a control command's stdout and stderr.
const maxOutput = 1 << 20

func execRunner(ctx context.Context, argv []string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = CleanEnv(os.Environ())
	var stdout, stderr capped
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

// capped keeps the first maxOutput bytes written to it.
type capped struct{ bytes.Buffer }

func (c *capped) Write(p []byte) (int, error) {
	if room := maxOutput - c.Len(); room > 0 {
		c.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}
