package server_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// #184: the Kaneo connection, the floors' Kaneo links and their boards.

const (
	kaneoKey  = "kaneo-fixture-key-0123456789"
	kaneoKey2 = "kaneo-fixture-key-second-987"
	kaneoURL  = "https://tasks.example.test"
)

// lockedBuffer is a log sink the hub and the test share.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

type kaneoBridge struct {
	*boardBridge
	conn *kaneoconf.FakeConnector
	svc  *kaneoconf.Service
	logs *lockedBuffer
	file string
}

func startKaneoBridge(t *testing.T) *kaneoBridge {
	t.Helper()
	kb := &kaneoBridge{logs: &lockedBuffer{}, file: filepath.Join(t.TempDir(), "kaneo.json"),
		conn: &kaneoconf.FakeConnector{Key: kaneoKey,
			WorkspaceList: []kaneoconf.Workspace{{ID: "ws1", Name: "Studio"}, {ID: "ws2", Name: "Home"}},
			ProjectList: []kaneoconf.Project{
				{ID: "p1", WorkspaceID: "ws1", Name: "Herdr", Slug: "HRD"},
				{ID: "p2", WorkspaceID: "ws2", Name: "Garden", Slug: "GDN"},
				{ID: "p3", WorkspaceID: "ws1", Name: "Old", Slug: "OLD", Archived: true},
			}}}
	kb.boardBridge = startBoardBridge(t, func(o *server.Options) {
		svc, err := kaneoconf.New(kaneoconf.Options{File: kb.file, Connector: kb.conn, Now: o.Now})
		if err != nil {
			t.Fatal(err)
		}
		kb.svc, o.Kaneo = svc, svc
		o.Log = slog.New(slog.NewTextHandler(kb.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	})
	return kb
}

// connect tests and saves the connection with key.
func (kb *kaneoBridge) saveConnection(key string) {
	kb.t.Helper()
	kb.c.mustAck(proto.CmdKaneoTest, proto.KaneoTestArgs{URL: ptr(kaneoURL), Key: ptr(key)})
	kb.c.mustAck(proto.CmdKaneoSet, proto.KaneoSetArgs{URL: ptr(kaneoURL), Key: ptr(key), DefaultWorkspace: proto.Some("ws1")})
}

// linkKaneo makes floor "s" a Kaneo floor of project p1.
func (kb *kaneoBridge) linkKaneo() {
	kb.t.Helper()
	kb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo),
		Kaneo: proto.Some(proto.KaneoLinkArgs{WorkspaceID: "ws1", ProjectID: "p1"})})
}

// noKey fails when the key is anywhere the bridge writes: the log, the
// audit log, the database's board caches.
func (kb *kaneoBridge) noKey(keys ...string) {
	kb.t.Helper()
	audit, err := kb.st.AuditLog(context.Background())
	if err != nil {
		kb.t.Fatal(err)
	}
	auditJSON, _ := json.Marshal(audit)
	caches, _ := kb.st.BoardCaches(context.Background())
	cacheJSON, _ := json.Marshal(caches)
	for _, k := range keys {
		for what, text := range map[string]string{"the log": kb.logs.String(), "the audit log": string(auditJSON), "the board caches": string(cacheJSON)} {
			if strings.Contains(text, k) {
				kb.t.Errorf("a key is in %s", what)
			}
		}
	}
}

