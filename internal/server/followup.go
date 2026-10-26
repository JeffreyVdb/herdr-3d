package server

// #90 follow-up questions: the open questions of an agent's final message.
// The usage tracker's FollowupTracker (fed the same lines as the ask and
// wrap-up trackers) says when a worker's turn ended and with which message;
// the hub waits for the turn to settle (FollowupDebounce, herdr no longer
// `working`), skips what other paths cover or the feature leaves out, and
// runs internal/followup's pipeline off the hub goroutine. A flagged message
// becomes Worker.Followup until it is answered (worker.answer_followup, one
// prompt on the worker's input lane), dismissed, the worker is prompted or
// typed into, herdr sees it `working` again, or it is gone.
//
// Each message looked at is recorded by worker and SHA-256 (followup_seen),
// with its follow-up while that is open: a restart or a re-read of the
// transcript never classifies the same message again, and an open one comes
// back as it was. #60: the message itself stays in memory with its open
// follow-up (from the turn, also after a restart), for worker.followup_message
// and worker.retry_followup, which extracts a fallback's questions again on
// request: never by itself.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/followup"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// DefaultFollowupDebounce is how long an ended turn and herdr's not-working
// status must hold before the message is looked at.
const DefaultFollowupDebounce = 2 * time.Second

// followupUpdate is a worker's latest ended turn (nil: none now: a turn
// runs, or a prompt came), from the usage tracker. moved: the same
// transcript went on (not another tracker: another agent session, or none).
type followupUpdate struct {
	id     string
	turn   *transcript.Turn
	moved  bool
	source commandRequestSource
}

// followupOffered is what the tracker last offered of a worker.
type followupOffered struct {
	t      *transcript.FollowupTracker
	seq    int
	source commandRequestSource
}

// offerFollowup queues worker w's latest ended turn when it changed (usage
// tracker goroutine, after its session's Poll).
func (tr *usageTracker) offerFollowup(w usageWorker) {
	var ft *transcript.FollowupTracker
	if l := tr.lines[w.id]; l != nil {
		ft = l.followup
	}
	o := followupOffered{t: ft, source: commandRequestSource{Agent: w.agent, Session: w.session}}
	var turn *transcript.Turn
	if ft != nil {
		o.seq, turn = ft.Seq(), ft.Turn()
	}
	prev, ok := tr.fuOffered[w.id]
	if ok && prev == o {
		return
	}
	tr.fuOffered[w.id] = o
	if !ok && turn == nil {
		return
	}
	if turn != nil {
		c := *turn
		turn = &c
	}
	tr.followUps = append(tr.followUps, followupUpdate{id: w.id, turn: turn, moved: ok && prev.t == ft && ft != nil, source: o.source})
}

// followupCand is a worker's ended turn waiting to be looked at.
type followupCand struct {
	turn     transcript.Turn
	source   commandRequestSource
	at       time.Time // when the hub got it
	inflight bool      // the pipeline runs on it
	// left counts the pipeline's results still to come (#66: the follow-up
	// questions' and the schedule suggestion's): it waits in pending until
	// the last.
	left int
}

// followupShown is a worker's open follow-up and the message it is of.
type followupShown struct {
	f    *proto.Followup
	hash string
	text string // the message (#60)
	// retrying: a worker.retry_followup runs on it.
	retrying bool
}

// MaxFollowupRetries bounds worker.retry_followup per follow-up (#60).
const MaxFollowupRetries = 3

// followupState is the hub's part of the feature (hub goroutine).
type followupState struct {
	svc     *followup.Service
	pending map[string]*followupCand  // worker id → its ended turn
	shown   map[string]*followupShown // worker id → its open follow-up
	last    string                    // the view as last published (JSON)
}

