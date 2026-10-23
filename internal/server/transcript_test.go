package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func fixture(t *testing.T, harness, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "transcript", "testdata", harness, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// fixtureLine is line i of a fixture, with its newline.
func fixtureLine(t *testing.T, harness, name string, i int) string {
	t.Helper()
	return strings.SplitAfter(fixture(t, harness, name), "\n")[i]
}

func writeTranscript(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// push reads until the transcript push or close of worker id's own watch
// (other messages are skipped).
func (c *client) push(id string) (proto.TranscriptItems, proto.TranscriptClosed) {
	c.t.Helper()
	for {
		m := c.next()
		switch m.env.T {
		case proto.TTranscriptItems:
			var p proto.TranscriptItems
			_ = json.Unmarshal(m.raw, &p)
			if p.ID == id && p.Child == nil {
				return p, proto.TranscriptClosed{}
			}
		case proto.TTranscriptClosed:
			var cl proto.TranscriptClosed
			_ = json.Unmarshal(m.raw, &cl)
			if cl.ID == id && cl.Child == nil {
				return proto.TranscriptItems{}, cl
			}
		}
	}
}

func decode[T any](t *testing.T, ack proto.Ack) T {
	t.Helper()
	var v T
	b, _ := json.Marshal(ack.Data)
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func workerID(t *testing.T, c *client, agentSession string) string {
	t.Helper()
	for {
		if ev := c.until(proto.EvWorkerUpsert); ev.Worker.AgentSession == agentSession {
			return ev.Worker.ID
		}
	}
}

// A Claude worker's transcript: the watch acks with its newest items, then
// pushes new items and, for a tool result, the call's item again; pages,
// items in full and a subagent's own timeline are read on request.
func TestTranscriptWatch(t *testing.T) {
	t.Parallel()
	const (
		sess  = "0a0b0c0d-5555-4555-8555-555555555551"
		other = "0a0b0c0d-5555-4555-8555-555555555552"
		agent = "aa3716c63ba631707"
	)
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	writeTranscript(t, path, fixture(t, "claude", "message.jsonl")+fixture(t, "claude", "agent.jsonl"))
	writeTranscript(t, filepath.Join(dir, "-home-u-w1", sess, "subagents", "agent-"+agent+".jsonl"),
		fixture(t, "claude", "subagent.jsonl"))
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 20 * time.Millisecond}, TranscriptFlush: 10 * time.Millisecond, MaxTranscriptWatches: 2})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	w2 := worker("w2", "b", "", "idle")
	b.floor("s1", true, w1, w2)
	id := workerID(t, c, sess)

	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})
	res := decode[proto.TranscriptWatchResult](t, ack)
	if res.Harness != "claude" || res.Session != sess || res.Version != "2.1.285" || res.Pending || res.HasMore ||
		res.Cursor != "c:1" || len(res.Items) != 5 || res.Items[2].ID != "toolu_018Aah2uHCqF4KbGuUkTSEYa" ||
		res.Items[2].Tool.Status != proto.ToolRunning || res.Items[4].Kind != proto.ItemSubagent {
		t.Fatalf("watch ack = %+v", res)
	}

	// The running Bash call's result: an update of its item, not a new one.
	appendLine(t, path, fixtureLine(t, "claude", "bash.jsonl", 1))
	p, cl := c.push(id)
	if cl.Reason != "" || len(p.Items) != 0 || len(p.Updates) != 1 || p.Updates[0].Seq != 3 ||
		p.Updates[0].Tool.Status != proto.ToolOK || p.TranscriptHead != nil {
		t.Fatalf("push = %+v %+v", p, cl)
	}
	appendLine(t, path, fixtureLine(t, "claude", "user.jsonl", 0))
	if p, _ = c.push(id); len(p.Items) != 1 || p.Items[0].Kind != proto.ItemUser || p.Items[0].Seq != 6 {
		t.Fatalf("push = %+v", p)
	}

	// Pages, one item in full, a subagent's timeline and one of its items.
	_, ack = c.mustAck(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Before: "c:4", Limit: 2})
	if pg := decode[proto.TranscriptPageResult](t, ack); len(pg.Items) != 2 || pg.Items[0].Seq != 2 || pg.Cursor != "c:2" || !pg.HasMore {
		t.Fatalf("page = %+v", pg)
	}
	_, ack = c.mustAck(proto.CmdTranscriptItem, proto.TranscriptItemArgs{ID: id, Item: "toolu_018Aah2uHCqF4KbGuUkTSEYa"})
	if it := decode[proto.TranscriptItemResult](t, ack).Item; it.Tool == nil || len(it.Tool.Input) == 0 || it.Tool.Status != proto.ToolOK {
		t.Fatalf("item = %+v", it)
	}
	c.mustError(proto.CmdTranscriptItem, proto.TranscriptItemArgs{ID: id, Item: "toolu_nope"}, proto.ErrNotFound)
	_, ack = c.mustAck(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Agent: agent})
	sub := decode[proto.TranscriptPageResult](t, ack)
	if len(sub.Items) != 4 || sub.Items[0].Kind != proto.ItemUser || sub.HasMore {
		t.Fatalf("subagent page = %+v", sub)
	}
	_, ack = c.mustAck(proto.CmdTranscriptItem, proto.TranscriptItemArgs{ID: id, Agent: agent, Item: sub.Items[1].ID})
	if it := decode[proto.TranscriptItemResult](t, ack).Item; it.ID != sub.Items[1].ID {
		t.Fatalf("subagent item = %+v", it)
	}
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Agent: "../../etc"}, proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Agent: "a0000000000000000"}, proto.ErrNotFound)
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id, Before: "nope"}, proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Limit: 501}, proto.ErrBadRequest)
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: "nope"}, proto.ErrUnknownWorker)

	// A plain shell: pending, and a read of it is invalid_state.
	id2 := ""
	for _, w := range b.connect(proto.Hello{}).snapshot().World.Workers {
		if w.ID != id {
			id2 = w.ID
		}
	}
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id2, Before: "c:1"}, proto.ErrInvalidState)
	_, ack = c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id2, Limit: 10})
	if res := decode[proto.TranscriptWatchResult](t, ack); !res.Pending || len(res.Items) != 0 {
		t.Fatalf("pending ack = %+v", res)
	}
	c.mustError(proto.CmdTranscriptPage, proto.TranscriptPageArgs{ID: id2, Before: "c:1"}, proto.ErrInvalidState)
	// Two watches is the cap here; watching one again replaces it.
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id2 + "x"}, proto.ErrUnknownWorker)
	b.floor("s1", true, w1, w2, worker("w3", "c", "", "idle"))
	id3 := ""
	for id3 == "" {
		if ev := c.until(proto.EvWorkerUpsert); ev.Worker.Label == "c" {
			id3 = ev.Worker.ID
		}
	}
	c.mustError(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id3}, proto.ErrCapacity)

	// The shell becomes a Claude agent: its transcript appears, pushed
	// with the head the pending ack lacked.
	path2 := filepath.Join(dir, "-home-u-w2", other+".jsonl")
	writeTranscript(t, path2, fixture(t, "claude", "user.jsonl"))
	w2.AgentSession, w2.Harness = other, world.HarnessClaude
	b.floor("s1", true, w1, w2, worker("w3", "c", "", "idle"))
	p, cl = c.push(id2)
	if cl.Reason != "" || p.TranscriptHead == nil || p.Pending || p.Session != other || p.Cursor != "c:1" || len(p.Items) != 5 {
		t.Fatalf("appeared: %+v %+v", p, cl)
	}

	// /clear: another agent session ends the watch.
	w1.AgentSession = other + "0"
	b.floor("s1", true, w1, w2, worker("w3", "c", "", "idle"))
	if _, cl = c.push(id); cl.Reason != proto.ClosedSessionChanged {
		t.Fatalf("closed = %+v", cl)
	}
	// Gone: worker_removed.
	b.floor("s1", true, w1, worker("w3", "c", "", "idle"))
	if _, cl = c.push(id2); cl.Reason != proto.ClosedWorkerRemoved {
		t.Fatalf("closed = %+v", cl)
	}
	c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: id2}) // not watched: a no-op
	// 20 sit / stand cycles leave no watch behind.
	for range 20 {
		c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id3})
		c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: id3})
	}
	if n := b.hub.TranscriptWatches(); n != 0 {
		t.Fatalf("%d watches left", n)
	}

	// The audit log has watch and unwatch with the worker id only; page and
	// item are not in it.
	rows, err := b.st.AuditLog(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	watches := 0
	for _, r := range rows {
		if strings.HasPrefix(r.Cmd, "transcript.") && r.Cmd != proto.CmdTranscriptWatch && r.Cmd != proto.CmdTranscriptUnwatch {
			t.Errorf("audited %s", r.Cmd)
		}
		if r.Cmd == proto.CmdTranscriptWatch {
			watches++
			if !strings.HasPrefix(r.Args, `{"id":`) || strings.Contains(r.Args, "limit") {
				t.Errorf("watch audited as %s", r.Args)
			}
		}
	}
	if watches < 3 {
		t.Errorf("%d watches audited", watches)
	}
}

