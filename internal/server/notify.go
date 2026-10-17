package server

// #11 notifications: the hub's side of internal/notify. Every worker event
// the hub emits (worker.upsert, worker.status, worker.activity,
// worker.removed) and every floor.upsert (a floor falling asleep or waking)
// hands the notify service a look at the workers it is about, from the
// hub's current proto.Worker, on the hub goroutine: Observe only appends to
// a bounded list under a mutex, so the emit path never waits on the network
// (TestNotifyEmitNeverBlocks). The service decides (the inbox rule, the
// episodes, the done settle) and sends from its own goroutines. The server
// knows notify's interfaces only: the Telegram channel is the app's
// (TestNotifyCoreIsProviderNeutral). #13: a reply to a notification is
// typed into its worker through worker.prompt's own path (replyPrompt).
// #14: what is tapped on a Telegram card answers the worker's ask or
// follow-up through worker.answer_ask's or worker.answer_followup's own
// path (cardAnswer); the cards' texts are the worker's facts (notifyFacts),
// none of a secret ask's. #88: and a blocked worker's permission or trust
// menu through worker.answer's (queueAnswer); of the menu only its
// choices' labels go, scrubbed (menuText), never its question line.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// notifyState is the hub's notifications state.
type notifyState struct {
	svc  *notify.Service
	last string // the View last published (JSON)
}

// notifyStore adapts the store to internal/notify's Store.
type notifyStore struct{ st *store.Store }

func (s notifyStore) LoadNotifySettings(ctx context.Context) (notify.Settings, bool, error) {
	n, ok, err := s.st.LoadNotifySettings(ctx)
	return notify.Settings(n), ok, err
}

func (s notifyStore) SaveNotifySettings(ctx context.Context, n notify.Settings) error {
	return s.st.SaveNotifySettings(ctx, store.NotifySettings(n))
}

func (s notifyStore) SaveNotifyMessage(ctx context.Context, msg notify.Ref, worker string, at time.Time) error {
	return s.st.SaveNotifyMessage(ctx, msg.Chat, msg.Message, worker, at)
}

func (s notifyStore) NotifyMessage(ctx context.Context, msg notify.Ref) (string, time.Time, bool, error) {
	return s.st.NotifyMessage(ctx, msg.Chat, msg.Message)
}

// initNotify opens the service when the bridge has a channel.
func (h *Hub) initNotify(ctx context.Context) error {
	if h.opts.NotifyChannel == nil {
		return nil
	}
	svc, err := notify.New(ctx, notify.Options{Store: notifyStore{h.st}, Channel: h.opts.NotifyChannel,
		EnvEnabled: h.opts.NotifyEnabled, Clock: h.opts.NotifyClock, Settle: h.opts.NotifySettle,
		Audit: h.auditNotify, Prompt: h.replyPrompt, Answer: h.cardAnswer, Log: h.log})
	if err != nil {
		return fmt.Errorf("notifications: %w", err)
	}
	h.nt.svc = svc
	if b, err := json.Marshal(svc.View()); err == nil {
		h.nt.last = string(b)
	}
	return nil
}

// notifyView is the feature's state for the snapshot (nil: no channel).
func (h *Hub) notifyView() *proto.NotifyState {
	if h.nt.svc == nil {
		return nil
	}
	v := h.nt.svc.View()
	return &v
}

// runNotify runs the service (its loop, its sender, the channel's pairing).
func (h *Hub) runNotify(ctx context.Context) {
	defer h.wg.Done()
	h.nt.svc.Run(ctx)
}

// trackNotify publishes the state whenever the service says it changed.
func (h *Hub) trackNotify(ctx context.Context) {
	defer h.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.nt.svc.Changes():
		}
		_ = h.doWait(ctx, h.publishNotify)
	}
}

