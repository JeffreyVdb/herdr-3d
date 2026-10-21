package herdr

import (
	"bufio"
	"context"
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
	// answer: herdr's full frame for each resize (#176 part 2).
	answer bool
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
		s.Buffer(nil, 1<<20) // herdr's own limit: a paste's line is longer than bufio's default
		for s.Scan() {
			f.mu.Lock()
			f.lines = append(f.lines, s.Text())
			answer := f.answer
			f.mu.Unlock()
			if answer && strings.Contains(s.Text(), `"terminal.resize"`) {
				_, _ = io.WriteString(outW, frameLine(len(f.lines), true, "again"))
			}
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

// #176 part 2: a paste is one bracketed terminal.input (markers and NUL in
// it removed, line ends as CR, the text as it is: no HTML escapes), a click
// is terminal.mouse down then up; both return once written, in order with
// the commands before them.
func TestControlTerminalPasteAndClick(t *testing.T) {
	fake := newFakeController(false)
	fake.answer = true
	c := &Control{Duplex: func([]string) (DuplexProc, error) { return fake, nil }}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer ct.Close()
	// The attach's first frame; the pump reads every frame after it.
	_ = fake.frame(frameLine(1, true, "hello"))
	fulls := make(chan struct{}, 16)
	go func() {
		for {
			f, err := ct.Next()
			if err != nil || f.Closed {
				return
			}
			if f.Full {
				fulls <- struct{}{}
			}
		}
	}()
	<-fulls
	start := time.Now()
	ctx := context.Background()
	if err := ct.Scroll(true, 2, 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if err := ct.Paste(ctx, "a<b>&\x00c\r\nd\ne\t✓\x1b[201~; rm -rf ~\x1b[20\x1b[200~0~x"); err != nil {
		t.Fatal(err)
	}
	if err := ct.Click(ctx, "left", 5, 2, 0); err != nil {
		t.Fatal(err)
	}
	if err := ct.Click(ctx, "middle", 79, 23, 7); err != nil {
		t.Fatal(err)
	}
	// Each returned once herdr's full frame for its resize came (not after appliedWait).
	if took := time.Since(start); took >= appliedWait {
		t.Fatalf("paste and clicks took %s: they did not see herdr's frames", took)
	}
	resize := `{"type":"terminal.resize","cols":80,"rows":24,"cell_width_px":0,"cell_height_px":0}`
	got := fake.waitLines(t, 9)
	want := []string{
		`{"type":"terminal.scroll","direction":"up","lines":2,"source":"wheel","column":0,"row":0,"modifiers":0}`,
		`{"type":"terminal.input","text":"\u001b[200~a<b>&c\rd\re\t✓; rm -rf ~x\u001b[201~"}`,
		resize,
		`{"type":"terminal.mouse","action":"down","button":"left","column":5,"row":2,"modifiers":0}`,
		`{"type":"terminal.mouse","action":"up","button":"left","column":5,"row":2,"modifiers":0}`,
		resize,
		`{"type":"terminal.mouse","action":"down","button":"middle","column":79,"row":23,"modifiers":7}`,
		`{"type":"terminal.mouse","action":"up","button":"middle","column":79,"row":23,"modifiers":7}`,
		resize,
	}
	if !slices.Equal(got, want) {
		t.Fatalf("stdin =\n%q\nwant\n%q", got, want)
	}
	// The resize that answers is the last size asked (its cell too).
	if err := ct.Resize(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	if err := ct.Click(ctx, "left", 0, 0, 0); err != nil {
		t.Fatal(err)
	}
	if got := fake.waitLines(t, 13)[12]; got != `{"type":"terminal.resize","cols":100,"rows":30,"cell_width_px":9,"cell_height_px":18}` {
		t.Fatalf("after a click: %s", got)
	}

	// The largest paste, all of it escaped by JSON, is one line under herdr's limit.
	worst := strings.Repeat("\x01", MaxMessage)
	if err := ct.Paste(ctx, worst); err != nil {
		t.Fatalf("a 16 KiB paste of control characters: %v", err)
	}
	if l := fake.waitLines(t, 14)[13]; len(l) < 6*MaxMessage || len(l)+1 > maxControlLine {
		t.Fatalf("worst paste line is %d bytes", len(l))
	}

	for name, call := range map[string]func() error{
		"too long":   func() error { return ct.Paste(ctx, strings.Repeat("x", MaxMessage+1)) },
		"not utf-8":  func() error { return ct.Paste(ctx, "\xff") },
		"button":     func() error { return ct.Click(ctx, "back", 0, 0, 0) },
		"no button":  func() error { return ct.Click(ctx, "", 0, 0, 0) },
		"column":     func() error { return ct.Click(ctx, "left", MaxCols, 0, 0) },
		"row":        func() error { return ct.Click(ctx, "left", 0, -1, 0) },
		"modifiers":  func() error { return ct.Click(ctx, "left", 0, 0, 8) },
		"negative m": func() error { return ct.Click(ctx, "left", 0, 0, -1) },
	} {
		if err := call(); !errors.Is(err, ErrNotAllowed) {
			t.Errorf("%s: err = %v, want ErrNotAllowed", name, err)
		}
	}
	if n := len(fake.written()); n != 15 {
		t.Fatalf("a refused command reached herdr: %d lines", n)
	}
	ct.Close()
	if err := ct.Paste(ctx, "x"); !errors.Is(err, ErrControlClosed) {
		t.Fatalf("a paste after close: %v", err)
	}
	if err := ct.Click(ctx, "left", 0, 0, 0); !errors.Is(err, ErrControlClosed) {
		t.Fatalf("a click after close: %v", err)
	}
}

func TestPasteClean(t *testing.T) {
	for in, want := range map[string]string{
		"":                                   "",
		"plain":                              "plain",
		"two\nlines\r\nthree\rfour":          "two\rlines\rthree\rfour",
		"\x00\x00":                           "",
		"\x1b[200~inner\x1b[201~":            "inner",
		"\x1b[20\x1b[201~0~":                 "", // removing one marker joins another
		"\x1b[2\x00\x00\x00\x0001~x":         "x",
		"keep \x1b[31mred\x1b[0m and \x1b[2": "keep \x1b[31mred\x1b[0m and \x1b[2",
		"\x1b[200\x1b[200~~":                 "", // ESC[200 + a marker + ~ is a marker again
	} {
		if got := PasteClean(in); got != want {
			t.Errorf("PasteClean(%q) = %q, want %q", in, got, want)
		}
		if got := PasteText(in); got != PasteStart+want+PasteEnd {
			t.Errorf("PasteText(%q) = %q", in, got)
		}
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

// #176 part 2: a paste or a click in a full queue makes room as the reset to
// the live bottom does (the wheels before it are moot: herdr resets the view
// before input), and waits until it is written; one dropped at Close says so.
func TestControlTerminalInputInAFullQueue(t *testing.T) {
	appliedWait = 10 * time.Millisecond // no frames here
	t.Cleanup(func() { appliedWait = 2 * time.Second })
	t.Run("makes room", func(t *testing.T) {
		p, ct := stalled(t, controlQueue)
		done := make(chan error, 1)
		go func() { done <- ct.Paste(context.Background(), "hi") }()
		select {
		case err := <-done:
			t.Fatalf("the paste returned before it was written: %v", err)
		case <-time.After(50 * time.Millisecond):
		}
		p.release()
		if err := <-done; err != nil {
			t.Fatalf("Paste in a full queue: %v", err)
		}
		if err := ct.Click(context.Background(), "left", 1, 1, 0); err != nil {
			t.Fatal(err)
		}
		ct.Close()
		got := strings.Split(strings.Join(p.written(), "\n"), "\n") // (this fake keeps writes: a paste's is two lines)
		if len(got) != 7 || got[0] != fmt.Sprintf(scrollLine, 0) || !strings.Contains(got[1], `\u001b[200~hi\u001b[201~`) ||
			!strings.Contains(got[2], `"terminal.resize"`) || !strings.Contains(got[3], `"action":"down"`) || got[6] != releaseLine {
			t.Fatalf("stdin = %q", got)
		}
	})
	t.Run("dropped at close", func(t *testing.T) {
		p, ct := stalled(t, 0)
		done := make(chan error, 1)
		go func() { done <- ct.Paste(context.Background(), "late") }()
		k := ct.(*controller)
		queued := func() int {
			k.mu.Lock()
			defer k.mu.Unlock()
			return len(k.queue)
		}
		for queued() == 0 {
			time.Sleep(time.Millisecond)
		}
		for i := range controlQueue - 1 { // the paste is the oldest queued
			if err := ct.Scroll(true, 1, i, 0, 0); err != nil {
				t.Fatal(err)
			}
		}
		time.AfterFunc(20*time.Millisecond, p.release)
		ct.Close()
		if err := <-done; !errors.Is(err, ErrControlClosed) {
			t.Fatalf("a paste dropped at close: %v", err)
		}
		for _, l := range p.written() {
			if strings.Contains(l, "late") {
				t.Fatalf("the dropped paste reached herdr: %s", l)
			}
		}
	})
}

// A paste or a click whose wait fails while it is still queued is taken out
// of the queue and says it was not written: it never reaches herdr later,
// behind what came after it.
func TestControlTerminalInputGivenUpIsNotWritten(t *testing.T) {
	appliedWait = 10 * time.Millisecond // no frames here
	t.Cleanup(func() { appliedWait = 2 * time.Second })
	for name, call := range map[string]func(t *testing.T, ct ControlStream) error{
		"write timeout": func(t *testing.T, ct ControlStream) error {
			writeWait = 30 * time.Millisecond
			t.Cleanup(func() { writeWait = 5 * time.Second })
			return ct.Paste(context.Background(), "LATE_PASTE")
		},
		"cancelled": func(_ *testing.T, ct ControlStream) error {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
			defer cancel()
			return ct.Click(ctx, "left", 7, 7, 0)
		},
	} {
		t.Run(name, func(t *testing.T) {
			p, ct := stalled(t, 2)
			if err := call(t, ct); !errors.Is(err, ErrInputUnsent) {
				t.Fatalf("err = %v, want ErrInputUnsent", err)
			}
			k := ct.(*controller)
			k.mu.Lock()
			queued := len(k.queue)
			k.mu.Unlock()
			if queued != 2 {
				t.Fatalf("%d commands queued, want the two scrolls", queued)
			}
			p.release()
			if err := ct.Paste(context.Background(), "NEXT"); err != nil {
				t.Fatal(err)
			}
			ct.Close()
			got := strings.Join(p.written(), "\n")
			if strings.Contains(got, "LATE_PASTE") || strings.Contains(got, `"column":7`) {
				t.Fatalf("the input given up reached herdr:\n%s", got)
			}
			if !strings.Contains(got, "NEXT") {
				t.Fatalf("the next paste is missing:\n%s", got)
			}
		})
	}
}

// Once the writer took a paste, a timeout or a cancel does not give up on
// it: it may still land, so Paste waits for the write, and says so.
func TestControlTerminalInputBeingWrittenIsWaitedFor(t *testing.T) {
	appliedWait = 10 * time.Millisecond
	writeWait = 20 * time.Millisecond
	t.Cleanup(func() { appliedWait, writeWait = 2*time.Second, 5*time.Second })
	p := newStalledController() // its first write (the paste) stalls
	c := &Control{Duplex: func([]string) (DuplexProc, error) { return p, nil }}
	ct, err := c.ControlTerminal(context.Background(), "h3d-it-1", "w1:p1", 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ct.Paste(ctx, "IN_FLIGHT") }()
	<-p.entered
	select {
	case err := <-done:
		t.Fatalf("Paste returned while its line was being written: %v", err)
	case <-time.After(100 * time.Millisecond): // past writeWait and the cancel
	}
	p.release()
	if err := <-done; err != nil {
		t.Fatalf("a paste written after its wait ran out: %v", err)
	}
	ct.Close()
	if n := strings.Count(strings.Join(p.written(), "\n"), "IN_FLIGHT"); n != 1 {
		t.Fatalf("the paste was written %d times", n)
	}
}

// The same-size resize that follows a paste is the size current when the
// paste is queued: a Resize at the same time is either before the paste
// (and the paste's resize is its size) or after it, never undone.
func TestControlTerminalBarrierKeepsTheLatestSize(t *testing.T) {
	sizes := regexp.MustCompile(`"cols":(\d+),"rows":(\d+)`)
	text := strings.Repeat("x", MaxMessage) // long to encode: the window a race needs
	for i := range 2000 {
		ct := &controller{size: [4]int{120, 40, 0, 0}}
		ct.more = sync.NewCond(&ct.mu)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { _ = ct.Paste(ctx, text); close(done) }()
		runtime.Gosched()
		if err := ct.Resize(150, 45, 0, 0); err != nil {
			t.Fatal(err)
		}
		for {
			ct.mu.Lock()
			n := len(ct.queue)
			ct.mu.Unlock()
			if n == 2 {
				break
			}
			runtime.Gosched()
		}
		ct.mu.Lock()
		last := ct.queue[len(ct.queue)-1]
		size := ct.size
		ct.mu.Unlock()
		m := sizes.FindAllStringSubmatch(string(last.line), -1)
		if got := m[len(m)-1][1] + "x" + m[len(m)-1][2]; got != fmt.Sprintf("%dx%d", size[0], size[1]) {
			t.Fatalf("iteration %d: the last resize queued is %s, the size asked last %dx%d", i, got, size[0], size[1])
		}
		cancel()
		<-done
	}
}