func TestKaneoConnectionCommands(t *testing.T) {
	kb := startKaneoBridge(t)
	c := kb.c
	_, ack := c.mustAck(proto.CmdKaneoGet, nil)
	if v := ack.Data.(map[string]any); v["state"] != "off" || v["available"] != true || v["key_set"] != false {
		t.Fatalf("kaneo.get = %v", v)
	}
	c.mustError(proto.CmdKaneoTest, proto.KaneoTestArgs{URL: ptr(kaneoURL)}, proto.ErrKeyRequired)
	c.mustError(proto.CmdKaneoTest, proto.KaneoTestArgs{URL: ptr("ftp://tasks.example.test"), Key: ptr(kaneoKey)}, proto.ErrBadURL)
	c.mustError(proto.CmdKaneoTest, proto.KaneoTestArgs{URL: ptr(kaneoURL), Key: ptr("wrong-key-0000")}, proto.ErrUnauthorized)
	c.mustError(proto.CmdKaneoSet, proto.KaneoSetArgs{URL: ptr(kaneoURL), Key: ptr(kaneoKey)}, "test_required")
	c.mustError(proto.CmdKaneoWorkspaces, nil, proto.ErrNotConfigured)

	_, m := c.command(proto.CmdKaneoTest, "t1", proto.KaneoTestArgs{URL: ptr(kaneoURL + "/api"), Key: ptr(kaneoKey)})
	res := ackData[proto.KaneoTestResult](t, m)
	if !res.OK || res.APIBase != kaneoURL+"/api" || res.WebOrigin != kaneoURL || len(res.Workspaces) != 2 || res.Workspaces[0].Name != "Studio" {
		t.Fatalf("kaneo.test = %+v", res)
	}
	if strings.Contains(string(m.raw), kaneoKey) {
		t.Fatal("the test's ack holds the key")
	}
	if v := kb.svc.View(); v.State != "off" {
		t.Fatalf("a passing test saved: %+v", v)
	}
	// The default must be one the test found.
	c.mustError(proto.CmdKaneoSet, proto.KaneoSetArgs{URL: ptr(kaneoURL), Key: ptr(kaneoKey), DefaultWorkspace: proto.Some("nope")}, proto.ErrBadRequest)
	_, m = c.command(proto.CmdKaneoSet, "s1", proto.KaneoSetArgs{URL: ptr(kaneoURL), Key: ptr(kaneoKey), DefaultWorkspace: proto.Some("ws2")})
	if m.env.T != proto.TAck || strings.Contains(string(m.raw), kaneoKey) {
		t.Fatalf("kaneo.set = %s", m.raw)
	}
	// Every client hears of it: a kaneo.update with key_set, never the key.
	other := kb.connect(proto.Hello{})
	snap := other.snapshot()
	if snap.World.Kaneo == nil || snap.World.Kaneo.State != "ready" || !snap.World.Kaneo.KeySet || snap.World.Kaneo.DefaultWorkspace == nil ||
		snap.World.Kaneo.DefaultWorkspace.Name != "Home" {
		t.Fatalf("snapshot kaneo = %+v", snap.World.Kaneo)
	}
	rawSnap, _ := json.Marshal(snap)
	if strings.Contains(string(rawSnap), kaneoKey) {
		t.Fatal("the snapshot holds the key")
	}
	upd := c.untilMsg(proto.EvKaneoUpdate)
	if !strings.Contains(string(upd.raw), `"key_set":true`) || strings.Contains(string(upd.raw), kaneoKey) || upd.env.Seq == 0 {
		t.Fatalf("kaneo.update = %s", upd.raw)
	}

	// The saved key is only ever sent to the saved instance.
	c.mustError(proto.CmdKaneoTest, proto.KaneoTestArgs{URL: ptr("https://elsewhere.example.test")}, proto.ErrKeyRequired)
	c.mustAck(proto.CmdKaneoTest, proto.KaneoTestArgs{})
	for _, call := range kb.conn.Calls() {
		if call.Key == kaneoKey && call.APIBase != kaneoURL+"/api" {
			t.Fatalf("the saved key went to %s", call.APIBase)
		}
	}
	_, m = c.command(proto.CmdKaneoProjects, "p", proto.KaneoProjectsArgs{WorkspaceID: "ws1"})
	if ps := ackData[proto.KaneoProjectsResult](t, m); len(ps.Projects) != 1 || ps.Projects[0].ID != "p1" || ps.Generation != 1 {
		t.Fatalf("kaneo.projects = %+v", ps)
	}

	// The audit rows say a key was given, never which.
	for _, cmd := range []string{proto.CmdKaneoTest, proto.CmdKaneoSet} {
		rows := auditRows(t, kb.boardBridge, cmd)
		if len(rows) == 0 {
			t.Fatalf("no audit rows of %s", cmd)
		}
		given := false
		for _, r := range rows {
			given = given || strings.Contains(string(r.Args), `"key_given":true`)
		}
		if !given {
			t.Errorf("no %s audit row says a key was given", cmd)
		}
	}
	kb.noKey(kaneoKey, "wrong-key-0000")

	// Disconnecting removes it.
	c.mustAck(proto.CmdKaneoClear, nil)
	if v := kb.svc.View(); v.State != "off" || v.KeySet || v.Generation != 2 {
		t.Fatalf("after kaneo.clear: %+v", v)
	}
}

