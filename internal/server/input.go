package server

// M5 term: typing into a worker's pane from its laptop (worker.keys),
// prompting its agent (worker.prompt). Input to one worker is serialized
// on its input lane, answers (worker.answer) included.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// TermHerdr is what the hub needs from herdr for the laptops:
// *herdr.Control, the allowlisted write path.
type TermHerdr interface {
	Observe(ctx context.Context, session, pane string, cols, rows int) (herdr.FrameStream, error)
	ReadPane(ctx context.Context, session, pane string) (string, error)
	SendKeys(ctx context.Context, session, pane string, keys ...string) error
	SendText(ctx context.Context, session, pane, text string) error
	SendSequence(ctx context.Context, session, pane, key string) error
	SubmitPrompt(ctx context.Context, session, pane, text string) error
	QueuePrompt(ctx context.Context, session, pane, text string) error
	// #95: a prompt to Claude Code is typed (in chunks, then Enter), and
	// what a failed one left in its input box erased.
	TypePrompt(ctx context.Context, session, pane, text string) error
	EraseTyped(ctx context.Context, session, pane string, n int) error
}

// Bounds of worker.keys.
const (
	maxInputItems   = 64
	maxItemText     = 4 << 10
	maxInputText    = herdr.MaxInputText // all of one command's text
	maxQueuedInputs = 32                 // commands waiting on one worker's lane
)

// DefaultPromptRetryWait is how long worker.prompt waits after pressing
// Enter again for an agent that dropped the first one.
const DefaultPromptRetryWait = 5 * time.Second

// #95: a prompt typed into Claude Code waits up to DefaultPromptReadyWait
// for the agent to be ready (idle or done, or working to queue it: text
// typed before its input box is up is lost), and up to
// DefaultPromptAckWait for it to start working after Enter (as herdr's
// `agent prompt --wait` does) before Enter is pressed once more.
const (
	DefaultPromptReadyWait = 5 * time.Second
	DefaultPromptAckWait   = 5 * time.Second
)

var (
	errInputFailed  = errors.New("input failed")
	errPromptFailed = errors.New("prompt failed")
	errStale        = errors.New("stale")
	// #13: what a Telegram reply's refusal is recognised by (wrapped, the
	// messages unchanged).
	errAskWaiting = errors.New("waits on its question")
	errLaneFull   = errors.New("waiting for this worker")
)

// termWorker is the worker a laptop command is for: known, on a watched
// floor that is running, with a pane.
func (h *Hub) termWorker(id string) (*proto.Worker, *floorState, error) {
	w := h.workers[id]
	if w == nil {
		return nil, nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	f, err := h.floorFor(w.Session)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %q", errUnknownWorker, id)
	}
	if !f.running {
		return nil, nil, fmt.Errorf("%w: floor %q is asleep", errInvalidState, w.Session)
	}
	if w.PaneID == "" {
		return nil, nil, fmt.Errorf("%w: %s has no pane", errInvalidState, w.Name)
	}
	if h.opts.Term == nil {
		return nil, nil, errors.New("laptops are not configured")
	}
	return w, f, nil
}

// inputLane is one worker's queue of input commands, run one at a time
// in order.
type inputLane struct {
	jobs    []func(context.Context)
	running bool
}

// laneTarget is where a queued input goes, read when its turn comes.
type laneTarget struct {
	session, pane string
	err           error
}

// inputWork is a queued input's work: the worker's pane as it is when its
// turn comes.
type inputWork func(ctx context.Context, session, pane string) (any, error)

// inputEnd gets a queued input's outcome, on its lane once it is done.
type inputEnd func(ctx context.Context, data any, err error)

// startInput queues work on the worker's input lane (hub goroutine). The
// work gets the worker's pane as it is when its turn comes; its audit row
// and reply follow when it is done.
func (h *Hub) startInput(ctx context.Context, c *Client, cmd proto.Command, id string, work inputWork) error {
	return h.queueInput(ctx, id, work, h.endCommand(c, cmd))
}

