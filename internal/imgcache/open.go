package imgcache

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/unix"
)

// errChanged: something on the way to the file was replaced after
// CheckPath looked (a directory swapped for a symlink).
var errChanged = errors.New("path changed after it was checked")

// readUnder reads the file at real, which CheckPath found under root with
// no symlink on the way. The read does not trust that anymore: it walks
// down from root one component at a time, never following a symlink
// (O_NOFOLLOW on each, O_DIRECTORY on the directories), so a directory
// swapped for a link since the check is refused instead of read through.
// The file is opened without blocking (a FIFO swapped in cannot hold the
// caller) and the opened descriptor is what is checked (regular, at most
// MaxImage bytes) and read.
func readUnder(root, real string) ([]byte, error) {
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return nil, ErrNotAllowed
	}
	fd, err := unix.Open(root, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	comps := strings.Split(rel, string(filepath.Separator))
	for i, c := range comps {
		flags := unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC
		if i < len(comps)-1 {
			flags |= unix.O_DIRECTORY
		} else {
			flags |= unix.O_NONBLOCK
		}
		next, err := unix.Openat(fd, c, flags, 0)
		_ = unix.Close(fd)
		if err != nil {
			if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
				return nil, errChanged
			}
			return nil, err
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), real)
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !fi.Mode().IsRegular() {
		return nil, ErrNotFile
	}
	if fi.Size() > MaxImage {
		return nil, ErrTooLarge
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxImage+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxImage {
		return nil, ErrTooLarge
	}
	return b, nil
}
