package server

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/screenshare"
)

// screenHub is a hub that is not running (the test runs its ops) with one
// sharing game c and a floor "s".
func screenHub(t *testing.T, timeout time.Duration) (*Hub, *Client) {
	t.Helper()
	frames, err := screenshare.Open(t.TempDir(), screenshare.Options{})
	if err != nil {
		t.Fatal(err)
	}
	c := &Client{send: make(chan []byte, 20)}
	h := &Hub{
		ops: make(chan func(context.Context), 64), done: make(chan struct{}),
		floors: map[string]*floorState{"s": {}}, clients: map[*Client]struct{}{c: {}},
		opts: Options{ScreenTimeout: timeout, Now: time.Now},
	}
	h.screen = screenState{frames: frames, games: map[*Client]*shareInfo{c: {sharing: true}}, pending: map[string]*framePending{}}
	return h, c
}

// runOps runs h's ops until the test ends.
func runOps(t *testing.T, h *Hub) {
	stop := make(chan struct{})
	ran := make(chan struct{})
	go func() {
		defer close(ran)
		for {
			select {
			case op := <-h.ops:
				op(context.Background())
			case <-stop:
				return
			}
		}
	}()
	t.Cleanup(func() { close(stop); <-ran })
}

// SC-R2: a grab cancelled while its registration is still queued asks the
// game nothing and holds no slot, however many there are.
func TestScreenCancelledGrabRegistersNothing(t *testing.T) {
	h, c := screenHub(t, time.Hour)
	for range maxPendingFrames + 1 {
		ctx, cancel := context.WithCancel(context.Background())
		returned := make(chan error, 1)
		go func() {
			_, err := h.grabScreen(ctx, proto.ScreenGrabArgs{Floor: "s", Requester: "Nibble"})
			returned <- err
		}()
		queued := <-h.ops
		cancel()
		if err := <-returned; !errors.Is(err, context.Canceled) {
			t.Fatalf("grab: %v, want canceled", err)
		}
		queued(context.Background()) // the registration runs after its caller left
	}
	if n := len(h.screen.pending); n != 0 {
		t.Fatalf("%d grabs pending after their callers left", n)
	}
	if n := len(c.send); n != 0 {
		t.Fatalf("%d frame requests sent for abandoned grabs", n)
	}
	if _, err := h.requestFrame(proto.ScreenGrabArgs{Floor: "s", Requester: "Nibble"}); err != nil {
		t.Fatalf("the next grab: %v", err)
	}
}

// SC-R2: a request registered for a caller that then stopped waiting (its
// ctx ended between the registration and the answer) expires on its own and
// frees its slot.
func TestScreenOrphanedFrameRequestExpires(t *testing.T) {
	h, _ := screenHub(t, 5*time.Millisecond)
	runOps(t, h)
	ctx := context.Background()
	var orphans []*framePending
	for range maxPendingFrames {
		p, err := query(ctx, h, func() *framePending {
			p, err := h.requestFrame(proto.ScreenGrabArgs{Floor: "s", Requester: "Nibble"})
			if err != nil {
				t.Error(err)
			}
			return p
		})
		if err != nil || p == nil {
			t.Fatalf("register: %v", err)
		}
		orphans = append(orphans, p)
	}
	for _, p := range orphans {
		select {
		case r := <-p.res:
			if errorCode(r.err) != proto.ErrFrameTimeout {
				t.Fatalf("orphan ended with %v, want frame_timeout", r.err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("an orphaned frame request never expired")
		}
	}
	n, _ := query(ctx, h, func() int { return len(h.screen.pending) })
	if n != 0 {
		t.Fatalf("%d orphaned grabs still pending", n)
	}
	err, qerr := query(ctx, h, func() error {
		_, err := h.requestFrame(proto.ScreenGrabArgs{Floor: "s", Requester: "Nibble"})
		return err
	})
	if qerr != nil || err != nil {
		t.Fatalf("the next grab: %v %v", qerr, err)
	}
}
