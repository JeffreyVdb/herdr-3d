package server

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #58 virtual floors (docs/protocol.md "Virtual floors"). A floor id is a
// real floor's session name or a virtual floor's "v-<12 hex>". h.floors
// holds a state for every floor of every discovered session: the real
// floor, and one per virtual floor defined on it, sharing the session's
// state. The store, never herdr, says which floor a worker belongs to.

// loadVirtualFloors reads the virtual floor definitions and the hidden
// floors.
func (h *Hub) loadVirtualFloors(ctx context.Context) error {
	vs, err := h.st.VirtualFloors(ctx)
	if err != nil {
		return err
	}
	for _, v := range vs {
		h.vfloors[v.ID] = v
	}
	if h.hidden, err = h.st.HiddenFloors(ctx); err != nil {
		return err
	}
	return nil
}

// placeVirtualFloors gives the session's virtual floors their states (it is
// in the world: they are too).
func (h *Hub) placeVirtualFloors(session string) {
	f := h.floors[session]
	if f == nil || f.virtual {
		return
	}
	for id, v := range h.vfloors {
		if v.BaseSession == session && h.floors[id] == nil {
			h.floors[id] = &floorState{sessionState: f.sessionState, id: id, virtual: true}
		}
	}
}

// sessionFloors lists the floors of a session: its real floor first, then
// its virtual floors by id.
func (h *Hub) sessionFloors(session string) []*floorState {
	f := h.floors[session]
	if f == nil || f.virtual {
		return nil
	}
	out := []*floorState{f}
	var vs []*floorState
	for _, g := range h.floors {
		if g.virtual && g.sessionState == f.sessionState {
			vs = append(vs, g)
		}
	}
	sort.Slice(vs, func(i, j int) bool { return vs[i].id < vs[j].id })
	return append(out, vs...)
}

// floorName is a floor's display name: a virtual floor's own, else its
// session's name.
func (h *Hub) floorName(f *floorState) string {
	if v, ok := h.vfloors[f.id]; ok {
		return v.Name
	}
	return f.session
}

// sessionOf is the herdr session of a floor id (itself for a floor that is
// not in the world and not defined).
func (h *Hub) sessionOf(floor string) string {
	if f := h.floors[floor]; f != nil {
		return f.session
	}
	if v, ok := h.vfloors[floor]; ok {
		return v.BaseSession
	}
	return floor
}

// workerFloor is the floor id a worker is on (its session's real floor
// when it names none).
func workerFloor(w *proto.Worker) string {
	if w.Floor != "" {
		return w.Floor
	}
	return w.Session
}

// floorArg is the floor a floor-scoped command names: its floor, else (the
// clients from before #58) its session's real floor.
func floorArg(floor, session string) string {
	if floor != "" {
		return floor
	}
	return session
}

// floorCreate applies floor.create and returns the new floor.
func (h *Hub) floorCreate(ctx context.Context, a proto.FloorCreateArgs) (proto.Floor, error) {
	name, err := store.CleanFloorName(a.Name)
	if err != nil {
		return proto.Floor{}, err
	}
	base := h.floors[a.BaseSession]
	switch {
	case a.BaseSession == "":
		return proto.Floor{}, bad("base_session is required")
	case base == nil || base.virtual:
		return proto.Floor{}, fmt.Errorf("%w: %q is not a discovered herdr session", errUnknownSession, a.BaseSession)
	case h.opts.Sessions != nil && !h.opts.Sessions.MatchString(a.BaseSession):
		return proto.Floor{}, fmt.Errorf("%w: %q is outside the sessions this bridge watches (--sessions %s)", errUnknownSession,
			a.BaseSession, h.opts.Sessions)
	}
	var v store.VirtualFloor
	for range 8 {
		id := "v-" + randHex(6)
		// The id shares the floor ids' namespace with herdr's sessions.
		if h.floors[id] != nil || h.creating[id] != nil {
			continue
		}
		if _, taken := h.vfloors[id]; taken {
			continue
		}
		if v, err = h.st.CreateVirtualFloor(ctx, id, name, a.BaseSession); errors.Is(err, store.ErrFloorExists) {
			continue
		}
		break
	}
	if err != nil {
		return proto.Floor{}, err
	}
	if v.ID == "" {
		return proto.Floor{}, errors.New("no free virtual floor id")
	}
	h.vfloors[v.ID] = v
	h.placeVirtualFloors(a.BaseSession)
	h.log.Info("virtual floor created", "floor", v.ID, "name", v.Name, "session", v.BaseSession)
	if err := h.afterChange(ctx); err != nil {
		return proto.Floor{}, err
	}
	return h.viewFloors[v.ID], nil
}

