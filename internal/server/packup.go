package server

// #110 pack up on request: before a prompt goes out, the game asks
// packup.detect whether it also tells the worker to leave once the task is
// done. internal/packup's pipeline runs off the hub goroutine, bounded by
// packup.DetectTimeout; the feature off or not ready, a worker the wrap-up
// does not take (a freelancer, no Claude or Codex agent), any failure or a
// timeout: matched false, the prompt goes as written. The prompt is never
// logged nor audited (only its length), nor is an error's text: a provider
// may echo the prompt in it, so only fixed codes are logged. Sending the task and the worker
// home is the game's next command: worker.wrapup (#83), nothing new here.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/packup"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// packupState is the hub's part of the feature (hub goroutine).
type packupState struct {
	svc  *packup.Service
	last string // the view as last published (JSON)
}

// initPackup makes the feature's service (NewHub); none without the AI
// integration.
func (h *Hub) initPackup(ctx context.Context) error {
	roles := h.opts.PackupRoles
	if roles == nil && h.opts.AI != nil {
		roles = h.opts.AI
	}
	if roles == nil {
		return nil
	}
	svc, err := packup.New(ctx, packup.Options{Roles: roles, Store: h.st, EnvEnabled: h.opts.PackupEnabled,
		Timeout: h.opts.PackupTimeout, Now: h.opts.Now})
	if err != nil {
		return fmt.Errorf("pack up on request: %w", err)
	}
	h.pk.svc = svc
	if b, err := json.Marshal(svc.View()); err == nil {
		h.pk.last = string(b)
	}
	return nil
}

// packupView is the feature's state for the snapshot (nil: no service).
func (h *Hub) packupView() *proto.Packup {
	if h.pk.svc == nil {
		return nil
	}
	v := h.pk.svc.View()
	return &v
}

// publishPackup emits packup.update when the state changed (hub goroutine):
// a setting, a passing test, a role's state.
func (h *Hub) publishPackup() {
	if h.pk.svc == nil {
		return
	}
	v := h.pk.svc.View()
	b, err := json.Marshal(v)
	if err != nil || string(b) == h.pk.last {
		return
	}
	h.pk.last = string(b)
	h.seq++
	msg := mustJSON(proto.PackupUpdate{T: proto.EvPackupUpdate, Seq: h.seq, Packup: v})
	h.ring.add(h.seq, msg)
	for c := range h.clients {
		h.deliver(c, msg)
	}
}

// packupSkip is why a prompt to w is not looked at ("": it is): the
// wrap-up's rule (#83), Claude or Codex agents that are not freelancers.
func (h *Hub) packupSkip(w *proto.Worker) string {
	harness := w.AgentKind
	if harness == "" {
		harness = w.Harness
	}
	switch {
	case !h.pk.svc.Ready():
		return "the feature is not ready"
	case world.Freelancer(w.Role):
		return "a freelancer"
	case w.AgentKind == "" || (harness != transcript.Claude && harness != transcript.Codex):
		return "not a Claude or Codex agent"
	}
	return ""
}

// startPackup answers packup.get, packup.set, packup.test and
// packup.detect. The models' calls and the store write run off the hub
// goroutine; a change is published (packup.update) before the ack.
func (h *Hub) startPackup(ctx context.Context, c *Client, cmd proto.Command) error {
	svc := h.pk.svc
	if svc == nil {
		return fmt.Errorf("%w: the bridge has no AI integration", errUnsupported)
	}
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdPackupGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	case proto.CmdPackupSet:
		var a proto.PackupSetArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			if err := svc.Set(ctx, a.Enabled, a.Threshold); err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishPackup)
			return svc.View(), nil
		}
	case proto.CmdPackupTest:
		var a proto.PackupTestArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Test(ctx, a.Threshold)
			if err != nil {
				return nil, err
			}
			_ = h.doWait(ctx, h.publishPackup)
			return res, nil
		}
	default: // packup.detect
		var a proto.PackupDetectArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		if strings.TrimSpace(a.Text) == "" || !herdr.ValidMessage(a.Text) {
			return bad("text must be 1-%d bytes of UTF-8 without NUL, got %d bytes", herdr.MaxMessage, len(a.Text))
		}
		w := h.workers[a.ID]
		if w == nil {
			return fmt.Errorf("%w: %q", errUnknownWorker, a.ID)
		}
		if why := h.packupSkip(w); why != "" {
			h.log.Info("pack-up not looked at", "worker", a.ID, "why", why)
			h.audit(ctx, c, cmd, nil)
			h.reply(c, cmd, proto.PackupDetectResult{}, nil)
			return nil
		}
		id := a.ID
		work = func(ctx context.Context) (any, error) {
			res, err := svc.Detect(ctx, a.Text)
			if err != nil {
				// Fail open: the prompt goes as written. Only the kind is
				// logged: a provider's words in err can echo the prompt.
				if !errors.Is(err, ai.ErrNotReady) && ctx.Err() == nil {
					h.log.Warn("pack-up detection failed", "worker", id, "kind", ai.KindOf(err))
				}
				return proto.PackupDetectResult{}, nil
			}
			if res.ExtractCode != "" {
				h.log.Info("pack-up extraction was no match", "worker", id, "score", res.Score, "why", res.ExtractCode)
			}
			h.log.Info("pack-up looked at", "worker", id, "score", res.Score, "matched", res.Matched, "task_runes", utf8.RuneCountInString(res.Task))
			out := proto.PackupDetectResult{Matched: res.Matched, Score: res.Score}
			if res.Matched {
				out.Task, out.Removed = res.Task, res.Removed
			}
			return out, nil
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// auditPackupDetect is what packup.detect leaves in the audit log: the
// worker and the prompt's length, never its text.
func auditPackupDetect(cmd proto.Command) json.RawMessage {
	var a proto.PackupDetectArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	return mustJSON(struct {
		ID        string        `json:"id"`
		TextBytes int           `json:"text_bytes"`
		Secrets   *secretsAudit `json:"secrets,omitempty"` // #108 round 2: the decisions' counts
	}{clip(a.ID), len(a.Text), auditReviews(a.Secrets)})
}

// packupErrorCode maps an error of internal/packup to its protocol code; ""
// when it is none.
func packupErrorCode(err error) string {
	var pe *packup.Error
	if errors.As(err, &pe) {
		return pe.Code
	}
	return ""
}
