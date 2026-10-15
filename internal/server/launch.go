package server

// M6 launch: team presets (preset.*), run.prepare and run.start (a
// write-code orchestrator hired through the worker.hire path, its first
// prompt composed from a ticket and a preset), run_launch and each floor's
// last preset.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/gitremote"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// Limits of run.prepare / run.start.
const (
	maxRunText  = 4096
	maxRunExtra = 8192
	maxIssue    = 1<<31 - 1
	// maxRunDescr bounds an orchestrator label's descr (ORCH|<descr>), as
	// write-code names its workspace.
	maxRunDescr = 10
	// buildTeam is the seeded preset, the default after the floor's last.
	buildTeam = "Build team"
)

// loadLaunch reads the presets, the floors' last presets and the launches
// still waiting for their run id.
func (h *Hub) loadLaunch(ctx context.Context) error {
	ps, err := h.st.Presets(ctx)
	if err != nil {
		return err
	}
	h.presets = map[string]store.Preset{}
	for _, p := range ps {
		h.presets[p.ID] = p
	}
	if h.lastPreset, err = h.st.LastPresets(ctx); err != nil {
		return err
	}
	pending, err := h.st.PendingRunLaunches(ctx)
	if err != nil {
		return err
	}
	h.runPending = map[string]bool{}
	for _, id := range pending {
		h.runPending[id] = true
	}
	return nil
}

func presetView(p store.Preset) proto.Preset {
	v := func(x store.Hire) proto.Hire { return proto.Hire{Harness: x.Harness, Model: x.Model, Effort: x.Effort} }
	return proto.Preset{ID: p.ID, Name: p.Name, Seeded: p.Seeded, Roles: proto.PresetRoles{
		Orch: v(p.Roles.Orch), Coder: v(p.Roles.Coder), Reviewer: v(p.Roles.Reviewer), UX: v(p.Roles.UX),
		Researcher: v(p.Roles.Researcher)}}
}

func storeRoles(r proto.PresetRoles) store.PresetRoles {
	v := func(x proto.Hire) store.Hire { return store.Hire{Harness: x.Harness, Model: x.Model, Effort: x.Effort} }
	return store.PresetRoles{Orch: v(r.Orch), Coder: v(r.Coder), Reviewer: v(r.Reviewer), UX: v(r.UX), Researcher: v(r.Researcher)}
}