// A floor's Kaneo link is checked with Kaneo before it is saved, and the
// GitHub settings and the Kaneo link survive switching between them.
func TestKaneoFloorSettings(t *testing.T) {
	kb := startKaneoBridge(t)
	c := kb.c
	link := func(ws, project string) proto.FloorSettingsArgs {
		return proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo), Kaneo: proto.Some(proto.KaneoLinkArgs{WorkspaceID: ws, ProjectID: project})}
	}
	c.mustError(proto.CmdFloorSettings, link("ws1", "p1"), proto.ErrNotConfigured)
	kb.saveConnection(kaneoKey)
	c.mustError(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo)}, proto.ErrBadRequest)
	c.mustError(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some("jira")}, proto.ErrBadRequest)
	c.mustError(proto.CmdFloorSettings, link("ws1", "p2"), proto.ErrBadRequest) // another workspace's project
	c.mustError(proto.CmdFloorSettings, link("ws1", "p3"), proto.ErrBadRequest) // archived
	c.mustError(proto.CmdFloorSettings, link("ws1", "gone"), proto.ErrNotFound) // deleted

	// A GitHub floor first: its repo and project stay through the switch.
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"),
		Project: proto.Some(proto.Project{Owner: "JeffreyVdb", Number: 3})})
	evs, _ := c.mustAck(proto.CmdFloorSettings, link("ws1", "p1"))
	var got *proto.FloorSettings
	for _, ev := range evs {
		if ev.T == proto.EvFloorUpsert && ev.Floor.Session == "s" {
			got = ev.Floor.Settings
		}
	}
	if got == nil || got.Tracker != "kaneo" || got.Kaneo == nil || *got.Kaneo != (proto.KaneoLink{WorkspaceID: "ws1", WorkspaceName: "Studio", ProjectID: "p1", ProjectName: "Herdr"}) ||
		got.Repo != "JeffreyVdb/lab" || got.Project == nil {
		t.Fatalf("settings = %+v", got)
	}
	// Back to GitHub: the Kaneo link stays, inactive.
	evs, _ = c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerGitHub)})
	for _, ev := range evs {
		if ev.T == proto.EvFloorUpsert && ev.Floor.Session == "s" {
			got = ev.Floor.Settings
		}
	}
	if got.Tracker != "" || got.Kaneo == nil || got.Kaneo.ProjectID != "p1" || got.Project == nil {
		t.Fatalf("settings after switching back = %+v", got)
	}
	// Switching to Kaneo again checks the kept link again (it may be gone).
	n := len(kb.conn.Calls())
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo)})
	if calls := kb.conn.Calls(); len(calls) == n || calls[n].Op != "project" || calls[n].Arg != "p1" {
		t.Fatalf("switching to Kaneo did not check the project: %+v", calls[n:])
	}
	// A save that does not touch the link asks Kaneo nothing.
	n = len(kb.conn.Calls())
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some("/home/u")})
	if len(kb.conn.Calls()) != n {
		t.Fatal("a save that kept the link called Kaneo")
	}
	// The global default moving does not move the floor.
	c.mustAck(proto.CmdKaneoTest, proto.KaneoTestArgs{})
	c.mustAck(proto.CmdKaneoSet, proto.KaneoSetArgs{DefaultWorkspace: proto.Some("ws2")})
	snap := kb.connect(proto.Hello{}).snapshot()
	for _, f := range snap.World.Floors {
		if f.Session == "s" && (f.Settings.Kaneo == nil || f.Settings.Kaneo.WorkspaceID != "ws1") {
			t.Fatalf("floor settings after the default moved = %+v", f.Settings)
		}
	}
	kb.noKey(kaneoKey)
}

