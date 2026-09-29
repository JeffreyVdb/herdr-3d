package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// The clock of the tests: the cut-off of the closed issues is 2026-09-22 12:00 UTC.
var testNow = time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

type ghCall struct {
	doc  githubcli.Doc
	vars map[string]any
}

// fakeGH plays gh: it recognises the document by its text, records the
// call and answers with what handle says (a JSON body, or an error).
type fakeGH struct {
	t      *testing.T
	mu     sync.Mutex
	calls  []ghCall
	handle func(doc githubcli.Doc, vars map[string]any) (string, error)
}

func (f *fakeGH) run(_ context.Context, argv []string, stdin []byte) ([]byte, []byte, error) {
	want := []string{"gh", "api", "graphql", "--method", "POST", "--input", "-"}
	if !slices.Equal(argv, want) {
		f.t.Errorf("argv = %q", argv)
	}
	var req struct {
		Query     string         `json:"query"`
		Variables map[string]any `json:"variables"`
	}
	if err := json.Unmarshal(stdin, &req); err != nil {
		f.t.Fatal(err)
	}
	var doc githubcli.Doc
	for _, d := range githubcli.Docs() {
		if githubcli.Text(d) == req.Query {
			doc = d
		}
	}
	if doc == "" {
		f.t.Fatalf("a query that is no embedded document: %.80s", req.Query)
	}
	f.mu.Lock()
	f.calls = append(f.calls, ghCall{doc, req.Variables})
	f.mu.Unlock()
	out, err := f.handle(doc, req.Variables)
	return []byte(out), nil, err
}

func (f *fakeGH) docs() []githubcli.Doc {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []githubcli.Doc
	for _, c := range f.calls {
		out = append(out, c.doc)
	}
	return out
}

func (f *fakeGH) last(doc githubcli.Doc) map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if f.calls[i].doc == doc {
			return f.calls[i].vars
		}
	}
	f.t.Fatalf("no call of %s", doc)
	return nil
}

func fixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func newRegistry(t *testing.T, handle func(githubcli.Doc, map[string]any) (string, error)) (*Registry, *fakeGH) {
	t.Helper()
	f := &fakeGH{t: t, handle: handle}
	return NewRegistry(&githubcli.Client{Bin: "gh", Run: f.run}, func() time.Time { return testNow }), f
}

// feedOnly answers the feed with a fixture and fails on anything else.
func feedOnly(t *testing.T, body string) func(githubcli.Doc, map[string]any) (string, error) {
	return func(doc githubcli.Doc, _ map[string]any) (string, error) {
		if doc != githubcli.DocFeed {
			t.Errorf("unexpected %s", doc)
		}
		return body, nil
	}
}

var projectCfg = Config{Repo: "JeffreyVdb/herdr-3d", ProjectOwner: "JeffreyVdb", ProjectNumber: 2}

func cardsByKey(b tracker.Board) map[string]tracker.Card {
	m := map[string]tracker.Card{}
	for _, c := range b.Cards {
		m[c.Key] = c
	}
	return m
}

