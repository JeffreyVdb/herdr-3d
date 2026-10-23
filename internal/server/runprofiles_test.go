package server_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/world"
)

// #167: a Codex profile for a run's orchestrator and for each Codex role of
// its team preset, against the profile bridge (profileBridge: ~/.codex, the
// default with herdr's hook, ~/.codex-work and ~/.codex-team, bare homes).

// runTeam is buildTeam with a Codex orchestrator, and the reviewers on
// reviewer, the ux reviewers on ux and the researchers on researcher.
func runTeam(reviewer, ux, researcher string) proto.PresetRoles {
	r := buildTeam
	r.Orch = proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low"}
	r.Reviewer.CodexProfile, r.UX.CodexProfile, r.Researcher.CodexProfile = reviewer, ux, researcher
	return r
}

// runOn makes a preset of roles on the profile bridge, its floor's folder
// /home/u/repo, and returns the preset's id.
func (pb *profileBridge) runOn(t *testing.T, name string, roles proto.PresetRoles) string {
	t.Helper()
	pb.c.mustAck(proto.CmdFloorSettings, proto.FloorSettingsArgs{Session: "s", DefaultCwd: proto.Some("/home/u/repo")})
	_, ack := pb.c.mustAck(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: name, Roles: roles})
	return ack.Data.(map[string]any)["id"].(string)
}

// start starts a run on preset at desk with orch, and returns its reply and
// the herdr calls it made.
func (pb *profileBridge) start(t *testing.T, desk int, preset string, orch proto.Hire) (msg, []string) {
	t.Helper()
	before := len(pb.fl.Calls())
	_, m := pb.c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, Text: "Fix the lobby", Orch: &orch,
		Preset: preset, Worktree: ptr(false)})
	return m, pb.fl.Calls()[before:]
}

// AC2: an orchestrator on another profile is hired as a worker on it is
// (its home exported in its pane before Codex starts, checked, named in the
// ack); on the default, by key or none, nothing of that.
func TestRunStartOrchProfile(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, false, "")
	preset := pb.runOn(t, "Plain", runTeam("", "", ""))
	orch := proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low", CodexProfile: "team"}
	m, calls := pb.start(t, 1, preset, orch)
	res := ackData[proto.RunStartResult](t, m)
	if i := slices.Index(calls, "codex-home w1:p1 "+pb.team); i < 0 || !strings.HasPrefix(calls[i+1], "start-agent w1:p1 ") {
		t.Fatalf("herdr calls = %q", calls)
	}
	if res.Codex == nil || res.Codex.Profile != "team" || !strings.Contains(res.Codex.ProfileNote, "team has no hooks.json with herdr's hook") ||
		!strings.Contains(res.Codex.ProfileNote, "team does not share setup with codex: no herdr hooks.") { // #167: as a hire's
		t.Fatalf("run.start ack %s", m.raw)
	}
	if l := pb.launches(t)[res.ID]; l.Profile != "team" {
		t.Fatalf("launch = %+v", l)
	}
	if row := auditRow(t, pb.bridge, proto.CmdRunStart); !strings.Contains(row.Result, `"codex_profile":"team"`) {
		t.Fatalf("audit = %+v", row)
	}
	if strings.Contains(res.Prompt, "Codex profile") || res.CodexTeamNote != "" || res.CodexTeamReason != "" {
		t.Fatalf("a team on the default: %s", m.raw)
	}
	for desk, key := range map[int]string{2: "", 3: "codex"} {
		orch.CodexProfile = key
		m, calls := pb.start(t, desk, preset, orch)
		ackData[proto.RunStartResult](t, m)
		if slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-home") }) {
			t.Fatalf("default %q: herdr calls %q", key, calls)
		}
	}
	// A key that cannot be used refuses the run in the orchestrator's name,
	// never as its preset gone.
	orch.CodexProfile = "nope"
	m, calls = pb.start(t, 4, preset, orch)
	if e := hireError(t, m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, `the orchestrator's Codex profile cannot be used: no Codex profile "nope"`) ||
		len(calls) != 0 {
		t.Fatalf("gone: %s, calls %q", m.raw, calls)
	}
	pb.balanced(t)
}

