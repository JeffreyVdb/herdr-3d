package server

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// #149: the transcript logs kept for return visits, driven through the
// tracker's rounds with a fake clock.

func keepLine(i int) string {
	return fmt.Sprintf(`{"type":"user","uuid":"u%d","timestamp":"2026-10-21T10:00:00.000Z","message":{"role":"user","content":"prompt %d"}}`+"\n", i, i)
}

func keepAppend(t *testing.T, path string, from, to int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for i := from; i < to; i++ {
		if _, err := f.WriteString(keepLine(i)); err != nil {
			t.Fatal(err)
		}
	}
}

// keepRig is a tracker over Claude transcripts in a temporary directory
// that counts the logs it builds, by path.
type keepRig struct {
	t       *testing.T
	dir     string
	tr      *usageTracker
	follows map[string]int
	t0      time.Time
}

func newKeepRig(t *testing.T, cfg UsageConfig) *keepRig {
	t.Helper()
	r := &keepRig{t: t, dir: t.TempDir(), follows: map[string]int{}, t0: time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)}
	cfg.Roots = usage.Roots{ClaudeProjects: r.dir}
	r.tr = newUsageTracker(cfg)
	r.tr.follow = func(harness, path string, fi fs.FileInfo, next int64, opts ...transcript.Option) (*transcript.Log, error) {
		r.follows[path]++
		return transcript.Follow(harness, path, fi, next, opts...)
	}
	t.Cleanup(r.tr.closeLogs)
	return r
}

func (r *keepRig) path(sess string) string { return filepath.Join(r.dir, "p", sess+".jsonl") }

func (r *keepRig) kidPath(sess, agent string) string {
	return filepath.Join(r.dir, "p", sess, "subagents", "agent-"+agent+".jsonl")
}

// at runs a round at t0+d.
func (r *keepRig) at(d time.Duration, ws ...usageWorker) {
	r.tr.poll(ws, r.t0.Add(d))
}

// log is worker id's log, built (nil: none).
func (r *keepRig) log(id string) *transcript.Log {
	r.t.Helper()
	l := r.tr.logs[id]
	if l == nil {
		return nil
	}
	ready(r.t, l.log)
	return l.log
}

func ready(t *testing.T, l *transcript.Log) {
	t.Helper()
	select {
	case <-l.Ready():
	case <-time.After(10 * time.Second):
		t.Fatal("not ready")
	}
}

// events are the round's log events, as "what worker reason".
func (r *keepRig) events() []string {
	var out []string
	for _, e := range r.tr.logEvents {
		out = append(out, strings.TrimSpace(e.what+" "+e.worker+" "+e.reason))
	}
	return out
}

func claudeWorker(id, sess string, watched bool) usageWorker {
	return usageWorker{id: id, harness: usage.Claude, session: sess, agent: sess, cwd: "/home/u/" + id, watched: watched}
}