// A Kaneo floor has its issue board without a repository; with one it
// also has that repository's pull requests. The fetch's name never holds
// the key.
func TestKaneoBoardWithAndWithoutRepo(t *testing.T) {
	kb := startKaneoBridge(t)
	tr := kb.fb.kaneoTracker("p1", 1)
	tr.board.Cards = []tracker.Card{card("t1", "HRD-1", "First", "to-do"), card("t2", "HRD-2", "Later", "planned")}
	tr.board.Cards[0].UpdatedAt = 0
	tr.board.Truncated = true
	w := kb.watcher()
	if res := w.watch("s"); res.Enabled || res.Reason != "no repo linked" {
		t.Fatalf("watch of an unlinked floor = %+v", res)
	}
	kb.saveConnection(kaneoKey)
	kb.linkKaneo()
	if res := w.watch("s"); !res.Enabled {
		t.Fatalf("watch of a Kaneo floor = %+v", res)
	}
	var is proto.BoardIssues
	for is.FetchedAt == 0 {
		is = w.issues()
	}
	if is.Provider != "kaneo" || is.ProviderName != "Kaneo" || !is.Truncated || len(is.Cards) != 2 || is.Cards[0].UpdatedAt != 0 ||
		len(is.Columns) != 4 || is.Columns[2].Kind != "planned" || is.Columns[3].Kind != "archived" || is.Capabilities.Close {
		t.Fatalf("kaneo board = %+v", is)
	}
	w.quiet(50 * time.Millisecond) // no pull request board without a repo

	_, host := kb.fb.repo("JeffreyVdb/lab")
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#31", "#31", "Kaneo boards", "feat/184", "success")}
	kb.link("JeffreyVdb/lab")
	for {
		m := w.next()
		if m.env.T != proto.TBoardPRs {
			continue
		}
		var ps proto.BoardPRs
		if err := json.Unmarshal(m.raw, &ps); err != nil {
			t.Fatal(err)
		}
		if ps.FetchedAt != 0 && len(ps.PRs) == 1 {
			break
		}
	}
	if res := w.watch("s"); !res.Enabled {
		t.Fatal("the Kaneo floor with a repo lost its board")
	}
	if is := w.issues(); is.Provider != "kaneo" {
		t.Fatalf("issues of a Kaneo floor with a repo come from %s", is.Provider)
	}
	raw, _ := json.Marshal(kb.fb.seen)
	keys := strings.Join(kb.fb.keys, " ")
	if strings.Contains(string(raw), kaneoKey) || strings.Contains(keys, kaneoKey) || !strings.Contains(keys, "g1") {
		t.Fatalf("the board's source or key holds the key, or no generation: %s", keys)
	}
	kb.noKey(kaneoKey)
}

// A Kaneo floor's pull requests are GitHub's: their rate reading is shown
// with them (not Kaneo's, which has none), and a refusal of the code host
// is not Kaneo refusing its key: no pause.
func TestKaneoFloorPullRequestsKeepTheirOwnGate(t *testing.T) {
	kb := startKaneoBridge(t)
	tr := kb.fb.kaneoTracker("p1", 1)
	tr.board.Cards = []tracker.Card{card("t1", "HRD-1", "First", "to-do")}
	_, host := kb.fb.repo("JeffreyVdb/lab")
	reset := kb.clk.Now().Add(time.Hour).UnixMilli()
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#31", "#31", "Kaneo boards", "feat/184", "success")}
	host.board.Rate = &provider.Rate{Remaining: 4000, Limit: 5000, ResetAt: reset, Cost: 1}
	kb.saveConnection(kaneoKey)
	kb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo),
		Kaneo: proto.Some(proto.KaneoLinkArgs{WorkspaceID: "ws1", ProjectID: "p1"}), Repo: proto.Some("JeffreyVdb/lab")})
	w := kb.watcher()
	w.watch("s")
	is, ps := w.pair()
	for is.FetchedAt == 0 || ps.FetchedAt == 0 {
		is, ps = w.pair()
	}
	if is.Rate != nil || ps.Rate == nil || ps.Rate.Remaining != 4000 {
		t.Fatalf("rates: issues %+v, pull requests %+v", is.Rate, ps.Rate)
	}
	host.set(func(f *fakeHost) { f.err = provider.Errorf(provider.ErrUnauthorized, "gh: not logged in") })
	kb.clk.Advance(61 * time.Second)
	for !is.Stale {
		is, _ = w.pair()
	}
	if is.PausedUntil != 0 || kb.svc.View().State != kaneoconf.StateReady {
		t.Fatalf("the code host's refusal paused Kaneo: %+v, %s", is, kb.svc.View().State)
	}
}

