package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/codehost"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/provider"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/tracker"
)

// A floor with no repo has no board; one with a repo answers from the cache
// at once, then from its first poll: the issues first, then the pull
// requests, both without a seq, and never in the snapshot.
func TestBoardWatch(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, host := bb.fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#9", "#9", "Boards", "todo")}
	tr.board.Rate = &provider.Rate{Remaining: 4870, ResetAt: 1790673600000}
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#31", "#31", "M6", "feat/7-m6", "success")}
	tr.gate = make(chan struct{}) // the first poll waits: the cache is still empty when the watch comes

	w := bb.watcher()
	if res := w.watch("s"); res.Enabled || res.Reason != "no repo linked" {
		t.Fatalf("no repo: %+v", res)
	}
	w.mustErrorFor(proto.CmdBoardWatch, proto.BoardArgs{Session: "nope"}, proto.ErrUnknownSession)
	bb.link("JeffreyVdb/lab")
	if res := w.watch("s"); !res.Enabled || res.Reason != "" {
		t.Fatalf("with a repo: %+v", res)
	}

	// Nothing cached yet: an empty replay, then the poll.
	first := w.issues()
	if !first.Initial || first.FetchedAt != 0 || first.Cards == nil || len(first.Cards) != 0 || first.Columns == nil || len(first.Columns) != 0 ||
		first.Provider != "fake" || first.ProviderName != "Fake" || first.Session != "s" {
		t.Fatalf("empty replay = %+v", first)
	}
	if p := w.prs(); !p.Initial || p.FetchedAt != 0 || p.PRs == nil || p.Merged == nil {
		t.Fatalf("empty prs replay = %+v", p)
	}
	tr.set(func(f *fakeTracker) { close(f.gate); f.gate = nil })
	is, ps := w.pair()
	if is.Initial || is.Stale || is.Truncated || is.FetchedAt != bb.clk.Now().UnixMilli() || len(is.Cards) != 1 || is.Cards[0].ID != "JeffreyVdb/lab#9" ||
		len(is.Columns) != 2 || is.Rate == nil || is.Rate.Remaining != 4870 || is.Rate.ResetAt != 1790673600000 ||
		!is.Capabilities.SetStatus || is.Session != "s" {
		t.Fatalf("poll issues = %+v", is)
	}
	if ps.Initial || ps.Stale || len(ps.PRs) != 1 || ps.PRs[0].Checks != "success" || ps.Merged == nil || len(ps.Merged) != 0 ||
		!ps.Capabilities.Merge || ps.Provider != "fake" {
		t.Fatalf("poll prs = %+v", ps)
	}
	raw, _ := json.Marshal(is)
	for _, want := range []string{`"t":"board.issues"`, `"provider_name":"Fake"`, `"fetched_at":`, `"cards":[{"id":"JeffreyVdb/lab#9"`, `"labels":[]`,
		`"rate":{"remaining":4870,"reset_at":1790673600000}`} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("board.issues lacks %s: %s", want, raw)
		}
	}

	// Not in the snapshot, not in the replay ring.
	other := bb.connect(proto.Hello{})
	snap := other.snapshot()
	rawSnap, _ := json.Marshal(snap)
	if strings.Contains(string(rawSnap), "board") || strings.Contains(string(rawSnap), "JeffreyVdb/lab#9") {
		t.Fatalf("the snapshot holds a board: %s", rawSnap)
	}
	replay := bb.connect(proto.Hello{SinceSeq: ptr(uint64(0)), Epoch: bb.hub.Epoch()})
	replay.seq = 0
	if replay.welcome.Resume != proto.ResumeReplay {
		t.Fatalf("resume = %s", replay.welcome.Resume)
	}
	for replay.seq < replay.welcome.ServerSeq {
		if m := replay.next(); m.env.T == proto.TBoardIssues || m.env.T == proto.TBoardPRs {
			t.Fatalf("a board message in the replay ring: %s", m.raw)
		}
	}

	// A second connection: its replay is the cache, initial, no new poll.
	polls := tr.Polls()
	w2 := bb.watcher()
	w2.watch("s")
	is2 := w2.issues()
	if !is2.Initial || len(is2.Cards) != 1 || is2.FetchedAt != is.FetchedAt || is2.Stale {
		t.Fatalf("cache replay = %+v", is2)
	}
	if p := w2.prs(); !p.Initial || len(p.PRs) != 1 || len(p.Merged) != 0 {
		t.Fatalf("prs replay = %+v", p)
	}
	if tr.Polls() != polls {
		t.Fatalf("a watch with a fresh cache polled: %d → %d", polls, tr.Polls())
	}

	// Unwatching ends the messages (the poll of a watched floor is due in a minute).
	w.command(proto.CmdBoardUnwatch, "u", proto.BoardArgs{Session: "s"})
	w2.command(proto.CmdBoardUnwatch, "u", proto.BoardArgs{Session: "s"})
	bb.clk.Advance(2 * time.Minute)
	w.quiet(100 * time.Millisecond)
	if tr.Polls() != polls {
		t.Fatalf("an unwatched floor is polled every 10 minutes, not every minute: %d polls", tr.Polls())
	}
	bb.clk.Advance(9 * time.Minute)
	eventually(t, "the idle poll", func() bool { return tr.Polls() > polls })
	if row := auditRow(t, bb.bridge, proto.CmdBoardWatch); !row.Done {
		t.Fatalf("board.watch audit = %+v", row)
	}
}

