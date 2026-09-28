package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadLoad(t *testing.T) {
	dir := t.TempDir()
	write := func(name, s string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if readLoad(dir) != nil {
		t.Fatal("load without /proc files")
	}
	write("loadavg", "2.41 1.40 2.71 2/5355 1755418\n")
	write("meminfo", "MemTotal:       65536000 kB\nMemFree:         1000 kB\nMemAvailable:   25231360 kB\n")
	l := readLoad(dir)
	if l == nil || l.Load1 != 2.41 || l.CPUs < 1 || l.MemUsedPct != 61.5 {
		t.Fatalf("load = %+v", l)
	}
	if HostLoad() == nil {
		t.Skip("no /proc here")
	}
}
