// Package jsonl reads the JSON-lines files agents append to (their
// transcripts): from byte offsets, complete lines only, never through a
// symlink. usage tails a transcript once per worker; transcript indexes
// what that tail already read and gets the rest of the lines from it.
package jsonl

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"syscall"
)

// MaxLine bounds one line; a longer one is skipped whole (transcripts
// carry large tool results and images, the longest seen is 1.5 MB).
const MaxLine = 16 << 20

// ErrReplaced is a file that was truncated or replaced since the last
// read: everything read from it must be forgotten and read again.
var ErrReplaced = errors.New("file truncated or replaced")

// Open opens a regular file for reading, never through a symlink.
func Open(path string) (*os.File, fs.FileInfo, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	if !fi.Mode().IsRegular() {
		f.Close()
		return nil, nil, errors.New(path + ": not a regular file")
	}
	return f, fi, nil
}

// Lines splits bytes fed in order into complete lines, each with the byte
// offset it starts at. An incomplete last line is kept for the next Feed;
// a line over MaxLine is dropped whole.
type Lines struct {
	pos     int64  // the offset of the next byte fed
	start   int64  // where the line being read starts
	partial []byte // its bytes so far
	skip    bool   // dropping an over-long line until its newline
}

// Reset starts over at offset at (the start of a line).
func (l *Lines) Reset(at int64) { *l = Lines{pos: at, start: at} }

// Next is where the next line handed out starts: every complete line
// before it was handed out (or dropped as over-long).
func (l *Lines) Next() int64 { return l.start }

// Feed takes the next bytes and hands each line they complete to fn
// (without its newline; the slice is only valid during the call).
func (l *Lines) Feed(chunk []byte, fn func(off int64, line []byte)) {
	for len(chunk) > 0 {
		i := bytes.IndexByte(chunk, '\n')
		if i < 0 {
			if !l.skip {
				l.partial = append(l.partial, chunk...)
				if len(l.partial) > MaxLine {
					l.partial, l.skip = nil, true
				}
			}
			l.pos += int64(len(chunk))
			return
		}
		line := chunk[:i]
		switch {
		case l.skip:
			l.skip = false
		case len(l.partial)+len(line) > MaxLine:
			l.partial = l.partial[:0]
		case len(l.partial) > 0:
			l.partial = append(l.partial, line...)
			fn(l.start, l.partial)
			l.partial = l.partial[:0]
		default:
			fn(l.start, line)
		}
		l.pos += int64(i + 1)
		l.start = l.pos
		chunk = chunk[i+1:]
	}
}

// Tail reads a growing file incrementally: from where it stopped,
// complete lines only.
type Tail struct {
	Path  string
	fi    fs.FileInfo // the file as last opened (identity)
	lines Lines
	read  int64 // bytes read in all
}

// NewTail tails path from its start.
func NewTail(path string) *Tail { return &Tail{Path: path} }

// Next reads what was appended since the last call and hands each new
// complete line to fn. It returns ErrReplaced (having read nothing) when
// the file shrank or is another file now; the tail then starts over.
func (t *Tail) Next(fn func(off int64, line []byte)) error {
	f, fi, err := Open(t.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	if t.fi != nil && (!os.SameFile(t.fi, fi) || fi.Size() < t.lines.pos) {
		t.Restart()
		return ErrReplaced
	}
	t.fi = fi
	if fi.Size() == t.lines.pos {
		return nil
	}
	if _, err := f.Seek(t.lines.pos, io.SeekStart); err != nil {
		return err
	}
	buf := make([]byte, 64<<10)
	for {
		n, err := f.Read(buf)
		t.read += int64(n)
		t.lines.Feed(buf[:n], fn)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// Restart forgets everything read, so the next call reads from the start.
func (t *Tail) Restart() {
	t.fi = nil
	t.lines.Reset(0)
}

// Delivered is where the next line handed out will start.
func (t *Tail) Delivered() int64 { return t.lines.Next() }

// File is the file as last read (nil before the first read).
func (t *Tail) File() fs.FileInfo { return t.fi }

// BytesRead is how many bytes the tail read in all.
func (t *Tail) BytesRead() int64 { return t.read }

// Scan hands fn the complete lines of r between from (a line start) and
// to, reading chunk bytes at a time; after each chunk it calls step, which
// may stop the scan with an error. It returns where the next line starts
// (the bytes of a line that runs past to are not handed out).
func Scan(r io.ReaderAt, from, to int64, chunk int, fn func(off int64, line []byte), step func() error) (int64, error) {
	var l Lines
	l.Reset(from)
	buf := make([]byte, chunk)
	for pos := from; pos < to; {
		n, err := r.ReadAt(buf[:min(int64(chunk), to-pos)], pos)
		l.Feed(buf[:n], fn)
		pos += int64(n)
		if err != nil && !errors.Is(err, io.EOF) {
			return l.Next(), err
		}
		if n == 0 {
			break // the file is shorter than to: truncated
		}
		if step != nil {
			if err := step(); err != nil {
				return l.Next(), err
			}
		}
	}
	return l.Next(), nil
}
