package runs_test

import (
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/runs"
)

func noLaunch(string) (proto.IssueRef, bool) { return proto.IssueRef{}, false }

func repos(m map[string]string) func(string) string { return func(f string) string { return m[f] } }

func issue(repo string, n int) *proto.IssueRef { return &proto.IssueRef{Repo: repo, Number: n} }

func TestLinksByRunToken(t *testing.T) {
	ms := []runs.Member{
		{ID: "o1", Floor: "a", Role: "orch", Run: "run-1", RunToken: true},
		{ID: "o2", Floor: "a", Role: "orch", Run: "run-2", RunToken: true},
		{ID: "c1", Floor: "a", Role: "code", Run: "run-1", RunToken: true, Ticket: "7"},
		{ID: "r1", Floor: "a", Role: "review", Run: "run-1", RunToken: true, Ticket: "7"},
		{ID: "g2", Floor: "a", Role: "ground", Run: "run-2", RunToken: true},
		{ID: "x", Floor: "a", Role: "code", Run: "run-3", RunToken: true, Ticket: "#9"}, // no orchestrator
		{ID: "e", Floor: "a"}, // not in a run
	}
	got := runs.Links(ms, repos(map[string]string{"a": "o/r"}), noLaunch)
	want := map[string]runs.Link{
		"o1": {Issue: issue("o/r", 7)},
		"c1": {OrchID: "o1", Issue: issue("o/r", 7)},
		"r1": {OrchID: "o1", Issue: issue("o/r", 7)},
		"g2": {OrchID: "o2"},
		"x":  {Issue: issue("o/r", 9)},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("links = %v, want %v", got, want)
	}
}

func TestLinksPreferTheSameFloorThenAnyFloor(t *testing.T) {
	ms := []runs.Member{
		{ID: "oa", Floor: "a", Role: "orch", Run: "run-1", RunToken: true},
		{ID: "ob", Floor: "b", Role: "orch", Run: "run-1", RunToken: true},
		{ID: "cb", Floor: "b", Role: "code", Run: "run-1", RunToken: true},
		{ID: "cc", Floor: "c", Role: "code", Run: "run-1", RunToken: true},
	}
	got := runs.Links(ms, repos(nil), noLaunch)
	if got["cb"].OrchID != "ob" || got["cc"].OrchID != "oa" {
		t.Fatalf("links = %v", got)
	}
}

func TestLinksLabelFallback(t *testing.T) {
	// Runs started without tokens: the run is the label's descr, which
	// rarely matches the orchestrator's. The only ORCH of the floor wins.
	ms := []runs.Member{
		{ID: "o", Floor: "a", Role: "orch", Run: "herdr-3d"},
		{ID: "c", Floor: "a", Role: "code", Run: "bridge-ro", Ticket: "7"},
		{ID: "u", Floor: "a", Role: "ux", Run: "bridge-ro", Ticket: "m6"},
		{ID: "t", Floor: "a", Role: "code", Run: "other", RunToken: true}, // a token run never falls back
		{ID: "d", Floor: "b", Role: "code", Run: "bridge-ro"},             // no ORCH on its floor
	}
	got := runs.Links(ms, repos(map[string]string{"a": "o/r"}), noLaunch)
	want := map[string]runs.Link{
		"o": {Issue: issue("o/r", 7)},
		"c": {OrchID: "o", Issue: issue("o/r", 7)},
		"u": {OrchID: "o", Issue: issue("o/r", 7)}, // non-numeric ticket: its ORCH's issue
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("links = %v, want %v", got, want)
	}
	// Two ORCHs on the floor: no guess.
	ms = append(ms, runs.Member{ID: "o2", Floor: "a", Role: "orch", Run: "x"})
	if got := runs.Links(ms, repos(nil), noLaunch); got["c"].OrchID != "" {
		t.Fatalf("guessed among two: %v", got)
	}
}

func TestLinksIssue(t *testing.T) {
	ms := []runs.Member{
		{ID: "o", Floor: "a", Role: "orch", Run: "r", RunToken: true},
		{ID: "c1", Floor: "a", Role: "code", Run: "r", RunToken: true, Ticket: "#8"},
		{ID: "c2", Floor: "a", Role: "code", Run: "r", RunToken: true, Ticket: "7"},
		{ID: "c3", Floor: "a", Role: "review", Run: "r", RunToken: true, Ticket: "7"},
		{ID: "g", Floor: "b", Role: "ground", Run: "r", RunToken: true},
	}
	// No repo: no issue anywhere.
	if got := runs.Links(ms, repos(nil), noLaunch); got["o"].Issue != nil || got["c1"].Issue != nil {
		t.Fatalf("issue without a repo: %v", got)
	}
	// The most common ticket is the ORCH's; each freelancer keeps its own;
	// one on a floor without a repo gets the ORCH's.
	got := runs.Links(ms, repos(map[string]string{"a": "o/r"}), noLaunch)
	if *got["o"].Issue != *issue("o/r", 7) || *got["c1"].Issue != *issue("o/r", 8) || *got["g"].Issue != *issue("o/r", 7) {
		t.Fatalf("issues = %v", got)
	}
	// The launch record wins.
	launched := func(id string) (proto.IssueRef, bool) { return proto.IssueRef{Repo: "x/y", Number: 3}, id == "o" }
	got = runs.Links(ms, repos(map[string]string{"a": "o/r"}), launched)
	if *got["o"].Issue != *issue("x/y", 3) || *got["g"].Issue != *issue("x/y", 3) || *got["c2"].Issue != *issue("o/r", 7) {
		t.Fatalf("launched issues = %v", got)
	}
	// Ties: the lowest number.
	ms[3].Ticket = "8"
	ms[1].Ticket = "7"
	if got := runs.Links(ms, repos(map[string]string{"a": "o/r"}), noLaunch); got["o"].Issue.Number != 7 {
		t.Fatalf("tie = %v", got["o"])
	}
}

func TestNearestDesk(t *testing.T) {
	used := func(ds ...int) func(int) bool {
		m := map[int]bool{}
		for _, d := range ds {
			m[d] = true
		}
		return func(d int) bool { return m[d] }
	}
	for _, tc := range []struct {
		orch int
		used []int
		want int
	}{
		{5, []int{0, 1, 5}, 4},                   // same pod, lower index first
		{5, []int{4, 5, 6, 7}, 0},                // pod full: pods 0 and 2 are both 1 away, the lower wins
		{9, []int{8, 9, 10, 11, 4, 5, 6, 7}, 12}, // pods 2 and 1 full: pod 3
		{1, []int{0, 1, 2, 3}, 4},                // pod 0 full: the next pod, beyond the floor if need be
		{0, []int{0, 1, 2, 3, 4, 5, 6, 7}, 8},
		{13, []int{12, 13, 14, 15, 8, 9, 10, 11}, 16}, // pod 3 full, pod 2 full: pod 4
	} {
		if got := runs.NearestDesk(tc.orch, used(tc.used...)); got != tc.want {
			t.Errorf("NearestDesk(%d, %v) = %d, want %d", tc.orch, tc.used, got, tc.want)
		}
	}
	if !runs.Nearer(4, 0, 5) || runs.Nearer(8, 4, 5) || !runs.Nearer(0, 8, 5) {
		t.Fatal("Nearer: same pod, then pod distance, then index")
	}
}
