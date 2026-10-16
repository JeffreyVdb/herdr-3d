package hoststats

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// sysTree makes a /sys root with block/<name> entries; those in phys have a
// device link.
func sysTree(t *testing.T, all []string, phys ...string) string {
	t.Helper()
	root := t.TempDir()
	for _, n := range all {
		if err := os.MkdirAll(filepath.Join(root, "block", n), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range phys {
		if err := os.MkdirAll(filepath.Join(root, "block", n, "device"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func stats(lines ...[2]any) []byte {
	s := ""
	for _, l := range lines {
		c := l[1].(DiskCounters)
		s += fmt.Sprintf(" 8 0 %s %d 0 %d 0 %d 0 %d 0 0 0 0\n", l[0], c.Reads, c.SectorsRead, c.Writes, c.SectorsWritten)
	}
	return []byte(s)
}

func TestDiskMeterFixtureFilter(t *testing.T) {
	t.Parallel()
	m := NewDiskMeter("testdata/sys")
	t0 := time.Unix(1_800_000_000, 0)
	if _, ok := m.Sample(fixture(t, "proc/diskstats"), t0); ok {
		t.Fatal("the first sample is a baseline")
	}
	rates, ok := m.Sample(fixture(t, "proc/diskstats"), t0.Add(time.Second))
	if !ok || len(rates) != 2 || rates[0].Name != "nvme0n1" || rates[1].Name != "sda" {
		t.Fatalf("physical disks only (nvme0n1, sda; not partitions, loop, dm, zram, md): %+v", rates)
	}
}

func TestDiskMeterRates(t *testing.T) {
	t.Parallel()
	m := NewDiskMeter(sysTree(t, []string{"sda", "dm-0"}, "sda"))
	t0 := time.Unix(1_800_000_000, 0)
	m.Sample(stats([2]any{"sda", DiskCounters{Reads: 100, SectorsRead: 1000, Writes: 50, SectorsWritten: 500}}), t0)
	// 2 s later: 40 reads, 2000 sectors read, 10 writes, 800 sectors written.
	rates, ok := m.Sample(stats([2]any{"sda", DiskCounters{Reads: 140, SectorsRead: 3000, Writes: 60, SectorsWritten: 1300}}), t0.Add(2*time.Second))
	want := DiskRate{Name: "sda", RIOPS: 20, WIOPS: 5, RBytes: 2000 * 512 / 2, WBytes: 800 * 512 / 2}
	if !ok || len(rates) != 1 || rates[0] != want {
		t.Fatalf("rates = %+v, want %+v", rates, want)
	}
}

func TestDiskMeterCounterGoingBackwardsResetsTheBaseline(t *testing.T) {
	t.Parallel()
	m := NewDiskMeter(sysTree(t, []string{"sda", "sdb"}, "sda", "sdb"))
	t0 := time.Unix(1_800_000_000, 0)
	m.Sample(stats(
		[2]any{"sda", DiskCounters{Reads: 1000, SectorsRead: 8000, Writes: 1000, SectorsWritten: 8000}},
		[2]any{"sdb", DiskCounters{Reads: 100, SectorsRead: 800, Writes: 100, SectorsWritten: 800}},
	), t0)
	rates, _ := m.Sample(stats(
		[2]any{"sda", DiskCounters{Reads: 5, SectorsRead: 40, Writes: 1100, SectorsWritten: 8800}}, // reads went backwards
		[2]any{"sdb", DiskCounters{Reads: 200, SectorsRead: 1600, Writes: 100, SectorsWritten: 800}},
	), t0.Add(time.Second))
	if rates[0].RIOPS != 0 || rates[0].WIOPS != 0 || rates[0].RBytes != 0 || rates[0].WBytes != 0 {
		t.Fatalf("sda restarts from this reading, no negative or invented rate: %+v", rates[0])
	}
	if rates[1].RIOPS != 100 {
		t.Fatalf("sdb is unaffected: %+v", rates[1])
	}
	rates, _ = m.Sample(stats(
		[2]any{"sda", DiskCounters{Reads: 25, SectorsRead: 200, Writes: 1100, SectorsWritten: 8800}},
		[2]any{"sdb", DiskCounters{Reads: 200, SectorsRead: 1600, Writes: 100, SectorsWritten: 800}},
	), t0.Add(2*time.Second))
	if rates[0].RIOPS != 20 || rates[0].RBytes != 160*512 {
		t.Fatalf("sda rates after the reset: %+v", rates[0])
	}
}

func TestDiskMeterRelistsSysBlockOnlyForNewNames(t *testing.T) {
	t.Parallel()
	root := sysTree(t, []string{"sda", "dm-0"}, "sda")
	m := NewDiskMeter(root)
	t0 := time.Unix(1_800_000_000, 0)
	c := DiskCounters{Reads: 1}
	two := stats([2]any{"sda", c}, [2]any{"dm-0", c})
	m.Sample(two, t0)

	// A disk appears in /sys but diskstats does not name it: no relist, so it stays unknown.
	if err := os.MkdirAll(filepath.Join(root, "block", "sdb", "device"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "block", "sda", "device")); err != nil {
		t.Fatal(err)
	}
	rates, _ := m.Sample(two, t0.Add(time.Second))
	if len(rates) != 1 || rates[0].Name != "sda" {
		t.Fatalf("no new name, no /sys/block read: %+v", rates)
	}
	// A new name does relist: sda lost its device link, sdb is physical.
	rates, _ = m.Sample(append(two, stats([2]any{"sdb", c})...), t0.Add(2*time.Second))
	if len(rates) != 1 || rates[0].Name != "sdb" {
		t.Fatalf("after the relist: %+v", rates)
	}
}

func TestDiskMeterNoPhysicalDisk(t *testing.T) {
	t.Parallel()
	m := NewDiskMeter(sysTree(t, []string{"loop0"}))
	t0 := time.Unix(1_800_000_000, 0)
	m.Sample(stats([2]any{"loop0", DiskCounters{}}), t0)
	rates, ok := m.Sample(stats([2]any{"loop0", DiskCounters{Reads: 5}}), t0.Add(time.Second))
	if !ok || len(rates) != 0 {
		t.Fatalf("rates = %+v ok=%v", rates, ok)
	}
}
