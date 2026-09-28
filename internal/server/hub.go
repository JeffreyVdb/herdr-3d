package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/JeffreyVdb/herdr-3d/internal/gitops"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// ErrSlowConsumer is why a client whose send queue filled up was dropped.
var ErrSlowConsumer = errors.New("slow consumer")

// Options configure a Hub.
type Options struct {
	Ring     int           // events kept for since_seq replay (default 4096)
	Queue    int           // per-client send queue, in messages (default 1024)
	MaxDesks int           // cap on the desks a floor renders beyond its occupied ones (default DefaultMaxDesks)
	NameHold time.Duration // how long a name stays held for a worker that left its floor, from when it left (default DefaultNameHold)
	Server   string        // version banner sent in welcome
	Log      *slog.Logger
	Now      func() time.Time // bridge clock for status_since and the name hold (default time.Now)

	// Herdr wakes floors and puts them to sleep (nil: floor.wake and
	// floor.sleep fail with internal).
	Herdr FloorHerdr
	// Sessions, if set, is the only set of sessions floor commands may act
	// on (the watcher's --sessions filter, checked again here).
	Sessions *regexp.Regexp
	// WakeTimeout bounds starting a woken server, its answering ping and
	// its floor being seen running, together (default DefaultWakeTimeout).
	WakeTimeout time.Duration
	// ResumeTimeout is how long a wake waits for the agents before the
	// fallback, and again for the fallback and its result; each bounds
	// every herdr call in it (default DefaultResumeTimeout).
	ResumeTimeout time.Duration
	// SleepTimeout bounds waiting for a stopped floor to be seen asleep
	// (default DefaultSleepTimeout).
	SleepTimeout time.Duration
	// ResumePoll is how often a wake looks at the panes' processes, and
	// ResumeSettle how long an agent process must keep running to count as
	// resumed (defaults 500 ms, 1.5 s).
	ResumePoll, ResumeSettle time.Duration
	// CodexSession finds the Codex session id of a cwd for the sleep
	// backfill, skipping ids already in use (nil: no backfill).
	CodexSession func(cwd string, skip func(id string) bool) (string, error)
	// RepoOf returns the GitHub owner/repo of a directory, or "" (nil: no
	// repo suggestions). It runs off the hub goroutine.
	RepoOf func(ctx context.Context, dir string) string
	// StatDir checks a default_cwd setting and a hire's cwd (default: an
	// existing directory).
	StatDir func(dir string) error

	// Hire hires workers and sends them home (nil: worker.hire and
	// worker.fire fail with internal).
	Hire HireHerdr
	// Git reads git state for hires and send-homes and runs their few git
	// commands (nil: no git info, no worktree hires or deletes).
	Git Git
	// Caps are the worker caps (zero: DefaultCaps).
	Caps Caps
	// HireOptions, if set, replaces what can be hired (tests: cheap models).
	HireOptions *proto.HireOptions
	// Load reads the host load for hire.prepare (nil: none).
	Load func() *proto.HostLoad
	// HomeDir is a hire's cwd when neither it nor the floor names one
	// (default: the user's home directory).
	HomeDir string
	// BranchOf reads the branch checked out at a linked worktree (default
	// gitops.HeadBranch).
	BranchOf func(checkout string) string
	// TrustTimeout bounds answering an agent's trust dialog, and retrying
	// the first prompt (default DefaultTrustTimeout); SeenTimeout how long a
	// hire or send-home waits for the bridge to see the workspace appear or
	// go (default DefaultSeenTimeout); ExitTimeout how long an agent has to
	// exit when sent home (default DefaultExitTimeout).
	TrustTimeout, SeenTimeout, ExitTimeout time.Duration
	// HirePoll is how often a hire or send-home looks at a pane, and
	// ExitPause the pause between Codex's /quit and Enter (defaults 250 ms,
	// 400 ms).
	HirePoll, ExitPause time.Duration
}

// DefaultMaxDesks is the default Options.MaxDesks.
const DefaultMaxDesks = 96

// DefaultNameHold is the default Options.NameHold.
const DefaultNameHold = 7 * 24 * time.Hour

// minDesks is the fewest desks a floor renders; spareDesks how many free
// desks it keeps beyond its workers (within MaxDesks).
const (
	minDesks   = 6
	spareDesks = 2
)

// Hub owns the world model. A single goroutine (Run) applies watcher
// observations and client commands, persists through the store, assigns
// event sequence numbers and fans events out to clients. Nothing it does
// blocks on a client: a client that cannot keep up is dropped.
type Hub struct {
	opts    Options
	log     *slog.Logger
	st      *store.Store
	epoch   string
	updates chan world.Update
	ops     chan func(context.Context)
	done    chan struct{} // closed when Run returns

	seq     uint64
	ring    *ring
	clients map[*Client]struct{}

	buildings map[string]store.Building
	assign    map[string]store.Assignment // by session
	floors    map[string]*floorState
	workers   map[string]*proto.Worker        // by worker id
	saved     map[string]savedWorker          // what the store last got, by worker id
	desks     map[string]map[string]int       // floor → worker id → desk index (mirrors desk_assignment)
	names     map[string]map[string]nameClaim // floor → name → claim (mirrors worker_name)

	viewBuildings map[string]proto.Building
	viewFloors    map[string]proto.Floor

	settings map[string]store.FloorSettings // by session (mirrors floor_repo)
	lastHire map[string]store.Hire          // by session (mirrors floor_hire_last)
	branches map[string]branchRead          // checkout path → its branch, read recently
	resume   map[string]string              // worker id → resume state, during and after a wake
	rescan   chan struct{}                  // asks the watcher to look at sessions now
	suggest  chan suggestJob                // repo lookups for the suggester
	wg       sync.WaitGroup                 // floor operations and the suggester
}

