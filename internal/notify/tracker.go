package notify

import "time"

// Kind is what an episode is about: the two events a notification is for.
type Kind string

// Kinds.
const (
	KindNeedsYou Kind = "needs_you"
	KindDone     Kind = "done"
)

// episodeKey names an episode of a worker: its kind and what it is (H3D-1:
// episode's, the question or state it is about; a done episode's is when it
// started). Another id is another episode.
func episodeKey(k Kind, id string) string { return string(k) + "|" + id }

// Alert is a notification about to go: whom it is about and what it says.
type Alert struct {
	WorkerID string
	Kind     Kind
	Reason   string
	Name     string
	Line     string
	// Ask or Followup is what a needs-you alert asks (#14: its cards).
	Ask      *Ask
	Followup *Followup
	// Since is when the episode started, unix ms (#88: a menu's card goes
	// with the notification of its blocked spell).
	Since int64
	// Menu is what a menu's card asks (#88: openMenu's; H3D-1: and what a
	// Questions only alert about a menu asks).
	Menu *Menu
	// H3D-1: Key is the episode (episodeKey: an alert goes only while it
	// is its worker's), About what it is about (about*, for the audit).
	Key, About string
	// Question: a pending question Questions only lets through: its cards,
	// else its text (Body), are the message, with no alert before them.
	Question bool
	// Report is a report request's text as it may leave the bridge
	// (Report.Request).
	Report string
	// Body is the question's text, the message itself (questionText; "":
	// the alert's line).
	Body string
	// Ring: the first of its cards rings (they are the notification).
	Ring bool
}

// sighting is one look at a worker for the tracker.
type sighting struct {
	id string
	// key is the worker's episode as if its floor were awake ("": none): it
	// is what is known, so a floor that wakes keeps its episodes.
	key  string
	kind Kind
	// eligible: the episode may notify now (a candidate on an awake floor,
	// the feature and its event on, the channel ready).
	eligible bool
	alert    Alert
}

type pendingDone struct {
	key   string
	due   time.Time
	alert Alert
}

// tracker finds the episodes that notify (pure: the caller's clock). A
// worker's first sighting is known silently (the bridge's start, a herdr
// session seen again: no burst of old alerts); after that a new episode
// notifies once: needs you at once, done after settle if it is still the
// same episode then (it is cancelled when it leaves, and settles again when
// it comes back). An episode that may not notify when it starts (the floor
// asleep, the feature or its event off, a freelancer's done not listed) is
// known silently. Not safe for concurrent use.
type tracker struct {
	settle  time.Duration
	known   map[string]string // worker id → the last episode known
	pending map[string]pendingDone
	// cur is each worker's episode at its last sighting (#106: a parked
	// alert goes only if its episode is still on).
	cur map[string]string
}

func newTracker(settle time.Duration) *tracker {
	return &tracker{settle: settle, known: map[string]string{}, pending: map[string]pendingDone{}, cur: map[string]string{}}
}

// current is worker id's episode at its last sighting ("": none).
func (t *tracker) current(id string) string { return t.cur[id] }

// observe takes a sighting; it returns the alert to send now, if any.
func (t *tracker) observe(s sighting, now time.Time) *Alert {
	if s.key == "" {
		delete(t.cur, s.id)
	} else {
		t.cur[s.id] = s.key
	}
	known, seen := t.known[s.id]
	if !seen {
		t.known[s.id] = s.key
		return nil
	}
	if p, ok := t.pending[s.id]; ok && p.key != s.key {
		delete(t.pending, s.id) // it left that done episode
	}
	if s.key == "" || s.key == known {
		return nil
	}
	if !s.eligible {
		t.known[s.id] = s.key
		delete(t.pending, s.id)
		return nil
	}
	if s.kind == KindNeedsYou {
		t.known[s.id] = s.key
		a := s.alert
		return &a
	}
	if p, ok := t.pending[s.id]; ok {
		p.alert = s.alert // the latest words
		t.pending[s.id] = p
		return nil
	}
	t.pending[s.id] = pendingDone{key: s.key, due: now.Add(t.settle), alert: s.alert}
	return nil
}

// reopen forgets that key was worker id's last known episode (H3D-1: a
// report request resolved; asked again, it is a new one).
func (t *tracker) reopen(id, key string) {
	if k, ok := t.known[id]; ok && k == key {
		t.known[id] = ""
	}
}

// gone forgets a worker that left.
func (t *tracker) gone(id string) {
	delete(t.known, id)
	delete(t.pending, id)
	delete(t.cur, id)
}

// due returns the done episodes that settled by now, known from here on.
func (t *tracker) due(now time.Time) []Alert {
	var out []Alert
	for id, p := range t.pending {
		if p.due.After(now) {
			continue
		}
		t.known[id] = p.key
		delete(t.pending, id)
		out = append(out, p.alert)
	}
	return out
}

// next is when the earliest done episode settles (ok false: none waits).
func (t *tracker) next() (time.Time, bool) {
	var at time.Time
	ok := false
	for _, p := range t.pending {
		if !ok || p.due.Before(at) {
			at, ok = p.due, true
		}
	}
	return at, ok
}
