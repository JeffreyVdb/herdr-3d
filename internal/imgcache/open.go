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
// no symlink anywhere in it (real and root are EvalSymlinks results). The
// read does not trust that anymore: it walks down from "/" one component
// at a time, never following a symlink (O_NOFOLLOW on each, O_DIRECTORY on
// the directories), so a directory swapped for a link since the check,
// whether below the root, the root itself or one above it, is refused
// instead of read through. What is read is what is at real now, reached
// only through directories; real is under root as text, so it is under the
// root. The file is opened without blocking (a FIFO swapped in cannot hold
// the caller) and the opened descriptor is what is checked (regular, at
// most MaxImage bytes) and read.
func readUnder(root, real string) ([]byte, error) {
	if !filepath.IsAbs(root) || !filepath.IsAbs(real) || filepath.Clean(real) != real || !within(filepath.Clean(root), real) || real == "/" {
		return nil, ErrNotAllowed
	}
	const file = unix.O_RDONLY | unix.O_NOFOLLOW | unix.O_CLOEXEC | unix.O_NONBLOCK
	fd, err := unix.Open("/", walkDir, 0)
	if err != nil {
		return nil, err
	}
	comps := strings.Split(real[1:], string(filepath.Separator))
	for i, c := range comps {
		flags := file
		if i < len(comps)-1 {
			flags = walkDir | unix.O_NOFOLLOW
		}
		next, err := unix.Openat(fd, c, flags, 0)
		_ = unix.Close(fd)
		if err != nil {
			return nil, openErr(err)
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

// openErr says a link or a directory that is not one any more is a change
// since the check.
func openErr(err error) error {
	if errors.Is(err, unix.ELOOP) || errors.Is(err, unix.ENOTDIR) {
		return errChanged
	}
	return err
}