type floorState struct {
	running bool
	def     bool
	err     string
	gen     uint64
	socket  string
	byWS    map[string]string // workspace id → worker id
	order   []string          // worker ids in herdr's sidebar order

	op        *floorOp           // wake or sleep in progress
	hires     map[string]*hireOp // hires in flight, by worker id
	fires     map[string]*fireOp // send-homes in flight, by worker id
	last      []world.WorkerObs  // the workers last observed (a hire re-applies them)
	origins   map[string]string  // cwd → GitHub repo, from the suggester
	askedCwds []string           // cwds of the last repo lookup
	askedAt   time.Time
	suggested *proto.Suggested
}

type savedWorker struct {
	workspaceID, label string
	fps                map[store.Fingerprint]bool
	meta               workerMeta
}

// workerMeta is what the bridge keeps with a worker beyond what herdr
// currently shows: the last known harness, model and effort, and since
// when (unix ms) it has had its status.
type workerMeta struct {
	harness, model, effort string
	status                 string
	statusSince            int64
	hiredAt                int64
}

// branchRead is a linked worktree's branch as read at.
type branchRead struct {
	branch string
	at     time.Time
}

// nameClaim is who owns a name on a floor.
type nameClaim struct {
	owner    string    // worker id
	released time.Time // when the owner was seen leaving the floor; zero while it is on it
}

// Client is one connected protocol client, as seen by the hub.
type Client struct {
	name string
	send chan []byte
	kick func(error) // closes the connection; never blocks
}

// NewClient makes a client with a bounded send queue. kick is called (at
// most once per reason, from the hub goroutine) to disconnect it.
func (h *Hub) NewClient(name string, kick func(error)) *Client {
	return &Client{name: name, send: make(chan []byte, h.opts.Queue), kick: kick}
}

// Send is the client's outgoing queue.
func (c *Client) Send() <-chan []byte { return c.send }

// NewHub loads buildings and floor assignments from st.
func NewHub(ctx context.Context, st *store.Store, opts Options) (*Hub, error) {
	if opts.Ring <= 0 {
		opts.Ring = 4096
	}
	if opts.Queue <= 0 {
		opts.Queue = 1024
	}
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	if opts.MaxDesks <= 0 {
		opts.MaxDesks = DefaultMaxDesks
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.NameHold <= 0 {
		opts.NameHold = DefaultNameHold
	}
	if opts.WakeTimeout <= 0 {
		opts.WakeTimeout = DefaultWakeTimeout
	}
	if opts.ResumeTimeout <= 0 {
		opts.ResumeTimeout = DefaultResumeTimeout
	}
	if opts.SleepTimeout <= 0 {
		opts.SleepTimeout = DefaultSleepTimeout
	}
	if opts.ResumePoll <= 0 {
		opts.ResumePoll = defaultResumePoll
	}
	if opts.ResumeSettle <= 0 {
		opts.ResumeSettle = defaultResumeSettle
	}
	if opts.StatDir == nil {
		opts.StatDir = isDir
	}
	if opts.Caps == (Caps{}) {
		opts.Caps = DefaultCaps
	}
	if opts.HomeDir == "" {
		opts.HomeDir = homeDir()
	}
	if opts.BranchOf == nil {
		opts.BranchOf = gitops.HeadBranch
	}
	if opts.TrustTimeout <= 0 {
		opts.TrustTimeout = DefaultTrustTimeout
	}
	if opts.SeenTimeout <= 0 {
		opts.SeenTimeout = DefaultSeenTimeout
	}
	if opts.ExitTimeout <= 0 {
		opts.ExitTimeout = DefaultExitTimeout
	}
	if opts.HirePoll <= 0 {
		opts.HirePoll = defaultHirePoll
	}
	if opts.ExitPause <= 0 {
		opts.ExitPause = defaultExitPause
	}
	var epoch [8]byte
	_, _ = rand.Read(epoch[:])
	h := &Hub{
		opts:          opts,
		log:           opts.Log,
		st:            st,
		epoch:         hex.EncodeToString(epoch[:]),
		updates:       make(chan world.Update, 256),
		ops:           make(chan func(context.Context), 64),
		done:          make(chan struct{}),
		ring:          newRing(opts.Ring),
		clients:       map[*Client]struct{}{},
		floors:        map[string]*floorState{},
		workers:       map[string]*proto.Worker{},
		saved:         map[string]savedWorker{},
		desks:         map[string]map[string]int{},
		names:         map[string]map[string]nameClaim{},
		viewBuildings: map[string]proto.Building{},
		viewFloors:    map[string]proto.Floor{},
		resume:        map[string]string{},
		branches:      map[string]branchRead{},
		rescan:        make(chan struct{}, 1),
		suggest:       make(chan suggestJob, 256),
	}
	if err := h.reload(ctx); err != nil {
		return nil, err
	}
	var err error
	if h.settings, err = st.FloorSettings(ctx); err != nil {
		return nil, err
	}
	if h.lastHire, err = st.LastHires(ctx); err != nil {
		return nil, err
	}
	desks, err := st.Desks(ctx)
	if err != nil {
		return nil, err
	}
	for _, d := range desks {
		h.floorDesks(d.Floor)[d.WorkerID] = d.Index
	}
	names, err := st.Names(ctx)
	if err != nil {
		return nil, err
	}
	for _, c := range names {
		h.floorNames(c.Floor)[c.Name] = nameClaim{owner: c.WorkerID, released: c.Released}
	}
	for _, b := range h.buildingViews() {
		h.viewBuildings[b.ID] = b
	}
	return h, nil
}

// Epoch identifies this hub instance; since_seq is only valid within one.
func (h *Hub) Epoch() string { return h.epoch }

// Updates is where watchers send observations.
func (h *Hub) Updates() chan<- world.Update { return h.updates }

// Rescans signals when the watcher should look at sessions right away
// (watch.Config.Rescan).
func (h *Hub) Rescans() <-chan struct{} { return h.rescan }

// Run processes updates and client operations until ctx is done. Floor
// operations still running end with ctx before it returns.
func (h *Hub) Run(ctx context.Context) error {
	defer close(h.done)
	defer h.wg.Wait()
	if h.opts.RepoOf != nil {
		h.wg.Add(1)
		go h.suggester(ctx)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case u := <-h.updates:
			switch u := u.(type) {
			case world.FloorObs:
				h.applyFloor(ctx, u)
			case world.FloorGone:
				h.removeFloor(u)
			case world.AgentDetected:
				h.agentDetected(u)
			}
		case op := <-h.ops:
			op(ctx)
		}
	}
}

