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
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/mcpdiag"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
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
	// #95: a Claude hire's prompt is typed (in chunks, then Enter), and
	// what a failed one left in its input box erased.
	TypePrompt(ctx context.Context, session, pane, text string) error
	EraseTyped(ctx context.Context, session, pane string, n int) error
	TypeExit(ctx context.Context, session, pane, harness string) error
	// #155: a shared-server Codex hire's server, typed into its pane, and
	// its TUI attached to it.
	StartCodexServer(ctx context.Context, session, pane, launcher string) error
	// #139: a Codex hire on a profile: its home exported in the pane's
	// shell first.
	ExportCodexHome(ctx context.Context, session, pane, home string) error
	StartCodexRemote(ctx context.Context, session, pane, name string, a herdr.Agent, r herdr.Remote) error
	CloseWorkspace(ctx context.Context, session, workspace string) error
	RemoveWorktree(ctx context.Context, session, workspace string) error
	PaneProcesses(ctx context.Context, session, pane string) (*herdr.ProcessInfo, error)
}

// Git is the typed git runner (*gitops.Git) hires and send-homes use.
// TopLevel and MainCheckout return gitops.ErrNotRepo outside a git work
// tree.
type Git interface {
	TopLevel(ctx context.Context, dir string) (string, error)
	// MainCheckout is the repository's main checkout, also from inside a
	// linked worktree: herdr makes worktrees only from it.
	MainCheckout(ctx context.Context, dir string) (string, error)
	Fetch(ctx context.Context, dir string) error
	DefaultBranch(ctx context.Context, dir string) string
	Commit(ctx context.Context, dir, ref string) (string, time.Time, error)
	Status(ctx context.Context, dir string) ([]string, error)
	Unpushed(ctx context.Context, dir string) (int, error)
	CurrentBranch(ctx context.Context, dir string) (string, error)
	BranchUnpushed(ctx context.Context, dir, branch string) (int, error)
	BranchTip(ctx context.Context, dir, branch string) (string, error)
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

// fetchFailedError is a worktree hire's failed `git fetch origin`; its
// message is git's.
type fetchFailedError struct{ err error }

func (e *fetchFailedError) Error() string { return e.err.Error() }
func (e *fetchFailedError) Unwrap() error { return e.err }

// hireOp is a worker.hire in flight. Its desk is reserved and its worker
// id minted from the start; workspaceID and pane are set (on the hub
// goroutine) once herdr made the workspace, and seen once the hub saw it.
// repo is a worktree hire's repository, set with the workspace.
type hireOp struct {
	startup                    *codexapp.Startup
	delivery                   string
	retryable                  bool
	id, session                string // session: the herdr session the workspace is made in
	floor                      string // #58: the floor the worker belongs to (the session's, or a virtual floor on it)
	desk                       int
	name, label, marker, agent string
	harness, model, effort     string
	cwd, prompt, branch, repo  string
	worktree                   bool
	codexPolicy                codexapp.VersionPolicy
	shared                     bool      // #155: a Codex hire with its own app-server
	profile                    string    // #139: the Codex profile's key ("": none asked for, the default)
	auto                       *autoPick // #140: an Auto hire's, until runHire picks its profile
	hiredAt                    int64
	client                     *Client
	cmd                        proto.Command
	auditID                    int64
	notify                     chan struct{}
	workspaceID, pane          string
	seen                       bool
	launched                   hireLaunched // run.start's, else nil
	watch                      *hireWatch   // #62: a schedule's fire, else nil
	secrets                    *hireSecrets // #108 round 2: its prompt's review, else nil
	// #39: compose builds the first prompt from its user-typed parts, each
	// run through tr (run.start's composed prompt: its extra only); nil: the
	// prompt is the user's text, translated whole. sent is the text the
	// worker gets (set off the hub goroutine before the prompt goes).
	compose firstPrompt
	sent    string
}

// hireSecrets is what the review of a hire's prompt made (#108 round 2):
// its fields after the gate (ps: worker.hire's prompt, run.start's text,
// extra and prompt) with the pending owner of their files (owner; Kind ""
// with none), claimed by the worker once it is seen and released when the
// hire fails; hire.interpret's hand-over it sends (token; claimed with
// them, left pending for another hire when it fails; hiring: taken by
// this hire); a schedule's stored prompt to check before anything reaches
// herdr (stored); and the reviewer it was made under.
type hireSecrets struct {
	rev    *promptsecret.Reviewer
	owner  secretfiles.Owner
	ps     []protected
	token  string
	hiring bool
	stored *storedPrompt
}

// storedPrompt is a schedule's prompt as stored and the record of its
// review ("": none).
type storedPrompt struct{ text, record string }

// dropHireSecrets undoes a hire's review (it failed, or never began): its
// own files go now, a hand-over it took goes back to pending (it expires
// unless another hire claims it). Any goroutine; the files go off the hub
// goroutine.
func (h *Hub) dropHireSecrets(ctx context.Context, sec *hireSecrets) {
	if sec == nil {
		return
	}
	if sec.hiring {
		_ = h.pendingHiring(sec.token, false)
		sec.hiring = false
	}
	if sec.owner.Kind == "" || protectedCount(sec.ps) == 0 {
		return
	}
	owner := sec.owner
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		h.releaseOwner(ctx, owner)
	}()
}

// hireReviewHolds refuses a hire's review the switch made stale (review
// B2; any goroutine), or a prompt that refers to a protected file revoked
// meanwhile (round 5): checked once its worker is seen, and again right
// before its first prompt goes, after waiting for the agent and on its
// input lane. A schedule's stored prompt has no review to go stale; the
// revoked files are checked for every hire, reviewed or not, stored or not
// (review L4: a successor holds files it did not review).
func (h *Hub) hireReviewHolds(op *hireOp) error {
	var rev *promptsecret.Reviewer
	if sec := op.secrets; sec != nil && sec.stored == nil {
		rev = sec.rev
	}
	return h.reviewHolds(rev, op.delivered())
}

// claimHireSecrets gives the hire's files to its worker (off the hub
// goroutine, once it is seen, before its prompt goes): its own pending
// owner's and the hand-over's. A review the switch made stale while the
// hire ran claims nothing (review B2): its own files go, and the prompt
// does not.
func (h *Hub) claimHireSecrets(ctx context.Context, op *hireOp) error {
	sec := op.secrets
	if sec == nil {
		return nil
	}
	if err := h.hireReviewHolds(op); err != nil {
		h.dropHireSecrets(ctx, sec)
		sec.ps = nil
		return err
	}
	if sec.owner.Kind != "" && protectedCount(sec.ps) > 0 {
		if err := h.ps.files.Claim(context.WithoutCancel(ctx), sec.owner.ID, op.id); err != nil {
			if errors.Is(err, secretfiles.ErrNotPending) {
				return fmt.Errorf("%w: its protected files expired before the worker was ready", errSecretsReviewStale)
			}
			return fmt.Errorf("%w: %v", errSecretsUnavailable, err)
		}
	}
	if sec.token != "" {
		if err := h.claimPending(ctx, sec.token, op.id, sec.rev); err != nil {
			return err
		}
		sec.hiring = false
	}
	return nil
}

// hireLaunched finishes a run.start's hire that succeeded (hub goroutine):
// it records the launch and returns the ack data. prompt is the first
// prompt as it was sent.
type hireLaunched func(ctx context.Context, res proto.HireResult, rep *hireReport, prompt string) any

// firstPrompt composes a hire's first prompt, translating only what a
// person typed with tr (#39).
type firstPrompt func(tr func(string) string) string

// hireWatch is how a hire the bridge started itself (#62: a schedule's
// fire, which no client waits for; #219: a handoff's hire) follows it, on
// the hub goroutine: begun once its desk, name and worker id are taken,
// before anything reaches herdr (an error refuses the hire); settled once
// it ended, with its result or its error and how far its first prompt got
// (HireResult.Delivery's values). leaving (#219, "": none) is a worker that
// goes home right after the hire: the caps do not count it.
type hireWatch struct {
	begun   func(ctx context.Context, id string) error
	settled func(ctx context.Context, id string, res *proto.HireResult, delivery string, err error)
	leaving string
}

// startInternalHire begins a hire the bridge starts itself (#62: a
// schedule's fire; #219: a handoff's hire): worker.hire's checks and audit
// row, under by, followed by watch, answered to nobody. a.Prompt is the
// task; the herdr hiring instructions go after it when asked, the task
// alone translated (hireLines). An error refuses it before anything began;
// sec is then the caller's to undo.
func (h *Hub) startInternalHire(ctx context.Context, by string, cmd proto.Command, a proto.WorkerHireArgs, watch *hireWatch,
	sec *hireSecrets) error {
	a, compose := hireLines(a)
	return h.beginHire(ctx, &Client{name: by, kick: func(error) {}}, cmd, a, nil, compose, watch, sec)
}

func (op *hireOp) signal() {
	select {
	case op.notify <- struct{}{}:
	default:
	}
}

