package server

// #118 floor overview: each worker's digest, the task and now lines the
// overview (the lounge's wall screen and its page) shows. The usage tracker
// feeds every Claude and Codex worker's transcript lines to its
// transcript.DigestTracker (on the same tap as the ask, wrap-up, follow-up
// and activity trackers) and hands the hub its view when it changed; the hub
// keeps it per worker and publishes Worker.Digest in a worker.upsert, only
// when the composed lines changed: they move on a prompt, an ai-title, a
// recap, the first step or a model's line, rarely.
//
// The fallbacks (phase 1): the task is Claude's ai-title, else the first
// prompt's first sentence; now is Claude's recent away_summary recap, else
// the worker's terminal title (NowSource "title", no text: the game reads
// Title, which goes out on the hot worker.status path and is never copied
// here).
//
// Phase 2, "Floor overview summaries" (opt-in, internal/digest's Service):
// the configured LLM writes a one-off worker's task line from its first
// prompt (once per prompt hash: again only after a /clear or another agent
// session) and every worker's now line from its last steps
// (transcript.DigestSteps), only for a worker on a floor a client stands on
// (floorViewed: the wall screen and the page are on that floor), one call at
// a time, under the daily cap, its lines cached by input hash. A model's
// line takes the fallback's place (source "llm") while the feature is ready;
// off, not ready or failing, the fallbacks show. Each call is audited with
// its sizes, the model and the endpoint's host, never its text.
//
// #198: the now line follows the recent steps, not the turn ends. It is due
// when the steps (their key, nowKey: never the context line, so a task line
// that changes alone costs nothing) differ from the ones last handed to the
// model (nowTried), at most once per DigestGap per worker and, right after a
// turn ended, once it settled (DigestSettle: the final message is in). So
// the first look at a floor writes the line of a turn still running, a long
// turn is summarized again each gap while it has new steps, and the same
// steps are never sent twice by themselves, whoever views, reconnects or
// polls; steps that come while a call is out are due after it. Of the due
// lines a one-off worker's task line goes first, then the now line of a
// worker with no model line, then the one whose line is the oldest. No
// timer runs for it: each change of a tracker pumps, and a line that waits
// (its gap, its settle, its retry delay) arms a wake for its time.
//
// #174: a failed task line is asked for again, a bounded number of times
// with growing delays (digest.RetryDelay, per prompt hash; no retry on a
// poll), and the digest says what became of the model's line while a
// fallback shows (WorkerDigest.TaskStatus / NowStatus: pending, retrying with
// its time, failed with the reason). The failures are forgiven when the
// config of the feature changes (digest.Service.ConfigKey: the LLM, the
// effort, the budget, a passing test, the switch) and by digest.retry; a
// call that could not go (busy, off, capped) never counts as an attempt.
//
// #198: a failed now line keeps the previous line (or the fallback), and
// NowStatus says it failed or when it is retried, beside a kept model's line
// too (not pending there: a refresh on its way is no news). Its steps are
// not sent again by themselves; newer steps are, once the gap and
// the retry policy's delay after the n-th failure in a row (DigestRetry, as
// a task line's) are over, until the policy says no more (digest.MaxAttempts
// in all). Then nothing goes by itself until a turn ends, the config
// changes, digest.retry (which sends the same steps again at once) or a
// reset; each of those starts the count again.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// Defaults of the summaries' timing.
const (
	// DefaultDigestSettle is how long after a turn ended its now line waits
	// (as the follow-up questions wait): its final message is in.
	DefaultDigestSettle = 2 * time.Second
	// DefaultDigestGap is the least time between two now lines of a worker.
	DefaultDigestGap = 60 * time.Second
)

// The audit row of a summary call.
const (
	digestAuditClient = "bridge"
	digestAuditCmd    = "digest.summarize"
)

// digestUpdate is a worker's tracker's digest now (nil: none: no
// transcript, another harness). epoch names the tracker (a new one for
// another agent session); with the digest's Resets, it is the identity the
// counts and the prompt are of.
type digestUpdate struct {
	id     string
	epoch  int
	digest *transcript.Digest
}

// digestOffered is what the usage tracker last offered of a worker: which
// tracker (and its epoch), at which of its changes.
type digestOffered struct {
	t     *transcript.DigestTracker
	epoch int
	seq   int
}