func (h *Hub) do(ctx context.Context, op func(context.Context)) error {
	select {
	case h.ops <- op:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-h.done:
		return errHubStopped
	}
}

var errHubStopped = errors.New("hub stopped")

// Join registers c after hello: it queues the welcome, then either the
// replay of every event after hello.SinceSeq (same epoch, still in the ring)
// or a fresh world.snapshot, then live events. It all happens in the hub
// goroutine, so nothing is missed or duplicated between them.
func (h *Hub) Join(ctx context.Context, c *Client, hello proto.Hello) error {
	return h.do(ctx, func(context.Context) {
		resume := proto.ResumeSnapshot
		var replay [][]byte
		if hello.SinceSeq != nil && hello.Epoch == h.epoch {
			if evs, ok := h.ring.since(*hello.SinceSeq, h.seq); ok && len(evs) <= cap(c.send)/2 {
				resume, replay = proto.ResumeReplay, evs
			}
		}
		h.clients[c] = struct{}{}
		h.deliver(c, mustJSON(proto.Welcome{
			T: proto.TWelcome, Proto: proto.Version, ServerSeq: h.seq, Epoch: h.epoch, Resume: resume, Server: h.opts.Server,
		}))
		if resume == proto.ResumeSnapshot {
			h.deliver(c, mustJSON(h.snapshot()))
			return
		}
		for _, msg := range replay {
			h.deliver(c, msg)
		}
	})
}

// Leave unregisters c. It works after the client's own context is gone.
func (h *Hub) Leave(c *Client) {
	_ = h.do(context.Background(), func(context.Context) { delete(h.clients, c) })
}

// Command runs one client command; its ack or error is queued to c after
// the events it caused. Accepted or rejected, it is audited.
func (h *Hub) Command(ctx context.Context, c *Client, cmd proto.Command) error {
	return h.do(ctx, func(ctx context.Context) {
		if _, ok := h.clients[c]; !ok {
			return
		}
		if cmd.ReqID == "" {
			h.audit(ctx, c, cmd, errNoReqID)
			h.reply(c, cmd, nil, errNoReqID)
			return
		}
		var start func(context.Context, *Client, proto.Command) error
		switch cmd.T {
		case proto.CmdFloorWake, proto.CmdFloorSleep:
			start = h.startFloorOp
		case proto.CmdWorkerHire:
			start = h.startHire
		case proto.CmdWorkerFire:
			start = h.startFire
		case proto.CmdHirePrepare:
			start = h.startHirePrepare
		case proto.CmdFirePrepare:
			start = h.startFirePrepare
		}
		if start != nil {
			// Accepted: the audit row is written (or begun) and the reply
			// sent when the slow part is done.
			if err := start(ctx, c, cmd); err != nil {
				h.audit(ctx, c, cmd, err)
				h.reply(c, cmd, nil, err)
			}
			return
		}
		data, err := h.command(ctx, cmd)
		h.audit(ctx, c, cmd, err)
		h.reply(c, cmd, data, err)
	})
}

func (h *Hub) audit(ctx context.Context, c *Client, cmd proto.Command, err error) {
	if aerr := h.st.Audit(ctx, c.name, cmd.T, cmd.Args, err); aerr != nil {
		h.log.Error("audit log write failed", "err", aerr)
	}
}

// reply sends a command's ack or error to c, if it is still connected.
func (h *Hub) reply(c *Client, cmd proto.Command, data any, err error) {
	if err != nil {
		code := errorCode(err)
		h.log.Info("command rejected", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID, "code", code, "err", err)
		h.deliver(c, mustJSON(proto.Error{T: proto.TError, ReqID: cmd.ReqID, Code: code, Message: err.Error()}))
		return
	}
	h.log.Info("command applied", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID)
	h.deliver(c, mustJSON(proto.Ack{T: proto.TAck, ReqID: cmd.ReqID, Data: data}))
}

var (
	errUnknownSession = errors.New("unknown session")
	errNoReqID        = errors.New("commands need a req_id")
)

