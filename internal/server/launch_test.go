package server_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

func presetNames(ps []proto.Preset) []string {
	var out []string
	for _, p := range ps {
		out = append(out, p.Name)
	}
	return out
}

func eventTypes(evs []proto.Event) []string {
	var out []string
	for _, ev := range evs {
		out = append(out, ev.T)
	}
	return out
}

var cheapTeam = proto.PresetRoles{
	Orch:       proto.Hire{Harness: "codex", Model: "gpt-6-luna", Effort: "low"},
	Coder:      proto.Hire{Harness: "codex", Model: "gpt-6-luna", Effort: "low"},
	Reviewer:   proto.Hire{Harness: "codex", Model: "gpt-6-luna", Effort: "medium"},
	UX:         proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "low"},
	Researcher: proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "ultra"},
}

// Presets: the seed, validation, events, the snapshot and persistence
// across a bridge restart (a real database file, reopened).
func TestPresets(t *testing.T) {
	t.Parallel()
	db := filepath.Join(t.TempDir(), "world.db")
	b := startBridge(t, db, server.Options{})
	c := b.connect(proto.Hello{Client: "presets"})
	snap := c.snapshot().World
	if len(snap.Presets) != 1 {
		t.Fatalf("presets = %+v", snap.Presets)
	}
	seed := snap.Presets[0]
	if seed.Name != "Build team" || !seed.Seeded || seed.Roles != buildTeam || !regexp.MustCompile(`^p_[0-9a-f]{12}$`).MatchString(seed.ID) {
		t.Fatalf("seed = %+v", seed)
	}
	raw, _ := json.Marshal(seed)
	want := `{"id":"` + seed.ID + `","name":"Build team","seeded":true,"roles":{` +
		`"orch":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},` +
		`"coder":{"harness":"claude","model":"claude-opus-5-5","effort":"medium"},` +
		`"reviewer":{"harness":"codex","model":"gpt-6-sol","effort":"high"},` +
		`"ux":{"harness":"codex","model":"gpt-6-sol","effort":"high"},` +
		`"researcher":{"harness":"codex","model":"gpt-6-sol","effort":"low"}}}`
	if string(raw) != want {
		t.Fatalf("seed JSON = %s", raw)
	}

	// Create: validation, then preset.upsert and the id.
	badRoles := cheapTeam
	badRoles.Reviewer.Model = "claude-haiku-4-5-20251001"
	c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "x", Roles: badRoles}, proto.ErrBadRequest)
	missing := cheapTeam
	missing.Researcher = proto.Hire{}
	c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "x", Roles: missing}, proto.ErrBadRequest)
	c.mustError(proto.CmdPresetCreate, map[string]any{"name": "x", "roles": map[string]any{"orch": cheapTeam.Orch}}, proto.ErrBadRequest)
	c.mustError(proto.CmdPresetCreate, map[string]any{"name": "x", "roles": cheapTeam, "color": "red"}, proto.ErrBadRequest)
	for _, name := range []string{"", "  ", "tab\there", strings.Repeat("n", 41)} {
		c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: name, Roles: cheapTeam}, proto.ErrBadRequest)
	}
	c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "BUILD TEAM", Roles: cheapTeam}, proto.ErrNameTaken)
	evs, ack := c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: " Cheap ", Roles: cheapTeam})
	id := ack.Data.(map[string]any)["id"].(string)
	if len(evs) != 1 || evs[0].T != proto.EvPresetUpsert || evs[0].Preset == nil ||
		*evs[0].Preset != (proto.Preset{ID: id, Name: "Cheap", Roles: cheapTeam}) {
		t.Fatalf("create events = %+v", evs)
	}

	// Update: a name, the roles (all five), nothing (no event), errors.
	evs, _ = c.mustAck(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Name: ptr("Alpha team")})
	if len(evs) != 1 || evs[0].Preset.Name != "Alpha team" || evs[0].Preset.Roles != cheapTeam {
		t.Fatalf("rename events = %+v", evs)
	}
	roles := cheapTeam
	roles.Orch = proto.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "xhigh"}
	evs, _ = c.mustAck(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Roles: &roles})
	if len(evs) != 1 || evs[0].Preset.Roles != roles || evs[0].Preset.Name != "Alpha team" {
		t.Fatalf("roles events = %+v", evs)
	}
	if evs, _ = c.mustAck(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Name: ptr(" Alpha team "), Roles: &roles}); len(evs) != 0 {
		t.Fatalf("unchanged update emitted %+v", evs)
	}
	c.mustError(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Name: ptr("build Team")}, proto.ErrNameTaken)
	c.mustError(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Name: ptr("")}, proto.ErrBadRequest)
	c.mustError(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Roles: &badRoles}, proto.ErrBadRequest)
	c.mustError(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: "p_ffffffffffff", Name: ptr("y")}, proto.ErrNotFound)
	// A case-only rename of its own name is fine.
	c.mustAck(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Name: ptr("alpha team")})

	// The snapshot lists them by name ignoring case.
	c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Zeta", Roles: buildTeam})
	if got := presetNames(b.connect(proto.Hello{}).snapshot().World.Presets); !slices.Equal(got, []string{"alpha team", "Build team", "Zeta"}) {
		t.Fatalf("snapshot order = %q", got)
	}

	// Delete: preset.removed; the seed stays deleted after a restart.
	evs, _ = c.mustAck(proto.CmdPresetDelete, proto.PresetDeleteArgs{ID: seed.ID})
	if len(evs) != 1 || evs[0].T != proto.EvPresetRemoved || evs[0].ID != seed.ID {
		t.Fatalf("delete events = %+v", evs)
	}
	c.mustError(proto.CmdPresetDelete, proto.PresetDeleteArgs{ID: seed.ID}, proto.ErrNotFound)
	log, _ := b.st.AuditLog(context.Background())
	var audited []string
	for _, e := range log {
		if strings.HasPrefix(e.Cmd, "preset.") && e.OK {
			audited = append(audited, e.Cmd)
		}
	}
	if len(audited) != 7 {
		t.Fatalf("audited = %q", audited)
	}
	b.stop()

	b = startBridge(t, db, server.Options{})
	got := b.connect(proto.Hello{}).snapshot().World.Presets
	if len(got) != 2 || got[0] != (proto.Preset{ID: id, Name: "alpha team", Roles: roles}) || got[1].Name != "Zeta" {
		t.Fatalf("after restart = %+v", got)
	}
}

