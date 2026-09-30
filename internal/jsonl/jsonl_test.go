package jsonl

import (
	"slices"
	"strings"
	"testing"
)

// Lines hands out complete lines with the offsets they start at, across
// chunks, and drops a line over MaxLine whole.
func TestLines(t *testing.T) {
	long := strings.Repeat("x", MaxLine+1)
	data := []byte("a\nbb\n" + long + "\nccc\npart")
	var offs []int64
	var lines []string
	var l Lines
	l.Reset(0)
	for chunk := range slices.Chunk(data, 7) {
		l.Feed(chunk, func(off int64, b []byte) { offs, lines = append(offs, off), append(lines, string(b)) })
	}
	if strings.Join(lines, "|") != "a|bb|ccc" {
		t.Fatalf("lines = %q", lines)
	}
	if offs[0] != 0 || offs[1] != 2 || offs[2] != int64(5+len(long)+1) {
		t.Fatalf("offsets = %v", offs)
	}
	if next := l.Next(); next != int64(len(data)-len("part")) {
		t.Fatalf("next = %d", next)
	}
}

func TestScan(t *testing.T) {
	data := "one\ntwo\nthr"
	var got []string
	next, err := Scan(strings.NewReader(data), 4, int64(len(data)), 3, func(off int64, b []byte) {
		got = append(got, string(b))
	}, nil)
	if err != nil || next != 8 || strings.Join(got, "|") != "two" {
		t.Fatalf("scan = %q, next %d, %v", got, next, err)
	}
}