func errorCode(err error) string {
	var bad *badArgsError
	var fetch *fetchFailedError
	switch {
	case errors.As(err, &fetch):
		return proto.ErrFetchFailed
	case errors.As(err, &bad), errors.Is(err, store.ErrInvalid), errors.Is(err, errNoReqID):
		return proto.ErrBadRequest
	case errors.Is(err, store.ErrNotFound):
		return proto.ErrNotFound
	case errors.Is(err, store.ErrNameTaken):
		return proto.ErrNameTaken
	case errors.Is(err, errUnknownSession):
		return proto.ErrUnknownSession
	case errors.Is(err, errUnknownCommand):
		return proto.ErrUnknownCommand
	case errors.Is(err, errBusy):
		return proto.ErrBusy
	case errors.Is(err, errInvalidState):
		return proto.ErrInvalidState
	case errors.Is(err, errWakeFailed):
		return proto.ErrWakeFailed
	case errors.Is(err, errSleepFailed):
		return proto.ErrSleepFailed
	case errors.Is(err, errUnknownWorker):
		return proto.ErrUnknownWorker
	case errors.Is(err, errDeskTaken):
		return proto.ErrDeskTaken
	case errors.Is(err, errCapacity):
		return proto.ErrCapacity
	case errors.Is(err, errNotClean):
		return proto.ErrNotClean
	case errors.Is(err, errHireFailed):
		return proto.ErrHireFailed
	case errors.Is(err, errFireFailed):
		return proto.ErrFireFailed
	}
	return proto.ErrInternal
}

type badArgsError struct{ err error }

func (e *badArgsError) Error() string { return "bad args: " + e.err.Error() }

var errUnknownCommand = errors.New("unknown command")

func decodeArgs(raw json.RawMessage, v any) error {
	if len(raw) == 0 || string(raw) == "null" {
		raw = json.RawMessage("{}")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return &badArgsError{err}
	}
	return nil
}

func (h *Hub) command(ctx context.Context, cmd proto.Command) (any, error) {
	var data any
	var err error
	switch cmd.T {
	case proto.CmdBuildingCreate:
		var a proto.BuildingCreateArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			var b store.Building
			if b, err = h.st.CreateBuilding(ctx, "b_"+randHex(6), a.Name); err == nil {
				data = map[string]string{"id": b.ID}
			}
		}
	case proto.CmdBuildingRename:
		var a proto.BuildingRenameArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.st.RenameBuilding(ctx, a.ID, a.Name)
		}
	case proto.CmdBuildingDelete:
		var a proto.BuildingDeleteArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.st.DeleteBuilding(ctx, a.ID)
		}
	case proto.CmdBuildingReorder:
		var a proto.BuildingReorderArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.st.ReorderBuildings(ctx, a.IDs)
		}
	case proto.CmdFloorAssign:
		var a proto.FloorAssignArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			var f *floorState
			if f, err = h.floorFor(a.Session); err != nil {
				break
			}
			if err = h.notBusy(a.Session, f); err != nil {
				break
			}
			building, index := "", -1
			if a.Building != nil {
				building = *a.Building
			}
			if a.Index != nil {
				index = *a.Index
			}
			err = h.st.AssignFloor(ctx, a.Session, building, index)
		}
	case proto.CmdFloorSettings:
		var a proto.FloorSettingsArgs
		if err = decodeArgs(cmd.Args, &a); err == nil {
			err = h.setSettings(ctx, a)
		}
	default:
		err = fmt.Errorf("%w: %q", errUnknownCommand, cmd.T)
	}
	if err != nil {
		return nil, err
	}
	if err := h.reload(ctx); err != nil {
		return nil, err
	}
	h.syncLayout()
	return data, nil
}

// reload reads buildings and floor assignments back from the store.
func (h *Hub) reload(ctx context.Context) error {
	bs, err := h.st.Buildings(ctx)
	if err != nil {
		return err
	}
	as, err := h.st.Assignments(ctx)
	if err != nil {
		return err
	}
	h.buildings = map[string]store.Building{}
	for _, b := range bs {
		h.buildings[b.ID] = b
	}
	h.assign = map[string]store.Assignment{}
	for _, a := range as {
		h.assign[a.Session] = a
	}
	return nil
}

func (h *Hub) applyFloor(ctx context.Context, u world.FloorObs) {
	f := h.floors[u.Session]
	if f != nil && u.Gen < f.gen {
		h.log.Debug("stale floor observation dropped", "session", u.Session, "gen", u.Gen, "current", f.gen)
		return
	}
	isNew := f == nil
	if isNew {
		f = &floorState{byWS: map[string]string{}}
		h.floors[u.Session] = f
	}
	fresh := u.Fresh || isNew
	// A worker that vanishes from a floor we watched run without a gap had
	// its workspace closed.
	closing := !isNew && f.running && u.Running && !fresh
	if f.running != u.Running && !isNew {
		h.log.Info("floor state changed", "session", u.Session, "running", u.Running)
	}
	if f.running && !u.Running {
		// Resume states end with the next sleep.
		for _, id := range f.order {
			delete(h.resume, id)
		}
	}
	if op := f.op; op != nil {
		switch {
		case op.kind == proto.TransitionSleeping && !u.Running:
			op.asleep = true // the asleep floor goes out without its transition
			op.signal()
		case op.kind == proto.TransitionWaking && u.Running:
			op.running = true
			op.signal()
		}
	}
	f.gen, f.running, f.def, f.err = u.Gen, u.Running, u.Default, u.Err
	if u.Socket != "" {
		f.socket = u.Socket
	}
	var evs []proto.Event
	if !u.KeepWorkers {
		f.last = u.Workers
		evs = h.syncWorkers(ctx, u.Session, f, u.Workers, fresh, closing)
		h.refreshSuggested(u.Session, f)
		h.askOrigins(u.Session, f)
	}
	// The floor (state, desks) goes first, then its workers.
	h.syncLayout()
	for _, ev := range evs {
		h.emit(ev)
	}
}

