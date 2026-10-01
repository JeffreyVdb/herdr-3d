package github

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/githubcli"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// edit changes a fixture through fn.
func edit(t *testing.T, name string, fn func(m map[string]any)) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(fixture(t, name)), &m); err != nil {
		t.Fatal(err)
	}
	fn(m)
	b, _ := json.Marshal(m)
	return string(b)
}

func dig(m map[string]any, path ...string) map[string]any {
	for _, p := range path {
		m = m[p].(map[string]any)
	}
	return m
}

func TestIssueDetail(t *testing.T) {
	reg, _ := newRegistry(t, func(doc githubcli.Doc, vars map[string]any) (string, error) {
		switch doc {
		case githubcli.DocFeed:
			return fixture(t, "feed-project.json"), nil
		case githubcli.DocIssueDetail:
			if vars["number"] != 9.0 || vars["owner"] != "JeffreyVdb" || vars["repo"] != "herdr-3d" {
				t.Errorf("vars = %v", vars)
			}
			return fixture(t, "issue-detail.json"), nil
		}
		t.Errorf("unexpected %s", doc)
		return "", nil
	})
	tr, _ := reg.For(projectCfg)
	ctx := context.Background()
	d, err := tr.Get(ctx, "JeffreyVdb/herdr-3d#9")
	if err != nil {
		t.Fatal(err)
	}
	// Raw markdown: it is the game that sanitises.
	if d.Body != "Two boards.\n\n<img src=x onerror=alert(1)>" || d.Author.Name != "dev" || d.CreatedAt == 0 || !d.CommentsTruncated ||
		len(d.Comments) != 2 || d.Comments[0].Author.Name != "dev" || d.Comments[0].Body != "first" || d.Comments[1].Author.Name != "" {
		t.Fatalf("detail = %+v", d)
	}
	if d.Card.Key != "#9" || d.Card.Column != "" { // no board read yet: no column
		t.Fatalf("card = %+v", d.Card)
	}
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	if d, _ = tr.Get(ctx, "JeffreyVdb/herdr-3d#9"); d.Card.Column != "ae6334b4" || d.Card.Priority != "high" {
		t.Fatalf("card after a board = %+v", d.Card)
	}
	if _, err := tr.Get(ctx, "other/repo#9"); !errors.Is(err, provider.ErrNotFound) {
		t.Fatalf("an id of another repository: %v", err)
	}
}

func TestRequestDetail(t *testing.T) {
	reg, _ := newRegistry(t, func(doc githubcli.Doc, vars map[string]any) (string, error) {
		if doc != githubcli.DocPRDetail {
			t.Errorf("unexpected %s", doc)
		}
		return fixture(t, "pr-detail.json"), nil
	})
	_, host := reg.For(projectCfg)
	d, err := host.Get(context.Background(), "JeffreyVdb/herdr-3d#33")
	if err != nil {
		t.Fatal(err)
	}
	if d.Request.Key != "#33" || d.Request.State != "open" || d.Request.Checks != "failure" || d.Body != "Closes #1\n" ||
		!slices.Equal(d.Request.Closes, []string{"JeffreyVdb/h3d-lab#1"}) {
		t.Fatalf("request = %+v", d.Request)
	}
	wantFiles := []codehost.File{{Path: "main.go", Additions: 12, Deletions: 3, Change: "modified"},
		{Path: "new.go", Additions: 40, Change: "added"}, {Path: "old.go", Deletions: 9, Change: "removed"}}
	if !slices.Equal(d.Files, wantFiles) || d.FilesTruncated {
		t.Fatalf("files = %+v", d.Files)
	}
	wantChecks := []codehost.Check{{Name: "test", State: "failure", URL: "https://ci.example/test"}, {Name: "lint", State: "success", URL: "https://ci.example/lint"},
		{Name: "docs", State: "neutral", URL: "https://ci.example/docs"}, {Name: "e2e", State: "pending", URL: "https://ci.example/e2e"},
		{Name: "ci/legacy", State: "success", URL: "https://ci.example/legacy"}}
	if !slices.Equal(d.Checks, wantChecks) {
		t.Fatalf("checks = %+v", d.Checks)
	}
	if len(d.Comments) != 1 || d.Comments[0].Author.Name != "rev" {
		t.Fatalf("comments = %+v", d.Comments)
	}
}

