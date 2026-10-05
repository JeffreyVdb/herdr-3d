package server

// #57: a worker's ask (the structured question its agent's latest turn
// waits on, read from its transcript by the usage tracker: Worker.Ask), and
// answering it (worker.answer_ask): the bridge drives the agent's dialog on
// the worker's input lane, reading its screen between key steps.

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// Timings of worker.answer_ask.
const (
	// DefaultAskStepTimeout is how long the dialog has to show what a key
	// step should make it show.
	DefaultAskStepTimeout = 3 * time.Second
	// DefaultAskResolveTimeout is how long the transcript has to record the
	// call's result once the last key is pressed.
	DefaultAskResolveTimeout = 8 * time.Second
	askPoll                  = 100 * time.Millisecond
	askKickEvery             = 250 * time.Millisecond
	// askSettle is how long typed text is left before Enter: an agent that
	// takes a paste may drop an Enter that follows it at once.
	askSettle = 300 * time.Millisecond
)

var toolUseIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// askShown is what the tracker last published of a worker's ask.
type askShown struct {
	ask      *proto.Ask
	resolved string
}

// askUpdate is a worker's ask now (nil: none), and the last call whose
// result its transcript recorded.
type askUpdate struct {
	id       string
	ask      *proto.Ask
	resolved string
}

// offerAsk queues worker w's ask for publishing when it changed (usage
// tracker goroutine, after its session's Poll).
func (tr *usageTracker) offerAsk(w usageWorker) {
	var a *proto.Ask
	var resolved string
	if t := tr.asks[w.id]; t != nil {
		a, resolved = t.Pending(), t.Resolved()
	}
	prev, ok := tr.askShown[w.id]
	if ok && reflect.DeepEqual(prev.ask, a) && prev.resolved == resolved && (a != nil) == w.asking {
		return
	}
	if !ok && a == nil && resolved == "" && !w.asking {
		return
	}
	tr.askShown[w.id] = askShown{ask: a, resolved: resolved}
	tr.askUps = append(tr.askUps, askUpdate{id: w.id, ask: a, resolved: resolved})
}

// setAsk publishes a worker's ask when it changed (worker.upsert; hub
// goroutine).
func (h *Hub) setAsk(id string, a *proto.Ask, resolved string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	if resolved != "" {
		h.askResolved[id] = resolved
	}
	if reflect.DeepEqual(w.Ask, a) {
		return
	}
	next := *w
	next.Ask = a
	h.workers[id] = &next
	if a == nil {
		delete(h.asks, id)
	} else {
		h.asks[id] = a
	}
	h.emit(proto.Event{T: proto.EvWorkerUpsert, Worker: &next})
}

// askAnswer is a validated answer to one question.
type askAnswer struct {
	choices []int
	other   *string
}

// checkAnswers validates worker.answer_ask's answers against the ask: one
// for every question, in the dialog's terms.
func checkAnswers(ask *proto.Ask, args []proto.AskAnswerArg) ([]askAnswer, error) {
	if len(args) != len(ask.Questions) {
		return nil, bad("answers must answer each of the %d questions once, got %d", len(ask.Questions), len(args))
	}
	out := make([]askAnswer, len(ask.Questions))
	seen := map[int]bool{}
	for i, a := range args {
		if a.Question < 0 || a.Question >= len(ask.Questions) || seen[a.Question] {
			return nil, bad("answers[%d].question must be a question's index (0-%d), once each", i, len(ask.Questions)-1)
		}
		seen[a.Question] = true
		q := ask.Questions[a.Question]
		picked := map[int]bool{}
		for _, c := range a.Choices {
			if c < 1 || c > len(q.Options) || picked[c] {
				return nil, bad("answers[%d].choices must be option numbers 1-%d, once each", i, len(q.Options))
			}
			picked[c] = true
		}
		n := len(a.Choices)
		if a.Other != nil {
			n++
			t := *a.Other
			switch {
			case !q.Other:
				return nil, bad("question %d takes no typed answer", a.Question)
			case t == "" || strings.TrimSpace(t) == "" || len(t) > proto.MaxAskOther || !herdr.ValidInputText(t):
				// Not quoted: it is what the player typed.
				return nil, bad("answers[%d].other must be 1-%d bytes of text on one line, without control characters", i, proto.MaxAskOther)
			case !q.Multi && len(a.Choices) > 0:
				return nil, bad("answers[%d]: a typed answer is instead of a choice", i)
			}
		}
		switch {
		case n == 0:
			return nil, bad("answers[%d] picks nothing", i)
		case !q.Multi && n > 1:
			return nil, bad("question %d takes one answer", a.Question)
		}
		ch := slices.Clone(a.Choices)
		slices.Sort(ch)
		out[a.Question] = askAnswer{choices: ch, other: a.Other}
	}
	return out, nil
}

