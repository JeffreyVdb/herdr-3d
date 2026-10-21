package herdr

// #176: the seated laptop's terminal controller. `terminal session control`
// attaches to a pane as its owner: the same NDJSON frames as an observer
// on stdout, and JSONL commands on stdin (resize the real PTY, scroll
// herdr's history, release). It is never started with --takeover: herdr
// refuses a second owner, and that refusal is the caller's read-only
// fallback (ControlRefused).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DuplexProc is a started long-running command with a stdin.
type DuplexProc interface {
	Proc
	// Stdin is the command's standard input; closing it is EOF.
	Stdin() io.WriteCloser
	// Done is closed once the command has exited and been reaped.
	Done() <-chan struct{}
}

// DuplexStreamer starts a long-running command with a stdin pipe.
type DuplexStreamer func(argv []string) (DuplexProc, error)

// Bounds of the controller's commands.
const (
	// maxControlLine bounds one JSONL command written to the controller's
	// stdin (herdr takes up to 1 MiB of input and closes the connection of
	// a client that sends more; the commands of #176 are a few dozen bytes,
	// and #176 part 2's bracketed paste stays under this too).
	maxControlLine = 64 << 10
	// controlQueue is how many commands may wait for the controller's
	// stdin; a full queue refuses the next one (the caller never blocks on
	// a wedged herdr).
	controlQueue = 64
	// MaxScrollLines bounds one terminal.scroll (herdr takes a u16).
	MaxScrollLines = 1000
	// MaxCellPx bounds a cell's size in pixels, as told to herdr with a resize.
	MaxCellPx = 256
	// ReleaseGrace is how long a released controller has to exit on its own
	// (herdr answers the release with terminal.closed "detached" and the CLI
	// exits) before it is stopped like an observer.
	ReleaseGrace = time.Second
)

// ErrControlClosed is returned by a command to a controller that was
// released or stopped.
var ErrControlClosed = errors.New("herdr: the terminal controller is closed")

// ControlRefused reports whether a controller's terminal.closed reason is
// herdr refusing it because another client owns the pane ("terminal <t>
// already has an attached client; retry with --takeover"): the pane can only
// be watched read only, and retrying would be refused again.
func ControlRefused(reason string) bool {
	return strings.Contains(reason, "already has an attached client")
}

// ControlTakenOver reports whether a controller's terminal.closed reason is
// another client taking the pane over with --takeover ("terminal attach taken
// over"): the pane is that client's now.
func ControlTakenOver(reason string) bool {
	return strings.Contains(reason, "taken over")
}

// ControlStream is a running controller: an observer's frames, and the
// commands only an owner may give.
type ControlStream interface {
	FrameStream
	// Resize sets the pane's real PTY to cols × rows (cellW × cellH: a
	// cell's size in pixels, 0 when unknown). herdr answers with a full
	// frame at the new size; the same size again asks for a full frame.
	Resize(cols, rows, cellW, cellH int) error
	// Scroll is a wheel of `lines` over cell (col, row) with modifier bits
	// mods (Shift 1, Ctrl 2, Alt 4: herdr's): herdr moves its history when
	// the application does not take the wheel itself.
	Scroll(up bool, lines, col, row, mods int) error
	// Live brings the view back to the live bottom of the history (an
	// empty terminal.input: herdr resets the scroll before any input).
	Live() error
	// RestoreOnRelease makes Close resize the PTY to cols × rows before it
	// releases the pane (0, 0: release only).
	RestoreOnRelease(cols, rows int)
}

// ControlTerminal starts a controller of a pane's terminal at cols × rows
// (`terminal session control`, never --takeover): the PTY is resized to
// that, and stays at its size against the herdr TUI's layout until the
// controller is released. Close releases it (terminal.release), waits up to
// ReleaseGrace for it to exit, then stops it.
func (c *Control) ControlTerminal(ctx context.Context, session, pane string, cols, rows int) (ControlStream, error) {
	argv, err := c.argv(opControl, map[string]string{"session": session, "pane": pane,
		"cols": strconv.Itoa(cols), "rows": strconv.Itoa(rows)})
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	start := c.Duplex
	if start == nil {
		start = execDuplex
	}
	p, err := start(argv)
	if err != nil {
		return nil, fmt.Errorf("herdr control %s: %w", opControl, err)
	}
	ct := &controller{observer: observer{p: p, r: bufio.NewReaderSize(p.Stdout(), 64<<10)}, p: p,
		queue: make(chan []byte, controlQueue), wrote: make(chan struct{})}
	go ct.write()
	return ct, nil
}

type controller struct {
	observer
	p DuplexProc

	mu      sync.Mutex
	closed  bool
	queue   chan []byte   // the commands for stdin, in order (closed by Close)
	wrote   chan struct{} // closed when the writer has stopped
	restore [2]int
	once    sync.Once
}