// writes answers the lookups and mutations of the write tests, recording nothing itself: the
// fakeGH does.
func writes(t *testing.T, extra func(doc githubcli.Doc, vars map[string]any) (string, bool)) func(githubcli.Doc, map[string]any) (string, error) {
	return func(doc githubcli.Doc, vars map[string]any) (string, error) {
		if out, ok := extra(doc, vars); ok {
			return out, nil
		}
		switch doc {
		case githubcli.DocIssueNode:
			return fmt.Sprintf(`{"data":{"repository":{"issue":{"id":"I_%v","number":%v,"state":"OPEN"}}}}`, vars["number"], vars["number"]), nil
		case githubcli.DocPRNode:
			return fmt.Sprintf(`{"data":{"repository":{"pullRequest":{"id":"PR_%v","number":%v,"state":"OPEN"}}}}`, vars["number"], vars["number"]), nil
		case githubcli.DocAddComment:
			return `{"data":{"addComment":{"commentEdge":{"node":{"id":"IC_new","body":"hi","createdAt":"2026-09-29T09:29:42Z","author":{"login":"dev","avatarUrl":"https://a/1"}}},"subject":{"id":"x"}}}}`, nil
		case githubcli.DocCloseIssue:
			return `{"data":{"closeIssue":{"issue":{"id":"I","number":9,"state":"CLOSED"}}}}`, nil
		}
		t.Errorf("unexpected %s", doc)
		return "", nil
	}
}

func none(githubcli.Doc, map[string]any) (string, bool) { return "", false }

func TestComment(t *testing.T) {
	reg, gh := newRegistry(t, writes(t, func(doc githubcli.Doc, _ map[string]any) (string, bool) {
		if doc == githubcli.DocFeed {
			return fixture(t, "feed-project.json"), true
		}
		return "", false
	}))
	tr, host := reg.For(projectCfg)
	ctx := context.Background()
	// Not seen yet: the node id is looked up; then the comment.
	c, err := tr.Comment(ctx, "JeffreyVdb/herdr-3d#9", "a comment")
	if err != nil || c.ID != "IC_new" || c.Author.Name != "dev" || c.CreatedAt == 0 {
		t.Fatalf("comment = %+v %v", c, err)
	}
	if !slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocIssueNode, githubcli.DocAddComment}) {
		t.Fatalf("calls = %v", gh.docs())
	}
	if v := gh.last(githubcli.DocAddComment); v["subjectId"] != "I_9" || v["body"] != "a comment" {
		t.Fatalf("vars = %v", v)
	}
	// The node id is remembered, and a feed teaches the ids of the board.
	if _, err := tr.Comment(ctx, "JeffreyVdb/herdr-3d#9", "again"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := host.Comment(ctx, "JeffreyVdb/herdr-3d#31", "on a pull request"); err != nil {
		t.Fatal(err)
	}
	if v := gh.last(githubcli.DocAddComment); v["subjectId"] != "PR_31" {
		t.Fatalf("pull request comment vars = %v", v)
	}
	n := len(gh.docs())
	if _, err := tr.Comment(ctx, "other/repo#3", "x"); !errors.Is(err, provider.ErrNotFound) || len(gh.docs()) != n {
		t.Fatalf("a comment on another repository: %v", err)
	}
	// A write makes the board stale: the next read fetches it again.
	before := 0
	for _, d := range gh.docs() {
		if d == githubcli.DocFeed {
			before++
		}
	}
	if _, err := tr.Comment(ctx, "JeffreyVdb/herdr-3d#9", "x"); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	after := 0
	for _, d := range gh.docs() {
		if d == githubcli.DocFeed {
			after++
		}
	}
	if after != before+1 {
		t.Fatalf("feeds %d then %d after a comment", before, after)
	}
}

