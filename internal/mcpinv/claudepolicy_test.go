package mcpinv

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
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
					excluded, _, ok := ClaudeExclusions(f, cwd, cwd)
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
	if names, _, ok := ClaudeExclusions(f, cwd, cwd); !ok || !slices.Equal(names, []string{"unapproved"}) {
		t.Fatalf("unapproved = %v %v", names, ok)
	}
}

// managedMcpServers of managed settings are managed servers above every
// other scope (a managed-mcp.json entry above them); Claude Code loads only
// remote https entries with plain names, and reads the key from managed
// settings only.
func TestReadClaudeManagedSettingsServers(t *testing.T) {
	f := DefaultClaudeFiles("", t.TempDir())
	f.Managed = filepath.Join(f.Home, "managed")
	writeJSON(t, filepath.Join(f.Managed, "managed-settings.json"), map[string]any{"managedMcpServers": map[string]any{
		"corp": map[string]any{"type": "http", "url": "https://fixture.invalid/mcp"}, "github": remote("sse"),
		"cmd": stdio("x"), "plain": map[string]any{"type": "http", "url": "http://fixture.invalid/mcp"},
		"bad name": map[string]any{"type": "http", "url": "https://fixture.invalid/mcp"},
		"expands":  map[string]any{"type": "http", "url": "https://${HOST}/mcp"}}})
	writeJSON(t, f.JSON, map[string]any{"mcpServers": map[string]any{"github": stdio("x"), "mine": stdio("x")}})
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{"managedMcpServers": map[string]any{"user-provided": remote("http")}})
	p := ReadClaude(f, "")
	want := []row{
		{"corp", "managed", "", "http", "n/a", "not_checked"},
		{"github", "managed", "", "sse", "n/a", "not_checked"},
		{"mine", "user", "", "stdio", "n/a", "not_checked"},
	}
	if got := rows(p); !slices.Equal(got, want) || p.Config.State != proto.MCPStateOK {
		t.Fatalf("servers = %v (%+v)", got, p.Config)
	}
	assertSafe(t, p)

	// managed-mcp.json defines a name first; provided servers are not
	// blocked by it.
	writeJSON(t, filepath.Join(f.Managed, "managed-mcp.json"), map[string]any{"mcpServers": map[string]any{"corp": stdio("x")}})
	want = []row{
		{"corp", "managed", "", "stdio", "n/a", "not_checked"},
		{"github", "managed", "", "sse", "n/a", "not_checked"},
		{"mine", "user", "", "stdio", "n/a", "blocked"},
	}
	if got := rows(ReadClaude(f, "")); !slices.Equal(got, want) {
		t.Fatalf("with managed-mcp.json = %v", got)
	}

	// The array form (Claude Desktop's) is ignored, not a broken file.
	writeJSON(t, filepath.Join(f.Managed, "managed-settings.json"), map[string]any{"managedMcpServers": []any{map[string]any{"name": "corp"}}})
	if p := ReadClaude(f, ""); p.Config.State != proto.MCPStateOK {
		t.Fatalf("array form = %+v", p.Config)
	}
}

