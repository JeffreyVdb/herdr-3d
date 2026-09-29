// Package limits reads the Claude and Codex plan limits (M10): it asks each
// CLI for them as a child of the bridge, so the user's normal sign-in is used
// and the bridge reads or stores no credentials. Neither probe starts a
// conversation, costs tokens or writes a session file.
package limits

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Cmd is a process to start.
type Cmd struct {
	Path string
	Args []string
	Dir  string
	Env  []string
}

// Process is a started child with pipes to its stdin and stdout.
type Process interface {
	Stdin() io.WriteCloser
	Stdout() io.Reader
	// Kill ends the process (and its children) at once. It may be called
	// more than once, from any goroutine.
	Kill()
	// Wait returns when the process has exited and been reaped.
	Wait() error
}

// Runner starts processes. The fake of the tests is one; ExecRunner the
// real one.
type Runner interface {
	Start(c Cmd) (Process, error)
}

// ExecRunner starts real processes, each in its own process group so that
// Kill takes the children down too. stderr is discarded.
type ExecRunner struct{}

type execProc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   io.Reader
}

// Start implements Runner.
func (ExecRunner) Start(c Cmd) (Process, error) {
	cmd := exec.Command(c.Path, c.Args...)
	cmd.Dir, cmd.Env = c.Dir, c.Env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &execProc{cmd: cmd, stdin: in, out: out}, nil
}

func (p *execProc) Stdin() io.WriteCloser { return p.stdin }
func (p *execProc) Stdout() io.Reader     { return p.out }
func (p *execProc) Wait() error           { return p.cmd.Wait() }
func (p *execProc) Kill() {
	if p.cmd.Process != nil {
		_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		_ = p.cmd.Process.Kill()
	}
}

// probeEnv is the bridge's environment as the probes get it: without the
// variables that make a CLI think it runs inside an agent session or under
// herdr (CLAUDECODE*, HERDR_*).
func probeEnv(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "CLAUDECODE") || strings.HasPrefix(kv, "HERDR_") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// errNotInstalled is a CLI that is not there.
var errNotInstalled = errors.New("not installed")

func startErr(err error) error {
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, os.ErrNotExist) {
		return errNotInstalled
	}
	return err
}

// maxLine bounds one line of a probe's output.
const maxLine = 4 << 20

// lines reads r line by line into a channel, which closes at the end of
// the stream (or on a line over maxLine). It returns when r does; killing
// the process ends it.
func lines(r io.Reader) <-chan []byte {
	ch := make(chan []byte, 16)
	go func() {
		defer close(ch)
		br := bufio.NewReaderSize(r, 64<<10)
		for {
			line, err := br.ReadBytes('\n')
			if len(line) > maxLine {
				return
			}
			if len(line) > 0 {
				ch <- line
			}
			if err != nil {
				return
			}
		}
	}()
	return ch
}

// session is a running probe process with its lines.
type session struct {
	p     Process
	lines <-chan []byte
	cfg   timing
}

// timing is how long a probe may take.
type timing struct {
	// Timeout is how long the probe waits for the answer; Grace how long a
	// process gets to exit, after its stdin closes, before it is killed.
	Timeout, Grace time.Duration
}

func startSession(r Runner, c Cmd, t timing) (*session, error) {
	p, err := r.Start(c)
	if err != nil {
		return nil, startErr(err)
	}
	return &session{p: p, lines: lines(p.Stdout()), cfg: t}, nil
}

func (s *session) send(line string) error {
	_, err := io.WriteString(s.p.Stdin(), line+"\n")
	return err
}

// next returns the next line, or an error at the deadline (errTimeout),
// when the stream ends (io.EOF) or when ctx is done.
func (s *session) next(ctx context.Context, deadline <-chan time.Time) ([]byte, error) {
	select {
	case l, ok := <-s.lines:
		if !ok {
			return nil, io.EOF
		}
		return l, nil
	case <-deadline:
		return nil, errTimeout
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// finish closes stdin, gives the process its grace to exit, kills it if it
// does not, and reaps it; the process is gone when it returns.
func (s *session) finish() {
	_ = s.p.Stdin().Close()
	done := make(chan struct{})
	go func() {
		_ = s.p.Wait()
		close(done)
	}()
	t := time.NewTimer(s.cfg.Grace)
	defer t.Stop()
	select {
	case <-done:
	case <-t.C:
		s.p.Kill()
		<-done
	}
	for range s.lines { // the reader ends with the pipe
	}
}

var errTimeout = errors.New("timeout")