// logBuf is a bridge log the test reads while the hub writes to it.
type logBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *logBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func (l *logBuf) lines(msg string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []string
	for _, line := range strings.Split(l.b.String(), "\n") {
		if strings.Contains(line, "msg=\""+msg+"\"") {
			out = append(out, line)
		}
	}
	return out
}

// Watching a worker again on the same connection replaces its watch (a
// sit after a desk print kept it: no capacity error, no second watch),
// and a watch acked pending or with no items is logged at debug with the
// worker's id, never with content.
func TestTranscriptRewatchAndEmptyAckLog(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-5555-4555-8555-555555555561"
	dir := t.TempDir()
	writeTranscript(t, filepath.Join(dir, "-home-u-w1", sess+".jsonl"), fixture(t, "claude", "message.jsonl"))
	var logs logBuf
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 20 * time.Millisecond}, TranscriptFlush: 10 * time.Millisecond, MaxTranscriptWatches: 1,
		Log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	b.floor("s1", true, w1, worker("w2", "b", "", "idle"))
	id := workerID(t, c, sess)

	for _, limit := range []int{1, 200, 200} {
		_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Limit: limit})
		if res := decode[proto.TranscriptWatchResult](t, ack); res.Pending || len(res.Items) == 0 {
			t.Fatalf("limit %d: ack = %+v", limit, res)
		}
		if n := b.hub.TranscriptWatches(); n != 1 {
			t.Fatalf("limit %d: %d watches", limit, n)
		}
	}
	if l := logs.lines("transcript watch acked empty"); len(l) != 0 {
		t.Fatalf("logged a full ack as empty: %q", l)
	}

	// A plain shell: pending.
	id2 := ""
	for _, w := range b.connect(proto.Hello{}).snapshot().World.Workers {
		if w.ID != id {
			id2 = w.ID
		}
	}
	c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: id})
	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id2, Limit: 10})
	if res := decode[proto.TranscriptWatchResult](t, ack); !res.Pending {
		t.Fatalf("pending ack = %+v", res)
	}
	l := logs.lines("transcript watch acked empty")
	if len(l) != 1 || !strings.Contains(l[0], "level=DEBUG") || !strings.Contains(l[0], "worker="+id2) ||
		!strings.Contains(l[0], "pending=true") || !strings.Contains(l[0], "items=0") || !strings.Contains(l[0], "limit=10") {
		t.Fatalf("empty ack log = %q", l)
	}
}

