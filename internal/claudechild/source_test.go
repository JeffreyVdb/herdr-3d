package claudechild

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents/childagentstest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// The fixtures in testdata/<case> are real Claude Code 2.1.302 recordings
// (testdata/README.md): the parent's records of the spawn, each child's
// transcript (trimmed) and its final meta file.

// cases are the fixtures' root sessions.
var cases = map[string]string{
	"a": "f41bf49f-1bb1-4510-8e0a-338094e2a6ba", "b": "bc8c5901-8ee0-4a6d-b05d-834ae9dfc88f",
	"c": "a9bfd339-1eba-4ab4-8fb6-00193e2e3915", "d": "9a1ba95d-8c02-49f5-a68d-a5d85dd6c47b",
	"e": "ef90ce79-0e17-4ce3-9cb6-8083169e2635", "f": "7697b132-4098-4729-9d47-e377057cf505",
	"g2": "8a46bd85-bdda-4454-92f6-c16067c96d28",
}

// fixture is a case's files: the parent's lines, each child's lines and
// final meta.
type fixture struct {
	parent []string
	child  map[string][]string
	meta   map[string]map[string]any
}

func load(t *testing.T, name string) fixture {
	t.Helper()
	dir := filepath.Join("testdata", name)
	fx := fixture{child: map[string][]string{}, meta: map[string]map[string]any{}}
	paths, _ := filepath.Glob(filepath.Join(dir, "*"))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		base := filepath.Base(p)
		switch {
		case strings.HasPrefix(base, "parent-"):
			fx.parent = lines(b)
		case strings.HasSuffix(base, ".meta.json"):
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			fx.meta[strings.TrimSuffix(strings.TrimPrefix(base, "agent-"), ".meta.json")] = m
		case strings.HasSuffix(base, ".jsonl"):
			fx.child[strings.TrimSuffix(strings.TrimPrefix(base, "agent-"), ".jsonl")] = lines(b)
		}
	}
	return fx
}

func lines(b []byte) []string {
	return strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
}

// rig is one worker's root session: its files on disk, read by a
// usage.Session whose children go to a Source, whose evidence goes to a
// registry (worker "w").
type rig struct {
	t       *testing.T
	dir     string // <projects>/<project>
	session string
	src     *Source
	sess    *usage.Session
	l       *Listener
	reg     *childagents.Registry
	evs     []childagents.Evidence
	now     time.Time
	hooks   string
	hl      *hookLog
}

// starts are the bridge's clock at each case's start: a second before its
// first call.
var starts = map[string]time.Time{
	"a": when("2026-10-17T20:43:34Z"), "b": when("2026-10-17T20:47:37Z"), "c": when("2026-10-17T20:47:37Z"),
	"d": when("2026-10-17T20:44:25Z"), "e": when("2026-10-17T20:50:44Z"), "f": when("2026-10-17T20:47:37Z"),
	"g2": when("2026-10-17T20:49:01Z"),
}

// newRig is a rig of a case's root session.
func newRig(t *testing.T, name string) *rig {
	t.Helper()
	root := t.TempDir()
	session := cases[name]
	r := &rig{t: t, dir: filepath.Join(root, "-proj"), session: session, now: starts[name], hooks: filepath.Join(root, "hooks.jsonl")}
	if err := os.MkdirAll(filepath.Join(r.dir, session, "subagents"), 0o755); err != nil {
		t.Fatal(err)
	}
	r.start(root)
	return r
}

// start makes a fresh bridge's reading: a new source, session and
// registry (a restart).
func (r *rig) start(root string) {
	r.src = New(Options{HookLog: r.hooks, Now: func() time.Time { return r.now }})
	r.sess = usage.NewSession(usage.Claude, r.session, usage.Roots{ClaudeProjects: root}, usage.DefaultPricing())
	r.l = r.src.Listener(r.session)
	r.sess.SetChildren(r.l)
	r.reg = childagents.New()
	r.reg.Worker("w", r.session)
	r.evs, r.hl = nil, nil
}

func (r *rig) path(name string) string { return filepath.Join(r.dir, r.session, "subagents", name) }

func (r *rig) main(ls ...string) { appendLines(r.t, filepath.Join(r.dir, r.session+".jsonl"), ls...) }

func (r *rig) child(id string, ls ...string) { appendLines(r.t, r.path("agent-"+id+".jsonl"), ls...) }

// meta writes a child's meta file (finished as asked) written at mtime.
func (r *rig) meta(id string, m map[string]any, finished bool, mtime time.Time) {
	r.t.Helper()
	m = cloneMap(m)
	if finished {
		m["finished"] = true
	} else {
		delete(m, "finished")
	}
	b, _ := json.Marshal(m)
	p := r.path("agent-" + id + ".meta.json")
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		r.t.Fatal(err)
	}
	if err := os.Chtimes(tmp, mtime, mtime); err != nil {
		r.t.Fatal(err)
	}
	if err := os.Rename(tmp, p); err != nil { // as Claude Code does
		r.t.Fatal(err)
	}
}

