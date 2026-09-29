package limits

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProc is a process whose behaviour is a script over its pipes.
type fakeProc struct {
	in        *os.File // what the probe writes
	inW       *os.File
	out       *os.File // what the probe reads
	outR      *os.File
	killed    chan struct{}
	done      chan struct{}
	once      sync.Once
	wasKilled bool
	mu        sync.Mutex
}

// script runs as the process: it reads p.lines() and writes p.say.
type script func(p *fakeProc)

func (p *fakeProc) Stdin() io.WriteCloser { return p.inW }
func (p *fakeProc) Stdout() io.Reader     { return p.outR }
func (p *fakeProc) Wait() error           { <-p.done; return nil }
func (p *fakeProc) Kill() {
	p.once.Do(func() {
		p.mu.Lock()
		p.wasKilled = true
		p.mu.Unlock()
		close(p.killed)
		p.in.Close()
		p.out.Close()
	})
}
func (p *fakeProc) didKill() bool { p.mu.Lock(); defer p.mu.Unlock(); return p.wasKilled }

// say writes lines the probe will read.
func (p *fakeProc) say(lines ...string) {
	for _, l := range lines {
		_, _ = io.WriteString(p.out, l+"\n")
	}
}

// reader reads what the probe writes, line by line, until its stdin closes.
func (p *fakeProc) reader() *bufio.Scanner { return bufio.NewScanner(p.in) }

// waitStdinClosed blocks until the probe closes stdin (or is killed).
func (p *fakeProc) waitStdinClosed() { _, _ = io.Copy(io.Discard, p.in) }

// hang blocks until the process is killed, ignoring stdin.
func (p *fakeProc) hang() { <-p.killed }

type fakeRunner struct {
	mu      sync.Mutex
	scripts map[string]script // by executable
	Started []Cmd
	procs   []*fakeProc
	// dirSeen records whether each started process's Dir existed then.
	dirSeen []bool
}

func newRunner(s map[string]script) *fakeRunner { return &fakeRunner{scripts: s} }

func (r *fakeRunner) Start(c Cmd) (Process, error) {
	r.mu.Lock()
	sc, ok := r.scripts[c.Path]
	r.Started = append(r.Started, c)
	r.mu.Unlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	in, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, out, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	p := &fakeProc{in: in, inW: inW, out: out, outR: outR, killed: make(chan struct{}), done: make(chan struct{})}
	st, err := os.Stat(c.Dir)
	r.mu.Lock()
	r.procs = append(r.procs, p)
	r.dirSeen = append(r.dirSeen, err == nil && st.IsDir())
	r.mu.Unlock()
	go func() {
		defer close(p.done)
		sc(p)
		p.out.Close()
		p.in.Close()
	}()
	return p, nil
}

func (r *fakeRunner) started(path string) []Cmd {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Cmd
	for _, c := range r.Started {
		if c.Path == path {
			out = append(out, c)
		}
	}
	return out
}

func fixture(t testing.TB, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimRight(string(b), "\n")
}

// claudeAnswers reads the request line, checks it, says the fixture's
// lines and waits for stdin to close, as claude does.
func claudeAnswers(t testing.TB, name string) script {
	return func(p *fakeProc) {
		sc := p.reader()
		if !sc.Scan() || sc.Text() != claudeRequest {
			t.Errorf("claude got %q, want the get_usage request", sc.Text())
		}
		p.say(strings.Split(fixture(t, name), "\n")...)
		p.waitStdinClosed()
	}
}

// codexAnswers plays app-server: initialize, initialized, read.
func codexAnswers(t testing.TB, result string) script {
	return func(p *fakeProc) {
		sc := p.reader()
		var got []string
		for sc.Scan() && len(got) < 3 {
			got = append(got, sc.Text())
			switch len(got) {
			case 1:
				if !strings.Contains(got[0], `"method":"initialize"`) {
					t.Errorf("first line %q, want initialize", got[0])
				}
				p.say(`{"id":1,"result":{"userAgent":"x","codexHome":"/x"}}`, `{"method":"remoteControl/status/changed","params":{}}`)
			case 2:
				if !strings.Contains(got[1], `"method":"initialized"`) || strings.Contains(got[1], `"id"`) {
					t.Errorf("second line %q, want the initialized notification", got[1])
				}
			case 3:
				if !strings.Contains(got[2], `"method":"account/rateLimits/read"`) {
					t.Errorf("third line %q, want account/rateLimits/read", got[2])
				}
				p.say(`{"id":2,"result":` + result + `}`)
			}
		}
		p.waitStdinClosed()
	}
}

func fastCfg(r Runner) Config {
	return Config{Runner: r, ClaudeBin: "claude", CodexBin: "codex", Timeout: 80 * time.Millisecond, Grace: 80 * time.Millisecond,
		Env: func() []string {
			return []string{"PATH=/bin", "CLAUDECODE=1", "CLAUDECODE_X=2", "HERDR_ENV=1", "CLAUDE_CONFIG_DIR=/c"}
		}}
}
