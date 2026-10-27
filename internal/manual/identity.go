package manual

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// ParseStartTicks extracts field 22 after the last ')' in a Linux proc stat.
func ParseStartTicks(stat string) (uint64, error) {
	end := strings.LastIndexByte(stat, ')')
	if end < 0 {
		return 0, fmt.Errorf("invalid proc stat")
	}
	fields := strings.Fields(stat[end+1:])
	if len(fields) <= 19 {
		return 0, fmt.Errorf("short proc stat")
	}
	return strconv.ParseUint(fields[19], 10, 64)
}

func StartTicks(pid int) (uint64, error) {
	if pid <= 0 {
		return 0, fmt.Errorf("invalid pid")
	}
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, err
	}
	return ParseStartTicks(string(b))
}
