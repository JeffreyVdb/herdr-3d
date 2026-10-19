package server

// M16 transcript: a worker's agent conversation at the laptop. A
// transcript.watch follows the worker's transcript as the usage tracker
// finds and reads it (one tail per worker, shared: the tracker hands each
// watched worker's lines to its transcript.Log) and pushes new and changed
// items to the watching connection only: connection-scoped messages, no
// seq, never in the replay ring.
//
// #26: a watch's target is a worker or one of its native children (its
// registry row, proto.TranscriptChild). A child's log is found from the
// worker's own row and session, never from the client, and read through the
// same session's tail of its file (usage.Session.Child); watches are keyed
// by target, so a worker's own watch and a child's run side by side.

import (
	"container/list"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/usage"
)

// Defaults and limits of the transcript view.
const (
	DefaultMaxTranscriptWatches = 4 // per connection
	DefaultTranscriptLimit      = 200
	MaxTranscriptLimit          = 500
	// DefaultTranscriptFlush is the least time between two pushes of one
	// watch (at most 4 a second).
	DefaultTranscriptFlush = 250 * time.Millisecond
	// WatchedRescan is how often a watched worker's transcript not found
	// (or a Codex worker's rollout) is looked for.
	WatchedRescan = 2 * time.Second
	// maxAgentLogs is how many subagent timelines a watch keeps indexed.
	maxAgentLogs = 4
	// maxImageReads is how many transcript.image reads one watch has in
	// flight; more are busy.
	maxImageReads = 16
	// maxSentHashes bounds the image hashes a watch remembers sending.
	maxSentHashes = 200_000
	// MaxChildTranscriptWatches (#26) is how many child watches one
	// connection has, apart from its MaxTranscriptWatches: a seat shows one
	// child at a time, and the one before it may still be closing. A newer
	// one evicts the oldest (transcript.closed evicted).
	MaxChildTranscriptWatches = 2
	// MaxChildTranscriptLogs (#26) is how many children's logs the bridge
	// follows at once, for every connection (a child watched twice is one
	// log); a watch of another one past it is refused (capacity). A log goes
	// with its last watch; watched again, it is read again from its file.
	MaxChildTranscriptLogs = 16
)

// txOffer is what the usage tracker found for a watched worker: its agent
// session (key: harness/session) and, once its transcript was found, the
// log that follows it.
type txOffer struct {
	key, harness, session string
	log                   *transcript.Log
	// avail (#26, a child's) is its proto.Transcript* availability while
	// log is nil.
	avail string
}

// txWatch is one connection watching one worker's transcript, or (#26)
// one of its children's.
type txWatch struct {
	c       *Client
	id      string
	child   *proto.TranscriptChild // #26: nil for the worker's own
	key     string                 // the target (txKey)
	born    uint64                 // order of the watches made (#26: the oldest child watch is evicted)
	limit   int
	cancel  context.CancelFunc
	offers  chan txOffer // (cap 1) the tracker's latest
	stopped bool         // unregistered (under txWatches.mu)
	// Under txWatches.mu: what page and item read.
	log     *transcript.Log
	session string
	agents  *agentLogs
	// sent are the image hashes this connection was sent (an item, a page,
	// the image list): transcript.image serves only those, and never a path
	// or a hash it was not told.
	sentMu sync.Mutex
	sent   map[string]struct{}
	// reads is the in-flight transcript.image reads.
	reads chan struct{}
}

// noteImages remembers the hashes of the images in items as sent.
func (w *txWatch) noteImages(items []proto.TranscriptItem) {
	w.sentMu.Lock()
	defer w.sentMu.Unlock()
	note := func(r *proto.ImageRef) {
		if r != nil && r.Hash != "" && len(w.sent) < maxSentHashes {
			w.sent[r.Hash] = struct{}{}
		}
	}
	for i := range items {
		for _, p := range items[i].Parts {
			note(p.Image)
		}
		if t := items[i].Tool; t != nil {
			for _, p := range t.Images {
				note(p.Image)
			}
		}
	}
}

func (w *txWatch) noteRefs(refs []proto.ImageRef) {
	w.sentMu.Lock()
	defer w.sentMu.Unlock()
	for i := range refs {
		if h := refs[i].Hash; h != "" && len(w.sent) < maxSentHashes {
			w.sent[h] = struct{}{}
		}
	}
}

func (w *txWatch) wasSent(hash string) bool {
	w.sentMu.Lock()
	defer w.sentMu.Unlock()
	_, ok := w.sent[hash]
	return ok
}

// txWatches are the running transcript watches (their own lock: pushes are
// sent from the watches' goroutines), by connection and target.
type txWatches struct {
	mu   sync.Mutex
	byC  map[*Client]map[string]*txWatch
	born uint64
}

// txKey is a watch's target: worker id, or (#26) worker id and child row.
func txKey(id string, child *proto.TranscriptChild) string {
	if child == nil {
		return id
	}
	return id + "\x00" + child.ID
}

