package server

import (
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// worker.usage goes out at most once per 5 s per worker, and only when the
// usage changed (fake clock).
func TestUsageThrottle(t *testing.T) {
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

// A Codex agent herdr knows no session of gets the usage of the newest
// rollout of its cwd that no other worker of its floor has (the sleep
// backfill's rule), without an agent_session of its own; looked for again
// after usage.MissRescan.
func TestUsageCodexWithoutSession(t *testing.T) {
	const (
		oldID  = "0c0d0e0f-0000-4000-8000-000000000001"
		midID  = "0c0d0e0f-0000-4000-8000-000000000002"
		newID  = "0c0d0e0f-0000-4000-8000-000000000003"
		elseID = "0c0d0e0f-0000-4000-8000-000000000004"
		nextID = "0c0d0e0f-0000-4000-8000-000000000005"
	)
	root := t.TempDir()
	codexRollout(t, root, "2026-09-28T09-00-00", oldID, "/repo", 100)
	codexRollout(t, root, "2026-09-29T09-00-00", midID, "/repo", 200)
	codexRollout(t, root, "2026-09-29T10-00-00", newID, "/repo", 300)
	codexRollout(t, root, "2026-09-29T11-00-00", elseID, "/elsewhere", 400)
	lookups := 0
	tr := newUsageTracker(UsageConfig{Roots: usage.Roots{CodexSessions: root}})
	find := tr.cfg.FindCodex
	tr.cfg.FindCodex = func(cwd string, skip func(string) bool) (string, error) {
		lookups++
		return find(cwd, skip)
	}
	t0 := time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)
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

	// a has the newest rollout as its own session (herdr knows it); b and c,
	// Codex in the same folder without one, get the next newest in id order;
	// d on another floor may have the newest; e is not Codex.
	ws := []usageWorker{
		{id: "a", harness: "codex", session: newID, floor: "s1"},
		{id: "c", harness: "codex", floor: "s1", codexCwd: "/repo"},
		{id: "b", harness: "codex", floor: "s1", codexCwd: "/repo"},
		{id: "d", harness: "codex", floor: "s2", codexCwd: "/repo"},
		{id: "e", harness: "claude", floor: "s1"},
	}
	got := inputs(tr.poll(ws, t0))
	if want := map[string]int64{"a": 300, "b": 200, "c": 100, "d": 300}; !maps.Equal(got, want) {
		t.Fatalf("first = %v, want %v", got, want)
	}
	if lookups != 3 {
		t.Fatalf("%d lookups", lookups)
	}
	// Found once, then kept: no lookups until the rescan.
	codexRollout(t, root, "2026-09-29T12-00-00", nextID, "/repo", 500)
	tr.poll(ws, t0.Add(2*time.Second))
	if lookups != 3 {
		t.Fatalf("%d lookups within the rescan", lookups)
	}
	// After it: b now has the newest free one, c the one b had; d the newest.
	got = inputs(tr.poll(ws, t0.Add(usage.MissRescan)))
	if want := map[string]int64{"b": 500, "c": 200, "d": 500}; !maps.Equal(got, want) {
		t.Fatalf("after the rescan = %v, want %v", got, want)
	}
	// herdr learns b's session (the sleep backfill): it is b's own now, and
	// nothing changes for it.
	ws[2].session, ws[2].codexCwd = nextID, ""
	if got = inputs(tr.poll(ws, t0.Add(usage.MissRescan+time.Second))); len(got) != 0 {
		t.Fatalf("known now: %v", got)
	}
	// The agent gone (no agent kind): its found session and its usage go.
	ws[1].codexCwd, ws[1].shown = "", true
	if got = inputs(tr.poll(ws, t0.Add(usage.MissRescan+2*time.Second))); !maps.Equal(got, map[string]int64{"c": -1}) {
		t.Fatalf("gone = %v", got)
	}
	if _, ok := tr.found["c"]; ok {
		t.Fatal("c's found session kept")
	}
}

// A worker that switches to another agent session (or rollout) loses the
// old one's usage at once, whether or not the new transcript is there yet;
// the new one's usage comes as the throttle lets it.
func TestUsageGoesWithItsSession(t *testing.T) {
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