// presetViews returns the presets by name ignoring case (the snapshot's
// order, and the first one run.prepare falls back to).
func (h *Hub) presetViews() []proto.Preset {
	out := make([]proto.Preset, 0, len(h.presets))
	for _, p := range h.presets {
		out = append(out, presetView(p))
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// lastPresetOf is a floor's last_preset: "" when none or deleted.
func (h *Hub) lastPresetOf(session string) string {
	id := h.lastPreset[session]
	if _, ok := h.presets[id]; !ok {
		return ""
	}
	return id
}

// validRoles checks all five roles against hire_options.
func (h *Hub) validRoles(r proto.PresetRoles) error {
	opts := h.hireOptions()
	for _, role := range []struct {
		name string
		hire proto.Hire
	}{{"orch", r.Orch}, {"coder", r.Coder}, {"reviewer", r.Reviewer}, {"ux", r.UX}, {"researcher", r.Researcher}} {
		if err := validHireIn(opts, role.hire); err != nil {
			return bad("roles.%s: %v", role.name, err)
		}
	}
	return nil
}

// presetCommand runs preset.create, preset.update and preset.delete.
func (h *Hub) presetCommand(ctx context.Context, cmd proto.Command) (any, error) {
	switch cmd.T {
	case proto.CmdPresetCreate:
		var a proto.PresetCreateArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return nil, err
		}
		if err := h.validRoles(a.Roles); err != nil {
			return nil, err
		}
		p, err := h.st.CreatePreset(ctx, "p_"+randHex(6), a.Name, storeRoles(a.Roles))
		if err != nil {
			return nil, err
		}
		h.presets[p.ID] = p
		v := presetView(p)
		h.emit(proto.Event{T: proto.EvPresetUpsert, Preset: &v})
		return map[string]string{"id": p.ID}, nil

	case proto.CmdPresetUpdate:
		var a proto.PresetUpdateArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return nil, err
		}
		cur, ok := h.presets[a.ID]
		if !ok {
			return nil, fmt.Errorf("%w: preset %q", store.ErrNotFound, a.ID)
		}
		next := cur
		if a.Name != nil {
			name, err := store.CleanPresetName(*a.Name)
			if err != nil {
				return nil, err
			}
			next.Name = name
		}
		if a.Roles != nil {
			if err := h.validRoles(*a.Roles); err != nil {
				return nil, err
			}
			next.Roles = storeRoles(*a.Roles)
		}
		if next == cur {
			return nil, nil
		}
		if err := h.st.UpdatePreset(ctx, next); err != nil {
			return nil, err
		}
		h.presets[next.ID] = next
		v := presetView(next)
		h.emit(proto.Event{T: proto.EvPresetUpsert, Preset: &v})
		return nil, nil

	case proto.CmdPresetDelete:
		var a proto.PresetDeleteArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return nil, err
		}
		if _, ok := h.presets[a.ID]; !ok {
			return nil, fmt.Errorf("%w: preset %q", store.ErrNotFound, a.ID)
		}
		if err := h.st.DeletePreset(ctx, a.ID); err != nil {
			return nil, err
		}
		delete(h.presets, a.ID)
		for s, id := range h.lastPreset {
			if id == a.ID {
				delete(h.lastPreset, s) // the store cascades; the floor.upsert follows
			}
		}
		h.emit(proto.Event{T: proto.EvPresetRemoved, ID: a.ID})
		return nil, nil
	}
	return nil, fmt.Errorf("%w: %q", errUnknownCommand, cmd.T)
}

// runPreset is the preset of a run: the one asked for (not_found if it is
// not there), else the floor's last, else "Build team", else the first by
// name. ok is false when there is no preset at all.
func (h *Hub) runPreset(session, id string) (p store.Preset, ok bool, err error) {
	if id != "" {
		if p, ok = h.presets[id]; !ok {
			return p, false, fmt.Errorf("%w: preset %q", store.ErrNotFound, id)
		}
		return p, true, nil
	}
	if p, ok = h.presets[h.lastPreset[session]]; ok {
		return p, true, nil
	}
	views := h.presetViews()
	for _, v := range views {
		if strings.EqualFold(v.Name, buildTeam) {
			return h.presets[v.ID], true, nil
		}
	}
	if len(views) > 0 {
		return h.presets[views[0].ID], true, nil
	}
	return store.Preset{}, false, nil
}

var (
	issueNumRe = regexp.MustCompile(`^#?([0-9]+)$`)
	issueURLRe = regexp.MustCompile(`^https://github\.com/([^/\s]+/[^/\s]+)/issues/([0-9]+)/?$`)
)

// runTicketOf is a run's ticket from its issue, text or work_item (nil when
// none is given). A work_item the floor's provider has to be asked about (a
// board not polled yet; #184 any item that is no GitHub issue, for its
// text) returns no ticket but the call that resolves it, to run off the hub
// goroutine (see workItemTicket).
func (h *Hub) runTicketOf(session string, f *floorState, issue json.RawMessage, text string,
	item *proto.WorkItemRef) (*proto.RunTicket, func(context.Context) (*proto.RunTicket, error), error) {
	if item != nil { // M7 boards: a card of the floor's issue provider
		if (len(issue) > 0 && string(issue) != "null") || text != "" {
			return nil, nil, bad("give one of an issue, a text and a work_item")
		}
		return h.workItemTicket(session, item)
	}
	t, err := h.runTicket(session, f, issue, text)
	return t, nil, err
}

