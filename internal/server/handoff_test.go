package server_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/handoff"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #223 literal handoffs against the follow-up bridge (w1 Claude, w2 Codex,
// real transcript files the usage tracker reads) with a handoff directory
// and the AI integration's fakes, which must never be called.

type hoBridge struct {
	*fuBridge
	dir string // the handoff directory
}

// hoService is a handoff service on dir and the database at db (the
// bridge opens the same database: one file, shared by path).
func hoService(t *testing.T, dir, db string) *handoff.Service {
	t.Helper()
	st, err := store.Open(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	svc, err := handoff.New(dir, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	return svc
}

func newHoBridge(t *testing.T) *hoBridge {
	t.Helper()
	return newHoBridgeAt(t, filepath.Join(t.TempDir(), "handoff"))
}

func newHoBridgeAt(t *testing.T, dir string) *hoBridge {
	t.Helper()
	return newHoBridgeWith(t, dir, 0)
}

// newHoBridgeWith reads the transcripts every interval (0: the follow-up
// bridge's own, fast one).
func newHoBridgeWith(t *testing.T, dir string, interval time.Duration) *hoBridge {
	t.Helper()
	db := filepath.Join(t.TempDir(), "world.db")
	svc := hoService(t, dir, db)
	off := false // #90 would classify the turn: the action must not, and nothing else may here
	fb := startFuBridgeWith(t, db, "", newFuRoles(), &off, "", func(o *server.Options) {
		if interval > 0 {
			o.Usage.Interval = interval
		}
		o.Handoffs = svc
		o.DigestEnabled = &off
		o.PackupEnabled = &off
		o.ActivityModel = &off
	})
	return &hoBridge{fuBridge: fb, dir: dir}
}

func claudeReply(id, uuid, text, stop string) string {
	b, _ := json.Marshal(map[string]any{"type": "assistant", "isSidechain": false, "uuid": uuid, "requestId": "req_" + id,
		"sessionId": wrapSess, "message": map[string]any{"id": id, "role": "assistant",
			"content": []map[string]any{{"type": "text", "text": text}}, "stop_reason": stop}})
	return string(b) + "\n"
}

const turnDone = `{"type":"system","subtype":"turn_duration","durationMs":5,"isSidechain":false}` + "\n"

func handoffOf(c *client, id string) *proto.Worker {
	c.t.Helper()
	return upsertFor(c, id, func(w *proto.Worker) bool { return w.Handoff != nil })
}

func noPrompts(t *testing.T, hb *hoBridge) {
	t.Helper()
	if cls, llm := hb.roles.calls(); cls != 0 || llm != 0 {
		t.Fatalf("AI calls: classifier %d, LLM %d", cls, llm)
	}
	for _, call := range append(hb.fl.Calls(), hb.term.Calls()...) {
		if strings.HasPrefix(call, "prompt") || strings.HasPrefix(call, "type") || strings.HasPrefix(call, "text") ||
			strings.HasPrefix(call, "submit") || strings.HasPrefix(call, "queue") || strings.HasPrefix(call, "keys") ||
			strings.HasPrefix(call, "seq") {
			t.Fatalf("the worker was sent something: %q", call)
		}
	}
}

// The latest completed Claude reply is offered, previewed and filed whole,
// with no model call and nothing sent to the worker; a repeated submit files
// nothing twice; the cabinet lists, shows, searches and deletes it.
func TestHandoffLiteralClaude(t *testing.T) {
	t.Parallel()
	hb := newHoBridge(t)
	c := hb.connect(proto.Hello{})
	s := c.snapshot()
	if s.World.Handoffs == nil || len(s.World.Handoffs.Counts) != 0 {
		t.Fatalf("cabinet %+v", s.World.Handoffs)
	}
	id := hb.ids["w1"]
	long := strings.Repeat("A line of the report that goes on.\n", 3000) // past the preview
	body := "  # Loader refactor\n\n```go\nfunc main() {}\n```\n\n" + long + "\n  "
	appendTo(t, hb.claude, wrapUser("Refactor the loader.")+claudeReply("msg_1", "u1", body, "end_turn")+turnDone)
	w := handoffOf(c, id)
	cand := *w.Handoff
	if cand.Message != "msg_1" || cand.Session != wrapSess || cand.Harness != "claude" || cand.Bytes != len(body) || cand.Source != proto.CandidateMessage {
		t.Fatalf("candidate %+v", cand)
	}
	_, m := c.command(proto.CmdWorkerHandoffPreview, "p", proto.WorkerHandoffPreviewArgs{Worker: id, Candidate: cand.ID})
	pv := ackData[proto.WorkerHandoffPreviewResult](t, m)
	if !pv.Truncated || len(pv.Text) > proto.HandoffPreviewBytes || !strings.HasPrefix(body, pv.Text) || pv.Title != "Loader refactor" ||
		pv.Provenance.WorkerName != w.Name || pv.Provenance.Branch != w.Branch || !pv.CanSendHome {
		t.Fatalf("preview: %d bytes, %+v", len(pv.Text), pv.Provenance)
	}
	args := proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral, Session: cand.Session, Candidate: cand.ID,
		Revision: cand.Revision, Op: "op-1"}
	evs, m := c.command(proto.CmdWorkerHandoff, "h", args)
	res := ackData[proto.WorkerHandoffResult](t, m)
	if res.Existing || res.SendHome != "" || res.Handoff.Title != "Loader refactor" || res.Handoff.Source != proto.HandoffSourceLiteral {
		t.Fatalf("result %s", m.raw)
	}
	var added *proto.Event
	for i := range evs {
		if evs[i].T == proto.EvHandoffAdded {
			added = &evs[i]
		}
	}
	if added == nil || added.Handoff.ID != res.Handoff.ID || *added.HandoffCount != 1 || added.Session != "s" {
		t.Fatalf("events %+v", evs)
	}
	raw, err := os.ReadFile(res.Handoff.Path)
	if err != nil {
		t.Fatal(err)
	}
	fm, got := handoff.SplitFrontMatter(string(raw))
	if got != body || fm["source"] != "literal" || fm["worker"] != w.Name || fm["session"] != wrapSess || fm["harness"] != "claude" {
		t.Fatalf("file: front matter %v, body %d bytes (want %d)", fm, len(got), len(body))
	}
	if filepath.Dir(res.Handoff.Path) != filepath.Join(hb.dir, "s") {
		t.Fatalf("path %s", res.Handoff.Path)
	}
	// The same submit again (a reconnect): the same handoff, no second file.
	evs, m = c.command(proto.CmdWorkerHandoff, "h2", args)
	again := ackData[proto.WorkerHandoffResult](t, m)
	if !again.Existing || again.Handoff.ID != res.Handoff.ID {
		t.Fatalf("again %s", m.raw)
	}
	for _, ev := range evs {
		if ev.T == proto.EvHandoffAdded {
			t.Fatal("handoff.added twice")
		}
	}
	if files, _ := filepath.Glob(filepath.Join(hb.dir, "s", "*.md")); len(files) != 1 {
		t.Fatalf("files %v", files)
	}
	noPrompts(t, hb)

	// The cabinet.
	_, m = c.command(proto.CmdHandoffList, "l", proto.HandoffListArgs{Floor: "s"})
	list := ackData[proto.HandoffListResult](t, m)
	if len(list.Handoffs) != 1 || list.Handoffs[0].Path != res.Handoff.Path {
		t.Fatalf("list %s", m.raw)
	}
	_, m = c.command(proto.CmdHandoffList, "q", proto.HandoffListArgs{Floor: "s", Q: `refact "OR`})
	list = ackData[proto.HandoffListResult](t, m)
	if len(list.Handoffs) != 0 {
		t.Fatalf("an OR matched: %s", m.raw)
	}
	_, m = c.command(proto.CmdHandoffList, "q2", proto.HandoffListArgs{Floor: "s", Q: "loader"})
	list = ackData[proto.HandoffListResult](t, m)
	if len(list.Handoffs) != 1 || !strings.Contains(list.Handoffs[0].Snippet, "\uE000Loader\uE001") {
		t.Fatalf("search %s", m.raw[:min(len(m.raw), 400)])
	}
	_, m = c.command(proto.CmdHandoffGet, "g", proto.HandoffGetArgs{ID: res.Handoff.ID})
	if g := ackData[proto.HandoffGetResult](t, m); g.Body != body {
		t.Fatalf("get: %d bytes", len(g.Body))
	}
	c.mustError(proto.CmdHandoffDelete, proto.HandoffDeleteArgs{ID: res.Handoff.ID}, proto.ErrConfirmationRequired)
	evs, m = c.command(proto.CmdHandoffDelete, "d", proto.HandoffDeleteArgs{ID: res.Handoff.ID, Confirm: true})
	ackData[proto.HandoffDeleteResult](t, m)
	if !slices.ContainsFunc(evs, func(ev proto.Event) bool {
		return ev.T == proto.EvHandoffRemoved && ev.HandoffID == res.Handoff.ID && *ev.HandoffCount == 0
	}) {
		t.Fatalf("events %+v", evs)
	}
	if _, err := os.Stat(filepath.Join(hb.dir, handoff.TrashDir, "s", filepath.Base(res.Handoff.Path))); err != nil {
		t.Fatalf("trash: %v", err)
	}
	c.mustError(proto.CmdHandoffGet, proto.HandoffGetArgs{ID: res.Handoff.ID}, proto.ErrNotFound)
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHandoff); !row.OK || !row.Done || strings.Contains(row.Result, "report") ||
		!strings.Contains(row.Result, `"bytes":`) {
		t.Fatalf("audit %+v", row)
	}
	noPrompts(t, hb)
}