func TestClose(t *testing.T) {
	reg, gh := newRegistry(t, writes(t, none))
	tr, _ := reg.For(projectCfg)
	ctx := context.Background()
	for reason, want := range map[string]string{"completed": "COMPLETED", "not_planned": "NOT_PLANNED", "duplicate": "DUPLICATE"} {
		if err := tr.Close(ctx, "JeffreyVdb/herdr-3d#9", reason); err != nil {
			t.Fatal(err)
		}
		if v := gh.last(githubcli.DocCloseIssue); v["reason"] != want || v["issueId"] != "I_9" {
			t.Fatalf("%s: vars = %v", reason, v)
		}
	}
	before := len(gh.docs())
	if err := tr.Close(ctx, "JeffreyVdb/herdr-3d#9", "wontfix"); !errors.Is(err, provider.ErrBadInput) || len(gh.docs()) != before {
		t.Fatalf("a bad reason: %v", err)
	}
}

func statusTarget(inProject bool) string {
	items := `[]`
	if inProject {
		items = `[{"id":"PVTI_other","project":{"id":"PVT_other","number":9}},{"id":"PVTI_9","project":{"id":"PVT_x","number":2}}]`
	}
	return `{"data":{"repository":{"issue":{"id":"I_9","number":9,"projectItems":{"nodes":` + items + `}}},
		"repositoryOwner":{"__typename":"User","projectV2":{"id":"PVT_x","number":2,"title":"b","fields":{"nodes":[{},
		{"id":"F_status","name":"Status","options":[{"id":"49294ed0","name":"Todo"},{"id":"ae6334b4","name":"Doing"}]}]}}}}}`
}

func TestSetStatus(t *testing.T) {
	inProject := true
	reg, gh := newRegistry(t, writes(t, func(doc githubcli.Doc, _ map[string]any) (string, bool) {
		switch doc {
		case githubcli.DocStatusTarget:
			return statusTarget(inProject), true
		case githubcli.DocAddProjectItem:
			return `{"data":{"addProjectV2ItemById":{"item":{"id":"PVTI_new","project":{"id":"PVT_x","number":2}}}}}`, true
		case githubcli.DocSetStatus:
			return `{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"x"}}}}`, true
		}
		return "", false
	}))
	tr, _ := reg.For(projectCfg)
	ctx := context.Background()
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#9", "ae6334b4", nil); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus}) {
		t.Fatalf("calls = %v", gh.docs())
	}
	// The item of the configured project (not the first one) gets the option of its field.
	v := gh.last(githubcli.DocSetStatus)
	if v["projectId"] != "PVT_x" || v["itemId"] != "PVTI_9" || v["fieldId"] != "F_status" || v["optionId"] != "ae6334b4" {
		t.Fatalf("vars = %v", v)
	}
	// An issue that is not in the project is added first.
	inProject = false
	gh.calls = nil
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#9", "49294ed0", nil); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocAddProjectItem, githubcli.DocSetStatus}) {
		t.Fatalf("calls = %v", gh.docs())
	}
	if v := gh.last(githubcli.DocAddProjectItem); v["projectId"] != "PVT_x" || v["contentId"] != "I_9" {
		t.Fatalf("add vars = %v", v)
	}
	if v := gh.last(githubcli.DocSetStatus); v["itemId"] != "PVTI_new" {
		t.Fatalf("set vars = %v", v)
	}
	// A column the field does not have is refused before anything is written.
	gh.calls = nil
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#9", "zzzz", nil); !errors.Is(err, provider.ErrBadInput) ||
		!slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocStatusTarget}) {
		t.Fatalf("an unknown column: %v %v", err, gh.docs())
	}
}