// Each watch's first page is logged at debug with what it cost (#126): the
// wait for the log's index, the page's read and the ack's (or, after a
// pending ack, the push's) size, never content.
func TestTranscriptReadLog(t *testing.T) {
	t.Parallel()
	const sess, other = "0a0b0c0d-5555-4555-8555-555555555571", "0a0b0c0d-5555-4555-8555-555555555572"
	dir := t.TempDir()
	writeTranscript(t, filepath.Join(dir, "-home-u-w1", sess+".jsonl"), fixture(t, "claude", "message.jsonl"))
	var logs logBuf
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 20 * time.Millisecond}, TranscriptFlush: 10 * time.Millisecond,
		Log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	w2 := worker("w2", "b", "", "idle")
	b.floor("s1", true, w1, w2)
	id := workerID(t, c, sess)

	_, m := c.command(proto.CmdTranscriptWatch, "rw1", proto.TranscriptWatchArgs{ID: id, Limit: 200})
	var ack proto.Ack
	if err := json.Unmarshal(m.raw, &ack); err != nil || m.env.T != proto.TAck {
		t.Fatalf("ack: %s", m.raw)
	}
	res := decode[proto.TranscriptWatchResult](t, ack)
	l := logs.lines("transcript watch read")
	if len(l) != 1 {
		t.Fatalf("read logs = %q", l)
	}
	for _, f := range []string{"level=DEBUG", "worker=" + id, "child=false", "req_id=rw1", "limit=200",
		fmt.Sprintf("items=%d", len(res.Items)), fmt.Sprintf("bytes=%d", len(m.raw)), "wait_ms=", "page_ms="} {
		if !strings.Contains(l[0], f) {
			t.Errorf("read log lacks %q: %q", f, l[0])
		}
	}

	// A pending watch logs nothing until its transcript appears; then the
	// push it gets is logged.
	id2 := ""
	for _, w := range b.connect(proto.Hello{}).snapshot().World.Workers {
		if w.ID != id {
			id2 = w.ID
		}
	}
	if _, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id2, Limit: 10}); !decode[proto.TranscriptWatchResult](t, ack).Pending {
		t.Fatal("not pending")
	}
	if l := logs.lines("transcript watch read"); len(l) != 1 {
		t.Fatalf("a pending ack logged a read: %q", l)
	}
	writeTranscript(t, filepath.Join(dir, "-home-u-w2", other+".jsonl"), fixture(t, "claude", "user.jsonl"))
	w2.AgentSession, w2.Harness = other, world.HarnessClaude
	b.floor("s1", true, w1, w2)
	p, cl := c.push(id2)
	if cl.Reason != "" || p.TranscriptHead == nil || len(p.Items) == 0 {
		t.Fatalf("appeared: %+v %+v", p, cl)
	}
	l = logs.lines("transcript watch read")
	if len(l) != 2 || !strings.Contains(l[1], "worker="+id2) || !strings.Contains(l[1], `req_id=""`) ||
		!strings.Contains(l[1], fmt.Sprintf("items=%d", len(p.Items))) || strings.Contains(l[1], "bytes=0") {
		t.Fatalf("push read log = %q", l)
	}

	// No transcript text in the logs.
	for _, it := range append(res.Items, p.Items...) {
		for _, part := range it.Parts {
			if len(part.Text) > 8 && strings.Contains(logs.String(), part.Text) {
				t.Errorf("the log has the text of %s", it.ID)
			}
		}
	}
}

