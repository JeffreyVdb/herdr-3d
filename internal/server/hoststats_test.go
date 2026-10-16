package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
	"github.com/JeffreyVdb/herdr-3d/internal/hoststats/hoststatstest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

const hostStatFixture = "cpu  100 0 100 800 0 0 0 0 0 0\n"

// hostRig is a bridge whose host is a fixture directory read on a fake clock.
type hostRig struct {
	*bridge
	clock *hoststatstest.Clock
	proc  string
	reads atomic.Int64
}

func newHostRig(t *testing.T) *hostRig {
	t.Helper()
	r := &hostRig{proc: t.TempDir(), clock: hoststatstest.New(time.Unix(1_800_000_000, 0).UTC())}
	files := map[string]string{
		"stat":      hostStatFixture,
		"meminfo":   "MemTotal: 1000000 kB\nMemAvailable: 600000 kB\n",
		"loadavg":   "0.50 0.40 0.30 1/100 1\n",
		"diskstats": " 8 0 sda 10 0 80 0 10 0 80 0 0 0 0\n",
	}
	for n, s := range files {
		if err := os.WriteFile(filepath.Join(r.proc, n), []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	sys := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sys, "block", "sda", "device"), 0o755); err != nil {
		t.Fatal(err)
	}
	rel := filepath.Join(t.TempDir(), "os-release")
	if err := os.WriteFile(rel, []byte("ID=debian\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.bridge = startBridge(t, "", server.Options{HostStats: &hoststats.Config{
		Proc: r.proc, Sys: sys, Clock: r.clock,
		Read: func(path string, _ []byte) ([]byte, error) {
			r.reads.Add(1)
			return os.ReadFile(path)
		},
		Updates: hoststats.UpdatesConfig{OSRelease: rel},
	}})
	return r
}

func (r *hostRig) client() *client {
	c := r.connect(proto.Hello{Client: "rack", Proto: proto.Version})
	c.snapshot()
	return c
}

func (r *hostRig) idle(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for r.clock.Live() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("the sampler still runs (%d timers)", r.clock.Live())
		}
		time.Sleep(time.Millisecond)
	}
}

// frames reads messages until it has one host.stats and one host.disk.
func (c *client) hostFrames() (proto.HostStats, proto.HostDisk, []byte) {
	c.t.Helper()
	var st proto.HostStats
	var d proto.HostDisk
	var raw []byte
	gotS, gotD := false, false
	for !gotS || !gotD {
		m := c.next()
		if m.env.Seq != 0 {
			c.t.Fatalf("host frames carry no seq: %s", m.raw)
		}
		switch m.env.T {
		case proto.THostStats:
			gotS, raw = true, m.raw
			if err := json.Unmarshal(m.raw, &st); err != nil {
				c.t.Fatal(err)
			}
		case proto.THostDisk:
			gotD = true
			if err := json.Unmarshal(m.raw, &d); err != nil {
				c.t.Fatal(err)
			}
		}
	}
	return st, d, raw
}

func TestHostWatchStartsAndStopsTheSampler(t *testing.T) {
	r := newHostRig(t)
	a := r.client()
	r.clock.Advance(time.Minute)
	if r.reads.Load() != 0 || r.clock.Live() != 0 {
		t.Fatalf("nothing watches yet, but the host was read %d times (%d timers)", r.reads.Load(), r.clock.Live())
	}

	if _, ack := a.mustAck(proto.CmdHostWatch, nil); ack.ReqID != proto.CmdHostWatch {
		t.Fatalf("ack = %+v", ack)
	}
	if r.reads.Load() == 0 {
		t.Fatal("the first watcher starts the sampler")
	}
	if _, _ = a.mustAck(proto.CmdHostWatch, nil); r.clock.Live() != 3 {
		t.Fatalf("host.watch twice is one watch and one sampler (timers %d)", r.clock.Live())
	}
	if err := os.WriteFile(filepath.Join(r.proc, "stat"), []byte("cpu  150 0 150 850 0 0 0 0 0 0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	r.clock.Advance(time.Second)
	st, disks, raw := a.hostFrames()
	if st.CPUPct == nil || *st.CPUPct != 66.7 || st.MemUsedPct != 40 || st.MemTotalBytes != 1000000*1024 || st.MemUsedBytes != 400000*1024 || st.Load1 != 0.5 || st.CPUs < 1 {
		t.Fatalf("stats = %+v", st)
	}
	if _, err := time.Parse(time.RFC3339, st.SampledAt); err != nil || st.SampledAt[len(st.SampledAt)-1] != 'Z' {
		t.Fatalf("sampled_at = %q, want RFC 3339 UTC", st.SampledAt)
	}
	var generic map[string]any
	_ = json.Unmarshal(raw, &generic)
	if _, has := generic["updates"]; has {
		t.Fatalf("a host that is not Arch-based reports no updates: %s", raw)
	}
	if len(disks.Disks) != 1 || disks.Disks[0].Name != "sda" {
		t.Fatalf("disks = %+v", disks)
	}

	// A second connection joins the running sampler and gets the latest frame at once.
	b := r.client()
	b.mustAck(proto.CmdHostWatch, nil)
	if m := b.next(); m.env.T != proto.THostStats {
		t.Fatalf("the late watcher's first message: %s", m.raw)
	}

	// One unwatches: sampling goes on for the other. The last one to go ends it.
	a.mustAck(proto.CmdHostUnwatch, nil)
	if r.clock.Live() == 0 {
		t.Fatal("a watcher is left, the sampler stays")
	}
	r.clock.Advance(4 * time.Second) // the stats tick comes at 5 s
	b.hostFrames()
	b.conn.CloseNow() // a disconnect drops its watch
	r.idle(t)
	reads := r.reads.Load()
	r.clock.Advance(time.Minute)
	if r.reads.Load() != reads || r.clock.Live() != 0 {
		t.Fatalf("read after the last watcher left: %d reads", r.reads.Load()-reads)
	}

	// Watching again starts a fresh run: no stale frame replays.
	c := r.client()
	c.mustAck(proto.CmdHostWatch, nil)
	r.clock.Advance(time.Second)
	c.hostFrames()
}

func TestHostFramesGoToWatchersOnly(t *testing.T) {
	r := newHostRig(t)
	watcher, other := r.client(), r.client()
	watcher.mustAck(proto.CmdHostWatch, nil)
	r.clock.Advance(time.Second)
	watcher.hostFrames()
	// The other connection got none: its next message is its own ack.
	other.send(proto.Command{T: proto.CmdHostUnwatch, ReqID: "x"})
	if m := other.next(); m.env.T != proto.TAck || m.env.ReqID != "x" {
		t.Fatalf("a connection that did not watch heard %s", m.raw)
	}
	// An unwatch of a connection that never watched changes nothing.
	if r.clock.Live() == 0 {
		t.Fatal("the watcher's sampler stopped")
	}
}

func TestHostUnwatchStopsTheSampler(t *testing.T) {
	r := newHostRig(t)
	a := r.client()
	a.mustAck(proto.CmdHostWatch, nil)
	r.clock.Advance(time.Second)
	a.hostFrames()
	a.mustAck(proto.CmdHostUnwatch, nil)
	r.idle(t)
	reads := r.reads.Load()
	r.clock.Advance(time.Hour)
	if r.reads.Load() != reads {
		t.Fatal("sampled after the last unwatch")
	}
	a.mustAck(proto.CmdHostUnwatch, nil) // idempotent
}
