package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// HireHerdr is what the hub needs from herdr to hire workers and send
// them home: *herdr.Control, the allowlisted write path.
type HireHerdr interface {
	CreateWorkspace(ctx context.Context, session, dir, label string) (herdr.Created, error)
	CreateWorktree(ctx context.Context, session, repo, branch, base, label string) (herdr.Created, error)
	MarkPane(ctx context.Context, session, pane, marker string) error
	StartAgent(ctx context.Context, session, pane, name string, a herdr.Agent) error
	ReadPane(ctx context.Context, session, pane string) (string, error)
	SendKey(ctx context.Context, session, pane string, key herdr.Key) error
	Prompt(ctx context.Context, session, pane, text string) error
	TypeExit(ctx context.Context, session, pane, harness string) error
	CloseWorkspace(ctx context.Context, session, workspace string) error
	RemoveWorktree(ctx context.Context, session, workspace string) error
	PaneProcesses(ctx context.Context, session, pane string) (*herdr.ProcessInfo, error)
}

// Git is the typed git runner (*gitops.Git) hires and send-homes use.
// TopLevel returns gitops.ErrNotRepo outside a git work tree.
type Git interface {
	TopLevel(ctx context.Context, dir string) (string, error)
	Fetch(ctx context.Context, dir string) error
	DefaultBranch(ctx context.Context, dir string) string
	Commit(ctx context.Context, dir, ref string) (string, time.Time, error)
	Status(ctx context.Context, dir string) ([]string, error)
	Unpushed(ctx context.Context, dir string) (int, error)
	DeleteBranch(ctx context.Context, dir, branch string) error
}

// Caps are the worker caps: above Soft the hire dialog warns, a hire above
// Hard is refused.
type Caps struct {
	FloorSoft, FloorHard int
	HostSoft, HostHard   int
}

// DefaultCaps are the default worker caps.
var DefaultCaps = Caps{FloorSoft: 12, FloorHard: 24, HostSoft: 48, HostHard: 96}

// Defaults of the hire and fire timings.
const (
	DefaultTrustTimeout = 10 * time.Second
	DefaultSeenTimeout  = 10 * time.Second
	DefaultExitTimeout  = 8 * time.Second
	defaultHirePoll     = 250 * time.Millisecond
	defaultExitPause    = 400 * time.Millisecond
	maxDirtyLines       = 50
)

var (
	errUnknownWorker = errors.New("unknown worker")
	errDeskTaken     = errors.New("desk taken")
	errCapacity      = errors.New("capacity")
	errNotClean      = errors.New("not clean")
	errHireFailed    = errors.New("hire failed")
	errFireFailed    = errors.New("fire failed")
)

func bad(format string, args ...any) error { return &badArgsError{fmt.Errorf(format, args...)} }

// hireOp is a worker.hire in flight. Its desk is reserved and its worker
// id minted from the start; workspaceID and pane are set (on the hub
// goroutine) once herdr made the workspace, and seen once the hub saw it.
type hireOp struct {
	id, session                string
	desk                       int
	name, label, marker, agent string
	harness, model, effort     string
	cwd, prompt, branch        string
	worktree                   bool
	hiredAt                    int64
	client                     *Client
	cmd                        proto.Command
	auditID                    int64
	notify                     chan struct{}
	workspaceID, pane          string
	seen                       bool
}

func (op *hireOp) signal() {
	select {
	case op.notify <- struct{}{}:
	default:
	}
}

// fireOp is a worker.fire in flight.
type fireOp struct {
	id, session, workspaceID, pane string
	harness, choice                string
	checkout, repoRoot, branch     string
	client                         *Client
	cmd                            proto.Command
	auditID                        int64
	notify                         chan struct{}
	removed                        bool
}

func (op *fireOp) signal() {
	select {
	case op.notify <- struct{}{}:
	default:
	}
}

// hireOptions returns what can be hired (Options.HireOptions, else the
// built-in list).
func (h *Hub) hireOptions() proto.HireOptions {
	if h.opts.HireOptions != nil {
		return *h.opts.HireOptions
	}
	return HireOptions()
}

// hireFloor returns a running, watched floor that no wake or sleep holds.
func (h *Hub) hireFloor(session string) (*floorState, error) {
	f, err := h.floorFor(session)
	if err != nil {
		return nil, err
	}
	if err := h.notBusy(session, f); err != nil {
		return nil, err
	}
	if !f.running {
		return nil, fmt.Errorf("%w: floor %q is asleep", errInvalidState, session)
	}
	return f, nil
}

// heldNames is every name of a floor no newcomer may take at at.
func (h *Hub) heldNames(session string, at time.Time) map[string]bool {
	held := map[string]bool{}
	for name, c := range h.names[session] {
		if c.released.IsZero() || at.Sub(c.released) < h.opts.NameHold {
			held[name] = true
		}
	}
	return held
}

