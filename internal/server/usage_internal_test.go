package server

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// worker.usage goes out at most once per 5 s per worker, and only when the
// usage changed (fake clock).
func TestUsageThrottle(t *testing.T) {
	t.Parallel()
	const sess = "0a0b0c0d-2222-4222-8222-222222222222"
	dir := t.TempDir()
	path := filepath.Join(dir, "p", sess+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	n := 0
	add := func() {
		n++
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Fprintf(f, `{"type":"assistant","message":{"id":"m%d","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":1}}}`+"\n", n)
		f.Close()
	}
	add()
	tr := newUsageTracker(UsageConfig{Roots: usage.Roots{ClaudeProjects: dir}})
	if tr.cfg.Throttle != 5*time.Second || tr.cfg.Interval != 2*time.Second {
		t.Fatalf("defaults: %+v", tr.cfg)
	}
	ws := []usageWorker{{id: "w", harness: "claude", session: sess}}
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) []usageUpdate { return tr.poll(ws, t0.Add(d)) }

	ups := at(0)
	if len(ups) != 1 || ups[0].usage.Input != 100 || ups[0].usage.UpdatedAt != t0.UnixMilli() {
		t.Fatalf("first = %+v", ups)
	}
	if ups = at(1 * time.Second); len(ups) != 0 {
		t.Fatalf("unchanged: %+v", ups)
	}
	add()
	if ups = at(2 * time.Second); len(ups) != 0 {
		t.Fatalf("changed 2 s after the last: %+v", ups)
	}
	add()
	if ups = at(4900 * time.Millisecond); len(ups) != 0 {
		t.Fatalf("changed 4.9 s after the last: %+v", ups)
	}
	ups = at(5 * time.Second)
	if len(ups) != 1 || ups[0].usage.Input != 300 || ups[0].usage.UpdatedAt != t0.Add(5*time.Second).UnixMilli() {
		t.Fatalf("at 5 s = %+v", ups)
	}
	if ups = at(11 * time.Second); len(ups) != 0 {
		t.Fatalf("nothing changed: %+v", ups)
	}
	add()
	if ups = at(12 * time.Second); len(ups) != 1 || ups[0].usage.Input != 400 {
		t.Fatalf("a change after a quiet time goes at once: %+v", ups)
	}

	// Another agent session: read afresh. None: the usage goes.
	ws[0].shown = true
	ws[0].session = ""
	if ups = at(20 * time.Second); len(ups) != 1 || ups[0].usage != nil {
		t.Fatalf("session gone = %+v", ups)
	}
	// The worker gone: forgotten.
	tr.poll(nil, t0.Add(21*time.Second))
	if len(tr.keys) != 0 || len(tr.sessions) != 0 || len(tr.throttle.at) != 0 {
		t.Fatalf("kept %v %v", tr.keys, tr.throttle.at)
	}
}

