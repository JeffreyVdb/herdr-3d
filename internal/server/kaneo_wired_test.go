package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/app"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneo/kaneotest"
	"github.com/JeffreyVdb/herdr-3d/internal/kaneoconf"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #184 end to end: the hub with the app's real wiring (app.Kaneo,
// app.Boards: internal/kaneo's client and tracker behind kaneoconf and the
// board factory) against a fake Kaneo instance over HTTP (kaneotest, the
// provider's fixtures), and GitHub's pull requests through a faked gh.

const wiredKey = "kn_wired_SECRET_0123456789abcdef"

// wiredRepo is the repository of the gh fixture without a project.
const wiredRepo = "JeffreyVdb/h3d-lab"

type wiredBridge struct {
	*boardBridge
	kn   *kaneotest.Server
	svc  *kaneoconf.Service
	logs *lockedBuffer
	file string
}

// startWired starts a bridge on db ("": a new one) wired like the world
// command, its Kaneo settings in file, against the fake instance kn.
func startWired(t *testing.T, kn *kaneotest.Server, db, file string, clk *boardClock, workers ...world.WorkerObs) *wiredBridge {
	t.Helper()
	feed, err := os.ReadFile(filepath.Join("..", "github", "testdata", "feed-noproject.json"))
	if err != nil {
		t.Fatal(err)
	}
	gh := func(_ context.Context, argv []string, stdin []byte) ([]byte, []byte, error) {
		var req struct {
			Query string `json:"query"`
		}
		if err := json.Unmarshal(stdin, &req); err != nil || req.Query != githubcli.Text(githubcli.DocFeed) {
			t.Errorf("gh: unexpected %.60s", stdin)
		}
		return feed, nil, nil
	}
	wb := &wiredBridge{kn: kn, logs: &lockedBuffer{}, file: file}
	wb.boardBridge = &boardBridge{fb: newFakeBoards(), clk: clk}
	wb.hireBridge = startHireBridgeAt(t, db, func(o *server.Options) {
		o.Now = clk.Now
		o.BoardTick = 3 * time.Millisecond
		svc, floors, err := app.Kaneo(kaneoconf.Options{File: file, Now: clk.Now})
		if err != nil {
			t.Fatal(err)
		}
		wb.svc, o.Kaneo = svc, svc
		o.Boards = app.Boards(&githubcli.Client{Bin: "gh", Run: gh}, clk.Now, floors)
		o.Log = slog.New(slog.NewTextHandler(wb.logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	}, workers...)
	return wb
}

// saveConnection tests the unsaved draft of the fake instance and saves it.
func (wb *wiredBridge) saveConnection() {
	wb.t.Helper()
	wb.c.mustAck(proto.CmdKaneoTest, proto.KaneoTestArgs{URL: ptr(wb.kn.URL), Key: ptr(wiredKey)})
	wb.c.mustAck(proto.CmdKaneoSet, proto.KaneoSetArgs{URL: ptr(wb.kn.URL), Key: ptr(wiredKey), DefaultWorkspace: proto.Some("ws_1")})
}

// noKey fails when the key is in anything the bridge said or wrote: what
// the clients read (acks, errors, events, snapshots, boards), the log, the
// audit log and the board caches.
func (wb *wiredBridge) noKey(clients ...*client) {
	wb.t.Helper()
	audit, err := wb.st.AuditLog(context.Background())
	if err != nil {
		wb.t.Fatal(err)
	}
	auditJSON, _ := json.Marshal(audit)
	caches, _ := wb.st.BoardCaches(context.Background())
	cacheJSON, _ := json.Marshal(caches)
	texts := map[string]string{"the log": wb.logs.String(), "the audit log": string(auditJSON), "the board caches": string(cacheJSON)}
	for i, c := range clients {
		texts[fmt.Sprintf("what client %d read", i)] = c.heard.String()
		if c.heard.Len() == 0 {
			wb.t.Errorf("client %d read nothing", i)
		}
	}
	for what, text := range texts {
		if strings.Contains(text, wiredKey) || strings.Contains(text, "SECRET") {
			wb.t.Errorf("the key is in %s", what)
		}
	}
}

// boardReads is how many board pages the fake served.
func (wb *wiredBridge) boardReads() int { return wb.kn.Count("GET", "/task/tasks/pr_1") }

// The settings, a floor's link, its board, the writes and the recovery from
// a refused key, through the real wiring.
func TestKaneoWiredEndToEnd(t *testing.T) {
	t.Parallel()
	kn := kaneotest.New(t, wiredKey)
	wb := startWired(t, kn, "", filepath.Join(t.TempDir(), "kaneo.json"), newBoardClock())
	c := wb.c

	// The test of an unsaved draft: the URL as its /api base, the key typed.
	_, m := c.command(proto.CmdKaneoTest, "t1", proto.KaneoTestArgs{URL: ptr(kn.URL + "/api"), Key: ptr("kn_wrong")})
	if m.env.T != proto.TError || !strings.Contains(string(m.raw), `"unauthorized"`) {
		t.Fatalf("a wrong key: %s", m.raw)
	}
	_, m = c.command(proto.CmdKaneoTest, "t2", proto.KaneoTestArgs{URL: ptr(kn.URL + "/api"), Key: ptr(wiredKey)})
	tested := ackData[proto.KaneoTestResult](t, m)
	if !tested.OK || tested.APIBase != kn.URL+"/api" || tested.WebOrigin != kn.URL || len(tested.Workspaces) != 2 || tested.User != "Alex" {
		t.Fatalf("test = %+v", tested)
	}
	if v := wb.svc.View(); v.State != kaneoconf.StateOff || v.KeySet {
		t.Fatalf("a test saved something: %+v", v)
	}
	wb.saveConnection()
	_, m = c.command(proto.CmdKaneoProjects, "p", proto.KaneoProjectsArgs{WorkspaceID: "ws_1"})
	if ps := ackData[proto.KaneoProjectsResult](t, m); len(ps.Projects) != 1 || ps.Projects[0].ID != "pr_1" || ps.Projects[0].Name != "Bridge" {
		t.Fatalf("projects = %+v", ps)
	}

	// A floor's link is checked against Kaneo: another workspace's project,
	// an archived one and a gone one are refused.
	link := func(project string) (string, proto.FloorSettingsArgs) {
		return project, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo),
			Kaneo: proto.Some(proto.KaneoLinkArgs{WorkspaceID: "ws_1", ProjectID: project})}
	}
	for _, refused := range []struct{ project, code string }{{"pr_x", proto.ErrBadRequest}, {"pr_old", proto.ErrBadRequest}, {"pr_gone", proto.ErrNotFound}} {
		_, args := link(refused.project)
		c.mustError(proto.CmdFloorSettings, args, refused.code)
	}
	_, args := link("pr_1")
	c.mustAck(proto.CmdFloorSettings, args)

	// The board: every page, the virtual columns around the workflow ones.
	w := wb.watcher()
	if res := w.watch("s"); !res.Enabled {
		t.Fatalf("watch = %+v", res)
	}
	var is proto.BoardIssues
	for is.FetchedAt == 0 {
		is = w.issues()
	}
	var cols []string
	for _, col := range is.Columns {
		cols = append(cols, col.ID+":"+col.Kind)
	}
	if is.Provider != "kaneo" || is.Truncated || is.Capabilities.Close || len(is.Cards) != 7 ||
		strings.Join(cols, ",") != "planned:planned,to-do:,in-progress:,in-review:,done:,archived:archived" {
		t.Fatalf("board = %+v (columns %v)", is, cols)
	}
	if n := wb.boardReads(); n != 3 {
		t.Fatalf("%d board pages read, want 3", n)
	}
	w.quiet(50 * time.Millisecond) // no repo: no pull request board

	// The detail, a comment, a status, a placed move and a stale one.
	_, m = c.command(proto.CmdIssueGet, "g", proto.ItemArgs{Session: "s", ID: "task_1"})
	if d := ackData[tracker.Detail](t, m); d.Card.Key != "KAN-1" || d.Card.Title != "Connect Kaneo (renamed)" || len(d.Comments) != 2 {
		t.Fatalf("detail = %+v", d)
	}
	_, m = c.command(proto.CmdIssueComment, "cm", proto.CommentArgs{Session: "s", ID: "task_1", Body: "Picked up by a worker."})
	if r := ackData[proto.CommentResult](t, m); r.Comment.ID != "act_3" {
		t.Fatalf("comment = %+v", r)
	}
	w.issues() // the refresh after the write
	kn.JSON("POST", "/task/reorder", 200, `[{"id":"task_7","position":0,"status":"to-do"},{"id":"task_1","position":1,"status":"to-do"},{"id":"task_2","position":2,"status":"to-do"}]`)
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "task_7", Column: "to-do", After: proto.Null[string]()})
	w.issues()
	kn.Text("POST", "/task/reorder", 409, "Conflict: the tasks changed")
	c.mustError(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "task_5", Column: "to-do", After: proto.Some("task_1")}, proto.ErrStale)
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "task_1", Column: "in-progress"})
	w.issues()
	kn.Text("POST", "/comment/task_1", 403, "Forbidden")
	c.mustError(proto.CmdIssueComment, proto.CommentArgs{Session: "s", ID: "task_1", Body: "again"}, proto.ErrForbidden)
	c.mustError(proto.CmdIssueClose, proto.IssueCloseArgs{Session: "s", ID: "task_1", Reason: "completed", Confirm: true}, proto.ErrUnsupported)
	var writes []string
	for _, r := range kn.Writes() {
		writes = append(writes, r.Method+" "+r.Path+" "+r.Body)
	}
	want := []string{
		`POST /api/comment/task_1 {"content":"Picked up by a worker."}`,
		`POST /api/task/reorder {"projectId":"pr_1","tasks":[{"id":"task_7","position":0,"status":"to-do"},{"id":"task_1","position":1},{"id":"task_2","position":2}],` +
			`"expectedTasks":[{"id":"task_1","position":0,"status":"to-do"},{"id":"task_2","position":1,"status":"to-do"},{"id":"task_7","position":2,"status":"to-do"}]}`,
		`POST /api/task/reorder {"projectId":"pr_1","tasks":[{"id":"task_5","position":1,"status":"to-do"},{"id":"task_2","position":2},{"id":"task_7","position":3}],` +
			`"expectedTasks":[{"id":"task_5","position":0,"status":"in-progress"},{"id":"task_1","position":0,"status":"to-do"},{"id":"task_2","position":1,"status":"to-do"},{"id":"task_7","position":2,"status":"to-do"}]}`,
		`PUT /api/task/status/task_1 {"status":"in-progress"}`,
		`POST /api/comment/task_1 {"content":"again"}`,
	}
	if !slices.Equal(writes, want) {
		t.Fatalf("writes:\n%s\nwant:\n%s", strings.Join(writes, "\n"), strings.Join(want, "\n"))
	}

	// A 401 at run time (maybe the key's quota) pauses the polling, and a
	// passing re-test of the saved connection resumes it.
	kn.Text("GET", "/task/tasks/pr_1", 401, "Unauthorized")
	wb.clk.Advance(61 * time.Second)
	for !is.Stale {
		is = w.issues()
	}
	if is.ErrorCode != proto.ErrUnauthorized || is.PausedUntil != wb.clk.Now().Add(kaneoconf.DefaultCooldown).UnixMilli() {
		t.Fatalf("after a 401: %+v", is)
	}
	eventually(t, "the paused connection", func() bool { return wb.svc.View().State == kaneoconf.StatePaused })
	reads := wb.boardReads()
	wb.clk.Advance(2 * time.Minute)
	w.quiet(100 * time.Millisecond)
	_, m = w.command(proto.CmdBoardRefresh, "r", proto.BoardArgs{Session: "s"})
	if ackData[proto.BoardRefreshResult](t, m).Queued || wb.boardReads() != reads {
		t.Fatalf("a paused floor was polled: %d → %d", reads, wb.boardReads())
	}
	pages := map[string]string{
		"limit=100&page=1&relatedPage=1": kaneotest.Fixture(t, "board-p1-r1.json"),
		"limit=100&page=1&relatedPage=2": kaneotest.Fixture(t, "board-p1-r2.json"),
		"limit=100&page=2&relatedPage=1": kaneotest.Fixture(t, "board-p2-r1.json"),
	}
	kn.On("GET", "/task/tasks/pr_1", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, pages[r.URL.RawQuery]) })
	c.mustAck(proto.CmdKaneoTest, proto.KaneoTestArgs{})
	for is.Stale {
		is = w.issues()
	}
	if is.ErrorCode != "" || is.PausedUntil != 0 || len(is.Cards) != 7 || wb.svc.View().State != kaneoconf.StateReady {
		t.Fatalf("after the re-test: %+v, %s", is, wb.svc.View().State)
	}

	// A board the bridge could not read in full: a status-only move goes,
	// a placed one cannot be computed.
	big := strings.Replace(pages["limit=100&page=1&relatedPage=1"], `"totalPages":2,"relatedPage":1,"relatedPageSize":100,"relatedTotalPages":2`,
		`"totalPages":9,"relatedPage":1,"relatedPageSize":100,"relatedTotalPages":1`, 1)
	kn.On("GET", "/task/tasks/pr_1", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, big) })
	wb.clk.Advance(61 * time.Second)
	for !is.Truncated {
		is = w.issues()
	}
	c.mustError(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "task_1", Column: "to-do", After: proto.Some("task_2")}, proto.ErrUnsupported)
	c.mustAck(proto.CmdIssueSetStatus, proto.IssueSetStatusArgs{Session: "s", ID: "task_1", Column: "to-do"})
	kn.On("GET", "/task/tasks/pr_1", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, pages[r.URL.RawQuery]) })

	// With a repo, the floor keeps its Kaneo issues and gets GitHub's pull
	// requests.
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some(wiredRepo)})
	var ps proto.BoardPRs
	for ps.FetchedAt == 0 {
		is, ps = w.pair()
	}
	if is.Provider != "kaneo" || ps.Provider != "github" || len(ps.PRs) != 2 {
		t.Fatalf("with a repo: issues of %s, pull requests %+v", is.Provider, ps)
	}

	for _, r := range kn.Requests() {
		if !r.Authorized && r.Path != "/api/auth/organization/list" {
			t.Errorf("%s %s went without the key", r.Method, r.Path)
		}
	}
	wb.noKey(c, w.client)
}

