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
// session) and every worker's now line from its last steps, after a turn
// ended and settled (DigestSettle), at most once per DigestGap per worker,
// only for a worker on a floor a client stands on (floorViewed: the wall
// screen and the page are on that floor), one call at a time, under the
// daily cap, its lines cached by input hash. A model's line takes the
// fallback's place (source "llm") while the feature is ready; off, not
// ready or failing, the fallbacks show. Each call is audited with its sizes,
// the model and the endpoint's host, never its text.

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
	// DefaultDigestSettle is how long after a turn ended its now line is
	// written (as the follow-up questions wait).
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
// generation, a turn that ended makes a now line due.
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
		}
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
	return out
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
	// now is the model's now line, written at nowAt (unix ms).
	now   string
	nowAt int64
	// ended is the tracker's Ended last seen; endedAt when a turn last ended
	// with no now line written since (zero: none is due).
	ended   int
	endedAt time.Time
	// callAt is when a now line was last asked for (DigestGap).
	callAt time.Time
}

// digestHub is the hub's part of the feature (hub goroutine).
type digestHub struct {
	svc      *digest.Service
	roles    digest.Roles
	last     string // the view as last published (JSON)
	ws       map[string]*dgLLM
	gen      int // the last dgLLM.gen given
	inflight bool
	wake     time.Time // when a pump is armed (zero: none)
}

// digestStore adapts the bridge's store to internal/digest's.
type digestStore struct{ st *store.Store }

func (a digestStore) LoadDigestSettings(ctx context.Context) (digest.Settings, bool, error) {
	s, ok, err := a.st.LoadDigestSettings(ctx)
	return digest.Settings{Enabled: s.Enabled, DailyCap: s.DailyCap, CallsDay: s.CallsDay, CallsToday: s.CallsToday}, ok, err
}

func (a digestStore) SaveDigestSettings(ctx context.Context, s digest.Settings) error {
	return a.st.SaveDigestSettings(ctx, storedDigest(s))
}

func (a digestStore) SaveDigestCalls(ctx context.Context, s digest.Settings) error {
	return a.st.SaveDigestCalls(ctx, storedDigest(s))
}

func storedDigest(s digest.Settings) store.DigestSettings {
	return store.DigestSettings{Enabled: s.Enabled, DailyCap: s.DailyCap, CallsDay: s.CallsDay, CallsToday: s.CallsToday}
}

func (a digestStore) LoadDigestCache(ctx context.Context, limit int) ([]digest.CacheEntry, error) {
	ls, err := a.st.DigestCache(ctx, limit)
	out := make([]digest.CacheEntry, 0, len(ls))
	for _, l := range ls {
		out = append(out, digest.CacheEntry{Key: l.Key, Line: l.Line})
	}
	return out, err
}

func (a digestStore) SaveDigestCache(ctx context.Context, e digest.CacheEntry, limit int) error {
	return a.st.SaveDigestLine(ctx, store.DigestLine{Key: e.Key, Line: e.Line}, limit)
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
	id   string
	in   digest.Input
	hash string    // a task's prompt hash
	at   time.Time // a now line's turn end (a task's: zero, first)
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
	for _, s := range d.Recent {
		st := digest.Step{Texts: s.Texts}
		for _, t := range s.Tools {
			st.Tools = append(st.Tools, digest.Tool{Name: t.Name, Summary: t.Summary})
		}
		in.Steps = append(in.Steps, st)
	}
	return in
}