// publishNotify emits notify.update when the state changed (hub goroutine).
func (h *Hub) publishNotify() {
	if h.nt.svc == nil {
		return
	}
	v := h.nt.svc.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.nt.last {
		return
	}
	h.nt.last = string(b)
	h.seq++
	msg := mustJSON(proto.NotifyUpdate{T: proto.EvNotifyUpdate, Seq: h.seq, NotifyState: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// notifyEvent hands the service a look at the workers an emitted event is
// about (hub goroutine, from emit). It never blocks.
func (h *Hub) notifyEvent(ev proto.Event) {
	svc := h.nt.svc
	if svc == nil {
		return
	}
	switch ev.T {
	case proto.EvWorkerUpsert:
		if ev.Worker != nil {
			h.notifyWorker(ev.Worker.ID)
		}
	case proto.EvWorkerStatus, proto.EvWorkerActivity:
		h.notifyWorker(ev.ID)
	case proto.EvWorkerRemoved:
		svc.Observe(notify.Observation{Worker: notify.Worker{ID: ev.ID}, Gone: true})
	case proto.EvFloorUpsert:
		if ev.Floor == nil {
			return
		}
		if f := h.floors[ev.Floor.ID]; f != nil {
			for _, id := range f.order {
				h.notifyWorker(id)
			}
		}
	}
}

func (h *Hub) notifyWorker(id string) {
	w := h.workers[id]
	if w == nil {
		return
	}
	f := h.floors[w.Floor]
	nw := notifyFacts(w, f != nil && !f.running)
	o := notify.Observation{Worker: nw, Name: workerDisplayName(w)}
	if v := notify.Judge(nw); v.Display == notify.DisplayNeedsYou || v.Display == notify.DisplayDone {
		o.Line = h.notifyLine(w, nw.Secret())
	}
	h.nt.svc.Observe(o)
}

// notifyFacts is what the inbox rule reads of a worker: its fields as they
// are (internal/notify interprets them, as the game does). #14: and what
// its question cards show; an ask with a secret question gives none of
// its texts.
func notifyFacts(w *proto.Worker, asleep bool) notify.Worker {
	n := notify.Worker{ID: w.ID, Status: w.Status, StatusSince: w.StatusSince, Asleep: asleep, Role: w.Role, Label: w.Label,
		OverCap: w.OverCap, Pass: w.Pass, Phase: w.Phase}
	if r := w.Report; r != nil {
		n.Report = &notify.Report{State: r.State, InputRequired: r.InputRequired, Resolved: r.InputResolved != nil}
	}
	if a := w.Ask; a != nil {
		n.Ask = &notify.Ask{ToolUseID: a.ToolUseID, Since: a.Since}
		if a.Questions != nil {
			n.Ask.Questions = make([]notify.AskQuestion, len(a.Questions))
			secret := slices.ContainsFunc(a.Questions, func(q proto.AskQuestion) bool { return q.Secret })
			for i, q := range a.Questions {
				nq := notify.AskQuestion{HasOptions: q.Options != nil, Secret: q.Secret}
				if !secret {
					nq.Header, nq.Question, nq.Multi, nq.Other = q.Header, q.Question, q.Multi, q.Other
					for _, o := range q.Options {
						nq.Options = append(nq.Options, notify.AskOption{Label: o.Label, Description: o.Description, Preview: o.Preview})
					}
				}
				n.Ask.Questions[i] = nq
			}
		}
	}
	if f := w.Followup; f != nil {
		n.Followup = &notify.Followup{TurnID: f.TurnID, At: f.At, Tail: f.Tail}
		for _, q := range f.Questions {
			nq := notify.FollowupQuestion{ID: q.ID, Question: q.Question, Kind: q.Kind, Options: len(q.Options),
				Label: q.Label, Context: q.Context, Choices: q.Options}
			if r := q.Recommendation; r != nil {
				nq.Recommendation = r.Text
			}
			n.Followup.Questions = append(n.Followup.Questions, nq)
		}
	}
	if u := w.WrapUp; u != nil {
		n.WrapUpState = u.State
	}
	if c := w.Codex; c != nil {
		n.CodexShared, n.CodexAsyncBlocked = c.Mode == proto.CodexModeShared, c.AsyncBlocked
	}
	if a := w.Activity; a != nil {
		n.ActivityKind = string(a.Kind)
	}
	if q := w.Question; q != nil && w.Status == statusBlocked && (q.Kind == proto.QuestionPermission || q.Kind == proto.QuestionTrust) {
		// Not q.Text: questionText can pick a command line that asks
		// ("$ curl -u user:pass 'Do you want to continue?'").
		n.Menu = &notify.Menu{Hash: q.Hash, Kind: q.Kind}
		for _, c := range q.Choices {
			n.Menu.Choices = append(n.Menu.Choices, notify.MenuChoice{N: c.N, Label: menuText(c.Label)})
		}
	}
	return n
}

var (
	// backtickRe is a span in backticks, or one the screen cut off: a
	// choice's quoted command.
	backtickRe = regexp.MustCompile("`[^`]*(`|$)")
	// namesCommandRe is a choice that may name a command: what not to ask
	// about again (Claude Code's "Yes, and don't ask again for npm test
	// commands in <dir>", Codex's "Yes, and don't ask again for commands
	// that start with `…`"), or commands at all.
	namesCommandRe = regexp.MustCompile(`(?i)ask\PL*again|command`)
	// askAgainRe is such a choice's lead as Claude Code and Codex write it,
	// up to where the command would start.
	askAgainRe = regexp.MustCompile("(?i)^(yes|no),?[\\s\\p{Z}]+(and[\\s\\p{Z}]+)?(don['‘’ʼ´` ]?t|do[\\s\\p{Z}]+not|never)[\\s\\p{Z}]+ask[\\s\\p{Z}]+again")
	// forRe is what follows the lead when it names what it is for.
	forRe = regexp.MustCompile(`(?i)^[\s\p{Z}]*for\b`)
	// keyHintRe is a choice's key at its end, as Codex shows it ("(p)").
	keyHintRe = regexp.MustCompile(`[\s\p{Z}]\([A-Za-z]\)[\s\p{Z}]*$`)
)

// menuLabelsKept are the captured screens' choices that say "command" and
// name none (TestNotifyFactsMenuCommandLine).
var menuLabelsKept = map[string]bool{
	"Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)": true,
}

// menuText is a screen menu choice's label as it may leave the bridge
// (#88). A label known to name no command is kept. One that says what not
// to ask about again is cut where the command would start ("Yes, and
// don't ask again for …"), and any other that may name a command is "…":
// a command's end is never looked for, so nothing of it is left. Its key
// (Codex's "(p)", one letter) is kept. Anything else has a span in
// backticks elided. All of it is scrubbed of what looks like a secret.
func menuText(s string) string {
	if menuLabelsKept[s] || !namesCommandRe.MatchString(s) {
		return digest.Scrub(backtickRe.ReplaceAllString(s, "`…`"))
	}
	key := keyHintRe.FindString(s)
	out := "…"
	if lead := askAgainRe.FindString(s); lead != "" {
		out = lead
		switch rest := strings.TrimSuffix(s[len(lead):], key); {
		case forRe.MatchString(rest):
			out += " for …"
		case strings.TrimSpace(rest) != "":
			out += " …"
		}
	}
	if key != "" {
		out += " " + strings.TrimSpace(key)
	}
	return digest.Scrub(out)
}

// workerDisplayName is the game's displayName: the name, else the label,
// else "Worker".
func workerDisplayName(w *proto.Worker) string {
	if n := strings.TrimSpace(w.Name); n != "" {
		return n
	}
	if l := strings.TrimSpace(w.Label); l != "" {
		return l
	}
	return "Worker"
}

// notifyLine is a notification's one line: the overview's now line (else
// its task line), else the transcript's last assistant text line, else
// nothing; scrubbed and clipped. A secret ask's worker gets none: its
// question must not leave the bridge.
func (h *Hub) notifyLine(w *proto.Worker, secret bool) string {
	if secret {
		return ""
	}
	var line string
	if d := w.Digest; d != nil {
		if d.Now != "" && d.NowSource != proto.DigestTitle {
			line = d.Now
		} else if d.Task != "" {
			line = d.Task
		}
	}
	if line == "" {
		if d := h.dg[w.ID]; d != nil {
			line = lastTextLine(d.Recent)
		}
	}
	return notify.OneLine(digest.Scrub(line), notify.LineMax)
}

// lastTextLine is the last non-empty line of the newest step that has text.
func lastTextLine(steps []transcript.DigestStep) string {
	for i := len(steps) - 1; i >= 0; i-- {
		ts := steps[i].Texts
		for j := len(ts) - 1; j >= 0; j-- {
			lines := strings.Split(ts[j], "\n")
			for k := len(lines) - 1; k >= 0; k-- {
				if l := strings.TrimSpace(lines[k]); l != "" {
					return l
				}
			}
		}
	}
	return ""
}

// replyPrompt is the service's Prompt (#13): a Telegram reply typed into
// worker id as worker.prompt types a client's (queuePrompt: the same checks,
// side effects, lane and herdr calls), with no client: no command reply,
// and no worker.prompt audit row (the service writes notify.reply, by the
// text's lengths). A /handoff is refused: it is the game's.
func (h *Hub) replyPrompt(ctx context.Context, id, text string, done func(error)) error {
	return h.handOff(ctx, func(hctx context.Context) error {
		return h.queuePrompt(hctx, proto.WorkerPromptArgs{ID: id, Text: text}, nil, func(_ context.Context, _ any, err error) {
			done(replyError(err))
		})
	})
}

// cardAnswer is the service's Answer (#14): what was tapped on a Telegram
// card answers the worker's ask or follow-up as the game's
// worker.answer_ask or worker.answer_followup does (queueAnswerAsk,
// queueAnswerFollowup: the same checks, lane and herdr calls), with no
// client: no command reply, and no row of those commands (the service
// writes notify.answer, without a text). An ask or follow-up that is no
// longer the one tapped is errStale (notify.ReplyClosed). #88: a menu's
// tap is worker.answer's (queueAnswer); a worker no longer blocked is
// closed too, and keys that left it blocked are notify.ReplyUnresolved.
func (h *Hub) cardAnswer(ctx context.Context, a notify.Answer, done func(error)) error {
	end := func(_ context.Context, data any, err error) {
		if r, ok := data.(proto.AnswerAskResult); ok && err == nil && !r.Resolved {
			h.log.Info("a Telegram card's answer was sent; the transcript has not recorded it yet", "worker", a.WorkerID)
		}
		if r, ok := data.(proto.AnswerResult); ok && err == nil && !r.Resolved {
			h.log.Info("a Telegram card's choice was sent; the worker is still blocked", "worker", a.WorkerID)
			done(&notify.ReplyError{Kind: notify.ReplyUnresolved})
			return
		}
		done(replyError(menuError(a, err)))
	}
	return h.handOff(ctx, func(hctx context.Context) error {
		if a.Hash != "" {
			return menuError(a, h.queueAnswer(hctx, proto.WorkerAnswerArgs{ID: a.WorkerID, Hash: a.Hash, Choice: a.Choice}, end))
		}
		if a.TurnID != "" {
			args := proto.WorkerAnswerFollowupArgs{ID: a.WorkerID, TurnID: a.TurnID}
			for _, f := range a.Followup {
				args.Answers = append(args.Answers, proto.FollowupAnswer{ID: f.ID, Value: f.Value})
			}
			return h.queueAnswerFollowup(hctx, args, end)
		}
		args := proto.WorkerAnswerAskArgs{ID: a.WorkerID, ToolUseID: a.ToolUseID, Cancel: a.Cancel}
		for _, x := range a.Ask {
			args.Answers = append(args.Answers, proto.AskAnswerArg{Question: x.Question, Choices: x.Choices, Other: x.Other})
		}
		return h.queueAnswerAsk(hctx, args, end)
	})
}

// menuError is a menu card's refusal (#88): a worker no longer blocked
// (worker.answer's invalid_state) is a menu no longer open.
func menuError(a notify.Answer, err error) error {
	if a.Hash != "" && errors.Is(err, errInvalidState) {
		return &notify.ReplyError{Kind: notify.ReplyClosed, Err: err}
	}
	return err
}

// handOff runs queue (the checks and the queueing of a reply's or a card's
// input) on the hub goroutine and returns its refusal, as the service
// tells it.
func (h *Hub) handOff(ctx context.Context, queue func(hctx context.Context) error) error {
	res := make(chan error, 1)
	err := h.do(ctx, func(hctx context.Context) { res <- queue(hctx) })
	if err != nil {
		return replyError(err)
	}
	select {
	case err := <-res:
		return replyError(err)
	case <-ctx.Done():
		return replyError(ctx.Err())
	case <-h.done:
		return replyError(errHubStopped)
	}
}

// replyError is err as the service tells it (nil stays nil; one told
// already stays as it is).
func replyError(err error) error {
	var told *notify.ReplyError
	if err == nil || errors.As(err, &told) {
		return err
	}
	var bad *badArgsError
	kind := notify.ReplyFailed
	switch {
	case errors.Is(err, errAskWaiting):
		kind = notify.ReplyAsk
	case errors.Is(err, errStale): // #14: the ask or follow-up tapped is no longer the worker's
		kind = notify.ReplyClosed
	case errors.Is(err, errLaneFull):
		kind = notify.ReplyBusy
	case errors.Is(err, errUnknownWorker):
		kind = notify.ReplyGone
	case errors.Is(err, errHandoffInGame):
		kind = notify.ReplyHandoff
	case errors.As(err, &bad):
		kind = notify.ReplyBadText
	case errors.Is(err, errInvalidState):
		kind = notify.ReplyState
	}
	return &notify.ReplyError{Kind: kind, Err: err}
}

// auditNotify writes a bridge-originated notify.send, notify.pair or (#13)
// notify.reply row.
func (h *Hub) auditNotify(ctx context.Context, cmd string, args any, err error) {
	if e := h.st.Audit(ctx, digestAuditClient, cmd, mustJSON(args), err); e != nil {
		h.log.Error("audit log write failed", "err", e)
	}
}

// startNotify answers the notify.* commands. Every one runs off the hub
// goroutine (a token check, a test message and a pairing's start call
// Telegram); a change is published (notify.update) before the ack.
func (h *Hub) startNotify(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.nt.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no notification channel", errUnsupported)
	}
	view := func(ctx context.Context, err error) (any, error) {
		if err != nil {
			return nil, err
		}
		_ = h.doWait(ctx, h.publishNotify)
		return svc.View(), nil
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdNotifyGet, proto.CmdNotifyTokenClear, proto.CmdNotifyPairStart, proto.CmdNotifyPairCancel, proto.CmdNotifyUnpair:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		do := map[string]func(context.Context) error{
			proto.CmdNotifyGet:        func(context.Context) error { return nil },
			proto.CmdNotifyTokenClear: func(context.Context) error { return svc.ClearToken() },
			proto.CmdNotifyPairStart:  svc.StartPairing,
			proto.CmdNotifyPairCancel: func(context.Context) error { return svc.CancelPairing() },
			proto.CmdNotifyUnpair:     func(context.Context) error { return svc.Unpair() },
		}[cmd.T]
		work = func(ctx context.Context) (any, error) { return view(ctx, do(ctx)) }
	case proto.CmdNotifySet:
		var a proto.NotifySetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		u := notify.Update{Enabled: a.Enabled, Quiet: a.Quiet, Freelancers: a.Freelancers, Replies: a.Replies}
		if e := a.Events; e != nil {
			u.NeedsYou, u.Done = e.NeedsYou, e.Done
		}
		work = func(ctx context.Context) (any, error) { return view(ctx, svc.Apply(ctx, u)) }
	case proto.CmdNotifyTokenSet:
		var a proto.NotifyTokenSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if strings.TrimSpace(a.Key) == "" {
			return &notify.Error{Code: notify.CodeBadRequest, Msg: "paste the bot token @BotFather gave you"}
		}
		work = func(ctx context.Context) (any, error) { return view(ctx, svc.SetToken(ctx, a.Key)) }
	default: // notify.test
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Test(ctx)
			_ = h.doWait(ctx, h.publishNotify)
			if err != nil {
				return nil, err
			}
			return res, nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// notifyErrorCode maps an error of internal/notify to its protocol code; ""
// when it is none.
func notifyErrorCode(err error) string {
	var e *notify.Error
	var se *notify.SendError
	if errors.As(err, &e) || errors.As(err, &se) {
		return notify.CodeOf(err)
	}
	return ""
}

// auditNotifyArgs is what notify.token.set leaves in the audit log: that a
// token was given, never the token (not even its length).
func auditNotifyArgs(cmd proto.Command) json.RawMessage {
	var a proto.NotifyTokenSetArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	return mustJSON(struct {
		KeyGiven bool `json:"key_given"`
	}{a.Key != ""})
}