func (w *watcher) mustErrorFor(typ string, args any, code string) {
	w.client.mustError(typ, args, code)
}

// A watched floor is polled every minute, one nobody watches every ten,
// asleep floors included.
func TestBoardPollPeriods(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	w.issues()
	w.prs()
	// Fresh: the next one is due a minute after the last.
	bb.clk.Advance(59 * time.Second)
	w.quiet(60 * time.Millisecond)
	if tr.Polls() != 1 {
		t.Fatalf("%d polls before the minute", tr.Polls())
	}
	bb.clk.Advance(2 * time.Second)
	is, _ := w.pair()
	if is.Initial || tr.Polls() != 2 {
		t.Fatalf("after a minute: %d polls, %+v", tr.Polls(), is)
	}
	// The floor goes to sleep, nobody watches: ten minutes.
	bb.floorAt("s", false, nil)
	w.command(proto.CmdBoardUnwatch, "u", proto.BoardArgs{Session: "s"})
	bb.clk.Advance(9 * time.Minute)
	w.quiet(60 * time.Millisecond)
	if tr.Polls() != 2 {
		t.Fatalf("%d polls before ten minutes", tr.Polls())
	}
	bb.clk.Advance(2 * time.Minute)
	eventually(t, "the poll of an asleep floor", func() bool { return tr.Polls() == 3 })
}

// board.refresh polls now, coalesces with a poll in flight, and at most one
// poll per ten seconds per floor comes of it.
func TestBoardRefresh(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	w.pair() // the replay
	polls := tr.Polls()

	refresh := func() proto.BoardRefreshResult {
		_, m := w.command(proto.CmdBoardRefresh, "r", proto.BoardArgs{Session: "s"})
		return ackData[proto.BoardRefreshResult](t, m)
	}
	// Too soon after the poll of the watch: it returns the last one.
	if r := refresh(); r.Queued {
		t.Fatalf("refresh right after a poll: %+v", r)
	}
	if is := w.issues(); !is.Initial || is.FetchedAt == 0 {
		t.Fatalf("the reply of a refused refresh is the cache: %+v", is)
	}
	w.prs()
	bb.clk.Advance(11 * time.Second)
	tr.set(func(f *fakeTracker) { f.gate = make(chan struct{}) })
	if r := refresh(); !r.Queued {
		t.Fatalf("refresh: %+v", r)
	}
	eventually(t, "the poll in flight", func() bool { return tr.Polls() == polls+1 })
	// Joins the poll in flight: no second one.
	bb.clk.Advance(20 * time.Second)
	if r := refresh(); !r.Queued {
		t.Fatalf("a refresh during a poll: %+v", r)
	}
	tr.set(func(f *fakeTracker) { close(f.gate); f.gate = nil })
	is, _ := w.pair()
	if is.Initial {
		t.Fatalf("poll = %+v", is)
	}
	time.Sleep(50 * time.Millisecond)
	if tr.Polls() != polls+1 {
		t.Fatalf("%d polls for the joined refresh", tr.Polls()-polls)
	}
	w.mustErrorFor(proto.CmdBoardRefresh, proto.BoardArgs{Session: "nope"}, proto.ErrUnknownSession)
	bb.floorAt("t", true, nil)
	bb.world(func(w proto.World) bool {
		return slices.ContainsFunc(w.Floors, func(f proto.Floor) bool { return f.Session == "t" })
	})
	w.mustErrorFor(proto.CmdBoardRefresh, proto.BoardArgs{Session: "t"}, proto.ErrUnsupported)
}