func cloneMap(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

// hook appends hook input lines to the hook log.
func (r *rig) hook(ls ...string) { appendLines(r.t, r.hooks, ls...) }

func appendLines(t *testing.T, path string, ls ...string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, l := range ls {
		if _, err := f.WriteString(l + "\n"); err != nil {
			t.Fatal(err)
		}
	}
}

// poll is one round of the tracker 2 s later, the hook log read, and the
// evidence applied.
func (r *rig) poll() {
	r.t.Helper()
	r.now = r.now.Add(2 * time.Second)
	r.sess.Poll(r.now)
	r.readHooks()
	r.apply()
}

// readHooks reads the hook log as Run does.
func (r *rig) readHooks() {
	if r.hl == nil {
		r.hl = &hookLog{path: r.hooks, max: DefaultMaxHookLog, log: r.src.opts.Log}
		r.hl.start(r.src.hookLine)
	} else {
		r.hl.read(r.src.hookLine)
	}
	r.src.flushHooks(r.hl)
}

func (r *rig) apply() {
	r.t.Helper()
	for _, e := range r.src.take() {
		r.evs = append(r.evs, e)
		if _, err := r.reg.Apply(e); err != nil {
			r.t.Fatalf("evidence %+v dropped: %v", e, err)
		}
	}
}

// rows is the worker's children now.
func (r *rig) rows() []proto.Child { return r.reg.Children("w") }

// one is the only child, which must have the native id ("": none yet).
func (r *rig) one(native string) proto.Child {
	r.t.Helper()
	cs := r.rows()
	if len(cs) != 1 {
		r.t.Fatalf("%d rows, want 1: %+v", len(cs), cs)
	}
	c := cs[0]
	if c.NativeID != native {
		r.t.Fatalf("native id %q, want %q (%+v)", c.NativeID, native, c)
	}
	return c
}

// noRemovals checks the evidence removed no row (a merge or a flicker).
func (r *rig) noRemovals() {
	r.t.Helper()
	for _, e := range r.evs {
		if e.Removed {
			r.t.Fatalf("a row was removed: %+v", e)
		}
	}
}

func ts(s string) int64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

func when(s string) time.Time { return time.UnixMilli(ts(s)) }

// A foreground child shows from its call on (pending, its file not
// written), gets its native id from its meta's toolUseId while it runs (the
// same row), and completes with its call's result; never two rows.
func TestForegroundVisibleBeforeResult(t *testing.T) {
	fx := load(t, "a")
	const agent = "a8db619749ca642d6"
	r := newRig(t, "a")
	r.main(fx.parent[0]) // the Agent tool_use
	r.poll()
	c := r.one("")
	if c.State != proto.ChildRunning || c.Transcript != proto.TranscriptPending || c.Parent != proto.ParentRoot ||
		c.Type != "general-purpose" || c.Description != "sleeper" || c.StartedAt != ts("2026-10-17T20:43:35.065Z") {
		t.Fatalf("provisional row = %+v", c)
	}
	id := c.ID
	r.child(agent, fx.child[agent][:6]...)
	r.poll() // its file, no meta yet: held for its pairing, the one row stays
	if c := r.one(""); c.ID != id {
		t.Fatalf("row %+v", c)
	}
	r.meta(agent, fx.meta[agent], false, when("2026-10-17T20:43:35.150Z"))
	r.poll()
	c = r.one(agent)
	if c.ID != id || c.State != proto.ChildRunning || c.Transcript != proto.TranscriptAvailable || c.EndedAt != 0 {
		t.Fatalf("paired row = %+v", c)
	}
	r.child(agent, fx.child[agent][6:]...)
	r.meta(agent, fx.meta[agent], true, when("2026-10-17T20:43:56.740Z"))
	r.main(fx.parent[1:]...) // the result
	r.poll()
	c = r.one(agent)
	if c.ID != id || c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-17T20:43:56.796Z") || c.Source != proto.ChildFromTranscript {
		t.Fatalf("completed row = %+v", c)
	}
	r.noRemovals()
}

