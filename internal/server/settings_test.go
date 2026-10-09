package server_test

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// The fallback catalog is handed out as a copy: changing one leaves the next as it was.
func TestHireOptionsCopy(t *testing.T) {
	a := server.HireOptions()
	a.Codex.ModelLabels["gpt-6-sol"], a.Codex.ExtraEfforts["gpt-6-sol"][0], a.Codex.Models[0] = "x", "x", "x"
	a.Claude.Models[0], a.Claude.Efforts[0] = "x", "x"
	b := server.HireOptions()
	if b.Codex.ModelLabels["gpt-6-sol"] != "GPT-6-Sol" || b.Codex.ExtraEfforts["gpt-6-sol"][0] != "ultra" || b.Codex.Models[0] != "gpt-6-sol" ||
		b.Claude.Models[0] != "claude-opus-5-5" || b.Claude.Efforts[0] != "low" {
		t.Fatalf("second copy = %+v", b)
	}
	if len(b.Codex.ModelLabels) != len(b.Codex.Models) {
		t.Fatalf("every fallback Codex model has a label: %+v", b.Codex)
	}
}

func TestFloorSettings(t *testing.T) {
	db := filepath.Join(t.TempDir(), "world.db")
	home := t.TempDir()
	b := startBridge(t, db, server.Options{})
	b.floor("s", true)
	b.floor("gone", false)
	c := b.connect(proto.Hello{Client: "settings"})
	snap := c.snapshot()
	if h := snap.World.HireOptions; h == nil || !reflect.DeepEqual(*h, server.HireOptions()) || h.Codex.ExtraEfforts["gpt-6-sol"][0] != "ultra" ||
		h.Codex.ModelLabels["gpt-6-sol"] != "GPT-6-Sol" {
		t.Fatalf("hire_options = %+v", snap.World.HireOptions)
	}
	if f := floorOf(snap.World, "s"); f.Settings != nil || f.Suggested != nil {
		t.Fatalf("fresh floor = %+v", f)
	}

	status := proto.StatusField{Name: "Status", Options: []string{"Todo", "Doing", "QA", "Done"}}
	full := proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/herdr-3d"),
		Project: proto.Some(proto.Project{Owner: "JeffreyVdb", Number: 3}), StatusField: proto.Some(status),
		DefaultCwd: proto.Some(home + "/"), DefaultHire: proto.Some(proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "ultra"})}
	evs, _ := c.mustAck(proto.CmdFloorSettings, full)
	want := proto.FloorSettings{Repo: "JeffreyVdb/herdr-3d", Project: &proto.Project{Owner: "JeffreyVdb", Number: 3},
		StatusField: &status, DefaultCwd: home, DefaultHire: &proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "ultra"}}
	if len(evs) != 1 || evs[0].T != proto.EvFloorUpsert || !reflect.DeepEqual(*evs[0].Floor.Settings, want) {
		t.Fatalf("set events = %+v", evs)
	}
	// Absent keys stay; setting what is already set changes nothing.
	if evs, _ := c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s"}); len(evs) != 0 {
		t.Fatalf("no-op events = %+v", evs)
	}
	if evs, _ := c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/herdr-3d")}); len(evs) != 0 {
		t.Fatalf("same value events = %+v", evs)
	}
	// null clears one key.
	evs, _ = c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Project: proto.Null[proto.Project](),
		DefaultHire: proto.Some(proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "max"})})
	want.Project, want.DefaultHire = nil, &proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "max"}
	if len(evs) != 1 || !reflect.DeepEqual(*evs[0].Floor.Settings, want) {
		t.Fatalf("clear events = %+v", evs)
	}
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "gone", Repo: proto.Some("o/r")})

	file := filepath.Join(home, "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	for name, args := range map[string]any{
		"bad repo":        proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("not a repo")},
		"repo no owner":   proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("herdr-3d")},
		"project zero":    proto.FloorSettingsArgs{Session: "s", Project: proto.Some(proto.Project{Owner: "o", Number: 0})},
		"project owner":   proto.FloorSettingsArgs{Session: "s", Project: proto.Some(proto.Project{Owner: "a b", Number: 1})},
		"project float":   map[string]any{"session": "s", "project": map[string]any{"owner": "o", "number": 1.5}},
		"project extra":   map[string]any{"session": "s", "project": map[string]any{"owner": "o", "number": 1, "url": "x"}},
		"no options":      proto.FloorSettingsArgs{Session: "s", StatusField: proto.Some(proto.StatusField{Name: "Status"})},
		"dup options":     proto.FloorSettingsArgs{Session: "s", StatusField: proto.Some(proto.StatusField{Name: "S", Options: []string{"a", "a"}})},
		"empty option":    proto.FloorSettingsArgs{Session: "s", StatusField: proto.Some(proto.StatusField{Name: "S", Options: []string{" "}})},
		"long name":       proto.FloorSettingsArgs{Session: "s", StatusField: proto.Some(proto.StatusField{Name: strings.Repeat("x", 65), Options: []string{"a"}})},
		"21 options":      proto.FloorSettingsArgs{Session: "s", StatusField: proto.Some(proto.StatusField{Name: "S", Options: strings.Split("a b c d e f g h i j k l m n o p q r s t u", " ")})},
		"relative cwd":    proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some("devel/x")},
		"missing cwd":     proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some(filepath.Join(home, "nope"))},
		"file cwd":        proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some(file)},
		"bad harness":     proto.FloorSettingsArgs{Session: "s", DefaultHire: proto.Some(proto.Hire{Harness: "opencode", Model: "x", Effort: "low"})},
		"bad model":       proto.FloorSettingsArgs{Session: "s", DefaultHire: proto.Some(proto.Hire{Harness: "claude", Model: "gpt-6-sol", Effort: "low"})},
		"bad effort":      proto.FloorSettingsArgs{Session: "s", DefaultHire: proto.Some(proto.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "ultra"})},
		"ultra for luna":  proto.FloorSettingsArgs{Session: "s", DefaultHire: proto.Some(proto.Hire{Harness: "codex", Model: "gpt-6-luna", Effort: "ultra"})},
		"unknown key":     map[string]any{"session": "s", "colour": "red"},
		"repo not string": map[string]any{"session": "s", "repo": 7},
	} {
		_, m := c.command(proto.CmdFloorSettings, name, args)
		if e := errorOf(m); m.env.T != proto.TError || e.Code != proto.ErrBadRequest {
			t.Errorf("%s: %s", name, m.raw)
		}
	}
	c.mustError(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "nope", Repo: proto.Some("o/r")}, proto.ErrUnknownSession)
	b.stop()

	// Settings survive a restart, also for a session that is gone for now.
	b2 := startBridge(t, db, server.Options{})
	b2.floor("s", false)
	w := b2.world(func(w proto.World) bool { return len(w.Floors) == 1 })
	if f := floorOf(w, "s"); f.Settings == nil || !reflect.DeepEqual(*f.Settings, want) {
		t.Fatalf("after restart = %+v", f.Settings)
	}
	b2.floor("gone", false)
	w = b2.world(func(w proto.World) bool { return len(w.Floors) == 2 })
	if f := floorOf(w, "gone"); f.Settings == nil || f.Settings.Repo != "o/r" {
		t.Fatalf("returning session = %+v", f)
	}
}

