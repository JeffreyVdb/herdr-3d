package herdr

import (
	"context"
	"encoding/json"
	"fmt"
)

// Created is a workspace that CreateWorkspace or CreateWorktree made.
type Created struct {
	WorkspaceID string
	// PaneID is the workspace's root pane.
	PaneID string
	// CheckoutPath and Branch are set for a worktree.
	CheckoutPath string
	Branch       string
}

// CreateWorkspace creates an unfocused workspace in dir with label
// (`workspace create`).
func (c *Control) CreateWorkspace(ctx context.Context, session, dir, label string) (Created, error) {
	out, err := c.run(ctx, opWorkspaceCreate, map[string]string{"session": session, "dir": dir, "label": label})
	if err != nil {
		return Created{}, err
	}
	return parseCreated("workspace create", out)
}

// CreateWorktree creates a git worktree of the repository at repo on a new
// branch from base (a remote-tracking ref) and opens it as an unfocused
// workspace (`worktree create`).
func (c *Control) CreateWorktree(ctx context.Context, session, repo, branch, base, label string) (Created, error) {
	out, err := c.run(ctx, opWorktreeCreate, map[string]string{"session": session, "dir": repo, "branch": branch,
		"base": base, "label": label})
	if err != nil {
		return Created{}, err
	}
	return parseCreated("worktree create", out)
}

func parseCreated(what string, out []byte) (Created, error) {
	var resp struct {
		Result *struct {
			Workspace *struct {
				WorkspaceID string `json:"workspace_id"`
			} `json:"workspace"`
			RootPane *struct {
				PaneID string `json:"pane_id"`
			} `json:"root_pane"`
			Worktree *struct {
				Branch string `json:"branch"`
				Path   string `json:"path"`
			} `json:"worktree"`
		} `json:"result"`
	}
	if err := json.Unmarshal(out, &resp); err != nil || resp.Result == nil || resp.Result.Workspace == nil ||
		resp.Result.RootPane == nil {
		return Created{}, fmt.Errorf("herdr %s: unexpected output %.300q", what, out)
	}
	r := resp.Result
	cr := Created{WorkspaceID: r.Workspace.WorkspaceID, PaneID: r.RootPane.PaneID}
	if r.Worktree != nil {
		cr.CheckoutPath, cr.Branch = r.Worktree.Path, r.Worktree.Branch
	}
	if !ValidWorkspaceID(cr.WorkspaceID) || !ValidPaneID(cr.PaneID) {
		return Created{}, fmt.Errorf("herdr %s: unexpected ids %q %q", what, cr.WorkspaceID, cr.PaneID)
	}
	return cr, nil
}

// MarkPane labels a pane with an identity marker h3d-<hex> (`pane rename`).
func (c *Control) MarkPane(ctx context.Context, session, pane, marker string) error {
	_, err := c.run(ctx, opMarkPane, map[string]string{"session": session, "pane": pane, "marker": marker})
	return err
}

// Agent is what StartAgent launches: a harness (claude or codex) with its
// model and effort, and the label Claude shows (--name).
type Agent struct {
	Harness, Model, Effort, Label string
}

var startOps = map[string]string{"claude": opStartClaude, "codex": opStartCodex}

// CanStart reports whether Control knows how to start an agent of this
// harness.
func CanStart(harness string) bool { _, ok := startOps[harness]; return ok }

// StartAgent starts an agent in a pane at its shell prompt (`agent start`,
// which types it into the shell so the user's wrappers apply), named name
// in herdr. An agent stuck on a dialog fails with the APIError code
// "agent_not_ready".
func (c *Control) StartAgent(ctx context.Context, session, pane, name string, a Agent) error {
	op, ok := startOps[a.Harness]
	if !ok {
		return fmt.Errorf("%w: cannot start harness %q", ErrNotAllowed, a.Harness)
	}
	vars := map[string]string{"session": session, "pane": pane, "agent": name, "model": a.Model, "effort": a.Effort}
	if a.Harness == "claude" {
		vars["label"] = a.Label
	}
	_, err := c.run(ctx, op, vars)
	if a.Harness == "codex" {
		return c.codexStartupResult(ctx, session, pane, name, err)
	}
	return err
}

// ReadPane returns the visible screen of a pane as text (`pane read`).
func (c *Control) ReadPane(ctx context.Context, session, pane string) (string, error) {
	out, err := c.run(ctx, opReadPane, map[string]string{"session": session, "pane": pane})
	if err != nil {
		return "", err
	}
	// The CLI prints the text itself; accept the JSON envelope too.
	var resp struct {
		Result *struct {
			Read *struct {
				Text string `json:"text"`
			} `json:"read"`
		} `json:"result"`
	}
	if json.Unmarshal(out, &resp) == nil && resp.Result != nil && resp.Result.Read != nil {
		return resp.Result.Read.Text, nil
	}
	return string(out), nil
}

// Key is a key Control may press in a pane.
type Key string

// Keys Control may press: answering a trust dialog, and interrupting an
// agent that does not exit.
const (
	KeyDown  Key = "down"
	KeyEnter Key = "enter"
	KeyCtrlC Key = "ctrl+c"
)

var keyOps = map[Key]string{KeyDown: opKeyDown, KeyEnter: opKeyEnter, KeyCtrlC: opKeyCtrlC}

// SendKey presses one key in a pane (`pane send-keys`).
func (c *Control) SendKey(ctx context.Context, session, pane string, key Key) error {
	op, ok := keyOps[key]
	if !ok {
		return fmt.Errorf("%w: key %q", ErrNotAllowed, key)
	}
	_, err := c.run(ctx, op, map[string]string{"session": session, "pane": pane})
	return err
}

// Prompt submits a prompt to the agent in a pane (`agent prompt`, without
// waiting for the turn).
func (c *Control) Prompt(ctx context.Context, session, pane, text string) error {
	_, err := c.run(ctx, opPrompt, map[string]string{"session": session, "pane": pane, "text": text})
	return err
}

var exitOps = map[string]string{"claude": opExitClaude, "codex": opExitCodex}

// TypeExit types the harness's exit command into a pane (claude /exit,
// codex /quit), without Enter: the caller presses it (Codex needs a pause
// first).
func (c *Control) TypeExit(ctx context.Context, session, pane, harness string) error {
	op, ok := exitOps[harness]
	if !ok {
		return fmt.Errorf("%w: cannot exit harness %q", ErrNotAllowed, harness)
	}
	_, err := c.run(ctx, op, map[string]string{"session": session, "pane": pane})
	return err
}

// CloseWorkspace closes one workspace (`workspace close`, never a group).
func (c *Control) CloseWorkspace(ctx context.Context, session, workspace string) error {
	_, err := c.run(ctx, opWorkspaceClose, map[string]string{"session": session, "workspace": workspace})
	return err
}

// RemoveWorktree removes a worktree workspace's checkout and closes it
// (`worktree remove`, never --force: git refuses a dirty tree).
func (c *Control) RemoveWorktree(ctx context.Context, session, workspace string) error {
	_, err := c.run(ctx, opWorktreeRemove, map[string]string{"session": session, "workspace": workspace})
	return err
}
