package notify

import (
	"context"
	"sync"
	"time"
)

// Clock is the time the notifications go by: now, and timers (the done
// settle, the backoff, a pairing's expiry). Tests pass a FakeClock.
type Clock interface {
	Now() time.Time
	// NewTimer fires once after d.
	NewTimer(d time.Duration) Timer
}

// Timer is a Clock's timer.
type Timer interface {
	C() <-chan time.Time
	// Stop stops it; false when it fired or was stopped already.
	Stop() bool
}

// RealClock is the wall clock.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now() }

func (RealClock) NewTimer(d time.Duration) Timer { return realTimer{time.NewTimer(d)} }

type realTimer struct{ t *time.Timer }

func (r realTimer) C() <-chan time.Time { return r.t.C }
func (r realTimer) Stop() bool          { return r.t.Stop() }

// Sleep waits d on clock, or until ctx is done (its error).
func Sleep(ctx context.Context, clock Clock, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := clock.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// FakeClock is a Clock that moves only when told (Advance). Safe for
// concurrent use.
type FakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
	added  chan struct{}
}

// NewFakeClock starts at now.
func NewFakeClock(now time.Time) *FakeClock {
	return &FakeClock{now: now, added: make(chan struct{}, 1)}
}

func (f *FakeClock) Now() time.Time {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.now
}

func (f *FakeClock) NewTimer(d time.Duration) Timer {
	f.mu.Lock()
	t := &fakeTimer{clock: f, at: f.now.Add(d), c: make(chan time.Time, 1)}
	if d <= 0 {
		t.fired = true
		t.c <- f.now
	} else {
		f.timers = append(f.timers, t)
	}
	f.mu.Unlock()
	select {
	case f.added <- struct{}{}:
	default:
	}
	return t
}

// Advance moves the clock by d, firing the timers due.
func (f *FakeClock) Advance(d time.Duration) {
	f.mu.Lock()
	f.now = f.now.Add(d)
	keep := f.timers[:0]
	for _, t := range f.timers {
		if !t.at.After(f.now) {
			t.fired = true
			t.c <- f.now
			continue
		}
		keep = append(keep, t)
	}
	f.timers = keep
	f.mu.Unlock()
}

// Waiting is how many timers wait.
func (f *FakeClock) Waiting() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.timers)
}

// WaitFor blocks until at least n timers wait, or ctx is done (false).
func (f *FakeClock) WaitFor(ctx context.Context, n int) bool {
	for {
		if f.Waiting() >= n {
			return true
		}
		select {
		case <-f.added:
		case <-ctx.Done():
			return false
		case <-time.After(5 * time.Millisecond): // a timer stopped and another added between looks
		}
	}
}

type fakeTimer struct {
	clock *FakeClock
	at    time.Time
	c     chan time.Time
	fired bool
}

func (t *fakeTimer) C() <-chan time.Time { return t.c }

func (t *fakeTimer) Stop() bool {
	f := t.clock
	f.mu.Lock()
	defer f.mu.Unlock()
	if t.fired {
		return false
	}
	for i, x := range f.timers {
		if x == t {
			f.timers = append(f.timers[:i], f.timers[i+1:]...)
			return true
		}
	}
	return false
}
