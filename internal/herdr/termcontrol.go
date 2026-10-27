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
	"unicode/utf8"
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
	// stdin; a full queue drops what the next one supersedes, or refuses it
	// (the caller never blocks on a wedged herdr).
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
	Input(text string) error
	InputBytes(b []byte) error
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
	ct := &controller{observer: observer{p: p, r: bufio.NewReaderSize(p.Stdout(), 64<<10)}, p: p, wrote: make(chan struct{})}
	ct.more = sync.NewCond(&ct.mu)
	go ct.write()
	return ct, nil
}

type controller struct {
	observer
	p DuplexProc

	// The queue is only read or changed under mu, by the senders and by the
	// writer taking its head, so dropping the commands one makes moot never
	// lets a later command overtake one that is kept.
	mu       sync.Mutex
	more     *sync.Cond    // signalled when the queue grows or closes
	closed   bool          // no more commands; the writer stops once the queue is empty
	queue    []ctlCmd      // the commands for stdin, in order (at most controlQueue)
	wrote    chan struct{} // closed when the writer has stopped
	released bool          // the writer wrote terminal.release
	restore  [2]int
	once     sync.Once
}

// A controller command's kind says which queued commands it supersedes.
type ctlKind int

const (
	kindResize ctlKind = iota
	kindScroll
	kindLive
	kindInput
	kindRelease
)

type ctlCmd struct {
	kind ctlKind
	line []byte
}

// write writes the queued commands to the controller's stdin, in order,
// until the queue is closed and empty; then it closes stdin (EOF also
// detaches). It writes without holding mu, so a wedged herdr blocks no
// sender.
func (ct *controller) write() {
	defer close(ct.wrote)
	stdin := ct.p.Stdin()
	defer stdin.Close()
	broken := false
	for {
		c, ok := ct.next()
		if !ok {
			return
		}
		if broken {
			continue // drain: nothing more reaches herdr
		}
		if _, err := stdin.Write(c.line); err != nil {
			broken = true
			continue
		}
		if c.kind == kindRelease {
			ct.mu.Lock()
			ct.released = true
			ct.mu.Unlock()
		}
	}
}

// next waits for a queued command and takes the oldest; false once the
// queue is closed and empty.
func (ct *controller) next() (ctlCmd, bool) {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	for len(ct.queue) == 0 {
		if ct.closed {
			return ctlCmd{}, false
		}
		ct.more.Wait()
	}
	c := ct.queue[0]
	ct.queue = ct.queue[1:]
	return c, true
}

// command is one JSONL command for the controller's stdin.
func command(kind ctlKind, cmd any) (ctlCmd, error) {
	line, err := json.Marshal(cmd)
	if err != nil {
		return ctlCmd{}, err
	}
	if len(line)+1 > maxControlLine {
		return ctlCmd{}, fmt.Errorf("%w: a controller command of %d bytes (at most %d)", ErrNotAllowed, len(line)+1, maxControlLine)
	}
	return ctlCmd{kind, append(line, '\n')}, nil
}

// send queues one command, without waiting for herdr. A full queue first
// drops the queued commands this one makes moot (supersede).
func (ct *controller) send(kind ctlKind, cmd any) error {
	c, err := command(kind, cmd)
	if err != nil {
		return err
	}
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if ct.closed {
		return ErrControlClosed
	}
	if len(ct.queue) == controlQueue {
		ct.supersede(kind)
	}
	if len(ct.queue) == controlQueue {
		return errors.New("herdr: the terminal controller is not reading its commands")
	}
	ct.queue = append(ct.queue, c)
	ct.more.Signal()
	return nil
}

// supersede drops the queued commands a new one of kind makes moot, keeping
// the rest in order (under mu, so the writer takes none meanwhile): a size
// makes the sizes before it moot, the reset to the live bottom the wheels and
// resets before it and all sizes but the last. A wheel drops nothing.
func (ct *controller) supersede(kind ctlKind) {
	if kind != kindResize && kind != kindLive {
		return
	}
	last := -1
	for i, c := range ct.queue {
		if c.kind == kindResize {
			last = i
		}
	}
	kept := ct.queue[:0]
	for i, c := range ct.queue {
		switch {
		case c.kind == kindResize && (kind == kindResize || i != last):
		case kind == kindLive && (c.kind == kindScroll || c.kind == kindLive):
		default:
			kept = append(kept, c)
		}
	}
	clear(ct.queue[len(kept):])
	ct.queue = kept
}

