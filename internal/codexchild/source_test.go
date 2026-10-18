package codexchild

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// The fixtures in testdata/<case> are real Codex rollouts (testdata/README.md):
// each case's root rollout and its children's, scrubbed.

// cases are the fixtures' root sessions.
var cases = map[string]string{
	"a": "01a14e28-bd2c-7e73-93d2-81ecf2153526", "b": "01a14e2b-473a-7321-8c9d-23f2c7973264",
	"c2": "01a14e2b-d7d0-7c01-8a79-2cb6ba62938e", "d": "01a14e2c-443a-7ed2-8ddc-fa7e07c5e551",
	"e": "01a14e30-98b9-7882-9fc9-2b6576e76199", "f-run": "01a14e31-1989-78d3-b7cd-f0ec0cf8be00",
	"f-run2": "01a14e31-77cf-7562-89a6-3966c43a2627", "f-run-v1b": "01a14e34-22ec-7022-aca1-c45b73f53039",
	"f-idle-v1b": "01a14e34-4bdf-7ff1-ac99-4bd71728f015", "g-a0160-v": "01a14e34-cd56-7403-bbbd-9fcbb638138f",
	"corpus-trap": "01a1411d-60ee-7ca0-91a1-88ef70dddaae", "corpus-guardian": "01a13fba-4edf-7880-a324-1d3b25197386",
}

// Child thread ids of the fixtures.
const (
	aChild      = "01a14e28-cb59-7ac3-b506-51c6edd1c63f"
	bA, bB      = "01a14e2b-57ca-7701-ab6c-a08e8a2ca5a0", "01a14e2b-5b85-7571-af1a-dc76570217e5"
	c2Outer     = "01a14e2b-e4bc-7472-8aac-009f651c0987"
	c2Inner     = "01a14e2b-ef35-7e53-adfb-e8adb97f831f"
	dChild      = "01a14e2c-51a5-7643-a15d-0e58fe75c036"
	eChild      = "01a14e30-a882-74a3-b22b-37ad4088e397"
	fRunChild   = "01a14e31-2737-7c82-8bc9-b943238bee56"
	fRun2Child  = "01a14e31-87cc-7000-9a0b-e7918b583344"
	v1RunChild  = "01a14e34-38ae-73f2-82db-03240f3900e0"
	v1IdleChild = "01a14e34-61f3-7c31-8c9d-3599e970f277"
	gChild      = "01a14e34-dd76-70a0-8531-cff13872d363"
	trapChild   = "01a14123-2203-7072-a869-f11c190d6c94"
	guardian    = "01a13fba-4eeb-7742-a414-4883dd60200c"
)

// fixture is a case's rollouts: each file's lines and name, by thread id.
type fixture struct {
	lines map[string][]string
	names map[string]string
}

func load(t *testing.T, name string) fixture {
	t.Helper()
	fx := fixture{lines: map[string][]string{}, names: map[string]string{}}
	paths, _ := filepath.Glob(filepath.Join("testdata", name, "rollout-*.jsonl"))
	if len(paths) == 0 {
		t.Fatalf("no fixture %q", name)
	}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		ls := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
		m, ok := codex.ParseMeta([]byte(ls[0]))
		if !ok {
			t.Fatalf("%s: no session_meta", p)
		}
		fx.lines[m.ID], fx.names[m.ID] = ls, filepath.Base(p)
	}
	return fx
}

// upTo is a file's lines before the first one at or past ordinal n.
func (fx fixture) upTo(thread string, n int64) []string {
	ls := fx.lines[thread]
	for i, l := range ls {
		var r record
		if json.Unmarshal([]byte(l), &r) == nil && r.Ordinal != nil && *r.Ordinal >= n {
			return ls[:i]
		}
	}
	return ls
}

// rig is one worker's root session: a case's rollouts on disk, read by a
// usage.Session whose children go to a Source, whose evidence goes to a
// registry (worker "w").
type rig struct {
	t       *testing.T
	root    string // the sessions directory
	session string
	fx      fixture
	written map[string]int // lines written, by thread
	src     *Source
	sess    *usage.Session
	l       *Listener
	reg     *childagents.Registry
	evs     []childagents.Evidence
	now     time.Time
}

