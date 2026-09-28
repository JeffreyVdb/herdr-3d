package server_test

import (
	"bufio"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

func mode(t *testing.T, path string) fs.FileMode {
	t.Helper()
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return fi.Mode()
}

func TestListenPermissions(t *testing.T) {
	sock := filepath.Join(shortDir(t), "herdr-world", "bridge.sock")
	ln, err := server.Listen(sock)
	if err != nil {
		t.Fatal(err)
	}
	if m := mode(t, filepath.Dir(sock)); m != fs.ModeDir|0o700 {
		t.Errorf("dir mode = %v, want drwx------", m)
	}
	if m := mode(t, sock); m != fs.ModeSocket|0o600 {
		t.Errorf("socket mode = %v, want Srw-------", m)
	}
	ln.Close()
	if _, err := os.Lstat(sock); !os.IsNotExist(err) {
		t.Fatalf("socket left behind after close: %v", err)
	}
}

func TestListenTightensLooseDir(t *testing.T) {
	dir := filepath.Join(shortDir(t), "herdr-world")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o755); err != nil { // defeat umask
		t.Fatal(err)
	}
	ln, err := server.Listen(filepath.Join(dir, "bridge.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if m := mode(t, dir); m != fs.ModeDir|0o700 {
		t.Fatalf("dir mode = %v, want drwx------", m)
	}
}

func TestListenStaleAndLiveSockets(t *testing.T) {
	sock := filepath.Join(shortDir(t), "bridge.sock")
	// A crashed bridge leaves its socket file behind.
	stale, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	stale.SetUnlinkOnClose(false)
	stale.Close()
	ln, err := server.Listen(sock)
	if err != nil {
		t.Fatalf("stale socket not replaced: %v", err)
	}
	defer ln.Close()
	// A second bridge on the same socket must not steal it.
	if _, err := server.Listen(sock); err == nil || !strings.Contains(err.Error(), "in use") {
		t.Fatalf("second listen: %v", err)
	}
}

func TestListenRefusesNonSocketsAndLongPaths(t *testing.T) {
	path := filepath.Join(shortDir(t), "bridge.sock")
	if err := os.WriteFile(path, []byte("precious"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Listen(path); err == nil {
		t.Fatal("replaced a regular file")
	}
	if b, _ := os.ReadFile(path); string(b) != "precious" {
		t.Fatal("regular file was touched")
	}
	long := filepath.Join(shortDir(t), strings.Repeat("x", 120), "bridge.sock")
	if _, err := server.Listen(long); err == nil || !strings.Contains(err.Error(), "unix sockets allow") {
		t.Fatalf("long path: %v", err)
	}
}

// TestNoTCPListener runs a full bridge and checks the kernel's socket tables:
// no TCP socket owned by this process is listening.
func TestNoTCPListener(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("reads /proc")
	}
	b := startBridge(t, "", server.Options{})
	b.floor("s", true, worker("w1", "a", "", "idle"))
	c := b.connect(proto.Hello{})
	c.snapshot()

	inodes := map[string]bool{}
	fds, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Fatal(err)
	}
	for _, fd := range fds {
		target, err := os.Readlink(filepath.Join("/proc/self/fd", fd.Name()))
		if err == nil && strings.HasPrefix(target, "socket:[") {
			inodes[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = true
		}
	}
	if len(inodes) == 0 {
		t.Fatal("found no sockets at all; the check is broken")
	}
	for _, table := range []string{"/proc/self/net/tcp", "/proc/self/net/tcp6"} {
		f, err := os.Open(table)
		if err != nil {
			continue // no IPv6
		}
		sc := bufio.NewScanner(f)
		sc.Scan() // header
		for sc.Scan() {
			fields := strings.Fields(sc.Text())
			if len(fields) < 10 {
				continue
			}
			// st 0A = TCP_LISTEN; field 9 is the inode.
			if st, _ := strconv.ParseUint(fields[3], 16, 8); st == 0x0A && inodes[fields[9]] {
				t.Errorf("%s: this process listens on TCP %s", table, fields[1])
			}
		}
		f.Close()
	}
	// And the unix socket is what serves.
	if m := mode(t, b.sock); m != fs.ModeSocket|0o600 {
		t.Errorf("bridge socket mode = %v", m)
	}
}
