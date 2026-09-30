// Package transcript turns a worker's agent transcript (Claude Code JSONL,
// Codex rollout JSONL) into one normalised timeline of items, for the
// laptop's conversation view (docs/protocol.md "Laptops: transcript").
//
// A Log never holds the transcript: it indexes where each item's lines
// are (byte offsets) and reads them back from the file when an item is
// asked for. It is built once from the file, off the caller's goroutine
// and cancellable, then kept current with the lines the worker's one tail
// reads (internal/usage shares its read through Line), so the file is
// never tailed twice.
package transcript

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/JeffreyVdb/herdr-3d/internal/jsonl"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Harnesses with transcripts.
const (
	Claude = "claude"
	Codex  = "codex"
)

// Limits.
const (
	// MaxPageItems caps the items of one page, hidden ones included.
	MaxPageItems = 2000
	// MaxPageBytes is about the most a page's items take in JSON: older
	// items past it wait for the next page.
	MaxPageBytes = 4 << 20
	// MaxPending bounds what a subscriber has not taken yet; past it the
	// subscription overflows (the watch resyncs).
	MaxPending = 4096
	// maxMessages bounds the Claude messages remembered for merging their
	// blocks; a message's lines follow each other closely.
	maxMessages = 4096
	// scanChunk is how much the build reads at a time.
	scanChunk = 256 << 10
)

// Why a Log ended.
var (
	ErrReplaced = errors.New("transcript truncated or replaced")
	ErrGone     = errors.New("transcript gone")
	ErrClosed   = errors.New("transcript closed")
)

// span is one line's contribution to an item: the line at off, n bytes
// long, contribution k of the line's.
type span struct {
	off int64
	n   int32
	k   int16
}

type entry struct {
	id     string
	ts     int64
	kind   string
	hidden bool
	hasImg bool // a line of it has an image (or an [Image #n: path] marker)
	spans  []span
}

type msgState struct {
	last   int32         // the entry of its last block
	blocks map[int]int32 // block index → entry
}

// Log is the index of one transcript file.
type Log struct {
	harness string
	path    string
	parse   func(off int64, b []byte) ([]contrib, string)
	f       *os.File
	r       io.ReaderAt // f (tests count what is read)
	fi      fs.FileInfo
	cancel  context.CancelFunc
	ready   chan struct{} // closed once built (or ended)
	done    chan struct{} // closed when it ended

	mu       sync.Mutex
	entries  []entry
	byID     map[string]int32
	msgs     map[string]*msgState
	msgOrder []string
	open     []int32 // calls without a result yet, oldest first
	version  string
	tailEnd  int64 // where the tail's next line starts
	built    int64 // every line before it is indexed
	live     bool  // built: lines come through Line
	err      error // why it ended
	subs     map[*Sub]struct{}
	isReady  bool
	env      *imageEnv // resolves the items' images
}

func parserOf(harness string) func(int64, []byte) ([]contrib, string) {
	if harness == Codex {
		return parseCodex
	}
	return parseClaude
}

// Supported reports whether harness has transcripts the package reads.
func Supported(harness string) bool { return harness == Claude || harness == Codex }

// Follow indexes the transcript at path that a tail is reading: fi is the
// file the tail read (nil: none yet) and next where its next line starts.
// The lines before next are read from the file, once, in the background;
// the tail's lines after it must be passed to Line. Ready is closed when
// the index caught up.
func Follow(harness, path string, fi fs.FileInfo, next int64, opts ...Option) (*Log, error) {
	return follow(harness, path, fi, next, nil, opts...)
}

// follow is Follow; wrap, if set, wraps the file's reads (tests).
func follow(harness, path string, fi fs.FileInfo, next int64, wrap func(io.ReaderAt) io.ReaderAt, opts ...Option) (*Log, error) {
	l, err := open(harness, path, fi, opts)
	if err != nil {
		return nil, err
	}
	if wrap != nil {
		l.r = wrap(l.f)
	}
	l.tailEnd = next
	ctx, cancel := context.WithCancel(context.Background())
	l.cancel = cancel
	go l.build(ctx)
	return l, nil
}

// Read indexes the whole transcript at path (a subagent's), in the
// caller's goroutine; Refresh reads what was appended since.
func Read(ctx context.Context, harness, path string, opts ...Option) (*Log, error) {
	l, err := open(harness, path, nil, opts)
	if err != nil {
		return nil, err
	}
	l.cancel = func() {}
	if err := l.Refresh(ctx); err != nil {
		l.Close()
		return nil, err
	}
	l.isReady, l.live = true, true
	close(l.ready)
	return l, nil
}