func (t *txWatches) get(c *Client, key string) *txWatch {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.byC[c][key]
}

// count is how many watches of workers' own transcripts (child: of
// children) a connection has.
func (t *txWatches) count(c *Client, child bool) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, w := range t.byC[c] {
		if (w.child != nil) == child {
			n++
		}
	}
	return n
}

// oldestChild is a connection's oldest child watch but the one of key.
func (t *txWatches) oldestChild(c *Client, key string) *txWatch {
	t.mu.Lock()
	defer t.mu.Unlock()
	var old *txWatch
	for k, w := range t.byC[c] {
		if w.child != nil && k != key && (old == nil || w.born < old.born) {
			old = w
		}
	}
	return old
}

// childLogs is how many children's logs the watches need, but the one of
// key: every connection's child watches, a child watched twice once.
func (t *txWatches) childLogs(key string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	seen := map[string]bool{}
	for _, m := range t.byC {
		for k, w := range m {
			if w.child != nil && k != key {
				seen[k] = true
			}
		}
	}
	return len(seen)
}

// children are the children of worker id that are watched (one each).
func (t *txWatches) children(id string) []*txWatch {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []*txWatch
	seen := map[string]bool{}
	for _, m := range t.byC {
		for k, w := range m {
			if w.child != nil && w.id == id && !seen[k] {
				seen[k] = true
				out = append(out, w)
			}
		}
	}
	return out
}

// add registers w, replacing (and returning) the connection's watch of the
// same worker.
func (t *txWatches) add(w *txWatch) (old *txWatch) {
	t.mu.Lock()
	defer t.mu.Unlock()
	m := t.byC[w.c]
	if m == nil {
		m = map[string]*txWatch{}
		t.byC[w.c] = m
	}
	if old = m[w.key]; old != nil {
		old.stopped = true
	}
	t.born++
	w.born = t.born
	m[w.key] = w
	return old
}

// remove unregisters w if it is still registered; nothing of it is sent
// after that.
func (t *txWatches) remove(w *txWatch) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if w.stopped || t.byC[w.c][w.key] != w {
		return false
	}
	w.stopped = true
	delete(t.byC[w.c], w.key)
	if len(t.byC[w.c]) == 0 {
		delete(t.byC, w.c)
	}
	return true
}

func (t *txWatches) all() []*txWatch {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []*txWatch
	for _, m := range t.byC {
		for _, w := range m {
			out = append(out, w)
		}
	}
	return out
}

// watched reports whether any connection watches worker id's transcript
// or (#26) one of its children's.
func (t *txWatches) watched(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, m := range t.byC {
		for _, w := range m {
			if w.id == id {
				return true
			}
		}
	}
	return false
}

// watchedOwn reports whether any connection watches worker id's own
// transcript.
func (t *txWatches) watchedOwn(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, m := range t.byC {
		if m[id] != nil {
			return true
		}
	}
	return false
}

// offer hands the tracker's verdict on a target (txKey) to its watches,
// the latest replacing one not taken yet.
func (t *txWatches) offer(key string, o txOffer) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, m := range t.byC {
		w := m[key]
		if w == nil {
			continue
		}
		select {
		case <-w.offers:
		default:
		}
		w.offers <- o
	}
}

// setLog records what a watch reads now (its goroutine).
func (t *txWatches) setLog(w *txWatch, log *transcript.Log, session string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	w.log, w.session = log, session
}

func (t *txWatches) reading(w *txWatch) (*transcript.Log, string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return w.log, w.session
}

// send queues a push of w without blocking, only while w is registered
// and its connection's send queue is at most half full (as terminal
// frames).
func (t *txWatches) send(w *txWatch, msg []byte) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if w.stopped {
		return errWatchStopped
	}
	if !roomy(w.c) {
		return errResync
	}
	select {
	case w.c.send <- msg:
		return nil
	default:
		return errResync
	}
}

func (h *Hub) initTranscripts() {
	h.tx.byC = map[*Client]map[string]*txWatch{}
	h.usageKick = make(chan struct{}, 1)
}

// kickUsage asks the usage tracker for a round now.
func (h *Hub) kickUsage() {
	select {
	case h.usageKick <- struct{}{}:
	default:
	}
}

