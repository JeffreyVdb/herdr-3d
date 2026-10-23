package mcpinv

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/execpath"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// CheckResult is one connection check: its state and note (display-safe),
// the version the probe reported, and what it saw of each server.
type CheckResult struct {
	State, Note string
	Version     string
	Rows        []Observed
}

// ClaudeRunner runs the installed Claude Code CLI for connection checks
// (a read never runs it).
type ClaudeRunner struct {
	Bin   string
	Run   Runner
	Files ClaudeFiles
	// ConfigDirEnv is the bridge's $CLAUDE_CONFIG_DIR ("": unset), given to
	// the probe explicitly: the clean environment drops every CLAUDE*.
	ConfigDirEnv string
	// Timeout bounds the whole check (0: 20 s); Poll is the interval of its
	// mcp_status polls (0: 500 ms).
	Timeout, Poll time.Duration
}

func (c ClaudeRunner) bin() string {
	if c.Bin == "" {
		return "claude"
	}
	return c.Bin
}

// Available is whether the CLI is there (looked up, never run).
func (c ClaudeRunner) Available() bool {
	_, err := exec.LookPath(execpath.Resolve(c.bin()))
	return err == nil
}

// claudeCheckArgs start the SDK's stream-json control protocol with the
// user's real setting sources (no --strict-mcp-config: the configured
// servers are what is checked), no tools, no hooks and no saved session.
// settings is the --settings JSON.
func claudeCheckArgs(settings string) []string {
	return []string{"--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
		"--no-session-persistence", "--tools", "", "--settings", settings}
}

// CheckClaude runs a connection check: a fresh Claude Code SDK process in
// cwd (an empty private dir for user scope) whose configured servers start on
// their own, polled with mcp_status every Poll until none is pending or
// Timeout (rows still pending are then connecting). Only initialize and
// mcp_status are sent: never a user message, a toggle, a reload or a call.
//
// Headless Claude Code starts the .mcp.json servers of cwd and of every
// folder above it without asking, so the ones the user has not approved
// (for user scope: all of them) are passed as disabledMcpjsonServers in
// --settings, and the ones its MCP policy blocks as deniedMcpServers by
// name (both measured on 2.1.309: such a server is then never started).
// When which ones cannot be known (one of those files is unreadable), the
// check is skipped.
func (c ClaudeRunner) CheckClaude(ctx context.Context, cwd string) (CheckResult, error) {
	if !c.Available() {
		return CheckResult{State: proto.MCPCheckSkipped, Note: "Claude Code CLI not found on the bridge"}, nil
	}
	dir, done, err := scopeDir(cwd)
	if err != nil {
		return CheckResult{}, &Failure{Note: "Claude Code check failed", Cause: err}
	}
	defer done()
	unapproved, blocked, ok := ClaudeExclusions(c.Files, cwd, dir)
	if !ok {
		return CheckResult{State: proto.MCPCheckSkipped,
			Note: "Skipped: a .mcp.json of the checkout or a folder above it could not be read, so its unapproved servers could not be kept from starting"}, nil
	}
	set := map[string]any{"disableAllHooks": true, "disabledMcpjsonServers": append([]string{}, unapproved...)}
	var deny []map[string]string
	for _, name := range blocked {
		if name != "" && name == strings.TrimSpace(name) { // what a serverName entry may be
			deny = append(deny, map[string]string{"serverName": name})
		}
	}
	if deny != nil {
		set["deniedMcpServers"] = deny
	}
	settings, err := json.Marshal(set)
	if err != nil {
		return CheckResult{}, err
	}
	timeout, poll := c.Timeout, c.Poll
	if timeout <= 0 {
		timeout = 20 * time.Second
	}
	if poll <= 0 {
		poll = 500 * time.Millisecond
	}
	var env []string
	if c.ConfigDirEnv != "" {
		env = []string{"CLAUDE_CONFIG_DIR=" + c.ConfigDirEnv}
	}
	// Timeout bounds the whole exchange (the process's own bound); the
	// polling stops early enough for the last poll's answer.
	deadline := time.Now().Add(timeout - min(2*time.Second, timeout/5))
	res, err := run(ctx, c.Run, Spawn{Bin: c.bin(), Dir: dir, Args: claudeCheckArgs(string(settings)), Env: env, Timeout: timeout},
		func(s Stream) (CheckResult, error) {
			res := CheckResult{State: proto.MCPCheckOK}
			var init struct {
				Version string `json:"claude_code_version"`
			}
			if err := s.ClaudeInit(&init); err != nil {
				return res, err
			}
			if versionText.MatchString(init.Version) {
				res.Version = init.Version
			}
			for n := 1; ; n++ {
				rows, err := claudeStatus(s, n)
				if err != nil {
					return res, err
				}
				res.Rows = rows
				pending := false
				for i := range res.Rows {
					pending = pending || res.Rows[i].Status == proto.MCPStatusConnecting
				}
				if !pending {
					return res, nil
				}
				if time.Now().Add(poll).After(deadline) {
					res.State, res.Note = proto.MCPCheckTimeout, "Some servers were still connecting when the check ended"
					return res, nil
				}
				select {
				case <-time.After(poll):
				case <-ctx.Done():
					return res, ctx.Err()
				}
			}
		})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			return CheckResult{State: proto.MCPCheckTimeout, Note: "Claude Code did not answer in time"}, nil
		}
		return CheckResult{}, &Failure{Note: "Claude Code check failed", Cause: err}
	}
	return res, nil
}