// A new key (a new generation) drops the floor's board: a poll that was in
// flight with the old one is never shown, and the store keeps the new one.
func TestKaneoNewConnectionDropsBoardAndLateResults(t *testing.T) {
	kb := startKaneoBridge(t)
	old, fresh := kb.fb.kaneoTracker("p1", 1), kb.fb.kaneoTracker("p1", 2)
	old.board.Cards = []tracker.Card{card("old", "HRD-1", "Old key", "to-do")}
	fresh.board.Cards = []tracker.Card{card("new", "HRD-1", "New key", "to-do")}
	kb.saveConnection(kaneoKey)
	kb.linkKaneo()
	kb.polled("s")
	w := kb.watcher()
	w.watch("s")
	if is := w.issues(); len(is.Cards) != 1 || is.Cards[0].ID != "old" {
		t.Fatalf("first board = %+v", is)
	}
	old.set(func(f *fakeTracker) { f.gate = make(chan struct{}) })
	kb.clk.Advance(11 * time.Second)
	_, m := w.command(proto.CmdBoardRefresh, "r", proto.BoardArgs{Session: "s"})
	if res := ackData[proto.BoardRefreshResult](t, m); !res.Queued {
		t.Fatal("the refresh did not start a poll")
	}
	eventually(t, "the held poll", func() bool { return old.Polls() >= 2 })
	kb.conn.Set(func(f *kaneoconf.FakeConnector) { f.Key = kaneoKey2 })
	kb.saveConnection(kaneoKey2)
	old.set(func(f *fakeTracker) { close(f.gate); f.gate = nil })
	for {
		is := w.issues()
		if len(is.Cards) == 1 && is.Cards[0].ID == "old" {
			t.Fatalf("a board of the old key was shown after the new one was saved: %+v", is)
		}
		if is.FetchedAt != 0 && len(is.Cards) == 1 && is.Cards[0].ID == "new" {
			break
		}
	}
	w.quiet(50 * time.Millisecond)
	caches, _ := kb.st.BoardCaches(context.Background())
	if c := caches["s"]; !strings.HasSuffix(c.Source, ":g2") || strings.Contains(string(c.Issues), `"old"`) {
		t.Fatalf("stored cache = %s %s", c.Source, c.Issues)
	}
}

