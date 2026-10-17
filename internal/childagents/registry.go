package childagents

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Limits of the registry.
const (
	// MaxPerWorker is the most children one root session keeps: evidence of
	// a new one beyond it is dropped.
	MaxPerWorker = 500
	maxName      = 128  // bytes of Name and Type
	maxDesc      = 1000 // bytes of Description
)

// Why evidence was dropped (Apply's error; the hub logs it at debug).
var (
	ErrUnbound  = errors.New("childagents: no worker has this root session now (an older session, or one not seen yet)")
	ErrInvalid  = errors.New("childagents: invalid evidence")
	ErrConflict = errors.New("childagents: the dispatch already belongs to another native id")
	ErrFull     = errors.New("childagents: the worker has too many children")
)

// Registry is every worker's native children: the hub's, used on its
// goroutine only. It starts empty and keeps nothing across a restart.
type Registry struct {
	gen       uint64            // the bridge-wide generation counter
	roots     map[string]*root  // by worker id
	bySession map[string]string // root agent session → the worker it is bound to
}

// root is one worker's generation: its root session and its children.
type root struct {
	worker, session string
	gen             uint64
	rows            map[string]*row   // by row id
	order           []string          // row ids, first seen first
	native          map[string]string // provider + native id → row id
	dispatch        map[string]string // provider + dispatch id → row id
	births          int               // rows made so far
}

type row struct {
	c        proto.Child
	birth    int    // order of creation in its root
	dispatch string // the first dispatch id seen for it
	// want is the parent the evidence named that has no row yet (the
	// child's Parent is unresolved meanwhile).
	want *ParentRef
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{roots: map[string]*root{}, bySession: map[string]string{}}
}

// Worker records a worker's root agent session (every refresh of it) and
// returns the worker's generation. A worker seen first, and one whose
// session was replaced (a non-empty session changed, also to none), gets
// the next generation and no children: its older ones are dropped, and so
// is any later evidence of the old session. A first session after none
// (""→X) keeps the generation: no child can have attached meanwhile.
// bound reports that the worker was bound to a new non-empty session: the
// hub then asks the sources to Replay it. A session another worker is bound
// to is not bound twice (its evidence stays the first worker's) until that
// worker lets go of it: the next refresh binds it then.
func (r *Registry) Worker(id, session string) (gen uint64, bound bool) {
	rt := r.roots[id]
	switch {
	case rt == nil:
		rt = r.newRoot(id, session)
		r.roots[id] = rt
	case rt.session == session:
		if session == "" || r.bySession[session] == id {
			return rt.gen, false
		}
		// Refused while another worker held it: bound once that one let go.
	case rt.session != "":
		r.unbind(rt)
		rt = r.newRoot(id, session)
		r.roots[id] = rt
	default:
		rt.session = session
	}
	return rt.gen, r.bind(rt)
}

// Remove forgets a worker that left, with its children (its worker.removed
// tells clients). If it comes back it gets a new generation.
func (r *Registry) Remove(id string) {
	if rt := r.roots[id]; rt != nil {
		r.unbind(rt)
		delete(r.roots, id)
	}
}

// Generation is a worker's generation (0: not seen).
func (r *Registry) Generation(id string) uint64 {
	if rt := r.roots[id]; rt != nil {
		return rt.gen
	}
	return 0
}

// Children are a worker's children, in the order first seen (a parent
// may come after its child).
func (r *Registry) Children(id string) []proto.Child {
	rt := r.roots[id]
	if rt == nil {
		return nil
	}
	out := make([]proto.Child, 0, len(rt.order))
	for _, rid := range rt.order {
		out = append(out, rt.rows[rid].c)
	}
	return out
}

func (r *Registry) newRoot(id, session string) *root {
	r.gen++
	return &root{worker: id, session: session, gen: r.gen, rows: map[string]*row{}, native: map[string]string{}, dispatch: map[string]string{}}
}

func (r *Registry) bind(rt *root) bool {
	if rt.session == "" {
		return false
	}
	if other, ok := r.bySession[rt.session]; ok && other != rt.worker {
		return false
	}
	r.bySession[rt.session] = rt.worker
	return true
}

func (r *Registry) unbind(rt *root) {
	if r.bySession[rt.session] == rt.worker {
		delete(r.bySession, rt.session)
	}
}