// endCommand is a client command's inputEnd: its audit row and its reply.
func (h *Hub) endCommand(c *Client, cmd proto.Command) inputEnd {
	return func(ctx context.Context, data any, err error) {
		if derr := h.doWait(ctx, func() {
			h.audit(ctx, c, cmd, err)
			h.reply(c, cmd, data, err)
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	}
}

// laneRoom refuses input to worker id while its lane is full (hub
// goroutine).
func (h *Hub) laneRoom(id string) error {
	if l := h.lanes[id]; l != nil && len(l.jobs) >= maxQueuedInputs {
		return fmt.Errorf("%w: %d commands are already %w", errInputFailed, len(l.jobs), errLaneFull)
	}
	return nil
}

// queueInput is startInput for any caller (hub goroutine): end gets the
// outcome (#13: a Telegram reply's, with no client).
func (h *Hub) queueInput(ctx context.Context, id string, work inputWork, end inputEnd) error {
	if err := h.laneRoom(id); err != nil {
		return err
	}
	h.queueLane(ctx, id, func(ctx context.Context) {
		t, err := query(ctx, h, func() laneTarget {
			w, _, err := h.termWorker(id)
			if err != nil {
				return laneTarget{err: err}
			}
			return laneTarget{session: w.Session, pane: w.PaneID}
		})
		var data any
		if err == nil {
			if err = t.err; err == nil {
				data, err = work(ctx, t.session, t.pane)
			}
		}
		end(ctx, data, err)
	})
	return nil
}

// queueLane queues a job on the worker's input lane (hub goroutine), and
// runs the lane if it is idle.
func (h *Hub) queueLane(ctx context.Context, id string, job func(context.Context)) {
	l := h.lanes[id]
	if l == nil {
		l = &inputLane{}
		h.lanes[id] = l
	}
	l.jobs = append(l.jobs, func(ctx context.Context) {
		h.toLive(id) // #176: input brings a controlled view back to the live bottom
		job(ctx)
	})
	if !l.running {
		l.running = true
		h.wg.Add(1)
		go h.runLane(ctx, id)
	}
}

// onLane runs work on worker id's input lane and waits for it to end (off
// the hub goroutine, never from a job on a lane).
func (h *Hub) onLane(ctx context.Context, id string, work func(context.Context)) error {
	done := make(chan struct{})
	if err := h.doWait(ctx, func() {
		h.queueLane(ctx, id, func(ctx context.Context) { defer close(done); work(ctx) })
	}); err != nil {
		return err
	}
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-h.done:
		return errHubStopped
	}
}

func (h *Hub) runLane(ctx context.Context, id string) {
	defer h.wg.Done()
	for {
		job, err := query(ctx, h, func() func(context.Context) {
			l := h.lanes[id]
			if l == nil || len(l.jobs) == 0 {
				delete(h.lanes, id)
				return nil
			}
			j := l.jobs[0]
			l.jobs = l.jobs[1:]
			return j
		})
		if err != nil || job == nil {
			return
		}
		job(ctx)
	}
}

// inputStep is one herdr call of a worker.keys: text, herdr key names, or
// one key sent as its sequence.
type inputStep struct {
	text string
	keys []string
	seq  string
}

// inputSteps validates worker.keys' input and batches it, in order:
// consecutive texts into one send-text, consecutive herdr keys into one
// send-keys.
func inputSteps(items []proto.InputItem) ([]inputStep, error) {
	if len(items) == 0 || len(items) > maxInputItems {
		return nil, bad("input must have 1-%d items, got %d", maxInputItems, len(items))
	}
	var steps []inputStep
	total := 0
	for i, it := range items {
		switch {
		case (it.Text == nil) == (it.Key == nil):
			return nil, bad("input[%d] must be exactly one of text and key", i)
		case it.Text != nil:
			t := *it.Text
			if t == "" || len(t) > maxItemText || !herdr.ValidInputText(t) {
				return nil, bad("input[%d].text must be 1-%d bytes of UTF-8 without control characters (send those as keys), got %d bytes",
					i, maxItemText, len(t))
			}
			if total += len(t); total > maxInputText {
				return nil, bad("input text must be at most %d bytes in all", maxInputText)
			}
			if n := len(steps); n > 0 && steps[n-1].keys == nil && steps[n-1].seq == "" {
				steps[n-1].text += t
			} else {
				steps = append(steps, inputStep{text: t})
			}
		case herdr.IsKeyName(*it.Key):
			if n := len(steps); n > 0 && steps[n-1].keys != nil {
				steps[n-1].keys = append(steps[n-1].keys, *it.Key)
			} else {
				steps = append(steps, inputStep{keys: []string{*it.Key}})
			}
		case herdr.IsSequenceKey(*it.Key):
			steps = append(steps, inputStep{seq: *it.Key})
		default:
			// Not quoted: it may be anything the client typed.
			return nil, bad("input[%d].key (%d bytes) is not a key name (see docs/protocol.md \"Input\")", i, len(*it.Key))
		}
	}
	return steps, nil
}

// startKeys validates worker.keys and queues it on the worker's lane.
func (h *Hub) startKeys(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerKeysArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if strings.HasPrefix(a.ID, "mp:") {
		return bad("worker.keys does not accept manual process ids")
	}
	steps, err := inputSteps(a.Input)
	if err != nil {
		return err
	}
	if _, _, err := h.termWorker(a.ID); err != nil {
		return err
	}
	h.tookOver(ctx, a.ID)      // #83: a person types: an armed wrap-up is off
	h.agentTookOver(ctx, a.ID) // #224: and a handoff request
	h.clearFollowup(ctx, a.ID) // #90: and its follow-up questions are moot
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, session, pane string) (any, error) {
		t := h.opts.Term
		for i, s := range steps {
			var err error
			switch {
			case s.keys != nil:
				err = t.SendKeys(ctx, session, pane, s.keys...)
			case s.seq != "":
				err = t.SendSequence(ctx, session, pane, s.seq)
			default:
				err = t.SendText(ctx, session, pane, s.text)
			}
			if err != nil {
				return nil, fmt.Errorf("%w: herdr refused step %d of %d: %v", errInputFailed, i+1, len(steps), err)
			}
		}
		return nil, nil
	})
}

