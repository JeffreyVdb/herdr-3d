package server_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/childagents/childagentstest"
	"github.com/JeffreyVdb/herdr-3d/internal/codex"
	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #26: a worker's native children's own transcripts, watched by target
// (worker id + child row), side by side with the worker's own.

// pushOf reads until the push or close of the watch of worker id (child:
// of that child; nil, of the worker's own); other messages are skipped.
func (c *client) pushOf(id string, child *proto.TranscriptChild) (proto.TranscriptItems, proto.TranscriptClosed) {
	c.t.Helper()
	same := func(got *proto.TranscriptChild) bool {
		return (got == nil) == (child == nil) && (got == nil || *got == *child)
	}
	for {
		m := c.next()
		switch m.env.T {
		case proto.TTranscriptItems:
			var p proto.TranscriptItems
			_ = json.Unmarshal(m.raw, &p)
			if p.ID == id && same(p.Child) {
				return p, proto.TranscriptClosed{}
			}
		case proto.TTranscriptClosed:
			var cl proto.TranscriptClosed
			_ = json.Unmarshal(m.raw, &cl)
			if cl.ID == id && same(cl.Child) {
				return proto.TranscriptItems{}, cl
			}
		}
	}
}

// childOf reads until the upsert of the child of native id (or, native "",
// any child) and returns its target.
func (c *client) childOf(native string) (*proto.TranscriptChild, proto.Child) {
	c.t.Helper()
	for {
		ev := c.until(proto.EvChildUpsert)
		if native == "" || ev.Child.NativeID == native {
			return &proto.TranscriptChild{ID: ev.Child.ID, Generation: ev.Child.Generation, Provider: ev.Child.Provider}, *ev.Child
		}
	}
}

type childRig struct {
	t   *testing.T
	b   *bridge
	src *childagentstest.FixtureSource
	c   *client
	dir string // the Claude projects directory
}

func startChildTx(t *testing.T, opts server.Options) *childRig {
	t.Helper()
	r := &childRig{t: t, src: childagentstest.NewFixtureSource()}
	base, _ := filepath.EvalSymlinks(t.TempDir())
	r.dir = filepath.Join(base, "projects")
	cache, err := imgcache.New(imgcache.Config{Dir: filepath.Join(base, "cache")})
	if err != nil {
		t.Fatal(err)
	}
	if opts.Usage == nil {
		opts.Usage = &server.UsageConfig{}
	}
	opts.Usage.Roots.ClaudeProjects = r.dir
	opts.Usage.Interval = 20 * time.Millisecond
	opts.Usage.Images = &transcript.Images{Cache: cache}
	opts.TranscriptFlush = 10 * time.Millisecond
	opts.ChildSources = []childagents.Source{r.src}
	r.b = startBridge(t, "", opts)
	r.c = r.b.connect(proto.Hello{})
	r.c.snapshot()
	return r
}

// floor puts the workers on floor s1 and returns their ids, once their
// sessions are bound.
func (r *childRig) floor(ws ...world.WorkerObs) []string {
	r.t.Helper()
	r.b.floor("s1", true, ws...)
	ids := make([]string, len(ws))
	for n := 0; n < len(ws); {
		ev := r.c.until(proto.EvWorkerUpsert)
		for i, w := range ws {
			if ev.Worker.WorkspaceID == w.WorkspaceID && ids[i] == "" {
				ids[i] = ev.Worker.ID
				n++
			}
		}
	}
	r.src.Wait()
	return ids
}

func (r *childRig) child(session, native string, more ...func(*childagents.Evidence)) {
	e := childagents.Evidence{Session: session, Provider: proto.ChildClaude, NativeID: native, State: proto.ChildRunning,
		Source: proto.ChildFromFixture, Parent: &childagents.ParentRef{Kind: proto.ParentRoot}}
	for _, f := range more {
		f(&e)
	}
	r.src.Emit(e)
}

func claudeWorker(ws, session string) world.WorkerObs {
	w := worker(ws, ws, session, "working")
	w.Harness = world.HarnessClaude
	return w
}