// Apply applies one observation and returns the events it makes, without
// seq: child.removed first, then child.upsert of every row it changed (the
// observed child first, then the children it resolved or orphaned). The
// error says why evidence was dropped (no events then).
func (r *Registry) Apply(e Evidence) ([]proto.Event, error) {
	if !valid(e) {
		return nil, ErrInvalid
	}
	wid, ok := r.bySession[e.Session]
	if !ok {
		return nil, ErrUnbound
	}
	rt := r.roots[wid]
	ch := changes{rt: rt, before: map[string]proto.Child{}}
	var byNative, byDispatch *row
	if e.NativeID != "" {
		byNative = rt.rows[rt.native[key(e.Provider, e.NativeID)]]
	}
	if e.DispatchID != "" {
		byDispatch = rt.rows[rt.dispatch[key(e.Provider, e.DispatchID)]]
		if byDispatch != nil && e.NativeID != "" && byDispatch.c.NativeID != "" && byDispatch.c.NativeID != e.NativeID {
			return nil, ErrConflict
		}
	}
	cur := byNative
	switch {
	case byNative != nil && byDispatch != nil && byNative != byDispatch:
		// One child seen twice before the evidence linking its ids: the
		// row seen first stays, the other merges into it.
		keep, gone := byDispatch, byNative
		if byNative.birth < byDispatch.birth {
			keep, gone = byNative, byDispatch
		}
		ch.merge(keep, gone)
		cur = keep
	case cur == nil:
		cur = byDispatch
	}
	if e.Removed {
		if cur != nil {
			ch.remove(cur)
		}
		return ch.events(), nil
	}
	if cur == nil {
		if len(rt.rows) >= MaxPerWorker {
			return nil, ErrFull
		}
		cur = rt.add(e)
		ch.before[cur.c.ID] = proto.Child{} // new: always an upsert
		ch.touched = append(ch.touched, cur.c.ID)
	}
	ch.touch(cur)
	if e.NativeID != "" {
		cur.c.NativeID = e.NativeID
		rt.native[key(e.Provider, e.NativeID)] = cur.c.ID
	}
	if e.DispatchID != "" {
		rt.dispatch[key(e.Provider, e.DispatchID)] = cur.c.ID
		if cur.dispatch == "" {
			cur.dispatch = e.DispatchID
		}
	}
	merge(&cur.c, e)
	if e.Parent != nil {
		ch.setParent(cur, e.Parent)
	}
	ch.resolveWaiting(cur)
	return ch.events(), nil
}

