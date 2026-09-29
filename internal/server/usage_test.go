package server_test

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// A Claude worker's usage: in worker.usage events (at most one per
// throttle, only on change), in snapshots and upserts; gone with its agent
// session.
func TestWorkerUsage(t *testing.T) {
	const sess = "0a0b0c0d-1111-4111-8111-111111111111"
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", sess+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	line := func(id string, in int) string {
		return fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"model":"claude-opus-5-5","usage":{"input_tokens":%d,`+
			`"output_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}`+"\n", id, in)
	}
	if err := os.WriteFile(path, []byte(line("m1", 1000)), 0o644); err != nil {
		t.Fatal(err)
	}
	throttle := 300 * time.Millisecond
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir}, Interval: 20 * time.Millisecond,
		Throttle: throttle}})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w1 := worker("w1", "a", sess, "working")
	w1.Harness = world.HarnessClaude
	b.floor("s1", true, w1, worker("w2", "shell", "", "idle"))
	ev := c.until(proto.EvWorkerUsage)
	if ev.Usage == nil || ev.Usage.Input != 1000 || ev.Usage.Tokens != 1010 || ev.Usage.Priced != proto.PricedKnown ||
		ev.Usage.UpdatedAt == 0 || ev.Session != "s1" {
		t.Fatalf("first usage = %+v", ev)
	}
	id := ev.ID
	first := time.Now()

	// Two lines in quick succession: one event, after the throttle, with both.
	appendLine(t, path, line("m2", 2000))
	time.Sleep(50 * time.Millisecond)
	appendLine(t, path, line("m3", 4000))
	ev = c.until(proto.EvWorkerUsage)
	if since := time.Since(first); since < throttle/2 { // exactly: TestUsageThrottle
		t.Errorf("second event %s after the first, throttle %s", since, throttle)
	}
	if ev.Usage.Input != 7000 {
		t.Fatalf("throttled usage = %+v", ev.Usage)
	}

	// A new client's snapshot has it; so does an upsert for another reason.
	c2 := b.connect(proto.Hello{})
	var snapUsage *proto.Usage
	for _, w := range c2.snapshot().World.Workers {
		if w.ID == id {
			snapUsage = w.Usage
		}
	}
	if snapUsage == nil || snapUsage.Input != 7000 {
		t.Fatalf("snapshot usage = %+v", snapUsage)
	}
	w1.Label = "renamed"
	b.floor("s1", true, w1, worker("w2", "shell", "", "idle"))
	if ev = c.until(proto.EvWorkerUpsert); ev.Worker.ID != id || ev.Worker.Usage == nil || ev.Worker.Usage.Input != 7000 {
		t.Fatalf("upsert = %+v", ev.Worker)
	}
	// No agent session: no usage.
	w1.AgentSession = ""
	b.floor("s1", true, w1, worker("w2", "shell", "", "idle"))
	for {
		ev = c.until(proto.EvWorkerUpsert)
		if ev.Worker.ID == id && ev.Worker.Usage == nil && ev.Worker.AgentSession == "" {
			break
		}
	}
}

func appendLine(t *testing.T, path, s string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
}