// initFollowups makes the feature's service (NewHub); none without the AI
// integration.
func (h *Hub) initFollowups(ctx context.Context) error {
	h.fu = followupState{pending: map[string]*followupCand{}, shown: map[string]*followupShown{}}
	roles := h.opts.FollowupRoles
	if roles == nil && h.opts.AI != nil {
		roles = h.opts.AI
	}
	if roles == nil {
		return nil
	}
	svc, err := followup.New(ctx, followup.Options{Roles: roles, Store: h.st, EnvEnabled: h.opts.FollowupsEnabled, Now: h.opts.Now})
	if err != nil {
		return fmt.Errorf("follow-up questions: %w", err)
	}
	h.fu.svc = svc
	if b, err := json.Marshal(svc.View()); err == nil {
		h.fu.last = string(b)
	}
	return nil
}

// followupsView is the feature's state for the snapshot (nil: no service).
func (h *Hub) followupsView() *proto.Followups {
	if h.fu.svc == nil {
		return nil
	}
	v := h.fu.svc.View()
	return &v
}

// publishFollowups emits followups.update when the state changed (hub
// goroutine): a setting, a passing test, a role's state.
func (h *Hub) publishFollowups() {
	if h.fu.svc == nil {
		return
	}
	v := h.fu.svc.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.fu.last {
		return
	}
	h.fu.last = string(b)
	h.emit(proto.Event{T: proto.EvFollowupsUpdate, Followups: &v})
}

// followupView is a worker's open follow-up (nil: none).
func (h *Hub) followupView(id string) *proto.Followup {
	if s := h.fu.shown[id]; s != nil {
		return s.f
	}
	return nil
}

// followupSeen takes a worker's latest ended turn from the tracker. The
// transcript gone on to a new prompt or turn (however short, herdr may never
// have seen it working) makes the open follow-up moot: it is cleared, so its
// turn_id is stale and a newer message is looked at in its place.
func (h *Hub) followupSeen(ctx context.Context, u followupUpdate) {
	if !h.commandRequestSourceCurrent(u.id, u.source) {
		return
	}
	h.suggestionSeen(ctx, u) // #66: the same turn end
	h.commandRequestSeen(ctx, u)
	s := h.fu.shown[u.id]
	if u.turn == nil {
		delete(h.fu.pending, u.id) // a prompt or a new turn: nothing to look at
		if s != nil && u.moved {
			h.clearFollowup(ctx, u.id)
		}
		return
	}
	if s != nil && s.hash == u.turn.Hash && !h.suggestionWants(u.id, u.turn.Hash) && !h.commandRequestWants(u.id, u.turn.Hash) {
		return // shown already
	}
	if s != nil && s.hash != u.turn.Hash {
		h.clearFollowup(ctx, u.id) // a newer turn's message
	}
	h.fu.pending[u.id] = &followupCand{turn: *u.turn, source: u.source, at: h.opts.Now()}
}

// sweepFollowups looks at the ended turns that settled (hub goroutine, every
// usage round while any wait). It reports whether any still wait.
func (h *Hub) sweepFollowups(ctx context.Context) bool {
	for id, c := range h.fu.pending {
		if !c.inflight && !h.considerFollowup(ctx, id, c) {
			delete(h.fu.pending, id)
		}
	}
	return len(h.fu.pending) > 0
}

// followupSkip is why a worker's ended turn is not looked at for follow-up
// questions ("": it is).
func (h *Hub) followupSkip(w *proto.Worker) string {
	if h.fu.svc == nil || !h.fu.svc.Ready() {
		return "the feature is not ready"
	}
	return turnSkip(w)
}

// turnSkip is why a worker's ended turn is not looked at by any feature on
// it ("": it is): what other paths cover, freelancers, other harnesses.
func turnSkip(w *proto.Worker) string {
	harness := w.Harness
	if harness == "" {
		harness = w.AgentKind
	}
	switch {
	case w.Ask != nil:
		return "an ask is pending (#57)"
	case w.Status == statusBlocked:
		return "the worker is blocked (its question)"
	case world.Freelancer(w.Role):
		return "a freelancer"
	case harness != transcript.Claude && harness != transcript.Codex:
		return "not a Claude or Codex agent"
	}
	return ""
}

