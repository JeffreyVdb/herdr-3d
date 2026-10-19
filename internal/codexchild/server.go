package codexchild

// #27 (phase 6 of #20): a shared-server worker's children, live, from its
// own app-server, the one that owns its conversation. The hub's join of the
// worker's root thread (codexapp.Watcher) reports to the Source: Joined
// when it is subscribed (on every connection), each notification a child
// can show in, Lost when the connection or the server went. An observer per
// join reads the server observationally (codexapp.ChildReader: never a
// resume, a load, a turn or an override) and keeps the session's server
// facts beside its rollout facts, in the same book: one derivation, one
// queue, so the two never race and a row never flaps between them (see
// combine). docs/protocol.md "Codex subagents through the shared
// app-server (#27)".

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"slices"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Defaults and bounds of the server half.
const (
	// DefaultSettle is how long a child that went idle may wait for the
	// end of its turn (the parent's subAgentActivity, its own
	// turn/completed) before the observer reads its last turn.
	DefaultSettle = time.Second
	// DefaultReadTimeout bounds one read of the server.
	DefaultReadTimeout = 10 * time.Second
	maxNotes           = 1024 // notifications queued; past it the observer recovers again
	maxNotKids         = 1024 // thread ids read and found not to be children, remembered
)

// server is a session's server facts: what its app-server showed through
// the hub's joins this bridge run (never persisted: a restart joins again).
type server struct {
	// owned: a join of the session was seen this run, so the server is
	// the authority on its children's state from now on (combine).
	owned bool
	// attached: joined now; token names the join (Joined and Lost bump it,
	// so a late result of an older join is dropped).
	attached bool
	token    int
	obs      *observer
	kids     map[string]*kid // by thread id
	seq      int
	notKids  map[string]bool
}

// kid is what the server showed of one child thread.
type kid struct {
	thread, parent, dispatch string
	name, typ, path          string
	ephemeral                bool
	// live is the server's word on it now: running (active, a turn
	// started), idle (loaded, no turn running), notLoaded (not in memory:
	// unloaded, closed or a restarted server's), "" (none yet: a fresh
	// child's first idle is its pending init).
	live string
	ran  bool // seen running on this server; an idle before it says nothing
	// end is the end of its latest turn the server showed (completed,
	// interrupted, shut_down; "": none since it last ran), at endAt.
	end           string
	endAt         int64
	started, last int64
	seq           int
	settle        time.Time // an idle with no end yet: read its last turn then
	settleGen     int
}

// Live states of a kid.
const (
	liveRunning   = "running"
	liveIdle      = "idle"
	liveNotLoaded = "notLoaded"
)

func (b *book) server() *server {
	if b.srv == nil {
		b.srv = &server{kids: map[string]*kid{}, notKids: map[string]bool{}}
	}
	return b.srv
}

// Joined: the hub's join of session's root thread is subscribed on a new
// connection, read through r. The server is the authority on the
// session's children from now on; an observer recovers them (every join:
// a connection initialized after a child was spawned is not subscribed to
// it, and a reconnect's join returns no children).
func (s *Source) Joined(session string, r codexapp.ChildReader) {
	if session == "" || r == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.book(session)
	sv := b.server()
	if sv.obs != nil {
		sv.obs.stop()
	}
	sv.owned, sv.attached = true, true
	sv.token++
	ctx := s.base
	if ctx == nil {
		ctx = context.Background()
	}
	sv.obs = newObserver(ctx, s, session, sv.token, r)
	go sv.obs.run()
	s.flush(b)
}

// Lost: the join's connection ended, or its server is gone (a retry, a
// stop, a dead process, the join left): no live claim of it stands
// (combine) until the next Joined recovers them.
func (s *Source) Lost(session string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.books[session]
	if b == nil || b.srv == nil || !b.srv.attached {
		return
	}
	sv := b.srv
	sv.attached = false
	sv.token++
	sv.obs.stop()
	sv.obs = nil
	for _, k := range sv.kids {
		k.settle = time.Time{}
	}
	s.flush(b)
}

