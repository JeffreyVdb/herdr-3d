package kaneo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// boardFake is a fake serving the fixture board: two task pages, the first
// with two related pages.
func boardFake(t *testing.T) *fake {
	t.Helper()
	f := newFake(t)
	f.json("GET", "/column/pr_1", 200, fixture(t, "columns.json"))
	pages := map[string]string{
		"limit=100&page=1&relatedPage=1": fixture(t, "board-p1-r1.json"),
		"limit=100&page=1&relatedPage=2": fixture(t, "board-p1-r2.json"),
		"limit=100&page=2&relatedPage=1": fixture(t, "board-p2-r1.json"),
	}
	f.on("GET", "/task/tasks/pr_1", func(w http.ResponseWriter, r *http.Request) {
		body, ok := pages[r.URL.RawQuery]
		if !ok {
			t.Errorf("unexpected board query %q", r.URL.RawQuery)
			http.Error(w, "Not Found", 404)
			return
		}
		io.WriteString(w, body)
	})
	return f
}

func newTracker(t *testing.T, f *fake) *Tracker {
	t.Helper()
	return NewTracker(f.client(t), "ws_1", "pr_1", "https://tasks.example.com/")
}

func TestInfoAndKey(t *testing.T) {
	f := newFake(t)
	tr := newTracker(t, f)
	if i := tr.Info(); i.ID != "kaneo" || i.Name != "Kaneo" ||
		i.Capabilities != (tracker.Capabilities{Comment: true, Close: false, SetStatus: true, Order: true}) {
		t.Fatalf("info = %+v", i)
	}
	if k := tr.Key(); k != "kaneo:"+f.srv.URL+"/api|ws_1|pr_1" {
		t.Fatalf("key = %q", k)
	}
	noKey(t, tr.Key())
	if k := NewTracker(f.client(t), "ws_1", "pr_2", "").Key(); k == tr.Key() {
		t.Fatalf("two projects share key %q", k)
	}
	if err := tr.Close(context.Background(), "task_1", tracker.ReasonCompleted); !errors.Is(err, provider.ErrUnsupported) {
		t.Fatalf("close = %v", err)
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("%d requests", n)
	}
}

func TestBoard(t *testing.T) {
	f := boardFake(t)
	tr := newTracker(t, f)
	b, err := tr.Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantCols := []tracker.Column{
		{ID: "planned", Name: "Planned", Kind: "planned"},
		{ID: "to-do", Name: "To Do"},
		{ID: "in-progress", Name: "In Progress"},
		{ID: "in-review", Name: "In Review"},
		{ID: "done", Name: "Done", Done: true},
		{ID: "archived", Name: "Archived", Kind: "archived"},
	}
	if !slices.Equal(b.Columns, wantCols) {
		t.Fatalf("columns = %+v", b.Columns)
	}
	if b.Truncated || b.Rate != nil {
		t.Fatalf("board = %+v", b)
	}
	var ids []string
	cards := map[string]tracker.Card{}
	for _, c := range b.Cards {
		ids = append(ids, c.ID)
		cards[c.ID] = c
		if c.UpdatedAt != 0 || c.ClosedAt != nil || c.Author != "" || c.Labels == nil || c.Assignees == nil || c.Capabilities != nil {
			t.Errorf("card %s = %+v", c.ID, c)
		}
		if c.URL != "https://tasks.example.com/dashboard/workspace/ws_1/project/pr_1/task/"+c.ID {
			t.Errorf("card %s url = %s", c.ID, c.URL)
		}
	}
	if !slices.Equal(ids, []string{"task_1", "task_2", "task_3", "task_4", "task_7", "task_5", "task_6"}) {
		t.Fatalf("cards = %v", ids)
	}
	c := cards["task_1"]
	if c.Key != "KAN-1" || c.Title != "Connect Kaneo" || c.State != "open" || c.Column != "to-do" || *c.Position != 0 ||
		c.Priority != "medium" || len(c.Assignees) != 1 || c.Assignees[0] != (provider.Person{Name: "Alex", AvatarURL: "https://img.example.invalid/alex.png"}) {
		t.Fatalf("task_1 = %+v", c)
	}
	// Labels of both related pages, once each.
	if !slices.Equal(c.Labels, []tracker.Label{{Name: "Integration", Color: "#3366ff"}, {Name: "Backend", Color: "#aabbcc"}}) {
		t.Fatalf("task_1 labels = %+v", c.Labels)
	}
	for id, want := range map[string]struct {
		key, state, column, priority string
		position                     int
	}{
		"task_2": {"KAN-2", "open", "to-do", "", 1},
		"task_3": {"KAN-3", "closed", "done", "urgent", 0},
		"task_4": {"KAN-4", "open", "planned", "low", 0},
		"task_7": {"KAN-7", "open", "to-do", "high", 2},
		"task_5": {"KAN-5", "open", "in-progress", "high", 0},
		"task_6": {"KAN-6", "open", "archived", "medium", 0}, // archived is not completed
	} {
		c := cards[id]
		if c.Key != want.key || c.State != want.state || c.Column != want.column || c.Priority != want.priority || *c.Position != want.position {
			t.Errorf("%s = %+v", id, c)
		}
	}
	if l := cards["task_3"].Labels; len(l) != 1 || l[0].Color != "#ededed" {
		t.Errorf("task_3 labels = %+v", l)
	}
	var queries []string
	for _, r := range f.requests() {
		if r.method != "GET" {
			t.Errorf("a board read wrote: %+v", r)
		}
		queries = append(queries, r.path+"?"+r.query)
	}
	if !slices.Equal(queries, []string{"/api/column/pr_1?", "/api/task/tasks/pr_1?limit=100&page=1&relatedPage=1",
		"/api/task/tasks/pr_1?limit=100&page=1&relatedPage=2", "/api/task/tasks/pr_1?limit=100&page=2&relatedPage=1"}) {
		t.Fatalf("requests = %v", queries)
	}
}

