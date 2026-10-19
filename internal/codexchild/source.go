// Package codexchild is #25's Codex source of native child agents (phase 4
// of #20, the terminal path): a childagents.Source that reports the
// subagents a worker's own Codex session spawns, from its rollout files.
//
// The rollouts are read once, by the usage tracker's usage.Session of each
// worker: its root rollout, and every rollout whose first line names a
// child spawned in its session (codex.ChildFinder), nested ones included.
// A Listener gets their lines. What they show is kept as facts keyed by
// explicit ids (a child's thread id, a spawn call's id, a turn's id), and
// each child's evidence is derived from them anew after every read, so a
// line read twice or a bridge restart (the tracker reads every file from
// its start again) give the same answer. Evidence goes out when it
// changed, through Run's emit. docs/protocol.md "Codex subagents (#25)".
package codexchild

import (
	"context"
	"reflect"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// maxIdleBooks is how many sessions no reader watches are remembered (the
// oldest are dropped).
const maxIdleBooks = 256

// Options configure a Source.
type Options struct {
	// Now is the bridge's clock (default time.Now).
	Now func() time.Time
	// #27, the server half (server.go): how long an idle child waits for
	// its turn's end before its last turn is read (default DefaultSettle),
	// the bound of each read (default DefaultReadTimeout), how long a
	// failed recovery waits to be tried again (default DefaultRetry), and
	// where it is logged (default nowhere).
	Settle, ReadTimeout, Retry time.Duration
	Log                        func(msg string, args ...any)
}

// Source is the Codex child-agent source. Its methods are safe for
// concurrent use.
type Source struct {
	opts Options
	kick chan struct{}

	mu    sync.Mutex
	books map[string]*book // by root session
	queue []childagents.Evidence
	touch int
	base  context.Context // Run's: the observers' (#27)
}

// book is one root session's evidence.
type book struct {
	session string
	readers []*Listener // the first one's facts are the session's
	// sent is the evidence last sent of each child (the registry's view of
	// them, as far as this source knows).
	sent    []childagents.Evidence
	touched int
	// srv is what the session's app-server showed (#27; nil: no join of
	// it was seen).
	srv *server
}

// New returns a source.
func New(o Options) *Source {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Settle <= 0 {
		o.Settle = DefaultSettle
	}
	if o.ReadTimeout <= 0 {
		o.ReadTimeout = DefaultReadTimeout
	}
	if o.Retry <= 0 {
		o.Retry = DefaultRetry
	}
	if o.Log == nil {
		o.Log = func(string, ...any) {}
	}
	return &Source{opts: o, kick: make(chan struct{}, 1), books: map[string]*book{}}
}

func (s *Source) book(session string) *book {
	b := s.books[session]
	if b == nil {
		b = &book{session: session}
		s.books[session] = b
		s.evict()
	}
	s.touch++
	b.touched = s.touch
	return b
}

// evict drops the oldest books no reader watches beyond maxIdleBooks.
func (s *Source) evict() {
	idle := 0
	var oldest *book
	for _, b := range s.books {
		if len(b.readers) == 0 && b.srv == nil {
			idle++
			if oldest == nil || b.touched < oldest.touched {
				oldest = b
			}
		}
	}
	if idle > maxIdleBooks && oldest != nil {
		delete(s.books, oldest.session)
	}
}

// Listener reads a root session's rollouts for the source: the
// usage.Children of one Codex usage.Session (Child's id is a child's
// thread id). Close it when the session is no longer read. With two
// readers of one session (two workers claiming it), the first one's are
// the facts; the other takes over when it closes.
type Listener struct {
	src     *Source
	b       *book
	f       *facts
	closed  bool
	pending bool // something changed since the last flush
}

var _ usage.Children = (*Listener)(nil)

// Listener returns a reader of a root session's rollouts.
func (s *Source) Listener(session string) *Listener {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.book(session)
	l := &Listener{src: s, b: b, f: newFacts()}
	b.readers = append(b.readers, l)
	return l
}

func (l *Listener) lock() bool {
	l.src.mu.Lock()
	if l.closed {
		l.src.mu.Unlock()
		return false
	}
	return true
}

// Main implements usage.Children: a line of the root's rollout.
func (l *Listener) Main(_ int64, line []byte) {
	if l.lock() {
		defer l.src.mu.Unlock()
		if l.f.mainLine(line) {
			l.pending = true
		}
	}
}

// Child implements usage.Children: a line of a child's rollout.
func (l *Listener) Child(thread string, off int64, line []byte) {
	if thread == "" {
		return
	}
	if l.lock() {
		defer l.src.mu.Unlock()
		l.f.childLine(l.b.session, thread, off, line)
		l.pending = true
	}
}

// Meta implements usage.Children: Codex has no meta files.
func (l *Listener) Meta(string, []byte, time.Time) {}

// Gone implements usage.Children: a child's rollout went.
func (l *Listener) Gone(thread string) {
	if l.lock() {
		defer l.src.mu.Unlock()
		l.f.goneFile(thread)
		l.pending = true
	}
}

// Reset implements usage.Children: the files are read again from their
// start (the evidence sent stays until the next flush says otherwise).
func (l *Listener) Reset() {
	if l.lock() {
		defer l.src.mu.Unlock()
		l.f = newFacts()
		l.pending = true
	}
}

// WantList implements usage.Children: a child spawned lately has no
// rollout read yet.
func (l *Listener) WantList() bool {
	if !l.lock() {
		return false
	}
	defer l.src.mu.Unlock()
	return wantList(l.f, l.src.opts.Now())
}

// Polled implements usage.Children: a poll's evidence goes out.
func (l *Listener) Polled(time.Time) {
	if !l.lock() {
		return
	}
	defer l.src.mu.Unlock()
	if l.pending {
		l.pending = false
		if len(l.b.readers) > 0 && l.b.readers[0] == l {
			l.src.flush(l.b)
		}
	}
}

// Close stops the reader: its facts go. The evidence sent stays the
// registry's (a reader closes when its worker or session went, which drops
// the rows); the session's next reader sends it all again.
func (l *Listener) Close() {
	s := l.src
	s.mu.Lock()
	defer s.mu.Unlock()
	if l.closed {
		return
	}
	l.closed = true
	b := l.b
	owner := b.readers[0] == l
	for i, r := range b.readers {
		if r == l {
			b.readers = append(b.readers[:i], b.readers[i+1:]...)
			break
		}
	}
	if len(b.readers) == 0 && b.srv == nil {
		b.sent = nil
		s.evict()
		return
	}
	if owner && len(b.readers) > 0 { // the next reader's facts are the session's now: sent after its next read, which may be its first
		b.readers[0].pending = true
	}
}

// facts are the session's facts: its first reader's.
func (b *book) facts() *facts {
	if len(b.readers) == 0 {
		return newFacts()
	}
	return b.readers[0].f
}

// flush queues the evidence of the session's children that changed since
// it was last sent, and a removal of each child sent that is gone. With
// s.mu held.
func (s *Source) flush(b *book) {
	if b.srv != nil && b.srv.recovering {
		return // sent once the join's recovery is done (#27)
	}
	next := b.derive()
	used := make([]bool, len(b.sent))
	var out, removed []childagents.Evidence
	for _, e := range next {
		same := false
		for i, p := range b.sent {
			if p.NativeID == e.NativeID {
				used[i] = true
				same = same || reflect.DeepEqual(p, e)
			}
		}
		if !same {
			out = append(out, e)
		}
	}
	for i, p := range b.sent {
		if !used[i] {
			removed = append(removed, childagents.Evidence{Session: p.Session, Provider: p.Provider, NativeID: p.NativeID,
				DispatchID: p.DispatchID, Source: p.Source, Removed: true})
		}
	}
	b.sent = next
	s.enqueue(append(removed, out...)...)
}

func (s *Source) enqueue(evs ...childagents.Evidence) {
	if len(evs) == 0 {
		return
	}
	s.queue = append(s.queue, evs...)
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// Replay queues all the evidence the session's facts give now, in the
// order first seen (never blocks): the hub bound a worker to the session.
// After a restart there is none yet; the tracker's first read of the
// worker's rollouts (from their start) sends it.
func (s *Source) Replay(session string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.books[session]
	if b == nil {
		return
	}
	b.sent = b.derive()
	s.enqueue(b.sent...)
}

// derive is the session's evidence: its rollouts', with its server's word
// (combine).
func (b *book) derive() []childagents.Evidence {
	return combine(b.session, derive(b.session, b.facts()), b.srv)
}

// Run sends the evidence queued until ctx ends.
func (s *Source) Run(ctx context.Context, emit func(childagents.Evidence)) error {
	s.mu.Lock()
	s.base = ctx
	s.mu.Unlock()
	for {
		for evs := s.take(); len(evs) > 0; evs = s.take() {
			for _, e := range evs {
				if ctx.Err() != nil {
					return nil
				}
				emit(e)
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-s.kick:
		}
	}
}

// take takes the evidence queued.
func (s *Source) take() []childagents.Evidence {
	s.mu.Lock()
	defer s.mu.Unlock()
	evs := s.queue
	s.queue = nil
	return evs
}