// target is the status-target answer for issue number n of the fixture's
// project: its item (none: not in the project) with its status.
func target(n int, item, status string) string {
	items := `[]`
	if item != "" {
		value := `null`
		if status != "" {
			value = `{"optionId":"` + status + `"}`
		}
		items = `[{"id":"PVTI_other","project":{"id":"PVT_other","number":9},"fieldValueByName":{"optionId":"zzzz"}},
			{"id":"` + item + `","project":{"id":"PVT_kwHOAAplCs4Bk8CS","number":2},"fieldValueByName":` + value + `}]`
	}
	return fmt.Sprintf(`{"data":{"repository":{"issue":{"id":"I_%d","number":%d,"projectItems":{"nodes":%s}}},
		"repositoryOwner":{"__typename":"User","projectV2":{"id":"PVT_kwHOAAplCs4Bk8CS","number":2,"title":"b","fields":{"nodes":[{},
		{"id":"F_status","name":"Status","options":[{"id":"49294ed0","name":"Todo"},{"id":"ae6334b4","name":"Doing"},
		{"id":"64e1b0ac","name":"QA"},{"id":"ccf5765b","name":"Done"}]}]}}}}}`, n, n, items)
}

// orderBoard is a registry whose GitHub has the fixture's project (its order:
// #7 Done, a draft, #30 Todo, a pull request, another repository's issue in
// Doing, #9 Doing, content out of reach, #4 (not a card), #6 Done) and
// answers status-target from targets; the position write fails with posErr
// when it is set.
func orderBoard(t *testing.T, targets map[float64]string, posErr *string) (*Registry, *fakeGH) {
	return newRegistry(t, writes(t, func(doc githubcli.Doc, vars map[string]any) (string, bool) {
		switch doc {
		case githubcli.DocFeed:
			return fixture(t, "feed-project.json"), true
		case githubcli.DocStatusTarget:
			if vars["statusField"] != "Status" {
				t.Errorf("status-target vars = %v", vars)
			}
			return targets[vars["number"].(float64)], true
		case githubcli.DocAddProjectItem:
			return `{"data":{"addProjectV2ItemById":{"item":{"id":"PVTI_new","project":{"id":"PVT_kwHOAAplCs4Bk8CS","number":2}}}}}`, true
		case githubcli.DocSetStatus:
			return `{"data":{"updateProjectV2ItemFieldValue":{"projectV2Item":{"id":"x"}}}}`, true
		case githubcli.DocSetPosition:
			if posErr != nil && *posErr != "" {
				return `{"data":{"updateProjectV2ItemPosition":null},"errors":[{"type":"FORBIDDEN","message":"` + *posErr + `"}]}`, true
			}
			return `{"data":{"updateProjectV2ItemPosition":{"clientMutationId":null}}}`, true
		case githubcli.DocItemsPage:
			// The order after the moves: #30 went to Doing after #9.
			return `{"data":{"node":{"items":{"pageInfo":{"hasNextPage":false},"nodes":[
				{"id":"PVTI_7","content":{"__typename":"Issue","id":"I_7"},"fieldValueByName":{"optionId":"ccf5765b"}},
				{"id":"PVTI_9","content":{"__typename":"Issue","id":"I_9"},"fieldValueByName":{"optionId":"ae6334b4"}},
				{"id":"PVTI_30","content":{"__typename":"Issue","id":"I_30"},"fieldValueByName":{"optionId":"ae6334b4"}},
				{"id":"PVTI_6","content":{"__typename":"Issue","id":"I_6"},"fieldValueByName":{"optionId":"ccf5765b"}}]}}}}`, true
		}
		return "", false
	}))
}