// Notify is a notification of session's join (the hub goroutine; never
// blocks): the methods a child shows in (codexapp.ChildMethods), the items
// only when they name children. The observer decides whose it is.
func (s *Source) Notify(session, method string, params json.RawMessage) {
	if !slices.Contains(codexapp.ChildMethods, method) {
		return
	}
	if (method == "item/started" || method == "item/completed") &&
		!bytes.Contains(params, []byte(`"`+codexapp.ItemSubAgentActivity+`"`)) && !bytes.Contains(params, []byte(`"`+codexapp.ItemCollabToolCall+`"`)) {
		return
	}
	s.mu.Lock()
	b := s.books[session]
	var o *observer
	if b != nil && b.srv != nil {
		o = b.srv.obs
	}
	s.mu.Unlock()
	if o != nil {
		o.push(note{method: method, params: append(json.RawMessage(nil), params...)})
	}
}

type note struct {
	method string
	params json.RawMessage
}

// observer reads one join's server for a session, on its own goroutine:
// recovery first, then the notifications in the order received.
type observer struct {
	src     *Source
	session string
	token   int
	r       codexapp.ChildReader
	ctx     context.Context
	cancel  context.CancelFunc
	kick    chan struct{}

	mu       sync.Mutex
	queue    []note
	resync   bool
	busy     bool
	recovers int // recoveries done (tests)
}

func newObserver(base context.Context, s *Source, session string, token int, r codexapp.ChildReader) *observer {
	ctx, cancel := context.WithCancel(base)
	return &observer{src: s, session: session, token: token, r: r, ctx: ctx, cancel: cancel, kick: make(chan struct{}, 1), resync: true}
}

func (o *observer) stop() { o.cancel() }

func (o *observer) push(n note) {
	o.mu.Lock()
	if len(o.queue) >= maxNotes {
		o.queue, o.resync = nil, true // recover again instead
	} else {
		o.queue = append(o.queue, n)
	}
	o.mu.Unlock()
	o.wake()
}

func (o *observer) wake() {
	select {
	case o.kick <- struct{}{}:
	default:
	}
}

func (o *observer) take() ([]note, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	q, rs := o.queue, o.resync
	o.queue, o.resync = nil, false
	o.busy = len(q) > 0 || rs
	return q, rs
}

func (o *observer) run() {
	t := time.NewTimer(time.Hour)
	defer t.Stop()
	for {
		notes, resync := o.take()
		if resync {
			o.recover()
		}
		for _, n := range notes {
			if o.ctx.Err() != nil {
				return
			}
			o.handle(n)
		}
		o.settle()
		o.mu.Lock()
		o.busy = false
		o.mu.Unlock()
		next := o.nextSettle()
		if !t.Stop() {
			select {
			case <-t.C:
			default:
			}
		}
		if !next.IsZero() {
			t.Reset(max(time.Until(next), 0))
		}
		select {
		case <-o.ctx.Done():
			return
		case <-o.kick:
		case <-t.C:
		}
	}
}

// apply runs fn on the session's server facts while this observer's join
// is still the session's, then sends what changed.
func (o *observer) apply(fn func(sv *server)) bool {
	s := o.src
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.books[o.session]
	if b == nil || b.srv == nil || b.srv.token != o.token || o.ctx.Err() != nil {
		return false
	}
	fn(b.srv)
	s.flush(b)
	return true
}

func (o *observer) call() (context.Context, context.CancelFunc) {
	return context.WithTimeout(o.ctx, o.src.opts.ReadTimeout)
}

// recover finds the session's descendants on the server (every join, and
// after an overflow): each one's metadata and live status, and the status
// of each child known before that is not among them.
func (o *observer) recover() {
	defer func() {
		o.mu.Lock()
		o.recovers++
		o.mu.Unlock()
	}()
	ctx, cancel := o.call()
	d, err := o.r.Descendants(ctx, o.session)
	cancel()
	if err != nil {
		o.src.opts.Log("recovering the codex children failed", "session", o.session, "err", err)
		return
	}
	found := map[string]bool{}
	o.apply(func(sv *server) {
		byID := map[string]codexapp.Thread{}
		for _, t := range d.Threads {
			byID[t.ID] = t
		}
		for _, t := range d.Threads {
			if !chained(byID, sv, t.ID, o.session) {
				continue
			}
			k := sv.add(t.ID, o.src.opts.Now())
			if k == nil {
				continue
			}
			found[t.ID] = true
			k.meta(&t, o.session)
			k.status(t.Status.Type, true)
		}
	})
	var missing []string
	o.src.mu.Lock()
	if b := o.src.books[o.session]; b != nil && b.srv != nil {
		for id := range b.srv.kids {
			if !found[id] {
				missing = append(missing, id)
			}
		}
	}
	o.src.mu.Unlock()
	slices.Sort(missing)
	// Not listed: an ephemeral child (no store row), one the fallback
	// could not see, one gone. A loaded one is read; any other is not in
	// memory.
	for _, id := range missing {
		th, err := o.read(id)
		o.apply(func(sv *server) {
			if k := sv.kids[id]; k != nil {
				if err != nil {
					k.status(codexapp.ThreadNotLoaded, true)
					return
				}
				k.meta(th, o.session)
				k.status(th.Status.Type, true)
			}
		})
	}
}