// AC4, AC5: each Codex role's profile is concrete at run start: Auto picked
// once by the rules with the floor's folder, a key as it is, the default
// as today; the prompt names the others' home and token, and says how to
// start them; the report and the ack say what Auto picked, and that their
// homes run no herdr hook.
func TestRunStartTeamProfiles(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, false, "", withOrigin("acme/widgets"))
	pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Rules: &[]proto.CodexRule{{Match: "github.com/acme/*", Profile: "work"}}})
	preset := pb.runOn(t, "Mixed", runTeam(proto.CodexProfileAuto, "codex", "team"))
	orch := proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low"}

	prep := runPrepare(t, pb.c, proto.RunPrepareArgs{Session: "s", Text: "Fix the lobby", Preset: preset})
	m, calls := pb.start(t, 1, preset, orch)
	res := ackData[proto.RunStartResult](t, m)
	team := "Team:\n" +
		"- coders: claude claude-opus-5-5, effort medium\n" +
		"- reviewers: codex gpt-6-sol, reasoning high, Codex profile work (CODEX_HOME=" + pb.work + ", token h3d_codex_profile=work)\n" +
		"- ux reviewers: codex gpt-6-sol, reasoning high\n" +
		"- researchers: codex gpt-6-sol, reasoning low, Codex profile team (CODEX_HOME=" + pb.team + ", token h3d_codex_profile=team)\n\n"
	if !strings.Contains(res.Prompt, team) || strings.Count(res.Prompt, "Start an agent whose team line names a Codex profile") != 1 ||
		strings.Contains(strings.ToLower(res.Prompt), "auto") {
		t.Fatalf("prompt =\n%s", res.Prompt)
	}
	if prep.Prompt != res.Prompt {
		t.Fatalf("run.prepare showed\n%s\nrun.start sent\n%s", prep.Prompt, res.Prompt)
	}
	if res.CodexTeamReason != "reviewers: Account: work (rule acme/*)" ||
		strings.Count(res.CodexTeamNote, "has no hooks.json with herdr's hook") != 2 ||
		strings.Count(res.CodexTeamNote, "does not share setup with codex: no herdr hooks.") != 2 || strings.Contains(res.CodexTeamNote, "wake") {
		t.Fatalf("ack %s", m.raw)
	}
	// The orchestrator itself is on the default: nothing exported.
	if slices.ContainsFunc(calls, func(c string) bool { return strings.HasPrefix(c, "codex-home") }) {
		t.Fatalf("herdr calls = %q", calls)
	}
	row := auditRow(t, pb.bridge, proto.CmdRunStart)
	if strings.Count(row.Result, "codex profile auto for the reviewers: Account: work (rule acme/*)") != 1 ||
		!strings.Contains(row.Result, "codex profile of the researcher: team ("+pb.team+")") {
		t.Fatalf("audit = %+v", row)
	}
	pb.balanced(t)
}

