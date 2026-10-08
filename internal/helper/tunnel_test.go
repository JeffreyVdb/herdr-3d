package helper

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/version"
)

func TestBackoffDelay(t *testing.T) {
	b := Backoff{Min: 100 * time.Millisecond, Max: time.Second, Jitter: 0.2}
	var got []time.Duration
	for n := range 6 {
		got = append(got, b.Delay(n, 0.5)) // r = 0.5: no jitter
	}
	want := []time.Duration{100, 200, 400, 800, 1000, 1000}
	for i := range want {
		want[i] *= time.Millisecond
	}
	if !slices.Equal(got, want) {
		t.Fatalf("delays = %v, want %v", got, want)
	}
	if lo, hi := b.Delay(3, 0), b.Delay(3, 0.999999); lo != 640*time.Millisecond || hi < 959*time.Millisecond || hi > 960*time.Millisecond {
		t.Fatalf("jitter range = %v..%v, want 640ms..960ms", lo, hi)
	}
	if d := b.Delay(1000, 0.5); d != time.Second {
		t.Fatalf("huge attempt = %v", d)
	}
}

// recorder captures backoff waits (and still waits, briefly).
type recorder struct {
	mu     sync.Mutex
	delays []time.Duration
}

func (r *recorder) wait(ctx context.Context, d time.Duration) error {
	r.mu.Lock()
	r.delays = append(r.delays, d)
	r.mu.Unlock()
	return sleep(ctx, d)
}

func (r *recorder) all() []time.Duration {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.delays)
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// TestTunnelRestartsWithBackoff drives the supervisor with a fake ssh
// through: failing starts (exponential backoff), coming up, its ssh being
// killed (restart, backoff reset because it had been up a while), the
// bridge going away (degraded, then restart) and coming back, and shutdown
// (ssh killed, socket removed).
func TestTunnelRestartsWithBackoff(t *testing.T) {
	dir := shortDir(t)
	ctl := filepath.Join(dir, "ctl")
	if err := os.WriteFile(ctl, []byte("fail"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(fakeSSHEnv, ctl)
	bridgeSock := filepath.Join(dir, "remote", "bridge.sock")
	stopBridge := startBridge(t, bridgeSock)

	rec := &recorder{}
	tun := &Tunnel{
		SSH: os.Args[0], Host: "dev@example", Remote: bridgeSock, Local: filepath.Join(dir, "local", "bridge.sock"),
		Log:          quietLog(),
		Backoff:      Backoff{Min: 20 * time.Millisecond, Max: 80 * time.Millisecond, Jitter: 0.2},
		StartTimeout: 500 * time.Millisecond, HealthInterval: 20 * time.Millisecond, HealthFailures: 2,
		StableAfter: 200 * time.Millisecond,
		wait:        rec.wait, rand: func() float64 { return 0.5 },
	}
	ctx, cancel := context.WithCancel(context.Background())
	var runErr error
	stopped := make(chan struct{})
	go func() { runErr = tun.Run(ctx); close(stopped) }()
	t.Cleanup(func() { cancel(); <-stopped })

	// ssh keeps failing: 20, 40, 80, 80 ms.
	waitFor(t, "four failed starts", func() bool { return len(rec.all()) >= 4 })
	if got := rec.all()[:4]; !slices.Equal(got, []time.Duration{20e6, 40e6, 80e6, 80e6}) {
		t.Fatalf("backoff = %v", got)
	}
	if st := tun.Status(); !strings.Contains(st.LastError, "ssh exited") {
		t.Fatalf("status = %+v", st)
	}
	args, _ := os.ReadFile(ctl + ".args")
	for _, want := range []string{"-N", "ControlMaster=no", "ControlPath=none", "ExitOnForwardFailure=yes", "ServerAliveInterval=10",
		"-L\n" + tun.Local + ":" + bridgeSock + "\njeff@example"} {
		if !strings.Contains(string(args), want) {
			t.Errorf("ssh args lack %q:\n%s", want, args)
		}
	}

	// ssh works now: up.
	if err := os.WriteFile(ctl, []byte("forward"), 0o600); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "tunnel up", func() bool { return tun.Status().State == StateUp })
	first := tun.Status()
	if err := tun.check(ctx); err != nil {
		t.Fatalf("bridge through the tunnel: %v", err)
	}

	// Its ssh is killed after being up longer than StableAfter: it comes
	// back, and the backoff starts over at Min.
	time.Sleep(250 * time.Millisecond)
	n := len(rec.all())
	if err := syscall.Kill(first.PID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "tunnel back up with a new ssh", func() bool {
		st := tun.Status()
		return st.State == StateUp && st.PID != first.PID
	})
	if d := rec.all()[n]; d != 20*time.Millisecond {
		t.Fatalf("delay after a stable run = %v, want the minimum", d)
	}
	if got := tun.Status().Restarts; got != first.Restarts+1 {
		t.Fatalf("restarts = %d, want %d", got, first.Restarts+1)
	}

	// The bridge goes away: degraded, then ssh is restarted (and cannot get
	// healthy until the bridge is back).
	second := tun.Status()
	stopBridge()
	waitFor(t, "degraded", func() bool { return tun.Status().State != StateUp })
	waitFor(t, "ssh restarted", func() bool { return tun.Status().Restarts > second.Restarts })
	if alive(second.PID) {
		t.Fatalf("the unhealthy ssh %d was not killed", second.PID)
	}
	startBridge(t, bridgeSock)
	waitFor(t, "tunnel up again", func() bool { return tun.Status().State == StateUp })

	// Shutdown kills ssh and removes the local socket.
	last := tun.Status().PID
	cancel()
	if <-stopped; runErr != nil {
		t.Fatal(runErr)
	}
	if alive(last) {
		t.Fatalf("ssh %d survived the helper", last)
	}
	if _, err := os.Lstat(tun.Local); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("local socket left behind: %v", err)
	}
	if st := tun.Status(); st.State != StateStopped {
		t.Fatalf("state = %+v", st)
	}
}