func (h *Hub) removeFloor(u world.FloorGone) {
	f := h.floors[u.Session]
	if f == nil || u.Gen < f.gen {
		return
	}
	for _, id := range f.order {
		w := h.workers[id]
		delete(h.workers, id)
		delete(h.saved, id)
		if w != nil {
			h.emit(proto.Event{T: proto.EvWorkerRemoved, ID: id, Session: w.Session, WorkspaceID: w.WorkspaceID})
		}
	}
	delete(h.floors, u.Session)
	delete(h.desks, u.Session)
	if err := h.st.FreeFloorDesks(context.Background(), u.Session); err != nil {
		h.log.Error("freeing desks failed", "session", u.Session, "err", err)
	}
	// Names stay held for the hold, should the session come back.
	h.releaseNames(context.Background(), u.Session, nil, h.opts.Now())
	h.log.Info("floor removed", "session", u.Session)
	h.syncLayout()
}

// resync re-applies a running floor's last observation, e.g. once a hire
// knows its workspace.
func (h *Hub) resync(ctx context.Context, session string) {
	f := h.floors[session]
	if f == nil || !f.running {
		return
	}
	evs := h.syncWorkers(ctx, session, f, f.last, false, false)
	h.syncLayout()
	for _, ev := range evs {
		h.emit(ev)
	}
}

// syncWorkers assigns identities, desks and names to the observed workers
// of a floor and returns the worker events of the diff (the caller emits
// them after the floor's own events).
func (h *Hub) syncWorkers(ctx context.Context, session string, f *floorState, obs []world.WorkerObs, fresh, closing bool) []proto.Event {
	assigned := map[string]string{} // workspace id → worker id
	if !fresh {
		for _, w := range obs {
			if id, ok := f.byWS[w.WorkspaceID]; ok {
				assigned[w.WorkspaceID] = id
			}
		}
	}
	// A hired workspace is its hire's worker, whatever else matched it.
	creating := false
	for _, op := range f.hires {
		if op.workspaceID == "" {
			creating = true
			continue
		}
		for ws, id := range assigned {
			if id == op.id && ws != op.workspaceID {
				delete(assigned, ws)
			}
		}
		for _, w := range obs {
			if w.WorkspaceID == op.workspaceID {
				assigned[w.WorkspaceID] = op.id
			}
		}
	}
	var unresolved []world.WorkerObs
	for _, w := range obs {
		if _, ok := assigned[w.WorkspaceID]; !ok {
			unresolved = append(unresolved, w)
		}
	}
	records := map[string]store.Worker{} // stored state of reconciled workers
	if len(unresolved) > 0 {
		taken := map[string]bool{}
		for _, id := range assigned {
			taken[id] = true
		}
		recs, err := h.st.SessionWorkers(ctx, session)
		if err != nil {
			h.log.Error("loading worker identities failed", "session", session, "err", err)
		}
		for _, r := range recs {
			records[r.ID] = r
		}
		for _, op := range f.hires {
			taken[op.id] = true // a hire's identity is only its own workspace
		}
		matches := world.Reconcile(unresolved, candidates(recs), taken)
		for _, w := range unresolved {
			if m, ok := matches[w.WorkspaceID]; ok {
				assigned[w.WorkspaceID] = m.ID
				h.log.Debug("worker reconciled", "session", session, "workspace", w.WorkspaceID, "worker", m.ID, "by", m.How)
				continue
			}
			if creating {
				// Possibly the workspace a hire is creating: wait until the
				// hire knows its id (it re-applies this observation).
				h.log.Debug("new workspace deferred while a hire creates one", "session", session, "workspace", w.WorkspaceID)
				continue
			}
			id := uuid.NewString()
			assigned[w.WorkspaceID] = id
			h.log.Debug("new worker", "session", session, "workspace", w.WorkspaceID, "worker", id)
		}
	}

	if creating {
		kept := make([]world.WorkerObs, 0, len(obs))
		for _, w := range obs {
			if _, ok := assigned[w.WorkspaceID]; ok {
				kept = append(kept, w)
			}
		}
		obs = kept
	}
	present := map[string]bool{}
	for _, id := range assigned {
		present[id] = true
	}
	obsWS := map[string]bool{}
	for _, w := range obs {
		obsWS[w.WorkspaceID] = true
	}
	at := h.opts.Now()
	var evs []proto.Event
	for _, id := range f.order {
		if present[id] {
			continue
		}
		w := h.workers[id]
		delete(h.workers, id)
		delete(h.saved, id)
		if w == nil {
			continue
		}
		if closing && !obsWS[w.WorkspaceID] {
			if err := h.st.CloseWorker(ctx, id); err != nil {
				h.log.Error("recording closed worker failed", "worker", id, "err", err)
			}
		}
		ev := proto.Event{T: proto.EvWorkerRemoved, ID: id, Session: session, WorkspaceID: w.WorkspaceID}
		if op := f.fires[id]; op != nil && !obsWS[op.workspaceID] {
			ev.Reason = proto.RemovedSentHome
			op.removed = true
			op.signal()
		}
		evs = append(evs, ev)
	}
	// Before anyone is named: whoever left (seen now, or while the bridge
	// was down) holds its name from now on.
	h.releaseNames(ctx, session, present, at)
	// Desks are held by the floor's current workers only: this frees the
	// desks of removed workers and of stored ones that did not come back.
	desks := h.floorDesks(session)
	for id := range desks {
		if !present[id] {
			delete(desks, id)
			if err := h.st.FreeDesk(ctx, id); err != nil {
				h.log.Error("freeing desk failed", "worker", id, "err", err)
			}
		}
	}

	now := at.UnixMilli()
	ids := make([]string, len(obs))
	metas := make([]workerMeta, len(obs))
	for i, w := range obs {
		id := assigned[w.WorkspaceID]
		ids[i] = id
		var base workerMeta
		if prev := h.workers[id]; prev != nil {
			base = metaOf(prev)
		} else if op := f.hires[id]; op != nil {
			base = workerMeta{harness: op.harness, model: op.model, effort: op.effort, hiredAt: op.hiredAt}
		} else if r, ok := records[id]; ok {
			base = workerMeta{harness: r.Harness, model: r.Model, effort: r.Effort, status: r.Status, statusSince: r.StatusSince,
				hiredAt: r.HiredAt}
		}
		metas[i] = nextMeta(base, w, now)
	}
	names, claimed := h.nameWorkers(session, ids, at)
	for i, id := range ids {
		if op := f.hires[id]; op != nil && !op.seen {
			claimed[i] = true // its name was only reserved in memory
		}
	}

	used := map[int]bool{}
	for _, d := range desks {
		used[d] = true
	}
	for _, op := range f.hires {
		used[op.desk] = true // reserved
	}
	order := make([]string, 0, len(obs))
	for i, w := range obs {
		id := ids[i]
		order = append(order, id)
		h.persist(ctx, id, session, w, metas[i])
		if claimed[i] {
			if err := h.st.ClaimName(ctx, session, names[i], id); err != nil {
				h.log.Error("saving worker name failed", "worker", id, "name", names[i], "err", err)
			}
		}
		desk, seated := desks[id]
		if op := f.hires[id]; !seated && op != nil {
			desk, seated = op.desk, true
			desks[id] = desk
			if err := h.st.AssignDesk(ctx, session, desk, id); err != nil {
				h.log.Error("saving desk failed", "worker", id, "desk", desk, "err", err)
			}
		}
		if !seated {
			for used[desk] {
				desk++
			}
			used[desk] = true
			desks[id] = desk
			if err := h.st.AssignDesk(ctx, session, desk, id); err != nil {
				h.log.Error("saving desk failed", "worker", id, "desk", desk, "err", err)
			}
		}
		next := workerView(id, session, w, metas[i], names[i], desk, h.resume[id])
		if w.Worktree != nil && w.Worktree.Linked && w.Worktree.CheckoutPath != "" {
			next.Branch = h.branchOf(w.Worktree.CheckoutPath, at)
		}
		if op := f.hires[id]; op != nil && !op.seen {
			op.seen = true
			op.signal()
		}
		prev := h.workers[id]
		h.workers[id] = next
		switch {
		case prev == nil:
			evs = append(evs, proto.Event{T: proto.EvWorkerUpsert, Worker: next})
		case reflect.DeepEqual(prev, next):
		case sameExceptStatus(prev, next):
			title := next.Title
			evs = append(evs, proto.Event{T: proto.EvWorkerStatus, ID: id, Session: session, WorkspaceID: next.WorkspaceID,
				Status: next.Status, PrevStatus: prev.Status, StatusSince: next.StatusSince, Title: &title})
		default:
			evs = append(evs, proto.Event{T: proto.EvWorkerUpsert, Worker: next})
		}
	}
	f.byWS = assigned
	f.order = order
	return evs
}