// offerDigest queues worker w's digest when its tracker changed (usage
// tracker goroutine, after its session's Poll).
func (tr *usageTracker) offerDigest(w usageWorker) {
	var t *transcript.DigestTracker
	if l := tr.lines[w.id]; l != nil {
		t = l.digest
	}
	prev, ok := tr.dgOffered[w.id]
	o := digestOffered{t: t, epoch: prev.epoch}
	if t != nil {
		o.seq = t.Seq()
		if !ok || prev.t != t {
			tr.dgEpoch++
			o.epoch = tr.dgEpoch
		}
	}
	if ok && prev == o {
		return
	}
	tr.dgOffered[w.id] = o
	if !ok && t == nil {
		return
	}
	u := digestUpdate{id: w.id, epoch: o.epoch}
	if t != nil {
		d := t.View()
		u.digest = &d
	}
	tr.dgUps = append(tr.dgUps, u)
}

// digestSeen takes a worker's tracker digest (hub goroutine): a reset (a
// /clear, another agent session: another tracker epoch or reset count, never
// guessed from the counts) drops the model's lines and starts a new
// generation; new steps make a now line due (#198), a turn that ended holds
// it for the settle and starts the count of the now line's failures again.
func (h *Hub) digestSeen(ctx context.Context, u digestUpdate) {
	w := h.workers[u.id]
	if w == nil || u.digest == nil {
		delete(h.dg, u.id)
		delete(h.dgs.ws, u.id)
	}
	if w == nil {
		return
	}
	if u.digest != nil {
		d := u.digest
		l := h.dgs.ws[u.id]
		if l == nil {
			h.dgs.gen++
			l = &dgLLM{gen: h.dgs.gen, epoch: u.epoch, resets: d.Resets}
			h.dgs.ws[u.id] = l
		}
		if l.epoch != u.epoch || l.resets != d.Resets {
			h.dgs.gen++
			*l = dgLLM{gen: h.dgs.gen, epoch: u.epoch, resets: d.Resets, callAt: l.callAt}
		}
		if d.Ended > l.ended {
			l.ended, l.endedAt = d.Ended, h.opts.Now()
			if f := l.nowFail; f != nil {
				// The count starts again; the failure (and its retry) stays
				// until newer steps are tried.
				f.attempts, f.retryAt = 0, l.endedAt
			}
		}
		l.nowKey = nowKey(d)
		h.dg[u.id] = d
	}
	h.refreshDigest(u.id)
	h.pumpDigest(ctx)
}

// refreshDigest publishes a worker's digest when its lines changed (hub
// goroutine).
func (h *Hub) refreshDigest(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	next := h.workerDigest(id, w)
	if reflect.DeepEqual(next, w.Digest) {
		return
	}
	nw := *w
	nw.Digest = next
	h.workers[id] = &nw
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &nw})
}

// workerDigest is the digest a worker shows: the fallbacks, and the model's
// lines in their place while the feature is ready: the task line of a
// one-off worker's current prompt, the now line unless a recap is newer.
// A model's now line kept after a refresh of newer steps failed carries that
// failure (failed, or retrying with its time, #198); never pending: a
// refresh on its way is no news while the line shows.
func (h *Hub) workerDigest(id string, w *proto.Worker) *proto.WorkerDigest {
	d := h.dg[id]
	out := composeDigest(d)
	l := h.dgs.ws[id]
	if out == nil || l == nil || h.dgs.svc == nil || !h.dgs.svc.Ready() {
		return out
	}
	if l.task != "" && l.taskHash == d.PromptHash && oneOff(w) {
		out.Task, out.TaskSource = l.task, proto.DigestLLM
	}
	if l.now != "" && d.Steps > 0 && (d.Recap == "" || d.RecapAt <= l.nowAt) {
		out.Now, out.NowSource, out.NowAt = l.now, proto.DigestLLM, l.nowAt
	}
	if out.TaskSource != proto.DigestLLM && oneOff(w) {
		out.TaskStatus = h.taskStatus(id, l, d)
	}
	if d.Steps > 0 {
		st := h.nowStatus(id, l)
		if out.NowSource != proto.DigestLLM || (st != nil && st.State != proto.LinePending) {
			out.NowStatus = st
		}
	}
	return out
}

