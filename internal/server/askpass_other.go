//go:build !linux

package server

import (
	"net"
	"os"
)

// Credential IPC requires peer credentials; unsupported platforms refuse it.
func askpassPeerOK(*net.UnixConn) bool { return false }

func askpassFileOwner(os.FileInfo) bool { return false }
