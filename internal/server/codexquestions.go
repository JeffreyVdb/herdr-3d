package server

// #156 (epic #153, phase 3): a shared Codex worker's async questions
// (request_user_input_async) and the bridge's answers to them, through the
// worker's own app-server (docs/research/codex-shared-tui.md §1, §2;
// docs/decisions.md #156). The bridge's join of the thread (codexserver.go)
// sees each batch live, and the thread's history on every (re)join; one
// codexapp.Questions per worker reconciles both with the answers it sees,
// the terminal's included. worker.answer_async sends the native envelope on
// the worker's input lane: turn/steer into the running turn, turn/start
// when none runs. A worker herdr shows as blocked only because of such a
// question takes prompts through the same two calls.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/codexapp"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// Bounds of the async questions on the wire (they are in every snapshot)
// and of worker.answer_async.
const (
	maxAsyncTitle   = 2000
	maxAsyncOption  = 1000
	maxAsyncOptions = 16
	maxAsyncAnswer  = 4 << 10 // one answer, as sent
	maxAsyncAnswers = 16      // answers in one command
	maxAsyncError   = 300
)

// Codex's two sends, as acks name them.
const (
	viaSteer = "turn/steer"
	viaStart = "turn/start"
	// viaAppServer is PromptResult.Via of a prompt sent through them.
	viaAppServer = "app_server"
)

var asyncBatchRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// threadQuestions is the reconciler of a worker's thread, a new one when it
// has none or one of another thread (hub goroutine).
func (h *Hub) threadQuestions(id, thread string) *codexapp.Questions {
	q := h.cx.questions[id]
	if q == nil || q.Thread != thread {
		q = codexapp.NewQuestions(thread)
		h.cx.questions[id] = q
	}
	return q
}

// codexJoined takes a join's thread: its running turn, and its history
// reconciled with what the bridge already knew of its questions, its
// recorded sends included (#158: after a restart they are all it knows of
// an answer still waiting in the running turn).
func (h *Hub) codexJoined(ctx context.Context, id string, cw *codexWatch, th *codexapp.Thread) {
	if th == nil || h.cx.launches[id].Thread != cw.thread {
		return
	}
	cw.turn = th.ActiveTurn()
	q := h.threadQuestions(id, cw.thread)
	q.Hydrate(th.Turns)
	for k, x := range h.cx.sends[id] {
		if x.Thread != cw.thread || !q.Restore(codexapp.PriorSend{Batch: x.Batch, Index: x.Index, Turn: x.Turn,
			Confirmed: x.Confirmed, Unconfirmed: x.Unconfirmed}, cw.turn) {
			h.forgetSend(ctx, id, k)
		}
	}
}

// codexNote is the part of the notifications the bridge reads.
type codexNote struct {
	ThreadID string        `json:"threadId"`
	TurnID   string        `json:"turnId"`
	Item     codexapp.Item `json:"item"`
	Turn     struct {
		ID string `json:"id"`
	} `json:"turn"`
	Status struct {
		Type string `json:"type"`
	} `json:"status"`
	RequestID json.RawMessage `json:"requestId"`
}

// codexNotification is one notification of the join (hub goroutine).
func (h *Hub) codexNotification(ctx context.Context, id string, cw *codexWatch, method string, params json.RawMessage) {
	var n codexNote
	if json.Unmarshal(params, &n) != nil || n.ThreadID != cw.thread || h.cx.launches[id].Thread != cw.thread {
		return
	}
	switch method {
	case "item/started", "item/completed":
		if h.threadQuestions(id, cw.thread).Observe(n.TurnID, n.Item, codexapp.OriginLive) {
			h.pruneSends(ctx, id)
		}
	case "turn/started":
		cw.turn = n.Turn.ID
	case "turn/completed":
		if cw.turn == n.Turn.ID {
			cw.turn = ""
		}
		// An answer the turn never delivered is undelivered (an interrupt
		// before the next model request drops a steered input).
		h.threadQuestions(id, cw.thread).TurnEnded(n.Turn.ID)
	case "thread/status/changed":
		if n.Status.Type != codexapp.ThreadActive {
			cw.turn = ""
		}
	case "serverRequest/resolved":
		delete(cw.requests, compactJSON(n.RequestID))
	}
}