// A repository with a project and its Status field: the columns come from
// the live field, in its order; the cards match their status.
func TestBoardWithProject(t *testing.T) {
	reg, gh := newRegistry(t, feedOnly(t, fixture(t, "feed-project.json")))
	tr, _ := reg.For(projectCfg)
	if info := tr.Info(); info.ID != "github" || info.Name != "GitHub" || !info.Capabilities.SetStatus || !info.Capabilities.Close {
		t.Fatalf("info = %+v", info)
	}
	b, err := tr.Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantCols := []tracker.Column{{ID: "", Name: "No status"}, {ID: "49294ed0", Name: "Todo"}, {ID: "ae6334b4", Name: "Doing"},
		{ID: "64e1b0ac", Name: "QA"}, {ID: "ccf5765b", Name: "Done", Done: true}}
	if !slices.Equal(b.Columns, wantCols) {
		t.Fatalf("columns = %+v", b.Columns)
	}
	cards := cardsByKey(b)
	// By update time. #4 was closed on the cut-off day but before its exact
	// time (out), #6 just after it (in).
	keys := []string{}
	for _, c := range b.Cards {
		keys = append(keys, c.Key)
	}
	if !slices.Equal(keys, []string{"#9", "#32", "#7", "#30", "#31", "#6"}) {
		t.Fatalf("cards = %v", keys)
	}
	if c := cards["#6"]; c.State != "closed" || c.Column != "ccf5765b" {
		t.Fatalf("#6 = %+v", c)
	}
	nine := cards["#9"]
	if nine.ID != "JeffreyVdb/herdr-3d#9" || nine.Column != "ae6334b4" || nine.State != "open" || nine.Priority != "high" ||
		nine.Author != "dev" || nine.URL != "https://github.com/JeffreyVdb/herdr-3d/issues/9" || nine.Capabilities != nil ||
		len(nine.Assignees) != 1 || nine.Assignees[0].Name != "dev" || nine.ClosedAt != nil {
		t.Fatalf("#9 = %+v", nine)
	}
	if !slices.Equal(nine.Labels, []tracker.Label{{Name: "bridge", Color: "#1d76db"}, {Name: "P1", Color: "#b60205"}}) {
		t.Fatalf("#9 labels = %+v", nine.Labels)
	}
	if c := cards["#32"]; c.Column != "" || len(c.Labels) != 1 {
		t.Fatalf("an issue with no project item: %+v", c)
	}
	if c := cards["#31"]; c.Column != "" { // only a status in another project
		t.Fatalf("#31 = %+v", c)
	}
	if c := cards["#30"]; c.Column != "49294ed0" || c.Priority != "urgent" {
		t.Fatalf("#30 = %+v (critical beats a low label)", c)
	}
	seven := cards["#7"]
	if seven.State != "closed" || seven.ClosedAt == nil || *seven.ClosedAt != time.Date(2026, 9, 29, 9, 19, 1, 0, time.UTC).UnixMilli() ||
		seven.Column != "ccf5765b" || seven.Capabilities == nil || seven.Capabilities.Close || !seven.Capabilities.Comment {
		t.Fatalf("#7 = %+v", seven)
	}
	if b.Truncated || b.Rate == nil || b.Rate.Remaining != 4870 || b.Rate.Cost != 12 ||
		b.Rate.ResetAt != time.Date(2026, 9, 29, 13, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("truncated %v, rate %+v", b.Truncated, b.Rate)
	}
	v := gh.last(githubcli.DocFeed)
	if v["owner"] != "JeffreyVdb" || v["repo"] != "herdr-3d" || v["projectOwner"] != "JeffreyVdb" || v["projectNumber"] != 2.0 ||
		v["hasProject"] != true || v["statusField"] != "Status" ||
		v["closedQuery"] != "repo:JeffreyVdb/herdr-3d is:issue is:closed closed:>=2026-09-22" ||
		len(v["watchedPRIds"].([]any)) != 0 {
		t.Fatalf("variables = %v", v)
	}
}

// A repository without a project: Open and Closed, and nothing to set.
func TestBoardWithoutProject(t *testing.T) {
	reg, gh := newRegistry(t, feedOnly(t, fixture(t, "feed-noproject.json")))
	tr, _ := reg.For(Config{Repo: "JeffreyVdb/h3d-lab"})
	if tr.Info().Capabilities.SetStatus {
		t.Fatal("a board without a project can set a status")
	}
	b, err := tr.Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(b.Columns, []tracker.Column{{ID: "open", Name: "Open"}, {ID: "closed", Name: "Closed", Done: true}}) {
		t.Fatalf("columns = %+v", b.Columns)
	}
	cards := cardsByKey(b)
	if len(cards) != 2 || cards["#1"].Column != "open" || cards["#3"].Column != "closed" || cards["#3"].State != "closed" {
		t.Fatalf("cards = %+v", b.Cards)
	}
	if v := gh.last(githubcli.DocFeed); v["hasProject"] != false || v["projectOwner"] != "JeffreyVdb" || v["projectNumber"] != 0.0 {
		t.Fatalf("variables = %v", v)
	}
	err = tr.SetStatus(context.Background(), "JeffreyVdb/h3d-lab#1", "open")
	if !errors.Is(err, provider.ErrUnsupported) {
		t.Fatalf("SetStatus without a project: %v", err)
	}
}