// A failed poll keeps the last good data and sends it again, stale, with the error;
// the next good one clears it.
func TestBoardStale(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, host := bb.fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#1", "#1", "One", "todo")}
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#2", "#2", "Two", "feat/two", "pending")}
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	good, _ := w.pair()
	if good.Stale {
		t.Fatal("stale at first")
	}
	tr.set(func(f *fakeTracker) { f.err = provider.Failed("GitHub auth") })
	bb.clk.Advance(61 * time.Second)
	is, ps := w.pair()
	if !is.Stale || is.Error != "GitHub auth" || len(is.Cards) != 1 || is.FetchedAt != good.FetchedAt || is.Initial ||
		!ps.Stale || ps.Error != "GitHub auth" || len(ps.PRs) != 1 || len(ps.Merged) != 0 {
		t.Fatalf("stale poll: %+v / %+v", is, ps)
	}
	// A watch during the failure replays the same data, stale, and tries again.
	w2 := bb.watcher()
	w2.watch("s")
	if r := w2.issues(); !r.Stale || r.Error == "" || len(r.Cards) != 1 || !r.Initial {
		t.Fatalf("replay while failing: %+v", r)
	}
	if again, _ := w.pair(); !again.Stale || len(again.Cards) != 1 {
		t.Fatalf("the retry after the watch: %+v", again)
	}
	tr.set(func(f *fakeTracker) { f.err = nil; f.board.Cards = nil })
	bb.clk.Advance(61 * time.Second)
	is, _ = w.pair()
	if is.Stale || is.Error != "" || len(is.Cards) != 0 {
		t.Fatalf("recovered: %+v", is)
	}
}

// A request open at one poll and merged at the next rings once: never on
// the replay of the cache, and not again, also across a restart.
func TestBoardMergeOnce(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	fb := newFakeBoards()
	clk := newBoardClock()
	start := func() *boardBridge {
		bb := &boardBridge{fb: fb, clk: clk}
		bb.hireBridge = startHireBridgeAt(t, db, func(o *server.Options) {
			o.Boards = fb.factory
			o.Now = clk.Now
			o.BoardTick = 3 * time.Millisecond
		})
		return bb
	}
	tr, host := fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#1", "#1", "One", "todo")}
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#12", "#12", "Twelve", "feat/12", "success"),
		request("JeffreyVdb/lab#13", "#13", "Thirteen", "feat/13", "success")}
	bb := start()
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	_, first := w.pair()
	if len(first.PRs) != 2 || len(first.Merged) != 0 {
		t.Fatalf("first poll: %+v", first)
	}
	// Both are open: the store has them for a restart.
	if c, _ := bb.st.BoardCaches(context.Background()); len(c["s"].OpenPRs) != 2 {
		t.Fatalf("stored open set = %+v", c["s"])
	}

	// #12 is merged (and gone from the open list) by the next poll.
	merged := codehost.Merged{ID: "JeffreyVdb/lab#12", Key: "#12", Title: "Twelve", MergedAt: 1790669990000, Closes: []string{"JeffreyVdb/lab#1"}}
	host.set(func(f *fakeHost) {
		f.board.Requests = f.board.Requests[1:]
		f.mergedNow = []codehost.Merged{merged}
	})
	bb.clk.Advance(61 * time.Second)
	_, second := w.pair()
	if len(second.PRs) != 1 || len(second.Merged) != 1 || second.Merged[0].ID != merged.ID || second.Merged[0].MergedAt != 1790669990000 ||
		second.Merged[0].Closes[0] != "JeffreyVdb/lab#1" || second.Initial {
		t.Fatalf("second poll: %+v", second)
	}
	if prevs := host.Prevs(); !slices.Equal(prevs[len(prevs)-1].OpenIDs, []string{"JeffreyVdb/lab#12", "JeffreyVdb/lab#13"}) {
		t.Fatalf("the poll was given the open set %+v", prevs)
	}
	// The replay of the cache never carries it.
	w2 := bb.watcher()
	w2.watch("s")
	w2.issues()
	if r := w2.prs(); !r.Initial || len(r.Merged) != 0 || len(r.PRs) != 1 {
		t.Fatalf("replay = %+v", r)
	}
	// A provider that keeps showing the merge does not ring it twice.
	host.set(func(f *fakeHost) { f.always = true })
	bb.clk.Advance(61 * time.Second)
	if _, third := w.pair(); len(third.Merged) != 0 {
		t.Fatalf("announced again: %+v", third)
	}

	// After a restart the announced merges are still known.
	bb.stop()
	bb = start()
	w = bb.watcher()
	w.watch("s")
	if r := w.prs(); r.Initial != true || len(r.Merged) != 0 { // the issues come first
		if len(r.PRs) == 0 {
			w.prs()
		}
	}
	bb.clk.Advance(2 * time.Hour) // the poll of the restarted floor is due
	_, after := w.pair()
	if len(after.Merged) != 0 {
		t.Fatalf("announced again after a restart: %+v", after)
	}
	if prevs := host.Prevs(); !slices.Equal(prevs[len(prevs)-1].OpenIDs, []string{"JeffreyVdb/lab#13"}) {
		t.Fatalf("after the restart the poll was given %+v", prevs[len(prevs)-1])
	}
}

