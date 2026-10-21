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
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/shell"
)

// Control is the bridge's only write path to herdr: waking and putting
// floors to sleep, hiring workers and sending them home, and (M5) the
// laptops: watching a pane's screen and typing into it. It is as narrow
// as Client is read-only: it runs exactly the commands in controlShapes,
// with every variable part validated and passed as its own argv element
// (no shell, except the one `<shell> -l -c` line that systemd-run starts,
// whose only variable is a validated session name in single quotes, and the
// one `setsid -f <shell> <launcher>` line typed into a pane). It creates
// and closes only single workspaces (never a group), renames only a hired
// worker's root pane (its identity marker) and restores a just-started Codex's
// agent name after hook review, types into a pane only a
// resume command, a hire's first prompt, the agents' exit commands, a
// fixed set of keys and (M5) what the player types or prompts at a laptop,
// owns (#176) only the seated laptop's terminal, through `terminal session
// control` without --takeover (resize, history scroll, release), never
// focuses anything and never uses systemctl.
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

	// M5 term: Stream starts a long-running command (Observe) and returns
	// its stdout (default: exec in its own process group with
	// CleanEnv(os.Environ())). Tests inject a fake.
	Stream Streamer
	// #176: Duplex starts the terminal controller, a long-running command
	// with a stdin (default: as Stream, with a stdin pipe). Tests inject a fake.
	Duplex DuplexStreamer

	// #95: TypeGap is the pause after each chunk of a typed prompt
	// (default DefaultTypeGap).
	TypeGap time.Duration

	// #155: CodexRun is the private directory the shared Codex launch's
	// launcher scripts and sockets live in. A launcher or socket outside it
	// is refused; empty refuses them all.
	CodexRun string

	// #23: ClaudeSettings is the bridge's own Claude Code settings file
	// (its observational hooks), passed with --settings to every Claude it
	// starts or resumes ("": none). It merges with the user's and the
	// project's settings, which are never touched.
	ClaudeSettings string

	// #68: Shell is the shell policy: bash (the default) or fish, an
	// explicit compatibility option. It picks the interpreter of a woken
	// floor's login environment and of the shared Codex launcher, and the
	// launcher's extension. Only that shell is ever used: Control never
	// reads $SHELL and never switches to the other one.
	Shell shell.Kind
	// ShellBin is the absolute path of Shell's executable. Empty, it is
	// resolved when first needed (shell.Resolve). Either way it is checked
	// again before every wake and launch (shell.Verify): a shell that is not
	// installed, or was removed since, is an error naming the option, not
	// a fallback.
	ShellBin string
}

// Runner runs one command and returns its stdout and stderr.
type Runner func(ctx context.Context, argv []string) (stdout, stderr []byte, err error)

// ErrNotAllowed is returned when an argument fails validation or a session
// is outside Control.Only.
var ErrNotAllowed = errors.New("herdr: control command not allowed")

// Control operations (keys of controlShapes).
const (
	opStart = "start"
	opStop  = "stop"
	// #58: a new session (newsession.go).
	opCreateSession = "create-session"
	opResumeClaude  = "resume-claude"
	// #23: the same with the bridge's Claude settings file (its hooks).
	opResumeClaudeSettings = "resume-claude-settings"
	opStartClaudeSettings  = "start-claude-settings"
	opResumeCodex          = "resume-codex"
	opReportCodex          = "report-codex-session"
	opProcessInfo          = "process-info"

	opWorkspaceCreate = "workspace-create"
	opWorktreeCreate  = "worktree-create"
	opMarkPane        = "mark-pane"
	opStartClaude     = "start-claude"
	opStartCodex      = "start-codex"
	opReadPane        = "read-pane"
	opKeyDown         = "key-down"
	opKeyEnter        = "key-enter"
	opKeyCtrlC        = "key-ctrl-c"
	opPrompt          = "prompt"
	opExitClaude      = "exit-claude"
	opExitCodex       = "exit-codex"
	opWorkspaceClose  = "workspace-close"
	opWorktreeRemove  = "worktree-remove"
)