// A stale or unknown candidate, another mode, a bad operation id: refused,
// nothing filed. A new prompt takes the candidate away.
func TestHandoffRefusals(t *testing.T) {
	t.Parallel()
	hb := newHoBridge(t)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id := hb.ids["w1"]
	appendTo(t, hb.claude, claudeReply("msg_1", "u1", "Done.", "end_turn")+turnDone)
	cand := *handoffOf(c, id).Handoff
	ok := proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral, Session: cand.Session, Candidate: cand.ID,
		Revision: cand.Revision, Op: "op-1"}
	for _, tc := range []struct {
		edit func(*proto.WorkerHandoffArgs)
		code string
	}{
		{func(a *proto.WorkerHandoffArgs) { a.Mode = "llm" }, proto.ErrBadRequest},
		{func(a *proto.WorkerHandoffArgs) { a.Op = "" }, proto.ErrBadRequest},
		{func(a *proto.WorkerHandoffArgs) { a.Op = "../x" }, proto.ErrBadRequest},
		{func(a *proto.WorkerHandoffArgs) { a.Candidate = "0123456789abcdef" }, proto.ErrHandoffUnavailable},
		{func(a *proto.WorkerHandoffArgs) { a.Revision = strings.Repeat("0", 64) }, proto.ErrHandoffUnavailable},
		{func(a *proto.WorkerHandoffArgs) { a.Session = "other" }, proto.ErrHandoffUnavailable},
		{func(a *proto.WorkerHandoffArgs) { a.Worker = "nobody" }, proto.ErrUnknownWorker},
	} {
		a := ok
		tc.edit(&a)
		c.mustError(proto.CmdWorkerHandoff, a, tc.code)
	}
	c.mustError(proto.CmdWorkerHandoff, map[string]any{"worker": id, "mode": "literal", "session": cand.Session, "candidate": cand.ID,
		"revision": cand.Revision, "op": "op-9", "path": "/etc/passwd"}, proto.ErrBadRequest)
	// A genuine prompt: the reply is not the latest any more.
	appendTo(t, hb.claude, wrapUser("Next."))
	upsertFor(c, id, func(w *proto.Worker) bool { return w.Handoff == nil })
	c.mustError(proto.CmdWorkerHandoff, ok, proto.ErrHandoffUnavailable)
	c.mustError(proto.CmdWorkerHandoffPreview, proto.WorkerHandoffPreviewArgs{Worker: id, Candidate: cand.ID}, proto.ErrHandoffUnavailable)
	if files, _ := filepath.Glob(filepath.Join(hb.dir, "*", "*")); len(files) != 0 {
		t.Fatalf("files %v", files)
	}
	noPrompts(t, hb)
}

