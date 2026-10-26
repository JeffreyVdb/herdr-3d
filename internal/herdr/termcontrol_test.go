package herdr

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeController is a herdr controller: it records the lines written to its
// stdin and, like herdr, ends its stream with terminal.closed "detached"
// and exits once it reads terminal.release (unless stubborn).
type fakeController struct {
	out      *os.File
	outW     *os.File
	in       *io.PipeWriter
	done     chan struct{}
	stopped  chan struct{}
	stubborn bool

	mu    sync.Mutex
	lines []string
	once  sync.Once
	stops int
}

func newFakeController(stubborn bool) *fakeController {
	out, outW, err := os.Pipe() // buffered, like a real one
	if err != nil {
		panic(err)
	}
	inR, inW := io.Pipe()
	f := &fakeController{out: out, outW: outW, in: inW, done: make(chan struct{}), stopped: make(chan struct{}), stubborn: stubborn}
	go func() {
		s := bufio.NewScanner(inR)
		for s.Scan() {
			f.mu.Lock()
			f.lines = append(f.lines, s.Text())
			f.mu.Unlock()
			if !stubborn && strings.Contains(s.Text(), `"terminal.release"`) {
				_, _ = io.WriteString(outW, `{"type":"terminal.closed","reason":"detached"}`+"\n")
				f.exit()
			}
		}
	}()
	return f
}

func (f *fakeController) exit() {
	f.once.Do(func() {
		f.outW.Close()
		close(f.done)
	})
}

func (f *fakeController) Stdout() io.Reader     { return f.out }
func (f *fakeController) Stdin() io.WriteCloser { return f.in }
func (f *fakeController) Done() <-chan struct{} { return f.done }
func (f *fakeController) written() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.lines)
}
func (f *fakeController) frame(line string) error { _, err := io.WriteString(f.outW, line); return err }
func (f *fakeController) Stop() error {
	f.mu.Lock()
	f.stops++
	f.mu.Unlock()
	f.exit()
	return nil
}

