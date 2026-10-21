package transcript

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A log kept while nobody watches it (#149) says whether it still indexes
// its file before it is handed out again: appended to, it does; truncated,
// replaced by another file at its path or gone, it does not.
func TestStale(t *testing.T) {
	dir := t.TempDir()
	follow := func(name string) (*Log, string) {
		t.Helper()
		path := filepath.Join(dir, name)
		writeLines(t, path, userLine(0), userLine(1))
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		l, err := Follow(Claude, path, fi, fi.Size())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(l.Close)
		ready(t, l)
		return l, path
	}

	l, path := follow("appended.jsonl")
	if err := l.Stale(); err != nil {
		t.Fatalf("as built: %v", err)
	}
	writeLines(t, path, userLine(2))
	if err := l.Stale(); err != nil {
		t.Fatalf("appended: %v", err)
	}

	l, path = follow("truncated.jsonl")
	if err := os.Truncate(path, 10); err != nil {
		t.Fatal(err)
	}
	if err := l.Stale(); !errors.Is(err, ErrReplaced) {
		t.Fatalf("truncated: %v", err)
	}

	l, path = follow("replaced.jsonl")
	next := path + ".new"
	writeLines(t, next, userLine(0), userLine(1), userLine(2))
	if err := os.Rename(next, path); err != nil {
		t.Fatal(err)
	}
	if err := l.Stale(); !errors.Is(err, ErrReplaced) {
		t.Fatalf("replaced: %v", err)
	}

	l, path = follow("gone.jsonl")
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := l.Stale(); !errors.Is(err, ErrGone) {
		t.Fatalf("gone: %v", err)
	}

	l, _ = follow("closed.jsonl")
	l.Close()
	if err := l.Stale(); !errors.Is(err, ErrClosed) {
		t.Fatalf("closed: %v", err)
	}
}

// Footprint estimates the index's memory: it grows with what is indexed,
// and is about the heap the index holds.
func TestFootprint(t *testing.T) {
	dir := t.TempDir()
	build := func(n int) *Log {
		t.Helper()
		path := filepath.Join(dir, "t.jsonl")
		_ = os.Remove(path)
		var lines []string
		for i := range n {
			lines = append(lines, userLine(i), noiseLine(i))
		}
		writeLines(t, path, lines...)
		fi, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		l, err := Follow(Claude, path, fi, fi.Size())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(l.Close)
		ready(t, l)
		return l
	}
	small, l := build(10).Footprint(), build(10_000)
	big := l.Footprint()
	if small <= 0 || big < 500*small {
		t.Fatalf("footprint of 20 lines %d, of 20000 %d", small, big)
	}
	// Entries of a short id and one span each: some tens of bytes an
	// entry, not some (nor some thousands).
	if per := big / int64(l.Len()); per < 50 || per > 1000 {
		t.Fatalf("%d bytes an entry (%d entries)", per, l.Len())
	}
}