// scopeDir is where a process for cwd runs: cwd, or for user scope ("") a
// new empty private dir (no project layer of any folder), removed by done.
func scopeDir(cwd string) (dir string, done func(), err error) {
	if cwd != "" {
		return cwd, func() {}, nil
	}
	dir, err = os.MkdirTemp("", "h3d-mcp-")
	if err != nil {
		return "", nil, err
	}
	return dir, func() { _ = os.RemoveAll(dir) }, nil
}

// claudeStatusRow is one row of mcp_status (never its config or error text).
type claudeStatusRow struct {
	Name      string `json:"name"`
	Status    string `json:"status"`
	Error     string `json:"error"`
	Scope     string `json:"scope"`
	Transport string `json:"transport"`
}

// claudeStatus sends mcp_status request n and maps its rows.
func claudeStatus(s Stream, n int) ([]Observed, error) {
	id := "h3d-mcp-" + strconv.Itoa(n)
	if err := s.Send(map[string]any{"type": "control_request", "request_id": id, "request": map[string]string{"subtype": "mcp_status"}}); err != nil {
		return nil, err
	}
	for {
		var msg struct {
			Type     string `json:"type"`
			Response struct {
				RequestID string `json:"request_id"`
				Subtype   string `json:"subtype"`
				Response  struct {
					MCPServers *[]claudeStatusRow `json:"mcpServers"`
				} `json:"response"`
			} `json:"response"`
		}
		if err := s.Next(&msg); err != nil {
			return nil, err
		}
		if msg.Type != "control_response" || msg.Response.RequestID != id {
			continue
		}
		if msg.Response.Subtype != "success" || msg.Response.Response.MCPServers == nil {
			return nil, errors.New("mcp_status failed")
		}
		out := []Observed{}
		seen := map[string]bool{}
		for _, r := range *msg.Response.Response.MCPServers {
			if o, ok := r.observe(); ok && !seen[o.Name] {
				seen[o.Name] = true
				out = append(out, o)
			}
		}
		return out, nil
	}
}

func (r claudeStatusRow) observe() (Observed, bool) {
	name := cleanName(r.Name)
	if name == "" {
		return Observed{}, false
	}
	o := Observed{Name: name, Status: proto.MCPStatusUnknown, Source: proto.MCPSourceUnknown, Transport: proto.MCPTransportUnknown}
	switch r.Status {
	case "connected":
		o.Status = proto.MCPStatusConnected
	case "pending":
		o.Status = proto.MCPStatusConnecting
	case "needs-auth":
		o.Status, o.Reason = proto.MCPStatusAuthRequired, "Authentication required"
	case "failed":
		o.Status, o.Reason = proto.MCPStatusFailed, errorCategory(r.Error)
	case "disabled":
		o.Status = proto.MCPStatusDisabled
	}
	switch r.Scope {
	case "user", "project", "local", "plugin":
		o.Source = r.Scope
	case "managed", "enterprise":
		o.Source = proto.MCPSourceManaged
	case "claudeai":
		o.Source = proto.MCPSourceConnector
	}
	if p, ok := strings.CutPrefix(name, "plugin:"); ok {
		o.Source = proto.MCPSourcePlugin
		o.Plugin, _, _ = strings.Cut(p, ":")
	}
	switch r.Transport {
	case "stdio", "http", "sse":
		o.Transport = r.Transport
	}
	return o, true
}
