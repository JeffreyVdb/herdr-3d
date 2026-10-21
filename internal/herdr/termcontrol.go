package herdr

// #176: the seated laptop's terminal controller. `terminal session control`
// attaches to a pane as its owner: the same NDJSON frames as an observer
// on stdout, and JSONL commands on stdin (resize the real PTY, scroll
// herdr's history, release). It is never started with --takeover: herdr
// refuses a second owner, and that refusal is the caller's read-only
// fallback (ControlRefused).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"slices"
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
	// a client that sends more). The commands are a few dozen bytes but a
	// paste: at most MaxMessage of text, which JSON may spell out as 6 bytes
	// a byte (\u001b).
	maxControlLine = 128 << 10
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

// writeWait bounds how long Paste and Click wait for their turn on the
// controller's stdin (see sendWritten; a variable for tests).
var writeWait = 5 * time.Second

// appliedWait bounds how long Paste and Click then wait for herdr's full
// frame that shows it applied them (see sendWritten; a variable for tests).
var appliedWait = 2 * time.Second

// Bracketed paste's markers (DECSET 2004): herdr unwraps one whole envelope
// in a terminal.input and wraps the text again only for an application
// that asked for bracketed paste.
const (
	PasteStart = "\x1b[200~"
	PasteEnd   = "\x1b[201~"
)

// Mouse buttons a click can be made with (terminal.mouse's "button").
var MouseButtons = []string{"left", "right", "middle"}

// ErrControlClosed is returned by a command to a controller that was
// released or stopped.
var ErrControlClosed = errors.New("herdr: the terminal controller is closed")

// ErrInputUnsent is a paste's or a click's error from before any of it was
// written to the controller's stdin (see InputUnsent).
var ErrInputUnsent = errors.New("herdr: the input was not sent")

// InputUnsent reports whether a Paste's or a Click's error is from before any
// of it was written to the controller's stdin: refused, given up while it was
// still queued, dropped at Close. It never reaches herdr, later neither. Any
// other error (a write that failed) may have left some of it with herdr.
func InputUnsent(err error) bool {
	return errors.Is(err, ErrInputUnsent) || errors.Is(err, ErrControlClosed) || errors.Is(err, ErrNotAllowed)
}

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
	// Paste writes text as one bracketed paste (PasteText: one
	// terminal.input, ESC[200~ … ESC[201~): herdr gives it to the application
	// as a paste when it asked for that, as plain text otherwise; nothing is
	// added, Enter neither. It returns once the line is on herdr's stdin, or
	// fails: it is never dropped without a word, and one that fails before it
	// is written (InputUnsent: a cancel or a timeout while it is queued) is
	// never written later. Once its line is being written it waits for that.
	Paste(ctx context.Context, text string) error
	// Click is a click of button (MouseButtons) on cell (col, row), 0-based,
	// with modifier bits mods (Shift 1, Ctrl 2, Alt 4): terminal.mouse down,
	// then up (herdr 0.9.2+; herdr drops it when the application has no
	// mouse reporting on). It returns once both lines are on herdr's stdin;
	// a failure is as Paste's.
	Click(ctx context.Context, button string, col, row, mods int) error
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
	ct := &controller{observer: observer{p: p, r: bufio.NewReaderSize(p.Stdout(), 64<<10)}, p: p, wrote: make(chan struct{}),
		size: [4]int{cols, rows, 0, 0}, full: make(chan struct{})}
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
	// #176 part 2: herdr answers each resize with one full frame (and the
	// attach with the first): resizes is how many the writer wrote, fulls how
	// many full frames came (full is closed and replaced at each), size the
	// last size asked for (cols, rows, cell px).
	resizes, fulls int
	full           chan struct{}
	size           [4]int
}

// A controller command's kind says which queued commands it supersedes.
type ctlKind int

const (
	kindResize ctlKind = iota
	kindScroll
	kindLive
	kindRelease
	// #176 part 2: a paste or a click; its sender waits for it (done).
	kindInput
)

type ctlCmd struct {
	kind ctlKind
	line []byte
	// resizes is how many terminal.resize lines the line holds.
	resizes int
	// done (nil: none) gets the write's outcome, or ErrControlClosed when
	// the command was dropped at Close, and how many resizes were written by
	// then.
	done chan written
}

type written struct {
	err     error
	resizes int
}

// finish tells a command's sender what became of it.
func (c ctlCmd) finish(err error, resizes int) {
	if c.done != nil {
		c.done <- written{err, resizes}
	}
}