// taskStatus is what became of a task line the model is to write (#174):
// nil when it is not awaited (no prompt, no fallback shown in its place).
func (h *Hub) taskStatus(id string, l *dgLLM, d *transcript.Digest) *proto.DigestLineStatus {
	if d.PromptHash == "" || l.taskHash == d.PromptHash {
		return nil
	}
	f := l.taskFail
	if f != nil && f.hash != d.PromptHash {
		f = nil
	}
	attempts := 0
	if f != nil {
		attempts = f.attempts
	}
	fl := h.dgs.flight
	switch {
	case fl != nil && fl.id == id && fl.in.Kind == digest.KindTask && fl.hash == d.PromptHash:
		return &proto.DigestLineStatus{State: proto.LinePending, Attempts: attempts}
	case f != nil && !f.retryAt.IsZero() && !f.retryAt.After(h.opts.Now()) && h.dgs.svc.Capped():
		// Due, but the day's budget is spent: it goes when there is one.
		return &proto.DigestLineStatus{State: proto.LinePending, Reason: "daily_cap", Attempts: f.attempts}
	case f != nil && !f.retryAt.IsZero():
		return &proto.DigestLineStatus{State: proto.LineRetrying, Reason: f.reason, Attempts: f.attempts, RetryAt: f.retryAt.UnixMilli()}
	case f != nil:
		return &proto.DigestLineStatus{State: proto.LineFailed, Reason: f.reason, Attempts: f.attempts}
	case h.dgs.svc.Capped():
		return &proto.DigestLineStatus{State: proto.LinePending, Reason: "daily_cap"}
	}
	return &proto.DigestLineStatus{State: proto.LinePending}
}

// nowStatus is the same for the now line, which is asked for when the steps
// changed (#198): nil without usable steps, or while none is due. It moves
// only with the line's state, never with each step (a worker.upsert each).
func (h *Hub) nowStatus(id string, l *dgLLM) *proto.DigestLineStatus {
	if l.nowKey == "" {
		return nil
	}
	f := l.nowFail
	attempts := 0
	if f != nil {
		attempts = f.attempts
	}
	newer := l.nowKey != l.nowTried
	fl := h.dgs.flight
	switch {
	case fl != nil && fl.id == id && fl.in.Kind == digest.KindNow:
		return &proto.DigestLineStatus{State: proto.LinePending, Attempts: attempts}
	case f != nil && (!newer || f.retryAt.IsZero()):
		// Its steps failed (newer ones wait for them to be tried), or the
		// attempts are used up: nothing goes by itself until a turn ends.
		return &proto.DigestLineStatus{State: proto.LineFailed, Reason: f.reason, Attempts: f.attempts}
	case f != nil && f.retryAt.After(h.opts.Now()):
		at := f.retryAt
		if g := l.callAt.Add(h.opts.DigestGap); !l.callAt.IsZero() && g.After(at) {
			at = g
		}
		return &proto.DigestLineStatus{State: proto.LineRetrying, Reason: f.reason, Attempts: f.attempts, RetryAt: at.UnixMilli()}
	case newer && h.dgs.svc.Capped():
		return &proto.DigestLineStatus{State: proto.LinePending, Reason: "daily_cap", Attempts: attempts}
	case newer:
		return &proto.DigestLineStatus{State: proto.LinePending, Attempts: attempts}
	}
	return nil
}

// nowKey is the key of a tracker's last steps (its now input without the
// context line, #198): "" when they hold nothing to write a line from.
func nowKey(d *transcript.Digest) string {
	in := digest.Input{Kind: digest.KindNow, Steps: nowSteps(d)}
	if digest.Empty(in) {
		return ""
	}
	return digest.Key(in)
}

// oneOff reports whether a worker is a one-off worker (an employee outside
// a write-code run): only theirs has a task line.
func oneOff(w *proto.Worker) bool { return w.Role == "" }