// SetStatus with an anchor: the status (when it changes), then the place,
// with the afterId the slot means in the project's one order.
func TestSetStatusOrder(t *testing.T) {
	ctx := context.Background()
	const todo, doing, qa, done = "49294ed0", "ae6334b4", "64e1b0ac", "ccf5765b"
	targets := map[float64]string{30: target(30, "PVTI_30", todo), 9: target(9, "PVTI_9", doing), 6: target(6, "PVTI_6", done),
		32: target(32, "", "")}
	posErr := ""
	for _, tc := range []struct {
		name  string
		id    string
		col   string
		after string // "" the top
		docs  []githubcli.Doc
		vars  map[string]any // of the position write
	}{
		{"after a card of another column", "JeffreyVdb/herdr-3d#30", doing, "JeffreyVdb/herdr-3d#9",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_30", "afterId": "PVTI_9"}},
		// Doing's first card is #9: right after the item before it (another
		// repository's issue), the moved card left out.
		{"the top of a column", "JeffreyVdb/herdr-3d#30", doing, "",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_30", "afterId": "PVTI_elsewhere"}},
		// Done's first card #7 is the project's first item: no afterId.
		{"the top of a column that starts the project", "JeffreyVdb/herdr-3d#30", done, "",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_30"}},
		{"an empty column", "JeffreyVdb/herdr-3d#30", qa, "",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_30"}},
		// A move within its own column writes no status.
		{"a reorder in the column", "JeffreyVdb/herdr-3d#6", done, "",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_6"}},
		{"after a card further down", "JeffreyVdb/herdr-3d#7", done, "JeffreyVdb/herdr-3d#6",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_7", "afterId": "PVTI_6"}},
		// Not in the project yet: added, its status set, then its place.
		{"not in the project", "JeffreyVdb/herdr-3d#32", doing, "JeffreyVdb/herdr-3d#9",
			[]githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocAddProjectItem, githubcli.DocSetStatus, githubcli.DocSetPosition},
			map[string]any{"projectId": "PVT_kwHOAAplCs4Bk8CS", "itemId": "PVTI_new", "afterId": "PVTI_9"}},
	} {
		reg, gh := orderBoard(t, targets, &posErr)
		tr, _ := reg.For(projectCfg)
		if _, err := tr.Board(ctx); err != nil {
			t.Fatal(err)
		}
		gh.calls = nil
		if tc.id == "JeffreyVdb/herdr-3d#7" {
			targets[7] = target(7, "PVTI_7", todo) // its status is not Done (yet)
		}
		if err := tr.SetStatus(ctx, tc.id, tc.col, &tracker.Anchor{After: tc.after}); err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if !slices.Equal(gh.docs(), tc.docs) {
			t.Fatalf("%s: calls = %v", tc.name, gh.docs())
		}
		if v := gh.last(githubcli.DocSetPosition); !maps.Equal(v, tc.vars) {
			t.Fatalf("%s: position vars = %v, want %v", tc.name, v, tc.vars)
		}
		if slices.Contains(tc.docs, githubcli.DocSetStatus) {
			if v := gh.last(githubcli.DocSetStatus); v["optionId"] != tc.col {
				t.Fatalf("%s: status vars = %v", tc.name, v)
			}
		}
	}

	// Without an anchor nothing changes: the status only, also in its own column.
	reg, gh := orderBoard(t, targets, &posErr)
	tr, _ := reg.For(projectCfg)
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#9", doing, nil); err != nil ||
		!slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocSetStatus}) {
		t.Fatalf("a status only: %v %v", err, gh.docs())
	}

	// After a write the order is read again (the feed's is stale), its cards the feed's.
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#30", doing, &tracker.Anchor{After: "JeffreyVdb/herdr-3d#9"}); err != nil {
		t.Fatal(err)
	}
	gh.calls = nil
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#6", doing, &tracker.Anchor{}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocStatusTarget, githubcli.DocItemsPage, githubcli.DocSetStatus, githubcli.DocSetPosition}) {
		t.Fatalf("calls = %v", gh.docs())
	}
	// Doing starts with #9 now, right after #7.
	if v := gh.last(githubcli.DocSetPosition); v["afterId"] != "PVTI_7" || v["itemId"] != "PVTI_6" {
		t.Fatalf("position vars = %v", v)
	}
	if v := gh.last(githubcli.DocItemsPage); v["after"] != nil || v["projectId"] != "PVT_kwHOAAplCs4Bk8CS" {
		t.Fatalf("items vars = %v", v)
	}

	// An anchor that is not in the project's order: stale, nothing written.
	reg, gh = orderBoard(t, targets, &posErr)
	tr, _ = reg.For(projectCfg)
	if _, err := tr.Board(ctx); err != nil {
		t.Fatal(err)
	}
	gh.calls = nil
	if err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#30", doing, &tracker.Anchor{After: "JeffreyVdb/herdr-3d#32"}); !errors.Is(err, provider.ErrStale) ||
		!slices.Equal(gh.docs(), []githubcli.Doc{githubcli.DocStatusTarget}) {
		t.Fatalf("a stale anchor: %v %v", err, gh.docs())
	}

	// The status is written, the place is not: the error says which.
	posErr = "Resource not accessible by integration"
	err := tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#30", doing, &tracker.Anchor{After: "JeffreyVdb/herdr-3d#9"})
	if !errors.Is(err, provider.ErrFailed) || !errors.Is(err, provider.ErrPartial) || !strings.Contains(err.Error(), "status changed, but its place") ||
		!strings.Contains(err.Error(), "Resource not accessible") || !slices.Contains(gh.docs(), githubcli.DocSetStatus) {
		t.Fatalf("a failed place: %v %v", err, gh.docs())
	}
	// A reorder that fails changed nothing: the plain error.
	err = tr.SetStatus(ctx, "JeffreyVdb/herdr-3d#6", done, &tracker.Anchor{})
	if !errors.Is(err, provider.ErrFailed) || errors.Is(err, provider.ErrPartial) || strings.Contains(err.Error(), "status changed") {
		t.Fatalf("a failed reorder: %v", err)
	}
	posErr = ""
}

// An issue added to the project whose status then fails: the add landed,
// so the error is partial.
func TestSetStatusPartialAdd(t *testing.T) {
	reg, _ := newRegistry(t, writes(t, func(doc githubcli.Doc, vars map[string]any) (string, bool) {
		switch doc {
		case githubcli.DocStatusTarget:
			return target(32, "", ""), true
		case githubcli.DocAddProjectItem:
			return `{"data":{"addProjectV2ItemById":{"item":{"id":"PVTI_new","project":{"id":"PVT_kwHOAAplCs4Bk8CS","number":2}}}}}`, true
		case githubcli.DocSetStatus:
			return `{"data":{"updateProjectV2ItemFieldValue":null},"errors":[{"type":"FORBIDDEN","message":"no"}]}`, true
		}
		return "", false
	}))
	tr, _ := reg.For(projectCfg)
	err := tr.SetStatus(context.Background(), "JeffreyVdb/herdr-3d#32", "ae6334b4", nil)
	if !errors.Is(err, provider.ErrFailed) || !errors.Is(err, provider.ErrPartial) || !strings.Contains(err.Error(), "added to the project") {
		t.Fatalf("a failed status after an add: %v", err)
	}
}

// prDetailWith is the failing-checks pull request with its state changed.
func prDetailWith(t *testing.T, state, rollup, mergeable string) string {
	return edit(t, "pr-detail.json", func(m map[string]any) {
		pr := dig(m, "data", "repository", "pullRequest")
		pr["state"], pr["mergeable"] = state, mergeable
		if rollup == "" {
			pr["commits"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["commit"].(map[string]any)["statusCheckRollup"] = nil
		} else {
			pr["commits"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["commit"].(map[string]any)["statusCheckRollup"].(map[string]any)["state"] = rollup
		}
	})
}

func TestMerge(t *testing.T) {
	ctx := context.Background()
	merge := func(detail string, mergeErr string) (codehost.Host, *fakeGH) {
		reg, gh := newRegistry(t, writes(t, func(doc githubcli.Doc, _ map[string]any) (string, bool) {
			switch doc {
			case githubcli.DocPRDetail:
				return detail, true
			case githubcli.DocMergePR:
				if mergeErr != "" {
					return mergeErr, true
				}
				return `{"data":{"mergePullRequest":{"pullRequest":{"id":"PR_33","number":33,"state":"MERGED","merged":true}}}}`, true
			}
			return "", false
		}))
		_, host := reg.For(projectCfg)
		return host, gh
	}
	const id = "JeffreyVdb/herdr-3d#33"
	merged := func(gh *fakeGH) bool {
		for _, d := range gh.docs() {
			if d == githubcli.DocMergePR {
				return true
			}
		}
		return false
	}

	// Green and mergeable: merged with the head that was read a moment ago.
	host, gh := merge(prDetailWith(t, "OPEN", "SUCCESS", "MERGEABLE"), "")
	for method, want := range map[string]string{"merge": "MERGE", "squash": "SQUASH", "rebase": "REBASE"} {
		if err := host.Merge(ctx, id, method, false); err != nil {
			t.Fatal(err)
		}
		v := gh.last(githubcli.DocMergePR)
		if v["method"] != want || v["pullRequestId"] != "PR_33" || v["expectedHeadOid"] != strings.Repeat("a", 40) {
			t.Fatalf("%s: vars = %v", method, v)
		}
	}
	if err := host.Merge(ctx, id, "fast-forward", false); !errors.Is(err, provider.ErrBadInput) {
		t.Fatalf("a bad method: %v", err)
	}

	// Failing checks: refused without an override, merged with one.
	host, gh = merge(prDetailWith(t, "OPEN", "FAILURE", "MERGEABLE"), "")
	if err := host.Merge(ctx, id, "squash", false); !errors.Is(err, provider.ErrChecksNotGreen) || merged(gh) {
		t.Fatalf("failing checks: %v, merged %v", err, merged(gh))
	}
	if err := host.Merge(ctx, id, "squash", true); err != nil || !merged(gh) {
		t.Fatalf("override: %v", err)
	}
	// No checks at all is not green either.
	host, gh = merge(prDetailWith(t, "OPEN", "", "MERGEABLE"), "")
	if err := host.Merge(ctx, id, "merge", false); !errors.Is(err, provider.ErrChecksNotGreen) || merged(gh) {
		t.Fatalf("no checks: %v", err)
	}
	// Unknown mergeability is refused; a conflict never merges.
	host, gh = merge(prDetailWith(t, "OPEN", "SUCCESS", "UNKNOWN"), "")
	if err := host.Merge(ctx, id, "merge", false); !errors.Is(err, provider.ErrNotMergeable) || merged(gh) {
		t.Fatalf("unknown: %v", err)
	}
	host, gh = merge(prDetailWith(t, "OPEN", "SUCCESS", "CONFLICTING"), "")
	if err := host.Merge(ctx, id, "merge", true); !errors.Is(err, provider.ErrNotMergeable) || merged(gh) {
		t.Fatalf("conflicting with an override: %v", err)
	}
	// Not open.
	host, gh = merge(prDetailWith(t, "MERGED", "SUCCESS", "UNKNOWN"), "")
	if err := host.Merge(ctx, id, "merge", true); !errors.Is(err, provider.ErrNotMergeable) || merged(gh) {
		t.Fatalf("merged already: %v", err)
	}
	// The head moved between the read and the merge.
	host, _ = merge(prDetailWith(t, "OPEN", "SUCCESS", "MERGEABLE"),
		`{"data":{"mergePullRequest":null},"errors":[{"type":"UNPROCESSABLE","message":"Head branch was modified. Review and try the merge again."}]}`)
	if err := host.Merge(ctx, id, "merge", false); !errors.Is(err, provider.ErrStale) {
		t.Fatalf("a moved head: %v", err)
	}
	// Anything else GitHub refuses is a failure with its message.
	host, _ = merge(prDetailWith(t, "OPEN", "SUCCESS", "MERGEABLE"),
		`{"data":{"mergePullRequest":null},"errors":[{"type":"FORBIDDEN","message":"Required status check is expected."}]}`)
	if err := host.Merge(ctx, id, "merge", false); !errors.Is(err, provider.ErrFailed) || !strings.Contains(err.Error(), "Required status check") {
		t.Fatalf("branch protection: %v", err)
	}
}

func TestOpenFromBranch(t *testing.T) {
	existing := true
	reg, gh := newRegistry(t, writes(t, func(doc githubcli.Doc, vars map[string]any) (string, bool) {
		switch doc {
		case githubcli.DocOpenPRForHead:
			if vars["head"] != "h3d/bramble-ca1d46" {
				t.Errorf("head = %v", vars["head"])
			}
			nodes := `[]`
			if existing {
				nodes = `[{"id":"PR_2","number":2,"url":"https://github.com/JeffreyVdb/h3d-lab/pull/2","headRefName":"h3d/bramble-ca1d46","baseRefName":"main"}]`
			}
			return `{"data":{"repository":{"id":"R_toy","pullRequests":{"nodes":` + nodes + `}}}}`, true
		case githubcli.DocCreatePR:
			return `{"data":{"createPullRequest":{"pullRequest":{"id":"PR_7","number":7,"url":"https://github.com/JeffreyVdb/h3d-lab/pull/7","state":"OPEN"}}}}`, true
		}
		return "", false
	}))
	_, host := reg.For(Config{Repo: "JeffreyVdb/h3d-lab"})
	b := codehost.Branch{Name: "h3d/bramble-ca1d46", Base: "main", Title: "feat: x", Body: "- x"}
	ctx := context.Background()
	got, err := host.OpenFromBranch(ctx, b)
	if err != nil || !got.Existed || got.ID != "JeffreyVdb/h3d-lab#2" || got.Key != "#2" || got.URL != "https://github.com/JeffreyVdb/h3d-lab/pull/2" {
		t.Fatalf("existing = %+v %v", got, err)
	}
	if slices.Contains(gh.docs(), githubcli.DocCreatePR) {
		t.Fatal("opened a second pull request for the same head")
	}
	existing = false
	got, err = host.OpenFromBranch(ctx, b)
	if err != nil || got.Existed || got.ID != "JeffreyVdb/h3d-lab#7" || got.Key != "#7" {
		t.Fatalf("created = %+v %v", got, err)
	}
	v := gh.last(githubcli.DocCreatePR)
	if v["repositoryId"] != "R_toy" || v["baseRefName"] != "main" || v["headRefName"] != "h3d/bramble-ca1d46" || v["title"] != "feat: x" ||
		v["body"] != "- x" || v["draft"] != false {
		t.Fatalf("vars = %v", v)
	}
}

// An issue is on the board when it is open or was closed within the window; the
// provider answers not_found for one that is not, even before any board read.
func TestIssueDetailOffBoard(t *testing.T) {
	detail := func(closedAt string) string {
		return edit(t, "issue-detail.json", func(m map[string]any) {
			is := dig(m, "data", "repository", "issue")
			is["state"], is["closedAt"] = "CLOSED", closedAt
		})
	}
	for _, tc := range []struct {
		name, closedAt string
		found          bool
	}{
		{"closed long ago", "2026-09-10T08:00:00Z", false},
		{"closed just outside the window", "2026-09-22T11:59:00Z", false},
		{"closed within the window", "2026-09-27T08:00:00Z", true},
	} {
		reg, _ := newRegistry(t, func(doc githubcli.Doc, _ map[string]any) (string, error) {
			if doc != githubcli.DocIssueDetail {
				t.Errorf("unexpected %s", doc)
			}
			return detail(tc.closedAt), nil
		})
		tr, _ := reg.For(projectCfg)
		_, err := tr.Get(context.Background(), "JeffreyVdb/herdr-3d#9")
		if tc.found && err != nil || !tc.found && !errors.Is(err, provider.ErrNotFound) {
			t.Errorf("%s: err = %v", tc.name, err)
		}
	}
}