// AC4: a role's profile that cannot be used refuses the run before
// anything reaches herdr, in plain words naming the role and the profile:
// not signed in (with the way to sign in), its folder gone, unknown. A
// prompt of the user's own is not composed, so the team is not read.
func TestRunStartTeamProfileRefused(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, false, "")
	// An added folder with no sign-in yet.
	spare := filepath.Join(pb.user, "spare")
	if err := os.MkdirAll(spare, 0o700); err != nil {
		t.Fatal(err)
	}
	_, ack := pb.c.mustAck(proto.CmdCodexProfilesSet, proto.CodexProfilesSetArgs{Add: ptr(spare)})
	var list proto.CodexProfiles
	if err := json.Unmarshal(mustMarshal(t, ack.Data), &list); err != nil {
		t.Fatal(err)
	}
	key := list.Profiles[len(list.Profiles)-1].Key
	orch := proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low"}
	idle := pb.runOn(t, "Spare", runTeam("", "", key))
	m, calls := pb.start(t, 1, idle, orch)
	if e := hireError(t, m); e.Code != proto.ErrBadRequest ||
		!strings.Contains(e.Message, "the researchers' Codex profile cannot be used: spare is not signed in. Run `CODEX_HOME="+spare+" codex login`") ||
		len(calls) != 0 {
		t.Fatalf("not signed in: %s, calls %q", m.raw, calls)
	}
	preset := pb.runOn(t, "Work", runTeam("work", "", ""))
	if err := os.RemoveAll(pb.work); err != nil {
		t.Fatal(err)
	}
	pb.c.mustAck(proto.CmdCodexProfilesGet, nil)
	m, calls = pb.start(t, 1, preset, orch)
	if e := hireError(t, m); e.Code != proto.ErrBadRequest || !strings.Contains(e.Message, "the reviewers' Codex profile cannot be used:") ||
		!strings.Contains(e.Message, "work") || len(calls) != 0 {
		t.Fatalf("gone: %s, calls %q", m.raw, calls)
	}
	// run.prepare still shows a prompt (that role on the default).
	if prep := runPrepare(t, pb.c, proto.RunPrepareArgs{Session: "s", Text: "Fix the lobby", Preset: preset}); prep.Prompt == "" ||
		strings.Contains(prep.Prompt, "Codex profile") {
		t.Fatalf("prepare = %+v", prep)
	}
	desk := 1
	_, m = pb.c.command(proto.CmdRunStart, "rs", proto.RunStartArgs{Session: "s", DeskIndex: &desk, Text: "Fix the lobby", Orch: &orch,
		Preset: preset, Worktree: ptr(false), Prompt: "Do it your way."})
	if res := ackData[proto.RunStartResult](t, m); res.Prompt != "Do it your way." {
		t.Fatalf("own prompt: %s", m.raw)
	}
}

// AC3: a preset keeps a profile per Codex role (Auto included) and gives it
// back; a non-Codex role takes none; a gone profile a role had stays when
// the preset is renamed, and a new one must be listed.
func TestPresetRoleProfiles(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, false, "")
	roles := runTeam(proto.CodexProfileAuto, "work", "")
	roles.Orch.CodexProfile = "team"
	id := pb.runOn(t, "Profiles", roles)
	w := pb.connect(proto.Hello{}).snapshot().World
	var got proto.Preset
	for _, p := range w.Presets {
		if p.ID == id {
			got = p
		}
	}
	if got.Roles != roles {
		t.Fatalf("preset roles = %+v", got.Roles)
	}
	bad := roles
	bad.Coder.CodexProfile = "work" // a claude role
	pb.c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Bad", Roles: bad}, proto.ErrBadRequest)
	bad = roles
	bad.Reviewer.CodexProfile = "nope"
	pb.c.mustError(proto.CmdPresetCreate, proto.PresetCreateArgs{Name: "Bad", Roles: bad}, proto.ErrBadRequest) // never not_found: the editor reads that as its preset gone

	if err := os.RemoveAll(pb.work); err != nil {
		t.Fatal(err)
	}
	pb.c.mustAck(proto.CmdCodexProfilesGet, nil)
	name := "Renamed"
	pb.c.mustAck(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Name: &name, Roles: &roles})
	moved := roles
	moved.Reviewer.CodexProfile = "work" // gone, and not this role's before
	pb.c.mustError(proto.CmdPresetUpdate, proto.PresetUpdateArgs{ID: id, Roles: &moved}, proto.ErrBadRequest)
}