// composeDigest is the lines the overview shows of a tracker's digest: the
// task as soon as it is known (the first prompt is enough), the now line only
// from the first assistant step (no NowSource before it: the game shows no
// now line, not the worker's title, until a turn of it was read).
// Phase 2's lines take their place in workerDigest.
func composeDigest(d *transcript.Digest) *proto.WorkerDigest {
	if d == nil {
		return nil
	}
	out := &proto.WorkerDigest{}
	out.Task, out.TaskSource = d.Task()
	if d.Steps == 0 {
		if out.Task == "" {
			return nil
		}
		return out
	}
	out.NowSource = proto.DigestTitle
	if d.Recap != "" {
		out.Now, out.NowSource, out.NowAt = d.Recap, proto.DigestRecap, d.RecapAt
	}
	return out
}

// ---- #118 phase 2: floor overview summaries ----------------------------

// dgLLM is the model's part of one worker's digest (hub goroutine).
type dgLLM struct {
	// gen is the generation (digestHub.gen's, new at each reset of the
	// tracker): a line written for another one is dropped. epoch and resets
	// are the identity it is of (digestUpdate).
	gen           int
	epoch, resets int
	// task is the model's task line of the prompt taskHash; taskTried the
	// prompt hash last handed to it.
	task, taskHash, taskTried string
	// taskFail is the failed attempts of taskTried's line (#174); nowFail
	// those of the now line in a row since its last success, a turn end (0
	// then, the failure kept) or a retry (#198).
	taskFail, nowFail *dgFail
	// now is the model's now line, written at nowAt (unix ms).
	now   string
	nowAt int64
	// nowKey is the key of the tracker's last steps (nowKey; "": nothing to
	// write a line from), nowTried the one last handed to the model by a call
	// that went (success or failure): the now line is due while they differ
	// (#198).
	nowKey, nowTried string
	// ended is the tracker's Ended last seen, endedAt when it last grew (zero:
	// no turn ended): a now line waits for DigestSettle after it.
	ended   int
	endedAt time.Time
	// callAt is when a now line was last asked for (DigestGap).
	callAt time.Time
}

// dgFail is a line's failed attempts: how many, the last one's reason, and
// when the next goes (zero: none by itself; a now line's: the earliest newer
// steps may go).
type dgFail struct {
	hash     string // the prompt the attempts are of (a task's)
	attempts int
	reason   string
	retryAt  time.Time
}

// digestHub is the hub's part of the feature (hub goroutine).
type digestHub struct {
	svc      *digest.Service
	roles    digest.Roles
	last     string // the view as last published (JSON)
	ws       map[string]*dgLLM
	gen      int // the last dgLLM.gen given
	inflight bool
	// flight is the line the call in flight is for (nil: none).
	flight *digestCand
	wake   time.Time // when a pump is armed (zero: none)
	// cfgKey is the feature's config the failures are of (Service.ConfigKey).
	cfgKey string
}

// digestStore adapts the bridge's store to internal/digest's.
type digestStore struct{ st *store.Store }

func (a digestStore) LoadDigestSettings(ctx context.Context) (digest.Settings, bool, error) {
	s, ok, err := a.st.LoadDigestSettings(ctx)
	return digest.Settings{Enabled: s.Enabled, DailyCap: s.DailyCap, ReasoningEffort: s.ReasoningEffort, MaxTokens: s.MaxTokens,
		CallsDay: s.CallsDay, CallsToday: s.CallsToday}, ok, err
}

func (a digestStore) SaveDigestSettings(ctx context.Context, s digest.Settings) error {
	return a.st.SaveDigestSettings(ctx, storedDigest(s))
}

func (a digestStore) SaveDigestCalls(ctx context.Context, s digest.Settings) error {
	return a.st.SaveDigestCalls(ctx, storedDigest(s))
}

func storedDigest(s digest.Settings) store.DigestSettings {
	return store.DigestSettings{Enabled: s.Enabled, DailyCap: s.DailyCap, ReasoningEffort: s.ReasoningEffort, MaxTokens: s.MaxTokens,
		CallsDay: s.CallsDay, CallsToday: s.CallsToday}
}

func (a digestStore) LoadDigestCache(ctx context.Context, limit int) ([]digest.CacheEntry, error) {
	ls, err := a.st.DigestCache(ctx, limit)
	out := make([]digest.CacheEntry, 0, len(ls))
	for _, l := range ls {
		out = append(out, digest.CacheEntry{Key: l.Key, Line: l.Line, At: l.UsedAt})
	}
	return out, err
}