// Kaneo refusing the key at run time (a bad key, or its quota) stops the
// Kaneo floors' polling for the cooldown: the board says so, refreshes do
// not poll, and a passing re-test of the saved connection resumes at once.
func TestKaneoUnauthorizedPausesPolling(t *testing.T) {
	kb := startKaneoBridge(t)
	tr := kb.fb.kaneoTracker("p1", 1)
	kb.saveConnection(kaneoKey)
	tr.set(func(f *fakeTracker) { f.err = provider.Errorf(provider.ErrUnauthorized, "kaneo: 401 Unauthorized") })
	kb.linkKaneo()
	w := kb.watcher()
	w.watch("s")
	var is proto.BoardIssues
	for !is.Stale {
		is = w.issues()
	}
	want := kb.clk.Now().Add(kaneoconf.DefaultCooldown).UnixMilli()
	if is.ErrorCode != proto.ErrUnauthorized || is.PausedUntil != want {
		t.Fatalf("stale board = %+v", is)
	}
	eventually(t, "the paused state", func() bool { return kb.svc.View().State == kaneoconf.StatePaused })
	polls := tr.Polls()
	kb.clk.Advance(2 * time.Minute) // a watched floor polls every minute, but not now
	w.quiet(100 * time.Millisecond)
	kb.clk.Advance(11 * time.Second)
	_, m := w.command(proto.CmdBoardRefresh, "r", proto.BoardArgs{Session: "s"})
	if res := ackData[proto.BoardRefreshResult](t, m); res.Queued {
		t.Fatal("a refresh polled a paused floor")
	}
	if tr.Polls() != polls {
		t.Fatalf("a paused floor was polled: %d → %d", polls, tr.Polls())
	}
	// The quota is back; the re-test of the saved connection resumes polling.
	tr.set(func(f *fakeTracker) { f.err = nil })
	kb.c.mustAck(proto.CmdKaneoTest, proto.KaneoTestArgs{})
	eventually(t, "the poll after the re-test", func() bool { return tr.Polls() > polls })
	for is.Stale {
		is = w.issues()
	}
	if is.ErrorCode != "" || is.PausedUntil != 0 || kb.svc.View().State != kaneoconf.StateReady {
		t.Fatalf("board after the re-test = %+v, state %s", is, kb.svc.View().State)
	}

	// Refused again: this time the cooldown runs out by itself.
	tr.set(func(f *fakeTracker) { f.err = provider.Errorf(provider.ErrUnauthorized, "kaneo: 401 Unauthorized") })
	kb.clk.Advance(61 * time.Second)
	for !is.Stale {
		is = w.issues()
	}
	if kb.svc.View().State != kaneoconf.StatePaused {
		t.Fatal("the second 401 did not pause")
	}
	polls = tr.Polls()
	kb.clk.Advance(4 * time.Minute)
	w.quiet(100 * time.Millisecond)
	if tr.Polls() != polls {
		t.Fatal("polled within the cooldown")
	}
	kb.clk.Advance(2 * time.Minute)
	eventually(t, "the poll after the cooldown", func() bool { return tr.Polls() > polls })
	kb.noKey(kaneoKey)
}

// A Kaneo item's 403 on a command is a permission problem, not a failure.
func TestKaneoForbiddenCommand(t *testing.T) {
	kb := startKaneoBridge(t)
	tr := kb.fb.kaneoTracker("p1", 1)
	tr.board.Cards = []tracker.Card{card("t1", "HRD-1", "First", "to-do")}
	tr.failOn["comment"] = provider.Errorf(provider.ErrForbidden, "kaneo: 403")
	kb.saveConnection(kaneoKey)
	kb.linkKaneo()
	kb.polled("s")
	kb.c.mustError(proto.CmdIssueComment, proto.CommentArgs{Session: "s", ID: "t1", Body: "hi"}, proto.ErrForbidden)
	kb.c.mustError(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "s", ID: "t1", Reason: "completed", Confirm: true}, proto.ErrUnsupported)
}

