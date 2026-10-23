package server

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// hireOptions is the legacy fallback when harness discovery is unavailable.
var hireOptions = proto.HireOptions{
	Claude: proto.HarnessOptions{
		Models:  []string{"claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"},
		Efforts: []string{"low", "medium", "high", "xhigh", "max"},
	},
	Codex: proto.HarnessOptions{
		Models:       []string{"gpt-6-sol", "gpt-6-luna", "gpt-6-astra"},
		Efforts:      []string{"low", "medium", "high", "xhigh", "max"},
		ExtraEfforts: map[string][]string{"gpt-6-sol": {"ultra"}, "gpt-6-astra": {"ultra"}},
		// The display names Codex's model/list reports for these ids (#200, #229).
		ModelLabels: map[string]string{"gpt-6-sol": "GPT-6-Sol", "gpt-6-luna": "GPT-6-Luna", "gpt-6-astra": "GPT-6-Astra"},
	},
}

// HireOptions returns a copy of the legacy fallback catalog.
func HireOptions() proto.HireOptions {
	c := hireOptions
	c.Codex.ExtraEfforts = map[string][]string{}
	for m, e := range hireOptions.Codex.ExtraEfforts {
		c.Codex.ExtraEfforts[m] = slices.Clone(e)
	}
	c.Claude.Models, c.Claude.Efforts = slices.Clone(c.Claude.Models), slices.Clone(c.Claude.Efforts)
	c.Codex.Models, c.Codex.Efforts = slices.Clone(c.Codex.Models), slices.Clone(c.Codex.Efforts)
	c.Codex.ModelLabels = maps.Clone(hireOptions.Codex.ModelLabels)
	return c
}

// validHireIn checks a harness/model/effort against hire options: the
// catalog's one rule (hireintent.Catalog.Check), which dictated hiring
// checks its proposals with too.
func validHireIn(all proto.HireOptions, h proto.Hire) error {
	return hireCatalog(all).Check(h.Harness, h.Model, h.Effort)
}

// Limits of the status_field setting.
const (
	maxFieldLen   = 64
	maxOptions    = 20
	maxProjectNum = 1 << 31
)

func validStatusField(f proto.StatusField) error {
	if !validLabel(f.Name) {
		return fmt.Errorf("status_field.name must be 1-%d bytes", maxFieldLen)
	}
	if len(f.Options) < 1 || len(f.Options) > maxOptions {
		return fmt.Errorf("status_field.options must have 1-%d entries", maxOptions)
	}
	seen := map[string]bool{}
	for _, o := range f.Options {
		if !validLabel(o) {
			return fmt.Errorf("status_field.options entries must be 1-%d bytes", maxFieldLen)
		}
		if seen[o] {
			return fmt.Errorf("status_field.options has %q twice", o)
		}
		seen[o] = true
	}
	return nil
}

// validExpectedMCP checks an expected_mcp list (#196) and returns its names
// trimmed: at most proto.MaxExpectedMCP, each 1-proto.MaxExpectedMCPName
// bytes of valid UTF-8 without control characters, no name twice (exact
// match). An empty list is nil: the setting is cleared.
func validExpectedMCP(list []string) ([]string, error) {
	if len(list) > proto.MaxExpectedMCP {
		return nil, fmt.Errorf("expected_mcp has %d names, the most is %d", len(list), proto.MaxExpectedMCP)
	}
	var out []string
	for _, n := range list {
		n = strings.TrimSpace(n)
		switch {
		case n == "" || len(n) > proto.MaxExpectedMCPName:
			return nil, fmt.Errorf("expected_mcp names must be 1-%d bytes", proto.MaxExpectedMCPName)
		case !utf8.ValidString(n) || strings.IndexFunc(n, unicode.IsControl) >= 0:
			return nil, fmt.Errorf("expected_mcp name %q has control characters or is not UTF-8", n)
		case slices.Contains(out, n):
			return nil, fmt.Errorf("expected_mcp has %q twice", n)
		}
		out = append(out, n)
	}
	return out, nil
}

func validLabel(s string) bool { return strings.TrimSpace(s) != "" && len(s) <= maxFieldLen }