// deniedMcpServers and allowedMcpServers (docs: managed-mcp.md) mark the
// servers they keep from running blocked, with the bridge's reason: the
// denylist by name, command line or URL pattern from any scope, before
// everything; the allowlist only where its kind of entry decides.
func TestReadClaudePolicy(t *testing.T) {
	type policy map[string]any
	cmd := func(c string, args ...string) map[string]any { return map[string]any{"command": c, "args": args} }
	url := func(u string) map[string]any { return map[string]any{"type": "http", "url": u} }
	servers := map[string]any{
		"named":   cmd("a"),
		"npx":     cmd("npx", "-y", "pkg"),
		"npx2":    cmd("npx", "-y", "pkg", "--flag"),
		"envcmd":  cmd("${HOME}/bin/server"),
		"remote":  url("https://mcp.example.com/api"),
		"port":    url("https://mcp.example.com:8443/api"),
		"other":   url("https://other.test/mcp"),
		"envurl":  url("https://${HOST}/mcp"),
		"unknown": map[string]any{"type": "ws", "url": "wss://x"},
	}
	cases := []struct {
		name            string
		user, local, mg policy
		blocked         map[string]string // name → reason
	}{
		{name: "no policy", blocked: map[string]string{}},
		{name: "deny by name, command and url", user: policy{"deniedMcpServers": []any{
			map[string]any{"serverName": "named"}, map[string]any{"serverCommand": []string{"npx", "-y", "pkg"}},
			map[string]any{"serverUrl": "https://mcp.example.com/*"}}},
			blocked: map[string]string{"named": reasonDenied, "npx": reasonDenied, "remote": reasonDenied}},
		{name: "deny on every port", local: policy{"deniedMcpServers": []any{map[string]any{"serverUrl": "https://mcp.example.com:*/*"}}},
			blocked: map[string]string{"remote": reasonDenied, "port": reasonDenied}},
		{name: "a deny rule of ${VAR} is not evaluated", user: policy{"deniedMcpServers": []any{map[string]any{"serverUrl": "https://${HOST}/*"}}},
			blocked: map[string]string{}},
		{name: "allow by command and url", mg: policy{"allowedMcpServers": []any{
			map[string]any{"serverCommand": []string{"npx", "-y", "pkg"}}, map[string]any{"serverUrl": "https://*.example.com/*"},
			map[string]any{"serverName": "named"}}},
			// a name counts only without entries of the server's kind; ${VAR} servers cannot be told
			blocked: map[string]string{"named": reasonNotAllowed, "npx2": reasonNotAllowed, "other": reasonNotAllowed}},
		{name: "allow by name only", user: policy{"allowedMcpServers": []any{map[string]any{"serverName": "named"}, map[string]any{"serverName": "remote"}}},
			blocked: map[string]string{"npx": reasonNotAllowed, "npx2": reasonNotAllowed, "envcmd": reasonNotAllowed, "port": reasonNotAllowed,
				"other": reasonNotAllowed, "envurl": reasonNotAllowed}},
		{name: "an empty allowlist allows nothing", local: policy{"allowedMcpServers": []any{}},
			blocked: map[string]string{"named": reasonNotAllowed, "npx": reasonNotAllowed, "npx2": reasonNotAllowed, "envcmd": reasonNotAllowed,
				"remote": reasonNotAllowed, "port": reasonNotAllowed, "other": reasonNotAllowed, "envurl": reasonNotAllowed}},
		{name: "allowlists add up over the scopes", user: policy{"allowedMcpServers": []any{map[string]any{"serverName": "named"}}},
			mg:      policy{"allowedMcpServers": []any{map[string]any{"serverName": "npx"}}},
			blocked: map[string]string{"npx2": reasonNotAllowed, "envcmd": reasonNotAllowed, "remote": reasonNotAllowed, "port": reasonNotAllowed, "other": reasonNotAllowed, "envurl": reasonNotAllowed}},
		{name: "allowManagedMcpServersOnly keeps only the managed allowlist", user: policy{"allowedMcpServers": []any{map[string]any{"serverName": "named"}}},
			mg: policy{"allowedMcpServers": []any{map[string]any{"serverName": "npx"}}, "allowManagedMcpServersOnly": true},
			blocked: map[string]string{"named": reasonNotAllowed, "npx2": reasonNotAllowed, "envcmd": reasonNotAllowed, "remote": reasonNotAllowed,
				"port": reasonNotAllowed, "other": reasonNotAllowed, "envurl": reasonNotAllowed}},
		{name: "a ${VAR} allow entry might allow anything of its kind", user: policy{"allowedMcpServers": []any{
			map[string]any{"serverCommand": []string{"${HOME}/bin/server"}}, map[string]any{"serverUrl": "https://mcp.example.com/*"}}},
			blocked: map[string]string{"port": reasonNotAllowed, "other": reasonNotAllowed}},
		{name: "deny beats allow", user: policy{"allowedMcpServers": []any{map[string]any{"serverName": "named"}}, "deniedMcpServers": []any{map[string]any{"serverName": "named"}}},
			blocked: map[string]string{"named": reasonDenied, "npx": reasonNotAllowed, "npx2": reasonNotAllowed, "envcmd": reasonNotAllowed,
				"remote": reasonNotAllowed, "port": reasonNotAllowed, "other": reasonNotAllowed, "envurl": reasonNotAllowed}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := DefaultClaudeFiles("", t.TempDir())
			f.Managed = filepath.Join(f.Home, "managed")
			cwd := filepath.Join(f.Home, "repo")
			writeJSON(t, f.JSON, map[string]any{"mcpServers": servers, "projects": map[string]any{cwd: map[string]any{"hasTrustDialogAccepted": true}}})
			for path, v := range map[string]policy{filepath.Join(f.Dir, "settings.json"): tc.user,
				filepath.Join(cwd, ".claude", "settings.local.json"): tc.local, filepath.Join(f.Managed, "managed-settings.json"): tc.mg} {
				if v != nil {
					writeJSON(t, path, v)
				}
			}
			p := ReadClaude(f, cwd)
			got := map[string]string{}
			for _, s := range p.Servers {
				if s.Status == proto.MCPStatusBlocked {
					got[s.Name] = s.Reason
				}
			}
			if !reflect.DeepEqual(got, tc.blocked) || p.Config.State != proto.MCPStateOK {
				t.Fatalf("blocked = %v, want %v (%+v)", got, tc.blocked, p.Config)
			}
			assertSafe(t, p)
			_, blocked, _ := ClaudeExclusions(f, cwd, cwd)
			if want := sortedKeys(tc.blocked); !slices.Equal(blocked, want) && len(blocked)+len(want) > 0 {
				t.Fatalf("check excludes %v, want %v", blocked, want)
			}
		})
	}
}