// A merge that happened while the bridge was down is found by the first poll
// after the restart, from the open set of the store, and announced once.
func TestBoardMergeAcrossRestart(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	fb := newFakeBoards()
	clk := newBoardClock()
	start := func() *boardBridge {
		bb := &boardBridge{fb: fb, clk: clk}
		bb.hireBridge = startHireBridgeAt(t, db, func(o *server.Options) {
			o.Boards = fb.factory
			o.Now = clk.Now
			o.BoardTick = 3 * time.Millisecond
		})
		return bb
	}
	tr, host := fb.repo("JeffreyVdb/lab")
	host.board.Requests = []codehost.Request{request("JeffreyVdb/lab#12", "#12", "Twelve", "feat/12", "success")}
	bb := start()
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	bb.stop()

	host.set(func(f *fakeHost) {
		f.board.Requests = nil
		f.mergedNow = []codehost.Merged{{ID: "JeffreyVdb/lab#12", Key: "#12", Title: "Twelve", MergedAt: 1790669990000, Closes: []string{}}}
	})
	clk.Advance(3 * time.Hour)
	tr.set(func(f *fakeTracker) { f.gate = make(chan struct{}) }) // the poll waits for the watch
	bb = start()
	w := bb.watcher()
	w.watch("s")
	// Its replay is the cache: initial, no merge.
	is := w.issues()
	if p := w.prs(); !p.Initial || len(p.Merged) != 0 || len(p.PRs) != 1 || !is.Initial {
		t.Fatalf("replay after the restart = %+v", p)
	}
	tr.set(func(f *fakeTracker) { close(f.gate); f.gate = nil })
	_, next := w.pair()
	if next.Initial || len(next.Merged) != 1 || next.Merged[0].ID != "JeffreyVdb/lab#12" || len(next.PRs) != 0 {
		t.Fatalf("first poll after the restart: %+v", next)
	}
	clk.Advance(61 * time.Second)
	host.set(func(f *fakeHost) { f.always = true })
	if _, again := w.pair(); len(again.Merged) != 0 {
		t.Fatalf("rang twice: %+v", again)
	}
}

