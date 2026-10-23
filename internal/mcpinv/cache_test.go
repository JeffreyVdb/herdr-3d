package mcpinv

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// clock is a settable time.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *clock { return &clock{now: time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)} }

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// fakeReads is a Reader whose reads are counted per key and answered by
// fn; gate, when set, holds every read until it is closed.
type fakeReads struct {
	mu    sync.Mutex
	calls map[Key]int
	gate  chan struct{}
	fn    func(key Key, n int) (proto.MCPProvider, error)
}

func (f *fakeReads) read(ctx context.Context, key Key) (proto.MCPProvider, error) {
	f.mu.Lock()
	if f.calls == nil {
		f.calls = map[Key]int{}
	}
	f.calls[key]++
	n, gate := f.calls[key], f.gate
	f.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return proto.MCPProvider{}, ctx.Err()
		}
	}
	return f.fn(key, n)
}

func (f *fakeReads) count(key Key) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[key]
}

// served is a provider naming its key and read number in one server.
func served(key Key, n int) (proto.MCPProvider, error) {
	p := emptyProvider()
	p.Config.State = proto.MCPStateOK
	p.Servers = []proto.MCPServer{{Name: fmt.Sprintf("%s|%s|%d", key.Cwd, key.Home, n), Source: "user", Transport: "stdio",
		Approval: proto.MCPApprovalNA, Status: proto.MCPStatusNotChecked, StatusScope: proto.MCPScopeConfig}}
	p.Skills.State = proto.MCPStateOK
	return p, nil
}

func newService(t *testing.T, c *clock, f *fakeReads, o Options) *Service {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	if o.Read == nil {
		o.Read = map[string]Reader{Codex: f.read, Claude: f.read}
	}
	o.Now = c.Now
	s := New(ctx, o)
	t.Cleanup(func() {
		cancel()
		s.Wait()
	})
	return s
}

func name(p proto.MCPProvider) string {
	if len(p.Servers) == 0 {
		return ""
	}
	return p.Servers[0].Name
}

// waitFor polls cond (a background read ending) for up to 2 s.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for range 200 {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition never held")
}

func TestServiceFreshStaleAndRevalidate(t *testing.T) {
	c := newClock()
	f := &fakeReads{fn: served}
	s := newService(t, c, f, Options{})
	key := Key{Codex, "/r/x", "/h/.codex"}

	p := s.Inventory(context.Background(), key)
	if name(p) != "/r/x|/h/.codex|1" || p.Config.State != proto.MCPStateOK || p.Config.ReadAt == nil || *p.Config.ReadAt != "2026-10-23T12:00:00Z" ||
		p.Config.Stale || p.Skills.ReadAt == nil {
		t.Fatalf("first = %+v", p)
	}
	c.add(15 * time.Second) // still fresh: no read
	if p := s.Inventory(context.Background(), key); name(p) != "/r/x|/h/.codex|1" || f.count(key) != 1 {
		t.Fatalf("fresh = %+v, reads %d", p, f.count(key))
	}
	c.add(time.Second) // stale: answered at once, refreshed in the background
	if p := s.Inventory(context.Background(), key); name(p) != "/r/x|/h/.codex|1" || p.Config.Stale {
		t.Fatalf("stale answer = %+v", p)
	}
	waitFor(t, func() bool { return name(s.Inventory(context.Background(), key)) == "/r/x|/h/.codex|2" })
	if f.count(key) != 2 {
		t.Fatalf("reads = %d", f.count(key))
	}
}

// Concurrent requests share one read per key; keys differing in cwd or
// config home (a Codex profile) are read and answered apart.
func TestServiceCoalescesAndIsolates(t *testing.T) {
	c := newClock()
	f := &fakeReads{fn: served, gate: make(chan struct{})}
	s := newService(t, c, f, Options{})
	keys := []Key{{Codex, "/r/x", "/h/.codex"}, {Codex, "/r/x", "/h/.codex-work"}, {Codex, "/r/y", "/h/.codex"}, {Codex, "", "/h/.codex"},
		{Claude, "/r/x", "/h/.codex"}}
	var wg sync.WaitGroup
	got := make([][]string, len(keys))
	var mu sync.Mutex
	for i, k := range keys {
		for range 10 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				p := s.Inventory(context.Background(), k)
				mu.Lock()
				got[i] = append(got[i], name(p))
				mu.Unlock()
			}()
		}
	}
	waitFor(t, func() bool {
		for _, k := range keys {
			if f.count(k) != 1 {
				return false
			}
		}
		return true
	})
	close(f.gate)
	wg.Wait()
	for i, k := range keys {
		want := k.Cwd + "|" + k.Home + "|1"
		for _, n := range got[i] {
			if n != want {
				t.Fatalf("key %v answered %q", k, n)
			}
		}
		if f.count(k) != 1 {
			t.Fatalf("key %v read %d times", k, f.count(k))
		}
	}
}

