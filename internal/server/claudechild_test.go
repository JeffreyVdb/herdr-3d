package server_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/claudechild"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #23: a Claude worker's subagent, end to end: the usage tracker reads its
// session's files, the Claude source turns them into evidence, the hub
// publishes the child. The fixture is a real background child
// (internal/claudechild/testdata/b): running from its launch, completed by
// its task notification, one row throughout.
func TestClaudeSubagentEndToEnd(t *testing.T) {
	t.Parallel()
	const session, agent = "bc8c5901-8ee0-4a6d-b05d-834ae9dfc88f", "a4a204a6a6e12e123"
	fx := filepath.Join("..", "claudechild", "testdata", "b")
	read := func(name string) []string {
		b, err := os.ReadFile(filepath.Join(fx, name))
		if err != nil {
			t.Fatal(err)
		}
		return strings.SplitAfter(strings.TrimSuffix(string(b), "\n"), "\n")
	}
	parent, child := read("parent-b.jsonl"), read("agent-"+agent+".jsonl")
	meta, _ := os.ReadFile(filepath.Join(fx, "agent-"+agent+".meta.json"))
	dir := t.TempDir()
	main := filepath.Join(dir, "-home-u-w1", session+".jsonl")
	sub := filepath.Join(dir, "-home-u-w1", session, "subagents")
	writeTranscript(t, main, strings.Join(parent[:2], "")+"\n") // the call and its launch
	writeTranscript(t, filepath.Join(sub, "agent-"+agent+".jsonl"), strings.Join(child, "")+"\n")
	writeTranscript(t, filepath.Join(sub, "agent-"+agent+".meta.json"), strings.Replace(string(meta), `,"finished":true`, "", 1))

	src := claudechild.New(claudechild.Options{})
	w1 := agentW("w1", "claude", "working")
	w1.AgentSession, w1.Harness = session, world.HarnessClaude
	tb := startTermBridge(t, func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{ClaudeProjects: dir}, Interval: 20 * time.Millisecond,
			ClaudeChildren: func(s string) server.ChildReader { return src.Listener(s) }}
		o.ChildSources = []childagents.Source{src}
	}, w1)
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := idOf(t, snap, "w1")
	var first *proto.Child
	if len(snap.World.Children) == 1 {
		first = &snap.World.Children[0]
	} else {
		first = c.until(proto.EvChildUpsert).Child
	}
	if first.WorkerID != id || first.NativeID != agent || first.State != proto.ChildRunning || first.Parent != proto.ParentRoot ||
		first.Description != "bg-sleeper" || first.Transcript != proto.TranscriptAvailable {
		t.Fatalf("child = %+v", first)
	}
	f, err := os.OpenFile(main, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.WriteString(strings.Join(parent[2:], "") + "\n") // the notification
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	for {
		ev := c.until(proto.EvChildUpsert)
		if ev.Child.ID != first.ID {
			t.Fatalf("a second row: %+v", ev.Child)
		}
		if ev.Child.State == proto.ChildCompleted {
			break
		}
	}
}