// startAnswerAsk validates worker.answer_ask and queues it on the worker's
// input lane.
func (h *Hub) startAnswerAsk(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.WorkerAnswerAskArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !toolUseIDRe.MatchString(a.ToolUseID) {
		return bad("tool_use_id must be the ask's tool_use_id")
	}
	switch {
	case a.Cancel && len(a.Answers) > 0:
		return bad("want answers or cancel: true, not both")
	case !a.Cancel && len(a.Answers) == 0:
		return bad("want answers (one per question) or cancel: true")
	case a.Prompt != "" && !a.Cancel:
		return bad("a prompt goes only with cancel")
	case a.Prompt != "" && !h.promptSourceOK(a.Prompt):
		// The limit is on the translated text (answerAsk checks it, #138).
		return badPromptText("prompt", len(a.Prompt))
	}
	w, _, err := h.termWorker(a.ID)
	if err != nil {
		return err
	}
	switch {
	case w.Ask == nil:
		return fmt.Errorf("%w: %s is not asking anything now", errStale, w.Name)
	case w.Ask.ToolUseID != a.ToolUseID:
		return fmt.Errorf("%w: %s asks another question now (tool_use_id %s)", errStale, w.Name, w.Ask.ToolUseID)
	}
	if a.Prompt != "" && !h.rewrites(w.AgentKind) {
		// Not translated: its limit and typing rules apply to it as it is.
		if !herdr.ValidMessage(a.Prompt) {
			return badPromptText("prompt", len(a.Prompt))
		}
		if w.Ask.Agent == proto.AskClaude {
			if err := checkTyped(proto.AskClaude, a.Prompt, herdr.MaxMessage, "prompt"); err != nil {
				return err
			}
		}
	}
	var answers []askAnswer
	if !a.Cancel {
		if answers, err = checkAnswers(w.Ask, a.Answers); err != nil {
			return err
		}
	}
	return h.startInput(ctx, c, cmd, a.ID, func(ctx context.Context, session, pane string) (any, error) {
		return h.answerAsk(ctx, a, answers, session, pane)
	})
}

// askDriver presses keys into one worker's dialog, reading its screen
// between steps.
type askDriver struct {
	h             *Hub
	ctx           context.Context
	id, toolUseID string
	session, pane string
	sent          []string
}

// current is the worker's ask now, if it is still the one being answered.
func (d *askDriver) current() (bool, error) {
	return query(d.ctx, d.h, func() bool {
		w := d.h.workers[d.id]
		return w != nil && w.PaneID == d.pane && w.Ask != nil && w.Ask.ToolUseID == d.toolUseID
	})
}

// press sends keys, only while the ask is still the one being answered.
func (d *askDriver) press(keys ...string) error {
	still, err := d.current()
	if err != nil {
		return err
	}
	if !still {
		return fmt.Errorf("%w: the question was answered or replaced meanwhile (no more keys pressed)", errStale)
	}
	if err := d.h.opts.Term.SendKeys(d.ctx, d.session, d.pane, keys...); err != nil {
		return fmt.Errorf("%w: %v", errInputFailed, err)
	}
	d.sent = append(d.sent, keys...)
	return nil
}

