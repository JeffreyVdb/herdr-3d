package server

import (
	"context"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// A wait cancelled while its closure is queued on the hub must not read
// what the closure writes when the hub runs it after all (go test -race).
func TestPendingWaitsCancelledWhileQueued(t *testing.T) {
	t.Parallel()
	for range 200 {
		h := &Hub{ops: make(chan func(context.Context), 1), done: make(chan struct{}), floors: map[string]*floorState{}}
		op := &floorOp{session: "s", waits: map[string]*resumeWait{"w": {pane: "w1:p1", state: proto.ResumePending}}}
		ctx, cancel := context.WithCancel(context.Background())
		got := make(chan []pendingWait)
		go func() { got <- h.pendingWaits(ctx, op) }()
		queued := <-h.ops
		cancel()
		queued(ctx) // the hub runs it anyway
		<-got       // the race detector is the check
	}
}