// chained reports whether id's parent chain, through the listed threads
// and the children already known, reaches root, and id is a spawned child.
func chained(byID map[string]codexapp.Thread, sv *server, id, root string) bool {
	for range 16 {
		t, ok := byID[id]
		if !ok {
			return sv.kids[id] != nil
		}
		if _, spawned := t.Spawn(); !spawned && t.ParentThreadID == "" {
			return false
		}
		p := t.ParentID()
		switch p {
		case root:
			return true
		case "":
			return false
		}
		id = p
	}
	return false
}

func (o *observer) read(id string) (*codexapp.Thread, error) {
	ctx, cancel := o.call()
	defer cancel()
	return o.r.ReadThread(ctx, id)
}

// handle applies one notification.
func (o *observer) handle(n note) {
	cn, ok := codexapp.DecodeChildNote(n.params)
	if !ok {
		return
	}
	now := o.src.opts.Now()
	switch n.method {
	case "item/started", "item/completed":
		o.item(cn, now)
	case "turn/started":
		if o.known(cn.ThreadID) {
			o.apply(func(sv *server) {
				if k := sv.kids[cn.ThreadID]; k != nil {
					k.running(cn.Turn.StartedAt * 1000)
				}
			})
		}
	case "turn/completed":
		if o.known(cn.ThreadID) {
			o.apply(func(sv *server) {
				if k := sv.kids[cn.ThreadID]; k != nil {
					k.turnEnded(cn.Turn.Status, cn.Turn.CompletedAt*1000)
				}
			})
		}
	case "thread/status/changed":
		if o.known(cn.ThreadID) {
			o.apply(func(sv *server) {
				if k := sv.kids[cn.ThreadID]; k != nil {
					k.status(cn.Status.Type, false)
					if k.live == liveRunning && k.settle.IsZero() && (cn.Status.Type == codexapp.ThreadIdle || cn.Status.Type == codexapp.ThreadSystemError) {
						k.settle, k.settleGen = now.Add(o.src.opts.Settle), k.settleGen+1
					}
				}
			})
		}
	case "thread/closed":
		if o.known(cn.ThreadID) {
			o.apply(func(sv *server) {
				if k := sv.kids[cn.ThreadID]; k != nil {
					k.status(codexapp.ThreadNotLoaded, false)
				}
			})
		}
	}
}

// item applies a parent's item naming children: subAgentActivity (the
// spawn, a message or follow-up, an interrupt, a turn completed) and
// collabAgentToolCall (v1: a spawn, a close; any other tool names them
// only). Its stream is the parent's (the root's, or a child's for a nested
// spawn). A tool call's status is never a child's state.
func (o *observer) item(cn codexapp.ChildNote, now time.Time) {
	it := cn.Item
	if it.Type != codexapp.ItemSubAgentActivity && it.Type != codexapp.ItemCollabToolCall {
		return
	}
	parent := cn.ThreadID
	if it.Type == codexapp.ItemCollabToolCall && it.SenderThreadID != "" {
		parent = it.SenderThreadID
	}
	if parent != o.session && !o.known(parent) {
		return // not a stream of this session's tree
	}
	at := cmp.Or(cn.CompletedAtMs, cn.StartedAtMs)
	var fresh []string
	o.apply(func(sv *server) {
		for _, id := range it.Children() {
			if id == "" || id == o.session {
				continue
			}
			k := sv.kids[id]
			if k == nil {
				if k = sv.add(id, now); k == nil {
					continue
				}
				fresh = append(fresh, id)
			}
			if k.parent == "" {
				k.parent = parent
			}
			k.last = max(k.last, at)
			switch it.Type {
			case codexapp.ItemSubAgentActivity:
				k.path = cmp.Or(k.path, it.AgentPath)
				switch it.Kind {
				case codexapp.ActivityStarted:
					k.dispatch = cmp.Or(k.dispatch, it.ID)
					if k.started == 0 || (at > 0 && at < k.started) {
						k.started = at
					}
					if !k.ran {
						k.running(0)
					}
				case codexapp.ActivityCompleted:
					k.ended(proto.ChildCompleted, at)
				case codexapp.ActivityInterrupted:
					k.ended(proto.ChildInterrupted, at)
				}
			case codexapp.ItemCollabToolCall:
				if it.Status != "completed" {
					continue
				}
				switch it.Tool {
				case codexapp.ToolSpawnAgent:
					if len(it.ReceiverThreadIDs) == 1 {
						k.dispatch = cmp.Or(k.dispatch, it.ID)
					}
					if !k.ran {
						k.running(0)
					}
				case codexapp.ToolCloseAgent:
					k.ended(proto.ChildShutDown, at)
				}
			}
		}
	})
	// A child named for the first time: its metadata (nickname, role,
	// ephemeral, parent) from one read.
	for _, id := range fresh {
		o.metadata(id)
	}
}