func newRig(t *testing.T, name string) *rig {
	t.Helper()
	r := &rig{t: t, root: t.TempDir(), session: cases[name], fx: load(t, name), written: map[string]int{}}
	var first record // the bridge's clock: a second before the root's first record
	_ = json.Unmarshal([]byte(r.fx.lines[r.session][0]), &first)
	r.now = time.UnixMilli(stamp(first.Timestamp)).Add(-time.Second)
	r.start()
	return r
}

// start makes a fresh bridge's reading: a new source, session and
// registry (a restart).
func (r *rig) start() {
	r.src = New(Options{Now: func() time.Time { return r.now }})
	r.sess = usage.NewSession(usage.Codex, r.session, usage.Roots{CodexSessions: r.root}, usage.DefaultPricing())
	r.l = r.src.Listener(r.session)
	r.sess.SetChildren(r.l)
	r.reg = childagents.New()
	r.reg.Worker("w", r.session)
	r.evs = nil
}

// path is a thread's rollout under the sessions directory (its date
// directory from its name).
func (r *rig) path(thread string) string {
	name := r.fx.names[thread]
	day := strings.ReplaceAll(strings.TrimPrefix(name, "rollout-")[:10], "-", "/")
	return filepath.Join(r.root, filepath.FromSlash(day), name)
}

// write appends a thread's lines up to (not including) line n of its
// fixture (n < 0: all).
func (r *rig) write(thread string, n int) {
	r.t.Helper()
	ls := r.fx.lines[thread]
	if n < 0 || n > len(ls) {
		n = len(ls)
	}
	r.add(thread, ls[r.written[thread]:n]...)
	r.written[thread] = n
}

// add appends lines to a thread's rollout.
func (r *rig) add(thread string, ls ...string) {
	r.t.Helper()
	p := r.path(thread)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatal(err)
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		r.t.Fatal(err)
	}
	defer f.Close()
	for _, l := range ls {
		if _, err := f.WriteString(l + "\n"); err != nil {
			r.t.Fatal(err)
		}
	}
}

// writeUpTo writes a thread's lines before ordinal n.
func (r *rig) writeUpTo(thread string, n int64) { r.write(thread, len(r.fx.upTo(thread, n))) }

// all writes every file of the case.
func (r *rig) all() {
	for thread := range r.fx.lines {
		r.write(thread, -1)
	}
}