// compactJSON is a JSON value with its insignificant space dropped: a
// server request's id as it is keyed.
func compactJSON(raw json.RawMessage) string {
	var b bytes.Buffer
	if json.Compact(&b, raw) != nil {
		return string(raw)
	}
	return b.String()
}

// questionsView is a shared worker's questions for its view (hub
// goroutine): those of its thread now, with the wire's caps.
func (h *Hub) questionsView(id string) []proto.CodexBatch {
	q := h.cx.questions[id]
	if q == nil || q.Thread != h.cx.launches[id].Thread {
		return nil
	}
	var out []proto.CodexBatch
	for _, b := range q.Batches() {
		v := proto.CodexBatch{Batch: b.ID, Turn: b.Turn, Seen: b.Seen, Twin: b.Twin, Conflict: b.Conflict, At: b.At.UnixMilli(),
			Questions: make([]proto.CodexQuestion, 0, len(b.Questions))}
		for i, x := range b.Questions {
			cq := proto.CodexQuestion{Index: i, State: string(x.State), AnsweredBy: x.AnsweredBy, Unconfirmed: x.Unconfirmed,
				Undelivered: x.Undelivered}
			var cut [4]bool
			cq.Title, cut[0] = cutBytes(x.Title, maxAsyncTitle)
			cq.Answer, cut[1] = cutBytes(x.Answer, maxAsyncAnswer)
			cq.Error, _ = cutBytes(x.Error, maxAsyncError)
			opts := x.Options
			if len(opts) > maxAsyncOptions {
				opts, cut[2] = opts[:maxAsyncOptions], true
			}
			for _, o := range opts {
				o, c := cutBytes(o, maxAsyncOption)
				cut[3] = cut[3] || c
				cq.Options = append(cq.Options, o)
			}
			cq.Truncated = cut[0] || cut[1] || cut[2] || cut[3]
			v.Questions = append(v.Questions, cq)
		}
		out = append(out, v)
	}
	return out
}

// cutBytes cuts s to at most n bytes, on a rune boundary.
func cutBytes(s string, n int) (string, bool) {
	if len(s) <= n {
		return s, false
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n], true
}

// asyncThread is the reconciler of a shared worker's thread, the one a
// command names (hub goroutine): the worker exists and is shared, and
// thread is still its thread (a /new in the terminal changes it).
func (h *Hub) asyncThread(id, thread string) (*codexapp.Questions, error) {
	w := h.workers[id]
	if w == nil {
		return nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	if !h.isShared(id) {
		return nil, fmt.Errorf("%w: %s is not a Codex worker with its own server", errInvalidState, w.Name)
	}
	if cur := h.cx.launches[id].Thread; cur != thread {
		return nil, fmt.Errorf("%w: %s's thread is %q now, not %q", errStale, w.Name, cur, thread)
	}
	q := h.cx.questions[id]
	if q == nil || q.Thread != thread {
		q = codexapp.NewQuestions(thread) // none known: every batch is unknown
	}
	return q, nil
}

// asyncError maps the reconciler's refusals to the protocol's codes.
func asyncError(err error) error {
	switch {
	case errors.Is(err, codexapp.ErrBadAnswer):
		return bad("%v", err)
	case errors.Is(err, codexapp.ErrUnknownBatch), errors.Is(err, codexapp.ErrNotPending):
		return fmt.Errorf("%w: %v", errStale, err)
	case errors.Is(err, codexapp.ErrConflict):
		return fmt.Errorf("%w: %v", errInvalidState, err)
	}
	return err
}

// attachedWatch is a shared worker's join while it is attached to thread.
func (h *Hub) attachedWatch(id, thread string) (*codexWatch, error) {
	cw := h.cx.watches[id]
	if cw == nil || !cw.attached || cw.thread != thread {
		return nil, fmt.Errorf("%w: the bridge is not attached to the worker's thread (its server: %s)", errInvalidState,
			h.cx.server[id])
	}
	return cw, nil
}

// validAsyncText reports whether an answer can go in the envelope: UTF-8
// without control characters but line ends and tabs.
func validAsyncText(s string) bool {
	if !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return false
		}
	}
	return true
}

