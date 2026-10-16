package watch_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
	"github.com/JeffreyVdb/herdr-3d/internal/watch"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// session makes a session directory like herdr's, optionally with a
// session.json fixture.
func session(t *testing.T, root, name, fixture string) herdr.Session {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if fixture != "" {
		if err := os.WriteFile(filepath.Join(dir, "session.json"), herdrtest.Fixture(t, fixture), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return herdr.Session{Name: name, SessionDir: dir, SocketPath: filepath.Join(dir, "herdr.sock")}
}

// recorder collects updates from the watchers. wait consumes the first
// matching update, received earlier or later; others stay pending.
type recorder struct {
	t       *testing.T
	out     chan world.Update
	pending []world.Update
}

func (r *recorder) wait(what string, ok func(world.Update) bool) world.Update {
	r.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		for i, u := range r.pending {
			if ok(u) {
				r.pending = slices.Delete(r.pending, i, i+1)
				return u
			}
		}
		select {
		case u := <-r.out:
			r.pending = append(r.pending, u)
		case <-deadline:
			r.t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func (r *recorder) floor(session, what string, ok func(world.FloorObs) bool) world.FloorObs {
	r.t.Helper()
	return r.wait(session+": "+what, func(u world.Update) bool {
		f, isFloor := u.(world.FloorObs)
		return isFloor && f.Session == session && ok(f)
	}).(world.FloorObs)
}

func workspaces(f world.FloorObs) []string {
	var ids []string
	for _, w := range f.Workers {
		ids = append(ids, w.WorkspaceID)
	}
	return ids
}

func status(f world.FloorObs, ws string) string {
	for _, w := range f.Workers {
		if w.WorkspaceID == ws {
			return w.Status
		}
	}
	return ""
}

func start(t *testing.T, lister watch.Herdr, only *regexp.Regexp) *recorder {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	out := make(chan world.Update, 1024)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = watch.Run(ctx, watch.Config{
			Herdr: lister, Out: out, Only: only, Poll: 100 * time.Millisecond, Resnapshot: time.Hour,
			ProbeTimeout: 200 * time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("watch.Run did not stop")
		}
	})
	return &recorder{t: t, out: out}
}

func TestWatch(t *testing.T) {
	root := shortDir(t)
	alpha := session(t, root, "alpha", "")
	srv := herdrtest.Start(t, alpha.SessionDir)
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))

	beta := session(t, root, "beta", "session_v3.json")
	// herdr 0.9.1 keeps unreadable files in session-backups/; never read.
	if err := os.MkdirAll(filepath.Join(beta.SessionDir, "session-backups"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(beta.SessionDir, "session-backups", "session.json"), []byte("garbage"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Stopped, with a future session.json and a leftover socket file.
	gamma := session(t, root, "gamma", "session_bad_version.json")
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: gamma.SocketPath, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	stale.Close()

	// A hung server: accepts, never answers. It must not stall anyone else.
	delta := session(t, root, "delta", "")
	hung, err := net.Listen("unix", delta.SocketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer hung.Close()
	go func() {
		var held []net.Conn
		defer func() {
			for _, c := range held {
				c.Close()
			}
		}()
		for {
			c, err := hung.Accept()
			if err != nil {
				return
			}
			held = append(held, c)
		}
	}()

	other := session(t, root, "not-mine", "session_v3.json")
	lister := herdrtest.NewLister()
	lister.Set(alpha, beta, gamma, delta, other)
	rec := start(t, lister, regexp.MustCompile(`^(alpha|beta|gamma|delta)$`))

	first := rec.floor("alpha", "running with the snapshot's workers", func(f world.FloorObs) bool { return f.Running })
	if !first.Fresh || !slices.Equal(workspaces(first), []string{"w1", "wD", "w3", "w4"}) {
		t.Fatalf("alpha = %+v", first)
	}
	b := rec.floor("beta", "asleep from session.json", func(f world.FloorObs) bool { return true })
	if b.Running || b.Err != "" || !slices.Equal(workspaces(b), []string{"w1", "w1Q", "w2", "w3"}) {
		t.Fatalf("beta = %+v", b)
	}
	g := rec.floor("gamma", "asleep with a format error", func(f world.FloorObs) bool { return true })
	if g.Running || len(g.Workers) != 0 || !strings.Contains(g.Err, "unsupported session.json version 4") {
		t.Fatalf("gamma = %+v", g)
	}
	if d := rec.floor("delta", "asleep (hung socket)", func(f world.FloorObs) bool { return true }); d.Running || len(d.Workers) != 0 {
		t.Fatalf("delta = %+v", d)
	}

	// A status event updates just that worker, within the same generation.
	srv.WaitStatusPane(t, "wD:p1")
	srv.PushStatus("wD:p1", "wD", "working", "claude")
	f := rec.floor("alpha", "wD working", func(f world.FloorObs) bool { return status(f, "wD") == "working" })
	if f.Fresh || f.Gen != first.Gen || status(f, "w1") != "working" {
		t.Fatalf("after status event: %+v", f)
	}

	// A lifecycle event triggers a re-snapshot; new panes get a status sub.
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot_after.json"))
	srv.PushLifecycle("workspace_closed", map[string]any{"type": "workspace_closed", "workspace_id": "wD"})
	f = rec.floor("alpha", "wD closed, w5 created", func(f world.FloorObs) bool { return slices.Contains(workspaces(f), "w5") })
	if !slices.Equal(workspaces(f), []string{"w1", "w3", "w4", "w5"}) {
		t.Fatalf("after lifecycle event: %v", workspaces(f))
	}
	srv.WaitStatusPane(t, "w5:p1")
	srv.PushStatus("w5:p1", "w5", "blocked", "claude")
	rec.floor("alpha", "w5 blocked", func(f world.FloorObs) bool { return status(f, "w5") == "blocked" })

	// The streams end but the server still answers: reconnect, marked fresh.
	srv.DropStreams()
	f = rec.floor("alpha", "reconnected", func(f world.FloorObs) bool { return f.Gen > first.Gen })
	if !f.Running || !f.Fresh {
		t.Fatalf("after reconnect: %+v", f)
	}

	// The session stops: herdr saves session.json on the way down.
	if err := os.WriteFile(filepath.Join(alpha.SessionDir, "session.json"), herdrtest.Fixture(t, "session_v3_unknown_fields.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	stoppedAt := time.Now()
	srv.Close()
	f = rec.floor("alpha", "asleep", func(f world.FloorObs) bool { return !f.Running })
	if took := time.Since(stoppedAt); took > 2*time.Second {
		t.Errorf("stop noticed after %v", took)
	}
	if f.Fresh || !slices.Equal(workspaces(f), []string{"w7"}) {
		t.Fatalf("asleep alpha = %+v", f)
	}

	// Listing fails for a while: nothing is torn down.
	lister.Fail(errors.New("herdr is being upgraded"))
	time.Sleep(300 * time.Millisecond)
	// The session is deleted.
	lister.Set(alpha, gamma, delta)
	rec.wait("beta gone", func(u world.Update) bool {
		g, ok := u.(world.FloorGone)
		if ok && g.Session != "beta" {
			t.Fatalf("unexpected FloorGone %+v", g)
		}
		return ok
	})

	for _, m := range srv.Methods() {
		if m != "ping" && m != "session.snapshot" && m != "events.subscribe" {
			t.Errorf("herdr was asked for %q", m)
		}
	}
}

// probeGate keeps liveness probes out of a scripted server restart.
type probeGate struct {
	watch.Herdr
	mu sync.Mutex
}

func (h *probeGate) Ping(ctx context.Context, socket string) (*herdr.Pong, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.Herdr.Ping(ctx, socket)
}

// TestWatchFreshAfterUnseenRestart: a session that stops and starts again
// between two polls cannot vouch for continuity.
func TestWatchFreshAfterUnseenRestart(t *testing.T) {
	root := shortDir(t)
	s := session(t, root, "s", "")
	srv := herdrtest.Start(t, s.SessionDir)
	lister := herdrtest.NewLister()
	lister.Set(s)
	h := &probeGate{Herdr: lister}
	rec := start(t, h, nil)
	first := rec.floor("s", "running", func(f world.FloorObs) bool { return f.Running })

	// No liveness probe may see the stopped socket: that would exercise an
	// observed stop and wake, where continuity is expected instead.
	func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		srv.Close()
		srv2 := herdrtest.Start(t, s.SessionDir)
		srv2.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))
	}()
	f := rec.floor("s", "running again", func(f world.FloorObs) bool { return f.Gen > first.Gen && f.Running && len(f.Workers) > 0 })
	if !f.Fresh {
		t.Fatalf("restart not marked fresh: %+v", f)
	}
}

// TestWatchDegraded: a session that answers ping but cannot be snapshotted
// stays running, keeps its workers and shows the error.
func TestWatchDegraded(t *testing.T) {
	root := shortDir(t)
	s := session(t, root, "s", "")
	srv := herdrtest.Start(t, s.SessionDir)
	srv.Fail("session.snapshot", "internal_error")
	lister := herdrtest.NewLister()
	lister.Set(s)
	rec := start(t, lister, nil)
	f := rec.floor("s", "degraded", func(f world.FloorObs) bool { return f.Err != "" })
	if !f.Running || !f.KeepWorkers || !strings.Contains(f.Err, "internal_error") {
		t.Fatalf("degraded = %+v", f)
	}
	srv.Fail("session.snapshot", "")
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))
	f = rec.floor("s", "recovered", func(f world.FloorObs) bool { return f.Err == "" && len(f.Workers) == 4 })
	if f.KeepWorkers || !f.Fresh {
		t.Fatalf("recovered = %+v", f)
	}
}

// TestWatchRescanAndAgentDetected: a rescan request looks at sessions right
// away (a woken session is followed without waiting for the poll), and
// herdr's pane_agent_detected reaches the hub as its own update.
func TestWatchRescanAndAgentDetected(t *testing.T) {
	root := shortDir(t)
	s := session(t, root, "s", "session_v3.json")
	lister := herdrtest.NewLister()
	lister.Set(s)
	out := make(chan world.Update, 1024)
	rescan := make(chan struct{}, 1)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = watch.Run(ctx, watch.Config{
			Herdr: lister, Out: out, Rescan: rescan, Poll: time.Hour, Resnapshot: time.Hour,
			ProbeTimeout: 200 * time.Millisecond, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		})
	}()
	t.Cleanup(func() { cancel(); <-done })
	rec := &recorder{t: t, out: out}
	asleep := rec.floor("s", "asleep", func(f world.FloorObs) bool { return !f.Running })
	if asleep.Socket != s.SocketPath {
		t.Fatalf("asleep socket = %q, want %q", asleep.Socket, s.SocketPath)
	}

	srv := herdrtest.Start(t, s.SessionDir)
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))
	woke := time.Now()
	rescan <- struct{}{}
	f := rec.floor("s", "running after the rescan", func(f world.FloorObs) bool { return f.Running })
	if took := time.Since(woke); took > time.Second || f.Socket != s.SocketPath {
		t.Fatalf("running after %v: %+v", took, f)
	}

	srv.WaitStreams(t, 2)
	srv.PushLifecycle("pane_agent_detected", map[string]any{"type": "pane_agent_detected", "pane_id": "w1:p1", "workspace_id": "w1", "agent": "claude"})
	srv.PushLifecycle("pane_agent_detected", map[string]any{"type": "pane_agent_detected", "pane_id": "w3:p1", "workspace_id": "w3", "agent": "codex", "released": true, "final_status": "idle"})
	isDetected := func(pane string) func(world.Update) bool {
		return func(u world.Update) bool { d, ok := u.(world.AgentDetected); return ok && d.PaneID == pane }
	}
	if d := rec.wait("claude detected", isDetected("w1:p1")).(world.AgentDetected); d != (world.AgentDetected{Session: "s", WorkspaceID: "w1", PaneID: "w1:p1", Agent: "claude"}) {
		t.Fatalf("detected = %+v", d)
	}
	if d := rec.wait("codex released", isDetected("w3:p1")).(world.AgentDetected); !d.Released || d.Agent != "codex" {
		t.Fatalf("released = %+v", d)
	}
}