// write writes the queued commands to the controller's stdin, in order,
// until the queue is closed and empty; then it closes stdin (EOF also
// detaches). It writes without holding mu, so a wedged herdr blocks no
// sender.
func (ct *controller) write() {
	defer close(ct.wrote)
	stdin := ct.p.Stdin()
	defer stdin.Close()
	var broken error
	for {
		c, ok := ct.next()
		if !ok {
			return
		}
		if broken != nil {
			c.finish(fmt.Errorf("%w: %w", ErrInputUnsent, broken), 0) // drain: nothing more reaches herdr
			continue
		}
		if _, err := stdin.Write(c.line); err != nil {
			broken = err
			c.finish(err, 0)
			continue
		}
		ct.mu.Lock()
		ct.resizes += c.resizes
		n := ct.resizes
		if c.kind == kindRelease {
			ct.released = true
		}
		ct.mu.Unlock()
		c.finish(nil, n)
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

// command is JSONL commands for the controller's stdin (one write), within
// maxControlLine; text as it is (no HTML escapes: a paste's "<" stays one
// byte).
func command(kind ctlKind, cmds ...any) (ctlCmd, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	for _, cmd := range cmds {
		if err := enc.Encode(cmd); err != nil {
			return ctlCmd{}, err
		}
	}
	if b.Len() > maxControlLine {
		return ctlCmd{}, fmt.Errorf("%w: a controller command of %d bytes (at most %d)", ErrNotAllowed, b.Len(), maxControlLine)
	}
	c := ctlCmd{kind: kind, line: b.Bytes()}
	if kind == kindResize {
		c.resizes = 1
	}
	return c, nil
}

// Next is the observer's, and (#176 part 2) counts herdr's full frames.
func (ct *controller) Next() (Frame, error) {
	f, err := ct.observer.Next()
	if err == nil && f.Full && !f.Closed {
		ct.mu.Lock()
		ct.fulls++
		close(ct.full)
		ct.full = make(chan struct{})
		ct.mu.Unlock()
	}
	return f, err
}

// send queues one command, without waiting for herdr. A full queue first
// drops the queued commands this one makes moot (supersede).
func (ct *controller) send(kind ctlKind, cmd any) error {
	c, err := command(kind, cmd)
	if err != nil {
		return err
	}
	return ct.queueCmd(c)
}

func (ct *controller) queueCmd(c ctlCmd) error {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	return ct.queueLocked(c)
}

// queueLocked is queueCmd under mu.
func (ct *controller) queueLocked(c ctlCmd) error {
	if ct.closed {
		return ErrControlClosed
	}
	if len(ct.queue) == controlQueue {
		ct.supersede(c.kind)
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
// resets before it and all sizes but the last. #176 part 2: input (a
// paste, a click) as the reset (herdr resets the view before any input); a
// queued input is never dropped. A wheel drops nothing.
func (ct *controller) supersede(kind ctlKind) {
	if kind == kindInput {
		kind = kindLive
	}
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
	c, err := command(kindResize, resizeCmd{"terminal.resize", cols, rows, cellW, cellH})
	if err != nil {
		return err
	}
	// The size with its place in the queue (see sendWritten); a refused
	// resize changes neither.
	ct.mu.Lock()
	defer ct.mu.Unlock()
	if err := ct.queueLocked(c); err != nil {
		return err
	}
	ct.size = [4]int{cols, rows, cellW, cellH}
	return nil
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

func (ct *controller) Paste(ctx context.Context, text string) error {
	if len(text) > MaxMessage || !utf8.ValidString(text) {
		return fmt.Errorf("%w: a paste of %d bytes (UTF-8, at most %d)", ErrNotAllowed, len(text), MaxMessage)
	}
	return ct.sendWritten(ctx, struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}{"terminal.input", PasteText(text)})
}

func (ct *controller) Click(ctx context.Context, button string, col, row, mods int) error {
	switch {
	case !slices.Contains(MouseButtons, button):
		return fmt.Errorf("%w: mouse button %q", ErrNotAllowed, button)
	case col < 0 || col >= MaxCols || row < 0 || row >= MaxRows:
		return fmt.Errorf("%w: click at cell %d,%d", ErrNotAllowed, col, row)
	case mods < 0 || mods > 7:
		return fmt.Errorf("%w: click modifiers %d", ErrNotAllowed, mods)
	}
	type mouse struct {
		Type      string `json:"type"`
		Action    string `json:"action"`
		Button    string `json:"button"`
		Column    int    `json:"column"`
		Row       int    `json:"row"`
		Modifiers int    `json:"modifiers"`
	}
	return ct.sendWritten(ctx, mouse{"terminal.mouse", "down", button, col, row, mods},
		mouse{"terminal.mouse", "up", button, col, row, mods})
}

// sendWritten queues input as one write and waits until herdr applied it:
// the caller's next input takes another way into herdr (`pane send-keys`),
// and on herdr 0.9.5 such keys were seen to overtake input that was only
// written to the controller's stdin. herdr acknowledges no input, but it
// answers every resize with a full frame, after what came before it on the
// controller's connection: so a resize to the size asked last goes with the
// input, and sendWritten returns once herdr's full frame for it came (or
// after appliedWait, the input written). A full queue makes room as a reset
// does, else the input is refused; one dropped at Close says so. The
// resize's size is the one current when the input is queued, under the same
// lock as Resize's, so a resize at the same time is either before the input
// (and that is the size) or after it: never undone. A cancel or writeWait
// while the input is still queued takes it out (ErrInputUnsent: never
// written later, behind what came after it); once the writer has it, they
// wait for the write, which ends or fails (Close stops a wedged herdr).
func (ct *controller) sendWritten(ctx context.Context, cmds ...any) error {
	c, err := command(kindInput, cmds...)
	if err != nil {
		return err
	}
	c.done = make(chan written, 1)
	ct.mu.Lock()
	sz := ct.size
	barrier, err := command(kindResize, resizeCmd{"terminal.resize", sz[0], sz[1], sz[2], sz[3]})
	if err == nil {
		c.line, c.resizes = append(c.line, barrier.line...), 1
		if len(c.line) > maxControlLine {
			err = fmt.Errorf("%w: a controller command of %d bytes (at most %d)", ErrNotAllowed, len(c.line), maxControlLine)
		} else if err = ct.queueLocked(c); err != nil && !errors.Is(err, ErrControlClosed) {
			err = fmt.Errorf("%w: %w", ErrInputUnsent, err)
		}
	}
	ct.mu.Unlock()
	if err != nil {
		return err
	}
	timer := time.NewTimer(writeWait)
	defer timer.Stop()
	var w written
	select {
	case w = <-c.done:
	case <-ctx.Done():
		if ct.withdraw(c.done) {
			return fmt.Errorf("%w: %w", ErrInputUnsent, ctx.Err())
		}
		w = <-c.done
	case <-timer.C:
		if ct.withdraw(c.done) {
			return fmt.Errorf("%w: the terminal controller is not reading its commands", ErrInputUnsent)
		}
		w = <-c.done
	}
	switch {
	case InputUnsent(w.err):
		return w.err
	case w.err != nil:
		return fmt.Errorf("herdr: writing to the terminal controller: %w", w.err)
	}
	// The attach's full frame, then one per resize written.
	timer.Reset(appliedWait)
	for {
		ct.mu.Lock()
		seen, full := ct.fulls, ct.full
		ct.mu.Unlock()
		if seen >= w.resizes+1 || ctx.Err() != nil {
			return nil // (cancelled: written, herdr's answer not waited for)
		}
		select {
		case <-full:
		case <-ctx.Done():
		case <-timer.C:
			return nil // written; herdr's answer is late (or one frame answered two resizes)
		case <-ct.p.Done():
			return nil
		}
	}
}

// withdraw takes the input whose sender waits on done out of the queue,
// keeping the rest in order; false when it is not there (the writer took it,
// or Close dropped it: done gets its outcome).
func (ct *controller) withdraw(done chan written) bool {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	for i, c := range ct.queue {
		if c.done == done {
			ct.queue = slices.Delete(ct.queue, i, i+1)
			return true
		}
	}
	return false
}

// PasteText is text as one bracketed paste: NUL and any paste marker in it
// removed (one inside would end herdr's envelope early, and herdr would
// write the whole line raw), line ends as CR (a terminal's paste: Enter's
// byte, as xterm.js sends it), between ESC[200~ and ESC[201~.
func PasteText(text string) string {
	return PasteStart + PasteClean(text) + PasteEnd
}

// PasteClean is the text of a paste as it is sent: PasteStrip, its line ends
// as CR.
func PasteClean(text string) string {
	t := PasteStrip(text)
	return strings.ReplaceAll(strings.ReplaceAll(t, "\r\n", "\r"), "\n", "\r")
}

// PasteStrip is text without what a paste cannot carry: NUL, and the paste
// markers (removed until none is left: taking one out may join another).
func PasteStrip(text string) string {
	t := strings.ReplaceAll(text, "\x00", "")
	for strings.Contains(t, PasteStart) || strings.Contains(t, PasteEnd) {
		t = strings.ReplaceAll(strings.ReplaceAll(t, PasteStart, ""), PasteEnd, "")
	}
	return t
}

func (ct *controller) RestoreOnRelease(cols, rows int) {
	ct.mu.Lock()
	ct.restore = [2]int{cols, rows}
	ct.mu.Unlock()
}

// Close releases the pane: the restore size first (when set), then
// terminal.release and EOF, even when the queue is full (the oldest queued
// commands, moot once the pane is released, make room); the controller has
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
		if over := len(ct.queue) + len(final) - controlQueue; over > 0 {
			for _, c := range ct.queue[:over] {
				c.finish(ErrControlClosed, 0) // a paste or a click waiting on it hears so
			}
			ct.queue = ct.queue[over:]
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