// A background child is paired by its launch result (async_launched with
// its agentId) before its file is even read, runs while the root idles, and
// completes with its task notification.
func TestBackgroundAndParentIdle(t *testing.T) {
	fx := load(t, "b")
	const agent = "a4a204a6a6e12e123"
	r := newRig(t, "b")
	r.main(fx.parent[:2]...) // tool_use, async_launched
	r.poll()
	c := r.one(agent)
	if c.State != proto.ChildRunning || c.Transcript != proto.TranscriptPending {
		t.Fatalf("launched = %+v", c)
	}
	r.child(agent, fx.child[agent][:10]...)
	r.meta(agent, fx.meta[agent], false, when("2026-10-17T20:47:38.400Z"))
	// The root's turn ends (it idles, its own Stop): nothing of the child's.
	r.main(`{"type":"assistant","timestamp":"2026-10-17T20:47:40.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Launched; waiting."}]}}`,
		`{"type":"system","subtype":"turn_duration","timestamp":"2026-10-17T20:47:40.100Z"}`)
	for range 5 {
		r.poll() // quiet logs
	}
	if c = r.one(agent); c.State != proto.ChildRunning || c.Transcript != proto.TranscriptAvailable {
		t.Fatalf("while the root idles = %+v", c)
	}
	r.child(agent, fx.child[agent][10:]...)
	r.main(fx.parent[2:]...) // the notification (queue-operation, then the user record)
	r.poll()
	if c = r.one(agent); c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-17T20:48:00.443Z") {
		t.Fatalf("notified = %+v", c)
	}
	r.noRemovals()
}

// Two children of one API message: each has its own row with its own
// agentId, from the metas' toolUseId, whatever order their files and metas
// come in; their files seen before their metas are held, never paired by
// order.
func TestTwoConcurrentChildren(t *testing.T) {
	fx := load(t, "c")
	const a, b = "a6196010ca5e24db3", "a0636606b1c718610"
	r := newRig(t, "c")
	// Both calls, without their launch results (as an older Claude that
	// writes the result late): only the metas can pair them.
	for _, l := range fx.parent {
		if strings.Contains(l, `"tool_use"`) {
			r.main(l)
		}
	}
	r.child(b, fx.child[b][:4]...) // B's file first
	r.child(a, fx.child[a][:4]...)
	r.poll()
	if cs := r.rows(); len(cs) != 2 || cs[0].NativeID != "" || cs[1].NativeID != "" {
		t.Fatalf("held: %+v", cs)
	}
	r.meta(b, fx.meta[b], false, when("2026-10-17T20:47:39.000Z"))
	r.poll()
	r.meta(a, fx.meta[a], false, when("2026-10-17T20:47:39.000Z"))
	r.poll()
	byDesc := map[string]string{}
	for _, c := range r.rows() {
		byDesc[c.Description] = c.NativeID
	}
	if len(r.rows()) != 2 || byDesc["conc-A"] != a || byDesc["conc-B"] != b {
		t.Fatalf("rows = %+v", r.rows())
	}
	r.main(fx.parent...) // the rest: launches (pairing again, the same) and notifications
	r.child(a, fx.child[a][4:]...)
	r.child(b, fx.child[b][4:]...)
	r.poll()
	for _, c := range r.rows() {
		if c.State != proto.ChildCompleted {
			t.Fatalf("not completed: %+v", c)
		}
	}
	if len(r.rows()) != 2 {
		t.Fatalf("rows = %+v", r.rows())
	}
	r.noRemovals()
}

// A child's child: its call is in its parent child's transcript, its meta
// names the parent (parentAgentId); it is shown under that child.
func TestNestedParentage(t *testing.T) {
	fx := load(t, "d")
	const outer, inner = "a4a99f3dcfd712264", "a06132324656db894"
	r := newRig(t, "d")
	r.main(fx.parent[0])
	r.child(outer, fx.child[outer]...)
	r.meta(outer, fx.meta[outer], false, when("2026-10-17T20:44:26.900Z"))
	r.child(inner, fx.child[inner][:5]...)
	r.poll()
	r.meta(inner, fx.meta[inner], false, when("2026-10-17T20:44:28.600Z"))
	r.poll()
	tree := childagentstest.Tree(r.rows())
	if len(tree) != 1 || tree[0].NativeID != outer || len(tree[0].Children) != 1 || tree[0].Children[0].NativeID != inner ||
		tree[0].Children[0].Parent != proto.ParentChild || tree[0].Children[0].Description != "inner" {
		t.Fatalf("tree = %+v", tree)
	}
	r.child(inner, fx.child[inner][5:]...)
	r.meta(inner, fx.meta[inner], true, when("2026-10-17T20:44:40.900Z"))
	r.meta(outer, fx.meta[outer], true, when("2026-10-17T20:44:41.800Z"))
	r.main(fx.parent[1:]...)
	r.poll()
	for _, c := range r.rows() {
		if c.State != proto.ChildCompleted {
			t.Fatalf("not completed: %+v", c)
		}
	}
	r.noRemovals()
}

