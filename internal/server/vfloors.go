package server

import (
	"context"
	"errors"
	"fmt"
	"sort"

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

// floorDelete deletes a virtual floor that has no workers (C2b adds
// move_workers). Its definition and the rows keyed by it go; a floor whose
// base session is away is checked against the workers stored on it.
func (h *Hub) floorDelete(ctx context.Context, a proto.FloorDeleteArgs) error {
	v, err := h.virtualFloor(a.Floor)
	if err != nil {
		return err
	}
	if a.MoveWorkers {
		return &codedError{proto.ErrUnsupported, errors.New("moving a virtual floor's workers to its base floor is not supported yet")}
	}
	f := h.floors[v.ID]
	if f != nil {
		if err := h.notBusy(v.ID, f); err != nil {
			return err
		}
		n := len(f.order)
		for _, op := range f.hires {
			if op.floor == v.ID {
				n++
			}
		}
		if n > 0 {
			return h.floorHasWorkers(v, n)
		}
		if f.running {
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
	if err := h.st.DeleteVirtualFloor(ctx, v.ID); err != nil {
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
	h.log.Info("virtual floor deleted", "floor", v.ID, "name", v.Name, "session", v.BaseSession)
	return nil
}

func (h *Hub) floorHasWorkers(v store.VirtualFloor, n int) error {
	who := "1 worker"
	if n != 1 {
		who = fmt.Sprintf("%d workers", n)
	}
	return fmt.Errorf("%w: floor “%s” has %s: send them home or move them to its base floor first", errInvalidState, v.Name, who)
}