// page is a board page of tasks n..n+count-1, all in "to-do".
func page(n, count, total, totalPages, relatedTotalPages int, column string) string {
	var tasks []map[string]any
	for i := n; i < n+count; i++ {
		tasks = append(tasks, map[string]any{"id": fmt.Sprintf("t%d", i), "projectId": "pr_1", "position": i, "number": i,
			"title": "T", "status": column, "priority": "low", "labels": []any{}})
	}
	b, _ := json.Marshal(map[string]any{
		"data": map[string]any{"id": "pr_1", "slug": "KAN", "workspaceId": "ws_1",
			"columns": []any{map[string]any{"id": column, "slug": column, "name": strings.ToUpper(column), "isFinal": column == "shipped",
				"position": 9, "tasks": tasks}},
			"plannedTasks": []any{}, "archivedTasks": []any{}},
		"pagination": map[string]any{"total": total, "page": 1, "pageSize": 100, "totalPages": totalPages, "relatedPage": 1,
			"relatedPageSize": 100, "relatedTotalPages": relatedTotalPages},
	})
	return string(b)
}

func TestBoardIsBounded(t *testing.T) {
	for _, tc := range []struct {
		name                     string
		totalPages, relatedPages int
		changing                 bool
		wantCalls, wantCards     int
		wantTruncated            bool
	}{
		{"whole", 2, 2, false, 1 + 4, 2, false},
		{"task pages", 9, 1, false, 1 + taskPages, taskPages, true},
		{"related pages", 1, 9, false, 1 + relatedPages, 1, true},
		{"calls", 5, 3, false, boardCalls, 4, true},
		{"moved under the read", 2, 1, true, 1 + 2, 2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			f.json("GET", "/column/pr_1", 200, fixture(t, "columns.json"))
			f.on("GET", "/task/tasks/pr_1", func(w http.ResponseWriter, r *http.Request) {
				var p int
				fmt.Sscanf(r.URL.Query().Get("page"), "%d", &p)
				total := 500
				if tc.changing {
					total += p
				}
				io.WriteString(w, page(p, 1, total, tc.totalPages, tc.relatedPages, "to-do"))
			})
			b, err := newTracker(t, f).Board(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if n := len(f.requests()); n != tc.wantCalls || len(b.Cards) != tc.wantCards || b.Truncated != tc.wantTruncated {
				t.Fatalf("%d calls, %d cards, truncated %v", n, len(b.Cards), b.Truncated)
			}
		})
	}
}

// A task in a column the column list lacks (made since) gets the board's
// own column, before Archived.
func TestBoardColumnOnlyThePagesName(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/column/pr_1", 200, fixture(t, "columns.json"))
	f.json("GET", "/task/tasks/pr_1", 200, page(1, 1, 1, 1, 1, "shipped"))
	b, err := newTracker(t, f).Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if n := len(b.Columns); n != 7 || b.Columns[5] != (tracker.Column{ID: "shipped", Name: "SHIPPED", Done: true}) || b.Columns[6].ID != "archived" {
		t.Fatalf("columns = %+v", b.Columns)
	}
	if c := b.Cards[0]; c.State != "closed" || c.Column != "shipped" {
		t.Fatalf("card = %+v", c)
	}
}

