package server

import (
	"fmt"
	"strings"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

// M6 launch: the first prompt of an orchestrator started from the game.

// IssueURL is the GitHub URL of an issue.
func IssueURL(repo string, number int) string {
	return fmt.Sprintf("https://github.com/%s/issues/%d", repo, number)
}

// issueStatusLine tells the orchestrator how the issue's status follows the run.
const issueStatusLine = "Move the ticket status accordingly, pull request always means QA, merging the PR always means Done."

// placementLine tells the orchestrator where its agents go: a laptop shows a
// pane at the pane's own size, so an agent in a split next to another is a
// narrow screen (#74).
const placementLine = "Start every agent you hire in its own herdr workspace or tab, never in a split pane of your tab or of another agent's tab: " +
	"a laptop shows a pane at its own size, and a fullscreen terminal is wanted."

// floorLine tells the orchestrator to tag the workspaces it creates with its
// floor (#58). It is a hint: the bridge places a freelancer on its
// orchestrator's floor once its run links it, and honours the token only
// on a workspace nothing else attributed.
func floorLine(floor string) string {
	return "Also tag every herdr workspace you create with the token " + floorToken + "=" + floor +
		", in the same herdr workspace report-metadata call as its other h3d_ tokens: it puts that agent on your floor."
}

// agentLine tells the orchestrator to tag the workspaces it creates with what
// it starts their agents with (H3D-2). A raw `herdr agent start` carries no
// hire record: the tokens are what the bridge then reports of the agent's
// harness, model and effort until its transcript says what it runs on.
const agentLine = "Also tag every herdr workspace you create with the tokens h3d_harness, h3d_model and h3d_effort, " +
	"the harness, model id and effort you start that agent with, in the same herdr workspace report-metadata call as the floor token: " +
	"use h3d_harness=claude for Claude Code and h3d_harness=codex for Codex. The floor shows them as that agent's model line."

// hireInstructions are the herdr hiring instructions for floor: where an
// agent starts the agents it hires, and the floor, harness, model and effort
// to tag them with. run.start
// puts them in an orchestrator's first prompt; #95 a worker.hire with
// herdr_instructions (a hire preset's "Add herdr hiring instructions") adds
// them after its prompt, and hire.prepare shows them.
func hireInstructions(floor string) string {
	return placementLine + "\n\n" + floorLine(floor) + "\n\n" + agentLine
}

// profileToken is the token an agent started on a Codex profile is tagged
// with (#167): the profile's key, which tells the bridge the Codex home its
// sessions are in (codexHomeOf).
const profileToken = "h3d_codex_profile"

// profileLine tells the orchestrator how to start an agent on the Codex
// profile its team line names (#167), after the hiring lines when a role
// has one other than the bridge's own.
const profileLine = "Start an agent whose team line names a Codex profile with CODEX_HOME set to that folder for its Codex: " +
	"create its workspace with herdr workspace create --env CODEX_HOME=<folder> (or run export CODEX_HOME=<folder> in its pane before herdr agent start), " +
	"and also tag that workspace with the token " + profileToken + "=<key> its team line gives, in the same herdr workspace report-metadata call as its other h3d_ tokens: " +
	"the floor then reads that agent's transcript in that profile's folder."

// TeamProfile is a Codex role's profile for a run (#167), resolved at
// run start: a listed profile other than the bridge's own, never Auto.
type TeamProfile struct{ Key, Name, Home string }

// TeamProfiles are a run's Codex roles on another profile than the
// bridge's own, by role (coder, reviewer, ux, researcher); a role on the
// default is not in it.
type TeamProfiles map[string]TeamProfile

// writeCodeSkill is the skill an orchestrator's first prompt runs.
const writeCodeSkill = "write-code"

// RunPrompt composes an orchestrator's first prompt: the write-code skill
// invoked as call (the orchestrator harness's way, PromptTranslator's
// SkillCall: claude /write-code, codex $write-code) on the ticket (an issue URL, or free text, trimmed), the team of the preset,
// the line telling it where to start its agents, the line telling it to tag
// them with its floor (the floor id), for an issue the line
// telling it to move the status, and the extra instructions (trimmed; with the blank line before them left
// out when empty).
func RunPrompt(call, ticket string, isIssue bool, roles proto.PresetRoles, floor, extra string) string {
	status := ""
	if isIssue {
		status = issueStatusLine
	}
	return runPrompt(call, ticket, status, roles, nil, floor, extra)
}

// itemRef is how a prompt names an item of a provider that numbers no
// GitHub issues (#184, #102): its canonical URL (Kaneo's names the
// instance, workspace, project and task), which the agent reads with the
// tools it has, as a GitHub issue's URL; "<Provider> task <key>" only
// when the provider gave no URL, never a bare number.
func itemRef(t *proto.RunTicket) string {
	if t.Item.URL != "" {
		return t.Item.URL
	}
	return t.ProviderName + " task " + t.Item.Key
}

// TicketPrompt is RunPrompt for a run ticket: an issue or a text as before,
// an item (#184) by its reference (#102: no copied title or description),
// with no status line (a provider's board need not have the issue line's
// QA and Done columns).
func TicketPrompt(call string, t *proto.RunTicket, roles proto.PresetRoles, floor, extra string) string {
	return TeamPrompt(call, t, roles, nil, floor, extra)
}

// TeamPrompt is TicketPrompt with the team's Codex profiles (#167): each
// role in profiles has its profile on its team line, and profileLine
// follows the hiring lines; with none it is TicketPrompt's to the byte.
func TeamPrompt(call string, t *proto.RunTicket, roles proto.PresetRoles, profiles TeamProfiles, floor, extra string) string {
	switch {
	case t.Kind == proto.TicketItem && t.Item != nil:
		return runPrompt(call, itemRef(t), "", roles, profiles, floor, extra)
	case t.Kind == proto.TicketIssue:
		return runPrompt(call, ticketRef(t), issueStatusLine, roles, profiles, floor, extra)
	}
	return runPrompt(call, ticketRef(t), "", roles, profiles, floor, extra)
}

// writeCodeCall is how an orchestrator of harness runs write-code: the
// translator's SkillCall (none: "/write-code").
func (h *Hub) writeCodeCall(harness string) string {
	if h.opts.Prompts == nil {
		return "/" + writeCodeSkill
	}
	return h.opts.Prompts.SkillCall(harness, writeCodeSkill)
}

// teamRole is a role of the team the orchestrator hires: its key in
// TeamProfiles, its words on its team line, and its hire.
type teamRole struct {
	role, what string
	hire       proto.Hire
}

// teamRoles are the roles of the team lines, in their order (the
// orchestrator is none of them).
func teamRoles(roles proto.PresetRoles) []teamRole {
	return []teamRole{
		{"coder", "coders", roles.Coder},
		{"reviewer", "reviewers", roles.Reviewer},
		{"ux", "ux reviewers", roles.UX},
		{"researcher", "researchers", roles.Researcher},
	}
}

func runPrompt(call, ticket, status string, roles proto.PresetRoles, profiles TeamProfiles, floor, extra string) string {
	var b strings.Builder
	b.WriteString(call + " " + strings.TrimSpace(ticket) + "\n\nTeam:")
	onProfile := false
	for _, r := range teamRoles(roles) {
		knob := "effort"
		if r.hire.Harness == "codex" {
			knob = "reasoning"
		}
		fmt.Fprintf(&b, "\n- %s: %s %s, %s %s", r.what, r.hire.Harness, r.hire.Model, knob, r.hire.Effort)
		if p, ok := profiles[r.role]; ok && r.hire.Harness == "codex" {
			fmt.Fprintf(&b, ", Codex profile %s (CODEX_HOME=%s, token %s=%s)", p.Name, p.Home, profileToken, p.Key)
			onProfile = true
		}
	}
	b.WriteString("\n\n" + hireInstructions(floor))
	if onProfile {
		b.WriteString("\n\n" + profileLine)
	}
	if status != "" {
		b.WriteString("\n\n" + status)
	}
	if extra = strings.TrimSpace(extra); extra != "" {
		b.WriteString("\n\n" + extra)
	}
	return b.String()
}
