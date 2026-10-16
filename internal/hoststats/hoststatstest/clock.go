// Package hoststatstest is the fake clock of hoststats' tests and the
// server's.
package hoststatstest

import (
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/hoststats"
)

// Clock is a settable clock whose tickers and timers fire when Advance
// passes them. A tick is dropped when its channel is full, as time.Ticker's
// is.
type Clock struct {
	mu   sync.Mutex
	now  time.Time
	subs []*sub
}

type sub struct {
	c       *Clock
	ch      chan time.Time
	at      time.Time
	every   time.Duration // 0: a timer
	stopped bool
}

// New starts a clock at t.
func New(t time.Time) *Clock { return &Clock{now: t} }

// Now implements hoststats.Clock.
func (c *Clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *Clock) add(d, every time.Duration) hoststats.Ticker {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := &sub{c: c, ch: make(chan time.Time, 1), at: c.now.Add(d), every: every}
	c.subs = append(c.subs, s)
	return s
}

// NewTicker implements hoststats.Clock.
func (c *Clock) NewTicker(d time.Duration) hoststats.Ticker { return c.add(d, d) }

// NewTimer implements hoststats.Clock.
func (c *Clock) NewTimer(d time.Duration) hoststats.Ticker { return c.add(d, 0) }

// Live is how many tickers and timers have not been stopped.
func (c *Clock) Live() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, s := range c.subs {
		if !s.stopped {
			n++
		}
	}
	return n
}

// Advance moves the clock by d, firing what comes due on the way in time
// order (the clock reads as the firing's time while its tick is sent).
func (c *Clock) Advance(d time.Duration) {
	c.mu.Lock()
	end := c.now.Add(d)
	for {
		var next *sub
		for _, s := range c.subs {
			if !s.stopped && !s.at.After(end) && (next == nil || s.at.Before(next.at)) {
				next = s
			}
		}
		if next == nil {
			break
		}
		c.now = next.at
		select {
		case next.ch <- next.at:
		default:
		}
		if next.every > 0 {
			next.at = next.at.Add(next.every)
		} else {
			next.stopped = true
		}
	}
	c.now = end
	c.mu.Unlock()
}

// C implements hoststats.Ticker.
func (s *sub) C() <-chan time.Time { return s.ch }

// Stop implements hoststats.Ticker.
func (s *sub) Stop() {
	s.c.mu.Lock()
	s.stopped = true
	s.c.mu.Unlock()
}
