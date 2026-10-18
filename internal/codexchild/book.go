package codexchild

import (
	"bytes"
	"cmp"
	"encoding/json"
	"slices"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// ListFor is how long after its spawn a child whose rollout is not seen yet
// asks for the date directories to be listed every poll (Codex writes the
// file 5–212 ms after the spawn, sometimes after its started record).
const ListFor = time.Minute

// facts are what one reader of a session's rollouts observed (cleared when
// they are read again from their start). They are kept by the file that
// showed them (its home), each keyed by an explicit id (a spawn call's, a
// turn's, an activity's), so a line read twice changes nothing, and a file
// that goes, or turns out not to be this session's, takes what it showed
// with it.
type facts struct {
	seq   int
	homes map[string]*home // by thread id: "" is the root's rollout, else a child's
	gone  map[string]bool  // child threads whose rollout went
}

func newFacts() *facts {
	return &facts{homes: map[string]*home{}, gone: map[string]bool{}}
}

// home is what one rollout showed.
type home struct {
	seq int
	// A child's rollout: its first line (nil: not read yet), and bad when
	// that line is not a spawned child of this session with this id (its
	// records then count for nothing).
	meta *codex.Meta
	bad  bool
	// first and last are its own records' timestamps (a child's: those at
	// or past its history start).
	first, last int64
	spawns      map[string]string // spawn_agent call id → its task_name
	links       map[string]link   // by child thread: the record that started it
	obs         map[string]obs    // lifecycle observations, by record key
}

// link is a spawner's record naming a child thread: v2's SubAgentActivity
// started (its id the spawn call's), v1's completed spawn_agent
// CollabAgentToolCall (its id the item's), a legacy-history sub_agent_activity.
type link struct {
	dispatch string
	path     string
	nick     string
	ts       int64
	seq      int
}

// obs is one observation of a child's lifecycle: running, completed,
// interrupted or shut down, at ts (the record's time).
type obs struct {
	thread, state string
	ts            int64
}

func (f *facts) home(thread string) *home {
	h := f.homes[thread]
	if h == nil {
		f.seq++
		h = &home{seq: f.seq, spawns: map[string]string{}, links: map[string]link{}, obs: map[string]obs{}}
		f.homes[thread] = h
	}
	return h
}

// mainLine records what a line of the root's rollout shows: only a line
// with a collaboration record is decoded (true: it was).
func (f *facts) mainLine(b []byte) bool {
	if !bytes.Contains(b, []byte(`"SubAgentActivity"`)) && !bytes.Contains(b, []byte(`"sub_agent_activity"`)) &&
		!bytes.Contains(b, []byte(`"CollabAgentToolCall"`)) && !bytes.Contains(b, []byte(`"spawn_agent"`)) {
		return false
	}
	var r record
	if json.Unmarshal(b, &r) != nil {
		return false
	}
	f.record("", f.home(""), &r)
	return true
}

// childLine records what a line of a child's rollout shows. Its first line
// (off 0) decides whether it is this session's child: a spawned child
// (thread_spawn) of session with this thread id; else nothing in it counts.
// Records before its history start are the parent's copied history (a
// forked child's), the copy of the parent's session_meta among them: they
// count for nothing either.
func (f *facts) childLine(session, thread string, off int64, b []byte) {
	delete(f.gone, thread)
	h := f.home(thread)
	if off == 0 {
		m, ok := codex.ParseMeta(b)
		h.meta = &m
		if !ok || !m.Child() || m.ID != thread || m.Session != session {
			f.retract(h)
		}
		return
	}
	if h.bad || h.meta == nil {
		return
	}
	var r record
	if json.Unmarshal(b, &r) != nil {
		return
	}
	if s := h.meta.HistoryStart; s > 0 && (r.Ordinal == nil || *r.Ordinal < s) {
		return
	}
	if ts := stamp(r.Timestamp); ts > 0 {
		if h.first == 0 || ts < h.first {
			h.first = ts
		}
		h.last = max(h.last, ts)
	}
	f.record(thread, h, &r)
}

// retract marks a file bad and forgets what it showed.
func (f *facts) retract(h *home) {
	h.bad = true
	clear(h.spawns)
	clear(h.links)
	clear(h.obs)
	h.first, h.last = 0, 0
}

// goneFile records that a child's rollout went: what it showed goes too.
func (f *facts) goneFile(thread string) {
	delete(f.homes, thread)
	f.gone[thread] = true
}

// record records a record of the rollout of thread ("": the root's). A
// child's own turns are its lifecycle; a spawner's activity records are its
// children's. The status of a collaboration tool call (a wait that
// returned, a spawn call done) is the call's, never a child's: only an
// explicit started, completed, interrupted or closed record is read.
func (f *facts) record(thread string, h *home, r *record) {
	ts := stamp(r.Timestamp)
	var p payload
	if json.Unmarshal(r.Payload, &p) != nil {
		return
	}
	switch r.Type {
	case "response_item":
		if p.Type == "function_call" && p.Name == "spawn_agent" && (p.Namespace == "collaboration" || p.Namespace == "") && p.CallID != "" {
			var a spawnArgs
			_ = json.Unmarshal([]byte(p.Arguments), &a)
			h.spawns[p.CallID] = a.TaskName
		}
	case "event_msg":
		switch p.Type {
		case "task_started", "task_complete", "turn_aborted":
			if thread == "" || p.TurnID == "" {
				return // the root's own turns
			}
			state, key := proto.ChildRunning, "turn:"+p.TurnID+":start"
			switch p.Type {
			case "task_complete":
				state, key = proto.ChildCompleted, "turn:"+p.TurnID+":end"
			case "turn_aborted": // interrupted, replaced, budget_limited, …: stopped before it completed
				state, key = proto.ChildInterrupted, "turn:"+p.TurnID+":end"
			}
			h.obs[key] = obs{thread: thread, state: state, ts: ts}
		case "item_completed":
			var it item
			if json.Unmarshal(p.Item, &it) != nil || it.ID == "" {
				return
			}
			switch it.Type {
			case "SubAgentActivity":
				f.activity(h, it.ID, it.Kind, it.AgentThreadID, it.AgentPath, ts, false)
			case "CollabAgentToolCall":
				f.collab(h, &it, ts)
			}
		case "sub_agent_activity":
			at := ts
			if p.OccurredAtMS > 0 {
				at = p.OccurredAtMS
			}
			f.activity(h, p.EventID, p.Kind, p.AgentThreadID, p.AgentPath, at, true)
		}
	}
}

// activity records a spawner's SubAgentActivity: started links the child
// to its spawn call (id: the call's id), completed ends one of its turns
// (id: subagent-completed-<turn>), interrupted is interrupt_agent's (id:
// its call's). interacted (a message or a follow-up) says nothing of the
// state: the child's own next turn does. A legacy-history event's id is
// its own: it names the spawn only when a spawn call of this file has it.
func (f *facts) activity(h *home, id, kind, thread, agentPath string, ts int64, legacy bool) {
	if thread == "" {
		return
	}
	switch kind {
	case "started":
		dispatch := id
		if _, ok := h.spawns[id]; legacy && !ok {
			dispatch = ""
		}
		if _, ok := h.links[thread]; !ok {
			f.seq++
			h.links[thread] = link{dispatch: dispatch, path: agentPath, ts: ts, seq: f.seq}
		}
		h.obs["started:"+thread] = obs{thread: thread, state: proto.ChildRunning, ts: ts}
	case "completed":
		h.obs["completed:"+id+":"+thread] = obs{thread: thread, state: proto.ChildCompleted, ts: ts}
	case "interrupted":
		h.obs["interrupted:"+id+":"+thread] = obs{thread: thread, state: proto.ChildInterrupted, ts: ts}
	}
}

// collab records a v1 CollabAgentToolCall: a completed spawn_agent names
// its child (receiver_thread_ids, one) and its nickname; a completed
// close_agent shuts its receivers down. Any other tool (wait, send_input,
// resume_agent) and any other status says nothing of a child.
func (f *facts) collab(h *home, it *item, ts int64) {
	if it.Status != "completed" {
		return
	}
	switch it.Tool {
	case "spawn_agent":
		if len(it.ReceiverThreadIDs) != 1 || it.ReceiverThreadIDs[0] == "" {
			return
		}
		thread := it.ReceiverThreadIDs[0]
		nick := ""
		for _, a := range it.ReceiverAgents {
			if a.ThreadID == thread {
				nick = a.AgentNickname
			}
		}
		if _, ok := h.links[thread]; !ok {
			f.seq++
			h.links[thread] = link{dispatch: it.ID, nick: nick, ts: ts, seq: f.seq}
		}
		h.obs["started:"+thread] = obs{thread: thread, state: proto.ChildRunning, ts: ts}
	case "close_agent":
		for _, thread := range it.ReceiverThreadIDs {
			if thread != "" {
				h.obs["closed:"+it.ID+":"+thread] = obs{thread: thread, state: proto.ChildShutDown, ts: ts}
			}
		}
	}
}

// rank orders states observed at the same instant: an end over a start, a
// shutdown over an interrupt.
func rank(state string) int {
	switch state {
	case proto.ChildCompleted:
		return 1
	case proto.ChildInterrupted:
		return 2
	case proto.ChildShutDown:
		return 3
	}
	return 0
}

// homesInOrder are the files that count, the root's first, then in the
// order first read.
func (f *facts) homesInOrder() []string {
	ids := make([]string, 0, len(f.homes))
	for id, h := range f.homes {
		if !h.bad {
			ids = append(ids, id)
		}
	}
	slices.SortFunc(ids, func(a, b string) int {
		if (a == "") != (b == "") {
			if a == "" {
				return -1
			}
			return 1
		}
		return cmp.Or(cmp.Compare(f.homes[a].seq, f.homes[b].seq), cmp.Compare(a, b))
	})
	return ids
}

// derive makes the evidence of every child the facts show, in the order
// first seen: each child rollout of the session, and each thread a spawner
// named, by its thread id.
func derive(session string, f *facts) []childagents.Evidence {
	homes := f.homesInOrder()
	type kid struct {
		thread string
		seq    int
	}
	seen := map[string]int{}
	var kids []kid
	add := func(thread string, seq int) {
		if i, ok := seen[thread]; ok {
			kids[i].seq = min(kids[i].seq, seq)
			return
		}
		seen[thread] = len(kids)
		kids = append(kids, kid{thread, seq})
	}
	for _, id := range homes {
		h := f.homes[id]
		if id != "" && h.meta != nil {
			add(id, h.seq)
		}
		for thread, l := range h.links {
			add(thread, l.seq)
		}
	}
	slices.SortStableFunc(kids, func(a, b kid) int { return cmp.Or(cmp.Compare(a.seq, b.seq), cmp.Compare(a.thread, b.thread)) })
	var out []childagents.Evidence
	for _, k := range kids {
		if e, ok := evidence(session, f, homes, k.thread); ok {
			out = append(out, e)
		}
	}
	return out
}

// evidence is what the facts say of one child thread; false: it shows as
// no row (its rollout went, or is not this session's).
func evidence(session string, f *facts, homes []string, thread string) (childagents.Evidence, bool) {
	if f.gone[thread] || thread == session {
		return childagents.Evidence{}, false
	}
	own := f.homes[thread]
	if own != nil && own.bad {
		return childagents.Evidence{}, false
	}
	e := childagents.Evidence{Session: session, Provider: proto.ChildCodex, NativeID: thread, Source: proto.ChildFromRollout}
	// The record that started it: the first in the files' order (the
	// root's first), and the file that holds it, its spawner.
	var l link
	spawner, linked := "", false
	for _, id := range homes {
		if x, ok := f.homes[id].links[thread]; ok {
			l, spawner, linked = x, id, true
			break
		}
	}
	e.DispatchID = l.dispatch
	var m *codex.Meta
	if own != nil && own.meta != nil {
		m = own.meta
	}
	// Who started it: its rollout's first line (thread_spawn's parent,
	// with the top-level parent_thread_id agreeing), else the file holding
	// its started record. Never forked_from_id, never a later session_meta.
	switch {
	case m != nil:
		if p := m.Source.ThreadSpawn.Parent; p != "" && (m.Parent == "" || m.Parent == p) {
			e.Parent = parentOf(session, p)
		}
	case linked:
		e.Parent = parentOf(session, spawner)
	}
	task := ""
	if linked && l.dispatch != "" {
		task = f.homes[spawner].spawns[l.dispatch]
	}
	if m != nil {
		ts := m.Source.ThreadSpawn
		e.Name, e.Type = ts.Nickname, ts.Role
		e.Description = leaf(ts.Path)
	}
	e.Name = cmp.Or(e.Name, l.nick)
	e.Description = cmp.Or(e.Description, leaf(l.path), leaf(task))
	// Lifecycle: the latest observation, from any file that counts (an
	// end over a start at the same instant). Quiet files end nothing.
	var last obs
	found := false
	for _, id := range homes {
		for _, o := range f.homes[id].obs {
			if o.thread != thread {
				continue
			}
			if !found || o.ts > last.ts || (o.ts == last.ts && rank(o.state) > rank(last.state)) {
				last, found = o, true
			}
			e.LastActivityAt = max(e.LastActivityAt, o.ts)
		}
	}
	e.State = proto.ChildRunning // spawned: its first turn is on its way
	if found {
		e.State = last.state
		if last.state != proto.ChildRunning {
			e.EndedAt = last.ts
		}
	}
	if linked && l.ts > 0 {
		e.StartedAt = l.ts
	}
	if own != nil {
		if own.first > 0 && (e.StartedAt == 0 || own.first < e.StartedAt) {
			e.StartedAt = own.first
		}
		e.LastActivityAt = max(e.LastActivityAt, own.last)
	}
	switch {
	case m != nil:
		e.Transcript = proto.TranscriptAvailable
	case e.State == proto.ChildRunning:
		e.Transcript = proto.TranscriptPending // started, its rollout not written (or not found) yet
	default:
		e.Transcript = proto.TranscriptUnavailable
	}
	return e, true
}

func parentOf(session, thread string) *childagents.ParentRef {
	if thread == "" || thread == session {
		return &childagents.ParentRef{Kind: proto.ParentRoot}
	}
	return &childagents.ParentRef{Kind: proto.ParentChild, NativeID: thread}
}

// wantList reports whether a child named within ListFor (by now) has no
// rollout read yet.
func wantList(f *facts, now time.Time) bool {
	for _, h := range f.homes {
		if h.bad {
			continue
		}
		for thread, l := range h.links {
			if f.homes[thread] == nil && !f.gone[thread] && (l.ts == 0 || now.UnixMilli()-l.ts < ListFor.Milliseconds()) {
				return true
			}
		}
	}
	return false
}
