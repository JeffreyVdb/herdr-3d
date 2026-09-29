package herdr

import "syscall"

// streamProcAttr puts a long-running command in its own process group
// (Stop signals the group) and has the kernel kill it should the bridge
// die without stopping it.
func streamProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