// startPrompt validates worker.prompt and queues it on the worker's lane.
// For a harness whose text is rewritten (#138) the text is translated on the
// lane, just before it is sent, and the limit and typing rules apply to the
// translated text.
func (h *Hub) startPrompt(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerPromptArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	handoff := func(ho promptHandoff) error {
		op := a.Op
		if op == "" {
			op = "prompt-" + randHex(8)
		}
		return h.startAgentHandoff(ctx, c, cmd, agentAsk{worker: a.ID, op: op, instruction: ho.instruction, prompt: true,
			settle: ho.settle, rev: ho.rev, answer: func(r proto.AgentHandoff, existing, queued bool) any {
				res := proto.PromptResult{Queued: queued, Handoff: &r, Existing: existing}
				if !existing { // #108: what this text became (an existing request used none of it)
					res.Sent, res.Protected = ho.sent, ho.protected
				}
				return res
			}})
	}
	return h.queuePrompt(ctx, a, handoff, h.endCommand(c, cmd))
}

// promptHandoff is a prompt that is a /handoff (#224), for its handoff
// callback: the instruction and (#108) what the review made of the prompt:
// the text sent in place of the typed one ("": as typed), how many ranges
// went to files, settle (nil: none), told how the request's command ends
// (agentAsk.settle), and the reviewer (agentAsk.rev).
type promptHandoff struct {
	instruction string
	sent        string
	protected   int
	settle      func(err error, existing bool)
	rev         *promptsecret.Reviewer
}

// promptReview is what the review made of a prompt (#108) for planPrompt:
// the text as typed (the prompt's own text is the one sent), how many
// ranges went to files, for a /handoff its settle, and the reviewer it was
// made under (nil: none), checked again right before the text goes.
type promptReview struct {
	typed     string
	protected int
	settle    func(err error, existing bool)
	rev       *promptsecret.Reviewer
}

// errHandoffInGame refuses a /handoff that does not come from the game
// (#13: a Telegram reply): the agent handoff is a client's command.
var errHandoffInGame = fmt.Errorf("%w: ask for a handoff in the game", errInvalidState)

// queuePrompt is worker.prompt's checks and its queueing on the worker's
// lane (hub goroutine), for a client's command and (#13) a Telegram reply
// alike: handoff starts a /handoff (nil: refused), end gets the outcome.
// #108: with prompt secrets reviewed (or a review given), the prompt goes
// through the gate first (queueReviewedPrompt).
func (h *Hub) queuePrompt(ctx context.Context, a proto.WorkerPromptArgs, handoff func(promptHandoff) error, end inputEnd) error {
	if h.gated(a.Secrets != nil || a.SecretsPending != "") {
		return h.queueReviewedPrompt(ctx, a, handoff, end)
	}
	work, err := h.planPrompt(ctx, a, promptReview{typed: a.Text}, handoff)
	if err != nil || work == nil {
		return err
	}
	return h.queueInput(ctx, a.ID, work, end)
}

