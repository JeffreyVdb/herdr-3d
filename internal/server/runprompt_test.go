package server_test

import (
	"strings"
	"testing"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/server"
)

var buildTeam = proto.PresetRoles{
	Orch:       proto.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "medium"},
	Coder:      proto.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "medium"},
	Reviewer:   proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "high"},
	UX:         proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "high"},
	Researcher: proto.Hire{Harness: "codex", Model: "gpt-6-sol", Effort: "low"},
}

const statusLine = "Move the ticket status accordingly, pull request always means QA, merging the PR always means Done."

const buildTeamLines = `Team:
- coders: claude claude-opus-5-5, effort medium
- reviewers: codex gpt-6-sol, reasoning high
- ux reviewers: codex gpt-6-sol, reasoning high
- researchers: codex gpt-6-sol, reasoning low`

// placementLine is the rule of where an orchestrator starts its agents
// (#74); a prompt has it after the team, whatever the ticket.
const placementLine = "Start every agent you hire in its own herdr workspace or tab, never in a split pane of your tab or of another agent's tab: " +
	"a laptop shows a pane at its own size, and a fullscreen terminal is wanted."

// floorLineS asks the orchestrator to tag its agents' workspaces with its
// floor (#58), here the real floor of session "s".
const floorLineS = "Also tag every herdr workspace you create with the token h3d_floor=s, " +
	"in the same herdr workspace report-metadata call as its other h3d_ tokens: it puts that agent on your floor."

// agentLineT asks the orchestrator to tag its agents' workspaces with the
// harness, model and effort it starts them with (H3D-2).
const agentLineT = "Also tag every herdr workspace you create with the tokens h3d_harness, h3d_model and h3d_effort, " +
	"the harness, model id and effort you start that agent with, in the same herdr workspace report-metadata call as the floor token: " +
	"use h3d_harness=claude for Claude Code and h3d_harness=codex for Codex. The floor shows them as that agent's model line."

// buildHead is the team of buildTeam, the placement rule, the floor line
// of floor "s" and the agent line.
const buildHead = buildTeamLines + "\n\n" + placementLine + "\n\n" + floorLineS + "\n\n" + agentLineT