func TestBoardErrors(t *testing.T) {
	for _, tc := range []struct {
		name string
		set  func(f *fake)
		kind error
	}{
		{"unknown project", func(f *fake) { f.text("GET", "/column/pr_1", 400, "Unknown project") }, provider.ErrNotFound},
		{"no access", func(f *fake) { f.text("GET", "/column/pr_1", 403, "No access to the project's workspace") }, provider.ErrForbidden},
		{"refused key", func(f *fake) { f.text("GET", "/column/pr_1", 401, "Unauthorized") }, provider.ErrUnauthorized},
		{"timed out", func(f *fake) {
			f.json("GET", "/column/pr_1", 200, `[]`)
			f.text("GET", "/task/tasks/pr_1", 503, "Task list request took too long; retry later")
		}, provider.ErrFailed},
		{"moved to another workspace", func(f *fake) {
			f.json("GET", "/column/pr_1", 200, `[]`)
			f.json("GET", "/task/tasks/pr_1", 200, strings.Replace(page(1, 1, 1, 1, 1, "to-do"), `"ws_1"`, `"ws_2"`, 1))
		}, provider.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			tc.set(f)
			_, err := newTracker(t, f).Board(context.Background())
			if !errors.Is(err, tc.kind) {
				t.Fatalf("err = %v", err)
			}
			noKey(t, err.Error())
		})
	}
}

func TestGet(t *testing.T) {
	f := boardFake(t)
	f.json("GET", "/task/task_1", 200, fixture(t, "task-detail.json"))
	f.json("GET", "/comment/task_1", 200, fixture(t, "comments.json"))
	tr := newTracker(t, f)
	ctx := context.Background()
	// No board read yet: Get reads one (for the slug, the columns, the labels).
	d, err := tr.Get(ctx, "task_1")
	if err != nil {
		t.Fatal(err)
	}
	if d.Body != "Add the tracker client.\n\n<img src=x onerror=alert(1)>" || d.CreatedAt != 1791374400000 || d.Author != (provider.Person{}) ||
		d.CommentsTruncated {
		t.Fatalf("detail = %+v", d)
	}
	if !slices.Equal(d.Comments, []provider.Comment{
		{ID: "act_1", Author: provider.Person{Name: "Alex", AvatarURL: "https://img.example.invalid/alex.png"}, Body: "Ready for review.", CreatedAt: 1791374400000},
		{ID: "act_2", Author: provider.Person{Name: "Sam"}, Body: "Looks good", CreatedAt: 1791378000000},
	}) {
		t.Fatalf("comments = %+v", d.Comments)
	}
	// The detail's now (title, column, priority); the board's labels and avatar.
	c := d.Card
	if c.Key != "KAN-1" || c.Title != "Connect Kaneo (renamed)" || c.Column != "in-review" || c.State != "open" || c.Position != nil ||
		c.Priority != "high" || len(c.Labels) != 2 || c.Assignees[0].AvatarURL == "" || c.URL == "" {
		t.Fatalf("card = %+v", c)
	}
	if n := f.count("GET", "/column/pr_1"); n != 1 {
		t.Fatalf("%d board reads", n)
	}
	for _, r := range f.requests() {
		if r.path == "/api/task/task_1" && r.query != "view=detail" {
			t.Fatalf("detail query = %q", r.query)
		}
	}
	// A second Get works from the same board.
	if _, err := tr.Get(ctx, "task_1"); err != nil || f.count("GET", "/column/pr_1") != 1 {
		t.Fatalf("second get: %v", err)
	}
}

func TestGetOutOfScope(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/task/task_x", 200, fixture(t, "task-elsewhere.json"))
	f.text("GET", "/task/task_gone", 400, "Unknown task, or its workspace could not be determined")
	f.text("GET", "/task/task_private", 403, "No access to the task's workspace")
	tr := newTracker(t, f)
	ctx := context.Background()
	for id, kind := range map[string]error{"task_x": provider.ErrNotFound, "task_gone": provider.ErrNotFound,
		"task_private": provider.ErrForbidden, "": provider.ErrNotFound} {
		if _, err := tr.Get(ctx, id); !errors.Is(err, kind) {
			t.Errorf("get %q = %v", id, err)
		}
	}
	// Nothing else was read for a task out of scope.
	for _, r := range f.requests() {
		if !strings.HasPrefix(r.path, "/api/task/task_") {
			t.Errorf("read %s", r.path)
		}
	}
}

