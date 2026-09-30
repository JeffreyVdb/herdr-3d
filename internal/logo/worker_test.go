package logo

import (
	"bytes"
	"context"
	"errors"
	"image"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// These tests go through the render worker: a child process, which under
// `go test` is the test binary itself (the worker mode is entered from init,
// see worker.go).

const okSVG = svgHead + `viewBox="0 0 10 10"><path d="M0 0 L10 0 L5 10 Z" fill="green"/></svg>`

// slowSVG is a benign document, 65 KB, one shape, that the source-level checks
// accept (its transforms have unit columns, so the scale bound stays 1) and
// that takes minutes to draw: a group chain that composes to a 50,000-fold
// stretch (each matrix maps (1,1) to (1.41,1.41)) turns 4000 curves into 4000
// segments of half a million pixels each. In-process it held a converter slot
// for over 20 s (review R5).
func slowSVG() string {
	const depth = 31
	path := `<path d="M0 0 ` + strings.Repeat("C10 0 0 10 10 10 C0 10 10 0 0 0 ", 2000) +
		`" fill="red" stroke="blue" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>`
	return svgHead + `viewBox="0 0 10 10">` + strings.Repeat(`<g transform="matrix(.7071 .7071 .7071 .7071 0 0)">`, depth) +
		path + strings.Repeat(`</g>`, depth) + `</svg>`
}

// gone fails unless the process is gone: reaped, not a zombie (kill(pid, 0)
// succeeds on a zombie).
func gone(t *testing.T, pid int) {
	t.Helper()
	if pid == 0 {
		t.Fatal("no worker was started")
	}
	if err := syscall.Kill(pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("worker %d is still there (kill 0: %v)", pid, err)
	}
}

// pids records the workers a converter starts.
type pids struct {
	mu sync.Mutex
	l  []int
}

func (p *pids) add(pid int) { p.mu.Lock(); p.l = append(p.l, pid); p.mu.Unlock() }
func (p *pids) n() int      { p.mu.Lock(); defer p.mu.Unlock(); return len(p.l) }
func (p *pids) all() []int  { p.mu.Lock(); defer p.mu.Unlock(); return append([]int(nil), p.l...) }

func converter(workers int, render time.Duration) (*Converter, *pids) {
	c := NewConverter(workers, DefaultWait)
	c.SetRenderTimeout(render)
	p := &pids{}
	c.started = p.add
	return c, p
}

// An SVG is converted by the child, and to the same bytes the in-process
// pipeline gives.
func TestSVGConvertsInChild(t *testing.T) {
	c, p := converter(1, DefaultRenderTimeout)
	got, err := c.Convert(context.Background(), []byte(okSVG))
	if err != nil {
		t.Fatal(err)
	}
	if p.n() != 1 {
		t.Fatalf("workers started = %d, want 1", p.n())
	}
	gone(t, p.all()[0])
	want, err := normalizeInProcess([]byte(okSVG))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got.PNG, want.PNG) || got.Hash != want.Hash || got.W != 1024 || got.H != 1024 || got.Source != "svg" {
		t.Fatalf("child result differs from the in-process one: %dx%d %s", got.W, got.H, got.Source)
	}
	if len(c.slots) != 0 {
		t.Fatal("the slot was not released")
	}
}

// Raster uploads and refused SVGs never start a child.
func TestNoChildWithoutAnSVGToDraw(t *testing.T) {
	c, p := converter(1, DefaultRenderTimeout)
	for _, in := range [][]byte{
		alphaPNG(t, 8, 8),
		[]byte(svgHead + `viewBox="0 0 9 9"><text>x</text></svg>`), // refused by the sanitiser in the bridge
		[]byte("not an image"),
	} {
		_, _ = c.Convert(context.Background(), in)
	}
	if p.n() != 0 {
		t.Fatalf("workers started = %d, want 0", p.n())
	}
}

// Refusals of the renderer come back typed, with its message.
func TestChildRefusalsAreTyped(t *testing.T) {
	c, _ := converter(1, DefaultRenderTimeout)
	for doc, want := range map[string]error{
		svgHead + `viewBox="0 0 9 9"><g/></svg>`:                                        ErrInvalid,     // draws nothing
		svgHead + `viewBox="0 0 1e9 1e9"><rect width="5" height="5" fill="red"/></svg>`: ErrUnsupported, // sanitiser, in the bridge
		svgHead + `viewBox="0 0 9 9"><rect width="5" height="5" fill="red" stroke-width="1e6" stroke="red"/>` + strings.Repeat(`<path d="M0 0 L9 9" stroke="red" stroke-width="1e6"/>`, 1) + `</svg>`: nil,
	} {
		_, err := c.Convert(context.Background(), []byte(doc))
		if want == nil {
			continue
		}
		if !errors.Is(err, want) {
			t.Errorf("%.60s: err = %v, want %v", doc, err, want)
		}
	}
	if len(c.slots) != 0 {
		t.Fatal("the slot was not released")
	}
}

