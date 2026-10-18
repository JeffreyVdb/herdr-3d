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
	"fmt"
	"maps"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/hireintent"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/secretfiles"
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

// startHireInterpret answers hire.interpret. #108 round 2: with prompt
// secrets reviewed, the language model reads the sentence only as its
// review made it (references in place of what it protects, to a pending
// owner the hire of its task claims), and the pending proposal's sentences
// only as an earlier answer gave them (secrets_pending) or with nothing to
// review in them; the ack's text and proposal hold the references.
func (h *Hub) startHireInterpret(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HireInterpretArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if !hireintent.ValidText(a.Text) {
		return bad("text must be at most %d bytes of UTF-8 without NUL, got %d bytes", hireintent.MaxTextBytes, len(a.Text))
	}
	gate, err := h.previewGate("", a.Text, a.Secrets, a.SecretsPending)
	if err != nil {
		return err
	}
	var sources []string
	if a.Pending != nil && h.gated(a.Secrets != nil || a.SecretsPending != "") {
		sources = a.Pending.Sources
		for i, s := range sources {
			if !hireintent.ValidText(s) {
				return bad("pending.sources[%d] must be at most %d bytes of UTF-8 without NUL", i, hireintent.MaxTextBytes)
			}
		}
	}
	rev := h.ps.rev
	req := hireintent.Request{Text: a.Text, Pending: a.Pending, Catalog: hireCatalog(h.hireOptions())}
	roles, timeout := h.hireIntentRoles(), h.opts.HireIntentTimeout
	if timeout <= 0 {
		timeout = hireintent.DefaultTimeout
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		pv, err := gate(ctx)
		if err != nil {
			return nil, err
		}
		if err := h.reviewedSources(ctx, rev, pv, sources); err != nil {
			pv.undo(ctx)
			return nil, err
		}
		if !hireintent.ValidText(pv.text) {
			pv.undo(ctx)
			return nil, bad("text with its file references must be at most %d bytes, got %d", hireintent.MaxTextBytes, len(pv.text))
		}
		req.Text = pv.text
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
		var given []string
		if res.Hire != nil {
			given = append(given, res.Hire.Sources...)
			given = append(given, res.Hire.Task.Value)
		}
		pv.answered(given...)
		return proto.HireInterpretResult{Result: res, Protected: protectedCount(pv.ps), SecretsPending: pv.token}, nil
	})
	return nil
}

// reviewedSources checks a pending proposal's sentences before the model
// reads them again (#108 round 2; off the hub goroutine): each one as the
// hand-over's earlier answer gave it, or with nothing to review in it (a
// sentence from before the switch, or a client's own: never one with a
// possible secret the review has not seen).
func (h *Hub) reviewedSources(ctx context.Context, rev *promptsecret.Reviewer, pv *preview, sources []string) error {
	var tok secretPending
	if pv.token != "" && !pv.fresh {
		h.ps.mu.Lock()
		if p := h.ps.pending[pv.token]; p != nil {
			tok.texts = maps.Clone(p.texts)
		}
		h.ps.mu.Unlock()
	}
	for i, s := range sources {
		if tok.reviewed(s) {
			continue
		}
		if _, err := h.protectText(ctx, rev, secretfiles.Owner{}, time.Time{}, s, nil); err != nil {
			return fmt.Errorf("pending.sources[%d]: %w", i, err)
		}
	}
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
		TextBytes      int           `json:"text_bytes"`
		PendingSources int           `json:"pending_sources"`
		Secrets        *secretsAudit `json:"secrets,omitempty"` // #108 round 2: the decisions' counts
	}{len(a.Text), pending, auditReviews(a.Secrets)})
}