// The transcript replaced under a candidate the bridge still offers: the
// text is not what it was, and nothing is filed or sent home.
func TestHandoffSourceReplaced(t *testing.T) {
	t.Parallel()
	hb := newHoBridge(t)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id := hb.ids["w1"]
	appendTo(t, hb.claude, claudeReply("msg_1", "u1", "Done.", "end_turn")+turnDone)
	cand := *handoffOf(c, id).Handoff
	// The same bytes in a new file (another inode): the bridge may still
	// offer the old candidate for a round.
	raw, _ := os.ReadFile(hb.claude)
	tmp := hb.claude + ".new"
	os.WriteFile(tmp, []byte(strings.Replace(string(raw), "Done.", "Gone.", 1)), 0o600)
	os.Rename(tmp, hb.claude)
	_, m := c.command(proto.CmdWorkerHandoff, "h", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral,
		Session: cand.Session, Candidate: cand.ID, Revision: cand.Revision, Op: "op-1", SendHome: true})
	var e proto.Error
	_ = json.Unmarshal(m.raw, &e)
	if m.env.T != proto.TError || (e.Code != proto.ErrHandoffSource && e.Code != proto.ErrHandoffUnavailable) {
		t.Fatalf("reply %s", m.raw)
	}
	if files, _ := filepath.Glob(filepath.Join(hb.dir, "*", "*")); len(files) != 0 {
		t.Fatalf("files %v", files)
	}
	time.Sleep(100 * time.Millisecond)
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("herdr calls %q", calls)
	}
}

