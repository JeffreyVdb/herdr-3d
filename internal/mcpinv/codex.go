package mcpinv

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/execpath"
	"github.com/JeffreyVdb/herdr-3d/internal/harness"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// CodexHome is the Codex profile a read or check runs under.
type CodexHome struct {
	// Home is its CODEX_HOME, absolute (the cache key's config home).
	Home string
	// Default is the bridge's own home: CODEX_HOME is then not set, as
	// for a worker on the default profile.
	Default bool
}

// env is what a Codex process of h gets on top of the clean environment.
func (h CodexHome) env() []string {
	if h.Default || h.Home == "" {
		return nil
	}
	return []string{"CODEX_HOME=" + h.Home}
}

// Codex runs the installed Codex CLI's app-server for reads and checks.
type CodexRunner struct {
	Bin string
	// UserHome is the home of display paths.
	UserHome string
	// ReadTimeout bounds a read (0: 10 s); CheckTimeout a check (0: 15 s).
	ReadTimeout, CheckTimeout time.Duration
}

// Bounds of a Codex check's mcpServerStatus/list.
const (
	codexPageLimit = 100
	codexMaxPages  = 5
)

func (c CodexRunner) bin() string {
	if c.Bin == "" {
		return "codex"
	}
	return c.Bin
}

// missing is the provider when the CLI is not there; nil when it is.
func (c CodexRunner) missing() *proto.MCPProvider {
	if _, err := exec.LookPath(execpath.Resolve(c.bin())); err != nil {
		p := Unavailable("Codex CLI not found on the bridge")
		return &p
	}
	return nil
}

// codexInit is the part of initialize's result a read uses.
type codexInit struct {
	UserAgent string `json:"userAgent"`
}