// hireCwd is the directory a hire works in: the one asked for, else the
// floor's effective default cwd, else the home directory.
func (h *Hub) hireCwd(session string, f *floorState, asked string) (string, error) {
	dir := asked
	if dir == "" {
		dir = h.settings[session].DefaultCwd
		if dir == "" && f.suggested != nil {
			dir = f.suggested.DefaultCwd
		}
		if dir == "" {
			dir = h.opts.HomeDir
		}
	}
	if !filepath.IsAbs(dir) || !herdr.ValidDir(filepath.Clean(dir)) {
		return "", bad("cwd must be an absolute path, got %q", dir)
	}
	dir = filepath.Clean(dir)
	if err := h.opts.StatDir(dir); err != nil {
		return "", bad("cwd %q: %v", dir, err)
	}
	return dir, nil
}

// counts returns how many workers a floor has and the host has, hires in
// flight included.
func (h *Hub) counts(session string) (floor, host int) {
	for s, f := range h.floors {
		if !f.running {
			continue
		}
		n := len(f.order)
		for _, op := range f.hires {
			if !op.seen {
				n++
			}
		}
		host += n
		if s == session {
			floor = n
		}
	}
	return floor, host
}

func (h *Hub) capacity(session string) proto.Capacity {
	floor, host := h.counts(session)
	c := h.opts.Caps
	return proto.Capacity{Floor: proto.CapacityCount{Count: floor, Soft: c.FloorSoft, Hard: c.FloorHard},
		Host: proto.CapacityCount{Count: host, Soft: c.HostSoft, Hard: c.HostHard}}
}

// choice is what the hire dialog pre-selects: the floor's default hire,
// else the last hire on the floor, else nothing.
func (h *Hub) choice(session string) (*proto.Hire, string) {
	opts := h.hireOptions()
	if s := h.settings[session]; s.HireHarness != "" {
		c := proto.Hire{Harness: s.HireHarness, Model: s.HireModel, Effort: s.HireEffort}
		if validHireIn(opts, c) == nil {
			return &c, proto.ChoiceFloorDefault
		}
	}
	if l, ok := h.lastHire[session]; ok {
		c := proto.Hire{Harness: l.Harness, Model: l.Model, Effort: l.Effort}
		if validHireIn(opts, c) == nil {
			return &c, proto.ChoiceLast
		}
	}
	return nil, proto.ChoiceNone
}

// startAsync runs the slow part of a command off the hub goroutine; its
// audit row and reply come when it is done.
func (h *Hub) startAsync(ctx context.Context, c *Client, cmd proto.Command, work func(context.Context) (any, error)) {
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		data, err := work(ctx)
		if derr := h.doWait(ctx, func() {
			h.audit(ctx, c, cmd, err)
			h.reply(c, cmd, data, err)
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
}

// startHirePrepare answers hire.prepare: the choice, label and capacity
// now, the git state and host load off the hub goroutine.
func (h *Hub) startHirePrepare(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HirePrepareArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	f, err := h.hireFloor(a.Session)
	if err != nil {
		return err
	}
	cwd, err := h.hireCwd(a.Session, f, a.Cwd)
	if err != nil {
		return err
	}
	res := proto.HirePrepareResult{Cwd: cwd, Capacity: h.capacity(a.Session)}
	res.Choice, res.ChoiceSource = h.choice(a.Session)
	res.Label = world.PickName(uuid.NewString(), h.heldNames(a.Session, h.opts.Now()))
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res.Git = h.gitInfo(ctx, cwd)
		if h.opts.Load != nil {
			res.Capacity.Load = h.opts.Load()
		}
		return res, nil
	})
	return nil
}

// gitInfo is the hire dialog's git state of dir: nil outside a work tree.
func (h *Hub) gitInfo(ctx context.Context, dir string) *proto.HireGit {
	if h.opts.Git == nil {
		return nil
	}
	top, err := h.opts.Git.TopLevel(ctx, dir)
	if err != nil {
		if !errors.Is(err, gitops.ErrNotRepo) {
			h.log.Warn("git rev-parse failed", "dir", dir, "err", err)
		}
		return nil
	}
	g := &proto.HireGit{RepoRoot: top, Fetched: true}
	if err := h.opts.Git.Fetch(ctx, top); err != nil {
		g.Fetched, g.FetchError = false, err.Error()
	}
	g.DefaultBranch = h.opts.Git.DefaultBranch(ctx, top)
	if g.DefaultBranch != "" {
		if sha, at, err := h.opts.Git.Commit(ctx, top, "origin/"+g.DefaultBranch); err == nil {
			g.BaseSHA, g.BaseTime = sha, at.UnixMilli()
		}
	}
	return g
}

var slugRun = regexp.MustCompile(`[^a-z0-9]+`)

