//go:build !linux

package herdr

import "syscall"

// streamProcAttr puts a long-running command in its own process group
// (Stop signals the group).
func streamProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