// considerFollowup decides on a worker's ended turn: keep waiting (true),
// or drop it (false) once skipped, restored or handed to the pipeline (it
// is then kept, inflight, until the pipeline is done).
// #66: the schedule suggestions look at the same ended turn: the pipeline
// runs for each feature that is ready and has not looked at the message yet
// (runTurn).
func (h *Hub) considerFollowup(ctx context.Context, id string, c *followupCand) bool {
	w := h.workers[id]
	if w == nil || strings.TrimSpace(c.turn.Text) == "" {
		return false
	}
	fu, ss, cr := h.followupSkip(w) == "", h.suggestionSkip(w) == "", h.commandRequestSkip(w) == ""
	if !fu && !ss && !cr {
		return false
	}
	now := h.opts.Now()
	debounce := h.opts.FollowupDebounce
	if w.Status == statusWorking || now.Sub(c.at) < debounce || now.UnixMilli()-w.StatusSince < debounce.Milliseconds() {
		return true
	}
	if fu {
		fu = h.followupUnseen(ctx, id, c)
	}
	if ss {
		ss = h.suggestionUnseen(ctx, id, c)
	}
	if cr {
		cr = h.commandRequestUnseen(ctx, id, c)
	}
	if !fu && !ss && !cr {
		return false
	}
	c.inflight = true
	h.runTurn(ctx, id, c, fu, ss, cr)
	return true
}

// followupUnseen reports whether the follow-up questions never looked at
// c's message. Looked at before (a restart, a re-read): never again, and an
// open follow-up comes back.
func (h *Hub) followupUnseen(ctx context.Context, id string, c *followupCand) bool {
	seen, ok, err := h.st.FollowupSeenOf(ctx, id, c.turn.Hash)
	if err != nil {
		h.log.Error("reading follow-up record failed", "worker", id, "err", err)
		return false
	}
	if !ok {
		return true
	}
	var f proto.Followup
	if s := h.fu.shown[id]; s != nil && s.hash == c.turn.Hash {
		return false // shown already
	}
	if seen.Followup != "" && !seen.Cleared && json.Unmarshal([]byte(seen.Followup), &f) == nil {
		h.setFollowup(id, &f, c.turn.Hash, c.turn.Text)
	}
	return false
}

// followupDone takes the pipeline's result (hub goroutine).
func (h *Hub) followupDone(ctx context.Context, id string, c *followupCand, turnID string, res *followup.Result, err error) {
	current := h.turnPartDone(id, c)
	if err != nil {
		// Not recorded: a later look (a restart) may try again. ai's errors
		// never carry a key.
		if !errors.Is(err, ai.ErrNotReady) && ctx.Err() == nil {
			h.log.Warn("follow-up classification failed", "worker", id, "kind", ai.KindOf(err), "err", err)
		}
		return
	}
	var f *proto.Followup
	if res.Flag {
		f = &proto.Followup{TurnID: turnID, Questions: res.Questions, Score: res.Score, Source: res.Source,
			At: h.opts.Now().UnixMilli()}
		f.Unlisted = res.Unlisted
		if res.Source == followup.SourceFallback {
			f.Tail, f.Error = followup.Tail(c.turn.Text, followup.TailChars), res.ExtractErr
			h.log.Info("follow-up extraction fell back", "worker", id, "why", res.ExtractErr, "efforts", res.Efforts)
		}
		if res.NotRound != "" {
			h.log.Info("follow-up not read as a grill round", "worker", id, "why", res.NotRound)
		}
	}
	// Superseded meanwhile (a prompt, the worker at work or asking): the
	// message was looked at, and is not flagged.
	w := h.workers[id]
	stale := !current || w == nil || h.followupSkip(w) != "" || w.Status == statusWorking
	var raw string
	if f != nil {
		b, _ := json.Marshal(f)
		raw = string(b)
	}
	if err := h.st.RecordFollowupSeen(ctx, id, c.turn.Hash, raw, stale && f != nil); err != nil {
		h.log.Error("recording follow-up failed", "worker", id, "err", err)
	}
	h.log.Info("follow-up looked at", "worker", id, "score", res.Score, "flagged", f != nil, "stale", stale)
	if f != nil && !stale {
		h.setFollowup(id, f, c.turn.Hash, c.turn.Text)
	}
}

