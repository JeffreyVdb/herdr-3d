package hireintent

import (
	"fmt"
	"maps"
	"slices"
)

// #190: the models the user sees. Settings → Harness models hides models of
// the Hire dialog per browser (h3d.hire.hiddenModels); hire.interpret
// carries that list, and interpretation reads the bridge's catalog minus
// those models. The list can only take models away, never add one: an id
// the catalog does not have is ignored. What the bridge accepts
// (Catalog.Check: worker.hire, settings, presets) still reads the whole
// catalog.

// Hidden is the models hidden per harness: {"claude": [ids], "codex":
// [ids]}, the browser's h3d.hire.hiddenModels.
type Hidden map[string][]string

// Bounds of a Hidden list.
const (
	MaxHiddenHarnesses = 8
	MaxHiddenModels    = 256 // per harness
	MaxHiddenIDBytes   = 200
)

// CheckHidden reports why h is not a hidden list: too many harnesses or
// ids, or an id (or harness) that is empty, too long or not text. Unknown
// harnesses and ids are not errors (Without ignores them).
func CheckHidden(h Hidden) error {
	if len(h) > MaxHiddenHarnesses {
		return fmt.Errorf("at most %d harnesses, got %d", MaxHiddenHarnesses, len(h))
	}
	for _, name := range slices.Sorted(maps.Keys(h)) {
		if !shortText(name) {
			return fmt.Errorf("a harness must be 1-%d bytes of text", MaxHiddenIDBytes)
		}
		ids := h[name]
		if len(ids) > MaxHiddenModels {
			return fmt.Errorf("%s: at most %d models, got %d", name, MaxHiddenModels, len(ids))
		}
		for _, id := range ids {
			if !shortText(id) {
				return fmt.Errorf("%s: a model must be 1-%d bytes of text", name, MaxHiddenIDBytes)
			}
		}
	}
	return nil
}

func shortText(s string) bool { return s != "" && len(s) <= MaxHiddenIDBytes && ValidText(s) }

// Without is c minus the models h hides, their extra efforts and readable
// names with them. A harness with every model hidden has none (a harness
// named then is Invalid, as one with an empty catalog).
func (c Catalog) Without(h Hidden) Catalog {
	if len(h) == 0 {
		return c
	}
	keep := func(name string, hc HarnessCatalog) HarnessCatalog {
		hide := h[name]
		if len(hide) == 0 {
			return hc
		}
		out := HarnessCatalog{Efforts: hc.Efforts}
		for _, id := range hc.Models {
			if slices.Contains(hide, id) {
				continue
			}
			out.Models = append(out.Models, id)
			if extra, ok := hc.ExtraEfforts[id]; ok {
				if out.ExtraEfforts == nil {
					out.ExtraEfforts = map[string][]string{}
				}
				out.ExtraEfforts[id] = extra
			}
			if l, ok := hc.ModelLabels[id]; ok {
				if out.ModelLabels == nil {
					out.ModelLabels = map[string]string{}
				}
				out.ModelLabels[id] = l
			}
		}
		if out.Models == nil {
			out.Models = []string{}
		}
		return out
	}
	return Catalog{Claude: keep("claude", c.Claude), Codex: keep("codex", c.Codex)}
}

// hiddenIn reports whether model is one of harness's in full but not in vis.
func hiddenIn(full, vis Catalog, harness, model string) bool {
	f, _ := full.Harness(harness)
	v, _ := vis.Harness(harness)
	return slices.Contains(f.Models, model) && !slices.Contains(v.Models, model)
}