// fireOp is a worker.fire in flight. For delete_branch, branch and
// repoRoot are the branch the bridge recorded making for the worker.
// repo is the repository of a linked worktree worker the bridge hired
// (else empty): once its last worktree is gone, the main checkout herdr
// opened for it goes too.
//
// #83: a wrap-up's send home has no client (nobody waits for its reply),
// is strict (a tree that changed while the agent exited fails it instead
// of keeping the worktree) and carries its verdict for the audit log.
type fireOp struct {
	id, name, session, workspaceID string
	pane, harness, choice          string
	checkout, repoRoot, branch     string
	repo                           string
	client                         *Client // nil: a wrap-up's
	cmd                            proto.Command
	auditID                        int64
	notify                         chan struct{}
	removed                        bool
	strict                         bool
	wrapup                         *fireWrapUp
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

// heldNames is every name of a floor no newcomer may take at at (owned, or
// released less than the hold ago), and, of those, when the ones whose
// owner left were released: the input of world.PickName.
func (h *Hub) heldNames(session string, at time.Time) (held map[string]bool, released map[string]time.Time) {
	held, released = map[string]bool{}, map[string]time.Time{}
	for name, c := range h.names[session] {
		if c.released.IsZero() || at.Sub(c.released) < h.opts.NameHold {
			held[name] = true
			if !c.released.IsZero() {
				released[name] = c.released
			}
		}
	}
	return held, released
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

// counts returns how many workers a floor (#58: a floor id; a virtual
// floor counts its own) has and the host has, hires in flight included.
func (h *Hub) counts(floor string) (onFloor, host int) {
	for id, f := range h.floors {
		if !f.running {
			continue
		}
		n := len(f.order)
		for _, op := range f.hires {
			if !op.seen && op.floor == id {
				n++
			}
		}
		host += n
		if id == floor {
			onFloor = n
		}
	}
	return onFloor, host
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
	a.Floor = floorArg(a.Floor, a.Session) // #58: a client from before floor ids names the session
	f, err := h.prepareFloor(a.Floor)
	if err != nil {
		return err
	}
	cwd, err := h.hireCwd(a.Floor, f, a.Cwd)
	if err != nil {
		return err
	}
	res := proto.HirePrepareResult{Cwd: cwd, Capacity: h.capacity(a.Floor), HerdrInstructions: hireInstructions(a.Floor)}
	res.Choice, res.ChoiceSource = h.choice(a.Floor)
	held, released := h.heldNames(a.Floor, h.opts.Now())
	res.Label = world.PickName(uuid.NewString(), held, released)
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res.Git = h.gitInfo(ctx, cwd, !a.Preview)
		if h.opts.Load != nil {
			res.Capacity.Load = h.opts.Load()
		}
		return res, nil
	})
	return nil
}