// setFollowup shows a worker's follow-up (worker.upsert).
func (h *Hub) setFollowup(id string, f *proto.Followup, hash, text string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	h.fu.shown[id] = &followupShown{f: f, hash: hash, text: text}
	next := *w
	next.Followup = f
	h.workers[id] = &next
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// dropFollowup forgets a worker's open follow-up for good (the record is
// cleared) and, with pending, the turn waiting to be looked at; without, a
// turn already handed to the pipeline still goes (its result is then
// recorded, not shown: herdr saw the worker at work after it settled), while
// one still waiting stays (herdr's status may lag the transcript's turn end).
// It reports whether one was shown. The caller publishes the worker.
func (h *Hub) dropFollowup(ctx context.Context, id string, pending bool) bool {
	if c := h.fu.pending[id]; c != nil && (pending || c.inflight) {
		delete(h.fu.pending, id)
	}
	s := h.fu.shown[id]
	if s == nil {
		return false
	}
	delete(h.fu.shown, id)
	if err := h.st.ClearFollowupSeen(ctx, id, s.hash); err != nil {
		h.log.Error("clearing follow-up record failed", "worker", id, "err", err)
	}
	return true
}

// clearFollowup drops a worker's follow-up and publishes it (hub goroutine):
// it was answered or dismissed, or the worker was prompted or typed into.
func (h *Hub) clearFollowup(ctx context.Context, id string) {
	if !h.dropFollowup(ctx, id, true) {
		return
	}
	if w := h.workers[id]; w != nil && w.Followup != nil {
		next := *w
		next.Followup = nil
		h.workers[id] = &next
		h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
	}
}

// startFollowups answers followups.get, followups.set and followups.test.
// The test's calls and the store write run off the hub goroutine; a change
// is published (followups.update) before the ack.
func (h *Hub) startFollowups(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.fu.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no AI integration", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdFollowupsGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	case proto.CmdFollowupsSet:
		var a proto.FollowupsSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			if err := svc.Set(ctx, a.Enabled, a.Threshold); err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishFollowups)
			return svc.View(), nil
		}
	default: // followups.test
		var a proto.FollowupsTestArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Test(ctx, a.Threshold)
			if err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishFollowups)
			return res, nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// followupOf checks a worker's follow-up is the one of turnID (hub