// A file failure (the floor's directory is a file): handoff_failed, no row,
// and no send home although it was asked.
func TestHandoffFileFailure(t *testing.T) {
	t.Parallel()
	hb := newHoBridge(t)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id := hb.ids["w1"]
	os.MkdirAll(hb.dir, 0o700)
	os.WriteFile(filepath.Join(hb.dir, "s"), []byte("in the way"), 0o600)
	appendTo(t, hb.claude, claudeReply("msg_1", "u1", "Done.", "end_turn")+turnDone)
	cand := *handoffOf(c, id).Handoff
	hb.fl.setProcs("w1:p1", running("claude", wrapSess))
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral, Session: cand.Session,
		Candidate: cand.ID, Revision: cand.Revision, Op: "op-1", SendHome: true}, proto.ErrHandoffFailed)
	time.Sleep(100 * time.Millisecond)
	if calls := hb.fl.Calls(); len(calls) != 0 {
		t.Fatalf("sent home after a failure: %q", calls)
	}
	_, m := c.command(proto.CmdHandoffList, "l", proto.HandoffListArgs{Floor: "s"})
	if l := ackData[proto.HandoffListResult](t, m); len(l.Handoffs) != 0 {
		t.Fatalf("list %s", m.raw)
	}
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHandoff); row.OK || !row.Done || row.Error == "" {
		t.Fatalf("audit %+v", row)
	}
}

