package mcpinv

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// ClaudeFiles are where Claude Code keeps its configuration: the bridge's
// own, as a worker it launches sees it.
type ClaudeFiles struct {
	// Dir is the config dir: $CLAUDE_CONFIG_DIR, else ~/.claude (settings,
	// plugins, skills).
	Dir string
	// JSON is the global config: $CLAUDE_CONFIG_DIR/.claude.json, else
	// ~/.claude.json (user and local servers, per-project approvals).
	JSON string
	// Managed is the managed settings dir (/etc/claude-code on Linux).
	Managed string
	// Home is the user's home, for display paths.
	Home string
}

// DefaultClaudeFiles are the bridge's: configDir is $CLAUDE_CONFIG_DIR ("":
// unset), home the user's home.
func DefaultClaudeFiles(configDir, home string) ClaudeFiles {
	f := ClaudeFiles{Dir: configDir, JSON: filepath.Join(configDir, ".claude.json"), Managed: "/etc/claude-code", Home: home}
	if configDir == "" {
		f.Dir, f.JSON = filepath.Join(home, ".claude"), filepath.Join(home, ".claude.json")
	}
	return f
}

// Notes of Claude Code's reads.
const (
	noteConnectors = "claude.ai connectors are not in the configuration files; Check connections lists them"
	noteManaged    = "Managed configuration (managed-mcp.json) decides which servers run"
	noteSkills     = "Found on disk; claude.ai-synced and lazily loaded skills are not listed"
)

// Size bounds of the files a Claude read opens.
const (
	maxConfigJSON = 64 << 20 // ~/.claude.json keeps history too
	maxSmallJSON  = 4 << 20
)

// claudeEntry is one server definition: only what is shown is decoded.
type claudeEntry struct {
	Type    string          `json:"type"`
	Command json.RawMessage `json:"command"`
	URL     json.RawMessage `json:"url"`
}

func (e claudeEntry) transport() string {
	switch strings.ToLower(e.Type) {
	case "stdio":
		return proto.MCPTransportStdio
	case "http", "streamable-http":
		return proto.MCPTransportHTTP
	case "sse":
		return proto.MCPTransportSSE
	case "":
		switch {
		case len(e.Command) > 0:
			return proto.MCPTransportStdio
		case len(e.URL) > 0:
			return proto.MCPTransportHTTP
		}
	}
	return proto.MCPTransportUnknown
}

// claudeProject is a project's entry in the global config.
type claudeProject struct {
	MCPServers         map[string]claudeEntry `json:"mcpServers"`
	DisabledMCPServers []string               `json:"disabledMcpServers"`
	approvals
	Trusted bool `json:"hasTrustDialogAccepted"`
}

// approvals are the keys that approve or reject a project's .mcp.json
// servers (in the global config's project entry and in settings files).
type approvals struct {
	Enabled   []string `json:"enabledMcpjsonServers"`
	Disabled  []string `json:"disabledMcpjsonServers"`
	EnableAll *bool    `json:"enableAllProjectMcpServers"`
}

// add layers b, a more specific source, over a (measured with get_settings
// on 2.1.309): the lists add up and b's enableAllProjectMcpServers, when
// set, replaces a's. A source that may not approve (a project settings
// file of a folder not trusted) only takes approvals away.
func (a *approvals) add(b approvals, approve bool) {
	if approve {
		a.Enabled = append(a.Enabled, b.Enabled...)
	}
	a.Disabled = append(a.Disabled, b.Disabled...)
	if b.EnableAll != nil && (approve || !*b.EnableAll) {
		a.EnableAll = b.EnableAll
	}
}

// claudeSettings are the settings keys a read uses.
type claudeSettings struct {
	EnabledPlugins map[string]json.RawMessage `json:"enabledPlugins"`
	SkillOverrides map[string]json.RawMessage `json:"skillOverrides"`
	approvals
}

// claudeRead is what one read of the files found, before it is a provider.
type claudeRead struct {
	f     ClaudeFiles
	cwd   string
	notes []string // problems, display-safe
	// merged settings: plugin key → enabled, skill name → override
	plugins   map[string]bool
	overrides map[string]string
	approve   approvals
	project   claudeProject
}