// A depth-2 child no evidence links (its parent's call not read, no meta)
// stays unresolved: it shows, under no guessed parent.
func TestNestedWithoutEvidenceUnresolved(t *testing.T) {
	fx := load(t, "d")
	const outer, inner = "a4a99f3dcfd712264", "a06132324656db894"
	r := newRig(t, "d")
	r.main(fx.parent[0])
	r.child(outer, fx.child[outer][:3]...) // not as far as the inner call
	r.meta(outer, fx.meta[outer], false, when("2026-10-17T20:44:26.900Z"))
	r.child(inner, fx.child[inner][:5]...)
	for range 4 {
		r.poll() // past HoldUnpaired
	}
	var got proto.Child
	for _, c := range r.rows() {
		if c.NativeID == inner {
			got = c
		}
	}
	if got.ID == "" || got.Parent != proto.ParentUnresolved || got.State != proto.ChildRunning {
		t.Fatalf("inner = %+v (rows %+v)", got, r.rows())
	}
}

// An interrupt: the parent's call is rejected, the child is interrupted;
// the child's own interruption marker after it is no resume.
func TestInterrupted(t *testing.T) {
	fx := load(t, "e")
	const agent = "a2b5d93218f6be8b1"
	r := newRig(t, "e")
	r.main(fx.parent[0])
	r.child(agent, fx.child[agent]...)
	r.meta(agent, fx.meta[agent], false, when("2026-10-17T20:50:45.700Z"))
	r.poll()
	r.main(fx.parent[1:]...)
	r.child(agent, `{"type":"user","isSidechain":true,"agentId":"a2b5d93218f6be8b1","sessionId":"ef90ce79-0e17-4ce3-9cb6-8083169e2635","timestamp":"2026-10-17T20:50:53.917Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}`,
		// A meta record of no origin (a reminder) sets it to no work either.
		`{"type":"user","isMeta":true,"isSidechain":true,"agentId":"a2b5d93218f6be8b1","sessionId":"ef90ce79-0e17-4ce3-9cb6-8083169e2635","timestamp":"2026-10-17T20:50:54.000Z","message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}`)
	r.poll()
	c := r.one(agent)
	if c.State != proto.ChildInterrupted || c.EndedAt != ts("2026-10-17T20:50:53.914Z") || c.Transcript != proto.TranscriptAvailable {
		t.Fatalf("interrupted = %+v", c)
	}
	r.noRemovals()
}

// A fork's file copies its parent's spawning call and its result: no new
// call, and the copied result does not complete the fork.
func TestForkCopiedCallIsNoSpawn(t *testing.T) {
	fx := load(t, "f")
	const agent = "a87b102338484508a"
	r := newRig(t, "f")
	r.main(fx.parent[0])
	r.child(agent, fx.child[agent][:6]...)
	r.meta(agent, fx.meta[agent], false, when("2026-10-17T20:47:38.450Z"))
	r.poll()
	c := r.one(agent)
	if c.State != proto.ChildRunning || c.Type != "fork" || c.Parent != proto.ParentRoot {
		t.Fatalf("fork = %+v", c)
	}
	r.child(agent, fx.child[agent][6:]...)
	r.meta(agent, fx.meta[agent], true, when("2026-10-17T20:48:00.800Z"))
	r.main(fx.parent[1:]...)
	r.poll()
	if c = r.one(agent); c.State != proto.ChildCompleted {
		t.Fatalf("fork = %+v", c)
	}
	r.noRemovals()
}

// Run in the background by default (run_in_background omitted).
func TestDefaultBackground(t *testing.T) {
	fx := load(t, "g2")
	const agent = "aac67dcb2641fda81"
	r := newRig(t, "g2")
	r.main(fx.parent[:2]...)
	r.poll()
	if c := r.one(agent); c.State != proto.ChildRunning {
		t.Fatalf("launched = %+v", c)
	}
	r.child(agent, fx.child[agent]...)
	r.meta(agent, fx.meta[agent], true, when("2026-10-17T20:49:24.450Z"))
	r.main(fx.parent[2:]...)
	r.poll()
	if c := r.one(agent); c.State != proto.ChildCompleted {
		t.Fatalf("done = %+v", c)
	}
}

