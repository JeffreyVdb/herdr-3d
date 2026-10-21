package server

import (
	"context"
	"encoding/json"
	"io"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// stalledStdin is a controller process whose stdin stops reading at the
// first command until it is let go: the commands after it wait in the
// controller's queue, as with a herdr that is busy.
type stalledStdin struct {
	entered, unblock, done chan struct{}
	once, letGo, exited    sync.Once

	mu    sync.Mutex
	lines []string
}

func (p *stalledStdin) Write(b []byte) (int, error) {
	p.once.Do(func() { close(p.entered); <-p.unblock })
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lines = append(p.lines, strings.TrimSuffix(string(b), "\n"))
	return len(b), nil
}
func (p *stalledStdin) Close() error {
	p.exited.Do(func() { close(p.done) })
	return nil
}
func (p *stalledStdin) Stdout() io.Reader     { return strings.NewReader("") }
func (p *stalledStdin) Stdin() io.WriteCloser { return p }
func (p *stalledStdin) Done() <-chan struct{} { return p.done }
func (p *stalledStdin) Stop() error           { p.release(); return p.Close() }
func (p *stalledStdin) release()              { p.letGo.Do(func() { close(p.unblock) }) }
func (p *stalledStdin) written() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.lines)
}

// stalledWatch is a hub with a control watch of worker w1, 10 lines up the
// history, whose controller (the real one) has a full queue of wheels.
func stalledWatch(t *testing.T) (*Hub, *watch, *stalledStdin, herdr.ControlStream) {
	t.Helper()
	p := &stalledStdin{entered: make(chan struct{}), unblock: make(chan struct{}), done: make(chan struct{})}
	ctl := &herdr.Control{Duplex: func([]string) (herdr.DuplexProc, error) { return p, nil }}
	cs, err := ctl.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { p.release(); cs.Close() })
	if err := cs.Scroll(true, 1, 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	<-p.entered
	for range 64 {
		if err := cs.Scroll(true, 1, 0, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := cs.Scroll(true, 1, 0, 0, 0); err == nil {
		t.Fatal("the controller's queue is not full")
	}
	c := &Client{send: make(chan []byte, 128)}
	w := &watch{c: c, id: "w1", pane: "w1:p1", control: true, ctl: ctlWatch{mode: proto.ControlOwned, stream: cs,
		hist: herdr.PaneScroll{Offset: 10, Max: 90, ViewportRows: 40}, histSent: true, poke: make(chan struct{}, 1)}}
	h := &Hub{lanes: map[string]*inputLane{"w1": {running: true}}}
	h.term.byC = map[*Client]map[string]*watch{c: {"w1": w}}
	return h, w, p, cs
}

// historySent is the terminal.history messages queued to the connection.
func historySent(c *Client) []proto.TerminalHistory {
	var out []proto.TerminalHistory
	for {
		select {
		case b := <-c.send:
			var m proto.TerminalHistory
			if json.Unmarshal(b, &m) == nil && m.T == proto.TTerminalHistory {
				out = append(out, m)
			}
		default:
			return out
		}
	}
}

// Input to a worker whose controlled view is up the history brings it back
// to the live bottom first, even when the controller's queue is full of
// wheels: the reset supersedes them, reaches herdr after the wheel herdr
// was reading, and only then is the view said to be live.
func TestInputResetsAFullControllerQueue(t *testing.T) {
	h, w, p, cs := stalledWatch(t)
	ran := false
	h.queueLane(context.Background(), "w1", func(context.Context) {
		h.term.mu.Lock()
		defer h.term.mu.Unlock()
		ran = w.ctl.hist.Offset == 0
	})
	h.lanes["w1"].jobs[0](context.Background())
	if !ran {
		t.Fatal("the input ran before the view was said to be live")
	}
	if got := historySent(w.c); len(got) != 1 || got[0].Offset != 0 {
		t.Fatalf("terminal.history = %+v, want offset 0", got)
	}
	p.release()
	cs.Close()
	got := p.written()
	if live := slices.Index(got, `{"type":"terminal.input"}`); live != 1 || len(got) != 3 || got[2] != `{"type":"terminal.release"}` {
		t.Fatalf("stdin = %q, want the wheel herdr was reading, the reset, the release", got)
	}
}

// A reset that could not be queued (the controller is closing) leaves the
// view where it was: nothing says it is live.
func TestInputWithoutAResetKeepsTheOffset(t *testing.T) {
	h, w, p, cs := stalledWatch(t)
	p.release()
	cs.Close()
	ran := false
	h.queueLane(context.Background(), "w1", func(context.Context) { ran = true })
	h.lanes["w1"].jobs[0](context.Background())
	if !ran {
		t.Fatal("the input did not run")
	}
	h.term.mu.Lock()
	offset, sent := w.ctl.hist.Offset, w.ctl.histSent
	h.term.mu.Unlock()
	if offset != 10 || !sent {
		t.Fatalf("offset %d (sent %v), want 10 as it was", offset, sent)
	}
	if got := historySent(w.c); len(got) != 0 {
		t.Fatalf("terminal.history = %+v, want none", got)
	}
}