func TestRunPrompt(t *testing.T) {
	t.Parallel()
	issueURL := server.IssueURL("JeffreyVdb/lab", 3)
	if issueURL != "https://github.com/JeffreyVdb/lab/issues/3" {
		t.Fatalf("IssueURL = %q", issueURL)
	}
	mixed := proto.PresetRoles{
		Coder:      proto.Hire{Harness: "codex", Model: "gpt-6-luna", Effort: "xhigh"},
		Reviewer:   proto.Hire{Harness: "claude", Model: "claude-fable-5-1", Effort: "max"},
		UX:         proto.Hire{Harness: "claude", Model: "claude-opus-5-5", Effort: "low"},
		Researcher: proto.Hire{Harness: "codex", Model: "gpt-6-astra", Effort: "ultra"},
	}
	multi := "Fix the lobby lights.\n\nThey flicker when a worker walks in."
	for _, tc := range []struct {
		name   string
		call   string
		ticket string
		issue  bool
		roles  proto.PresetRoles
		extra  string
		want   string
	}{
		{"claude issue", "/write-code", issueURL, true, buildTeam, "",
			"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine},
		{"codex issue", "$write-code", issueURL, true, buildTeam, "",
			"$write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine},
		{"claude issue + extra", "/write-code", issueURL, true, buildTeam, "  Use port 5173 for the demo.\nKeep it small.\n\n",
			"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine +
				"\n\nUse port 5173 for the demo.\nKeep it small."},
		{"codex issue + extra", "$write-code", issueURL, true, buildTeam, "Keep it small.",
			"$write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine + "\n\nKeep it small."},
		{"claude text", "/write-code", "  " + multi + "\n", false, buildTeam, "",
			"/write-code " + multi + "\n\n" + buildHead},
		{"codex text", "$write-code", multi, false, buildTeam, "",
			"$write-code " + multi + "\n\n" + buildHead},
		{"claude text + extra", "/write-code", multi, false, buildTeam, "No new deps.",
			"/write-code " + multi + "\n\n" + buildHead + "\n\nNo new deps."},
		{"codex text + extra", "$write-code", multi, false, buildTeam, "No new deps.",
			"$write-code " + multi + "\n\n" + buildHead + "\n\nNo new deps."},
		{"whitespace-only extra is none", "/write-code", issueURL, true, buildTeam, " \n\t ",
			"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildHead + "\n\n" + statusLine},
		{"effort vs reasoning follows each role's harness", "$write-code", issueURL, true, mixed, "",
			"$write-code https://github.com/JeffreyVdb/lab/issues/3\n\nTeam:\n" +
				"- coders: codex gpt-6-luna, reasoning xhigh\n" +
				"- reviewers: claude claude-fable-5-1, effort max\n" +
				"- ux reviewers: claude claude-opus-5-5, effort low\n" +
				"- researchers: codex gpt-6-astra, reasoning ultra\n\n" + placementLine + "\n\n" + floorLineS + "\n\n" + agentLineT + "\n\n" + statusLine},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := server.RunPrompt(tc.call, tc.ticket, tc.issue, tc.roles, "s", tc.extra); got != tc.want {
				t.Fatalf("RunPrompt =\n%s\n---\nwant\n%s", got, tc.want)
			}
		})
	}
}

// #58: the floor line names the orchestrator's floor, a virtual one too,
// right after the placement rule.
func TestRunPromptNamesTheFloor(t *testing.T) {
	t.Parallel()
	got := server.RunPrompt("/write-code", "Fix the lobby.", false, buildTeam, "v-0123456789ab", "")
	want := "/write-code Fix the lobby.\n\n" + buildTeamLines + "\n\n" + placementLine + "\n\n" +
		"Also tag every herdr workspace you create with the token h3d_floor=v-0123456789ab, " +
		"in the same herdr workspace report-metadata call as its other h3d_ tokens: it puts that agent on your floor.\n\n" + agentLineT
	if got != want {
		t.Fatalf("prompt =\n%s\nwant\n%s", got, want)
	}
}

// #184, #102: an item's ticket is its canonical URL, like an issue's, with
// no status line, and with extra instructions after the floor line; with no
// URL it is "<Provider> task <key>", never a bare number.
func TestItemPrompt(t *testing.T) {
	t.Parallel()
	ticket := &proto.RunTicket{Kind: proto.TicketItem, ProviderName: "Kaneo",
		Item: &proto.WorkItemRef{Provider: "kaneo", ID: "t1", Key: "HRD-3", Title: " Lobby ", URL: "https://tasks.example.test/x"}}
	for call, extra := range map[string]string{"$write-code": "", "/write-code": "  Keep it small.\n"} {
		want := call + " https://tasks.example.test/x\n\n" + buildHead
		if extra != "" {
			want += "\n\nKeep it small."
		}
		if got := server.TicketPrompt(call, ticket, buildTeam, "s", extra); got != want {
			t.Fatalf("prompt =\n%s\nwant\n%s", got, want)
		}
	}
	ticket.Item.URL = ""
	if got, want := server.TicketPrompt("/write-code", ticket, buildTeam, "s", ""), "/write-code Kaneo task HRD-3\n\n"+buildHead; got != want {
		t.Fatalf("prompt without a URL =\n%s\nwant\n%s", got, want)
	}
	// An issue's prompt is the one it always was.
	issue := &proto.RunTicket{Kind: proto.TicketIssue, Repo: "JeffreyVdb/lab", Number: 3, URL: server.IssueURL("JeffreyVdb/lab", 3)}
	if got := server.TicketPrompt("/write-code", issue, buildTeam, "s", ""); got != server.RunPrompt("/write-code", issue.URL, true, buildTeam, "s", "") {
		t.Fatalf("issue prompt = %q", got)
	}
}

// #167: a Codex role on another profile than the bridge's own has its
// profile's name, home and token on its team line, and one line after the
// hiring lines says how to start and tag such an agent. A team all on the
// default (no profiles, or each one the default) is the prompt it always
// was, also when the roles' own codex_profile say "auto" or a key.
func TestTeamPromptProfiles(t *testing.T) {
	t.Parallel()
	ticket := &proto.RunTicket{Kind: proto.TicketText, Text: "Fix the lobby."}
	team := buildTeam
	team.Reviewer.CodexProfile, team.Researcher.CodexProfile = "auto", "work"
	want := "/write-code Fix the lobby.\n\n" + buildHead
	for _, profiles := range []server.TeamProfiles{nil, {}} {
		if got := server.TeamPrompt("/write-code", ticket, team, profiles, "s", ""); got != want {
			t.Fatalf("all on the default =\n%s\nwant\n%s", got, want)
		}
	}
	profiles := server.TeamProfiles{
		"reviewer":   {Key: "work", Name: "Work", Home: "/home/u/.codex-work"},
		"researcher": {Key: "lab-1a2b3c", Name: "Lab", Home: "/data/lab"},
	}
	got := server.TeamPrompt("/write-code", ticket, team, profiles, "s", "Keep it small.")
	want = "/write-code Fix the lobby.\n\nTeam:\n" +
		"- coders: claude claude-opus-5-5, effort medium\n" +
		"- reviewers: codex gpt-6-sol, reasoning high, Codex profile Work (CODEX_HOME=/home/u/.codex-work, token h3d_codex_profile=work)\n" +
		"- ux reviewers: codex gpt-6-sol, reasoning high\n" +
		"- researchers: codex gpt-6-sol, reasoning low, Codex profile Lab (CODEX_HOME=/data/lab, token h3d_codex_profile=lab-1a2b3c)\n\n" +
		placementLine + "\n\n" + floorLineS + "\n\n" + agentLineT + "\n\n" +
		"Start an agent whose team line names a Codex profile with CODEX_HOME set to that folder for its Codex: " +
		"create its workspace with herdr workspace create --env CODEX_HOME=<folder> (or run export CODEX_HOME=<folder> in its pane before herdr agent start), " +
		"and also tag that workspace with the token h3d_codex_profile=<key> its team line gives, in the same herdr workspace report-metadata call as its other h3d_ tokens: " +
		"the floor then reads that agent's transcript in that profile's folder." +
		"\n\nKeep it small."
	if got != want {
		t.Fatalf("prompt =\n%s\nwant\n%s", got, want)
	}
	if strings.Contains(got, "auto") {
		t.Fatalf("the prompt says auto: %s", got)
	}
}
