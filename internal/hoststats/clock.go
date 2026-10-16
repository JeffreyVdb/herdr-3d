package hoststats

import "time"

// Clock is the Sampler's time: the real one, or the fake of the tests
// (hoststatstest.Clock).
type Clock interface {
	Now() time.Time
	NewTicker(d time.Duration) Ticker
	NewTimer(d time.Duration) Ticker
}

// Ticker is a time.Ticker or time.Timer as the Sampler sees it.
type Ticker interface {
	C() <-chan time.Time
	Stop()
}

// RealClock is the wall clock.
type RealClock struct{}

type realTicker struct{ t *time.Ticker }
type realTimer struct{ t *time.Timer }

func (RealClock) Now() time.Time                   { return time.Now() }
func (RealClock) NewTicker(d time.Duration) Ticker { return realTicker{time.NewTicker(d)} }
func (RealClock) NewTimer(d time.Duration) Ticker  { return realTimer{time.NewTimer(d)} }
func (r realTicker) C() <-chan time.Time           { return r.t.C }
func (r realTicker) Stop()                         { r.t.Stop() }
func (r realTimer) C() <-chan time.Time            { return r.t.C }
func (r realTimer) Stop()                          { r.t.Stop() }