func (a digestStore) SaveDigestCache(ctx context.Context, e digest.CacheEntry, limit int) error {
	return a.st.SaveDigestLine(ctx, store.DigestLine{Key: e.Key, Line: e.Line, UsedAt: e.At}, limit)
}

// initDigest makes the feature's service (NewHub); none without the AI
// integration: the fallbacks still show.
func (h *Hub) initDigest(ctx context.Context) error {
	h.dgs = digestHub{ws: map[string]*dgLLM{}}
	roles := h.opts.DigestRoles
	if roles == nil && h.opts.AI != nil {
		roles = h.opts.AI
	}
	if roles == nil {
		return nil
	}
	svc, err := digest.New(ctx, digest.Options{Roles: roles, Store: digestStore{h.st}, EnvEnabled: h.opts.DigestEnabled, Now: h.opts.Now})
	if err != nil {
		return fmt.Errorf("floor overview summaries: %w", err)
	}
	h.dgs.svc, h.dgs.roles = svc, roles
	h.dgs.cfgKey = svc.ConfigKey()
	if b, err := json.Marshal(svc.View()); err == nil {
		h.dgs.last = string(b)
	}
	return nil
}

// digestView is the feature's state for the snapshot (nil: no service).
func (h *Hub) digestView() *proto.DigestState {
	if h.dgs.svc == nil {
		return nil
	}
	v := h.dgs.svc.View()
	return &v
}

