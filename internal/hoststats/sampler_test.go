package hoststats_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
	"github.com/JeffreyVdb/herdr-3d/internal/hoststats/hoststatstest"
)

type rig struct {
	t     *testing.T
	proc  string
	clock *hoststatstest.Clock
	s     *hoststats.Sampler
	reads atomic.Int64
	stats chan hoststats.Stats
	disks chan []hoststats.DiskRate
}

func writeProc(t *testing.T, proc, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(proc, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newRig(t *testing.T, upd hoststats.UpdatesConfig) *rig {
	t.Helper()
	r := &rig{t: t, proc: t.TempDir(), clock: hoststatstest.New(time.Unix(1_800_000_000, 0).UTC()),
		stats: make(chan hoststats.Stats, 16), disks: make(chan []hoststats.DiskRate, 16)}
	for _, n := range []string{"stat", "meminfo", "loadavg", "diskstats"} {
		b, err := os.ReadFile(filepath.Join("testdata", "proc", n))
		if err != nil {
			t.Fatal(err)
		}
		writeProc(t, r.proc, n, string(b))
	}
	r.s = hoststats.New(hoststats.Config{
		Proc: r.proc, Sys: "testdata/sys", Clock: r.clock, Updates: upd,
		Read: func(path string, buf []byte) ([]byte, error) {
			r.reads.Add(1)
			return os.ReadFile(path)
		},
	})
	return r
}

func (r *rig) start() (stop func()) {
	return r.s.Start(hoststats.Sink{
		Stats: func(_ context.Context, s hoststats.Stats) { r.stats <- s },
		Disk:  func(_ context.Context, d []hoststats.DiskRate) { r.disks <- d },
	})
}

func recv[T any](t *testing.T, ch <-chan T, what string) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatalf("no %s", what)
		panic("unreachable")
	}
}

func none[T any](t *testing.T, ch <-chan T, what string) {
	t.Helper()
	select {
	case v := <-ch:
		t.Fatalf("unexpected %s: %+v", what, v)
	case <-time.After(30 * time.Millisecond):
	}
}

func TestSamplerNothingReadBeforeStartAndAfterStop(t *testing.T) {
	r := newRig(t, hoststats.UpdatesConfig{})
	r.clock.Advance(time.Minute)
	if n := r.reads.Load(); n != 0 || r.clock.Live() != 0 {
		t.Fatalf("a Sampler never started read %d files and has %d timers", n, r.clock.Live())
	}
	stop := r.start()
	if r.reads.Load() == 0 {
		t.Fatal("Start takes its baselines")
	}
	stop()
	after := r.reads.Load()
	if r.clock.Live() != 0 {
		t.Fatalf("%d timers left after stop", r.clock.Live())
	}
	for range 10 {
		r.clock.Advance(time.Second)
	}
	none(t, r.stats, "stats after stop")
	none(t, r.disks, "disk after stop")
	if got := r.reads.Load(); got != after {
		t.Fatalf("read %d files after stop", got-after)
	}
	stop() // idempotent
}

func TestSamplerCadence(t *testing.T) {
	r := newRig(t, hoststats.UpdatesConfig{})
	stop := r.start()
	defer stop()

	// Busy: 100 more jiffies, 50 idle.
	writeProc(t, r.proc, "stat", "cpu  4755 356 584 3749 23 23 0 0 0 0\n")
	r.clock.Advance(time.Second)
	d := recv(t, r.disks, "first disk frame")
	if len(d) != 2 || d[0].Name != "nvme0n1" {
		t.Fatalf("disks = %+v", d)
	}
	st := recv(t, r.stats, "first stats frame, after 1 s")
	if st.CPUPct == nil || *st.CPUPct != 50 {
		t.Fatalf("cpu = %v", st.CPUPct)
	}
	if st.MemTotalBytes != 32768000*1024 || st.MemUsedBytes != (32768000-19300000)*1024 || st.MemUsedPct != 41.1 || st.Load1 != 0.82 || st.CPUs < 1 {
		t.Fatalf("stats = %+v", st)
	}
	if !st.SampledAt.Equal(time.Unix(1_800_000_001, 0)) || st.Updates != nil {
		t.Fatalf("sampled at %v updates %v", st.SampledAt, st.Updates)
	}

	// Disk every second, stats at 5 s.
	for i := 2; i <= 4; i++ {
		r.clock.Advance(time.Second)
		recv(t, r.disks, fmt.Sprintf("disk frame %d", i))
		none(t, r.stats, "stats before 5 s")
	}
	r.clock.Advance(time.Second)
	recv(t, r.disks, "disk frame 5")
	recv(t, r.stats, "stats at 5 s")
	r.clock.Advance(5 * time.Second)
	recv(t, r.stats, "stats at 10 s")
}

