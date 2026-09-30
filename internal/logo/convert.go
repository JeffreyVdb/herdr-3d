package logo

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/png"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Default limits of a Converter.
const (
	DefaultWorkers = 2
	DefaultWait    = 10 * time.Second
	// DefaultRenderTimeout is how long a render worker may run before it is
	// killed: what a hostile SVG can hold a conversion slot for.
	DefaultRenderTimeout = 5 * time.Second

	maxWorkerOutput = 8 << 20 // bytes of PNG a worker may write (a 1024 x 1024 RGBA PNG is about 4 MiB at worst)
	maxWorkerStderr = 4 << 10 // bytes of a worker's stderr kept
	workerWaitDelay = time.Second
)

// Converter turns uploads into logos with at most a few conversions at once.
//
// PNG and WebP are decoded in the bridge (bounded by the pixel caps read from
// the header). An SVG is sanitised in the bridge, then drawn by a render worker
// (worker.go): the bridge's own executable, run again as a child that reads the
// sanitised copy on stdin and writes the PNG on stdout. oksvg and rasterx take
// no context and no source-level check can bound their cost, so the only hard
// bound is to kill the child: at RenderTimeout it gets SIGKILL (with its
// process group), is always waited for, and the conversion is refused. A
// conversion holds its slot for the life of the child, so a hostile document
// ties a slot up for at most the timeout. The child's output is size-capped and
// validated as a PNG, its exit status and stderr are never shown to the user
// (except a typed refusal's short message), and it gets a minimal environment.
type Converter struct {
	slots  chan struct{}
	wait   time.Duration
	render time.Duration // RenderTimeout

	// Test hooks. command builds the worker's command (default: this binary
	// in worker mode); started is called with the child's pid.
	command func(ctx context.Context) (*exec.Cmd, error)
	started func(pid int)
}

// NewConverter returns a converter with workers slots (default DefaultWorkers)
// and a limit of wait (default DefaultWait) for a slot. Render workers get
// DefaultRenderTimeout (SetRenderTimeout).
func NewConverter(workers int, wait time.Duration) *Converter {
	if workers <= 0 {
		workers = DefaultWorkers
	}
	if wait <= 0 {
		wait = DefaultWait
	}
	return &Converter{slots: make(chan struct{}, workers), wait: wait, render: DefaultRenderTimeout}
}

// SetRenderTimeout sets how long a render worker may run (default
// DefaultRenderTimeout). Call it before the first Convert.
func (c *Converter) SetRenderTimeout(d time.Duration) {
	if d > 0 {
		c.render = d
	}
}

// Convert normalises an upload, waiting for a free slot. It returns ErrBusy
// when there is none in time, and for an SVG that the render worker does not
// finish in time ErrUnsupported and ErrTimeout together.
func (c *Converter) Convert(ctx context.Context, data []byte) (Result, error) {
	timer := time.NewTimer(c.wait)
	defer timer.Stop()
	select {
	case c.slots <- struct{}{}:
	case <-timer.C:
		return Result{}, fmt.Errorf("%w: other logos are being converted", ErrBusy)
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	defer func() { <-c.slots }()
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	return normalize(data, func(clean []byte) (Result, error) { return c.renderInChild(ctx, clean) })
}

// defaultCommand is the render worker: this executable in worker mode, with an
// environment of its own (nothing of the bridge's, whose variables may hold
// tokens) and a CPU limit a little over the deadline.
func (c *Converter) defaultCommand(ctx context.Context) (*exec.Cmd, error) {
	exe, err := workerExecutable()
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, exe, workerArg)
	cmd.Env = []string{
		workerEnv + "=1",
		cpuEnv + "=" + strconv.Itoa(int(math.Ceil(c.render.Seconds()))+1),
		"GOMAXPROCS=2",
	}
	return cmd, nil
}

