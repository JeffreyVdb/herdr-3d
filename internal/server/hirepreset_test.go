package server_test

import (
	"context"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/herdr"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// catalogTuples are tuples of the bridge's catalog (server.HireOptions, the
// test bridges' own): a Claude one, a Codex model's extra effort, and a Codex
// model that does not take it.
func catalogTuples(t *testing.T) (claude, extra proto.Hire, plain string) {
	t.Helper()
	cat := server.HireOptions()
	claude = proto.Hire{Harness: "claude", Model: cat.Claude.Models[len(cat.Claude.Models)-1], Effort: cat.Claude.Efforts[0]}
	for _, m := range cat.Codex.Models {
		if e := cat.Codex.ExtraEfforts[m]; len(e) > 0 && extra.Model == "" {
			extra = proto.Hire{Harness: "codex", Model: m, Effort: e[0]}
		} else if len(e) == 0 && plain == "" {
			plain = m
		}
	}
	if extra.Model == "" || plain == "" || slices.Contains(cat.Codex.Efforts, extra.Effort) {
		t.Fatalf("catalog has no model-only effort: %+v", cat.Codex)
	}
	return claude, extra, plain
}

func hirePresetNames(ps []proto.HirePreset) []string {
	var out []string
	for _, p := range ps {
		out = append(out, p.Name+"@"+p.Floor)
	}
	return out
}

// #93: hire_preset.create / update / delete persist first, then every client
// hears of it; names are unique ignoring case within a scope only; every
// field is checked as worker.hire checks it (the prompt is required), the
// tuple against the catalog; the snapshot has them all after a restart.
func TestHirePresets(t *testing.T) {
	t.Parallel()
	claude, extra, plain := catalogTuples(t)
	hb := startHireBridge(t, nil)
	c := hb.c
	other := hb.connect(proto.Hello{Client: "other"})
	if w := other.snapshot().World; w.HirePresets == nil || len(w.HirePresets) != 0 {
		t.Fatalf("hire_presets = %#v, want []", w.HirePresets)
	}
	spec := func(name, floor string, h proto.Hire, prompt string) proto.HirePresetSpec {
		return proto.HirePresetSpec{Name: name, Floor: floor, Prompt: prompt, Harness: h.Harness, Model: h.Model, Effort: h.Effort}
	}
	const deploy = "Deploy the release to A, B and C.\nReport each one."

	evs, ack := c.mustAck(proto.CmdHirePresetCreate, spec(" Deploy ", "s", claude, deploy))
	var made proto.HirePreset
	raw, _ := json.Marshal(ack.Data)
	_ = json.Unmarshal(raw, &made)
	if !regexp.MustCompile(`^hp_[0-9a-f]{16}$`).MatchString(made.ID) || made.Name != "Deploy" || made.Floor != "s" || made.Prompt != deploy ||
		made.Harness != claude.Harness || made.Model != claude.Model || made.Effort != claude.Effort || made.CreatedAt == 0 || made.UpdatedAt != made.CreatedAt {
		t.Fatalf("created = %+v", made)
	}
	if len(evs) != 1 || evs[0].T != proto.EvHirePresetUpsert || evs[0].HirePreset == nil || *evs[0].HirePreset != made {
		t.Fatalf("create events = %+v", evs)
	}
	if ev := other.until(proto.EvHirePresetUpsert); *ev.HirePreset != made {
		t.Fatalf("other client: %+v", ev.HirePreset)
	}
	// A global one is no floor's: "floor" is left out.
	_, ack = c.mustAck(proto.CmdHirePresetCreate, spec("deploy", "", extra, "Deploy everywhere."))
	raw, _ = json.Marshal(ack.Data)
	if strings.Contains(string(raw), `"floor"`) {
		t.Fatalf("global preset JSON = %s", raw)
	}
	var global proto.HirePreset
	_ = json.Unmarshal(raw, &global)

	// Names: unique ignoring case in the scope; the same name on a floor and globally is fine (above).
	c.mustError(proto.CmdHirePresetCreate, spec("DEPLOY", "s", claude, "x"), proto.ErrNameTaken)
	c.mustError(proto.CmdHirePresetCreate, spec("Deploy", "", claude, "x"), proto.ErrNameTaken)
	for _, name := range []string{"", "  ", "tab\there", strings.Repeat("n", 41)} {
		c.mustError(proto.CmdHirePresetCreate, spec(name, "s", claude, "x"), proto.ErrBadRequest)
	}
	// Scope: a floor the bridge knows (unknown: unknown_session); no other keys.
	c.mustError(proto.CmdHirePresetCreate, spec("x", "nope", claude, "x"), proto.ErrUnknownSession)
	c.mustError(proto.CmdHirePresetCreate, map[string]any{"name": "x", "prompt": "x", "harness": claude.Harness, "model": claude.Model,
		"effort": claude.Effort, "building": "b1"}, proto.ErrBadRequest)
	// Prompt: worker.hire's rules, and required.
	for _, p := range []string{"", "  \n", "--force it", "a\x00b", strings.Repeat("x", herdr.MaxPrompt+1)} {
		c.mustError(proto.CmdHirePresetCreate, spec("x", "s", extra, p), proto.ErrBadRequest)
	}
	// Claude's prompt is typed: no control characters but line ends and tabs (Codex's is pasted).
	c.mustError(proto.CmdHirePresetCreate, spec("x", "s", claude, "ring \a"), proto.ErrBadRequest)
	c.mustAck(proto.CmdHirePresetCreate, spec("bell", "s", extra, "ring \a"))
	// Tuple: the catalog's (an effort only some models take is theirs only).
	for _, h := range []proto.Hire{
		{Harness: "claude", Model: "claude-haiku-0-0", Effort: claude.Effort},
		{Harness: "claude", Model: claude.Model, Effort: "ultra"},
		{Harness: "codex", Model: plain, Effort: extra.Effort},
		{Harness: "gemini", Model: claude.Model, Effort: claude.Effort},
		{Harness: "", Model: "", Effort: ""},
	} {
		c.mustError(proto.CmdHirePresetCreate, spec("x", "s", h, "x"), proto.ErrBadRequest)
	}

	// Update: the whole spec, its scope too; nothing changed sends nothing.
	if evs, _ := c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: spec("Deploy ", "s", claude, deploy)}); len(evs) != 0 {
		t.Fatalf("unchanged update emitted %+v", evs)
	}
	c.mustError(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: spec("Deploy", "", claude, deploy)}, proto.ErrNameTaken)
	c.mustError(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: spec("Deploy", "s", claude, "")}, proto.ErrBadRequest)
	c.mustError(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: "hp_ffffffffffffffff", HirePresetSpec: spec("y", "s", claude, "x")}, proto.ErrNotFound)
	next := spec("Deploy (Codex)", "s", proto.Hire{Harness: "codex", Model: plain, Effort: "low"}, "Deploy to A only.")
	evs, ack = c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: made.ID, HirePresetSpec: next})
	if len(evs) != 1 || evs[0].HirePreset.ID != made.ID || evs[0].HirePreset.Name != "Deploy (Codex)" || evs[0].HirePreset.Model != plain ||
		evs[0].HirePreset.Prompt != "Deploy to A only." || evs[0].HirePreset.CreatedAt != made.CreatedAt || evs[0].HirePreset.UpdatedAt <= made.UpdatedAt {
		t.Fatalf("update events = %+v", evs)
	}
	updated := *evs[0].HirePreset

	// Delete: hire_preset.removed for every client.
	evs, _ = c.mustAck(proto.CmdHirePresetDelete, proto.HirePresetDeleteArgs{ID: global.ID})
	if len(evs) != 1 || evs[0].T != proto.EvHirePresetRemoved || evs[0].ID != global.ID {
		t.Fatalf("delete events = %+v", evs)
	}
	if ev := other.until(proto.EvHirePresetRemoved); ev.ID != global.ID {
		t.Fatalf("other client: %+v", ev)
	}
	c.mustError(proto.CmdHirePresetDelete, proto.HirePresetDeleteArgs{ID: global.ID}, proto.ErrNotFound)

	hb.stop()
	hb = startHireBridgeAt(t, hb.db, nil)
	got := hb.connect(proto.Hello{}).snapshot().World.HirePresets
	if len(got) != 2 || got[0].Name != "bell" || got[1] != updated {
		t.Fatalf("after restart = %+v", got)
	}
}

