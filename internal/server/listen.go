package server

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// maxSocketPath is sun_path minus the terminating NUL (Linux: 108 bytes).
const maxSocketPath = 107

// Listen creates the bridge's unix socket: the directory is created (or
// tightened) to 0700 and must be owned by us, a stale socket from a crashed
// run is removed, a live one is an error, and the socket is chmod 0600.
// The socket file is removed again when the listener is closed.
func Listen(path string) (*net.UnixListener, error) {
	if len(path) > maxSocketPath {
		return nil, fmt.Errorf("socket path is %d bytes, unix sockets allow %d: %s", len(path), maxSocketPath, path)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := securePrivateDir(dir); err != nil {
		return nil, err
	}
	if err := removeStale(path); err != nil {
		return nil, err
	}
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func securePrivateDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s is not a directory", dir)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s is owned by uid %d, not us", dir, st.Uid)
	}
	if fi.Mode().Perm() != 0o700 {
		return os.Chmod(dir, 0o700)
	}
	return nil
}

func removeStale(path string) error {
	fi, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("%s exists and is not a socket", path)
	}
	if c, err := net.DialTimeout("unix", path, 500*time.Millisecond); err == nil {
		c.Close()
		return fmt.Errorf("%s is in use by another running bridge", path)
	}
	return os.Remove(path)
}