var versionText = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z.+-]{0,32}$`)

// version is the Codex version in an app-server's userAgent
// ("herdr_3d/0.163.0 (…)"), "" when it has none.
func (i codexInit) version() string {
	first, _, _ := strings.Cut(i.UserAgent, " ")
	if _, v, ok := strings.Cut(first, "/"); ok && versionText.MatchString(v) {
		return v
	}
	return ""
}

// codexFailure is the display-safe Failure of a Codex process that did
// not get through.
func codexFailure(ctx context.Context, err error, what string) error {
	var rpc *harness.RPCError
	switch {
	case errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil:
		return &Failure{Note: "Codex app-server did not answer in time", Cause: err}
	case errors.As(err, &rpc):
		return &Failure{Note: "Codex app-server refused " + rpc.Method, Cause: err}
	case errors.Is(err, exec.ErrNotFound):
		return &Failure{Note: "Codex CLI not found on the bridge", Cause: err}
	}
	return &Failure{Note: "Codex app-server " + what + " failed", Cause: err}
}

// ReadCodex reads Codex's configured MCP servers and skills for cwd ("":
// user scope, run in an empty private dir) under home: a fresh app-server that is sent initialize,
// config/read and skills/list only (they start no MCP server). The error is
// a *Failure when the process did not get through; a refused request of
// the two leaves its half failed.
func (c CodexRunner) ReadCodex(ctx context.Context, home CodexHome, cwd string) (proto.MCPProvider, error) {
	if p := c.missing(); p != nil {
		return *p, nil
	}
	dir, done, err := scopeDir(cwd)
	if err != nil {
		return proto.MCPProvider{}, codexFailure(ctx, err, "read")
	}
	defer done()
	p, err := harness.Run(ctx, harness.Spawn{Bin: c.bin(), Dir: dir, Args: []string{"app-server"}, Env: home.env(), Timeout: c.ReadTimeout},
		func(s *harness.Stream) (proto.MCPProvider, error) {
			p := emptyProvider()
			var init codexInit
			if err := s.CodexInit(&init); err != nil {
				return p, err
			}
			p.Version = init.version()
			var cfg codexConfig
			params := map[string]any{"includeLayers": false}
			if cwd != "" {
				params["cwd"] = cwd
			}
			var rpc *harness.RPCError
			switch err := s.RPC(2, "config/read", params, &cfg); {
			case errors.As(err, &rpc):
				p.Config = proto.MCPRead{State: proto.MCPStateFailed, Note: "Codex app-server refused config/read"}
			case err != nil:
				return p, err
			default:
				p.Config.State, p.Servers = proto.MCPStateOK, cfg.servers()
			}
			var list codexSkills
			switch err := s.RPC(3, "skills/list", map[string]any{"cwds": []string{dir}}, &list); {
			case errors.As(err, &rpc):
				p.Skills.State, p.Skills.Note = proto.MCPStateFailed, "Codex app-server refused skills/list"
			case err != nil:
				return p, err
			default:
				p.Skills = list.skills(dir, c.UserHome)
			}
			return p, nil
		})
	if err != nil {
		return proto.MCPProvider{}, codexFailure(ctx, err, "read")
	}
	return p, nil
}

// codexConfig is config/read's answer: the servers' shown fields only (env,
// headers, commands and URLs are never decoded) and the origins' layer types.
type codexConfig struct {
	Config struct {
		MCPServers map[string]struct {
			Enabled *bool           `json:"enabled"`
			Command json.RawMessage `json:"command"`
			URL     json.RawMessage `json:"url"`
		} `json:"mcp_servers"`
	} `json:"config"`
	Origins map[string]struct {
		Name struct {
			Type string `json:"type"`
		} `json:"name"`
	} `json:"origins"`
}

// codexLayer maps a config layer's type to a source.
func codexLayer(t string) string {
	switch t {
	case "user":
		return proto.MCPSourceUser
	case "project":
		return proto.MCPSourceProject
	case "system", "packagedDefaults":
		return proto.MCPSourceSystem
	case "mdm", "enterpriseManaged", "legacyManagedConfigTomlFromFile", "legacyManagedConfigTomlFromMdm":
		return proto.MCPSourceManaged
	}
	return proto.MCPSourceUnknown
}

func (c codexConfig) source(name string) string {
	prefix := "mcp_servers." + name + "."
	var keys []string
	for k := range c.Origins {
		if strings.HasPrefix(k, prefix) {
			keys = append(keys, k)
		}
	}
	if len(keys) == 0 {
		return proto.MCPSourceUnknown
	}
	slices.Sort(keys)
	pick := keys[0]
	for _, leaf := range []string{"command", "url"} { // the layer that defines it
		if slices.Contains(keys, prefix+leaf) {
			pick = prefix + leaf
			break
		}
	}
	return codexLayer(c.Origins[pick].Name.Type)
}

func (c codexConfig) servers() []proto.MCPServer {
	out := []proto.MCPServer{}
	for _, raw := range sortedKeys(c.Config.MCPServers) {
		name := cleanName(raw)
		if name == "" {
			continue
		}
		e := c.Config.MCPServers[raw]
		s := proto.MCPServer{Name: name, Source: c.source(raw), Transport: proto.MCPTransportUnknown, Enabled: e.Enabled,
			Approval: proto.MCPApprovalNA, Status: proto.MCPStatusNotChecked, StatusScope: proto.MCPScopeConfig}
		switch {
		case len(e.URL) > 0 && string(e.URL) != "null":
			s.Transport = proto.MCPTransportHTTP
		case len(e.Command) > 0 && string(e.Command) != "null":
			s.Transport = proto.MCPTransportStdio
		}
		if e.Enabled != nil && !*e.Enabled {
			s.Status, s.Reason = proto.MCPStatusDisabled, "Disabled in config"
		}
		out = append(out, s)
	}
	return out
}

// codexSkills is skills/list's answer (the fields used).
type codexSkills struct {
	Data *[]codexSkillGroup `json:"data"`
}

type codexSkillGroup struct {
	Cwd    string `json:"cwd"`
	Skills []struct {
		Name             string  `json:"name"`
		Description      string  `json:"description"`
		ShortDescription *string `json:"shortDescription"`
		Interface        *struct {
			ShortDescription *string `json:"shortDescription"`
		} `json:"interface"`
		Path     string  `json:"path"`
		Scope    string  `json:"scope"`
		Enabled  *bool   `json:"enabled"`
		PluginID *string `json:"pluginId"`
	} `json:"skills"`
	Errors []struct {
		Path    string `json:"path"`
		Message string `json:"message"`
	} `json:"errors"`
}

func (l codexSkills) skills(dir, home string) proto.MCPSkills {
	out := proto.MCPSkills{State: proto.MCPStateOK, Complete: true, Items: []proto.MCPSkill{}, Errors: []proto.MCPSkillError{}}
	if l.Data == nil {
		out.State, out.Complete, out.Note = proto.MCPStateFailed, false, "Codex app-server returned no skills"
		return out
	}
	groups := *l.Data
	g := slices.IndexFunc(groups, func(e codexSkillGroup) bool { return filepath.Clean(e.Cwd) == filepath.Clean(dir) })
	if g < 0 && len(groups) == 1 {
		g = 0
	}
	if g < 0 {
		out.State, out.Complete, out.Note = proto.MCPStateFailed, false, "Codex app-server returned no skills for this checkout"
		return out
	}
	for _, s := range groups[g].Skills {
		name := cleanName(s.Name)
		if name == "" {
			continue
		}
		desc := s.Description
		if s.ShortDescription != nil && *s.ShortDescription != "" {
			desc = *s.ShortDescription
		}
		if s.Interface != nil && s.Interface.ShortDescription != nil && *s.Interface.ShortDescription != "" {
			desc = *s.Interface.ShortDescription
		}
		source := proto.MCPSourceUnknown
		switch s.Scope {
		case "user", "repo", "system", "admin":
			source = s.Scope
		}
		skill := proto.MCPSkill{Name: name, Description: cleanText(desc), Source: source, Enabled: s.Enabled,
			Invocation: proto.MCPInvocationUnknown, Where: skillWhere(home, s.Path)}
		if s.PluginID != nil {
			id, _, _ := strings.Cut(*s.PluginID, "@")
			if skill.Plugin = cleanName(id); skill.Plugin != "" {
				skill.Source = proto.MCPSourcePlugin
			}
		}
		out.Items = append(out.Items, skill)
	}
	for _, e := range groups[g].Errors {
		out.Errors = append(out.Errors, proto.MCPSkillError{Where: skillWhere(home, e.Path), Message: skillErrorCategory(e.Message)})
	}
	return out
}

// skillWhere is a skill's folder for display ("" for a path that is not one).
func skillWhere(home, path string) string {
	if !filepath.IsAbs(path) {
		return ""
	}
	if filepath.Base(path) == "SKILL.md" {
		path = filepath.Dir(path)
	}
	return cleanName(Display(home, filepath.Clean(path)))
}

// skillErrorCategory is the bridge's phrase for a skill's load error.
func skillErrorCategory(msg string) string {
	m := strings.ToLower(msg)
	switch {
	case strings.Contains(m, "missing field"), strings.Contains(m, "front matter"), strings.Contains(m, "frontmatter"),
		strings.Contains(m, "yaml"), strings.Contains(m, "invalid"), strings.Contains(m, "parse"):
		return "Invalid SKILL.md front matter"
	case strings.Contains(m, "permission"), strings.Contains(m, "read"):
		return "Unreadable SKILL.md"
	}
	return "Skill failed to load"
}

// CodexStatus is one row of mcpServerStatus/list (the fields used: never
// toolsError's text, httpOrigin, tools or resources).
type CodexStatus struct {
	Name          string          `json:"name"`
	RuntimeStatus *string         `json:"runtimeStatus"`
	PluginID      *string         `json:"pluginId"`
	ServerInfo    json.RawMessage `json:"serverInfo"`
	ToolsError    *string         `json:"toolsError"`
	AuthStatus    string          `json:"authStatus"`
}

// Observed is one server's status as a check or a worker saw it.
type Observed struct {
	Name, Status, Reason string
	Source, Plugin       string // for a server the config read did not list
	Transport            string
}

// observe maps a status row: a worker's runtimeStatus directly when it has
// one, else the probe's evidence (serverInfo: connected; notLoggedIn: auth
// required; toolsError: failed, its text reduced to a category). A row with
// none of them is unknown.
func (r CodexStatus) observe() (Observed, bool) {
	name := cleanName(r.Name)
	if name == "" {
		return Observed{}, false
	}
	o := Observed{Name: name, Source: proto.MCPSourceUnknown, Transport: proto.MCPTransportUnknown, Status: proto.MCPStatusUnknown}
	if r.PluginID != nil {
		id, _, _ := strings.Cut(*r.PluginID, "@")
		if o.Plugin = cleanName(id); o.Plugin != "" {
			o.Source = proto.MCPSourcePlugin
		}
	}
	if r.RuntimeStatus != nil {
		switch *r.RuntimeStatus {
		case "notStarted":
			o.Status, o.Reason = proto.MCPStatusNotChecked, "Not started yet"
		case "starting":
			o.Status = proto.MCPStatusConnecting
		case "connected":
			o.Status = proto.MCPStatusConnected
		case "authenticationRequired":
			o.Status, o.Reason = proto.MCPStatusAuthRequired, "Authentication required"
		case "failed":
			o.Status, o.Reason = proto.MCPStatusFailed, "Startup failed"
			if r.ToolsError != nil {
				o.Reason = errorCategory(*r.ToolsError)
			}
		case "cancelled":
			o.Status, o.Reason = proto.MCPStatusFailed, "Startup cancelled"
		case "disabled":
			o.Status = proto.MCPStatusDisabled
		}
		return o, true
	}
	switch {
	case len(r.ServerInfo) > 0 && string(r.ServerInfo) != "null":
		o.Status = proto.MCPStatusConnected
	case r.AuthStatus == "notLoggedIn":
		o.Status, o.Reason = proto.MCPStatusAuthRequired, "Authentication required"
	case r.ToolsError != nil:
		o.Status, o.Reason = proto.MCPStatusFailed, errorCategory(*r.ToolsError)
	}
	return o, true
}

// errorCategory is the bridge's phrase for a server's error text.
func errorCategory(text string) string {
	m := strings.ToLower(text)
	switch {
	case strings.Contains(m, "auth"), strings.Contains(m, "401"), strings.Contains(m, "403"), strings.Contains(m, "unauthorized"):
		return "Authentication failed"
	case strings.Contains(m, "connection closed"):
		return "Connection closed"
	case strings.Contains(m, "timed out"), strings.Contains(m, "timeout"):
		return "Timed out"
	case strings.Contains(m, "not found"), strings.Contains(m, "no such file"):
		return "Command not found"
	case strings.Contains(m, "refused"):
		return "Connection refused"
	}
	return "Startup failed"
}

// MapCodexStatuses maps status rows to observations, one per name.
func MapCodexStatuses(rows []CodexStatus) []Observed {
	out := []Observed{}
	seen := map[string]bool{}
	for _, r := range rows {
		if o, ok := r.observe(); ok && !seen[o.Name] {
			seen[o.Name] = true
			out = append(out, o)
		}
	}
	return out
}

// CheckCodex runs a connection check: a fresh app-server under home in cwd
// asked mcpServerStatus/list without a thread (it starts every enabled
// server, on each page), limit 100, at most 5 pages.
func (c CodexRunner) CheckCodex(ctx context.Context, home CodexHome, cwd string) (CheckResult, error) {
	if c.missing() != nil {
		return CheckResult{State: proto.MCPCheckSkipped, Note: "Codex CLI not found on the bridge"}, nil
	}
	timeout := c.CheckTimeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	dir, done, err := scopeDir(cwd)
	if err != nil {
		return CheckResult{}, codexFailure(ctx, err, "check")
	}
	defer done()
	res, err := harness.Run(ctx, harness.Spawn{Bin: c.bin(), Dir: dir, Args: []string{"app-server"}, Env: home.env(), Timeout: timeout},
		func(s *harness.Stream) (CheckResult, error) {
			res := CheckResult{State: proto.MCPCheckOK}
			var init codexInit
			if err := s.CodexInit(&init); err != nil {
				return res, err
			}
			res.Version = init.version()
			var rows []CodexStatus
			cursor := ""
			seen := map[string]bool{}
			for page := 0; ; page++ {
				params := map[string]any{"limit": codexPageLimit, "detail": "toolsAndAuthOnly"}
				if cursor != "" {
					params["cursor"] = cursor
				}
				var resp struct {
					Data       []CodexStatus `json:"data"`
					NextCursor *string       `json:"nextCursor"`
				}
				if err := s.RPC(page+2, "mcpServerStatus/list", params, &resp); err != nil {
					return res, err
				}
				rows = append(rows, resp.Data...)
				if resp.NextCursor == nil || *resp.NextCursor == "" || seen[*resp.NextCursor] {
					break
				}
				if page+1 >= codexMaxPages {
					res.Note = "More servers than one check reads; the rest were not checked"
					break
				}
				cursor = *resp.NextCursor
				seen[cursor] = true
			}
			res.Rows = MapCodexStatuses(rows)
			return res, nil
		})
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil {
			return CheckResult{State: proto.MCPCheckTimeout, Note: "Codex app-server did not answer in time"}, nil
		}
		return CheckResult{}, codexFailure(ctx, err, "check")
	}
	return res, nil
}
