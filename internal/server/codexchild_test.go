package server_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/codexchild"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #25: a Codex worker's subagents, end to end: the usage tracker reads its
// root rollout and finds and reads its child rollouts, the Codex source
// turns them into evidence, the hub publishes the children. The fixture is
// a real nested run (internal/codexchild/testdata/c2): the depth-2 child
// attaches to the depth-1 one, both completed.
func TestCodexSubagentsEndToEnd(t *testing.T) {
	t.Parallel()
	const session = "01a14e2b-d7d0-7c01-8a79-2cb6ba62938e"
	const outer, inner = "01a14e2b-e4bc-7472-8aac-009f651c0987", "01a14e2b-ef35-7e53-adfb-e8adb97f831f"
	dir := t.TempDir()
	files, _ := filepath.Glob(filepath.Join("..", "codexchild", "testdata", "c2", "rollout-*.jsonl"))
	for _, p := range files {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		writeTranscript(t, filepath.Join(dir, "2026", "10", "18", filepath.Base(p)), string(b))
	}
	src := codexchild.New(codexchild.Options{})
	w1 := agentW("w1", "codex", "working")
	w1.AgentSession, w1.Harness = session, world.HarnessCodex
	tb := startTermBridge(t, func(o *server.Options) {
		o.Usage = &server.UsageConfig{Roots: usage.Roots{CodexSessions: dir}, Interval: 20 * time.Millisecond,
			CodexChildren: func(s string) server.ChildReader { return src.Listener(s) }}
		o.ChildSources = []childagents.Source{src}
	}, w1)
	c := tb.connect(proto.Hello{})
	snap := c.snapshot()
	id := idOf(t, snap, "w1")
	rows := map[string]proto.Child{}
	for _, ch := range snap.World.Children {
		rows[ch.NativeID] = ch
	}
	for rows[outer].State != proto.ChildCompleted || rows[inner].State != proto.ChildCompleted {
		ev := c.until(proto.EvChildUpsert)
		rows[ev.Child.NativeID] = *ev.Child
	}
	o, i := rows[outer], rows[inner]
	if len(rows) != 2 || o.WorkerID != id || o.Parent != proto.ParentRoot || o.Name != "Volta" || o.Provider != proto.ChildCodex ||
		i.Parent != proto.ParentChild || i.ParentID != o.ID || i.Name != "Pasteur" || !strings.HasPrefix(i.ID, "ch_") ||
		i.Transcript != proto.TranscriptAvailable || i.Source != proto.ChildFromRollout {
		t.Fatalf("rows = %+v", rows)
	}
}