func open(harness, path string, fi fs.FileInfo, opts []Option) (*Log, error) {
	if !Supported(harness) {
		return nil, fmt.Errorf("no transcripts for harness %q", harness)
	}
	f, got, err := jsonl.Open(path)
	if err != nil {
		return nil, err
	}
	if fi != nil && !os.SameFile(fi, got) {
		f.Close()
		return nil, ErrReplaced
	}
	l := &Log{harness: harness, path: path, parse: parserOf(harness), f: f, r: f, fi: got, ready: make(chan struct{}),
		done: make(chan struct{}), byID: map[string]int32{}, msgs: map[string]*msgState{}, subs: map[*Sub]struct{}{},
		env: newImageEnv()}
	for _, o := range opts {
		o(l)
	}
	return l, nil
}

// defaultEnv resolves the images of an item built without a log (tests):
// it decodes and hashes inline images and keeps nothing.
var defaultEnv = newImageEnv()

// build indexes the lines before the tail's, then goes live.
func (l *Log) build(ctx context.Context) {
	for {
		l.mu.Lock()
		if l.err != nil {
			l.mu.Unlock()
			return
		}
		from, to := l.built, l.tailEnd
		if from >= to {
			l.live = true
			l.setReady()
			l.mu.Unlock()
			return
		}
		l.mu.Unlock()
		next, err := l.scan(ctx, from, to)
		if err == nil && next < to {
			err = ErrReplaced // shorter than the tail read it: truncated
		}
		if err != nil {
			if ctx.Err() != nil {
				err = ErrClosed
			}
			l.end(err)
			return
		}
	}
}

// Refresh indexes what a Read log's file gained (complete lines only).
func (l *Log) Refresh(ctx context.Context) error {
	fi, err := l.f.Stat()
	if err != nil {
		return err
	}
	l.mu.Lock()
	from := l.built
	l.mu.Unlock()
	if fi.Size() < from {
		return ErrReplaced
	}
	_, err = l.scan(ctx, from, fi.Size())
	return err
}

// scan indexes the complete lines in [from, to).
func (l *Log) scan(ctx context.Context, from, to int64) (int64, error) {
	next, err := jsonl.Scan(l.r, from, to, scanChunk, func(off int64, line []byte) {
		cs, v := l.parse(off, line)
		l.mu.Lock()
		l.index(off, len(line), cs, v)
		l.mu.Unlock()
	}, ctx.Err)
	l.mu.Lock()
	if next > l.built {
		l.built = next
	}
	l.mu.Unlock()
	return next, err
}

// Line indexes a line the tail read (the tail's goroutine); before the
// build caught up it only notes how far the tail is.
func (l *Log) Line(off int64, b []byte) {
	l.mu.Lock()
	if l.err != nil || off < l.built {
		l.mu.Unlock()
		return
	}
	if !l.live {
		l.tailEnd = off + int64(len(b)) + 1
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	cs, v := l.parse(off, b)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.err != nil {
		return
	}
	l.index(off, len(b), cs, v)
	l.built = off + int64(len(b)) + 1
}

// Void ends the log: the tail's lines are void (usage.Tap).
func (l *Log) Void(gone bool) {
	if gone {
		l.end(ErrGone)
		return
	}
	l.end(ErrReplaced)
}

// Close ends the log and closes its file.
func (l *Log) Close() { l.end(ErrClosed) }

func (l *Log) end(err error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.err != nil {
		return
	}
	l.err = err
	l.cancel()
	l.setReady()
	close(l.done)
	for s := range l.subs {
		s.signal()
	}
	// Reads in flight fail; nothing is read after this.
	_ = l.f.Close()
}

func (l *Log) setReady() {
	if !l.isReady {
		l.isReady = true
		close(l.ready)
	}
}

// Ready is closed once the index caught up with the tail (or the log
// ended: Err).
func (l *Log) Ready() <-chan struct{} { return l.ready }

// Done is closed when the log ended.
func (l *Log) Done() <-chan struct{} { return l.done }

// Err is why the log ended (nil while it runs).
func (l *Log) Err() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.err
}

// Path is the transcript's file.
func (l *Log) Path() string { return l.path }

// Harness is the transcript's harness.
func (l *Log) Harness() string { return l.harness }

// Version is the agent's version the transcript records (Claude's
// version, Codex's cli_version), the last seen.
func (l *Log) Version() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.version
}

// Len is how many items the log has.
func (l *Log) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.entries)
}

