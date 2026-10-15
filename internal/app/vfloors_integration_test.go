//go:build integration

package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// noAgent is herdr's own write path for hires, except that a hire starts no
// agent: its workspace, pane marker, herdr restarts and bridge restarts are
// real, and nothing runs Claude or Codex.
type noAgent struct{ *herdr.Control }

func (noAgent) StartAgent(context.Context, string, string, string, herdr.Agent) error { return nil }

// vfBridge is a bridge under test on a throwaway session: its database, and
// the socket a restart serves again.
type vfBridge struct {
	t      *testing.T
	s      *throwaway
	sock   string
	db     string
	only   *regexp.Regexp
	conn   *bridgeConn
	stopFn func()
}

func newVFBridge(t *testing.T, s *throwaway, only *regexp.Regexp) *vfBridge {
	sockDir, err := os.MkdirTemp("", "h3d")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	vb := &vfBridge{t: t, s: s, sock: filepath.Join(sockDir, "herdr-world", "bridge.sock"),
		db: filepath.Join(t.TempDir(), "world.db"), only: only}
	vb.start()
	t.Cleanup(func() { vb.stop() })
	return vb
}

// start serves the bridge (again, after stop: a bridge restart over the same
// database) and connects to it once its floor is running.
func (vb *vfBridge) start() {
	t, s := vb.t, vb.s
	opts := server.HireOptions()
	opts.Claude.Models = append(opts.Claude.Models, cheapClaude)
	control := &herdr.Control{Herdr: s.bin, Only: vb.only}
	ctx, cancel := context.WithCancel(context.Background())
	ready, served := make(chan struct{}), make(chan error, 1)
	go func() {
		served <- Serve(ctx, ServeConfig{
			Socket: vb.sock, DB: vb.db, Herdr: &herdr.Client{Bin: s.bin}, Only: vb.only,
			Log:  slog.New(slog.NewTextHandler(testWriter{t}, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Name: "herdr-world", Ready: func() { close(ready) },
			Control: control, Hire: noAgent{control}, HireOptions: &opts, TrustTimeout: time.Second,
		})
	}()
	vb.stopFn = func() {
		cancel()
		if err := <-served; err != nil {
			t.Errorf("Serve: %v", err)
		}
	}
	select {
	case <-ready:
	case err := <-served:
		t.Fatalf("Serve: %v", err)
	}
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := proto.Dial(dctx, vb.sock)
	dcancel()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Hello(ctx, proto.Hello{Client: "integration-vfloors"}); err != nil {
		t.Fatal(err)
	}
	st := &stream{t: t, msgs: make(chan []byte, 4096)}
	go func() {
		defer close(st.msgs)
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			st.msgs <- raw
		}
	}()
	st.waitFor("the session's floor", 10*time.Second, func(ev proto.Event) bool {
		return ev.T == proto.EvFloorUpsert && ev.Floor.ID == s.name
	})
	vb.conn = &bridgeConn{t: t, conn: conn, st: st}
}

func (vb *vfBridge) stop() {
	if vb.stopFn != nil {
		vb.conn.conn.CloseNow()
		vb.stopFn()
		vb.stopFn = nil
	}
}

// world waits until the bridge's world satisfies ok (a fresh snapshot each
// time) and returns it.
func (vb *vfBridge) world(what string, within time.Duration, ok func(proto.World) bool) proto.World {
	vb.t.Helper()
	deadline := time.Now().Add(within)
	for {
		var out strings.Builder
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
		err := dumpMain(dctx, "herdr-world", []string{"-socket", vb.sock, "-once"}, &out, io.Discard)
		dcancel()
		if err != nil {
			vb.t.Fatal(err)
		}
		var snap proto.Snapshot
		if err := json.Unmarshal([]byte(out.String()), &snap); err != nil {
			vb.t.Fatal(err)
		}
		if ok(snap.World) {
			return snap.World
		}
		if time.Now().After(deadline) {
			vb.t.Fatalf("the world never got to %s: %s", what, out.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func floorIn(w proto.World, id string) (proto.Floor, bool) {
	for _, f := range w.Floors {
		if f.ID == id {
			return f, true
		}
	}
	return proto.Floor{}, false
}

func workerIn(w proto.World, ok func(proto.Worker) bool) (proto.Worker, bool) {
	for _, wk := range w.Workers {
		if ok(wk) {
			return wk, true
		}
	}
	return proto.Worker{}, false
}

// settled: every floor is in state, none in a transition.
func settled(state string, floors ...string) func(proto.World) bool {
	return func(w proto.World) bool {
		for _, id := range floors {
			if f, ok := floorIn(w, id); !ok || f.State != state || f.Transition != "" {
				return false
			}
		}
		return true
	}
}

// TestIntegrationVirtualFloors (#58) runs a virtual floor on a throwaway
// session through the bridge, with herdr's real sleep (session stop) and wake
// (the transient unit herdr-s-<name>). No agent starts: the hire path is
// herdr's own, minus the agent (noAgent).
//
//   - floor.sleep on the virtual floor puts the session to sleep: both floors
//     asleep;
//   - decision 3: a hire on the virtual floor while it sleeps wakes the
//     session first: both floors running, the worker on the virtual floor;
//   - a workspace made with `herdr workspace create` (unattributed) is on the
//     real floor;
//   - herdr restarts (sleep on the real floor, wake on the virtual one): the
//     worker is still on the virtual floor at its desk;
//   - the bridge restarts over the same database: the same.
func TestIntegrationVirtualFloors(t *testing.T) {
	if _, err := exec.LookPath("systemd-run"); err != nil {
		t.Skip("systemd-run is not installed")
	}
	s := startThrowaway(t)
	wakeUnitCleanup(t, s)
	cwd := t.TempDir()
	vb := newVFBridge(t, s, regexp.MustCompile("^"+regexp.QuoteMeta(s.name)+"$"))
	b := vb.conn

	var v proto.Floor
	b.ack(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: s.name}, 15*time.Second, &v)
	if !v.Virtual || v.BaseSession != s.name || !strings.HasPrefix(v.ID, "v-") {
		t.Fatalf("created %+v", v)
	}

	// Sleep from the virtual floor: the whole session sleeps.
	b.ack(proto.CmdFloorSleep, proto.FloorArgs{Floor: v.ID}, time.Minute, nil)
	vb.world("both floors asleep", 15*time.Second, settled("asleep", s.name, v.ID))

	// Decision 3: hire on the asleep virtual floor.
	desk := 1
	var hired proto.HireResult
	start := time.Now()
	evs := b.ack(proto.CmdWorkerHire, proto.WorkerHireArgs{Floor: v.ID, DeskIndex: &desk, Harness: "claude", Model: cheapClaude,
		Effort: "low", Label: "Webby", Cwd: cwd}, 2*time.Minute, &hired)
	t.Logf("hire with a wake acked after %s", time.Since(start).Round(time.Millisecond))
	waking := false
	for _, ev := range evs {
		waking = waking || (ev.T == proto.EvFloorUpsert && ev.Floor.ID == v.ID && ev.Floor.Transition == proto.TransitionWaking)
	}
	if !waking {
		t.Errorf("no waking transition on the virtual floor before the hire's ack")
	}
	w := vb.world("both floors running with the hire", 15*time.Second, func(w proto.World) bool {
		_, ok := workerIn(w, func(wk proto.Worker) bool { return wk.ID == hired.ID })
		return ok && settled("running", s.name, v.ID)(w)
	})
	if wk, _ := workerIn(w, func(wk proto.Worker) bool { return wk.ID == hired.ID }); wk.Floor != v.ID || wk.Session != s.name ||
		wk.DeskIndex != desk {
		t.Fatalf("hired worker = %+v", wk)
	}

	// A workspace nobody attributed is on the real floor.
	s.run("--session", s.name, "workspace", "create", "--cwd", cwd, "--label", "notes", "--no-focus")
	isNotes := func(wk proto.Worker) bool { return wk.Label == "notes" }
	w = vb.world("the unattributed workspace", 15*time.Second, func(w proto.World) bool { _, ok := workerIn(w, isNotes); return ok })
	if notes, _ := workerIn(w, isNotes); notes.Floor != s.name {
		t.Fatalf("unattributed workspace = %+v", notes)
	}

	check := func(when string) {
		t.Helper()
		w := vb.world(when, 20*time.Second, func(w proto.World) bool {
			_, hiredOK := workerIn(w, func(wk proto.Worker) bool { return wk.ID == hired.ID })
			_, notesOK := workerIn(w, isNotes)
			return hiredOK && notesOK && settled("running", s.name, v.ID)(w)
		})
		wk, _ := workerIn(w, func(wk proto.Worker) bool { return wk.ID == hired.ID })
		notes, _ := workerIn(w, isNotes)
		if wk.Floor != v.ID || wk.DeskIndex != desk || notes.Floor != s.name {
			t.Fatalf("%s: hired %+v, notes %+v", when, wk, notes)
		}
	}

	// herdr restarts: sleep from the real floor, wake from the virtual one.
	b.ack(proto.CmdFloorSleep, proto.FloorArgs{Floor: s.name}, time.Minute, nil)
	vb.world("both floors asleep again", 15*time.Second, settled("asleep", s.name, v.ID))
	b.ack(proto.CmdFloorWake, proto.FloorArgs{Floor: v.ID}, time.Minute, nil)
	check("after a sleep and wake")

	// The bridge restarts over the same database.
	vb.stop()
	vb.start()
	check("after a bridge restart")
}

// TestIntegrationVirtualFloorSessionGuard (#58): a virtual floor's base must
// be a session the bridge watches (--sessions), and session.create refuses a
// name outside it. Another real throwaway session, which the bridge does not
// watch, is the base it is refused.
func TestIntegrationVirtualFloorSessionGuard(t *testing.T) {
	s := startThrowaway(t)
	outside := startThrowaway(t)
	vb := newVFBridge(t, s, regexp.MustCompile("^"+regexp.QuoteMeta(s.name)+"$"))
	b := vb.conn
	b.refuse(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: outside.name}, proto.ErrUnknownSession)
	b.refuse(proto.CmdSessionCreate, proto.SessionCreateArgs{Name: outside.name + "-new"}, proto.ErrBadRequest)
	var v proto.Floor
	b.ack(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: "Web", BaseSession: s.name}, 15*time.Second, &v)
	if v.BaseSession != s.name {
		t.Fatalf("created %+v", v)
	}
}