// applySettings folds floor.settings.set args into a floor's settings:
// absent keys stay, null clears, a value (validated) replaces.
func applySettings(cur store.FloorSettings, a proto.FloorSettingsArgs, statDir func(string) error, hire proto.HireOptions) (store.FloorSettings, error) {
	next := cur
	next.StatusOptions = slices.Clone(cur.StatusOptions)
	next.ExpectedMCP = slices.Clone(cur.ExpectedMCP)
	bad := func(format string, args ...any) error { return &badArgsError{fmt.Errorf(format, args...)} }
	if a.Repo.Set {
		next.Repo = ""
		if v := a.Repo.Value; v != nil {
			if !gitremote.ValidRepo(*v) {
				return cur, bad("repo must be a GitHub owner/repo, got %q", *v)
			}
			next.Repo = *v
		}
	}
	if a.Project.Set {
		next.ProjectOwner, next.ProjectNumber = "", 0
		if v := a.Project.Value; v != nil {
			if !gitremote.ValidOwner(v.Owner) {
				return cur, bad("project.owner must be a GitHub user or organization, got %q", v.Owner)
			}
			if v.Number < 1 || v.Number >= maxProjectNum {
				return cur, bad("project.number must be a positive integer, got %d", v.Number)
			}
			next.ProjectOwner, next.ProjectNumber = v.Owner, v.Number
		}
	}
	if a.StatusField.Set {
		next.StatusField, next.StatusOptions = "", nil
		if v := a.StatusField.Value; v != nil {
			if err := validStatusField(*v); err != nil {
				return cur, &badArgsError{err}
			}
			next.StatusField, next.StatusOptions = v.Name, slices.Clone(v.Options)
		}
	}
	if a.DefaultCwd.Set {
		next.DefaultCwd = ""
		if v := a.DefaultCwd.Value; v != nil {
			dir := *v
			if !filepath.IsAbs(dir) || strings.ContainsRune(dir, 0) {
				return cur, bad("default_cwd must be an absolute path, got %q", dir)
			}
			dir = filepath.Clean(dir)
			if err := statDir(dir); err != nil {
				return cur, bad("default_cwd %q: %v", dir, err)
			}
			next.DefaultCwd = dir
		}
	}
	if a.Tracker.Set { // #184
		next.Tracker = ""
		if v := a.Tracker.Value; v != nil {
			switch *v {
			case proto.TrackerGitHub:
			case proto.TrackerKaneo:
				next.Tracker = proto.TrackerKaneo
			default:
				return cur, bad("tracker must be github or kaneo, got %q", *v)
			}
		}
	}
	if a.Kaneo.Set {
		next.KaneoWorkspaceID, next.KaneoWorkspaceName, next.KaneoProjectID, next.KaneoProjectName = "", "", "", ""
		if v := a.Kaneo.Value; v != nil {
			if validItemID(v.WorkspaceID) != nil || validItemID(v.ProjectID) != nil {
				return cur, bad("kaneo needs a workspace_id and a project_id of 1-%d bytes without control characters", maxItemID)
			}
			next.KaneoWorkspaceID, next.KaneoProjectID = v.WorkspaceID, v.ProjectID
			if v.WorkspaceID == cur.KaneoWorkspaceID && v.ProjectID == cur.KaneoProjectID {
				next.KaneoWorkspaceName, next.KaneoProjectName = cur.KaneoWorkspaceName, cur.KaneoProjectName
			}
		}
	}
	if next.Tracker == proto.TrackerKaneo && next.KaneoProjectID == "" {
		return cur, bad("a Kaneo floor needs its workspace and project: choose a project")
	}
	if a.ExpectedMCP.Set { // #196
		next.ExpectedMCP = nil
		if v := a.ExpectedMCP.Value; v != nil {
			names, err := validExpectedMCP(*v)
			if err != nil {
				return cur, &badArgsError{err}
			}
			next.ExpectedMCP = names
		}
	}
	if a.DefaultHire.Set {
		next.HireHarness, next.HireModel, next.HireEffort = "", "", ""
		if v := a.DefaultHire.Value; v != nil {
			if err := validHireIn(hire, *v); err != nil {
				return cur, &badArgsError{fmt.Errorf("default_hire.%w", err)}
			}
			next.HireHarness, next.HireModel, next.HireEffort = v.Harness, v.Model, v.Effort
		}
	}
	return next, nil
}

// isDir is the default Options.StatDir: dir exists and is a directory.
func isDir(dir string) error {
	fi, err := os.Stat(dir)
	if err != nil {
		return errors.Unwrap(err)
	}
	if !fi.IsDir() {
		return errors.New("not a directory")
	}
	return nil
}

// settingsView renders stored settings for the protocol (nil: none set).
func settingsView(s store.FloorSettings) *proto.FloorSettings {
	if s.IsZero() {
		return nil
	}
	v := &proto.FloorSettings{Repo: s.Repo, DefaultCwd: s.DefaultCwd}
	if s.ProjectNumber != 0 {
		v.Project = &proto.Project{Owner: s.ProjectOwner, Number: s.ProjectNumber}
	}
	if s.StatusField != "" {
		v.StatusField = &proto.StatusField{Name: s.StatusField, Options: slices.Clone(s.StatusOptions)}
	}
	if s.HireHarness != "" {
		v.DefaultHire = &proto.Hire{Harness: s.HireHarness, Model: s.HireModel, Effort: s.HireEffort}
	}
	v.Tracker = s.Tracker                       // #184
	v.ExpectedMCP = slices.Clone(s.ExpectedMCP) // #196
	if s.KaneoProjectID != "" {
		v.Kaneo = &proto.KaneoLink{WorkspaceID: s.KaneoWorkspaceID, WorkspaceName: s.KaneoWorkspaceName,
			ProjectID: s.KaneoProjectID, ProjectName: s.KaneoProjectName}
	}
	return v
}

// kaneoCheck is a floor's Kaneo link as Kaneo vouched for it (#184): the
// ids checked and the names to keep, the connection's generation that
// checked them, and the floor's link the save started from.
type kaneoCheck struct {
	workspaceID, workspaceName string
	projectID, projectName     string
	generation                 int64
	from                       linkIdentity
}