// slug is a name as lower-case words joined by "-" (at most 40 bytes).
func slug(name string) string {
	s := strings.Trim(slugRun.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if len(s) > 40 {
		s = strings.TrimRight(s[:40], "-")
	}
	if s == "" {
		s = "worker"
	}
	return s
}

// startHire validates worker.hire, reserves its desk and name, mints the
// worker id and starts the hire.
func (h *Hub) startHire(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerHireArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	f, err := h.hireFloor(a.Session)
	if err != nil {
		return err
	}
	if a.DeskIndex == nil {
		return bad("desk_index is required")
	}
	if err := validHireIn(h.hireOptions(), proto.Hire{Harness: a.Harness, Model: a.Model, Effort: a.Effort}); err != nil {
		return &badArgsError{err}
	}
	if !herdr.CanStart(a.Harness) {
		return bad("cannot start harness %q", a.Harness)
	}
	at := h.opts.Now()
	held := h.heldNames(a.Session, at)
	if a.Label == "" {
		a.Label = world.PickName(uuid.NewString(), held)
	}
	if !herdr.ValidLabel(a.Label) {
		return bad("label must be 1-%d bytes without control characters, not starting with \"-\"", herdr.MaxLabel)
	}
	if a.Prompt != "" && !herdr.ValidPrompt(a.Prompt) {
		return bad("prompt must be 1-%d bytes of text, not starting with \"--\"", herdr.MaxPrompt)
	}
	cwd, err := h.hireCwd(a.Session, f, a.Cwd)
	if err != nil {
		return err
	}
	if a.Worktree && h.opts.Git == nil {
		return errors.New("worktree hires are not configured")
	}
	desk := *a.DeskIndex
	if n := h.deskCount(a.Session, f); desk < 0 || desk >= n {
		return fmt.Errorf("%w: desk %d is not on the floor (0-%d)", errDeskTaken, desk, n-1)
	}
	for id, d := range h.desks[a.Session] {
		if d == desk {
			name := id
			if w := h.workers[id]; w != nil {
				name = w.Name
			}
			return fmt.Errorf("%w: desk %d is %s's", errDeskTaken, desk, name)
		}
	}
	for _, op := range f.hires {
		if op.desk == desk {
			return fmt.Errorf("%w: desk %d is being hired into", errDeskTaken, desk)
		}
	}
	floorN, hostN := h.counts(a.Session)
	caps := h.opts.Caps
	switch {
	case floorN+1 > caps.FloorHard:
		return fmt.Errorf("%w: the floor has %d workers, the most is %d (--max-workers-per-floor)", errCapacity, floorN, caps.FloorHard)
	case hostN+1 > caps.HostHard:
		return fmt.Errorf("%w: the host has %d workers, the most is %d (--max-workers)", errCapacity, hostN, caps.HostHard)
	}
	if h.opts.Hire == nil {
		return errors.New("hiring is not configured")
	}

	id := uuid.NewString()
	hex := strings.ReplaceAll(id, "-", "")
	name := a.Label
	if held[name] || !world.IsName(name) {
		name = world.PickName(id, held)
	}
	op := &hireOp{id: id, session: a.Session, desk: desk, name: name, label: a.Label, marker: "h3d-" + hex[:12],
		agent: slug(name) + "-" + hex[:6], harness: a.Harness, model: a.Model, effort: a.Effort, cwd: cwd,
		prompt: a.Prompt, worktree: a.Worktree, hiredAt: at.UnixMilli(), client: c, cmd: cmd,
		notify: make(chan struct{}, 1)}
	if a.Worktree {
		op.branch = "h3d/" + op.agent
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, cmd.Args)
	if err != nil {
		return err
	}
	op.auditID = auditID
	if f.hires == nil {
		f.hires = map[string]*hireOp{}
	}
	f.hires[id] = op
	h.floorNames(a.Session)[name] = nameClaim{owner: id} // held until the hire ends
	h.log.Info("hire started", "client", c.name, "req_id", cmd.ReqID, "session", a.Session, "desk", desk,
		"worker", id, "harness", a.Harness, "model", a.Model, "effort", a.Effort, "worktree", a.Worktree)
	h.wg.Add(1)
	go h.runHire(ctx, op)
	return nil
}

// hireReport is the audit-log result of a worker.hire.
type hireReport struct {
	Worker      string   `json:"worker"`
	Desk        int      `json:"desk"`
	Name        string   `json:"name"`
	Cwd         string   `json:"cwd"`
	Harness     string   `json:"harness"`
	Model       string   `json:"model"`
	Effort      string   `json:"effort"`
	RepoRoot    string   `json:"repo_root,omitempty"`
	Branch      string   `json:"branch,omitempty"`
	Base        string   `json:"base,omitempty"`
	BaseSHA     string   `json:"base_sha,omitempty"`
	Fetched     *bool    `json:"fetched,omitempty"`
	FetchError  string   `json:"fetch_error,omitempty"`
	WorkspaceID string   `json:"workspace_id,omitempty"`
	Pane        string   `json:"pane,omitempty"`
	Marker      string   `json:"marker,omitempty"`
	Start       string   `json:"start,omitempty"`
	Trust       string   `json:"trust,omitempty"`
	Prompt      string   `json:"prompt,omitempty"`
	Rollback    []string `json:"rollback,omitempty"`
	Steps       []string `json:"steps"`
}

func (r *hireReport) step(format string, args ...any) {
	r.Steps = append(r.Steps, fmt.Sprintf(format, args...))
}

// runHire makes the workspace (or worktree), binds it to the worker,
// marks its pane, starts the agent, answers its trust dialog, sends the
// first prompt and acks once the worker was seen. A failure after the
// workspace exists rolls it back.
func (h *Hub) runHire(ctx context.Context, op *hireOp) {
	defer h.wg.Done()
	hh, git := h.opts.Hire, h.opts.Git
	rep := &hireReport{Worker: op.id, Desk: op.desk, Name: op.name, Cwd: op.cwd, Harness: op.harness, Model: op.model,
		Effort: op.effort, Marker: op.marker, Steps: []string{}}
	res := proto.HireResult{ID: op.id, Trust: proto.TrustNone}
	var created herdr.Created
	var repo string
	fail := func(err error) {
		if created.WorkspaceID != "" {
			h.rollbackHire(ctx, op, created, repo, rep)
		}
		h.finishHire(ctx, op, nil, err, rep)
	}

	if op.worktree {
		var err error
		if repo, err = git.TopLevel(ctx, op.cwd); err != nil {
			if errors.Is(err, gitops.ErrNotRepo) {
				fail(bad("worktree: %s is not in a git work tree", op.cwd))
			} else {
				fail(fmt.Errorf("%w: worktree: %v", errHireFailed, err))
			}
			return
		}
		rep.RepoRoot = repo
		fetched := true
		if err := git.Fetch(ctx, repo); err != nil {
			fetched, rep.FetchError, res.FetchError = false, err.Error(), err.Error()
			rep.step("git fetch origin failed: %v", err)
		} else {
			rep.step("git fetch origin")
		}
		rep.Fetched = &fetched
		def := git.DefaultBranch(ctx, repo)
		if def == "" {
			fail(bad("worktree: %s has no origin/<default branch> to branch from", repo))
			return
		}
		base := "origin/" + def
		sha, _, err := git.Commit(ctx, repo, base)
		if err != nil {
			fail(fmt.Errorf("%w: worktree: %s: %v", errHireFailed, base, err))
			return
		}
		rep.Base, rep.BaseSHA, rep.Branch = base, sha, op.branch
		res.BaseSHA = sha
		if created, err = hh.CreateWorktree(ctx, op.session, repo, op.branch, base, op.label); err != nil {
			fail(fmt.Errorf("%w: herdr worktree create: %v", errHireFailed, err))
			return
		}
		res.Branch = op.branch
		rep.step("herdr worktree create %s from %s (%s)", op.branch, base, sha)
	} else {
		var err error
		if created, err = hh.CreateWorkspace(ctx, op.session, op.cwd, op.label); err != nil {
			fail(fmt.Errorf("%w: herdr workspace create: %v", errHireFailed, err))
			return
		}
		rep.step("herdr workspace create")
	}
	rep.WorkspaceID, rep.Pane = created.WorkspaceID, created.PaneID
	res.WorkspaceID = created.WorkspaceID
	if err := h.doWait(ctx, func() { h.bindHire(ctx, op, created) }); err != nil {
		return
	}

	if err := hh.MarkPane(ctx, op.session, created.PaneID, op.marker); err != nil {
		fail(fmt.Errorf("%w: herdr pane rename: %v", errHireFailed, err))
		return
	}
	rep.step("marked %s %s", created.PaneID, op.marker)

	agent := herdr.Agent{Harness: op.harness, Model: op.model, Effort: op.effort, Label: op.label}
	startErr := hh.StartAgent(ctx, op.session, created.PaneID, op.agent, agent)
	var api *herdr.APIError
	switch {
	case startErr == nil:
		rep.Start = "ready"
	case errors.As(startErr, &api) && api.Code == "agent_not_ready":
		rep.Start = "blocked during startup"
	default:
		fail(fmt.Errorf("%w: herdr agent start: %v", errHireFailed, startErr))
		return
	}
	rep.step("herdr agent start %s: %s", op.agent, rep.Start)

	dir := op.cwd
	if created.CheckoutPath != "" {
		dir = created.CheckoutPath
	}
	trust, note := h.answerTrust(ctx, op, created.PaneID, dir)
	res.Trust, rep.Trust = trust, trust
	if note != "" {
		rep.step("%s", note)
	}

	if !h.awaitHire(ctx, op, time.Now().Add(h.opts.SeenTimeout), func() bool { return op.seen }) {
		if ctx.Err() != nil {
			return
		}
		fail(fmt.Errorf("%w: the new workspace %s was not seen within %s", errHireFailed, created.WorkspaceID, h.opts.SeenTimeout))
		return
	}

	if op.prompt != "" {
		sent, perr := h.sendPrompt(ctx, op, created.PaneID)
		res.Prompted = &sent
		if perr != nil {
			res.PromptError, rep.Prompt = perr.Error(), "failed: "+perr.Error()
		} else {
			rep.Prompt = "sent"
		}
	}
	choice := store.Hire{Harness: op.harness, Model: op.model, Effort: op.effort}
	if err := h.doWait(ctx, func() {
		if err := h.st.SetLastHire(ctx, op.session, choice); err != nil {
			h.log.Error("saving the last hire failed", "session", op.session, "err", err)
		} else {
			h.lastHire[op.session] = choice
		}
	}); err != nil {
		return
	}
	h.finishHire(ctx, op, &res, nil, rep)
}

// bindHire records the hire's workspace (hub goroutine) and re-applies the
// floor's last observation, in case herdr's event came first.
func (h *Hub) bindHire(ctx context.Context, op *hireOp, created herdr.Created) {
	op.workspaceID, op.pane = created.WorkspaceID, created.PaneID
	h.resync(ctx, op.session)
}

// Trust dialogs, as the agents draw them.
var (
	claudeTrust = []string{"Yes, I trust this folder", "No, exit"}
	codexTrust  = []string{"Trust this folder?", "Trust and continue"}
)

// trustDialog reports which agent's trust dialog screen shows for dir.
func trustDialog(screen, dir string) string {
	flat := strings.Join(strings.Fields(screen), "")
	if !strings.Contains(flat, strings.Join(strings.Fields(dir), "")) {
		return ""
	}
	has := func(needles []string) bool {
		for _, n := range needles {
			if !strings.Contains(screen, n) {
				return false
			}
		}
		return true
	}
	switch {
	case has(claudeTrust):
		return "claude"
	case has(codexTrust):
		return "codex"
	}
	return ""
}

// answerTrust answers the agent's trust dialog for dir, the directory the
// player hired into: Claude Down + Enter ("Yes, I trust this folder"),
// Codex Enter ("1. Trust and continue"). It reads the screen until no
// dialog shows or TrustTimeout ends.
func (h *Hub) answerTrust(ctx context.Context, op *hireOp, pane, dir string) (trust, note string) {
	hh := h.opts.Hire
	deadline := time.Now().Add(h.opts.TrustTimeout)
	trust = proto.TrustNone
	for answered := 0; ; {
		screen, err := hh.ReadPane(ctx, op.session, pane)
		if err != nil {
			return trust, "reading the screen failed: " + err.Error()
		}
		kind := trustDialog(screen, dir)
		switch {
		case kind == "":
			if answered > 0 {
				return trust, "answered the " + op.harness + " trust dialog"
			}
			return trust, ""
		case kind != op.harness:
			return trust, "a " + kind + " trust dialog in a " + op.harness + " pane: left alone"
		case answered >= 2 || time.Now().After(deadline):
			return trust, "the trust dialog is still open: left for the player"
		}
		keys := []herdr.Key{herdr.KeyEnter}
		if kind == "claude" {
			keys = []herdr.Key{herdr.KeyDown, herdr.KeyEnter}
		}
		for i, k := range keys {
			if i > 0 {
				sleepCtx(ctx, h.opts.HirePoll)
			}
			if err := hh.SendKey(ctx, op.session, pane, k); err != nil {
				return trust, "answering the trust dialog failed: " + err.Error()
			}
		}
		answered++
		trust = proto.TrustApproved
		// Let the agent redraw before looking again.
		for time.Now().Before(deadline) {
			sleepCtx(ctx, h.opts.HirePoll)
			if ctx.Err() != nil {
				return trust, ""
			}
			s, err := hh.ReadPane(ctx, op.session, pane)
			if err != nil || trustDialog(s, dir) == "" {
				break
			}
		}
	}
}

// sendPrompt sends the hire's first prompt once the agent takes it,
// retrying while herdr says the agent is not ready yet.
func (h *Hub) sendPrompt(ctx context.Context, op *hireOp, pane string) (bool, error) {
	deadline := time.Now().Add(h.opts.TrustTimeout)
	for {
		err := h.opts.Hire.Prompt(ctx, op.session, pane, op.prompt)
		if err == nil {
			return true, nil
		}
		var api *herdr.APIError
		if !errors.As(err, &api) || !slices.Contains([]string{"agent_not_ready", "agent_not_found", "agent_blocked"}, api.Code) ||
			time.Now().After(deadline) || ctx.Err() != nil {
			return false, err
		}
		sleepCtx(ctx, 4*h.opts.HirePoll)
	}
}

// rollbackHire closes a failed hire's workspace; a worktree's checkout and
// its fresh, commit-less branch go too.
func (h *Hub) rollbackHire(ctx context.Context, op *hireOp, created herdr.Created, repo string, rep *hireReport) {
	hh := h.opts.Hire
	if op.worktree {
		if err := hh.RemoveWorktree(ctx, op.session, created.WorkspaceID); err != nil {
			rep.Rollback = append(rep.Rollback, "herdr worktree remove failed: "+err.Error())
			return
		}
		rep.Rollback = append(rep.Rollback, "herdr worktree remove")
		if err := h.opts.Git.DeleteBranch(ctx, repo, op.branch); err != nil {
			rep.Rollback = append(rep.Rollback, "git branch -D failed: "+err.Error())
		} else {
			rep.Rollback = append(rep.Rollback, "git branch -D "+op.branch)
		}
		return
	}
	if err := hh.CloseWorkspace(ctx, op.session, created.WorkspaceID); err != nil {
		rep.Rollback = append(rep.Rollback, "herdr workspace close failed: "+err.Error())
	} else {
		rep.Rollback = append(rep.Rollback, "herdr workspace close")
	}
}

// finishHire ends a hire on the hub goroutine: the reservation ends, the
// audit row is completed and the client gets its ack or error.
func (h *Hub) finishHire(ctx context.Context, op *hireOp, res *proto.HireResult, opErr error, rep *hireReport) {
	err := h.doWait(ctx, func() {
		if f := h.floors[op.session]; f != nil && f.hires[op.id] == op {
			delete(f.hires, op.id)
		}
		if !op.seen {
			if c, ok := h.names[op.session][op.name]; ok && c.owner == op.id {
				delete(h.names[op.session], op.name)
			}
		}
		h.syncLayout()
		if aerr := h.st.AuditEnd(ctx, op.auditID, opErr, rep); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		var data any
		if res != nil {
			data = *res
		}
		h.reply(op.client, op.cmd, data, opErr)
	})
	if err != nil {
		h.log.Warn("hire abandoned", "session", op.session, "worker", op.id, "err", err)
	}
}

// awaitHire waits until deadline for flag (read on the hub goroutine).
func (h *Hub) awaitHire(ctx context.Context, op *hireOp, deadline time.Time, flag func() bool) bool {
	return awaitOn(ctx, h, op.notify, deadline, flag)
}

func awaitOn(ctx context.Context, h *Hub, notify <-chan struct{}, deadline time.Time, flag func() bool) bool {
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	for {
		if ok, _ := query(ctx, h, flag); ok {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-timer.C:
			ok, _ := query(ctx, h, flag)
			return ok
		case <-notify:
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

// fireWorker is the worker a send-home command is for, on a floor it may
// act on.
func (h *Hub) fireWorker(id string) (*proto.Worker, *floorState, error) {
	w := h.workers[id]
	if w == nil {
		return nil, nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	f, err := h.floorFor(w.Session)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	if err := h.notBusy(w.Session, f); err != nil {
		return nil, nil, err
	}
	if !f.running {
		return nil, nil, fmt.Errorf("%w: floor %q is asleep", errInvalidState, w.Session)
	}
	if f.hires[id] != nil {
		return nil, nil, fmt.Errorf("%w: %s is still being hired", errBusy, w.Name)
	}
	if f.fires[id] != nil {
		return nil, nil, fmt.Errorf("%w: %s is already being sent home", errBusy, w.Name)
	}
	return w, f, nil
}

// groupBlocked says why herdr would refuse to close a worker's workspace:
// it is a repository's main checkout and linked worktree workspaces of it
// are open on the floor (herdr closes those only as a group, which the
// bridge never does).
func (h *Hub) groupBlocked(w *proto.Worker, f *floorState) string {
	if w.Worktree == nil || w.Worktree.Linked || w.Worktree.RepoRoot == "" {
		return ""
	}
	var names []string
	for _, id := range f.order {
		o := h.workers[id]
		if o != nil && o.ID != w.ID && o.Worktree != nil && o.Worktree.Linked && o.Worktree.RepoRoot == w.Worktree.RepoRoot {
			names = append(names, o.Name)
		}
	}
	if len(names) == 0 {
		return ""
	}
	return fmt.Sprintf("%s works in the main checkout of %s, whose worktrees are still open (%s): send those home first",
		w.Name, w.Worktree.RepoRoot, strings.Join(names, ", "))
}

// checkoutOf is the directory a worker's git state is read from.
func checkoutOf(w *proto.Worker) string {
	if w.Worktree != nil && w.Worktree.CheckoutPath != "" {
		return w.Worktree.CheckoutPath
	}
	return w.Cwd
}

// treeState is a worker's git tree: where, dirty lines, unpushed commits.
type treeState struct {
	top      string
	dirty    []string
	unpushed int
	err      error
}

func (h *Hub) readTree(ctx context.Context, dir string) treeState {
	if h.opts.Git == nil || dir == "" || !herdr.ValidDir(dir) {
		return treeState{}
	}
	top, err := h.opts.Git.TopLevel(ctx, dir)
	if err != nil {
		if errors.Is(err, gitops.ErrNotRepo) {
			return treeState{}
		}
		return treeState{err: err}
	}
	t := treeState{top: top}
	if t.dirty, err = h.opts.Git.Status(ctx, top); err != nil {
		t.err = err
		return t
	}
	if t.unpushed, err = h.opts.Git.Unpushed(ctx, top); err != nil {
		t.err = err
	}
	return t
}

func (t treeState) problems() string {
	var why []string
	if n := len(t.dirty); n > 0 {
		why = append(why, plural(n, "uncommitted change"))
	}
	if t.unpushed > 0 {
		why = append(why, plural(t.unpushed, "commit")+" not on any remote")
	}
	return strings.Join(why, ", ")
}

func plural(n int, what string) string {
	if n == 1 {
		return "1 " + what
	}
	return fmt.Sprintf("%d %ss", n, what)
}

// startFirePrepare answers worker.fire.prepare; git runs off the hub
// goroutine.
func (h *Hub) startFirePrepare(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	w, f, err := h.fireWorker(a.ID)
	if err != nil {
		return err
	}
	res := proto.FirePrepareResult{Name: w.Name, Label: w.Label, Branch: w.Branch, Dirty: []string{}, CanFire: true}
	if why := h.groupBlocked(w, f); why != "" {
		res.CanFire, res.FireBlocked = false, why
	}
	linked := w.Worktree != nil && w.Worktree.Linked
	dir := checkoutOf(w)
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		t := h.readTree(ctx, dir)
		switch {
		case t.err != nil:
			res.Reason = "reading the git state failed: " + t.err.Error()
		case t.top == "":
			res.Reason = "not in a git work tree"
		default:
			res.Worktree = &proto.FireWorktree{Path: t.top, Linked: linked}
			res.Dirty = append(res.Dirty, t.dirty[:min(len(t.dirty), maxDirtyLines)]...)
			res.Unpushed = t.unpushed
			switch why := t.problems(); {
			case !linked:
				res.Reason = "not in a linked worktree (only those can be deleted)"
			case why != "":
				res.Reason = why
			default:
				res.CanDelete = true
			}
		}
		return res, nil
	})
	return nil
}

// startFire validates worker.fire and starts sending the worker home.
func (h *Hub) startFire(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerFireArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Worktree == "" {
		a.Worktree = proto.FireKeep
	}
	if !slices.Contains([]string{proto.FireKeep, proto.FireDelete, proto.FireDeleteBranch}, a.Worktree) {
		return bad("worktree must be keep, delete or delete_branch, got %q", a.Worktree)
	}
	w, f, err := h.fireWorker(a.ID)
	if err != nil {
		return err
	}
	if why := h.groupBlocked(w, f); why != "" {
		return fmt.Errorf("%w: %s", errFireFailed, why)
	}
	if !herdr.ValidWorkspaceID(w.WorkspaceID) {
		return fmt.Errorf("%w: workspace id %q", errFireFailed, w.WorkspaceID)
	}
	if h.opts.Hire == nil {
		return errors.New("sending workers home is not configured")
	}
	op := &fireOp{id: w.ID, session: w.Session, workspaceID: w.WorkspaceID, pane: w.PaneID, choice: a.Worktree,
		checkout: checkoutOf(w), client: c, cmd: cmd, notify: make(chan struct{}, 1)}
	op.harness = w.AgentKind
	if op.harness == "" {
		op.harness = w.Harness
	}
	if a.Worktree != proto.FireKeep {
		switch {
		case w.Worktree == nil || !w.Worktree.Linked:
			return bad("%s does not work in a linked worktree: only keep is possible", w.Name)
		case h.opts.Git == nil:
			return errors.New("deleting worktrees is not configured")
		}
		op.repoRoot = w.Worktree.RepoRoot
	}
	if a.Worktree == proto.FireDeleteBranch {
		if !herdr.ValidBranch(w.Branch) || !herdr.ValidDir(op.repoRoot) {
			return bad("branch %q was not made by the bridge (h3d/…): delete the worktree only", w.Branch)
		}
		op.branch = w.Branch
	}
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, cmd.Args)
	if err != nil {
		return err
	}
	op.auditID = auditID
	if f.fires == nil {
		f.fires = map[string]*fireOp{}
	}
	f.fires[w.ID] = op
	h.log.Info("send home started", "client", c.name, "req_id", cmd.ReqID, "session", w.Session, "worker", w.ID,
		"worktree", a.Worktree)
	h.wg.Add(1)
	go h.runFire(ctx, op)
	return nil
}

// fireReport is the audit-log result of a worker.fire.
type fireReport struct {
	Worker    string   `json:"worker"`
	Workspace string   `json:"workspace"`
	Choice    string   `json:"choice"`
	Checkout  string   `json:"checkout,omitempty"`
	Dirty     []string `json:"dirty,omitempty"`
	Unpushed  int      `json:"unpushed,omitempty"`
	Exit      string   `json:"exit,omitempty"`
	Released  bool     `json:"released"`
	Worktree  string   `json:"worktree,omitempty"`
	Steps     []string `json:"steps"`
}

func (r *fireReport) step(format string, args ...any) {
	r.Steps = append(r.Steps, fmt.Sprintf(format, args...))
}

// runFire checks the tree (for a delete), exits the agent gracefully,
// closes the workspace or removes its worktree, waits for the worker to
// be gone and deletes the branch when asked.
func (h *Hub) runFire(ctx context.Context, op *fireOp) {
	defer h.wg.Done()
	hh := h.opts.Hire
	rep := &fireReport{Worker: op.id, Workspace: op.workspaceID, Choice: op.choice, Checkout: op.checkout, Steps: []string{}}
	res := proto.FireResult{Worktree: proto.WorktreeKept}
	remove := op.choice != proto.FireKeep
	if remove {
		t := h.readTree(ctx, op.checkout)
		rep.Dirty, rep.Unpushed = t.dirty, t.unpushed
		switch {
		case t.err != nil:
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: reading the git state: %v", errFireFailed, t.err), rep)
			return
		case t.top == "":
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: %s is not a git work tree", errFireFailed, op.checkout), rep)
			return
		case t.problems() != "":
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: %s: the worktree is kept", errNotClean, t.problems()), rep)
			return
		}
		rep.step("tree clean and pushed")
	}

	res.Released = h.exitAgent(ctx, op, rep)
	rep.Released = res.Released

	if remove {
		if t := h.readTree(ctx, op.checkout); t.err != nil || t.problems() != "" {
			remove = false
			why := t.problems()
			if t.err != nil {
				why = t.err.Error()
			}
			res.Note = "the tree changed while the agent exited (" + why + "): the worktree is kept"
			rep.step("%s", res.Note)
		}
	}
	if remove {
		if err := hh.RemoveWorktree(ctx, op.session, op.workspaceID); err != nil {
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: herdr worktree remove: %v", errFireFailed, err), rep)
			return
		}
		res.Worktree = proto.WorktreeDeleted
		rep.step("herdr worktree remove")
	} else {
		if err := hh.CloseWorkspace(ctx, op.session, op.workspaceID); err != nil {
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: herdr workspace close: %v", errFireFailed, err), rep)
			return
		}
		rep.step("herdr workspace close")
	}
	if !awaitOn(ctx, h, op.notify, time.Now().Add(h.opts.SeenTimeout), func() bool { return op.removed }) {
		if ctx.Err() != nil {
			return
		}
		h.finishFire(ctx, op, nil, fmt.Errorf("%w: herdr closed %s, but it was not seen gone within %s",
			errFireFailed, op.workspaceID, h.opts.SeenTimeout), rep)
		return
	}
	if remove && op.choice == proto.FireDeleteBranch {
		if err := h.opts.Git.DeleteBranch(ctx, op.repoRoot, op.branch); err != nil {
			res.Note = "the branch was kept: " + err.Error()
		} else {
			res.Worktree = proto.WorktreeDelBranch
		}
		rep.step("git branch -D %s: %s", op.branch, orOK(res.Note))
	}
	rep.Worktree = res.Worktree
	h.finishFire(ctx, op, &res, nil, rep)
}

func orOK(note string) string {
	if note == "" {
		return "ok"
	}
	return note
}

// exitAgent exits the pane's agent the way a person would (claude /exit,
// codex /quit, then Enter) and waits for the pane to be back at its shell;
// Ctrl-C twice when it is not. It reports whether the agent left by
// itself, or there was none.
func (h *Hub) exitAgent(ctx context.Context, op *fireOp, rep *fireReport) bool {
	hh := h.opts.Hire
	if op.pane == "" || !herdr.ValidPaneID(op.pane) {
		rep.Exit = "no pane"
		return true
	}
	info, err := h.paneProcesses(ctx, op.session, op.pane)
	switch {
	case err != nil:
		rep.Exit = "no exit: " + err.Error()
		return false
	case info.AtShell():
		rep.Exit = "no agent running"
		return true
	case !herdr.CanStart(op.harness):
		rep.Exit = fmt.Sprintf("no exit: cannot exit %q", op.harness)
		return false
	}
	if err := hh.TypeExit(ctx, op.session, op.pane, op.harness); err != nil {
		rep.Exit = "typing the exit failed: " + err.Error()
		return false
	}
	if op.harness == "codex" {
		sleepCtx(ctx, h.opts.ExitPause) // its command popup takes an early Enter
	}
	if err := hh.SendKey(ctx, op.session, op.pane, herdr.KeyEnter); err != nil {
		rep.Exit = "pressing Enter failed: " + err.Error()
		return false
	}
	rep.Exit = map[string]string{"claude": "/exit", "codex": "/quit"}[op.harness] + " + Enter"
	start := time.Now()
	if h.waitShell(ctx, op, time.Now().Add(h.opts.ExitTimeout)) {
		rep.step("agent exited after %s", time.Since(start).Round(time.Millisecond))
		return true
	}
	for range 2 {
		if err := hh.SendKey(ctx, op.session, op.pane, herdr.KeyCtrlC); err != nil {
			rep.step("Ctrl-C failed: %v", err)
			break
		}
		if h.waitShell(ctx, op, time.Now().Add(h.opts.ExitTimeout/4)) {
			rep.step("agent exited after Ctrl-C")
			return false
		}
	}
	rep.step("agent still running after %s: closing anyway", time.Since(start).Round(time.Millisecond))
	return false
}

// waitShell polls the pane until its shell is in the foreground again.
func (h *Hub) waitShell(ctx context.Context, op *fireOp, deadline time.Time) bool {
	for {
		if info, err := h.paneProcesses(ctx, op.session, op.pane); err == nil && info.AtShell() {
			return true
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return false
		}
		sleepCtx(ctx, h.opts.HirePoll)
	}
}

// finishFire ends a send-home on the hub goroutine.
func (h *Hub) finishFire(ctx context.Context, op *fireOp, res *proto.FireResult, opErr error, rep *fireReport) {
	err := h.doWait(ctx, func() {
		if f := h.floors[op.session]; f != nil && f.fires[op.id] == op {
			delete(f.fires, op.id)
		}
		if aerr := h.st.AuditEnd(ctx, op.auditID, opErr, rep); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		var data any
		if res != nil {
			data = *res
		}
		h.reply(op.client, op.cmd, data, opErr)
	})
	if err != nil {
		h.log.Warn("send home abandoned", "session", op.session, "worker", op.id, "err", err)
	}
}

// homeDir is the default Options.HomeDir.
func homeDir() string {
	dir, err := os.UserHomeDir()
	if err != nil {
		return "/"
	}
	return dir
}
