// Package helper is the Mac-side h3d-helper: it keeps an SSH tunnel to the
// bridge's unix socket alive, serves the game bundle on loopback, and
// proxies the game's WebSocket to the bridge after checking Host, Origin
// and a per-start token.
package helper

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

// Tunnel states.
const (
	StateConnecting = "connecting" // ssh started, waiting for the bridge to answer through it
	StateUp         = "up"         // the bridge answers /healthz through the tunnel
	StateDegraded   = "degraded"   // ssh runs but the bridge stopped answering
	StateBackoff    = "backoff"    // waiting to restart ssh
	StateStopped    = "stopped"
)

// MaxSocketPath is the longest unix socket path we accept (macOS sun_path is
// 104 bytes including the NUL; Linux allows 108).
const MaxSocketPath = 103

// Backoff is exponential backoff with jitter: attempt n waits
// min(Max, Min·2ⁿ), scaled by a random factor in [1-Jitter, 1+Jitter].
type Backoff struct {
	Min, Max time.Duration
	Jitter   float64
}

// DefaultBackoff is the tunnel's restart backoff.
var DefaultBackoff = Backoff{Min: 500 * time.Millisecond, Max: 30 * time.Second, Jitter: 0.2}

// Delay is the wait before restart attempt n (0-based); r is uniform in [0, 1).
func (b Backoff) Delay(attempt int, r float64) time.Duration {
	d := b.Min
	for i := 0; i < attempt && d < b.Max; i++ {
		d *= 2
	}
	d = min(d, b.Max)
	return time.Duration(float64(d) * (1 + b.Jitter*(2*r-1)))
}

// Status is a snapshot of the tunnel's state.
type Status struct {
	State     string    `json:"state"`
	Since     time.Time `json:"since"`
	Restarts  int       `json:"restarts"`
	LastError string    `json:"last_error,omitempty"`
	PID       int       `json:"pid,omitempty"` // of the running ssh
	// Bridge is the bridge's build version from its /healthz: empty until the
	// first check, "unknown" for a bridge too old to report one.
	Bridge string `json:"bridge,omitempty"`
}

// Tunnel keeps `ssh -N -L Local:Remote Host` running and checks the bridge
// through it. It restarts ssh with backoff when it exits, fails to come up,
// or the bridge stops answering for a while, and kills it (its whole
// process group) when Run returns.
type Tunnel struct {
	SSH    string // ssh executable
	Host   string // [user@]host
	Remote string // the bridge socket on Host
	Local  string // local end of the forward (created by ssh, removed by us)
	Log    *slog.Logger

	Backoff        Backoff       // default DefaultBackoff
	StartTimeout   time.Duration // for a new ssh to get healthy (default 20s)
	HealthInterval time.Duration // between checks while up (default 5s)
	HealthFailures int           // consecutive failed checks that restart ssh (default 3)
	StableAfter    time.Duration // being up this long resets the backoff (default 30s)
	KillGrace      time.Duration // SIGTERM → SIGKILL (default 2s)

	// Tests hook these.
	wait func(ctx context.Context, d time.Duration) error
	rand func() float64

	mu     sync.Mutex
	status Status
}

// Args is the ssh command line (without the executable).
func (t *Tunnel) Args() []string {
	return []string{
		"-N", "-T",
		// Never become (or use) a shared ControlMaster: killing this ssh
		// must not take anyone's multiplexed sessions down (architecture §7).
		"-o", "ControlMaster=no", "-o", "ControlPath=none",
		"-o", "ExitOnForwardFailure=yes",
		"-o", "StreamLocalBindUnlink=yes", "-o", "StreamLocalBindMask=0177",
		"-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3",
		"-o", "ConnectTimeout=10", "-o", "BatchMode=yes",
		"-L", t.Local + ":" + t.Remote,
		t.Host,
	}
}

