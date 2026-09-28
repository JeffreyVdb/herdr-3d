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
	"sort"
	"time"

	"github.com/google/uuid"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// ErrSlowConsumer is why a client whose send queue filled up was dropped.
var ErrSlowConsumer = errors.New("slow consumer")

// Options configure a Hub.
type Options struct {
	Ring     int    // events kept for since_seq replay (default 4096)
	Queue    int    // per-client send queue, in messages (default 1024)
	MaxDesks int    // cap on the desks a floor renders beyond its occupied ones (default DefaultMaxDesks)
	Server   string // version banner sent in welcome
	Log      *slog.Logger
	Now      func() time.Time // bridge clock for status_since (default time.Now)
}

// DefaultMaxDesks is the default Options.MaxDesks.
const DefaultMaxDesks = 96

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
	workers   map[string]*proto.Worker  // by worker id
	saved     map[string]savedWorker    // what the store last got, by worker id
	desks     map[string]map[string]int // floor → worker id → desk index (mirrors desk_assignment)

	viewBuildings map[string]proto.Building
	viewFloors    map[string]proto.Floor
}

type floorState struct {
	running bool
	def     bool
	err     string
	gen     uint64
	byWS    map[string]string // workspace id → worker id
	order   []string          // worker ids in herdr's sidebar order
}

type savedWorker struct {
	workspaceID, label string
	fps                map[store.Fingerprint]bool
	meta               workerMeta
}

