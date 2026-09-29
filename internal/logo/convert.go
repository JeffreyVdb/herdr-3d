package logo

import (
	"context"
	"fmt"
	"time"
)

// Default limits of a Converter.
const (
	DefaultWorkers = 2
	DefaultWait    = 10 * time.Second
)

// Converter runs Normalize with at most a few conversions at once, and
// gives up waiting after a wall-clock limit.
//
// The limit stops the wait, not the work: the image libraries take no
// context, so a conversion that overruns keeps its slot (and its CPU) until it
// ends on its own. That bounds the damage to Workers busy goroutines, and the
// input limits (checkSVG, the pixel budget) bound how long each can run. A
// killable worker process would cut it off; it was left out for the added
// moving parts (the bridge would have to re-exec itself, on Linux only).
type Converter struct {
	slots chan struct{}
	wait  time.Duration
}

// NewConverter returns a converter with workers slots (default DefaultWorkers)
// and a limit of wait (default DefaultWait) for a slot and for the result,
// each.
func NewConverter(workers int, wait time.Duration) *Converter {
	if workers <= 0 {
		workers = DefaultWorkers
	}
	if wait <= 0 {
		wait = DefaultWait
	}
	return &Converter{slots: make(chan struct{}, workers), wait: wait}
}

// Convert normalises an upload, waiting for a free slot. It returns ErrBusy
// when there is none in time or the conversion does not finish in time.
func (c *Converter) Convert(ctx context.Context, data []byte) (Result, error) {
	timer := time.NewTimer(c.wait)
	defer timer.Stop()
	select {
	case c.slots <- struct{}{}:
	case <-timer.C:
		return Result{}, fmt.Errorf("%w: other logos are being converted", ErrBusy)
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
	type out struct {
		r   Result
		err error
	}
	done := make(chan out, 1)
	go func() {
		defer func() { <-c.slots }()
		r, err := Normalize(data)
		done <- out{r, err}
	}()
	timer.Reset(c.wait)
	select {
	case o := <-done:
		return o.r, o.err
	case <-timer.C:
		return Result{}, fmt.Errorf("%w: the conversion took too long", ErrBusy)
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}