// poll is one round of the tracker 2 s later and the evidence applied.
func (r *rig) poll() {
	r.t.Helper()
	r.now = r.now.Add(2 * time.Second)
	r.sess.Poll(r.now)
	r.apply()
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

func (r *rig) rows() []proto.Child { return r.reg.Children("w") }

// row is the row of a native id.
func (r *rig) row(native string) proto.Child {
	r.t.Helper()
	for _, c := range r.rows() {
		if c.NativeID == native {
			return c
		}
	}
	r.t.Fatalf("no row of %s: %+v", native, r.rows())
	return proto.Child{}
}

// one is the only child, which must have the native id.
func (r *rig) one(native string) proto.Child {
	r.t.Helper()
	if cs := r.rows(); len(cs) != 1 {
		r.t.Fatalf("%d rows, want 1: %+v", len(cs), cs)
	}
	return r.row(native)
}

// dispatch is the dispatch id the evidence of a native id named.
func (r *rig) dispatch(native string) string {
	for _, e := range r.evs {
		if e.NativeID == native && e.DispatchID != "" {
			return e.DispatchID
		}
	}
	return ""
}

// noRemovals checks the evidence removed no row (a flicker).
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

// want is a child's row as a case's files show it whole.
type want struct {
	native, parent, parentID, name, desc, state, dispatch string
	ended                                                 int64
}

// Every case read whole: each child once, with the parent its first line
// names, the dispatch its spawner's record names, and the state its own
// turns and its spawner's activity records end in.
func TestCasesWhole(t *testing.T) {
	for name, wants := range map[string][]want{
		"a": {{aChild, proto.ParentRoot, "", "Rawls", "count_lines", proto.ChildCompleted, "call_547707ed56864c5aa116b31cb658edb3",
			ts("2026-10-18T08:37:42.437Z")}},
		"b": {
			{bA, proto.ParentRoot, "", "Hume", "count_a", proto.ChildCompleted, "call_3ee1246d4d324471aae519a3f3cb5bd6", ts("2026-10-18T08:40:28.839Z")},
			{bB, proto.ParentRoot, "", "Fermat", "count_b", proto.ChildCompleted, "call_c9b9f831318e4c76ade25bac227d8a4d", ts("2026-10-18T08:40:30.437Z")},
		},
		"c2": {
			{c2Outer, proto.ParentRoot, "", "Volta", "count_outer", proto.ChildCompleted, "call_b5287cdf95e44946b9c5712a85529ae3",
				ts("2026-10-18T08:41:08.608Z")},
			{c2Inner, proto.ParentChild, c2Outer, "Pasteur", "count_inner", proto.ChildCompleted, "call_7c5b817bb8284c4fb4900ab2ea195a11",
				ts("2026-10-18T08:41:07.895Z")},
		},
		"d": {{dChild, proto.ParentRoot, "", "Aquinas", "counter", proto.ChildCompleted, "call_ea41059e656b4a5cad99a1143b3ae487",
			ts("2026-10-18T08:41:36.186Z")}},
		"e": {{eChild, proto.ParentRoot, "", "Volta", "sleeper", proto.ChildInterrupted, "call_935221067dff49a787200a312ec485ec",
			ts("2026-10-18T08:46:19.338Z")}},
		"f-run": {{fRunChild, proto.ParentRoot, "", "Heisenberg", "sleeper", proto.ChildInterrupted, "call_e3ddd2ccbaaf4772ae1b7a806ae9841d",
			ts("2026-10-18T08:46:47.512Z")}},
		"f-run2": {{fRun2Child, proto.ParentRoot, "", "Averroes", "sleeper", proto.ChildInterrupted, "call_e11ec57e05894b2ca9de7adcff49751b",
			ts("2026-10-18T08:47:45.069Z")}},
		"f-run-v1b": {{v1RunChild, proto.ParentRoot, "", "Kuhn", "", proto.ChildShutDown, "exec-e0392fe9-20ec-4524-8100-8fa2af7f6c41",
			ts("2026-10-18T08:50:07.723Z")}},
		"f-idle-v1b": {{v1IdleChild, proto.ParentRoot, "", "Turing", "", proto.ChildShutDown, "exec-917b3be8-058c-4ce6-98fa-97aac52f6aea",
			ts("2026-10-18T08:50:24.715Z")}},
		"g-a0160-v": {{gChild, proto.ParentRoot, "", "Planck", "count_lines", proto.ChildCompleted, "call_296759000cc847849f5c58b28a091415",
			ts("2026-10-18T08:50:54.284Z")}},
		"corpus-trap": {{trapChild, proto.ParentRoot, "", "Peirce", "correction_prompt", proto.ChildCompleted,
			"call_d360a49a19f44639b1551456258c2661", ts("2026-10-15T19:57:26.419Z")}},
		"corpus-guardian": nil, // a guardian reviewer is no child
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, name)
			r.all()
			r.poll()
			r.poll()
			cs := r.rows()
			if len(cs) != len(wants) {
				t.Fatalf("%d rows, want %d: %+v", len(cs), len(wants), cs)
			}
			for i, w := range wants {
				c := cs[i]
				if c.NativeID != w.native || c.Parent != w.parent || c.ParentID != r.rowIDOf(w.parentID) || c.Name != w.name ||
					c.Description != w.desc || c.State != w.state || c.EndedAt != w.ended || c.Source != proto.ChildFromRollout ||
					c.Transcript != proto.TranscriptAvailable || c.Provider != proto.ChildCodex {
					t.Errorf("row %d = %+v; want %+v", i, c, w)
				}
				if d := r.dispatch(w.native); d != w.dispatch {
					t.Errorf("%s dispatch = %q; want %q", w.native, d, w.dispatch)
				}
			}
			r.noRemovals()
		})
	}
}

