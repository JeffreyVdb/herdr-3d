package mcpinv

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// approvalScopes are the places a .mcp.json approval key can be set, from
// the least to the most specific (managed settings above all). "entry" is
// the checkout's entry in ~/.claude.json: measured on 2.1.309 it counts as
// local settings, below settings.local.json, and only when it says true.
var approvalScopes = []string{"user", "project", "entry", "local", "managed"}

// wantApproval is the approval of a .mcp.json server named s as Claude Code
// decides it: each list adds up over the scopes, and the most specific
// scope that sets enableAllProjectMcpServers wins (measured with
// get_settings on 2.1.309). A project or local settings file of a folder
// not trusted may only take approvals away (docs: its approvals wait for
// the trust dialog; a disabledMcpjsonServers entry anywhere rejects).
func wantApproval(all map[string]string, enabled, disabled string, trusted bool) string {
	widens := func(scope string) bool { return trusted || scope != "project" && scope != "local" }
	if disabled != "" {
		return proto.MCPApprovalRejected
	}
	on := false
	for _, scope := range approvalScopes {
		switch v := all[scope]; {
		case v == "":
		case scope == "entry" && v == "false":
		case v == "true" && !widens(scope):
		default:
			on = v == "true"
		}
	}
	if on || enabled != "" && widens(enabled) {
		return proto.MCPApprovalApproved
	}
	return proto.MCPApprovalPending
}

// Every combination of enableAllProjectMcpServers (unset, true, false) in
// each scope, an enabledMcpjsonServers and a disabledMcpjsonServers entry
// for the server in any one scope or none, in a trusted folder and not:
// the inventory's approval and status and the check's exclusion list both
// follow the effective result.
func TestClaudeApprovalMatrix(t *testing.T) {
	home := t.TempDir()
	f := DefaultClaudeFiles("", home)
	f.Managed = filepath.Join(home, "managed")
	cwd := filepath.Join(home, "repo")
	writeJSON(t, filepath.Join(cwd, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"s": stdio("x")}})
	if err := os.MkdirAll(filepath.Join(cwd, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{"user": filepath.Join(f.Dir, "settings.json"), "project": filepath.Join(cwd, ".claude", "settings.json"),
		"local": filepath.Join(cwd, ".claude", "settings.local.json"), "managed": filepath.Join(f.Managed, "managed-settings.json")}
	listScopes := []string{"", "user", "project", "entry", "local"}
	values := []string{"", "true", "false"}
	n := 0
	var walk func(i int, all map[string]string)
	walk = func(i int, all map[string]string) {
		if i < len(approvalScopes) {
			for _, v := range values {
				all[approvalScopes[i]] = v
				walk(i+1, all)
			}
			return
		}
		for _, enabled := range listScopes {
			for _, disabled := range listScopes {
				for _, trusted := range []bool{true, false} {
					layers := map[string]map[string]any{}
					for _, scope := range approvalScopes {
						layers[scope] = map[string]any{}
						if v := all[scope]; v != "" {
							layers[scope]["enableAllProjectMcpServers"] = v == "true"
						}
					}
					if enabled != "" {
						layers[enabled]["enabledMcpjsonServers"] = []string{"s"}
					}
					if disabled != "" {
						layers[disabled]["disabledMcpjsonServers"] = []string{"s"}
					}
					layers["entry"]["hasTrustDialogAccepted"] = trusted
					writeJSON(t, f.JSON, map[string]any{"projects": map[string]any{cwd: layers["entry"]}})
					for scope, path := range paths {
						writeJSON(t, path, layers[scope])
					}
					want := wantApproval(all, enabled, disabled, trusted)
					wantStatus := map[string]string{proto.MCPApprovalApproved: proto.MCPStatusNotChecked,
						proto.MCPApprovalPending: proto.MCPStatusApprovalRequired, proto.MCPApprovalRejected: proto.MCPStatusDisabled}[want]
					name := fmt.Sprintf("enableAll=%v enabled@%q disabled@%q trusted=%v", all, enabled, disabled, trusted)
					p := ReadClaude(f, cwd)
					if len(p.Servers) != 1 || p.Servers[0].Approval != want || p.Servers[0].Status != wantStatus || p.Config.State != proto.MCPStateOK {
						t.Fatalf("%s: servers %+v, want %s (%s)", name, p.Servers, want, p.Config.Note)
					}
					excluded, ok := ClaudeUnapproved(f, cwd)
					if !ok || slices.Contains(excluded, "s") != (want != proto.MCPApprovalApproved) {
						t.Fatalf("%s: excluded %v (%v), want approval %s", name, excluded, ok, want)
					}
					n++
				}
			}
		}
	}
	walk(0, map[string]string{})
	if n != 243*25*2 {
		t.Fatalf("%d cases", n)
	}
}

// The review's case: user settings approve every project server, the
// checkout's settings.local.json says false, so an otherwise unapproved
// server stays out of the check.
func TestClaudeLocalFalseRevokesUserTrue(t *testing.T) {
	f := DefaultClaudeFiles("", t.TempDir())
	f.Managed = ""
	cwd := filepath.Join(f.Home, "proj")
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{"enableAllProjectMcpServers": true})
	writeJSON(t, filepath.Join(cwd, ".claude", "settings.local.json"), map[string]any{"enableAllProjectMcpServers": false})
	writeJSON(t, filepath.Join(cwd, ".mcp.json"), map[string]any{"mcpServers": map[string]any{"unapproved": stdio("fixture")}})
	if names, ok := ClaudeUnapproved(f, cwd); !ok || !slices.Equal(names, []string{"unapproved"}) {
		t.Fatalf("unapproved = %v %v", names, ok)
	}
}