// A description Kaneo deferred is read page by page, carrying its version;
// one that changes under the read is read again from the start.
func TestGetDeferredDescription(t *testing.T) {
	f := boardFake(t)
	f.json("GET", "/task/task_2", 200, fixture(t, "task-deferred.json"))
	f.json("GET", "/comment/task_2", 200, `[]`)
	changed := 1
	f.on("GET", "/task/task_2/description", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.RawQuery {
		case "offset=0":
			io.WriteString(w, `{"content":"first half, ","version":"41","nextOffset":11}`)
		case "offset=11&version=41":
			if changed > 0 {
				changed--
				w.WriteHeader(409)
				io.WriteString(w, "Description changed or is unavailable; refresh before loading it again")
				return
			}
			io.WriteString(w, `{"content":"second half","version":"41","nextOffset":null}`)
		default:
			t.Errorf("description query %q", r.URL.RawQuery)
		}
	})
	d, err := newTracker(t, f).Get(context.Background(), "task_2")
	if err != nil {
		t.Fatal(err)
	}
	if d.Body != "first half, second half" || d.Card.Key != "KAN-2" || d.Comments == nil {
		t.Fatalf("detail = %+v", d)
	}
	if n := f.count("GET", "/task/task_2/description"); n != 4 {
		t.Fatalf("%d description pages", n)
	}
	// Changing twice is an error, not half a description.
	changed = 2
	if _, err := newTracker(t, f).Get(context.Background(), "task_2"); !errors.Is(err, provider.ErrStale) {
		t.Fatalf("changing = %v", err)
	}
}

func TestComment(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/task/task_1", 200, fixture(t, "task-detail.json"))
	f.json("POST", "/comment/task_1", 200, fixture(t, "comment-created.json"))
	f.json("GET", "/comment/task_1", 200, fixture(t, "comments-after.json"))
	tr := newTracker(t, f)
	ctx := context.Background()
	c, err := tr.Comment(ctx, "task_1", "Picked up by a worker.")
	if err != nil {
		t.Fatal(err)
	}
	if c != (provider.Comment{ID: "act_3", Author: provider.Person{Name: "Alex", AvatarURL: "https://img.example.invalid/alex.png"},
		Body: "Picked up by a worker.", CreatedAt: 1791381600000}) {
		t.Fatalf("comment = %+v", c)
	}
	var post []request
	for _, r := range f.requests() {
		if r.method == "POST" {
			post = append(post, r)
		}
	}
	if len(post) != 1 || post[0].body != `{"content":"Picked up by a worker."}` || post[0].query != "" {
		t.Fatalf("posts = %+v", post)
	}
	// The author is a nicety: the comment is posted either way.
	f.text("GET", "/comment/task_1", 503, "busy")
	if c, err := tr.Comment(ctx, "task_1", "again"); err != nil || c.ID != "act_3" || c.Author.Name != "" {
		t.Fatalf("without the list: %+v, %v", c, err)
	}
	f.text("POST", "/comment/task_1", 403, "missing task:update permission")
	if _, err := tr.Comment(ctx, "task_1", "no"); !errors.Is(err, provider.ErrForbidden) {
		t.Fatalf("403 = %v", err)
	}
}

func TestCommentIsChecked(t *testing.T) {
	f := newFake(t)
	f.json("GET", "/task/task_x", 200, fixture(t, "task-elsewhere.json"))
	tr := newTracker(t, f)
	ctx := context.Background()
	for _, body := range []string{"", " \n\t", strings.Repeat("a", maxComment+1), strings.Repeat("😀", maxComment/2) + "a"} {
		if _, err := tr.Comment(ctx, "task_1", body); !errors.Is(err, provider.ErrBadInput) {
			t.Errorf("a comment of %d bytes = %v", len(body), err)
		}
	}
	if _, err := tr.Comment(ctx, "task_x", "hello"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("another project's task = %v", err)
	}
	if n := f.count("POST", "/comment/task_x") + f.count("POST", "/comment/task_1"); n != 0 {
		t.Fatalf("%d posts", n)
	}
	if utf16Len(strings.Repeat("a", maxComment)) != maxComment || utf16Len(strings.Repeat("😀", maxComment/2)) != maxComment ||
		utf16Len("é") != 1 {
		t.Fatal("utf16Len")
	}
}

