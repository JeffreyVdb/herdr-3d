package server

import (
	"bufio"
	"encoding/json"
	"io"
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
	r.hygiene(marker)
}