// A worker watched again after its watch ended, within the TTL, gets the
// same log back, built already, with the lines appended meanwhile, read
// by the session's one tail: no second Follow of the file. While it is
// kept nothing is offered for it and it holds neither the watched interval
// nor WatchedRescan.
func TestKeptLogReused(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-1491-4491-8491-149149149101"
	r := newKeepRig(t, UsageConfig{})
	keepAppend(t, r.path(sess), 0, 3)
	w := claudeWorker("w", sess, true)
	r.at(0, w)
	first := r.log("w")
	if first == nil || first.Len() != 3 || len(r.tr.txOffers) != 1 || r.tr.txOffers["w"].log != first {
		t.Fatalf("watched: log %v, offers %v", first, r.tr.txOffers)
	}
	if got := r.events(); len(got) != 1 || got[0] != "built w" {
		t.Fatalf("events = %q", got)
	}

	// The watch ends: kept, still the session's tap, not offered.
	w.watched = false
	r.at(2*time.Second, w)
	s := r.tr.sessions["w"]
	if got := r.events(); len(got) != 1 || got[0] != "retained w" {
		t.Fatalf("events = %q", got)
	}
	keepAppend(t, r.path(sess), 3, 5) // while away
	for i := 2; i <= 5; i++ {
		r.at(time.Duration(i)*2*time.Second, w)
		if len(r.tr.txOffers) != 0 || s.Rescan() != 0 || s.Tap() != first {
			t.Fatalf("round %d kept: offers %v, rescan %v, tap %v", i, r.tr.txOffers, s.Rescan(), s.Tap())
		}
	}
	if r.tr.logs["w"].log != first || first.Err() != nil || first.Len() != 5 {
		t.Fatalf("kept log: %v %v, %d items", r.tr.logs["w"], first.Err(), first.Len())
	}

	// Watched again: the same log, its first page has what came meanwhile.
	w.watched = true
	r.at(time.Minute, w)
	if r.log("w") != first || r.tr.txOffers["w"].log != first || r.follows[r.path(sess)] != 1 {
		t.Fatalf("rewatch: %v (first %v), %d follows", r.tr.logs["w"].log, first, r.follows[r.path(sess)])
	}
	select {
	case <-first.Ready():
	default:
		t.Fatal("not ready when offered")
	}
	sub, page, err := first.Subscribe(200)
	if err != nil {
		t.Fatal(err)
	}
	sub.Close()
	if len(page.Items) != 5 || page.Items[4].Parts[0].Text != "prompt 4" {
		t.Fatalf("first page = %+v", page.Items)
	}
	if got := r.events(); len(got) != 1 || got[0] != "reused w" || r.tr.logEvents[0].idle != time.Minute-2*time.Second ||
		r.tr.reused != 1 || r.tr.built != 1 {
		t.Fatalf("events = %q %+v", got, r.tr.logEvents)
	}
	if s.Rescan() != WatchedRescan {
		t.Fatalf("watched rescan = %v", s.Rescan())
	}
}

// A kept log that no longer indexes the worker's transcript is closed and
// the next watch builds one: truncated, replaced by a new file, another
// agent session, another directory; the worker gone closes it.
func TestKeptLogInvalidated(t *testing.T) {
	t.Parallel()
	const (
		sess  = "0a0b0c0d-1491-4491-8491-149149149111"
		other = "0a0b0c0d-1491-4491-8491-149149149112"
	)
	for _, tc := range []struct {
		name   string
		change func(r *keepRig, w *usageWorker) // while it is kept
		items  int                              // the rebuilt log's
	}{
		{"truncate", func(r *keepRig, w *usageWorker) {
			if err := os.Truncate(r.path(sess), 0); err != nil {
				t.Fatal(err)
			}
			keepAppend(t, r.path(sess), 10, 12)
		}, 2},
		{"replace", func(r *keepRig, w *usageWorker) {
			next := r.path(sess) + ".new"
			keepAppend(t, next, 20, 26) // longer than the old one
			if err := os.Rename(next, r.path(sess)); err != nil {
				t.Fatal(err)
			}
		}, 6},
		{"session", func(r *keepRig, w *usageWorker) {
			keepAppend(t, r.path(other), 30, 34)
			w.session, w.agent = other, other
		}, 4},
		{"cwd", func(r *keepRig, w *usageWorker) {
			w.cwd = "/home/u/elsewhere"
		}, 3},
	} {
		for _, between := range []bool{false, true} {
			// The change is seen at the return visit, before its tail's
			// next read, or (between) by a round meanwhile.
			t.Run(fmt.Sprintf("%s/between=%v", tc.name, between), func(t *testing.T) {
				t.Parallel()
				r := newKeepRig(t, UsageConfig{})
				keepAppend(t, r.path(sess), 0, 3)
				w := claudeWorker("w", sess, true)
				r.at(0, w)
				first := r.log("w")
				w.watched = false
				r.at(2*time.Second, w)
				tc.change(r, &w)
				var ev []string
				if between {
					r.at(3*time.Second, w)
					ev = r.events()
				}
				w.watched = true
				r.at(4*time.Second, w)
				ev = append(ev, r.events()...)
				got := r.log("w")
				if got == nil || got == first || first.Err() == nil {
					t.Fatalf("rewatch: %v (first %v, %v)", got, first, first.Err())
				}
				if err := got.Err(); err != nil || got.Len() != tc.items {
					t.Fatalf("rebuilt: %v, %d items", err, got.Len())
				}
				if len(ev) < 2 || ev[0] != "evicted w invalidated" || ev[len(ev)-1] != "built w" || r.tr.reused != 0 {
					t.Fatalf("events = %q, %d reused", ev, r.tr.reused)
				}
			})
		}
	}

	// The worker gone: its kept log is closed.
	r := newKeepRig(t, UsageConfig{})
	keepAppend(t, r.path(sess), 0, 3)
	w := claudeWorker("w", sess, true)
	r.at(0, w)
	first := r.log("w")
	w.watched = false
	r.at(2*time.Second, w)
	r.at(4 * time.Second)
	if !errors.Is(first.Err(), transcript.ErrClosed) || len(r.tr.logs) != 0 {
		t.Fatalf("gone: %v, %d logs", first.Err(), len(r.tr.logs))
	}
	if ev := r.events(); len(ev) != 1 || ev[0] != "evicted w gone" {
		t.Fatalf("events = %q", ev)
	}
}