// "Hand to a worker" on a Kaneo task: the run's ticket is the item
// resolved through the tracker (key, title, URL, description), its prompt
// inlines them and sends nobody to gh, the launch record keeps
// {provider, id} (never a repo or number), and the orchestrator and its
// crew carry the item, not a GitHub issue.
func TestKaneoRunWorkItem(t *testing.T) {
	kb := startKaneoBridge(t)
	tr := kb.fb.kaneoTracker("p1", 1)
	url := kaneoURL + "/dashboard/workspace/ws1/project/p1/task/t1"
	c1 := card("t1", "HRD-12", "Kaneo boards", "to-do")
	c1.URL = url
	tr.board.Cards = []tracker.Card{c1}
	tr.detail = tracker.Detail{Card: c1, Body: "Make the floor read Kaneo.\n\n" + strings.Repeat("Details. ", 1000)}
	kb.git.repos["/home/u/lab"] = "/home/u/lab"
	kb.saveConnection(kaneoKey)
	kb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo),
		Kaneo: proto.Some(proto.KaneoLinkArgs{WorkspaceID: "ws1", ProjectID: "p1"}), DefaultCwd: proto.Some("/home/u/lab")})
	kb.polled("s")
	decorateRoles(kb.boardBridge)
	item := &proto.WorkItemRef{Provider: "kaneo", ID: "t1"}

	_, m := kb.c.command(proto.CmdRunPrepare, "p", proto.RunPrepareArgs{Session: "s", WorkItem: item})
	res := ackData[proto.RunPrepareResult](t, m)
	if res.Ticket == nil || res.Ticket.Kind != proto.TicketItem || res.Ticket.Item == nil || res.Ticket.Item.Key != "HRD-12" ||
		res.Ticket.Item.URL != url || res.Ticket.Repo != "" || res.Ticket.Number != 0 || res.Label != "ORCH|hrd-12" {
		t.Fatalf("prepare = %+v (ticket %+v)", res, res.Ticket)
	}
	for _, want := range []string{"/write-code Kaneo task HRD-12: Kaneo boards\n" + url + "\n\nMake the floor read Kaneo.",
		"[The description goes on in Kaneo; this is its first part.]", "not a GitHub issue", "Don't look it up with gh"} {
		if !strings.Contains(res.Prompt, want) {
			t.Errorf("the prompt lacks %q", want)
		}
	}
	if strings.Contains(res.Prompt, statusLine) || strings.Contains(res.Prompt, "github.com") || strings.Contains(string(m.raw), kaneoKey) {
		t.Fatalf("prompt = %q", res.Prompt)
	}
	kb.c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", WorkItem: &proto.WorkItemRef{Provider: "kaneo", ID: "elsewhere"}}, proto.ErrNotFound)
	kb.c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", WorkItem: &proto.WorkItemRef{Provider: "github", ID: "t1"}}, proto.ErrNotFound)

	preset := kb.connect(proto.Hello{}).snapshot().World.Presets[0].ID
	desk := 1
	evs, m := kb.c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, WorkItem: item, Orch: &buildTeam.Orch, Preset: preset})
	start := ackData[proto.RunStartResult](t, m)
	l, ok, err := kb.st.RunLaunchByWorker(t.Context(), start.ID)
	if err != nil || !ok || l.ItemProvider != "kaneo" || l.ItemID != "t1" || l.ItemKey != "HRD-12" || l.Repo != "" || l.IssueNumber != 0 || l.TicketText != "" {
		t.Fatalf("run_launch = %+v %v %v", l, ok, err)
	}
	var orch *proto.Worker
	for _, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == start.ID && ev.Worker.WorkItem != nil {
			orch = ev.Worker
		}
	}
	if orch == nil || orch.Issue != nil || *orch.WorkItem != (proto.WorkItemRef{Provider: "kaneo", ID: "t1", Key: "HRD-12", Title: "Kaneo boards", URL: url}) {
		t.Fatalf("the orchestrator's link before the ack: %+v", orch)
	}
	kb.noKey(kaneoKey)
}

// healthzOpenHosts reads the open-hosts header of the bridge's /healthz.
func healthzOpenHosts(t *testing.T, sock string) string {
	t.Helper()
	hc := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", sock)
	}}}
	resp, err := hc.Get("http://herdr-world/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp.Header.Get(proto.OpenHostsHeader)
}

// The bridge names its Kaneo instance's web host to the Mac helper on
// /healthz (its own socket, never a client), only while one is saved.
func TestKaneoOpenHostOnHealthz(t *testing.T) {
	kb := startKaneoBridge(t)
	if h := healthzOpenHosts(t, kb.sock); h != "" {
		t.Fatalf("open hosts before a connection = %q", h)
	}
	kb.saveConnection(kaneoKey)
	if h := healthzOpenHosts(t, kb.sock); h != "tasks.example.test" {
		t.Fatalf("open hosts = %q", h)
	}
	kb.c.mustAck(proto.CmdKaneoClear, nil)
	if h := healthzOpenHosts(t, kb.sock); h != "" {
		t.Fatalf("open hosts after clear = %q", h)
	}
}
