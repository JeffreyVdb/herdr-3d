package server

// #98 activity: what each worker's agent is doing right now. The usage
// tracker feeds every Claude and Codex worker's transcript lines to its
// transcript.ActivityTracker (on the same tap as the ask, wrap-up and
// follow-up trackers) and hands the hub its view each round; the hub picks
// the part herdr's status calls for (working: the turn's activity; idle or
// done: waiting on background tasks; anything else: none), applies the
// model's cached answer to a command the rules could not place, and
// publishes Worker.Activity: in the worker's upsert when its status changes,
// else as a worker.activity event, only on a change and at most twice a
// second per worker.
//
// "Classify unknown commands" (opt-in, internal/activity's Service): a
// command the rules could not place is asked about once, off the hub
// goroutine, one call at a time, only while the feature is ready and only
// for a worker on a floor a client stands on; a candidate that is no longer
// current when the slot frees is never asked about, and an answer is shown
// only if its call is still current.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/activity"
	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/imgcache"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// DefaultActivityThrottle is the least time between two worker.activity
// events of one worker (at most 2 a second).
const DefaultActivityThrottle = 500 * time.Millisecond

// maxActivityImageReads is how many activity thumbnails are read at once.
const maxActivityImageReads = 8

// activityUpdate is a worker's tracker's view now (nil: none: no transcript,
// another harness, another agent session).
type activityUpdate struct {
	id   string
	view *transcript.ActivityView
}

// activityOffered is what the usage tracker last offered of a worker.
type activityOffered struct {
	working, idle *activity.Activity
	cand          *transcript.ActivityCandidate
	none          bool
	turnAt        int64
}

// offerActivity queues worker w's activity view when it changed (usage
// tracker goroutine, after its session's Poll).
func (tr *usageTracker) offerActivity(w usageWorker, now time.Time) {
	var v *transcript.ActivityView
	if l := tr.lines[w.id]; l != nil && l.activity != nil {
		view := l.activity.View(now)
		v = &view
	}
	o := activityOffered{none: v == nil}
	if v != nil {
		o.working, o.idle, o.cand, o.turnAt = v.Working, v.Idle, v.Candidate, v.TurnAt
	}
	prev, ok := tr.actOffered[w.id]
	if ok && reflect.DeepEqual(prev, o) {
		return
	}
	tr.actOffered[w.id] = o
	if !ok && v == nil {
		return
	}
	tr.actUps = append(tr.actUps, activityUpdate{id: w.id, view: v})
}

// actWorker is the hub's part of one worker's activity.
type actWorker struct {
	view   transcript.ActivityView
	candAt time.Time // when its current candidate came
	tried  string    // the candidate item last handed to the model
	pubAt  time.Time // when its activity last went out
	flush  bool      // a change waits for the throttle
}

// activityHub is the hub's part of the feature (hub goroutine).
type activityHub struct {
	svc      *activity.Service
	last     string // the state as last published (JSON)
	ws       map[string]*actWorker
	inflight bool
	// idleAt is when each worker's last idle or done began (unix ms): a
	// turn that opened before is over.
	idleAt map[string]int64
	// views is the floor each connection stands on (its board.watch, sent
	// for the floor you are on whether or not it has a board).
	views map[*Client]string
	reads chan struct{}
}

// activityStore adapts the bridge's store to internal/activity's.
type activityStore struct{ st *store.Store }

func (a activityStore) LoadActivitySettings(ctx context.Context) (activity.Settings, bool, error) {
	s, ok, err := a.st.LoadActivitySettings(ctx)
	return activity.Settings{ModelEnabled: s.ModelEnabled, Threshold: s.Threshold, Margin: s.Margin, DailyCap: s.DailyCap,
		CallsDay: s.CallsDay, CallsToday: s.CallsToday}, ok, err
}

func (a activityStore) SaveActivitySettings(ctx context.Context, s activity.Settings) error {
	return a.st.SaveActivitySettings(ctx, store.ActivitySettings{ModelEnabled: s.ModelEnabled, Threshold: s.Threshold,
		Margin: s.Margin, DailyCap: s.DailyCap, CallsDay: s.CallsDay, CallsToday: s.CallsToday})
}