// planPrompt is worker.prompt's checks and side effects for a.Text as it is
// sent (hub goroutine): the work to run on the worker's lane, or nil when
// the prompt became a /handoff (its request answers the command). r says
// what was typed (#108: the text before its secrets were protected, and how
// many went to files): PromptResult.Sent says so when the text sent is
// another, a /handoff's ack too.
func (h *Hub) planPrompt(ctx context.Context, a proto.WorkerPromptArgs, r promptReview, handoff func(promptHandoff) error) (inputWork, error) {
	if !h.promptSourceOK(a.Text) {
		return nil, badPromptText("text", len(a.Text))
	}
	w, _, err := h.termWorker(a.ID)
	if err != nil {
		return nil, err
	}
	if w.AgentKind == "" {
		return nil, fmt.Errorf("%w: %s runs no agent (a plain shell: use worker.keys)", errInvalidState, w.Name)
	}
	kind := w.AgentKind
	rewrites := h.rewrites(kind)
	if !rewrites {
		if !herdr.ValidMessage(a.Text) {
			return nil, badPromptText("text", len(a.Text))
		}
		if err := checkTyped(kind, a.Text, herdr.MaxMessage, "text"); err != nil {
			return nil, err
		}
	}
	if w.Ask != nil { // #57: its dialog would take the text
		return nil, fmt.Errorf("%w: %s %w: answer it first (worker.answer_ask)", errInvalidState, w.Name, errAskWaiting)
	}
	// #224: exactly "/handoff [instruction]" asks the agent for a handoff
	// the bridge files, before any translation.
	if instruction, ok := handoffCommand(a.Text); ok && h.ho.svc != nil {
		if handoff == nil {
			return nil, errHandoffInGame
		}
		ho := promptHandoff{instruction: instruction, protected: r.protected, settle: r.settle, rev: r.rev}
		if a.Text != r.typed {
			ho.sent = a.Text
		}
		return nil, handoff(ho)
	}
	// #140: a built-in whose output or dialog shows only in the terminal,
	// as typed: it starts no turn, so it is sent without waiting for one.
	terminal := h.opts.Prompts != nil && h.opts.Prompts.TerminalOnly(kind, a.Text)
	h.tookOver(ctx, a.ID)      // #83: a person prompts: an armed wrap-up is off
	h.agentTookOver(ctx, a.ID) // #224: and a handoff request
	h.clearFollowup(ctx, a.ID) // #90: and its follow-up questions are moot
	return func(ctx context.Context, session, pane string) (any, error) {
		if rewrites {
			text, err := h.composerPrompt(ctx, a.ID, kind, a.Text, "text")
			if err != nil {
				return nil, err
			}
			a.Text = text
		}
		send := h.prompt
		if terminal {
			send = h.terminalPrompt
		}
		res, err := send(ctx, a, session, pane, r.rev)
		if err == nil {
			// #58: its user line is read now, not on the tracker's next tick
			// (a watched transcript's is a second away).
			h.kickUsage()
			// #138: the transcript shows what was sent: say so when it is not
			// what was typed (#108: its secrets protected). #140: and when the
			// transcript will show nothing of it, so the game can show the
			// terminal.
			if pr, ok := res.(proto.PromptResult); ok {
				if a.Text != r.typed {
					pr.Sent = a.Text
				}
				pr.Terminal = terminal
				pr.Protected = r.protected
				res = pr
			}
		}
		return res, err
	}, nil
}

// typesPrompts reports whether prompts to an agent of this kind are typed
// (#95: Claude Code), not pasted with `agent prompt` (Codex).
func typesPrompts(kind string) bool { return kind == "claude" }

// checkTyped refuses a prompt to an agent of this kind that cannot be
// typed: a control character other than a line end or a tab, or longer
// than limit as typed (each tab is four spaces). what names the argument.
func checkTyped(kind, text string, limit int, what string) error {
	if !typesPrompts(kind) {
		return nil
	}
	norm, ok := herdr.NormalizeTyped(text)
	switch {
	case !ok:
		return bad("%s for Claude is typed: it must not be blank or hold control characters other than line ends and tabs (%d bytes)",
			what, len(text))
	case len(norm) > limit:
		return bad("%s for Claude is typed: it must be at most %d bytes as typed (a tab is four spaces), got %d", what, limit, len(norm))
	}
	return nil
}

// promptState is what a prompt needs of its worker now: its status
// (statusAsking while it has an ask, #57), its agent's kind, and how often
// herdr saw it start working or get blocked (#95).
type promptState struct {
	status, kind string
	starts       uint64
}

// promptState reads worker id (hub goroutine).
func (h *Hub) promptState(id string) promptState {
	w := h.workers[id]
	switch {
	case w == nil:
		return promptState{}
	case w.Ask != nil:
		return promptState{statusAsking, w.AgentKind, h.starts[id]}
	}
	return promptState{w.Status, w.AgentKind, h.starts[id]}
}

// started reports whether the worker started after since: working,
// blocked or asking now, or it started (and maybe ended) meanwhile.
func (p promptState) started(since uint64) bool {
	return p.status == statusWorking || p.status == statusBlocked || p.status == statusAsking || p.starts != since
}

