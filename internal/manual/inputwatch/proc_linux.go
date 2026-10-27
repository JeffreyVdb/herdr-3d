//go:build linux

package inputwatch

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// System is the live /proc.
func System() Proc { return sysProc{} }

type sysProc struct{}

func numbers(dir string) ([]int, error) {
	f, err := os.Open(dir)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	names, err := f.Readdirnames(-1)
	if err != nil {
		return nil, err
	}
	out := make([]int, 0, len(names))
	for _, n := range names {
		if v, err := strconv.Atoi(n); err == nil && v > 0 {
			out = append(out, v)
		}
	}
	return out, nil
}

func read(path string) (string, error) {
	b, err := os.ReadFile(path)
	return string(b), err
}

func (sysProc) PIDs() ([]int, error)         { return numbers("/proc") }
func (sysProc) Stat(pid int) (string, error) { return read(fmt.Sprintf("/proc/%d/stat", pid)) }
func (sysProc) Tasks(pid int) ([]int, error) { return numbers(fmt.Sprintf("/proc/%d/task", pid)) }
func (sysProc) TaskStat(pid, tid int) (string, error) {
	return read(fmt.Sprintf("/proc/%d/task/%d/stat", pid, tid))
}
func (sysProc) Syscall(pid, tid int) (string, error) {
	return read(fmt.Sprintf("/proc/%d/task/%d/syscall", pid, tid))
}
func (sysProc) Wchan(pid, tid int) (string, error) {
	return read(fmt.Sprintf("/proc/%d/task/%d/wchan", pid, tid))
}
func (sysProc) Children(pid, tid int) ([]int, error) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/children", pid, tid))
	if err != nil {
		return nil, err
	}
	var out []int
	for _, f := range strings.Fields(string(b)) {
		if v, err := strconv.Atoi(f); err == nil && v > 0 {
			out = append(out, v)
		}
	}
	return out, nil
}
func (sysProc) FDs(pid int) ([]int, error) { return numbers(fmt.Sprintf("/proc/%d/fd", pid)) }

func (sysProc) Device(pid, fd int) (uint64, bool, error) {
	info, err := os.Stat(fmt.Sprintf("/proc/%d/fd/%d", pid, fd))
	if err != nil {
		return 0, false, err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeCharDevice == 0 {
		return 0, false, nil
	}
	return st.Rdev, true, nil
}

// Canonical opens the descriptor's terminal again without making it a
// controlling tty and without blocking, asks for its modes and closes it:
// nothing is ever read from it.
func (sysProc) Canonical(pid, fd int) (bool, error) {
	f, err := unix.Open(fmt.Sprintf("/proc/%d/fd/%d", pid, fd), unix.O_RDONLY|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return false, err
	}
	defer unix.Close(f)
	t, err := unix.IoctlGetTermios(f, unix.TCGETS)
	if err != nil {
		return false, err
	}
	return t.Lflag&unix.ICANON != 0, nil
}