// startTranscriptWatch validates transcript.watch and starts the watch;
// the ack comes once the worker's transcript is indexed, or is pending
// (hub goroutine).
func (h *Hub) startTranscriptWatch(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TranscriptWatchArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Limit < 0 || a.Limit > MaxTranscriptLimit {
		return bad("limit must be 1-%d", MaxTranscriptLimit)
	}
	if a.Limit == 0 {
		a.Limit = DefaultTranscriptLimit
	}
	wk, err := h.txWorker(a.ID)
	if err != nil {
		return err
	}
	key := txKey(a.ID, a.Child)
	if a.Child != nil { // #26
		if _, err := h.txChild(a.ID, a.Child); err != nil {
			return err
		}
		if n := h.tx.childLogs(key); n >= MaxChildTranscriptLogs {
			return fmt.Errorf("%w: the bridge already follows %d child transcripts", errCapacity, n)
		}
	} else {
		n := h.tx.count(c, false)
		if h.tx.get(c, key) != nil { // a re-watch replaces it
			n--
		}
		if n >= h.opts.MaxTranscriptWatches {
			return fmt.Errorf("%w: this connection already watches %d transcripts (--max-transcript-watches)", errCapacity, n)
		}
	}
	wctx, cancel := context.WithCancel(ctx)
	w := &txWatch{c: c, id: a.ID, child: a.Child, key: key, limit: a.Limit, cancel: cancel, offers: make(chan txOffer, 1),
		sent: map[string]struct{}{}, reads: make(chan struct{}, maxImageReads)}
	if a.Child == nil {
		w.agents = newAgentLogs(h.txImageOptions(wk.Cwd))
	}
	if old := h.tx.add(w); old != nil {
		old.cancel()
	}
	if a.Child != nil && h.tx.count(c, true) > MaxChildTranscriptWatches {
		if old := h.tx.oldestChild(c, key); old != nil {
			h.closeTranscriptWatch(old, proto.ClosedEvicted)
		}
	}
	h.wg.Add(1)
	go h.runTranscriptWatch(ctx, wctx, w, cmd)
	h.kickUsage()
	if a.Child == nil {
		h.retryCodexJoin(a.ID)  // #156: a failed join is tried again when the player looks
		h.syncCodexWatches(ctx) // #155: a shared Codex worker's thread is joined now
	}
	return nil
}

// txChild is the child a transcript target names (#26): a row of the
// worker's now, of its current generation and the provider named (hub
// goroutine).
func (h *Hub) txChild(id string, t *proto.TranscriptChild) (proto.Child, error) {
	if t.ID == "" || (t.Provider != proto.ChildClaude && t.Provider != proto.ChildCodex) {
		return proto.Child{}, bad("child needs its id and its provider (%q or %q)", proto.ChildClaude, proto.ChildCodex)
	}
	if g := h.ch.reg.Generation(id); g != t.Generation {
		return proto.Child{}, &codedError{proto.ErrStale, fmt.Errorf("the worker's session was replaced (generation %d, not %d): its children went with it", g, t.Generation)}
	}
	c, ok := h.ch.reg.Child(id, t.ID)
	if !ok || c.Provider != t.Provider {
		return proto.Child{}, &codedError{proto.ErrNotFound, fmt.Errorf("worker %q has no %s child %q", id, t.Provider, t.ID)}
	}
	return c, nil
}