// metadata reads a child's thread once for what the items do not say.
func (o *observer) metadata(id string) {
	th, err := o.read(id)
	if err != nil {
		return
	}
	o.apply(func(sv *server) {
		if k := sv.kids[id]; k != nil {
			k.meta(th, o.session)
		}
	})
}

// known reports whether id is a child of the session, reading a thread it
// does not know yet (a status, a turn or a close of a thread the items have
// not named: a nested child, one spawned before this connection): a
// spawned thread whose parent chain reaches the session is one.
func (o *observer) known(id string) bool {
	if id == "" || id == o.session {
		return false
	}
	var have, not bool
	o.src.mu.Lock()
	if b := o.src.books[o.session]; b != nil && b.srv != nil {
		have, not = b.srv.kids[id] != nil, b.srv.notKids[id]
	}
	o.src.mu.Unlock()
	if have || not {
		return have
	}
	chain := map[string]codexapp.Thread{}
	cur := id
	for range 8 {
		th, err := o.read(cur)
		if err != nil {
			return false // not read: asked again next time
		}
		chain[cur] = *th
		p := th.ParentID()
		if p == "" || p == o.session {
			break
		}
		var known bool
		o.src.mu.Lock()
		if b := o.src.books[o.session]; b != nil && b.srv != nil {
			known = b.srv.kids[p] != nil
		}
		o.src.mu.Unlock()
		if known {
			break
		}
		cur = p
	}
	ok := false
	o.apply(func(sv *server) {
		if !chained(chain, sv, id, o.session) {
			if len(sv.notKids) >= maxNotKids {
				clear(sv.notKids)
			}
			sv.notKids[id] = true
			return
		}
		// The chain from the top down, so a parent comes before its child.
		var ids []string
		for c := id; len(ids) <= len(chain); {
			t, in := chain[c]
			if !in || slices.Contains(ids, c) {
				break
			}
			ids = append([]string{c}, ids...)
			c = t.ParentID()
		}
		for _, c := range ids {
			t := chain[c]
			k := sv.kids[c]
			if k == nil {
				if k = sv.add(c, o.src.opts.Now()); k == nil {
					return
				}
				k.meta(&t, o.session)
				k.status(t.Status.Type, false)
			}
		}
		ok = sv.kids[id] != nil
	})
	return ok
}

// nextSettle is the earliest pending settle.
func (o *observer) nextSettle() time.Time {
	var next time.Time
	o.src.mu.Lock()
	defer o.src.mu.Unlock()
	if b := o.src.books[o.session]; b != nil && b.srv != nil && b.srv.token == o.token {
		for _, k := range b.srv.kids {
			if !k.settle.IsZero() && (next.IsZero() || k.settle.Before(next)) {
				next = k.settle
			}
		}
	}
	return next
}

