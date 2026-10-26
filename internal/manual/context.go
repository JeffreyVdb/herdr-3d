package manual

import (
	"context"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
)

func ParseNoNewPrivs(status string) (bool, error) {
	for _, line := range strings.Split(status, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if ok && k == "NoNewPrivs" {
			switch strings.TrimSpace(v) {
			case "0":
				return false, nil
			case "1":
				return true, nil
			default:
				return false, fmt.Errorf("invalid NoNewPrivs")
			}
		}
	}
	return false, fmt.Errorf("NoNewPrivs missing")
}

// ServerNoNewPrivs reads the peer PID of the connected session socket, so it
// checks the server actually hosting this pane rather than the bridge process.
func ServerNoNewPrivs(ctx context.Context, socket string) (bool, error) {
	d := net.Dialer{}
	c, err := d.DialContext(ctx, "unix", socket)
	if err != nil {
		return false, err
	}
	defer c.Close()
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return false, fmt.Errorf("not a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return false, err
	}
	var cred *syscall.Ucred
	var sockErr error
	if err = raw.Control(func(fd uintptr) {
		cred, sockErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return false, err
	}
	if sockErr != nil {
		return false, sockErr
	}
	if cred == nil || cred.Pid <= 0 {
		return false, fmt.Errorf("no server peer PID")
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", cred.Pid))
	if err != nil {
		return false, err
	}
	return ParseNoNewPrivs(string(b))
}