// publishDigestState emits digest.update when the state changed (hub
// goroutine): a setting, a call counted, a passing test, the LLM's state.
// The model's lines apply only while the feature is ready, so every
// worker's digest is composed again.
func (h *Hub) publishDigestState(ctx context.Context) {
	if h.dgs.svc == nil {
		return
	}
	v := h.dgs.svc.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.dgs.last {
		if h.digestConfigSeen() { // a passing test moves no field of the view
			h.pumpDigest(ctx)
		}
		return
	}
	h.dgs.last = string(b)
	h.seq++
	msg := mustJSON(proto.DigestUpdate{T: proto.EvDigestUpdate, Seq: h.seq, DigestState: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
	for id := range h.dg {
		h.refreshDigest(id)
	}
	h.pumpDigest(ctx)
}

// digestCand is a line the model may write now.
type digestCand struct {
	id string
	in digest.Input
	// hash is a task's prompt hash, a now line's steps key (dgLLM.nowKey).
	hash string
	// at orders the candidates, the earliest first: a task's is zero, a now
	// line's when its model line was written (none: the Unix epoch).
	at time.Time
}

// digestInput is a worker's now input: its last steps, after its ticket's
// title (a run's worker) or its task line (a one-off worker).
func (h *Hub) digestInput(w *proto.Worker, d *transcript.Digest) digest.Input {
	in := digest.Input{Kind: digest.KindNow}
	switch {
	case !oneOff(w) && w.Issue != nil && w.Issue.Title != "":
		in.Context = fmt.Sprintf("Ticket #%d: %s", w.Issue.Number, w.Issue.Title)
	case oneOff(w) && w.Digest != nil && w.Digest.Task != "":
		in.Context = "Task: " + w.Digest.Task
	}
	in.Steps = nowSteps(d)
	return in
}

// nowSteps is a tracker's last steps as the model reads them.
func nowSteps(d *transcript.Digest) []digest.Step {
	var out []digest.Step
	for _, s := range d.Recent {
		st := digest.Step{Texts: s.Texts}
		for _, t := range s.Tools {
			st.Tools = append(st.Tools, digest.Tool{Name: t.Name, Summary: t.Summary})
		}
		out = append(out, st)
	}
	return out
}

// pumpDigest hands the model the line it may write first (hub goroutine):
// the feature ready, no call in flight, the worker on a floor a client
// stands on; a one-off worker's task line first, then the now line of
// steps not yet tried (#198) of a worker with no model line, then of the
// one whose line is the oldest, once the worker's gap, a turn end's settle
// and a failure's retry delay are over. A line that waits for one of those
// wakes it again then. Past the daily cap only a cached line goes; the
// others wait, still due, for the budget (tomorrow's wakes it; a higher cap
// or the toggle pumps).
func (h *Hub) pumpDigest(ctx context.Context) {
	svc := h.dgs.svc
	if svc == nil {
		return
	}
	h.digestConfigSeen()
	if h.dgs.inflight || !svc.Ready() {
		return
	}
	now := h.opts.Now()
	var pick *digestCand
	var wake time.Time
	capped, held := svc.Capped(), false
	better := func(c digestCand) {
		if capped {
			if _, ok := svc.Cached(c.in); !ok {
				held = true
				return
			}
		}
		if pick == nil || c.at.Before(pick.at) || (c.at.Equal(pick.at) && c.id < pick.id) {
			pick = &c
		}
	}
	for id, l := range h.dgs.ws {
		w, d := h.workers[id], h.dg[id]
		if w == nil || d == nil || !h.floorViewed(w.Session) {
			continue
		}
		if oneOff(w) && d.PromptHash != "" && l.taskHash != d.PromptHash {
			switch f := l.taskFail; {
			case l.taskTried != d.PromptHash:
				better(digestCand{id: id, in: digest.Input{Kind: digest.KindTask, Prompt: d.Prompt}, hash: d.PromptHash})
			case f != nil && f.hash == d.PromptHash && !f.retryAt.IsZero():
				// A failed attempt is asked again, once its delay is over.
				if f.retryAt.After(now) {
					if wake.IsZero() || f.retryAt.Before(wake) {
						wake = f.retryAt
					}
				} else {
					if capped {
						h.refreshDigest(id) // due, but the budget is spent: the status says so
					}
					better(digestCand{id: id, in: digest.Input{Kind: digest.KindTask, Prompt: d.Prompt}, hash: d.PromptHash})
				}
			}
		}
		if d.Steps == 0 || l.nowKey == "" || l.nowKey == l.nowTried {
			continue // nothing to write from, or these steps were tried
		}
		var due time.Time
		if f := l.nowFail; f != nil {
			if f.retryAt.IsZero() {
				continue // the attempts are used up: until a turn ends
			}
			due = f.retryAt
		}
		if !l.endedAt.IsZero() && l.endedAt.Add(h.opts.DigestSettle).After(due) {
			due = l.endedAt.Add(h.opts.DigestSettle)
		}
		if !l.callAt.IsZero() && l.callAt.Add(h.opts.DigestGap).After(due) {
			due = l.callAt.Add(h.opts.DigestGap)
		}
		if due.After(now) {
			if wake.IsZero() || due.Before(wake) {
				wake = due
			}
			continue
		}
		if capped {
			h.refreshDigest(id) // due, but the budget may be spent: the status says so
		}
		better(digestCand{id: id, in: h.digestInput(w, d), hash: l.nowKey, at: time.UnixMilli(l.nowAt)})
	}
	if held {
		if day := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, now.Location()); wake.IsZero() || day.Before(wake) {
			wake = day
		}
	}
	if pick == nil {
		h.wakeDigest(ctx, wake)
		return
	}
	c, l := *pick, h.dgs.ws[pick.id]
	gen := l.gen
	if c.in.Kind == digest.KindTask {
		l.taskTried = c.hash
	}
	h.dgs.inflight, h.dgs.flight = true, &c
	h.refreshDigest(c.id) // pending
	model, host := h.llmEndpoint()
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		res, err := svc.Summarize(ctx, c.in)
		if !res.Cached && !errors.Is(err, ai.ErrNotReady) && !errors.Is(err, digest.ErrBusy) && !errors.Is(err, digest.ErrCapped) {
			h.auditDigest(ctx, c, res, err, model, host)
		}
		_ = h.do(ctx, func(ctx context.Context) { h.digestDone(ctx, c, gen, res, err) })
	}()
}

// wakeDigest pumps again at "at" (zero: never), unless a wake comes sooner
// already.
func (h *Hub) wakeDigest(ctx context.Context, at time.Time) {
	if at.IsZero() || (!h.dgs.wake.IsZero() && !h.dgs.wake.After(at)) {
		return
	}
	h.dgs.wake = at
	time.AfterFunc(at.Sub(h.opts.Now()), func() {
		_ = h.do(ctx, func(ctx context.Context) {
			if h.dgs.wake.Equal(at) {
				h.dgs.wake = time.Time{}
			}
			h.pumpDigest(ctx)
		})
	})
}

