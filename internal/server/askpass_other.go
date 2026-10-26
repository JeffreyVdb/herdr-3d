//go:build !linux

package server

import "net"

// Credential IPC requires peer credentials; unsupported platforms refuse it.
func askpassPeerOK(*net.UnixConn) bool { return false }
