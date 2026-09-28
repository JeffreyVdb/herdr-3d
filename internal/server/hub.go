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

	"github.com/google/uuid"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// ErrSlowConsumer is why a client whose send queue filled up was dropped.
var ErrSlowConsumer = errors.New("slow consumer")

// Options configure a Hub.
type Options struct {
	Ring   int    // events kept for since_seq replay (default 4096)
	Queue  int    // per-client send queue, in messages (default 1024)
	Server string // version banner sent in welcome
	Log    *slog.Logger
}

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
	workers   map[string]*proto.Worker // by worker id
	saved     map[string]savedWorker   // what the store last got, by worker id

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
		viewBuildings: map[string]proto.Building{},
		viewFloors:    map[string]proto.Floor{},
	}
	if err := h.reload(ctx); err != nil {
		return nil, err
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
	h.syncLayout()
	if !u.KeepWorkers {
		h.syncWorkers(ctx, u.Session, f, u.Workers, fresh, closing)
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
	h.log.Info("floor removed", "session", u.Session)
	h.syncLayout()
}

// syncWorkers assigns identities to observed workers and emits the diff.
func (h *Hub) syncWorkers(ctx context.Context, session string, f *floorState, obs []world.WorkerObs, fresh, closing bool) {
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
	if len(unresolved) > 0 {
		taken := map[string]bool{}
		for _, id := range assigned {
			taken[id] = true
		}
		recs, err := h.st.SessionWorkers(ctx, session)
		if err != nil {
			h.log.Error("loading worker identities failed", "session", session, "err", err)
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
		h.emit(proto.Event{T: proto.EvWorkerRemoved, ID: id, Session: session, WorkspaceID: w.WorkspaceID})
	}

	order := make([]string, 0, len(obs))
	for _, w := range obs {
		id := assigned[w.WorkspaceID]
		order = append(order, id)
		h.persist(ctx, id, session, w)
		next := workerView(id, session, w)
		prev := h.workers[id]
		h.workers[id] = next
		switch {
		case prev == nil:
			h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: next})
		case reflect.DeepEqual(prev, next):
		case prev.Status != next.Status && sameExceptStatus(prev, next):
			h.emit(proto.Event{T: proto.EvWorkerStatus, ID: id, Session: session, WorkspaceID: next.WorkspaceID,
				Status: next.Status, PrevStatus: prev.Status})
		default:
			h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: next})
		}
	}
	f.byWS = assigned
	f.order = order
}

func sameExceptStatus(a, b *proto.Worker) bool {
	x, y := *a, *b
	x.Status, y.Status = "", ""
	return reflect.DeepEqual(x, y)
}

// persist writes a worker's identity and fingerprints when they changed.
func (h *Hub) persist(ctx context.Context, id, session string, w world.WorkerObs) {
	fps := fingerprints(w)
	prev, ok := h.saved[id]
	if ok && prev.workspaceID == w.WorkspaceID && prev.label == w.Label {
		changed := false
		for _, fp := range fps {
			if !prev.fps[fp] {
				changed = true
				break
			}
		}
		if !changed {
			return
		}
	}
	rec := store.Worker{ID: id, Session: session, WorkspaceID: w.WorkspaceID, Label: w.Label, Fingerprints: fps}
	if err := h.st.SaveWorker(ctx, rec); err != nil {
		h.log.Error("saving worker failed", "worker", id, "err", err)
		return
	}
	set := map[store.Fingerprint]bool{}
	for _, fp := range fps {
		set[fp] = true
	}
	h.saved[id] = savedWorker{workspaceID: w.WorkspaceID, label: w.Label, fps: set}
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

func workerView(id, session string, w world.WorkerObs) *proto.Worker {
	return &proto.Worker{
		ID: id, Session: session, WorkspaceID: w.WorkspaceID, Label: w.Label, Cwd: w.Cwd,
		PaneID: w.PaneID, PaneLabel: w.PaneLabel, AgentKind: w.AgentKind, AgentName: w.AgentName,
		AgentSession: w.AgentSession, Status: w.Status, Title: w.Title, Tokens: w.Tokens,
		Worktree: w.Worktree, Role: w.Role, Run: w.Run,
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
	v := proto.Floor{Session: session, State: world.Asleep, Default: f.def, Error: f.err}
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