func TestTunnelRemovesStaleSocketAndRefusesOtherFiles(t *testing.T) {
	dir := shortDir(t)
	stale := filepath.Join(dir, "stale.sock")
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: stale, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	ln.SetUnlinkOnClose(false)
	ln.Close() // leaves the socket file, like a crashed ssh
	if err := prepareSocket(stale); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale socket still there: %v", err)
	}
	plain := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(plain, []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := prepareSocket(plain); err == nil {
		t.Fatal("a regular file at the socket path was accepted")
	}
	tun := &Tunnel{Local: "/" + strings.Repeat("x", MaxSocketPath), Log: quietLog()}
	if err := tun.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "unix sockets allow") {
		t.Fatalf("long socket path: %v", err)
	}
}

func TestNoteBridgeVersion(t *testing.T) {
	var buf strings.Builder
	tun := &Tunnel{Log: slog.New(slog.NewTextHandler(&buf, nil))}

	tun.noteBridge(version.Version)
	if got := tun.Status().Bridge; got != version.Version {
		t.Fatalf("Bridge = %q, want %q", got, version.Version)
	}
	if strings.Contains(buf.String(), "WARN") {
		t.Errorf("matching versions warned: %s", buf.String())
	}

	buf.Reset()
	tun.noteBridge(version.Version) // unchanged: silent
	if buf.Len() != 0 {
		t.Errorf("repeat logged: %s", buf.String())
	}

	tun.noteBridge("v9.9.9-other")
	if !strings.Contains(buf.String(), "versions differ") || tun.Status().Bridge != "v9.9.9-other" {
		t.Errorf("mismatch: status %q, log %q", tun.Status().Bridge, buf.String())
	}

	buf.Reset()
	tun.noteBridge("") // a bridge from before the header existed
	if !strings.Contains(buf.String(), "does not report") || tun.Status().Bridge != "unknown" {
		t.Errorf("old bridge: status %q, log %q", tun.Status().Bridge, buf.String())
	}
}

// #184: the hosts the bridge trusts come from its /healthz header: only
// plain host names, and none once the header is gone.
func TestNoteOpenHosts(t *testing.T) {
	tun := &Tunnel{Log: quietLog()}
	tun.noteOpenHosts("Tasks.Example.Test, bad host, https://x.test, x.test:443, ,-bad.test, ok-2.example.test, tasks.example.test")
	if got := tun.Status().OpenHosts; !slices.Equal(got, []string{"tasks.example.test", "ok-2.example.test"}) {
		t.Fatalf("hosts = %q", got)
	}
	tun.noteOpenHosts("")
	if got := tun.Status().OpenHosts; len(got) != 0 {
		t.Fatalf("hosts after the header went = %q", got)
	}
}