// rowIDOf is the row id of a native id ("": "").
func (r *rig) rowIDOf(native string) string {
	if native == "" {
		return ""
	}
	return r.row(native).ID
}

// A child shows from its spawner's started record on, before its rollout
// is written (pending) and before it reports back; its file makes the same
// row available; its own task_complete and its spawner's completed end it.
func TestVisibleBeforeReportBack(t *testing.T) {
	r := newRig(t, "a")
	r.writeUpTo(cases["a"], 13) // the spawn call and its started record (ordinal 12)
	r.poll()
	c := r.one(aChild)
	if c.State != proto.ChildRunning || c.Transcript != proto.TranscriptPending || c.Parent != proto.ParentRoot ||
		c.Description != "count_lines" || c.StartedAt != ts("2026-10-18T08:37:38.794Z") || c.EndedAt != 0 {
		t.Fatalf("from its started record = %+v", c)
	}
	if !r.l.WantList() {
		t.Error("a child spawned without its rollout should ask for a listing")
	}
	id := c.ID
	r.writeUpTo(aChild, 20) // its own turn under way
	r.poll()
	c = r.one(aChild)
	if c.ID != id || c.State != proto.ChildRunning || c.Transcript != proto.TranscriptAvailable || c.Name != "Rawls" {
		t.Fatalf("with its rollout = %+v", c)
	}
	if r.l.WantList() {
		t.Error("still asks for a listing")
	}
	r.write(aChild, -1) // its task_complete
	r.poll()
	if c = r.one(aChild); c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-18T08:37:42.436Z") {
		t.Fatalf("own task_complete = %+v", c)
	}
	r.write(cases["a"], -1) // the spawner's completed, the wait's tool call
	r.poll()
	if c = r.one(aChild); c.ID != id || c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-18T08:37:42.437Z") {
		t.Fatalf("whole = %+v", c)
	}
	r.noRemovals()
}

// Two children spawned together are told apart by their ids only, whatever
// order their files come in.
func TestConcurrentChildren(t *testing.T) {
	r := newRig(t, "b")
	r.write(cases["b"], 1)
	r.write(bB, -1) // B's file first, before any spawner record
	r.poll()
	if c := r.one(bB); c.State != proto.ChildCompleted || c.Parent != proto.ParentRoot || r.dispatch(bB) != "" {
		t.Fatalf("B alone = %+v", c)
	}
	r.writeUpTo(cases["b"], 23) // both started records
	r.poll()
	if cs := r.rows(); len(cs) != 2 || cs[0].NativeID != bB || cs[1].NativeID != bA || cs[1].Transcript != proto.TranscriptPending {
		t.Fatalf("rows = %+v", cs)
	}
	if r.dispatch(bA) != "call_3ee1246d4d324471aae519a3f3cb5bd6" || r.dispatch(bB) != "call_c9b9f831318e4c76ade25bac227d8a4d" {
		t.Fatalf("dispatches %q %q", r.dispatch(bA), r.dispatch(bB))
	}
	r.write(bA, 5) // A at work
	r.poll()
	if a, b := r.row(bA), r.row(bB); a.State != proto.ChildRunning || b.State != proto.ChildCompleted {
		t.Fatalf("A %+v, B %+v", a, b)
	}
	r.all()
	r.poll()
	if a := r.row(bA); a.State != proto.ChildCompleted || len(r.rows()) != 2 {
		t.Fatalf("A = %+v", a)
	}
	r.noRemovals()
}