// settle reads the last turn of each child whose idle came with no end
// within Settle: its status is the end (completed; interrupted or failed:
// interrupted); a turn still in progress, none, or a refusal (an ephemeral
// child, a legacy one not loaded) leaves it idle.
func (o *observer) settle() {
	now := o.src.opts.Now()
	type due struct {
		id  string
		gen int
	}
	var dues []due
	o.src.mu.Lock()
	if b := o.src.books[o.session]; b != nil && b.srv != nil && b.srv.token == o.token {
		for id, k := range b.srv.kids {
			if !k.settle.IsZero() && !now.Before(k.settle) {
				dues = append(dues, due{id, k.settleGen})
			}
		}
	}
	o.src.mu.Unlock()
	slices.SortFunc(dues, func(a, b due) int { return cmp.Compare(a.id, b.id) })
	for _, d := range dues {
		ctx, cancel := o.call()
		t, err := o.r.LastTurn(ctx, d.id)
		cancel()
		o.apply(func(sv *server) {
			k := sv.kids[d.id]
			if k == nil || k.settleGen != d.gen || k.settle.IsZero() {
				return // it ran again, or ended, meanwhile
			}
			k.settle = time.Time{}
			if err == nil && t != nil && t.Status != codexapp.TurnInProgress {
				k.turnEnded(t.Status, 0)
				return
			}
			k.live = liveIdle
		})
	}
}

// add is a new child of the session (nil: too many).
func (sv *server) add(id string, now time.Time) *kid {
	if k := sv.kids[id]; k != nil {
		return k
	}
	if len(sv.kids) >= childagents.MaxPerWorker {
		return nil
	}
	sv.seq++
	k := &kid{thread: id, seq: sv.seq}
	sv.kids[id] = k
	delete(sv.notKids, id)
	return k
}

// meta takes a read thread's metadata.
func (k *kid) meta(t *codexapp.Thread, session string) {
	sp, _ := t.Spawn()
	if p := t.ParentID(); p != "" {
		k.parent = p
	}
	k.name = cmp.Or(t.AgentNickname, sp.Nickname, k.name)
	k.typ = cmp.Or(t.AgentRole, sp.Role, k.typ)
	k.path = cmp.Or(sp.Path, k.path)
	k.ephemeral = t.Ephemeral
	if k.started == 0 && t.CreatedAt > 0 {
		k.started = t.CreatedAt * 1000
	}
}

// status takes a status the server gave: in a list or a read (recovered:
// an idle child then is idle, whatever it did before), or a broadcast
// thread/status/changed.
func (k *kid) status(st string, recovered bool) {
	switch st {
	case codexapp.ThreadActive:
		k.running(0)
	case codexapp.ThreadIdle, codexapp.ThreadSystemError:
		switch {
		case recovered:
			k.live = liveIdle
		case k.ran && k.live != liveRunning:
			k.live = liveIdle
		}
		// Running, it waits for its end (handle sets settle); a fresh
		// child's first idle (pending init) says nothing.
	case codexapp.ThreadNotLoaded:
		k.live, k.settle = liveNotLoaded, time.Time{}
	}
}

// running: a turn of it runs (again): its earlier end is over.
func (k *kid) running(at int64) {
	k.live, k.ran, k.end, k.endAt, k.settle = liveRunning, true, "", 0, time.Time{}
	if at > 0 && (k.started == 0 || at < k.started) {
		k.started = at
	}
}

// ended: its turn ended as state at at (ms; 0: not shown).
func (k *kid) ended(state string, at int64) {
	k.end, k.endAt, k.settle = state, at, time.Time{}
	k.ran = true
	if k.live != liveNotLoaded {
		k.live = liveIdle
	}
	k.last = max(k.last, at)
}

// turnEnded takes a turn's end status (completed; interrupted or failed:
// interrupted, #22 having no failed state).
func (k *kid) turnEnded(status string, at int64) {
	switch status {
	case codexapp.TurnCompleted:
		k.ended(proto.ChildCompleted, at)
	case codexapp.TurnInterrupted, codexapp.TurnFailed:
		k.ended(proto.ChildInterrupted, at)
	}
}