// The bounds evict kept logs, the least recently watched first: past the
// TTL, past the most kept, past the footprint budget. An evicted log is
// closed and its session's tail no longer feeds it. A watched log is
// neither counted nor evicted; the tracker's end closes them all.
func TestKeptLogBounds(t *testing.T) {
	t.Parallel()
	sess := func(i int) string { return fmt.Sprintf("0a0b0c0d-1491-4491-8491-1491491491%02d", 20+i) }
	setup := func(t *testing.T, cfg UsageConfig, n int) (*keepRig, []usageWorker, []*transcript.Log) {
		r := newKeepRig(t, cfg)
		ws := make([]usageWorker, n)
		logs := make([]*transcript.Log, n)
		for i := range n {
			keepAppend(t, r.path(sess(i)), 0, 3+i)
			ws[i] = claudeWorker(fmt.Sprintf("w%d", i), sess(i), true)
		}
		r.at(0, ws...)
		for i := range n {
			logs[i] = r.log(ws[i].id)
		}
		return r, ws, logs
	}
	evicted := func(t *testing.T, r *keepRig, l *transcript.Log, id string) {
		t.Helper()
		if !errors.Is(l.Err(), transcript.ErrClosed) || r.tr.logs[id] != nil || r.tr.sessions[id].Tap() != nil {
			t.Fatalf("%s not evicted: %v, %v", id, l.Err(), r.tr.logs[id])
		}
	}
	kept := func(t *testing.T, r *keepRig, l *transcript.Log, id string) {
		t.Helper()
		if l.Err() != nil || r.tr.logs[id] == nil || r.tr.logs[id].log != l || r.tr.sessions[id].Tap() != l {
			t.Fatalf("%s not kept: %v", id, l.Err())
		}
	}

	t.Run("ttl", func(t *testing.T) {
		t.Parallel()
		r, ws, logs := setup(t, UsageConfig{IdleLogTTL: time.Minute}, 2)
		ws[0].watched = false
		r.at(time.Second, ws...)
		r.at(time.Second+time.Minute-time.Millisecond, ws...)
		kept(t, r, logs[0], "w0")
		r.at(time.Second+time.Minute, ws...)
		evicted(t, r, logs[0], "w0")
		if ev := r.events(); len(ev) != 1 || ev[0] != "evicted w0 ttl" {
			t.Fatalf("events = %q", ev)
		}
		kept(t, r, logs[1], "w1") // watched all along
		r.at(time.Hour, ws...)
		if logs[1].Err() != nil {
			t.Fatal("a watched log expired")
		}
	})

	t.Run("count", func(t *testing.T) {
		t.Parallel()
		r, ws, logs := setup(t, UsageConfig{MaxIdleLogs: 2}, 4)
		for i := range 3 { // w0, w1, w2 unwatched in that order; w3 watched
			ws[i].watched = false
			r.at(time.Duration(i+1)*time.Second, ws...)
		}
		evicted(t, r, logs[0], "w0")
		if ev := r.events(); len(ev) != 2 || ev[0] != "retained w2" || ev[1] != "evicted w0 count" {
			t.Fatalf("events = %q", ev)
		}
		kept(t, r, logs[1], "w1")
		kept(t, r, logs[2], "w2")
		kept(t, r, logs[3], "w3")
		// One watched again leaves room.
		ws[1].watched = true
		ws[3].watched = false
		r.at(10*time.Second, ws...)
		kept(t, r, logs[2], "w2")
		kept(t, r, logs[3], "w3")
		if r.tr.logs["w1"].log != logs[1] || !r.tr.logs["w1"].idle.IsZero() {
			t.Fatal("w1 not reused")
		}
	})

	t.Run("footprint", func(t *testing.T) {
		t.Parallel()
		r0, _, l0 := setup(t, UsageConfig{}, 3)
		budget := l0[1].Footprint() + l0[2].Footprint() // w1 and w2 fit, not w0 beside them
		r, ws, logs := setup(t, UsageConfig{IdleLogBudget: budget}, 3)
		_ = r0
		for i := range 3 {
			ws[i].watched = false
			r.at(time.Duration(i+1)*time.Second, ws...)
		}
		evicted(t, r, logs[0], "w0")
		if ev := r.events(); len(ev) != 2 || ev[1] != "evicted w0 footprint" {
			t.Fatalf("events = %q", ev)
		}
		kept(t, r, logs[1], "w1")
		kept(t, r, logs[2], "w2")

		// A watched log over the budget is not evicted, nor counted.
		ws[0].watched = true
		keepAppend(t, r.path(sess(0)), 3, 400)
		r.at(5*time.Second, ws...)
		big := r.log("w0")
		if big.Len() != 400 || big.Footprint() <= budget {
			t.Fatalf("big: %d items, %d bytes", big.Len(), big.Footprint())
		}
		r.at(6*time.Second, ws...)
		kept(t, r, logs[1], "w1")
		kept(t, r, logs[2], "w2")
		if big.Err() != nil {
			t.Fatal("a watched log was evicted")
		}
		// Alone and over the budget when its watch ends: it goes.
		ws[0].watched = false
		r.at(7*time.Second, ws...)
		if !errors.Is(big.Err(), transcript.ErrClosed) {
			t.Fatal("kept over the budget")
		}

		// The tracker's end closes the kept and the watched.
		ws[1].watched = true
		r.at(8*time.Second, ws...)
		r.tr.closeLogs()
		for i, l := range logs[1:] {
			if !errors.Is(l.Err(), transcript.ErrClosed) {
				t.Fatalf("w%d open at the end", i+1)
			}
		}
	})
}

