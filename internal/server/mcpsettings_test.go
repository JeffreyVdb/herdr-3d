package server_test

import (
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

// #196: expected_mcp is stored with the floor's settings, trimmed, and
// shown in floor.upsert; null and [] clear it; bad lists are refused.
func TestFloorExpectedMCP(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	b.floor("s", true)
	c := b.connect(proto.Hello{Client: "settings"})
	c.snapshot()

	evs, _ := c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some([]string{" github ", "linear", "plugin:x:y"})})
	if len(evs) != 1 || evs[0].Floor.Settings == nil || !slices.Equal(evs[0].Floor.Settings.ExpectedMCP, []string{"github", "linear", "plugin:x:y"}) {
		t.Fatalf("set events = %+v", evs)
	}
	if evs, _ := c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some([]string{"github", "linear", "plugin:x:y"})}); len(evs) != 0 {
		t.Fatalf("same value events = %+v", evs)
	}

	long := strings.Repeat("x", proto.MaxExpectedMCPName)
	many := make([]string, proto.MaxExpectedMCP)
	for i := range many {
		many[i] = "s" + strings.Repeat("x", i)
	}
	if evs, _ := c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some(append(many[:len(many)-1:len(many)-1], long))}); len(evs) != 1 {
		t.Fatalf("limits events = %+v", evs)
	}

	for name, list := range map[string][]string{
		"too many":     append(slices.Clone(many), "one more"),
		"empty":        {"a", "  "},
		"too long":     {long + "x"},
		"duplicate":    {"github", " github"},
		"control":      {"git\nhub"},
		"nul":          {"git\x00hub"},
		"tab in name":  {"a\tb"},
		"delete char":  {"a\x7fb"},
		"c1 control":   {"a\u0085b"},
		"empty string": {""},
	} {
		_, m := c.command(proto.CmdFloorSettings, name, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some(list)})
		if e := errorOf(m); m.env.T != proto.TError || e.Code != proto.ErrBadRequest {
			t.Errorf("%s: %s", name, m.raw)
		}
	}
	for name, args := range map[string]any{
		"not a list":  map[string]any{"session": "s", "expected_mcp": "github"},
		"not strings": map[string]any{"session": "s", "expected_mcp": []any{1}},
	} {
		_, m := c.command(proto.CmdFloorSettings, name, args)
		if e := errorOf(m); m.env.T != proto.TError || e.Code != proto.ErrBadRequest {
			t.Errorf("%s: %s", name, m.raw)
		}
	}

	// [] clears it, as null does; a floor with nothing else set has no settings.
	evs, _ = c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some([]string{})})
	if len(evs) != 1 || evs[0].Floor.Settings != nil {
		t.Fatalf("clear events = %+v", evs)
	}
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some([]string{"github"})})
	evs, _ = c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Null[[]string]()})
	if len(evs) != 1 || evs[0].Floor.Settings != nil {
		t.Fatalf("null events = %+v", evs)
	}
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", ExpectedMCP: proto.Some([]string{"github"})})
	b.stop()

	b2 := startBridge(t, db, server.Options{})
	b2.floor("s", false)
	w := b2.world(func(w proto.World) bool { return len(w.Floors) == 1 })
	if f := floorOf(w, "s"); f.Settings == nil || !reflect.DeepEqual(f.Settings.ExpectedMCP, []string{"github"}) {
		t.Fatalf("after restart = %+v", f.Settings)
	}
}
