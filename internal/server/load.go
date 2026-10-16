package server

import (
	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// HostLoad reads the host's load from /proc (Options.Load): the 1-minute
// load average, the CPU count and the share of memory in use. It returns
// nil when /proc cannot be read. The reading is hoststats', shared with the
// server rack (#74).
func HostLoad() *proto.HostLoad {
	l := hoststats.HostLoad()
	if l == nil {
		return nil
	}
	return &proto.HostLoad{Load1: l.Load1, CPUs: l.CPUs, MemUsedPct: l.MemUsedPct}
}