// startAnswerAsync validates worker.answer_async and queues it on the
// worker's input lane, where it is checked again just before it is sent.
func (h *Hub) startAnswerAsync(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerAnswerAsyncArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Thread == "" || !asyncBatchRe.MatchString(a.Batch) {
		return bad("thread and batch (a question message id) are required")
	}
	if len(a.Answers) == 0 || len(a.Answers) > maxAsyncAnswers {
		return bad("answers must have 1-%d items, got %d", maxAsyncAnswers, len(a.Answers))
	}
	replies := make([]codexapp.Reply, 0, len(a.Answers))
	for i, x := range a.Answers {
		if x.Index == nil {
			return bad("answers[%d].index is required", i)
		}
		if len(x.Answer) > maxAsyncAnswer || !validAsyncText(x.Answer) {
			return bad("answers[%d].answer must be at most %d bytes of UTF-8 without control characters but line ends and tabs, got %d bytes",
				i, maxAsyncAnswer, len(x.Answer))
		}
		replies = append(replies, codexapp.Reply{Index: *x.Index, Text: x.Answer})
	}
	if _, _, err := h.termWorker(a.ID); err != nil {
		return err
	}
	q, err := h.asyncThread(a.ID, a.Thread)
	if err != nil {
		return err
	}
	t, err := q.Admit(a.Batch, replies)
	if err != nil {
		return asyncError(err)
	}
	if _, err := h.attachedWatch(a.ID, a.Thread); err != nil {
		return err
	}
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, _, _ string) (any, error) {
		return h.answerAsync(ctx, a, t)
	})
}

// asyncSend is a checked answer, ready to go (taken on the hub goroutine).
type asyncSend struct {
	w         CodexWatch
	q         *codexapp.Questions
	turn      string
	text, cid string
	indexes   []int
	err       error
}

// answerAsync sends an answer on the worker's input lane: the worker, its
// thread, the join and the questions checked again and marked sending in
// one step (an answer to them submitted before is stale from then on, a
// retry of an undelivered one included: it must be submitted after), then
// one turn/steer into the running turn, or turn/start when none runs. A steer
// the server refuses delivered nothing (the turn ended meanwhile): a turn
// is started instead, once. An answer is never sent twice: a send with no
// response is sent, unconfirmed, and a refused one is pending again.
func (h *Hub) answerAsync(ctx context.Context, a proto.WorkerAnswerAsyncArgs, t codexapp.Ticket) (any, error) {
	s, err := query(ctx, h, func() asyncSend {
		q, err := h.asyncThread(a.ID, a.Thread)
		if err != nil {
			return asyncSend{err: err}
		}
		cw, err := h.attachedWatch(a.ID, a.Thread)
		if err != nil {
			return asyncSend{err: err}
		}
		answers, err := q.BeginAdmitted(t)
		if err != nil {
			return asyncSend{err: asyncError(err)}
		}
		h.refreshCodex(a.ID)
		s := asyncSend{w: cw.w, q: q, turn: cw.turn, text: codexapp.ReplyEnvelope(answers...), cid: codexapp.NewClientID()}
		for _, x := range answers {
			s.indexes = append(s.indexes, x.Index)
		}
		// Recorded before it goes out (#158): the turn it is steered into,
		// or none for a turn it starts.
		h.recordSends(ctx, a.ID, a.Thread, a.Batch, s.indexes, store.CodexAsyncSend{ClientID: s.cid, Turn: s.turn})
		return s
	})
	if err != nil {
		return nil, err
	}
	if s.err != nil {
		return nil, s.err
	}
	res := proto.AsyncAnswerResult{State: proto.AsyncSent}
	res.Via, res.Turn, res.Fallback, err = h.sendToThread(ctx, a.ID, s.w, s.turn, s.text, s.cid)
	unconfirmed := errors.Is(err, codexapp.ErrNoResponse)
	_ = h.doWait(ctx, func() {
		if h.cx.questions[a.ID] != s.q { // the thread changed meanwhile
			return
		}
		switch {
		case err == nil:
			s.q.Sent(a.Batch, s.indexes, res.Turn, false)
			h.recordSends(ctx, a.ID, a.Thread, a.Batch, s.indexes, store.CodexAsyncSend{ClientID: s.cid, Turn: res.Turn, Confirmed: true})
		case unconfirmed:
			s.q.Sent(a.Batch, s.indexes, "", true)
			h.recordSends(ctx, a.ID, a.Thread, a.Batch, s.indexes, store.CodexAsyncSend{ClientID: s.cid, Unconfirmed: true})
		default:
			s.q.Failed(a.Batch, s.indexes, err.Error())
			for _, i := range s.indexes {
				h.forgetSend(ctx, a.ID, sendKey{a.Batch, i})
			}
		}
		h.pruneSends(ctx, a.ID) // delivered before the response came
		h.refreshCodex(a.ID)
	})
	switch {
	case unconfirmed:
		h.log.Warn("an async answer got no response: not sent again", "worker", a.ID, "batch", a.Batch, "err", err)
		res.Unconfirmed, res.Turn = true, ""
		return res, nil
	case err != nil:
		return nil, fmt.Errorf("%w: %s refused the answer: %v", errInputFailed, res.Via, err)
	}
	return res, nil
}

