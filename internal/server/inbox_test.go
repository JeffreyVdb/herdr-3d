package server_test

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

func inboxResult(t *testing.T, ack proto.Ack) bool {
	t.Helper()
	b, _ := json.Marshal(ack.Data)
	var r proto.InboxDismissResult
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r.Dismissed
}

// #106: inbox.dismiss hides a done worker's row for that done episode, for
// every client, across a restart, until the worker's next working → done.
func TestInboxDismiss(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	a := b.connect(proto.Hello{Client: "a"})
	other := b.connect(proto.Hello{Client: "other"})
	if s := a.snapshot(); s.World.InboxDismissed == nil || len(s.World.InboxDismissed) != 0 {
		t.Fatalf("empty snapshot map expected, got %#v", s.World.InboxDismissed)
	}
	other.snapshot()

	b.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "working"), worker("w2", "CODE|x|2|r1", "sess-2", "working"))
	evs := a.events(3)
	w1, w2 := evs[1].Worker.ID, evs[2].Worker.ID
	other.events(3)

	// Not done: ignored, nothing is stored or sent.
	_, ack := a.mustAck(proto.CmdInboxDismiss, proto.InboxDismissArgs{ID: w1, StatusSince: evs[1].Worker.StatusSince})
	if inboxResult(t, ack) {
		t.Fatal("dismissed a worker that is working")
	}

	b.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "done"), worker("w2", "CODE|x|2|r1", "sess-2", "working"))
	done := a.event()
	if done.T != proto.EvWorkerStatus || done.ID != w1 || done.Status != "done" {
		t.Fatalf("done event = %+v", done)
	}
	other.event()
	since := done.StatusSince

	// Stale status_since, a worker that is not done, an unknown worker: ignored, silent.
	for _, args := range []proto.InboxDismissArgs{{ID: w1, StatusSince: since - 1}, {ID: w1, StatusSince: since + 1},
		{ID: w2, StatusSince: since}, {ID: "nobody", StatusSince: since}} {
		evs, ack := a.mustAck(proto.CmdInboxDismiss, args)
		if inboxResult(t, ack) || len(evs) != 0 {
			t.Fatalf("%+v: dismissed %v, events %+v", args, inboxResult(t, ack), evs)
		}
	}
	a.mustError(proto.CmdInboxDismiss, proto.InboxDismissArgs{ID: w1}, proto.ErrBadRequest)
	a.mustError(proto.CmdInboxDismiss, map[string]any{"id": w1, "status_since": since, "x": 1}, proto.ErrBadRequest)

	// The current episode: recorded and sent to every client.
	evs, ack = a.mustAck(proto.CmdInboxDismiss, proto.InboxDismissArgs{ID: w1, StatusSince: since})
	if !inboxResult(t, ack) || len(evs) != 1 || evs[0].T != proto.EvInboxDismissed || evs[0].ID != w1 || evs[0].StatusSince != since {
		t.Fatalf("dismiss: ack %+v, events %+v", ack, evs)
	}
	if ev := other.event(); ev.T != proto.EvInboxDismissed || ev.ID != w1 || ev.StatusSince != since {
		t.Fatalf("second client's event = %+v", ev)
	}
	// Again: still dismissed, but nothing new to say.
	evs, ack = a.mustAck(proto.CmdInboxDismiss, proto.InboxDismissArgs{ID: w1, StatusSince: since})
	if !inboxResult(t, ack) || len(evs) != 0 {
		t.Fatalf("repeat: ack %+v, events %+v", ack, evs)
	}

	// A new client's snapshot has it.
	late := b.connect(proto.Hello{Client: "late"})
	if got := late.snapshot().World.InboxDismissed; len(got) != 1 || got[w1] != since {
		t.Fatalf("snapshot map = %v", got)
	}

	// A bridge restart keeps it (the same done episode).
	b.stop()
	b2 := startBridge(t, db, server.Options{})
	b2.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "done"), worker("w2", "CODE|x|2|r1", "sess-2", "working"))
	var got map[string]int64
	for range 100 {
		c := b2.connect(proto.Hello{})
		s := c.snapshot()
		if len(s.World.Workers) == 2 {
			got = s.World.InboxDismissed
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(got) != 1 || got[w1] != since {
		t.Fatalf("after restart: %v", got)
	}

	// Back to work: the dismissal goes; done again is a new episode, listed again.
	c := b2.connect(proto.Hello{})
	c.snapshot()
	b2.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "working"), worker("w2", "CODE|x|2|r1", "sess-2", "working"))
	c.until(proto.EvWorkerStatus)
	time.Sleep(20 * time.Millisecond)
	b2.floor("s", true, worker("w1", "CODE|x|1|r1", "sess-1", "done"), worker("w2", "CODE|x|2|r1", "sess-2", "working"))
	again := c.until(proto.EvWorkerStatus)
	if again.StatusSince == since {
		t.Fatal("a new done episode needs a new status_since")
	}
	if got := b2.connect(proto.Hello{}).snapshot().World.InboxDismissed; len(got) != 0 {
		t.Fatalf("a new episode is still dismissed: %v", got)
	}
	// The old episode's status_since can no longer dismiss it.
	_, ack = c.mustAck(proto.CmdInboxDismiss, proto.InboxDismissArgs{ID: w1, StatusSince: since})
	if inboxResult(t, ack) {
		t.Fatal("dismissed with the previous episode's status_since")
	}
}
