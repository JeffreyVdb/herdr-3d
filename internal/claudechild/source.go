// Package claudechild is #23's Claude Code source of native child agents
// (phase 2 of #20): a childagents.Source that reports the subagents a
// worker's own Claude Code session runs, from its transcripts (always) and
// the bridge's hook log (when the bridge started the worker with its hooks).
//
// The transcripts are read once, by the usage tracker's usage.Session of
// each worker (its main transcript, every subagents/agent-<id>.jsonl and
// its meta file): a Listener gets their lines. The hook log is tailed here.
// What both show of a root session is kept as facts keyed by explicit ids
// (a call's tool_use id, a child's agentId), and each child's evidence is
// derived from them anew after every read, so a line read twice, a hook
// missing or a bridge restart (the tracker reads every file from its start
// again) give the same answer. Evidence goes out when it changed, through
// Run's emit. docs/protocol.md "Claude Code subagents (#23)".
package claudechild

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"reflect"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/childagents"
	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// Defaults of Options.
const (
	DefaultHookPoll = time.Second
	// DefaultMaxHookLog is the size past which the hook log is rotated
	// (one older file is kept, and read again after a restart).
	DefaultMaxHookLog = 8 << 20
	// maxIdleBooks is how many sessions no reader watches keep their hook
	// facts (the oldest are dropped).
	maxIdleBooks = 256
)

// Options configure a Source.
type Options struct {
	// HookLog is the hook log the bridge's Claude hooks append to ("": no
	// hooks, transcripts only).
	HookLog string
	// HookPoll is how often the hook log is read (default DefaultHookPoll);
	// MaxHookLog its size before rotation (default DefaultMaxHookLog).
	HookPoll   time.Duration
	MaxHookLog int64
	// Now is the bridge's clock (default time.Now).
	Now func() time.Time
	Log *slog.Logger
}

// Source is the Claude Code child-agent source. Its methods are safe for
// concurrent use.
type Source struct {
	opts Options
	kick chan struct{}

	mu    sync.Mutex
	books map[string]*book // by root session
	queue []childagents.Evidence
	touch int // book use counter (eviction)
	// hooksChanged are the sessions hook lines read since the last flush.
	hooksChanged map[string]bool
}

// book is one root session's evidence.
type book struct {
	session string
	readers []*Listener // the first one's facts are the transcripts'
	hooks   *hookFacts
	// sent is the evidence last sent of each child (the registry's view of
	// them, as far as this source knows).
	sent    []childagents.Evidence
	touched int
}