// txWorker is the worker a transcript command is for: known, on a watched
// floor that is running.
func (h *Hub) txWorker(id string) (*proto.Worker, error) {
	w := h.workers[id]
	if w == nil {
		return nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	f, err := h.floorFor(w.Session)
	if err != nil {
		return nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	if !f.running {
		return nil, fmt.Errorf("%w: floor %q is asleep", errInvalidState, w.Session)
	}
	if h.opts.Usage == nil {
		return nil, errors.New("transcripts are not configured")
	}
	return w, nil
}

// startTranscriptUnwatch answers transcript.unwatch; a watch that is not
// there is a no-op.
func (h *Hub) startTranscriptUnwatch(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.TranscriptUnwatchArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if w := h.tx.get(c, txKey(a.ID, a.Child)); w != nil && h.tx.remove(w) {
		w.cancel()
	}
	h.syncCodexWatches(ctx) // #155
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

// dropTranscriptWatches stops every transcript watch of a connection that
// went away.
func (h *Hub) dropTranscriptWatches(c *Client) {
	for _, w := range h.tx.all() {
		if w.c == c && h.tx.remove(w) {
			w.cancel()
		}
	}
}

// syncTranscriptWatches ends the watches whose worker went or fell asleep,
// and (#26) the child watches whose child went or whose worker's session
// was replaced (hub goroutine, after each observation and child evidence).
func (h *Hub) syncTranscriptWatches() {
	for _, w := range h.tx.all() {
		reason := ""
		wk := h.workers[w.id]
		switch {
		case wk == nil:
			reason = proto.ClosedWorkerRemoved
		case h.floors[wk.Session] == nil || !h.floors[wk.Session].running:
			reason = proto.ClosedAsleep
		case w.child != nil:
			var ce *codedError
			if _, err := h.txChild(w.id, w.child); errors.As(err, &ce) && ce.code == proto.ErrStale {
				reason = proto.ClosedSessionChanged
			} else if err != nil {
				reason = proto.ClosedNotFound
			}
		}
		if reason != "" {
			h.closeTranscriptWatch(w, reason)
		}
	}
}

// closeTranscriptWatch ends a watch and tells its connection why (hub
// goroutine).
func (h *Hub) closeTranscriptWatch(w *txWatch, reason string) {
	if !h.tx.remove(w) {
		return
	}
	w.cancel()
	h.log.Debug("transcript watch closed", "client", w.c.name, "worker", w.id, "child", w.child != nil, "reason", reason)
	h.deliver(w.c, mustJSON(proto.TranscriptClosed{T: proto.TTranscriptClosed, ID: w.id, Child: w.child, Reason: reason}))
}

// runTranscriptWatch follows the tracker's offers for the watch's worker:
// it acks (pending while there is no transcript), then pushes what the
// log gains at most every TranscriptFlush, until the watch ends. hctx is
// the hub's context (replies), ctx the watch's.
func (h *Hub) runTranscriptWatch(hctx, ctx context.Context, w *txWatch, cmd proto.Command) {
	defer h.wg.Done()
	defer w.cancel()
	if w.agents != nil {
		defer w.agents.close()
	}
	var (
		acked bool
		key   string
		avail string // #26: a pending child's availability, as last sent
		log   *transcript.Log
		sub   *transcript.Sub
		last  time.Time
		timer = time.NewTimer(time.Hour)
		armed bool
	)
	timer.Stop()
	defer timer.Stop()
	defer func() {
		if sub != nil {
			sub.Close()
		}
	}()
	closeWith := func(reason string) {
		_ = h.doWait(hctx, func() { h.closeTranscriptWatch(w, reason) })
	}
	fail := func(err error) {
		if !acked {
			h.tx.remove(w)
			h.finishTranscriptCmd(hctx, w, cmd, nil, err)
		}
	}
	// open subscribes to a log once it is indexed.
	open := func(o txOffer) (transcript.Page, bool) {
		select {
		case <-ctx.Done():
			fail(fmt.Errorf("%w: the watch stopped before its transcript was read", errInvalidState))
			return transcript.Page{}, false
		case <-o.log.Ready():
		}
		s, page, err := o.log.Subscribe(w.limit)
		if err != nil {
			reason := closedReason(err)
			if !acked {
				fail(fmt.Errorf("%w: the transcript changed while it was read (%v); watch again", errInvalidState, err))
			} else {
				closeWith(reason)
			}
			return transcript.Page{}, false
		}
		sub, log, key = s, o.log, o.key
		h.tx.setLog(w, o.log, o.session)
		return page, true
	}
	head := func(o txOffer, p transcript.Page, pending bool) proto.TranscriptHead {
		hd := proto.TranscriptHead{Harness: o.harness, Session: o.session, Cursor: p.Cursor, HasMore: p.HasMore, Pending: pending}
		if o.log != nil {
			hd.Version = o.log.Version()
		}
		if w.child != nil { // #26
			hd.Availability = proto.TranscriptAvailable
			if pending {
				hd.Availability = o.avail
			}
		}
		return hd
	}
	// push sends a push of the watch: false when the watch ended.
	push := func(m proto.TranscriptItems) bool {
		m.T, m.ID, m.Child = proto.TTranscriptItems, w.id, w.child
		if err := h.tx.send(w, mustJSON(m)); err != nil {
			if errors.Is(err, errResync) {
				h.log.Debug("transcript watch resync", "client", w.c.name, "worker", w.id)
				closeWith(proto.ClosedResync)
			}
			return false
		}
		return true
	}
	flush := func() bool {
		armed = false
		items, updates, err := sub.Take()
		if err != nil {
			closeWith(closedReason(err))
			return false
		}
		last = time.Now()
		if len(items) == 0 && len(updates) == 0 {
			return true
		}
		w.noteImages(items)
		w.noteImages(updates)
		return push(proto.TranscriptItems{Items: items, Updates: updates})
	}
	var wake <-chan struct{}
	for {
		select {
		case <-ctx.Done():
			fail(fmt.Errorf("%w: the watch stopped before its transcript was read", errInvalidState))
			return
		case o := <-w.offers:
			switch {
			case !acked && o.log == nil:
				acked, key, avail = true, o.key, o.avail
				h.tx.setLog(w, nil, o.session)
				h.finishTranscriptCmd(hctx, w, cmd, &proto.TranscriptWatchResult{
					TranscriptHead: head(o, transcript.Page{Cursor: transcript.Cursor(1)}, true),
					Items:          []proto.TranscriptItem{}}, nil)
			case !acked:
				page, ok := open(o)
				if !ok {
					return
				}
				acked, wake = true, sub.Wake()
				h.finishTranscriptCmd(hctx, w, cmd, &proto.TranscriptWatchResult{TranscriptHead: head(o, page, false),
					Items: page.Items}, nil)
			case log == nil && o.log != nil: // pending: the transcript appeared
				page, ok := open(o)
				if !ok {
					return
				}
				wake = sub.Wake()
				hd := head(o, page, false)
				w.noteImages(page.Items)
				if !push(proto.TranscriptItems{Items: page.Items, Updates: []proto.TranscriptItem{}, TranscriptHead: &hd}) {
					return
				}
				last = time.Now()
			case log == nil:
				key = o.key
				h.tx.setLog(w, nil, o.session)
				if w.child != nil && o.avail != avail { // #26: pending <-> unavailable, said by a head alone
					avail = o.avail
					hd := head(o, transcript.Page{Cursor: transcript.Cursor(1)}, true)
					if !push(proto.TranscriptItems{Items: []proto.TranscriptItem{}, Updates: []proto.TranscriptItem{}, TranscriptHead: &hd}) {
						return
					}
				}
			case o.key != key: // another agent session or rollout
				closeWith(proto.ClosedSessionChanged)
				return
			}
		case <-wake:
			if log.Err() != nil {
				closeWith(closedReason(log.Err()))
				return
			}
			if wait := h.opts.TranscriptFlush - time.Since(last); wait > 0 {
				if !armed {
					timer.Reset(wait)
					armed = true
				}
				continue
			}
			if !flush() {
				return
			}
		case <-timer.C:
			if !flush() {
				return
			}
		}
	}
}

// closedReason is the transcript.closed reason for why a log ended.
func closedReason(err error) string {
	switch {
	case errors.Is(err, transcript.ErrGone):
		return proto.ClosedNotFound
	case errors.Is(err, transcript.ErrClosed):
		return proto.ClosedSessionChanged // the tracker lets a log go when the worker's session changes
	}
	return proto.ClosedResync
}

// finishTranscriptCmd audits transcript.watch (the worker id only) and
// answers it.
func (h *Hub) finishTranscriptCmd(hctx context.Context, w *txWatch, cmd proto.Command, data *proto.TranscriptWatchResult, err error) {
	if data != nil {
		w.noteImages(data.Items)
		// An empty view in the game is traced from here: which worker, and why (no transcript yet, or nothing in it).
		if data.Pending || len(data.Items) == 0 {
			h.log.Debug("transcript watch acked empty", "client", w.c.name, "worker", w.id, "child", w.child != nil, "req_id", cmd.ReqID,
				"pending", data.Pending, "availability", data.Availability, "items", len(data.Items), "limit", w.limit)
		}
	}
	if derr := h.doWait(hctx, func() {
		h.audit(hctx, w.c, cmd, err)
		if data == nil {
			h.reply(w.c, cmd, nil, err)
			return
		}
		h.reply(w.c, cmd, data, err)
	}); derr != nil {
		h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
	}
}

// startTranscriptRead answers transcript.page and transcript.item off the
// hub goroutine. They are reads of what the watch shows: not audited, and
// only for a worker the connection watches.
func (h *Hub) startTranscriptRead(ctx context.Context, c *Client, cmd proto.Command) error {
	var id, agent string
	var child *proto.TranscriptChild // #26
	var work func(w *txWatch, log *transcript.Log) (any, error)
	switch cmd.T {
	case proto.CmdTranscriptPage:
		var a proto.TranscriptPageArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			h.reply(c, cmd, nil, err)
			return nil
		}
		if a.Limit < 0 || a.Limit > MaxTranscriptLimit {
			h.reply(c, cmd, nil, bad("limit must be 1-%d", MaxTranscriptLimit))
			return nil
		}
		if a.Limit == 0 {
			a.Limit = DefaultTranscriptLimit
		}
		var before int64
		if a.Before != "" {
			var ok bool
			if before, ok = transcript.ParseCursor(a.Before); !ok {
				h.reply(c, cmd, nil, bad("before must be a cursor"))
				return nil
			}
		} else if a.Agent == "" {
			h.reply(c, cmd, nil, bad("before is needed (it is optional with agent)"))
			return nil
		}
		id, agent, child = a.ID, a.Agent, a.Child
		work = func(w *txWatch, log *transcript.Log) (any, error) {
			p, err := log.Before(before, a.Limit)
			if err != nil {
				return nil, &codedError{proto.ErrInvalidState, fmt.Errorf("the transcript changed; watch again (%v)", err)}
			}
			w.noteImages(p.Items)
			return proto.TranscriptPageResult{Items: p.Items, Cursor: p.Cursor, HasMore: p.HasMore}, nil
		}
	case proto.CmdTranscriptItem:
		var a proto.TranscriptItemArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			h.reply(c, cmd, nil, err)
			return nil
		}
		if a.Item == "" {
			h.reply(c, cmd, nil, bad("item is needed"))
			return nil
		}
		id, agent, child = a.ID, a.Agent, a.Child
		work = func(w *txWatch, log *transcript.Log) (any, error) {
			it, ok, err := log.Item(a.Item)
			switch {
			case err != nil:
				return nil, &codedError{proto.ErrInvalidState, fmt.Errorf("the transcript changed; watch again (%v)", err)}
			case !ok:
				return nil, &codedError{proto.ErrNotFound, fmt.Errorf("no item %q in the transcript", a.Item)}
			}
			w.noteImages([]proto.TranscriptItem{it})
			return proto.TranscriptItemResult{Item: it}, nil
		}
	case proto.CmdTranscriptImage:
		var a proto.TranscriptImageArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			h.reply(c, cmd, nil, err)
			return nil
		}
		if !imgcache.ValidHash(a.Hash) {
			h.reply(c, cmd, nil, bad("hash must be the sha256 of an image, in hex"))
			return nil
		}
		if a.Size != proto.ImageThumb && a.Size != proto.ImageFull {
			h.reply(c, cmd, nil, bad("size must be %q or %q", proto.ImageThumb, proto.ImageFull))
			return nil
		}
		// #98: the image a worker's activity shows now, for a connection on
		// its floor (its thumbnail only).
		if load := h.activityImage(c, a.ID, a.Hash); load != nil && a.Size == proto.ImageThumb && a.Agent == "" && a.Child == nil {
			h.readActivityImage(ctx, c, cmd, a.Hash, load)
			return nil
		}
		id, agent, child = a.ID, a.Agent, a.Child
		work = func(w *txWatch, log *transcript.Log) (any, error) { return readImage(w, log, a) }
	case proto.CmdTranscriptImages:
		var a proto.TranscriptImagesArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			h.reply(c, cmd, nil, err)
			return nil
		}
		if a.Limit < 0 || a.Limit > proto.MaxSessionImages {
			h.reply(c, cmd, nil, bad("limit must be 1-%d", proto.MaxSessionImages))
			return nil
		}
		if a.Limit == 0 {
			a.Limit = proto.DefaultSessionImages
		}
		var before int64
		if a.Before != "" {
			var ok bool
			if before, ok = transcript.ParseCursor(a.Before); !ok {
				h.reply(c, cmd, nil, bad("before must be a cursor"))
				return nil
			}
		}
		id, child = a.ID, a.Child
		work = func(w *txWatch, log *transcript.Log) (any, error) {
			pg, err := log.Images(before, a.Limit)
			if err != nil {
				return nil, &codedError{proto.ErrInvalidState, fmt.Errorf("the transcript changed; watch again (%v)", err)}
			}
			if pg.Refs == nil {
				pg.Refs = []proto.ImageRef{}
			}
			w.noteRefs(pg.Refs)
			return proto.TranscriptImagesResult{Images: pg.Refs, Cursor: pg.Cursor, HasMore: pg.HasMore}, nil
		}
	}
	if agent != "" && child != nil {
		h.reply(c, cmd, nil, bad("agent and child cannot go together: a child's timeline is its own target"))
		return nil
	}
	w := h.tx.get(c, txKey(id, child))
	if w == nil || (child != nil && *w.child != *child) {
		if _, err := h.txWorker(id); err != nil {
			h.reply(c, cmd, nil, err)
			return nil
		}
		h.reply(c, cmd, nil, fmt.Errorf("%w: this connection does not watch that transcript", errInvalidState))
		return nil
	}
	log, session := h.tx.reading(w)
	if log == nil {
		h.reply(c, cmd, nil, fmt.Errorf("%w: the transcript is pending", errInvalidState))
		return nil
	}
	if agent != "" && (log.Harness() != transcript.Claude || !transcript.ValidAgentID(agent)) {
		h.reply(c, cmd, nil, bad("agent must be a Claude subagent's agent_id"))
		return nil
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		read := log
		var err error
		if agent != "" {
			read, err = w.agents.get(ctx, log, session, agent)
		}
		var data any
		if err == nil {
			data, err = work(w, read)
		}
		if derr := h.doWait(ctx, func() { h.reply(c, cmd, data, err) }); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
	return nil
}