// The pull requests: checks, review, mergeability, closes.
func TestRequests(t *testing.T) {
	reg, _ := newRegistry(t, feedOnly(t, fixture(t, "feed-project.json")))
	_, host := reg.For(projectCfg)
	b, err := host.Board(context.Background(), codehost.PrevState{})
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]codehost.Request{}
	for _, r := range b.Requests {
		by[r.Key] = r
	}
	if len(by) != 4 || len(b.Merged) != 0 {
		t.Fatalf("requests = %+v merged %+v", b.Requests, b.Merged)
	}
	ok := by["#31"]
	if ok.ID != "JeffreyVdb/herdr-3d#31" || ok.State != "open" || ok.Checks != "success" || ok.Review != "approved" ||
		ok.Mergeable != "mergeable" || ok.HeadBranch != "feat/7-m6" || ok.BaseBranch != "main" || ok.Draft || ok.Author != "dev" ||
		!slices.Equal(ok.Closes, []string{"JeffreyVdb/herdr-3d#7", "other-org/web#3"}) || ok.Additions != 120 || ok.Deletions != 8 ||
		ok.ChangedFiles != 4 || ok.URL != "https://github.com/JeffreyVdb/herdr-3d/pull/31" {
		t.Fatalf("#31 = %+v", ok)
	}
	if r := by["#33"]; r.Checks != "failure" || r.Review != "changes_requested" || r.Mergeable != "mergeable" {
		t.Fatalf("failing checks: %+v", r)
	}
	// A null rollup is "none", never green.
	if r := by["#34"]; r.Checks != "none" || r.Review != "none" || r.Mergeable != "conflicting" || !r.Draft || len(r.Closes) != 0 {
		t.Fatalf("no rollup: %+v", r)
	}
	if r := by["#35"]; r.Checks != "pending" || r.Review != "review_required" || r.Mergeable != "unknown" {
		t.Fatalf("pending: %+v", r)
	}
}

// One feed serves both boards of a poll, and floors that link the same
// repository and project share it.
func TestSharedFeed(t *testing.T) {
	reg, gh := newRegistry(t, feedOnly(t, fixture(t, "feed-project.json")))
	tr, host := reg.For(projectCfg)
	tr2, host2 := reg.For(projectCfg)
	ctx := context.Background()
	if _, err := host.Board(ctx, codehost.PrevState{}); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := tr2.Board(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := host2.Board(ctx, codehost.PrevState{}); err != nil {
		t.Fatal(err)
	}
	if n := len(gh.docs()); n != 1 {
		t.Fatalf("%d feed calls for one poll of two floors", n)
	}
	if projectCfg.Key() != (Config{Repo: "jeffreyvdb/HERDR-3D", ProjectOwner: "jeffreyvdb", ProjectNumber: 2, StatusField: "status"}).Key() {
		t.Fatal("the key depends on case")
	}
	// Later (past the reuse window) it is fetched again.
	testNow = testNow.Add(time.Minute)
	defer func() { testNow = testNow.Add(-time.Minute) }()
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(gh.docs()); n != 2 {
		t.Fatalf("%d feed calls after a minute", n)
	}
}

// A request open at the last poll and merged now is a transition; one that
// cannot be read, or was closed, is not. After a restart (no node ids in
// memory) the ids are looked up first.
func TestMergedBetweenPolls(t *testing.T) {
	cfg := Config{Repo: "JeffreyVdb/h3d-lab"}
	handle := func(doc githubcli.Doc, vars map[string]any) (string, error) {
		switch doc {
		case githubcli.DocFeed:
			if ids, _ := vars["watchedPRIds"].([]any); len(ids) == 0 {
				return fixture(t, "feed-noproject.json"), nil
			}
			return fixture(t, "feed-merged.json"), nil
		case githubcli.DocPRNode:
			n := int(vars["number"].(float64))
			if n == 99 {
				return `{"data":{"repository":{"pullRequest":null}}}`, nil
			}
			return fmt.Sprintf(`{"data":{"repository":{"pullRequest":{"id":"PR_%d","number":%d,"state":"OPEN"}}}}`, n, n), nil
		}
		t.Errorf("unexpected %s", doc)
		return "", nil
	}
	reg, gh := newRegistry(t, handle)
	_, host := reg.For(cfg)
	ctx := context.Background()
	first, err := host.Board(ctx, codehost.PrevState{})
	if err != nil || len(first.Merged) != 0 || len(first.Requests) != 2 {
		t.Fatalf("first poll: %+v %v", first, err)
	}
	testNow = testNow.Add(time.Minute)
	defer func() { testNow = testNow.Add(-time.Minute) }()
	prev := codehost.PrevState{OpenIDs: []string{"JeffreyVdb/h3d-lab#2", "JeffreyVdb/h3d-lab#4"}}
	second, err := host.Board(ctx, prev)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.Requests) != 1 || second.Requests[0].Key != "#2" {
		t.Fatalf("open = %+v", second.Requests)
	}
	want := codehost.Merged{ID: "JeffreyVdb/h3d-lab#4", Key: "#4", Title: "Probe PR", MergedAt: time.Date(2026, 9, 29, 9, 31, 22, 0, time.UTC).UnixMilli(),
		Closes: []string{"JeffreyVdb/h3d-lab#3"}}
	if len(second.Merged) != 1 || !slices.Equal(second.Merged[0].Closes, want.Closes) || second.Merged[0].ID != want.ID ||
		second.Merged[0].MergedAt != want.MergedAt || second.Merged[0].Title != want.Title || second.Merged[0].Key != want.Key {
		t.Fatalf("merged = %+v", second.Merged)
	}
	if ids := gh.last(githubcli.DocFeed)["watchedPRIds"].([]any); len(ids) != 2 || ids[0] != "PR_2" || ids[1] != "PR_4" {
		t.Fatalf("watched node ids = %v (known from the first poll)", ids)
	}
	for _, d := range gh.docs() {
		if d == githubcli.DocPRNode {
			t.Fatal("looked up node ids that the first poll knew")
		}
	}

	// A restarted bridge knows the ids only as the cache has them.
	reg2, gh2 := newRegistry(t, handle)
	_, host2 := reg2.For(cfg)
	prev.OpenIDs = append(prev.OpenIDs, "JeffreyVdb/h3d-lab#99", "someone-else/repo#5", "not an id")
	third, err := host2.Board(ctx, prev)
	if err != nil || len(third.Merged) != 1 {
		t.Fatalf("after a restart: %+v %v", third, err)
	}
	lookups := 0
	for _, c := range gh2.calls {
		if c.doc == githubcli.DocPRNode {
			lookups++
		}
	}
	if lookups != 3 { // #2, #4 and #99; another repo and a bad id are not looked up
		t.Fatalf("%d lookups", lookups)
	}
	if ids := gh2.last(githubcli.DocFeed)["watchedPRIds"].([]any); len(ids) != 2 {
		t.Fatalf("watched = %v", ids)
	}
}

