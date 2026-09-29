package server

// M5 term: typing into a worker's pane from its laptop (worker.keys),
// prompting its agent (worker.prompt). Input to one worker is serialized
// on its input lane, answers (worker.answer) included.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
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

var (
	errInputFailed  = errors.New("input failed")
	errPromptFailed = errors.New("prompt failed")
	errStale        = errors.New("stale")
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

// startInput queues work on the worker's input lane (hub goroutine). The
// work gets the worker's pane as it is when its turn comes; its audit row
// and reply follow when it is done.
func (h *Hub) startInput(ctx context.Context, c *Client, cmd proto.Command, id string,
	work func(ctx context.Context, session, pane string) (any, error)) error {
	l := h.lanes[id]
	if l == nil {
		l = &inputLane{}
		h.lanes[id] = l
	}
	if len(l.jobs) >= maxQueuedInputs {
		return fmt.Errorf("%w: %d commands are already waiting for this worker", errInputFailed, len(l.jobs))
	}
	l.jobs = append(l.jobs, func(ctx context.Context) {
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
		if derr := h.doWait(ctx, func() {
			h.audit(ctx, c, cmd, err)
			h.reply(c, cmd, data, err)
		}); derr != nil {
			h.log.Warn("command abandoned", "cmd", cmd.T, "err", derr)
		}
	})
	if !l.running {
		l.running = true
		h.wg.Add(1)
		go h.runLane(ctx, id)
	}
	return nil
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
			return nil, bad("input[%d].key %q is not a key name (see docs/protocol.md \"Input\")", i, clip(*it.Key))
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
	steps, err := inputSteps(a.Input)
	if err != nil {
		return err
	}
	if _, _, err := h.termWorker(a.ID); err != nil {
		return err
	}
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
func (h *Hub) startPrompt(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerPromptArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !herdr.ValidMessage(a.Text) {
		return bad("text must be 1-%d bytes of UTF-8 without NUL, got %d bytes", herdr.MaxMessage, len(a.Text))
	}
	w, _, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	if w.AgentKind == "" {
		return fmt.Errorf("%w: %s runs no agent (a plain shell: use worker.keys)", errInvalidState, w.Name)
	}
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, session, pane string) (any, error) {
		return h.prompt(ctx, a, session, pane)
	})
}

// prompt submits a prompt. To an agent at work it is queued for its next
// turn; otherwise herdr waits for it to start working, and when the agent
// took the text but dropped the Enter (agent_prompt_stalled) Enter is
// pressed once more and the worker watched for PromptRetryWait.
func (h *Hub) prompt(ctx context.Context, a proto.WorkerPromptArgs, session, pane string) (any, error) {
	status, err := query(ctx, h, func() string {
		if w := h.workers[a.ID]; w != nil {
			return w.Status
		}
		return ""
	})
	if err != nil {
		return nil, err
	}
	t := h.opts.Term
	switch status {
	case statusBlocked:
		return nil, fmt.Errorf("%w: the worker is blocked: answer its question first", errInvalidState)
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
	if err := t.SendKeys(ctx, session, pane, "enter"); err != nil {
		return nil, fmt.Errorf("%w: the agent dropped Enter, and pressing it again failed: %v", errPromptFailed, err)
	}
	for end := time.Now().Add(h.opts.PromptRetryWait); ; {
		s, err := query(ctx, h, func() string {
			if w := h.workers[a.ID]; w != nil {
				return w.Status
			}
			return ""
		})
		if err != nil {
			return nil, err
		}
		if s == statusWorking || s == statusBlocked {
			return proto.PromptResult{Retried: true}, nil
		}
		if time.Now().After(end) {
			return nil, fmt.Errorf("%w: the text is in the agent's input, but it did not start working, Enter pressed again", errPromptFailed)
		}
		sleepCtx(ctx, answerPoll)
	}
}

// auditArgs is what the audit log keeps of a command's args: everything,
// except what a person typed (worker.keys and worker.prompt keep its
// lengths and the key names).
func auditArgs(cmd proto.Command) json.RawMessage {
	switch cmd.T {
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
		return mustJSON(struct {
			ID        string `json:"id"`
			TextBytes int    `json:"text_bytes"`
			TextRunes int    `json:"text_runes"`
		}{a.ID, len(a.Text), utf8.RuneCountInString(a.Text)})
	}
	return cmd.Args
}

func redacted(raw json.RawMessage) json.RawMessage {
	return mustJSON(map[string]any{"redacted": true, "bytes": len(raw)})
}