// #149: a worker watched again after the usage rounds dropped its watch
// gets its log as kept, with what was appended meanwhile: the read waits
// for no build, and the debug log says reused (with the hit counts), never
// content.
func TestTranscriptReturnVisit(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-1491-4491-8491-149149149151"
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	writeTranscript(t, path, fixture(t, "claude", "message.jsonl"))
	var logs logBuf
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 20 * time.Millisecond}, TranscriptFlush: 10 * time.Millisecond,
		Log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	b.floor("s1", true, w1)
	id := workerID(t, c, sess)
	await := func(msg string, n int) []string {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for len(logs.lines(msg)) < n {
			if time.Now().After(deadline) {
				t.Fatalf("no %q: %s", msg, logs.String())
			}
			time.Sleep(5 * time.Millisecond)
		}
		return logs.lines(msg)
	}

	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})
	cold := decode[proto.TranscriptWatchResult](t, ack)
	c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: id})
	await("transcript log retained", 1)
	appendLine(t, path, fixtureLine(t, "claude", "user.jsonl", 0))
	time.Sleep(60 * time.Millisecond) // a few rounds away

	_, ack = c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})
	back := decode[proto.TranscriptWatchResult](t, ack)
	if len(back.Items) != len(cold.Items)+1 || back.Items[len(back.Items)-1].Kind != proto.ItemUser {
		t.Fatalf("return visit: %d items after %d", len(back.Items), len(cold.Items))
	}
	if l := logs.lines("transcript log built"); len(l) != 1 || !strings.Contains(l[0], "worker="+id) {
		t.Fatalf("built = %q", l)
	}
	r := await("transcript log reused", 1)
	for _, f := range []string{"level=DEBUG", "worker=" + id, "child=false", "idle_ms=", "footprint=", "items=", "reused=1", "built=1"} {
		if !strings.Contains(r[0], f) {
			t.Errorf("reused log lacks %q: %q", f, r[0])
		}
	}
	if l := logs.lines("transcript watch read"); len(l) != 2 || !strings.Contains(l[1], "wait_ms=0") {
		t.Fatalf("read logs = %q", l)
	}
	for _, it := range back.Items {
		for _, part := range it.Parts {
			if len(part.Text) > 8 && strings.Contains(logs.String(), part.Text) {
				t.Errorf("the log has the text of %s", it.ID)
			}
		}
	}
}

