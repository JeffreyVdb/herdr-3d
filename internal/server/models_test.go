package server_test

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

func TestDiscoveredModelsAcrossCommands(t *testing.T) {
	t.Parallel()
	catalog := server.HireOptions()
	catalog.Codex = proto.HarnessOptions{Models: []string{"gpt-6.1-sol", "gpt-future"}, Efforts: []string{"high"},
		ExtraEfforts: map[string][]string{"gpt-6.1-sol": {"ultra"}}}
	hb := startHireBridge(t, func(o *server.Options) { o.HireOptions = &catalog })
	c := hb.c
	if got := hb.connect(proto.Hello{}).snapshot().World.HireOptions; got == nil || !reflect.DeepEqual(*got, catalog) {
		t.Fatalf("snapshot catalog = %+v", got)
	}
	choice := proto.Hire{Harness: "codex", Model: "gpt-6.1-sol", Effort: "ultra"}
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"), DefaultHire: proto.Some(choice)})
	_, reply := c.command(proto.CmdHirePrepare, "prepare", proto.HirePrepareArgs{Session: "s"})
	prepared := ackData[proto.HirePrepareResult](t, reply)
	if prepared.Choice == nil || *prepared.Choice != choice || prepared.ChoiceSource != proto.ChoiceFloorDefault {
		t.Fatalf("prepared choice = %+v", prepared)
	}
	roles := proto.PresetRoles{Orch: choice, Coder: choice, Reviewer: choice, UX: choice, Researcher: choice}
	_, reply = c.command(proto.CmdPresetCreate, "preset", proto.PresetCreateArgs{Name: "Discovered team", Roles: roles})
	preset := ackData[proto.Preset](t, reply)
	_, reply = c.command(proto.CmdRunPrepare, "run", proto.RunPrepareArgs{Session: "s", Issue: json.RawMessage("3"), Preset: preset.ID, Orch: &choice})
	run := ackData[proto.RunPrepareResult](t, reply)
	if run.Orch == nil || *run.Orch != choice {
		t.Fatalf("run choice = %+v", run)
	}
	c.mustAck(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: "s", DeskIndex: ptr(1), Harness: choice.Harness, Model: choice.Model, Effort: choice.Effort})
	for _, invalid := range []proto.Hire{
		{Harness: "codex", Model: "gpt-6-sol", Effort: "high"},   // replaced by the discovered catalog
		{Harness: "codex", Model: "gpt-future", Effort: "ultra"}, // effort only supported by another model
	} {
		c.mustError(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", DefaultHire: proto.Some(invalid)}, proto.ErrBadRequest)
		c.mustError(proto.CmdWorkerHire, proto.WorkerHireArgs{Session: "s", DeskIndex: ptr(2), Harness: invalid.Harness, Model: invalid.Model, Effort: invalid.Effort}, proto.ErrBadRequest)
		badRoles := roles
		badRoles.Reviewer = invalid
		c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Invalid team", Roles: badRoles}, proto.ErrBadRequest)
	}
}