// M5 term: control operations of the laptops.
const (
	opObserve      = "observe"
	opSendKeys     = "send-keys"
	opSendText     = "send-text"
	opSendSequence = "send-sequence"
	opPromptWait   = "prompt-wait"
	opPromptQueued = "prompt-queued"
	// #95: one chunk of a prompt typed into Claude Code.
	opTypeText = "type-text"
	// #176: the seated laptop's terminal controller.
	opControl = "control"
)

// #155: control operations of a shared-server Codex worker.
const (
	opRestoreCodexName  = "rename-started-agent"
	opStartCodexServer  = "start-codex-server"
	opStartCodexRemote  = "start-codex-remote"
	opResumeCodexRemote = "resume-codex-remote"
	// #155 round 2: a shared worker's wake when its server does not start.
	opResumeCodexEmbedded = "resume-codex-embedded"
	// #139: a worker on a Codex profile: its CODEX_HOME exported in its
	// pane's shell (bash, or fish's set -gx).
	opExportCodexHome     = "export-codex-home"
	opExportCodexHomeFish = "export-codex-home-fish"
)

// #74: control operations of the fullscreen laptop (pane zoom).
const (
	opZoomOn  = "zoom-on"
	opZoomOff = "zoom-off"
)

// controlShapes is the complete set of commands Control may run, as argv
// templates. {herdr} and {systemd-run} are the configured executables and
// {shell} and {launcher-shell} the shell policy's (shellBin);
// {session}, {pane}, {id} and {home} are validated placeholders (see
// placeholders); everything else is literal. TestControlAllowlist is the
// tripwire: widening this needs review.
var controlShapes = map[string][]string{
	// Restore only a just-started Codex's name after a hook-review startup timeout.
	opRestoreCodexName: {"{herdr}", "--session", "{session}", "agent", "rename", "{pane}", "{agent}"},
	// Wake: a supervised headless server with the user's login environment
	// (docs/research/herdr-followup.md §2b), in the policy's shell (#68).
	opStart: {"{systemd-run}", "--user", "--unit=herdr-s-{session}", "--collect", "-p", "KillMode=process",
		"--working-directory={home}", "{shell}", "-l", "-c", "exec herdr --session '{session}' server"},
	// #58 Create: a new named session is a server started under a name herdr
	// has not seen (`herdr session` has no create verb), the wake's launch.
	// CreateSession refuses a name herdr already knows.
	opCreateSession: {"{systemd-run}", "--user", "--unit=herdr-s-{session}", "--collect", "-p", "KillMode=process",
		"--working-directory={home}", "{shell}", "-l", "-c", "exec herdr --session '{session}' server"},
	// Sleep: herdr's orderly stop (saves state, keeps agent_session).
	opStop: {"{herdr}", "session", "stop", "{session}", "--json"},
	// Wake fallback for an agent herdr did not resume.
	opResumeClaude: {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "claude --resume {id}"},
	// #23: with the bridge's hooks; the file is a plain absolute path, so
	// single quotes hold it in any shell.
	opResumeClaudeSettings: {"{herdr}", "--session", "{session}", "pane", "run", "{pane}",
		"claude --settings '{settings}' --resume {id}"},
	opResumeCodex: {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "codex resume {id}"},
	// Sleep: backfill a Codex pane's session id so it can resume.
	opReportCodex: {"{herdr}", "--session", "{session}", "pane", "report-agent-session", "{pane}",
		"--source", "herdr:codex", "--agent", "codex", "--agent-session-id", "{id}"},
	// Read only: what runs in a pane (is the agent up? is it at a shell?).
	opProcessInfo: {"{herdr}", "--session", "{session}", "pane", "process-info", "--pane", "{pane}"},

	// Hire: a workspace, or a worktree branched from a fetched remote base.
	opWorkspaceCreate: {"{herdr}", "--session", "{session}", "workspace", "create", "--cwd", "{dir}",
		"--label", "{label}", "--no-focus"},
	opWorktreeCreate: {"{herdr}", "--session", "{session}", "worktree", "create", "--cwd", "{dir}",
		"--branch", "{branch}", "--base", "{base}", "--label", "{label}", "--no-focus"},
	// Hire: the identity marker on the new root pane.
	opMarkPane: {"{herdr}", "--session", "{session}", "pane", "rename", "{pane}", "{marker}"},
	// Hire: herdr types the agent into the pane's shell (fish wrappers apply).
	opStartClaude: {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "claude",
		"--pane", "{pane}", "--timeout", "30000", "--",
		"--model", "{model}", "--effort", "{effort}", "--permission-mode", "bypassPermissions", "--name", "{label}"},
	// #23: the same with the bridge's Claude settings file (its hooks).
	opStartClaudeSettings: {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "claude",
		"--pane", "{pane}", "--timeout", "30000", "--",
		"--model", "{model}", "--effort", "{effort}", "--permission-mode", "bypassPermissions", "--name", "{label}",
		"--settings", "{settings}"},
	opStartCodex: {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
		"--pane", "{pane}", "--timeout", "30000", "--",
		"-m", "{model}", "-c", "model_reasoning_effort={effort}", "--dangerously-bypass-approvals-and-sandbox"},
	// Read only: the screen, to recognise an agent's trust dialog.
	opReadPane: {"{herdr}", "--session", "{session}", "pane", "read", "{pane}", "--source", "visible"},
	// Answering the trust dialog; Ctrl-C when an agent does not exit.
	opKeyDown:  {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "down"},
	opKeyEnter: {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "enter"},
	opKeyCtrlC: {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "ctrl+c"},
	// Hire: the optional first task, confirmed by the agent starting to work
	// (else agent_prompt_stalled after 5 s).
	opPrompt: {"{herdr}", "--session", "{session}", "agent", "prompt", "{pane}", "{text}",
		"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"},
	// Send home: the agents' own exit commands (then Enter).
	opExitClaude: {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "/exit"},
	opExitCodex:  {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "/quit"},
	// Send home: close the one workspace, or remove its worktree (which
	// closes it; git refuses a dirty tree, and --force is never passed).
	opWorkspaceClose: {"{herdr}", "--session", "{session}", "workspace", "close", "{workspace}"},
	opWorktreeRemove: {"{herdr}", "--session", "{session}", "worktree", "remove", "--workspace", "{workspace}"},

	// M5 term. Read only, long-running: a pane's screen as NDJSON frames (a
	// full frame, then diffs; read-only, no input, resize or takeover).
	opObserve: {"{herdr}", "--session", "{session}", "terminal", "session", "observe", "{pane}",
		"--cols", "{cols}", "--rows", "{rows}"},
	// #176. Long-running: the seated laptop's terminal as its owner (the
	// same frames as observe; on stdin only resize, scroll, an empty input
	// that returns to the live bottom, and release). Never --takeover: herdr
	// refuses a second owner, and the bridge falls back to observe.
	opControl: {"{herdr}", "--session", "{session}", "terminal", "session", "control", "{pane}",
		"--cols", "{cols}", "--rows", "{rows}"},
	// Laptop input: herdr key names ({keys} is one argv element per key),
	// literal text without control characters, and the fixed xterm
	// sequence of a key herdr 0.9.0 has no name for (delete, home, …).
	opSendKeys:     {"{herdr}", "--session", "{session}", "pane", "send-keys", "{pane}", "{keys}"},
	opSendText:     {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "{input}"},
	opSendSequence: {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "{seq}"},
	// worker.prompt: confirmed by the agent starting to work (else
	// agent_prompt_stalled after 5 s), or queued for an agent at work.
	opPromptWait: {"{herdr}", "--session", "{session}", "agent", "prompt", "{pane}", "{message}",
		"--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"},
	opPromptQueued: {"{herdr}", "--session", "{session}", "agent", "prompt", "{pane}", "{message}"},
	// #95: a prompt to Claude Code is typed, in chunks (then key-enter):
	// the same command as send-text, but its text may hold "\n" (a new
	// line in Claude's input, not Enter).
	opTypeText: {"{herdr}", "--session", "{session}", "pane", "send-text", "{pane}", "{chunk}"},

	// #74. Zoom a pane's tab to that pane (it also focuses the pane) and put
	// the tab back. Explicit modes only: never --toggle, never no mode, so a
	// repeated call cannot undo what the other one did.
	opZoomOn:  {"{herdr}", "--session", "{session}", "pane", "zoom", "{pane}", "--on"},
	opZoomOff: {"{herdr}", "--session", "{session}", "pane", "zoom", "{pane}", "--off"},

	// #155. A shared-server Codex worker: its own app-server, started from
	// its pane's initialized shell (the bridge-written launcher script under
	// CodexRun, run by the policy's shell: bash by its absolute path, fish as
	// `fish`; setsid keeps it off the pane's foreground job), then the
	// TUI attached to it, and on wake the remote resume, which takes no
	// permission override (a remote resume refuses one and exits).
	opStartCodexServer: {"{herdr}", "--session", "{session}", "pane", "run", "{pane}",
		"setsid -f {launcher-shell} {launcher} </dev/null >/dev/null 2>&1"},
	opStartCodexRemote: {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
		"--pane", "{pane}", "--timeout", "30000", "--", "--remote", "unix://{socket}", "-C", "{cwd}",
		"-m", "{model}", "-c", "model_reasoning_effort={effort}", "--dangerously-bypass-approvals-and-sandbox"},
	opResumeCodexRemote: {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
		"--pane", "{pane}", "--timeout", "30000", "--", "resume", "{id}", "--remote", "unix://{socket}", "-C", "{cwd}",
		"-m", "{model}", "-c", "model_reasoning_effort={effort}"},
	// The wake of a shared worker whose server did not start: its thread
	// resumed on Codex's embedded server, with hire's model arguments (any
	// -c keeps a plain codex off the CODEX_HOME daemon) and hire's
	// permissions, never as an argument-free `codex resume`.
	opResumeCodexEmbedded: {"{herdr}", "--session", "{session}", "agent", "start", "{agent}", "--kind", "codex",
		"--pane", "{pane}", "--timeout", "30000", "--", "resume", "{id}",
		"-m", "{model}", "-c", "model_reasoning_effort={effort}", "--dangerously-bypass-approvals-and-sandbox"},

	// #139. A worker on a Codex profile: the profile's home exported in its
	// pane's shell before anything of it starts there, so every Codex herdr
	// types into that shell (the attached TUI, a legacy start, a wake's
	// embedded resume) runs on it; `herdr agent start` takes no env. The
	// policy's shell picks the shape. The home is a plain path, so single
	// quotes hold it in either shell.
	opExportCodexHome:     {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "export CODEX_HOME='{codex-home}'"},
	opExportCodexHomeFish: {"{herdr}", "--session", "{session}", "pane", "run", "{pane}", "set -gx CODEX_HOME '{codex-home}'"},
}

