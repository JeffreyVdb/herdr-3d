package server

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

// A cleanup task can need a final query (protected files read the live
// workers). Once the event loop stops, it must release those queries before
// waiting for the tasks themselves. Fake time distinguishes stopping from
// waiting out a task's deadline without adding a real-time performance gate.
func TestHubShutdownUnblocksBackgroundQuery(t *testing.T) {
	t.Parallel()
	synctest.Test(t, func(t *testing.T) {
		h := &Hub{
			opts: Options{ScheduleTick: time.Hour},
			ops:  make(chan func(context.Context), 1),
			done: make(chan struct{}),
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		h.wg.Add(1)
		stopped := make(chan struct{})
		go func() {
			h.Run(ctx)
			close(stopped)
		}()
		synctest.Wait() // Run has stopped accepting work and is waiting for the task.
		qctx, qcancel := context.WithTimeout(context.Background(), time.Minute)
		defer qcancel()
		_, err := query(qctx, h, func() bool { return true })
		h.wg.Done()
		<-stopped
		if !errors.Is(err, errHubStopped) {
			t.Fatalf("background query after stop: %v, want %v", err, errHubStopped)
		}
	})
}