func (a activityStore) LoadActivityCache(ctx context.Context, limit int) ([]activity.CacheEntry, error) {
	as, err := a.st.ActivityCache(ctx, limit)
	out := make([]activity.CacheEntry, 0, len(as))
	for _, x := range as {
		out = append(out, activity.CacheEntry{Key: x.Key, Kind: activity.Kind(x.Kind)})
	}
	return out, err
}

func (a activityStore) SaveActivityCache(ctx context.Context, e activity.CacheEntry, limit int) error {
	return a.st.SaveActivityAnswer(ctx, store.ActivityAnswer{Key: e.Key, Kind: string(e.Kind)}, limit)
}

// initActivity makes the model's service (NewHub); none without the AI
// integration: the rules still run.
func (h *Hub) initActivity(ctx context.Context) error {
	h.act = activityHub{ws: map[string]*actWorker{}, views: map[*Client]string{}, idleAt: map[string]int64{},
		reads: make(chan struct{}, maxActivityImageReads)}
	roles := h.opts.ActivityRoles
	if roles == nil && h.opts.AI != nil {
		roles = h.opts.AI
	}
	if roles == nil {
		return nil
	}
	svc, err := activity.NewService(ctx, activity.Options{Roles: roles, Store: activityStore{h.st}, EnvModel: h.opts.ActivityModel,
		Now: h.opts.Now})
	if err != nil {
		return fmt.Errorf("activity: %w", err)
	}
	h.act.svc = svc
	if b, err := json.Marshal(svc.View()); err == nil {
		h.act.last = string(b)
	}
	return nil
}

// activityView is the feature's state for the snapshot (nil: no service).
func (h *Hub) activityView() *proto.ActivityState {
	if h.act.svc == nil {
		return nil
	}
	v := h.act.svc.View()
	return &v
}

