package usage

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"syscall"
)

// MaxLine bounds one transcript line; a longer one is skipped whole
// (transcripts carry large tool results, never usage that large).
const MaxLine = 16 << 20

// tail reads a growing file incrementally: from a stored offset, complete
// lines only. An incomplete last line is kept for the next read.
type tail struct {
	path    string
	fi      fs.FileInfo // the file as last opened (identity)
	off     int64       // the next byte to read
	partial []byte      // bytes after the last newline read
	skip    bool        // dropping an over-long line until its newline
	read    int64       // bytes read in all (tests)
}

// errReplaced is a file that was truncated or replaced since the last
// read: everything read from it must be forgotten and read again.
var errReplaced = errors.New("file truncated or replaced")

// next reads what was appended since the last call and hands each new
// complete line to fn. It returns errReplaced (having read nothing) when
// the file shrank or is another file now; the tail then starts over.
func (t *tail) next(fn func(line []byte)) error {
	f, err := os.OpenFile(t.path, os.O_RDONLY|syscall.O_NOFOLLOW, 0) // never a symlink
	if err != nil {
		return err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return err
	}
	if !fi.Mode().IsRegular() {
		return errors.New(t.path + ": not a regular file")
	}
	if t.fi != nil && (!os.SameFile(t.fi, fi) || fi.Size() < t.off) {
		t.restart()
		return errReplaced
	}
	t.fi = fi
	if fi.Size() == t.off {
		return nil
	}
	if _, err := f.Seek(t.off, io.SeekStart); err != nil {
		return err
	}
	buf := make([]byte, 64<<10)
	for {
		n, err := f.Read(buf)
		t.read += int64(n)
		t.off += int64(n)
		t.feed(buf[:n], fn)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// restart forgets everything read, so the next call reads from the start.
func (t *tail) restart() {
	t.fi, t.off, t.partial, t.skip = nil, 0, nil, false
}

func (t *tail) feed(chunk []byte, fn func([]byte)) {
	for len(chunk) > 0 {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			if !t.skip {
				t.partial = append(t.partial, chunk...)
				if len(t.partial) > MaxLine {
					t.partial, t.skip = nil, true
				}
			}
			return
		}
		line := chunk[:i]
		switch {
		case t.skip:
			t.skip = false
		case len(t.partial)+len(line) > MaxLine:
			t.partial = t.partial[:0]
		case len(t.partial) > 0:
			t.partial = append(t.partial, line...)
			fn(t.partial)
			t.partial = t.partial[:0]
		default:
			fn(line)
		}
		chunk = chunk[i+1:]
	}
}