// The review's cases: a deny rule in user settings blocks a user server; a
// managed server of managedMcpServers needs no allowlist entry but obeys a
// deny rule.
func TestReadClaudePolicyManaged(t *testing.T) {
	f := DefaultClaudeFiles("", t.TempDir())
	f.Managed = filepath.Join(f.Home, "managed")
	writeJSON(t, f.JSON, map[string]any{"mcpServers": map[string]any{"blocked": stdio("fixture-only")}})
	writeJSON(t, filepath.Join(f.Dir, "settings.json"), map[string]any{"deniedMcpServers": []any{map[string]any{"serverName": "blocked"}, map[string]any{"serverName": "denied-corp"}}})
	writeJSON(t, filepath.Join(f.Managed, "managed-settings.json"), map[string]any{"allowedMcpServers": []any{},
		"managedMcpServers": map[string]any{"corp": map[string]any{"type": "http", "url": "https://fixture.invalid/mcp"},
			"denied-corp": map[string]any{"type": "http", "url": "https://fixture.invalid/mcp"}}})
	want := []row{
		{"corp", "managed", "", "http", "n/a", "not_checked"},
		{"denied-corp", "managed", "", "http", "n/a", "blocked"},
		{"blocked", "user", "", "stdio", "n/a", "blocked"},
	}
	if got := rows(ReadClaude(f, "")); !slices.Equal(got, want) {
		t.Fatalf("servers = %v", got)
	}
}

func TestURLMatches(t *testing.T) {
	for _, tc := range []struct {
		pattern, url string
		want         bool
	}{
		{"https://mcp.example.com/*", "https://mcp.example.com/api", true},
		{"https://mcp.example.com/*", "https://mcp.example.com", true},
		{"https://Mcp.Example.com/*", "https://mcp.example.com./api", true},
		{"https://mcp.example.com", "https://mcp.example.com/any/path", true},
		{"https://mcp.example.com/*", "https://mcp.example.com:8443/api", false},
		{"https://mcp.example.com/*", "https://mcp.example.com:443/api", true},
		{"https://mcp.example.com:8443/*", "https://mcp.example.com:8443/api", true},
		{"https://mcp.example.com:*/*", "https://mcp.example.com:8443/api", true},
		{"https://*.example.com/*", "https://a.example.com:9000/x", true},
		{"https://*.example.com/*", "https://example.com/x", false},
		{"http://localhost:*/*", "http://localhost:3000/mcp", true},
		{"*://mcp.example.com/*", "http://mcp.example.com/x", true},
		{"*://mcp.example.com/*", "http://mcp.example.com:8080/x", false},
		{"https://mcp.example.com/api/*", "https://mcp.example.com/API/x", false},
		{"https://mcp.example.com/api/*", "https://mcp.example.com/api/x", true},
		{"https://mcp.example.com/*", "http://mcp.example.com/x", false},
		{"https://mcp.example.com/*", "not a url", false},
		{"no scheme", "https://mcp.example.com/x", false},
	} {
		if got := urlMatches(tc.pattern, tc.url); got != tc.want {
			t.Errorf("urlMatches(%q, %q) = %v", tc.pattern, tc.url, got)
		}
	}
	for _, tc := range []struct {
		pattern, s string
		want       bool
	}{{"*", "", true}, {"a*b*c", "aXbYbc", true}, {"a*b", "ab", true}, {"a*b", "abc", false}, {"*.x.*", "a.x.b", true}, {"ab", "a", false}} {
		if got := glob(tc.pattern, tc.s); got != tc.want {
			t.Errorf("glob(%q, %q) = %v", tc.pattern, tc.s, got)
		}
	}
}