// subagentPath is a Claude session's subagent's transcript under project
// directory project.
func (r *childRig) subagentPath(project, session, agent string) string {
	return filepath.Join(r.dir, project, session, "subagents", "agent-"+agent+".jsonl")
}

// A running Claude child, opened by its row: its own conversation, live; its
// older pages, items and images read through its own target, and an image
// sent on one watch is not one the other may read. The worker's own watch
// goes on beside it, unchanged. Then the worker's session is replaced: both
// close, and the old child cannot be watched again.
func TestChildTranscriptWatch(t *testing.T) {
	t.Parallel()
	const (
		sess  = "0a0b0c0d-2626-4626-8626-262626262601"
		next  = "0a0b0c0d-2626-4626-8626-262626262602"
		agent = "aa3716c63ba631707"
	)
	r := startChildTx(t, server.Options{MaxTranscriptWatches: 1})
	main := filepath.Join(r.dir, "-home-u-w1", sess+".jsonl")
	parentPNG, childPNG := seededPNG(t, 40, 30, 7), seededPNG(t, 50, 20, 9)
	writeTranscript(t, main, fixture(t, "claude", "message.jsonl")+claudeImageLine(t, "pu1", parentPNG))
	sub := r.subagentPath("-home-u-w1", sess, agent)
	lines := strings.SplitAfter(strings.TrimSuffix(fixture(t, "claude", "subagent.jsonl"), "\n"), "\n")
	writeTranscript(t, sub, strings.Join(lines[:len(lines)-1], "")+claudeImageLine(t, "cu1", childPNG))
	id := r.floor(claudeWorker("w1", sess))[0]
	r.child(sess, agent)
	ch, row := r.c.childOf(agent)
	c := r.c

	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})
	parent := decode[proto.TranscriptWatchResult](t, ack)
	if parent.Pending || len(parent.Items) == 0 || parent.Availability != "" {
		t.Fatalf("parent ack = %+v", parent)
	}
	// One watch of the worker's own is this connection's cap: a child's is not counted against it.
	_, ack = c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: ch, Limit: 2})
	res := decode[proto.TranscriptWatchResult](t, ack)
	if res.Pending || res.Availability != proto.TranscriptAvailable || res.Harness != "claude" || res.Session != agent ||
		len(res.Items) != 2 || !res.HasMore || res.Items[1].ID != "cu1" {
		t.Fatalf("child ack = %+v", res)
	}
	if row.AgentSession != sess || row.Generation != ch.Generation {
		t.Fatalf("row = %+v", row)
	}

	// Live: a line appended to the child's file is pushed on the child's watch only; the worker's own goes on.
	appendLine(t, sub, lines[len(lines)-1]+"\n")
	p, cl := c.pushOf(id, ch)
	if cl.Reason != "" || len(p.Items) != 1 || p.Items[0].Seq != res.Items[1].Seq+1 || p.TranscriptHead != nil {
		t.Fatalf("child push = %+v %+v", p, cl)
	}
	appendLine(t, main, fixtureLine(t, "claude", "user.jsonl", 0))
	if p, cl = c.pushOf(id, nil); cl.Reason != "" || len(p.Items) != 1 || p.Items[0].Kind != proto.ItemUser {
		t.Fatalf("parent push = %+v %+v", p, cl)
	}

	// Older pages and an item, of the child's own log.
	_, ack = c.mustAck(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: ch, Before: res.Cursor, Limit: 100})
	pg := decode[proto.TranscriptPageResult](t, ack)
	if len(pg.Items) == 0 || pg.HasMore || pg.Items[0].Seq != 1 || pg.Items[0].Kind != proto.ItemUser {
		t.Fatalf("child page = %+v", pg)
	}
	_, ack = c.mustAck(proto.CmdTranscriptItem, proto.TranscriptItemArgs{ID: id, Child: ch, Item: pg.Items[0].ID})
	if it := decode[proto.TranscriptItemResult](t, ack).Item; it.ID != pg.Items[0].ID {
		t.Fatalf("child item = %+v", it)
	}
	c.mustError(proto.CmdTranscriptItem, proto.TranscriptItemArgs{ID: id, Item: pg.Items[0].ID}, proto.ErrNotFound) // not the worker's
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: ch, Agent: agent}, proto.ErrBadRequest)

	// Images: each watch serves only what it sent.
	childHash, parentHash := imgcache.Hash(childPNG), imgcache.Hash(parentPNG)
	_, ack = c.mustAck(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Child: ch, Hash: childHash, Size: proto.ImageThumb})
	if img := decode[proto.TranscriptImageResult](t, ack); img.Width != 50 || img.Data == "" {
		t.Fatalf("child image = %+v", img)
	}
	c.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Hash: childHash, Size: proto.ImageThumb}, proto.ErrNotFound)
	_, ack = c.mustAck(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Hash: parentHash, Size: proto.ImageFull})
	if img := decode[proto.TranscriptImageResult](t, ack); img.Width != 40 {
		t.Fatalf("parent image = %+v", img)
	}
	c.mustError(proto.CmdTranscriptImage, proto.TranscriptImageArgs{ID: id, Child: ch, Hash: parentHash, Size: proto.ImageThumb}, proto.ErrNotFound)
	_, ack = c.mustAck(proto.CmdTranscriptImages, proto.TranscriptImagesArgs{ID: id, Child: ch})
	if imgs := decode[proto.TranscriptImagesResult](t, ack); len(imgs.Images) != 1 || imgs.Images[0].Hash != childHash {
		t.Fatalf("child images = %+v", imgs)
	}

	// Targets the worker has no such child for, or one of another generation.
	stale := *ch
	stale.Generation++
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: &stale}, proto.ErrStale)
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: &stale, Before: "c:2"}, proto.ErrInvalidState)
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: &proto.TranscriptChild{ID: "ch_0000000000000000", Generation: ch.Generation, Provider: proto.ChildClaude}}, proto.ErrNotFound)
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: &proto.TranscriptChild{ID: ch.ID, Generation: ch.Generation, Provider: proto.ChildCodex}}, proto.ErrNotFound)
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: &proto.TranscriptChild{ID: ch.ID, Generation: ch.Generation}}, proto.ErrBadRequest)

	// /clear: the worker's session is replaced. The child's watch closes (its generation is gone) as the worker's does.
	w1 := claudeWorker("w1", next)
	r.b.floor("s1", true, w1)
	closedChild, closedOwn := false, false
	for !closedChild || !closedOwn {
		m := c.next()
		if m.env.T != proto.TTranscriptClosed {
			continue
		}
		var cl proto.TranscriptClosed
		_ = json.Unmarshal(m.raw, &cl)
		if cl.Reason != proto.ClosedSessionChanged {
			t.Fatalf("closed = %+v", cl)
		}
		if cl.Child != nil && *cl.Child == *ch {
			closedChild = true
		} else if cl.Child == nil {
			closedOwn = true
		}
	}
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: ch}, proto.ErrStale)
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: ch, Before: "c:2"}, proto.ErrInvalidState)
}

