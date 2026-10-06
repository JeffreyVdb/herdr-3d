package herdr

import (
	"context"
	"fmt"
	"strings"
)

// Remote is where a shared-server Codex worker's TUI attaches (#155): its
// own app-server's unix socket (under Control.CodexRun) and the working
// directory the TUI names with -C.
type Remote struct {
	Socket, Cwd string
}

// inRun reports whether path sits directly inside c.CodexRun.
func (c *Control) inRun(path string) bool {
	return c.CodexRun != "" && validHome(c.CodexRun) && strings.HasPrefix(path, c.CodexRun+"/") &&
		!strings.Contains(path[len(c.CodexRun)+1:], "/")
}

// StartCodexServer types the shared Codex launch's server start into a
// pane at its shell prompt (`pane run`): `setsid -f fish <launcher>`, the
// bridge-written script under CodexRun that starts `codex app-server`
// with the pane's environment and leaves the pane free.
func (c *Control) StartCodexServer(ctx context.Context, session, pane, launcher string) error {
	if !c.inRun(launcher) {
		return fmt.Errorf("%w: launcher %q is not in the codex run directory", ErrNotAllowed, launcher)
	}
	_, err := c.run(ctx, opStartCodexServer, map[string]string{"session": session, "pane": pane, "launcher": launcher})
	return err
}

// StartCodexRemote starts Codex's TUI in a pane attached to the worker's
// app-server (`agent start … -- --remote unix://<socket> -C <cwd>` and
// hire's model arguments), named name in herdr.
func (c *Control) StartCodexRemote(ctx context.Context, session, pane, name string, a Agent, r Remote) error {
	vars, err := c.remoteVars(session, pane, name, a, r)
	if err != nil {
		return err
	}
	_, err = c.run(ctx, opStartCodexRemote, vars)
	return err
}

// ResumeCodexRemote resumes a Codex thread in a pane attached to the
// worker's app-server (`agent start … -- resume <id> --remote … -C …` with
// the model and effort but no permission override, which a remote resume
// refuses: the thread keeps the permissions it was started with).
func (c *Control) ResumeCodexRemote(ctx context.Context, session, pane, name, thread string, a Agent, r Remote) error {
	vars, err := c.remoteVars(session, pane, name, a, r)
	if err != nil {
		return err
	}
	vars["id"] = thread
	_, err = c.run(ctx, opResumeCodexRemote, vars)
	return err
}

func (c *Control) remoteVars(session, pane, name string, a Agent, r Remote) (map[string]string, error) {
	if a.Harness != "codex" {
		return nil, fmt.Errorf("%w: a remote launch is for codex, not %q", ErrNotAllowed, a.Harness)
	}
	if !c.inRun(r.Socket) {
		return nil, fmt.Errorf("%w: socket %q is not in the codex run directory", ErrNotAllowed, r.Socket)
	}
	return map[string]string{"session": session, "pane": pane, "agent": name, "model": a.Model, "effort": a.Effort,
		"socket": r.Socket, "cwd": r.Cwd}, nil
}

// ResumeCodexEmbedded resumes a shared worker's Codex thread on Codex's
// embedded server when its own server did not start on wake (`agent start
// … -- resume <id> -m … -c model_reasoning_effort=… --dangerously-bypass-
// approvals-and-sandbox`, hire's arguments): never an argument-free `codex
// resume`, which joins the CODEX_HOME daemon.
func (c *Control) ResumeCodexEmbedded(ctx context.Context, session, pane, name, thread string, a Agent) error {
	if a.Harness != "codex" {
		return fmt.Errorf("%w: an embedded resume is for codex, not %q", ErrNotAllowed, a.Harness)
	}
	_, err := c.run(ctx, opResumeCodexEmbedded, map[string]string{"session": session, "pane": pane, "agent": name,
		"id": thread, "model": a.Model, "effort": a.Effort})
	return err
}