// goroutine): stale when it has none, or another (answered, dismissed, or a
// newer turn's).
func (h *Hub) followupOf(id, turnID string) (*followupShown, error) {
	if h.workers[id] == nil {
		return nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	s := h.fu.shown[id]
	if s == nil || s.f.TurnID != turnID {
		return nil, fmt.Errorf("%w: the worker has no open follow-up of turn %q (answered, dismissed, or a newer turn)", errStale, clip(turnID))
	}
	return s, nil
}

// startDismissFollowup answers worker.dismiss_followup.
func (h *Hub) startDismissFollowup(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerDismissFollowupArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if _, err := h.followupOf(a.ID, a.TurnID); err != nil {
		return err
	}
	h.clearFollowup(ctx, a.ID)
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

// FollowupPromptHeader starts the prompt worker.answer_followup sends.
const FollowupPromptHeader = "Answers to your open questions:"

// FollowupRecommended follows an answer that is the agent's own
// recommendation, accepted as it was (#60).
const FollowupRecommended = "(your recommendation)"

// followupPrompt formats the answers as the one prompt the agent gets: a
// line per answered question, in the questions' order, then the questions
// left unanswered and the round's note. A question with a label (a grill
// round's Q9, #60) is named by it and its title ("- Q9 <question> →
// <answer>"), else by its number ("<n>. <question> → <answer>"); a note
// follows the answer after a space, and an accepted recommendation says so.
// A fallback's one free answer is sent as it is (with the note after it).
// A cut recommendation sent back as an answer is refused (bad_request).
func followupPrompt(f *proto.Followup, answers []proto.FollowupAnswer, note string) (string, error) {
	if len(note) > proto.MaxFollowupAnswer || !utf8.ValidString(note) {
		return "", bad("note must be at most %d bytes of UTF-8", proto.MaxFollowupAnswer)
	}
	note = strings.TrimSpace(strings.ReplaceAll(note, "\r\n", "\n"))
	if len(answers) == 0 && note == "" {
		return "", bad("answers must answer at least one question")
	}
	byID := map[string]proto.FollowupAnswer{}
	for i, a := range answers {
		at := -1
		for j, q := range f.Questions {
			if q.ID == a.ID {
				at = j
			}
		}
		if at < 0 {
			return "", bad("answers[%d].id is not a question of this follow-up", i)
		}
		if _, dup := byID[a.ID]; dup {
			return "", bad("answers[%d] answers question %s again", i, a.ID)
		}
		for _, s := range []string{a.Value, a.Note} {
			if len(s) > proto.MaxFollowupAnswer || !utf8.ValidString(s) {
				return "", bad("answers[%d]: a value or note must be at most %d bytes of UTF-8", i, proto.MaxFollowupAnswer)
			}
		}
		a.Value = strings.TrimSpace(strings.ReplaceAll(a.Value, "\r\n", "\n"))
		a.Note = strings.TrimSpace(strings.ReplaceAll(a.Note, "\r\n", "\n"))
		if a.Value == "" && a.Note == "" {
			return "", bad("answers[%d] is empty", i)
		}
		if q := f.Questions[at]; cutRecommendation(q, a.Value) || cutRecommendation(q, a.Note) {
			name := "question " + strconv.Itoa(at+1)
			if q.Label != "" {
				name = q.Label
			}
			return "", bad("%s's recommendation was too long to send whole: read the whole message and write your answer", name)
		}
		byID[a.ID] = a
	}
	join := func(a proto.FollowupAnswer) string {
		switch {
		case a.Value == "":
			return a.Note
		case a.Note == "":
			return a.Value
		}
		return a.Value + " " + a.Note
	}
	withNote := func(s string) string {
		switch {
		case note == "":
			return s
		case s == "":
			return note
		}
		return s + "\n\n" + note
	}
	if f.Source == proto.FollowupFallback && len(f.Questions) == 1 {
		a, ok := byID[f.Questions[0].ID]
		if !ok {
			return note, nil
		}
		return withNote(join(a)), nil
	}
	var b strings.Builder
	var unanswered []string
	b.WriteString(FollowupPromptHeader)
	for i, q := range f.Questions {
		name := strconv.Itoa(i + 1)
		if q.Label != "" {
			name = q.Label
		}
		a, ok := byID[q.ID]
		if !ok {
			unanswered = append(unanswered, name)
			continue
		}
		v := join(a)
		if q.Kind == proto.FollowupYesNo {
			switch strings.ToLower(a.Value) {
			case "yes", "no":
			default:
				return "", bad("question %s is yes or no: value must be \"Yes\" or \"No\"", q.ID)
			}
		}
		if recommended(q, a) {
			v += " " + FollowupRecommended
		}
		if q.Label != "" {
			fmt.Fprintf(&b, "\n- %s %s → %s", q.Label, q.Question, v)
		} else {
			fmt.Fprintf(&b, "\n%d. %s → %s", i+1, q.Question, v)
		}
	}
	if len(unanswered) > 0 {
		b.WriteString("\nUnanswered: " + strings.Join(unanswered, ", "))
	}
	return withNote(b.String()), nil
}

// recommended: answer a is question q's recommendation as it was (its
// option, or its whole text: never a cut one's), with no note.
func recommended(q proto.FollowupQuestion, a proto.FollowupAnswer) bool {
	r := q.Recommendation
	if r == nil || a.Note != "" {
		return false
	}
	if q.Kind == proto.FollowupChoice && r.Option != nil && *r.Option >= 0 && *r.Option < len(q.Options) {
		return a.Value == q.Options[*r.Option]
	}
	return q.Kind == proto.FollowupOpen && !r.Cut && a.Value == strings.TrimSpace(r.Text)
}

// cutRecommendation: s is question q's cut recommendation sent back as an
// answer (#60): its start, with or without the "…", however its spaces fold.
// The bridge refuses it whatever the client: the agent would take a part of
// its answer for the whole. An option of q is sent whole, never refused.
func cutRecommendation(q proto.FollowupQuestion, s string) bool {
	r := q.Recommendation
	if r == nil || !r.Cut || s == "" || slices.Contains(q.Options, s) {
		return false
	}
	fold := func(s string) string { return strings.TrimRight(strings.Join(strings.Fields(s), " "), " .…") }
	return fold(s) == fold(r.Text)
}

// startAnswerFollowup answers worker.answer_followup: the answers as one
// prompt, sent like worker.prompt on the worker's input lane. The follow-up
// is checked again when its turn on the lane comes, and cleared once the
// prompt went.
func (h *Hub) startAnswerFollowup(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerAnswerFollowupArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	return h.queueAnswerFollowup(ctx, a, h.endCommand(c, cmd))
}

// queueAnswerFollowup is worker.answer_followup's checks and its queueing
// on the worker's lane (hub goroutine), for a client's command and (#14) a
// Telegram card's answer alike: end gets the outcome. #108 round 2: with
// prompt secrets reviewed, its texts (the answers' values and notes, the
// note) go through the gate on the lane first, and the prompt they make is
// checked again.
func (h *Hub) queueAnswerFollowup(ctx context.Context, a proto.WorkerAnswerFollowupArgs, end inputEnd) error {
	text, err := h.planAnswerFollowup(a)
	if err != nil {
		return err
	}
	if h.gated(a.Secrets != nil) {
		var fields []secretField
		if a.Note != "" {
			fields = append(fields, secretField{path: "note", text: a.Note})
		}
		for i, x := range a.Answers {
			for _, f := range []secretField{{path: fmt.Sprintf("answers[%d].value", i), text: x.Value}, {path: fmt.Sprintf("answers[%d].note", i), text: x.Note}} {
				if f.text != "" {
					fields = append(fields, f)
				}
			}
		}
		return h.queueReviewed(ctx, a.ID, a.Secrets, fields, end, func(ctx context.Context, texts func(string) string, rev *promptsecret.Reviewer) (inputWork, error) {
			b := a
			b.Note, b.Secrets, b.Answers = texts("note"), nil, slices.Clone(a.Answers)
			for i := range b.Answers {
				b.Answers[i].Value, b.Answers[i].Note = texts(fmt.Sprintf("answers[%d].value", i)), texts(fmt.Sprintf("answers[%d].note", i))
			}
			text, err := h.planAnswerFollowup(b)
			if err != nil {
				return nil, err
			}
			h.tookOver(ctx, a.ID)
			h.agentTookOver(ctx, a.ID)
			return h.sendFollowupAnswers(a, text, rev), nil
		})
	}
	h.tookOver(ctx, a.ID)      // #83: a person prompts: an armed wrap-up is off
	h.agentTookOver(ctx, a.ID) // #224: and a handoff request
	return h.queueInput(ctx, a.ID, h.sendFollowupAnswers(a, text, nil), end)
}

// planAnswerFollowup is worker.answer_followup's checks (hub goroutine):
// the prompt its answers make.
func (h *Hub) planAnswerFollowup(a proto.WorkerAnswerFollowupArgs) (string, error) {
	s, err := h.followupOf(a.ID, a.TurnID)
	if err != nil {
		return "", err
	}
	text, err := followupPrompt(s.f, a.Answers, a.Note)
	if err != nil {
		return "", err
	}
	if !herdr.ValidMessage(text) {
		return "", bad("the answers make a prompt of %d bytes (at most %d, without NUL)", len(text), herdr.MaxMessage)
	}
	w, _, err := h.termWorker(a.ID)
	if err != nil {
		return "", err
	}
	if w.AgentKind == "" {
		return "", fmt.Errorf("%w: %s runs no agent", errInvalidState, w.Name)
	}
	if err := checkTyped(w.AgentKind, text, herdr.MaxMessage, "the answers"); err != nil {
		return "", err
	}
	if w.Ask != nil { // #57: its dialog would take the text
		return "", fmt.Errorf("%w: %s %w: answer it first (worker.answer_ask)", errInvalidState, w.Name, errAskWaiting)
	}
	return text, nil
}

// sendFollowupAnswers is the work that sends a follow-up's answers (text)
// on the worker's lane: the follow-up checked again first, cleared once
// the prompt went. #108: rev is its review's (nil: none), checked again as
// the prompt goes.
func (h *Hub) sendFollowupAnswers(a proto.WorkerAnswerFollowupArgs, text string, rev *promptsecret.Reviewer) inputWork {
	return func(ctx context.Context, session, pane string) (any, error) {
		stale, err := query(ctx, h, func() error { _, err := h.followupOf(a.ID, a.TurnID); return err })
		if err != nil {
			return nil, err
		}
		if stale != nil {
			return nil, stale
		}
		res, err := h.prompt(ctx, proto.WorkerPromptArgs{ID: a.ID, Text: text}, session, pane, rev)
		if err != nil {
			return nil, err
		}
		h.kickUsage()
		_ = h.doWait(ctx, func() {
			delete(h.cr.latest, a.ID)
			h.closeCommandRequest(a.ID, "", "moved")
			if _, err := h.followupOf(a.ID, a.TurnID); err == nil {
				h.clearFollowup(ctx, a.ID)
			}
		})
		return res, nil
	}
}

// startRetryFollowup answers worker.retry_followup (#60): a fallback's
// questions extracted again from its message (never classified again), at
// most MaxFollowupRetries times and one at a time. The outcome replaces the
// follow-up of the same turn (also in followup_seen, so a restart brings
// back the recovered round) unless it was answered, dismissed or moot
// meanwhile; a failure is the fallback again, with the new why.
// A successful extraction with no questions clears the follow-up.
func (h *Hub) startRetryFollowup(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerRetryFollowupArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	s, err := h.followupOf(a.ID, a.TurnID)
	if err != nil {
		return err
	}
	switch {
	case h.fu.svc == nil || !h.fu.svc.Ready():
		return fmt.Errorf("%w: follow-up questions are not ready (switched off, or a model is not ready)", errInvalidState)
	case s.f.Source != proto.FollowupFallback:
		return bad("its questions were read: there is nothing to retry")
	case s.retrying:
		return fmt.Errorf("%w: a retry of these questions is running", errBusy)
	case s.f.Retries >= MaxFollowupRetries:
		return fmt.Errorf("%w: retried %d times already: answer in your own words, or read the whole message", errInvalidState, s.f.Retries)
	}
	s.retrying = true
	svc, text := h.fu.svc, s.text
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		ex, err := svc.Retry(ctx, text)
		var out proto.WorkerRetryFollowupResult
		if derr := h.doWait(ctx, func() { out, err = h.retriedFollowup(ctx, a, s, ex, err) }); derr != nil {
			return nil, derr
		}
		if err != nil {
			return nil, err
		}
		return out, nil
	})
	return nil
}