// "Hand to a worker" on a Kaneo task: the run's ticket is resolved through
// the real tracker (key, title, URL), its prompt names it by its URL (#102:
// not its title or description), in run.prepare and run.start; its launch keeps
// {provider: kaneo, id}, and after a restart the orchestrator is still
// linked to the task by its launch record, never a GitHub issue.
func TestKaneoWiredRunSurvivesRestart(t *testing.T) {
	t.Parallel()
	kn := kaneotest.New(t, wiredKey)
	db, file, clk := filepath.Join(t.TempDir(), "world.db"), filepath.Join(t.TempDir(), "kaneo.json"), newBoardClock()
	wb := startWired(t, kn, db, file, clk)
	wb.saveConnection()
	wb.git.repos["/home/u/lab"] = "/home/u/lab"
	wb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Tracker: proto.Some(proto.TrackerKaneo),
		Kaneo: proto.Some(proto.KaneoLinkArgs{WorkspaceID: "ws_1", ProjectID: "pr_1"}), DefaultCwd: proto.Some("/home/u/lab")})
	wb.polled("s")
	decorateRoles(wb.boardBridge)
	url := kn.URL + "/dashboard/workspace/ws_1/project/pr_1/task/task_1"
	item := &proto.WorkItemRef{Provider: "kaneo", ID: "task_1"}

	_, m := wb.c.command(proto.CmdRunPrepare, "p", proto.RunPrepareArgs{Session: "s", WorkItem: item})
	res := ackData[proto.RunPrepareResult](t, m)
	if res.Ticket == nil || res.Ticket.Kind != proto.TicketItem || res.Ticket.Item == nil || res.Ticket.Item.Key != "KAN-1" ||
		res.Ticket.Item.URL != url || res.Ticket.Repo != "" || res.Ticket.Number != 0 {
		t.Fatalf("prepare = %+v (ticket %+v)", res, res.Ticket)
	}
	if !strings.HasPrefix(res.Prompt, "/write-code "+url+"\n\nTeam:") || strings.Contains(res.Prompt, "Connect Kaneo") ||
		strings.Contains(res.Prompt, "Add the tracker client.") || strings.Contains(res.Prompt, "github.com") || strings.Contains(res.Prompt, statusLine) {
		t.Fatalf("prompt = %q", res.Prompt)
	}
	preset := wb.connect(proto.Hello{}).snapshot().World.Presets[0].ID
	desk := 1
	_, m = wb.c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, WorkItem: item, Orch: &buildTeam.Orch, Preset: preset})
	start := ackData[proto.RunStartResult](t, m)
	if start.Prompt != res.Prompt {
		t.Fatalf("run.start prompt = %q, the preview's %q", start.Prompt, res.Prompt)
	}
	if l, ok, err := wb.st.RunLaunchByWorker(t.Context(), start.ID); err != nil || !ok || l.ItemProvider != "kaneo" || l.ItemID != "task_1" ||
		l.ItemKey != "KAN-1" || l.Repo != "" || l.IssueNumber != 0 {
		t.Fatalf("run_launch = %+v %v %v", l, ok, err)
	}
	wb.fl.mu.Lock()
	workers := slices.Clone(wb.fl.workers)
	wb.fl.mu.Unlock()
	wb.noKey(wb.c)
	wb.stop()

	wb = startWired(t, kn, db, file, clk, workers...)
	// The title is the board's (the card's; the detail's rename is not on
	// the board), the link Kaneo's own.
	want := proto.WorkItemRef{Provider: "kaneo", ID: "task_1", Key: "KAN-1", Title: "Connect Kaneo", URL: url}
	c := wb.connect(proto.Hello{})
	found := func(ws []proto.Worker) bool {
		for _, w := range ws {
			if w.ID == start.ID && w.WorkItem != nil && *w.WorkItem == want && w.Issue == nil {
				return true
			}
		}
		return false
	}
	if !found(c.snapshot().World.Workers) {
		for {
			if ev := c.event(); ev.T == proto.EvWorkerUpsert && found([]proto.Worker{*ev.Worker}) {
				break
			}
		}
	}
	wb.noKey(c)
}