// agentLogs are the subagent timelines a watch read, the most recent
// maxAgentLogs (each refreshed when read again).
type agentLogs struct {
	mu     sync.Mutex
	order  *list.List // of *agentLog, most recent first
	closed bool       // the watch ended
	opts   []transcript.Option
}

type agentLog struct {
	path string
	log  *transcript.Log
}

func newAgentLogs(opts []transcript.Option) *agentLogs {
	return &agentLogs{order: list.New(), opts: opts}
}

// get returns subagent agent's log of the Claude session main is the
// transcript of: <dir>/<session>/subagents/agent-<agent>.jsonl.
func (a *agentLogs) get(ctx context.Context, main *transcript.Log, session, agent string) (*transcript.Log, error) {
	path := filepath.Join(filepath.Dir(main.Path()), session, "subagents", "agent-"+agent+".jsonl")
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, &codedError{proto.ErrInvalidState, errors.New("the watch ended")}
	}
	for e := a.order.Front(); e != nil; e = e.Next() {
		al := e.Value.(*agentLog)
		if al.path != path {
			continue
		}
		if err := al.log.Refresh(ctx); err == nil {
			a.order.MoveToFront(e)
			return al.log, nil
		}
		al.log.Close() // replaced: read it again
		a.order.Remove(e)
		break
	}
	log, err := transcript.Read(ctx, transcript.Claude, path, a.opts...)
	if err != nil {
		return nil, &codedError{proto.ErrNotFound, fmt.Errorf("no transcript for subagent %q", agent)}
	}
	a.order.PushFront(&agentLog{path: path, log: log})
	for a.order.Len() > maxAgentLogs {
		b := a.order.Back()
		b.Value.(*agentLog).log.Close()
		a.order.Remove(b)
	}
	return log, nil
}

