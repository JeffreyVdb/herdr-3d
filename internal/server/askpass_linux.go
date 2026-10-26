//go:build linux

package server

import (
	"net"
	"os"
	"syscall"
)

func askpassPeerOK(c *net.UnixConn) bool {
	raw, err := c.SyscallConn()
	if err != nil {
		return false
	}
	ok := false
	if err := raw.Control(func(fd uintptr) {
		cred, e := syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		ok = e == nil && cred.Uid == uint32(os.Getuid())
	}); err != nil {
		return false
	}
	return ok
}

func askpassFileOwner(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid())
}
