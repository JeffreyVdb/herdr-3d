package server

// #93 hire presets (hire_preset.*): a named first prompt with its harness,
// model and effort, on one floor or global. The hub keeps them in memory
// (mirroring hire_preset) and writes every change to the store first. Using
// one is an ordinary worker.hire the game sends with the preset's values:
// nothing here hires. #95: hire_preset.check asks the classifier whether a
// prompt hands work to other agents, for the editor's nudge to tick "Add
// herdr hiring instructions".

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/ai"
	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/promptsecret"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

func (h *Hub) loadHirePresets(ctx context.Context) error {
	all, err := h.st.HirePresets(ctx)
	if err != nil {
		return err
	}
	h.hirePresets = map[string]store.HirePreset{}
	for _, p := range all {
		h.hirePresets[p.ID] = p
	}
	return nil
}

func hirePresetView(p store.HirePreset) proto.HirePreset {
	return proto.HirePreset{ID: p.ID, Name: p.Name, Floor: p.Floor, Prompt: p.Prompt, Harness: p.Harness, Model: p.Model,
		Effort: p.Effort, HerdrInstructions: p.HerdrInstructions, CodexProfile: p.CodexProfile, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
}

// hirePresetViews are the snapshot's hire_presets: by name ignoring case,
// never nil.
func (h *Hub) hirePresetViews() []proto.HirePreset {
	out := make([]proto.HirePreset, 0, len(h.hirePresets))
	for _, p := range h.hirePresets {
		out = append(out, hirePresetView(p))
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// applyHirePresetSpec checks a and writes it into p. A floor must be one
// the bridge knows (a real floor it sees, or a defined virtual floor),
// unless it is p's floor already: a floor not seen for now keeps its
// presets editable. The prompt and the tuple follow worker.hire's rules,
// and the prompt is required.
func (h *Hub) applyHirePresetSpec(p *store.HirePreset, a proto.HirePresetSpec) error {
	name, err := store.CleanPresetName(a.Name)
	if err != nil {
		return err
	}
	if a.Floor != "" && a.Floor != p.Floor {
		if _, err := h.floorFor(a.Floor); err != nil {
			if _, defined := h.vfloors[a.Floor]; !defined {
				return err
			}
		}
	}
	if err := validHireIn(h.hireOptions(), proto.Hire{Harness: a.Harness, Model: a.Model, Effort: a.Effort}); err != nil {
		return &badArgsError{err}
	}
	if !herdr.CanStart(a.Harness) {
		return bad("cannot start harness %q", a.Harness)
	}
	if !herdr.ValidPrompt(a.Prompt) {
		return bad("prompt must be 1-%d bytes of text, not starting with \"--\"", herdr.MaxPrompt)
	}
	if err := checkTyped(a.Harness, a.Prompt, herdr.MaxPrompt, "prompt"); err != nil {
		return err
	}
	if err := h.checkProfileKey(a.Harness, a.CodexProfile, p.CodexProfile); err != nil { // #139: a gone one it had stays
		return err
	}
	if a.Harness != "codex" && a.CodexProfile != "" {
		return bad("codex_profile is for a Codex hire, not %q", a.Harness)
	}
	p.Name, p.Floor, p.Prompt, p.Harness, p.Model, p.Effort = name, a.Floor, a.Prompt, a.Harness, a.Model, a.Effort
	p.HerdrInstructions, p.CodexProfile = a.HerdrInstructions, a.CodexProfile
	return nil
}

// startHirePreset runs hire_preset.create, .update and .delete (hub
// goroutine). #108 round 2: with prompt secrets reviewed, a create's or an
// update's prompt is scanned first (off the hub goroutine): stored only
// when nothing was found or its review leaves every candidate as typed,
// with that record (a preset's prompt reaches an agent only through a
// worker.hire, reviewed there).
func (h *Hub) startHirePreset(ctx context.Context, c *Client, cmd proto.Command) error {
	end := func(ctx context.Context, record *string) error {
		data, err := h.hirePresetCommand(ctx, cmd, record)
		if err != nil {
			return err
		}
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, data, nil)
		return nil
	}
	var spec proto.HirePresetSpec
	switch cmd.T {
	case proto.CmdHirePresetCreate:
		if err := decodeArgs(cmd.Args, &spec); err != nil {
			return err
		}
	case proto.CmdHirePresetUpdate:
		var a proto.HirePresetUpdateArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return err
		}
		spec = a.HirePresetSpec
	}
	if !h.gated(spec.Secrets != nil) {
		return end(ctx, nil)
	}
	return h.storedGate(ctx, c, cmd, spec.Prompt, spec.Secrets, end)
}

// hirePresetCommand runs hire_preset.create, .update and .delete. record
// (#108) is the record of the review of the prompt (nil: none made, as the
// switch is off: an update keeps the one it had, which matches only the
// text it was made of).
func (h *Hub) hirePresetCommand(ctx context.Context, cmd proto.Command, record *string) (any, error) {
	now := h.opts.Now().UnixMilli()
	switch cmd.T {
	case proto.CmdHirePresetCreate:
		var a proto.HirePresetSpec
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return nil, err
		}
		p := store.HirePreset{ID: "hp_" + randHex(8), CreatedAt: now, UpdatedAt: now}
		if err := h.applyHirePresetSpec(&p, a); err != nil {
			return nil, err
		}
		if record != nil {
			p.SecretsReview = *record
		}
		if err := h.st.CreateHirePreset(ctx, p); err != nil {
			return nil, err
		}
		h.hirePresets[p.ID] = p
		v := hirePresetView(p)
		h.emit(proto.Event{T: proto.EvHirePresetUpsert, HirePreset: &v})
		h.log.Info("hire preset created", "preset", p.ID, "floor", p.Floor)
		return v, nil

	case proto.CmdHirePresetUpdate:
		var a proto.HirePresetUpdateArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return nil, err
		}
		cur, ok := h.hirePresets[a.ID]
		if !ok {
			return nil, fmt.Errorf("%w: hire preset %q", store.ErrNotFound, a.ID)
		}
		next := cur
		if err := h.applyHirePresetSpec(&next, a.HirePresetSpec); err != nil {
			return nil, err
		}
		if record != nil {
			next.SecretsReview = *record
		}
		if next == cur {
			return hirePresetView(cur), nil
		}
		next.UpdatedAt = max(now, cur.UpdatedAt+1)
		if err := h.st.UpdateHirePreset(ctx, next); err != nil {
			return nil, err
		}
		h.hirePresets[next.ID] = next
		v := hirePresetView(next)
		h.emit(proto.Event{T: proto.EvHirePresetUpsert, HirePreset: &v})
		return v, nil

	case proto.CmdHirePresetDelete:
		var a proto.HirePresetDeleteArgs
		if err := decodeArgs(cmd.Args, &a); err != nil {
			return nil, err
		}
		if _, ok := h.hirePresets[a.ID]; !ok {
			return nil, fmt.Errorf("%w: hire preset %q", store.ErrNotFound, a.ID)
		}
		if err := h.st.DeleteHirePreset(ctx, a.ID); err != nil {
			return nil, err
		}
		delete(h.hirePresets, a.ID)
		h.emit(proto.Event{T: proto.EvHirePresetRemoved, ID: a.ID})
		return nil, nil
	}
	return nil, fmt.Errorf("%w: %q", errUnknownCommand, cmd.T)
}