func TestSetStatus(t *testing.T) {
	f := boardFake(t)
	f.json("GET", "/task/task_1", 200, fixture(t, "task-detail.json"))
	f.json("GET", "/task/task_x", 200, fixture(t, "task-elsewhere.json"))
	f.json("PUT", "/task/status/task_1", 200, fixture(t, "status-updated.json"))
	tr := newTracker(t, f)
	ctx := context.Background()
	if err := tr.SetStatus(ctx, "task_1", "in-progress", nil); err != nil {
		t.Fatal(err)
	}
	var puts []request
	for _, r := range f.requests() {
		if r.method == "PUT" {
			puts = append(puts, r)
		}
	}
	if len(puts) != 1 || puts[0].path != "/api/task/status/task_1" || puts[0].body != `{"status":"in-progress"}` {
		t.Fatalf("puts = %+v", puts)
	}
	// The last board knows where it went.
	tr.mu.Lock()
	p := *tr.last.tasks["task_1"]
	tr.mu.Unlock()
	if p.status != "in-progress" || *p.position != 1 {
		t.Fatalf("place = %+v", p)
	}
	// The virtual columns are columns too.
	for _, col := range []string{"planned", "archived", "done"} {
		if err := tr.SetStatus(ctx, "task_1", col, nil); err != nil {
			t.Errorf("to %s: %v", col, err)
		}
	}
	if err := tr.SetStatus(ctx, "task_1", "col_prog", nil); !errors.Is(err, provider.ErrBadInput) {
		t.Fatalf("a column id, not a slug = %v", err)
	}
	if err := tr.SetStatus(ctx, "task_x", "done", nil); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("another project's task = %v", err)
	}
	if n := f.count("PUT", "/task/status/task_x"); n != 0 {
		t.Fatal("wrote another project's task")
	}
	f.text("PUT", "/task/status/task_1", 403, "missing task:update permission")
	if err := tr.SetStatus(ctx, "task_1", "done", nil); !errors.Is(err, provider.ErrForbidden) {
		t.Fatalf("403 = %v", err)
	}
}

// reorders is the bodies of the reorders sent so far.
func reorders(f *fake) []string {
	var out []string
	for _, r := range f.requests() {
		if r.method == "POST" && r.path == "/api/task/reorder" {
			out = append(out, r.body)
		}
	}
	return out
}

func TestReorder(t *testing.T) {
	f := boardFake(t)
	answer := `[]`
	f.on("POST", "/task/reorder", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, answer) })
	tr := newTracker(t, f)
	ctx := context.Background()
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	// task_5 from In Progress into To Do, after task_1: To Do is numbered
	// again (task_1 keeps 0), the snapshot is both columns as read.
	answer = `[{"id":"task_5","position":1,"status":"to-do"},{"id":"task_2","position":2,"status":"to-do"},{"id":"task_7","position":3,"status":"to-do"}]`
	if err := tr.SetStatus(ctx, "task_5", "to-do", &tracker.Anchor{After: "task_1"}); err != nil {
		t.Fatal(err)
	}
	want := `{"projectId":"pr_1",` +
		`"tasks":[{"id":"task_5","position":1,"status":"to-do"},{"id":"task_2","position":2},{"id":"task_7","position":3}],` +
		`"expectedTasks":[{"id":"task_5","position":0,"status":"in-progress"},` +
		`{"id":"task_1","position":0,"status":"to-do"},{"id":"task_2","position":1,"status":"to-do"},{"id":"task_7","position":2,"status":"to-do"}]}`
	if got := reorders(f); len(got) != 1 || got[0] != want {
		t.Fatalf("reorder = %v\nwant     %s", got, want)
	}
	// The next move is computed from the answer: task_1 to the top of the
	// (now empty) In Progress.
	answer = `[{"id":"task_1","position":0,"status":"in-progress"}]`
	if err := tr.SetStatus(ctx, "task_1", "in-progress", &tracker.Anchor{}); err != nil {
		t.Fatal(err)
	}
	want = `{"projectId":"pr_1","tasks":[{"id":"task_1","position":0,"status":"in-progress"}],` +
		`"expectedTasks":[{"id":"task_1","position":0,"status":"to-do"},{"id":"task_5","position":1,"status":"to-do"},` +
		`{"id":"task_2","position":2,"status":"to-do"},{"id":"task_7","position":3,"status":"to-do"}]}`
	if got := reorders(f); len(got) != 2 || got[1] != want {
		t.Fatalf("reorder = %v\nwant     %s", got[1:], want)
	}
	// Within a column, to the top; a planned task has no position yet.
	answer = `[]`
	if err := tr.SetStatus(ctx, "task_7", "to-do", &tracker.Anchor{}); err != nil {
		t.Fatal(err)
	}
	want = `{"projectId":"pr_1","tasks":[{"id":"task_7","position":0,"status":"to-do"}],` +
		`"expectedTasks":[{"id":"task_5","position":1,"status":"to-do"},{"id":"task_2","position":2,"status":"to-do"},{"id":"task_7","position":3,"status":"to-do"}]}`
	if got := reorders(f); got[2] != want {
		t.Fatalf("reorder = %s\nwant     %s", got[2], want)
	}
	if err := tr.SetStatus(ctx, "task_4", "planned", &tracker.Anchor{}); err != nil {
		t.Fatal(err)
	}
	want = `{"projectId":"pr_1","tasks":[{"id":"task_4","position":0,"status":"planned"}],` +
		`"expectedTasks":[{"id":"task_4","position":null,"status":"planned"}]}`
	if got := reorders(f); got[3] != want {
		t.Fatalf("reorder = %s\nwant     %s", got[3], want)
	}
	// No task read, no status PUT: the reorder is the one write.
	if f.count("PUT", "/task/status/task_5")+f.count("GET", "/task/task_5") != 0 {
		t.Fatal("more than the reorder")
	}
}