func (ct *controller) Resize(cols, rows, cellW, cellH int) error {
	switch {
	case cols < MinCols || cols > MaxCols || rows < MinRows || rows > MaxRows:
		return fmt.Errorf("%w: terminal size %d×%d", ErrNotAllowed, cols, rows)
	case cellW < 0 || cellW > MaxCellPx || cellH < 0 || cellH > MaxCellPx:
		return fmt.Errorf("%w: cell size %d×%d px", ErrNotAllowed, cellW, cellH)
	}
	return ct.send(kindResize, resizeCmd{"terminal.resize", cols, rows, cellW, cellH})
}

type resizeCmd struct {
	Type  string `json:"type"`
	Cols  int    `json:"cols"`
	Rows  int    `json:"rows"`
	CellW int    `json:"cell_width_px"`
	CellH int    `json:"cell_height_px"`
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
	return ct.send(kindScroll, struct {
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
	return ct.send(kindLive, struct {
		Type string `json:"type"`
	}{"terminal.input"})
}

// Input and InputBytes keep each controller line below its size limit.
// Queue all chunks together so an error cannot leave a partially sent input.
func (ct *controller) Input(text string) error {
	if !utf8.ValidString(text) {
		return fmt.Errorf("%w: input is not UTF-8", ErrNotAllowed)
	}
	var chunks []ctlCmd
	for len(text) > 0 {
		n := min(len(text), 8192)
		for n < len(text) && !utf8.RuneStart(text[n]) {
			n--
		}
		c, err := command(kindInput, struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{"terminal.input", text[:n]})
		if err != nil {
			return err
		}
		chunks = append(chunks, c)
		text = text[n:]
	}
	return ct.inputChunks(chunks)
}

func (ct *controller) InputBytes(b []byte) error {
	var chunks []ctlCmd
	for len(b) > 0 {
		n := min(len(b), 8192)
		c, err := command(kindInput, struct {
			Type  string `json:"type"`
			Bytes []byte `json:"bytes"`
		}{"terminal.input", b[:n]})
		if err != nil {
			return err
		}
		chunks = append(chunks, c)
		b = b[n:]
	}
	return ct.inputChunks(chunks)
}

func (ct *controller) inputChunks(chunks []ctlCmd) error {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if ct.closed {
		return ErrControlClosed
	}
	if len(ct.queue)+len(chunks) > controlQueue {
		return errors.New("herdr: the terminal controller is not reading its commands")
	}
	ct.queue = append(ct.queue, chunks...)
	ct.more.Signal()
	return nil
}

func (ct *controller) RestoreOnRelease(cols, rows int) {
	ct.mu.Lock()
	ct.restore = [2]int{cols, rows}
	ct.mu.Unlock()
}

// Close releases the pane: the restore size first (when set), then
// terminal.release and EOF, even when the queue is full (old non-input
// commands make room; queued input is kept in order); the controller has
// ReleaseGrace to exit by itself, then it is stopped (SIGTERM, SIGKILL) and
// reaped. The error says a controller that had to be stopped never read its
// release. Safe to call twice.
func (ct *controller) Close() error {
	var err error
	ct.once.Do(func() {
		release, _ := command(kindRelease, struct {
			Type string `json:"type"`
		}{"terminal.release"})
		final := []ctlCmd{release}
		ct.mu.Lock()
		if r := ct.restore; r[0] > 0 && r[1] > 0 {
			restore, _ := command(kindResize, resizeCmd{"terminal.resize", r[0], r[1], 0, 0})
			final = []ctlCmd{restore, release}
		}
		ct.closed = true
		over := len(ct.queue) + len(final) - controlQueue
		if over > 0 {
			kept := ct.queue[:0]
			for _, item := range ct.queue {
				if over > 0 && item.kind != kindInput {
					over--
					continue
				}
				kept = append(kept, item)
			}
			ct.queue = kept
		}
		ct.queue = append(ct.queue, final...)
		ct.more.Signal()
		ct.mu.Unlock()
		timer := time.NewTimer(ReleaseGrace)
		defer timer.Stop()
		exited := true
		select {
		case <-ct.p.Done():
		case <-timer.C:
			exited = false
		}
		_ = ct.p.Stop()
		<-ct.wrote
		ct.mu.Lock()
		defer ct.mu.Unlock()
		if !ct.released && !exited {
			err = errors.New("herdr: the terminal controller was stopped before it read its release")
		}
	})
	return err
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