// pumpDigest hands the model the line it may write first (hub goroutine):
// the feature ready, no call in flight, the worker on a floor a client
// stands on; a one-off worker's task line first, then the now line of the
// turn that ended longest ago, once settled and the worker's gap is over.
// A line that waits for its settle or gap wakes it again then. Past the
// daily cap only a cached line goes; the others wait, still due, for the
// budget (tomorrow's wakes it; a higher cap or the toggle pumps).
func (h *Hub) pumpDigest(ctx context.Context) {
	svc := h.dgs.svc
	if svc == nil || h.dgs.inflight || !svc.Ready() {
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
		if oneOff(w) && d.PromptHash != "" && l.taskHash != d.PromptHash && l.taskTried != d.PromptHash {
			better(digestCand{id: id, in: digest.Input{Kind: digest.KindTask, Prompt: d.Prompt}, hash: d.PromptHash})
		}
		if l.endedAt.IsZero() || d.Steps == 0 {
			continue
		}
		due := l.endedAt.Add(h.opts.DigestSettle)
		if !l.callAt.IsZero() && l.callAt.Add(h.opts.DigestGap).After(due) {
			due = l.callAt.Add(h.opts.DigestGap)
		}
		if due.After(now) {
			if wake.IsZero() || due.Before(wake) {
				wake = due
			}
			continue
		}
		better(digestCand{id: id, in: h.digestInput(w, d), at: l.endedAt})
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
	gen, endedAt := l.gen, l.endedAt
	if c.in.Kind == digest.KindTask {
		l.taskTried = c.hash
	} else {
		l.endedAt = time.Time{}
	}
	h.dgs.inflight = true
	model, host := h.llmEndpoint()
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		res, err := svc.Summarize(ctx, c.in)
		if !res.Cached && !errors.Is(err, ai.ErrNotReady) && !errors.Is(err, digest.ErrBusy) && !errors.Is(err, digest.ErrCapped) {
			h.auditDigest(ctx, c, res, err, model, host)
		}
		_ = h.do(ctx, func(ctx context.Context) { h.digestDone(ctx, c, gen, endedAt, res, err) })
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
// made counts its input as tried.
func (h *Hub) digestDone(ctx context.Context, c digestCand, gen int, endedAt time.Time, res digest.Result, err error) {
	h.dgs.inflight = false
	defer h.pumpDigest(ctx)
	defer h.publishDigestState(ctx) // the day's count
	l := h.dgs.ws[c.id]
	if l == nil {
		return
	}
	now := h.opts.Now()
	if c.in.Kind == digest.KindNow && !res.Cached && !errors.Is(err, digest.ErrBusy) && !errors.Is(err, ai.ErrNotReady) && !errors.Is(err, digest.ErrCapped) {
		l.callAt = now // a call went: the worker's gap starts
	}
	switch {
	case errors.Is(err, digest.ErrBusy), errors.Is(err, ai.ErrNotReady), errors.Is(err, digest.ErrCapped):
		if l.gen == gen {
			if c.in.Kind == digest.KindTask && l.taskTried == c.hash {
				l.taskTried = ""
			} else if c.in.Kind == digest.KindNow && l.endedAt.IsZero() {
				l.endedAt = endedAt
			}
		}
		return
	case errors.Is(err, digest.ErrNoLine):
		h.log.Debug("no floor overview line", "worker", c.id, "kind", c.in.Kind, "why", err)
		return
	case err != nil:
		// A provider's words may echo the input (the transcript): only the
		// error's kind goes to the log, as to the audit.
		if ctx.Err() == nil {
			kind := string(ai.KindOf(err))
			if kind == "" {
				kind = "failed"
			}
			h.log.Warn("floor overview summary failed", "worker", c.id, "kind", kind)
		}
		return
	}
	if l.gen != gen {
		return
	}
	if c.in.Kind == digest.KindTask {
		l.task, l.taskHash = res.Line, c.hash
	} else {
		l.now, l.nowAt = res.Line, now.UnixMilli()
	}
	h.log.Debug("floor overview line written", "worker", c.id, "kind", c.in.Kind, "cached", res.Cached)
	h.refreshDigest(c.id)
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
// sent and answered, the model and the endpoint's host; never the text,
// and of a failure only its kind.
func (h *Hub) auditDigest(ctx context.Context, c digestCand, res digest.Result, err error, model, host string) {
	args := mustJSON(struct {
		ID          string `json:"id"`
		Kind        string `json:"kind"`
		SentBytes   int    `json:"sent_bytes"`
		AnswerBytes int    `json:"answer_bytes"`
		Model       string `json:"model"`
		Host        string `json:"host"`
	}{c.id, c.in.Kind, res.Sent, res.Answer, clip(model), clip(host)})
	var aerr error
	switch k := ai.KindOf(err); {
	case k != "":
		aerr = errors.New(string(k))
	case errors.Is(err, digest.ErrNoLine):
		aerr = errors.New("no_line")
	case err != nil:
		aerr = errors.New("failed")
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
	case proto.CmdDigestGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	case proto.CmdDigestSet:
		var a proto.DigestSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			if err := svc.Set(ctx, a.Enabled, a.DailyCap); err != nil {
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

// digestErrorCode maps an error of internal/digest to its protocol code; ""
// when it is none.
func digestErrorCode(err error) string {
	var de *digest.Error
	if errors.As(err, &de) {
		return de.Code
	}
	return ""
}
