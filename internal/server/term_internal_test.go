package server

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
)

// A watch's queue holds one merged frame of at most maxPendingFrame bytes:
// a full frame replaces what is pending, diffs are appended, and past the
// bound it overflows and keeps nothing more.
func TestWatchQueueIsBounded(t *testing.T) {
	q := newWatchQueue()
	q.put(herdr.Frame{Data: []byte("diff before any full frame")})
	if _, _, _, _, ok, err := q.take(); ok || err != nil {
		t.Fatalf("a diff before the first full frame was kept (%v)", err)
	}
	q.put(herdr.Frame{Full: true, Width: 80, Height: 24, Data: []byte("old")})
	q.put(herdr.Frame{Full: true, Width: 80, Height: 24, Data: []byte("new")})
	q.put(herdr.Frame{Width: 80, Height: 24, Data: []byte("+d")})
	if data, full, cols, rows, ok, err := q.take(); !ok || err != nil || !full || string(data) != "new+d" || cols != 80 || rows != 24 {
		t.Fatalf("take = %q full %v %dx%d ok %v err %v", data, full, cols, rows, ok, err)
	}
	chunk := bytes.Repeat([]byte("y"), 64<<10)
	for i := 0; i < 64; i++ {
		q.put(herdr.Frame{Data: chunk})
		q.mu.Lock()
		n := len(q.data)
		q.mu.Unlock()
		if n > maxPendingFrame {
			t.Fatalf("%d bytes queued after %d diffs", n, i+1)
		}
	}
	if _, overflow := q.state(); !overflow {
		t.Fatal("4 MiB of diffs did not overflow")
	}
	if _, _, _, _, _, err := q.take(); !errors.Is(err, errResync) {
		t.Fatalf("take after overflowing: %v", err)
	}
}

// burstObs is an observer with frames always ready: its output is read as
// fast as the reader takes it.
type burstObs struct {
	full   bool
	reads  atomic.Int64
	done   chan struct{}
	closed sync.Once
}

func (o *burstObs) Next() (herdr.Frame, error) {
	select {
	case <-o.done:
		return herdr.Frame{}, errors.New("closed")
	default:
	}
	n := o.reads.Add(1)
	return herdr.Frame{Full: o.full || n == 1, Width: 120, Height: 40, Data: make([]byte, 64<<10)}, nil
}

func (o *burstObs) Close() error { o.closed.Do(func() { close(o.done) }); return nil }

// While a frame waits to be sent (here: behind the watches' lock, as when
// another watch sends), the observer's output is still read: nothing
// queues outside the bounded merged frame, and full frames just replace
// it. Diffs that outgrow it make the watch resync once it can go on.
func TestObserverIsReadWhileSendingWaits(t *testing.T) {
	for _, full := range []bool{true, false} {
		h := &Hub{opts: Options{FirstFrame: time.Second}}
		h.initTerm()
		w := &watch{c: &Client{send: make(chan []byte, 128)}, fps: 30}
		obs := &burstObs{full: full, done: make(chan struct{})}
		ctx, cancel := context.WithCancel(context.Background())
		h.term.mu.Lock() // the first send waits
		done := make(chan error, 1)
		go func() { done <- h.pump(ctx, w, obs) }()
		deadline := time.Now().Add(5 * time.Second)
		for obs.reads.Load() < 256 { // 16 MiB
			if time.Now().After(deadline) {
				h.term.mu.Unlock()
				t.Fatalf("full %v: the reader stopped after %d frames while a send waited", full, obs.reads.Load())
			}
			time.Sleep(time.Millisecond)
		}
		h.term.mu.Unlock()
		if !full {
			select {
			case err := <-done:
				if !errors.Is(err, errResync) {
					t.Fatalf("diffs: pump = %v, want a resync", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("diffs: no resync")
			}
		}
		cancel()
		obs.Close()
		if !full {
			continue
		}
		if err := <-done; errors.Is(err, errResync) {
			t.Fatalf("full frames: pump = %v", err)
		}
		if len(w.c.send) == 0 {
			t.Fatal("full frames: nothing sent")
		}
	}
}