func TestReorderRefusals(t *testing.T) {
	f := boardFake(t)
	f.text("POST", "/task/reorder", 409, "Board changed; refresh before reordering")
	tr := newTracker(t, f)
	ctx := context.Background()
	if err := tr.SetStatus(ctx, "task_5", "to-do", &tracker.Anchor{After: "task_1"}); !errors.Is(err, provider.ErrStale) {
		t.Fatalf("409 = %v", err)
	}
	for _, tc := range []struct {
		id, column, after string
		kind              error
	}{
		{"task_5", "to-do", "task_5", provider.ErrBadInput}, // after itself
		{"task_5", "to-do", "task_3", provider.ErrStale},    // task_3 is in Done
		{"task_5", "to-do", "task_99", provider.ErrStale},   // not on the board
		{"task_99", "to-do", "", provider.ErrStale},         // the moved card is not either
		{"task_5", "nowhere", "", provider.ErrBadInput},     // no such column
		{"task_5", "col_todo", "", provider.ErrBadInput},    // a column id, not its slug
	} {
		if err := tr.SetStatus(ctx, tc.id, tc.column, &tracker.Anchor{After: tc.after}); !errors.Is(err, tc.kind) {
			t.Errorf("%+v = %v", tc, err)
		}
	}
	if n := len(reorders(f)); n != 1 {
		t.Fatalf("%d reorders sent", n)
	}
	// A truncated board cannot be ordered.
	g := newFake(t)
	g.json("GET", "/column/pr_1", 200, fixture(t, "columns.json"))
	g.json("GET", "/task/tasks/pr_1", 200, page(1, 1, 900, 9, 1, "to-do"))
	tr = newTracker(t, g)
	if err := tr.SetStatus(ctx, "t1", "to-do", &tracker.Anchor{}); !errors.Is(err, provider.ErrUnsupported) {
		t.Fatalf("truncated = %v", err)
	}
	if n := len(reorders(g)); n != 0 {
		t.Fatalf("%d reorders sent", n)
	}
}

// The poller and the commands may call at once.
func TestConcurrentCalls(t *testing.T) {
	f := boardFake(t)
	f.json("GET", "/task/task_1", 200, fixture(t, "task-detail.json"))
	f.json("GET", "/comment/task_1", 200, fixture(t, "comments.json"))
	f.json("PUT", "/task/status/task_1", 200, fixture(t, "status-updated.json"))
	f.json("POST", "/task/reorder", 200, `[{"id":"task_5","position":0,"status":"to-do"}]`)
	tr := newTracker(t, f)
	ctx := context.Background()
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(4)
		go func() { defer wg.Done(); tr.Board(ctx) }()
		go func() { defer wg.Done(); tr.Get(ctx, "task_1") }()
		go func() { defer wg.Done(); tr.SetStatus(ctx, "task_1", "in-progress", nil) }()
		go func() { defer wg.Done(); tr.SetStatus(ctx, "task_5", "to-do", &tracker.Anchor{}) }()
	}
	wg.Wait()
}
