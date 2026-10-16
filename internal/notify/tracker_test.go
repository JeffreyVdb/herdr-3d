package notify

import (
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)

func see(id string, k Kind, since int64, eligible bool) sighting {
	s := sighting{id: id, kind: k, eligible: eligible, alert: Alert{WorkerID: id, Kind: k}}
	if k != "" {
		s.key = episodeKey(k, since)
	}
	return s
}

func TestTrackerFirstSightingIsSilent(t *testing.T) {
	tr := newTracker(5 * time.Second)
	if a := tr.observe(see("a", KindNeedsYou, 1, true), t0); a != nil {
		t.Fatalf("first sighting notified: %+v", a)
	}
	if a := tr.observe(see("b", KindDone, 1, true), t0); a != nil {
		t.Fatalf("first sighting notified: %+v", a)
	}
	if got := tr.due(t0.Add(time.Minute)); len(got) != 0 {
		t.Fatalf("first sighting settled: %+v", got)
	}
}

func TestTrackerNeedsYouAtOnceOncePerEpisode(t *testing.T) {
	tr := newTracker(5 * time.Second)
	tr.observe(see("a", "", 0, false), t0)
	a := tr.observe(see("a", KindNeedsYou, 10, true), t0)
	if a == nil || a.Kind != KindNeedsYou {
		t.Fatalf("needs you did not notify at once: %v", a)
	}
	if a := tr.observe(see("a", KindNeedsYou, 10, true), t0); a != nil {
		t.Fatal("the same episode notified twice")
	}
	tr.observe(see("a", "", 0, false), t0) // back to work
	if a := tr.observe(see("a", KindNeedsYou, 10, true), t0); a != nil {
		t.Fatal("an episode known came back and notified")
	}
	if a := tr.observe(see("a", KindNeedsYou, 20, true), t0); a == nil {
		t.Fatal("a new episode did not notify")
	}
}

func TestTrackerDoneSettles(t *testing.T) {
	tr := newTracker(5 * time.Second)
	tr.observe(see("a", "", 0, false), t0)
	if a := tr.observe(see("a", KindDone, 10, true), t0); a != nil {
		t.Fatal("done notified before it settled")
	}
	if at, ok := tr.next(); !ok || !at.Equal(t0.Add(5*time.Second)) {
		t.Fatalf("next = %v %v", at, ok)
	}
	if got := tr.due(t0.Add(4999 * time.Millisecond)); len(got) != 0 {
		t.Fatalf("settled early: %+v", got)
	}
	got := tr.due(t0.Add(5 * time.Second))
	if len(got) != 1 || got[0].WorkerID != "a" {
		t.Fatalf("due = %+v", got)
	}
	if got := tr.due(t0.Add(time.Hour)); len(got) != 0 {
		t.Fatalf("settled twice: %+v", got)
	}
	if a := tr.observe(see("a", KindDone, 10, true), t0.Add(time.Hour)); a != nil {
		t.Fatal("the settled episode notified again")
	}
}

func TestTrackerDoneCancelledWhenItLeaves(t *testing.T) {
	tr := newTracker(5 * time.Second)
	tr.observe(see("a", "", 0, false), t0)
	tr.observe(see("a", KindDone, 10, true), t0)
	tr.observe(see("a", "", 0, false), t0.Add(2*time.Second)) // back to work
	if _, ok := tr.next(); ok {
		t.Fatal("a done that left still waits")
	}
	if got := tr.due(t0.Add(time.Minute)); len(got) != 0 {
		t.Fatalf("cancelled done notified: %+v", got)
	}
	// It comes back to the same episode (#98: waiting, status unchanged): it settles again.
	tr.observe(see("a", KindDone, 10, true), t0.Add(time.Minute))
	if got := tr.due(t0.Add(time.Minute + 5*time.Second)); len(got) != 1 {
		t.Fatalf("the episode back did not settle: %+v", got)
	}
}

func TestTrackerDoneReplacedByANewEpisode(t *testing.T) {
	tr := newTracker(5 * time.Second)
	tr.observe(see("a", "", 0, false), t0)
	tr.observe(see("a", KindDone, 10, true), t0)
	if a := tr.observe(see("a", KindNeedsYou, 11, true), t0.Add(time.Second)); a == nil {
		t.Fatal("needs you did not notify")
	}
	if got := tr.due(t0.Add(time.Minute)); len(got) != 0 {
		t.Fatalf("the replaced done notified: %+v", got)
	}
}

func TestTrackerIneligibleIsKnownSilently(t *testing.T) {
	tr := newTracker(5 * time.Second)
	tr.observe(see("a", "", 0, false), t0)
	// Asleep (or off): known, never notified, not when it wakes either.
	if a := tr.observe(see("a", KindNeedsYou, 10, false), t0); a != nil {
		t.Fatal("an ineligible episode notified")
	}
	if a := tr.observe(see("a", KindNeedsYou, 10, true), t0); a != nil {
		t.Fatal("a floor that woke notified a known episode")
	}
	// A pending done that becomes ineligible is dropped and known.
	tr.observe(see("a", KindDone, 20, true), t0)
	tr.observe(see("a", KindDone, 20, false), t0)
	if got := tr.due(t0.Add(time.Minute)); len(got) != 0 {
		t.Fatalf("ineligible done notified: %+v", got)
	}
}

func TestTrackerGoneForgets(t *testing.T) {
	tr := newTracker(5 * time.Second)
	tr.observe(see("a", "", 0, false), t0)
	tr.observe(see("a", KindDone, 10, true), t0)
	tr.gone("a")
	if got := tr.due(t0.Add(time.Minute)); len(got) != 0 {
		t.Fatalf("gone worker notified: %+v", got)
	}
	// Seen again (a session back): a first sighting, silent.
	if a := tr.observe(see("a", KindNeedsYou, 30, true), t0); a != nil {
		t.Fatal("a worker seen again notified at once")
	}
}