func (d *askDriver) typeText(text string) error {
	still, err := d.current()
	if err != nil {
		return err
	}
	if !still {
		return fmt.Errorf("%w: the question was answered or replaced meanwhile (no more keys pressed)", errStale)
	}
	if err := d.h.opts.Term.SendText(d.ctx, d.session, d.pane, text); err != nil {
		return fmt.Errorf("%w: %v", errInputFailed, err)
	}
	d.sent = append(d.sent, "text")
	return nil
}

// waitFor reads the screen until ok says it shows what the last step
// should have made it show: input_failed after AskStepTimeout, stale as
// soon as the ask is answered or replaced some other way.
func (d *askDriver) waitFor(what string, ok func(screen string) bool) error {
	return d.wait(what, ok, false)
}

// waitGone is waitFor for the dialog's end: the ask resolving is fine.
func (d *askDriver) waitGone(what string, ok func(screen string) bool) error {
	return d.wait(what, ok, true)
}

func (d *askDriver) wait(what string, ok func(screen string) bool, goneOK bool) error {
	end := time.Now().Add(d.h.opts.AskStepTimeout)
	for {
		screen, err := d.h.opts.Term.ReadPane(d.ctx, d.session, d.pane)
		if err == nil && ok(screen) {
			return nil
		}
		still, qerr := d.current()
		switch {
		case qerr != nil:
			return qerr
		case !still && goneOK:
			return nil
		case !still:
			return fmt.Errorf("%w: the question was answered or replaced meanwhile (no more keys pressed)", errStale)
		}
		if time.Now().After(end) {
			if err != nil {
				return fmt.Errorf("%w: reading the screen failed: %v", errInputFailed, err)
			}
			return fmt.Errorf("%w: the dialog did not show %s (keys sent: %s); look at the terminal", errInputFailed, what, strings.Join(d.sent, " "))
		}
		sleepCtx(d.ctx, askPoll)
	}
}

func (d *askDriver) settle() { sleepCtx(d.ctx, askSettle) }

func digit(n int) string { return strconv.Itoa(n) }

// labelIs reports whether a row shows typed text: the whole of it, or (a
// long one the row cuts) its start.
func labelIs(label, text string) bool {
	a, b := collapse(label), collapse(text)
	return a == b || (len(a) >= 16 && strings.HasPrefix(b, strings.TrimSuffix(a, "…")))
}

// answerAsk answers the ask on the worker's lane: the ask checked again,
// the dialog driven, then the transcript watched for the call's result.
func (h *Hub) answerAsk(ctx context.Context, a proto.WorkerAnswerAskArgs, answers []askAnswer, session, pane string) (any, error) {
	ask, err := query(ctx, h, func() *proto.Ask {
		if w := h.workers[a.ID]; w != nil && w.PaneID == pane {
			return w.Ask
		}
		return nil
	})
	switch {
	case err != nil:
		return nil, err
	case ask == nil:
		return nil, fmt.Errorf("%w: the question was answered meanwhile", errStale)
	case ask.ToolUseID != a.ToolUseID:
		return nil, fmt.Errorf("%w: it asks another question now (tool_use_id %s)", errStale, ask.ToolUseID)
	}
	// #138: the composer's text, for its harness, and its limit checked now:
	// a prompt that cannot be sent is refused before the dialog is touched.
	var prompt string
	if a.Prompt != "" {
		if prompt, err = h.composerPrompt(ctx, a.ID, ask.Agent, a.Prompt, "prompt"); err != nil {
			return nil, err
		}
	}
	d := &askDriver{h: h, ctx: ctx, id: a.ID, toolUseID: a.ToolUseID, session: session, pane: pane}
	switch {
	case ask.Agent == proto.AskCodex && a.Cancel:
		err = d.codexCancel(ask)
	case ask.Agent == proto.AskCodex:
		err = d.codex(ask, answers)
	case a.Cancel:
		err = d.claudeCancel(ask)
	default:
		err = d.claude(ask, answers)
	}
	if err != nil {
		return nil, err
	}
	res := proto.AnswerAskResult{Sent: d.sent}
	if res.Resolved, err = h.waitAskResolved(ctx, a.ID, a.ToolUseID); err != nil {
		return nil, err
	}
	if a.Prompt != "" && res.Resolved {
		if ask.Agent == proto.AskClaude { // #95: typed, once the dismissed dialog is gone
			if _, err := h.typePrompt(ctx, a.ID, session, pane, prompt, true); err != nil {
				return nil, fmt.Errorf("%w: dismissed, but the prompt was not sent: %v", errPromptFailed, err)
			}
		} else if err := h.submitAfterAsk(ctx, a.ID, session, pane, ask.Agent, prompt); err != nil {
			return nil, err
		}
		res.Prompted = true
	}
	return res, nil
}

