package claudechild

import (
	"bytes"
	"cmp"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// Timings of the derivation (the bridge's clock, never the evidence's).
const (
	// HoldUnpaired is how long a child file whose dispatch is not known yet
	// waits for the evidence that pairs it (its meta's toolUseId, about
	// 0.1–1.6 s after it) while a dispatch of the session is unpaired: so
	// the child shows as one row, not as a row of its own merged into the
	// dispatch's later. Never longer: a file no evidence pairs shows alone.
	HoldUnpaired = 5 * time.Second
	// ListFor is how long after its dispatch an unpaired child asks for
	// the subagents directory to be listed every poll.
	ListFor = time.Minute
)

// facts are what one reader of a session's files observed (cleared when
// its files are read again from the start). Each is keyed by an explicit
// id, so a line read twice changes nothing.
type facts struct {
	seq      int                  // observation counter
	dispatch map[string]*dispatch // by tool_use id
	results  map[string]ended     // by tool_use id: the call's result, in its own file
	pairs    map[string]string    // tool_use id → agentId, from its result
	notes    map[note]bool        // task notifications (each is in two records)
	metas    map[string]metaFact  // by agentId
	files    map[string]*file     // by agentId
	gone     map[string]bool      // agentIds whose file went
}

func newFacts() *facts {
	return &facts{dispatch: map[string]*dispatch{}, results: map[string]ended{}, pairs: map[string]string{},
		notes: map[note]bool{}, metas: map[string]metaFact{}, files: map[string]*file{}, gone: map[string]bool{}}
}

// dispatch is an Agent call: a child started (or about to).
type dispatch struct {
	id string
	// home is the agentId of the child whose transcript holds the call
	// ("": the main transcript).
	home              string
	name, typ, desc   string
	teammate          bool
	ts                int64 // the call's record (0: a hook's, which has none)
	seq               int
	fromHook, fromLog bool
}

// ended is an end of a child's work: its state and when.
type ended struct {
	state string
	ts    int64
	// launched says a background child started (no end).
	launched bool
	teammate bool
}

type note struct {
	agent, tool string
	ended
}

type metaFact struct {
	meta
	mtime int64
}

// file is a child's transcript as read.
type file struct {
	seq     int
	lines   int
	first   int64 // the earliest record's timestamp
	last    int64 // the latest
	prompt  int64 // the latest prompt's (its task, a resume, a Stop hook's feedback)
	fork    bool
	copying int // records of a fork's copied context still to skip
	// sessionOK and agentOK say its first record naming a session, and its
	// first naming an agent, named this one (a fork's first line names
	// its agent only).
	sessionOK, agentOK bool
	bad                bool // its records name another session or agent
	seenAt             time.Time
}

// hookFacts are what the hook log said of a session. Hook input carries no
// timestamp, so it never decides a lifecycle: it adds the dispatch before
// its transcript line, the pairing, the nested parent and the type.
type hookFacts struct {
	seq      int
	dispatch map[string]*dispatch
	pairs    map[string]string // tool_use id → agentId (PostToolUse)
	types    map[string]string // agentId → agent_type (SubagentStart/Stop)
}

func newHookFacts() *hookFacts {
	return &hookFacts{dispatch: map[string]*dispatch{}, pairs: map[string]string{}, types: map[string]string{}}
}

// toolUseIDRe finds the calls a line's tool results answer, so most lines
// are never decoded here (the usage reads every one already).
var toolUseIDRe = regexp.MustCompile(`"tool_use_id"\s*:\s*"([^"\\]{1,128})"`)

// mainLine records what a main transcript line shows: only a line with an
// Agent call, a result of a known call or a task notification is decoded
// (true: it was).
func (f *facts) mainLine(b []byte) bool {
	call := bytes.Contains(b, []byte(`"tool_use"`)) && (bytes.Contains(b, []byte(`"Agent"`)) || bytes.Contains(b, []byte(`"Task"`)))
	if !call && !bytes.Contains(b, []byte("task-notification")) && !f.answers(b) {
		return false
	}
	var l line
	if json.Unmarshal(b, &l) != nil {
		return false
	}
	f.record("", &l)
	return true
}

// answers reports whether a line holds the result of a known call.
func (f *facts) answers(b []byte) bool {
	if !bytes.Contains(b, []byte(`"tool_result"`)) {
		return false
	}
	for _, m := range toolUseIDRe.FindAllSubmatch(b, -1) {
		if f.dispatch[string(m[1])] != nil {
			return true
		}
	}
	return false
}

// childLine records what a line of child agent's transcript shows. A file
// whose first records name another session or agent shows nothing at all;
// and nothing in a file counts before a record of it named this session
// (every record that does, a call, a result or a notification, names it).
func (f *facts) childLine(session, agent string, b []byte) {
	var l line
	if json.Unmarshal(b, &l) != nil {
		return
	}
	fl := f.file(agent)
	delete(f.gone, agent)
	fl.lines++
	if !fl.bad && !fl.sessionOK && l.SessionID != "" {
		fl.sessionOK, fl.bad = l.SessionID == session, l.SessionID != session
	}
	if !fl.bad && !fl.agentOK && l.AgentID != "" {
		fl.agentOK, fl.bad = l.AgentID == agent, l.AgentID != agent
	}
	if fl.bad {
		return
	}
	if l.Type == "fork-context-ref" {
		// A fork's file starts with its parent's context: copies of the
		// parent's spawning call and its result (same tool_use id), which
		// are not this child's (docs/research/claude-subagents.md).
		fl.fork, fl.copying = true, 2
		return
	}
	if fl.copying > 0 && (l.Type == "assistant" || l.Type == "user") {
		fl.copying--
		return
	}
	if l.Type == "user" || l.Type == "assistant" || l.Type == "attachment" || l.Type == "system" {
		if ts := stamp(l.Timestamp); ts > 0 {
			if fl.first == 0 || ts < fl.first {
				fl.first = ts
			}
			fl.last = max(fl.last, ts)
			if l.prompt() {
				fl.prompt = max(fl.prompt, ts)
			}
		}
	}
	if fl.sessionOK {
		f.record(agent, &l)
	}
}

func (f *facts) file(agent string) *file {
	fl := f.files[agent]
	if fl == nil {
		f.seq++
		fl = &file{seq: f.seq}
		f.files[agent] = fl
	}
	return fl
}

// record records a record's calls, results and notifications, read in the
// transcript of home ("": the main one).
func (f *facts) record(home string, l *line) {
	ts := stamp(l.Timestamp)
	switch l.Type {
	case "assistant":
		if l.Message == nil {
			return
		}
		for _, b := range blocks(l.Message.Content) {
			if b.Type != "tool_use" || !subagentTool(b.Name) || b.ID == "" {
				continue
			}
			if d := f.dispatch[b.ID]; d != nil {
				continue // seen (a fork's copy of it, or the line again): not a new call
			}
			var in agentInput
			_ = json.Unmarshal(b.Input, &in)
			f.seq++
			f.dispatch[b.ID] = &dispatch{id: b.ID, home: home, name: in.Name, typ: in.SubagentType, desc: in.Description,
				teammate: in.TeamName != "", ts: ts, seq: f.seq, fromLog: true}
		}
	case "user":
		if l.Message == nil {
			return
		}
		var res agentResult
		resRead := false
		for _, b := range blocks(l.Message.Content) {
			switch b.Type {
			case "tool_result":
				d := f.dispatch[b.ToolUseID]
				if d == nil || d.home != home {
					continue // not an Agent call of this transcript (a fork's copy is not)
				}
				if !resRead {
					res, resRead = result(l.ToolUseResult), true // it goes with the record's first result
				}
				e := ended{ts: ts, teammate: res.teammate()}
				switch {
				case b.IsError:
					e.state = proto.ChildInterrupted // rejected (an interrupt) or failed before it could complete
				case res.Status == "completed":
					e.state = proto.ChildCompleted
				case res.Status == "async_launched":
					e.launched = true
				}
				f.results[b.ToolUseID] = e
				if res.AgentID != "" && !b.IsError {
					f.pairs[b.ToolUseID] = res.AgentID
				}
			case "text":
				f.note(b.Text, ts)
			}
		}
	case "queue-operation":
		var s string
		if l.Operation == "enqueue" && json.Unmarshal(l.Content, &s) == nil {
			f.note(s, ts)
		}
	}
}

// note records a text's task notifications as ends. completed is
// completed; killed (stopped) and failed are interrupted: stopped before the
// task was done (phase 1 has no failed state). Another status says nothing.
// A background shell's notification names no child and stays unmatched.
func (f *facts) note(text string, ts int64) {
	if !strings.Contains(text, "<task-notification>") {
		return
	}
	for _, n := range notifications(text) {
		var state string
		switch n.status {
		case "completed":
			state = proto.ChildCompleted
		case "killed", "failed", "stopped", "cancelled":
			state = proto.ChildInterrupted
		default:
			continue
		}
		f.notes[note{agent: n.taskID, tool: n.toolUseID, ended: ended{state: state, ts: ts}}] = true
	}
}

// metaFile records a child's meta file.
func (f *facts) metaFile(agent string, b []byte, mtime time.Time) {
	m, ok := parseMeta(b)
	if !ok {
		return
	}
	f.file(agent)
	delete(f.gone, agent)
	f.metas[agent] = metaFact{meta: m, mtime: mtime.UnixMilli()}
}

// goneFile records that a child's transcript went. Its meta is kept: it
// may be the only pairing of the child's call, which must go with it (and
// its file back is the same child).
func (f *facts) goneFile(agent string) {
	delete(f.files, agent)
	f.gone[agent] = true
}

// hookLine records a hook's input.
func (h *hookFacts) line(in *hookInput) {
	agent := ""
	if transcript.ValidAgentID(in.AgentID) {
		agent = in.AgentID
	}
	switch in.Event {
	case "PreToolUse", "PostToolUse":
		if !subagentTool(in.ToolName) || in.ToolUseID == "" {
			return
		}
		d := h.dispatch[in.ToolUseID]
		if d == nil {
			h.seq++
			d = &dispatch{id: in.ToolUseID, home: agent, seq: h.seq, fromHook: true}
			if in.ToolInput != nil {
				d.name, d.typ, d.desc, d.teammate = in.ToolInput.Name, in.ToolInput.SubagentType, in.ToolInput.Description, in.ToolInput.TeamName != ""
			}
			h.dispatch[in.ToolUseID] = d
		}
		if in.Event == "PostToolUse" {
			r := result(in.Response)
			d.teammate = d.teammate || r.teammate()
			if r.AgentID != "" {
				h.pairs[in.ToolUseID] = r.AgentID
			}
		}
	case "SubagentStart", "SubagentStop":
		if agent != "" && in.AgentType != nil {
			h.types[agent] = *in.AgentType
		}
	}
}

// kid is one child as the evidence shows it: its dispatch, its agent, or
// both once explicit evidence paired them.
type kid struct {
	tool, agent string
	seq         int
}

// derive makes the evidence of every child the facts show, in the order
// first seen. now is the bridge's clock (HoldUnpaired).
func derive(session string, f *facts, h *hookFacts, now time.Time) []childagents.Evidence {
	kids := pair(f, h)
	unpaired := false
	for _, k := range kids {
		if k.agent == "" && !endedOf(f, k).ok() && !teammate(f, h, k) {
			unpaired = true
		}
	}
	var out []childagents.Evidence
	for _, k := range kids {
		if e, ok := evidence(session, f, h, k, unpaired, now); ok {
			out = append(out, e)
		}
	}
	return out
}

// pair groups the ids into children by explicit evidence only: a meta's
// toolUseId, a call's result naming its agentId, a notification naming
// both, a PostToolUse hook's agentId. Never by order, timing or mtime. The
// first pairing of an id wins (meta, result, notification, hook); a later
// one naming another partner is ignored.
func pair(f *facts, h *hookFacts) []kid {
	toAgent, toTool := map[string]string{}, map[string]string{}
	link := func(tool, agent string) {
		if tool == "" || agent == "" || !transcript.ValidAgentID(agent) {
			return
		}
		if _, ok := toAgent[tool]; ok {
			return
		}
		if _, ok := toTool[agent]; ok {
			return
		}
		toAgent[tool], toTool[agent] = agent, tool
	}
	for _, a := range sortedKeys(f.metas) {
		link(f.metas[a].ToolUseID, a)
	}
	for _, t := range sortedKeys(f.pairs) {
		link(t, f.pairs[t])
	}
	for _, n := range sortedNotes(f) {
		link(n.tool, n.agent)
	}
	for _, t := range sortedKeys(h.pairs) {
		link(t, h.pairs[t])
	}
	seen := map[string]bool{}
	var kids []kid
	add := func(tool, agent string, seq int) {
		key := "d" + tool
		if tool == "" {
			key = "a" + agent
		}
		if seen[key] {
			return
		}
		seen[key] = true
		kids = append(kids, kid{tool: tool, agent: agent, seq: seq})
	}
	// Order: a child's first fact, files' before hooks' (hook facts number
	// apart, and come after: a file read is the evidence of record).
	for _, t := range sortedKeys(f.dispatch) {
		add(t, toAgent[t], f.dispatch[t].seq)
	}
	for _, a := range sortedKeys(f.files) {
		add(toTool[a], a, f.files[a].seq)
	}
	for _, t := range sortedKeys(h.dispatch) {
		if f.dispatch[t] == nil {
			add(t, toAgent[t], 1<<30+h.dispatch[t].seq)
		}
	}
	// A pairing makes one kid of a dispatch and a file seen apart: the
	// first seen's place.
	for i := range kids {
		k := &kids[i]
		if k.tool != "" && k.agent != "" {
			if fl := f.files[k.agent]; fl != nil {
				k.seq = min(k.seq, fl.seq)
			}
		}
	}
	slices.SortStableFunc(kids, func(a, b kid) int { return cmp.Compare(a.seq, b.seq) })
	return kids
}

// sortedNotes are the notifications in their order (time, then ids).
func sortedNotes(f *facts) []note {
	ns := make([]note, 0, len(f.notes))
	for n := range f.notes {
		ns = append(ns, n)
	}
	slices.SortFunc(ns, func(a, b note) int {
		return cmp.Or(cmp.Compare(a.ts, b.ts), cmp.Compare(a.agent, b.agent), cmp.Compare(a.tool, b.tool), cmp.Compare(a.state, b.state))
	})
	return ns
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	slices.Sort(ks)
	return ks
}

// end is a child's latest end (zero: none).
type end struct {
	ended
	source string
}

func (e end) ok() bool { return e.state != "" }

// endedOf is the latest end the transcripts show of a child: its call's
// result, a notification, its meta's finished (at the meta's write).
func endedOf(f *facts, k kid) end {
	var e end
	take := func(c ended) {
		if c.state != "" && c.ts >= e.ts {
			e = end{ended: c, source: proto.ChildFromTranscript}
		}
	}
	if k.tool != "" {
		take(f.results[k.tool])
	}
	for n := range f.notes {
		if (k.agent != "" && n.agent == k.agent) || (k.tool != "" && n.tool == k.tool) {
			take(n.ended)
		}
	}
	if m, ok := f.metas[k.agent]; ok && k.agent != "" && m.Finished {
		take(ended{state: proto.ChildCompleted, ts: m.mtime})
	}
	return e
}

func teammate(f *facts, h *hookFacts, k kid) bool {
	if k.tool == "" {
		return false
	}
	if d := f.dispatch[k.tool]; d != nil && d.teammate {
		return true
	}
	if d := h.dispatch[k.tool]; d != nil && d.teammate {
		return true
	}
	return f.results[k.tool].teammate
}

// evidence is what a child's facts say, as one observation; false: the
// child is shown as no row (a teammate, an internal helper, a file that
// went or names another session, or one held for its pairing).
func evidence(session string, f *facts, h *hookFacts, k kid, unpaired bool, now time.Time) (childagents.Evidence, bool) {
	e := childagents.Evidence{Session: session, Provider: proto.ChildClaude, NativeID: k.agent, DispatchID: k.tool}
	d, hd := f.dispatch[k.tool], h.dispatch[k.tool]
	if k.tool == "" {
		d, hd = nil, nil
	}
	fl, m := f.files[k.agent], f.metas[k.agent]
	hasMeta := false
	if k.agent != "" {
		_, hasMeta = f.metas[k.agent]
	} else {
		fl = nil
	}
	switch {
	case teammate(f, h, k):
		return e, false // an agent-team teammate is no disposable subagent
	case k.agent != "" && f.gone[k.agent]:
		return e, false
	case fl != nil && fl.bad:
		return e, false
	case d == nil && hd == nil && fl == nil:
		return e, false // a hook's helper (/btw, a prompt suggestion: no call, no file)
	case d == nil && hd == nil && h.types[k.agent] == "" && hasType(h, k.agent):
		return e, false // an internal helper: SubagentStart/Stop with an empty agent_type
	case d == nil && hd == nil && !hasMeta && unpaired && !fl.seenAt.IsZero() && now.Sub(fl.seenAt) < HoldUnpaired:
		return e, false // held: its pairing is likely on its way
	case d == nil && hd == nil && !hasMeta && unpaired && fl.seenAt.IsZero():
		return e, false // seen this poll: held
	}
	// Who started it: the transcript holding its call (the main one: the
	// root; a child's: that child), else its meta's parentAgentId, else a
	// first-level spawn depth (the root). Nothing else: unresolved.
	switch {
	case d != nil:
		e.Parent = parentOf(d.home)
	case hd != nil:
		e.Parent = parentOf(hd.home)
	case m.ParentAgentID != "":
		e.Parent = &childagents.ParentRef{Kind: proto.ParentChild, NativeID: m.ParentAgentID}
	case hasMeta && m.SpawnDepth == 1:
		e.Parent = &childagents.ParentRef{Kind: proto.ParentRoot}
	}
	for _, x := range []*dispatch{d, hd} {
		if x == nil {
			continue
		}
		e.Name = cmp.Or(e.Name, x.name)
		e.Type = cmp.Or(e.Type, x.typ)
		e.Description = cmp.Or(e.Description, x.desc)
	}
	if hasMeta {
		e.Type = cmp.Or(e.Type, m.AgentType)
		e.Description = cmp.Or(e.Description, m.Description)
	}
	if k.agent != "" {
		e.Type = cmp.Or(e.Type, h.types[k.agent])
	}
	// Lifecycle, from the transcripts only: the latest end, unless a prompt
	// came after it (resumed: the same agentId at work again). Quiet logs
	// end nothing.
	last := endedOf(f, k)
	resumed := fl != nil && last.ok() && fl.prompt > last.ts
	switch {
	case last.ok() && !resumed:
		e.State, e.Source, e.EndedAt = last.state, last.source, last.ts
	case d != nil || fl != nil:
		e.State, e.Source = proto.ChildRunning, proto.ChildFromTranscript
	default:
		e.State, e.Source = proto.ChildRunning, proto.ChildFromHook // a hook's call, its line not read yet
	}
	if d != nil && d.ts > 0 {
		e.StartedAt = d.ts
	}
	if fl != nil {
		if fl.first > 0 && (e.StartedAt == 0 || fl.first < e.StartedAt) {
			e.StartedAt = fl.first
		}
		e.LastActivityAt = fl.last
	}
	switch {
	case fl != nil:
		e.Transcript = proto.TranscriptAvailable
	case e.EndedAt > 0 || e.State != proto.ChildRunning:
		e.Transcript = proto.TranscriptUnavailable
	default:
		e.Transcript = proto.TranscriptPending // started, its file not written yet
	}
	return e, true
}

func hasType(h *hookFacts, agent string) bool {
	_, ok := h.types[agent]
	return ok
}

func parentOf(home string) *childagents.ParentRef {
	if home == "" {
		return &childagents.ParentRef{Kind: proto.ParentRoot}
	}
	return &childagents.ParentRef{Kind: proto.ParentChild, NativeID: home}
}

// wantList reports whether a call of the session waits for its child's
// file: made within ListFor (by now), its file not read (also when it
// ended already: a short child between two polls).
func wantList(f *facts, h *hookFacts, now time.Time) bool {
	for _, k := range pair(f, h) {
		if k.tool == "" || f.files[k.agent] != nil || f.gone[k.agent] || teammate(f, h, k) {
			continue
		}
		d := f.dispatch[k.tool]
		if d == nil || d.ts == 0 || now.UnixMilli()-d.ts < ListFor.Milliseconds() {
			return true
		}
	}
	return false
}