// Past 100 open issues the next page is followed, up to five; past that the
// board says it is truncated.
func TestPaging(t *testing.T) {
	var feed map[string]any
	if err := json.Unmarshal([]byte(fixture(t, "feed-noproject.json")), &feed); err != nil {
		t.Fatal(err)
	}
	repo := feed["data"].(map[string]any)["repository"].(map[string]any)
	repo["openIssues"].(map[string]any)["pageInfo"] = map[string]any{"hasNextPage": true, "endCursor": "c1"}
	first, _ := json.Marshal(feed)
	pages := 0
	handle := func(doc githubcli.Doc, vars map[string]any) (string, error) {
		switch doc {
		case githubcli.DocFeed:
			return string(first), nil
		case githubcli.DocIssuesPage:
			pages++
			if want := fmt.Sprintf("c%d", pages); vars["after"] != want {
				t.Errorf("page %d after %v", pages, vars["after"])
			}
			return fmt.Sprintf(`{"data":{"repository":{"openIssues":{"pageInfo":{"hasNextPage":true,"endCursor":"c%d"},"nodes":[
				{"id":"I_p%d","number":%d,"title":"more","state":"OPEN","updatedAt":"2026-09-2%dT08:00:00Z","createdAt":"2026-09-01T08:00:00Z",
				"labels":{"pageInfo":{"hasNextPage":false},"nodes":[]},"assignees":{"pageInfo":{"hasNextPage":false},"nodes":[]},
				"projectItems":{"pageInfo":{"hasNextPage":false},"nodes":[]}}]}}}}`, pages+1, pages, 100+pages, pages), nil
		}
		t.Errorf("unexpected %s", doc)
		return "", nil
	}
	reg, _ := newRegistry(t, handle)
	tr, _ := reg.For(Config{Repo: "JeffreyVdb/h3d-lab"})
	b, err := tr.Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if pages != 4 || len(b.Cards) != 2+4 || !b.Truncated {
		t.Fatalf("%d pages, %d cards, truncated %v", pages, len(b.Cards), b.Truncated)
	}
}

// A nested connection with more than it returned makes the board truncated.
func TestNestedTruncation(t *testing.T) {
	var feed map[string]any
	if err := json.Unmarshal([]byte(fixture(t, "feed-noproject.json")), &feed); err != nil {
		t.Fatal(err)
	}
	issue := feed["data"].(map[string]any)["repository"].(map[string]any)["openIssues"].(map[string]any)["nodes"].([]any)[0].(map[string]any)
	issue["labels"].(map[string]any)["pageInfo"] = map[string]any{"hasNextPage": true, "endCursor": "x"}
	body, _ := json.Marshal(feed)
	reg, _ := newRegistry(t, feedOnly(t, string(body)))
	tr, _ := reg.For(Config{Repo: "JeffreyVdb/h3d-lab"})
	b, err := tr.Board(context.Background())
	if err != nil || !b.Truncated {
		t.Fatalf("truncated = %v, %v", b.Truncated, err)
	}
}