// virtualFloor is the virtual floor a floor.rename or floor.delete names.
func (h *Hub) virtualFloor(id string) (store.VirtualFloor, error) {
	if id == "" {
		return store.VirtualFloor{}, bad("floor is required")
	}
	v, ok := h.vfloors[id]
	if !ok {
		if f := h.floors[id]; f != nil {
			return store.VirtualFloor{}, bad("%q is a herdr session's own floor: only virtual floors can be renamed or deleted", id)
		}
		return store.VirtualFloor{}, fmt.Errorf("%w: floor %q", store.ErrNotFound, id)
	}
	return v, nil
}

func (h *Hub) floorRename(ctx context.Context, a proto.FloorRenameArgs) error {
	v, err := h.virtualFloor(a.Floor)
	if err != nil {
		return err
	}
	name, err := store.CleanFloorName(a.Name)
	if err != nil {
		return err
	}
	if err := h.st.RenameVirtualFloor(ctx, v.ID, name); err != nil {
		return err
	}
	v.Name = name
	h.vfloors[v.ID] = v
	return nil
}

// floorDelete deletes a virtual floor. Its definition and the rows keyed
// by it go. Without move_workers it must have no workers (a floor whose
// base session is away is checked against the workers stored on it); with
// it, its workers go to the base session's real floor, which seats and
// names them as newcomers.
func (h *Hub) floorDelete(ctx context.Context, a proto.FloorDeleteArgs) error {
	v, err := h.virtualFloor(a.Floor)
	if err != nil {
		return err
	}
	f := h.floors[v.ID]
	if f != nil {
		if err := h.notBusy(v.ID, f); err != nil {
			return err
		}
		hiring := 0
		for _, op := range f.hires {
			if op.floor == v.ID {
				hiring++
			}
		}
		switch n := len(f.order) + hiring; {
		case a.MoveWorkers && hiring > 0:
			return fmt.Errorf("%w: floor “%s” is hiring: delete it once the hire is done", errBusy, v.Name)
		case !a.MoveWorkers && n > 0:
			return h.floorHasWorkers(v, n)
		case !a.MoveWorkers && f.running:
			// Its session is observed and nobody is on it: workers still
			// stored on it are gone (never seen again); they fall back.
			stale, err := h.st.FloorWorkers(ctx, v.ID)
			if err != nil {
				return err
			}
			for _, id := range stale {
				if err := h.st.SetWorkerFloor(ctx, id, v.BaseSession); err != nil {
					return err
				}
			}
		}
	}
	if err := h.st.DeleteVirtualFloor(ctx, v.ID, a.MoveWorkers); err != nil {
		if errors.Is(err, store.ErrFloorHasWorkers) {
			ids, _ := h.st.FloorWorkers(ctx, v.ID)
			return h.floorHasWorkers(v, len(ids))
		}
		return err
	}
	delete(h.vfloors, v.ID)
	delete(h.floors, v.ID)
	delete(h.desks, v.ID)
	delete(h.names, v.ID)
	delete(h.settings, v.ID)
	delete(h.lastHire, v.ID)
	delete(h.lastPreset, v.ID)
	delete(h.hidden, v.ID)
	if bf := h.boards.floors[v.ID]; bf != nil {
		h.dropBoard(bf)
	}
	delete(h.boards.stored, v.ID)
	h.log.Info("virtual floor deleted", "floor", v.ID, "name", v.Name, "session", v.BaseSession, "moved", a.MoveWorkers)
	if f != nil && len(f.order) > 0 {
		// Its workers' floor is no longer defined: the session's last
		// observation puts them on the real floor (floor.removed first).
		h.regroup(ctx, v.BaseSession)
	}
	return nil
}