func TestSamplerRestartsFromABaseline(t *testing.T) {
	r := newRig(t, hoststats.UpdatesConfig{})
	stop := r.start()
	r.clock.Advance(time.Second)
	recv(t, r.stats, "stats")
	stop()
	// A second watcher session starts clean: its first CPU reading is against a new baseline.
	writeProc(t, r.proc, "stat", "cpu  4705 356 584 3799 23 23 0 0 0 0\n")
	stop = r.start()
	defer stop()
	writeProc(t, r.proc, "stat", "cpu  4705 356 584 3899 23 23 0 0 0 0\n") // 100 idle jiffies, 100 total since the baseline
	r.clock.Advance(time.Second)
	st := recv(t, r.stats, "stats of the second run")
	if st.CPUPct == nil || *st.CPUPct != 0 {
		t.Fatalf("cpu = %v", st.CPUPct)
	}
}

func TestSamplerCPUUnreadableStaysNull(t *testing.T) {
	r := newRig(t, hoststats.UpdatesConfig{})
	if err := os.Remove(filepath.Join(r.proc, "stat")); err != nil {
		t.Fatal(err)
	}
	stop := r.start()
	defer stop()
	r.clock.Advance(time.Second)
	if st := recv(t, r.stats, "stats"); st.CPUPct != nil {
		t.Fatalf("cpu = %v, want null", *st.CPUPct)
	}
}

type stubRunner struct{ runs atomic.Int64 }

func (s *stubRunner) Run(context.Context, string, []string) ([]byte, int, error) {
	s.runs.Add(1)
	return []byte("a 1 -> 2\nb 1 -> 2\n"), 0, nil
}

func TestSamplerUpdatesOnlyWhileRunning(t *testing.T) {
	rel := filepath.Join(t.TempDir(), "os-release")
	if err := os.WriteFile(rel, []byte("ID=omarchy\nID_LIKE=arch\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run := &stubRunner{}
	r := newRig(t, hoststats.UpdatesConfig{Runner: run, OSRelease: rel, Resolve: func(n string) string { return "/opt/bin/" + n }})
	r.clock.Advance(48 * time.Hour)
	if run.runs.Load() != 0 {
		t.Fatal("checkupdates ran with nobody watching")
	}
	stop := r.start()
	defer stop()
	r.clock.Advance(time.Second)
	recv(t, r.stats, "first stats") // starts the check, off the goroutine
	deadline := time.Now().Add(5 * time.Second)
	for run.runs.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	r.clock.Advance(4 * time.Second)
	var st hoststats.Stats
	for range 20 { // the result shows in a frame after the run ended
		st = recv(t, r.stats, "stats")
		if st.Updates != nil {
			break
		}
		r.clock.Advance(5 * time.Second)
	}
	if st.Updates == nil || st.Updates.Count != 2 {
		t.Fatalf("updates = %+v", st.Updates)
	}
	// Frames every 5 s for an hour: still one run.
	for range 12 {
		r.clock.Advance(5 * time.Second)
		recv(t, r.stats, "stats")
	}
	if n := run.runs.Load(); n != 1 {
		t.Fatalf("checkupdates ran %d times in a minute", n)
	}
}