// A provisional child (seen from its dispatch: no native id) is pending,
// never another conversation; named, still pending while its file is not
// written; its provider saying it has none, unavailable; once the file
// appears the same watch goes live with its history. A removed child's
// watch closes not_found.
func TestChildTranscriptPendingThenLive(t *testing.T) {
	t.Parallel()
	const (
		sess  = "0a0b0c0d-2626-4626-8626-262626262611"
		agent = "ab3716c63ba631707"
	)
	r := startChildTx(t, server.Options{})
	writeTranscript(t, filepath.Join(r.dir, "-home-u-w1", sess+".jsonl"), fixture(t, "claude", "message.jsonl"))
	// A sibling's transcript is there all along: never shown for the pending one.
	r.child(sess, "ac3716c63ba631707")
	id := r.floor(claudeWorker("w1", sess))[0]
	writeTranscript(t, r.subagentPath("-home-u-w1", sess, "ac3716c63ba631707"), fixture(t, "claude", "subagent.jsonl"))
	r.child(sess, "", func(e *childagents.Evidence) { e.DispatchID = "toolu_26pending" })
	ch, row := r.c.childOf("")
	for row.NativeID != "" {
		ch, row = r.c.childOf("")
	}
	c := r.c
	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: ch})
	res := decode[proto.TranscriptWatchResult](t, ack)
	if !res.Pending || res.Availability != proto.TranscriptPending || len(res.Items) != 0 {
		t.Fatalf("provisional ack = %+v", res)
	}
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: ch, Before: "c:1"}, proto.ErrInvalidState)

	// Named, and its provider says it has no transcript: unavailable, by a head alone.
	r.child(sess, agent, func(e *childagents.Evidence) {
		e.DispatchID, e.State, e.Transcript = "toolu_26pending", proto.ChildCompleted, proto.TranscriptUnavailable
	})
	p, cl := c.pushOf(id, ch)
	if cl.Reason != "" || p.TranscriptHead == nil || !p.Pending || p.Availability != proto.TranscriptUnavailable || len(p.Items) != 0 {
		t.Fatalf("unavailable push = %+v %+v", p, cl)
	}
	// Its file appears: live on the same watch, the head first.
	sub := r.subagentPath("-home-u-w1", sess, agent)
	writeTranscript(t, sub, fixture(t, "claude", "subagent.jsonl"))
	p, cl = c.pushOf(id, ch)
	if cl.Reason != "" || p.TranscriptHead == nil || p.Pending || p.Availability != proto.TranscriptAvailable || p.Session != agent ||
		len(p.Items) != 4 || p.Items[0].Kind != proto.ItemUser {
		t.Fatalf("appeared push = %+v %+v", p, cl)
	}
	_, ack = c.mustAck(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: ch, Before: p.Cursor})
	if pg := decode[proto.TranscriptPageResult](t, ack); len(pg.Items) != 0 || pg.HasMore {
		t.Fatalf("page = %+v", pg)
	}
	// Its file goes: not_found (a new watch says unavailable, never an error page).
	if err := os.Remove(sub); err != nil {
		t.Fatal(err)
	}
	if _, cl = c.pushOf(id, ch); cl.Reason != proto.ClosedNotFound {
		t.Fatalf("gone = %+v", cl)
	}
	_, ack = c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: ch})
	if res := decode[proto.TranscriptWatchResult](t, ack); !res.Pending || res.Availability != proto.TranscriptUnavailable {
		t.Fatalf("after it went = %+v", res)
	}
	// The row removed: not_found.
	r.child(sess, agent, func(e *childagents.Evidence) { e.Removed = true })
	if _, cl = c.pushOf(id, ch); cl.Reason != proto.ClosedNotFound {
		t.Fatalf("removed = %+v", cl)
	}
}

