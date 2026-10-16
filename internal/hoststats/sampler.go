package hoststats

import (
	"context"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Defaults of the Sampler's timings.
const (
	DefaultStatsEvery = 5 * time.Second // CPU, memory, updates
	DefaultDiskEvery  = time.Second     // diskstats
	DefaultFirstAfter = time.Second     // the first stats frame after a start
)

// Stats is one sample of CPU, memory and updates.
type Stats struct {
	// CPUPct is nil until two readings of /proc/stat exist.
	CPUPct        *float64
	CPUs          int
	Load1         float64
	MemUsedPct    float64
	MemUsedBytes  uint64
	MemTotalBytes uint64
	SampledAt     time.Time
	// Updates is nil when the host is not supported or no check worked yet.
	Updates *UpdatesResult
}

// Config configures a Sampler. The zero value samples the real host.
type Config struct {
	// Proc and Sys are the /proc and /sys roots (defaults /proc, /sys).
	Proc, Sys string
	// StatsEvery, DiskEvery and FirstAfter are the timings (defaults 5 s,
	// 1 s, 1 s).
	StatsEvery, DiskEvery, FirstAfter time.Duration
	// Clock is the time of the timers and of the rates (default RealClock).
	Clock Clock
	// Read reads a whole file into buf (default: a plain read of the file;
	// tests count the calls).
	Read func(path string, buf []byte) ([]byte, error)
	// Updates configures the pending-updates check; Updates.StateDir is
	// the bridge's own directory for CHECKUPDATES_DB.
	Updates UpdatesConfig
}

// Sampler samples the host while it is started. It does nothing between a
// Start's stop and the next Start: no timers, no reads, no checkupdates.
type Sampler struct {
	cfg Config
	upd *Updates
}

// New makes a stopped Sampler.
func New(cfg Config) *Sampler {
	if cfg.Proc == "" {
		cfg.Proc = "/proc"
	}
	if cfg.Sys == "" {
		cfg.Sys = "/sys"
	}
	if cfg.StatsEvery <= 0 {
		cfg.StatsEvery = DefaultStatsEvery
	}
	if cfg.DiskEvery <= 0 {
		cfg.DiskEvery = DefaultDiskEvery
	}
	if cfg.FirstAfter <= 0 {
		cfg.FirstAfter = DefaultFirstAfter
	}
	if cfg.Clock == nil {
		cfg.Clock = RealClock{}
	}
	if cfg.Read == nil {
		cfg.Read = readInto
	}
	return &Sampler{cfg: cfg, upd: NewUpdates(cfg.Updates, cfg.Clock.Now)}
}

// Sink receives the frames, on the sampler's goroutine. ctx ends when the
// run is stopped, so a sink that waits for something can give up.
type Sink struct {
	Stats func(ctx context.Context, s Stats)
	Disk  func(ctx context.Context, disks []DiskRate)
}

// Start begins a run: it takes the /proc/stat and /proc/diskstats baselines
// now, sends the first Stats after FirstAfter and then one every StatsEvery,
// and Disk every DiskEvery. The returned stop ends the run and waits for it
// (a Sink call in progress sees its ctx cancelled); no read happens after
// it returns. A Sampler runs one run at a time.
func (s *Sampler) Start(sink Sink) (stop func()) {
	s.upd.Refresh()
	ctx, cancel := context.WithCancel(context.Background())
	r := &run{s: s, ctx: ctx, sink: sink, disks: NewDiskMeter(s.cfg.Sys)}
	r.baseline()
	r.first = s.cfg.Clock.NewTimer(s.cfg.FirstAfter)
	r.stats = s.cfg.Clock.NewTicker(s.cfg.StatsEvery)
	r.disk = s.cfg.Clock.NewTicker(s.cfg.DiskEvery)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		r.loop()
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			wg.Wait()
			r.first.Stop()
			r.stats.Stop()
			r.disk.Stop()
		})
	}
}

// run is one Start to its stop. Its buffers and meters belong to its
// goroutine (and to Start, before the goroutine runs).
type run struct {
	s    *Sampler
	ctx  context.Context
	sink Sink

	first, stats, disk Ticker

	buf   []byte
	cpu   CPUMeter
	disks *DiskMeter
}

func (r *run) read(name string) []byte {
	b, err := r.s.cfg.Read(filepath.Join(r.s.cfg.Proc, name), r.buf)
	if cap(b) > cap(r.buf) {
		r.buf = b[:0]
	}
	if err != nil {
		return nil
	}
	return b
}

func (r *run) baseline() {
	if t, ok := ParseCPU(r.read("stat")); ok {
		r.cpu.Sample(t)
	}
	r.disks.Sample(r.read("diskstats"), r.s.cfg.Clock.Now())
}

func (r *run) loop() {
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-r.first.C():
			r.sampleStats()
		case <-r.stats.C():
			r.sampleStats()
		case <-r.disk.C():
			r.sampleDisk()
		}
	}
}

func (r *run) sampleStats() {
	now := r.s.cfg.Clock.Now()
	st := Stats{CPUs: runtime.NumCPU(), SampledAt: now}
	if t, ok := ParseCPU(r.read("stat")); ok {
		if pct, ok := r.cpu.Sample(t); ok {
			st.CPUPct = &pct
		}
	}
	if m, ok := ParseMem(r.read("meminfo")); ok {
		st.MemUsedPct, st.MemUsedBytes, st.MemTotalBytes = m.UsedPct(), m.UsedBytes(), m.Total
	}
	if l, ok := ParseLoad1(r.read("loadavg")); ok {
		st.Load1 = l
	}
	// A due updates check starts here at most once per Every, off this
	// goroutine; its result shows in the next frame.
	r.s.upd.Poll(r.ctx, nil)
	st.Updates = r.s.upd.Last()
	if r.ctx.Err() == nil && r.sink.Stats != nil {
		r.sink.Stats(r.ctx, st)
	}
}

func (r *run) sampleDisk() {
	rates, ok := r.disks.Sample(r.read("diskstats"), r.s.cfg.Clock.Now())
	if ok && r.ctx.Err() == nil && r.sink.Disk != nil {
		r.sink.Disk(r.ctx, rates)
	}
}