// A depth-2 child attaches to the depth-1 child its first line names; its
// spawn is only in the depth-1 child's rollout, the root's never names it,
// and its second line (the depth-1 child's copied session_meta) is not its.
func TestNestedChild(t *testing.T) {
	r := newRig(t, "c2")
	r.write(cases["c2"], -1)
	r.writeUpTo(c2Outer, 13) // through its started record of the inner one
	r.poll()
	inner := r.row(c2Inner)
	if inner.Parent != proto.ParentChild || inner.ParentID != r.row(c2Outer).ID || inner.Transcript != proto.TranscriptPending ||
		inner.State != proto.ChildRunning || inner.Description != "count_inner" {
		t.Fatalf("inner from its spawner's started = %+v", inner)
	}
	r.write(c2Inner, 3) // its own line 1 and the copied meta of the outer one
	r.poll()
	if inner = r.row(c2Inner); inner.Name != "Pasteur" || inner.Parent != proto.ParentChild || inner.ParentID != r.row(c2Outer).ID ||
		inner.State != proto.ChildRunning || inner.Transcript != proto.TranscriptAvailable {
		t.Fatalf("inner with its rollout = %+v", inner)
	}
	if len(r.rows()) != 2 {
		t.Fatalf("rows = %+v", r.rows())
	}
	r.all()
	r.poll()
	if inner = r.row(c2Inner); inner.State != proto.ChildCompleted {
		t.Fatalf("inner = %+v", inner)
	}
	// The inner file alone (its spawner's file not read): still the outer
	// one's child, by its first line.
	r2 := newRig(t, "c2")
	r2.write(cases["c2"], 1)
	r2.write(c2Inner, -1)
	r2.poll()
	c := r2.one(c2Inner)
	if c.Parent != proto.ParentUnresolved || r2.evs[0].Parent == nil || r2.evs[0].Parent.NativeID != c2Outer {
		t.Fatalf("inner alone = %+v (evidence %+v)", c, r2.evs[0].Parent)
	}
	r2.write(c2Outer, -1)
	for range 5 { // found by the next listing (SubagentRescan)
		r2.poll()
	}
	if c = r2.row(c2Inner); c.Parent != proto.ParentChild || c.ParentID != r2.row(c2Outer).ID {
		t.Fatalf("resolved = %+v", c)
	}
}

// A follow-up is the same child at work again: completed, running, then
// completed, one row; the interacted record alone changes nothing.
func TestFollowUp(t *testing.T) {
	r2 := newRig(t, "d")
	r2.writeUpTo(cases["d"], 21) // spawn, started, completed, the wait
	r2.writeUpTo(dChild, 21)     // its first turn
	r2.poll()
	c := r2.one(dChild)
	id := c.ID
	if c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-18T08:41:33.474Z") {
		t.Fatalf("first turn = %+v", c)
	}
	r2.writeUpTo(cases["d"], 27) // followup_task's interacted
	r2.poll()
	if c = r2.one(dChild); c.State != proto.ChildCompleted {
		t.Fatalf("interacted alone = %+v", c)
	}
	r2.writeUpTo(dChild, 22) // its next own task_started
	r2.poll()
	if c = r2.one(dChild); c.ID != id || c.State != proto.ChildRunning || c.EndedAt != 0 {
		t.Fatalf("followed up = %+v", c)
	}
	r2.all()
	r2.poll()
	if c = r2.one(dChild); c.ID != id || c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-18T08:41:36.186Z") {
		t.Fatalf("second turn = %+v", c)
	}
	r2.noRemovals()
}

// Interrupts: SIGINT of codex exec ends the child by its own turn_aborted
// only; interrupt_agent by its spawner's interrupted record, before the
// child's own abort is read.
func TestInterrupts(t *testing.T) {
	r := newRig(t, "e")
	r.all()
	r.poll()
	if c := r.one(eChild); c.State != proto.ChildInterrupted {
		t.Fatalf("SIGINT = %+v", c)
	}
	r = newRig(t, "f-run")
	r.write(cases["f-run"], -1)
	r.write(fRunChild, 2) // its turn started, its abort not read
	r.poll()
	if c := r.one(fRunChild); c.State != proto.ChildInterrupted || c.EndedAt != ts("2026-10-18T08:46:47.503Z") {
		t.Fatalf("interrupt_agent = %+v", c)
	}
}

