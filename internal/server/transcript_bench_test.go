package server_test

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// TestBenchReturnVisit measures what a transcript watch waits for through
// the hub (#149), cold and on return visits: H3D_TXREUSE_BENCH is a list of
// real transcripts separated by ':' (Claude <session>.jsonl, Codex
// rollout-…-<id>.jsonl; skipped without it). Each is copied (never
// written in place: lines are appended to the copy) under TMPDIR, then
// watched cold, again after the usage rounds dropped the watch, again
// after a line was appended while away, and again after the file was
// replaced (rebuilt). It logs the hub's wait_ms and page_ms of each and the
// kept log's footprint; sizes and times only, never content.
//
//	H3D_TXREUSE_BENCH=/path/a.jsonl:/path/rollout-….jsonl go test -run TestBenchReturnVisit -v ./internal/server
func TestBenchReturnVisit(t *testing.T) {
	env := os.Getenv("H3D_TXREUSE_BENCH")
	if env == "" {
		t.Skip("H3D_TXREUSE_BENCH is not set")
	}
	for _, src := range filepath.SplitList(env) {
		benchReturnVisit(t, src)
	}
}

var benchAttr = regexp.MustCompile(`\b(wait_ms|page_ms|items|footprint|reason)=(\S+)`)

func benchReturnVisit(t *testing.T, src string) {
	dir := t.TempDir()
	name := filepath.Base(src)
	sess := strings.TrimSuffix(name, ".jsonl")
	codex := strings.HasPrefix(name, "rollout-")
	var path string
	var roots usage.Roots
	if codex {
		sess = sess[len(sess)-36:]
		path = filepath.Join(dir, "2026", "10", "21", name)
		roots.CodexSessions = dir
	} else {
		path = filepath.Join(dir, "-bench", name)
		roots.ClaudeProjects = dir
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	copyFile(t, src, path)
	fi, _ := os.Stat(path)

	var logs logBuf
	b := startBridge(t, "", server.Options{Usage: &server.UsageConfig{Roots: roots, Interval: 200 * time.Millisecond},
		TranscriptFlush: 10 * time.Millisecond, Log: slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	c := b.connect(proto.Hello{})
	c.snapshot()
	w := worker("w1", "a", sess, "working")
	w.Harness = world.HarnessClaude
	if codex {
		w.AgentKind, w.Harness = "codex", world.HarnessCodex
	}
	b.floor("s1", true, w)
	id := workerID(t, c, sess)
	// As on a running bridge, the tail read the file before the first watch.
	for read := false; !read; {
		for _, w := range b.connect(proto.Hello{}).snapshot().World.Workers {
			read = read || (w.ID == id && w.Usage != nil)
		}
		time.Sleep(50 * time.Millisecond)
	}
	await := func(msg string, n int) string {
		t.Helper()
		deadline := time.Now().Add(60 * time.Second)
		for len(logs.lines(msg)) < n {
			if time.Now().After(deadline) {
				t.Fatalf("no %q", msg)
			}
			time.Sleep(5 * time.Millisecond)
		}
		return logs.lines(msg)[n-1]
	}
	attrs := func(line string) string {
		var out []string
		for _, m := range benchAttr.FindAllStringSubmatch(line, -1) {
			out = append(out, m[1]+"="+m[2])
		}
		return strings.Join(out, " ")
	}
	reads := 0
	visit := func(what string) {
		t.Helper()
		// Sent, then the read awaited in the log: a rebuild of a big file takes longer than the client waits for a message.
		args, _ := json.Marshal(proto.TranscriptWatchArgs{ID: id})
		c.send(proto.Command{T: proto.CmdTranscriptWatch, ReqID: fmt.Sprintf("v%d", reads), Args: args})
		reads++
		line := await("transcript watch read", reads)
		for c.next().env.T != proto.TAck {
		}
		t.Logf("%7.1f MB %-6s %-22s %s", float64(fi.Size())/1e6, map[bool]string{true: "codex", false: "claude"}[codex], what,
			attrs(line))
	}
	away := func() {
		t.Helper()
		c.mustAck(proto.CmdTranscriptUnwatch, proto.WorkerArgs{ID: id})
		time.Sleep(700 * time.Millisecond) // past a few usage rounds
	}

	visit("cold")
	away()
	t.Logf("%7.1f MB kept: %s", float64(fi.Size())/1e6, attrs(await("transcript log retained", 1)))
	visit("return")
	away()
	line := fixtureLine(t, "claude", "user.jsonl", 0)
	if codex {
		line = fixtureLine(t, "codex", "session.jsonl", 1)
	}
	appendLine(t, path, line)
	time.Sleep(500 * time.Millisecond)
	visit("return, appended away")
	away()
	next := path + ".new"
	copyFile(t, path, next)
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	visit("replaced (rebuilt)")
	t.Logf("%7.1f MB events: reused %d, built %d, evicted %q", float64(fi.Size())/1e6, len(logs.lines("transcript log reused")),
		len(logs.lines("transcript log built")), attrs(await("transcript log evicted", 1)))
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	in, err := os.Open(from)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}