// New returns a source.
func New(o Options) *Source {
	if o.HookPoll <= 0 {
		o.HookPoll = DefaultHookPoll
	}
	if o.MaxHookLog <= 0 {
		o.MaxHookLog = DefaultMaxHookLog
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	return &Source{opts: o, kick: make(chan struct{}, 1), books: map[string]*book{}}
}

func (s *Source) book(session string) *book {
	b := s.books[session]
	if b == nil {
		b = &book{session: session, hooks: newHookFacts()}
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
		if len(b.readers) == 0 {
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

// Listener reads a root session's transcripts for the source: a
// usage.Children of one usage.Session. Close it when the session is no
// longer read. With two readers of one session (two workers claiming it),
// the first one's are the facts; the other takes over when it closes.
type Listener struct {
	src     *Source
	b       *book
	f       *facts
	polled  time.Time
	closed  bool
	pending bool // something changed since the last flush
}

var _ usage.Children = (*Listener)(nil)

// Listener returns a reader of a root session's transcripts.
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

// Main implements usage.Children.
func (l *Listener) Main(_ int64, line []byte) {
	if l.lock() {
		defer l.src.mu.Unlock()
		if l.f.mainLine(line) {
			l.pending = true
		}
	}
}

// Child implements usage.Children.
func (l *Listener) Child(agentID string, _ int64, line []byte) {
	if !validAgent(agentID) {
		return
	}
	if l.lock() {
		defer l.src.mu.Unlock()
		l.f.childLine(l.b.session, agentID, line)
		l.pending = true
	}
}

// Meta implements usage.Children.
func (l *Listener) Meta(agentID string, b []byte, mtime time.Time) {
	if !validAgent(agentID) {
		return
	}
	if l.lock() {
		defer l.src.mu.Unlock()
		l.f.metaFile(agentID, b, mtime)
		l.pending = true
	}
}

// Gone implements usage.Children.
func (l *Listener) Gone(agentID string) {
	if l.lock() {
		defer l.src.mu.Unlock()
		l.f.goneFile(agentID)
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

// WantList implements usage.Children.
func (l *Listener) WantList() bool {
	if !l.lock() {
		return false
	}
	defer l.src.mu.Unlock()
	return wantList(l.f, l.b.hooks, l.src.opts.Now())
}

// Polled implements usage.Children: a poll's evidence goes out.
func (l *Listener) Polled(now time.Time) {
	if !l.lock() {
		return
	}
	defer l.src.mu.Unlock()
	l.polled = now
	for _, fl := range l.f.files {
		if fl.seenAt.IsZero() {
			fl.seenAt = now
		}
	}
	// A held child is let out by time alone: flush every poll while one
	// may be held, else only when something changed.
	if l.pending || l.holding() {
		l.pending = false
		if len(l.b.readers) > 0 && l.b.readers[0] == l {
			l.src.flush(l.b, now)
		}
	}
}

// holding reports whether a file of the session may be held for its
// pairing.
func (l *Listener) holding() bool {
	for a, fl := range l.f.files {
		if _, ok := l.f.metas[a]; !ok && l.polled.Sub(fl.seenAt) < HoldUnpaired+time.Second {
			return true
		}
	}
	return false
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
	if len(b.readers) == 0 {
		b.sent = nil
		s.evict()
		return
	}
	if owner { // the next reader's facts are the session's now: sent after its next read, which may be its first
		b.readers[0].pending = true
	}
}

func validAgent(id string) bool { return transcript.ValidAgentID(id) }

// facts are the session's transcript facts: its first reader's.
func (b *book) facts() *facts {
	if len(b.readers) == 0 {
		return newFacts()
	}
	return b.readers[0].f
}

// flush queues the evidence of the session's children that changed since
// it was last sent, and a removal of each child sent that is gone. With
// s.mu held.
func (s *Source) flush(b *book, now time.Time) {
	next := derive(b.session, b.facts(), b.hooks, now)
	used := make([]bool, len(b.sent))
	var out, removed []childagents.Evidence
	for _, e := range next {
		same := false
		for i, p := range b.sent {
			if (e.NativeID != "" && p.NativeID == e.NativeID) || (e.DispatchID != "" && p.DispatchID == e.DispatchID) {
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
// worker's files (from their start) sends it.
func (s *Source) Replay(session string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b := s.books[session]
	if b == nil {
		return
	}
	b.sent = derive(b.session, b.facts(), b.hooks, s.opts.Now())
	s.enqueue(b.sent...)
}

// Run sends the evidence queued, and reads the hook log, until ctx ends.
func (s *Source) Run(ctx context.Context, emit func(childagents.Evidence)) error {
	var h *hookLog
	var tick <-chan time.Time
	if s.opts.HookLog != "" {
		h = &hookLog{path: s.opts.HookLog, max: s.opts.MaxHookLog, log: s.opts.Log}
		h.start(s.hookLine)
		s.flushHooks(h)
		t := time.NewTicker(s.opts.HookPoll)
		defer t.Stop()
		tick = t.C
	}
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
		case <-tick:
			h.read(s.hookLine)
			s.flushHooks(h)
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

// hookLine records one line of the hook log (lines that do not parse, and
// events of no session, are skipped).
func (s *Source) hookLine(b []byte) {
	var in hookInput
	if json.Unmarshal(b, &in) != nil || in.SessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.book(in.SessionID).hooks.line(&in)
	if s.hooksChanged == nil {
		s.hooksChanged = map[string]bool{}
	}
	s.hooksChanged[in.SessionID] = true
}

// flushHooks sends what the hook lines read changed.
func (s *Source) flushHooks(*hookLog) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.opts.Now()
	for session := range s.hooksChanged {
		if b := s.books[session]; b != nil {
			s.flush(b, now)
		}
	}
	s.hooksChanged = nil
}

// hookLog tails the bridge's hook log: the rotated file once, then the
// current one. A line that does not parse (torn by a full disk) is skipped
// by the reader.
type hookLog struct {
	path string
	max  int64
	log  *slog.Logger
	tail *jsonl.Tail
}

func (h *hookLog) start(fn func([]byte)) {
	old := jsonl.NewTail(h.path + ".1")
	if err := old.Next(func(_ int64, b []byte) { fn(b) }); err != nil && !errors.Is(err, fs.ErrNotExist) {
		h.log.Debug("claude hook log", "path", old.Path, "err", err)
	}
	h.tail = jsonl.NewTail(h.path)
	h.read(fn)
}

// read reads what the log gained, then rotates it when it is past max.
func (h *hookLog) read(fn func([]byte)) {
	err := h.tail.Next(func(_ int64, b []byte) { fn(b) })
	if errors.Is(err, jsonl.ErrReplaced) { // rotated or truncated by someone else: read it all (facts read twice change nothing)
		err = h.tail.Next(func(_ int64, b []byte) { fn(b) })
	}
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		return
	default:
		h.log.Debug("claude hook log", "path", h.path, "err", err)
		return
	}
	if fi := h.tail.File(); fi != nil && fi.Size() > h.max && h.tail.Delivered() == fi.Size() {
		if err := os.Rename(h.path, h.path+".1"); err != nil {
			h.log.Warn("claude hook log: rotate", "path", h.path, "err", err)
			return
		}
		h.tail = jsonl.NewTail(h.path)
	}
}