// AC6: an agent an orchestrator started on another profile, as its prompt
// says (CODEX_HOME set, its workspace tagged h3d_codex_profile=<key>), is
// read in that profile's sessions: its usage and its transcript, as a
// worker the bridge hired there; untagged, in the default's.
func TestTaggedFreelancerOnProfile(t *testing.T) {
	t.Parallel()
	const (
		defID  = "0c0d0e0f-1670-4000-8000-0000000000b1"
		teamID = "0c0d0e0f-1670-4000-8000-0000000000b2"
	)
	pb := startProfileBridge(t, false, "")
	profileRollout(t, filepath.Join(pb.def, "sessions"), "2026-10-21T11-00-00", defID, "/home/u/repo", 900)
	profileRollout(t, filepath.Join(pb.team, "sessions"), "2026-10-21T10-00-00", teamID, "/home/u/repo", 300,
		`{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review the lobby"}]}}`)
	agent := func(ws, session string, tokens map[string]string) world.WorkerObs {
		return world.WorkerObs{WorkspaceID: ws, Label: "REV|" + ws, Cwd: "/home/u/repo", IdentityCwd: "/home/u/repo", PaneID: ws + ":p1",
			AgentKind: "codex", AgentSession: session, Status: "idle", Tokens: tokens}
	}
	pb.floorAt("s", true, []world.WorkerObs{
		agent("w7", teamID, map[string]string{"h3d_codex_profile": "team", "h3d_role": "reviewer"}),
		agent("w8", defID, map[string]string{"h3d_role": "reviewer"}),
	})
	ws := workersOf(pb.world(func(w proto.World) bool {
		x := workersOf(w, "s")
		return x["w7"].Usage != nil && x["w8"].Usage != nil
	}), "s")
	if ws["w7"].Usage.Input != 300 || ws["w8"].Usage.Input != 900 {
		t.Fatalf("usage w7 %+v, w8 %+v", ws["w7"].Usage, ws["w8"].Usage)
	}
	c := pb.connect(proto.Hello{Client: "tx"})
	c.snapshot()
	_, wack := c.mustAck(proto.CmdTranscriptWatch, proto.TranscriptWatchArgs{ID: ws["w7"].ID})
	var page proto.TranscriptWatchResult
	if err := json.Unmarshal(mustMarshal(t, wack.Data), &page); err != nil {
		t.Fatal(err)
	}
	if page.Session != teamID || !slices.ContainsFunc(page.Items, func(it proto.TranscriptItem) bool {
		return it.Kind == proto.ItemUser && len(it.Parts) > 0 && it.Parts[0].Text == "review the lobby"
	}) {
		t.Fatalf("transcript.watch = %+v", page)
	}
}

// #167: a team role's notes say what a hire on its profile would: not
// shared, nothing while it shares in step, how it drifted; and the bare
// home's note for an agent the orchestrator starts promises no wake.
func TestRunStartTeamSetupNotes(t *testing.T) {
	t.Parallel()
	pb := startProfileBridge(t, false, "")
	preset := pb.runOn(t, "Work reviewers", runTeam("work", "", ""))
	orch := proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low"}
	note := func(desk int) string {
		t.Helper()
		m, _ := pb.start(t, desk, preset, orch)
		return ackData[proto.RunStartResult](t, m).CodexTeamNote
	}
	want := "work does not share setup with codex: no herdr hooks. work has no hooks.json with herdr's hook: herdr is not told the " +
		"Codex session of an agent the orchestrator starts on it. Its conversation and usage stay pending until its session is reported."
	if got := note(1); got != want {
		t.Fatalf("not shared:\n%s\nwant\n%s", got, want)
	}
	pb.c.mustAck(proto.CmdCodexProfilesShare, proto.CodexShareArgs{Key: "work", Share: ptr(true)})
	if got := note(2); got != "" {
		t.Fatalf("shared in step: %q", got)
	}
	if err := os.Remove(filepath.Join(pb.work, "hooks.json")); err != nil {
		t.Fatal(err)
	}
	if got := note(3); !strings.HasPrefix(got, "work's shared setup has drifted from codex's: hooks.json is missing. work has no hooks.json") {
		t.Fatalf("drifted: %q", got)
	}
}