// regroup re-applies a session's last observation, asleep too (resync's
// is a running floor's), e.g. once a floor of it is gone.
func (h *Hub) regroup(ctx context.Context, session string) {
	f := h.floors[session]
	switch {
	case f == nil:
		return
	case f.running:
		h.resync(ctx, session)
		return
	}
	evs := h.syncWorkers(ctx, session, f, f.last, false, false)
	h.syncLayout()
	for _, ev := range evs {
		h.emit(ev)
	}
}

func (h *Hub) floorHasWorkers(v store.VirtualFloor, n int) error {
	who := "1 worker"
	if n != 1 {
		who = fmt.Sprintf("%d workers", n)
	}
	return fmt.Errorf("%w: floor “%s” has %s: send them home or move them to its base floor first", errInvalidState, v.Name, who)
}

// wakeForHire is decision 3: a worker.hire or run.start on a virtual floor
// whose base session is asleep wakes the session first (the floor.wake
// path, audited as its own floor.wake row, its transition on every floor of
// the session), then goes on with hire on the hub goroutine; a failed wake
// fails the command. It reports false when the floor needs no wake, and the
// command goes on as on any floor (an asleep real floor is refused).
func (h *Hub) wakeForHire(ctx context.Context, c *Client, cmd proto.Command, floor string, hire func(context.Context) error) (bool, error) {
	f, err := h.floorFor(floor)
	if err != nil || !f.virtual || f.running || f.op != nil || h.opts.Herdr == nil || !herdr.ValidSessionName(f.session) {
		return false, nil
	}
	args := mustJSON(map[string]string{"floor": floor, "for": cmd.T, "req_id": cmd.ReqID})
	auditID, err := h.st.AuditBegin(ctx, c.name, proto.CmdFloorWake, args)
	if err != nil {
		return true, err
	}
	name := h.floorName(f)
	op := &floorOp{session: f.session, client: c, cmd: cmd, auditID: auditID, notify: make(chan struct{}, 1)}
	op.then = func(ctx context.Context, err error) {
		if err != nil {
			err = fmt.Errorf("waking floor “%s” (session %s) before the hire: %w", name, f.session, err)
		} else {
			err = hire(ctx)
		}
		if err != nil {
			h.audit(ctx, c, cmd, err)
			h.reply(c, cmd, nil, err)
		}
	}
	f.op = op
	h.log.Info("waking a virtual floor's session for a hire", "client", c.name, "cmd", cmd.T, "req_id", cmd.ReqID,
		"session", f.session, "floor", floor)
	h.beginWake(ctx, op, f)
	return true, nil
}

// prepareFloor is the floor of hire.prepare and run.prepare: hireFloor's,
// but a virtual floor may be asleep (decision 3: its hire wakes it).
func (h *Hub) prepareFloor(floor string) (*floorState, error) {
	if f, err := h.floorFor(floor); err == nil && f.virtual && !f.running {
		return f, h.notBusy(floor, f)
	}
	return h.hireFloor(floor)
}

// floorHide applies floor.hide (decision 2): a floor in the world, or a
// virtual floor whose session is away.
func (h *Hub) floorHide(ctx context.Context, a proto.FloorHideArgs) error {
	if a.Floor == "" {
		return bad("floor is required")
	}
	if _, defined := h.vfloors[a.Floor]; !defined {
		if _, err := h.floorFor(a.Floor); err != nil {
			return err
		}
	}
	if h.hidden[a.Floor] == a.Hidden {
		return nil
	}
	if err := h.st.SetFloorHidden(ctx, a.Floor, a.Hidden); err != nil {
		return err
	}
	if a.Hidden {
		h.hidden[a.Floor] = true
	} else {
		delete(h.hidden, a.Floor)
	}
	h.log.Info("floor hidden", "floor", a.Floor, "hidden", a.Hidden)
	return nil
}

// workerFloorName is the display name of a worker's floor.
func (h *Hub) workerFloorName(w *proto.Worker) string {
	id := workerFloor(w)
	if v, ok := h.vfloors[id]; ok {
		return v.Name
	}
	return id
}
