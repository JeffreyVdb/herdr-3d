//go:build unix

package logo

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// limitSelf is the worker's own defence in depth, for a worker that outlives
// or ignores the parent's deadline (a stuck parent, a parent killed first): no
// core dump (it would hold the upload), and a hard CPU limit that kills it. A
// limit on the address space is not set: the Go runtime reserves address
// space it does not use, so it is not a memory limit (see workerMemoryLimit).
func limitSelf(cpu int) {
	_ = syscall.Setrlimit(syscall.RLIMIT_CORE, &syscall.Rlimit{})
	if cpu > 0 {
		// Soft = hard: past it the kernel sends SIGKILL. (At a lower soft
		// limit it sends SIGXCPU, which the Go runtime ignores unless asked.)
		_ = syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{Cur: uint64(cpu), Max: uint64(cpu)})
	}
}

// killable puts the child in its own process group and makes the context's
// cancellation SIGKILL the whole group, not just the child.
func killable(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}

// workerExecutable is what to execute to run the bridge again. On Linux
// /proc/self/exe names the running image even after the file was replaced by
// an upgrade (os.Executable would report "… (deleted)").
func workerExecutable() (string, error) {
	if _, err := os.Stat("/proc/self/exe"); err == nil {
		return "/proc/self/exe", nil
	}
	return os.Executable()
}