// The document of review R5: refused within the deadline, the child gone, the
// slot free for the next logo.
func TestSlowSVGIsKilledAtTheDeadline(t *testing.T) {
	const deadline = time.Second * raceScale
	c, p := converter(1, deadline)
	doc := slowSVG()
	if len(doc) > 70_000 {
		t.Fatalf("the document is %d bytes", len(doc))
	}
	if _, err := sanitizeSVG([]byte(doc)); err != nil {
		t.Fatalf("the sanitiser refuses the document, so it tests nothing: %v", err)
	}
	t0 := time.Now()
	_, err := c.Convert(context.Background(), []byte(doc))
	took := time.Since(t0)
	if !errors.Is(err, ErrTimeout) || !errors.Is(err, ErrUnsupported) {
		t.Fatalf("err = %v, want ErrTimeout (and ErrUnsupported)", err)
	}
	if strings.Contains(err.Error(), "logo render timeout") {
		t.Fatalf("the message has the sentinel's words: %v", err)
	}
	if took < deadline || took > deadline+1500*time.Millisecond*raceScale {
		t.Fatalf("refused after %v, want about %v", took, deadline)
	}
	if p.n() != 1 {
		t.Fatalf("workers started = %d", p.n())
	}
	gone(t, p.all()[0])
	if len(c.slots) != 0 {
		t.Fatal("the slot was not released")
	}
	t0 = time.Now()
	if _, err := c.Convert(context.Background(), []byte(okSVG)); err != nil {
		t.Fatalf("an ordinary logo right after: %v", err)
	}
	if d := time.Since(t0); d > time.Second*raceScale {
		t.Fatalf("the ordinary logo took %v", d)
	}
}

// Two hostile conversions hold both slots, but only until the deadline: a
// third, ordinary logo waits no longer than that.
func TestHostileConversionsDoNotBlockOthersBeyondTheDeadline(t *testing.T) {
	const deadline = time.Second * raceScale
	c, p := converter(2, deadline)
	c.wait = 3 * deadline // busy is for a wait longer than a kill takes
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.Convert(context.Background(), []byte(slowSVG()))
			errs <- err
		}()
	}
	for p.n() < 2 {
		time.Sleep(5 * time.Millisecond)
	}
	t0 := time.Now()
	if _, err := c.Convert(context.Background(), []byte(okSVG)); err != nil {
		t.Fatalf("the ordinary logo: %v", err)
	}
	if d := time.Since(t0); d > deadline+1500*time.Millisecond*raceScale {
		t.Fatalf("the ordinary logo waited %v behind two hostile ones, want at most about %v", d, deadline)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if !errors.Is(err, ErrTimeout) {
			t.Fatalf("hostile: err = %v, want ErrTimeout", err)
		}
	}
	for _, pid := range p.all() {
		gone(t, pid)
	}
	if len(c.slots) != 0 {
		t.Fatal("a slot was not released")
	}
}

// A caller that goes away takes the child with it.
func TestCancelKillsTheChild(t *testing.T) {
	c, p := converter(1, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for p.n() == 0 {
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
	}()
	t0 := time.Now()
	_, err := c.Convert(ctx, []byte(slowSVG()))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if d := time.Since(t0); d > 3*time.Second*raceScale {
		t.Fatalf("took %v to give up", d)
	}
	gone(t, p.all()[0])
	if len(c.slots) != 0 {
		t.Fatal("the slot was not released")
	}
}

// The worker's own CPU limit, for a worker its parent did not (or could not)
// kill: with a parent deadline far away, the kernel ends it.
func TestWorkerCPULimit(t *testing.T) {
	c, p := converter(1, time.Minute)
	c.command = func(ctx context.Context) (*exec.Cmd, error) {
		cmd, err := c.defaultCommand(ctx)
		if err == nil {
			cmd.Env = append(cmd.Env, cpuEnv+"=1") // the later value wins
		}
		return cmd, err
	}
	t0 := time.Now()
	_, err := c.Convert(context.Background(), []byte(slowSVG()))
	if !errors.Is(err, ErrInvalid) || errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v, want ErrInvalid from a worker killed by its CPU limit", err)
	}
	if d := time.Since(t0); d < 900*time.Millisecond || d > 8*time.Second*raceScale {
		t.Fatalf("killed after %v, want about 1 s of CPU", d)
	}
	gone(t, p.all()[0])
}

