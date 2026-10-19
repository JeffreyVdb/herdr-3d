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
	t.Parallel()
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
	ev := c.untilFirstUsage()
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

// A worker whose agent session changes to one whose transcript is not
// there yet loses the old session's usage: in an upsert, and in the next
// snapshot.
func TestUsageGoesWithItsAgentSession(t *testing.T) {
	t.Parallel()
	const (
		oldID = "0a0b0c0d-4444-4444-8444-444444444441"
		newID = "0a0b0c0d-4444-4444-8444-444444444442"
	)
	dir := t.TempDir()
	path := filepath.Join(dir, "-home-u-w1", oldID+".jsonl")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"type":"assistant","message":{"id":"m1","model":"claude-opus-5-5","usage":`+
		`{"input_tokens":1000000,"output_tokens":100000}}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir},
		Interval: 10 * time.Millisecond, Throttle: time.Hour}})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w := worker("w1", "a", oldID, "working")
	w.Harness = world.HarnessClaude
	b.floor("s1", true, w)
	id := c.untilFirstUsage().ID

	w.AgentSession = newID
	b.floor("s1", true, w)
	for {
		ev := c.until(proto.EvWorkerUpsert)
		if ev.Worker.ID == id && ev.Worker.AgentSession == newID && ev.Worker.Usage == nil {
			break
		}
	}
	for _, sw := range b.connect(proto.Hello{}).snapshot().World.Workers {
		if sw.ID == id && sw.Usage != nil {
			t.Fatalf("session %s shows the old session's usage %+v", sw.AgentSession, sw.Usage)
		}
	}
}

// untilFirstUsage reads until a worker's first usage arrives: a worker.usage,
// or (H3D-2: its transcript's model is what the worker shows now, which only
// an upsert carries) a worker.upsert with the usage, returned as the former.
func (c *client) untilFirstUsage() proto.Event {
	c.t.Helper()
	for {
		ev := c.event()
		switch {
		case ev.T == proto.EvWorkerUsage:
			return ev
		case ev.T == proto.EvWorkerUpsert && ev.Worker.Usage != nil:
			return proto.Event{T: proto.EvWorkerUsage, ID: ev.Worker.ID, Session: ev.Worker.Session, Usage: ev.Worker.Usage}
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
