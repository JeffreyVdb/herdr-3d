package server_test

import (
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

func gets(tr *fakeTracker, id string) int {
	n := 0
	for _, c := range tr.Calls() {
		if c == "get "+id {
			n++
		}
	}
	return n
}

// #118: a run's ticket carries its title and URL from the floor's board, and
// a poll that renames the card renames it on the workers.
func TestTicketTitleFromTheBoard(t *testing.T) {
	t.Parallel()
	bb := startBoardBridge(t, nil,
		runWorker("o", "ORCH|demo", runTokens("orch", "run-1")),
		runWorker("c", "CODE|demo|7|r1", runTokens("code", "run-1")))
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	c7 := card("JeffreyVdb/lab#7", "#7", "Fix the lift", "todo")
	c7.URL = "https://example.test/cards/7"
	tr.set(func(f *fakeTracker) { f.board.Cards = []tracker.Card{c7} })
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	titled := func(title string) func(proto.World) bool {
		return func(w proto.World) bool {
			ws := workersOf(w, "s")
			return ws["o"].Issue != nil && ws["o"].Issue.Title == title && ws["c"].Issue != nil && ws["c"].Issue.Title == title
		}
	}
	ws := workersOf(bb.world(titled("Fix the lift")), "s")
	for _, id := range []string{"o", "c"} {
		w := ws[id]
		if w.Issue.URL != c7.URL || w.WorkItem == nil || w.WorkItem.Title != "Fix the lift" || w.WorkItem.URL != c7.URL {
			t.Errorf("%s: issue %+v, work_item %+v", id, w.Issue, w.WorkItem)
		}
	}
	// (Read once at most: the board may not have been polled when the link came.)
	if n := gets(tr, "JeffreyVdb/lab#7"); n > 1 {
		t.Fatalf("%d reads of the item", n)
	}
	c7.Title = "Fix the lift doors"
	tr.set(func(f *fakeTracker) { f.board.Cards = []tracker.Card{c7} })
	bb.clk.Advance(11 * time.Minute) // the next idle poll
	bb.world(titled("Fix the lift doors"))
}

// #118: an item no board has (closed long ago) is read once with issue.get's
// provider call, and the answer kept: never asked again, for any worker.
func TestTicketTitleReadOnce(t *testing.T) {
	t.Parallel()
	bb := startBoardBridge(t, nil,
		runWorker("o", "ORCH|demo", runTokens("orch", "run-1")),
		runWorker("c", "CODE|demo|7|r1", runTokens("code", "run-1")))
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	old := card("JeffreyVdb/lab#7", "#7", "An old closed ticket", "done")
	old.URL = "https://example.test/cards/7"
	tr.set(func(f *fakeTracker) { f.detail = tracker.Detail{Card: old} })
	bb.link("JeffreyVdb/lab")
	ws := workersOf(bb.world(func(w proto.World) bool {
		ws := workersOf(w, "s")
		return ws["c"].Issue != nil && ws["c"].Issue.Title != "" && ws["o"].Issue != nil && ws["o"].Issue.Title != ""
	}), "s")
	if w := ws["c"]; w.Issue.Title != "An old closed ticket" || w.Issue.URL != old.URL || w.WorkItem.Title != old.Title {
		t.Fatalf("c: issue %+v, work_item %+v", w.Issue, w.WorkItem)
	}
	bb.polled("s")
	for range 3 { // polls and relinks: the card is still not on the board
		bb.clk.Advance(11 * time.Minute)
		time.Sleep(20 * time.Millisecond)
	}
	if n := gets(tr, "JeffreyVdb/lab#7"); n != 1 {
		t.Fatalf("%d reads of the item, want 1: %q", n, tr.Calls())
	}
	ws = workersOf(bb.connect(proto.Hello{}).snapshot().World, "s")
	if !strings.HasPrefix(ws["o"].Issue.Title, "An old") {
		t.Fatalf("o after the polls: %+v", ws["o"].Issue)
	}
}

// #118: a read that fails is not retried (no loop against a provider): the
// ticket keeps the provider's link and no title.
func TestTicketTitleReadFails(t *testing.T) {
	t.Parallel()
	bb := startBoardBridge(t, nil, runWorker("o", "ORCH|demo|7", runTokens("orch", "run-1", "h3d_ticket", "7")))
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	tr.set(func(f *fakeTracker) { f.missing = map[string]bool{"JeffreyVdb/lab#7": true} })
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	eventually(t, "the read", func() bool { return gets(tr, "JeffreyVdb/lab#7") == 1 })
	for range 3 {
		bb.clk.Advance(11 * time.Minute)
		time.Sleep(20 * time.Millisecond)
	}
	if n := gets(tr, "JeffreyVdb/lab#7"); n != 1 {
		t.Fatalf("%d reads", n)
	}
	w := workersOf(bb.connect(proto.Hello{}).snapshot().World, "s")["o"]
	if w.Issue == nil || w.Issue.Title != "" || w.Issue.URL != "https://example.test/JeffreyVdb/lab/issues/7" {
		t.Fatalf("issue = %+v", w.Issue)
	}
}