func (a *agentLogs) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.closed = true
	for e := a.order.Front(); e != nil; e = e.Next() {
		e.Value.(*agentLog).log.Close()
	}
	a.order.Init()
}

// txLog is the log the tracker keeps for a watched worker.
type txLog struct {
	key string
	log *transcript.Log
}

// syncTranscript keeps worker w's log while it is watched (before and
// after its session's Poll: a transcript found in the Poll gets its log
// then) and drops it when not (usage tracker goroutine).
func (tr *usageTracker) syncTranscript(w usageWorker, s *usage.Session, key string) {
	cur := tr.logs[w.id]
	if cur != nil && (!w.watched || cur.key != key || cur.log.Err() != nil) {
		cur.log.Close()
		delete(tr.logs, w.id)
		if s != nil {
			s.SetTap(nil)
		}
		cur = nil
	}
	if !w.watched || s == nil || cur != nil || !transcript.Supported(w.harness) {
		return
	}
	path, fi, next := s.Main()
	if path == "" {
		return
	}
	log, err := transcript.Follow(w.harness, path, fi, next, tr.imageOptions(w.cwd)...)
	if err != nil {
		return // looked at again next round
	}
	tr.logs[w.id] = &txLog{key: key, log: log}
	s.SetTap(log)
}

// offers is the tracker's verdict for every watched worker after a round,
// and (#26) for every watched child, by target (txKey).
func (tr *usageTracker) offers(ws []usageWorker) map[string]txOffer {
	out := map[string]txOffer{}
	for _, w := range ws {
		for _, k := range w.kids {
			// A provisional child (no native id yet) is pending whatever its row says; one whose log is not read
			// is pending, or unavailable when its provider says so.
			o := txOffer{key: k.logKey(), harness: k.harness, session: k.native, avail: proto.TranscriptPending}
			if k.native != "" && k.avail == proto.TranscriptUnavailable {
				o.avail = proto.TranscriptUnavailable
			}
			if l := tr.kidLogs[w.id][k.key]; l != nil && l.key == o.key && l.log.Err() == nil {
				o.log, o.avail = l.log, proto.TranscriptAvailable
			}
			out[k.key] = o
		}
		if !w.watched {
			continue
		}
		o := txOffer{key: tr.keys[w.id], harness: w.harness, session: w.session}
		if l := tr.logs[w.id]; l != nil && l.key == o.key {
			o.log = l.log
		}
		out[w.id] = o
	}
	return out
}