// floorDesks returns a floor's desk map, creating it.
func (h *Hub) floorDesks(session string) map[string]int {
	m := h.desks[session]
	if m == nil {
		m = map[string]int{}
		h.desks[session] = m
	}
	return m
}

// floorNames returns a floor's name claims, creating them.
func (h *Hub) floorNames(session string) map[string]nameClaim {
	m := h.names[session]
	if m == nil {
		m = map[string]nameClaim{}
		h.names[session] = m
	}
	return m
}

func metaOf(w *proto.Worker) workerMeta {
	return workerMeta{harness: w.Harness, model: w.Model, effort: w.Effort, status: w.Status, statusSince: w.StatusSince,
		hiredAt: w.HiredAt}
}

// branchTTL is how long a linked worktree's branch, read from its files,
// is reused.
const branchTTL = 15 * time.Second

// branchOf returns the branch checked out at a linked worktree, read at
// most every branchTTL.
func (h *Hub) branchOf(checkout string, at time.Time) string {
	if r, ok := h.branches[checkout]; ok && at.Sub(r.at) < branchTTL && !at.Before(r.at) {
		return r.branch
	}
	b := h.opts.BranchOf(checkout)
	h.branches[checkout] = branchRead{branch: b, at: at}
	return b
}

// nextMeta folds an observation into what the bridge knows about a worker:
// harness, model and effort are remembered once seen (herdr drops tokens on
// a restart), and status_since only moves when the status changes.
func nextMeta(m workerMeta, w world.WorkerObs, now int64) workerMeta {
	if w.Harness != "" {
		m.harness = w.Harness
	}
	if w.Model != "" {
		m.model = w.Model
	}
	if w.Effort != "" {
		m.effort = w.Effort
	}
	if m.status != w.Status || m.statusSince == 0 {
		m.status, m.statusSince = w.Status, now
	}
	return m
}

// releaseNames records that the owners of a floor's names who are not
// among present left it at at: each name stays held for the name hold from
// then. A worker that left while the bridge was down is recorded at the
// first observation after, so its hold starts late, never early.
func (h *Hub) releaseNames(ctx context.Context, session string, present map[string]bool, at time.Time) {
	claims := h.names[session]
	for name, c := range claims {
		if !c.released.IsZero() || present[c.owner] {
			continue
		}
		c.released = at
		claims[name] = c
		if err := h.st.ReleaseName(ctx, c.owner, at); err != nil {
			h.log.Error("releasing worker name failed", "worker", c.owner, "name", name, "err", err)
		}
	}
}