// prompt submits a prompt. To an agent at work it is queued for its next
// turn; otherwise herdr waits for it to start working, and when the agent
// took the text but dropped the Enter (agent_prompt_stalled) Enter is
// pressed once more and the worker watched for PromptRetryWait. A prompt
// to Claude is typed (typePrompt). #108: a reviewed text's review (rev;
// nil: none) is checked last, right before any of it goes (stale: unsent).
func (h *Hub) prompt(ctx context.Context, a proto.WorkerPromptArgs, session, pane string, rev *promptsecret.Reviewer) (any, error) {
	cur, err := query(ctx, h, func() promptState { return h.promptState(a.ID) })
	if err != nil {
		return nil, unsent(err)
	}
	if typesPrompts(cur.kind) {
		return h.typePrompt(ctx, a.ID, session, pane, a.Text, false, rev)
	}
	if err := h.reviewHolds(rev, a.Text); err != nil {
		return nil, unsent(err)
	}
	t := h.opts.Term
	switch cur.status {
	case statusAsking:
		return nil, unsent(fmt.Errorf("%w: the worker %w: answer it first", errInvalidState, errAskWaiting))
	case statusBlocked:
		// #156: blocked only by a shared Codex worker's async question:
		// through its app-server (herdr would refuse it).
		if res, ok, err := h.promptViaServer(ctx, a.ID, a.Text, rev); ok {
			return res, err
		}
		return nil, unsent(fmt.Errorf("%w: the worker is blocked: answer its question first", errInvalidState))
	case statusWorking:
		if err := t.QueuePrompt(ctx, session, pane, a.Text); err != nil {
			return nil, fmt.Errorf("%w: %v", errPromptFailed, err)
		}
		return proto.PromptResult{Queued: true}, nil
	}
	err = t.SubmitPrompt(ctx, session, pane, a.Text)
	var api *herdr.APIError
	switch {
	case err == nil:
		return proto.PromptResult{}, nil
	case !errors.As(err, &api) || api.Code != "agent_prompt_stalled":
		return nil, fmt.Errorf("%w: %v", errPromptFailed, err)
	}
	return h.retryEnter(ctx, a.ID, session, pane, cur.starts, h.retryKeys(cur.kind, a.Text)...)
}

// notSentError is a prompt's error from before any of it reached the
// terminal (unsent): its text and kind are the error's. Any other failure
// may have left the text with the agent (#108: a reviewed /handoff's files
// then stay; agentAsk.settle).
type notSentError struct{ error }

func (e notSentError) Unwrap() error { return e.error }

// unsent marks err as from before any of a prompt reached the terminal.
func unsent(err error) error { return notSentError{err} }

// notSent reports an error marked unsent.
func notSent(err error) bool { return errors.As(err, new(notSentError)) }

// terminalPrompt sends a prompt that runs a terminal-only built-in (#140):
// it opens a dialog or prints in the terminal, and starts no turn. It is
// typed (Claude, typeIn) or pasted (Codex, `agent prompt` without waiting)
// with its one Enter, and done once herdr delivered it: nothing waits for a
// turn, and Enter is never pressed again, as it would act on the dialog. To
// a working agent it goes as any prompt does (queued): the CLI runs it, or
// refuses it, in its terminal.
func (h *Hub) terminalPrompt(ctx context.Context, a proto.WorkerPromptArgs, session, pane string, rev *promptsecret.Reviewer) (any, error) {
	cur, err := query(ctx, h, func() promptState { return h.promptState(a.ID) })
	if err != nil {
		return nil, err
	}
	if typesPrompts(cur.kind) {
		if cur, err = h.typeIn(ctx, a.ID, session, pane, a.Text, false, rev); err != nil {
			return nil, err
		}
		return proto.PromptResult{Queued: cur.status == statusWorking}, nil
	}
	switch cur.status {
	case statusAsking:
		return nil, fmt.Errorf("%w: the worker %w: answer it first", errInvalidState, errAskWaiting)
	case statusBlocked:
		return nil, fmt.Errorf("%w: the worker is blocked: answer its question first", errInvalidState)
	}
	if err := h.reviewHolds(rev, a.Text); err != nil {
		return nil, unsent(err)
	}
	if err := h.opts.Term.QueuePrompt(ctx, session, pane, a.Text); err != nil {
		return nil, fmt.Errorf("%w: %v", errPromptFailed, err)
	}
	return proto.PromptResult{Queued: cur.status == statusWorking}, nil
}

// retryEnter presses keys (Enter, or what a harness needs before it: #138)
// once more for an agent that took a prompt's text but dropped the Enter,
// and watches the worker for PromptRetryWait. since is the worker's start
// counter when the prompt began: if the worker has started meanwhile (the
// prompt was only slow), nothing is pressed, as the keys may hold an Esc
// that would abort its turn, and the prompt counts as started.
func (h *Hub) retryEnter(ctx context.Context, id, session, pane string, since uint64, keys ...string) (any, error) {
	cur, err := query(ctx, h, func() promptState { return h.promptState(id) })
	if err != nil {
		return nil, err
	}
	if cur.started(since) {
		return proto.PromptResult{}, nil
	}
	if err := h.opts.Term.SendKeys(ctx, session, pane, keys...); err != nil {
		return nil, fmt.Errorf("%w: the agent dropped Enter, and pressing it again failed: %v", errPromptFailed, err)
	}
	started, err := h.awaitStarted(ctx, id, cur.starts, h.opts.PromptRetryWait)
	switch {
	case err != nil:
		return nil, err
	case !started:
		return nil, fmt.Errorf("%w: the text is in the agent's input, but it did not start working, Enter pressed again", errPromptFailed)
	}
	return proto.PromptResult{Retried: true}, nil
}

