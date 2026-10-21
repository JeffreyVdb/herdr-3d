package store_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/store"
)

// #93: a hire preset survives a restart with every field, by name ignoring
// case; an update replaces its name, scope, prompt and tuple and keeps its
// created_at; a delete is gone for good.
func TestHirePresetsPersist(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "world.db")
	st := open(t, path)
	deploy := store.HirePreset{ID: "hp_a", Name: "Deploy release", Floor: "herdr-3d", Prompt: "Deploy the release to A, B and C.",
		Harness: "claude", Model: "claude-sonnet-5-5", Effort: "low", CreatedAt: 1790000000000, UpdatedAt: 1790000000000}
	audit := store.HirePreset{ID: "hp_b", Name: "audit deps", Prompt: "Audit the dependencies.", Harness: "codex", Model: "gpt-6-luna",
		Effort: "medium", CreatedAt: 1790000000001, UpdatedAt: 1790000000001}
	for _, p := range []store.HirePreset{deploy, audit} {
		if err := st.CreateHirePreset(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	st.Close()
	st = open(t, path)
	if l, err := st.HirePresets(ctx); err != nil || !reflect.DeepEqual(l, []store.HirePreset{audit, deploy}) {
		t.Fatalf("listed = %+v, %v", l, err)
	}

	// The floor preset goes global: another prompt and tuple, the same id and created_at.
	next := deploy
	next.Name, next.Floor, next.Prompt, next.Model, next.Effort, next.UpdatedAt = " Deploy all ", "", "Deploy everywhere.", "claude-opus-5-5", "high", 1790000000500
	if err := st.UpdateHirePreset(ctx, next); err != nil {
		t.Fatal(err)
	}
	next.Name = "Deploy all"
	if l, _ := st.HirePresets(ctx); !reflect.DeepEqual(l, []store.HirePreset{audit, next}) {
		t.Fatalf("after update = %+v", l)
	}
	if err := st.UpdateHirePreset(ctx, store.HirePreset{ID: "nope", Name: "x", Prompt: "p", Harness: "claude", Model: "m", Effort: "e"}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("update unknown: %v", err)
	}
	if err := st.DeleteHirePreset(ctx, "hp_a"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteHirePreset(ctx, "hp_a"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("delete twice: %v", err)
	}
	st.Close()
	st = open(t, path)
	if l, _ := st.HirePresets(ctx); !reflect.DeepEqual(l, []store.HirePreset{audit}) {
		t.Fatalf("after delete and restart = %+v", l)
	}
}

// #93: names are unique ignoring case within a scope (one floor, or global);
// the same name on another floor, and on a floor and globally, is allowed.
// Names follow the team presets' rules.
func TestHirePresetScopedNames(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	n := 0
	add := func(name, floor string) error {
		n++
		return st.CreateHirePreset(ctx, store.HirePreset{ID: "hp_" + string(rune('a'+n)), Name: name, Floor: floor, Prompt: "p",
			Harness: "claude", Model: "m", Effort: "e"})
	}
	for _, c := range []struct{ name, floor string }{{"Deploy", "s"}, {"Deploy", "t"}, {"Deploy", ""}, {"Deploy", "v-0123456789ab"}, {"Deploy", "v-ba9876543210"}} {
		if err := add(c.name, c.floor); err != nil {
			t.Fatalf("%q on %q: %v", c.name, c.floor, err)
		}
	}
	for _, c := range []struct{ name, floor string }{{"deploy", "s"}, {" DEPLOY ", ""}, {"Deploy", "v-0123456789ab"}} {
		if err := add(c.name, c.floor); !errors.Is(err, store.ErrNameTaken) {
			t.Fatalf("%q on %q again: %v", c.name, c.floor, err)
		}
	}
	for _, name := range []string{"", "   ", "a\tb", string(make([]byte, 41))} {
		if err := add(name, "s"); !errors.Is(err, store.ErrInvalid) {
			t.Fatalf("name %q: %v", name, err)
		}
	}
	// Moving into a scope that has the name is refused too; renaming to itself (another case) is not.
	l, _ := st.HirePresets(ctx)
	var onS, onT store.HirePreset
	for _, p := range l {
		switch p.Floor {
		case "s":
			onS = p
		case "t":
			onT = p
		}
	}
	onT.Floor = "s"
	if err := st.UpdateHirePreset(ctx, onT); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("move into a taken scope: %v", err)
	}
	onS.Name = "DEPLOY"
	if err := st.UpdateHirePreset(ctx, onS); err != nil {
		t.Fatalf("rename to itself: %v", err)
	}
}

// #93: deleting a virtual floor deletes its own presets only: another
// virtual floor on the same session, the real floor and the global ones keep
// theirs. Renaming, hiding and moving a floor change none.
func TestHirePresetsFollowTheFloor(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	if _, err := st.CreateBuilding(ctx, "b1", "Work"); err != nil {
		t.Fatal(err)
	}
	if err := st.AssignFloor(ctx, "s", "b1", 0); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"v-0123456789ab", "v-ba9876543210"} {
		if _, err := st.CreateVirtualFloor(ctx, id, "Side "+id, "s"); err != nil {
			t.Fatal(err)
		}
	}
	for i, floor := range []string{"s", "v-0123456789ab", "v-ba9876543210", ""} {
		p := store.HirePreset{ID: "hp_" + string(rune('a'+i)), Name: "Deploy", Floor: floor, Prompt: "p", Harness: "claude", Model: "m", Effort: "e"}
		if err := st.CreateHirePreset(ctx, p); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.RenameVirtualFloor(ctx, "v-0123456789ab", "Renamed"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetFloorHidden(ctx, "v-0123456789ab", true); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateBuilding(ctx, "b2", "Other"); err != nil {
		t.Fatal(err)
	}
	if err := st.AssignFloor(ctx, "s", "b2", 0); err != nil {
		t.Fatal(err)
	}
	floors := func() []string {
		l, err := st.HirePresets(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, p := range l {
			out = append(out, p.Floor)
		}
		return out
	}
	if got := floors(); !reflect.DeepEqual(got, []string{"s", "v-0123456789ab", "v-ba9876543210", ""}) {
		t.Fatalf("after rename, hide, move = %q", got)
	}
	if err := st.DeleteVirtualFloor(ctx, "v-0123456789ab", false); err != nil {
		t.Fatal(err)
	}
	if got := floors(); !reflect.DeepEqual(got, []string{"s", "v-ba9876543210", ""}) {
		t.Fatalf("after deleting the floor = %q", got)
	}
}

// #93: the scope's names ignore case beyond ASCII, as the game's
// toLowerCase does: "Équipe" and "équipe" are one name on a floor and
// globally, on create and on update, yet allowed once per scope.
func TestHirePresetNamesFoldUnicode(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	add := func(id, name, floor string) error {
		return st.CreateHirePreset(ctx, store.HirePreset{ID: id, Name: name, Floor: floor, Prompt: "p", Harness: "claude", Model: "m", Effort: "e"})
	}
	for i, floor := range []string{"s", "t", "v-0123456789ab", ""} {
		if err := add("hp_"+string(rune('a'+i)), "Équipe", floor); err != nil {
			t.Fatalf("Équipe on %q: %v", floor, err)
		}
	}
	for _, c := range []struct{ name, floor string }{{"équipe", "s"}, {"ÉQUIPE", ""}, {"équipe", "v-0123456789ab"}} {
		if err := add("hp_x", c.name, c.floor); !errors.Is(err, store.ErrNameTaken) {
			t.Fatalf("%q on %q: %v", c.name, c.floor, err)
		}
	}
	// Renaming to the other case of another's name in the scope is refused; moving there too.
	if err := add("hp_e", "Straße", "s"); err != nil {
		t.Fatal(err)
	}
	rename := store.HirePreset{ID: "hp_e", Name: "équipe", Floor: "s", Prompt: "p", Harness: "claude", Model: "m", Effort: "e"}
	if err := st.UpdateHirePreset(ctx, rename); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("rename to équipe: %v", err)
	}
	if err := add("hp_f", "équipe", "u"); err != nil {
		t.Fatal(err)
	}
	move := store.HirePreset{ID: "hp_f", Name: "équipe", Floor: "", Prompt: "p", Harness: "claude", Model: "m", Effort: "e"}
	if err := st.UpdateHirePreset(ctx, move); !errors.Is(err, store.ErrNameTaken) {
		t.Fatalf("move équipe global: %v", err)
	}
	// Its own name in another case is fine.
	rename.ID, rename.Name = "hp_a", "ÉQUIPE"
	if err := st.UpdateHirePreset(ctx, rename); err != nil {
		t.Fatalf("rename to itself: %v", err)
	}
}

// #93: the bridge compares names with full Unicode case folding, so it is at
// least as strict as the game's toLowerCase: a final sigma (ος, ΟΣ), a dotted
// capital I (İ, i plus U+0307) and accents are one name each way. Folding
// also joins names the game keeps apart (STRASSE and straße): the bridge
// refuses the second with ErrNameTaken, which the editor shows on the name.
// Each pair is still free in another scope.
func TestHirePresetNamesCaseFold(t *testing.T) {
	ctx := context.Background()
	st := open(t, filepath.Join(t.TempDir(), "world.db"))
	n := 0
	add := func(name, floor string) error {
		n++
		return st.CreateHirePreset(ctx, store.HirePreset{ID: fmt.Sprintf("hp_%d", n), Name: name, Floor: floor, Prompt: "p", Harness: "claude", Model: "m", Effort: "e"})
	}
	for _, names := range [][]string{
		{"ΟΣ", "ος", "Ος", "οσ"},
		{"İ", "i̇"},
		{"Équipe", "équipe", "ÉQUIPE"},
		{"STRASSE", "straße", "Strasse"},
		{"Ꭰ", "ꭰ"},
	} {
		for _, floor := range []string{"s", "t", "v-0123456789ab", ""} {
			if err := add(names[0], floor); err != nil {
				t.Fatalf("%q on %q: %v", names[0], floor, err)
			}
			for _, other := range names[1:] {
				if err := add(other, floor); !errors.Is(err, store.ErrNameTaken) {
					t.Fatalf("%q on %q after %q: %v", other, floor, names[0], err)
				}
			}
		}
		if err := add(names[len(names)-1], "u"); err != nil {
			t.Fatalf("%q on a floor without %q: %v", names[len(names)-1], names[0], err)
		}
	}
}

// #95: a database from before "Add herdr hiring instructions" keeps its
// presets with the box off; the flag is stored, survives a restart and an
// update replaces it.
func TestHirePresetInstructions(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	created := slices.IndexFunc(store.Migrations, func(q string) bool { return strings.Contains(q, "CREATE TABLE hire_preset") })
	if created < 0 || created == len(store.Migrations)-1 {
		t.Fatalf("hire_preset is created by migration %d of %d", created, len(store.Migrations))
	}
	before := created + 1
	for _, q := range store.Migrations[:before] {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range []string{
		"PRAGMA user_version = " + strconv.Itoa(before),
		`INSERT INTO hire_preset (id, name, name_key, floor, prompt, harness, model, effort, created_at, updated_at)
			VALUES ('hp_old', 'Old', 'old', NULL, 'For each PR, spawn a subagent.', 'claude', 'm', 'e', 1, 1)`,
	} {
		if _, err := db.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	st := open(t, path)
	old := store.HirePreset{ID: "hp_old", Name: "Old", Prompt: "For each PR, spawn a subagent.", Harness: "claude", Model: "m", Effort: "e", CreatedAt: 1, UpdatedAt: 1}
	if l, err := st.HirePresets(ctx); err != nil || !reflect.DeepEqual(l, []store.HirePreset{old}) {
		t.Fatalf("migrated = %+v, %v", l, err)
	}
	ticked := store.HirePreset{ID: "hp_new", Name: "New", Floor: "s", Prompt: "Hire reviewers.", Harness: "codex", Model: "m", Effort: "e",
		HerdrInstructions: true, CreatedAt: 2, UpdatedAt: 2}
	if err := st.CreateHirePreset(ctx, ticked); err != nil {
		t.Fatal(err)
	}
	on := old
	on.HerdrInstructions, on.UpdatedAt = true, 3
	if err := st.UpdateHirePreset(ctx, on); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if l, _ := st.HirePresets(ctx); !reflect.DeepEqual(l, []store.HirePreset{ticked, on}) {
		t.Fatalf("after restart = %+v", l)
	}
	off := ticked
	off.HerdrInstructions, off.UpdatedAt = false, 4
	if err := st.UpdateHirePreset(ctx, off); err != nil {
		t.Fatal(err)
	}
	if l, _ := st.HirePresets(ctx); !reflect.DeepEqual(l, []store.HirePreset{off, on}) {
		t.Fatalf("after unticking = %+v", l)
	}
}

// #139: a preset keeps its Codex profile's key.
func TestHirePresetCodexProfile(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "w.db")
	st := open(t, path)
	p := store.HirePreset{ID: "hp_w", Name: "On work", Prompt: "Review it.", Harness: "codex", Model: "m", Effort: "e", CodexProfile: "work",
		CreatedAt: 1, UpdatedAt: 1}
	if err := st.CreateHirePreset(ctx, p); err != nil {
		t.Fatal(err)
	}
	p.CodexProfile, p.UpdatedAt = "", 2
	if err := st.UpdateHirePreset(ctx, p); err != nil {
		t.Fatal(err)
	}
	q := store.HirePreset{ID: "hp_x", Name: "Other", Prompt: "Fix it.", Harness: "codex", Model: "m", Effort: "e", CodexProfile: "team-32b74a",
		CreatedAt: 3, UpdatedAt: 3}
	if err := st.CreateHirePreset(ctx, q); err != nil {
		t.Fatal(err)
	}
	st.Close()
	st = open(t, path)
	if l, err := st.HirePresets(ctx); err != nil || !reflect.DeepEqual(l, []store.HirePreset{p, q}) {
		t.Fatalf("presets = %+v, %v", l, err)
	}
}
