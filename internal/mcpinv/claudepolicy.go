package mcpinv

import (
	"encoding/json"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Reasons of a server Claude Code's MCP policy keeps from running.
const (
	reasonDenied     = "Blocked by an MCP deny rule in Claude Code settings"
	reasonNotAllowed = "Not on the MCP allowlist in Claude Code settings"
)

// mcpRule is one allowedMcpServers / deniedMcpServers entry: a server's
// name, its URL pattern or its command line. unknown: its value uses
// ${VAR} expansion, which the bridge does not evaluate.
type mcpRule struct {
	name    string
	url     string
	command []string
	unknown bool
}

// parseRules are the entries of a policy list; set is whether the list is
// there at all (an empty allowlist allows nothing, an absent one all).
func parseRules(raw json.RawMessage) (rules []mcpRule, set bool) {
	var entries []map[string]json.RawMessage
	if len(raw) == 0 || json.Unmarshal(raw, &entries) != nil || entries == nil {
		return nil, false
	}
	for _, e := range entries {
		var r mcpRule
		switch {
		case json.Unmarshal(e["serverName"], &r.name) == nil && r.name != "":
		case json.Unmarshal(e["serverUrl"], &r.url) == nil && r.url != "":
			r.unknown = strings.Contains(r.url, "${")
		case json.Unmarshal(e["serverCommand"], &r.command) == nil && len(r.command) > 0:
			r.unknown = slices.ContainsFunc(r.command, func(s string) bool { return strings.Contains(s, "${") })
		default:
			continue
		}
		rules = append(rules, r)
	}
	return rules, true
}

// mcpPolicy is Claude Code's allowlist and denylist of MCP servers, merged
// over the settings files (docs: managed-mcp.md "How a server is
// evaluated"): the denylist from every scope; the allowlist from every
// scope, or with allowManagedMcpServersOnly only the managed one's.
type mcpPolicy struct {
	deny, allow, managedAllow    []mcpRule
	allowSet, managedSet, strict bool
}

// add merges one settings file's lists.
func (p *mcpPolicy) add(s claudeSettings, managed bool) {
	deny, _ := parseRules(s.Denied)
	p.deny = append(p.deny, deny...)
	allow, set := parseRules(s.Allowed)
	p.allow, p.allowSet = append(p.allow, allow...), p.allowSet || set
	if managed {
		p.managedAllow, p.managedSet, p.strict = allow, set, s.ManagedOnly
	}
}

// blocked is why the policy keeps the server name (as written) defined by
// e from running, "" when it does not or the bridge cannot tell. A server
// of the organization's (skipAllow) needs no allowlist entry; nothing
// overrides a deny rule.
func (p mcpPolicy) blocked(name string, e claudeEntry, skipAllow bool) string {
	cmd, cmdOK := e.commandLine()
	addr, addrOK := e.address()
	for _, r := range p.deny {
		switch {
		case r.unknown:
		case r.name != "" && r.name == name,
			r.command != nil && cmdOK && slices.Equal(r.command, cmd),
			r.url != "" && addrOK && urlMatches(r.url, addr):
			return reasonDenied
		}
	}
	allow, set := p.allow, p.allowSet
	if p.strict {
		allow, set = p.managedAllow, p.managedSet
	}
	if skipAllow || !set {
		return ""
	}
	// A server must match its kind's entry; a name counts only when the
	// list has no entry of that kind.
	var kind func(mcpRule) bool
	var match func(mcpRule) bool
	switch e.transport() {
	case proto.MCPTransportStdio:
		kind = func(r mcpRule) bool { return r.command != nil }
		match = func(r mcpRule) bool { return cmdOK && slices.Equal(r.command, cmd) }
		if !cmdOK && slices.ContainsFunc(allow, kind) {
			return ""
		}
	case proto.MCPTransportHTTP, proto.MCPTransportSSE:
		kind = func(r mcpRule) bool { return r.url != "" }
		match = func(r mcpRule) bool { return addrOK && urlMatches(r.url, addr) }
		if !addrOK && slices.ContainsFunc(allow, kind) {
			return ""
		}
	default:
		return ""
	}
	byKind := slices.ContainsFunc(allow, kind)
	for _, r := range allow {
		switch {
		case kind(r) && r.unknown:
			return "" // it might allow it
		case kind(r) && match(r), !byKind && r.name != "" && r.name == name:
			return ""
		}
	}
	return reasonNotAllowed
}

// commandLine is a stdio server's command and arguments, false when it has
// none or uses ${VAR} expansion.
func (e claudeEntry) commandLine() ([]string, bool) {
	var cmd string
	var args []string
	if json.Unmarshal(e.Command, &cmd) != nil || cmd == "" || len(e.Args) > 0 && json.Unmarshal(e.Args, &args) != nil {
		return nil, false
	}
	line := append([]string{cmd}, args...)
	return line, !slices.ContainsFunc(line, func(s string) bool { return strings.Contains(s, "${") })
}

// address is a remote server's URL, false when it has none or uses ${VAR}
// expansion.
func (e claudeEntry) address() (string, bool) {
	var u string
	if json.Unmarshal(e.URL, &u) != nil || u == "" || strings.Contains(u, "${") {
		return "", false
	}
	return u, true
}

// expands is whether a server's values use ${VAR} expansion outside env.
func (e claudeEntry) expands() bool {
	for _, raw := range []json.RawMessage{e.Command, e.Args, e.URL, e.Headers} {
		if strings.Contains(string(raw), "${") {
			return true
		}
	}
	return false
}

var managedName = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// managedServers are the managedMcpServers of managed settings that Claude
// Code loads (docs: managed-mcp.md "What an entry can contain"): an object
// of remote https servers with plain names and no ${VAR}; another shape is
// ignored, as Claude Code does.
func managedServers(raw json.RawMessage) map[string]claudeEntry {
	var all map[string]claudeEntry
	if len(raw) == 0 || json.Unmarshal(raw, &all) != nil {
		return nil
	}
	out := map[string]claudeEntry{}
	for name, e := range all {
		addr, ok := e.address()
		t := e.transport()
		if managedName.MatchString(name) && len(e.Command) == 0 && (t == proto.MCPTransportHTTP || t == proto.MCPTransportSSE) &&
			ok && strings.HasPrefix(strings.ToLower(addr), "https://") && !e.expands() {
			out[name] = e
		}
	}
	return out
}

// urlMatches is whether a serverUrl pattern matches the URL raw (docs:
// managed-mcp.md "How serverUrl entries match"): * matches anything; the
// host is matched without case or a trailing dot; a pattern without a path
// matches every path; without a port, a host written out matches only the
// scheme's default port, one with a * every port.
func urlMatches(pattern, raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	port := u.Port()
	if port == "" {
		port = defaultPort(scheme)
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}

	pScheme, rest, ok := strings.Cut(pattern, "://")
	if !ok {
		return false
	}
	authority, pPath, hasPath := strings.Cut(rest, "/")
	pHost, pPort, hasPort := authority, "", false
	if h, p, err := net.SplitHostPort(authority); err == nil {
		pHost, pPort, hasPort = h, p, true
	}
	pHost = strings.TrimSuffix(strings.ToLower(strings.Trim(pHost, "[]")), ".")
	switch {
	case !glob(strings.ToLower(pScheme), scheme), !glob(pHost, host):
		return false
	case hasPort && !glob(pPort, port):
		return false
	case !hasPort && !strings.Contains(pHost, "*") && port != defaultPort(scheme):
		return false
	}
	return !hasPath || glob("/"+pPath, path)
}

func defaultPort(scheme string) string {
	switch scheme {
	case "https":
		return "443"
	case "http":
		return "80"
	}
	return ""
}

// glob is whether s matches pattern, whose * matches any run of bytes.
func glob(pattern, s string) bool {
	p, i, star, mark := 0, 0, -1, 0
	for i < len(s) {
		switch {
		case p < len(pattern) && pattern[p] == '*':
			star, mark = p, i
			p++
		case p < len(pattern) && pattern[p] == s[i]:
			p, i = p+1, i+1
		case star >= 0: // the last * takes one more byte
			mark++
			p, i = star+1, mark
		default:
			return false
		}
	}
	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}