// A first read is waited for up to Wait; then the answer is pending (never
// an empty success), and a later request gets the read.
func TestServicePendingFirstRead(t *testing.T) {
	c := newClock()
	f := &fakeReads{fn: served, gate: make(chan struct{})}
	s := newService(t, c, f, Options{Wait: 50 * time.Millisecond})
	key := Key{Codex, "/r/x", "/h/.codex"}
	p := s.Inventory(context.Background(), key)
	if p.Config.State != proto.MCPStatePending || p.Skills.State != proto.MCPStatePending || len(p.Servers) != 0 || p.Config.ReadAt != nil {
		t.Fatalf("pending = %+v", p)
	}
	close(f.gate)
	waitFor(t, func() bool { return s.Inventory(context.Background(), key).Config.State == proto.MCPStateOK })
	if f.count(key) != 1 {
		t.Fatalf("reads = %d", f.count(key))
	}
}

// A failed read keeps the last good one, stale; retries back off 30 s
// doubling to 5 min; a success resets it. With no good read the answer is
// failed with the read's note.
func TestServiceFailureAndBackoff(t *testing.T) {
	c := newClock()
	var fail atomic.Bool
	f := &fakeReads{fn: func(key Key, n int) (proto.MCPProvider, error) {
		if fail.Load() {
			return proto.MCPProvider{}, &Failure{Note: "Codex app-server did not answer in time", Cause: errors.New("raw: secret stderr")}
		}
		return served(key, n)
	}}
	s := newService(t, c, f, Options{})
	key := Key{Codex, "/r/x", "/h/.codex"}
	s.Inventory(context.Background(), key)

	fail.Store(true)
	reads := 1
	// The first failed read is the revalidation after Fresh.
	c.add(16 * time.Second)
	s.Inventory(context.Background(), key)
	reads++
	waitFor(t, func() bool { return s.Inventory(context.Background(), key).Config.Stale })
	p := s.Inventory(context.Background(), key)
	if name(p) != "/r/x|/h/.codex|1" || !p.Config.Stale || !p.Skills.Stale || p.Config.State != proto.MCPStateOK ||
		!strings.Contains(p.Config.Note, "did not answer in time") || strings.Contains(p.Config.Note, "secret") {
		t.Fatalf("stale = %+v", p)
	}
	for _, wait := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute} {
		c.add(wait - time.Second)
		s.Inventory(context.Background(), key)
		if f.count(key) != reads {
			t.Fatalf("read inside the %v backoff", wait)
		}
		c.add(time.Second)
		s.Inventory(context.Background(), key)
		reads++
		waitFor(t, func() bool { return f.count(key) == reads })
		waitFor(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.keys[key].reading == nil })
	}
	fail.Store(false)
	c.add(5 * time.Minute)
	s.Inventory(context.Background(), key)
	waitFor(t, func() bool { return !s.Inventory(context.Background(), key).Config.Stale })

	// No good read at all: failed, not an empty success.
	fail.Store(true)
	other := Key{Codex, "/r/y", "/h/.codex"}
	p = s.Inventory(context.Background(), other)
	if p.Config.State != proto.MCPStateFailed || p.Skills.State != proto.MCPStateFailed || p.Config.Note != "Codex app-server did not answer in time" {
		t.Fatalf("failed = %+v", p)
	}
}

// At most Max keys are kept, the least recently used dropped first.
func TestServiceLRU(t *testing.T) {
	c := newClock()
	f := &fakeReads{fn: served}
	s := newService(t, c, f, Options{Max: 3})
	k := func(i int) Key { return Key{Claude, fmt.Sprintf("/r/%d", i), "/h"} }
	for i := range 3 {
		s.Inventory(context.Background(), k(i))
	}
	s.Inventory(context.Background(), k(0)) // used again: kept
	s.Inventory(context.Background(), k(3))
	waitFor(t, func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.keys) == 3 })
	s.Inventory(context.Background(), k(0))
	s.Inventory(context.Background(), k(1)) // evicted: read again
	if f.count(k(0)) != 1 || f.count(k(1)) != 2 {
		t.Fatalf("reads %d %d", f.count(k(0)), f.count(k(1)))
	}
}