// A transcript's pushes never push a connection past half its send queue:
// the watch ends with resync instead (the game watches again), and the
// connection is not dropped as a slow consumer.
func TestTranscriptResync(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-6666-4666-8666-666666666661"
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	writeTranscript(t, path, fixture(t, "claude", "message.jsonl"))
	b := startBridge(t, "", server.Options{Queue: 8, Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 10 * time.Millisecond}, TranscriptFlush: time.Millisecond})
	d := b.direct(t)
	d.read() // welcome
	d.read() // snapshot
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	b.floor("s1", true, w1)
	id := ""
	for id == "" {
		var ev proto.Event
		if _, raw := d.read(); json.Unmarshal(raw, &ev) == nil && ev.T == proto.EvWorkerUpsert {
			id = ev.Worker.ID
		}
	}
	if ack := d.command(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id}); !strings.Contains(string(ack), `"ack"`) {
		t.Fatalf("watch: %s", ack)
	}
	// Fill the queue past half without reading.
	for i := range 5 {
		raw, _ := json.Marshal(proto.TranscriptItemArgs{ID: id, Item: "toolu_018Aah2uHCqF4KbGuUkTSEYa"})
		if err := b.hub.Command(context.Background(), d.c, proto.Command{T: proto.CmdTranscriptItem, ReqID: "i" + string(rune('0'+i)),
			Args: raw}); err != nil {
			t.Fatal(err)
		}
	}
	for deadline := time.Now().Add(5 * time.Second); len(d.c.Send()) < 5; {
		if time.Now().After(deadline) {
			t.Fatalf("queue has %d", len(d.c.Send()))
		}
		time.Sleep(5 * time.Millisecond)
	}
	appendLine(t, path, fixtureLine(t, "claude", "bash.jsonl", 1))
	for deadline := time.Now().Add(5 * time.Second); len(d.c.Send()) < 6; { // what the watch sent
		if time.Now().After(deadline) {
			t.Fatal("the watch sent nothing")
		}
		time.Sleep(5 * time.Millisecond)
	}
	var closed proto.TranscriptClosed
	for deadline := time.Now().Add(5 * time.Second); closed.T == ""; {
		if time.Now().After(deadline) {
			t.Fatal("no transcript.closed")
		}
		select {
		case raw := <-d.c.Send():
			var env proto.Envelope
			_ = json.Unmarshal(raw, &env)
			switch env.T {
			case proto.TTranscriptItems:
				t.Fatalf("pushed past half the queue: %s", raw)
			case proto.TTranscriptClosed:
				_ = json.Unmarshal(raw, &closed)
			}
		case <-time.After(10 * time.Millisecond):
		}
	}
	if closed.Reason != proto.ClosedResync || closed.ID != id || d.wasKicked() != nil {
		t.Fatalf("closed %+v, kicked %v", closed, d.wasKicked())
	}
	// Watching again works.
	if ack := d.command(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id}); !strings.Contains(string(ack), `"ack"`) {
		t.Fatalf("re-watch: %s", ack)
	}
}