var (
	sessionNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)
	paneIDRe      = regexp.MustCompile(`^[A-Za-z0-9]{1,32}:[A-Za-z0-9]{1,32}$`)
	agentIDRe     = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)
	workspaceIDRe = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	branchRe      = regexp.MustCompile(`^h3d/[a-z0-9]+(-[a-z0-9]+)*$`)
	baseRe        = regexp.MustCompile(`^origin/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
	markerRe      = regexp.MustCompile(`^h3d-[0-9a-f]{6,32}$`)
	agentNameRe   = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	modelRe       = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{0,63}$`)
	effortRe      = regexp.MustCompile(`^[a-z]{1,16}$`)
	placeholderRe = regexp.MustCompile(`\{[a-z-]+\}`)
	// #155: what a path typed into a shell, or into the TUI's command line,
	// may hold: no space, quote, glob, $ or other shell metacharacter.
	plainPathRe = regexp.MustCompile(`^/[A-Za-z0-9._/+@,=:-]{1,255}$`)
	runFileRe   = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,90}$`)
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

// ValidDir reports whether dir may be passed as a working directory: an
// absolute, clean path without NUL or line breaks.
func ValidDir(dir string) bool { return validHome(dir) }

// MaxLabel bounds a hired worker's label (workspace label, Claude --name).
const MaxLabel = 64

// ValidLabel reports whether label may label a hired workspace: 1-64
// bytes of UTF-8 without control characters, not starting with "-" (a
// flag to herdr or to the agent's CLI).
func ValidLabel(label string) bool {
	if label == "" || len(label) > MaxLabel || !utf8.ValidString(label) || label[0] == '-' ||
		strings.TrimSpace(label) == "" {
		return false
	}
	for _, r := range label {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// MaxPrompt bounds a hire's first prompt.
const MaxPrompt = 32 << 10

// ValidPrompt reports whether text may be sent as a prompt: 1-32 KiB of
// UTF-8 without NUL, not starting with "--" (herdr's CLI would read it as
// one of its flags).
func ValidPrompt(text string) bool {
	return strings.TrimSpace(text) != "" && len(text) <= MaxPrompt && utf8.ValidString(text) &&
		!strings.ContainsRune(text, 0) && !strings.HasPrefix(text, "--")
}

// ValidBranch reports whether name is a branch the bridge makes for a
// worktree hire: h3d/ and lower-case words joined by "-".
func ValidBranch(name string) bool { return branchRe.MatchString(name) && len(name) <= 100 }

// ValidBase reports whether ref is a remote-tracking base "origin/<branch>"
// (no "..", no ".lock" component).
func ValidBase(ref string) bool {
	if !baseRe.MatchString(ref) || len(ref) > 200 || strings.Contains(ref, "..") {
		return false
	}
	for _, part := range strings.Split(ref, "/") {
		if strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
	}
	return true
}

// ValidMarker reports whether label is an identity marker h3d-<hex>.
func ValidMarker(label string) bool { return markerRe.MatchString(label) }

// ValidAgentName reports whether name may name a hired agent in herdr.
func ValidAgentName(name string) bool { return agentNameRe.MatchString(name) && len(name) <= 64 }

func validModel(m string) bool  { return modelRe.MatchString(m) }
func validEffort(e string) bool { return effortRe.MatchString(e) }

// ValidPlainDir reports whether dir may be typed as a working directory
// (#155: the shared Codex launch's -C and its trust override): an absolute,
// clean path of letters, digits and ._/+@,=:- only.
func ValidPlainDir(dir string) bool {
	return plainPathRe.MatchString(dir) && filepath.Clean(dir) == dir && !strings.Contains(dir, "/../")
}

// validRunFile reports whether path may name a shared Codex launch file:
// absolute, clean, short (a unix socket path is limited to 108 bytes) and
// of the plain characters, ending in ext.
func validRunFile(path, ext string) bool {
	return runFileRe.MatchString(path) && filepath.Clean(path) == path && strings.HasSuffix(path, ext) &&
		!strings.Contains(path, "..")
}

// validSettingsFile reports whether path may name the bridge's Claude
// settings file (#23): a plain, clean absolute path of a .json file, typed
// into a pane's shell in single quotes on a resume.
func validSettingsFile(path string) bool {
	return plainPathRe.MatchString(path) && filepath.Clean(path) == path && strings.HasSuffix(path, ".json") &&
		!strings.Contains(path, "..")
}

// ValidWorkspaceID reports whether id looks like a herdr workspace id ("w1").
func ValidWorkspaceID(id string) bool { return workspaceIDRe.MatchString(id) }

// Resumable harnesses and their resume shapes.
var resumeOps = map[string]string{"claude": opResumeClaude, "codex": opResumeCodex}

// CanResume reports whether Control knows how to resume an agent of this
// harness.
func CanResume(harness string) bool { _, ok := resumeOps[harness]; return ok }

// StartSession starts a stopped session's server as the transient user
// unit herdr-s-<session>, with a login environment of the policy's shell.
func (c *Control) StartSession(ctx context.Context, session string) error {
	home, err := c.home()
	if err != nil {
		return err
	}
	_, err = c.run(ctx, opStart, map[string]string{"session": session, "home": home})
	return err
}

// home is the started server's working directory: Home, else the user's.
func (c *Control) home() (string, error) {
	if c.Home != "" {
		return c.Home, nil
	}
	return os.UserHomeDir()
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
	vars := map[string]string{"session": session, "pane": pane, "id": agentSession}
	if op == opResumeClaude && c.ClaudeSettings != "" { // #23
		op, vars["settings"] = opResumeClaudeSettings, c.ClaudeSettings
	}
	_, err := c.run(ctx, op, vars)
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
	"session":   ValidSessionName,
	"pane":      ValidPaneID,
	"id":        ValidAgentSessionID,
	"home":      validHome,
	"dir":       ValidDir,
	"label":     ValidLabel,
	"branch":    ValidBranch,
	"base":      ValidBase,
	"marker":    ValidMarker,
	"agent":     ValidAgentName,
	"model":     validModel,
	"effort":    validEffort,
	"text":      ValidPrompt,
	"workspace": ValidWorkspaceID,

	// M5 term
	"cols":    validCols,
	"rows":    validRows,
	"keys":    validKeyList,
	"input":   ValidInputText,
	"seq":     validSequence,
	"message": ValidMessage,

	// #95
	"chunk": validTypedChunk,

	// #155
	// Either format (argv also requires the policy's own, see launcherFits).
	"launcher": func(s string) bool { return validRunFile(s, ".sh") || validRunFile(s, ".fish") },
	"socket":   func(s string) bool { return validRunFile(s, ".sock") },
	"cwd":      ValidPlainDir,
	// #139: a Codex profile's home, typed into the pane's shell.
	"codex-home": ValidPlainDir,

	// #23
	"settings": validSettingsFile,
}

// secretPlaceholders are what a person typed: a refused value is never
// quoted in an error (errors reach the log and the audit log).
var secretPlaceholders = map[string]bool{"text": true, "input": true, "message": true, "chunk": true}

// run is the single choke point for control commands: it expands the
// shape of op with vars after validating each one (and the session
// against Only), then runs it.
func (c *Control) run(ctx context.Context, op string, vars map[string]string) ([]byte, error) {
	argv, err := c.argv(op, vars)
	if err != nil {
		return nil, err
	}
	timeout := c.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
		switch op {
		case opStop:
			timeout = 45 * time.Second
		case opStartClaude, opStartClaudeSettings, opStartCodex, opStartCodexRemote, opResumeCodexRemote, opResumeCodexEmbedded, opWorktreeCreate, opWorktreeRemove:
			timeout = 40 * time.Second // agent start waits up to 30 s itself
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
		what := "herdr control " + op
		// herdr reports server errors as JSON {"error":{…}}, on stderr.
		for _, out := range [][]byte{stderr, stdout} {
			var resp struct {
				Error *APIError `json:"error"`
			}
			if json.Unmarshal(bytes.TrimSpace(out), &resp) == nil && resp.Error != nil {
				return stdout, fmt.Errorf("%s: %w", what, resp.Error)
			}
		}
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = strings.TrimSpace(string(stdout))
		}
		return stdout, fmt.Errorf("%s: %w: %.500s", what, err, msg)
	}
	return stdout, nil
}

// argv expands the shape of op with vars after validating each one (and
// the session against Only). The element "{keys}" alone becomes one
// element per key.
func (c *Control) argv(op string, vars map[string]string) ([]string, error) {
	shape, ok := controlShapes[op]
	if !ok {
		return nil, fmt.Errorf("%w: unknown operation %q", ErrNotAllowed, op)
	}
	for name, v := range vars {
		valid, known := placeholders[name]
		if !known || !valid(v) {
			if secretPlaceholders[name] {
				return nil, fmt.Errorf("%w: invalid %s (%d bytes)", ErrNotAllowed, name, len(v))
			}
			return nil, fmt.Errorf("%w: invalid %s %q", ErrNotAllowed, name, v)
		}
	}
	if s := vars["session"]; c.Only != nil && !c.Only.MatchString(s) {
		return nil, fmt.Errorf("%w: session %q is not watched", ErrNotAllowed, s)
	}
	if l, ok := vars["launcher"]; ok && !c.launcherFits(l) {
		return nil, fmt.Errorf("%w: launcher %q is not a %s launcher (shell policy %s)", ErrNotAllowed, l,
			c.Shell.Or().LauncherExt(), c.Shell.Or())
	}
	argv := make([]string, 0, len(shape))
	var missing error
	for _, tmpl := range shape {
		if tmpl == "{keys}" {
			keys, ok := vars["keys"]
			if !ok {
				return nil, fmt.Errorf("%w: %s needs keys", ErrNotAllowed, op)
			}
			argv = append(argv, strings.Fields(keys)...)
			continue
		}
		argv = append(argv, placeholderRe.ReplaceAllStringFunc(tmpl, func(ph string) string {
			switch name := ph[1 : len(ph)-1]; name {
			case "herdr":
				return c.bin(c.Herdr, "herdr")
			case "systemd-run":
				return c.bin(c.SystemdRun, "systemd-run")
			case "shell", "launcher-shell":
				bin, err := c.shellBin(name == "launcher-shell")
				if err != nil {
					missing = err
				}
				return bin
			default:
				v, ok := vars[name]
				if !ok {
					missing = fmt.Errorf("%w: %s needs %s", ErrNotAllowed, op, name)
				}
				return v
			}
		}))
	}
	if missing != nil {
		return nil, missing
	}
	return argv, nil
}

// launcherFits reports whether the launcher file is in the format the
// policy's shell runs.
func (c *Control) launcherFits(path string) bool {
	return strings.HasSuffix(path, c.Shell.Or().LauncherExt())
}

// shellBin is the policy's shell as the argv names it: for the wake the
// absolute path of its executable; for the launcher typed into a pane, bash
// by that path too and fish (as in v1.45.0) as `fish`. The path is typed
// into a shell, so it must be plain characters. A shell that is not
// installed is an error that names the option.
func (c *Control) shellBin(launcher bool) (string, error) {
	k := c.Shell.Or()
	if _, err := shell.Parse(string(k)); err != nil {
		return "", fmt.Errorf("%w: %v", ErrNotAllowed, err)
	}
	bin := c.ShellBin
	if bin == "" {
		var err error
		if bin, err = shell.Resolve(k); err != nil {
			return "", err
		}
	}
	if !ValidPlainDir(bin) {
		return "", fmt.Errorf("%w: the %s executable %q is not a plain absolute path (set %s to a shell installed at one)",
			ErrNotAllowed, k, bin, shell.Option)
	}
	// A path cached at startup may have lost its shell since: a command
	// dispatched with it would exit with its error discarded.
	if err := shell.Verify(k, bin); err != nil {
		return "", err
	}
	if launcher && k == shell.Fish {
		return "fish", nil
	}
	return bin, nil
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