// launchBridge is a hire bridge whose floor "s" links JeffreyVdb/lab and
// works in the repository /home/u/lab.
func launchBridge(t *testing.T, workers ...world.WorkerObs) (*hireBridge, proto.World) {
	t.Helper()
	return launchBridgeWith(t, &fakePrompts{}, workers...)
}

// launchBridgeWith is launchBridge with fp as its prompt translator (#39).
func launchBridgeWith(t *testing.T, fp *fakePrompts, workers ...world.WorkerObs) (*hireBridge, proto.World) {
	t.Helper()
	hb := startHireBridge(t, func(o *server.Options) { o.Prompts = fp }, workers...)
	hb.git.repos["/home/u/lab"] = "/home/u/lab"
	hb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Some("JeffreyVdb/lab"),
		DefaultCwd: proto.Some("/home/u/lab")})
	return hb, hb.connect(proto.Hello{}).snapshot().World
}

func runPrepare(t *testing.T, c *client, args any) proto.RunPrepareResult {
	t.Helper()
	_, m := c.command(proto.CmdRunPrepare, "rp", args)
	return ackData[proto.RunPrepareResult](t, m)
}

func TestRunPrepare(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t)
	c := hb.c
	seed := w.Presets[0].ID
	orch := buildTeam.Orch
	issue3 := "/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine

	// Nothing to work on yet: defaults, no prompt.
	res := runPrepare(t, c, proto.RunPrepareArgs{Session: "s"})
	if res.Prompt != "" || res.Label != "" || res.Ticket != nil || res.Preset != seed || res.Orch == nil || *res.Orch != orch ||
		res.Cwd != "/home/u/lab" || res.Git == nil || res.Git.RepoRoot != "/home/u/lab" || res.Capacity.Floor.Hard != 24 ||
		res.Capacity.Load == nil {
		t.Fatalf("empty prepare = %+v", res)
	}

	// Issue forms; a URL brings its own repo.
	for _, issue := range []any{3, "3", "#3", " #3 ", "https://github.com/JeffreyVdb/lab/issues/3"} {
		res = runPrepare(t, c, map[string]any{"session": "s", "issue": issue})
		want := proto.RunTicket{Kind: proto.TicketIssue, Repo: "JeffreyVdb/lab", Number: 3, URL: "https://github.com/JeffreyVdb/lab/issues/3"}
		if res.Prompt != issue3 || res.Label != "ORCH|issue-3" || res.Ticket == nil || *res.Ticket != want {
			t.Fatalf("issue %v: %+v", issue, res)
		}
	}
	res = runPrepare(t, c, map[string]any{"session": "s", "issue": "https://github.com/other-org/web.site/issues/123456/"})
	if res.Ticket.Repo != "other-org/web.site" || res.Ticket.Number != 123456 || res.Label != "ORCH|issue-1234" ||
		!strings.HasPrefix(res.Prompt, "/write-code https://github.com/other-org/web.site/issues/123456\n\n") {
		t.Fatalf("url issue: %+v", res)
	}
	// Free text, the ORCH's harness and extra instructions.
	codex := proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "high"}
	res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Text: "  Fix the lobby lights!\nThey flicker.\n", Orch: &codex,
		Extra: "Keep it small.\n"})
	if res.Prompt != "$write-code Fix the lobby lights!\nThey flicker.\n\n"+buildHead+"\n\nKeep it small." ||
		res.Label != "ORCH|fix-the" || res.Ticket.Kind != proto.TicketText || res.Ticket.Text != "Fix the lobby lights!\nThey flicker." ||
		*res.Orch != codex {
		t.Fatalf("text: %+v", res)
	}
	for text, label := range map[string]string{"Refactoring everything": "ORCH|refactorin", "!!! ???": "ORCH|run",
		"a b c d e f g": "ORCH|a-b-c-d-e"} {
		if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Text: text}); res.Label != label {
			t.Errorf("label of %q = %q, want %q", text, res.Label, label)
		}
	}

	// Errors.
	for _, args := range []any{
		map[string]any{"session": "s", "issue": 3, "text": "both"},
		map[string]any{"session": "s", "issue": 0},
		map[string]any{"session": "s", "issue": -2},
		map[string]any{"session": "s", "issue": 2.5},
		map[string]any{"session": "s", "issue": "three"},
		map[string]any{"session": "s", "issue": "https://gitlab.com/a/b/issues/3"},
		map[string]any{"session": "s", "issue": true},
		map[string]any{"session": "s", "text": "   "},
		map[string]any{"session": "s", "text": strings.Repeat("x", 4097)},
		map[string]any{"session": "s", "issue": 3, "extra": strings.Repeat("x", 8193)},
		map[string]any{"session": "s", "orch": map[string]any{"harness": "claude", "model": "claude-haiku-4-5-20251001", "effort": "low"}},
		map[string]any{"session": "s", "cwd": "/tmp"},
	} {
		c.mustError(proto.CmdRunPrepare, args, proto.ErrBadRequest)
	}
	c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "s", Preset: "p_ffffffffffff"}, proto.ErrNotFound)
	c.mustError(proto.CmdRunPrepare, proto.RunPrepareArgs{Session: "nope"}, proto.ErrUnknownSession)
	// An issue number needs the floor's repo.
	c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", Repo: proto.Null[string]()})
	_, m := c.command(proto.CmdRunPrepare, "norepo", map[string]any{"session": "s", "issue": 3})
	if e := errorOf(m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, "the floor has no linked repo") {
		t.Fatalf("no repo: %s", m.raw)
	}
	if res = runPrepare(t, c, map[string]any{"session": "s", "issue": "https://github.com/JeffreyVdb/lab/issues/3"}); res.Prompt != issue3 {
		t.Fatalf("url without a floor repo: %+v", res)
	}
	if row := auditRow(t, hb.bridge, proto.CmdRunPrepare); !row.Done || !row.OK {
		t.Fatalf("audit = %+v", row)
	}

	// Default preset: the floor's last, else Build team, else the first.
	_, ack := c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Alpha", Roles: cheapTeam})
	alpha := ack.Data.(map[string]any)["id"].(string)
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s"}); res.Preset != seed {
		t.Fatalf("default with Alpha = %s", res.Preset)
	}
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Preset: alpha, Text: "go"}); res.Preset != alpha ||
		*res.Orch != cheapTeam.Orch || !strings.HasPrefix(res.Prompt, "$write-code go\n\nTeam:\n- coders: codex gpt-6-luna, reasoning low\n") {
		t.Fatalf("asked preset = %+v", res)
	}
	c.mustAck(proto.CmdPresetDelete, proto.PresetDeleteArgs{ID: seed})
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s"}); res.Preset != alpha {
		t.Fatalf("first preset = %s", res.Preset)
	}
	c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "build TEAM", Roles: buildTeam})
	_, ack = c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Zulu", Roles: buildTeam})
	zulu := ack.Data.(map[string]any)["id"].(string)
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s"}); res.Preset == alpha || res.Preset == zulu {
		t.Fatalf("build team by name = %s", res.Preset)
	}
	d := 2
	c.mustAck(proto.CmdRunStart, proto.RunStartArgs{Session: "s", DeskIndex: &d, Text: "go", Orch: &orch, Preset: zulu})
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s"}); res.Preset != zulu {
		t.Fatalf("last preset = %s", res.Preset)
	}
	// No presets at all: no preset, no orch, no prompt.
	for _, p := range hb.connect(proto.Hello{}).snapshot().World.Presets {
		c.mustAck(proto.CmdPresetDelete, proto.PresetDeleteArgs{ID: p.ID})
	}
	if res = runPrepare(t, c, proto.RunPrepareArgs{Session: "s", Text: "go"}); res.Preset != "" || res.Orch != nil || res.Prompt != "" ||
		res.Label != "ORCH|go" {
		t.Fatalf("no presets = %+v", res)
	}
}