// Two workers in the same directory (one Claude projects directory) whose
// children even share a native id: each target reads its own worker's
// session's file, and one worker's row is never another's.
func TestChildTranscriptTwoWorkersOneDirectory(t *testing.T) {
	t.Parallel()
	const (
		s1    = "0a0b0c0d-2626-4626-8626-262626262621"
		s2    = "0a0b0c0d-2626-4626-8626-262626262622"
		agent = "ad3716c63ba631707"
	)
	r := startChildTx(t, server.Options{})
	project := "-home-u-shared"
	writeTranscript(t, filepath.Join(r.dir, project, s1+".jsonl"), fixture(t, "claude", "message.jsonl"))
	writeTranscript(t, filepath.Join(r.dir, project, s2+".jsonl"), fixture(t, "claude", "message.jsonl"))
	say := func(uuid, text string) string {
		b, _ := json.Marshal(map[string]any{"type": "user", "uuid": uuid, "timestamp": "2026-09-30T10:00:00.000Z",
			"message": map[string]any{"role": "user", "content": text}})
		return string(b) + "\n"
	}
	writeTranscript(t, r.subagentPath(project, s1, agent), say("one", "the first worker's child"))
	writeTranscript(t, r.subagentPath(project, s2, agent), say("two", "the second worker's child"))
	a, b := claudeWorker("w1", s1), claudeWorker("w2", s2)
	b.Cwd, b.IdentityCwd = a.Cwd, a.IdentityCwd
	ids := r.floor(a, b)
	r.child(s1, agent)
	ch1, row1 := r.c.childOf(agent)
	r.child(s2, agent)
	ch2, row2 := r.c.childOf(agent)
	if row1.WorkerID != ids[0] || row2.WorkerID != ids[1] || ch1.ID == ch2.ID {
		t.Fatalf("rows %+v %+v", row1, row2)
	}
	c := r.c
	for i, ch := range []*proto.TranscriptChild{ch1, ch2} {
		_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: ids[i], Child: ch})
		res := decode[proto.TranscriptWatchResult](t, ack)
		want := []string{"one", "two"}[i]
		if len(res.Items) != 1 || res.Items[0].ID != want {
			t.Fatalf("worker %d's child = %+v", i, res.Items)
		}
	}
	// A row of one worker named under the other: refused, whatever the generation.
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: ids[0], Child: &proto.TranscriptChild{ID: ch2.ID, Generation: ch1.Generation, Provider: proto.ChildClaude}}, proto.ErrNotFound)
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: ids[1], Child: &proto.TranscriptChild{ID: ch1.ID, Generation: ch2.Generation, Provider: proto.ChildClaude}}, proto.ErrNotFound)
}