// submitAfterAsk submits a Codex prompt once its dismissed dialog is gone.
// A prompt that stalled gets the harness's retry keys when they are more
// than a lone Enter (a popup the text left open took the Enter: close it,
// submit), unless the worker started meanwhile (promptState.started, since
// its start counter before the submit): the prompt was only slow, and an Esc
// would abort its turn (#138).
func (h *Hub) submitAfterAsk(ctx context.Context, id, session, pane, kind, prompt string) error {
	before, err := query(ctx, h, func() promptState { return h.promptState(id) })
	if err != nil {
		return err
	}
	err = h.opts.Term.SubmitPrompt(ctx, session, pane, prompt)
	if err == nil {
		return nil
	}
	var api *herdr.APIError
	if !errors.As(err, &api) || api.Code != "agent_prompt_stalled" {
		return fmt.Errorf("%w: dismissed, but the prompt was not sent: %v", errPromptFailed, err)
	}
	keys := h.retryKeys(kind, prompt)
	if slices.Equal(keys, []string{"enter"}) {
		return nil
	}
	cur, err := query(ctx, h, func() promptState { return h.promptState(id) })
	switch {
	case err != nil:
		return fmt.Errorf("%w: dismissed, but the prompt was not sent: %v", errPromptFailed, err)
	case cur.started(before.starts):
		return nil
	}
	if err := h.opts.Term.SendKeys(ctx, session, pane, keys...); err != nil {
		return fmt.Errorf("%w: dismissed, but the prompt was not sent: %v", errPromptFailed, err)
	}
	return nil
}

// waitAskResolved watches for the transcript to record the call's result
// (the usage tracker kicked for a round now and then).
func (h *Hub) waitAskResolved(ctx context.Context, id, toolUseID string) (bool, error) {
	end := time.Now().Add(h.opts.AskResolveTimeout)
	var kicked time.Time
	for {
		done, err := query(ctx, h, func() bool { return h.askResolved[id] == toolUseID })
		if err != nil {
			return false, err
		}
		if done {
			return true, nil
		}
		if time.Now().After(end) {
			return false, nil
		}
		if time.Since(kicked) >= askKickEvery {
			h.kickUsage()
			kicked = time.Now()
		}
		sleepCtx(ctx, askPoll)
	}
}