// txKid is a child of a worker a connection watches (#26), as the hub's
// registry has it now: its target (txKey), native id ("": provisional), the
// worker's agent session it belongs to, its harness and the transcript
// availability its evidence says.
type txKid struct {
	key, native, session, harness, avail string
}

// logKey is the identity of the child's log.
func (k txKid) logKey() string { return k.harness + "/" + k.session + "/" + k.native }

// txKids are worker id's watched children (hub goroutine): rows of its
// current generation only (a watch of another is about to close).
func (h *Hub) txKids(id string) []txKid {
	var out []txKid
	for _, w := range h.tx.children(id) {
		c, err := h.txChild(id, w.child)
		if err != nil {
			continue
		}
		k := txKid{key: w.key, native: c.NativeID, session: c.AgentSession, harness: c.Provider, avail: c.Transcript}
		if k.harness == transcript.Claude && k.native != "" && !transcript.ValidAgentID(k.native) {
			k.native, k.avail = "", proto.TranscriptUnavailable // never a file of its name
		}
		out = append(out, k)
	}
	return out
}

// syncKidTranscripts keeps a log of each watched child of worker w whose
// transcript its session reads, fed by the session's own tail of it, and
// drops the others (usage tracker goroutine, before and after the session's
// Poll). Only children of the session the worker has now: another session's
// child never reaches its log, nor does a child of another worker in the
// same directory (its own session).
func (tr *usageTracker) syncKidTranscripts(w usageWorker, s *usage.Session) {
	want := map[string]txKid{}
	var natives []string
	for _, k := range w.kids {
		if k.native != "" && tr.keys[w.id] == k.harness+"/"+k.session {
			want[k.key] = k
			natives = append(natives, k.native)
		}
	}
	tr.closeKidLogs(w.id, want)
	if s == nil {
		return
	}
	s.WantChildren(natives)
	for key, k := range want {
		if tr.kidLogs[w.id][key] != nil {
			continue
		}
		f, ok := s.Child(k.native)
		if !ok {
			continue // not read yet: looked for in the next Poll
		}
		opts := tr.imageOptions(w.cwd)
		if k.harness == transcript.Codex {
			opts = append(opts, transcript.CodexHistoryStart(f.HistoryStart)) // its parent's copied history is not its own
		}
		log, err := transcript.Follow(k.harness, f.Path, f.File, f.Next, opts...)
		if err != nil {
			continue
		}
		if tr.kidLogs[w.id] == nil {
			tr.kidLogs[w.id] = map[string]*txLog{}
		}
		tr.kidLogs[w.id][key] = &txLog{key: k.logKey(), log: log}
		s.SetChildTap(k.native, log)
	}
}