// A Codex terminal child: its rollout, found as a child of the worker's own
// session, read from its history start: the parent's copied records are not
// shown as the child's activity.
func TestChildTranscriptCodex(t *testing.T) {
	t.Parallel()
	const (
		session = "01a1411d-60ee-7ca0-91a1-88ef70dddaae" // internal/codexchild/testdata/corpus-trap
		thread  = "01a14123-2203-7072-a869-f11c190d6c94"
	)
	sessions := filepath.Join(t.TempDir(), "sessions")
	var meta codex.Meta
	paths, _ := filepath.Glob(filepath.Join("..", "codexchild", "testdata", "corpus-trap", "rollout-*.jsonl"))
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		name := filepath.Base(p)
		day := strings.ReplaceAll(strings.TrimPrefix(name, "rollout-")[:10], "-", "/")
		writeTranscript(t, filepath.Join(sessions, filepath.FromSlash(day), name), string(b))
		if m, ok := codex.ParseMeta(b[:strings.IndexByte(string(b), '\n')]); ok && m.ID == thread {
			meta = m
		}
	}
	if meta.HistoryStart == 0 {
		t.Fatal("the fixture's child has no history start")
	}
	r := startChildTx(t, server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{CodexSessions: sessions}}})
	w := worker("w1", "w1", session, "working")
	w.Harness = world.HarnessCodex
	id := r.floor(w)[0]
	r.src.Emit(childagents.Evidence{Session: session, Provider: proto.ChildCodex, NativeID: thread, State: proto.ChildCompleted,
		Source: proto.ChildFromRollout, Transcript: proto.TranscriptAvailable})
	ch, _ := r.c.childOf(thread)
	_, ack := r.c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: ch, Limit: 500})
	res := decode[proto.TranscriptWatchResult](t, ack)
	if res.Pending || res.Harness != "codex" || res.Session != thread || len(res.Items) == 0 {
		t.Fatalf("codex child ack = %+v", res.TranscriptHead)
	}
	whole, err := transcript.Read(t.Context(), transcript.Codex, filepath.Join(sessions, "2026", "10", "15", "rollout-2026-10-15T21-56-23-"+thread+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer whole.Close()
	all, _ := whole.Before(0, 2000)
	start, _ := time.Parse(time.RFC3339Nano, "2026-10-15T19:56:23.956Z") // its own task_started (internal/codexchild)
	visible := 0
	for _, it := range res.Items {
		if it.Hidden {
			continue
		}
		visible++
		if it.TS < start.UnixMilli() {
			t.Errorf("inherited item shown as the child's: %+v", it)
		}
	}
	inherited := 0
	for _, it := range all.Items {
		if !it.Hidden && it.TS < start.UnixMilli() {
			inherited++
		}
	}
	if visible == 0 || inherited == 0 {
		t.Fatalf("visible %d, inherited without the history start %d", visible, inherited)
	}
}

// Many children: a connection has at most MaxChildTranscriptWatches child
// watches (a newer one evicts the oldest, which can be watched again: its
// completed history is read again from its file), and the bridge follows at
// most MaxChildTranscriptLogs children's logs for every connection.
func TestChildTranscriptBounds(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-2626-4626-8626-262626262631"
	r := startChildTx(t, server.Options{})
	writeTranscript(t, filepath.Join(r.dir, "-home-u-w1", sess+".jsonl"), fixture(t, "claude", "message.jsonl"))
	id := r.floor(claudeWorker("w1", sess))[0]
	n := server.MaxChildTranscriptLogs + 2 // kids[1] and the last are left over
	kids := make([]*proto.TranscriptChild, n)
	for i := range n {
		agent := fmt.Sprintf("a%016x", i+1)
		writeTranscript(t, r.subagentPath("-home-u-w1", sess, agent), fixture(t, "claude", "subagent.jsonl"))
		r.child(sess, agent, func(e *childagents.Evidence) { e.State, e.Transcript = proto.ChildCompleted, proto.TranscriptAvailable })
		kids[i], _ = r.c.childOf(agent)
	}
	c := r.c
	// watch watches a child and returns the children's watches closed meanwhile (the eviction comes before the ack).
	watch := func(c *client, ch *proto.TranscriptChild) []string {
		t.Helper()
		b, _ := json.Marshal(proto.TranscriptWatchArgs{ID: id, Child: ch})
		c.send(proto.Command{T: proto.CmdTranscriptWatch, ReqID: "w-" + ch.ID, Args: b})
		var closed []string
		for {
			m := c.next()
			switch m.env.T {
			case proto.TTranscriptClosed:
				var cl proto.TranscriptClosed
				_ = json.Unmarshal(m.raw, &cl)
				if cl.Child != nil {
					closed = append(closed, cl.Child.ID+" "+cl.Reason)
				}
			case proto.TAck:
				var ack proto.Ack
				_ = json.Unmarshal(m.raw, &ack)
				if res := decode[proto.TranscriptWatchResult](t, ack); res.Pending || len(res.Items) != 4 {
					t.Fatalf("child %s = %+v", ch.ID, res)
				}
				return closed
			case proto.TError:
				t.Fatalf("watch %s: %s", ch.ID, m.raw)
			}
		}
	}
	watch(c, kids[0])
	watch(c, kids[1])
	_, own := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id}) // the worker's own, beside them
	if res := decode[proto.TranscriptWatchResult](t, own); res.Pending {
		t.Fatalf("own = %+v", res)
	}
	if closed := watch(c, kids[2]); len(closed) != 1 || closed[0] != kids[0].ID+" "+proto.ClosedEvicted {
		t.Fatalf("oldest = %q", closed)
	}
	// The evicted one, watched again: its history, read again; the next oldest goes.
	if closed := watch(c, kids[0]); len(closed) != 1 || closed[0] != kids[1].ID+" "+proto.ClosedEvicted {
		t.Fatalf("next oldest = %q", closed)
	}
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Child: kids[1], Before: "c:2"}, proto.ErrInvalidState)
	// Every connection's children: MaxChildTranscriptLogs logs at most (one child watched twice is one).
	watched := 2 // kids[0], kids[2]
	for i := 3; watched < server.MaxChildTranscriptLogs; i += 2 {
		o := r.b.connect(proto.Hello{})
		o.snapshot()
		watch(o, kids[i])
		watch(o, kids[i+1])
		watched += 2
	}
	o := r.b.connect(proto.Hello{})
	o.snapshot()
	watch(o, kids[0]) // already followed: shared
	o.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Child: kids[n-1]}, proto.ErrCapacity)
	// One goes: another can come.
	c.mustAck(proto.CmdTranscriptUnwatch, proto.TranscriptUnwatchArgs{ID: id, Child: kids[2]})
	watch(o, kids[n-1])
}