// A collaboration tool call's status is the call's: a wait that returned
// (also one naming the child, v1, with agents_states completed) and a spawn
// call done leave a running child running.
func TestToolCallStatusIsNotChildState(t *testing.T) {
	r := newRig(t, "f-idle-v1b")
	r.writeUpTo(cases["f-idle-v1b"], 19) // the spawn's CollabAgentToolCall
	r.writeUpTo(v1IdleChild, 2)          // its turn started
	r.poll()
	if c := r.one(v1IdleChild); c.State != proto.ChildRunning || c.Name != "Turing" {
		t.Fatalf("spawned = %+v", c)
	}
	// The wait's item names it, completed, with its last message, while
	// its own task_complete is not read.
	r.writeUpTo(cases["f-idle-v1b"], 26)
	r.poll()
	if c := r.one(v1IdleChild); c.State != proto.ChildRunning {
		t.Fatalf("after the wait = %+v", c)
	}
	r = newRig(t, "f-run2") // a v2 wait that timed out, the child still at work
	r.writeUpTo(cases["f-run2"], 28)
	r.writeUpTo(fRun2Child, 17)
	r.poll()
	if c := r.one(fRun2Child); c.State != proto.ChildRunning {
		t.Fatalf("after a timed-out wait = %+v", c)
	}
}

// A forked child's copied history (before subagent_history_start_ordinal)
// is not its own: the parent's copied open turn and completed turn say
// nothing of it (corpus: the inherited-prefix trap).
func TestInheritedPrefix(t *testing.T) {
	r := newRig(t, "corpus-trap")
	r.writeUpTo(cases["corpus-trap"], 130) // through the started record
	r.writeUpTo(trapChild, 17)             // line 1, the copied meta and history, not its own turn yet
	r.poll()
	c := r.one(trapChild)
	if c.State != proto.ChildRunning || c.EndedAt != 0 || c.StartedAt != ts("2026-10-15T19:56:23.953Z") ||
		c.LastActivityAt != ts("2026-10-15T19:56:23.953Z") || c.Name != "Peirce" {
		t.Fatalf("with its copied history = %+v", c)
	}
	r.all()
	r.poll()
	if c = r.one(trapChild); c.State != proto.ChildCompleted || c.EndedAt != ts("2026-10-15T19:57:26.419Z") ||
		c.StartedAt != ts("2026-10-15T19:56:23.953Z") || c.LastActivityAt != ts("2026-10-15T19:57:26.419Z") {
		t.Fatalf("whole = %+v", c)
	}
}

// A bridge restart rebuilds the same rows (ids included) from the files
// alone.
func TestRestartRebuilds(t *testing.T) {
	for _, name := range []string{"c2", "d", "f-run", "f-idle-v1b", "g-a0160-v"} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, name)
			r.all()
			r.poll()
			before := r.rows()
			r.start()
			r.poll()
			if after := r.rows(); !slices.Equal(ids(before), ids(after)) || len(after) != len(before) {
				t.Fatalf("after a restart %+v; before %+v", after, before)
			}
			for i, c := range r.rows() {
				b := before[i]
				if c.State != b.State || c.Parent != b.Parent || c.ParentID != b.ParentID || c.EndedAt != b.EndedAt || c.Name != b.Name {
					t.Errorf("row %d after %+v; before %+v", i, c, b)
				}
			}
		})
	}
}

func ids(cs []proto.Child) []string {
	var out []string
	for _, c := range cs {
		out = append(out, c.ID+"/"+c.NativeID)
	}
	return out
}

// Replay sends the session's children again, in order, without reading.
func TestReplay(t *testing.T) {
	r := newRig(t, "b")
	r.all()
	r.poll()
	r.evs = nil
	r.src.Replay(r.session)
	r.apply()
	if len(r.evs) != 2 || r.evs[0].NativeID != bA || r.evs[1].NativeID != bB {
		t.Fatalf("replayed %+v", r.evs)
	}
	r.src.Replay("another")
	if evs := r.src.take(); len(evs) != 0 {
		t.Fatalf("another session's replay = %+v", evs)
	}
}

// A child rollout that went removes its row; back, it is the same row.
func TestGoneFile(t *testing.T) {
	r := newRig(t, "a")
	r.all()
	r.poll()
	id := r.one(aChild).ID
	if err := os.Remove(r.path(aChild)); err != nil {
		t.Fatal(err)
	}
	r.poll()
	if cs := r.rows(); len(cs) != 0 {
		t.Fatalf("after its file went: %+v", cs)
	}
	r.written[aChild] = 0
	r.write(aChild, -1)
	for range 5 { // found by the next listing (SubagentRescan)
		r.poll()
	}
	if c := r.one(aChild); c.ID != id || c.State != proto.ChildCompleted {
		t.Fatalf("back = %+v", c)
	}
}

