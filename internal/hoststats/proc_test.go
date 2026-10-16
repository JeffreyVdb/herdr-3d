package hoststats

import (
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseCPU(t *testing.T) {
	t.Parallel()
	got, ok := ParseCPU(fixture(t, "proc/stat"))
	// user+nice+system+idle+iowait+irq+softirq+steal; guest is not added.
	if !ok || got.Idle != 3699+23 || got.Total != 4705+356+584+3699+23+23 {
		t.Fatalf("cpu = %+v ok=%v", got, ok)
	}
	// Eleven fields: guest and guest_nice stay out of the total.
	got, ok = ParseCPU([]byte("cpu  10 0 10 80 0 0 0 0 5 5\ncpu0 1 1 1 1\n"))
	if !ok || got.Total != 100 || got.Idle != 80 {
		t.Fatalf("with guest: %+v ok=%v", got, ok)
	}
	for _, bad := range []string{"", "intr 1 2 3\n", "cpu  1 2\n", "cpu  a b c d\n", "cpu0 1 2 3 4\n"} {
		if _, ok := ParseCPU([]byte(bad)); ok {
			t.Errorf("ParseCPU(%q) ok", bad)
		}
	}
}

func TestCPUMeter(t *testing.T) {
	t.Parallel()
	var m CPUMeter
	if _, ok := m.Sample(CPUTimes{Idle: 100, Total: 200}); ok {
		t.Fatal("a first reading is no percentage")
	}
	// 100 jiffies later, 25 of them idle: 75 % busy.
	if p, ok := m.Sample(CPUTimes{Idle: 125, Total: 300}); !ok || p != 75 {
		t.Fatalf("p = %v ok=%v", p, ok)
	}
	// Δtotal == 0: the previous value stays.
	if p, ok := m.Sample(CPUTimes{Idle: 125, Total: 300}); !ok || p != 75 {
		t.Fatalf("Δtotal = 0: p = %v ok=%v", p, ok)
	}
	// Δtotal < 0 (a reset, a suspend): the previous value stays, the new reading is the baseline.
	if p, ok := m.Sample(CPUTimes{Idle: 10, Total: 20}); !ok || p != 75 {
		t.Fatalf("Δtotal < 0: p = %v ok=%v", p, ok)
	}
	if p, ok := m.Sample(CPUTimes{Idle: 10, Total: 120}); !ok || p != 100 {
		t.Fatalf("after the reset: p = %v ok=%v", p, ok)
	}
	// An idle counter that moved more than the total is clamped.
	if p, _ := m.Sample(CPUTimes{Idle: 400, Total: 130}); p != 0 {
		t.Fatalf("clamped p = %v", p)
	}
}

func TestCPUMeterNoValueToKeep(t *testing.T) {
	t.Parallel()
	var m CPUMeter
	m.Sample(CPUTimes{Idle: 10, Total: 20})
	if _, ok := m.Sample(CPUTimes{Idle: 10, Total: 20}); ok {
		t.Fatal("Δtotal = 0 with nothing before: still no percentage")
	}
}

func TestParseMem(t *testing.T) {
	t.Parallel()
	m, ok := ParseMem(fixture(t, "proc/meminfo"))
	if !ok || m.Total != 32768000*1024 || m.Available != 19300000*1024 {
		t.Fatalf("mem = %+v ok=%v", m, ok)
	}
	if got, want := m.UsedBytes(), uint64(32768000-19300000)*1024; got != want {
		t.Fatalf("used = %d, want %d (total - available, as free)", got, want)
	}
	if got := m.UsedPct(); got != 41.1 {
		t.Fatalf("used pct = %v", got)
	}
	for _, bad := range []string{"", "MemTotal: x kB\n", "MemFree: 1 kB\n"} {
		if _, ok := ParseMem([]byte(bad)); ok {
			t.Errorf("ParseMem(%q) ok", bad)
		}
	}
	if (Mem{Total: 10, Available: 20}).UsedBytes() != 0 {
		t.Fatal("available over total is no negative use")
	}
}

func TestParseLoad1(t *testing.T) {
	t.Parallel()
	if v, ok := ParseLoad1(fixture(t, "proc/loadavg")); !ok || v != 0.82 {
		t.Fatalf("load1 = %v ok=%v", v, ok)
	}
	for _, bad := range []string{"", "\n", "x 1 2"} {
		if _, ok := ParseLoad1([]byte(bad)); ok {
			t.Errorf("ParseLoad1(%q) ok", bad)
		}
	}
}

func TestReadLoad(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	write := func(name, s string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if ReadLoad(dir) != nil {
		t.Fatal("load without /proc files")
	}
	write("loadavg", "2.41 1.40 2.71 2/5355 1755418\n")
	write("meminfo", "MemTotal:       65536000 kB\nMemFree:         1000 kB\nMemAvailable:   25231360 kB\n")
	l := ReadLoad(dir)
	if l == nil || l.Load1 != 2.41 || l.CPUs < 1 || l.MemUsedPct != 61.5 {
		t.Fatalf("load = %+v", l)
	}
	if HostLoad() == nil {
		t.Skip("no /proc here")
	}
}

func TestParseDiskstats(t *testing.T) {
	t.Parallel()
	got := map[string]DiskCounters{}
	ParseDiskstats(fixture(t, "proc/diskstats"), func(name string, c DiskCounters) { got[name] = c })
	if len(got) != 8 {
		t.Fatalf("devices = %v", got)
	}
	// Fields 4, 6, 8 and 10 of the line.
	if want := (DiskCounters{Reads: 100000, SectorsRead: 4000000, Writes: 50000, SectorsWritten: 2000000}); got["nvme0n1"] != want {
		t.Fatalf("nvme0n1 = %+v, want %+v", got["nvme0n1"], want)
	}
	n := 0
	ParseDiskstats([]byte("8 0 sda 1 2 3\n\ngarbage\n8 0 sdb a b c d e f g h\n"), func(string, DiskCounters) { n++ })
	if n != 0 {
		t.Fatalf("short or malformed lines gave %d devices", n)
	}
}

func BenchmarkReadStat(b *testing.B) {
	var buf []byte
	for b.Loop() {
		buf, _ = readInto("/proc/stat", buf)
		ParseCPU(buf)
	}
}