// dropFloorHirePresets forgets a deleted virtual floor's own presets (the
// store deleted them with the floor) and tells the clients.
func (h *Hub) dropFloorHirePresets(floor string) {
	var ids []string
	for id, p := range h.hirePresets {
		if p.Floor == floor {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		delete(h.hirePresets, id)
		h.emit(proto.Event{T: proto.EvHirePresetRemoved, ID: id})
	}
}

// #95 hire_preset.check: the classifier's question, the score from which a
// prompt delegates (followup's default: a false positive is one question the
// player dismisses, a miss puts agents on the wrong floor), and the bound
// of the call (the game gives up at 1.5 s, as for packup.detect). #127: a
// workspace recreated to resume another agent's conversation is delegation
// too (it lost its floor tag).
const (
	hirePresetCheckQuestion = "Does this task tell the AI coding agent to start, spawn, hire, resume or hand work to other AI agents " +
		"(subagents, workers, coders, reviewers), including recreating a workspace to resume another agent, " +
		"instead of doing all of it itself?"
	hirePresetCheckThreshold = 0.7
	hirePresetCheckTimeout   = 1200 * time.Millisecond
)

// HirePresetRoles is what hire_preset.check needs of the AI integration
// (*ai.Service): the classifier and its state.
type HirePresetRoles interface {
	State(r ai.Role) ai.State
	Classifier() ai.Classifier
}

// hirePresetRoles is the classifier's owner (Options.HirePresetRoles, else
// the AI integration; nil: none, every check answers delegates false).
func (h *Hub) hirePresetRoles() HirePresetRoles {
	if h.opts.HirePresetRoles != nil {
		return h.opts.HirePresetRoles
	}
	if h.opts.AI != nil {
		return h.opts.AI
	}
	return nil
}

// startHirePresetCheck answers hire_preset.check off the hub goroutine. It
// fails open: no classifier, one not ready (no call), an error or a timeout
// answer delegates false, and the preset saves as it is. Neither the prompt
// nor an error's text is logged (a provider may echo the prompt). #108
// round 2: with prompt secrets reviewed, the prompt is reviewed as the
// preset stores it first (storedReview: never a protected value, so the
// classifier reads it as typed); refused, nothing is classified.
func (h *Hub) startHirePresetCheck(ctx context.Context, c *Client, cmd proto.Command) error {
	var a proto.HirePresetCheckArgs
	if err := decodeArgs(cmd.Args, &a); err != nil {
		return err
	}
	if strings.TrimSpace(a.Prompt) == "" || !herdr.ValidPrompt(a.Prompt) {
		return bad("prompt must be 1-%d bytes of text, got %d bytes", herdr.MaxPrompt, len(a.Prompt))
	}
	var gate func(context.Context) error
	var rev *promptsecret.Reviewer
	if h.gated(a.Secrets != nil) {
		if err := h.stillOn(); err != nil {
			return err
		}
		rev = h.ps.rev
		gate = func(ctx context.Context) error {
			if _, err := h.storedReview(ctx, rev, a.Prompt, a.Secrets); err != nil {
				return err
			}
			return h.reviewCurrent(rev) // review B2: the switch changed while it waited
		}
	}
	roles, timeout := h.hirePresetRoles(), h.opts.HirePresetCheckTimeout
	if timeout <= 0 {
		timeout = hirePresetCheckTimeout
	}
	if gate == nil && (roles == nil || roles.State(ai.RoleClassifier) != ai.StateReady) {
		h.audit(ctx, c, cmd, nil)
		h.reply(c, cmd, proto.HirePresetCheckResult{}, nil)
		return nil
	}
	h.startAsync(ctx, c, cmd, func(ctx context.Context) (any, error) {
		if gate != nil {
			if err := gate(ctx); err != nil {
				return nil, err
			}
			if roles == nil || roles.State(ai.RoleClassifier) != ai.StateReady {
				return proto.HirePresetCheckResult{}, nil
			}
		}
		cls := roles.Classifier()
		cctx, cancel := context.WithTimeout(ai.WithGate(ctx, func() error { return h.reviewHolds(rev, a.Prompt) }), timeout)
		defer cancel()
		score, err := cls.Classify(cctx, map[string]any{"prompt": a.Prompt}, hirePresetCheckQuestion)
		if err := h.reviewHolds(rev, a.Prompt); err != nil {
			// Review B2, pass 2: the switch changed while the call waited for
			// a model slot, or ran; round 5: or a file it refers to was revoked.
			return nil, err
		}
		if err != nil {
			if !errors.Is(err, ai.ErrNotReady) && ctx.Err() == nil {
				h.log.Warn("hire preset check failed", "kind", ai.KindOf(err))
			}
			return proto.HirePresetCheckResult{}, nil
		}
		res := proto.HirePresetCheckResult{Delegates: score >= hirePresetCheckThreshold, Score: score}
		h.log.Info("hire preset checked", "score", score, "delegates", res.Delegates, "prompt_bytes", len(a.Prompt))
		return res, nil
	})
	return nil
}

// auditHirePresetCheck is what hire_preset.check leaves in the audit log:
// the prompt's length, never its text.
func auditHirePresetCheck(cmd proto.Command) json.RawMessage {
	var a proto.HirePresetCheckArgs
	if json.Unmarshal(cmd.Args, &a) != nil {
		return redacted(cmd.Args)
	}
	return mustJSON(struct {
		PromptBytes int           `json:"prompt_bytes"`
		Secrets     *secretsAudit `json:"secrets,omitempty"` // #108 round 2: the decisions' counts
	}{len(a.Prompt), auditReviews(a.Secrets)})
}
