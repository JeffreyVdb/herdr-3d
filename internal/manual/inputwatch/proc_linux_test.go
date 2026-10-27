//go:build linux

package inputwatch

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// openPty is a new pseudo-terminal pair (no library: /dev/ptmx).
func openPty(t testing.TB) (master, slave *os.File) {
	t.Helper()
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Skipf("no ptmx: %v", err)
	}
	var unlock int32
	if _, _, e := unix.Syscall(unix.SYS_IOCTL, m.Fd(), unix.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); e != 0 {
		t.Fatal(e)
	}
	n, err := unix.IoctlGetInt(int(m.Fd()), unix.TIOCGPTN)
	if err != nil {
		t.Fatal(err)
	}
	s, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", n), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Close(); _ = s.Close() })
	return m, s
}

// runOnPty starts script as the session leader of a new pty, its controlling
// terminal (like a herdr pane, except that the test is its parent).
func runOnPty(t testing.TB, script string) (*exec.Cmd, *os.File) {
	t.Helper()
	m, s := openPty(t)
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = s, s, s
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })
	go func() { // drain the output so nothing blocks on it
		b := make([]byte, 4096)
		for {
			if _, err := m.Read(b); err != nil {
				return
			}
		}
	}()
	return cmd, m
}

func runOf(t testing.TB, pid int) Run {
	t.Helper()
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		t.Fatal(err)
	}
	st, err := parseStat(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return Run{PID: pid, StartTicks: st.start}
}

// observeUntil samples until want holds or 3 s pass.
func observeUntil(t *testing.T, run Run, want func(Observation) bool) Observation {
	t.Helper()
	d := &Detector{Proc: System()}
	var o Observation
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
		o = d.Observe(map[string]Run{"r": run})["r"]
		if want(o) {
			return o
		}
	}
	t.Fatalf("last observation %+v", o)
	return o
}

// The real kernel, for a run the test started (its parent may read the
// syscall files despite Yama 1): a line read is confirmed, a sleep is not,
// a /dev/tty read in a pipeline's non-leader is confirmed, raw mode is not
// reported.
func TestSystemObservesARealPty(t *testing.T) {
	if _, err := os.Stat("/proc/self/syscall"); err != nil {
		t.Skip("no /proc syscall files")
	}
	cmd, _ := runOnPty(t, "read x")
	run := runOf(t, cmd.Process.Pid)
	o := observeUntil(t, run, func(o Observation) bool { return o.Positive() })
	if !o.Live || o.Detection != Full || o.Confidence != Confirmed || o.Reason != TTYRead {
		t.Fatalf("read: %+v", o)
	}

	cmd, _ = runOnPty(t, "sleep 30")
	run = runOf(t, cmd.Process.Pid)
	time.Sleep(200 * time.Millisecond)
	if o := (&Detector{Proc: System()}).Observe(map[string]Run{"r": run})["r"]; !o.Live || o.Positive() {
		t.Fatalf("sleep: %+v", o)
	}

	cmd, _ = runOnPty(t, "sleep 30 | (read x </dev/tty)")
	run = runOf(t, cmd.Process.Pid)
	if o := observeUntil(t, run, func(o Observation) bool { return o.Positive() }); o.Confidence != Confirmed {
		t.Fatalf("pipeline: %+v", o)
	}

	cmd, _ = runOnPty(t, "stty raw -echo; read x")
	run = runOf(t, cmd.Process.Pid)
	if o := observeUntil(t, run, func(o Observation) bool { return o.Suppressed == "tui" }); o.Positive() {
		t.Fatalf("raw mode: %+v", o)
	}
}

// What a herdr run looks like on this host: a process the observer did not
// start. Here that is approximated by this test's own process, whose
// syscall file it may always read; the denied case is covered by the fakes
// (contract D2). This only checks the detection level is reported.
func TestSystemDetectionLevel(t *testing.T) {
	cmd, _ := runOnPty(t, "sleep 30")
	run := runOf(t, cmd.Process.Pid)
	o := (&Detector{Proc: System()}).Observe(map[string]Run{"r": run})["r"]
	if _, err := os.ReadFile(fmt.Sprintf("/proc/%d/syscall", run.PID)); err == nil && o.Detection != Full {
		t.Fatalf("readable syscall, detection %q", o.Detection)
	} else if err != nil && o.Detection != Hints {
		t.Fatalf("denied syscall (%v), detection %q", err, o.Detection)
	}
	if !strings.Contains("full hints", o.Detection) {
		t.Fatal(o.Detection)
	}
}

// BenchmarkObserveSystem is one sample of n runs on the live /proc: one
// process table scan shared by every run.
func BenchmarkObserveSystem(b *testing.B) {
	runs := map[string]Run{}
	for i := 0; i < 3; i++ {
		cmd, _ := runOnPty(b, "read x")
		runs[fmt.Sprint(i)] = runOf(b, cmd.Process.Pid)
	}
	time.Sleep(200 * time.Millisecond)
	d := &Detector{Proc: System()}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		d.Observe(runs)
	}
}