// awaitStarted watches a worker for up to wait for it to start after since
// (promptState.started).
func (h *Hub) awaitStarted(ctx context.Context, id string, since uint64, wait time.Duration) (bool, error) {
	for end := time.Now().Add(wait); ; {
		cur, err := query(ctx, h, func() promptState { return h.promptState(id) })
		if err != nil {
			return false, err
		}
		if cur.started(since) {
			return true, nil
		}
		if time.Now().After(end) || ctx.Err() != nil {
			return false, ctx.Err()
		}
		sleepCtx(ctx, answerPoll)
	}
}

// typePrompt types a prompt into a Claude worker's pane (#95, on its input
// lane, so nothing else is typed between two chunks). It waits up to
// PromptReadyWait for the agent to be ready: idle or done, then the text
// is typed and the worker watched for PromptAckWait to start working
// (Enter pressed once more if not, as for a stalled `agent prompt`); or
// working, then it is typed for Claude to queue, without waiting. A
// blocked worker, or one with an ask, is refused, unless settling: then
// (a dialog just answered) it is waited out like any other state.
func (h *Hub) typePrompt(ctx context.Context, id, session, pane, text string, settling bool, rev *promptsecret.Reviewer) (any, error) {
	cur, err := h.typeIn(ctx, id, session, pane, text, settling, rev)
	if err != nil {
		return nil, err
	}
	if cur.status == statusWorking {
		return proto.PromptResult{Queued: true}, nil
	}
	started, err := h.awaitStarted(ctx, id, cur.starts, h.opts.PromptAckWait)
	switch {
	case err != nil:
		return nil, err
	case started:
		return proto.PromptResult{}, nil
	}
	return h.retryEnter(ctx, id, session, pane, cur.starts, "enter")
}

// typeIn is typePrompt up to its Enter: it waits for the agent to be ready
// and types text, and returns the worker's state from before it typed.
// #108 review B2: a reviewed text's review (rev; nil: none) is checked
// once the agent is ready, right before the text is typed.
func (h *Hub) typeIn(ctx context.Context, id, session, pane, text string, settling bool, rev *promptsecret.Reviewer) (promptState, error) {
	var cur promptState
	for end := time.Now().Add(h.opts.PromptReadyWait); ; {
		var err error
		if cur, err = query(ctx, h, func() promptState { return h.promptState(id) }); err != nil {
			return cur, unsent(err)
		}
		s := cur.status
		switch {
		case s == statusAsking && !settling:
			return cur, unsent(fmt.Errorf("%w: the worker %w: answer it first", errInvalidState, errAskWaiting))
		case s == statusBlocked && !settling:
			return cur, unsent(fmt.Errorf("%w: the worker is blocked: answer its question first", errInvalidState))
		}
		if s == statusWorking || s == statusIdle || s == statusDone {
			break
		}
		if time.Now().After(end) || ctx.Err() != nil {
			return cur, unsent(fmt.Errorf("%w: the agent is not ready for a prompt (herdr says %q)", errPromptFailed, s))
		}
		sleepCtx(ctx, answerPoll)
	}
	t := h.opts.Term
	if err := h.eraseDirty(ctx, id, session, pane, t.EraseTyped); err != nil {
		return cur, unsent(err) // an earlier prompt's leftovers: none of this one is typed
	}
	var stale error
	if err := h.doWait(ctx, func() {
		if stale = h.reviewHolds(rev, text); stale == nil {
			h.noteTyped(id, text)
		}
	}); err != nil {
		return cur, unsent(err)
	}
	if stale != nil {
		return cur, unsent(stale)
	}
	if err := t.TypePrompt(ctx, session, pane, text); err != nil {
		h.erasePartlyTyped(ctx, id, session, pane, err, t.EraseTyped)
		return cur, fmt.Errorf("%w: %v", errPromptFailed, err)
	}
	return cur, nil
}