// gitInfo is the hire dialog's git state of dir: nil outside a work tree.
// A preview reads only local refs; the worktree hire fetches before branching.
func (h *Hub) gitInfo(ctx context.Context, dir string, fetch bool) *proto.HireGit {
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
	g := &proto.HireGit{RepoRoot: top, Preview: !fetch}
	if fetch {
		g.Fetched = true
		if err := h.opts.Git.Fetch(ctx, top); err != nil {
			g.Fetched, g.FetchError = false, err.Error()
		}
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
// worker id and starts the hire. #108 round 2: with prompt secrets
// reviewed, its prompt goes through the gate first (reviewedHire).
func (h *Hub) startHire(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerHireArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	a.Floor = floorArg(a.Floor, a.Session) // #58: a client from before floor ids names the session
	if a.HerdrInstructions && strings.TrimSpace(a.Prompt) == "" {
		return bad("herdr_instructions needs a prompt")
	}
	if err := h.hireShape(withHireLines(a)); err != nil {
		return err
	}
	// #58 decision 3: an asleep virtual floor's session wakes first.
	if waking, err := h.wakeForHire(ctx, c, cmd, a.Floor, func(ctx context.Context) error {
		return h.reviewedHire(ctx, c, cmd, a)
	}); waking || err != nil {
		return err
	}
	return h.reviewedHire(ctx, c, cmd, a)
}

// withHireLines is a with its prompt as the hire sends it: #95, the herdr
// hiring instructions for its floor after the task, as run.start's prompt
// has them.
func withHireLines(a proto.WorkerHireArgs) proto.WorkerHireArgs {
	if a.HerdrInstructions {
		a.Prompt += "\n\n" + hireInstructions(a.Floor)
	}
	return a
}

// hireLines is withHireLines(a) and, with the lines, the compose that
// translates the task (a.Prompt as given) alone (#39): beginHire checks
// the whole prompt (hireShape), and hirePromptFor falls back to it, the
// lines included. worker.hire's and a schedule's fire (#127) share it.
func hireLines(a proto.WorkerHireArgs) (proto.WorkerHireArgs, firstPrompt) {
	if !a.HerdrInstructions {
		return a, nil
	}
	task, lines := a.Prompt, "\n\n"+hireInstructions(a.Floor)
	return withHireLines(a), func(tr func(string) string) string { return tr(task) + lines }
}

// hireTask begins a worker.hire whose task (a.Prompt, without the herdr
// hiring instructions) is as it is sent, with the lines (hireLines).
func (h *Hub) hireTask(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHireArgs, sec *hireSecrets) error {
	a, compose := hireLines(a)
	return h.beginHire(ctx, c, cmd, a, nil, compose, nil, sec)
}

// reviewedHire is worker.hire's prompt through the gate (#108 round 2),
// with the switch on or a review given, then the hire with what it made:
// its files go to a pending owner the worker claims once it is seen; a task
// that is hire.interpret's, exactly as answered (secrets_pending), needs no
// review again, and its files are claimed with it.
func (h *Hub) reviewedHire(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHireArgs) error {
	if !h.gated(a.Secrets != nil || a.SecretsPending != "") {
		return h.hireTask(ctx, c, cmd, a, nil)
	}
	if err := h.stillOn(); err != nil {
		return err
	}
	if a.Prompt == "" {
		if a.Secrets != nil || a.SecretsPending != "" {
			return fmt.Errorf("%w: a review needs the prompt it is of", errSecretsReviewRequired)
		}
		return h.hireTask(ctx, c, cmd, a, nil)
	}
	if err := scannable(a.Prompt, "prompt"); err != nil {
		return err
	}
	rev := h.ps.rev
	var tok secretPending
	if a.SecretsPending != "" {
		var err error
		if tok, err = h.pendingFor(a.SecretsPending, rev, "", true); err != nil {
			return err
		}
	}
	startGated(h, ctx, c, cmd, rev, func(ctx context.Context) (*hireSecrets, error) {
		sec := &hireSecrets{rev: rev, token: a.SecretsPending}
		if a.Secrets == nil && tok.reviewed(a.Prompt) {
			return sec, nil // hire.interpret's task as it answered it
		}
		sec.owner = secretfiles.NewPending()
		ps, err := h.protectFields(ctx, rev, sec.owner, h.opts.Now().Add(h.opts.SecretPendingTTL),
			[]secretField{{text: a.Prompt, review: a.Secrets}})
		if err != nil {
			return nil, err
		}
		sec.ps = ps
		return sec, nil
	}, h.dropHireSecrets, func(ctx context.Context, sec *hireSecrets) error {
		if len(sec.ps) > 0 {
			a.Prompt = sec.ps[0].text
		}
		a.Secrets, a.SecretsPending = nil, ""
		return h.hireTask(ctx, c, cmd, a, sec)
	})
	return nil
}

// hireShape checks what a hire asks for that needs no floor: the desk is
// named, the harness, model and effort can be hired and started, and the
// prompt is well formed.
func (h *Hub) hireShape(a proto.WorkerHireArgs) error {
	if a.DeskIndex == nil {
		return bad("desk_index is required")
	}
	if err := validHireIn(h.hireOptions(), proto.Hire{Harness: a.Harness, Model: a.Model, Effort: a.Effort}); err != nil {
		return &badArgsError{err}
	}
	if !herdr.CanStart(a.Harness) {
		return bad("cannot start harness %q", a.Harness)
	}
	if a.Prompt != "" && !herdr.ValidPrompt(a.Prompt) {
		return bad("prompt must be 1-%d bytes of text, not starting with \"--\"", herdr.MaxPrompt)
	}
	if a.Prompt != "" {
		if err := checkTyped(a.Harness, a.Prompt, herdr.MaxPrompt, "prompt"); err != nil { // #95
			return err
		}
	}
	return h.checkProfileKey(a.Harness, a.CodexProfile, "") // #139
}

// beginHire is the hire of worker.hire, run.start and a schedule's fire
// (#62): it validates a,
// reserves the desk and name, mints the worker id and starts the hire.
// launched, if set, runs on the hub goroutine once the hire succeeded and
// returns the ack data instead of the HireResult (run.start). compose, if
// set, rebuilds a.Prompt with its typed parts translated (run.start's
// composed prompt); nil translates a.Prompt whole (#39). watch, if set,
// follows a hire the bridge started itself (#62). sec (#108 round 2), if
// set, is what the review of its prompt made (a.Prompt is the protected
// one), or a schedule's stored prompt to check first; an error here leaves
// it to the caller.
func (h *Hub) beginHire(ctx context.Context, c *Client, cmd proto.Command, a proto.WorkerHireArgs, launched hireLaunched,
	compose firstPrompt, watch *hireWatch, sec *hireSecrets) error {
	f, err := h.hireFloor(a.Floor)
	if err != nil {
		return err
	}
	if err := h.hireShape(a); err != nil {
		return err
	}
	at := h.opts.Now()
	held, released := h.heldNames(a.Floor, at)
	if a.Label == "" {
		a.Label = world.PickName(uuid.NewString(), held, released)
	}
	if !herdr.ValidLabel(a.Label) {
		return bad("label must be 1-%d bytes without control characters, not starting with \"-\"", herdr.MaxLabel)
	}
	cwd, err := h.hireCwd(a.Floor, f, a.Cwd)
	if err != nil {
		return err
	}
	if a.Worktree && h.opts.Git == nil {
		return errors.New("worktree hires are not configured")
	}
	desk := *a.DeskIndex
	if err := h.hireRoom(a.Floor, f, desk); err != nil {
		return err
	}
	leaving := ""
	if watch != nil {
		leaving = watch.leaving
	}
	if err := h.checkCapsWith(a.Floor, leaving, false); err != nil {
		return err
	}
	if h.opts.Hire == nil {
		return errors.New("hiring is not configured")
	}

	id := uuid.NewString()
	hex := strings.ReplaceAll(id, "-", "")
	name := a.Label
	if !world.Pickable(name, held, released) {
		name = world.PickName(id, held, released)
	}
	op := &hireOp{id: id, session: f.session, floor: a.Floor, desk: desk, name: name, label: a.Label, marker: "h3d-" + hex[:12],
		agent: slug(name) + "-" + hex[:6], harness: a.Harness, model: a.Model, effort: a.Effort, cwd: cwd,
		prompt: a.Prompt, worktree: a.Worktree, hiredAt: at.UnixMilli(), client: c, cmd: cmd,
		notify: make(chan struct{}, 1), launched: launched, compose: compose, shared: a.Harness == "codex" && h.cx.enabled, codexPolicy: h.cx.policy,
		watch: watch, profile: a.CodexProfile}
	if a.CodexProfile == proto.CodexProfileAuto { // #140: picked in runHire, from what the hub has now
		op.profile, op.auto = "", h.autoPickOf()
	}
	if a.Worktree {
		op.branch = "h3d/" + op.agent
	}
	if watch != nil && watch.begun != nil {
		if err := watch.begun(ctx, id); err != nil {
			return err
		}
	}
	if sec != nil && sec.token != "" { // #108: hire.interpret's files are this hire's to claim
		if err := h.pendingHiring(sec.token, true); err != nil {
			return err
		}
		sec.hiring = true
	}
	op.secrets = sec
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, auditArgs(cmd))
	if err != nil {
		return err
	}
	op.auditID = auditID
	if f.hires == nil {
		f.hires = map[string]*hireOp{}
	}
	f.hires[id] = op
	h.floorNames(a.Floor)[name] = nameClaim{owner: id} // held until the hire ends
	// Pending hires make room before their workspace appears.
	h.syncLayout()
	h.log.Info("hire started", "client", c.name, "req_id", cmd.ReqID, "session", a.Floor, "desk", desk,
		"worker", id, "harness", a.Harness, "model", a.Model, "effort", a.Effort, "worktree", a.Worktree)
	h.wg.Add(1)
	go h.runHire(ctx, op)
	return nil
}

// hireRoom refuses a desk of floor (f its state) a hire cannot take: off
// the floor, a worker's, being hired into, or (#219) held for a handoff's
// hire.
func (h *Hub) hireRoom(floor string, f *floorState, desk int) error {
	// A form can outlive the spare desks it was opened on (workers leave
	// while its prompt is written). Grow back to that desk within the cap.
	if n := max(h.opts.MaxDesks, h.deskCount(floor, f)); desk < 0 || desk >= n {
		return fmt.Errorf("%w: desk %d is not on the floor (0-%d)", errDeskTaken, desk, n-1)
	}
	for id, d := range h.desks[floor] {
		if d == desk {
			name := id
			if w := h.workers[id]; w != nil {
				name = w.Name
			}
			return fmt.Errorf("%w: desk %d is %s's", errDeskTaken, desk, name)
		}
	}
	for _, op := range f.hires {
		if op.floor == floor && op.desk == desk {
			return fmt.Errorf("%w: desk %d is being hired into", errDeskTaken, desk)
		}
	}
	return h.deskHeld(floor, desk)
}

// checkCapsWith is checkCaps for one hire, (#219) not counting leaving
// ("": none), a worker that goes home right after it, and with holds the
// desks the handoffs' pending hires hold.
func (h *Hub) checkCapsWith(floor, leaving string, holds bool) error {
	floorN, hostN := h.counts(floor)
	if holds {
		for _, r := range h.hh.byOp {
			if r.holds() {
				hostN++
				if r.rec.Floor == floor {
					floorN++
				}
			}
		}
	}
	if w := h.workers[leaving]; leaving != "" && w != nil {
		hostN--
		if workerFloor(w) == floor {
			floorN--
		}
	}
	return h.capsRefuse(floorN, hostN, 1)
}

// checkCaps refuses a hire that would put the floor or the host above its
// hard cap with need more workers (hires in flight already count).
func (h *Hub) checkCaps(session string, need int) error {
	floorN, hostN := h.counts(session)
	return h.capsRefuse(floorN, hostN, need)
}

// capsRefuse refuses need more workers on a floor and host of floorN and
// hostN.
func (h *Hub) capsRefuse(floorN, hostN, need int) error {
	caps := h.opts.Caps
	switch {
	case floorN+need > caps.FloorHard:
		return fmt.Errorf("%w: the floor has %d workers, the most is %d (--max-workers-per-floor)", errCapacity, floorN,
			caps.FloorHard)
	case hostN+need > caps.HostHard:
		return fmt.Errorf("%w: the host has %d workers, the most is %d (--max-workers)", errCapacity, hostN, caps.HostHard)
	}
	return nil
}

// hireReport is the audit-log result of a worker.hire.
type hireReport struct {
	Startup     []proto.MCPDiagnostic `json:"startup,omitempty"`
	Delivery    string                `json:"delivery"`
	Worker      string                `json:"worker"`
	Desk        int                   `json:"desk"`
	Name        string                `json:"name"`
	Cwd         string                `json:"cwd"`
	Harness     string                `json:"harness"`
	Model       string                `json:"model"`
	Effort      string                `json:"effort"`
	RepoRoot    string                `json:"repo_root,omitempty"`
	Branch      string                `json:"branch,omitempty"`
	Base        string                `json:"base,omitempty"`
	BaseSHA     string                `json:"base_sha,omitempty"`
	Fetched     *bool                 `json:"fetched,omitempty"`
	FetchError  string                `json:"fetch_error,omitempty"`
	WorkspaceID string                `json:"workspace_id,omitempty"`
	Pane        string                `json:"pane,omitempty"`
	Marker      string                `json:"marker,omitempty"`
	Start       string                `json:"start,omitempty"`
	Trust       string                `json:"trust,omitempty"`
	Prompt      string                `json:"prompt,omitempty"`
	Launch      string                `json:"launch,omitempty"`               // run.start's launch id
	Codex       string                `json:"codex,omitempty"`                // #155: shared, or legacy and why
	Profile     string                `json:"codex_profile,omitempty"`        // #139: the Codex profile's name
	Reason      string                `json:"codex_profile_reason,omitempty"` // #140: an Auto hire's pick and why
	Rollback    []string              `json:"rollback,omitempty"`
	Steps       []string              `json:"steps"`
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
	op.delivery, op.retryable = "not_sent", true

	hh, git := h.opts.Hire, h.opts.Git
	rep := &hireReport{Worker: op.id, Desk: op.desk, Name: op.name, Cwd: op.cwd, Harness: op.harness, Model: op.model,
		Effort: op.effort, Marker: op.marker, Steps: []string{}}
	res := proto.HireResult{ID: op.id, Trust: proto.TrustNone}
	var created herdr.Created
	var repo string
	fail := func(err error) {
		if op.startup != nil {
			op.startup.Close()
		}
		if op.startup != nil {
			rep.Startup = mcpdiag.Merge(rep.Startup, op.startup.Snapshot()...)
		}
		var diagnostic *mcpdiag.Failure
		if errors.As(err, &diagnostic) {
			rep.Startup = mcpdiag.Merge(rep.Startup, diagnostic.Diagnostics...)
		}
		rep.Delivery = op.delivery
		if len(rep.Startup) > 0 {
			if auditErr := h.st.AuditProgress(ctx, op.auditID, rep); auditErr != nil {
				h.log.Error("saving startup diagnostics failed", "err", auditErr)
			}
		}
		if op.shared || op.profile != "" { // #155: its server (if one started) goes with it; #139: its launch too
			if note := h.stopSharedServer(ctx, op.id); note != "" {
				rep.Rollback = append(rep.Rollback, note)
				if strings.Contains(note, "survived") {
					op.retryable = false
				}
			}
			_ = h.doWait(ctx, func() { h.forgetCodex(ctx, op.id) })
		}
		if created.WorkspaceID != "" {
			if kept := h.rollbackHire(ctx, op, created, repo, rep); kept != "" {
				op.retryable = false
				err = fmt.Errorf("%w; rolling back, %s", err, kept)
			}
			if op.worktree {
				h.closeIdleMain(ctx, op.notify, op.session, repo, created.WorkspaceID, func(format string, args ...any) {
					rep.Rollback = append(rep.Rollback, fmt.Sprintf(format, args...))
				})
			}
		}
		h.dropHireSecrets(ctx, op.secrets) // #108: its own files go; a hand-over goes back to pending
		h.finishHire(ctx, op, nil, err, rep)
	}
	// #108: a schedule's stored prompt goes only as its review left it,
	// checked before anything reaches herdr.
	if sec := op.secrets; sec != nil && sec.stored != nil {
		if err := h.checkStored(ctx, sec.rev, sec.stored.text, sec.stored.record); err != nil {
			rep.step("prompt secrets: %v", err)
			fail(err)
			return
		}
	}

	if op.worktree {
		var err error
		if repo, err = git.MainCheckout(ctx, op.cwd); err != nil {
			if errors.Is(err, gitops.ErrNotRepo) {
				fail(bad("worktree: %s is not in a git work tree", op.cwd))
			} else {
				fail(fmt.Errorf("%w: worktree: %v", errHireFailed, err))
			}
			return
		}
		rep.RepoRoot = repo
		// Only a freshly fetched base: the last fetched one may lack what
		// was merged since, and every branch from it would revert that
		// (agent-office #119).
		fetched := true
		if err := git.Fetch(ctx, repo); err != nil {
			fetched, rep.FetchError = false, err.Error()
			rep.Fetched = &fetched
			rep.step("git fetch origin failed: %v", err)
			fail(&fetchFailedError{err})
			return
		}
		rep.step("git fetch origin")
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
		// Recorded as the bridge's, for this worker: only such a branch is
		// ever deleted (send home's delete_branch, or a rollback).
		rec := store.HireBranch{WorkerID: op.id, Session: op.session, RepoRoot: repo, Branch: op.branch, BaseSHA: sha, Base: def}
		var recErr error
		if err := h.doWait(ctx, func() { recErr = h.st.RecordHireBranch(ctx, rec) }); err != nil {
			return
		}
		if recErr != nil {
			h.log.Error("recording the hire's branch failed", "worker", op.id, "branch", op.branch, "err", recErr)
			rep.step("recording the branch failed (send home will not delete it): %v", recErr)
		}
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
	if err := h.doWait(ctx, func() { op.repo = repo; h.bindHire(ctx, op, created) }); err != nil {
		return
	}

	if err := hh.MarkPane(ctx, op.session, created.PaneID, op.marker); err != nil {
		fail(fmt.Errorf("%w: herdr pane rename: %v", errHireFailed, err))
		return
	}
	rep.step("marked %s %s", created.PaneID, op.marker)

	dir := op.cwd
	if created.CheckoutPath != "" {
		dir = created.CheckoutPath
	}
	agent := herdr.Agent{Harness: op.harness, Model: op.model, Effort: op.effort, Label: op.label}
	// #140: Auto becomes a concrete profile here, once: everything after
	// (and every wake) runs on that key.
	if op.auto != nil {
		h.resolveAuto(ctx, op, rep, &res)
	}
	// #139: a Codex profile is prepared, and off the default its home is
	// exported in the pane's shell, before anything of Codex starts there.
	var prof *codexProfileRun
	if op.harness == "codex" && op.profile != "" {
		p, release, err := h.prepareProfile(ctx, op.profile)
		defer release()
		if err != nil {
			fail(fmt.Errorf("%w: codex profile: %v", errHireFailed, err))
			return
		}
		prof, rep.Profile = &p, p.name
		if !p.def {
			if err := hh.ExportCodexHome(ctx, op.session, created.PaneID, p.home); err != nil {
				fail(fmt.Errorf("%w: exporting CODEX_HOME: %v", errHireFailed, err))
				return
			}
			rep.step("exported CODEX_HOME=%s in %s (codex profile %s)", p.home, created.PaneID, p.name)
		}
	}
	var startErr error
	switch {
	case op.shared:
		startErr = h.hireShared(ctx, op, created.PaneID, dir, agent, rep, &res, prof)
	case prof != nil:
		startErr = h.hireOnProfile(ctx, op, created.PaneID, dir, agent, rep, &res, prof)
	default:
		startErr = hh.StartAgent(ctx, op.session, created.PaneID, op.agent, agent)
	}
	var api *herdr.APIError
	switch {
	case startErr == nil:
		rep.Start = "ready"
	case isProfileRefused(startErr): // #139: in its own words
		fail(fmt.Errorf("%w: %v", errHireFailed, startErr))
		return
	case errors.As(startErr, &api) && api.Code == "agent_not_ready":
		rep.Start = "blocked during startup"
	default:
		fail(fmt.Errorf("%w: herdr agent start: %w", errHireFailed, startErr))
		return
	}
	rep.step("herdr agent start %s: %s", op.agent, rep.Start)

	trust, note := h.answerTrust(ctx, op, created.PaneID, dir)
	res.Trust, rep.Trust = trust, trust
	if note != "" {
		rep.step("%s", note)
	}
	hooks := op.harness == "codex" && h.hooksReviewShows(ctx, op, created.PaneID, rep) // #155 (B8)

	if !h.awaitHire(ctx, op, time.Now().Add(h.opts.SeenTimeout), func() bool { return op.seen }) {
		if ctx.Err() != nil {
			return
		}
		fail(fmt.Errorf("%w: the new workspace %s was not seen within %s", errHireFailed, created.WorkspaceID, h.opts.SeenTimeout))
		return
	}

	// #108: seen, the worker keeps the files its prompt refers to, also
	// when the prompt does not go (they live until it ends).
	claimErr := h.claimHireSecrets(ctx, op)
	if claimErr != nil {
		rep.step("prompt secrets: %v", claimErr)
	} else {
		h.leaseSuccessor(ctx, op) // round 5: and the files its prompt names (a handoff's)
	}
	if op.prompt != "" && claimErr != nil {
		sent := false
		res.Prompted, res.PromptError = &sent, claimErr.Error()+": send the prompt again"
		rep.Prompt = "not sent: " + res.PromptError
	} else if op.prompt != "" && hooks {
		sent := false
		res.Prompted, res.PromptError = &sent, "Codex asks to review its hooks: answer it in the terminal, then send the prompt"
		rep.Prompt = "not sent: " + res.PromptError
	} else if op.prompt != "" {
		catalogDir := op.cwd
		if op.worktree {
			catalogDir = repo
		}
		op.sent = h.hirePromptFor(op, catalogDir, dir)
		sent, how, perr := h.sendPrompt(ctx, op, created.PaneID)
		res.Prompted = &sent
		if sent {
			op.delivery = "accepted"
		}
		switch {
		case errors.Is(perr, errSecretsReviewStale):
			// #108 review B2: the switch changed while the prompt waited for
			// the agent or its lane, or (round 5) a file it refers to was
			// revoked meanwhile: it did not go, and the files its review
			// made go as at seen (a hand-over's stay the worker's).
			if op.secrets != nil {
				h.unprotectAll(ctx, op.secrets.ps)
				op.secrets.ps = nil
			}
			res.PromptError = perr.Error() + ": send the prompt again"
			rep.step("prompt secrets: %v", perr)
			rep.Prompt = "not sent: " + res.PromptError
		case perr != nil:
			res.PromptError, rep.Prompt = perr.Error(), "failed: "+perr.Error()
		default:
			rep.Prompt = how
		}
	}
	if op.secrets != nil {
		res.Protected = protectedCount(op.secrets.ps)
	}
	choice := store.Hire{Harness: op.harness, Model: op.model, Effort: op.effort}
	if err := h.doWait(ctx, func() {
		if err := h.st.SetLastHire(ctx, op.floor, choice); err != nil {
			h.log.Error("saving the last hire failed", "floor", op.floor, "err", err)
		} else {
			h.lastHire[op.floor] = choice
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
	if !showsPath(screen, dir) {
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

// showsPath reports whether screen shows the path dir whole, not as part
// of a longer path (/tmp/repo is not in /tmp/repo-other or /x/tmp/repo).
// Lines the agent hard-wrapped are joined first: a line is taken to wrap
// when it reaches (about) the width of the screen's longest line and the
// next one is not blank. Checked live on herdr 0.9.0: Claude and Codex
// both break a long path one column short of the pane width and indent
// the rest. In the joined text dir must follow the start, whitespace or a
// quote and be followed by the end, whitespace or a quote. A screen it
// cannot read that way (a path wrapped at a space, say) does not match:
// the dialog is then left for the player.
func showsPath(screen, dir string) bool {
	lines := strings.Split(strings.ReplaceAll(screen, "\r", ""), "\n")
	width := 0
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
		width = max(width, utf8.RuneCountInString(lines[i]))
	}
	var joined strings.Builder
	for i, l := range lines {
		if i > 0 && !wraps(lines[i-1], l, width) {
			joined.WriteByte('\n')
			joined.WriteString(l)
		} else {
			joined.WriteString(strings.TrimLeft(l, " \t"))
		}
	}
	text := joined.String()
	for off := 0; ; {
		i := strings.Index(text[off:], dir)
		if i < 0 {
			return false
		}
		i += off
		if pathEdge(utf8.DecodeLastRuneInString(text[:i])) && pathEdge(utf8.DecodeRuneInString(text[i+len(dir):])) {
			return true
		}
		off = i + 1
	}
}

// wraps reports whether line, on a screen width wide, runs on into next.
func wraps(line, next string, width int) bool {
	return width > 2 && utf8.RuneCountInString(line) >= width-2 && strings.TrimSpace(next) != ""
}

// pathEdge reports whether the rune r (size bytes) may border a path
// shown whole: none (size 0: the start or end of the text), whitespace or
// a quote.
func pathEdge(r rune, size int) bool {
	return size == 0 || unicode.IsSpace(r) || strings.ContainsRune("\"'`‘’“”", r)
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

// hirePromptFor is the hire's first prompt as its harness takes it (#39),
// off the hub goroutine: the typed parts translated against the skills the
// catalog holds for catalogDir (the hire's folder; a worktree hire's
// repository root, where the dialog's completion looked them up) and the
// files of checkout (the new worker's), never waiting for a probe. It fails
// open: a rewrite that is no longer a valid prompt sends the text as typed.
func (h *Hub) hirePromptFor(op *hireOp, catalogDir, checkout string) string {
	tr := func(text string) string {
		if !h.rewrites(op.harness) || text == "" {
			return text
		}
		return h.opts.Prompts.TranslateCached(op.harness, catalogDir, checkout, text)
	}
	var out string
	if op.compose != nil {
		out = op.compose(tr)
	} else {
		out = tr(op.prompt)
	}
	if !herdr.ValidPrompt(out) {
		return op.prompt
	}
	return out
}

// delivered is the first prompt as the worker got it (as it was asked
// for until it was sent).
func (op *hireOp) delivered() string {
	if op.sent != "" {
		return op.sent
	}
	return op.prompt
}

// sendPrompt sends the hire's first prompt once the agent takes it,
// retrying while herdr says the agent is not ready yet. An agent still
// starting up (just past its trust dialog) can take the text but drop the
// Enter (herdr: agent_prompt_stalled): Enter is pressed again until the
// worker is seen working. #108 review B2: its review is checked again
// before each try (a refused one delivered nothing), never after.
func (h *Hub) sendPrompt(ctx context.Context, op *hireOp, pane string) (sent bool, how string, err error) {
	if typesPrompts(op.harness) {
		return h.typeHirePrompt(ctx, op, pane)
	}
	deadline := time.Now().Add(h.opts.TrustTimeout)
	for tries := 1; ; tries++ {
		if err := h.hireReviewHolds(op); err != nil {
			return false, "", err
		}
		op.delivery = "unknown"
		err := h.opts.Hire.Prompt(ctx, op.session, pane, op.delivered())
		if err == nil {
			op.delivery = "accepted"
			return true, fmt.Sprintf("sent (try %d)", tries), nil
		}
		var api *herdr.APIError
		if errors.As(err, &api) && slices.Contains([]string{"agent_not_ready", "agent_not_found", "agent_blocked"}, api.Code) {
			op.delivery = "not_sent"
		}
		if errors.As(err, &api) && api.Code == "agent_prompt_stalled" {
			n, err := h.pressUntilWorking(ctx, op, pane, err)
			return err == nil, fmt.Sprintf("sent, stalled, then %d× Enter", n), err
		}
		if !errors.As(err, &api) || !slices.Contains([]string{"agent_not_ready", "agent_not_found", "agent_blocked"}, api.Code) ||
			time.Now().After(deadline) || ctx.Err() != nil {
			return false, "", err
		}
		sleepCtx(ctx, 4*h.opts.HirePoll)
	}
}

// typeHirePrompt types a Claude hire's first prompt (#95): once herdr
// sees the agent idle or done (text typed before its input box is up is
// lost; within TrustTimeout), on the worker's input lane so a laptop's
// keys cannot land between two chunks. Then the worker is watched for
// PromptAckWait to start working, and Enter pressed again until it does
// (pressUntilWorking: an agent just past its trust dialog can drop the
// first Enter). #108 review B2: its review is checked last, on the lane
// before anything is typed.
func (h *Hub) typeHirePrompt(ctx context.Context, op *hireOp, pane string) (sent bool, how string, err error) {
	deadline := time.Now().Add(h.opts.TrustTimeout)
	var cur promptState
	for {
		if cur, err = query(ctx, h, func() promptState { return h.promptState(op.id) }); err != nil {
			return false, "", err
		}
		if cur.status == statusIdle || cur.status == statusDone {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			return false, "", fmt.Errorf("the agent was not ready for its prompt within %s (herdr says %q)", h.opts.TrustTimeout, cur.status)
		}
		sleepCtx(ctx, h.opts.HirePoll)
	}
	// Read only once the job is done (onLane returned nil).
	var typedHow string
	var typedErr error
	if err := h.onLane(ctx, op.id, func(ctx context.Context) {
		var stale error
		if typedErr = h.doWait(ctx, func() {
			if stale = h.hireReviewHolds(op); stale == nil {
				h.noteTyped(op.id, op.delivered())
			}
		}); typedErr != nil {
			return
		}
		if typedErr = stale; stale != nil {
			return
		}
		op.delivery = "unknown"
		if typedErr = h.opts.Hire.TypePrompt(ctx, op.session, pane, op.delivered()); typedErr != nil {
			h.erasePartlyTyped(ctx, op.id, op.session, pane, typedErr, h.opts.Hire.EraseTyped)
			return
		}
		started, err := h.awaitStarted(ctx, op.id, cur.starts, h.opts.PromptAckWait)
		if typedHow, typedErr = "typed", err; err != nil || started {
			return
		}
		n, err := h.pressUntilWorking(ctx, op, pane, errors.New("typed, but the agent did not start working, Enter pressed again"))
		typedHow, typedErr = fmt.Sprintf("typed, then %d× Enter", n), err
	}); err != nil {
		return false, "", err
	}
	return typedErr == nil, typedHow, typedErr
}

// pressUntilWorking presses submit (at most 3 times) until the hired
// worker's status moves to working, blocked or done: Enter, or the
// harness's retry keys for the prompt (#39: a Codex prompt that ends in a
// "$skill" has its popup take the Enter: Esc, then Enter), as a follow-up's.
func (h *Hub) pressUntilWorking(ctx context.Context, op *hireOp, pane string, stalled error) (int, error) {
	keys := h.retryKeys(op.harness, op.delivered())
	press := func() error {
		if h.opts.Term != nil && !slices.Equal(keys, []string{"enter"}) {
			return h.opts.Term.SendKeys(ctx, op.session, pane, keys...)
		}
		return h.opts.Hire.SendKey(ctx, op.session, pane, herdr.KeyEnter)
	}
	status := func() string {
		s, _ := query(ctx, h, func() string {
			if w := h.workers[op.id]; w != nil {
				return w.Status
			}
			return ""
		})
		return s
	}
	for n := 1; n <= 3; n++ {
		if err := press(); err != nil {
			return n, err
		}
		for end := time.Now().Add(h.opts.TrustTimeout / 5); time.Now().Before(end) && ctx.Err() == nil; {
			switch status() {
			case "working", "blocked", "done":
				return n, nil
			}
			sleepCtx(ctx, h.opts.HirePoll)
		}
	}
	return 3, stalled
}

// rollbackHire closes a failed hire's workspace. A worktree's checkout
// goes too only when its tree is clean, and its fresh branch only when it
// still points at the commit it was made from (nothing of the agent's is
// on it); what is kept, and why, is returned for the error.
func (h *Hub) rollbackHire(ctx context.Context, op *hireOp, created herdr.Created, repo string, rep *hireReport) (kept string) {
	hh, git := h.opts.Hire, h.opts.Git
	note := func(s string) { rep.Rollback = append(rep.Rollback, s) }
	closeWorkspace := func() {
		if err := hh.CloseWorkspace(ctx, op.session, created.WorkspaceID); err != nil {
			op.retryable = false
			note("herdr workspace close failed: " + err.Error())
		} else {
			note("herdr workspace close")
		}
	}
	if !op.worktree {
		closeWorkspace()
		return ""
	}
	checkout := created.CheckoutPath
	var why string
	if checkout == "" || !herdr.ValidDir(checkout) {
		why = "its checkout is unknown"
	} else if dirty, err := git.Status(ctx, checkout); err != nil {
		why = "reading its git status failed: " + err.Error()
	} else if len(dirty) > 0 {
		why = plural(len(dirty), "uncommitted change")
	}
	if why != "" {
		closeWorkspace()
		kept = fmt.Sprintf("the worktree %s and branch %s are kept (%s)", checkout, op.branch, why)
		note(kept)
		return kept
	}
	if err := hh.RemoveWorktree(ctx, op.session, created.WorkspaceID); err != nil {
		note("herdr worktree remove failed: " + err.Error())
		kept = fmt.Sprintf("the worktree %s and branch %s are kept (herdr worktree remove failed)", checkout, op.branch)
		note(kept)
		return kept
	}
	note("herdr worktree remove")
	switch tip, err := git.BranchTip(ctx, repo, op.branch); {
	case err != nil:
		why = "reading where it points failed: " + err.Error()
	case tip != rep.BaseSHA:
		why = fmt.Sprintf("it has commits since %.12s: now at %.12s", rep.BaseSHA, tip)
	}
	if why == "" {
		if err := git.DeleteBranch(ctx, repo, op.branch); err != nil {
			why = "git branch -D failed: " + err.Error()
		}
	}
	if why != "" {
		kept = fmt.Sprintf("the branch %s is kept (%s)", op.branch, why)
		note(kept)
		return kept
	}
	note("git branch -D " + op.branch)
	h.forgetBranch(ctx, op.id)
	return ""
}

// forgetBranch drops the record of the branch the bridge made for a
// worker, once the branch is gone.
func (h *Hub) forgetBranch(ctx context.Context, id string) {
	_ = h.doWait(ctx, func() {
		if err := h.st.ForgetHireBranch(ctx, id); err != nil {
			h.log.Error("forgetting the hire's branch failed", "worker", id, "err", err)
		}
	})
}

// finishHire ends a hire on the hub goroutine: the reservation ends, the
// audit row is completed and the client gets its ack or error.
func (h *Hub) finishHire(ctx context.Context, op *hireOp, res *proto.HireResult, opErr error, rep *hireReport) {
	err := h.doWait(ctx, func() {
		if f := h.floors[op.session]; f != nil && f.hires[op.id] == op {
			delete(f.hires, op.id)
			if op.repo != "" {
				h.resync(ctx, op.session) // its repository's main checkout is no longer held hidden
			}
		}
		if !op.seen {
			if c, ok := h.names[op.floor][op.name]; ok && c.owner == op.id {
				delete(h.names[op.floor], op.name)
			}
		}
		rep.Delivery = op.delivery
		if op.startup != nil {
			rep.Startup = mcpdiag.Merge(rep.Startup, op.startup.Snapshot()...)
		}
		var data any
		if opErr != nil {
			data = proto.HireFailure{Operation: op.id, Cwd: op.cwd, Profile: op.profile, Delivery: op.delivery, Retryable: op.retryable && op.delivery == "not_sent", Startup: rep.Startup}
		}
		if res != nil {
			res.Delivery, res.Startup = op.delivery, rep.Startup
			data = *res
			if op.launched != nil {
				data = op.launched(ctx, *res, rep, op.delivered())
			}
		}
		h.syncLayout()
		if aerr := h.st.AuditEnd(ctx, op.auditID, opErr, rep); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		h.reply(op.client, op.cmd, data, opErr)
		if op.watch != nil && op.watch.settled != nil {
			op.watch.settled(ctx, op.id, res, op.delivery, opErr)
		}
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

// holdRepos are the repositories whose idle main checkout stays hidden
// although no linked worktree of them is open (yet, or any more): a
// worktree hire made its workspace, or a worker the bridge hired into a
// linked worktree is being sent home. The hold ends with the operation,
// after the main checkout was closed (closeIdleMain).
func (h *Hub) holdRepos(f *floorState) map[string]bool {
	var repos map[string]bool
	hold := func(repo string) {
		if repo != "" {
			if repos == nil {
				repos = map[string]bool{}
			}
			repos[repo] = true
		}
	}
	for _, op := range f.hires {
		hold(op.repo)
	}
	for _, op := range f.fires {
		hold(op.repo)
	}
	return repos
}

// hireWorkspaces are the workspaces hires in flight made: workers whatever
// they look like yet (an agentless one is not a hidden main checkout).
func (h *Hub) hireWorkspaces(f *floorState) map[string]bool {
	var ws map[string]bool
	for _, op := range f.hires {
		if op.workspaceID != "" {
			if ws == nil {
				ws = map[string]bool{}
			}
			ws[op.workspaceID] = true
		}
	}
	return ws
}

// signalOps wakes the operations waiting on the floor's workspaces.
func (h *Hub) signalOps(f *floorState) {
	for _, op := range f.hires {
		op.signal()
	}
	for _, op := range f.fires {
		op.signal()
	}
}

// closeIdleMain closes, best effort, the main checkout workspace herdr
// opened for a repository's worktrees (see world.HiddenMainCheckouts)
// once no linked worktree of the repository is open on the floor any more.
// gone is the workspace of the worktree just closed or removed: it is
// waited for first. It never closes a workspace with an agent, and a
// failure is only logged and noted: the workspace then shows as a worker
// again.
func (h *Hub) closeIdleMain(ctx context.Context, notify <-chan struct{}, session, repo, gone string, step func(format string, args ...any)) {
	// What herdr last showed.
	idle := func() (ids []string, linked, goneOpen bool) {
		f := h.floors[session]
		if f == nil {
			return nil, false, false
		}
		for _, w := range f.last {
			switch {
			case w.WorkspaceID == gone:
				goneOpen = true
			case w.IsLinked() && w.Worktree.RepoRoot == repo:
				linked = true
			case w.IsMainCheckout() && w.Worktree.RepoRoot == repo && !w.HasAgent():
				ids = append(ids, w.WorkspaceID)
			}
		}
		return ids, linked, goneOpen
	}
	if !awaitOn(ctx, h, notify, time.Now().Add(h.opts.SeenTimeout), func() bool { _, _, open := idle(); return !open }) {
		return
	}
	type found struct {
		ids    []string
		linked bool
	}
	r, err := query(ctx, h, func() found { ids, linked, _ := idle(); return found{ids, linked} })
	if err != nil || r.linked {
		return
	}
	for _, id := range r.ids {
		if why := h.mainStillIdle(ctx, session, repo, id); why != "" {
			h.log.Warn("not closing the idle main checkout", "session", session, "workspace", id, "repo", repo, "why", why)
			step("herdr workspace close of the repository's main checkout %s skipped: %s", id, why)
			continue
		}
		if err := h.opts.Hire.CloseWorkspace(ctx, session, id); err != nil {
			h.log.Warn("closing the idle main checkout failed", "session", session, "workspace", id, "repo", repo, "err", err)
			step("herdr workspace close of the repository's main checkout %s failed: %v", id, err)
			continue
		}
		step("herdr workspace close of the repository's main checkout %s", id)
		awaitOn(ctx, h, notify, time.Now().Add(h.opts.SeenTimeout), func() bool {
			ids, _, _ := idle()
			return !slices.Contains(ids, id)
		})
	}
}

// mainStillIdle re-reads the floor from herdr (not the hub's last
// observation, which an agent may have outrun: closing a workspace kills
// every process in it) and says why the main checkout workspace id must not
// be closed, "" when it is still a shell of a repository without an open
// linked worktree. A floor that cannot be read is no reason to close.
func (h *Hub) mainStillIdle(ctx context.Context, session, repo, id string) string {
	socket, err := query(ctx, h, func() string {
		if f := h.floors[session]; f != nil {
			return f.socket
		}
		return ""
	})
	if err != nil {
		return err.Error()
	}
	if h.opts.Fresh == nil || socket == "" {
		return "herdr's state cannot be read"
	}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	fresh, err := h.opts.Fresh(rctx, socket)
	if err != nil {
		return fmt.Sprintf("herdr's state cannot be read: %v", err)
	}
	why := "it is gone"
	for _, w := range fresh {
		switch {
		case w.IsLinked() && w.Worktree.RepoRoot == repo:
			return "a worktree of the repository is open again"
		case w.WorkspaceID == id && w.IsMainCheckout() && w.Worktree.RepoRoot == repo:
			why = ""
			if w.HasAgent() {
				why = "an agent runs in it"
			}
		}
	}
	return why
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
	for _, id := range f.all { // herdr's groups are the session's
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
	made, recorded, err := h.st.HireBranchOf(ctx, w.ID)
	if err != nil {
		return err
	}
	holds := h.scheduleHolds() // #63: read here, matched against the tree's top below
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		t := h.readTree(ctx, dir)
		if linked && t.err == nil && t.top != "" {
			// The branch as it is now, not as last displayed.
			if b, err := h.opts.Git.CurrentBranch(ctx, t.top); err == nil {
				res.Branch = b
			}
		}
		switch {
		case t.err != nil:
			res.Reason = "reading the git state failed: " + t.err.Error()
		case t.top == "":
			res.Reason = "not in a git work tree"
		default:
			res.Worktree = &proto.FireWorktree{Path: t.top, Linked: linked}
			res.Dirty = append(res.Dirty, t.dirty[:min(len(t.dirty), maxDirtyLines)]...)
			res.Unpushed = t.unpushed
			held := holds.of(t.top)
			switch why := t.problems(); {
			case !linked:
				res.Reason = "not in a linked worktree (only those can be deleted)"
			case held != "":
				res.Reason = held
			case why != "":
				res.Reason = why
			default:
				res.CanDelete = true
				res.CanDeleteBranch = recorded && h.branchDeletable(ctx, made, t.top) == ""
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
	w, f, err := h.fireWorker(a.ID)
	if err != nil {
		return err
	}
	op, err := h.newFireOp(ctx, w, f, a.Worktree)
	if err != nil {
		return err
	}
	op.client, op.cmd = c, cmd
	auditID, err := h.st.AuditBegin(ctx, c.name, cmd.T, cmd.Args)
	if err != nil {
		return err
	}
	op.auditID = auditID
	h.beginFire(ctx, op, f)
	h.log.Info("send home started", "client", c.name, "req_id", cmd.ReqID, "session", w.Session, "worker", w.ID,
		"worktree", op.choice)
	return nil
}

// newFireOp validates sending w home with a worktree choice ("": keep), as
// worker.fire and a wrap-up's CLEAN do, and returns the operation (no
// client, not started).
func (h *Hub) newFireOp(ctx context.Context, w *proto.Worker, f *floorState, choice string) (*fireOp, error) {
	if choice == "" {
		choice = proto.FireKeep
	}
	if !slices.Contains([]string{proto.FireKeep, proto.FireDelete, proto.FireDeleteBranch}, choice) {
		return nil, bad("worktree must be keep, delete or delete_branch, got %q", choice)
	}
	if why := h.groupBlocked(w, f); why != "" {
		return nil, fmt.Errorf("%w: %s", errFireFailed, why)
	}
	if !herdr.ValidWorkspaceID(w.WorkspaceID) {
		return nil, fmt.Errorf("%w: workspace id %q", errFireFailed, w.WorkspaceID)
	}
	if h.opts.Hire == nil {
		return nil, errors.New("sending workers home is not configured")
	}
	op := &fireOp{id: w.ID, name: w.Name, session: w.Session, workspaceID: w.WorkspaceID, pane: w.PaneID, choice: choice,
		checkout: checkoutOf(w), notify: make(chan struct{}, 1)}
	op.harness = w.AgentKind
	if op.harness == "" {
		op.harness = w.Harness
	}
	if choice != proto.FireKeep {
		switch {
		case w.Worktree == nil || !w.Worktree.Linked:
			return nil, bad("%s does not work in a linked worktree: only keep is possible", w.Name)
		case h.opts.Git == nil:
			return nil, errors.New("deleting worktrees is not configured")
		}
		// #63: checked here against the checkout, and against the tree's
		// top before anything is removed (fireCheck).
		if why := h.scheduleHolds().of(op.checkout); why != "" {
			return nil, fmt.Errorf("%w: %s", errInvalidState, why)
		}
	}
	var made store.HireBranch
	var recorded bool
	if w.Worktree != nil && w.Worktree.Linked {
		var err error
		if made, recorded, err = h.st.HireBranchOf(ctx, w.ID); err != nil {
			return nil, err
		}
		if recorded {
			op.repo = w.Worktree.RepoRoot
		}
	}
	if choice == proto.FireDeleteBranch {
		// Only the branch the bridge recorded making for this worker; its
		// name alone proves nothing.
		if !recorded || !herdr.ValidBranch(made.Branch) || !herdr.ValidDir(made.RepoRoot) {
			return nil, bad("the bridge made no branch for %s: delete the worktree only", w.Name)
		}
		op.branch, op.repoRoot = made.Branch, made.RepoRoot
	}
	return op, nil
}

// beginFire starts an operation from newFireOp, its audit row begun.
func (h *Hub) beginFire(ctx context.Context, op *fireOp, f *floorState) {
	if f.fires == nil {
		f.fires = map[string]*fireOp{}
	}
	f.fires[op.id] = op
	h.wg.Add(1)
	go h.runFire(ctx, op)
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
	// #83: the wrap-up whose CLEAN sent the worker home.
	WrapUp *fireWrapUp `json:"wrapup,omitempty"`
	// top is the worktree's top level git last read (fireCheck).
	top string
}

// fireWrapUp is the wrap-up behind a send home, in its audit report.
type fireWrapUp struct {
	Nonce   string `json:"nonce"`
	Verdict string `json:"verdict"`
	Reason  string `json:"reason,omitempty"`
}

func (r *fireReport) step(format string, args ...any) {
	r.Steps = append(r.Steps, fmt.Sprintf(format, args...))
}

// runFire checks the tree (for a delete), exits the agent gracefully and,
// once it is gone, closes the workspace or removes its worktree, waits for
// the worker to be gone and deletes the branch when asked. An agent that
// does not exit is left as it is: nothing is closed.
func (h *Hub) runFire(ctx context.Context, op *fireOp) {
	defer h.wg.Done()
	hh := h.opts.Hire
	rep := &fireReport{Worker: op.id, Workspace: op.workspaceID, Choice: op.choice, Checkout: op.checkout, Steps: []string{},
		WrapUp: op.wrapup}
	res := proto.FireResult{Worktree: proto.WorktreeKept}
	remove := op.choice != proto.FireKeep
	// #63: a worktree a schedule holds is kept, with a note.
	keepHeld := func(held string) {
		remove = false
		res.Note = heldKept(held)
		if op.wrapup != nil {
			op.wrapup.Reason = res.Note
		}
		rep.step("%s", res.Note)
	}
	if remove {
		why, held, err := h.fireCheck(ctx, op, rep)
		switch {
		case err != nil:
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: %v", errFireFailed, err), rep)
			return
		case held != "" && op.wrapup != nil:
			keepHeld(held) // a wrap-up's CLEAN keeps a held worktree
		case held != "":
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: %s", errInvalidState, held), rep)
			return
		case why != "":
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: %s: the worktree is kept", errNotClean, why), rep)
			return
		default:
			rep.step("tree clean and pushed")
		}
	}

	if name, err := h.stopManualForOwner(ctx, op.id, "stopped for send-home"); err != nil {
		h.finishFire(ctx, op, nil, fmt.Errorf("%w: cannot verify manual process %s stopped: nothing was closed or removed", errFireFailed, name), rep)
		return
	}
	exit := h.exitAgent(ctx, op, rep)
	res.Released = exit == exitedByItself
	rep.Released = res.Released
	switch exit {
	case exitStuck:
		h.finishFire(ctx, op, nil, fmt.Errorf("%w: %s's agent is still running (%s, then Ctrl-C twice): nothing was closed or removed",
			errFireFailed, op.name, rep.Exit), rep)
		return
	case exitUnknown:
		h.finishFire(ctx, op, nil, fmt.Errorf("%w: cannot tell whether %s's agent is still running (%s): nothing was closed or removed",
			errFireFailed, op.name, rep.Exit), rep)
		return
	case exitHeld:
		h.finishFire(ctx, op, nil, fmt.Errorf("%w: %s's agent is still running (%s; no Ctrl-C to its shared Codex terminal, "+
			"which could open Codex's agent command center: quit it there and send it home again): nothing was closed or removed",
			errFireFailed, op.name, rep.Exit), rep)
		return
	}
	// #155: a shared worker's server outlives its pane: it goes now.
	if note := h.stopSharedServer(ctx, op.id); note != "" {
		rep.step("%s", note)
	}

	if remove {
		if why, held, err := h.fireCheck(ctx, op, rep); held != "" {
			keepHeld(held) // held while the agent exited: kept, never deleted
		} else if err != nil || why != "" {
			if err != nil {
				why = err.Error()
			}
			if op.strict {
				// #83: a wrap-up deletes the worktree or leaves the worker
				// at its desk, never half of it.
				rep.step("the tree changed while the agent exited (%s): nothing closed", why)
				h.finishFire(ctx, op, nil, fmt.Errorf("%w: the tree changed while %s's agent exited (%s): nothing was closed or removed",
					errNotClean, op.name, why), rep)
				return
			}
			remove = false
			res.Note = "the tree changed while the agent exited (" + why + "): the worktree is kept"
			rep.step("%s", res.Note)
		}
	}
	// release ends the reservation below, before the result goes out.
	release := func() {
		if remove {
			_ = h.doWait(ctx, func() { h.releaseRemoval(op.id) })
		}
	}
	if remove {
		// #63: the last hold check, and the worktree reserved for its
		// removal, in one hub step: a schedule acknowledged before it is
		// seen here, and one after it is refused until the removal ends.
		held, err := query(ctx, h, func() string { return h.reserveRemoval(op.id, rep.top) })
		switch {
		case err != nil:
			h.finishFire(ctx, op, nil, fmt.Errorf("%w: %v", errFireFailed, err), rep)
			return
		case held != "":
			keepHeld(held)
		}
	}
	if remove {
		if err := hh.RemoveWorktree(ctx, op.session, op.workspaceID); err != nil {
			release()
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
	gone := awaitOn(ctx, h, op.notify, time.Now().Add(h.opts.SeenTimeout), func() bool { return op.removed })
	release()
	if !gone {
		if ctx.Err() != nil {
			return
		}
		h.finishFire(ctx, op, nil, fmt.Errorf("%w: herdr closed %s, but it was not seen gone within %s",
			errFireFailed, op.workspaceID, h.opts.SeenTimeout), rep)
		return
	}
	if remove && op.choice == proto.FireDeleteBranch {
		// The checkout is gone; the branch's commits are checked once more.
		switch n, err := h.opts.Git.BranchUnpushed(ctx, op.repoRoot, op.branch); {
		case err != nil:
			res.Note = "the branch was kept: " + err.Error()
		case n > 0:
			res.Note = "the branch was kept: " + plural(n, "commit") + " not on any remote"
		default:
			if err := h.opts.Git.DeleteBranch(ctx, op.repoRoot, op.branch); err != nil {
				res.Note = "the branch was kept: " + err.Error()
			} else {
				res.Worktree = proto.WorktreeDelBranch
				h.forgetBranch(ctx, op.id)
			}
		}
		rep.step("git branch -D %s: %s", op.branch, orOK(res.Note))
	}
	if op.repo != "" {
		h.closeIdleMain(ctx, op.notify, op.session, op.repo, op.workspaceID, rep.step)
	}
	rep.Worktree = res.Worktree
	h.finishFire(ctx, op, &res, nil, rep)
}

// fireCheck says why a worker's worktree may not be deleted now: held, a
// schedule's cwd is in it (#63); why, its tree is dirty or has commits on
// no remote, or (delete_branch) the checkout is no longer on the branch the
// bridge made or that branch has commits on no remote. err: the state
// could not be read. Off the hub goroutine.
func (h *Hub) fireCheck(ctx context.Context, op *fireOp, rep *fireReport) (why, held string, err error) {
	t := h.readTree(ctx, op.checkout)
	rep.Dirty, rep.Unpushed, rep.top = t.dirty, t.unpushed, t.top
	switch {
	case t.err != nil:
		return "", "", fmt.Errorf("reading the git state: %v", t.err)
	case t.top == "":
		return "", "", fmt.Errorf("%s is not a git work tree", op.checkout)
	}
	holds, err := query(ctx, h, h.scheduleHolds)
	if err != nil {
		return "", "", err
	}
	switch held := holds.of(t.top); {
	case held != "":
		return "", held, nil
	case t.problems() != "":
		return t.problems(), "", nil
	case op.branch == "":
		return "", "", nil
	}
	return h.branchDeletable(ctx, store.HireBranch{RepoRoot: op.repoRoot, Branch: op.branch}, t.top), "", nil
}

// heldKept is the note of a send home that kept a held worktree (#63).
func heldKept(held string) string { return held + ": the worktree is kept" }

// branchDeletable says why the branch the bridge made may not be deleted
// with the worktree at checkout: the checkout is on another branch now
// (read afresh, not the displayed one), or the branch has commits on no
// remote. "" when it may.
func (h *Hub) branchDeletable(ctx context.Context, made store.HireBranch, checkout string) string {
	git := h.opts.Git
	cur, err := git.CurrentBranch(ctx, checkout)
	if err != nil {
		return "reading the checkout's branch failed: " + err.Error()
	}
	if cur != made.Branch {
		now := "a detached HEAD"
		if cur != "" {
			now = "branch " + cur
		}
		return fmt.Sprintf("the checkout is on %s, not %s (the branch the bridge made)", now, made.Branch)
	}
	n, err := git.BranchUnpushed(ctx, made.RepoRoot, made.Branch)
	switch {
	case err != nil:
		return "counting the commits of " + made.Branch + " failed: " + err.Error()
	case n > 0:
		return plural(n, "commit") + " of " + made.Branch + " not on any remote"
	}
	return ""
}

func orOK(note string) string {
	if note == "" {
		return "ok"
	}
	return note
}

// How a send home's agent went (exitAgent).
type exitResult int

const (
	exitedByItself   exitResult = iota // it exited gracefully, or none ran
	exitedAfterCtrlC                   // it left after Ctrl-C
	exitStuck                          // it is still running
	exitHeld                           // #155: a shared Codex worker's is still running, and gets no Ctrl-C
	exitUnknown                        // its pane's processes cannot be read
)

// exitAgent exits the pane's agent the way a person would (claude /exit,
// codex /quit, then Enter) and waits for the pane to be back at its shell;
// Ctrl-C twice when it is not (or the agent has no graceful exit), except
// for a shared Codex worker (#155), which is left as it is.
func (h *Hub) exitAgent(ctx context.Context, op *fireOp, rep *fireReport) exitResult {
	hh := h.opts.Hire
	if op.pane == "" || !herdr.ValidPaneID(op.pane) {
		rep.Exit = "no pane"
		return exitedByItself
	}
	info, err := h.paneProcesses(ctx, op.session, op.pane)
	switch {
	case err != nil:
		rep.Exit = "reading the pane's processes failed: " + err.Error()
		return exitUnknown
	case info.AtShell():
		rep.Exit = "no agent running"
		return exitedByItself
	}
	start := time.Now()
	if h.exitGracefully(ctx, op, rep) {
		return exitedByItself
	}
	// #155: never Ctrl-C into a shared worker's Codex. Its terminal may be on
	// a dialog the bridge did not expect, where Ctrl-C opens the agent
	// command center listing the user's other threads (B10). Its server
	// stays up: a TUI whose server is gone waits to reconnect (B6), and the
	// terminal stays usable to quit by hand. #158: except when its server
	// is already gone, the one state where /quit does nothing and Ctrl-C is
	// what that TUI offers (codexQuitGone): it goes as a legacy worker goes.
	shared, err := query(ctx, h, func() bool { return h.isShared(op.id) })
	if (shared || err != nil) && !(err == nil && h.codexServerGone(ctx, op.id)) {
		rep.step("agent still running after %s: no Ctrl-C to a shared Codex worker's terminal, nothing closed",
			time.Since(start).Round(time.Millisecond))
		return exitHeld
	}
	for range 2 {
		if err := hh.SendKey(ctx, op.session, op.pane, herdr.KeyCtrlC); err != nil {
			rep.step("Ctrl-C failed: %v", err)
			break
		}
		if h.waitShell(ctx, op, time.Now().Add(h.opts.ExitTimeout/4)) {
			rep.step("agent exited after Ctrl-C")
			return exitedAfterCtrlC
		}
	}
	rep.step("agent still running after %s: nothing closed", time.Since(start).Round(time.Millisecond))
	return exitStuck
}

// exitGracefully types the agent's exit command and presses Enter (again,
// up to 3 times, while it is not gone), waiting up to ExitTimeout for the
// pane to be back at its shell.
func (h *Hub) exitGracefully(ctx context.Context, op *fireOp, rep *fireReport) bool {
	hh := h.opts.Hire
	if !herdr.CanStart(op.harness) {
		rep.Exit = fmt.Sprintf("no graceful exit for %q", op.harness)
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
	deadline := start.Add(h.opts.ExitTimeout)
	// An agent still starting up (e.g. just past its trust dialog) can drop
	// the first Enter: press it again a few times while it is not gone.
	for presses := 1; ; presses++ {
		next := time.Now().Add(h.opts.ExitTimeout / 5)
		if presses > 3 || next.After(deadline) {
			next = deadline
		}
		if h.waitShell(ctx, op, next) {
			rep.step("agent exited after %s (%d× Enter)", time.Since(start).Round(time.Millisecond), presses)
			return true
		}
		if !time.Now().Before(deadline) || ctx.Err() != nil {
			return false
		}
		if err := hh.SendKey(ctx, op.session, op.pane, herdr.KeyEnter); err != nil {
			rep.step("pressing Enter again failed: %v", err)
			return false
		}
	}
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
			if op.repo != "" {
				h.resync(ctx, op.session) // its repository's main checkout is no longer held hidden
			}
		}
		if aerr := h.st.AuditEnd(ctx, op.auditID, opErr, rep); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		if opErr == nil { // #155: gone, and so is its server
			h.forgetCodex(ctx, op.id)
			h.releaseSecrets(op.id) // #108: and its protected files
		}
		if op.wrapup != nil { // #83
			h.wrapUpFired(ctx, op, opErr)
		}
		if op.client == nil {
			return
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