// renderInChild draws a sanitised SVG in a render worker. See Converter.
func (c *Converter) renderInChild(ctx context.Context, clean []byte) (Result, error) {
	tctx, cancel := context.WithTimeout(ctx, c.render)
	defer cancel()
	mk := c.command
	if mk == nil {
		mk = c.defaultCommand
	}
	cmd, err := mk(tctx)
	if err != nil {
		return Result{}, fmt.Errorf("cannot start the logo render worker: %w", err)
	}
	out := &capBuffer{max: maxWorkerOutput, overflow: cancel}
	stderr := &capBuffer{max: maxWorkerStderr, discard: true}
	// exec copies stdin in a goroutine of its own, so a worker that never reads
	// cannot hold this up past the kill; WaitDelay bounds the wait for that
	// copy and the output pipes once the process is gone.
	cmd.Stdin = bytes.NewReader(clean)
	cmd.Stdout, cmd.Stderr = out, stderr
	cmd.WaitDelay = workerWaitDelay
	killable(cmd)
	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("cannot start the logo render worker: %w", err)
	}
	if c.started != nil {
		c.started(cmd.Process.Pid)
	}
	werr := cmd.Wait() // always: the child is reaped whatever happened
	switch {
	case ctx.Err() != nil:
		return Result{}, ctx.Err()
	case out.over():
		return Result{}, invalid("cannot process this image")
	case werr != nil && errors.Is(tctx.Err(), context.DeadlineExceeded):
		return Result{}, timeoutError{}
	case werr == nil:
		return checkWorkerPNG(out.bytes())
	}
	var ee *exec.ExitError
	if errors.As(werr, &ee) {
		switch ee.ExitCode() {
		case exitInvalid:
			return Result{}, fmt.Errorf("%w: %s", ErrInvalid, workerMessage(stderr.bytes()))
		case exitUnsupported:
			return Result{}, fmt.Errorf("%w: %s", ErrUnsupported, workerMessage(stderr.bytes()))
		case exitTooLarge:
			return Result{}, fmt.Errorf("%w: %s", ErrTooLarge, workerMessage(stderr.bytes()))
		}
	}
	return Result{}, invalid("cannot process this image")
}

// timeoutError is a render worker that had to be killed: it is both
// ErrUnsupported (the HTTP answer: the document must be simpler) and ErrTimeout
// (what tests and logs look for).
type timeoutError struct{}

func (timeoutError) Error() string {
	return ErrUnsupported.Error() + ": the SVG takes too long to draw: use fewer or simpler shapes"
}

func (timeoutError) Is(target error) bool { return target == ErrUnsupported || target == ErrTimeout }

// workerMessage is the message of a typed refusal, cut short and cleaned of
// anything but printable text: a worker is trusted no further than that.
func workerMessage(stderr []byte) string {
	var r workerRefusal
	if json.Unmarshal(stderr, &r) != nil || r.Message == "" {
		return "cannot process this image"
	}
	msg := strings.Map(func(c rune) rune {
		if c < ' ' || c == 0x7f || c == 0xfffd {
			return ' '
		}
		return c
	}, r.Message)
	if len(msg) > maxWorkerMessage {
		msg = strings.ToValidUTF8(msg[:maxWorkerMessage], "") + "…"
	}
	return msg
}

// pngEnd is the IEND chunk that ends every PNG.
var pngEnd = []byte("\x00\x00\x00\x00IEND\xaeB`\x82")

// checkWorkerPNG accepts a worker's output only if it is a PNG that fits the
// stored size and has nothing after its last chunk: the bridge stores exactly
// these bytes.
func checkWorkerPNG(b []byte) (Result, error) {
	if !bytes.HasSuffix(b, pngEnd) {
		return Result{}, invalid("cannot process this image")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > MaxEdge || cfg.Height > MaxEdge {
		return Result{}, invalid("cannot process this image")
	}
	if _, err := png.Decode(bytes.NewReader(b)); err != nil {
		return Result{}, invalid("cannot process this image")
	}
	return Result{PNG: b, Hash: Hash(b), W: cfg.Width, H: cfg.Height, Source: "svg"}, nil
}

// capBuffer keeps what is written to it up to max bytes. Past that it either
// discards the rest (discard: a chatty stderr) or calls overflow, which kills
// the worker, and refuses further writes.
type capBuffer struct {
	mu       sync.Mutex
	buf      bytes.Buffer
	max      int
	discard  bool
	overflow func()
	full     bool
}

func (c *capBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.full {
		return len(p), nil
	}
	if room := c.max - c.buf.Len(); len(p) > room {
		c.buf.Write(p[:room])
		if c.discard {
			c.full = true
			return len(p), nil
		}
		c.full = true
		c.overflow()
		return room, errors.New("logo worker output over the limit")
	}
	return c.buf.Write(p)
}

// over reports whether output was refused for its size.
func (c *capBuffer) over() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.full && !c.discard
}

func (c *capBuffer) bytes() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Bytes()
}