// linkIdentity is what makes a floor's issue board: its tracker and its
// Kaneo link (the rest of its settings may change under a save).
type linkIdentity struct {
	tracker, workspaceID, projectID string
}

func linkOf(s store.FloorSettings) linkIdentity {
	return linkIdentity{s.Tracker, s.KaneoWorkspaceID, s.KaneoProjectID}
}

// needsKaneoCheck says whether saving next over cur stores a Kaneo link
// that Kaneo has to vouch for first: a new link, or a switch to Kaneo
// (the kept link's project may be gone since).
func needsKaneoCheck(cur, next store.FloorSettings) bool {
	if next.KaneoProjectID == "" {
		return false
	}
	changed := next.KaneoWorkspaceID != cur.KaneoWorkspaceID || next.KaneoProjectID != cur.KaneoProjectID
	return changed || (next.Tracker == proto.TrackerKaneo && cur.Tracker != proto.TrackerKaneo)
}

// startFloorSettings runs floor.settings.set. A save that stores a Kaneo
// link asks Kaneo first, off the hub goroutine (the project must be a live
// project of that workspace), then applies the args again to what the
// floor has by then: stale when the floor's link or the Kaneo connection
// changed meanwhile.
func (h *Hub) startFloorSettings(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.FloorSettingsArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	a.Floor = floorArg(a.Floor, a.Session) // #58: a client from before floor ids names the session
	f, err := h.floorFor(a.Floor)
	if err != nil {
		return err
	}
	if err := h.notBusy(a.Floor, f); err != nil {
		return err
	}
	cur := h.settings[a.Floor]
	next, err := applySettings(cur, a, h.opts.StatDir, h.hireOptions())
	if err != nil {
		return err
	}
	finish := func(ctx context.Context, check *kaneoCheck) {
		err := h.setSettings(ctx, a, check)
		if err == nil {
			err = h.afterChange(ctx)
		}
		h.audit(ctx, c, cmd, err)
		h.reply(c, cmd, nil, err)
	}
	if !needsKaneoCheck(cur, next) {
		finish(ctx, nil)
		return nil
	}
	svc := h.opts.Kaneo
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no Kaneo settings", errUnsupported)
	}
	ws, project, from := next.KaneoWorkspaceID, next.KaneoProjectID, linkOf(cur)
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		p, gen, err := svc.VerifyProject(ctx, ws, project)
		check := &kaneoCheck{workspaceID: ws, projectID: project, projectName: p.Name, generation: gen, from: from}
		if err == nil { // the workspace's name, from the list the form just read (cached)
			if list, _, werr := svc.Workspaces(ctx); werr == nil {
				for _, w := range list {
					if w.ID == ws {
						check.workspaceName = w.Name
					}
				}
			}
		}
		if derr := h.doWait(ctx, func() {
			if err != nil {
				h.audit(ctx, c, cmd, err)
				h.reply(c, cmd, nil, err)
				return
			}
			finish(ctx, check)
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

// afterChange is what follows a command that changed the world (a floor's
// settings too): the buildings, the layout and the run links read again.
func (h *Hub) afterChange(ctx context.Context) error {
	if err := h.reload(ctx); err != nil {
		return err
	}
	h.syncLayout()
	h.relink() // M6 runs: a floor's repo may have changed
	return nil
}

// setSettings applies floor.settings.set. A Kaneo link it stores must be
// the one check vouched for, with the connection that is saved now, over
// the link the floor had when the save began (else the save is stale: the
// floor or the connection changed meanwhile).
func (h *Hub) setSettings(ctx context.Context, a proto.FloorSettingsArgs, check *kaneoCheck) error {
	f, err := h.floorFor(a.Floor)
	if err != nil {
		return err
	}
	if err := h.notBusy(a.Floor, f); err != nil {
		return err
	}
	cur := h.settings[a.Floor]
	next, err := applySettings(cur, a, h.opts.StatDir, h.hireOptions())
	if err != nil {
		return err
	}
	if needsKaneoCheck(cur, next) {
		if check == nil || check.workspaceID != next.KaneoWorkspaceID || check.projectID != next.KaneoProjectID || check.from != linkOf(cur) {
			return fmt.Errorf("%w: the floor's Kaneo link changed meanwhile: save again", errStale)
		}
		if l, ok := h.opts.Kaneo.Link(); !ok || l.Generation != check.generation {
			return fmt.Errorf("%w: the Kaneo connection changed meanwhile: pick the project again", errStale)
		}
		next.KaneoWorkspaceName, next.KaneoProjectName = check.workspaceName, check.projectName
	}
	if settingsEqual(cur, next) {
		return nil
	}
	if err := h.st.SetFloorSettings(ctx, a.Floor, next); err != nil {
		return err
	}
	if next.IsZero() {
		delete(h.settings, a.Floor)
	} else {
		h.settings[a.Floor] = next
	}
	h.refreshSuggested(a.Floor, f)
	return nil
}

func settingsEqual(a, b store.FloorSettings) bool {
	return reflect.DeepEqual(settingsView(a), settingsView(b))
}