// scripted runs a shell script as the worker.
func scripted(c *Converter, script string) {
	c.command = func(ctx context.Context) (*exec.Cmd, error) {
		return exec.CommandContext(ctx, "/bin/sh", "-c", script), nil
	}
}

// A misbehaving worker is an error, never a panic or a hang, and the slot and
// the process are always released.
func TestWorkerFailures(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	good := write("good.png", encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 8, 8))))
	huge := write("huge.png", encodePNG(t, image.NewNRGBA(image.Rect(0, 0, MaxEdge+1, 4))))
	trunc := write("trunc.png", encodePNG(t, image.NewNRGBA(image.Rect(0, 0, 8, 8)))[:40])
	const deadline = time.Second * raceScale
	tests := []struct {
		name, script string
		want         error
		msg          string
		fast         bool // refused well before the deadline
	}{
		{"a PNG (sanity)", `cat ` + good, nil, "", true},
		{"non-zero exit", `exit 3`, ErrInvalid, "cannot process this image", true},
		{"crash", `kill -SEGV $$`, ErrInvalid, "cannot process this image", true},
		{"killed", `kill -KILL $$`, ErrInvalid, "cannot process this image", true},
		{"no output", `exit 0`, ErrInvalid, "", true},
		{"garbage", `echo garbage`, ErrInvalid, "", true},
		{"a PNG over the stored size", `cat ` + huge, ErrInvalid, "", true},
		{"a truncated PNG", `cat ` + trunc, ErrInvalid, "", true},
		{"a PNG and trailing bytes", `cat ` + good + `; echo x`, ErrInvalid, "", true},
		{"output over the cap", `yes | head -c 20000000`, ErrInvalid, "cannot process this image", true},
		{"output over the cap, then hangs", `head -c 20000000 /dev/zero; exec sleep 30`, ErrInvalid, "cannot process this image", true},
		{"typed: invalid", `echo '{"message":"bad thing"}' >&2; exit 10`, ErrInvalid, "bad thing", true},
		{"typed: unsupported", `echo '{"message":"no can do"}' >&2; exit 11`, ErrUnsupported, "no can do", true},
		{"typed: too large", `echo '{"message":"big"}' >&2; exit 12`, ErrTooLarge, "big", true},
		{"typed with a message that is not JSON", `echo 'not json' >&2; exit 11`, ErrUnsupported, "cannot process this image", true},
		{"typed with control characters", `printf '{"message":"a\\u0000b\\nc\\u001b[31m"}' >&2; exit 10`, ErrInvalid, "a b c [31m", true},
		{"stderr spam", `head -c 5000000 /dev/zero >&2; exit 4`, ErrInvalid, "cannot process this image", true},
		{"never reads its input, never ends", `exec sleep 30`, ErrTimeout, "", false},
		{"ignores its input and prints then hangs", `echo hi; exec sleep 30`, ErrTimeout, "", false},
		{"a grandchild holds the pipes", `sleep 30 & wait`, ErrTimeout, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c, p := converter(1, deadline)
			scripted(c, tc.script)
			t0 := time.Now()
			// Enough input that a worker that never reads would block a naive write.
			in := svgHead + `viewBox="0 0 9 9"><title>` + strings.Repeat("x", 300_000) + `</title><rect width="5" height="5"/></svg>`
			res, err := c.Convert(context.Background(), []byte(in))
			took := time.Since(t0)
			if tc.want == nil {
				if err != nil || res.W != 8 || res.H != 8 {
					t.Fatalf("got %+v, %v", res, err)
				}
			} else {
				if !errors.Is(err, tc.want) {
					t.Fatalf("err = %v, want %v", err, tc.want)
				}
				if tc.msg != "" && !strings.HasSuffix(err.Error(), ": "+tc.msg) {
					t.Fatalf("err = %q, want message %q", err, tc.msg)
				}
			}
			if tc.fast && took > deadline*4/5 {
				t.Fatalf("took %v, want well under the deadline", took)
			}
			if !tc.fast && (took < deadline || took > deadline+2*time.Second*raceScale) {
				t.Fatalf("took %v, want about the deadline %v", took, deadline)
			}
			gone(t, p.all()[0])
			if len(c.slots) != 0 {
				t.Fatal("the slot was not released")
			}
			if _, err := scriptedOK(c, good); err != nil {
				t.Fatalf("the converter is unusable afterwards: %v", err)
			}
		})
	}
}

