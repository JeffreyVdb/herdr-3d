package herdr_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
)

// shortDir is a temp dir short enough for unix socket paths (t.TempDir can
// exceed the ~108 byte limit).
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return c
}

func TestPingAndSnapshot(t *testing.T) {
	srv := herdrtest.Start(t, shortDir(t))
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))
	c := &herdr.Client{}

	pong, err := c.Ping(ctx(t), srv.Socket)
	if err != nil {
		t.Fatal(err)
	}
	if pong.Protocol != 22 || pong.Version != "0.9.0" {
		t.Fatalf("pong = %+v", pong)
	}

	snap, err := c.Snapshot(ctx(t), srv.Socket)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Workspaces) != 4 || len(snap.Panes) != 5 || len(snap.Agents) != 3 {
		t.Fatalf("snapshot sizes: %d workspaces, %d panes, %d agents", len(snap.Workspaces), len(snap.Panes), len(snap.Agents))
	}
	w := snap.Workspaces[0]
	if w.Label != "ORCH|bridge-ro" || w.Tokens["h3d_role"] != "orch" || w.Worktree == nil || w.Worktree.RepoName != "herdr-3d" {
		t.Fatalf("workspace[0] = %+v", w)
	}
	if a := snap.Agents[1]; a.Name == nil || *a.Name != "coder-r1" || a.AgentSession.Value != "3c731faa-b5eb-4fa8-a699-9016cf8e1c43" {
		t.Fatalf("agent[1] = %+v", a)
	}
}

