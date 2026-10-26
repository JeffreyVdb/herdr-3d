package server

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type inputProc struct {
	stdout   *io.PipeReader
	out      *io.PipeWriter
	stdin    *io.PipeWriter
	done     chan struct{}
	once     sync.Once
	commands chan map[string]any
}

func newInputProc() *inputProc {
	outR, outW := io.Pipe()
	inR, inW := io.Pipe()
	p := &inputProc{stdout: outR, out: outW, stdin: inW, done: make(chan struct{}), commands: make(chan map[string]any, 64)}
	go func() {
		_, _ = io.WriteString(outW, `{"encoding":"ansi","full":true,"height":40,"seq":1,"type":"terminal.frame","width":120,"bytes":"aGk="}`+"\n")
	}()
	go func() {
		scan := bufio.NewScanner(inR)
		for scan.Scan() {
			var v map[string]any
			_ = json.Unmarshal(scan.Bytes(), &v)
			p.commands <- v
			if v["type"] == "terminal.release" {
				p.finish()
				return
			}
		}
		p.finish()
	}()
	return p
}
func (p *inputProc) finish() {
	p.once.Do(func() { _ = p.out.Close(); _ = p.stdout.Close(); _ = p.stdin.Close(); close(p.done) })
}
func (p *inputProc) Stdout() io.Reader     { return p.stdout }
func (p *inputProc) Stdin() io.WriteCloser { return p.stdin }
func (p *inputProc) Done() <-chan struct{} { return p.done }
func (p *inputProc) Stop() error           { p.finish(); return nil }