// index adds one line's contributions (under mu).
func (l *Log) index(off int64, n int, cs []contrib, version string) {
	if version != "" {
		l.version = version
	}
	for k := range cs {
		c := &cs[k]
		sp := span{off: off, n: int32(n), k: int16(k)}
		switch c.link {
		case linkOwn:
			if i, ok := l.byID[c.id]; ok {
				l.addSpan(i, sp, c)
				continue
			}
			i := l.newEntry(c.id, c, sp)
			if c.kind == proto.ItemTool || c.kind == proto.ItemSubagent {
				l.open = append(l.open, i)
			}
		case linkBlock:
			m := l.msg(c.msg)
			if i, ok := m.blocks[c.block]; ok {
				l.addSpan(i, sp, c)
				m.last = i
				continue
			}
			if last := m.last; last >= 0 && (c.kind == proto.ItemAssistant || c.kind == proto.ItemThinking) &&
				l.entries[last].kind == c.kind {
				m.blocks[c.block] = last
				l.addSpan(last, sp, c)
				continue
			}
			if i, ok := l.byID[c.id]; ok { // a tool_use id seen before
				m.blocks[c.block], m.last = i, i
				l.addSpan(i, sp, c)
				continue
			}
			i := l.newEntry(c.id, c, sp)
			m.blocks[c.block], m.last = i, i
			if c.kind == proto.ItemTool || c.kind == proto.ItemSubagent {
				l.open = append(l.open, i)
			}
		case linkResult:
			if c.id == "" {
				continue
			}
			i, ok := l.byID[c.id]
			if !ok { // a result without its call (before this file)
				l.newEntry(c.id, c, sp)
				continue
			}
			l.addSpan(i, sp, c)
			l.closeCall(i)
		case linkAbort:
			for _, i := range l.open {
				l.addSpan(i, sp, c)
			}
			l.open = l.open[:0]
		}
	}
}

func (l *Log) msg(id string) *msgState {
	m := l.msgs[id]
	if m == nil {
		m = &msgState{last: -1, blocks: map[int]int32{}}
		l.msgs[id] = m
		l.msgOrder = append(l.msgOrder, id)
		if len(l.msgOrder) > maxMessages {
			delete(l.msgs, l.msgOrder[0])
			l.msgOrder = l.msgOrder[1:]
		}
	}
	return m
}

func (l *Log) closeCall(i int32) {
	for j, o := range l.open {
		if o == i {
			l.open = append(l.open[:j], l.open[j+1:]...)
			return
		}
	}
}

func (l *Log) newEntry(id string, c *contrib, sp span) int32 {
	i := int32(len(l.entries))
	l.entries = append(l.entries, entry{id: id, ts: c.ts, kind: c.kind, hidden: c.hidden, hasImg: c.hasImg(), spans: []span{sp}})
	l.byID[id] = i
	for s := range l.subs {
		s.signal()
	}
	return i
}

func (l *Log) addSpan(i int32, sp span, c *contrib) {
	e := &l.entries[i]
	e.spans = append(e.spans, sp)
	e.hasImg = e.hasImg || c.hasImg()
	for s := range l.subs {
		s.update(i)
	}
}

// Items reads the items at the given entry indexes back from the file
// (full: untruncated, else capped for lists).
func (l *Log) items(idx []int32, full bool) ([]proto.TranscriptItem, error) {
	l.mu.Lock()
	if l.err != nil {
		err := l.err
		l.mu.Unlock()
		return nil, err
	}
	es := make([]entry, len(idx))
	for j, i := range idx {
		es[j] = l.entries[i]
		es[j].spans = append([]span(nil), l.entries[i].spans...)
	}
	l.mu.Unlock()
	parsed := map[int64][]contrib{}
	var buf []byte
	out := make([]proto.TranscriptItem, 0, len(es))
	for j, e := range es {
		var b *builder
		for _, sp := range e.spans {
			cs, ok := parsed[sp.off]
			if !ok {
				if cap(buf) < int(sp.n) {
					buf = make([]byte, sp.n)
				}
				buf = buf[:sp.n]
				if _, err := l.r.ReadAt(buf, sp.off); err != nil {
					if l.Err() != nil {
						return nil, l.Err()
					}
					return nil, fmt.Errorf("%w: %v", ErrReplaced, err)
				}
				cs, _ = l.parse(sp.off, buf)
				parsed[sp.off] = cs
			}
			if int(sp.k) >= len(cs) {
				continue // the file changed under the index: a resync follows
			}
			c := &cs[sp.k]
			if b == nil {
				b = newBuilder(e.id, int64(idx[j])+1, c)
				b.it.Kind, b.it.Hidden = e.kind, e.hidden
				b.env = l.env
			}
			b.add(c)
		}
		if b == nil {
			b = &builder{it: proto.TranscriptItem{ID: e.id, Seq: int64(idx[j]) + 1, TS: e.ts, Kind: e.kind, Hidden: e.hidden}, env: l.env}
		}
		out = append(out, b.finish(full))
	}
	return out, nil
}