func TestRunStart(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t, worker("w1", "CODE|a", "", "idle"))
	c := hb.c
	seed := w.Presets[0].ID
	orch := proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "high"}
	desk := 3
	prompt := "/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine + "\n\nUse port 5173."
	evs, m := c.command(proto.CmdRunStart, "rs1", map[string]any{"session": "s", "desk_index": desk, "issue": "#3",
		"orch": orch, "preset": seed, "extra": "Use port 5173."})
	var res proto.RunStartResult
	if m.env.T != proto.TAck {
		t.Fatalf("run.start: %s", m.raw)
	}
	res = ackData[proto.RunStartResult](t, m)
	if !regexp.MustCompile(`^l_[0-9a-f]{16}$`).MatchString(res.LaunchID) || res.Prompt != prompt || res.ID == "" ||
		res.WorkspaceID != "w3" || res.Prompted == nil || !*res.Prompted || !strings.HasPrefix(res.Branch, "h3d/") ||
		res.BaseSHA != hb.git.sha || res.Trust != proto.TrustNone {
		t.Fatalf("ack = %s", m.raw)
	}
	// The M4 hire: a worktree (the default) at the desk, the label, the
	// ORCH's choice, the prompt as its first prompt.
	marker := "h3d-" + strings.ReplaceAll(res.ID, "-", "")[:12]
	calls := hb.fl.Calls()
	wantCalls := []string{
		"worktree s /home/u/lab " + res.Branch + " origin/main ORCH|issue-3",
		"mark w3:p1 " + marker,
		"start-agent w3:p1 " + strings.TrimPrefix(res.Branch, "h3d/") + " claude claude-fable-5-1 high ORCH|issue-3",
		"type w3:p1 " + strconv.Quote(prompt), // #95: typed into Claude
	}
	if !slices.Equal(calls, wantCalls) {
		t.Fatalf("herdr calls =\n%q\nwant\n%q", calls, wantCalls)
	}
	var hired *proto.Worker
	lastPreset := -1
	for i, ev := range evs {
		if ev.T == proto.EvWorkerUpsert && ev.Worker.ID == res.ID && hired == nil {
			hired = ev.Worker
		}
		if ev.T == proto.EvFloorUpsert && ev.Floor.Session == "s" && ev.Floor.LastPreset == seed {
			lastPreset = i
		}
	}
	if hired == nil || hired.DeskIndex != 3 || hired.Label != "ORCH|issue-3" || hired.Model != "claude-fable-5-1" || hired.HiredAt == 0 {
		t.Fatalf("hired = %+v", hired)
	}
	if lastPreset < 0 {
		t.Fatalf("no floor.upsert with last_preset before the ack: %q", eventTypes(evs))
	}
	// run_launch is stored; the ORCH's first h3d_run token fills run_id.
	l, ok, err := hb.st.RunLaunchByWorker(context.Background(), res.ID)
	if err != nil || !ok || l.ID != res.LaunchID || l.Repo != "JeffreyVdb/lab" || l.IssueNumber != 3 || l.RunID != "" ||
		l.PresetID != seed || l.PresetName != "Build team" || l.Session != "s" {
		t.Fatalf("run_launch = %+v %v %v", l, ok, err)
	}
	hb.fl.update("w3", func(w *world.WorkerObs) {
		w.Tokens = map[string]string{"h3d_role": "orch", "h3d_run": "20260929-0900-lab"}
	})
	waitRunID(t, hb, res.ID, "20260929-0900-lab")
	hb.fl.update("w3", func(w *world.WorkerObs) { w.Tokens = map[string]string{"h3d_run": "later"} })
	hb.world(func(w proto.World) bool { return workersOf(w, "s")["w3"].Tokens["h3d_run"] == "later" })
	if l, _, _ = hb.st.RunLaunchByWorker(context.Background(), res.ID); l.RunID != "20260929-0900-lab" {
		t.Fatalf("run id moved: %+v", l)
	}
	row := auditRow(t, hb.bridge, proto.CmdRunStart)
	if !row.OK || !row.Done || !strings.Contains(row.Result, `"launch":"`+res.LaunchID+`"`) || !strings.Contains(row.Result, `"desk":3`) {
		t.Fatalf("audit = %+v", row)
	}

	// An edited prompt is sent as it is; a plain workspace when asked; the
	// label as given; free text is recorded.
	_, ack := c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Cheap", Roles: cheapTeam})
	cheap := ack.Data.(map[string]any)["id"].(string)
	edited := "Reply with OK.\nThen stop."
	desk = 4
	_, m = c.command(proto.CmdRunStart, "rs2", proto.RunStartArgs{Session: "s", DeskIndex: &desk, Text: "Tidy the lobby",
		Orch: &cheapTeam.Orch, Preset: cheap, Worktree: ptr(false), Label: "Boss", Prompt: edited})
	res2 := ackData[proto.RunStartResult](t, m)
	calls = hb.fl.Calls()[len(wantCalls):]
	if res2.Prompt != edited || res2.Branch != "" || calls[0] != "create s /home/u/lab Boss" || calls[len(calls)-1] != "prompt w4:p1 "+strconv.Quote(edited) {
		t.Fatalf("edited run: %s\n%q", m.raw, calls)
	}
	if l, _, _ := hb.st.RunLaunchByWorker(context.Background(), res2.ID); l.TicketText != "Tidy the lobby" || l.Repo != "" || l.PresetName != "Cheap" {
		t.Fatalf("text launch = %+v", l)
	}
	if f := floorOf(hb.connect(proto.Hello{}).snapshot().World, "s"); f.LastPreset != cheap {
		t.Fatalf("last_preset = %q", f.LastPreset)
	}
	// Deleting the floor's last preset clears it: preset.removed, then floor.upsert.
	evs, _ = c.mustAck(proto.CmdPresetDelete, proto.PresetDeleteArgs{ID: cheap})
	if got := eventTypes(evs); !slices.Equal(got, []string{proto.EvPresetRemoved, proto.EvFloorUpsert}) || evs[1].Floor.LastPreset != "" {
		t.Fatalf("delete events = %+v", evs)
	}

	// worker.hire's errors apply; the rest are run.start's own.
	start := func(mut func(a map[string]any)) map[string]any {
		a := map[string]any{"session": "s", "desk_index": 5, "issue": 3, "orch": orch, "preset": seed}
		mut(a)
		return a
	}
	for code, muts := range map[string][]func(map[string]any){
		proto.ErrDeskTaken:      {func(a map[string]any) { a["desk_index"] = 3 }, func(a map[string]any) { a["desk_index"] = 99 }},
		proto.ErrNotFound:       {func(a map[string]any) { a["preset"] = "p_ffffffffffff" }},
		proto.ErrUnknownSession: {func(a map[string]any) { a["session"] = "other" }},
		proto.ErrBadRequest: {
			func(a map[string]any) { delete(a, "desk_index") },
			func(a map[string]any) { delete(a, "issue") },
			func(a map[string]any) { a["text"] = "both" },
			func(a map[string]any) { delete(a, "orch") },
			func(a map[string]any) { delete(a, "preset") },
			func(a map[string]any) {
				a["orch"] = proto.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "ultra"}
			},
			func(a map[string]any) { a["prompt"] = "--wait" },
			func(a map[string]any) { a["label"] = "-x" },
			func(a map[string]any) { a["extra"] = strings.Repeat("x", 8193) },
			func(a map[string]any) { a["cwd"] = "/tmp" },
		},
	} {
		for _, mut := range muts {
			c.mustError(proto.CmdRunStart, start(mut), code)
		}
	}
	hb.floorAt("t", false, nil)
	hb.world(func(w proto.World) bool { return floorOf(w, "t").State == "asleep" })
	c.mustError(proto.CmdRunStart, start(func(a map[string]any) { a["session"] = "t" }), proto.ErrInvalidState)
}