// waitLines waits until the controller read n lines.
func (f *fakeController) waitLines(t *testing.T, n int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if got := f.written(); len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("controller read %q, want %d lines", f.written(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestControlTerminalCommands(t *testing.T) {
	fake := newFakeController(false)
	var argv []string
	c := &Control{Duplex: func(a []string) (DuplexProc, error) { argv = a; return fake, nil }}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 132, 41)
	if err != nil {
		t.Fatal(err)
	}
	// The argv: control, never --takeover.
	if !slices.Equal(argv, []string{"herdr", "--session", "h3d-it-1", "terminal", "session", "control", "w1:p1",
		"--cols", "132", "--rows", "41"}) {
		t.Fatalf("argv = %q", argv)
	}
	go func() { _ = fake.frame(frameLine(1, true, "hello")) }()
	if f, err := ct.Next(); err != nil || !f.Full || string(f.Data) != "hello" {
		t.Fatalf("frame = %+v, %v", f, err)
	}
	for _, call := range []func() error{
		func() error { return ct.Resize(150, 45, 9, 18) },
		func() error { return ct.Scroll(true, 3, 10, 5, 0) },
		func() error { return ct.Scroll(false, 1000, 299, 99, 7) },
		ct.Live,
	} {
		if err := call(); err != nil {
			t.Fatal(err)
		}
	}
	got := fake.waitLines(t, 4)
	want := []string{
		`{"type":"terminal.resize","cols":150,"rows":45,"cell_width_px":9,"cell_height_px":18}`,
		`{"type":"terminal.scroll","direction":"up","lines":3,"source":"wheel","column":10,"row":5,"modifiers":0}`,
		`{"type":"terminal.scroll","direction":"down","lines":1000,"source":"wheel","column":299,"row":99,"modifiers":7}`,
		`{"type":"terminal.input"}`,
	}
	if !slices.Equal(got, want) {
		t.Fatalf("stdin = %q\nwant %q", got, want)
	}

	// Out of bounds: refused before anything is written.
	for name, call := range map[string]func() error{
		"narrow":     func() error { return ct.Resize(39, 40, 0, 0) },
		"wide":       func() error { return ct.Resize(301, 40, 0, 0) },
		"short":      func() error { return ct.Resize(80, 9, 0, 0) },
		"tall":       func() error { return ct.Resize(80, 101, 0, 0) },
		"cell":       func() error { return ct.Resize(80, 24, MaxCellPx+1, 10) },
		"neg cell":   func() error { return ct.Resize(80, 24, -1, 10) },
		"no lines":   func() error { return ct.Scroll(true, 0, 0, 0, 0) },
		"many lines": func() error { return ct.Scroll(true, MaxScrollLines+1, 0, 0, 0) },
		"column":     func() error { return ct.Scroll(true, 1, MaxCols, 0, 0) },
		"row":        func() error { return ct.Scroll(true, 1, 0, -1, 0) },
		"modifiers":  func() error { return ct.Scroll(true, 1, 0, 0, 8) },
		"huge command": func() error {
			return ct.(*controller).send(kindLive, map[string]string{"text": strings.Repeat("x", maxControlLine)})
		},
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if n := len(fake.written()); n != 4 {
		t.Fatalf("a refused command reached herdr: %q", fake.written())
	}

	// Close: the restore size, then the release; herdr ends the stream and the
	// controller exits on its own (no stop needed, so it is quick).
	ct.RestoreOnRelease(120, 40)
	start := time.Now()
	if err := ct.Close(); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(start); took >= ReleaseGrace {
		t.Fatalf("a released controller took %s to close", took)
	}
	got = fake.waitLines(t, 6)
	if want := []string{`{"type":"terminal.resize","cols":120,"rows":40,"cell_width_px":0,"cell_height_px":0}`, `{"type":"terminal.release"}`}; !slices.Equal(got[4:], want) {
		t.Fatalf("on close: %q, want %q", got[4:], want)
	}
	if f, err := ct.Next(); err != nil || !f.Closed || f.Reason != "detached" {
		t.Fatalf("after release: %+v, %v", f, err)
	}
	if err := ct.Close(); err != nil { // twice is fine
		t.Fatal(err)
	}
	if err := ct.Live(); !errors.Is(err, ErrControlClosed) {
		t.Fatalf("a command after close: %v", err)
	}
}

// A controller that does not exit after the release is stopped once
// ReleaseGrace is over.
func TestControlTerminalStopsAStubbornController(t *testing.T) {
	fake := newFakeController(true)
	c := &Control{Duplex: func([]string) (DuplexProc, error) { return fake, nil }}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	ct.Close()
	if took := time.Since(start); took < ReleaseGrace || took > ReleaseGrace+time.Second {
		t.Fatalf("Close took %s, want about %s", took, ReleaseGrace)
	}
	if got := fake.waitLines(t, 1); !slices.Equal(got, []string{`{"type":"terminal.release"}`}) {
		t.Fatalf("stdin = %q", got)
	}
	if fake.stops != 1 {
		t.Fatalf("stopped %d times", fake.stops)
	}
}

func TestControlTerminalRefusesBadInputBeforeRunning(t *testing.T) {
	ran := false
	c := &Control{Only: regexp.MustCompile(`^h3d-it-`), Duplex: func([]string) (DuplexProc, error) { ran = true; return newFakeController(false), nil }}
	for name, args := range map[string]struct {
		session, pane string
		cols, rows    int
	}{
		"unwatched": {"herdr-3d", "w1:p1", 80, 24},
		"bad pane":  {"h3d-it-1", "w1:p1 --takeover", 80, 24},
		"narrow":    {"h3d-it-1", "w1:p1", 39, 24},
		"tall":      {"h3d-it-1", "w1:p1", 80, 101},
	} {
		if _, err := c.ControlTerminal(context.Background(), args.session, args.pane, args.cols, args.rows); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	if ran {
		t.Fatal("a refused controller was started")
	}
}

func TestControlRefusalReasons(t *testing.T) {
	refused := "terminal attach failed: terminal term_3 already has an attached client; retry with --takeover"
	if !ControlRefused(refused) || ControlTakenOver(refused) {
		t.Fatalf("refusal %q", refused)
	}
	if !ControlTakenOver("terminal attach taken over") || ControlRefused("terminal attach taken over") {
		t.Fatal("takeover")
	}
	for _, other := range []string{"detached", "live update in progress; reconnect after handoff completes", "terminal attach ended: terminal term_1 not found", ""} {
		if ControlRefused(other) || ControlTakenOver(other) {
			t.Errorf("%q is neither", other)
		}
	}
}

// The default duplex streamer: a real process reads the commands on its
// stdin, and a release makes it exit by itself.
func TestControlTerminalExec(t *testing.T) {
	dir := t.TempDir()
	got := filepath.Join(dir, "stdin")
	fake := filepath.Join(dir, "herdr")
	script := "#!/bin/sh\nprintf '%s\\n' '" + strings.TrimSpace(frameLine(1, true, "hi")) + "'\n" +
		"while IFS= read -r line; do printf '%s\\n' \"$line\" >> " + got + "\n" +
		"case \"$line\" in *terminal.release*) printf '%s\\n' '{\"type\":\"terminal.closed\",\"reason\":\"detached\"}'; exit 0;; esac\ndone\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	c := &Control{Herdr: fake}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-x", "w1:p1", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if f, err := ct.Next(); err != nil || string(f.Data) != "hi" {
		t.Fatalf("frame = %+v, %v", f, err)
	}
	if err := ct.Resize(100, 30, 0, 0); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	ct.Close()
	if took := time.Since(start); took >= ReleaseGrace {
		t.Fatalf("Close took %s: the controller did not exit on the release", took)
	}
	b, _ := os.ReadFile(got)
	if want := `{"type":"terminal.resize","cols":100,"rows":30,"cell_width_px":0,"cell_height_px":0}` + "\n" + `{"type":"terminal.release"}` + "\n"; string(b) != want {
		t.Fatalf("stdin = %q, want %q", b, want)
	}
}

// stalledController is a controller whose stdin stops reading at the first
// command until it is let go (or stopped): the commands after it wait in the
// queue, as with a herdr that is busy.
type stalledController struct {
	entered, unblock, done chan struct{}
	once, letGo, exited    sync.Once

	mu    sync.Mutex
	lines []string
	stops int
}

func newStalledController() *stalledController {
	return &stalledController{entered: make(chan struct{}), unblock: make(chan struct{}), done: make(chan struct{})}
}

func (p *stalledController) Write(b []byte) (int, error) {
	p.once.Do(func() { close(p.entered); <-p.unblock })
	select {
	case <-p.done:
		return 0, io.ErrClosedPipe
	default:
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lines = append(p.lines, strings.TrimSuffix(string(b), "\n"))
	return len(b), nil
}
func (p *stalledController) Close() error          { return nil }
func (p *stalledController) Stdout() io.Reader     { return strings.NewReader("") }
func (p *stalledController) Stdin() io.WriteCloser { return p }
func (p *stalledController) Done() <-chan struct{} { return p.done }
func (p *stalledController) release()              { p.letGo.Do(func() { close(p.unblock) }) }
func (p *stalledController) Stop() error {
	p.mu.Lock()
	p.stops++
	p.mu.Unlock()
	p.exited.Do(func() { close(p.done) })
	p.release()
	return nil
}
func (p *stalledController) written() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.lines)
}

// stalled starts a controller on a stalled stdin with its first command (a
// scroll) taken and n more scrolls queued.
func stalled(t *testing.T, n int) (*stalledController, ControlStream) {
	t.Helper()
	p := newStalledController()
	c := &Control{Duplex: func([]string) (DuplexProc, error) { return p, nil }}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	if err := ct.Scroll(true, 1, 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	<-p.entered
	for i := range n {
		if err := ct.Scroll(true, 1, i, 0, 0); err != nil {
			t.Fatalf("scroll %d: %v", i, err)
		}
	}
	return p, ct
}

const (
	scrollLine  = `{"type":"terminal.scroll","direction":"up","lines":1,"source":"wheel","column":%d,"row":0,"modifiers":0}`
	restoreLine = `{"type":"terminal.resize","cols":80,"rows":24,"cell_width_px":0,"cell_height_px":0}`
	releaseLine = `{"type":"terminal.release"}`
	liveLine    = `{"type":"terminal.input"}`
)

// Close delivers the restore size and then the release even when the queue
// is full (herdr stalled for a moment): what was queued before them is moot
// once the pane is released, and nothing is written after the release.
func TestControlTerminalCloseThroughAFullQueue(t *testing.T) {
	p, ct := stalled(t, controlQueue)
	if err := ct.Scroll(true, 1, 0, 0, 0); err == nil {
		t.Fatal("a full queue took another scroll")
	}
	ct.RestoreOnRelease(80, 24)
	time.AfterFunc(20*time.Millisecond, p.release)
	if err := ct.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got := p.written()
	if len(got) < 3 || !slices.Equal(got[len(got)-2:], []string{restoreLine, releaseLine}) {
		t.Fatalf("stdin ends %q, want the restore then the release", got[max(0, len(got)-3):])
	}
	for _, l := range got[:len(got)-2] {
		if !strings.Contains(l, `"terminal.scroll"`) {
			t.Fatalf("before the restore: %s", l)
		}
	}
}

// A controller whose stdin never reads again is stopped after ReleaseGrace,
// and Close says the release did not reach it.
func TestControlTerminalCloseOfAWedgedController(t *testing.T) {
	p, ct := stalled(t, controlQueue)
	ct.RestoreOnRelease(80, 24)
	start := time.Now()
	err := ct.Close()
	if took := time.Since(start); took < ReleaseGrace || took > ReleaseGrace+time.Second {
		t.Fatalf("Close took %s, want about %s", took, ReleaseGrace)
	}
	if err == nil {
		t.Fatal("Close of a controller that never read its release: no error")
	}
	if p.stops != 1 {
		t.Fatalf("stopped %d times", p.stops)
	}
	if got := p.written(); len(got) != 0 {
		t.Fatalf("written after the stop: %q", got)
	}
}

// A full queue makes room for what supersedes queued commands: the reset to
// the live bottom drops the wheels before it (and all but the last size), a
// size drops the sizes before it. A wheel never drops anything.
func TestControlTerminalSupersedesInAFullQueue(t *testing.T) {
	t.Run("live", func(t *testing.T) {
		p, ct := stalled(t, controlQueue-2)
		for _, call := range []func() error{
			func() error { return ct.Resize(100, 30, 0, 0) },
			func() error { return ct.Resize(110, 35, 0, 0) },
		} {
			if err := call(); err != nil {
				t.Fatal(err)
			}
		}
		if err := ct.Live(); err != nil {
			t.Fatalf("Live in a full queue: %v", err)
		}
		if err := ct.Scroll(true, 1, 7, 0, 0); err != nil {
			t.Fatalf("a scroll after the room made: %v", err)
		}
		p.release()
		ct.Close()
		want := []string{fmt.Sprintf(scrollLine, 0), `{"type":"terminal.resize","cols":110,"rows":35,"cell_width_px":0,"cell_height_px":0}`,
			liveLine, fmt.Sprintf(scrollLine, 7), releaseLine}
		if got := p.written(); !slices.Equal(got, want) {
			t.Fatalf("stdin = %q\nwant %q", got, want)
		}
	})
	t.Run("resize", func(t *testing.T) {
		p, ct := stalled(t, controlQueue-2)
		if err := ct.Resize(100, 30, 0, 0); err != nil {
			t.Fatal(err)
		}
		if err := ct.Live(); err != nil {
			t.Fatal(err)
		}
		if err := ct.Resize(110, 35, 0, 0); err != nil {
			t.Fatalf("Resize in a full queue: %v", err)
		}
		// herdr reads again only once Close has made room for the release
		// (the oldest wheel), or the count would depend on who goes first.
		time.AfterFunc(20*time.Millisecond, p.release)
		ct.Close()
		got := p.written()
		if n := len(got); n != controlQueue+1 || got[n-3] != liveLine || !strings.Contains(got[n-2], `"cols":110`) || got[n-1] != releaseLine {
			t.Fatalf("stdin (%d lines) ends %q", n, got[max(0, n-4):])
		}
		for _, l := range got {
			if strings.Contains(l, `"cols":100`) {
				t.Fatalf("a superseded size reached herdr: %s", l)
			}
		}
	})
	t.Run("scrolls only", func(t *testing.T) {
		p, ct := stalled(t, controlQueue)
		if err := ct.Resize(110, 35, 0, 0); err == nil {
			t.Fatal("a size took the place of a wheel")
		}
		p.release()
		ct.Close()
	})
}

// busyController is a stalledController that yields before every write, as
// a herdr that reads again while commands are sent, and exits once it has
// read the release (so Close does not wait out the grace). With an rng (the
// writer's own), it also pauses now and then, so the queue fills and drains.
type busyController struct {
	*stalledController
	rng *rand.Rand
}

func newBusyController(rng *rand.Rand) *busyController {
	return &busyController{newStalledController(), rng}
}

func (p *busyController) Stdin() io.WriteCloser { return p }
func (p *busyController) Write(b []byte) (int, error) {
	runtime.Gosched()
	if p.rng != nil && p.rng.IntN(16) == 0 {
		time.Sleep(time.Duration(p.rng.IntN(200)) * time.Microsecond)
	}
	n, err := p.stalledController.Write(b)
	if strings.Contains(string(b), `"terminal.release"`) {
		p.exited.Do(func() { close(p.done) })
	}
	return n, err
}

func controlOn(t *testing.T, p DuplexProc) ControlStream {
	t.Helper()
	c := &Control{Duplex: func([]string) (DuplexProc, error) { return p, nil }}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	return ct
}

// A size that supersedes in a full queue while herdr reads again keeps the
// order of what it keeps: no wheel queued before the reset to the live
// bottom reaches herdr after it (the wheels would scroll the view back up).
func TestControlTerminalSupersedeKeepsTheOrder(t *testing.T) {
	for trial := range 10000 {
		p := newBusyController(nil)
		ct := controlOn(t, p)
		if err := ct.Scroll(true, 1, 0, 0, 0); err != nil {
			t.Fatal(err)
		}
		<-p.entered
		for i := range controlQueue - 2 {
			if err := ct.Scroll(true, 1, i, 0, 0); err != nil {
				t.Fatal(err)
			}
		}
		if err := ct.Resize(100, 30, 0, 0); err != nil {
			t.Fatal(err)
		}
		if err := ct.Live(); err != nil {
			t.Fatal(err)
		}
		p.release()
		if err := ct.Resize(110, 35, 0, 0); err != nil {
			t.Fatalf("trial %d: Resize in a full queue: %v", trial, err)
		}
		ct.Close()
		got := p.written()
		live := slices.Index(got, liveLine)
		if live < 0 {
			t.Fatalf("trial %d: the reset never reached herdr: %q", trial, got)
		}
		if want := []string{`{"type":"terminal.resize","cols":110,"rows":35,"cell_width_px":0,"cell_height_px":0}`, releaseLine}; !slices.Equal(got[live+1:], want) {
			t.Fatalf("trial %d: after the reset %d lines, the first %s; want %q", trial, len(got)-live-1, got[min(live+1, len(got)-1)], want)
		}
	}
}

// The queue's order over many interleavings: one sender queues wheels, sizes
// and resets while herdr reads at an uneven pace, then closes. What reaches
// herdr is the accepted commands in the order they were sent, less the ones
// superseded: (a) a subsequence of that order, so (b) nothing queued before a
// reset is written after it; (c) the restore and the release come last.
func TestControlTerminalQueueOrderProperty(t *testing.T) {
	refused, dropped := 0, 0
	for seed := range 300 {
		rng := rand.New(rand.NewPCG(uint64(seed), 1))
		p := newBusyController(rand.New(rand.NewPCG(uint64(seed), 2)))
		p.release()
		ct := controlOn(t, p)
		var accepted []string // the lines, in the order they were queued
		for k := range 400 {
			var err error
			var line string
			switch r := rng.IntN(20); {
			case r < 12: // a wheel, told apart by its cell
				err = ct.Scroll(true, 1, k%MaxCols, k/MaxCols, 0)
				line = fmt.Sprintf(`{"type":"terminal.scroll","direction":"up","lines":1,"source":"wheel","column":%d,"row":%d,"modifiers":0}`, k%MaxCols, k/MaxCols)
			case r < 16: // a size (never the restore's 80×24)
				err = ct.Resize(200+k%100, MinRows+k/100, 0, 0)
				line = fmt.Sprintf(`{"type":"terminal.resize","cols":%d,"rows":%d,"cell_width_px":0,"cell_height_px":0}`, 200+k%100, MinRows+k/100)
			case r < 19: // a reset, told apart by a seq herdr ignores
				err = ct.(*controller).send(kindLive, struct {
					Type string `json:"type"`
					Seq  int    `json:"seq"`
				}{"terminal.input", k})
				line = fmt.Sprintf(`{"type":"terminal.input","seq":%d}`, k)
				if err != nil {
					t.Fatalf("seed %d: a reset was refused: %v", seed, err)
				}
			default:
				runtime.Gosched()
				continue
			}
			if err != nil {
				refused++
				continue
			}
			accepted = append(accepted, line)
		}
		ct.RestoreOnRelease(80, 24)
		if err := ct.Close(); err != nil {
			t.Fatalf("seed %d: Close: %v", seed, err)
		}
		got := p.written()
		n := len(got)
		if n < 2 || !slices.Equal(got[n-2:], []string{restoreLine, releaseLine}) {
			t.Fatalf("seed %d: stdin ends %q, want the restore then the release", seed, got[max(0, n-3):])
		}
		at := make(map[string]int, len(accepted))
		for i, l := range accepted {
			at[l] = i
		}
		last := -1
		for _, l := range got[:n-2] {
			i, ok := at[l]
			switch {
			case !ok:
				t.Fatalf("seed %d: %s reached herdr but was not queued before the close", seed, l)
			case i <= last && strings.Contains(accepted[last], `"terminal.input"`):
				t.Fatalf("seed %d: %s, queued before the reset %s, reached herdr after it", seed, l, accepted[last])
			case i <= last:
				t.Fatalf("seed %d: %s reached herdr after %s, queued later", seed, l, accepted[last])
			}
			last = i
		}
		dropped += len(accepted) - (n - 2)
	}
	if refused == 0 || dropped == 0 {
		t.Fatalf("the queue never filled (%d wheels refused, %d commands superseded): the test proves nothing", refused, dropped)
	}
	t.Logf("%d commands refused, %d superseded", refused, dropped)
}

func TestControllerInputChunks(t *testing.T) {
	f := newFakeController(false)
	ct := controlOn(t, f)
	text := strings.Repeat("\x00é", 6000)
	if err := ct.Input(text); err != nil {
		t.Fatal(err)
	}
	b := bytes.Repeat([]byte{0, 255, 42}, 9000)
	if err := ct.InputBytes(b); err != nil {
		t.Fatal(err)
	}
	if err := ct.Close(); err != nil {
		t.Fatal(err)
	}
	var got string
	var raw []byte
	for _, line := range f.written() {
		if len(line)+1 > maxControlLine {
			t.Fatal("oversized line")
		}
		var v struct {
			Type  string `json:"type"`
			Text  string `json:"text"`
			Bytes []byte `json:"bytes"`
		}
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatal(err)
		}
		got += v.Text
		raw = append(raw, v.Bytes...)
	}
	if got != text || !slices.Equal(raw, b) {
		t.Fatal("input changed in transit")
	}
}

func TestControllerInputSurvivesSupersedeAndClose(t *testing.T) {
	p, ct := stalled(t, controlQueue-2)
	if err := ct.Input("first"); err != nil {
		t.Fatal(err)
	}
	if err := ct.Input("second"); err != nil {
		t.Fatal(err)
	}
	if err := ct.Input("rejected"); err == nil {
		t.Fatal("full queue accepted input")
	}
	if err := ct.Live(); err != nil {
		t.Fatal(err)
	}
	p.release()
	if err := ct.Close(); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(p.written(), "\n")
	first, second := strings.Index(got, `"text":"first"`), strings.Index(got, `"text":"second"`)
	if first < 0 || second <= first || strings.Contains(got, "rejected") {
		t.Fatalf("input order: %s", got)
	}
}