// A child's view closed and opened again, and a switch from child A to B
// and back, reuse A's log while it is its session's; a child of the
// worker's next agent session is not one of them.
func TestKeptChildLog(t *testing.T) {
	t.Parallel()
	const (
		sess  = "0a0b0c0d-1491-4491-8491-149149149131"
		next  = "0a0b0c0d-1491-4491-8491-149149149132"
		a, b  = "a1491000000000001", "a1491000000000002"
		keyA  = "w\x00c-a"
		keyB  = "w\x00c-b"
		keyA2 = "w\x00c-a2"
	)
	r := newKeepRig(t, UsageConfig{})
	keepAppend(t, r.path(sess), 0, 2)
	keepAppend(t, r.kidPath(sess, a), 0, 3)
	keepAppend(t, r.kidPath(sess, b), 0, 4)
	kid := func(key, native, s string) txKid {
		return txKid{key: key, native: native, session: s, harness: usage.Claude, avail: proto.TranscriptAvailable}
	}
	w := claudeWorker("w", sess, false)
	kidLog := func(key string) *transcript.Log {
		t.Helper()
		l := r.tr.kidLogs["w"][key]
		if l == nil {
			return nil
		}
		ready(t, l.log)
		return l.log
	}

	w.kids = []txKid{kid(keyA, a, sess)}
	r.at(0, w)
	la := kidLog(keyA)
	if la == nil || la.Len() != 3 || r.tr.txOffers[keyA].log != la {
		t.Fatalf("A watched: %v", la)
	}
	s := r.tr.sessions["w"]

	// A's view closed: kept, fed by its tail.
	w.kids = nil
	r.at(2*time.Second, w)
	keepAppend(t, r.kidPath(sess, a), 3, 5)
	r.at(4*time.Second, w)
	if kidLog(keyA) != la || la.Len() != 5 || s.ChildTap(a) != la || len(r.tr.txOffers) != 0 || s.Rescan() != 0 {
		t.Fatalf("A kept: %v, %d items, tap %v, offers %v", r.tr.kidLogs["w"], la.Len(), s.ChildTap(a), r.tr.txOffers)
	}
	// Opened again: the same log.
	w.kids = []txKid{kid(keyA, a, sess)}
	r.at(6*time.Second, w)
	if kidLog(keyA) != la || r.tr.txOffers[keyA].log != la {
		t.Fatal("A not reused")
	}

	// A → B → A.
	w.kids = []txKid{kid(keyB, b, sess)}
	r.at(8*time.Second, w)
	lb := kidLog(keyB)
	if lb == nil || lb.Len() != 4 || kidLog(keyA) != la || la.Err() != nil {
		t.Fatalf("B: %v, A kept %v", lb, r.tr.kidLogs["w"][keyA])
	}
	w.kids = []txKid{kid(keyA, a, sess)}
	r.at(10*time.Second, w)
	if kidLog(keyA) != la || kidLog(keyB) != lb || s.ChildTap(b) != lb {
		t.Fatal("A not reused, or B not kept")
	}
	if r.follows[r.kidPath(sess, a)] != 1 || r.follows[r.kidPath(sess, b)] != 1 || r.tr.reused != 2 || r.tr.built != 2 {
		t.Fatalf("follows %v, reused %d, built %d", r.follows, r.tr.reused, r.tr.built)
	}

	// The worker's next agent session: its children are other logs; the
	// old ones go.
	keepAppend(t, r.path(next), 0, 2)
	keepAppend(t, r.kidPath(next, a), 0, 1)
	w.session, w.agent = next, next
	w.kids = []txKid{kid(keyA2, a, next)}
	r.at(12*time.Second, w)
	la2 := kidLog(keyA2)
	if la2 == nil || la2 == la || la2.Len() != 1 || la.Err() == nil || lb.Err() == nil || len(r.tr.kidLogs["w"]) != 1 {
		t.Fatalf("next session: %v, old %v %v", la2, la.Err(), lb.Err())
	}

	// A kept child, then the worker gone: closed.
	w.kids = nil
	r.at(14*time.Second, w)
	r.at(16 * time.Second)
	if la2.Err() == nil || len(r.tr.kidLogs) != 0 {
		t.Fatalf("gone: %v", r.tr.kidLogs)
	}
}