func TestManualTerminalWatchInputAndDetach(t *testing.T) {
	procs := make(chan *inputProc, 4)
	control := &herdr.Control{Duplex: func([]string) (herdr.DuplexProc, error) { p := newInputProc(); procs <- p; return p, nil }}
	r := newManualRigWithTerm(t, control)
	r.action(func() {
		r.hub.opts.MaxWatches = 2
		r.hub.opts.MaxObservers = 2
		r.hub.manualProcesses["mp_11111111"] = proto.ManualProcess{ID: "mp_11111111", State: "running", Session: "s", PaneID: "w1:p3"}
		r.hub.floors["s"] = &floorState{sessionState: &sessionState{session: "s", running: true}, id: "s"}
		r.hub.workers["worker"] = &proto.Worker{ID: "worker", Session: "s", PaneID: "w1:p1"}
		p := r.hub.manualProcesses[testManualID]
		p.PaneID = "w1:p2"
		r.hub.manualProcesses[testManualID] = p
	})
	watch := func(id string) *inputProc {
		t.Helper()
		if e := r.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: id, Control: true, Cols: 120, Rows: 40}); e.T != "" {
			t.Fatalf("watch: %+v", e)
		}
		var p *inputProc
		select {
		case p = <-procs:
		case <-time.After(3 * time.Second):
			t.Fatal("controller did not start")
		}
		for {
			e, b := r.read()
			if e.T == proto.TTerminalFrame && strings.Contains(string(b), id) {
				break
			}
		}
		return p
	}
	agent := watch("worker")
	mp := watch("mp:" + testManualID)
	if e := r.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: "mp:mp_11111111"}); e.Code != proto.ErrCapacity {
		t.Fatalf("per-connection cap: %+v", e)
	}
	marker := "H3D-MARKER-terminal-0123456789"
	if e := r.command(proto.CmdTerminalInput, proto.TerminalInputArgs{ID: "mp:" + testManualID, Text: &marker}); e.T != "" {
		t.Fatalf("input: %+v", e)
	}
	seen := false
	deadline := time.After(3 * time.Second)
	for !seen {
		select {
		case m := <-mp.commands:
			if v, ok := m["text"].(string); ok {
				if v != marker {
					t.Fatal("input changed")
				}
				seen = true
			}
		case <-deadline:
			t.Fatal("input did not reach controller")
		}
	}
	bytesMarker := []byte("H3D-MARKER-terminal-bytes-987654321")
	if e := r.command(proto.CmdTerminalInput, proto.TerminalInputArgs{ID: "mp:" + testManualID, Bytes: &bytesMarker}); e.T != "" {
		t.Fatalf("bytes input: %+v", e)
	}
	foundBytes := false
	for !foundBytes {
		select {
		case m := <-mp.commands:
			if v, ok := m["bytes"].(string); ok {
				decoded, err := base64.StdEncoding.DecodeString(v)
				if err != nil || string(decoded) != string(bytesMarker) {
					t.Fatal("bytes input changed")
				}
				foundBytes = true
			}
		case <-time.After(3 * time.Second):
			t.Fatal("bytes input did not arrive")
		}
	}
	if e := r.command(proto.CmdTerminalResize, proto.TerminalResizeArgs{ID: "mp:" + testManualID, Cols: 110, Rows: 35}); e.T != "" {
		t.Fatalf("resize: %+v", e)
	}
	if e := r.command(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: "mp:" + testManualID, Direction: "up", Lines: 2}); e.T != "" {
		t.Fatalf("scroll: %+v", e)
	}
	if e := r.command(proto.CmdTerminalInput, proto.TerminalInputArgs{ID: "mp:" + testManualID, Text: &marker, Bytes: &bytesMarker}); e.Code != proto.ErrBadRequest {
		t.Fatalf("two payloads accepted: %+v", e)
	}
	large := strings.Repeat("x", (16<<10)+1)
	if e := r.command(proto.CmdTerminalInput, proto.TerminalInputArgs{ID: "mp:" + testManualID, Text: &large}); e.Code != proto.ErrBadRequest {
		t.Fatalf("oversized input accepted: %+v", e)
	}
	other, err := proto.Dial(r.ctx, filepath.Join(r.root, "bridge.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.CloseNow()
	if _, err = other.Hello(r.ctx, proto.Hello{Client: "not-owner"}); err != nil {
		t.Fatal(err)
	}
	otherRig := &manualRig{t: t, ctx: r.ctx, ws: other}
	otherRig.read()
	if e := otherRig.command(proto.CmdTerminalWatch, proto.TerminalWatchArgs{ID: "mp:mp_11111111"}); e.Code != proto.ErrCapacity {
		t.Fatalf("host cap: %+v", e)
	}
	if e := otherRig.command(proto.CmdTerminalInput, proto.TerminalInputArgs{ID: "mp:" + testManualID, Text: &marker}); e.Code != proto.ErrBadRequest {
		t.Fatalf("unowned input: %+v", e)
	}
	assertNoMarker(t, "unowned input response", marker, otherRig.wire.Bytes())
	if e := r.command(proto.CmdTerminalScroll, proto.TerminalScrollArgs{ID: "worker", Direction: "up", Lines: 1}); e.T != "" {
		t.Fatalf("agent control was lost: %+v", e)
	}
	select {
	case <-agent.commands:
	case <-time.After(time.Second):
		t.Fatal("agent scroll not delivered")
	}
	if e := r.command(proto.CmdWorkerKeys, proto.WorkerKeysArgs{ID: "mp:" + testManualID}); e.Code != proto.ErrBadRequest {
		t.Fatalf("worker.keys accepted manual id: %+v", e)
	}
	if e := r.command(proto.CmdTerminalUnwatch, proto.WorkerArgs{ID: "mp:" + testManualID}); e.T != "" {
		t.Fatalf("detach: %+v", e)
	}
	r.action(func() {
		if r.hub.manualProcesses[testManualID].State != "running" {
			t.Error("detach stopped process")
		}
	})
	select {
	case <-mp.done:
	case <-time.After(3 * time.Second):
		t.Fatal("manual controller did not detach")
	}
	mp2 := watch("mp:" + testManualID)
	r.action(func() {
		p := r.hub.manualProcesses[testManualID]
		p.State = "exited"
		p.PaneID = ""
		r.hub.manualProcesses[testManualID] = p
		r.hub.syncWatches()
	})
	for {
		e, b := r.read()
		if e.T == proto.TTerminalClosed {
			var closed proto.TerminalClosed
			_ = json.Unmarshal(b, &closed)
			if closed.ID == "mp:"+testManualID {
				if closed.Reason != "process_gone" {
					t.Fatalf("close reason %q", closed.Reason)
				}
				break
			}
		}
	}
	select {
	case <-mp2.done:
	case <-time.After(3 * time.Second):
		t.Fatal("closed pane controller did not exit")
	}
	r.action(func() {
		p := r.hub.manualProcesses[testManualID]
		p.State = "running"
		p.PaneID = "w1:p2"
		r.hub.manualProcesses[testManualID] = p
	})
	mp3 := watch("mp:" + testManualID)
	go func() {
		_, _ = io.WriteString(mp3.out, `{"type":"terminal.closed","reason":"terminal term_1 not found"}`+"\n")
	}()
	for {
		e, b := r.read()
		if e.T == proto.TTerminalClosed {
			var closed proto.TerminalClosed
			_ = json.Unmarshal(b, &closed)
			if closed.ID == "mp:"+testManualID {
				if closed.Reason != proto.ClosedProcessGone {
					t.Fatalf("pane disappearance: %+v", closed)
				}
				break
			}
		}
	}
	r.inspectProc(os.Getpid(), marker, string(bytesMarker))
	r.hygiene(marker, string(bytesMarker))
}
