package inputwatch

import (
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

// fakeProc is a process table: each process has a stat, tasks with their
// state, syscall (or a permission error) and wchan, and descriptors.
type fakeProc struct {
	procs     map[int]*fakeProcess
	denied    bool // every syscall file is EPERM (Yama ptrace_scope 1)
	noKids    bool // children files are missing (no CONFIG_PROC_CHILDREN): full scan
	raw       bool // the run's tty is out of canonical mode
	canonical int  // Canonical calls
}

type fakeProcess struct {
	comm                            string
	state                           byte
	ppid, pgrp, session, tty, tpgid int
	start                           uint64
	tasks                           map[int]*fakeTask
	fds                             map[int]uint64 // fd → rdev; 0: not a character device
	private                         bool           // a setuid process: nothing but stat is readable
	kidsHidden                      bool           // its children cannot be listed
}

type fakeTask struct {
	state   byte
	syscall string // "" with denied: EPERM
	wchan   string
}

const (
	runTTY   = 0x8805 // /dev/pts/5
	otherTTY = 0x8806
)

var (
	pts5    = unix.Mkdev(136, 5)
	pts6    = unix.Mkdev(136, 6)
	devTTY  = unix.Mkdev(5, 0)
	readNr  = unix.SYS_READ
	readvNr = unix.SYS_READV
)

func (f *fakeProc) PIDs() ([]int, error) {
	var out []int
	for pid := range f.procs {
		out = append(out, pid)
	}
	return out, nil
}
func (f *fakeProc) statOf(p *fakeProcess, state byte) string {
	return fmt.Sprintf("1 (%s) %c %d %d %d %d %d 0 0 0 0 0 0 0 0 0 0 0 0 0 %d 0 0", p.comm, state, p.ppid, p.pgrp, p.session, p.tty, p.tpgid, p.start)
}
func (f *fakeProc) Stat(pid int) (string, error) {
	p := f.procs[pid]
	if p == nil {
		return "", os.ErrNotExist
	}
	return f.statOf(p, p.state), nil
}
func (f *fakeProc) Tasks(pid int) ([]int, error) {
	p := f.procs[pid]
	if p == nil {
		return nil, os.ErrNotExist
	}
	if len(p.tasks) == 0 {
		return []int{pid}, nil
	}
	var out []int
	for tid := range p.tasks {
		out = append(out, tid)
	}
	return out, nil
}
func (f *fakeProc) task(pid, tid int) (*fakeProcess, *fakeTask) {
	p := f.procs[pid]
	if p == nil {
		return nil, nil
	}
	if t := p.tasks[tid]; t != nil {
		return p, t
	}
	if tid == pid {
		return p, &fakeTask{state: p.state, syscall: "running"}
	}
	return p, nil
}
func (f *fakeProc) TaskStat(pid, tid int) (string, error) {
	p, t := f.task(pid, tid)
	if t == nil {
		return "", os.ErrNotExist
	}
	return f.statOf(p, t.state), nil
}
func (f *fakeProc) Syscall(pid, tid int) (string, error) {
	p, t := f.task(pid, tid)
	if t == nil {
		return "", os.ErrNotExist
	}
	if f.denied || p.private || t.syscall == "" {
		return "", os.ErrPermission
	}
	return t.syscall, nil
}
func (f *fakeProc) Wchan(pid, tid int) (string, error) {
	p, t := f.task(pid, tid)
	if t == nil || p.private {
		return "", os.ErrPermission
	}
	return t.wchan, nil
}
func (f *fakeProc) Children(pid, tid int) ([]int, error) {
	if f.noKids || f.procs[pid] == nil || f.procs[pid].kidsHidden {
		return nil, os.ErrNotExist
	}
	var out []int
	if tid != pid {
		return out, nil
	}
	for child, p := range f.procs {
		if p.ppid == pid {
			out = append(out, child)
		}
	}
	return out, nil
}
func (f *fakeProc) FDs(pid int) ([]int, error) {
	p := f.procs[pid]
	if p == nil || p.private {
		return nil, os.ErrPermission
	}
	var out []int
	for fd := range p.fds {
		out = append(out, fd)
	}
	return out, nil
}
func (f *fakeProc) Device(pid, fd int) (uint64, bool, error) {
	p := f.procs[pid]
	if p == nil || p.private {
		return 0, false, os.ErrPermission
	}
	rdev, ok := p.fds[fd]
	if !ok {
		return 0, false, os.ErrNotExist
	}
	return rdev, rdev != 0, nil
}
func (f *fakeProc) Canonical(pid, fd int) (bool, error) {
	f.canonical++
	if rdev := f.procs[pid].fds[fd]; rdev == devTTY {
		return false, fmt.Errorf("a /dev/tty descriptor must never be reopened")
	}
	return !f.raw, nil
}

// launcher (100) runs `sh -c` (101) in the run tty's foreground group 100.
func newRun() *fakeProc {
	f := &fakeProc{procs: map[int]*fakeProcess{}}
	f.add(100, &fakeProcess{comm: "herdr-world", state: 'S', ppid: 1, pgrp: 100, session: 100, tty: runTTY, tpgid: 100, start: 4242,
		tasks: map[int]*fakeTask{100: {state: 'S', syscall: fmt.Sprintf("%d 0xffffffff 0x0", unix.SYS_WAIT4), wchan: "do_wait"}},
		fds:   map[int]uint64{0: pts5, 1: pts5, 2: pts5}})
	f.add(101, &fakeProcess{comm: "sh", state: 'S', ppid: 100, pgrp: 100, session: 100, tty: runTTY, tpgid: 100, start: 4243,
		tasks: map[int]*fakeTask{101: {state: 'S', syscall: fmt.Sprintf("%d 0xffffffff 0x0", unix.SYS_WAIT4), wchan: "do_wait"}},
		fds:   map[int]uint64{0: pts5, 1: pts5, 2: pts5}})
	return f
}

func (f *fakeProc) add(pid int, p *fakeProcess) { f.procs[pid] = p }

// fg adds a foreground process of the run (child of sh) in one task.
func (f *fakeProc) fg(pid int, comm string, state byte, syscall, wchan string, fds map[int]uint64) *fakeProcess {
	p := &fakeProcess{comm: comm, state: state, ppid: 101, pgrp: 100, session: 100, tty: runTTY, tpgid: 100, start: uint64(5000 + pid),
		tasks: map[int]*fakeTask{pid: {state: state, syscall: syscall, wchan: wchan}}, fds: fds}
	f.add(pid, p)
	return p
}

func call(nr int, fd int) string { return fmt.Sprintf("%d 0x%x 0x7ffd1000 0x1 0x0 0x0 0x0 0x7ffd0ff8 0x7f00", nr, fd) }

var stdio = map[int]uint64{0: pts5, 1: pts5, 2: pts5}

func observe(t *testing.T, f *fakeProc) Observation {
	t.Helper()
	d := &Detector{Proc: f}
	return d.Observe(map[string]Run{"mp_1": {PID: 100, StartTicks: 4242}})["mp_1"]
}

// The cases of ground-input.md Part A (#213), with syscalls readable (a
// parent-owned run) and denied (Yama ptrace_scope 1, this host's herdr runs).
func TestObserveMatrix(t *testing.T) {
	type want struct{ confidence, reason, suppressed string }
	cases := []struct {
		name          string
		setup         func(f *fakeProc)
		full, limited want
	}{
		{"bash read -p", func(f *fakeProc) { f.fg(200, "bash", 'S', call(readNr, 0), "wait_woken", stdio) },
			want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"apt-style Y/n read", func(f *fakeProc) { f.fg(200, "apt", 'S', call(readNr, 0), "wait_woken", stdio) },
			want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"python input()", func(f *fakeProc) { f.fg(200, "python3", 'S', call(readNr, 0), "wait_woken", stdio) },
			want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"read -s (echo off: not consulted)", func(f *fakeProc) { f.fg(200, "bash", 'S', call(readNr, 0), "wait_woken", stdio) },
			want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"getpass on /dev/tty fd 3", func(f *fakeProc) {
			f.fg(200, "python3", 'S', call(readNr, 3), "wait_woken", map[int]uint64{0: pts5, 1: pts5, 2: pts5, 3: devTTY})
		}, want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"ssh-keygen -p on /dev/tty only", func(f *fakeProc) {
			f.fg(200, "ssh-keygen", 'S', call(readNr, 3), "wait_woken", map[int]uint64{0: 0, 1: 0, 2: pts5, 3: devTTY})
		}, want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"readv on the tty", func(f *fakeProc) { f.fg(200, "prog", 'S', call(readvNr, 0), "wait_woken", stdio) },
			want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"sudo terminal prompt (setuid: nothing readable)", func(f *fakeProc) {
			f.fg(200, "sudo", 'S', "", "", stdio).private = true
		}, want{Uncertain, SudoTerminal, ""}, want{Uncertain, SudoTerminal, ""}},
		{"sudo running its command", func(f *fakeProc) {
			f.fg(200, "sudo", 'S', "", "", stdio).private = true
			f.add(300, &fakeProcess{comm: "sudo", state: 'S', ppid: 200, pgrp: 300, session: 300, tty: otherTTY, tpgid: 300, start: 1, private: true})
		}, want{}, want{}},
		{"cat (splice on the tty)", func(f *fakeProc) { f.fg(200, "cat", 'S', call(unix.SYS_SPLICE, 0), "wait_woken", stdio) },
			want{}, want{Uncertain, TTYWait, ""}},
		{"sleep 30", func(f *fakeProc) {
			f.fg(200, "sleep", 'S', call(unix.SYS_CLOCK_NANOSLEEP, 0), "hrtimer_nanosleep", stdio)
		}, want{}, want{}},
		{"busy loop", func(f *fakeProc) { f.fg(200, "bash", 'R', "running", "0", stdio) }, want{}, want{}},
		{"less (a known pager)", func(f *fakeProc) {
			f.fg(200, "less", 'S', call(readNr, 3), "wait_woken", map[int]uint64{0: pts5, 1: pts5, 2: pts5, 3: devTTY})
		}, want{"", "", "tui"}, want{"", "", "tui"}},
		{"vim (a known editor)", func(f *fakeProc) { f.fg(200, "vim", 'S', call(readNr, 0), "wait_woken", stdio) },
			want{"", "", "tui"}, want{"", "", "tui"}},
		{"unknown full-screen program in raw mode", func(f *fakeProc) {
			f.raw = true
			f.fg(200, "mytui", 'S', call(readNr, 0), "wait_woken", stdio)
		}, want{"", "", "tui"}, want{"", "", "tui"}},
		{"sleep 30 | (read x </dev/tty): a non-leader reads", func(f *fakeProc) {
			f.fg(200, "sleep", 'S', call(unix.SYS_CLOCK_NANOSLEEP, 0), "hrtimer_nanosleep", stdio)
			f.fg(201, "bash", 'S', call(readNr, 0), "wait_woken", map[int]uint64{0: devTTY, 1: pts5, 2: pts5})
		}, want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"cat & sleep 30: the background reader is stopped in its own group", func(f *fakeProc) {
			f.fg(200, "sleep", 'S', call(unix.SYS_CLOCK_NANOSLEEP, 0), "hrtimer_nanosleep", stdio)
			bg := f.fg(201, "cat", 'T', call(readNr, 0), "do_signal_stop", stdio)
			bg.pgrp = 201
		}, want{}, want{}},
		{"background reader in its own group, not stopped", func(f *fakeProc) {
			bg := f.fg(201, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
			bg.pgrp = 201
		}, want{}, want{}},
		{"sleep 30 | cat: cat reads a pipe", func(f *fakeProc) {
			f.fg(200, "sleep", 'S', call(unix.SYS_CLOCK_NANOSLEEP, 0), "hrtimer_nanosleep", stdio)
			f.fg(201, "cat", 'S', call(readNr, 0), "pipe_read", map[int]uint64{0: 0, 1: pts5, 2: pts5})
		}, want{}, want{}},
		{"socket wait with a tty stdout only", func(f *fakeProc) {
			f.fg(200, "curl", 'S', call(readNr, 5), "wait_woken", map[int]uint64{0: 0, 1: pts5, 2: pts5, 5: 0})
		}, want{}, want{Uncertain, TTYWait, ""}},
		{"reads another tty", func(f *fakeProc) {
			f.fg(200, "bash", 'S', call(readNr, 0), "wait_woken", map[int]uint64{0: pts6})
		}, want{}, want{}},
		{"/dev/tty of a process whose controlling tty is another", func(f *fakeProc) {
			p := f.fg(200, "bash", 'S', call(readNr, 3), "wait_woken", map[int]uint64{3: devTTY})
			p.tty = otherTTY
		}, want{}, want{}},
		{"a second thread reads", func(f *fakeProc) {
			p := f.fg(200, "app", 'S', call(unix.SYS_FUTEX, 0), "futex_wait_queue", stdio)
			p.tasks[201] = &fakeTask{state: 'S', syscall: call(readNr, 0), wchan: "wait_woken"}
		}, want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"the foreground group moved to a job's own group", func(f *fakeProc) {
			for _, pid := range []int{100, 101} {
				f.procs[pid].tpgid = 400
			}
			p := f.fg(400, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
			p.pgrp, p.tpgid = 400, 400
		}, want{Confirmed, TTYRead, ""}, want{Uncertain, TTYWait, ""}},
		{"same group number in another session", func(f *fakeProc) {
			p := f.fg(200, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
			p.session = 999
		}, want{}, want{}},
		{"nothing but the launcher", func(*fakeProc) {}, want{}, want{}},
	}
	for _, c := range cases {
		for _, mode := range []string{"syscalls readable", "syscalls denied", "no children files"} {
			denied := mode == "syscalls denied"
			w := c.full
			if denied {
				w = c.limited
			}
			t.Run(c.name+" ("+mode+")", func(t *testing.T) {
				f := newRun()
				f.denied, f.noKids = denied, mode == "no children files"
				c.setup(f)
				o := observe(t, f)
				detection := Full
				if denied {
					detection = Hints
				}
				if !o.Live || o.Detection != detection {
					t.Fatalf("live %v detection %q, want %q", o.Live, o.Detection, detection)
				}
				if o.Confidence != w.confidence || o.Reason != w.reason || o.Suppressed != w.suppressed {
					t.Fatalf("got %q/%q suppressed %q, want %q/%q suppressed %q", o.Confidence, o.Reason, o.Suppressed, w.confidence, w.reason, w.suppressed)
				}
				if o.Positive() != (w.confidence != "") {
					t.Fatal("Positive disagrees")
				}
			})
		}
	}
}

// A confirmed read wins over an uncertain hint in the same group.
func TestObserveConfirmedWins(t *testing.T) {
	f := newRun()
	f.fg(200, "sudo", 'S', "", "", stdio).private = true
	f.fg(201, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
	if o := observe(t, f); o.Confidence != Confirmed || o.Reason != TTYRead {
		t.Fatalf("%+v", o)
	}
}

// A sudo whose children cannot be listed is not called childless.
func TestObserveSudoWithHiddenChildren(t *testing.T) {
	f := newRun()
	p := f.fg(200, "sudo", 'S', "", "", stdio)
	p.private, p.kidsHidden = true, true
	if o := observe(t, f); o.Positive() {
		t.Fatalf("%+v", o)
	}
}

// The launcher's identity: a reused PID (other start ticks), a gone one, a
// run without a tty, no /proc at all.
func TestObserveIdentityAndDetection(t *testing.T) {
	f := newRun()
	f.fg(200, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
	d := &Detector{Proc: f}
	got := d.Observe(map[string]Run{"reused": {PID: 100, StartTicks: 1}, "gone": {PID: 77, StartTicks: 4242}, "live": {PID: 100, StartTicks: 4242}})
	if o := got["reused"]; o.Live || o.Positive() || o.Detection != None {
		t.Fatalf("reused pid: %+v", o)
	}
	if o := got["gone"]; o.Live || o.Positive() {
		t.Fatalf("gone: %+v", o)
	}
	if o := got["live"]; !o.Live || o.Confidence != Confirmed {
		t.Fatalf("live: %+v", o)
	}
	f.procs[100].tty = 0
	if o := d.Observe(map[string]Run{"x": {PID: 100, StartTicks: 4242}})["x"]; !o.Live || o.Detection != None || o.Positive() {
		t.Fatalf("no tty: %+v", o)
	}
	var none *Detector
	if o := none.Observe(map[string]Run{"x": {PID: 100, StartTicks: 4242}})["x"]; o.Detection != None || o.Live {
		t.Fatalf("no proc: %+v", o)
	}
	if o := (&Detector{}).Observe(map[string]Run{"x": {PID: 100}})["x"]; o.Detection != None {
		t.Fatalf("nil proc: %+v", o)
	}
}

// The raw-mode check asks the tty once per sample, through the launcher's
// own pts descriptor, never through a /dev/tty one.
func TestObserveAsksTheTTYThroughThePts(t *testing.T) {
	f := newRun()
	f.procs[100].fds = map[int]uint64{0: devTTY, 7: pts5}
	f.fg(200, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
	f.fg(201, "bash", 'S', call(readNr, 0), "wait_woken", stdio)
	if o := observe(t, f); o.Confidence != Confirmed {
		t.Fatalf("%+v", o)
	}
	if f.canonical != 1 {
		t.Fatalf("canonical asked %d times", f.canonical)
	}
}

func TestParseStatComm(t *testing.T) {
	st, err := parseStat("42 (a) b (c)) S 1 42 42 34821 42 0 0 0 0 0 0 0 0 0 20 0 1 0 777 0 0")
	if err != nil || st.comm != "a) b (c)" || st.state != 'S' || st.tty != 34821 || st.start != 777 {
		t.Fatalf("%+v %v", st, err)
	}
	if major, minor := ttyDevice(34821); major != 136 || minor != 5 {
		t.Fatalf("%d:%d", major, minor)
	}
	if major, minor := ttyDevice(int(0x88 << 8)); major != 136 || minor != 0 {
		t.Fatalf("%d:%d", major, minor)
	}
	for _, s := range []string{"", "1 (x", "1 (x) S 1"} {
		if _, err := parseStat(s); err == nil {
			t.Fatalf("parsed %q", s)
		}
	}
}