// problem notes a file that could not be read (missing files are fine).
func (r *claudeRead) problem(path, what string) {
	n := "Could not " + what + " " + Display(r.f.Home, path)
	if !slices.Contains(r.notes, n) {
		r.notes = append(r.notes, n)
	}
}

// readJSON decodes the JSON file at path into v, at most limit bytes. False
// when it is absent (no note) or unusable (noted).
func (r *claudeRead) readJSON(path string, limit int64, v any) bool {
	b, err := readFile(path, limit)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return false
	case err != nil:
		r.problem(path, "read")
		return false
	}
	if err := json.Unmarshal(b, v); err != nil {
		r.problem(path, "parse")
		return false
	}
	return true
}

// errTooLarge is a file over a read's bound.
var errTooLarge = errors.New("file too large")

// readFile reads a regular file of at most limit bytes.
func readFile(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if fi, err := f.Stat(); err != nil {
		return nil, err
	} else if !fi.Mode().IsRegular() {
		return nil, errors.New("not a regular file")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(b)) > limit {
		err = errTooLarge
	}
	return b, err
}

// settings reads the settings files of cwd from lowest to highest
// precedence: user, project, local, managed. The project entry of the
// global config counts as local settings below settings.local.json, and
// its enableAllProjectMcpServers only when true (both measured on 2.1.309).
// Project and local settings approve project servers only in a trusted
// folder (local ones also in the user's own config home); elsewhere they
// may only take approvals away.
func (r *claudeRead) settings() {
	type file struct {
		path    string
		approve bool
	}
	files := []file{{filepath.Join(r.f.Dir, "settings.json"), true}}
	if r.cwd != "" {
		home := r.cwd == filepath.Clean(r.f.Home) || r.cwd == filepath.Dir(filepath.Clean(r.f.Dir))
		files = append(files, file{filepath.Join(r.cwd, ".claude", "settings.json"), r.project.Trusted},
			file{"", true}, file{filepath.Join(r.cwd, ".claude", "settings.local.json"), r.project.Trusted || home})
	}
	if r.f.Managed != "" {
		files = append(files, file{filepath.Join(r.f.Managed, "managed-settings.json"), true})
	}
	r.plugins, r.overrides = map[string]bool{}, map[string]string{}
	for _, f := range files {
		if f.path == "" {
			entry := r.project.approvals
			if entry.EnableAll != nil && !*entry.EnableAll {
				entry.EnableAll = nil
			}
			r.approve.add(entry, f.approve)
			continue
		}
		var s claudeSettings
		if !r.readJSON(f.path, maxSmallJSON, &s) {
			continue
		}
		for k, v := range s.EnabledPlugins {
			var on bool
			r.plugins[k] = json.Unmarshal(v, &on) == nil && on
		}
		for k, v := range s.SkillOverrides {
			var o string
			if json.Unmarshal(v, &o) == nil {
				r.overrides[k] = o
			}
		}
		r.approve.add(s.approvals, f.approve)
	}
}

// plugin is an enabled, installed plugin.
type plugin struct {
	name string // without its marketplace
	root string // its install path
}