// codexRollout writes a Codex rollout started at stamp in cwd whose last
// token count has input tokens in.
func codexRollout(t *testing.T, root, stamp, id, cwd string, in int) {
	t.Helper()
	dir := filepath.Join(root, stamp[0:4], stamp[5:7], stamp[8:10])
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"cwd":%q}}`+"\n"+
		`{"type":"turn_context","payload":{"model":"gpt-6-luna","cwd":%q}}`+"\n"+
		`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":0,`+
		`"output_tokens":1,"total_tokens":%d},"last_token_usage":{"total_tokens":%d},"model_context_window":258400}}}`+"\n",
		id, cwd, cwd, in, in+1, in+1)
	if err := os.WriteFile(filepath.Join(dir, "rollout-"+stamp+"-"+id+".jsonl"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// #192: no transcript-derived state until the worker's session is identified.
func TestUsageCodexWithoutSession(t *testing.T) {
	t.Parallel()
	const session = "0c0d0e0f-0000-4000-8000-000000000001"
	root := t.TempDir()
	codexRollout(t, root, "2026-09-28T09-00-00", session, "/repo", 100)
	tr := newUsageTracker(UsageConfig{Roots: usage.Roots{CodexSessions: root}})
	defer tr.closeLogs()
	ws := []usageWorker{{id: "new", harness: "codex", cwd: "/repo", watched: true}}
	now := time.Now()
	for _, at := range []time.Time{now, now.Add(usage.MissRescan)} {
		if got := tr.poll(ws, at); len(got) != 0 || tr.sessions["new"] != nil || tr.logs["new"] != nil || tr.lines["new"] != nil {
			t.Fatalf("unidentified worker read a rollout: %+v", got)
		}
	}
	ws[0].session = session
	if got := tr.poll(ws, now.Add(2*usage.MissRescan)); len(got) != 1 || got[0].usage.Input != 100 {
		t.Fatalf("identified resume: %+v", got)
	}
	ws[0].session, ws[0].shown = "", true
	if got := tr.poll(ws, now.Add(3*usage.MissRescan)); len(got) != 1 || got[0].usage != nil || tr.sessions["new"] != nil {
		t.Fatalf("replacement kept previous usage: %+v", got)
	}
}

// #139: a Codex worker on another profile reads its rollouts in that
// profile's own sessions folder, by its identified session: never in
// --codex-sessions (the default home's), also not when its profile is gone.
// A worker whose folder changes (a wake on the default) reads afresh.
func TestUsageCodexProfileRoot(t *testing.T) {
	t.Parallel()
	const (
		defID  = "0c0d0e0f-1390-4000-8000-000000000001"
		workID = "0c0d0e0f-1390-4000-8000-000000000002"
		bothID = "0c0d0e0f-1390-4000-8000-000000000003"
	)
	def, work := filepath.Join(t.TempDir(), "sessions"), t.TempDir()
	codexRollout(t, def, "2026-09-29T11-00-00", defID, "/repo", 900) // newer, same folder: never another profile's
	codexRollout(t, filepath.Join(work, "sessions"), "2026-09-29T10-00-00", workID, "/repo", 300)
	codexRollout(t, def, "2026-09-29T09-00-00", bothID, "/elsewhere", 70)
	codexRollout(t, filepath.Join(work, "sessions"), "2026-09-29T09-00-00", bothID, "/elsewhere", 7)
	tr := newUsageTracker(UsageConfig{Roots: usage.Roots{CodexSessions: def}})
	inputs := func(ups []usageUpdate) map[string]int64 {
		out := map[string]int64{}
		for _, u := range ups {
			if u.usage == nil {
				out[u.id] = -1
			} else {
				out[u.id] = u.usage.Input
			}
		}
		return out
	}
	ws := []usageWorker{
		{id: "found", harness: "codex", session: workID, codexOther: true, codexHome: work, watched: true},
		{id: "known", harness: "codex", session: bothID, codexOther: true, codexHome: work},
		{id: "gone", harness: "codex", session: defID, codexOther: true},
		{id: "own", harness: "codex", session: defID},
	}
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	got := inputs(tr.poll(ws, t0))
	if want := map[string]int64{"found": 300, "known": 7, "own": 900}; !maps.Equal(got, want) {
		t.Fatalf("first = %v, want %v", got, want)
	}
	// Its transcript lines come from the same file (M16: a watched worker's log).
	if path, _, _ := tr.sessions["found"].Main(); !strings.HasPrefix(path, filepath.Join(work, "sessions")+string(filepath.Separator)) {
		t.Fatalf("read %s", path)
	}
	if l := tr.logs["found"]; l == nil {
		t.Fatal("no transcript log for the worker on a profile")
	}
	// Woken on the default (its profile gone): the same session is looked
	// for afresh, in the default's folder.
	ws[1].codexOther, ws[1].codexHome, ws[1].shown = false, "", true
	if got = inputs(tr.poll(ws, t0.Add(10*time.Second))); !maps.Equal(got, map[string]int64{"known": 70}) {
		t.Fatalf("on the default = %v", got)
	}
}

// S1c: a Codex worker on another profile resolves its transcripts' path
// images under its own home's generated_images, never the bridge's own
// home's (a gone profile: under none); the bridge's other roots and its
// cache stay. Every other worker keeps the bridge's images as they are.
func TestUsageCodexProfileImages(t *testing.T) {
	t.Parallel()
	base := &transcript.Images{Roots: []string{"/home/u/drops", "/home/u/.codex/generated_images"}}
	tr := newUsageTracker(UsageConfig{Images: base})
	if im := tr.images(usageWorker{harness: "codex"}); im != base {
		t.Fatalf("the bridge's own: %+v", im)
	}
	im := tr.images(usageWorker{harness: "codex", codexOther: true, codexHome: "/home/u/.codex-work"})
	if !slices.Equal(im.Roots, []string{"/home/u/drops", "/home/u/.codex-work/generated_images"}) || im.Cache != base.Cache {
		t.Fatalf("on work: %+v", im)
	}
	if im := tr.images(usageWorker{harness: "codex", codexOther: true}); !slices.Equal(im.Roots, []string{"/home/u/drops"}) {
		t.Fatalf("gone: %+v", im)
	}
	if !slices.Equal(base.Roots, []string{"/home/u/drops", "/home/u/.codex/generated_images"}) {
		t.Fatalf("the bridge's images changed: %+v", base.Roots)
	}
}

// A worker that switches to another agent session (or rollout) loses the
// old one's usage at once, whether or not the new transcript is there yet;
// the new one's usage comes as the throttle lets it.
func TestUsageGoesWithItsSession(t *testing.T) {
	t.Parallel()
	const (
		oldID = "0a0b0c0d-3333-4333-8333-333333333331"
		newID = "0a0b0c0d-3333-4333-8333-333333333332"
	)
	dir := t.TempDir()
	write := func(id string, in int) {
		t.Helper()
		path := filepath.Join(dir, "p", id+".jsonl")
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		line := fmt.Sprintf(`{"type":"assistant","message":{"id":"m-%s","model":"claude-opus-5-5","usage":{"input_tokens":%d,"output_tokens":1}}}`+"\n", id, in)
		if err := os.WriteFile(path, []byte(line), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(oldID, 1_000_000)
	tr := newUsageTracker(UsageConfig{Roots: usage.Roots{ClaudeProjects: dir}})
	ws := []usageWorker{{id: "w", harness: "claude", session: oldID}}
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	if ups := tr.poll(ws, t0); len(ups) != 1 || ups[0].usage == nil || ups[0].usage.Input != 1_000_000 {
		t.Fatalf("first = %+v", ups)
	}
	ws[0].shown = true

	// No transcript for the new session yet: the old usage goes, once.
	ws[0].session = newID
	if ups := tr.poll(ws, t0.Add(time.Second)); len(ups) != 1 || ups[0].usage != nil {
		t.Fatalf("switched = %+v, want the usage gone", ups)
	}
	ws[0].shown = false
	if ups := tr.poll(ws, t0.Add(time.Hour)); len(ups) != 0 {
		t.Fatalf("later = %+v", ups)
	}
	// Its transcript appears: its usage, counted from its own lines.
	write(newID, 7)
	ups := tr.poll(ws, t0.Add(time.Hour+usage.MissRescan))
	if len(ups) != 1 || ups[0].usage == nil || ups[0].usage.Input != 7 {
		t.Fatalf("new session = %+v", ups)
	}
	ws[0].shown = true

	// Back to the old one within the throttle: the new one's usage goes at
	// once, the old one's comes when the throttle lets it.
	at := t0.Add(time.Hour + usage.MissRescan)
	ws[0].session = oldID
	if ups := tr.poll(ws, at.Add(time.Second)); len(ups) != 1 || ups[0].usage != nil {
		t.Fatalf("switched within the throttle = %+v, want the usage gone", ups)
	}
	ws[0].shown = false
	if ups := tr.poll(ws, at.Add(5*time.Second)); len(ups) != 1 || ups[0].usage == nil || ups[0].usage.Input != 1_000_000 {
		t.Fatalf("after the throttle = %+v", ups)
	}
	ws[0].shown = true
	// Past the throttle, a switch to a readable session replaces the usage
	// in one update.
	ws[0].session = newID
	if ups := tr.poll(ws, at.Add(time.Minute)); len(ups) != 1 || ups[0].usage == nil || ups[0].usage.Input != 7 {
		t.Fatalf("switched past the throttle = %+v", ups)
	}
}

// #101: a change of the context count or of the window's estimated flag goes
// out even when everything else, the rounded percentage included, is the
// same: the meter shows both.
func TestUsageThrottleContextOnlyChange(t *testing.T) {
	t.Parallel()
	pct := func(v float64) *float64 { return &v }
	base := proto.Usage{Tokens: 100, Priced: proto.PricedKnown, ContextPct: pct(4.2), ContextWindow: 1_000_000, ContextTokens: 42_000}
	th := &usageThrottle{every: 5 * time.Second, shown: map[string]proto.Usage{}, at: map[string]time.Time{}}
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
	if _, ok := th.offer("w", base, t0); !ok {
		t.Fatal("first not offered")
	}
	same := base
	same.ContextPct = pct(4.2) // another pointer, the same value
	if _, ok := th.offer("w", same, t0.Add(time.Minute)); ok {
		t.Fatal("an unchanged usage offered")
	}
	count := base
	count.ContextTokens = 42_400 // 4.24 %: still 4.2
	if u, ok := th.offer("w", count, t0.Add(2*time.Minute)); !ok || u.ContextTokens != 42_400 {
		t.Fatalf("count-only change: %+v %v", u, ok)
	}
	est := count
	est.ContextWindowEstimated = true
	if u, ok := th.offer("w", est, t0.Add(3*time.Minute)); !ok || !u.ContextWindowEstimated {
		t.Fatalf("flag-only change: %+v %v", u, ok)
	}
	// Still throttled: a change within 5 s of the last goes later.
	next := est
	next.ContextTokens = 42_500
	if _, ok := th.offer("w", next, t0.Add(3*time.Minute+time.Second)); ok {
		t.Fatal("offered within the throttle")
	}
	// A compact drops the count and the percentage: that is a change too.
	cleared := est
	cleared.ContextTokens, cleared.ContextPct = 0, nil
	if u, ok := th.offer("w", cleared, t0.Add(4*time.Minute)); !ok || u.ContextPct != nil || u.ContextTokens != 0 {
		t.Fatalf("cleared: %+v %v", u, ok)
	}
}

// #139 S1a: a watched Codex child of a worker on another profile gets its
// transcript from that profile's sessions folder, as one on the default
// does from --codex-sessions: the child is the reader's session's, though
// the reader is kept under its home too.
func TestUsageCodexProfileChildTranscript(t *testing.T) {
	t.Parallel()
	const (
		parent = "0c0d0e0f-1390-4000-8000-000000000011"
		child  = "0c0d0e0f-1390-4000-8000-000000000012"
	)
	for _, other := range []bool{false, true} {
		t.Run(fmt.Sprintf("profile=%v", other), func(t *testing.T) {
			t.Parallel()
			home := t.TempDir()
			sessions := filepath.Join(home, "sessions")
			codexRollout(t, sessions, "2026-09-29T09-00-00", parent, "/repo", 100)
			body := fmt.Sprintf(`{"type":"session_meta","payload":{"id":%q,"session_id":%q,"cwd":"/repo","thread_source":"subagent",`+
				`"source":{"subagent":{"thread_spawn":{"parent_thread_id":%q,"depth":1}}}}}`+"\n"+
				`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"child task"}]}}`+"\n",
				child, parent, parent)
			if err := os.WriteFile(filepath.Join(sessions, "2026", "09", "29", "rollout-2026-09-29T09-01-00-"+child+".jsonl"), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			roots := usage.Roots{CodexSessions: sessions}
			if other {
				roots.CodexSessions = t.TempDir() // the default's: never read for it
			}
			tr := newUsageTracker(UsageConfig{Roots: roots})
			defer tr.closeLogs()
			kid := txKid{key: "child-watch", native: child, session: parent, harness: "codex", avail: proto.TranscriptAvailable}
			w := usageWorker{id: "w", harness: "codex", session: parent, codexOther: other, kids: []txKid{kid}}
			if other {
				w.codexHome = home
			}
			now := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
			for i := range 3 {
				tr.poll([]usageWorker{w}, now.Add(time.Duration(i)*time.Second))
			}
			if tr.kidLogs["w"]["child-watch"] == nil {
				t.Fatalf("the child's transcript never opens: reader %q", tr.keys["w"])
			}
			// A child of another session of the worker never reaches its log
			// (#149: the first one's is kept for a return visit).
			w.kids[0].session, w.kids[0].key = "0c0d0e0f-1390-4000-8000-000000000013", "other-watch"
			tr.poll([]usageWorker{w}, now.Add(3*time.Second))
			if tr.kidLogs["w"]["other-watch"] != nil {
				t.Fatalf("another session's child: %v", tr.kidLogs["w"])
			}
		})
	}
}
