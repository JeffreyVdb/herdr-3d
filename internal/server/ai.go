package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// #92 AI integration: the bridge-wide settings of the classification model
// and the LLM. The hub only carries them: internal/ai holds the settings, the
// keys and the calls, and knows no feature. A key arrives in ai.models,
// ai.test and ai.set and is never put in an ack, an event, the audit log or a
// log line.

// startAI answers ai.get, ai.models, ai.test, ai.set and ai.clear. The calls
// out (a model list, a test) and the file write run off the hub goroutine.
func (h *Hub) startAI(ctx context.Context, c *Client, cmd proto.Command) error {
	if h.opts.AI == nil {
		return fmt.Errorf("%w: the bridge has no AI integration", errUnsupported)
	}
	svc := h.opts.AI
	var work func(context.Context) (any, error)
	switch cmd.T {
	case proto.CmdAIGet:
		if err := decodeArgs(cmd.Args, &struct{}{}); err != nil {
			return err
		}
		work = func(context.Context) (any, error) { return svc.View(), nil }
	case proto.CmdAIClear:
		var a proto.AIRoleArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		work = func(context.Context) (any, error) {
			if err := svc.Clear(ai.Role(a.Role)); err != nil {
				return nil, err
			}
			return svc.View(), nil
		}
	default:
		var a proto.AIFieldsArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		role, f := ai.Role(a.Role), ai.Fields{BaseURL: a.BaseURL, Model: a.Model, Key: a.Key, ExtraBody: a.ExtraBody}
		switch cmd.T {
		case proto.CmdAIModels:
			work = func(ctx context.Context) (any, error) {
				res, err := svc.Models(ctx, role, f)
				if err != nil {
					return nil, err
				}
				return proto.AIModelsResult{Models: res.Models, BaseURL: res.BaseURL}, nil
			}
		case proto.CmdAITest:
			work = func(ctx context.Context) (any, error) {
				res, err := svc.Test(ctx, role, f)
				if err != nil {
					return nil, err
				}
				return proto.AITestResult{OK: true, LatencyMS: res.LatencyMS, JSONMode: res.JSONMode, BaseURL: res.BaseURL, Score: res.Score}, nil
			}
		default: // ai.set
			work = func(context.Context) (any, error) {
				if err := svc.Set(role, f); err != nil {
					return nil, err
				}
				return svc.View(), nil
			}
		}
	}
	h.startAsync(ctx, c, cmd, work)
	return nil
}

// aiView is the AI state for the snapshot (nil: no AI service).
func (h *Hub) aiView() *proto.AI {
	if h.opts.AI == nil {
		return nil
	}
	v := h.opts.AI.View()
	return &v
}

// trackAI publishes the AI state whenever the service says it changed (a
// saved role, a rejected key, a passing test), as one ai.update.
func (h *Hub) trackAI(ctx context.Context) {
	defer h.wg.Done()
	last, _ := json.Marshal(h.opts.AI.View())
	for {
		select {
		case <-ctx.Done():
			return
		case <-h.opts.AI.Changes():
		}
		_ = h.doWait(ctx, func() {
			defer h.publishActivityState(ctx) // #98: and the classifier's is the activity's
			defer h.publishFollowups()        // #90: a role's state is the feature's
			defer h.publishPackup()           // #110: and pack up's
			defer h.publishDigestState(ctx)   // #118: and the summaries' (the LLM's)
			v := h.opts.AI.View()
			b, err := json.Marshal(v)
			if err != nil || string(b) == string(last) {
				return
			}
			last = b
			h.emit(proto.Event{T: proto.EvAIUpdate, AI: &v})
		})
	}
}

// aiErrorCode maps an error of internal/ai to its protocol code; "" when it
// is none.
func aiErrorCode(err error) string {
	var ae *ai.Error
	if !errors.As(err, &ae) {
		return ""
	}
	switch ae.Kind {
	case ai.KindBadConfig, ai.KindUnsupportedRole:
		return proto.ErrBadRequest
	case ai.KindNotReady:
		return proto.ErrInvalidState
	}
	return string(ae.Kind)
}

// auditAI is what an AI command leaves in the audit log: the role and which
// fields it named, never a key (not even its length).
func auditAI(cmd proto.Command) json.RawMessage {
	var a proto.AIFieldsArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	out := struct {
		Role      string `json:"role"`
		BaseURL   string `json:"base_url,omitempty"`
		Model     string `json:"model,omitempty"`
		KeyGiven  bool   `json:"key_given,omitempty"`
		ExtraBody bool   `json:"extra_body,omitempty"`
	}{Role: clip(a.Role), KeyGiven: a.Key != nil && *a.Key != "", ExtraBody: len(a.ExtraBody) > 0}
	if a.BaseURL != nil {
		out.BaseURL = clip(ai.Scrub(*a.BaseURL))
	}
	if a.Model != nil {
		out.Model = clip(ai.Scrub(*a.Model))
	}
	return mustJSON(out)
}