// scriptedOK converts once more with a worker that succeeds.
func scriptedOK(c *Converter, png string) (Result, error) {
	scripted(c, `cat `+png)
	return c.Convert(context.Background(), []byte(okSVG))
}

// The kill takes the worker's whole process group: nothing it started stays.
func TestKillTakesTheProcessGroup(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	c, p := converter(1, 500*time.Millisecond)
	scripted(c, `sleep 30 & echo $! > `+pidFile+`; wait`)
	if _, err := c.Convert(context.Background(), []byte(okSVG)); !errors.Is(err, ErrTimeout) {
		t.Fatalf("err = %v", err)
	}
	gone(t, p.all()[0])
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	var grand int
	for _, r := range strings.TrimSpace(string(b)) {
		grand = grand*10 + int(r-'0')
	}
	// The orphan is adopted by init, which reaps it; give that a moment.
	for i := 0; i < 100 && syscall.Kill(grand, 0) == nil; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	gone(t, grand)
}

// A worker that cannot be started is an ordinary error (the bridge answers
// 500), and the slot is free.
func TestWorkerThatCannotStart(t *testing.T) {
	c, _ := converter(1, DefaultRenderTimeout)
	c.command = func(ctx context.Context) (*exec.Cmd, error) {
		return exec.CommandContext(ctx, "/nonexistent/logo-worker"), nil
	}
	_, err := c.Convert(context.Background(), []byte(okSVG))
	if err == nil || errors.Is(err, ErrInvalid) || errors.Is(err, ErrUnsupported) || errors.Is(err, ErrTooLarge) || errors.Is(err, ErrBusy) {
		t.Fatalf("err = %v, want a plain error", err)
	}
	if len(c.slots) != 0 {
		t.Fatal("the slot was not released")
	}
}

// The worker function itself: the exit codes the parent maps back, and the
// sanitising it does on its own.
func TestRunWorker(t *testing.T) {
	run := func(in string) (int, []byte, string) {
		var out, errw bytes.Buffer
		code := runWorker(strings.NewReader(in), &out, &errw)
		return code, out.Bytes(), errw.String()
	}
	if code, png, _ := run(okSVG); code != 0 || len(png) == 0 {
		t.Fatalf("code %d, %d bytes", code, len(png))
	}
	for name, tc := range map[string]struct {
		in   string
		code int
	}{
		"draws nothing":                          {svgHead + `viewBox="0 0 9 9"><g/></svg>`, exitInvalid},
		"not XML":                                {"garbage", exitInvalid},
		"text, given without the bridge's check": {svgHead + `viewBox="0 0 9 9"><text>x</text></svg>`, exitUnsupported},
		"foreign markup, given unsanitised":      {`<svg xmlns="` + svgNS + `" xmlns:x="urn:x" viewBox="0 0 9 9"><x:rect width="9" height="9"/></svg>`, exitInvalid},
		"over the input limit":                   {strings.Repeat(" ", MaxInput+1), exitTooLarge},
	} {
		code, out, errw := run(tc.in)
		if code != tc.code || len(out) != 0 || !strings.Contains(errw, `"message"`) {
			t.Errorf("%s: code %d (want %d), %d bytes out, stderr %q", name, code, tc.code, len(out), errw)
		}
	}
}

// What the bridge hands the worker passes the sanitiser unchanged, so drawing
// the canonical copy is drawing what was checked.
func TestCanonicalCopyIsStable(t *testing.T) {
	for _, doc := range []string{
		okSVG,
		`<?xml version="1.0"?><svg xmlns="` + svgNS + `" xmlns:x="urn:evil" viewBox="0 0 9 9" x:foo="1" Style="a:b"><x:junk><rect/></x:junk><g id="a&lt;b" style="Fill: red;font-size:9;stroke-width:2"><title>t</title><linearGradient id="g" href="#h"/></g></svg>`,
		slowSVG(),
	} {
		once, err := sanitizeSVG([]byte(doc))
		if err != nil {
			t.Fatal(err)
		}
		twice, err := sanitizeSVG(once)
		if err != nil || !bytes.Equal(once, twice) {
			t.Fatalf("sanitising the canonical copy again changes it (%v)", err)
		}
	}
}
