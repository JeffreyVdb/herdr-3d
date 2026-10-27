package server

// #66 schedule suggestions (part 5 of #61): when an agent's final message
// says a step must wait, offer to schedule it. The feature rides the
// follow-up questions' turn end (followup.go): the same tracker, the same
// settle (FollowupDebounce, herdr no longer `working`), the same message and
// classifier state. runTurn runs the pipeline off the hub goroutine for each
// feature that is ready and has not looked at the message: both → one
// ClassifyMany with both gates, then the follow-up extraction, then the
// schedule's (a slow or failed schedule step never holds the questions
// back); one → its own Classify, the follow-up questions' byte for byte as
// before.
//
// A suggestion becomes Worker.ScheduleSuggestion until it is accepted (a
// schedule.create whose source names it), dismissed
// (worker.dismiss_schedule_suggestion), or the transcript goes on (a prompt,
// another turn, one with the same reply included). Each message looked at is recorded by worker and SHA-256
// (schedsuggest_seen) with its suggestion and why it closed: a restart or a
// re-read never asks the models again, an open suggestion comes back, a
// closed one never does. Nothing is ever scheduled here: accepting the chip
// opens the game's schedule form, and only its save creates a schedule.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/cmdrequest"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/schedsuggest"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// The keys of the two gates in one ClassifyMany.
const (
	gateFollowup = "followup"
	gateSchedule = "schedule"
	gateCommand  = "command_request"
)

// suggestionShown is a worker's open suggestion and the message it is of.
type suggestionShown struct {
	s    *proto.ScheduleSuggestion
	hash string
}

// suggestState is the hub's part of the feature (hub goroutine).
type suggestState struct {
	svc   *schedsuggest.Service
	roles schedsuggest.Roles
	shown map[string]*suggestionShown // worker id → its open suggestion
	// latest is each worker's latest ended turn (its Turn.ID): a result of
	// another is stale, one with the same reply included.
	latest map[string]string
	// running is each worker's messages (hashes) whose extraction runs: the
	// same message offered again meanwhile (a re-read, a newer turn with the
	// same reply behind another) is not asked twice.
	running map[string]map[string]bool
	last    string // the view as last published (JSON)
}

// initScheduleSuggestions makes the feature's service (NewHub); none
// without the AI integration.
func (h *Hub) initScheduleSuggestions(ctx context.Context) error {
	h.ss = suggestState{shown: map[string]*suggestionShown{}, latest: map[string]string{}, running: map[string]map[string]bool{}}
	roles := h.opts.ScheduleSuggestRoles
	if roles == nil && h.opts.FollowupRoles != nil {
		roles = h.opts.FollowupRoles
	}
	if roles == nil && h.opts.AI != nil {
		roles = h.opts.AI
	}
	if roles == nil {
		return nil
	}
	svc, err := schedsuggest.New(ctx, schedsuggest.Options{Roles: roles, Store: h.st, EnvEnabled: h.opts.ScheduleSuggestionsEnabled, Now: h.opts.Now})
	if err != nil {
		return fmt.Errorf("schedule suggestions: %w", err)
	}
	h.ss.svc, h.ss.roles = svc, roles
	if b, err := json.Marshal(svc.View()); err == nil {
		h.ss.last = string(b)
	}
	return nil
}

// scheduleSuggestionsView is the feature's state for the snapshot (nil: no
// service).
func (h *Hub) scheduleSuggestionsView() *proto.ScheduleSuggestions {
	if h.ss.svc == nil {
		return nil
	}
	v := h.ss.svc.View()
	return &v
}