func TestFeedErrors(t *testing.T) {
	ctx := context.Background()
	answer := func(body string, err error) func(githubcli.Doc, map[string]any) (string, error) {
		return func(githubcli.Doc, map[string]any) (string, error) { return body, err }
	}
	cases := []struct {
		name string
		cfg  Config
		body string
		err  error
		is   error
		msg  string
	}{
		{"missing project", projectCfg, `{"data":{"repositoryOwner":{"projectV2":null}},"errors":[{"type":"NOT_FOUND","path":["repositoryOwner","projectV2"],"message":"Could not resolve to a ProjectV2 with the number 2."}]}`,
			&githubcli.ExitError{Code: 1}, provider.ErrFailed, "GitHub project 2 of JeffreyVdb not found"},
		{"missing repository", Config{Repo: "JeffreyVdb/nope"}, `{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"message":"Could not resolve to a Repository with the name 'JeffreyVdb/nope'."}]}`,
			&githubcli.ExitError{Code: 1}, provider.ErrNotFound, "GitHub repository JeffreyVdb/nope not found"},
		{"a project without the status field", Config{Repo: "JeffreyVdb/herdr-3d", ProjectOwner: "JeffreyVdb", ProjectNumber: 2, StatusField: "Stage"},
			fixture(t, "feed-project.json"), nil, provider.ErrFailed, `has no single-select field "Stage"`},
		{"bad credentials", projectCfg, `{"message":"Bad credentials","documentation_url":"x","status":"401"}`, &githubcli.ExitError{Code: 1},
			provider.ErrFailed, "GitHub auth"},
	}
	for _, c := range cases {
		reg, _ := newRegistry(t, answer(c.body, c.err))
		tr, _ := reg.For(c.cfg)
		_, err := tr.Board(ctx)
		if !errors.Is(err, c.is) || err == nil || !strings.Contains(err.Error(), c.msg) {
			t.Errorf("%s: err = %v, want %v with %q", c.name, err, c.is, c.msg)
		}
	}
	// A rate limit is its own error, with the reset the data names.
	reg, _ := newRegistry(t, answer(`{"data":{"rateLimit":{"cost":1,"limit":5000,"remaining":0,"resetAt":"2026-09-29T13:00:00Z"}},"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}`, nil))
	tr, _ := reg.For(projectCfg)
	_, err := tr.Board(ctx)
	var rl *provider.RateLimitError
	if !errors.As(err, &rl) || !rl.ResetAt.Equal(time.Date(2026, 9, 29, 13, 0, 0, 0, time.UTC)) {
		t.Fatalf("rate limit: %v", err)
	}
}

func TestRunLinker(t *testing.T) {
	reg, _ := newRegistry(t, nil)
	tr, _ := reg.For(Config{Repo: "JeffreyVdb/herdr-3d"})
	rl, ok := tr.(tracker.RunLinker)
	if !ok {
		t.Fatal("the GitHub tracker does not map runs")
	}
	if id, ok := rl.ItemFromRun("jeffreyvdb/HERDR-3D", 9); !ok || id != "JeffreyVdb/herdr-3d#9" {
		t.Fatalf("ItemFromRun = %q %v", id, ok)
	}
	if id, _ := rl.ItemFromRun("other/repo", 3); id != "other/repo#3" {
		t.Fatalf("other repo: %q", id)
	}
	if repo, n, url, ok := rl.RunFromItem("JeffreyVdb/herdr-3d#9"); !ok || repo != "JeffreyVdb/herdr-3d" || n != 9 ||
		url != "https://github.com/JeffreyVdb/herdr-3d/issues/9" {
		t.Fatalf("RunFromItem = %q %d %q %v", repo, n, url, ok)
	}
	for _, bad := range []string{"other/repo#3", "JeffreyVdb/herdr-3d#0", "JeffreyVdb/herdr-3d#x", "9", "JeffreyVdb/herdr-3d#09"} {
		if _, _, _, ok := rl.RunFromItem(bad); ok {
			t.Errorf("RunFromItem(%q) is ok", bad)
		}
	}
}