// A run started before a restart gets its run id after it.
func TestRunIDAfterRestart(t *testing.T) {
	t.Parallel()
	hb, w := launchBridge(t)
	orch := buildTeam.Orch
	desk := 1
	_, m := hb.c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, Issue: json.RawMessage("7"),
		Orch: &orch, Preset: w.Presets[0].ID})
	res := ackData[proto.RunStartResult](t, m)
	hb.stop()
	b := startBridge(t, hb.db, fastOps(newFakeHerdr()))
	obs := hb.fl.workers[len(hb.fl.workers)-1]
	obs.Tokens = map[string]string{"h3d_run": "r-after"}
	b.publish(world.FloorObs{Session: "s", Running: true, Gen: world.NextGen(), Socket: "sock-s", Workers: []world.WorkerObs{obs}})
	waitRunIDIn(t, b, res.ID, "r-after")
}

func waitRunID(t *testing.T, hb *hireBridge, worker, run string) {
	t.Helper()
	waitRunIDIn(t, hb.bridge, worker, run)
}

func waitRunIDIn(t *testing.T, b *bridge, worker, run string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		l, _, err := b.st.RunLaunchByWorker(context.Background(), worker)
		if err == nil && l.RunID == run {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("run id = %+v, %v; want %q", l, err, run)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
