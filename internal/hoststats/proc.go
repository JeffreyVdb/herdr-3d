package hoststats

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
)

// Load is the host's load for hire capacity: the 1-minute load average, the
// CPU count and the share of memory in use.
type Load struct {
	Load1      float64
	CPUs       int
	MemUsedPct float64
}

// HostLoad reads the host's load from /proc, or nil when it cannot be read.
func HostLoad() *Load { return ReadLoad("/proc") }

// ReadLoad is HostLoad over a /proc root.
func ReadLoad(proc string) *Load {
	b, err := os.ReadFile(filepath.Join(proc, "loadavg"))
	if err != nil {
		return nil
	}
	load1, ok := ParseLoad1(b)
	if !ok {
		return nil
	}
	l := &Load{Load1: load1, CPUs: runtime.NumCPU()}
	if mb, err := os.ReadFile(filepath.Join(proc, "meminfo")); err == nil {
		if m, ok := ParseMem(mb); ok {
			l.MemUsedPct = m.UsedPct()
		}
	}
	return l
}

// ParseLoad1 is the first field of /proc/loadavg.
func ParseLoad1(b []byte) (float64, bool) {
	f, _ := nextField(b)
	if len(f) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(string(f), 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// CPUTimes are the aggregate `cpu` line of /proc/stat, in jiffies: Idle is
// idle + iowait and Total the sum of user, nice, system, idle, iowait, irq,
// softirq and steal. guest and guest_nice are left out, as they are already
// counted in user and nice.
type CPUTimes struct{ Idle, Total uint64 }

// ParseCPU reads the aggregate `cpu` line of /proc/stat.
func ParseCPU(b []byte) (CPUTimes, bool) {
	for len(b) > 0 {
		var line []byte
		line, b = cutLine(b)
		if !bytes.HasPrefix(line, []byte("cpu")) || len(line) < 4 || line[3] != ' ' {
			continue
		}
		rest := line[4:]
		var v [8]uint64
		n := 0
		for n < len(v) {
			var f []byte
			f, rest = nextField(rest)
			if len(f) == 0 {
				break
			}
			x, err := strconv.ParseUint(string(f), 10, 64)
			if err != nil {
				return CPUTimes{}, false
			}
			v[n] = x
			n++
		}
		if n < 4 { // user nice system idle at least
			return CPUTimes{}, false
		}
		var total uint64
		for _, x := range v[:n] {
			total += x
		}
		return CPUTimes{Idle: v[3] + v[4], Total: total}, true
	}
	return CPUTimes{}, false
}

// CPUMeter turns successive CPUTimes into a usage percentage.
type CPUMeter struct {
	prev CPUTimes
	have bool
	last float64
	ok   bool
}

// Sample takes the next reading and returns cpu% = 1 - Δidle/Δtotal, in
// percent. ok is false until two readings exist. When Δtotal <= 0 (a counter
// reset, a suspend) the previous value is kept.
func (m *CPUMeter) Sample(t CPUTimes) (pct float64, ok bool) {
	prev, had := m.prev, m.have
	m.prev, m.have = t, true
	if !had {
		return 0, false
	}
	if t.Total <= prev.Total {
		return m.last, m.ok
	}
	dTotal := float64(t.Total - prev.Total)
	dIdle := 0.0
	if t.Idle > prev.Idle {
		dIdle = float64(t.Idle - prev.Idle)
	}
	p := (1 - dIdle/dTotal) * 100
	p = min(max(p, 0), 100)
	m.last, m.ok = round1(p), true
	return m.last, true
}

// Mem is /proc/meminfo's MemTotal and MemAvailable, in bytes.
type Mem struct{ Total, Available uint64 }

// ParseMem reads MemTotal and MemAvailable (both in kB there).
func ParseMem(b []byte) (Mem, bool) {
	var m Mem
	var gotT, gotA bool
	for len(b) > 0 && !(gotT && gotA) {
		var line []byte
		line, b = cutLine(b)
		var dst *uint64
		switch {
		case bytes.HasPrefix(line, []byte("MemTotal:")):
			dst, gotT = &m.Total, true
		case bytes.HasPrefix(line, []byte("MemAvailable:")):
			dst, gotA = &m.Available, true
		default:
			continue
		}
		_, rest := cutField(line, ':')
		f, _ := nextField(rest)
		n, err := strconv.ParseUint(string(f), 10, 64)
		if err != nil {
			return Mem{}, false
		}
		*dst = n * 1024
	}
	if m.Total == 0 {
		return Mem{}, false
	}
	return m, true
}

// UsedBytes is MemTotal - MemAvailable, the `used` column of free.
func (m Mem) UsedBytes() uint64 {
	if m.Available >= m.Total {
		return 0
	}
	return m.Total - m.Available
}

// UsedPct is UsedBytes over the total, in percent, rounded to a tenth.
func (m Mem) UsedPct() float64 {
	if m.Total == 0 {
		return 0
	}
	return round1(float64(m.UsedBytes()) / float64(m.Total) * 100)
}

// DiskCounters are one device's cumulative /proc/diskstats counters: reads
// and writes completed, and sectors (always 512 bytes) read and written.
type DiskCounters struct{ Reads, SectorsRead, Writes, SectorsWritten uint64 }

// ParseDiskstats calls fn with every device line of /proc/diskstats (fields
// 3, 4, 6, 8 and 10 of a line: the name, reads, sectors read, writes and
// sectors written). A line too short or malformed is skipped.
func ParseDiskstats(b []byte, fn func(name string, c DiskCounters)) {
	for len(b) > 0 {
		var line []byte
		line, b = cutLine(b)
		var f [10][]byte
		rest, n := line, 0
		for n < len(f) {
			var x []byte
			x, rest = nextField(rest)
			if len(x) == 0 {
				break
			}
			f[n] = x
			n++
		}
		if n < len(f) {
			continue
		}
		var c DiskCounters
		ok := true
		for i, dst := range []*uint64{&c.Reads, &c.SectorsRead, &c.Writes, &c.SectorsWritten} {
			v, err := strconv.ParseUint(string(f[[]int{3, 5, 7, 9}[i]]), 10, 64)
			if err != nil {
				ok = false
				break
			}
			*dst = v
		}
		if ok {
			fn(string(f[2]), c)
		}
	}
}

func round1(f float64) float64 { return float64(int64(f*10+0.5)) / 10 }

func cutLine(b []byte) (line, rest []byte) {
	if i := bytes.IndexByte(b, '\n'); i >= 0 {
		return b[:i], b[i+1:]
	}
	return b, nil
}

func cutField(b []byte, sep byte) (before, after []byte) {
	if i := bytes.IndexByte(b, sep); i >= 0 {
		return b[:i], b[i+1:]
	}
	return b, nil
}

// nextField returns the next run of non-blank bytes of b and what follows.
func nextField(b []byte) (field, rest []byte) {
	i := 0
	for i < len(b) && (b[i] == ' ' || b[i] == '\t') {
		i++
	}
	j := i
	for j < len(b) && b[j] != ' ' && b[j] != '\t' && b[j] != '\n' {
		j++
	}
	return b[i:j], b[j:]
}

// readInto reads a whole (proc) file into buf, growing it when it is too
// small, and returns the bytes read; the caller keeps the result as the
// next buf.
func readInto(path string, buf []byte) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return buf[:0], err
	}
	defer f.Close()
	if cap(buf) == 0 {
		buf = make([]byte, 0, 8<<10)
	}
	buf = buf[:0]
	for {
		if len(buf) == cap(buf) {
			buf = append(buf, 0)[:len(buf)]
		}
		n, err := f.Read(buf[len(buf):cap(buf)])
		buf = buf[:len(buf)+n]
		if errors.Is(err, io.EOF) {
			return buf, nil
		}
		if err != nil {
			return buf, err
		}
	}
}