// runTicket reads a run's ticket from its issue or text (nil when neither
// is given). An issue number takes the floor's effective repo.
func (h *Hub) runTicket(session string, f *floorState, issue json.RawMessage, text string) (*proto.RunTicket, error) {
	hasIssue := len(issue) > 0 && string(issue) != "null"
	if hasIssue && text != "" {
		return nil, bad("give either an issue or a text, not both")
	}
	if text != "" {
		t := strings.TrimSpace(text)
		if t == "" || len(t) > maxRunText || !utf8.ValidString(t) || strings.ContainsRune(t, 0) {
			return nil, bad("text must be 1-%d bytes of text", maxRunText)
		}
		return &proto.RunTicket{Kind: proto.TicketText, Text: t}, nil
	}
	if !hasIssue {
		return nil, nil
	}
	var repo, digits string
	var s string
	if err := json.Unmarshal(issue, &s); err == nil {
		s = strings.TrimSpace(s)
		if m := issueURLRe.FindStringSubmatch(s); m != nil {
			repo, digits = m[1], m[2]
			if !gitremote.ValidRepo(repo) {
				return nil, bad("issue URL %q does not name a GitHub owner/repo", s)
			}
		} else if m := issueNumRe.FindStringSubmatch(s); m != nil {
			digits = m[1]
		} else {
			return nil, bad("issue must be a number, \"#<n>\" or https://github.com/<owner>/<repo>/issues/<n>, got %q", s)
		}
	} else {
		var n json.Number
		if err := json.Unmarshal(issue, &n); err != nil {
			return nil, bad("issue must be a number or a string")
		}
		digits = n.String()
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n < 1 || n > maxIssue {
		return nil, bad("issue must be a positive integer, got %s", digits)
	}
	if repo == "" {
		repo = h.settings[session].Repo
		if repo == "" && f.suggested != nil {
			repo = f.suggested.Repo
		}
		if repo == "" {
			return nil, bad("the floor has no linked repo: set its repo, or give the issue's URL")
		}
	}
	return &proto.RunTicket{Kind: proto.TicketIssue, Repo: repo, Number: n, URL: IssueURL(repo, n)}, nil
}

// ref is how the prompt names the ticket.
func ticketRef(t *proto.RunTicket) string {
	if t.Kind == proto.TicketIssue {
		return t.URL
	}
	return t.Text
}

// runLabel is an orchestrator's default label: ORCH|issue-<n>, ORCH|<key>
// for an item (#184), or ORCH| and the first words of the text as a slug;
// the descr at most 10 bytes.
func runLabel(t *proto.RunTicket) string {
	if t.Kind == proto.TicketIssue {
		d := "issue-" + strconv.Itoa(t.Number)
		return "ORCH|" + d[:min(len(d), maxRunDescr)]
	}
	words := t.Text
	if t.Kind == proto.TicketItem && t.Item != nil {
		if d := strings.Trim(slugRun.ReplaceAllString(strings.ToLower(t.Item.Key), "-"), "-"); d != "" {
			return "ORCH|" + strings.TrimRight(d[:min(len(d), maxRunDescr)], "-")
		}
		words = t.Item.Title
	}
	var d string
	for _, w := range strings.Split(strings.Trim(slugRun.ReplaceAllString(strings.ToLower(words), "-"), "-"), "-") {
		switch {
		case w == "":
		case d == "":
			d = w[:min(len(w), maxRunDescr)]
		case len(d)+1+len(w) <= maxRunDescr:
			d += "-" + w
		default:
			return "ORCH|" + d
		}
	}
	if d == "" {
		d = "run"
	}
	return "ORCH|" + d
}

func validExtra(extra string) error {
	if len(extra) > maxRunExtra || !utf8.ValidString(extra) || strings.ContainsRune(extra, 0) {
		return bad("extra must be at most %d bytes of text", maxRunExtra)
	}
	return nil
}

// startRunPrepare answers run.prepare: the defaults, label and prompt now,
// the git state and host load off the hub goroutine (as hire.prepare).
func (h *Hub) startRunPrepare(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.RunPrepareArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	a.Floor = floorArg(a.Floor, a.Session) // #58: a client from before floor ids names the session
	f, err := h.prepareFloor(a.Floor)
	if err != nil {
		return err
	}
	ticket, resolve, err := h.runTicketOf(a.Floor, f, a.Issue, a.Text, a.WorkItem)
	if err != nil {
		return err
	}
	if err := validExtra(a.Extra); err != nil {
		return err
	}
	p, havePreset, err := h.runPreset(a.Floor, a.Preset)
	if err != nil {
		return err
	}
	var orch *proto.Hire
	switch {
	case a.Orch != nil:
		if err := validHireIn(h.hireOptions(), *a.Orch); err != nil {
			return bad("orch: %v", err)
		}
		o := *a.Orch
		orch = &o
	case havePreset:
		o := presetView(p).Roles.Orch
		orch = &o
	}
	cwd, err := h.hireCwd(a.Floor, f, "")
	if err != nil {
		return err
	}
	res := proto.RunPrepareResult{Preset: p.ID, Orch: orch, Cwd: cwd, Capacity: h.capacity(a.Floor)}
	roles := presetView(p).Roles
	compose := func(t *proto.RunTicket) {
		res.Ticket = t
		if t != nil {
			res.Label = runLabel(t)
			if havePreset && orch != nil {
				res.Prompt = TicketPrompt(h.writeCodeCall(orch.Harness), t, roles, a.Extra)
			}
		}
	}
	compose(ticket)
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		if resolve != nil {
			t, err := resolve(ctx)
			if err != nil {
				return nil, err
			}
			compose(t)
		}
		res.Git = h.gitInfo(ctx, cwd)
		if h.opts.Load != nil {
			res.Capacity.Load = h.opts.Load()
		}
		return res, nil
	})
	return nil
}