// The rate policy: below what one more cycle of every board plus the reserve
// needs, only watched floors are polled; below 50 or after a rate limit
// nothing is until the reset, then it resumes.
func TestBoardRateLimit(t *testing.T) {
	bb := startBoardBridge(t, nil)
	a, _ := bb.fb.repo("JeffreyVdb/a")
	b, _ := bb.fb.repo("JeffreyVdb/b")
	reset := bb.clk.Now().Add(time.Hour)
	rate := func(n int) *provider.Rate { return &provider.Rate{Remaining: n, Cost: 12, ResetAt: reset.UnixMilli()} }
	a.board.Rate, b.board.Rate = rate(4000), rate(4000)
	bb.link("JeffreyVdb/a")
	bb.floorAt("t", true, nil)
	bb.world(func(w proto.World) bool {
		return slices.ContainsFunc(w.Floors, func(f proto.Floor) bool { return f.Session == "t" })
	})
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "t", Repo: proto.Some("JeffreyVdb/b")})
	eventually(t, "both floors polled once", func() bool { return a.Polls() == 1 && b.Polls() == 1 })
	bb.polled("s")
	bb.polled("t")

	// Their next polls (allowed: the last reading is 4000) read 110 left.
	a.set(func(f *fakeTracker) { f.board.Rate = rate(110) })
	b.set(func(f *fakeTracker) { f.board.Rate = rate(110) })
	bb.clk.Advance(11 * time.Minute)
	eventually(t, "both floors polled again", func() bool { return a.Polls() == 2 && b.Polls() == 2 })
	time.Sleep(50 * time.Millisecond) // and applied

	// 110 left; one more cycle of two boards is 24, plus the reserve of 100:
	// nothing unwatched is polled.
	bb.clk.Advance(11 * time.Minute)
	time.Sleep(80 * time.Millisecond)
	if a.Polls() != 2 || b.Polls() != 2 {
		t.Fatalf("background polls with a low rate: a %d, b %d", a.Polls(), b.Polls())
	}
	// A watched floor still is.
	w := bb.watcher()
	w.watch("s")
	w.pair() // the replay
	is, _ := w.pair()
	if a.Polls() != 3 || b.Polls() != 2 || is.Rate == nil || is.Rate.Remaining != 110 {
		t.Fatalf("watched: a %d, b %d, %+v", a.Polls(), b.Polls(), is.Rate)
	}
	// Under 50 nothing is, watched or not.
	a.set(func(f *fakeTracker) { f.board.Rate = rate(40) })
	bb.clk.Advance(61 * time.Second)
	is, _ = w.pair()
	if is.Rate == nil || is.Rate.Remaining != 40 || a.Polls() != 4 {
		t.Fatalf("rate = %+v, polls %d", is.Rate, a.Polls())
	}
	bb.clk.Advance(5 * time.Minute)
	w.quiet(80 * time.Millisecond)
	if a.Polls() != 4 || b.Polls() != 2 {
		t.Fatalf("polls while out of budget: a %d, b %d", a.Polls(), b.Polls())
	}
	// The reset: everything resumes.
	a.set(func(f *fakeTracker) {
		f.board.Rate = &provider.Rate{Remaining: 4990, Cost: 12, ResetAt: reset.Add(time.Hour).UnixMilli()}
	})
	b.set(func(f *fakeTracker) {
		f.board.Rate = &provider.Rate{Remaining: 4990, Cost: 12, ResetAt: reset.Add(time.Hour).UnixMilli()}
	})
	bb.clk.Advance(56 * time.Minute)
	is, _ = w.pair()
	if a.Polls() != 5 || is.Rate.Remaining != 4990 {
		t.Fatalf("after the reset: a %d, %+v", a.Polls(), is.Rate)
	}
	eventually(t, "the other floor's poll", func() bool { return b.Polls() == 3 })
}