func TestSnapshotOfDeadSocketFails(t *testing.T) {
	dir := shortDir(t)
	// A leftover socket file with nobody listening: stopped sessions keep theirs.
	srv := herdrtest.Start(t, dir)
	srv.Close()
	if _, err := os.Stat(srv.Socket); err != nil {
		if err := os.WriteFile(srv.Socket, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := (&herdr.Client{}).Ping(ctx(t), srv.Socket); err == nil {
		t.Fatal("ping of a dead socket succeeded")
	}
}

func TestSubscribeStreamsEventsUntilEOF(t *testing.T) {
	srv := herdrtest.Start(t, shortDir(t))
	c := &herdr.Client{}
	life, err := c.Subscribe(ctx(t), srv.Socket, herdr.LifecycleSubscriptions)
	if err != nil {
		t.Fatal(err)
	}
	defer life.Close()
	status, err := c.Subscribe(ctx(t), srv.Socket, herdr.StatusSubscriptions([]string{"w1:p1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer status.Close()
	srv.WaitStatusPane(t, "w1:p1")

	// Replay the recorded stream of a throwaway session: lifecycle lines go
	// to the lifecycle stream, status lines to the per-pane one.
	for _, line := range strings.Split(strings.TrimSpace(string(herdrtest.Fixture(t, "events.ndjson"))), "\n") {
		var ev herdr.Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Event == herdr.EventStatusChanged {
			var sc herdr.StatusChanged
			_ = json.Unmarshal(ev.Data, &sc)
			srv.PushStatus(sc.PaneID, sc.WorkspaceID, sc.AgentStatus, *sc.Agent)
		} else {
			srv.PushLifecycle(ev.Event, ev.Data)
		}
	}

	var lifecycle []string
	for range 6 {
		ev, err := life.Next()
		if err != nil {
			t.Fatal(err)
		}
		lifecycle = append(lifecycle, ev.Event)
	}
	want := []string{"workspace_created", "tab_created", "pane_created", "pane_agent_detected", "pane_agent_detected", "workspace_closed"}
	if !slices.Equal(lifecycle, want) {
		t.Fatalf("lifecycle = %v, want %v", lifecycle, want)
	}
	var statuses []string
	for range 3 {
		ev, err := status.Next()
		if err != nil {
			t.Fatal(err)
		}
		var sc herdr.StatusChanged
		if err := json.Unmarshal(ev.Data, &sc); err != nil {
			t.Fatal(err)
		}
		statuses = append(statuses, sc.AgentStatus)
	}
	if !slices.Equal(statuses, []string{"working", "idle", "unknown"}) {
		t.Fatalf("statuses = %v", statuses)
	}

	srv.DropStreams()
	if _, err := life.Next(); err == nil {
		t.Fatal("expected EOF after the server dropped the stream")
	}
	if _, err := status.Next(); err == nil {
		t.Fatal("expected EOF after the server dropped the stream")
	}
}

func TestSubscribeEndsOnCancel(t *testing.T) {
	srv := herdrtest.Start(t, shortDir(t))
	c, cancel := context.WithCancel(context.Background())
	s, err := (&herdr.Client{}).Subscribe(c, srv.Socket, herdr.LifecycleSubscriptions)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	cancel()
	done := make(chan error, 1)
	go func() { _, err := s.Next(); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Next succeeded after cancel")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Next did not return after cancel")
	}
}

// TestOnlyReadOnlyMethods drives every exported call and checks what the
// fake server was asked for.
func TestOnlyReadOnlyMethods(t *testing.T) {
	srv := herdrtest.Start(t, shortDir(t))
	c := &herdr.Client{}
	if _, err := c.Ping(ctx(t), srv.Socket); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Snapshot(ctx(t), srv.Socket); err != nil {
		t.Fatal(err)
	}
	s, err := c.Subscribe(ctx(t), srv.Socket, herdr.LifecycleSubscriptions)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	for _, m := range srv.Methods() {
		if m != "ping" && m != "session.snapshot" && m != "events.subscribe" {
			t.Errorf("herdr was asked for %q", m)
		}
	}
}

// TestListSessionsRunsExactlyTheListCommand uses a stand-in herdr binary
// that records its argv and environment.
func TestListSessionsRunsExactlyTheListCommand(t *testing.T) {
	dir := t.TempDir()
	fixture := filepath.Join(dir, "list.json")
	if err := os.WriteFile(fixture, herdrtest.Fixture(t, "session_list.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	record := filepath.Join(dir, "record")
	bin := filepath.Join(dir, "herdr")
	script := "#!/bin/sh\necho \"$@\" > " + record + "\nenv >> " + record + "\ncat " + fixture + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_SOCKET_PATH", "/nowhere/herdr.sock")
	t.Setenv("HERDR_SESSION", "someone-elses")
	t.Setenv("CLAUDE_CODE_CHILD_SESSION", "1")

	sessions, err := (&herdr.Client{Bin: bin}).ListSessions(ctx(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 || !sessions[0].Default || sessions[0].SessionDir != "/home/u/.config/herdr" || sessions[1].Name != "herdr-3d" || !sessions[1].Running {
		t.Fatalf("sessions = %+v", sessions)
	}
	got, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(got), "\n")
	if lines[0] != "session list --json" {
		t.Fatalf("argv = %q", lines[0])
	}
	for _, l := range lines[1:] {
		if strings.HasPrefix(l, "HERDR_SOCKET_PATH=") || strings.HasPrefix(l, "HERDR_SESSION=") || strings.HasPrefix(l, "CLAUDE") {
			t.Errorf("leaked into herdr's environment: %s", l)
		}
	}
}

func TestListSessionsFailure(t *testing.T) {
	_, err := (&herdr.Client{Bin: filepath.Join(t.TempDir(), "no-such-herdr")}).ListSessions(ctx(t))
	if err == nil {
		t.Fatal("expected an error")
	}
}

func TestErrorResponses(t *testing.T) {
	srv := herdrtest.Start(t, shortDir(t))
	c := &herdr.Client{}
	srv.Fail("session.snapshot", "server_busy")
	_, err := c.Snapshot(ctx(t), srv.Socket)
	var apiErr *herdr.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "server_busy" {
		t.Fatalf("err = %v, want APIError server_busy", err)
	}
	srv.Fail("events.subscribe", "nope")
	if _, err := c.Subscribe(ctx(t), srv.Socket, herdr.LifecycleSubscriptions); !errors.As(err, &apiErr) {
		t.Fatalf("subscribe err = %v, want APIError", err)
	}

	srv.Fail("session.snapshot", "")
	srv.SetSnapshot(json.RawMessage(`null`))
	if _, err := c.Snapshot(ctx(t), srv.Socket); err == nil || !strings.Contains(err.Error(), "result.snapshot missing") {
		t.Fatalf("err = %v", err)
	}
}

// #176: a pane's history offset, read with pane.get.
func TestPaneScroll(t *testing.T) {
	srv := herdrtest.Start(t, shortDir(t))
	c := &herdr.Client{}
	srv.SetPaneScroll("w1:p1", 12, 79, 31)
	got, ok, err := c.PaneScroll(ctx(t), srv.Socket, "w1:p1")
	if err != nil || !ok || got != (herdr.PaneScroll{ViewportRows: 31, Offset: 12, Max: 79}) {
		t.Fatalf("PaneScroll = %+v, %v, %v", got, ok, err)
	}
	srv.SetPaneScroll("w1:p2", 0, 0, -1) // no metrics: no scroll field
	if _, ok, err := c.PaneScroll(ctx(t), srv.Socket, "w1:p2"); err != nil || ok {
		t.Fatalf("without metrics: %v, %v", ok, err)
	}
	if _, _, err := c.PaneScroll(ctx(t), srv.Socket, "w9:p9"); err == nil {
		t.Fatal("an unknown pane")
	}
}