// closeKidLogs closes worker id's child logs, but the ones keep still wants
// (the same log, still running).
func (tr *usageTracker) closeKidLogs(id string, keep map[string]txKid) {
	for key, l := range tr.kidLogs[id] {
		if k, ok := keep[key]; ok && l.key == k.logKey() && l.log.Err() == nil {
			continue
		}
		l.log.Close()
		delete(tr.kidLogs[id], key)
	}
	if len(tr.kidLogs[id]) == 0 {
		delete(tr.kidLogs, id)
	}
}

// txImageOptions are the options a transcript log is opened with for a
// worker: the bridge's images, and the worker's own directory as a root of
// its path images.
func (h *Hub) txImageOptions(cwd string) []transcript.Option {
	var opts []transcript.Option
	if h.opts.Usage != nil && h.opts.Usage.Images != nil {
		opts = append(opts, transcript.WithImages(h.opts.Usage.Images))
	}
	if cwd != "" {
		opts = append(opts, transcript.WithCwd(cwd))
	}
	return opts
}

// readImage answers transcript.image: the thumbnail or the full image of a
// hash this connection was sent.
func readImage(w *txWatch, log *transcript.Log, a proto.TranscriptImageArgs) (any, error) {
	if !w.wasSent(a.Hash) {
		return nil, &codedError{proto.ErrNotFound, errors.New("no image with that hash was sent on this connection")}
	}
	select {
	case w.reads <- struct{}{}:
		defer func() { <-w.reads }()
	default:
		return nil, &codedError{proto.ErrBusy, fmt.Errorf("already reading %d images for this watch", maxImageReads)}
	}
	if a.Size == proto.ImageThumb {
		t, err := log.Thumb(a.Hash)
		if err != nil {
			return nil, imageError(err)
		}
		return proto.TranscriptImageResult{Mime: t.Mime, Width: t.Width, Height: t.Height, Bytes: len(t.Data), Size: proto.ImageThumb,
			Data: base64.StdEncoding.EncodeToString(t.Data)}, nil
	}
	data, err := log.Image(a.Hash)
	if err != nil {
		return nil, imageError(err)
	}
	if base64.StdEncoding.EncodedLen(len(data)) > proto.MaxFullImageBase64 {
		return nil, &codedError{proto.ErrTooLarge, fmt.Errorf("the image is %d bytes, the most sent whole is %d bytes of base64", len(data), proto.MaxFullImageBase64)}
	}
	info, _ := imgcache.Inspect(data)
	return proto.TranscriptImageResult{Mime: info.Mime, Width: info.Width, Height: info.Height, Bytes: len(data), Size: proto.ImageFull,
		Data: base64.StdEncoding.EncodeToString(data)}, nil
}

// imageError is a failed image read as a protocol error.
func imageError(err error) error {
	switch {
	case errors.Is(err, transcript.ErrNoImage), errors.Is(err, imgcache.ErrNotAllowed), errors.Is(err, imgcache.ErrMissing),
		errors.Is(err, imgcache.ErrNotFile), errors.Is(err, imgcache.ErrNotImage), errors.Is(err, imgcache.ErrTooLarge):
		return &codedError{proto.ErrNotFound, errors.New("the image is not available")}
	case errors.Is(err, transcript.ErrReplaced), errors.Is(err, transcript.ErrGone), errors.Is(err, transcript.ErrClosed):
		return &codedError{proto.ErrInvalidState, fmt.Errorf("the transcript changed; watch again (%v)", err)}
	}
	return &codedError{proto.ErrInternal, errors.New("the image could not be read")}
}

// imageOptions is txImageOptions for the tracker.
func (tr *usageTracker) imageOptions(cwd string) []transcript.Option {
	var opts []transcript.Option
	if tr.cfg.Images != nil {
		opts = append(opts, transcript.WithImages(tr.cfg.Images))
	}
	if cwd != "" {
		opts = append(opts, transcript.WithCwd(cwd))
	}
	return opts
}
