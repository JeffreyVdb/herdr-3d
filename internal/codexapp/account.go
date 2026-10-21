package codexapp

// #139: the checks of a worker hired or woken on a Codex profile: which
// account its server signed in to (account/read), and whether the
// account's workspace policy lets it run as herdr-3d hires it
// (configRequirements/read). docs/research/codex-accounts.md §7 and
// codex-accounts-shared-setup.md "What #139 must report".

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
)

// Account is what account/read says of a sign-in, without the email (it is
// never decoded).
type Account struct {
	// SignedIn: the reply has an account (null: not signed in).
	SignedIn bool
	// Plan is the account's planType ("team", "prolite"; "" when unsent).
	Plan string
	// ID is workspaceRouting.chatgptAccountId, the only identity the reply
	// carries (an experimental field: "" when the server does not send it).
	// Only ever compared: never stored, logged or sent.
	ID string
}

// Requirements is what configRequirements/read says of the workspace
// policy that applies.
type Requirements struct {
	// Present: the reply has requirements (null: no policy applies).
	Present bool
	// Approvals and Sandboxes are its allowed approval policies and sandbox
	// modes (nil: it does not limit them). A policy that is not a plain
	// name is listed by its kind.
	Approvals, Sandboxes []string
}

// What herdr-3d hires with (--dangerously-bypass-approvals-and-sandbox).
const (
	HireApproval = "never"
	HireSandbox  = "danger-full-access"
)

// Refuses reports whether the policy keeps a worker from running as
// herdr-3d hires it: without asking (approval never) and without a sandbox.
func (r Requirements) Refuses() bool {
	return r.Present && (r.Approvals != nil && !slices.Contains(r.Approvals, HireApproval) ||
		r.Sandboxes != nil && !slices.Contains(r.Sandboxes, HireSandbox))
}

// accountReply is account/read's result, as far as it is read.
type accountReply struct {
	Account *struct {
		PlanType string `json:"planType"`
	} `json:"account"`
	WorkspaceRouting *struct {
		ChatgptAccountID string `json:"chatgptAccountId"`
	} `json:"workspaceRouting"`
}

func (r accountReply) account() Account {
	a := Account{SignedIn: r.Account != nil}
	if r.Account != nil {
		a.Plan = r.Account.PlanType
	}
	if r.WorkspaceRouting != nil {
		a.ID = r.WorkspaceRouting.ChatgptAccountID
	}
	return a
}

// requirementsReply is configRequirements/read's result, as far as it is
// read.
type requirementsReply struct {
	Requirements *struct {
		Approvals []json.RawMessage `json:"allowedApprovalPolicies"`
		Sandboxes []json.RawMessage `json:"allowedSandboxModes"`
	} `json:"requirements"`
}

func (r requirementsReply) requirements() Requirements {
	if r.Requirements == nil {
		return Requirements{}
	}
	return Requirements{Present: true, Approvals: names(r.Requirements.Approvals), Sandboxes: names(r.Requirements.Sandboxes)}
}

// names lists policy values: a string as it is, an object by its key (a
// granular approval policy).
func names(raw []json.RawMessage) []string {
	if raw == nil {
		return nil
	}
	out := []string{}
	for _, v := range raw {
		var s string
		if json.Unmarshal(v, &s) == nil {
			out = append(out, s)
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(v, &m) == nil && len(m) == 1 {
			for k := range m {
				out = append(out, k)
			}
			continue
		}
		out = append(out, "another policy")
	}
	return out
}

// initParams is the initialize of the checks: experimentalApi, for
// workspaceRouting and the policy's experimental fields.
func initParams(version string) map[string]any {
	return map[string]any{
		"clientInfo":   map[string]any{"name": ClientName, "title": "herdr-3d", "version": version},
		"capabilities": map[string]any{"experimentalApi": true},
	}
}

// ReadProfile asks a worker's own server (its socket) which account it
// signed in to and which workspace policy applies.
func ReadProfile(ctx context.Context, sock string) (Account, Requirements, error) {
	c, err := dial(ctx, sock, nil)
	if err != nil {
		return Account{}, Requirements{}, err
	}
	defer c.close()
	if err := c.call(ctx, "initialize", initParams("profile"), nil); err != nil {
		return Account{}, Requirements{}, err
	}
	if err := c.notify(ctx, "initialized"); err != nil {
		return Account{}, Requirements{}, err
	}
	var acct accountReply
	if err := c.call(ctx, "account/read", map[string]any{"refreshToken": false}, &acct); err != nil {
		return Account{}, Requirements{}, err
	}
	var req requirementsReply
	if err := c.call(ctx, "configRequirements/read", nil, &req); err != nil {
		return acct.account(), Requirements{}, err
	}
	return acct.account(), req.requirements(), nil
}

// ReadHomeAccount asks `codex app-server` over stdio, run with env (the
// profile's CODEX_HOME) in a scratch directory, which account the home is
// signed in to: the reference a worker's server is compared with.
func ReadHomeAccount(ctx context.Context, codex string, env []string) (Account, error) {
	dir, err := os.MkdirTemp("", "h3d-account-")
	if err != nil {
		return Account{}, err
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := exec.CommandContext(ctx, codex, "app-server")
	cmd.Dir, cmd.Env = dir, env
	in, err := cmd.StdinPipe()
	if err != nil {
		return Account{}, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return Account{}, err
	}
	if err := cmd.Start(); err != nil {
		return Account{}, err
	}
	defer func() {
		in.Close()
		cancel()
		_ = cmd.Wait()
	}()
	send := func(v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		_, err = in.Write(append(b, '\n'))
		return err
	}
	lines := bufio.NewScanner(out)
	lines.Buffer(make([]byte, 64<<10), MaxMessage)
	reply := func(id string) (json.RawMessage, error) {
		for lines.Scan() {
			var m Message
			if json.Unmarshal(lines.Bytes(), &m) != nil || m.Method != "" || strings.TrimSpace(string(m.ID)) != id {
				continue // a notification, or not ours
			}
			if m.Error != nil {
				return nil, m.Error
			}
			return m.Result, nil
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return nil, errors.New("codex app-server ended before it answered")
	}
	if err := send(map[string]any{"id": 1, "method": "initialize", "params": initParams("account")}); err != nil {
		return Account{}, fmt.Errorf("initialize: %w", err)
	}
	if _, err := reply("1"); err != nil {
		return Account{}, fmt.Errorf("initialize: %w", err)
	}
	if err := send(map[string]any{"method": "initialized"}); err != nil {
		return Account{}, err
	}
	if err := send(map[string]any{"id": 2, "method": "account/read", "params": map[string]any{"refreshToken": false}}); err != nil {
		return Account{}, fmt.Errorf("account/read: %w", err)
	}
	res, err := reply("2")
	if err != nil {
		return Account{}, fmt.Errorf("account/read: %w", err)
	}
	var r accountReply
	if err := json.Unmarshal(res, &r); err != nil {
		return Account{}, fmt.Errorf("account/read: %w", err)
	}
	return r.account(), nil
}
