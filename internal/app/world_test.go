package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr/herdrtest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

func TestDefaultPaths(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/4242")
	if got := DefaultSocket(); got != "/run/user/4242/herdr-world/bridge.sock" {
		t.Errorf("DefaultSocket = %q", got)
	}
	t.Setenv("XDG_STATE_HOME", "/home/u/.state")
	if got := DefaultDB(); got != "/home/u/.state/herdr-world/world.db" {
		t.Errorf("DefaultDB = %q", got)
	}
	t.Setenv("XDG_STATE_HOME", "")
	t.Setenv("HOME", "/home/u")
	if got := DefaultDB(); got != "/home/u/.local/state/herdr-world/world.db" {
		t.Errorf("DefaultDB fallback = %q", got)
	}
}

func TestWorldVersionAndUsage(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := World("herdr-world", []string{"-version"}, &out, &errOut); code != 0 || strings.TrimSpace(out.String()) != "herdr-world "+version.Version {
		t.Fatalf("-version: code %d, out %q, err %q", code, out.String(), errOut.String())
	}
	if code := World("herdr-world", []string{"frob"}, &out, &errOut); code != 2 {
		t.Fatalf("unknown subcommand: code %d", code)
	}
	if code := World("herdr-world", []string{"serve", "-nope"}, &out, &errOut); code != 2 {
		t.Fatalf("bad flag: code %d", code)
	}
}

// running is a bridge started with Serve against a fake herdr.
type running struct {
	sock string
	stop func()
}

func serve(t *testing.T, db string, lister *herdrtest.Lister) running {
	t.Helper()
	dir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "herdr-world", "bridge.sock")
	ctx, cancel := context.WithCancel(context.Background())
	ready := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- Serve(ctx, ServeConfig{
			Socket: sock, DB: db, Herdr: lister, Poll: 50 * time.Millisecond, Resnapshot: time.Hour,
			Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Name: "herdr-world", Ready: func() { close(ready) },
		})
	}()
	select {
	case <-ready:
	case err := <-done:
		t.Fatalf("Serve: %v", err)
	}
	var once sync.Once
	stop := func() {
		once.Do(func() {
			cancel()
			if err := <-done; err != nil {
				t.Errorf("Serve: %v", err)
			}
			if _, err := os.Lstat(sock); !os.IsNotExist(err) {
				t.Errorf("socket not removed on shutdown: %v", err)
			}
		})
	}
	t.Cleanup(stop)
	return running{sock: sock, stop: stop}
}

func runCLI(t *testing.T, fn func(context.Context, string, []string, io.Writer, io.Writer) error, args ...string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out, errOut bytes.Buffer
	err := fn(ctx, "herdr-world", args, &out, &errOut)
	return out.String(), err
}

func dumpOnce(t *testing.T, sock string) proto.World {
	t.Helper()
	for {
		out, err := runCLI(t, dumpMain, "-socket", sock, "-once")
		if err != nil {
			t.Fatalf("dump: %v", err)
		}
		lines := strings.Split(strings.TrimSpace(out), "\n")
		var snap proto.Snapshot
		if len(lines) != 1 || json.Unmarshal([]byte(lines[0]), &snap) != nil || snap.T != proto.TSnapshot {
			t.Fatalf("dump -once printed %q", out)
		}
		if len(snap.World.Floors) > 0 {
			return snap.World
		}
		time.Sleep(20 * time.Millisecond) // discovery has not run yet
	}
}

