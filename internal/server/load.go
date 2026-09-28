package server

import (
	"bufio"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// HostLoad reads the host's load from /proc (Options.Load): the 1-minute
// load average, the CPU count and the share of memory in use. It returns
// nil when /proc cannot be read.
func HostLoad() *proto.HostLoad { return readLoad("/proc") }

func readLoad(proc string) *proto.HostLoad {
	b, err := os.ReadFile(filepath.Join(proc, "loadavg"))
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return nil
	}
	load1, err := strconv.ParseFloat(f[0], 64)
	if err != nil {
		return nil
	}
	l := &proto.HostLoad{Load1: load1, CPUs: runtime.NumCPU()}
	if pct, ok := memUsed(filepath.Join(proc, "meminfo")); ok {
		l.MemUsedPct = pct
	}
	return l
}

// memUsed is (MemTotal - MemAvailable) / MemTotal, in percent, rounded to
// a tenth.
func memUsed(path string) (float64, bool) {
	fh, err := os.Open(path)
	if err != nil {
		return 0, false
	}
	defer fh.Close()
	var total, avail float64
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(v)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseFloat(fields[0], 64)
		if err != nil {
			continue
		}
		switch k {
		case "MemTotal":
			total = n
		case "MemAvailable":
			avail = n
		}
	}
	if total <= 0 {
		return 0, false
	}
	pct := (total - avail) / total * 100
	return float64(int(pct*10+0.5)) / 10, true
}