// A live Codex worker herdr knows no session of: its transcript is the
// rollout identified by herdr; an identified /new ends the watch with session_changed.
func TestTranscriptCodexRollout(t *testing.T) {
	t.Parallel()
	const (
		first  = "01a0eba4-0119-7e33-915b-1d458317a918"
		second = "01a0eba4-0119-7e33-915b-1d458317a919"
	)
	root := t.TempDir()
	rollout := func(id, name string) string {
		// The fixture's session_meta, with this id and the worker's cwd.
		lines := strings.SplitAfter(fixture(t, "codex", "session.jsonl"), "\n")
		lines[0] = `{"timestamp":"2026-09-29T05:32:46.952Z","type":"session_meta","payload":{"id":"` + id +
			`","cwd":"/home/u/w1","cli_version":"0.158.0"}}` + "\n"
		path := filepath.Join(root, "2026", "09", "29", name+"-"+id+".jsonl")
		writeTranscript(t, path, strings.Join(lines, ""))
		return path
	}
	rollout(first, "rollout-2026-09-29T05-32-46")
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{CodexSessions: root},
		Interval: 20 * time.Millisecond}, TranscriptFlush: 10 * time.Millisecond})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w := worker("w1", "a", first, "working")
	w.AgentKind, w.Harness = "codex", world.HarnessCodex
	b.floor("s1", true, w)
	id := c.until(proto.EvWorkerUpsert).Worker.ID

	_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id, Limit: 3})
	res := decode[proto.TranscriptWatchResult](t, ack)
	visible := 0
	for _, it := range res.Items {
		if !it.Hidden {
			visible++
		}
	}
	if res.Harness != "codex" || res.Session != first || res.Version != "0.158.0" || res.Pending || !res.HasMore || visible != 3 ||
		res.Items[len(res.Items)-1].Notice == nil || res.Items[len(res.Items)-1].Notice.Source != "event_msg/task_complete" {
		t.Fatalf("watch ack = %+v", res)
	}
	rollout(second, "rollout-2026-09-29T06-00-00")
	w.AgentSession = second
	b.floor("s1", true, w)
	if _, cl := c.push(id); cl.Reason != proto.ClosedSessionChanged {
		t.Fatalf("closed = %+v", cl)
	}
	_, ack = c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})
	if res := decode[proto.TranscriptWatchResult](t, ack); res.Session != second {
		t.Fatalf("re-watch = %+v", res)
	}
}