func TestServeDumpCmd(t *testing.T) {
	root, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(root) })
	alphaDir := filepath.Join(root, "alpha")
	sleepyDir := filepath.Join(root, "sleepy")
	for _, d := range []string{alphaDir, sleepyDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(sleepyDir, "session.json"), herdrtest.Fixture(t, "session_v3.json"), 0o600); err != nil {
		t.Fatal(err)
	}
	srv := herdrtest.Start(t, alphaDir)
	srv.SetSnapshot(herdrtest.SnapshotFixture(t, "snapshot.json"))
	lister := herdrtest.NewLister()
	lister.Set(
		herdr.Session{Name: "alpha", SessionDir: alphaDir, SocketPath: srv.Socket},
		herdr.Session{Name: "sleepy", SessionDir: sleepyDir, SocketPath: filepath.Join(sleepyDir, "herdr.sock")},
	)
	db := filepath.Join(t.TempDir(), "world.db")
	b := serve(t, db, lister)

	w := dumpOnce(t, b.sock)
	for len(w.Floors) < 2 {
		w = dumpOnce(t, b.sock)
	}
	if w.Floors[0].Session != "alpha" || w.Floors[0].State != "running" || w.Floors[1].State != "asleep" || len(w.Workers) != 8 {
		t.Fatalf("world = %+v", w)
	}

	out, err := runCLI(t, cmdMain, "-socket", b.sock, proto.CmdBuildingCreate, `{"name":"Work"}`)
	if err != nil {
		t.Fatalf("cmd: %v", err)
	}
	var ack proto.Ack
	if json.Unmarshal([]byte(out), &ack) != nil || ack.T != proto.TAck {
		t.Fatalf("cmd printed %q", out)
	}
	id := ack.Data.(map[string]any)["id"].(string)
	if _, err := runCLI(t, cmdMain, "-socket", b.sock, proto.CmdFloorAssign, `{"session":"sleepy","building":"`+id+`"}`); err != nil {
		t.Fatal(err)
	}
	out, err = runCLI(t, cmdMain, "-socket", b.sock, "building.explode", `{}`)
	if err == nil || !strings.Contains(out, proto.ErrUnknownCommand) {
		t.Fatalf("unknown command: out %q, err %v", out, err)
	}
	if _, err := runCLI(t, cmdMain, "-socket", b.sock, proto.CmdBuildingCreate, `{not json`); err == nil {
		t.Fatal("invalid JSON accepted")
	}

	// dump streams events after the snapshot until cancelled.
	ctx, cancel := context.WithCancel(context.Background())
	pr, pw := io.Pipe()
	dumpDone := make(chan error, 1)
	go func() {
		dumpDone <- dumpMain(ctx, "herdr-world", []string{"-socket", b.sock}, pw, io.Discard)
		pw.Close()
	}()
	lines := bufio.NewScanner(pr)
	lines.Buffer(nil, 1<<20)
	if !lines.Scan() || !strings.Contains(lines.Text(), `"t":"world.snapshot"`) {
		t.Fatalf("first dump line: %q", lines.Text())
	}
	srv.WaitStatusPane(t, "w4:p1")
	srv.PushStatus("w4:p1", "w4", "working", "h3dprobe")
	for lines.Scan() {
		if strings.Contains(lines.Text(), `"t":"worker.upsert"`) && strings.Contains(lines.Text(), `"agent_kind":"h3dprobe"`) {
			break
		}
	}
	cancel()
	go func() { _, _ = io.Copy(io.Discard, pr) }()
	if err := <-dumpDone; err != nil {
		t.Fatalf("dump after Ctrl-C: %v", err)
	}

	// Restart: the building and its floor survive.
	b.stop()
	b = serve(t, db, lister)
	w = dumpOnce(t, b.sock)
	for len(w.Floors) < 2 {
		w = dumpOnce(t, b.sock)
	}
	if len(w.Buildings) != 1 || w.Buildings[0].Name != "Work" || !slices.Equal(w.Buildings[0].Floors, []string{"sleepy"}) ||
		!slices.Equal(w.Unassigned, []string{"alpha"}) || w.Floors[0].Session != "sleepy" {
		t.Fatalf("after restart: buildings %+v, unassigned %v", w.Buildings, w.Unassigned)
	}
}

func TestDumpReplay(t *testing.T) {
	lister := herdrtest.NewLister()
	b := serve(t, filepath.Join(t.TempDir(), "world.db"), lister)
	var errOut bytes.Buffer
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out bytes.Buffer
	if err := dumpMain(ctx, "herdr-world", []string{"-socket", b.sock, "-once"}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	var epoch string
	var seq uint64
	for _, f := range strings.Fields(errOut.String()) {
		if v, ok := strings.CutPrefix(f, "epoch="); ok {
			epoch = v
		}
		if v, ok := strings.CutPrefix(f, "server_seq="); ok {
			_ = json.Unmarshal([]byte(v), &seq)
		}
	}
	if _, err := runCLI(t, cmdMain, "-socket", b.sock, proto.CmdBuildingCreate, `{"name":"A"}`); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errOut.Reset()
	if err := dumpMain(ctx, "herdr-world", []string{"-socket", b.sock, "-once", "-since", "0", "-epoch", epoch}, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errOut.String(), "resume=replay") || !strings.Contains(out.String(), `"t":"building.upsert"`) || strings.Contains(out.String(), "world.snapshot") {
		t.Fatalf("replay dump: out %q err %q (seq was %d)", out.String(), errOut.String(), seq)
	}
}