// combine is the session's evidence: the rollouts' (derive), and while the
// server owns the session, its word on each child's state.
//
// The server that owns the conversation is the authority on a child's
// state once a join of it was seen this run; the rollouts still give the
// rest (names, parents, the transcript, times). While it is joined: a
// child it shows running is running; the end of its latest turn it showed
// is its state; one it shows idle or not loaded with no end it saw takes
// the rollouts' end, else is idle (loaded) or unknown (not in memory: a
// killed process's child, whose rollout never ends). With the join lost,
// no live claim stands: an end it or the rollouts showed stays, any other
// child is unknown, the rollouts' running included. A child it never named
// keeps the rollouts' word (joined), or loses a running one (lost).
func combine(session string, roll []childagents.Evidence, sv *server) []childagents.Evidence {
	if sv == nil || !sv.owned {
		return roll
	}
	out := make([]childagents.Evidence, 0, len(roll)+len(sv.kids))
	seen := map[string]bool{}
	for _, e := range roll {
		seen[e.NativeID] = true
		out = append(out, overlay(session, e, sv.kids[e.NativeID], sv.attached))
	}
	kids := make([]*kid, 0, len(sv.kids))
	for _, k := range sv.kids {
		if !seen[k.thread] {
			kids = append(kids, k)
		}
	}
	slices.SortFunc(kids, func(a, b *kid) int { return cmp.Compare(a.seq, b.seq) })
	for _, k := range kids {
		out = append(out, overlay(session, childagents.Evidence{}, k, sv.attached))
	}
	return out
}

func isEnd(state string) bool {
	return state == proto.ChildCompleted || state == proto.ChildInterrupted || state == proto.ChildShutDown
}

// overlay is one child's evidence: r the rollouts' (zero: none), k the
// server's (nil: none).
func overlay(session string, r childagents.Evidence, k *kid, attached bool) childagents.Evidence {
	e := r
	if e.NativeID == "" {
		e = childagents.Evidence{Session: session, Provider: proto.ChildCodex, NativeID: k.thread, Source: proto.ChildFromAppServer}
	}
	if k != nil {
		e.DispatchID = cmp.Or(e.DispatchID, k.dispatch)
		if e.Parent == nil && k.parent != "" {
			e.Parent = parentOf(session, k.parent)
		}
		e.Name, e.Type = cmp.Or(e.Name, k.name), cmp.Or(e.Type, k.typ)
		e.Description = cmp.Or(e.Description, leaf(k.path))
		if k.started > 0 && (e.StartedAt == 0 || k.started < e.StartedAt) {
			e.StartedAt = k.started
		}
		e.LastActivityAt = max(e.LastActivityAt, k.last)
		switch {
		case k.ephemeral:
			e.Transcript = proto.TranscriptUnavailable // live only: no rollout, ever
		case r.NativeID == "":
			e.Transcript = proto.TranscriptPending // its rollout not read yet
		}
	}
	e.State, e.EndedAt, e.Source = decide(r, k, attached)
	return e
}

// decide is combine's rule for one child's state, its end time and the
// source that set it.
func decide(r childagents.Evidence, k *kid, attached bool) (string, int64, string) {
	rollout := func() (string, int64, string) { return r.State, r.EndedAt, cmp.Or(r.Source, proto.ChildFromAppServer) }
	server := func(state string, at int64) (string, int64, string) { return state, at, proto.ChildFromAppServer }
	switch {
	case k == nil:
		if !attached && r.State == proto.ChildRunning {
			return server(proto.ChildUnknown, 0)
		}
		return rollout()
	case !attached:
		if k.end != "" {
			return server(k.end, k.endAt)
		}
		if isEnd(r.State) {
			return rollout()
		}
		return server(proto.ChildUnknown, 0)
	case k.live == liveRunning:
		return server(proto.ChildRunning, 0)
	case k.end != "":
		return server(k.end, cmp.Or(k.endAt, r.EndedAt))
	case k.live == liveIdle:
		if isEnd(r.State) {
			return rollout()
		}
		return server(proto.ChildIdle, 0)
	case k.live == liveNotLoaded:
		if isEnd(r.State) {
			return rollout()
		}
		return server(proto.ChildUnknown, 0)
	}
	return rollout()
}

// quiet reports whether session's observer has nothing to do now
// (tests): its recovery and queue done, no settle pending.
func (s *Source) quiet(session string) bool {
	s.mu.Lock()
	b := s.books[session]
	var o *observer
	settling := false
	if b != nil && b.srv != nil {
		o = b.srv.obs
		for _, k := range b.srv.kids {
			settling = settling || !k.settle.IsZero()
		}
	}
	s.mu.Unlock()
	if o == nil {
		return true
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return !o.busy && len(o.queue) == 0 && !o.resync && o.recovers > 0 && !settling
}