// Resumed (SendMessage to a finished child): the same agentId at work
// again is the same row, running, its end cleared; done again, completed.
// A Stop hook's feedback while it works is no new end, and a SubagentStop
// hook (stop_hook_active) never completes it.
func TestResumeAndStopHookContinuation(t *testing.T) {
	fx := load(t, "a")
	const agent = "a8db619749ca642d6"
	r := newRig(t, "a")
	r.main(fx.parent...)
	r.child(agent, fx.child[agent]...)
	r.meta(agent, fx.meta[agent], true, when("2026-10-17T20:43:56.740Z"))
	r.poll()
	c := r.one(agent)
	if c.State != proto.ChildCompleted {
		t.Fatalf("done = %+v", c)
	}
	id := c.ID
	r.child(agent, `{"parentUuid":"d21d81f2-fc8d-475b-aafd-bf7b116f262a","isSidechain":true,"promptId":"092985fe-ae35-468a-bfc1-12232b050eb0","agentId":"a8db619749ca642d6","type":"user","message":{"role":"user","content":"The coordinator sent a message while you were working:\nCount again.\n\nAddress this before completing your current task."},"isMeta":true,"uuid":"d06950e7-5332-4bd7-8105-1e827ffa6b79","timestamp":"2026-10-17T20:44:10.000Z","origin":{"kind":"coordinator"},"userType":"external","entrypoint":"cli","sessionId":"f41bf49f-1bb1-4510-8e0a-338094e2a6ba","version":"2.1.302","gitBranch":"HEAD"}`,
		`{"type":"assistant","isSidechain":true,"agentId":"a8db619749ca642d6","sessionId":"f41bf49f-1bb1-4510-8e0a-338094e2a6ba","timestamp":"2026-10-17T20:44:11.000Z","message":{"role":"assistant","content":[{"type":"text","text":"2"}]}}`)
	r.hook(`{"session_id":"f41bf49f-1bb1-4510-8e0a-338094e2a6ba","agent_id":"a8db619749ca642d6","agent_type":"general-purpose","hook_event_name":"SubagentStart"}`)
	r.poll()
	c = r.one(agent)
	if c.ID != id || c.State != proto.ChildRunning || c.EndedAt != 0 {
		t.Fatalf("resumed = %+v", c)
	}
	// A Stop hook blocks its stop: it goes on working.
	r.hook(`{"session_id":"f41bf49f-1bb1-4510-8e0a-338094e2a6ba","agent_id":"a8db619749ca642d6","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":false}`)
	r.child(agent, `{"type":"user","isSidechain":true,"agentId":"a8db619749ca642d6","sessionId":"f41bf49f-1bb1-4510-8e0a-338094e2a6ba","timestamp":"2026-10-17T20:44:12.000Z","message":{"role":"user","content":"Stop hook feedback: Before you finish, also reply with the word twice."}}`)
	r.hook(`{"session_id":"f41bf49f-1bb1-4510-8e0a-338094e2a6ba","agent_id":"a8db619749ca642d6","agent_type":"general-purpose","hook_event_name":"SubagentStop","stop_hook_active":true}`)
	r.poll()
	if c = r.one(agent); c.State != proto.ChildRunning {
		t.Fatalf("continued = %+v", c)
	}
	r.meta(agent, fx.meta[agent], true, when("2026-10-17T20:44:13.000Z"))
	r.poll()
	if c = r.one(agent); c.ID != id || c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-17T20:44:13.000Z") {
		t.Fatalf("done again = %+v", c)
	}
	r.noRemovals()
}

// The hooks' evidence and the transcripts' make one row per child: the
// call is shown from PreToolUse before its transcript line is read, then
// paired by PostToolUse; with the transcripts too, nothing doubles, and the
// tree is the transcripts-only one.
func TestHooksAndTranscriptsReconcile(t *testing.T) {
	fx := load(t, "c")
	const a, b = "a6196010ca5e24db3", "a0636606b1c718610"
	const s = "a9bfd339-1eba-4ab4-8fb6-00193e2e3915"
	pre := func(tool, desc string) string {
		return `{"session_id":"` + s + `","hook_event_name":"PreToolUse","tool_name":"Agent","tool_use_id":"` + tool +
			`","tool_input":{"description":"` + desc + `","subagent_type":"general-purpose","run_in_background":true}}`
	}
	post := func(tool, agent string) string {
		return `{"session_id":"` + s + `","hook_event_name":"PostToolUse","tool_name":"Agent","tool_use_id":"` + tool +
			`","tool_response":{"status":"async_launched","agentId":"` + agent + `"}}`
	}
	start := func(agent string) string {
		return `{"session_id":"` + s + `","agent_id":"` + agent + `","agent_type":"general-purpose","hook_event_name":"SubagentStart"}`
	}
	r := newRig(t, "c")
	r.main(`{"type":"permission-mode","permissionMode":"bypassPermissions"}`) // the session's file, before its first call
	r.hook(pre("toolu_01R9eYspZkcg4T7NU12oA7fa", "conc-A"), start(a), pre("toolu_01HvjY3HUbwAE2aHWybYXa4H", "conc-B"), start(b))
	r.poll()
	cs := r.rows()
	if len(cs) != 2 || cs[0].Source != proto.ChildFromHook || cs[0].NativeID != "" || cs[0].Transcript != proto.TranscriptPending {
		t.Fatalf("from the hooks: %+v", cs)
	}
	r.hook(post("toolu_01R9eYspZkcg4T7NU12oA7fa", a), post("toolu_01HvjY3HUbwAE2aHWybYXa4H", b),
		`not json`, `{"session_id":"`+s+`","hook_event_name":"SubagentStop","agent_id":"x1","agent_type":""}`) // a torn line, a helper
	r.main(fx.parent...)
	r.child(a, fx.child[a]...)
	r.child(b, fx.child[b]...)
	r.meta(a, fx.meta[a], true, when("2026-10-17T20:48:00.400Z"))
	r.meta(b, fx.meta[b], true, when("2026-10-17T20:48:00.600Z"))
	r.poll()
	withHooks := childagentstest.Tree(r.rows())
	r.noRemovals()

	jr := newRig(t, "c")
	jr.main(fx.parent...)
	jr.child(a, fx.child[a]...)
	jr.child(b, fx.child[b]...)
	jr.meta(a, fx.meta[a], true, when("2026-10-17T20:48:00.400Z"))
	jr.meta(b, fx.meta[b], true, when("2026-10-17T20:48:00.600Z"))
	jr.poll()
	jsonlOnly := childagentstest.Tree(jr.rows())
	if len(jsonlOnly) != 2 || !slices.EqualFunc(withHooks, jsonlOnly, nodeEq) {
		t.Fatalf("with hooks %+v\njsonl only %+v", withHooks, jsonlOnly)
	}
}

