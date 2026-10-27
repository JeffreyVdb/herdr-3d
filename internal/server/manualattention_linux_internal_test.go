//go:build linux

package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/manual"
	"github.com/JeffreyVdb/herdr-3d/internal/manual/inputwatch"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"golang.org/x/sys/unix"
)

// scriptedProc is one run on /dev/pts/5: the launcher and a foreground
// child named comm that either reads the tty or sleeps.
type scriptedProc struct {
	mu      sync.Mutex
	pid     int
	start   uint64
	comm    string
	reading bool
	calls   int
}

const scriptedTTY = 0x8805

func (s *scriptedProc) lock() func() { s.mu.Lock(); s.calls++; return s.mu.Unlock }
func (s *scriptedProc) PIDs() ([]int, error) {
	defer s.lock()()
	return []int{s.pid, s.pid + 1}, nil
}
func (s *scriptedProc) stat(pid int) (string, error) {
	switch pid {
	case s.pid:
		return fmt.Sprintf("%d (herdr-world) S 1 %d %d %d %d 0 0 0 0 0 0 0 0 0 0 0 0 0 %d 0", pid, s.pid, s.pid, scriptedTTY, s.pid, s.start), nil
	case s.pid + 1:
		return fmt.Sprintf("%d (%s) S %d %d %d %d %d 0 0 0 0 0 0 0 0 0 0 0 0 0 9 0", pid, s.comm, s.pid, s.pid, s.pid, scriptedTTY, s.pid), nil
	}
	return "", os.ErrNotExist
}
func (s *scriptedProc) Stat(pid int) (string, error) { defer s.lock()(); return s.stat(pid) }
func (s *scriptedProc) Tasks(pid int) ([]int, error) { return []int{pid}, nil }
func (s *scriptedProc) TaskStat(pid, _ int) (string, error) {
	defer s.lock()()
	return s.stat(pid)
}
func (s *scriptedProc) Syscall(pid, _ int) (string, error) {
	defer s.lock()()
	if pid == s.pid+1 && s.reading {
		return fmt.Sprintf("%d 0x0 0x7ffd 0x1", unix.SYS_READ), nil
	}
	return fmt.Sprintf("%d 0x0 0x0", unix.SYS_WAIT4), nil
}
func (s *scriptedProc) Wchan(int, int) (string, error) { return "do_wait", nil }
func (s *scriptedProc) Children(pid, _ int) ([]int, error) {
	if pid == s.pid {
		return []int{s.pid + 1}, nil
	}
	return nil, nil
}
func (s *scriptedProc) FDs(int) ([]int, error) { return []int{0, 1, 2}, nil }
func (s *scriptedProc) Device(int, int) (uint64, bool, error) {
	return unix.Mkdev(136, 5), true, nil
}
func (s *scriptedProc) Canonical(int, int) (bool, error) { return true, nil }
func (s *scriptedProc) set(reading bool) {
	s.mu.Lock()
	s.reading = reading
	s.mu.Unlock()
}

// processUpsert reads events until a manual_process.upsert of the rig's
// process satisfies ok.
func (r *manualRig) processUpsert(ok func(proto.ManualProcess) bool) proto.ManualProcess {
	r.t.Helper()
	for {
		e, b := r.read()
		if e.T != proto.EvManualProcessUpsert {
			continue
		}
		var ev proto.Event
		if json.Unmarshal(b, &ev) == nil && ev.Process != nil && ev.Process.ID == testManualID && ok(*ev.Process) {
			return *ev.Process
		}
	}
}