// publishScheduleSuggestions emits schedule_suggestions.update when the
// state changed (hub goroutine): a setting, the zone, a role's state. Like
// packup.update it is not an Event (its fields would collide with
// followups.update's).
func (h *Hub) publishScheduleSuggestions() {
	if h.ss.svc == nil {
		return
	}
	v := h.ss.svc.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.ss.last {
		return
	}
	h.ss.last = string(b)
	h.seq++
	msg := mustJSON(proto.ScheduleSuggestionsUpdate{T: proto.EvScheduleSuggestionsUpdate, Seq: h.seq, ScheduleSuggestions: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// suggestionView is a worker's open suggestion (nil: none).
func (h *Hub) suggestionView(id string) *proto.ScheduleSuggestion {
	if s := h.ss.shown[id]; s != nil {
		return s.s
	}
	return nil
}

// suggestionSkip is why a worker's ended turn is not looked at for a
// schedule suggestion ("": it is).
func (h *Hub) suggestionSkip(w *proto.Worker) string {
	if h.ss.svc == nil || !h.ss.svc.Ready() {
		return "the feature is not ready"
	}
	return turnSkip(w)
}

// suggestionSeen takes a worker's latest ended turn from the tracker (with
// followupSeen): the transcript gone on to a new prompt or turn closes the
// open suggestion. A turn is its Turn.ID: a newer one with the same reply
// closes it too (and gets none: its message was looked at).
func (h *Hub) suggestionSeen(ctx context.Context, u followupUpdate) {
	s := h.ss.shown[u.id]
	if u.turn == nil {
		delete(h.ss.latest, u.id)
		if s != nil && u.moved {
			h.closeSuggestion(ctx, u.id, store.ScheduleSuggestMoved)
		}
		return
	}
	h.ss.latest[u.id] = u.turn.ID
	if s != nil && s.s.ID != u.turn.ID {
		h.closeSuggestion(ctx, u.id, store.ScheduleSuggestMoved) // a newer turn
	}
}

// suggestionWants reports whether the feature may still have to look at a
// worker's message hash (it is ready and shows no suggestion of it): the
// follow-up questions showing theirs is then no reason to skip the turn.
func (h *Hub) suggestionWants(id, hash string) bool {
	if h.ss.svc == nil || !h.ss.svc.Ready() {
		return false
	}
	s := h.ss.shown[id]
	return s == nil || s.hash != hash
}

// suggestionUnseen reports whether the feature never looked at c's message
// and is not looking at it now. Looked at before (a restart, a re-read):
// never again, and an open suggestion of c's turn comes back (one of an
// earlier turn with the same reply closes: the transcript went on while the
// bridge was down).
func (h *Hub) suggestionUnseen(ctx context.Context, id string, c *followupCand) bool {
	if h.ss.running[id][c.turn.Hash] {
		return false
	}
	seen, ok, err := h.st.ScheduleSuggestSeenOf(ctx, id, c.turn.Hash)
	if err != nil {
		h.log.Error("reading schedule suggestion record failed", "worker", id, "err", err)
		return false
	}
	if !ok {
		return true
	}
	var s proto.ScheduleSuggestion
	if cur := h.ss.shown[id]; cur != nil && cur.s.ID == c.turn.ID {
		return false
	}
	if seen.Suggestion == "" || seen.Outcome != "" || json.Unmarshal([]byte(seen.Suggestion), &s) != nil {
		return false
	}
	if s.ID != c.turn.ID {
		if err := h.st.CloseScheduleSuggestSeen(ctx, id, c.turn.Hash, store.ScheduleSuggestMoved); err != nil {
			h.log.Error("closing schedule suggestion record failed", "worker", id, "err", err)
		}
		return false
	}
	h.setSuggestion(id, &s, c.turn.Hash)
	return false
}

// runTurn runs the pipeline on c's message off the hub goroutine (fu: the
// follow-up questions look at it, ss: the schedule suggestions). Each result
// goes to the hub as it comes; c stays pending until the last.
func (h *Hub) runTurn(ctx context.Context, id string, c *followupCand, fu, ss, cr bool) {
	fsvc, ssvc, roles, crReady := h.fu.svc, h.ss.svc, h.ss.roles, h.commandRequestReady()
	text, turnID := c.turn.Text, c.turn.ID
	c.left = 0
	if fu {
		c.left++
	}
	if ss {
		c.left++
		if h.ss.running[id] == nil {
			h.ss.running[id] = map[string]bool{}
		}
		h.ss.running[id][c.turn.Hash] = true
	}
	if cr {
		c.left++
		if h.cr.running[id] == nil {
			h.cr.running[id] = map[string]bool{}
		}
		h.cr.running[id][c.turn.Hash] = true
	}
	fuDone := func(res *followup.Result, err error) {
		_ = h.do(ctx, func(ctx context.Context) { h.followupDone(ctx, id, c, turnID, res, err) })
	}
	ssDone := func(res *schedsuggest.Result, err error) {
		_ = h.do(ctx, func(ctx context.Context) { h.suggestionDone(ctx, id, c, res, err) })
	}
	crDone := func(res crResult) {
		_ = h.do(ctx, func(ctx context.Context) { h.commandRequestDone(ctx, id, c, res) })
	}
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		if !cr && fu && !ss {
			r, e := fsvc.Detect(ctx, text)
			fuDone(r, e)
			return
		}
		if !cr && ss && !fu {
			r, e := ssvc.Detect(ctx, text)
			ssDone(r, e)
			return
		}
		questions := map[string]string{}
		if fu {
			questions[gateFollowup] = followup.GateQuestion
		}
		if ss {
			questions[gateSchedule] = schedsuggest.GateQuestion
		}
		if cr {
			questions[gateCommand] = cmdrequest.GateQuestion
		}
		scores, err := roles.Classifier().ClassifyMany(ctx, schedsuggest.State(text), questions)
		if err != nil {
			if fu {
				fuDone(nil, err)
			}
			if ss {
				ssDone(nil, err)
			}
			if cr {
				crDone(crResult{stage: "classifier", err: err})
			}
			return
		}
		if fu {
			r, e := fsvc.Scored(ctx, text, scores[gateFollowup])
			fuDone(r, e)
		}
		if ss {
			r, e := ssvc.Scored(ctx, text, scores[gateSchedule])
			ssDone(r, e)
		}
		if cr {
			// #213: a reply below the threshold still reaches extraction in
			// the lower band when it holds a shell command it asks for.
			res := crResult{score: scores[gateCommand], decision: cmdrequest.Gate(scores[gateCommand], text)}
			if res.decision.Extract {
				res.extracted = true
				if !crReady {
					res.stage, res.err = "extraction", ai.ErrNotReady
				} else if r, e := cmdrequest.ExtractReport(ctx, roles.LLM(), text); e != nil {
					res.stage, res.err = "extraction", e
				} else {
					res.commands, res.rejected = r.Commands, r
				}
			}
			crDone(res)
		}
	}()
}

// turnPartDone takes one of c's results (hub goroutine): it reports whether
// c is still the worker's pending turn, and drops it once the last came;
// #213: unless the command request asked for a retry, which keeps it
// waiting for that alone.
func (h *Hub) turnPartDone(id string, c *followupCand) bool {
	current := h.fu.pending[id] == c
	c.left--
	if current && c.left <= 0 {
		if c.crRetry {
			c.crRetry, c.crOnly, c.inflight = false, true, false
		} else {
			delete(h.fu.pending, id)
		}
	}
	return current
}

// suggestionDone takes the schedule pipeline's result (hub goroutine).
func (h *Hub) suggestionDone(ctx context.Context, id string, c *followupCand, res *schedsuggest.Result, err error) {
	h.turnPartDone(id, c)
	if r := h.ss.running[id]; r != nil {
		delete(r, c.turn.Hash)
		if len(r) == 0 {
			delete(h.ss.running, id)
		}
	}
	if err != nil {
		// Not recorded: a later look (a restart) may try again. ai's errors
		// never carry a key.
		if !errors.Is(err, ai.ErrNotReady) && ctx.Err() == nil {
			h.log.Warn("schedule suggestion classification failed", "worker", id, "kind", ai.KindOf(err), "err", err)
		}
		return
	}
	now := h.opts.Now()
	var s *proto.ScheduleSuggestion
	if d := res.Draft; d != nil {
		s = &proto.ScheduleSuggestion{ID: c.turn.ID, Message: c.turn.Message, DueAt: d.DueAt.UnixMilli(), Title: d.Title,
			DraftPrompt: d.Prompt, Score: res.Score, At: now.UnixMilli()}
	} else if res.Flag {
		h.log.Info("no schedule suggestion", "worker", id, "why", res.Why, "efforts", res.Efforts)
	}
	// Superseded meanwhile (another turn, a prompt, the worker gone or
	// asking): the message was looked at, and nothing is shown.
	w := h.workers[id]
	stale := h.ss.latest[id] != c.turn.ID || w == nil || h.suggestionSkip(w) != ""
	var raw, outcome string
	if s != nil {
		b, _ := json.Marshal(s)
		raw = string(b)
		if stale {
			outcome = store.ScheduleSuggestStale
		}
	}
	if err := h.st.RecordScheduleSuggestSeen(ctx, id, c.turn.Hash, raw, outcome); err != nil {
		h.log.Error("recording schedule suggestion failed", "worker", id, "err", err)
	}
	h.log.Info("schedule suggestion looked at", "worker", id, "score", res.Score, "suggested", s != nil, "stale", stale)
	if s != nil && !stale {
		h.setSuggestion(id, s, c.turn.Hash)
	}
}

// setSuggestion shows a worker's suggestion (worker.upsert).
func (h *Hub) setSuggestion(id string, s *proto.ScheduleSuggestion, hash string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	h.ss.shown[id] = &suggestionShown{s: s, hash: hash}
	next := *w
	next.ScheduleSuggestion = s
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// closeSuggestion closes a worker's open suggestion for good (its record
// says why) and publishes the worker (hub goroutine).
func (h *Hub) closeSuggestion(ctx context.Context, id, outcome string) {
	if !h.dropSuggestion(ctx, id, outcome) {
		return
	}
	if w := h.workers[id]; w != nil && w.ScheduleSuggestion != nil {
		next := *w
		next.ScheduleSuggestion = nil
		h.workers[id] = &next
		h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
	}
}

// dropSuggestion forgets a worker's open suggestion, recording why it
// closed; it reports whether one was shown. The caller publishes the worker
// (a worker gone has nothing to publish).
func (h *Hub) dropSuggestion(ctx context.Context, id, outcome string) bool {
	if outcome == store.ScheduleSuggestGone {
		delete(h.ss.latest, id)
		delete(h.ss.running, id)
	}
	s := h.ss.shown[id]
	if s == nil {
		return false
	}
	delete(h.ss.shown, id)
	if err := h.st.CloseScheduleSuggestSeen(ctx, id, s.hash, outcome); err != nil {
		h.log.Error("closing schedule suggestion record failed", "worker", id, "err", err)
	}
	h.log.Info("schedule suggestion closed", "worker", id, "outcome", outcome)
	return true
}

// acceptSuggestion closes the open suggestion a schedule was created from
// (hub goroutine, after schedule.create stored it): its source names the
// worker and the message the suggestion is of. A schedule from the plain
// "Schedule follow-up…" or of another message leaves it.
func (h *Hub) acceptSuggestion(ctx context.Context, src *proto.ScheduleSource) {
	if src == nil || src.Kind != proto.ScheduleFromSuggestion {
		return
	}
	if s := h.ss.shown[src.Worker]; s != nil && s.s.Message == src.Message {
		h.closeSuggestion(ctx, src.Worker, store.ScheduleSuggestAccepted)
	}
}

// startScheduleSuggestions answers schedule_suggestions.get, .set and .zone.
// The store write runs off the hub goroutine; a change is published
// (schedule_suggestions.update) before the ack.
func (h *Hub) startScheduleSuggestions(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.ss.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no AI integration", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdScheduleSuggestionsGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	case proto.CmdScheduleSuggestionsSet:
		var a proto.ScheduleSuggestionsSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			if err := svc.Set(ctx, a.Enabled, a.Threshold); err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishScheduleSuggestions)
			return svc.View(), nil
		}
	default: // schedule_suggestions.zone
		var a proto.ScheduleSuggestionsZoneArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			changed, err := svc.SetZone(ctx, a.Zone)
			if err != nil {
				return nil, err
			}
			if changed {
				_ = h.doWait(ctx, h.publishScheduleSuggestions)
			}
			return svc.View(), nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// startDismissScheduleSuggestion answers worker.dismiss_schedule_suggestion:
// the suggestion named closes for good (stale when the worker has none, or
// another).
func (h *Hub) startDismissScheduleSuggestion(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerDismissScheduleSuggestionArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if h.workers[a.ID] == nil {
		return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
	}
	if s := h.ss.shown[a.ID]; s == nil || s.s.ID != a.Suggestion {
		return fmt.Errorf("%w: the worker has no open schedule suggestion %q (accepted, dismissed, or the transcript went on)", errStale, clip(a.Suggestion))
	}
	h.closeSuggestion(ctx, a.ID, store.ScheduleSuggestDismissed)
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

// scheduleSuggestErrorCode maps an error of internal/schedsuggest to its
// protocol code; "" when it is none.
func scheduleSuggestErrorCode(err error) string {
	var e *schedsuggest.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}