func nodeEq(a, b childagentstest.Node) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// A bridge restart rebuilds the same tree from the files alone, and a
// Replay sends a bound session's children again.
func TestRestartAndReplay(t *testing.T) {
	fx := load(t, "d")
	const outer, inner = "a4a99f3dcfd712264", "a06132324656db894"
	r := newRig(t, "d")
	r.main(fx.parent...)
	r.child(outer, fx.child[outer]...)
	r.child(inner, fx.child[inner]...)
	r.meta(outer, fx.meta[outer], true, when("2026-10-17T20:44:41.800Z"))
	r.meta(inner, fx.meta[inner], true, when("2026-10-17T20:44:40.900Z"))
	r.poll()
	before := childagentstest.Tree(r.rows())
	ids := slices.Collect(func(yield func(string) bool) {
		for _, c := range r.rows() {
			if !yield(c.ID) {
				return
			}
		}
	})

	r.start(filepath.Dir(r.dir)) // restart: nothing kept
	r.poll()
	after := childagentstest.Tree(r.rows())
	if !slices.EqualFunc(before, after, nodeEq) || len(after) != 1 || len(after[0].Children) != 1 {
		t.Fatalf("before %+v\nafter %+v", before, after)
	}
	for i, c := range r.rows() {
		if c.ID != ids[i] {
			t.Fatalf("row ids changed: %v → %+v", ids, r.rows())
		}
	}

	// A session bound again (a worker that let it go): Replay sends it all.
	reg := childagents.New()
	reg.Worker("w2", r.session)
	r.src.Replay(r.session)
	for _, e := range r.src.take() {
		if _, err := reg.Apply(e); err != nil {
			t.Fatal(err)
		}
	}
	if replayed := childagentstest.Tree(reg.Children("w2")); !slices.EqualFunc(before, replayed, nodeEq) {
		t.Fatalf("replayed %+v", replayed)
	}
}

// A child's transcript cleaned up removes its row; a call whose file is
// not written yet is pending, never another child's.
func TestFileGoneAndPending(t *testing.T) {
	fx := load(t, "b")
	const agent = "a4a204a6a6e12e123"
	r := newRig(t, "b")
	r.main(fx.parent[0])
	r.poll()
	if c := r.one(""); c.Transcript != proto.TranscriptPending {
		t.Fatalf("pending = %+v", c)
	}
	r.main(fx.parent[1])
	r.child(agent, fx.child[agent]...)
	r.poll()
	if c := r.one(agent); c.Transcript != proto.TranscriptAvailable {
		t.Fatalf("available = %+v", c)
	}
	if err := os.Remove(r.path("agent-" + agent + ".jsonl")); err != nil {
		t.Fatal(err)
	}
	r.poll()
	if cs := r.rows(); len(cs) != 0 {
		t.Fatalf("after cleanup: %+v", cs)
	}
}

// A running foreground child cleaned up before its result, when its meta
// was the only pairing: its row goes (not left running under the call), and
// its file back (found at the next listing: a call whose file went waits
// for none) is the same one row.
func TestForegroundGoneBeforeResult(t *testing.T) {
	fx := load(t, "a")
	const agent = "a8db619749ca642d6"
	r := newRig(t, "a")
	r.main(fx.parent[0])
	r.child(agent, fx.child[agent][:6]...)
	r.meta(agent, fx.meta[agent], false, when("2026-10-17T20:43:35.150Z"))
	r.poll()
	r.one(agent)
	if err := os.Remove(r.path("agent-" + agent + ".jsonl")); err != nil {
		t.Fatal(err)
	}
	r.poll()
	if cs := r.rows(); len(cs) != 0 {
		t.Fatalf("after cleanup rows = %+v; evidence = %+v", cs, r.evs)
	}
	r.child(agent, fx.child[agent][:6]...)
	for range usage.SubagentRescan / (2 * time.Second) {
		r.poll()
	}
	if c := r.one(agent); c.State != proto.ChildRunning {
		t.Fatalf("back = %+v", c)
	}
}