// claude drives Claude Code's AskUserQuestion dialog (keys verified live,
// see the grounding of #57 and testdata/screens/claude-ask-*): a
// single-select question takes its option's digit and moves on (a preview
// question's digit only moves the cursor: Enter); Other is its digit ("Type
// something."), the text, Enter. A multi-select question's digits toggle
// without moving the cursor, one per herdr call (several in one call were
// dropped live), and untick what the answer does not have (Other's row
// too); → leaves it, or with Other: arrows to its row, the text, Enter if
// that left it unticked, Tab to the Submit row, Enter. An Other row that
// holds other text (typed in the terminal) is emptied first, ctrl+e then
// ctrl+u; on a single-select question the arrows take the cursor there, as
// its digit would submit that text. The cursor left on that row (in the
// terminal) edits its text, where a digit is typed (seen live): the arrows
// take it off first. With tabs (several questions, or a
// multi-select one) the review comes last: Enter on "Submit answers". After
// the last key the dialog must be gone.
func (d *askDriver) claude(ask *proto.Ask, answers []askAnswer) error {
	tabbed := len(ask.Questions) > 1
	for _, q := range ask.Questions {
		tabbed = tabbed || q.Multi
	}
	for i, q := range ask.Questions {
		ans := answers[i]
		var dlg claudeDialog
		on := func(s string) bool {
			dlg = parseClaudeDialog(s)
			return dlg.showsQuestion(q)
		}
		// Step descriptions name questions and options by number only: the
		// error reaches the audit log and the server's log.
		if err := d.waitFor(fmt.Sprintf("question %d", i+1), on); err != nil {
			return err
		}
		other := len(q.Options) + 1 // the "Type something" row
		// The cursor on it (left there in the terminal) edits its text: a digit would be typed, not pressed.
		typing := dlg.cursor() == other
		if typing && (ans.other == nil || q.Multi) {
			if err := d.claudeMoveTo(on, &dlg, other-1); err != nil {
				return err
			}
		}
		switch {
		case !q.Multi && ans.other != nil:
			if typing {
				// focused already
			} else if r, _ := dlg.row(other); isTypeRow(r.label) {
				if err := d.press(digit(other)); err != nil {
					return err
				}
				if err := d.waitFor("its Type something row focused", func(s string) bool {
					return on(s) && dlg.cursor() == other
				}); err != nil {
					return err
				}
			} else if err := d.claudeMoveTo(on, &dlg, other); err != nil {
				return err
			}
			if err := d.claudeType(on, &dlg, other, *ans.other); err != nil {
				return err
			}
			if err := d.press("enter"); err != nil {
				return err
			}
		case !q.Multi:
			c := ans.choices[0]
			if err := d.press(digit(c)); err != nil {
				return err
			}
			if hasPreview(q) { // the digit only moves the cursor there
				if err := d.waitFor(fmt.Sprintf("the cursor on option %d", c), func(s string) bool { return on(s) && dlg.cursor() == c }); err != nil {
					return err
				}
				if err := d.press("enter"); err != nil {
					return err
				}
			}
		default:
			for _, c := range ans.choices {
				if r, ok := dlg.row(c); ok && r.box == 2 {
					continue // ticked already
				}
				if err := d.press(digit(c)); err != nil {
					return err
				}
				if err := d.waitFor(fmt.Sprintf("option %d ticked", c), func(s string) bool {
					if !on(s) {
						return false
					}
					r, ok := dlg.row(c)
					return ok && r.box == 2
				}); err != nil {
					return err
				}
			}
			for _, r := range dlg.rows { // ticked before, not wanted now: untick
				unwanted := (r.n <= len(q.Options) && !slices.Contains(ans.choices, r.n)) || (r.n == other && ans.other == nil)
				if r.box != 2 || !unwanted {
					continue
				}
				if err := d.press(digit(r.n)); err != nil {
					return err
				}
				n := r.n
				if err := d.waitFor(fmt.Sprintf("row %d unticked", n), func(s string) bool {
					if !on(s) {
						return false
					}
					r, ok := dlg.row(n)
					return ok && r.box == 1
				}); err != nil {
					return err
				}
			}
			if ans.other == nil {
				if err := d.press("right"); err != nil {
					return err
				}
				break
			}
			if err := d.claudeMoveTo(on, &dlg, other); err != nil {
				return err
			}
			if err := d.claudeType(on, &dlg, other, *ans.other); err != nil {
				return err
			}
			if r, _ := dlg.row(other); r.box != 2 {
				if err := d.press("enter"); err != nil {
					return err
				}
				if err := d.waitFor("Type something ticked", func(s string) bool {
					r, ok := dlg.row(other)
					return on(s) && ok && r.box == 2
				}); err != nil {
					return err
				}
			}
			if err := d.press("tab"); err != nil {
				return err
			}
			if err := d.waitFor("the cursor on Submit", func(s string) bool { return on(s) && dlg.submitCur }); err != nil {
				return err
			}
			if err := d.press("enter"); err != nil {
				return err
			}
		}
		if !tabbed { // its one question's last key
			return d.waitGone(fmt.Sprintf("question %d answered", i+1), func(s string) bool { return !on(s) })
		}
	}
	if err := d.waitFor("the review of the answers", func(s string) bool {
		dlg := parseClaudeDialog(s)
		return dlg.review && dlg.showsAsk(ask) && dlg.cursor() == 1
	}); err != nil {
		return err
	}
	if err := d.press("enter"); err != nil {
		return err
	}
	return d.waitGone("the answers submitted", func(s string) bool { return !parseClaudeDialog(s).showsAsk(ask) })
}