// sendToThread sends user input to a shared worker's thread (off the hub
// goroutine, on its input lane): turn/steer into turn when one runs,
// turn/start otherwise, and turn/start once when the steer was refused
// (the turn ended between the bridge's view and the server's: nothing was
// delivered). It returns the call that went last and the turn it reached.
func (h *Hub) sendToThread(ctx context.Context, id string, w CodexWatch, turn, text, cid string) (via, reached string, fallback bool, err error) {
	if turn != "" {
		reached, err = w.Steer(ctx, turn, text, cid)
		if !codexapp.Refused(err) {
			return viaSteer, reached, false, err
		}
		h.log.Info("turn/steer refused: starting a turn instead", "worker", id, "turn", turn, "err", err)
		fallback = true
	}
	reached, err = w.StartTurn(ctx, text, cid)
	return viaStart, reached, fallback, err
}

// startDismissAsync answers worker.dismiss_async (hub goroutine): pending
// or sent questions are put away, in the bridge only.
func (h *Hub) startDismissAsync(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerDismissAsyncArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if a.Thread == "" || !asyncBatchRe.MatchString(a.Batch) {
		return bad("thread and batch (a question message id) are required")
	}
	if len(a.Indexes) > maxAsyncAnswers {
		return bad("indexes must have at most %d items", maxAsyncAnswers)
	}
	q, err := h.asyncThread(a.ID, a.Thread)
	if err != nil {
		return err
	}
	if err := q.Dismiss(a.Batch, a.Indexes); err != nil {
		return asyncError(err)
	}
	h.refreshCodex(a.ID)
	h.audit(ctx, c, cmd, nil)
	h.reply(c, cmd, nil, nil)
	return nil
}

// asyncBlocked is the join a prompt can go through when herdr shows a
// shared worker as blocked only because of an async question (B7: herdr
// refuses `agent prompt` then, agent_blocked): attached, a turn running
// with a question Codex still holds as pending, and no server request open
// (an approval or a blocking question is a real block: the terminal
// answers it). Hub goroutine.
func (h *Hub) asyncBlocked(id string) (*codexWatch, bool) {
	l, ok := h.cx.launches[id]
	cw := h.cx.watches[id]
	if !ok || !h.isShared(id) || cw == nil || !cw.attached || cw.thread != l.Thread || cw.turn == "" || len(cw.requests) > 0 {
		return nil, false
	}
	q := h.cx.questions[id]
	return cw, q != nil && q.Thread == l.Thread && q.Unanswered(cw.turn)
}

// asyncPrompt is a prompt's way through the app-server.
type asyncPrompt struct {
	w    CodexWatch
	turn string
	ok   bool
}

// promptViaServer sends a prompt to a shared worker herdr shows as blocked
// by an async question (input lane): steered into the running turn, as
// Codex's own composer queues it ("Messages to be submitted after next
// tool call"), so it is delivered with the turn's next model request. ok is
// false when the worker is not blocked that way.
func (h *Hub) promptViaServer(ctx context.Context, id, text string) (any, bool, error) {
	p, err := query(ctx, h, func() asyncPrompt {
		cw, ok := h.asyncBlocked(id)
		if !ok {
			return asyncPrompt{}
		}
		return asyncPrompt{w: cw.w, turn: cw.turn, ok: true}
	})
	if err != nil {
		return nil, true, err
	}
	if !p.ok {
		return nil, false, nil
	}
	via, _, _, err := h.sendToThread(ctx, id, p.w, p.turn, text, codexapp.NewClientID())
	switch {
	case errors.Is(err, codexapp.ErrNoResponse):
		return nil, true, fmt.Errorf("%w: no response from the worker's app-server (it may have taken the prompt): %v", errPromptFailed, err)
	case err != nil:
		return nil, true, fmt.Errorf("%w: %v", errPromptFailed, err)
	}
	return proto.PromptResult{Queued: via == viaSteer, Via: viaAppServer}, true, nil
}