// Page is a run of items, oldest first, and where the run starts.
type Page struct {
	Items   []proto.TranscriptItem
	Cursor  string // before this: the items older than these
	HasMore bool
}

// Cursor is the cursor of the items before seq.
func Cursor(seq int64) string { return "c:" + strconv.FormatInt(seq, 10) }

// ParseCursor reads a cursor: the seq its items come before.
func ParseCursor(s string) (int64, bool) {
	n, err := strconv.ParseInt(strings.TrimPrefix(s, "c:"), 10, 64)
	if !strings.HasPrefix(s, "c:") || err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// Before returns up to limit visible items (hidden ones between them
// come along) older than seq (0: the newest).
func (l *Log) Before(seq int64, limit int) (Page, error) {
	l.mu.Lock()
	end := int32(len(l.entries))
	if seq > 0 && seq-1 < int64(end) {
		end = int32(seq - 1)
	}
	idx := l.pick(end, limit)
	l.mu.Unlock()
	return l.page(idx, end)
}

// pick walks back from end (under mu).
func (l *Log) pick(end int32, limit int) []int32 {
	var idx []int32
	visible := 0
	for i := end - 1; i >= 0 && len(idx) < MaxPageItems; i-- {
		if !l.entries[i].hidden {
			if visible == limit {
				break
			}
			visible++
		}
		idx = append(idx, i)
	}
	for a, b := 0, len(idx)-1; a < b; a, b = a+1, b-1 {
		idx[a], idx[b] = idx[b], idx[a]
	}
	return idx
}

func (l *Log) page(idx []int32, end int32) (Page, error) {
	items, err := l.items(idx, false)
	if err != nil {
		return Page{}, err
	}
	// Keep the newest within MaxPageBytes.
	size, from := 0, len(items)
	for from > 0 {
		s := approxSize(&items[from-1])
		if size+s > MaxPageBytes && from < len(items) {
			break
		}
		size += s
		from--
	}
	items = items[from:]
	p := Page{Items: items, Cursor: Cursor(int64(end) + 1)}
	if len(items) > 0 {
		p.Cursor = Cursor(items[0].Seq)
		p.HasMore = items[0].Seq > 1
	} else {
		p.HasMore = end > 0
	}
	return p, nil
}

// approxSize is about an item's size in JSON.
func approxSize(it *proto.TranscriptItem) int {
	n := 160 + len(it.ID)
	for _, p := range it.Parts {
		n += len(p.Text) + 16
	}
	if t := it.Tool; t != nil {
		n += len(t.Name) + len(t.InputSummary) + len(t.Input) + len(t.OutputText) + 16*len(t.Images)
		for _, d := range t.Diffs {
			n += diffSize(d)
		}
		if t.Diff != nil && len(t.Diffs) == 0 {
			n += diffSize(*t.Diff)
		}
	}
	if it.Notice != nil {
		n += len(it.Notice.Text)
	}
	return n * 11 / 10 // escaping
}

func diffSize(d proto.TranscriptDiff) int {
	n := len(d.Path)
	for _, h := range d.Hunks {
		for _, s := range h.Lines {
			n += len(s) + 4
		}
	}
	return n
}

// Item is the item with id in full; ok is false when there is none.
func (l *Log) Item(id string) (proto.TranscriptItem, bool, error) {
	l.mu.Lock()
	i, ok := l.byID[id]
	l.mu.Unlock()
	if !ok {
		return proto.TranscriptItem{}, false, nil
	}
	items, err := l.items([]int32{i}, true)
	if err != nil {
		return proto.TranscriptItem{}, false, err
	}
	return items[0], true, nil
}

// Sub follows a log's changes for one watcher.
type Sub struct {
	l        *Log
	next     int32              // the first entry not taken
	updated  map[int32]struct{} // entries changed since taken
	wake     chan struct{}
	overflow bool
}

// Subscribe follows the log from now on and returns the newest page as
// of then (the watch's ack).
func (l *Log) Subscribe(limit int) (*Sub, Page, error) {
	l.mu.Lock()
	if l.err != nil {
		err := l.err
		l.mu.Unlock()
		return nil, Page{}, err
	}
	end := int32(len(l.entries))
	s := &Sub{l: l, next: end, updated: map[int32]struct{}{}, wake: make(chan struct{}, 1)}
	l.subs[s] = struct{}{}
	idx := l.pick(end, limit)
	l.mu.Unlock()
	p, err := l.page(idx, end)
	if err != nil {
		s.Close()
		return nil, Page{}, err
	}
	return s, p, nil
}

// Wake has a value when something changed (or the log ended).
func (s *Sub) Wake() <-chan struct{} { return s.wake }

func (s *Sub) signal() {
	if int(int32(len(s.l.entries))-s.next)+len(s.updated) > MaxPending {
		s.overflow = true
	}
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Sub) update(i int32) {
	if i < s.next {
		s.updated[i] = struct{}{}
	}
	s.signal()
}

// ErrOverflow is a subscriber that fell MaxPending changes behind.
var ErrOverflow = errors.New("transcript subscriber overflowed")

// Take returns what changed since the last Take: new items and items sent
// before that changed (whole, capped for lists).
func (s *Sub) Take() (items, updates []proto.TranscriptItem, err error) {
	l := s.l
	l.mu.Lock()
	if l.err != nil {
		err := l.err
		l.mu.Unlock()
		return nil, nil, err
	}
	if s.overflow {
		l.mu.Unlock()
		return nil, nil, ErrOverflow
	}
	end := int32(len(l.entries))
	var news, ups []int32
	for i := s.next; i < end; i++ {
		news = append(news, i)
	}
	for i := range s.updated {
		ups = append(ups, i)
	}
	s.next, s.updated = end, map[int32]struct{}{}
	l.mu.Unlock()
	slices.Sort(ups)
	if items, err = l.items(news, false); err != nil {
		return nil, nil, err
	}
	if updates, err = l.items(ups, false); err != nil {
		return nil, nil, err
	}
	return items, updates, nil
}

// Close stops following.
func (s *Sub) Close() {
	s.l.mu.Lock()
	delete(s.l.subs, s)
	s.l.mu.Unlock()
}

// parseAt reads the line at off (n bytes) back from the file and parses it.
func (l *Log) parseAt(off int64, n int) ([]contrib, error) {
	buf := make([]byte, n)
	if _, err := l.r.ReadAt(buf, off); err != nil {
		if l.Err() != nil {
			return nil, l.Err()
		}
		return nil, fmt.Errorf("%w: %v", ErrReplaced, err)
	}
	cs, _ := l.parse(off, buf)
	return cs, nil
}

// Images lists the images of the whole session, oldest first: the refs of
// every item that has any, from the index (no bytes; each item is read back
// from the file once, its images are then remembered). At most limit, the
// newest; more says there were older ones.
func (l *Log) Images(limit int) (refs []proto.ImageRef, more bool, err error) {
	l.mu.Lock()
	if l.err != nil {
		err := l.err
		l.mu.Unlock()
		return nil, false, err
	}
	var idx []int32
	for i := range l.entries {
		if l.entries[i].hasImg {
			idx = append(idx, int32(i))
		}
	}
	l.mu.Unlock()
	// Items are read in batches from the newest back, until limit images.
	const batch = 64
	var newest [][]proto.ImageRef
	total := 0
	for end := len(idx); end > 0 && total < limit; {
		start := max(0, end-batch)
		items, err := l.items(idx[start:end], false)
		if err != nil {
			return nil, false, err
		}
		for j := len(items) - 1; j >= 0; j-- {
			rs := itemImages(&items[j])
			newest = append(newest, rs)
			total += len(rs)
		}
		end = start
		if end > 0 && total >= limit {
			more = true
		}
	}
	for i := len(newest) - 1; i >= 0; i-- {
		refs = append(refs, newest[i]...)
	}
	if len(refs) > limit {
		refs, more = refs[len(refs)-limit:], true
	}
	return refs, more, nil
}

// itemImages are the image refs of an item, in order (copies).
func itemImages(it *proto.TranscriptItem) []proto.ImageRef {
	var out []proto.ImageRef
	for _, p := range it.Parts {
		if p.Image != nil {
			out = append(out, *p.Image)
		}
	}
	if t := it.Tool; t != nil {
		for _, p := range t.Images {
			if p.Image != nil {
				out = append(out, *p.Image)
			}
		}
	}
	return out
}