// Send home after filing: only once filed, through worker.fire's path; a
// working worker is filed but not sent home.
func TestHandoffSendHome(t *testing.T) {
	t.Parallel()
	hb := newHoBridge(t)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id1, id2 := hb.ids["w1"], hb.ids["w2"]
	hb.fl.setProcs("w1:p1", running("claude", wrapSess))
	appendTo(t, hb.claude, claudeReply("msg_1", "u1", "Done.", "end_turn")+turnDone)
	cand := *handoffOf(c, id1).Handoff
	evs, m := c.command(proto.CmdWorkerHandoff, "h", proto.WorkerHandoffArgs{Worker: id1, Mode: proto.HandoffModeLiteral,
		Session: cand.Session, Candidate: cand.ID, Revision: cand.Revision, Op: "op-1", SendHome: true})
	res := ackData[proto.WorkerHandoffResult](t, m)
	if res.SendHome != proto.HandoffSendStarted {
		t.Fatalf("result %s", m.raw)
	}
	added := slices.IndexFunc(evs, func(ev proto.Event) bool { return ev.T == proto.EvHandoffAdded })
	if added < 0 {
		t.Fatalf("no handoff.added before the ack: %+v", evs)
	}
	eventWhere(c, func(ev proto.Event) bool { return ev.T == proto.EvWorkerRemoved && ev.ID == id1 })
	if calls := hb.fl.Calls(); !slices.Contains(calls, "close w1") || slices.ContainsFunc(calls, func(s string) bool { return strings.HasPrefix(s, "prompt") }) {
		t.Fatalf("herdr calls %q", calls)
	}
	// The fire's audit row ends after worker.removed.
	eventually(t, "the fire's audit row", func() bool {
		row := auditRow(t, hb.bridge, proto.CmdWorkerFire)
		return row.OK && row.Done
	})

	// Codex, at work: filed, not sent home.
	hb.fl.update("w2", func(w *world.WorkerObs) { w.Status = "working" })
	appendTo(t, hb.codex, codexTurn("t1", "msg_c1", "Codex is done.")) // its final_answer
	cw := upsertFor(c, id2, func(w *proto.Worker) bool { return w.Status == "working" && w.Handoff != nil })
	_, m = c.command(proto.CmdWorkerHandoff, "h2", proto.WorkerHandoffArgs{Worker: id2, Mode: proto.HandoffModeLiteral,
		Session: cw.Handoff.Session, Candidate: cw.Handoff.ID, Revision: cw.Handoff.Revision, Op: "op-2", SendHome: true})
	res = ackData[proto.WorkerHandoffResult](t, m)
	if res.SendHome != proto.HandoffSendSkipped || !strings.Contains(res.SendHomeReason, "working") || res.Handoff.Harness != "codex" ||
		cw.Handoff.Message != "msg_c1" {
		t.Fatalf("codex result %s", m.raw)
	}
	b, _ := os.ReadFile(res.Handoff.Path)
	if _, body := handoff.SplitFrontMatter(string(b)); body != "Codex is done." {
		t.Fatalf("codex body %q", body)
	}
}

func codexTurn(turn, item, text string) string {
	line := func(typ string, payload any) string {
		b, _ := json.Marshal(map[string]any{"timestamp": "2026-10-01T09:01:00.000Z", "type": typ, "payload": payload})
		return string(b) + "\n"
	}
	return line("event_msg", map[string]any{"type": "task_started", "turn_id": turn}) +
		line("response_item", map[string]any{"type": "message", "role": "user", "content": []map[string]any{{"type": "input_text", "text": "Go."}}}) +
		line("response_item", map[string]any{"type": "message", "id": "msg_c0", "role": "assistant", "phase": "commentary",
			"content": []map[string]any{{"type": "output_text", "text": "Looking."}}}) +
		line("response_item", map[string]any{"type": "message", "id": item, "role": "assistant", "phase": "final_answer",
			"content": []map[string]any{{"type": "output_text", "text": text}}}) +
		line("event_msg", map[string]any{"type": "task_complete", "turn_id": turn, "last_agent_message": text})
}