// Checks are coalesced per key, at most one per CheckEvery (a request
// inside it answers the last), and their statuses stay on the inventory.
func TestServiceChecks(t *testing.T) {
	c := newClock()
	f := &fakeReads{fn: func(key Key, n int) (proto.MCPProvider, error) {
		p, _ := served(key, n)
		p.Servers = append(p.Servers, proto.MCPServer{Name: "off", Status: proto.MCPStatusDisabled, StatusScope: proto.MCPScopeConfig},
			proto.MCPServer{Name: "kept", Status: proto.MCPStatusNotChecked, StatusScope: proto.MCPScopeConfig})
		return p, nil
	}}
	gate := make(chan struct{})
	var checks atomic.Int32
	check := func(ctx context.Context, key Key) (CheckResult, error) {
		checks.Add(1)
		<-gate
		return CheckResult{State: proto.MCPCheckOK, Version: "0.163.0", Rows: []Observed{
			{Name: "off", Status: proto.MCPStatusUnknown}, {Name: "conn", Status: proto.MCPStatusConnected, Source: proto.MCPSourceConnector, Transport: "http"},
			{Name: key.Cwd + "|" + key.Home + "|1", Status: proto.MCPStatusFailed, Reason: "Connection closed"}}}, nil
	}
	s := newService(t, c, f, Options{Check: map[string]Checker{Codex: check}})
	key := Key{Codex, "/r/x", "/h/.codex"}
	var wg sync.WaitGroup
	answers := make(chan proto.MCPProvider, 5)
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			answers <- s.Check(context.Background(), key)
		}()
	}
	waitFor(t, func() bool { return checks.Load() == 1 })
	close(gate)
	wg.Wait()
	close(answers)
	for p := range answers {
		if p.Check.State != proto.MCPCheckOK || p.Check.At == nil || p.Version != "0.163.0" {
			t.Fatalf("check = %+v", p.Check)
		}
		byName := map[string]proto.MCPServer{}
		for _, s := range p.Servers {
			byName[s.Name] = s
		}
		if s := byName["/r/x|/h/.codex|1"]; s.Status != proto.MCPStatusFailed || s.StatusScope != proto.MCPScopeProbe || s.Reason != "Connection closed" || s.StatusAt == nil {
			t.Fatalf("checked server = %+v", s)
		}
		if s := byName["off"]; s.Status != proto.MCPStatusDisabled || s.StatusScope != proto.MCPScopeConfig {
			t.Fatalf("a disabled server the check knows nothing of stays disabled: %+v", s)
		}
		if s := byName["kept"]; s.Status != proto.MCPStatusNotChecked || s.StatusScope != proto.MCPScopeConfig {
			t.Fatalf("a server the check omitted keeps its config status: %+v", s)
		}
		if s := byName["conn"]; s.Source != proto.MCPSourceConnector || s.Status != proto.MCPStatusConnected || s.StatusScope != proto.MCPScopeProbe {
			t.Fatalf("a server only the check saw is added: %+v", s)
		}
	}
	// Inside 30 s: the last check's result, no new check.
	c.add(29 * time.Second)
	if p := s.Check(context.Background(), key); checks.Load() != 1 || p.Check.At == nil || *p.Check.At != "2026-10-23T12:00:00Z" {
		t.Fatalf("rate limit: %d checks, %+v", checks.Load(), p.Check)
	}
	// The inventory carries the last check.
	if p := s.Inventory(context.Background(), key); p.Check.State != proto.MCPCheckOK {
		t.Fatalf("inventory check = %+v", p.Check)
	}
	c.add(time.Second)
	s.Check(context.Background(), key)
	if checks.Load() != 2 {
		t.Fatalf("checks = %d", checks.Load())
	}
	// Another key is checked apart.
	s.Check(context.Background(), Key{Codex, "/r/x", "/h/.codex-work"})
	if checks.Load() != 3 {
		t.Fatalf("checks = %d", checks.Load())
	}
}

// A check that failed is answered failed with its note, never raw text.
func TestServiceCheckFailure(t *testing.T) {
	c := newClock()
	f := &fakeReads{fn: served}
	s := newService(t, c, f, Options{Check: map[string]Checker{Claude: func(context.Context, Key) (CheckResult, error) {
		return CheckResult{}, &Failure{Note: "Claude Code check failed", Cause: errors.New("stderr: SECRET")}
	}}})
	p := s.Check(context.Background(), Key{Claude, "/r/x", "/h/.claude"})
	if p.Check.State != proto.MCPCheckFailed || p.Check.Note != "Claude Code check failed" || p.Servers[0].StatusScope != proto.MCPScopeConfig {
		t.Fatalf("check = %+v", p)
	}
}

func TestApplyObservation(t *testing.T) {
	p, _ := served(Key{Codex, "/r", "/h"}, 1)
	applyCheck(&p, CheckResult{State: proto.MCPCheckOK, Rows: []Observed{{Name: "/r|/h|1", Status: proto.MCPStatusFailed}}}, newClock().Now())
	w := proto.MCPWorker{ID: "w1", Name: "Ada"}
	ApplyObservation(&p, WorkerObservation{Worker: w, At: newClock().Now().Add(-time.Minute), Rows: []Observed{{Name: "/r|/h|1", Status: proto.MCPStatusConnected}}})
	if s := p.Servers[0]; s.Status != proto.MCPStatusFailed || s.Worker != nil {
		t.Fatalf("an older observation does not win: %+v", s)
	}
	ApplyObservation(&p, WorkerObservation{Worker: w, At: newClock().Now().Add(time.Minute), Rows: []Observed{{Name: "/r|/h|1", Status: proto.MCPStatusConnected}}})
	if s := p.Servers[0]; s.Status != proto.MCPStatusConnected || s.StatusScope != proto.MCPScopeWorker || s.Worker == nil || s.Worker.Name != "Ada" {
		t.Fatalf("a newer observation wins: %+v", s)
	}
}