// startRunStart validates run.start and starts its orchestrator's hire
// (beginHire, worker.hire's path) with the composed or edited prompt; the
// hire's success records the launch and the floor's last preset.
func (h *Hub) startRunStart(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.RunStartArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	a.Floor = floorArg(a.Floor, a.Session) // #58: a client from before floor ids names the session
	switch {
	case a.DeskIndex == nil:
		return bad("desk_index is required")
	case a.Orch == nil:
		return bad("orch is required")
	case a.Preset == "":
		return bad("preset is required")
	}
	// #58 decision 3: an asleep virtual floor's session wakes first.
	if waking, err := h.wakeForHire(ctx, c, cmd, a.Floor, func(ctx context.Context) error {
		return h.runStart(ctx, c, cmd, a, nil)
	}); waking || err != nil {
		return err
	}
	return h.runStart(ctx, c, cmd, a, nil)
}

// runStart is startRunStart after the args are read. A work_item that the
// floor's provider must vouch for or describe (see runTicketOf) is resolved
// off the hub goroutine, then the start goes on from here with its ticket:
// stale when the floor's board source changed meanwhile (#184: another
// tracker, Kaneo connection or project), the item being of the old one.
func (h *Hub) runStart(ctx context.Context, c *Client, cmd proto.Command, a proto.RunStartArgs, resolved *proto.RunTicket) error {
	f, err := h.hireFloor(a.Floor)
	if err != nil {
		return err
	}
	ticket, resolve, err := resolved, (func(context.Context) (*proto.RunTicket, error))(nil), error(nil)
	if ticket == nil {
		ticket, resolve, err = h.runTicketOf(a.Floor, f, a.Issue, a.Text, a.WorkItem)
	}
	if err != nil {
		return err
	}
	if resolve != nil {
		source := h.boardKey(a.Floor)
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			t, err := resolve(ctx)
			if derr := h.doWait(ctx, func() {
				if err == nil && h.boardKey(a.Floor) != source {
					err = fmt.Errorf("%w: the floor's issue board changed while its item was read: pick the item again", errStale)
				}
				if err == nil {
					err = h.runStart(ctx, c, cmd, a, t)
				}
				if err != nil {
					h.audit(ctx, c, cmd, err)
					h.reply(c, cmd, nil, err)
				}
			}); derr != nil {
				h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
			}
		}()
		return nil
	}
	if ticket == nil {
		return bad("an issue or a text is required")
	}
	if err := validExtra(a.Extra); err != nil {
		return err
	}
	if a.Orch == nil {
		return bad("orch is required")
	}
	if a.Preset == "" {
		return bad("preset is required")
	}
	p, ok := h.presets[a.Preset]
	if !ok {
		return fmt.Errorf("%w: preset %q", store.ErrNotFound, a.Preset)
	}
	// #39: what was typed (the extra, or an edited prompt whole) is
	// translated for the orchestrator's harness when the hire sends it, never
	// the ticket the bridge composes around the extra (an issue's text).
	prompt := a.Prompt
	var compose firstPrompt
	if prompt == "" {
		call, roles := h.writeCodeCall(a.Orch.Harness), presetView(p).Roles
		prompt = TicketPrompt(call, ticket, roles, a.Extra)
		compose = func(tr func(string) string) string { return TicketPrompt(call, ticket, roles, tr(a.Extra)) }
	}
	label := a.Label
	if label == "" {
		label = runLabel(ticket)
	}
	worktree := a.Worktree == nil || *a.Worktree
	launch := store.RunLaunch{ID: "l_" + randHex(8), Session: f.session, FloorID: a.Floor, PresetID: p.ID, PresetName: p.Name}
	switch {
	case ticket.Kind == proto.TicketIssue:
		launch.Repo, launch.IssueNumber = ticket.Repo, ticket.Number
	case ticket.Kind == proto.TicketItem && ticket.Item != nil: // #184: {provider, id}, never a repo or a number
		launch.ItemProvider, launch.ItemID, launch.ItemKey = ticket.Item.Provider, ticket.Item.ID, ticket.Item.Key
	default:
		launch.TicketText = ticket.Text
	}
	hire := proto.WorkerHireArgs{Floor: a.Floor, Session: f.session, DeskIndex: a.DeskIndex, Harness: a.Orch.Harness, Model: a.Orch.Model,
		Effort: a.Orch.Effort, Label: label, Worktree: worktree, Prompt: prompt}
	return h.beginHire(ctx, c, cmd, hire, func(ctx context.Context, res proto.HireResult, rep *hireReport, sent string) any {
		launch.OrchWorkerID = res.ID
		rep.Launch = launch.ID
		if err := h.st.RecordRunLaunch(ctx, launch); err != nil {
			h.log.Error("recording the run launch failed", "worker", res.ID, "launch", launch.ID, "err", err)
			rep.step("recording the launch failed: %v", err)
		} else {
			h.runPending[res.ID] = true
			h.fillRunIDs(ctx)
			// The first observation of the orchestrator may have missed the
			// record (it is written after the hire): forget that miss and link
			// now, so its issue and work item are on the wire before this ack
			// instead of tens of seconds later.
			delete(h.runs.launches, res.ID)
			h.relink()
		}
		if _, ok := h.presets[p.ID]; ok { // not deleted meanwhile
			if err := h.st.SetLastPreset(ctx, a.Floor, p.ID); err != nil {
				h.log.Error("saving the last preset failed", "session", a.Floor, "err", err)
			} else {
				h.lastPreset[a.Floor] = p.ID
			}
		}
		return proto.RunStartResult{HireResult: res, LaunchID: launch.ID, Prompt: sent}
	}, compose)
}

// fillRunIDs records the run id of launches whose orchestrator now shows
// an h3d_run token (the first one it shows).
func (h *Hub) fillRunIDs(ctx context.Context) {
	for id := range h.runPending {
		w := h.workers[id]
		if w == nil || w.Tokens["h3d_run"] == "" {
			continue
		}
		if err := h.st.SetRunLaunchRun(ctx, id, w.Tokens["h3d_run"]); err != nil {
			if !errors.Is(err, context.Canceled) {
				h.log.Error("recording the run id failed", "worker", id, "err", err)
			}
			continue
		}
		delete(h.runPending, id)
	}
}