// digestDone takes a line the model wrote (hub goroutine): shown when the
// worker's tracker did not start over meanwhile. A failure keeps the
// previous line (or the fallback); a call that could not go now (busy, the
// feature switched off, the daily cap reached) is due again: only a call
// made counts its input as tried (a now line's steps: nowTried).
func (h *Hub) digestDone(ctx context.Context, c digestCand, gen int, res digest.Result, err error) {
	h.dgs.inflight, h.dgs.flight = false, nil
	defer h.pumpDigest(ctx)
	defer h.publishDigestState(ctx) // the day's count
	l := h.dgs.ws[c.id]
	if l == nil {
		return
	}
	defer h.refreshDigest(c.id) // pending is over, whatever came of it
	now := h.opts.Now()
	if c.in.Kind == digest.KindNow && !res.Cached && !errors.Is(err, digest.ErrBusy) && !errors.Is(err, ai.ErrNotReady) && !errors.Is(err, digest.ErrCapped) {
		l.callAt = now // a call went: the worker's gap starts
	}
	switch {
	case errors.Is(err, digest.ErrBusy), errors.Is(err, ai.ErrNotReady), errors.Is(err, digest.ErrCapped):
		if l.gen == gen && c.in.Kind == digest.KindTask && l.taskTried == c.hash {
			l.taskTried = ""
		}
		return
	case err != nil:
		reason := digest.Reason(err)
		if errors.Is(err, digest.ErrNoLine) {
			h.log.Debug("no floor overview line", "worker", c.id, "kind", c.in.Kind, "why", err)
		} else if ctx.Err() == nil {
			// A provider's words may echo the input (the transcript): only the
			// error's kind goes to the log, as to the audit.
			h.log.Warn("floor overview summary failed", "worker", c.id, "kind", reason)
		}
		if l.gen == gen {
			if c.in.Kind == digest.KindNow {
				l.nowTried = c.hash
			}
			h.digestFailed(l, c, reason, now)
		}
		return
	}
	if l.gen != gen {
		return
	}
	if c.in.Kind == digest.KindTask {
		l.task, l.taskHash, l.taskFail = res.Line, c.hash, nil
	} else {
		// now_at is when the model wrote the line (#198), a cached one's too.
		at := res.At
		if at.IsZero() {
			at = now
		}
		l.now, l.nowAt, l.nowTried, l.nowFail = res.Line, at.UnixMilli(), c.hash, nil
	}
	h.log.Debug("floor overview line written", "worker", c.id, "kind", c.in.Kind, "cached", res.Cached)
}

// digestFailed records a failed attempt of a line (hub goroutine): a task
// line's is asked again after a growing delay, up to digest.MaxAttempts; a
// now line's steps are not, newer ones go after the same delays, up to the
// same count, then they wait for a turn end (or a retry, #198). The previous
// line, or the fallback, stays.
func (h *Hub) digestFailed(l *dgLLM, c digestCand, reason string, now time.Time) {
	if c.in.Kind == digest.KindNow {
		f := &dgFail{attempts: 1, reason: reason}
		if l.nowFail != nil {
			f.attempts = l.nowFail.attempts + 1
		}
		if d, ok := h.opts.DigestRetry(f.attempts); ok {
			f.retryAt = now.Add(d)
		}
		l.nowFail = f
		return
	}
	f := l.taskFail
	if f == nil || f.hash != c.hash {
		f = &dgFail{hash: c.hash}
	}
	f.attempts++
	f.reason, f.retryAt = reason, time.Time{}
	if d, ok := h.opts.DigestRetry(f.attempts); ok {
		f.retryAt = now.Add(d)
	}
	l.taskFail = f
}

// digestForgive makes the lines whose attempts failed due again (hub
// goroutine): the task line is asked for at once with its attempts counted
// anew, the now line too, from the steps there are (the same ones again
// included), without waiting for the worker's gap. id "" is every worker.
// It returns how many lines.
func (h *Hub) digestForgive(id string) int {
	n := 0
	for wid, l := range h.dgs.ws {
		if id != "" && wid != id {
			continue
		}
		if l.taskFail != nil {
			l.taskFail, l.taskTried = nil, ""
			n++
		}
		if l.nowFail != nil {
			l.nowFail, l.callAt, l.nowTried = nil, time.Time{}, ""
			n++
		}
		h.refreshDigest(wid)
	}
	return n
}