// retriedFollowup takes a retry's extraction (hub goroutine).
func (h *Hub) retriedFollowup(ctx context.Context, a proto.WorkerRetryFollowupArgs, s *followupShown, ex followup.Extraction, err error) (proto.WorkerRetryFollowupResult, error) {
	s.retrying = false
	if err != nil {
		return proto.WorkerRetryFollowupResult{}, err
	}
	cur, serr := h.followupOf(a.ID, a.TurnID)
	if serr != nil || cur != s {
		return proto.WorkerRetryFollowupResult{}, fmt.Errorf("%w: the questions were answered, dismissed or replaced meanwhile", errStale)
	}
	if len(ex.Questions) == 0 {
		h.clearFollowup(ctx, a.ID)
		return proto.WorkerRetryFollowupResult{Source: ex.Source}, nil
	}
	next := *s.f
	next.Retries++
	next.Questions, next.Source, next.Unlisted, next.Error = ex.Questions, ex.Source, ex.Unlisted, ex.ExtractErr
	if ex.Source != followup.SourceFallback {
		next.Tail = ""
	}
	h.log.Info("follow-up extraction retried", "worker", a.ID, "source", ex.Source, "why", ex.ExtractErr, "efforts", ex.Efforts)
	b, _ := json.Marshal(&next)
	if err := h.st.RecordFollowupSeen(ctx, a.ID, s.hash, string(b), false); err != nil {
		h.log.Error("recording follow-up failed", "worker", a.ID, "err", err)
	}
	h.setFollowup(a.ID, &next, s.hash, s.text)
	return proto.WorkerRetryFollowupResult{Source: next.Source, Error: next.Error}, nil
}