// auditArgs is what the audit log keeps of a command's args: everything,
// except what a person typed (worker.keys and worker.prompt keep its
// lengths and the key names).
func auditArgs(cmd proto.Command) json.RawMessage {
	switch cmd.T {
	// #108 round 2: a hire's prompt (a schedule's fire's too, whose args
	// name the schedule), a run's texts and a stored prompt by their
	// lengths, never their text, with the switch on or off; a review by its
	// decisions' counts.
	case proto.CmdWorkerHire, proto.CmdHirePresetCreate, proto.CmdHirePresetUpdate, proto.CmdScheduleCreate, proto.CmdScheduleUpdate:
		return auditTexts(cmd.Args, "prompt")
	case proto.CmdScheduleRetry, proto.CmdScheduleRunNow: // a review of the stored prompt, by its counts
		return auditTexts(cmd.Args)
	case proto.CmdRunPrepare, proto.CmdRunStart:
		return auditTexts(cmd.Args, "text", "extra", "prompt")
	case proto.CmdWorkerHandoff: // #224, #9: the instruction is free text: its length only
		var a proto.WorkerHandoffArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(struct {
			Worker           string        `json:"worker"`
			Mode             string        `json:"mode"`
			Session          string        `json:"session,omitempty"`
			Candidate        string        `json:"candidate,omitempty"`
			Revision         string        `json:"revision,omitempty"`
			InstructionBytes int           `json:"instruction_bytes,omitempty"`
			SendHome         bool          `json:"send_home,omitempty"`
			Op               string        `json:"op"`
			Secrets          *secretsAudit `json:"secrets,omitempty"` // #108 round 2
		}{clip(a.Worker), clip(a.Mode), clip(a.Session), clip(a.Candidate), clip(a.Revision), len(a.Instruction), a.SendHome, clip(a.Op),
			auditReviews(a.Secrets)})
	case proto.CmdTerminalInput:
		var a proto.TerminalInputArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		n := 0
		if a.Text != nil {
			n = len(*a.Text)
		}
		if a.Bytes != nil {
			n += len(*a.Bytes)
		}
		return mustJSON(struct {
			ID    string `json:"id"`
			Bytes int    `json:"bytes"`
		}{clip(a.ID), n})
	case proto.CmdWorkerKeys:
		var a proto.WorkerKeysArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		type item struct {
			TextBytes *int   `json:"text_bytes,omitempty"`
			Key       string `json:"key,omitempty"`
		}
		out := struct {
			ID    string `json:"id"`
			Input []item `json:"input"`
		}{ID: a.ID, Input: make([]item, 0, len(a.Input))}
		for _, it := range a.Input {
			var i item
			if it.Text != nil {
				n := len(*it.Text)
				i.TextBytes = &n
			}
			if it.Key != nil {
				i.Key = clip(*it.Key)
				if !herdr.IsKeyName(i.Key) && !herdr.IsSequenceKey(i.Key) {
					i.Key = fmt.Sprintf("(not a key, %d bytes)", len(*it.Key))
				}
			}
			out.Input = append(out.Input, i)
		}
		return mustJSON(out)
	case proto.CmdWorkerPrompt:
		var a proto.WorkerPromptArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		out := struct {
			ID        string `json:"id"`
			TextBytes int    `json:"text_bytes"`
			TextRunes int    `json:"text_runes"`
			// #108: how many decisions of each action, never a range.
			Protect *int `json:"secrets_protect,omitempty"`
			Ignore  *int `json:"secrets_ignore,omitempty"`
		}{ID: a.ID, TextBytes: len(a.Text), TextRunes: utf8.RuneCountInString(a.Text)}
		if a.Secrets != nil {
			var protect, ignore int
			for _, d := range a.Secrets.Decisions {
				if d.Action == proto.SecretIgnore {
					ignore++
				} else {
					protect++
				}
			}
			out.Protect, out.Ignore = &protect, &ignore
		}
		return mustJSON(out)
	// #108: the scanned text by its lengths, never its text.
	case proto.CmdPromptSecretsScan:
		var a proto.PromptSecretsScanArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(struct {
			TextBytes int `json:"text_bytes"`
			TextRunes int `json:"text_runes"`
		}{len(a.Text), utf8.RuneCountInString(a.Text)})
	// #156: the question ids and the answers' lengths, never the answers.
	case proto.CmdWorkerAnswerAsync:
		var a proto.WorkerAnswerAsyncArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		type answer struct {
			Index       *int `json:"index"`
			AnswerBytes int  `json:"answer_bytes"`
		}
		out := struct {
			ID      string        `json:"id"`
			Thread  string        `json:"thread"`
			Batch   string        `json:"batch"`
			Answers []answer      `json:"answers,omitempty"`
			Secrets *secretsAudit `json:"secrets,omitempty"` // #108 round 2
		}{ID: a.ID, Thread: clip(a.Thread), Batch: clip(a.Batch), Secrets: auditReviewMap(a.Secrets)}
		for _, x := range a.Answers {
			out.Answers = append(out.Answers, answer{x.Index, len(x.Answer)})
		}
		return mustJSON(out)
	// #57: the picks and the typed texts' lengths, never the texts.
	case proto.CmdWorkerAnswerAsk:
		var a proto.WorkerAnswerAskArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		type answer struct {
			Question   int   `json:"question"`
			Choices    []int `json:"choices,omitempty"`
			OtherBytes *int  `json:"other_bytes,omitempty"`
		}
		out := struct {
			ID          string        `json:"id"`
			ToolUseID   string        `json:"tool_use_id"`
			Answers     []answer      `json:"answers,omitempty"`
			Cancel      bool          `json:"cancel,omitempty"`
			PromptBytes int           `json:"prompt_bytes,omitempty"`
			Secrets     *secretsAudit `json:"secrets,omitempty"` // #108 round 2
		}{ID: a.ID, ToolUseID: clip(a.ToolUseID), Cancel: a.Cancel, PromptBytes: len(a.Prompt), Secrets: auditReviewMap(a.Secrets)}
		for _, x := range a.Answers {
			an := answer{Question: x.Question, Choices: x.Choices}
			if x.Other != nil {
				n := len(*x.Other)
				an.OtherBytes = &n
			}
			out.Answers = append(out.Answers, an)
		}
		return mustJSON(out)
	// M13 whiteboard: an agent's note by its length, never its text.
	case proto.CmdWhiteboardPin:
		var a proto.WhiteboardPinArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(struct {
			Floor     string `json:"floor"`
			Author    string `json:"author"`
			Kind      string `json:"kind"`
			Bytes     int    `json:"bytes"`
			RequestID string `json:"request_id,omitempty"`
		}{clip(a.Floor), clip(a.Author), "note", len(a.Note), clip(a.RequestID)})
	// #83: the prompt by its length, never its text.
	case proto.CmdWorkerWrapUp:
		var a proto.WorkerWrapUpArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(struct {
			ID             string        `json:"id"`
			Worktree       string        `json:"worktree,omitempty"`
			PromptBytes    int           `json:"prompt_bytes"`
			Secrets        *secretsAudit `json:"secrets,omitempty"`         // #108 round 2
			SecretsPending bool          `json:"secrets_pending,omitempty"` // round 5: a hand-over, never its token
		}{a.ID, clip(a.Worktree), len(a.Prompt), auditReviews(a.Secrets), a.SecretsPending != ""})
	// #92: the role and the fields named, never the key.
	case proto.CmdAIModels, proto.CmdAITest, proto.CmdAISet, proto.CmdAIClear:
		return auditAI(cmd)
	// #184: the instance and whether a key was given, never the key.
	case proto.CmdKaneoTest, proto.CmdKaneoSet:
		return auditKaneo(cmd)
	case proto.CmdNotifyTokenSet: // #11: the bot token is never logged
		return auditNotifyArgs(cmd)
	// #90: the answers by their lengths, never their text.
	case proto.CmdWorkerAnswerFollowup:
		return auditFollowup(cmd)
	// #110: the prompt by its length, never its text.
	case proto.CmdPackupDetect:
		return auditPackupDetect(cmd)
	// #211: the dictated text by its length, never its text.
	case proto.CmdHireInterpret:
		return auditHireInterpret(cmd)
	// #95: the preset's prompt by its length, never its text.
	case proto.CmdHirePresetCheck:
		return auditHirePresetCheck(cmd)
	// M16 transcript: the worker id only (#26: and a child's target).
	case proto.CmdTranscriptWatch, proto.CmdTranscriptUnwatch:
		var a struct {
			ID    string                 `json:"id"`
			Child *proto.TranscriptChild `json:"child,omitempty"`
		}
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(a)
	// M7 boards: the target and the byte counts, never a body.
	case proto.CmdIssueComment, proto.CmdPRComment:
		var a proto.CommentArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(struct {
			Session   string `json:"session"`
			ID        string `json:"id"`
			BodyBytes int    `json:"body_bytes"`
		}{a.Session, a.ID, len(a.Body)})
	case proto.CmdWorkerOpenPR:
		var a proto.OpenPRArgs
		if json.Unmarshal(cmd.Args, &a) != nil {
			return redacted(cmd.Args)
		}
		return mustJSON(struct {
			ID         string `json:"id"`
			TitleBytes int    `json:"title_bytes"`
			BodyBytes  int    `json:"body_bytes"`
			Confirm    bool   `json:"confirm"`
		}{a.ID, len(a.Title), len(a.Body), a.Confirm})
	}
	return cmd.Args
}

// auditTexts is a command's args with each named text field as its length
// ("<name>_bytes") and its review (`secrets`: one, or one per field) as
// the decisions' counts (#108 round 2): never a typed text nor a range.
// Args that do not read as an object are redacted.
func auditTexts(raw json.RawMessage, texts ...string) json.RawMessage {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || m == nil {
		return redacted(raw)
	}
	for _, k := range texts {
		v, ok := m[k]
		if !ok {
			continue
		}
		var s string
		if json.Unmarshal(v, &s) != nil {
			return redacted(raw)
		}
		delete(m, k)
		m[k+"_bytes"] = mustJSON(len(s))
	}
	if v, ok := m["secrets"]; ok {
		var many proto.SecretsReviews
		var one proto.SecretsReview
		switch {
		case json.Unmarshal(v, &many) == nil:
			m["secrets"] = mustJSON(auditReviewMap(many))
		case json.Unmarshal(v, &one) == nil:
			m["secrets"] = mustJSON(auditReviews(&one))
		default:
			return redacted(raw)
		}
	}
	return mustJSON(m)
}

func redacted(raw json.RawMessage) json.RawMessage {
	return mustJSON(map[string]any{"redacted": true, "bytes": len(raw)})
}