// workerMeta is what the bridge keeps about a worker beyond what herdr
// currently shows: its name, the last known harness, model and effort, and
// since when (unix ms) it has had its status.
type workerMeta struct {
	name, harness, model, effort string
	status                       string
	statusSince                  int64
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
		viewBuildings: map[string]proto.Building{},
		viewFloors:    map[string]proto.Floor{},
	}
	if err := h.reload(ctx); err != nil {
		return nil, err
	}
	desks, err := st.Desks(ctx)
	if err != nil {
		return nil, err
	}
	for _, d := range desks {
		h.floorDesks(d.Floor)[d.WorkerID] = d.Index
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

// Run processes updates and client operations until ctx is done.
func (h *Hub) Run(ctx context.Context) error {
	defer close(h.done)
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
// the events it caused.
func (h *Hub) Command(ctx context.Context, c *Client, cmd proto.Command) error {
	return h.do(ctx, func(ctx context.Context) {
		if _, ok := h.clients[c]; !ok {
			return
		}
		data, err := h.command(ctx, cmd)
		if aerr := h.st.Audit(ctx, c.name, cmd.T, cmd.Args, err); aerr != nil {
			h.log.Error("audit log write failed", "err", aerr)
		}
		if err != nil {
			code := errorCode(err)
			h.log.Info("command rejected", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID, "code", code, "err", err)
			h.deliver(c, mustJSON(proto.Error{T: proto.TError, ReqID: cmd.ReqID, Code: code, Message: err.Error()}))
			return
		}
		h.log.Info("command applied", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID)
		h.deliver(c, mustJSON(proto.Ack{T: proto.TAck, ReqID: cmd.ReqID, Data: data}))
	})
}

var errUnknownSession = errors.New("unknown session")

func errorCode(err error) string {
	var bad *badArgsError
	switch {
	case errors.As(err, &bad), errors.Is(err, store.ErrInvalid):
		return proto.ErrBadRequest
	case errors.Is(err, store.ErrNotFound):
		return proto.ErrNotFound
	case errors.Is(err, store.ErrNameTaken):
		return proto.ErrNameTaken
	case errors.Is(err, errUnknownSession):
		return proto.ErrUnknownSession
	case errors.Is(err, errUnknownCommand):
		return proto.ErrUnknownCommand
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
			if _, known := h.floors[a.Session]; !known {
				err = fmt.Errorf("%w: %q", errUnknownSession, a.Session)
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
	f.gen, f.running, f.def, f.err = u.Gen, u.Running, u.Default, u.Err
	var evs []proto.Event
	if !u.KeepWorkers {
		evs = h.syncWorkers(ctx, u.Session, f, u.Workers, fresh, closing)
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
	h.log.Info("floor removed", "session", u.Session)
	h.syncLayout()
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
		matches := world.Reconcile(unresolved, candidates(recs), taken)
		for _, w := range unresolved {
			if m, ok := matches[w.WorkspaceID]; ok {
				assigned[w.WorkspaceID] = m.ID
				h.log.Debug("worker reconciled", "session", session, "workspace", w.WorkspaceID, "worker", m.ID, "by", m.How)
				continue
			}
			id := uuid.NewString()
			assigned[w.WorkspaceID] = id
			h.log.Debug("new worker", "session", session, "workspace", w.WorkspaceID, "worker", id)
		}
	}

	present := map[string]bool{}
	for _, id := range assigned {
		present[id] = true
	}
	obsWS := map[string]bool{}
	for _, w := range obs {
		obsWS[w.WorkspaceID] = true
	}
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
		evs = append(evs, proto.Event{T: proto.EvWorkerRemoved, ID: id, Session: session, WorkspaceID: w.WorkspaceID})
	}
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

	now := h.opts.Now().UnixMilli()
	ids := make([]string, len(obs))
	metas := make([]workerMeta, len(obs))
	for i, w := range obs {
		id := assigned[w.WorkspaceID]
		ids[i] = id
		var base workerMeta
		if prev := h.workers[id]; prev != nil {
			base = metaOf(prev)
		} else if r, ok := records[id]; ok {
			base = workerMeta{name: r.Name, harness: r.Harness, model: r.Model, effort: r.Effort, status: r.Status, statusSince: r.StatusSince}
		}
		metas[i] = nextMeta(base, w, now)
	}
	// Any stored worker of the floor may come back (its marker or agent
	// session reconciles it even after its workspace closed), so its name
	// stays out of reach of newcomers.
	reserved := map[string]bool{}
	for _, r := range records {
		if r.Name != "" {
			reserved[r.Name] = true
		}
	}
	nameWorkers(ids, metas, desks, reserved)

	used := map[int]bool{}
	for _, d := range desks {
		used[d] = true
	}
	order := make([]string, 0, len(obs))
	for i, w := range obs {
		id := ids[i]
		order = append(order, id)
		h.persist(ctx, id, session, w, metas[i])
		desk, seated := desks[id]
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
		next := workerView(id, session, w, metas[i], desk)
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

func metaOf(w *proto.Worker) workerMeta {
	return workerMeta{name: w.Name, harness: w.Harness, model: w.Model, effort: w.Effort, status: w.Status, statusSince: w.StatusSince}
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

// nameWorkers makes every worker's name unique on its floor. Workers keep
// the name they have; the rest get one that is neither on the floor nor
// reserved. Newcomers never get a stored name, so two workers of a floor
// only share one after a database error or in a database written before
// that rule: then seated workers keep it first.
func nameWorkers(ids []string, metas []workerMeta, desks map[string]int, reserved map[string]bool) {
	taken := map[string]bool{}
	for _, seatedPass := range []bool{true, false} {
		for i, id := range ids {
			if _, seated := desks[id]; seated != seatedPass {
				continue
			}
			if n := metas[i].name; n != "" && !taken[n] {
				taken[n] = true
			} else {
				metas[i].name = ""
			}
		}
	}
	for n := range reserved {
		taken[n] = true
	}
	for i, id := range ids {
		if metas[i].name == "" {
			metas[i].name = world.PickName(id, taken)
			taken[metas[i].name] = true
		}
	}
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
		Name: m.name, Status: m.status, StatusSince: m.statusSince, Harness: m.harness, Model: m.model, Effort: m.effort}
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

func workerView(id, session string, w world.WorkerObs, m workerMeta, desk int) *proto.Worker {
	return &proto.Worker{
		ID: id, Session: session, WorkspaceID: w.WorkspaceID, Label: w.Label, Cwd: w.Cwd,
		PaneID: w.PaneID, PaneLabel: w.PaneLabel, AgentKind: w.AgentKind, AgentName: w.AgentName,
		AgentSession: w.AgentSession, Status: w.Status, Title: w.Title, Tokens: w.Tokens,
		Worktree: w.Worktree, Role: w.Role, Run: w.Run,
		Name: m.name, DeskIndex: desk, Harness: m.harness, Model: m.model, Effort: m.effort, StatusSince: m.statusSince,
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
	v := proto.Floor{Session: session, State: world.Asleep, Default: f.def, Error: f.err, Desks: h.deskCount(session, f)}
	if f.running {
		v.State = world.Running
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
	w := proto.World{Buildings: h.buildingViews(), Unassigned: []string{}, Floors: []proto.Floor{}, Workers: []proto.Worker{}}
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