// nameWorkers returns the names of a floor's workers (all present, after
// releaseNames) and which of their claims changed and must be stored. A
// worker keeps the name it owns on the floor. One that owns none (new, or
// back after its hold ran out and a newcomer took its name) gets a name
// that no worker on the floor owns and no worker that left less than the
// hold ago still holds. Taking a name whose hold ran out takes it from its
// owner, who gets a new name if it ever comes back. So names are unique on
// a floor, and a worker that returns within its hold always has its name.
func (h *Hub) nameWorkers(session string, ids []string, at time.Time) (names []string, claimed []bool) {
	claims := h.floorNames(session)
	owned := make(map[string]string, len(claims)) // worker id → name
	for name, c := range claims {
		owned[c.owner] = name
	}
	names, claimed = make([]string, len(ids)), make([]bool, len(ids))
	for i, id := range ids {
		name, ok := owned[id]
		if !ok {
			continue
		}
		names[i] = name
		if !claims[name].released.IsZero() { // back on the floor
			claims[name] = nameClaim{owner: id}
			claimed[i] = true
		}
	}
	held := map[string]bool{}
	for name, c := range claims {
		if c.released.IsZero() || at.Sub(c.released) < h.opts.NameHold {
			held[name] = true
		}
	}
	for i, id := range ids {
		if names[i] != "" {
			continue
		}
		names[i] = world.PickName(id, held)
		held[names[i]] = true
		claims[names[i]] = nameClaim{owner: id}
		claimed[i] = true
	}
	return names, claimed
}

// sameExceptStatus reports whether only the status (and its age) and the
// title differ: that is a worker.status event, anything else an upsert.
func sameExceptStatus(a, b *proto.Worker) bool {
	x, y := *a, *b
	x.Status, y.Status = "", ""
	x.StatusSince, y.StatusSince = 0, 0
	x.Title, y.Title = "", ""
	return reflect.DeepEqual(x, y)
}

// persist writes a worker's identity, fingerprints and meta when they
// changed; a status change alone is a cheaper update.
func (h *Hub) persist(ctx context.Context, id, session string, w world.WorkerObs, m workerMeta) {
	fps := fingerprints(w)
	prev, ok := h.saved[id]
	if ok && prev.workspaceID == w.WorkspaceID && prev.label == w.Label && sameIdentityMeta(prev.meta, m) {
		changed := false
		for _, fp := range fps {
			if !prev.fps[fp] {
				changed = true
				break
			}
		}
		if !changed {
			if prev.meta != m {
				if err := h.st.SetWorkerStatus(ctx, id, m.status, m.statusSince); err != nil {
					h.log.Error("saving worker status failed", "worker", id, "err", err)
					return
				}
				prev.meta = m
				h.saved[id] = prev
			}
			return
		}
	}
	rec := store.Worker{ID: id, Session: session, WorkspaceID: w.WorkspaceID, Label: w.Label, Fingerprints: fps,
		Status: m.status, StatusSince: m.statusSince, Harness: m.harness, Model: m.model, Effort: m.effort, HiredAt: m.hiredAt}
	if err := h.st.SaveWorker(ctx, rec); err != nil {
		h.log.Error("saving worker failed", "worker", id, "err", err)
		return
	}
	set := map[store.Fingerprint]bool{}
	for _, fp := range fps {
		set[fp] = true
	}
	h.saved[id] = savedWorker{workspaceID: w.WorkspaceID, label: w.Label, fps: set, meta: m}
}

func sameIdentityMeta(a, b workerMeta) bool {
	a.status, a.statusSince, b.status, b.statusSince = "", 0, "", 0
	return a == b
}

func fingerprints(w world.WorkerObs) []store.Fingerprint {
	var fps []store.Fingerprint
	for _, m := range w.Markers {
		fps = append(fps, store.Fingerprint{Kind: store.FPMarker, Value: m})
	}
	if w.AgentSession != "" {
		fps = append(fps, store.Fingerprint{Kind: store.FPAgentSession, Value: w.AgentSession})
	}
	if w.Label != "" {
		fps = append(fps, store.Fingerprint{Kind: store.FPLabelCwd, Value: world.LabelCwdKey(w.Label, w.IdentityCwd)})
	}
	return fps
}

func candidates(recs []store.Worker) []world.Candidate {
	out := make([]world.Candidate, 0, len(recs))
	for _, r := range recs {
		c := world.Candidate{ID: r.ID, WorkspaceID: r.WorkspaceID, Closed: r.Closed}
		for _, fp := range r.Fingerprints {
			switch fp.Kind {
			case store.FPMarker:
				c.Markers = append(c.Markers, fp.Value)
			case store.FPAgentSession:
				c.AgentSessions = append(c.AgentSessions, fp.Value)
			case store.FPLabelCwd:
				c.LabelCwds = append(c.LabelCwds, fp.Value)
			}
		}
		out = append(out, c)
	}
	return out
}

func workerView(id, session string, w world.WorkerObs, m workerMeta, name string, desk int, resume string) *proto.Worker {
	return &proto.Worker{
		ID: id, Session: session, WorkspaceID: w.WorkspaceID, Label: w.Label, Cwd: w.Cwd,
		PaneID: w.PaneID, PaneLabel: w.PaneLabel, AgentKind: w.AgentKind, AgentName: w.AgentName,
		AgentSession: w.AgentSession, Status: w.Status, Title: w.Title, Tokens: w.Tokens,
		Worktree: w.Worktree, Role: w.Role, Run: w.Run,
		Name: name, DeskIndex: desk, Harness: m.harness, Model: m.model, Effort: m.effort, StatusSince: m.statusSince,
		Resume: resume, HiredAt: m.hiredAt,
	}
}

