package server_test

import (
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

const buildTeamLines = `Team:
- coders: claude claude-opus-5-5, effort medium
- reviewers: codex gpt-6-sol, reasoning high
- ux reviewers: codex gpt-6-sol, reasoning high
- researchers: codex gpt-6-sol, reasoning low`

func TestRunPrompt(t *testing.T) {
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
		name    string
		harness string
		ticket  string
		roles   proto.PresetRoles
		extra   string
		want    string
	}{
		{"claude issue", "claude", issueURL, buildTeam, "",
			"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildTeamLines},
		{"codex issue", "codex", issueURL, buildTeam, "",
			"$write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildTeamLines},
		{"claude issue + extra", "claude", issueURL, buildTeam, "  Use port 5173 for the demo.\nKeep it small.\n\n",
			"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildTeamLines +
				"\n\nUse port 5173 for the demo.\nKeep it small."},
		{"codex issue + extra", "codex", issueURL, buildTeam, "Keep it small.",
			"$write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildTeamLines + "\n\nKeep it small."},
		{"claude text", "claude", "  " + multi + "\n", buildTeam, "",
			"/write-code " + multi + "\n\n" + buildTeamLines},
		{"codex text", "codex", multi, buildTeam, "",
			"$write-code " + multi + "\n\n" + buildTeamLines},
		{"claude text + extra", "claude", multi, buildTeam, "No new deps.",
			"/write-code " + multi + "\n\n" + buildTeamLines + "\n\nNo new deps."},
		{"codex text + extra", "codex", multi, buildTeam, "No new deps.",
			"$write-code " + multi + "\n\n" + buildTeamLines + "\n\nNo new deps."},
		{"whitespace-only extra is none", "claude", issueURL, buildTeam, " \n\t ",
			"/write-code https://github.com/JeffreyVdb/lab/issues/3\n\n" + buildTeamLines},
		{"effort vs reasoning follows each role's harness", "codex", issueURL, mixed, "",
			"$write-code https://github.com/JeffreyVdb/lab/issues/3\n\nTeam:\n" +
				"- coders: codex gpt-6-luna, reasoning xhigh\n" +
				"- reviewers: claude claude-fable-5-1, effort max\n" +
				"- ux reviewers: claude claude-opus-5-5, effort low\n" +
				"- researchers: codex gpt-6-astra, reasoning ultra"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := server.RunPrompt(tc.harness, tc.ticket, tc.roles, tc.extra); got != tc.want {
				t.Fatalf("RunPrompt =\n%s\n---\nwant\n%s", got, tc.want)
			}
		})
	}
}