// The whole loop on a running hub: the ticker samples the run through the
// detector, two reads publish a confirmed episode (waiting), the snapshot of
// a reconnecting client carries it, input to the run's terminal clears it,
// new reads open a new episode, and the foreground program's name (a
// marker) appears nowhere.
func TestManualInputAttentionEndToEnd(t *testing.T) {
	procs := make(chan *inputProc, 4)
	control := &herdr.Control{Duplex: func([]string) (herdr.DuplexProc, error) { p := newInputProc(); procs <- p; return p, nil }}
	r := newManualRigWithTerm(t, control)
	marker := "H3D-MARKER-foreground-0123456789"
	fake := &scriptedProc{pid: 4_000_000, start: 777, comm: marker}
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, testManualID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := manual.WriteStatus(filepath.Join(dir, testManualID), manual.Status{PID: fake.pid, StartTicks: fake.start, StartedAt: 1}); err != nil {
		t.Fatal(err)
	}
	r.action(func() {
		r.hub.opts.ManualDir = dir
		r.hub.mi.det = &inputwatch.Detector{Proc: fake}
		r.hub.workers["worker"] = &proto.Worker{ID: "worker", Session: "s", PaneID: "w1:p1"}
		r.hub.syncManualInputTicker()
		r.hub.mi.ticker.Reset(15 * time.Millisecond)
	})
	quiet := r.processUpsert(func(p proto.ManualProcess) bool { return p.InputDetection != "" })
	if quiet.Attention != nil || quiet.State != "running" || quiet.InputDetection != "full" {
		t.Fatalf("idle run: %+v", quiet)
	}
	fake.set(true)
	open := r.processUpsert(func(p proto.ManualProcess) bool { return p.Attention != nil })
	if a := open.Attention; a.Kind != "input" || a.Confidence != "confirmed" || a.Reason != "tty_read" || open.State != "waiting" {
		t.Fatalf("opened: %+v", open)
	}
	// A reconnecting client's snapshot has the same episode.
	snap := r.snapshotOf()
	if got := manualOf(snap, testManualID); got.Attention == nil || got.Attention.ID != open.Attention.ID {
		t.Fatalf("snapshot: %+v", got)
	}
	if e := r.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: "mp:" + testManualID, Control: true, Cols: 120, Rows: 40}); e.T != "" {
		t.Fatalf("watch: %+v", e)
	}
	select {
	case <-procs:
	case <-time.After(3 * time.Second):
		t.Fatal("controller did not start")
	}
	for {
		if e, b := r.read(); e.T == proto.TTerminalFrame && strings.Contains(string(b), testManualID) {
			break
		}
	}
	answer := "y\n"
	mark := r.wire.Len()
	if e := r.command(proto.CmdTerminalInput, proto.TerminalInputArgs{ID: "mp:" + testManualID, Text: &answer}); e.T != "" {
		t.Fatalf("input: %+v", e)
	}
	// The clear is published before the ack.
	var cleared *proto.ManualProcess
	for _, line := range strings.Split(string(r.wire.Bytes()[mark:]), "\n") {
		var ev proto.Event
		if json.Unmarshal([]byte(line), &ev) == nil && ev.T == proto.EvManualProcessUpsert && ev.Process.ID == testManualID && ev.Process.Attention == nil {
			cleared = ev.Process
			break
		}
	}
	if cleared == nil || cleared.State != "running" {
		t.Fatalf("not cleared before the ack: %+v", cleared)
	}
	again := r.processUpsert(func(p proto.ManualProcess) bool { return p.Attention != nil })
	if again.Attention.ID == open.Attention.ID {
		t.Fatal("a new episode reused the old id")
	}
	fake.set(false)
	r.processUpsert(func(p proto.ManualProcess) bool { return p.Attention == nil && p.State == "running" })
	r.hygiene(marker)
	if strings.Contains(r.log.String(), marker) {
		t.Fatal("marker in the log")
	}
}

// snapshotOf is a new client's snapshot (a reconnect).
func (r *manualRig) snapshotOf() proto.Snapshot {
	r.t.Helper()
	ws, err := proto.Dial(r.ctx, filepath.Join(r.root, "bridge.sock"))
	if err != nil {
		r.t.Fatal(err)
	}
	defer ws.CloseNow()
	if _, err := ws.Hello(r.ctx, proto.Hello{Client: "reconnect"}); err != nil {
		r.t.Fatal(err)
	}
	_, b, err := ws.Read(r.ctx)
	if err != nil {
		r.t.Fatal(err)
	}
	var s proto.Snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		r.t.Fatal(err)
	}
	return s
}

func manualOf(s proto.Snapshot, id string) proto.ManualProcess {
	for _, p := range s.World.ManualProcesses {
		if p.ID == id {
			return p
		}
	}
	return proto.ManualProcess{}
}