// buildingViews returns buildings in sort order with their known floors.
func (h *Hub) buildingViews() []proto.Building {
	bs := make([]proto.Building, 0, len(h.buildings))
	for _, b := range h.buildings {
		bs = append(bs, proto.Building{ID: b.ID, Name: b.Name, Sort: b.Sort, Floors: []string{}})
	}
	sort.Slice(bs, func(i, j int) bool {
		if bs[i].Sort != bs[j].Sort {
			return bs[i].Sort < bs[j].Sort
		}
		return bs[i].ID < bs[j].ID
	})
	byID := map[string]int{}
	for i, b := range bs {
		byID[b.ID] = i
	}
	as := make([]store.Assignment, 0, len(h.assign))
	for _, a := range h.assign {
		if _, known := h.floors[a.Session]; known {
			as = append(as, a)
		}
	}
	sort.Slice(as, func(i, j int) bool { return as[i].Index < as[j].Index })
	for _, a := range as {
		if i, ok := byID[a.BuildingID]; ok {
			bs[i].Floors = append(bs[i].Floors, a.Session)
		}
	}
	return bs
}

func (h *Hub) floorView(session string, f *floorState) proto.Floor {
	v := proto.Floor{Session: session, State: world.Asleep, Default: f.def, Error: f.err, Desks: h.deskCount(session, f),
		Settings: settingsView(h.settings[session])}
	if f.running {
		v.State = world.Running
	}
	if f.op != nil && !f.op.asleep {
		v.Transition = f.op.kind
	}
	if f.suggested != nil {
		s := *f.suggested
		v.Suggested = &s
	}
	if a, ok := h.assign[session]; ok {
		if _, ok := h.buildings[a.BuildingID]; ok {
			b, i := a.BuildingID, a.Index
			v.Building, v.Index = &b, &i
		}
	}
	return v
}

// deskCount is how many desks a floor renders: every occupied desk, and
// otherwise its workers plus spares (at least minDesks), capped at MaxDesks.
func (h *Hub) deskCount(session string, f *floorState) int {
	highest := -1
	for _, id := range f.order {
		if d, ok := h.desks[session][id]; ok && d > highest {
			highest = d
		}
	}
	return max(highest+1, min(h.opts.MaxDesks, max(minDesks, len(f.order)+spareDesks)))
}

// syncLayout emits building and floor events for whatever changed since the
// last call: floor upserts, floor removals, building upserts, building
// removals, in that order.
func (h *Hub) syncLayout() {
	names := make([]string, 0, len(h.floors))
	for s := range h.floors {
		names = append(names, s)
	}
	sort.Strings(names)
	for _, s := range names {
		v := h.floorView(s, h.floors[s])
		if old, ok := h.viewFloors[s]; !ok || !reflect.DeepEqual(old, v) {
			h.viewFloors[s] = v
			h.emit(proto.Event{T: proto.EvFloorUpsert, Floor: &v})
		}
	}
	gone := []string{}
	for s := range h.viewFloors {
		if _, ok := h.floors[s]; !ok {
			gone = append(gone, s)
		}
	}
	sort.Strings(gone)
	for _, s := range gone {
		delete(h.viewFloors, s)
		h.emit(proto.Event{T: proto.EvFloorRemoved, Session: s})
	}
	views := h.buildingViews()
	for i := range views {
		v := views[i]
		if old, ok := h.viewBuildings[v.ID]; !ok || !reflect.DeepEqual(old, v) {
			h.viewBuildings[v.ID] = v
			h.emit(proto.Event{T: proto.EvBuildingUpsert, Building: &v})
		}
	}
	removed := []string{}
	for id := range h.viewBuildings {
		if _, ok := h.buildings[id]; !ok {
			removed = append(removed, id)
		}
	}
	sort.Strings(removed)
	for _, id := range removed {
		delete(h.viewBuildings, id)
		h.emit(proto.Event{T: proto.EvBuildingRemoved, ID: id})
	}
}

// snapshot renders the world: buildings in order with their floors in
// order, then the unassigned lot by name.
func (h *Hub) snapshot() proto.Snapshot {
	hire := h.hireOptions()
	w := proto.World{Buildings: h.buildingViews(), Unassigned: []string{}, Floors: []proto.Floor{}, Workers: []proto.Worker{},
		HireOptions: &hire}
	placed := map[string]bool{}
	var order []string
	for _, b := range w.Buildings {
		for _, s := range b.Floors {
			placed[s] = true
			order = append(order, s)
		}
	}
	for _, s := range sortedFloors(h.floors) {
		if !placed[s] {
			w.Unassigned = append(w.Unassigned, s)
			order = append(order, s)
		}
	}
	for _, s := range order {
		f := h.floors[s]
		w.Floors = append(w.Floors, h.floorView(s, f))
		for _, id := range f.order {
			if wk := h.workers[id]; wk != nil {
				w.Workers = append(w.Workers, *wk)
			}
		}
	}
	return proto.Snapshot{T: proto.TSnapshot, Seq: h.seq, World: w}
}

func sortedFloors(m map[string]*floorState) []string {
	out := make([]string, 0, len(m))
	for s := range m {
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// emit assigns the next seq, keeps the event for replay and sends it to
// every client.
func (h *Hub) emit(ev proto.Event) {
	h.seq++
	ev.Seq = h.seq
	msg := mustJSON(ev)
	h.ring.add(ev.Seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// deliver queues msg for c without blocking, dropping c if its queue is full.
func (h *Hub) deliver(c *Client, msg []byte) {
	if _, ok := h.clients[c]; !ok {
		return
	}
	select {
	case c.send <- msg:
	default:
		delete(h.clients, c)
		h.log.Warn("dropping slow client", "client", c.name, "queue", cap(c.send))
		c.kick(ErrSlowConsumer)
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