// startFollowupMessage answers worker.followup_message (#60): the message
// the open follow-up is of, on request (never in the worker's upsert).
func (h *Hub) startFollowupMessage(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerFollowupMessageArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	s, err := h.followupOf(a.ID, a.TurnID)
	if err != nil {
		return err
	}
	text := followup.Tail(s.text, followup.MaxMessageChars)
	h.reply(c, cmd, proto.WorkerFollowupMessageResult{Text: text, Cut: len(text) < len(s.text)}, nil)
	return nil
}

// auditFollowup is what worker.answer_followup leaves in the audit log: the
// ids and each answer's lengths, never its text.
func auditFollowup(cmd proto.Command) json.RawMessage {
	var a proto.WorkerAnswerFollowupArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	type answer struct {
		ID         string `json:"id"`
		ValueBytes int    `json:"value_bytes"`
		NoteBytes  int    `json:"note_bytes,omitempty"`
	}
	out := struct {
		ID        string        `json:"id"`
		TurnID    string        `json:"turn_id"`
		Answers   []answer      `json:"answers"`
		NoteBytes int           `json:"note_bytes,omitempty"`
		Secrets   *secretsAudit `json:"secrets,omitempty"` // #108 round 2: the decisions' counts
	}{ID: clip(a.ID), TurnID: clip(a.TurnID), Answers: []answer{}, NoteBytes: len(a.Note), Secrets: auditReviewMap(a.Secrets)}
	for _, x := range a.Answers {
		out.Answers = append(out.Answers, answer{ID: clip(x.ID), ValueBytes: len(x.Value), NoteBytes: len(x.Note)})
	}
	return mustJSON(out)
}

// followupErrorCode maps an error of internal/followup to its protocol code;
// "" when it is none.
func followupErrorCode(err error) string {
	var fe *followup.Error
	if errors.As(err, &fe) {
		return fe.Code
	}
	return ""
}