// isTypeRow reports whether a row is the empty Other row ("Type
// something", "Type something." on a single-select question).
func isTypeRow(label string) bool { return strings.TrimSuffix(label, ".") == claudeTypeRow }

// claudeMoveTo takes the cursor to numbered row n with the arrows (from the
// unnumbered Submit row, 0, up).
func (d *askDriver) claudeMoveTo(on func(string) bool, dlg *claudeDialog, n int) error {
	for dlg.cursor() != n {
		key := "down"
		if cur := dlg.cursor(); cur > n || cur == 0 {
			key = "up"
		}
		from := dlg.cursor()
		if err := d.press(key); err != nil {
			return err
		}
		if err := d.waitFor(fmt.Sprintf("the cursor moving towards row %d", n), func(s string) bool { return on(s) && dlg.cursor() != from }); err != nil {
			return err
		}
		if len(d.sent) > 64 {
			return fmt.Errorf("%w: the cursor never reached row %d", errInputFailed, n)
		}
	}
	return nil
}

// claudeType types text into a focused Type something row, emptied first
// (ctrl+e, ctrl+u: verified live, typing goes in at the start of what is
// there) when it holds other text, and waits for the row to show it.
func (d *askDriver) claudeType(on func(string) bool, dlg *claudeDialog, row int, text string) error {
	r, _ := dlg.row(row)
	if r.label == text {
		return nil // typed already
	}
	if !isTypeRow(r.label) {
		if err := d.press("ctrl+e"); err != nil {
			return err
		}
		if err := d.press("ctrl+u"); err != nil {
			return err
		}
		if err := d.waitFor("its Type something row emptied", func(s string) bool {
			if !on(s) {
				return false
			}
			r, ok := dlg.row(row)
			return ok && r.cursor && isTypeRow(r.label)
		}); err != nil {
			return err
		}
	}
	if err := d.typeText(text); err != nil {
		return err
	}
	if err := d.waitFor("the typed answer in its Type something row", func(s string) bool {
		if !on(s) {
			return false
		}
		r, ok := dlg.row(row)
		return ok && r.cursor && labelIs(r.label, text)
	}); err != nil {
		return err
	}
	d.settle()
	return nil
}

func hasPreview(q proto.AskQuestion) bool {
	return slices.ContainsFunc(q.Options, func(o proto.AskOption) bool { return o.Preview != "" })
}

// cancel presses Esc on the ask's dialog, and only on it: shows says
// whether a screen shows a dialog and whether it is the ask's. Another
// question on the screen (the terminal moved on before the transcript
// said so) is stale, nothing pressed.
func (d *askDriver) cancel(shows func(screen string) (dialog, ours bool)) error {
	another := false
	if err := d.waitFor("its dialog", func(s string) bool {
		dialog, ours := shows(s)
		another = dialog && !ours
		return ours
	}); err != nil {
		if another && errors.Is(err, errInputFailed) {
			return fmt.Errorf("%w: the terminal shows another question (no keys pressed)", errStale)
		}
		return err
	}
	if err := d.press("esc"); err != nil {
		return err
	}
	return d.waitGone("the dialog closed", func(s string) bool { _, ours := shows(s); return !ours })
}