// #158: the bridge's answers Codex accepted, or may have, whose question is
// not answered yet, kept in the store (codex_async_send) and in
// codexState.sends. Codex holds a steered answer in the running turn until
// its next model request, and the thread's history shows it only then; a
// restarted bridge rebuilds its questions from that history, so without
// these it would take, and send, a second answer the model then sees too.
// A send is recorded before its request goes out and updated with the
// response; it goes once its question is answered (or its batch is gone),
// when its answer is refused, when the thread changes and when the worker is
// sent home. A dismissal keeps it: the bridge forgets dismissals on a
// restart, and the answer may still be on its way.

// sendKey is a question of a worker's thread.
type sendKey struct {
	batch string
	index int
}

// loadSends reads the recorded sends (initCodex).
func (h *Hub) loadSends(ctx context.Context) error {
	all, err := h.st.CodexAsyncSends(ctx)
	if err != nil {
		return err
	}
	for id, xs := range all {
		for _, x := range xs {
			h.sendsOf(id)[sendKey{x.Batch, x.Index}] = x
		}
	}
	return nil
}

func (h *Hub) sendsOf(id string) map[sendKey]store.CodexAsyncSend {
	m := h.cx.sends[id]
	if m == nil {
		m = map[sendKey]store.CodexAsyncSend{}
		h.cx.sends[id] = m
	}
	return m
}

// recordSends records the questions of one answer as x says (hub
// goroutine). A store that fails is logged: that answer is then known only
// until the bridge stops.
func (h *Hub) recordSends(ctx context.Context, id, thread, batch string, indexes []int, x store.CodexAsyncSend) {
	xs := make([]store.CodexAsyncSend, 0, len(indexes))
	for _, i := range indexes {
		x.WorkerID, x.Thread, x.Batch, x.Index = id, thread, batch, i
		xs = append(xs, x)
		h.sendsOf(id)[sendKey{batch, i}] = x
	}
	if err := h.st.RecordCodexAsyncSends(context.WithoutCancel(ctx), xs); err != nil {
		h.log.Error("recording an async answer failed: a restart may take it again", "worker", id, "batch", batch, "err", err)
	}
}

// forgetSend drops one question's send (hub goroutine).
func (h *Hub) forgetSend(ctx context.Context, id string, k sendKey) {
	if _, ok := h.cx.sends[id][k]; !ok {
		return
	}
	delete(h.cx.sends[id], k)
	if err := h.st.ForgetCodexAsyncSend(context.WithoutCancel(ctx), id, k.batch, k.index); err != nil {
		h.log.Error("forgetting an async answer failed", "worker", id, "batch", k.batch, "err", err)
	}
}

// forgetSends drops a worker's sends (hub goroutine).
func (h *Hub) forgetSends(ctx context.Context, id string) {
	if len(h.cx.sends[id]) == 0 {
		return
	}
	delete(h.cx.sends, id)
	if err := h.st.ForgetCodexAsyncSends(context.WithoutCancel(ctx), id); err != nil {
		h.log.Error("forgetting the async answers failed", "worker", id, "err", err)
	}
}

// pruneSends drops a worker's sends whose question is answered or gone
// from its thread's questions (hub goroutine). Before the bridge has
// joined the thread (its questions not read yet) it keeps them.
func (h *Hub) pruneSends(ctx context.Context, id string) {
	q := h.cx.questions[id]
	thread := h.cx.launches[id].Thread
	for k, x := range h.cx.sends[id] {
		if x.Thread != thread {
			h.forgetSend(ctx, id, k)
			continue
		}
		if q == nil || q.Thread != thread {
			continue
		}
		if st, ok := q.StateOf(k.batch, k.index); !ok || st == codexapp.QAnswered {
			h.forgetSend(ctx, id, k)
		}
	}
}