// installedPlugins are the enabled plugins with an install of cwd's or the
// user's.
func (r *claudeRead) installedPlugins() []plugin {
	var keys []string
	for k, on := range r.plugins {
		if on {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	slices.Sort(keys)
	path := filepath.Join(r.f.Dir, "plugins", "installed_plugins.json")
	var installed struct {
		Plugins map[string][]struct {
			Scope       string `json:"scope"`
			InstallPath string `json:"installPath"`
			ProjectPath string `json:"projectPath"`
		} `json:"plugins"`
	}
	if !r.readJSON(path, maxSmallJSON, &installed) {
		return nil
	}
	var out []plugin
	for _, k := range keys {
		for _, in := range installed.Plugins[k] {
			if in.ProjectPath != "" && in.ProjectPath != r.cwd || !filepath.IsAbs(in.InstallPath) {
				continue
			}
			name, _, _ := strings.Cut(k, "@")
			if name = cleanName(name); name != "" {
				out = append(out, plugin{name: name, root: filepath.Clean(in.InstallPath)})
			}
			break
		}
	}
	return out
}

// pluginServers are a plugin's server definitions: its root .mcp.json, or
// its manifest's mcpServers (inline, or files inside the plugin).
func (r *claudeRead) pluginServers(p plugin) map[string]claudeEntry {
	var root struct {
		MCPServers map[string]claudeEntry `json:"mcpServers"`
	}
	if r.readJSON(filepath.Join(p.root, ".mcp.json"), maxSmallJSON, &root) && root.MCPServers != nil {
		return root.MCPServers
	}
	var manifest struct {
		MCPServers json.RawMessage `json:"mcpServers"`
	}
	if !r.readJSON(filepath.Join(p.root, ".claude-plugin", "plugin.json"), maxSmallJSON, &manifest) || len(manifest.MCPServers) == 0 {
		return nil
	}
	out := map[string]claudeEntry{}
	if json.Unmarshal(manifest.MCPServers, &out) == nil {
		return out
	}
	var refs []string
	var one string
	if json.Unmarshal(manifest.MCPServers, &one) == nil {
		refs = []string{one}
	} else if json.Unmarshal(manifest.MCPServers, &refs) != nil {
		r.problem(filepath.Join(p.root, ".claude-plugin", "plugin.json"), "parse")
		return nil
	}
	for _, ref := range refs {
		path := filepath.Join(p.root, ref)
		if !strings.HasPrefix(path, p.root+string(filepath.Separator)) {
			continue
		}
		var file struct {
			MCPServers map[string]claudeEntry `json:"mcpServers"`
		}
		if r.readJSON(path, maxSmallJSON, &file) {
			for k, v := range file.MCPServers {
				out[k] = v
			}
		}
	}
	return out
}

// claudeConfig is what a read of the files found.
type claudeConfig struct {
	*claudeRead
	global    map[string]claudeEntry // user scope
	managed   map[string]claudeEntry
	exclusive bool                   // managed-mcp.json decides
	mcpjson   map[string]claudeEntry // the .mcp.json files of cwd and its ancestors
	mcpjsonOK bool                   // each was absent or read
	plugins   []plugin
}

func loadClaude(f ClaudeFiles, cwd string) claudeConfig {
	r := &claudeRead{f: f, cwd: cwd}
	c := claudeConfig{claudeRead: r, mcpjsonOK: true}
	var global struct {
		MCPServers map[string]claudeEntry   `json:"mcpServers"`
		Projects   map[string]claudeProject `json:"projects"`
	}
	r.readJSON(f.JSON, maxConfigJSON, &global)
	c.global = global.MCPServers
	if cwd != "" {
		r.project = global.Projects[cwd]
	}
	r.settings()
	var managed struct {
		MCPServers map[string]claudeEntry `json:"mcpServers"`
	}
	c.exclusive = f.Managed != "" && r.readJSON(filepath.Join(f.Managed, "managed-mcp.json"), maxSmallJSON, &managed)
	c.managed = managed.MCPServers
	if cwd != "" {
		c.mcpjson, c.mcpjsonOK = r.mcpJSON(cwd)
	}
	c.plugins = r.installedPlugins()
	return c
}

// mcpJSON are the project-scope servers Claude Code loads in cwd: those of
// the .mcp.json of cwd and of every ancestor up to / (also above the
// repository root), the closest definition of a name winning (measured on
// 2.1.309). ok is false when one of the files exists but could not be read.
func (r *claudeRead) mcpJSON(cwd string) (map[string]claudeEntry, bool) {
	out, ok := map[string]claudeEntry{}, true
	for d := filepath.Clean(cwd); ; {
		path := filepath.Join(d, ".mcp.json")
		if _, err := os.Lstat(path); err == nil || !errors.Is(err, fs.ErrNotExist) {
			var file struct {
				MCPServers map[string]claudeEntry `json:"mcpServers"`
			}
			if r.readJSON(path, maxSmallJSON, &file) {
				for name, e := range file.MCPServers {
					if _, closer := out[name]; !closer {
						out[name] = e
					}
				}
			} else {
				ok = false
			}
		}
		parent := filepath.Dir(d)
		if parent == d {
			return out, ok
		}
		d = parent
	}
}

// approval is a project-scope server's approval.
func (c claudeConfig) approval(name string) string {
	switch {
	case slices.Contains(c.approve.Disabled, name):
		return proto.MCPApprovalRejected
	case c.approve.EnableAll != nil && *c.approve.EnableAll || slices.Contains(c.approve.Enabled, name):
		return proto.MCPApprovalApproved
	}
	return proto.MCPApprovalPending
}

// ReadClaude reads Claude Code's configured MCP servers and skills for cwd
// ("": user scope only) from f's files, starting no process. A file that
// could not be read makes the read partial with a note naming it; a missing
// one is just not there. The skills are found on disk: never complete.
func ReadClaude(f ClaudeFiles, cwd string) proto.MCPProvider {
	c := loadClaude(f, cwd)
	p := emptyProvider()

	// Precedence: local > project > user > plugin; a name is defined once.
	seen := map[string]bool{}
	add := func(name string, e claudeEntry, source, plug string) {
		if name = cleanName(name); name == "" || seen[name] {
			return
		}
		seen[name] = true
		s := proto.MCPServer{Name: name, Source: source, Plugin: plug, Transport: e.transport(), Enabled: ptr(true),
			Approval: proto.MCPApprovalNA, Status: proto.MCPStatusNotChecked, StatusScope: proto.MCPScopeConfig}
		if source == proto.MCPSourceProject {
			s.Approval = c.approval(name)
		}
		switch {
		case c.exclusive && source != proto.MCPSourceManaged:
			s.Status, s.Reason = proto.MCPStatusBlocked, "Not allowed by managed configuration"
		case slices.Contains(c.project.DisabledMCPServers, name):
			s.Status, s.Enabled, s.Reason = proto.MCPStatusDisabled, ptr(false), "Disabled for this project"
		case s.Approval == proto.MCPApprovalRejected:
			s.Status, s.Enabled, s.Reason = proto.MCPStatusDisabled, ptr(false), "Rejected for this project"
		case s.Approval == proto.MCPApprovalPending:
			s.Status, s.Reason = proto.MCPStatusApprovalRequired, "Waiting for approval in Claude Code"
		}
		p.Servers = append(p.Servers, s)
	}
	for _, name := range sortedKeys(c.managed) {
		add(name, c.managed[name], proto.MCPSourceManaged, "")
	}
	for _, name := range sortedKeys(c.project.MCPServers) {
		add(name, c.project.MCPServers[name], proto.MCPSourceLocal, "")
	}
	for _, name := range sortedKeys(c.mcpjson) {
		add(name, c.mcpjson[name], proto.MCPSourceProject, "")
	}
	for _, name := range sortedKeys(c.global) {
		add(name, c.global[name], proto.MCPSourceUser, "")
	}
	for _, pl := range c.plugins {
		servers := c.pluginServers(pl)
		for _, name := range sortedKeys(servers) {
			add("plugin:"+pl.name+":"+name, servers[name], proto.MCPSourcePlugin, pl.name)
		}
	}

	notes := []string{}
	if c.exclusive {
		notes = append(notes, noteManaged)
	}
	notes = append(notes, c.notes...)
	p.Config.State = proto.MCPStateOK
	if len(c.notes) > 0 {
		p.Config.State = proto.MCPStatePartial
	}
	p.Config.Note = strings.Join(append(notes, noteConnectors), ". ")

	p.Skills = c.skills(c.plugins)
	return p
}

// ClaudeUnapproved are the names, exactly as written, of the .mcp.json
// servers of cwd and its ancestors that Claude Code has not been told to
// use: a headless probe in cwd would start them without asking. False when
// one of those files exists but could not be read: then which ones is not
// known.
func ClaudeUnapproved(f ClaudeFiles, cwd string) ([]string, bool) {
	if cwd == "" {
		return nil, true
	}
	c := loadClaude(f, cwd)
	if !c.mcpjsonOK {
		return nil, false
	}
	var out []string
	for _, name := range sortedKeys(c.mcpjson) {
		if c.approval(name) != proto.MCPApprovalApproved {
			out = append(out, name)
		}
	}
	return out, true
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