// claudeCancel is Esc on the dialog: Claude records it as a rejected call
// ("User rejected tool use") and an interruption.
func (d *askDriver) claudeCancel(ask *proto.Ask) error {
	return d.cancel(func(s string) (bool, bool) {
		dlg := parseClaudeDialog(s)
		return dlg.ok, dlg.showsAsk(ask)
	})
}

// codex drives Codex's request_user_input overlay (keys from its pinned
// source, verified live for these: testdata/screens/codex-ask-*): an
// option's digit picks it and goes to the next question (the last one's
// submits them all); Other is the arrows to "None of the above", Enter
// (its notes open), the text, Enter; notes open already (in the terminal)
// take only the text if empty, only Enter if they hold it, no keys if they
// hold other text. A digit on "None of the above" would submit it without
// the text. It has no multi-select. After the last key
// the overlay must be gone.
func (d *askDriver) codex(ask *proto.Ask, answers []askAnswer) error {
	var on func(string) bool
	for i, q := range ask.Questions {
		ans := answers[i]
		var dlg codexDialog
		on = func(s string) bool {
			dlg = parseCodexDialog(s)
			return dlg.showsQuestion(i, len(ask.Questions), q)
		}
		if err := d.waitFor(fmt.Sprintf("question %d", i+1), on); err != nil {
			return err
		}
		if ans.other == nil {
			if dlg.notes { // opened in the terminal: a digit would go into them
				return fmt.Errorf("%w: question %d has its notes open (no keys pressed for it); look at the terminal", errInputFailed, i+1)
			}
			if err := d.press(digit(ans.choices[0])); err != nil {
				return err
			}
			continue
		}
		other := len(q.Options) + 1 // "None of the above"
		text := *ans.other
		// Its notes open already (in the terminal): Enter would submit what
		// they hold. Empty on None of the above, the text goes in; holding
		// this text, Enter; anything else, no keys.
		opened, typed := false, false
		if dlg.notes {
			opened = dlg.cursor() == other && dlg.notesText == ""
			typed = dlg.cursor() == other && !q.Secret && collapse(dlg.notesText) == collapse(text)
			if !opened && !typed {
				return fmt.Errorf("%w: question %d has its notes open (no keys pressed for it); look at the terminal", errInputFailed, i+1)
			}
		}
		if !opened && !typed {
			for dlg.cursor() != other {
				key := "down"
				if dlg.cursor() > other {
					key = "up"
				}
				from := dlg.cursor()
				if err := d.press(key); err != nil {
					return err
				}
				if err := d.waitFor("the cursor moving towards None of the above", func(s string) bool { return on(s) && dlg.cursor() != from }); err != nil {
					return err
				}
				if len(d.sent) > 64 {
					return fmt.Errorf("%w: the cursor never reached None of the above", errInputFailed)
				}
			}
			if err := d.press("enter"); err != nil {
				return err
			}
			if err := d.waitFor("its notes open", func(s string) bool { return on(s) && dlg.notes && dlg.notesText == "" }); err != nil {
				return err
			}
			opened = true
		}
		if opened {
			if err := d.typeText(text); err != nil {
				return err
			}
			if err := d.waitFor("the typed answer in its notes", func(s string) bool {
				if !on(s) || !dlg.notes {
					return false
				}
				if q.Secret { // masked
					return dlg.notesText != "" && strings.Trim(dlg.notesText, "*") == ""
				}
				return labelIs(dlg.notesText, text)
			}); err != nil {
				return err
			}
			d.settle()
		}
		if err := d.press("enter"); err != nil {
			return err
		}
	}
	// Each question's key is checked by the next one showing; the last one's here.
	last := on
	return d.waitGone(fmt.Sprintf("question %d answered", len(ask.Questions)), func(s string) bool { return !last(s) })
}

// codexCancel is Esc on the overlay: Codex interrupts the turn (the call's
// output says it was aborted).
func (d *askDriver) codexCancel(ask *proto.Ask) error {
	return d.cancel(func(s string) (bool, bool) {
		dlg := parseCodexDialog(s)
		return dlg.ok, dlg.showsAsk(ask)
	})
}