// Another root session's child in the same directory (two Codex workers in
// one cwd) is never this session's: nor is a guardian reviewer.
func TestOtherSessionsChildren(t *testing.T) {
	r := newRig(t, "a")
	other := newRig(t, "b")
	other.root = r.root // b's files in a's sessions directory, the same day
	other.all()
	g := newRig(t, "corpus-guardian")
	g.root = r.root
	g.all()
	r.all()
	r.poll()
	r.poll()
	r.one(aChild)
}

// A file whose first line is not a spawned child of this session counts
// for nothing, its started records of nested children included.
func TestForeignFile(t *testing.T) {
	fx := load(t, "c2")
	s := New(Options{})
	l := s.Listener(cases["a"]) // another session
	for i, line := range fx.lines[c2Outer] {
		l.Child(c2Outer, int64(i), []byte(line))
	}
	l.Polled(time.Now())
	if evs := s.take(); len(evs) != 0 {
		t.Fatalf("foreign file: %+v", evs)
	}
	// A child file whose first line names another thread.
	l2 := s.Listener(cases["c2"])
	for i, line := range fx.lines[c2Outer] {
		l2.Child(c2Inner, int64(i), []byte(line))
	}
	l2.Polled(time.Now())
	if evs := s.take(); len(evs) != 0 {
		t.Fatalf("another thread's file: %+v", evs)
	}
}

// Legacy-history rollouts write sub_agent_activity events (all kinds but
// completed): started pairs only with a spawn call of the same file.
func TestLegacyActivity(t *testing.T) {
	const session, child = "01a14e00-0000-7000-8000-000000000001", "01a14e00-0000-7000-8000-000000000002"
	s := New(Options{})
	l := s.Listener(session)
	for i, line := range []string{
		`{"timestamp":"2026-10-18T08:00:00.000Z","type":"session_meta","payload":{"id":"` + session + `","history_mode":"legacy"}}`,
		`{"timestamp":"2026-10-18T08:00:01.000Z","type":"response_item","payload":{"type":"function_call","name":"spawn_agent","namespace":"collaboration","call_id":"call_1","arguments":"{\"task_name\":\"lint\"}"}}`,
		`{"timestamp":"2026-10-18T08:00:01.020Z","type":"event_msg","payload":{"type":"sub_agent_activity","event_id":"call_1","occurred_at_ms":1792310401015,"agent_thread_id":"` + child + `","agent_path":"/root/lint","kind":"started"}}`,
		`{"timestamp":"2026-10-18T08:00:03.000Z","type":"event_msg","payload":{"type":"sub_agent_activity","event_id":"call_2","occurred_at_ms":1792310403000,"agent_thread_id":"` + child + `","agent_path":"/root/lint","kind":"interrupted"}}`,
	} {
		l.Main(int64(i), []byte(line))
	}
	l.Polled(time.Now())
	evs := s.take()
	if len(evs) != 1 {
		t.Fatalf("evidence %+v", evs)
	}
	e := evs[0]
	if e.NativeID != child || e.DispatchID != "call_1" || e.State != proto.ChildInterrupted || e.EndedAt != 1792310403000 ||
		e.StartedAt != 1792310401015 || e.Description != "lint" || e.Transcript != proto.TranscriptUnavailable {
		t.Fatalf("legacy = %+v", e)
	}
}

// A second reader of one session takes over when the first closes,
// without removing rows; the last one closing sends nothing.
func TestSecondReaderTakesOver(t *testing.T) {
	r := newRig(t, "a")
	r.all()
	r.poll()
	second := usage.NewSession(usage.Codex, r.session, usage.Roots{CodexSessions: r.root}, usage.DefaultPricing())
	l2 := r.src.Listener(r.session)
	second.SetChildren(l2)
	r.l.Close()
	r.now = r.now.Add(time.Second)
	second.Poll(r.now)
	r.apply()
	r.one(aChild)
	r.noRemovals()
	l2.Close()
	if evs := r.src.take(); len(evs) != 0 {
		t.Fatalf("closing sent %+v", evs)
	}
}
