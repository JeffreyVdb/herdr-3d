package server

// #211 dictated hiring, phase 2: hire.interpret reads one sentence with the
// AI integration's LLM off the hub goroutine, bounded by
// hireintent.DefaultTimeout (Options.HireIntentTimeout), against the hire
// catalog of the moment, and answers internal/hireintent's result. It sends
// no worker.hire, calls no herdr and keeps nothing: a follow-up reply comes
// with the pending proposal the client holds. The text is never logged nor
// audited (only its length), nor is a provider's error text: only codes.

import (
	"context"
	"encoding/json"

	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// hireCatalog is the hire options as internal/hireintent reads them.
func hireCatalog(o proto.HireOptions) hireintent.Catalog {
	conv := func(h proto.HarnessOptions) hireintent.HarnessCatalog {
		return hireintent.HarnessCatalog{Models: h.Models, Efforts: h.Efforts, ExtraEfforts: h.ExtraEfforts, ModelLabels: h.ModelLabels}
	}
	return hireintent.Catalog{Claude: conv(o.Claude), Codex: conv(o.Codex)}
}

// hireIntentRoles is the LLM's owner (Options.HireIntentRoles, else the AI
// integration; nil: none, every interpretation is not_ready).
func (h *Hub) hireIntentRoles() hireintent.Roles {
	if h.opts.HireIntentRoles != nil {
		return h.opts.HireIntentRoles
	}
	if h.opts.AI != nil {
		return h.opts.AI
	}
	return nil
}

// startHireInterpret answers hire.interpret.
func (h *Hub) startHireInterpret(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HireInterpretArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !hireintent.ValidText(a.Text) {
		return bad("text must be at most %d bytes of UTF-8 without NUL, got %d bytes", hireintent.MaxTextBytes, len(a.Text))
	}
	req := hireintent.Request{Text: a.Text, Pending: a.Pending, Catalog: hireCatalog(h.hireOptions())}
	roles, timeout := h.hireIntentRoles(), h.opts.HireIntentTimeout
	if timeout <= 0 {
		timeout = hireintent.DefaultTimeout
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		res := hireintent.Run(ctx, roles, timeout, req)
		if res.Error != nil {
			h.log.Warn("hire interpretation failed", "code", res.Error.Code, "pending", req.Pending != nil)
		} else {
			ready, asks := false, 0
			if res.Hire != nil {
				ready, asks = res.Hire.ReadyForReview, len(res.Hire.Questions)
			}
			h.log.Info("hire interpreted", "intent", res.Intent, "reason", res.Reason, "ready_for_review", ready,
				"questions", asks, "pending", req.Pending != nil)
		}
		return res, nil
	})
	return nil
}

// auditHireInterpret is what hire.interpret leaves in the audit log: the
// text's length and how many sentences the pending proposal had, never a
// sentence.
func auditHireInterpret(cmd proto.Command) json.RawMessage {
	var a proto.HireInterpretArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	pending := 0
	if a.Pending != nil {
		pending = len(a.Pending.Sources)
	}
	return mustJSON(struct {
		TextBytes      int `json:"text_bytes"`
		PendingSources int `json:"pending_sources"`
	}{len(a.Text), pending})
}