func (t *Tunnel) defaults() {
	if t.Log == nil {
		t.Log = slog.Default()
	}
	if t.Backoff == (Backoff{}) {
		t.Backoff = DefaultBackoff
	}
	if t.StartTimeout <= 0 {
		t.StartTimeout = 20 * time.Second
	}
	if t.HealthInterval <= 0 {
		t.HealthInterval = 5 * time.Second
	}
	if t.HealthFailures <= 0 {
		t.HealthFailures = 3
	}
	if t.StableAfter <= 0 {
		t.StableAfter = 30 * time.Second
	}
	if t.KillGrace <= 0 {
		t.KillGrace = 2 * time.Second
	}
	if t.wait == nil {
		t.wait = sleep
	}
	if t.rand == nil {
		t.rand = rand.Float64
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Status returns the current state.
func (t *Tunnel) Status() Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.status
}

func (t *Tunnel) set(state string, err error, pid int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.status.State != state {
		t.status.Since = time.Now()
	}
	t.status.State, t.status.PID = state, pid
	if err != nil {
		t.status.LastError = err.Error()
	}
}

// Dial connects to the bridge through the tunnel.
func (t *Tunnel) Dial(ctx context.Context) (net.Conn, error) {
	var d net.Dialer
	return d.DialContext(ctx, "unix", t.Local)
}

// Run supervises ssh until ctx is done. It only returns an error for a
// configuration it can never run with.
func (t *Tunnel) Run(ctx context.Context) error {
	t.defaults()
	if len(t.Local) > MaxSocketPath {
		return fmt.Errorf("local socket path is %d bytes, unix sockets allow %d: %s", len(t.Local), MaxSocketPath, t.Local)
	}
	defer t.set(StateStopped, nil, 0)
	attempt := 0
	for {
		up, err := t.runOnce(ctx)
		if ctx.Err() != nil {
			t.Log.Info("tunnel stopped")
			return nil
		}
		if up >= t.StableAfter {
			attempt = 0
		}
		d := t.Backoff.Delay(attempt, t.rand())
		attempt++
		t.mu.Lock()
		t.status.Restarts++
		t.mu.Unlock()
		t.set(StateBackoff, err, 0)
		t.Log.Warn("tunnel down, restarting", "err", err, "up_for", up.Round(time.Millisecond), "retry_in", d.Round(time.Millisecond), "attempt", attempt)
		if t.wait(ctx, d) != nil {
			t.Log.Info("tunnel stopped")
			return nil
		}
	}
}

// runOnce runs one ssh until it exits, never gets healthy, or stays
// unhealthy; it returns how long the tunnel was up.
func (t *Tunnel) runOnce(ctx context.Context) (time.Duration, error) {
	if err := prepareSocket(t.Local); err != nil {
		return 0, err
	}
	defer os.Remove(t.Local)
	p, err := t.start()
	if err != nil {
		return 0, err
	}
	defer p.stop(t.KillGrace)
	t.set(StateConnecting, nil, p.cmd.Process.Pid)
	t.Log.Info("tunnel connecting", "pid", p.cmd.Process.Pid, "host", t.Host, "remote", t.Remote, "local", t.Local)

	deadline := time.NewTimer(t.StartTimeout)
	defer deadline.Stop()
	poll := time.NewTicker(200 * time.Millisecond)
	for healthy := false; !healthy; {
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-p.done:
			return 0, p.exitErr()
		case <-deadline.C:
			return 0, fmt.Errorf("bridge not answering through the tunnel after %s: %w", t.StartTimeout, t.check(ctx))
		case <-poll.C:
			healthy = t.check(ctx) == nil
		}
	}
	poll.Stop()
	upAt := time.Now()
	t.set(StateUp, nil, p.cmd.Process.Pid)
	t.Log.Info("tunnel up", "pid", p.cmd.Process.Pid)

	tick := time.NewTicker(t.HealthInterval)
	defer tick.Stop()
	fails := 0
	for {
		select {
		case <-ctx.Done():
			return time.Since(upAt), ctx.Err()
		case <-p.done:
			return time.Since(upAt), p.exitErr()
		case <-tick.C:
			err := t.check(ctx)
			switch {
			case err == nil && fails > 0:
				fails = 0
				t.set(StateUp, nil, p.cmd.Process.Pid)
				t.Log.Info("tunnel healthy again")
			case err != nil:
				fails++
				if fails == 1 {
					t.set(StateDegraded, err, p.cmd.Process.Pid)
					t.Log.Warn("bridge not answering through the tunnel", "err", err)
				}
				if fails >= t.HealthFailures {
					return time.Since(upAt), fmt.Errorf("bridge not answering through the tunnel (%d checks): %w", fails, err)
				}
			}
		}
	}
}