// A handoff file a crash left without its row is in the cabinet after the
// restart (the startup reconcile), and counted in the snapshot.
func TestHandoffStartupReconcile(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "handoff")
	os.MkdirAll(filepath.Join(dir, "s"), 0o700)
	at := time.Date(2026, 10, 10, 12, 0, 0, 0, time.Local)
	os.WriteFile(filepath.Join(dir, "s", "20261010-1200-ada-orphan.md"), []byte(handoff.FrontMatter(store.Handoff{Floor: "s",
		WorkerName: "Ada", Source: "literal"}, at)+"# Orphan\nleft by a crash"), 0o600)
	os.WriteFile(filepath.Join(dir, "s", ".handoff-1.tmp"), []byte("half"), 0o600)
	hb := newHoBridgeAt(t, dir)
	s := hb.connect(proto.Hello{}).snapshot()
	if s.World.Handoffs == nil || s.World.Handoffs.Counts["s"] != 1 {
		t.Fatalf("cabinet %+v", s.World.Handoffs)
	}
	c := hb.connect(proto.Hello{})
	c.snapshot()
	_, m := c.command(proto.CmdHandoffList, "l", proto.HandoffListArgs{Floor: "s", Q: "crash"})
	if l := ackData[proto.HandoffListResult](t, m); len(l.Handoffs) != 1 || l.Handoffs[0].Title != "Orphan" || l.Handoffs[0].WorkerName != "Ada" {
		t.Fatalf("list %s", m.raw)
	}
	if _, err := os.Stat(filepath.Join(dir, "s", ".handoff-1.tmp")); !os.IsNotExist(err) {
		t.Fatalf("tmp left: %v", err)
	}
}

// A genuine prompt already in the transcript when the reply is submitted,
// before the bridge's next read (every 2 s, as in production): the reply
// is not the latest any more, nothing is filed or previewed.
func TestHandoffNewPromptBeforeTheRead(t *testing.T) {
	t.Parallel()
	hb := newHoBridgeWith(t, filepath.Join(t.TempDir(), "handoff"), server.DefaultUsageInterval)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id := hb.ids["w1"]
	appendTo(t, hb.claude, wrapUser("Refactor the loader.")+claudeReply("msg_1", "u1", "Previous reply.", "end_turn")+turnDone)
	cand := *handoffOf(c, id).Handoff
	appendTo(t, hb.claude, wrapUser("A new genuine prompt."))
	c.mustError(proto.CmdWorkerHandoffPreview, proto.WorkerHandoffPreviewArgs{Worker: id, Candidate: cand.ID}, proto.ErrHandoffUnavailable)
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral, Session: cand.Session,
		Candidate: cand.ID, Revision: cand.Revision, Op: "op-1"}, proto.ErrHandoffUnavailable)
	if files, _ := filepath.Glob(filepath.Join(hb.dir, "*", "*")); len(files) != 0 {
		t.Fatalf("files %v", files)
	}
	// Refused after the transcript was read again (an audit row that failed);
	// no row only when the bridge's read came first (a rare race).
	if row := auditRow(t, hb.bridge, proto.CmdWorkerHandoff); row.OK || (row.Done != (row.Error != "")) {
		t.Fatalf("audit %+v", row)
	}
	noPrompts(t, hb)
}

// The worker's agent session changed (herdr says so before the bridge reads
// the new transcript): the old session's reply is withdrawn at once and
// refused when submitted.
func TestHandoffWorkerSessionChanged(t *testing.T) {
	t.Parallel()
	hb := newHoBridgeWith(t, filepath.Join(t.TempDir(), "handoff"), server.DefaultUsageInterval)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id := hb.ids["w1"]
	appendTo(t, hb.claude, claudeReply("msg_1", "u1", "Old session reply.", "end_turn")+turnDone)
	cand := *handoffOf(c, id).Handoff
	hb.fl.update("w1", func(w *world.WorkerObs) { w.AgentSession = "new-session" })
	if w := upsertFor(c, id, func(w *proto.Worker) bool { return w.AgentSession == "new-session" }); w.Handoff != nil {
		t.Fatalf("still offered: %+v", w.Handoff)
	}
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral, Session: cand.Session,
		Candidate: cand.ID, Revision: cand.Revision, Op: "op-1"}, proto.ErrHandoffUnavailable)
	c.mustError(proto.CmdWorkerHandoffPreview, proto.WorkerHandoffPreviewArgs{Worker: id, Candidate: cand.ID}, proto.ErrHandoffUnavailable)
	if files, _ := filepath.Glob(filepath.Join(hb.dir, "*", "*")); len(files) != 0 {
		t.Fatalf("files %v", files)
	}
}

