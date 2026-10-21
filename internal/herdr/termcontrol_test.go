package herdr

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
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

func (f *fakeController) Stdout() io.Reader       { return f.out }
func (f *fakeController) Stdin() io.WriteCloser   { return f.in }
func (f *fakeController) Done() <-chan struct{}   { return f.done }
func (f *fakeController) written() []string       { f.mu.Lock(); defer f.mu.Unlock(); return slices.Clone(f.lines) }
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
		"narrow":       func() error { return ct.Resize(39, 40, 0, 0) },
		"wide":         func() error { return ct.Resize(301, 40, 0, 0) },
		"short":        func() error { return ct.Resize(80, 9, 0, 0) },
		"tall":         func() error { return ct.Resize(80, 101, 0, 0) },
		"cell":         func() error { return ct.Resize(80, 24, MaxCellPx+1, 10) },
		"neg cell":     func() error { return ct.Resize(80, 24, -1, 10) },
		"no lines":     func() error { return ct.Scroll(true, 0, 0, 0, 0) },
		"many lines":   func() error { return ct.Scroll(true, MaxScrollLines+1, 0, 0, 0) },
		"column":       func() error { return ct.Scroll(true, 1, MaxCols, 0, 0) },
		"row":          func() error { return ct.Scroll(true, 1, 0, -1, 0) },
		"modifiers":    func() error { return ct.Scroll(true, 1, 0, 0, 8) },
		"huge command": func() error { return ct.(*controller).send(map[string]string{"text": strings.Repeat("x", maxControlLine)}) },
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