// check asks the bridge's /healthz through the tunnel.
func (t *Tunnel) check(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c := &http.Client{Transport: &http.Transport{
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return t.Dial(ctx) },
		DisableKeepAlives: true,
	}}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://herdr-world/healthz", nil)
	if err != nil {
		return err
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(string(body)) != "ok" {
		return fmt.Errorf("healthz: %s %q", resp.Status, body)
	}
	t.noteBridge(resp.Header.Get(proto.VersionHeader))
	return nil
}

// noteBridge records the bridge's version and logs when it changes: a warning
// if it is not the helper's own (the two ship in one release, so they should
// match).
func (t *Tunnel) noteBridge(v string) {
	if v == "" {
		v = "unknown"
	}
	t.mu.Lock()
	changed := t.status.Bridge != v
	t.status.Bridge = v
	t.mu.Unlock()
	switch {
	case !changed:
	case v == "unknown":
		t.Log.Warn("bridge does not report its version (older release)", "helper", version.Version)
	case v != version.Version:
		t.Log.Warn("bridge and helper versions differ", "bridge", v, "helper", version.Version)
	default:
		t.Log.Info("bridge version", "version", v)
	}
}

// prepareSocket makes the socket's directory (0700) and removes a leftover
// socket from an earlier run. Anything else at that path is an error.
func prepareSocket(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("%s exists and is not a socket", path)
	}
	return os.Remove(path)
}

// proc is one running ssh.
type proc struct {
	cmd  *exec.Cmd
	done chan struct{} // closed when it exited
	err  error
}

func (t *Tunnel) start() (*proc, error) {
	cmd := exec.Command(t.SSH, t.Args()...)
	// Own process group, so stop() takes anything ssh spawned with it.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = &lineLog{log: t.Log}
	cmd.WaitDelay = time.Second
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", t.SSH, err)
	}
	p := &proc{cmd: cmd, done: make(chan struct{})}
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	return p, nil
}

func (p *proc) exitErr() error {
	if p.err == nil {
		return errors.New("ssh exited")
	}
	return fmt.Errorf("ssh exited: %w", p.err)
}

// stop terminates ssh's process group: SIGTERM, then SIGKILL after grace.
func (p *proc) stop(grace time.Duration) {
	pgid := -p.cmd.Process.Pid
	select {
	case <-p.done:
		_ = syscall.Kill(pgid, syscall.SIGKILL) // stragglers in its group
		return
	default:
	}
	_ = syscall.Kill(pgid, syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(grace):
		_ = syscall.Kill(pgid, syscall.SIGKILL)
		<-p.done
	}
}

// lineLog logs each line ssh writes to stderr.
type lineLog struct {
	log *slog.Logger
	buf []byte
}

func (l *lineLog) Write(b []byte) (int, error) {
	l.buf = append(l.buf, b...)
	for {
		i := bytes.IndexByte(l.buf, '\n')
		if i < 0 {
			break
		}
		if line := string(bytes.TrimSpace(l.buf[:i])); line != "" {
			l.log.Warn("ssh: " + line)
		}
		l.buf = l.buf[i+1:]
	}
	if len(l.buf) > 4096 { // no newline in sight: flush it anyway
		l.log.Warn("ssh: " + string(bytes.TrimSpace(l.buf)))
		l.buf = l.buf[:0]
	}
	return len(b), nil
}