// A Codex agent herdr knows no session of: its rollout is found by its cwd,
// and its reply is offered under the session herdr reports (none). When
// herdr reports the same session later, the reply is offered again under it
// and files.
func TestHandoffCodexFoundByCwd(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	dir := filepath.Join(t.TempDir(), "handoff")
	svc := hoService(t, dir, db)
	off := false
	fb := startFuBridgeWith(t, db, "", newFuRoles(), &off, "", func(o *server.Options) {
		o.Handoffs = svc
		o.DigestEnabled, o.PackupEnabled, o.ActivityModel = &off, &off, &off
		o.Usage.FindCodex = func(string, func(string) bool) (string, error) { return wrapCodex, nil }
	})
	c := fb.connect(proto.Hello{})
	c.snapshot()
	id := fb.ids["w2"]
	fb.fl.update("w2", func(w *world.WorkerObs) { w.AgentSession = "" })
	upsertFor(c, id, func(w *proto.Worker) bool { return w.AgentSession == "" })
	appendTo(t, fb.codex, codexTurn("t1", "msg_c1", "Found by cwd."))
	w := handoffOf(c, id)
	if w.AgentSession != "" || w.Handoff.Session != wrapCodex {
		t.Fatalf("agent session %q, candidate %+v", w.AgentSession, w.Handoff)
	}
	cand := *w.Handoff
	_, m := c.command(proto.CmdWorkerHandoffPreview, "p1", proto.WorkerHandoffPreviewArgs{Worker: id, Candidate: cand.ID})
	if got := ackData[proto.WorkerHandoffPreviewResult](t, m); got.Text != "Found by cwd." {
		t.Fatalf("preview %+v", got)
	}

	fb.fl.update("w2", func(w *world.WorkerObs) { w.AgentSession = wrapCodex })
	w = upsertFor(c, id, func(w *proto.Worker) bool { return w.AgentSession == wrapCodex && w.Handoff != nil })
	if *w.Handoff != cand {
		t.Fatalf("offered again as %+v, was %+v", w.Handoff, cand)
	}
	_, m = c.command(proto.CmdWorkerHandoff, "f1", proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral,
		Session: cand.Session, Candidate: cand.ID, Revision: cand.Revision, Op: "op-cwd"})
	if got := ackData[proto.WorkerHandoffResult](t, m); got.Handoff.AgentSession != wrapCodex || got.Existing {
		t.Fatalf("filed %+v", got)
	}
}

// Truncated below what the bridge read and grown again past it (the same
// file): the turn_duration that completed a null stop_reason reply is gone,
// so the reply is not filed and not previewed.
func TestHandoffTruncateRegrow(t *testing.T) {
	t.Parallel()
	hb := newHoBridgeWith(t, filepath.Join(t.TempDir(), "handoff"), server.DefaultUsageInterval)
	c := hb.connect(proto.Hello{})
	c.snapshot()
	id := hb.ids["w1"]
	appendTo(t, hb.claude, claudeReply("msg_1", "u1", "Done.", "")+turnDone)
	cand := *handoffOf(c, id).Handoff
	raw, err := os.ReadFile(hb.claude)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(hb.claude, int64(len(raw)-len(turnDone))); err != nil {
		t.Fatal(err)
	}
	appendTo(t, hb.claude, `{"type":"attachment","isSidechain":false,"attachment":{"type":"date","padding":"`+strings.Repeat("x", len(turnDone))+`"}}`+"\n")
	c.mustError(proto.CmdWorkerHandoffPreview, proto.WorkerHandoffPreviewArgs{Worker: id, Candidate: cand.ID}, proto.ErrHandoffSource)
	c.mustError(proto.CmdWorkerHandoff, proto.WorkerHandoffArgs{Worker: id, Mode: proto.HandoffModeLiteral, Session: cand.Session,
		Candidate: cand.ID, Revision: cand.Revision, Op: "op-regrow"}, proto.ErrHandoffSource)
	if files, _ := filepath.Glob(filepath.Join(hb.dir, "*", "*")); len(files) != 0 {
		t.Fatalf("files %v", files)
	}
}