// A child cleaned up whose pairing came from a hook (PostToolUse) only:
// its row goes too.
func TestGoneHookPaired(t *testing.T) {
	fx := load(t, "b")
	const agent, tool = "a4a204a6a6e12e123", "toolu_01N8bHkC24nZx7es3qSngiL4"
	r := newRig(t, "b")
	r.main(fx.parent[0])
	r.hook(`{"session_id":"` + r.session + `","hook_event_name":"PostToolUse","tool_name":"Agent","tool_use_id":"` + tool +
		`","tool_response":{"status":"async_launched","agentId":"` + agent + `"}}`)
	r.child(agent, fx.child[agent][:6]...)
	r.poll()
	if c := r.one(agent); c.Transcript != proto.TranscriptAvailable {
		t.Fatalf("row = %+v", c)
	}
	if err := os.Remove(r.path("agent-" + agent + ".jsonl")); err != nil {
		t.Fatal(err)
	}
	r.poll()
	if cs := r.rows(); len(cs) != 0 {
		t.Fatalf("after cleanup: %+v", cs)
	}
}

// A child file whose records name another session or agent is not this
// session's: nothing in it counts (its own row, a call in it, a result or
// a notification in it).
func TestForeignChildFileIgnored(t *testing.T) {
	const call = `"message":{"content":[{"type":"tool_use","id":"toolu_foreign","name":"Agent","input":{"description":"foreign nested child","subagent_type":"general-purpose"}}]}`
	for name, ls := range map[string][]string{
		"session": {`{"type":"assistant","sessionId":"another-session","agentId":"a111","timestamp":"2026-10-17T20:47:38Z",` + call + `}`},
		"agent":   {`{"type":"assistant","sessionId":"` + cases["b"] + `","agentId":"a222","timestamp":"2026-10-17T20:47:38Z",` + call + `}`},
		// A fork's first line names its agent only; the next names the session.
		"fork": {`{"type":"fork-context-ref","agentId":"a111"}`,
			`{"type":"assistant","sessionId":"another-session","agentId":"a111","timestamp":"2026-10-17T20:47:38Z",` + call + `}`},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, "b")
			r.main(`{"type":"permission-mode","permissionMode":"bypassPermissions"}`)
			r.child("a111", ls...)
			r.poll()
			r.poll()
			r.poll()
			r.poll()
			if cs := r.rows(); len(cs) != 0 {
				t.Fatalf("rows = %+v", cs)
			}
		})
	}
	t.Run("derive", func(t *testing.T) {
		f := newFacts()
		f.childLine("right-session", "a111", []byte(`{"type":"assistant","sessionId":"wrong-session","agentId":"a111","timestamp":"2026-10-17T20:43:35Z",`+call+`}`))
		if out := derive("right-session", f, newHookFacts(), time.Now()); len(out) != 0 {
			t.Fatalf("evidence = %+v", out)
		}
	})
	// Its notification of this session's running child ends nothing.
	t.Run("notification", func(t *testing.T) {
		fx := load(t, "b")
		const agent = "a4a204a6a6e12e123"
		r := newRig(t, "b")
		r.main(fx.parent[:2]...)
		r.child(agent, fx.child[agent][:6]...)
		r.child("a111", strings.Replace(fx.parent[3], `"sessionId":"`+cases["b"]+`"`, `"sessionId":"another-session"`, 1))
		r.poll()
		if c := r.one(agent); c.State != proto.ChildRunning {
			t.Fatalf("row = %+v", c)
		}
	})
}