// digestConfigSeen forgives every failure when the feature's config changed
// since the last time (the LLM, the effort, the budget, a passing test, the
// switch): what failed under the old one may work under the new (hub
// goroutine).
func (h *Hub) digestConfigSeen() bool {
	k := h.dgs.svc.ConfigKey()
	if k == h.dgs.cfgKey {
		return false
	}
	h.dgs.cfgKey = k
	h.digestForgive("")
	return true
}

// llmEndpoint is the model and the endpoint's host in use, for the audit
// ("" each when the roles do not say).
func (h *Hub) llmEndpoint() (model, host string) {
	v, ok := h.dgs.roles.(interface{ View() ai.View })
	if !ok {
		return "", ""
	}
	l := v.View().LLM
	if u, err := url.Parse(l.BaseURL); err == nil {
		host = u.Host
	}
	return l.Model, host
}

// auditDigest records a call to the model: the worker, the kind, the sizes
// sent and answered, the model and the endpoint's host, the reasoning effort
// and completion budget the request carried and, when an answer came back,
// its sanitized diagnostics (HTTP status, finish reasons, token counts, the
// content's state and length); never the text, nor any reasoning, and of a
// failure only its kind.
func (h *Hub) auditDigest(ctx context.Context, c digestCand, res digest.Result, err error, model, host string) {
	args := mustJSON(struct {
		ID          string          `json:"id"`
		Kind        string          `json:"kind"`
		SentBytes   int             `json:"sent_bytes"`
		AnswerBytes int             `json:"answer_bytes"`
		Model       string          `json:"model"`
		Host        string          `json:"host"`
		Effort      string          `json:"reasoning_effort,omitempty"`
		MaxTokens   int             `json:"max_tokens,omitempty"`
		Diag        *ai.Diagnostics `json:"diag,omitempty"`
	}{c.id, c.in.Kind, res.Sent, res.Answer, clip(model), clip(host), res.Effort, res.MaxTokens, res.Diag})
	var aerr error
	if err != nil {
		aerr = errors.New(digest.Reason(err))
	}
	actx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if e := h.st.Audit(actx, digestAuditClient, digestAuditCmd, args, aerr); e != nil {
		h.log.Error("audit log write failed", "err", e)
	}
}

// startDigest answers digest.get, digest.set and digest.test. The test's
// calls and the store write run off the hub goroutine; a change is
// published (digest.update) before the ack.
func (h *Hub) startDigest(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.dgs.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no AI integration", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdDigestRetry:
		return h.startDigestRetry(ctx, c, cmd)
	case proto.CmdDigestGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		// The settings window asks as it opens: the model's reasoning is read
		// from its catalog then, when it has not been lately (#174).
		work = func(ctx context.Context) (any, error) {
			svc.Refresh(ctx)
			return svc.View(), nil
		}
	case proto.CmdDigestSet:
		var a proto.DigestSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			if err := svc.Apply(ctx, digest.Update{Enabled: a.Enabled, DailyCap: a.DailyCap, ReasoningEffort: a.ReasoningEffort, MaxTokens: a.MaxTokens}); err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, func() { h.publishDigestState(ctx) })
			return svc.View(), nil
		}
	default: // digest.test
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Test(ctx)
			if err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, func() { h.publishDigestState(ctx) })
			return res, nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// startDigestRetry answers digest.retry on the hub goroutine: the lines of a
// worker (or every worker) whose summary failed are due again, their
// attempts counted anew (#174). Nothing is retried while the feature is not
// ready.
func (h *Hub) startDigestRetry(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.DigestRetryArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	svc := h.dgs.svc
	if a.ID != "" && h.workers[a.ID] == nil {
		return fmt.Errorf("%w: %s", errUnknownWorker, a.ID)
	}
	if !svc.Ready() {
		return &digest.Error{Code: digest.CodeIncomplete, Msg: "floor overview summaries are off or the LLM is not ready: nothing to retry"}
	}
	n := h.digestForgive(a.ID)
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, proto.DigestRetryResult{Retried: n}, nil)
	h.pumpDigest(ctx)
	return nil
}

// digestErrorCode maps an error of internal/digest to its protocol code; ""
// when it is none.
func digestErrorCode(err error) string {
	var de *digest.Error
	if errors.As(err, &de) {
		return de.Code
	}
	return ""
}