// write writes the queued commands to the controller's stdin, in order,
// until the queue is closed; then it closes stdin (EOF also detaches).
func (ct *controller) write() {
	defer close(ct.wrote)
	stdin := ct.p.Stdin()
	defer stdin.Close()
	for line := range ct.queue {
		if _, err := stdin.Write(line); err != nil {
			for range ct.queue { // drain: nothing more reaches herdr
			}
			return
		}
	}
}

// send queues one command, without waiting for herdr.
func (ct *controller) send(cmd any) error {
	line, err := json.Marshal(cmd)
	if err != nil {
		return err
	}
	if len(line)+1 > maxControlLine {
		return fmt.Errorf("%w: a controller command of %d bytes (at most %d)", ErrNotAllowed, len(line)+1, maxControlLine)
	}
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if ct.closed {
		return ErrControlClosed
	}
	select {
	case ct.queue <- append(line, '\n'):
		return nil
	default:
		return errors.New("herdr: the terminal controller is not reading its commands")
	}
}

func (ct *controller) Resize(cols, rows, cellW, cellH int) error {
	switch {
	case cols < MinCols || cols > MaxCols || rows < MinRows || rows > MaxRows:
		return fmt.Errorf("%w: terminal size %d×%d", ErrNotAllowed, cols, rows)
	case cellW < 0 || cellW > MaxCellPx || cellH < 0 || cellH > MaxCellPx:
		return fmt.Errorf("%w: cell size %d×%d px", ErrNotAllowed, cellW, cellH)
	}
	return ct.send(struct {
		Type  string `json:"type"`
		Cols  int    `json:"cols"`
		Rows  int    `json:"rows"`
		CellW int    `json:"cell_width_px"`
		CellH int    `json:"cell_height_px"`
	}{"terminal.resize", cols, rows, cellW, cellH})
}

func (ct *controller) Scroll(up bool, lines, col, row, mods int) error {
	switch {
	case lines < 1 || lines > MaxScrollLines:
		return fmt.Errorf("%w: scroll of %d lines", ErrNotAllowed, lines)
	case col < 0 || col >= MaxCols || row < 0 || row >= MaxRows:
		return fmt.Errorf("%w: scroll at cell %d,%d", ErrNotAllowed, col, row)
	case mods < 0 || mods > 7:
		return fmt.Errorf("%w: scroll modifiers %d", ErrNotAllowed, mods)
	}
	dir := "down"
	if up {
		dir = "up"
	}
	return ct.send(struct {
		Type      string `json:"type"`
		Direction string `json:"direction"`
		Lines     int    `json:"lines"`
		Source    string `json:"source"`
		Column    int    `json:"column"`
		Row       int    `json:"row"`
		Modifiers int    `json:"modifiers"`
	}{"terminal.scroll", dir, lines, "wheel", col, row, mods})
}

func (ct *controller) Live() error {
	return ct.send(struct {
		Type string `json:"type"`
	}{"terminal.input"})
}

func (ct *controller) RestoreOnRelease(cols, rows int) {
	ct.mu.Lock()
	ct.restore = [2]int{cols, rows}
	ct.mu.Unlock()
}

// Close releases the pane: the restore size first (when set), then
// terminal.release and EOF; the controller has ReleaseGrace to exit by
// itself, then it is stopped (SIGTERM, SIGKILL) and reaped. Safe to call
// twice.
func (ct *controller) Close() error {
	ct.once.Do(func() {
		ct.mu.Lock()
		restore := ct.restore
		ct.mu.Unlock()
		if restore[0] > 0 && restore[1] > 0 {
			_ = ct.Resize(restore[0], restore[1], 0, 0)
		}
		_ = ct.send(struct {
			Type string `json:"type"`
		}{"terminal.release"})
		ct.mu.Lock()
		ct.closed = true
		close(ct.queue)
		ct.mu.Unlock()
		timer := time.NewTimer(ReleaseGrace)
		defer timer.Stop()
		select {
		case <-ct.p.Done():
		case <-timer.C:
		}
		_ = ct.p.Stop()
		<-ct.wrote
	})
	return nil
}

// execDuplex is execStream with a stdin pipe.
func execDuplex(argv []string) (DuplexProc, error) {
	r, w, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = CleanEnv(os.Environ())
	cmd.Stdout = w // stderr: /dev/null (herdr reports refusals as terminal.closed)
	cmd.SysProcAttr = streamProcAttr()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		r.Close()
		w.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		return nil, err
	}
	w.Close()
	p := &duplexProc{proc: proc{cmd: cmd, r: r, done: make(chan struct{})}, stdin: stdin}
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

type duplexProc struct {
	proc
	stdin io.WriteCloser
}

func (p *duplexProc) Stdin() io.WriteCloser { return p.stdin }
func (p *duplexProc) Done() <-chan struct{} { return p.done }
