package hoststats

import (
	"os"
	"path/filepath"
	"slices"
	"time"
)

// DiskRate is one physical disk's activity over the last interval, per
// second.
type DiskRate struct {
	Name   string
	RIOPS  float64
	WIOPS  float64
	RBytes float64
	WBytes float64
}

// DiskMeter turns /proc/diskstats readings into the rates of the physical
// disks. A device counts when /sys/block/<dev>/device exists: that drops
// loop, ram, zram, dm-* and md* devices, and partitions are not in
// /sys/block at all, so nothing is counted twice. /sys/block is listed again
// only when a device name appears in diskstats that was not seen before.
type DiskMeter struct {
	sys string

	known map[string]bool // every name seen in diskstats
	phys  map[string]bool // the physical ones among them
	prev  map[string]DiskCounters
	at    time.Time
	have  bool
}

// NewDiskMeter reads physical devices under the /sys root sys.
func NewDiskMeter(sys string) *DiskMeter {
	return &DiskMeter{sys: sys, known: map[string]bool{}, phys: map[string]bool{}, prev: map[string]DiskCounters{}}
}

// Sample takes the diskstats text read at now. The first call only sets the
// baseline (ok false). Afterwards it returns the disks sorted by name; a disk
// whose counter went backwards, or that is new, restarts from this reading
// and reports zero for the interval.
func (m *DiskMeter) Sample(b []byte, now time.Time) (rates []DiskRate, ok bool) {
	type dev struct {
		name string
		c    DiskCounters
	}
	var devs []dev
	fresh := false
	ParseDiskstats(b, func(name string, c DiskCounters) {
		devs = append(devs, dev{name, c})
		if !m.known[name] {
			m.known[name], fresh = true, true
		}
	})
	if fresh { // a name never seen: look at /sys/block again, once for all of them
		m.relist()
	}
	cur := make(map[string]DiskCounters, len(devs))
	for _, d := range devs {
		if m.phys[d.name] {
			cur[d.name] = d.c
		}
	}
	prevAt, had := m.at, m.have
	prev := m.prev
	m.prev, m.at, m.have = cur, now, true
	if !had {
		return nil, false
	}
	dt := now.Sub(prevAt).Seconds()
	if dt <= 0 {
		return nil, false
	}
	rates = make([]DiskRate, 0, len(cur))
	for name, c := range cur {
		r := DiskRate{Name: name}
		p, seen := prev[name]
		if seen && c.Reads >= p.Reads && c.Writes >= p.Writes && c.SectorsRead >= p.SectorsRead && c.SectorsWritten >= p.SectorsWritten {
			r.RIOPS = round1(float64(c.Reads-p.Reads) / dt)
			r.WIOPS = round1(float64(c.Writes-p.Writes) / dt)
			r.RBytes = float64(uint64(float64(c.SectorsRead-p.SectorsRead) * 512 / dt))
			r.WBytes = float64(uint64(float64(c.SectorsWritten-p.SectorsWritten) * 512 / dt))
		}
		rates = append(rates, r)
	}
	slices.SortFunc(rates, func(a, b DiskRate) int {
		switch {
		case a.Name < b.Name:
			return -1
		case a.Name > b.Name:
			return 1
		}
		return 0
	})
	return rates, true
}

// relist reads /sys/block again: the physical devices are the entries with a
// device link.
func (m *DiskMeter) relist() {
	ents, err := os.ReadDir(filepath.Join(m.sys, "block"))
	if err != nil {
		return
	}
	m.phys = make(map[string]bool, len(ents))
	for _, e := range ents {
		if _, err := os.Stat(filepath.Join(m.sys, "block", e.Name(), "device")); err == nil {
			m.phys[e.Name()] = true
		}
	}
}
