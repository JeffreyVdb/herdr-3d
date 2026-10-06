package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// The whole board path, with gh played by a fake: a floor linked to a repository
// and a project shows its board through `dump -board`, and a comment goes
// through `cmd` to the GraphQL mutation with the audit row holding no text.
func TestServeBoards(t *testing.T) {
	feed, err := os.ReadFile(filepath.Join("..", "github", "testdata", "feed-project.json"))
	if err != nil {
		t.Fatal(err)
	}
	// The fixture is dated for the day it was cut, so the board runs on a clock of that day: an hour before the
	// github tests' 12:00, which keeps #6 (closed 2026-09-22 12:00:01) an hour inside the seven-day window while
	// the clock still moves for the feed's age, and #5 (closed 09:00) outside it.
	base, start := time.Date(2026, 9, 29, 11, 0, 0, 0, time.UTC), time.Now()
	now := func() time.Time { return base.Add(time.Since(start)) }
	// #118: the run's issue (#2, not on the board) is read once for its title.
	detail, err := os.ReadFile(filepath.Join("..", "github", "testdata", "issue-detail.json"))
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var mutations []map[string]any
	gh := func(_ context.Context, argv []string, stdin []byte) ([]byte, []byte, error) {
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.Unmarshal(stdin, &req); err != nil {
			t.Errorf("stdin: %v", err)
		}
		switch req.Query {
		case githubcli.Text(githubcli.DocFeed):
			return feed, nil, nil
		case githubcli.Text(githubcli.DocIssueDetail):
			return detail, nil, nil
		case githubcli.Text(githubcli.DocIssueNode):
			return []byte(`{"data":{"repository":{"issue":{"id":"I_9","number":9,"state":"OPEN"}}}}`), nil, nil
		case githubcli.Text(githubcli.DocAddComment):
			mu.Lock()
			mutations = append(mutations, req.Variables)
			mu.Unlock()
			return []byte(`{"data":{"addComment":{"commentEdge":{"node":{"id":"IC_1","body":"x","createdAt":"2026-09-29T09:29:42Z","author":{"login":"dev","avatarUrl":""}}}}}}`), nil, nil
		}
		t.Errorf("unexpected query %.60s", req.Query)
		return nil, nil, nil
	}

	root, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	alphaDir := filepath.Join(root, "alpha")
	if err := os.MkdirAll(alphaDir, 0o700); err != nil {
		t.Fatal(err)
	}
	srv := herdrtest.Start(t, alphaDir)
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))
	lister := herdrtest.NewLister()
	lister.Set(herdr.Session{Name: "alpha", SessionDir: alphaDir, SocketPath: srv.Socket})
	db := filepath.Join(t.TempDir(), "world.db")
	b := serveWith(t, db, lister, func(c *ServeConfig) {
		c.Boards = GitHubBoards(&githubcli.Client{Bin: "gh", Run: gh}, now)
		c.BoardTick = 5 * time.Millisecond
	})
	dumpOnce(t, b.sock)

	settings := `{"session":"alpha","repo":"JeffreyVdb/herdr-3d","project":{"owner":"JeffreyVdb","number":2}}`
	if out, err := runCLI(t, cmdMain, "-socket", b.sock, proto.CmdFloorSettings, settings); err != nil {
		t.Fatalf("settings: %v %s", err, out)
	}
	out, err := runCLI(t, dumpMain, "-socket", b.sock, "-board", "alpha", "-once")
	if err != nil {
		t.Fatalf("dump -board: %v", err)
	}
	var issues proto.BoardIssues
	var prs proto.BoardPRs
	for _, l := range strings.Split(strings.TrimSpace(out), "\n") {
		var env proto.Envelope
		if json.Unmarshal([]byte(l), &env) != nil {
			t.Fatalf("not JSON: %q", l)
		}
		switch env.T {
		case proto.TBoardIssues:
			_ = json.Unmarshal([]byte(l), &issues)
		case proto.TBoardPRs:
			_ = json.Unmarshal([]byte(l), &prs)
		}
	}
	var cols []string
	for _, c := range issues.Columns {
		cols = append(cols, c.Name)
	}
	if issues.FetchedAt == 0 || issues.Provider != "github" || issues.ProviderName != "GitHub" || strings.Join(cols, ",") != "No status,Todo,Doing,QA,Done" ||
		len(issues.Cards) != 6 || len(prs.PRs) != 4 || prs.FetchedAt == 0 {
		t.Fatalf("issues %+v\nprs %+v", issues, prs)
	}
	// Nothing GitHub-shaped on the wire.
	for _, banned := range []string{"PVT_", "PVTI_", "projectV2", "headRefOid", "optionId", "I_9", "PR_31"} {
		if strings.Contains(out, banned) {
			t.Errorf("the board messages hold %q", banned)
		}
	}

	out, err = runCLI(t, cmdMain, "-socket", b.sock, proto.CmdIssueComment,
		`{"session":"alpha","id":"JeffreyVdb/herdr-3d#9","body":"the deploy key is hunter2"}`)
	if err != nil || !strings.Contains(out, `"IC_1"`) {
		t.Fatalf("issue.comment: %v %s", err, out)
	}
	mu.Lock()
	if len(mutations) != 1 || mutations[0]["subjectId"] != "I_9" || mutations[0]["body"] != "the deploy key is hunter2" {
		t.Fatalf("mutations = %v", mutations)
	}
	mu.Unlock()
	b.stop()
	st, err := store.Open(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	log, _ := st.AuditLog(context.Background())
	seen := false
	for _, e := range log {
		if e.Cmd == proto.CmdIssueComment {
			seen = true
			if strings.Contains(e.Args, "hunter2") || !strings.Contains(e.Args, `"body_bytes":25`) || !e.OK {
				t.Errorf("audit = %+v", e)
			}
		}
	}
	if !seen {
		t.Fatal("no audit row of the comment")
	}
}
