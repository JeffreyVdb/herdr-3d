package server

// #93 hire presets (hire_preset.*): a named first prompt with its harness,
// model and effort, on one floor or global. The hub keeps them in memory
// (mirroring hire_preset) and writes every change to the store first. Using
// one is an ordinary worker.hire the game sends with the preset's values:
// nothing here hires.

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
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
		Effort: p.Effort, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
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
	p.Name, p.Floor, p.Prompt, p.Harness, p.Model, p.Effort = name, a.Floor, a.Prompt, a.Harness, a.Model, a.Effort
	return nil
}

// hirePresetCommand runs hire_preset.create, .update and .delete.
func (h *Hub) hirePresetCommand(ctx context.Context, cmd proto.Command) (any, error) {
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
