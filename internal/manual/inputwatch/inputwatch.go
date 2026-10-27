// Package inputwatch observes whether a manual run's foreground processes
// wait for terminal input (#213). It reads only process metadata: the run's
// tty and foreground group from /proc/<pid>/stat, each foreground task's
// state, blocked syscall or wait channel, and its descriptors' devices. It
// never reads the terminal, its output or any process memory, so nothing it
// reports can carry terminal text.
//
// A task blocked in read(2) or readv(2) on the run's own tty (its pts, or
// /dev/tty while the run's tty is the task's controlling tty) is a
// confirmed observation; that needs /proc/<pid>/syscall, which Yama
// ptrace_scope 1 denies for processes the bridge did not start. Without it a
// task sleeping in the tty line discipline's wait (wchan wait_woken or
// n_tty_read) with a descriptor on the run's tty, or a childless foreground
// sudo (its terminal prompt; sudo's own files are unreadable), is only
// uncertain. Full-screen programs (raw mode, or a known pager, editor or
// monitor) are never reported: they always wait for keys.
package inputwatch

import (
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// Proc is the part of /proc the detector reads (System on Linux; fakes in
// tests). Every method may fail with a permission error.
type Proc interface {
	PIDs() ([]int, error)
	Stat(pid int) (string, error)
	Tasks(pid int) ([]int, error)
	TaskStat(pid, tid int) (string, error)
	// Syscall is /proc/<pid>/task/<tid>/syscall.
	Syscall(pid, tid int) (string, error)
	Wchan(pid, tid int) (string, error)
	// Children is /proc/<pid>/task/<tid>/children.
	Children(pid, tid int) ([]int, error)
	FDs(pid int) ([]int, error)
	// Device is the device number of what fd refers to; ok is false for
	// anything but a character device.
	Device(pid, fd int) (rdev uint64, ok bool, err error)
	// Canonical reports whether the terminal fd refers to is in canonical
	// (line) mode; it never reads from it.
	Canonical(pid, fd int) (bool, error)
}

// Run is a run's launcher identity (manual.Status).
type Run struct {
	PID        int
	StartTicks uint64
}

// Detection levels (proto.InputDetection*).
const (
	Full  = "full"
	Hints = "hints"
	None  = "none"
)

// Confidences and reasons (proto.Attention*).
const (
	Confirmed    = "confirmed"
	Uncertain    = "uncertain"
	TTYRead      = "tty_read"
	TTYWait      = "tty_wait"
	SudoTerminal = "sudo_terminal"
)

// Observation is one sample of a run.
type Observation struct {
	// Detection is what this host lets the bridge see of the run: full
	// (syscalls readable), hints (process state only), none (no tty, no
	// /proc).
	Detection string
	// Live: the launcher's identity matched; nothing else is set without it.
	Live bool
	// Confidence and Reason of the strongest wait seen ("": none).
	Confidence, Reason string
	// Suppressed names why a tty wait was not reported ("tui"), for
	// diagnostics.
	Suppressed string
}

// Positive reports whether the run was seen waiting.
func (o Observation) Positive() bool { return o.Confidence != "" }

// Detector samples runs through a Proc.
type Detector struct{ Proc Proc }

// tuiNames are foreground programs that read keys while showing a screen:
// a wait of theirs is navigation, not a question (best effort; raw mode
// covers the rest).
var tuiNames = map[string]bool{
	"less": true, "more": true, "most": true, "man": true, "vi": true, "vim": true, "nvim": true, "view": true,
	"nano": true, "pico": true, "emacs": true, "micro": true, "hx": true, "helix": true, "kak": true, "mg": true,
	"top": true, "htop": true, "btop": true, "atop": true, "iotop": true, "watch": true, "tmux": true, "screen": true,
	"mc": true, "ranger": true, "nnn": true, "lf": true, "fzf": true, "tig": true, "lazygit": true, "k9s": true, "ssh": true,
}

// stat is the part of /proc/<pid>/stat the detector uses.
type stat struct {
	comm                            string
	state                           byte
	ppid, pgrp, session, tty, tpgid int
	start                           uint64
}

func parseStat(s string) (stat, error) {
	open, end := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if open < 0 || end < open {
		return stat{}, fmt.Errorf("invalid proc stat")
	}
	f := strings.Fields(s[end+1:])
	if len(f) < 20 || len(f[0]) != 1 {
		return stat{}, fmt.Errorf("short proc stat")
	}
	st := stat{comm: s[open+1 : end], state: f[0][0]}
	ints := []*int{&st.ppid, &st.pgrp, &st.session, &st.tty, &st.tpgid}
	for i, p := range ints {
		v, err := strconv.Atoi(f[i+1])
		if err != nil {
			return stat{}, err
		}
		*p = v
	}
	start, err := strconv.ParseUint(f[19], 10, 64)
	if err != nil {
		return stat{}, err
	}
	st.start = start
	return st, nil
}

// ttyDevice splits stat's tty_nr into major and minor.
func ttyDevice(nr int) (uint32, uint32) {
	n := uint32(nr)
	return (n >> 8) & 0xfff, (n & 0xff) | ((n >> 12) & 0xfff00)
}

// readCall parses a syscall file: the fd of a blocked read(2) or readv(2).
func readCall(s string) (fd int, ok bool) {
	f := strings.Fields(s)
	if len(f) < 2 {
		return 0, false
	}
	nr, err := strconv.ParseInt(f[0], 10, 64)
	if err != nil || (nr != unix.SYS_READ && nr != unix.SYS_READV) {
		return 0, false
	}
	v, err := strconv.ParseUint(strings.TrimPrefix(f[1], "0x"), 16, 32)
	if err != nil {
		return 0, false
	}
	return int(v), true
}

// Observe samples every run with one scan of the process table.
func (d *Detector) Observe(runs map[string]Run) map[string]Observation {
	out := make(map[string]Observation, len(runs))
	if d == nil || d.Proc == nil {
		for id := range runs {
			out[id] = Observation{Detection: None}
		}
		return out
	}
	var all map[int]stat
	for id, r := range runs {
		o := Observation{Detection: None}
		raw, err := d.Proc.Stat(r.PID)
		if err != nil || r.PID <= 0 {
			out[id] = o
			continue
		}
		ls, err := parseStat(raw)
		if err != nil || ls.start != r.StartTicks {
			out[id] = o
			continue
		}
		o.Live = true
		if ls.tty == 0 {
			out[id] = o
			continue
		}
		o.Detection = Hints
		if _, err := d.Proc.Syscall(r.PID, r.PID); err == nil {
			o.Detection = Full
		}
		if ls.tpgid <= 0 {
			out[id] = o
			continue
		}
		table, unknown, ok := d.tree(ls.session)
		if !ok {
			if all == nil {
				all = d.scan()
			}
			table, unknown = all, nil
		}
		g := group{d: d, o: &o, launcherPID: r.PID, launcher: ls, termFD: -2, childrenUnknown: unknown}
		g.observe(table)
		out[id] = o
	}
	return out
}

// maxTree bounds one session walk.
const maxTree = 4096

// tree reads the run's session from its leader down (a herdr pane's
// session: every process of its foreground group descends from the leader
// unless it was orphaned): their stats, and the processes whose children
// could not be listed. ok is false when the leader is gone or unreadable,
// or its children cannot be listed.
func (d *Detector) tree(leader int) (table map[int]stat, unknown map[int]bool, ok bool) {
	raw, err := d.Proc.Stat(leader)
	if err != nil {
		return nil, nil, false
	}
	if st, err := parseStat(raw); err != nil || st.session != leader {
		return nil, nil, false
	}
	table, unknown = map[int]stat{}, map[int]bool{}
	queue := []int{leader}
	for len(queue) > 0 && len(table) < maxTree {
		pid := queue[0]
		queue = queue[1:]
		if _, seen := table[pid]; seen {
			continue
		}
		raw, err := d.Proc.Stat(pid)
		if err != nil {
			continue
		}
		st, err := parseStat(raw)
		if err != nil {
			continue
		}
		table[pid] = st
		tids, err := d.Proc.Tasks(pid)
		if err != nil {
			tids = []int{pid}
		}
		for _, tid := range tids {
			kids, err := d.Proc.Children(pid, tid)
			if err != nil {
				unknown[pid] = true
				continue
			}
			queue = append(queue, kids...)
		}
	}
	if unknown[leader] { // no children files at all (CONFIG_PROC_CHILDREN)
		return nil, nil, false
	}
	return table, unknown, true
}

// scan reads every process's stat once (unreadable ones are skipped): the
// fallback when the session's leader cannot be read.
func (d *Detector) scan() map[int]stat {
	table := map[int]stat{}
	pids, err := d.Proc.PIDs()
	if err != nil {
		return table
	}
	for _, pid := range pids {
		raw, err := d.Proc.Stat(pid)
		if err != nil {
			continue
		}
		if st, err := parseStat(raw); err == nil {
			table[pid] = st
		}
	}
	return table
}

// group is one run's sample: its launcher and the foreground group of its
// tty.
type group struct {
	d           *Detector
	o           *Observation
	launcherPID int
	launcher    stat
	termFD      int // the launcher's descriptor on the run's pts (-1: none, -2: not looked up)
	asked, isRaw bool
	// childrenUnknown: processes whose children could not be listed (nil
	// after a full scan, which sees every child).
	childrenUnknown map[int]bool
}

// observe looks at every task of the run tty's foreground group.
func (g *group) observe(table map[int]stat) {
	d, runTTY := g.d, g.launcher.tty
	children := map[int]bool{}
	for _, st := range table {
		children[st.ppid] = true
	}
	for pid, st := range table {
		if st.pgrp != g.launcher.tpgid || st.tty != runTTY || st.session != g.launcher.session {
			continue
		}
		if st.comm == "sudo" && st.state == 'S' && !children[pid] && !g.childrenUnknown[pid] {
			g.raise(st, false, Uncertain, SudoTerminal)
			continue
		}
		tids, err := d.Proc.Tasks(pid)
		if err != nil {
			tids = []int{pid}
		}
		for _, tid := range tids {
			raw, err := d.Proc.TaskStat(pid, tid)
			if err != nil {
				continue
			}
			ts, err := parseStat(raw)
			if err != nil || ts.state != 'S' {
				continue
			}
			if call, err := d.Proc.Syscall(pid, tid); err == nil {
				if fd, ok := readCall(call); ok && d.onRunTTY(pid, fd, ts.tty, runTTY) {
					g.raise(st, true, Confirmed, TTYRead)
				}
				continue // readable and not a tty read: not waiting on the tty
			}
			wchan, err := d.Proc.Wchan(pid, tid)
			if err != nil || (wchan != "wait_woken" && wchan != "n_tty_read") {
				continue
			}
			if d.hasTTYFD(pid, ts.tty, runTTY) {
				g.raise(st, true, Uncertain, TTYWait)
			}
		}
	}
}

// raise records a wait unless it is a full-screen program's (a known name,
// or the tty in raw mode); a confirmed one wins over an uncertain one.
func (g *group) raise(st stat, tty bool, confidence, reason string) {
	if tty && (tuiNames[st.comm] || g.raw()) {
		g.o.Suppressed = "tui"
		return
	}
	if g.o.Confidence == Confirmed {
		return
	}
	g.o.Confidence, g.o.Reason = confidence, reason
}

// raw reports whether the run's tty is out of canonical mode, asked through
// the launcher's own descriptor on the pts (a /dev/tty descriptor would open
// the bridge's controlling terminal, not the run's). Unknown: false.
func (g *group) raw() bool {
	if g.asked {
		return g.isRaw
	}
	g.asked = true
	if g.termFD == -2 {
		g.termFD = -1
		if fds, err := g.d.Proc.FDs(g.launcherPID); err == nil {
			rm, rn := ttyDevice(g.launcher.tty)
			for _, fd := range fds {
				if rdev, ok, err := g.d.Proc.Device(g.launcherPID, fd); err == nil && ok && unix.Major(rdev) == rm && unix.Minor(rdev) == rn {
					g.termFD = fd
					break
				}
			}
		}
	}
	if g.termFD < 0 {
		return false
	}
	canonical, err := g.d.Proc.Canonical(g.launcherPID, g.termFD)
	g.isRaw = err == nil && !canonical
	return g.isRaw
}

// onRunTTY reports whether pid's fd is the run's tty: its pts itself, or
// /dev/tty (5,0) while the run's tty is the task's controlling tty.
func (d *Detector) onRunTTY(pid, fd, taskTTY, runTTY int) bool {
	rdev, ok, err := d.Proc.Device(pid, fd)
	if err != nil || !ok {
		return false
	}
	major, minor := unix.Major(rdev), unix.Minor(rdev)
	if major == 5 && minor == 0 {
		return taskTTY == runTTY
	}
	rm, rn := ttyDevice(runTTY)
	return major == rm && minor == rn
}

// hasTTYFD reports whether pid has a descriptor on the run's tty.
func (d *Detector) hasTTYFD(pid, taskTTY, runTTY int) bool {
	fds, err := d.Proc.FDs(pid)
	if err != nil {
		return false
	}
	for _, fd := range fds {
		if d.onRunTTY(pid, fd, taskTTY, runTTY) {
			return true
		}
	}
	return false
}