// fakeOrigins is Options.RepoOf from a map, counting lookups.
type fakeOrigins struct {
	mu    sync.Mutex
	repos map[string]string
	asked map[string]int
}

func (f *fakeOrigins) repoOf(_ context.Context, dir string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked[dir]++
	return f.repos[dir]
}

func inRepo(ws, cwd, root string) world.WorkerObs {
	w := worker(ws, "CODE|"+ws, "", "idle")
	w.Cwd = cwd
	if root != "" {
		w.Worktree = &world.Worktree{RepoRoot: root, CheckoutPath: cwd, Linked: root != cwd}
	}
	return w
}

func TestRepoSuggestion(t *testing.T) {
	origins := &fakeOrigins{asked: map[string]int{}, repos: map[string]string{
		"/r/herdr-3d-wt/m3-go": "JeffreyVdb/herdr-3d", "/r/herdr-3d-wt/m3-game": "JeffreyVdb/herdr-3d",
		"/r/infra": "fomra/depot-manager", "/r/infra-wt/x": "fomra/depot-manager", "/r/other": "o/other",
	}}
	b := startBridge(t, "", server.Options{RepoOf: origins.repoOf})
	c := b.connect(proto.Hello{})
	c.snapshot()
	suggested := func(want proto.Suggested) {
		t.Helper()
		for {
			ev := c.until(proto.EvFloorUpsert)
			if ev.Floor.Session == "s" && ev.Floor.Suggested != nil && *ev.Floor.Suggested == want {
				return
			}
		}
	}
	// The most common repo wins; its default cwd is a worker's root
	// checkout (not the linked worktree it works in).
	b.floor("s", true,
		inRepo("w1", "/r/infra-wt/x", "/r/infra"),
		inRepo("w2", "/r/herdr-3d-wt/m3-go", "/r/herdr-3d"),
		inRepo("w3", "/tmp/scratch", ""),
		inRepo("w4", "/r/herdr-3d-wt/m3-game", "/r/herdr-3d"))
	suggested(proto.Suggested{Repo: "JeffreyVdb/herdr-3d", DefaultCwd: "/r/herdr-3d"})
	// A tie goes to the first in sidebar order.
	b.floor("s", true,
		inRepo("w1", "/r/infra-wt/x", "/r/infra"),
		inRepo("w2", "/r/herdr-3d-wt/m3-go", "/r/herdr-3d"))
	suggested(proto.Suggested{Repo: "fomra/depot-manager", DefaultCwd: "/r/infra"})
	// The chosen repo decides the default cwd.
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/herdr-3d")})
	w := b.world(func(w proto.World) bool {
		return floorOf(w, "s").Suggested != nil && floorOf(w, "s").Suggested.DefaultCwd == "/r/herdr-3d"
	})
	if f := floorOf(w, "s"); f.Suggested.Repo != "fomra/depot-manager" || f.Settings.Repo != "JeffreyVdb/herdr-3d" {
		t.Fatalf("floor = %+v", f)
	}
	// Asleep floors use their session.json cwds; repeated identical
	// observations do not look again.
	b.floor("zz", false, inRepo("w1", "/r/other", ""))
	w = b.world(func(w proto.World) bool { return floorOf(w, "zz").Suggested != nil })
	if f := floorOf(w, "zz"); *f.Suggested != (proto.Suggested{Repo: "o/other"}) {
		t.Fatalf("asleep floor = %+v", f.Suggested)
	}
	b.floor("zz", false, inRepo("w1", "/r/other", ""))
	b.floor("zz", false, inRepo("w1", "/r/other", ""))
	b.world(func(w proto.World) bool { return true })
	origins.mu.Lock()
	defer origins.mu.Unlock()
	if n := origins.asked["/r/other"]; n != 1 {
		t.Fatalf("/r/other looked up %d times", n)
	}
}
