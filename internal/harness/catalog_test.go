package harness

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

type reply struct {
	list []proto.CommandEntry
	err  error
}

// scripted is a probe that answers each call with the next reply the test
// sends (or the catalog's ctx ending).
type scripted struct {
	calls   atomic.Int32
	dirs    chan string
	replies chan reply
}

func newScripted() *scripted {
	return &scripted{dirs: make(chan string, 16), replies: make(chan reply)}
}

func (s *scripted) probe(ctx context.Context, dir string) ([]proto.CommandEntry, error) {
	s.calls.Add(1)
	s.dirs <- dir
	select {
	case r := <-s.replies:
		return r.list, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

var (
	builtinRows = []proto.CommandEntry{{Name: "compact", Description: "summarize", Kind: proto.CommandKindBuiltin}}
	listA       = []proto.CommandEntry{{Name: "a", Kind: proto.CommandKindSkill}}
	listB       = []proto.CommandEntry{{Name: "b", Kind: proto.CommandKindCustom}}
)

// testCatalog is a catalog of one "codex" probe on a clock the test moves.
func testCatalog(t *testing.T) (*Catalog, *scripted, func(time.Duration)) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	p := newScripted()
	c := NewCatalog(ctx, nil, map[string]Probe{"codex": p.probe}, map[string][]proto.CommandEntry{"codex": builtinRows})
	var clock atomic.Int64
	c.now = func() time.Time { return time.Unix(0, clock.Load()) }
	t.Cleanup(func() {
		cancel()
		c.Wait()
	})
	return c, p, func(d time.Duration) { clock.Add(int64(d)) }
}

// async runs Commands in the background.
func async(c *Catalog, ctx context.Context, dir string) <-chan *proto.WorkerCommands {
	out := make(chan *proto.WorkerCommands, 1)
	go func() {
		res, _ := c.Commands(ctx, "codex", dir)
		out <- res
	}()
	return out
}

func mustCommands(t *testing.T, c *Catalog, dir string) *proto.WorkerCommands {
	t.Helper()
	res, err := c.Commands(context.Background(), "codex", dir)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestCatalogMissThenHit(t *testing.T) {
	c, p, advance := testCatalog(t)
	res := async(c, context.Background(), "/w")
	if dir := <-p.dirs; dir != "/w" {
		t.Fatalf("probed %q", dir)
	}
	select {
	case <-res:
		t.Fatal("a miss answered before its probe")
	case <-time.After(20 * time.Millisecond):
	}
	p.replies <- reply{list: listA}
	if got := <-res; !reflect.DeepEqual(got, &proto.WorkerCommands{Commands: listA}) {
		t.Fatalf("miss = %+v", got)
	}
	advance(catalogTTL)
	if got := mustCommands(t, c, "/w"); !reflect.DeepEqual(got.Commands, listA) || got.Partial {
		t.Fatalf("hit = %+v", got)
	}
	if n := p.calls.Load(); n != 1 {
		t.Fatalf("probes = %d: a fresh hit probes nothing", n)
	}
	// The answer is the caller's.
	got := mustCommands(t, c, "/w")
	got.Commands[0].Name = "mutated"
	if mustCommands(t, c, "/w").Commands[0].Name != "a" {
		t.Fatal("the cache shares its list")
	}
}

func TestCatalogStaleRefreshesInBackground(t *testing.T) {
	c, p, advance := testCatalog(t)
	res := async(c, context.Background(), "/w")
	<-p.dirs
	p.replies <- reply{list: listA}
	<-res
	advance(catalogTTL + time.Second)
	// Stale: the old list at once, and one refresh for any number of asks.
	for range 3 {
		if got := mustCommands(t, c, "/w"); !reflect.DeepEqual(got.Commands, listA) {
			t.Fatalf("stale = %+v", got)
		}
	}
	<-p.dirs
	if n := p.calls.Load(); n != 2 {
		t.Fatalf("probes = %d, want one refresh", n)
	}
	p.replies <- reply{list: listB}
	c.Wait()
	if got := mustCommands(t, c, "/w"); !reflect.DeepEqual(got, &proto.WorkerCommands{Commands: listB}) {
		t.Fatalf("refreshed = %+v", got)
	}
}

func TestCatalogSingleFlight(t *testing.T) {
	c, p, _ := testCatalog(t)
	var wg sync.WaitGroup
	results := make(chan *proto.WorkerCommands, 8)
	for range 8 {
		wg.Go(func() { results <- <-async(c, context.Background(), "/w") })
	}
	<-p.dirs
	time.Sleep(20 * time.Millisecond) // the others join the probe in flight
	p.replies <- reply{list: listA}
	wg.Wait()
	close(results)
	for got := range results {
		if !reflect.DeepEqual(got.Commands, listA) {
			t.Fatalf("got %+v", got)
		}
	}
	if n := p.calls.Load(); n != 1 {
		t.Fatalf("probes = %d, want 1", n)
	}
	// Keys are (harness, checkout): another checkout is its own probe.
	res := async(c, context.Background(), "/other")
	if dir := <-p.dirs; dir != "/other" {
		t.Fatalf("probed %q", dir)
	}
	p.replies <- reply{list: listB}
	if got := <-res; !reflect.DeepEqual(got.Commands, listB) {
		t.Fatalf("other = %+v", got)
	}
}

func TestCatalogFailureKeepsPreviousList(t *testing.T) {
	c, p, advance := testCatalog(t)
	res := async(c, context.Background(), "/w")
	<-p.dirs
	p.replies <- reply{list: listA}
	<-res
	advance(catalogTTL + time.Second)
	mustCommands(t, c, "/w")
	<-p.dirs
	p.replies <- reply{err: context.DeadlineExceeded} // the probe's 10 s
	c.Wait()
	if got := mustCommands(t, c, "/w"); !reflect.DeepEqual(got, &proto.WorkerCommands{Commands: listA}) {
		t.Fatalf("after a failed refresh = %+v", got)
	}
	if n := p.calls.Load(); n != 2 {
		t.Fatalf("probes = %d: no retry right after a failure", n)
	}
}

func TestCatalogNoListIsPartialBuiltins(t *testing.T) {
	c, p, advance := testCatalog(t)
	res := async(c, context.Background(), "/w")
	<-p.dirs
	p.replies <- reply{err: errors.New("codex: not found")}
	want := &proto.WorkerCommands{Commands: builtinRows, Partial: true}
	if got := <-res; !reflect.DeepEqual(got, want) {
		t.Fatalf("failed miss = %+v", got)
	}
	// Not cached as a success, but not retried in a hot loop either.
	if got := mustCommands(t, c, "/w"); !reflect.DeepEqual(got, want) || p.calls.Load() != 1 {
		t.Fatalf("right after = %+v, probes %d", got, p.calls.Load())
	}
	// Later the next ask retries, in the background.
	advance(catalogTTL + time.Second)
	if got := mustCommands(t, c, "/w"); !reflect.DeepEqual(got, want) {
		t.Fatalf("retry = %+v", got)
	}
	<-p.dirs
	p.replies <- reply{list: nil} // an empty catalog is a success
	c.Wait()
	if got := mustCommands(t, c, "/w"); got.Partial || got.Commands == nil || len(got.Commands) != 0 {
		t.Fatalf("after a successful retry = %+v", got)
	}
	// A harness without static built-ins answers [].
	c2 := NewCatalog(context.Background(), nil, map[string]Probe{"claude": func(context.Context, string) ([]proto.CommandEntry, error) {
		return nil, errors.New("no claude")
	}}, map[string][]proto.CommandEntry{"claude": {}})
	got, err := c2.Commands(context.Background(), "claude", "/w")
	if err != nil || !got.Partial || got.Commands == nil || len(got.Commands) != 0 {
		t.Fatalf("claude without a list = %+v, %v", got, err)
	}
}

func TestCatalogRequestEndsBeforeProbe(t *testing.T) {
	c, p, _ := testCatalog(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := c.Commands(ctx, "codex", "/w")
		done <- err
	}()
	<-p.dirs
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	// The probe goes on for the next ask; it does not start another.
	res := async(c, context.Background(), "/w")
	p.replies <- reply{list: listA}
	if got := <-res; !reflect.DeepEqual(got.Commands, listA) || p.calls.Load() != 1 {
		t.Fatalf("got %+v, probes %d", got, p.calls.Load())
	}
}

func TestCatalogUnknownHarness(t *testing.T) {
	c, p, _ := testCatalog(t)
	if _, err := c.Commands(context.Background(), "", "/w"); err == nil {
		t.Error("no harness accepted")
	}
	if _, err := c.Commands(context.Background(), "aider", "/w"); err == nil {
		t.Error("an unknown harness accepted")
	}
	if p.calls.Load() != 0 {
		t.Error("probed")
	}
}

func TestCatalogEvictsLeastRecentlyUsed(t *testing.T) {
	c, p, _ := testCatalog(t)
	c.max = 2
	get := func(dir string, probed bool) {
		t.Helper()
		res := async(c, context.Background(), dir)
		if probed {
			<-p.dirs
			p.replies <- reply{list: listA}
		}
		<-res
	}
	get("/a", true)
	get("/b", true)
	get("/a", false) // /b is now the least recently used
	get("/c", true)
	get("/a", false)
	get("/b", true) // evicted: a miss again
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := len(c.entries); n != 2 {
		t.Fatalf("entries = %d", n)
	}
}

func TestCatalogEvictionKeepsProbeInFlight(t *testing.T) {
	// /a's probe is held open; the others answer at once.
	held := newScripted()
	probe := func(ctx context.Context, dir string) ([]proto.CommandEntry, error) {
		if dir == "/a" {
			return held.probe(ctx, dir)
		}
		return listB, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := NewCatalog(ctx, nil, map[string]Probe{"codex": probe}, map[string][]proto.CommandEntry{"codex": builtinRows})
	t.Cleanup(func() {
		cancel()
		c.Wait()
	})
	c.max = 2
	first := async(c, context.Background(), "/a")
	<-held.dirs
	c.mu.Lock()
	probing := c.entries[catalogKey{"codex", "/a"}].probing
	c.mu.Unlock()
	for _, dir := range []string{"/b", "/c", "/d"} { // more keys than fit
		mustCommands(t, c, dir)
	}
	// An ask that ends at once still registers: it must join /a's probe.
	done, stop := context.WithCancel(context.Background())
	stop()
	if _, err := c.Commands(done, "codex", "/a"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	c.mu.Lock()
	e := c.entries[catalogKey{"codex", "/a"}]
	c.mu.Unlock()
	if e == nil || e.probing != probing {
		t.Fatal("/a's probe in flight was evicted: a second probe started")
	}
	second := async(c, context.Background(), "/a")
	held.replies <- reply{list: listA}
	for _, res := range []<-chan *proto.WorkerCommands{first, second} {
		if got := <-res; !reflect.DeepEqual(got, &proto.WorkerCommands{Commands: listA}) {
			t.Fatalf("waiter = %+v", got)
		}
	}
	c.Wait()
	if n := held.calls.Load(); n != 1 {
		t.Fatalf("probes for /a = %d, want 1", n)
	}
	// Once the probe ended, the next ask trims back to c.max.
	mustCommands(t, c, "/a")
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := len(c.entries); n != 2 {
		t.Fatalf("entries = %d", n)
	}
}

func TestCatalogTrimsWhenProbesEnd(t *testing.T) {
	// A burst of first asks, all probes held open: more keys than fit.
	p := newScripted()
	ctx, cancel := context.WithCancel(context.Background())
	c := NewCatalog(ctx, nil, map[string]Probe{"codex": p.probe}, map[string][]proto.CommandEntry{"codex": builtinRows})
	t.Cleanup(cancel)
	c.max = 2
	dirs := []string{"/a", "/b", "/c", "/d"}
	var res []<-chan *proto.WorkerCommands
	for _, dir := range dirs {
		res = append(res, async(c, context.Background(), dir))
		<-p.dirs
	}
	c.mu.Lock()
	if n := len(c.entries); n != len(dirs) {
		c.mu.Unlock()
		t.Fatalf("entries in flight = %d", n)
	}
	c.mu.Unlock()
	for range dirs {
		p.replies <- reply{list: listA}
	}
	for _, r := range res {
		<-r
	}
	c.Wait()
	// No further ask: the probes ending trimmed the cache back to c.max.
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := len(c.entries); n != 2 {
		t.Fatalf("entries = %d, want 2", n)
	}
}

func TestCatalogShutdownStopsProbes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	p := newScripted()
	c := NewCatalog(ctx, nil, map[string]Probe{"codex": p.probe}, map[string][]proto.CommandEntry{"codex": builtinRows})
	res := async(c, context.Background(), "/w")
	<-p.dirs
	cancel()
	c.Wait()
	if got := <-res; !got.Partial {
		t.Fatalf("got %+v", got)
	}
}