// A kept child's file truncated: rebuilt at the next view.
func TestKeptChildLogTruncated(t *testing.T) {
	t.Parallel()
	const (
		sess = "0a0b0c0d-1491-4491-8491-149149149141"
		a    = "a1491000000000011"
		key  = "w\x00c-a"
	)
	r := newKeepRig(t, UsageConfig{})
	keepAppend(t, r.path(sess), 0, 2)
	keepAppend(t, r.kidPath(sess, a), 0, 3)
	w := claudeWorker("w", sess, false)
	w.kids = []txKid{{key: key, native: a, session: sess, harness: usage.Claude, avail: proto.TranscriptAvailable}}
	r.at(0, w)
	first := r.tr.kidLogs["w"][key].log
	ready(t, first)
	kids := w.kids
	w.kids = nil
	r.at(2*time.Second, w)
	if err := os.Truncate(r.kidPath(sess, a), 0); err != nil {
		t.Fatal(err)
	}
	keepAppend(t, r.kidPath(sess, a), 0, 1)
	w.kids = kids
	r.at(4*time.Second, w)
	got := r.tr.kidLogs["w"][key]
	if got == nil || got.log == first || first.Err() == nil {
		t.Fatalf("not rebuilt: %v", got)
	}
	ready(t, got.log)
	if got.log.Err() != nil || got.log.Len() != 1 {
		t.Fatalf("rebuilt: %v, %d items", got.log.Err(), got.log.Len())
	}
}