// A file whose records name this session but no agent, until one names
// another agent, is foreign from the start: what it showed before is
// retracted. One naming this agent then is this child's, the call kept.
func TestForeignChildFileFoundLate(t *testing.T) {
	const (
		call   = `{"type":"assistant","sessionId":"right-session","timestamp":"2026-10-17T20:43:35Z","message":{"content":[{"type":"tool_use","id":"toolu_delayed","name":"Agent","input":{}}]}}`
		result = `{"type":"user","sessionId":"right-session","timestamp":"2026-10-17T20:43:40Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_delayed","content":"done"}]},"toolUseResult":{"status":"completed","agentId":"a333"}}`
	)
	named := func(agent string) string {
		return `{"type":"user","sessionId":"right-session","agentId":"` + agent + `","message":{"content":"hello"}}`
	}
	for name, ls := range map[string][]string{
		"call":   {call, named("a222")},
		"result": {call, result, named("a222")},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFacts()
			for _, l := range ls {
				f.childLine("right-session", "a111", []byte(l))
			}
			if out := derive("right-session", f, newHookFacts(), time.Now()); len(out) != 0 {
				t.Fatalf("evidence = %+v", out)
			}
			if len(f.dispatch)+len(f.results)+len(f.pairs) != 0 {
				t.Fatalf("kept: %v %v %v", f.dispatch, f.results, f.pairs)
			}
		})
	}
	t.Run("legit", func(t *testing.T) {
		f := newFacts()
		f.childLine("right-session", "a111", []byte(call))
		f.childLine("right-session", "a111", []byte(named("a111")))
		// The file's own row is held this poll (its pairing may be on its way).
		out := derive("right-session", f, newHookFacts(), time.Now())
		if len(out) != 1 || out[0].DispatchID != "toolu_delayed" || out[0].Parent.NativeID != "a111" {
			t.Fatalf("evidence = %+v", out)
		}
	})
	// Its notification of this session's running child ends nothing.
	t.Run("notification", func(t *testing.T) {
		fx := load(t, "b")
		const agent = "a4a204a6a6e12e123"
		r := newRig(t, "b")
		r.main(fx.parent[:2]...)
		r.child(agent, fx.child[agent][:6]...)
		r.child("a111", fx.parent[3], `{"type":"user","sessionId":"`+cases["b"]+`","agentId":"a222","message":{"content":"hello"}}`)
		r.poll()
		if c := r.one(agent); c.State != proto.ChildRunning {
			t.Fatalf("row = %+v", c)
		}
	})
}

// An agent-team teammate's spawn (team_name) is no subagent row, and
// neither is an internal helper only a hook shows.
func TestTeammateAndHelperNoRows(t *testing.T) {
	r := newRig(t, "a")
	r.main(`{"type":"assistant","timestamp":"2026-10-17T20:43:35.065Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_team1","name":"Agent","input":{"description":"reviewer","subagent_type":"general-purpose","name":"rev","team_name":"t1","prompt":"x"}}]}}`)
	r.hook(`{"session_id":"`+cases["a"]+`","agent_id":"ahelper1","agent_type":"","hook_event_name":"SubagentStart"}`,
		`{"session_id":"`+cases["a"]+`","agent_id":"ahelper1","agent_type":"","hook_event_name":"SubagentStop","stop_hook_active":false}`)
	r.poll()
	if cs := r.rows(); len(cs) != 0 {
		t.Fatalf("rows = %+v", cs)
	}
}

// Tolerant reading: a partial last line waits, a line that does not parse
// and a meta of the wrong types are skipped, a replaced transcript is read
// again without a second row.
func TestTolerantReading(t *testing.T) {
	fx := load(t, "a")
	const agent = "a8db619749ca642d6"
	r := newRig(t, "a")
	half := len(fx.parent[0]) / 2
	appendRaw(t, filepath.Join(r.dir, r.session+".jsonl"), "{broken\n"+fx.parent[0][:half])
	r.poll()
	if cs := r.rows(); len(cs) != 0 {
		t.Fatalf("partial line: %+v", cs)
	}
	appendRaw(t, filepath.Join(r.dir, r.session+".jsonl"), fx.parent[0][half:]+"\n")
	r.child(agent, fx.child[agent][:3]...)
	appendRaw(t, r.path("agent-"+agent+".meta.json"), `{"agentType":7,"toolUseId":"toolu_015sQxegDivBtkxbTPKcRffk","spawnDepth":"one"}`)
	r.poll()
	c := r.one(agent)
	if c.Type != "general-purpose" || c.Parent != proto.ParentRoot {
		t.Fatalf("row = %+v", c)
	}
	// Replaced (rewritten shorter): read again from the start, the same row.
	if err := os.WriteFile(filepath.Join(r.dir, r.session+".jsonl"), []byte(fx.parent[0]+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.child(agent, fx.child[agent][3:5]...)
	r.poll()
	if c2 := r.one(agent); c2.ID != c.ID {
		t.Fatalf("after replacement %+v", c2)
	}
	r.noRemovals()
}

func appendRaw(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}

// Two workers claiming one session read it twice: the first reader's
// facts are the session's; when it closes, the other's take over at its
// next read, and no row goes meanwhile.
func TestSecondReaderTakesOver(t *testing.T) {
	fx := load(t, "b")
	const agent = "a4a204a6a6e12e123"
	r := newRig(t, "b")
	r.main(fx.parent...)
	r.child(agent, fx.child[agent]...)
	r.poll()
	second := usage.NewSession(usage.Claude, r.session, usage.Roots{ClaudeProjects: filepath.Dir(r.dir)}, usage.DefaultPricing())
	l2 := r.src.Listener(r.session)
	second.SetChildren(l2)
	r.l.Close()
	r.apply()
	second.Poll(r.now.Add(time.Second))
	r.apply()
	if c := r.one(agent); c.State != proto.ChildCompleted {
		t.Fatalf("row %+v", c)
	}
	r.noRemovals()
}
