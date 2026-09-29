package server

import (
	"fmt"
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
