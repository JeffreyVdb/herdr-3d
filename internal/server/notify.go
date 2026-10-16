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
// (TestNotifyCoreIsProviderNeutral).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
		Audit: h.auditNotify, Log: h.log})
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
// are (internal/notify interprets them, as the game does).
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
			for i, q := range a.Questions {
				n.Ask.Questions[i] = notify.AskQuestion{HasOptions: q.Options != nil, Secret: q.Secret}
			}
		}
	}
	if f := w.Followup; f != nil {
		n.Followup = &notify.Followup{TurnID: f.TurnID, At: f.At}
		for _, q := range f.Questions {
			n.Followup.Questions = append(n.Followup.Questions, notify.FollowupQuestion{ID: q.ID, Question: q.Question, Kind: q.Kind, Options: len(q.Options)})
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
	return n
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

// auditNotify writes a bridge-originated notify.send or notify.pair row.
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
		u := notify.Update{Enabled: a.Enabled, Quiet: a.Quiet, Freelancers: a.Freelancers}
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