func valid(e Evidence) bool {
	if e.Session == "" || e.Source == "" || (e.NativeID == "" && e.DispatchID == "") {
		return false
	}
	if e.Provider != proto.ChildClaude && e.Provider != proto.ChildCodex {
		return false
	}
	if p := e.Parent; p != nil {
		switch p.Kind {
		case proto.ParentRoot:
		case proto.ParentChild:
			if p.NativeID == "" && p.DispatchID == "" {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func key(provider, id string) string { return provider + "\x00" + id }

// rowID is a row's id: stable for the row's life, and the same for the
// same first observation in the same worker and generation (so a fresh
// registry fed the same evidence makes the same ids).
func rowID(worker string, gen uint64, provider, kind, id string) string {
	sum := sha256.Sum256([]byte(worker + "\x00" + strconv.FormatUint(gen, 10) + "\x00" + provider + "\x00" + kind + "\x00" + id))
	return "ch_" + hex.EncodeToString(sum[:8])
}

// add makes the row of a child first seen in e: provisional (no native id)
// when e names only its dispatch.
func (rt *root) add(e Evidence) *row {
	kind, id := "native", e.NativeID
	if id == "" {
		kind, id = "dispatch", e.DispatchID
	}
	rt.births++
	rw := &row{birth: rt.births, c: proto.Child{
		ID: rowID(rt.worker, rt.gen, e.Provider, kind, id), Provider: e.Provider, WorkerID: rt.worker, AgentSession: rt.session,
		Generation: rt.gen, Parent: proto.ParentUnresolved, State: proto.ChildUnknown, Source: e.Source,
		Transcript: proto.TranscriptUnavailable,
	}}
	rt.rows[rw.c.ID] = rw
	rt.order = append(rt.order, rw.c.ID)
	return rw
}

// merge applies e's fields to c: a set field replaces, an empty one keeps.
func merge(c *proto.Child, e Evidence) {
	if e.Name != "" {
		c.Name = clip(e.Name, maxName)
	}
	if e.Type != "" {
		c.Type = clip(e.Type, maxName)
	}
	if e.Description != "" {
		c.Description = clip(e.Description, maxDesc)
	}
	if e.State != "" {
		c.State = validState(e.State)
		c.Source = e.Source
		if c.State == proto.ChildRunning && e.EndedAt == 0 {
			c.EndedAt = 0 // running again (resumed): no end yet
		}
	}
	if e.StartedAt > 0 && (c.StartedAt == 0 || e.StartedAt < c.StartedAt) {
		c.StartedAt = e.StartedAt
	}
	if e.LastActivityAt > c.LastActivityAt {
		c.LastActivityAt = e.LastActivityAt
	}
	if e.EndedAt > 0 {
		c.EndedAt = e.EndedAt
	}
	if validTranscript(e.Transcript) {
		c.Transcript = e.Transcript
	}
}

// clip cuts s to at most n bytes on a rune boundary.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// changes collects what one Apply did to a root.
type changes struct {
	rt      *root
	before  map[string]proto.Child // rows touched, as they were (a new one: zero)
	touched []string               // in order
	removed []string
}

func (ch *changes) touch(rw *row) {
	if _, ok := ch.before[rw.c.ID]; ok {
		return
	}
	ch.before[rw.c.ID] = rw.c
	ch.touched = append(ch.touched, rw.c.ID)
}

func (ch *changes) events() []proto.Event {
	var evs []proto.Event
	for _, id := range ch.removed {
		evs = append(evs, proto.Event{T: proto.EvChildRemoved, ID: id, WorkerID: ch.rt.worker, Generation: ch.rt.gen})
	}
	for _, id := range ch.touched {
		rw := ch.rt.rows[id]
		if rw == nil || rw.c == ch.before[id] {
			continue
		}
		c := rw.c
		evs = append(evs, proto.Event{T: proto.EvChildUpsert, Child: &c})
	}
	return evs
}

// setParent applies a parent the evidence names. A child parent the root
// has no row of yet leaves the child unresolved until it shows up; one that
// would make a cycle (itself, or one of its own descendants) is ignored.
func (ch *changes) setParent(rw *row, p *ParentRef) {
	if p.Kind == proto.ParentRoot {
		rw.want = nil
		rw.c.Parent, rw.c.ParentID = proto.ParentRoot, ""
		return
	}
	par := ch.rt.find(rw.c.Provider, p)
	if par == nil {
		rw.want = p
		rw.c.Parent, rw.c.ParentID = proto.ParentUnresolved, ""
		return
	}
	if ch.rt.descends(par, rw) {
		return
	}
	rw.want = nil
	rw.c.Parent, rw.c.ParentID = proto.ParentChild, par.c.ID
}

// resolveWaiting gives the children that wait for rw as their parent their
// parent now.
func (ch *changes) resolveWaiting(rw *row) {
	for _, id := range ch.rt.order {
		w := ch.rt.rows[id]
		if w == rw || w.want == nil || ch.rt.find(w.c.Provider, w.want) != rw {
			continue
		}
		ch.touch(w)
		ch.setParent(w, w.want)
	}
}

// find is the row a parent ref names (nil: none yet).
func (rt *root) find(provider string, p *ParentRef) *row {
	if p.NativeID != "" {
		if rw := rt.rows[rt.native[key(provider, p.NativeID)]]; rw != nil {
			return rw
		}
	}
	if p.DispatchID != "" {
		return rt.rows[rt.dispatch[key(provider, p.DispatchID)]]
	}
	return nil
}

// descends reports whether par is rw or one of its descendants.
func (rt *root) descends(par, rw *row) bool {
	for n := 0; par != nil && n <= len(rt.rows); n++ {
		if par == rw {
			return true
		}
		if par.c.Parent != proto.ParentChild {
			return false
		}
		par = rt.rows[par.c.ParentID]
	}
	return false
}

// remove drops a row; its children become unresolved, waiting for it to
// come back.
func (ch *changes) remove(rw *row) {
	rt := ch.rt
	ref := &ParentRef{Kind: proto.ParentChild, NativeID: rw.c.NativeID, DispatchID: rw.dispatch}
	for k, id := range rt.dispatch {
		if id == rw.c.ID {
			delete(rt.dispatch, k)
		}
	}
	for k, id := range rt.native {
		if id == rw.c.ID {
			delete(rt.native, k)
		}
	}
	ch.drop(rw)
	for _, id := range rt.order {
		c := rt.rows[id]
		if c.c.Parent == proto.ParentChild && c.c.ParentID == rw.c.ID {
			ch.touch(c)
			c.c.Parent, c.c.ParentID, c.want = proto.ParentUnresolved, "", ref
		}
	}
}

// merge folds gone into keep: its ids name keep from now on and its
// children are keep's.
func (ch *changes) merge(keep, gone *row) {
	rt := ch.rt
	ch.touch(keep)
	for k, id := range rt.native {
		if id == gone.c.ID {
			rt.native[k] = keep.c.ID
		}
	}
	for k, id := range rt.dispatch {
		if id == gone.c.ID {
			rt.dispatch[k] = keep.c.ID
		}
	}
	if keep.c.NativeID == "" {
		keep.c.NativeID = gone.c.NativeID
	}
	if keep.dispatch == "" {
		keep.dispatch = gone.dispatch
	}
	if keep.c.Parent == proto.ParentUnresolved && gone.c.Parent != proto.ParentUnresolved && gone.c.ParentID != keep.c.ID {
		keep.c.Parent, keep.c.ParentID, keep.want = gone.c.Parent, gone.c.ParentID, nil
	}
	ch.drop(gone)
	for _, id := range rt.order {
		c := rt.rows[id]
		if c.c.Parent == proto.ParentChild && c.c.ParentID == gone.c.ID {
			ch.touch(c)
			c.c.ParentID = keep.c.ID
		}
	}
}

func (ch *changes) drop(rw *row) {
	rt := ch.rt
	delete(rt.rows, rw.c.ID)
	for i, id := range rt.order {
		if id == rw.c.ID {
			rt.order = append(rt.order[:i], rt.order[i+1:]...)
			break
		}
	}
	ch.removed = append(ch.removed, rw.c.ID)
}
