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
	obs             int               // observations applied so far
}

type row struct {
	c        proto.Child
	birth    int    // order of creation in its root
	dispatch string // the first dispatch id seen for it
	// want is the parent the evidence named that has no row yet (the
	// child's Parent is unresolved meanwhile).
	want *ParentRef
	// seen is when evidence last set each of its last-wins fields.
	seen seen
}

// seen is when evidence last set each last-wins field of a row, in its
// root's observation order (0: never): a merge keeps the later of two rows'.
type seen struct{ name, typ, desc, state, ended, transcript, parent int }

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
	rt.obs++
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
	cur.merge(e, rt.obs)
	if e.Parent != nil && ch.setParent(cur, e.Parent) {
		cur.seen.parent = rt.obs
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

// merge applies e's fields, observed at, to the row: a set field replaces,
// an empty one keeps.
func (rw *row) merge(e Evidence, at int) {
	c := &rw.c
	if e.Name != "" {
		c.Name, rw.seen.name = clip(e.Name, maxName), at
	}
	if e.Type != "" {
		c.Type, rw.seen.typ = clip(e.Type, maxName), at
	}
	if e.Description != "" {
		c.Description, rw.seen.desc = clip(e.Description, maxDesc), at
	}
	if e.State != "" {
		c.State, c.Source, rw.seen.state = validState(e.State), e.Source, at
		if c.State == proto.ChildRunning && e.EndedAt == 0 {
			c.EndedAt, rw.seen.ended = 0, at // running again (resumed): no end yet
		}
	}
	if e.StartedAt > 0 && (c.StartedAt == 0 || e.StartedAt < c.StartedAt) {
		c.StartedAt = e.StartedAt
	}
	if e.LastActivityAt > c.LastActivityAt {
		c.LastActivityAt = e.LastActivityAt
	}
	if e.EndedAt > 0 {
		c.EndedAt, rw.seen.ended = e.EndedAt, at
	}
	if validTranscript(e.Transcript) {
		c.Transcript, rw.seen.transcript = e.Transcript, at
	}
}

// fold takes into rw what gone observed: as if one row had seen both rows'
// evidence in observation order. A last-wins field takes the value set
// later (State with its Source; EndedAt, also cleared by a resumed
// running), StartedAt the earliest, LastActivityAt the latest; a field only
// one row has is kept.
func (rw *row) fold(gone *row) {
	c, g := &rw.c, &gone.c
	if gone.seen.name > rw.seen.name {
		c.Name, rw.seen.name = g.Name, gone.seen.name
	}
	if gone.seen.typ > rw.seen.typ {
		c.Type, rw.seen.typ = g.Type, gone.seen.typ
	}
	if gone.seen.desc > rw.seen.desc {
		c.Description, rw.seen.desc = g.Description, gone.seen.desc
	}
	if gone.seen.state > rw.seen.state {
		c.State, c.Source, rw.seen.state = g.State, g.Source, gone.seen.state
	}
	if gone.seen.ended > rw.seen.ended {
		c.EndedAt, rw.seen.ended = g.EndedAt, gone.seen.ended
	}
	if gone.seen.transcript > rw.seen.transcript {
		c.Transcript, rw.seen.transcript = g.Transcript, gone.seen.transcript
	}
	if g.StartedAt > 0 && (c.StartedAt == 0 || g.StartedAt < c.StartedAt) {
		c.StartedAt = g.StartedAt
	}
	c.LastActivityAt = max(c.LastActivityAt, g.LastActivityAt)
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
// would make a cycle (itself, or one of its own descendants) is ignored
// (false).
func (ch *changes) setParent(rw *row, p *ParentRef) bool {
	if p.Kind == proto.ParentRoot {
		rw.want = nil
		rw.c.Parent, rw.c.ParentID = proto.ParentRoot, ""
		return true
	}
	par := ch.rt.find(rw.c.Provider, p)
	if par == nil {
		rw.want = p
		rw.c.Parent, rw.c.ParentID = proto.ParentUnresolved, ""
		return true
	}
	return ch.link(rw, par)
}

// link puts rw under par, unless that would make a cycle (par is rw or one
// of its descendants): false then, and nothing changes.
func (ch *changes) link(rw, par *row) bool {
	if ch.rt.descends(par, rw) {
		return false
	}
	rw.want = nil
	rw.c.Parent, rw.c.ParentID = proto.ParentChild, par.c.ID
	return true
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

// merge folds gone into keep: its ids name keep from now on, keep keeps
// every field either observed (fold) and gone's children are keep's.
//
// keep's parent is the parent of the two rows observed later (seen.parent)
// if it is still one once they are one row, else the other's, else
// unresolved: never keep itself (a parent that was the other row) nor one
// of their descendants (a cycle). gone's children then go under keep
// through link's cycle check; one that would make a cycle is unresolved,
// waiting for keep.
func (ch *changes) merge(keep, gone *row) {
	rt := ch.rt
	ch.touch(keep)
	keep.fold(gone)
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
	first, second := keep, gone
	if gone.seen.parent > keep.seen.parent {
		first, second = gone, keep
	}
	if !ch.adoptParent(keep, gone, first) && !ch.adoptParent(keep, gone, second) {
		keep.c.Parent, keep.c.ParentID, keep.want, keep.seen.parent = proto.ParentUnresolved, "", nil, 0
	}
	ch.drop(gone)
	ref := &ParentRef{Kind: proto.ParentChild, NativeID: keep.c.NativeID, DispatchID: keep.dispatch}
	for _, id := range rt.order {
		c := rt.rows[id]
		if c == keep || c.c.Parent != proto.ParentChild || c.c.ParentID != gone.c.ID {
			continue
		}
		ch.touch(c)
		if !ch.link(c, keep) {
			c.c.Parent, c.c.ParentID, c.want = proto.ParentUnresolved, "", ref
		}
	}
}

// adoptParent gives keep, merging gone into it, the parent from (one of
// the two) has, if it is still a parent once gone is keep: not keep or gone
// themselves nor one of their descendants. False: it is not, or from has
// no parent evidence.
func (ch *changes) adoptParent(keep, gone, from *row) bool {
	if from.seen.parent == 0 {
		return false
	}
	p, want, at := from.c, from.want, from.seen.parent
	var par *row
	switch {
	case p.Parent == proto.ParentChild:
		if par = ch.rt.rows[p.ParentID]; par == nil {
			return false
		}
	case p.Parent == proto.ParentUnresolved && want != nil:
		par = ch.rt.find(keep.c.Provider, want) // gone's ids find keep by now
	}
	if par != nil {
		if ch.rt.descends(par, keep) || ch.rt.descends(par, gone) {
			return false
		}
		p.Parent, p.ParentID, want = proto.ParentChild, par.c.ID, nil
	}
	keep.c.Parent, keep.c.ParentID, keep.want, keep.seen.parent = p.Parent, p.ParentID, want, at
	return true
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