// #192: a directory is not proof that a rollout belongs to a new worker.
func TestTranscriptCodexWaitsForIdentity(t *testing.T) {
	t.Parallel()
	const old = "01a0eba4-0119-7e33-915b-1d458317a910"
	const fresh = "01a0eba4-0119-7e33-915b-1d458317a911"
	for _, tc := range []struct {
		name, label, oldCwd                            string
		identified, delayedFile, sameFloor, otherFloor bool
	}{
		{name: "different name", label: "brand new", oldCwd: "/home/u/w1"},
		{name: "same name", label: "previous name", oldCwd: "/home/u/w1"},
		{name: "other directory", label: "new", oldCwd: "/elsewhere"},
		{name: "identified immediately", label: "new", oldCwd: "/home/u/w1", identified: true},
		{name: "delayed rollout", label: "new", oldCwd: "/home/u/w1", delayedFile: true},
		{name: "same floor", label: "new", oldCwd: "/home/u/w1", sameFloor: true},
		{name: "different floors", label: "new", oldCwd: "/home/u/w1", otherFloor: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			root := t.TempDir()
			rollout := func(session, stamp, cwd, content string) {
				writeTranscript(t, filepath.Join(root, "2026", "09", "29", "rollout-2026-09-29T"+stamp+"-"+session+".jsonl"),
					fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q}}`+"\n"+
						`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":%q}]}}`+"\n", session, cwd, content))
			}
			rollout(old, "05-32-46", tc.oldCwd, "OLD CONVERSATION")
			b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{CodexSessions: root}, Interval: 20 * time.Millisecond}, TranscriptFlush: 10 * time.Millisecond})
			c := b.connect(proto.Hello{})
			c.snapshot()
			w := worker("w1", tc.label, "", "working")
			w.AgentKind, w.Harness = "codex", world.HarnessCodex
			if tc.identified {
				w.AgentSession = fresh
			}
			publish := func() {
				others := []world.WorkerObs{w}
				if tc.sameFloor || tc.otherFloor {
					other := worker("w2", "previous name", old, "working")
					other.AgentKind, other.Harness, other.Cwd = "codex", world.HarnessCodex, "/home/u/w1"
					if tc.sameFloor {
						others = append(others, other)
					} else {
						b.floor("s2", true, other)
					}
				}
				b.floor("s1", true, others...)
			}
			publish()
			id := ""
			for id == "" {
				ev := c.until(proto.EvWorkerUpsert)
				if ev.Worker.Label == tc.label {
					id = ev.Worker.ID
				}
			}
			watch := func(c *client) proto.TranscriptWatchResult {
				_, ack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: id})
				return decode[proto.TranscriptWatchResult](t, ack)
			}
			pending := func() {
				t.Helper()
				res := watch(c)
				if !res.Pending || len(res.Items) != 0 || (res.Session != "" && res.Session != fresh) {
					t.Fatalf("new worker received historical conversation: %+v", res)
				}
			}
			pending()
			if !tc.delayedFile {
				rollout(fresh, "06-00-00", "/home/u/w1", "NEW CONVERSATION")
				// Even a new file is not identity: it could belong to another worker.
				if !tc.identified {
					pending()
				}
			}
			if !tc.identified {
				w.AgentSession = fresh
				publish()
				workerID(t, c, fresh)
			}
			if tc.delayedFile {
				pending()
				rollout(fresh, "06-00-00", "/home/u/w1", "NEW CONVERSATION")
			}
			p, cl := c.push(id)
			var res proto.TranscriptWatchResult
			if cl.Reason == proto.ClosedSessionChanged {
				res = watch(c)
			} else {
				if cl.Reason != "" || p.TranscriptHead == nil {
					t.Fatalf("arrival: %+v %+v", p, cl)
				}
				res = proto.TranscriptWatchResult{TranscriptHead: *p.TranscriptHead, Items: p.Items}
			}
			check := func(res proto.TranscriptWatchResult, session, text string) {
				t.Helper()
				body, _ := json.Marshal(res.Items)
				if res.Pending || res.Session != session || !strings.Contains(string(body), text) {
					t.Fatalf("identified conversation: %+v", res)
				}
				if session == fresh && strings.Contains(string(body), "OLD CONVERSATION") {
					t.Fatal("old content mixed into new session")
				}
			}
			check(res, fresh, "NEW CONVERSATION")
			// Reconnecting uses the explicitly identified session, even if it is historical.
			reconnected := b.connect(proto.Hello{})
			reconnected.snapshot()
			check(watch(reconnected), fresh, "NEW CONVERSATION")
			w.AgentSession = old
			publish()
			workerID(t, c, old)
			if _, cl = c.push(id); cl.Reason != proto.ClosedSessionChanged {
				t.Fatalf("resume close: %+v", cl)
			}
			check(watch(c), old, "OLD CONVERSATION")
			// Replacing the agent at the same worker slot must forget its previous reader.
			w.AgentSession = ""
			publish()
			if _, cl = c.push(id); cl.Reason != proto.ClosedSessionChanged {
				t.Fatalf("replacement close: %+v", cl)
			}
			pending()
		})
	}
}