// publishActivityState emits activity.update when the state changed (hub
// goroutine): a setting, a call counted, the classifier's state. A change
// may change what the workers show (the model's answers apply only while
// the feature is on and ready) and what may be asked.
func (h *Hub) publishActivityState(ctx context.Context) {
	if h.act.svc == nil {
		return
	}
	v := h.act.svc.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.act.last {
		return
	}
	h.act.last = string(b)
	h.seq++
	msg := mustJSON(proto.ActivityUpdate{T: proto.EvActivityUpdate, Seq: h.seq, ActivityState: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
	for id := range h.act.ws {
		h.publishActivity(id)
	}
	h.pumpActivity(ctx)
}

// activitySeen takes a worker's tracker view (hub goroutine).
func (h *Hub) activitySeen(u activityUpdate) {
	if h.workers[u.id] == nil {
		delete(h.act.ws, u.id)
		return
	}
	aw := h.act.ws[u.id]
	if u.view == nil {
		if aw != nil {
			aw.view = transcript.ActivityView{}
			h.publishActivity(u.id)
			delete(h.act.ws, u.id)
		}
		return
	}
	if aw == nil {
		aw = &actWorker{}
		h.act.ws[u.id] = aw
	}
	if c, old := u.view.Candidate, aw.view.Candidate; c != nil && (old == nil || old.Item != c.Item) {
		aw.candAt = h.opts.Now()
	}
	aw.view = *u.view
	h.publishActivity(u.id)
}

// composeActivity is a worker's activity for its status: the turn's while
// working (the model's cached answer over Working for a command the rules
// could not place), waiting on background tasks while idle or done, else
// none.
func (h *Hub) composeActivity(id string, w *proto.Worker) *proto.Activity {
	aw := h.act.ws[id]
	if aw == nil || w == nil {
		return nil
	}
	var a *activity.Activity
	switch w.Status {
	case statusWorking:
		a = aw.view.Working
		if aw.view.TurnAt < h.act.idleAt[id] {
			// herdr is ahead of the tracker: a new turn, nothing of it read
			// yet (the previous turn's tool must not show).
			a = &activity.Activity{Kind: activity.KindThinking, Since: w.StatusSince, Source: activity.SourceDerived}
		}
	case statusIdle, statusDone:
		a = aw.view.Idle
	}
	if a == nil {
		return nil
	}
	out := *a
	if c := aw.view.Candidate; w.Status == statusWorking && c != nil && h.act.svc != nil && h.act.svc.Applies() {
		if k, ok := h.act.svc.Cached(c.Tool, c.Command); ok && k != activity.KindWorking {
			out.Kind, out.Source = k, activity.SourceModel
		}
	}
	return &out
}

// publishActivity sends a worker's activity when it changed (hub
// goroutine): a worker.activity event, held back to the throttle.
func (h *Hub) publishActivity(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	next := h.composeActivity(id, w)
	if reflect.DeepEqual(next, w.Activity) {
		return
	}
	aw := h.act.ws[id]
	now := h.opts.Now()
	if aw != nil {
		if wait := h.opts.ActivityThrottle - now.Sub(aw.pubAt); wait > 0 && !now.Before(aw.pubAt) {
			if !aw.flush {
				aw.flush = true
				time.AfterFunc(wait, func() {
					_ = h.do(context.Background(), func(context.Context) {
						if aw := h.act.ws[id]; aw != nil {
							aw.flush = false
						}
						h.publishActivity(id)
					})
				})
			}
			return
		}
		aw.pubAt = now
	}
	nw := *w
	nw.Activity = next
	h.workers[id] = &nw
	h.emit(proto.Event{T: proto.EvWorkerActivity, ID: id, Session: w.Session, WorkspaceID: w.WorkspaceID, Activity: next})
}

// activityFor is a worker's activity in its upsert (syncWorkers: its status
// may have changed): it goes out with the worker, and counts as published.
func (h *Hub) activityFor(id string, w *proto.Worker, prev *proto.Worker) *proto.Activity {
	if w.Status == statusIdle || w.Status == statusDone {
		h.act.idleAt[id] = w.StatusSince
	}
	a := h.composeActivity(id, w)
	if prev == nil || !reflect.DeepEqual(a, prev.Activity) {
		if aw := h.act.ws[id]; aw != nil {
			aw.pubAt = h.opts.Now()
		}
	}
	return a
}

// floorViewed reports whether a client stands on a floor: its board.watch,
// or a laptop or transcript of one of its workers.
func (h *Hub) floorViewed(session string) bool {
	for c := range h.clients {
		if h.viewing(c, session) {
			return true
		}
	}
	return false
}

// viewing reports whether connection c stands on a floor.
func (h *Hub) viewing(c *Client, session string) bool {
	if h.act.views[c] == session {
		return true
	}
	on := func(id string) bool { w := h.workers[id]; return w != nil && w.Session == session }
	h.term.mu.Lock()
	for id := range h.term.byC[c] {
		if on(id) {
			h.term.mu.Unlock()
			return true
		}
	}
	h.term.mu.Unlock()
	h.tx.mu.Lock()
	defer h.tx.mu.Unlock()
	for id := range h.tx.byC[c] {
		if on(id) {
			return true
		}
	}
	return false
}

// standsOn records the floor a connection stands on ("": none).
func (h *Hub) standsOn(ctx context.Context, c *Client, session string) {
	if session == "" {
		delete(h.act.views, c)
		return
	}
	h.act.views[c] = session
	h.pumpActivity(ctx)
}

// pumpActivity hands the model the oldest candidate it may ask about (hub
// goroutine): the feature ready, no call in flight, the worker working on a
// floor a client stands on, its command neither answered nor asked about.
func (h *Hub) pumpActivity(ctx context.Context) {
	svc := h.act.svc
	if svc == nil || h.act.inflight || !svc.Ready() {
		return
	}
	pick := ""
	var at time.Time
	for id, aw := range h.act.ws {
		c := aw.view.Candidate
		w := h.workers[id]
		if c == nil || w == nil || w.Status != statusWorking || aw.tried == c.Item || !h.floorViewed(w.Session) {
			continue
		}
		if _, ok := svc.Cached(c.Tool, c.Command); ok {
			continue
		}
		if pick == "" || aw.candAt.Before(at) || (aw.candAt.Equal(at) && id < pick) {
			pick, at = id, aw.candAt
		}
	}
	if pick == "" {
		return
	}
	aw := h.act.ws[pick]
	cand := *aw.view.Candidate
	aw.tried = cand.Item
	h.act.inflight = true
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		kind, err := svc.Classify(ctx, cand.Tool, cand.Command)
		_ = h.do(ctx, func(ctx context.Context) {
			h.act.inflight = false
			switch {
			case err == nil:
				h.log.Debug("command classified", "worker", pick, "kind", kind)
			case !errors.Is(err, ai.ErrNotReady) && !errors.Is(err, activity.ErrBusy) && ctx.Err() == nil:
				// ai's errors never carry a key, nor the command.
				h.log.Warn("command classification failed", "worker", pick, "kind", ai.KindOf(err), "err", err)
			}
			// Shown only while the call is current: publishActivity applies
			// the cache to each worker's current candidate.
			if aw := h.act.ws[pick]; aw != nil && aw.view.Candidate != nil && aw.view.Candidate.Item == cand.Item {
				h.publishActivity(pick)
			}
			h.publishActivityState(ctx)
			h.pumpActivity(ctx)
		})
	}()
}

// startActivity answers activity.get and activity.set. The store write runs
// off the hub goroutine; a change is published (activity.update) before
// the ack.
func (h *Hub) startActivity(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.act.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no AI integration", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdActivityGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	default: // activity.set
		var a proto.ActivitySetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			if err := svc.Set(ctx, a.ModelEnabled, a.Threshold, a.Margin, a.DailyCap); err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, func() { h.publishActivityState(ctx) })
			return svc.View(), nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// activityErrorCode maps an error of internal/activity to its protocol code;
// "" when it is none.
func activityErrorCode(err error) string {
	var ae *activity.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

// activityImage is the reader of a worker's current activity image when
// connection c may have it: the hash is the one Worker.Activity shows now,
// and c stands on the worker's floor (hub goroutine).
func (h *Hub) activityImage(c *Client, id, hash string) func() ([]byte, error) {
	w, aw := h.workers[id], h.act.ws[id]
	if w == nil || aw == nil || w.Activity == nil || w.Activity.Image == nil || w.Activity.Image.Hash != hash {
		return nil
	}
	if cur := aw.view.Working; cur == nil || cur.Image == nil || cur.Image.Hash != hash || aw.view.Image == nil {
		return nil
	}
	if !h.viewing(c, w.Session) {
		return nil
	}
	return aw.view.Image
}

// readActivityImage answers transcript.image for a worker's activity image:
// its thumbnail, off the hub goroutine.
func (h *Hub) readActivityImage(ctx context.Context, c *Client, cmd proto.Command, hash string, load func() ([]byte, error)) {
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		var data any
		var err error
		select {
		case h.act.reads <- struct{}{}:
			var t imgcache.Thumb
			if h.opts.Usage != nil && h.opts.Usage.Images != nil && h.opts.Usage.Images.Cache != nil {
				t, err = h.opts.Usage.Images.Cache.Thumb(hash, load)
			} else if b, lerr := load(); lerr != nil {
				err = lerr
			} else {
				t, err = imgcache.MakeThumb(b)
			}
			<-h.act.reads
			if err != nil {
				err = imageError(err)
			} else {
				data = proto.TranscriptImageResult{Mime: t.Mime, Width: t.Width, Height: t.Height, Bytes: len(t.Data),
					Size: proto.ImageThumb, Data: base64.StdEncoding.EncodeToString(t.Data)}
			}
		default:
			err = &codedError{proto.ErrBusy, fmt.Errorf("already reading %d activity images", maxActivityImageReads)}
		}
		if derr := h.doWait(ctx, func() { h.reply(c, cmd, data, err) }); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}()
}
