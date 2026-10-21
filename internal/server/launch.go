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
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
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
	v := func(x store.Hire) proto.Hire {
		return proto.Hire{Harness: x.Harness, Model: x.Model, Effort: x.Effort, CodexProfile: x.CodexProfile}
	}
	return proto.Preset{ID: p.ID, Name: p.Name, Seeded: p.Seeded, Roles: proto.PresetRoles{
		Orch: v(p.Roles.Orch), Coder: v(p.Roles.Coder), Reviewer: v(p.Roles.Reviewer), UX: v(p.Roles.UX),
		Researcher: v(p.Roles.Researcher)}}
}

func storeRoles(r proto.PresetRoles) store.PresetRoles {
	v := func(x proto.Hire) store.Hire {
		return store.Hire{Harness: x.Harness, Model: x.Model, Effort: x.Effort, CodexProfile: x.CodexProfile}
	}
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

// validRoles checks all five roles against hire_options, and (#167) each
// one's Codex profile as a hire preset's is checked: keep are the roles as
// stored (preset.update's), whose profile a role keeps even when gone.
func (h *Hub) validRoles(r, keep proto.PresetRoles) error {
	opts := h.hireOptions()
	for _, role := range []struct {
		name       string
		hire, kept proto.Hire
	}{{"orch", r.Orch, keep.Orch}, {"coder", r.Coder, keep.Coder}, {"reviewer", r.Reviewer, keep.Reviewer}, {"ux", r.UX, keep.UX},
		{"researcher", r.Researcher, keep.Researcher}} {
		if err := validHireIn(opts, role.hire); err != nil {
			return bad("roles.%s: %v", role.name, err)
		}
		if role.hire.Harness != "codex" && role.hire.CodexProfile != "" {
			return bad("roles.%s: codex_profile is for a Codex role, not %q", role.name, role.hire.Harness)
		}
		if err := h.checkProfileKey(role.hire.Harness, role.hire.CodexProfile, role.kept.CodexProfile); err != nil {
			// A bad_request, never not_found: the editor reads that as its preset gone.
			return bad("roles.%s: %s", role.name, profileWords(err))
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
		if err := h.validRoles(a.Roles, proto.PresetRoles{}); err != nil {
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
			if err := h.validRoles(*a.Roles, presetView(cur).Roles); err != nil {
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
		if err := h.checkProfileKey(a.Orch.Harness, a.Orch.CodexProfile, ""); err != nil { // #167
			return bad("orch: %s", profileWords(err))
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
	// #167: the preview names the team's profiles as run.start would pick
	// them now; a role whose profile cannot be used is on the default here
	// (run.start refuses it).
	ask, _ := h.askTeam(roles, cwd, false)
	call := ""
	if orch != nil {
		call = h.writeCodeCall(orch.Harness)
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		t := ticket
		if resolve != nil {
			var err error
			if t, err = resolve(ctx); err != nil {
				return nil, err
			}
		}
		res.Ticket = t
		if t != nil {
			res.Label = runLabel(t)
			if havePreset && orch != nil {
				team, _ := h.resolveTeam(ctx, ask, false)
				res.Prompt = TeamPrompt(call, t, roles, team.profiles, a.Floor, a.Extra)
			}
		}
		res.Git = h.gitInfo(ctx, cwd, !a.Preview)
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
		return h.reviewedRunStart(ctx, c, cmd, a)
	}); waking || err != nil {
		return err
	}
	return h.reviewedRunStart(ctx, c, cmd, a)
}

// reviewedRunStart is run.start's texts through the gate (#108 round 2),
// with the switch on or a review given, each with its own review: the
// ticket's text (kept with the launch, its label's words, and in the
// composed prompt), the extra (in the composed prompt; unused beside an
// edited prompt) and the edited prompt. Their files go to one pending
// owner the orchestrator claims once it is seen. Then the start goes on
// with what the gate made of them.
func (h *Hub) reviewedRunStart(ctx context.Context, c *Client, cmd proto.Command, a proto.RunStartArgs) error {
	if !h.gated(a.Secrets != nil) {
		return h.runStart(ctx, c, cmd, a, nil, nil)
	}
	if err := h.stillOn(); err != nil {
		return err
	}
	// As typed first (no file for a text that never fits); runStart and the
	// hire check them again with their references.
	if t := strings.TrimSpace(a.Text); a.Text != "" && (t == "" || len(t) > maxRunText) {
		return bad("text must be 1-%d bytes of text", maxRunText)
	}
	if err := validExtra(a.Extra); err != nil {
		return err
	}
	if a.Prompt != "" && !herdr.ValidPrompt(a.Prompt) {
		return bad("prompt must be 1-%d bytes of text, not starting with \"--\"", herdr.MaxPrompt)
	}
	var fields []secretField
	for _, f := range []secretField{{path: "text", text: a.Text}, {path: "extra", text: a.Extra}, {path: "prompt", text: a.Prompt}} {
		if f.text == "" || (f.path == "extra" && a.Prompt != "") {
			continue
		}
		if err := scannable(f.text, f.path); err != nil {
			return err
		}
		fields = append(fields, f)
	}
	fields, err := reviewFields(a.Secrets, fields)
	if err != nil {
		return err
	}
	a.Secrets = nil
	if len(fields) == 0 {
		return h.runStart(ctx, c, cmd, a, nil, nil)
	}
	rev, owner := h.ps.rev, secretfiles.NewPending()
	startGated(h, ctx, c, cmd, rev, func(ctx context.Context) (*hireSecrets, error) {
		ps, err := h.protectFields(ctx, rev, owner, h.opts.Now().Add(h.opts.SecretPendingTTL), fields)
		if err != nil {
			return nil, err
		}
		return &hireSecrets{rev: rev, owner: owner, ps: ps}, nil
	}, h.dropHireSecrets, func(ctx context.Context, sec *hireSecrets) error {
		for i, f := range fields {
			switch f.path {
			case "text":
				a.Text = sec.ps[i].text
			case "extra":
				a.Extra = sec.ps[i].text
			case "prompt":
				a.Prompt = sec.ps[i].text
			}
		}
		return h.runStart(ctx, c, cmd, a, nil, sec)
	})
	return nil
}

// runStart is startRunStart after the args are read (#108: and its texts
// through the gate, sec what it made: it is beginHire's from there, or
// dropped here when the start fails off the hub goroutine). A work_item
// that the floor's provider must vouch for or describe (see runTicketOf)
// is resolved off the hub goroutine, then the start goes on from here with
// its ticket: stale when the floor's board source changed meanwhile (#184:
// another tracker, Kaneo connection or project), the item being of the old
// one.
func (h *Hub) runStart(ctx context.Context, c *Client, cmd proto.Command, a proto.RunStartArgs, resolved *proto.RunTicket,
	sec *hireSecrets) error {
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
				if err == nil && sec != nil { // #108 review B2: the switch changed while the item was read
					err = h.reviewCurrent(sec.rev)
				}
				if err == nil {
					err = h.runStart(ctx, c, cmd, a, t, sec)
				}
				if err != nil {
					h.dropHireSecrets(ctx, sec)
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
	// #167: the orchestrator's profile is a hire's (beginHire checks it
	// again), said here as the run's; the roles' are resolved once, off
	// the hub goroutine, unless the prompt is the user's own.
	if err := h.checkProfileKey(a.Orch.Harness, a.Orch.CodexProfile, ""); err != nil {
		return roleProfileError("orchestrator's", err)
	}
	var ask *teamAsk
	if a.Prompt == "" {
		cwd, err := h.hireCwd(a.Floor, f, "")
		if err != nil {
			return err
		}
		if ask, err = h.askTeam(presetView(p).Roles, cwd, true); err != nil {
			return err
		}
	}
	if ask == nil {
		return h.launchRun(ctx, c, cmd, a, ticket, p, f, runTeam{}, sec)
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		team, err := h.resolveTeam(ctx, ask, true)
		if derr := h.doWait(ctx, func() {
			var f *floorState
			if err == nil {
				f, err = h.hireFloor(a.Floor)
			}
			if err == nil && sec != nil { // #108 review B2: the switch changed while the team was resolved
				err = h.reviewCurrent(sec.rev)
			}
			if err == nil {
				if cur, ok := h.presets[a.Preset]; !ok {
					err = fmt.Errorf("%w: preset %q", store.ErrNotFound, a.Preset)
				} else if cur != p {
					err = fmt.Errorf("%w: the team preset changed while its Codex profiles were read: start the run again", errStale)
				}
			}
			if err == nil {
				err = h.launchRun(ctx, c, cmd, a, ticket, p, f, team, sec)
			}
			if err != nil {
				h.dropHireSecrets(ctx, sec)
				h.audit(ctx, c, cmd, err)
				h.reply(c, cmd, nil, err)
			}
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

// launchRun is runStart with its ticket, preset and (#167) team resolved:
// the prompt composed with the team's profiles, and the orchestrator's
// hire begun (beginHire) on its own profile.
func (h *Hub) launchRun(ctx context.Context, c *Client, cmd proto.Command, a proto.RunStartArgs, ticket *proto.RunTicket, p store.Preset,
	f *floorState, team runTeam, sec *hireSecrets) error {
	// #39: what was typed (the extra, or an edited prompt whole) is
	// translated for the orchestrator's harness when the hire sends it, never
	// the ticket the bridge composes around the extra (an issue's text).
	prompt := a.Prompt
	var compose firstPrompt
	if prompt == "" {
		call, roles := h.writeCodeCall(a.Orch.Harness), presetView(p).Roles
		prompt = TeamPrompt(call, ticket, roles, team.profiles, a.Floor, a.Extra)
		compose = func(tr func(string) string) string {
			return TeamPrompt(call, ticket, roles, team.profiles, a.Floor, tr(a.Extra))
		}
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
		Effort: a.Orch.Effort, Label: label, Worktree: worktree, Prompt: prompt, CodexProfile: a.Orch.CodexProfile}
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
		out := proto.RunStartResult{HireResult: res, LaunchID: launch.ID, Prompt: sent}
		teamReport(rep, &out, team)
		return out
	}, compose, nil, sec)
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