// #93: a floor's presets are keyed by its floor id: two virtual floors on one
// session keep their own; renaming one or moving it to another building
// changes nothing; deleting one removes its own (hire_preset.removed) and
// none of the others; a floor not seen for now keeps its presets editable.
func TestHirePresetScopes(t *testing.T) {
	t.Parallel()
	claude, _, _ := catalogTuples(t)
	hb := startHireBridge(t, nil)
	c := hb.c
	floor := func(name string) string {
		_, ack := c.mustAck(proto.CmdFloorCreate, proto.FloorCreateArgs{Name: name, BaseSession: "s"})
		return ack.Data.(map[string]any)["id"].(string)
	}
	web, api := floor("Web"), floor("API")
	ids := map[string]string{}
	for _, f := range []string{"s", web, api, ""} {
		_, ack := c.mustAck(proto.CmdHirePresetCreate, proto.HirePresetSpec{Name: "Deploy", Floor: f, Prompt: "Deploy " + f,
			Harness: claude.Harness, Model: claude.Model, Effort: claude.Effort})
		ids[f] = ack.Data.(map[string]any)["id"].(string)
	}
	c.mustAck(proto.CmdFloorRename, proto.FloorRenameArgs{Floor: web, Name: "Frontend"})
	b1, b2 := createBuilding(c, "One"), createBuilding(c, "Two")
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "s", Building: &b1})
	c.mustAck(proto.CmdFloorAssign, proto.FloorAssignArgs{Session: "s", Building: &b2})
	if got := hirePresetNames(hb.connect(proto.Hello{}).snapshot().World.HirePresets); len(got) != 4 || !slices.Contains(got, "Deploy@"+web) || !slices.Contains(got, "Deploy@"+api) || !slices.Contains(got, "Deploy@s") || !slices.Contains(got, "Deploy@") {
		t.Fatalf("after rename and moves = %q", got)
	}

	evs, _ := c.mustAck(proto.CmdFloorDelete, proto.FloorDeleteArgs{Floor: web})
	var removed []string
	for _, ev := range evs {
		if ev.T == proto.EvHirePresetRemoved {
			removed = append(removed, ev.ID)
		}
	}
	if !slices.Equal(removed, []string{ids[web]}) {
		t.Fatalf("floor delete removed %q (events %q)", removed, eventTypes(evs))
	}
	if ps, _ := hb.st.HirePresets(context.Background()); len(ps) != 3 {
		t.Fatalf("stored = %+v", ps)
	}
	// A deleted floor is no scope any more.
	c.mustError(proto.CmdHirePresetCreate, proto.HirePresetSpec{Name: "x", Floor: web, Prompt: "x", Harness: claude.Harness, Model: claude.Model,
		Effort: claude.Effort}, proto.ErrUnknownSession)

	// A real floor the bridge does not see after a restart: its preset stays, and stays editable on it.
	hb.floorAt("t", true, nil)
	hb.c.until(proto.EvFloorUpsert)
	_, ack := c.mustAck(proto.CmdHirePresetCreate, proto.HirePresetSpec{Name: "On t", Floor: "t", Prompt: "x", Harness: claude.Harness,
		Model: claude.Model, Effort: claude.Effort})
	onT := ack.Data.(map[string]any)["id"].(string)
	hb.stop()
	hb = startHireBridgeAt(t, hb.db, nil)
	if got := hirePresetNames(hb.connect(proto.Hello{}).snapshot().World.HirePresets); !slices.Contains(got, "On t@t") || len(got) != 4 {
		t.Fatalf("after restart = %q", got)
	}
	hb.c.mustAck(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: onT, HirePresetSpec: proto.HirePresetSpec{Name: "Still t", Floor: "t",
		Prompt: "y", Harness: claude.Harness, Model: claude.Model, Effort: claude.Effort}})
	hb.c.mustError(proto.CmdHirePresetUpdate, proto.HirePresetUpdateArgs{ID: onT, HirePresetSpec: proto.HirePresetSpec{Name: "Still t", Floor: "u",
		Prompt: "y", Harness: claude.Harness, Model: claude.Model, Effort: claude.Effort}}, proto.ErrUnknownSession)
}