// A rate limit error stops the polls until its reset, also for watched floors,
// and says so in the stale message; a secondary limit waits a minute, then more.
func TestBoardRateLimitError(t *testing.T) {
	bb := startBoardBridge(t, nil)
	tr, _ := bb.fb.repo("JeffreyVdb/lab")
	tr.board.Cards = []tracker.Card{card("JeffreyVdb/lab#1", "#1", "One", "todo")}
	bb.link("JeffreyVdb/lab")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	w.pair()
	reset := bb.clk.Now().Add(20 * time.Minute)
	tr.set(func(f *fakeTracker) { f.err = &provider.RateLimitError{ResetAt: reset, Msg: "GitHub rate limit"} })
	bb.clk.Advance(61 * time.Second)
	is, _ := w.pair()
	if !is.Stale || is.Error != "GitHub rate limit" || is.Rate == nil || is.Rate.Remaining != 0 || is.Rate.ResetAt != reset.UnixMilli() ||
		len(is.Cards) != 1 {
		t.Fatalf("rate limited poll: %+v", is)
	}
	polls := tr.Polls()
	bb.clk.Advance(10 * time.Minute)
	w.quiet(80 * time.Millisecond)
	if tr.Polls() != polls {
		t.Fatal("polled before the reset")
	}
	tr.set(func(f *fakeTracker) { f.err = nil })
	bb.clk.Advance(11 * time.Minute)
	if is, _ = w.pair(); is.Stale || tr.Polls() != polls+1 {
		t.Fatalf("after the reset: %+v", is)
	}

	// A secondary limit names no reset: a minute, then two.
	tr.set(func(f *fakeTracker) { f.err = &provider.RateLimitError{} })
	bb.clk.Advance(61 * time.Second)
	w.pair() // fails
	n := tr.Polls()
	bb.clk.Advance(59 * time.Second)
	w.quiet(60 * time.Millisecond)
	if tr.Polls() != n {
		t.Fatal("polled inside the first minute")
	}
	bb.clk.Advance(2 * time.Second)
	w.pair() // the second failure: two minutes now
	n = tr.Polls()
	bb.clk.Advance(119 * time.Second)
	w.quiet(60 * time.Millisecond)
	if tr.Polls() != n {
		t.Fatal("polled inside the second wait")
	}
	tr.set(func(f *fakeTracker) { f.err = nil })
	bb.clk.Advance(2 * time.Second)
	if is, _ = w.pair(); is.Stale {
		t.Fatalf("after the back-off: %+v", is)
	}
}

// Changing a floor's link drops what was cached of the old one.
func TestBoardLinkChange(t *testing.T) {
	bb := startBoardBridge(t, nil)
	a, _ := bb.fb.repo("JeffreyVdb/a")
	b, _ := bb.fb.repo("JeffreyVdb/b")
	a.board.Cards = []tracker.Card{card("JeffreyVdb/a#1", "#1", "In a", "todo")}
	b.board.Cards = []tracker.Card{card("JeffreyVdb/b#1", "#1", "In b", "todo")}
	bb.link("JeffreyVdb/a")
	bb.polled("s")
	w := bb.watcher()
	w.watch("s")
	if is, _ := w.pair(); len(is.Cards) != 1 || is.Cards[0].ID != "JeffreyVdb/a#1" {
		t.Fatalf("board of a = %+v", is)
	}
	bb.link("JeffreyVdb/b")
	// The watcher gets the empty board of the new link, then its poll.
	sawEmpty := false
	for {
		is, _ := w.pair()
		if len(is.Cards) == 0 && is.Initial {
			sawEmpty = true
			continue
		}
		if len(is.Cards) == 1 && is.Cards[0].ID == "JeffreyVdb/b#1" {
			break
		}
		t.Fatalf("board = %+v", is)
	}
	if !sawEmpty {
		t.Fatal("no empty board after the link changed")
	}
	// Unlinking: no board any more.
	bb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Null[string]()})
	w2 := bb.watcher()
	if res := w2.watch("s"); res.Enabled {
		t.Fatalf("watch without a repo: %+v", res)
	}
	c, _ := bb.st.BoardCaches(context.Background())
	if _, ok := c["s"]; ok {
		t.Fatalf("stored cache of an unlinked floor: %+v", c["s"])
	}
}

// Without a provider factory the boards are off.
func TestBoardsNotConfigured(t *testing.T) {
	hb := startHireBridge(t, nil)
	hb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab")})
	_, m := hb.c.command(proto.CmdBoardWatch, "w", proto.BoardArgs{Session: "s"})
	if res := ackData[proto.BoardWatchResult](t, m); res.Enabled || res.Reason != "boards are not configured" {
		t.Fatalf("watch = %+v", res)
	}
	for _, cmd := range []string{proto.CmdIssueComment, proto.CmdPRComment} {
		hb.c.mustError(cmd, proto.CommentArgs{Session: "s", ID: "x#1", Body: "hi"}, proto.ErrUnsupported)
	}
	hb.c.mustError(proto.CmdBoardRefresh, proto.BoardArgs{Session: "s"}, proto.ErrUnsupported)
}

var errBoom = errors.New("boom")
