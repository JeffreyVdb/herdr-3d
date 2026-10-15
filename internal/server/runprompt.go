package server

import (
	"fmt"
	"strings"
	"unicode/utf8"

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
	return runPrompt(call, ticket, status, roles, floor, extra)
}

// maxItemBody bounds how much of an item's description goes into a prompt
// (#184); the rest stays with the provider.
const maxItemBody = 6000

// ItemTicket is how a prompt names an item of a provider that numbers no
// GitHub issues (#184): an agent cannot read it there (the bridge's key
// never reaches an agent), so the ticket carries what the provider gave:
// "<Provider> task <key>: <title>", its URL, and its description (its
// first maxItemBody bytes).
func ItemTicket(t *proto.RunTicket) string {
	it := t.Item
	var b strings.Builder
	fmt.Fprintf(&b, "%s task %s: %s", t.ProviderName, it.Key, strings.TrimSpace(it.Title))
	if it.URL != "" {
		b.WriteString("\n" + it.URL)
	}
	if body := strings.TrimSpace(t.Body); body != "" {
		if len(body) > maxItemBody {
			n := maxItemBody
			for n > 0 && !utf8.RuneStart(body[n]) {
				n--
			}
			body = strings.TrimSpace(body[:n]) + "\n\n[The description goes on in " + t.ProviderName + "; this is its first part.]"
		}
		b.WriteString("\n\n" + body)
	}
	return b.String()
}

// itemLine tells the orchestrator that the ticket is no GitHub issue
// (#184): no gh lookups, and the status is not its to move.
func itemLine(provider string) string {
	return "This ticket is a " + provider + " task, not a GitHub issue: everything the bridge read of it is above. " +
		"Don't look it up with gh, and leave its status on the " + provider + " board to people."
}

// TicketPrompt is RunPrompt for a run ticket: an issue or a text as before,
// an item (#184) with its text inlined and the item line in place of the
// status line.
func TicketPrompt(call string, t *proto.RunTicket, roles proto.PresetRoles, floor, extra string) string {
	if t.Kind == proto.TicketItem && t.Item != nil {
		return runPrompt(call, ItemTicket(t), itemLine(t.ProviderName), roles, floor, extra)
	}
	return RunPrompt(call, ticketRef(t), t.Kind == proto.TicketIssue, roles, floor, extra)
}

// writeCodeCall is how an orchestrator of harness runs write-code: the
// translator's SkillCall (none: "/write-code").
func (h *Hub) writeCodeCall(harness string) string {
	if h.opts.Prompts == nil {
		return "/" + writeCodeSkill
	}
	return h.opts.Prompts.SkillCall(harness, writeCodeSkill)
}

func runPrompt(call, ticket, status string, roles proto.PresetRoles, floor, extra string) string {
	var b strings.Builder
	b.WriteString(call + " " + strings.TrimSpace(ticket) + "\n\nTeam:")
	for _, r := range []struct {
		what string
		hire proto.Hire
	}{
		{"coders", roles.Coder},
		{"reviewers", roles.Reviewer},
		{"ux reviewers", roles.UX},
		{"researchers", roles.Researcher},
	} {
		knob := "effort"
		if r.hire.Harness == "codex" {
			knob = "reasoning"
		}
		fmt.Fprintf(&b, "\n- %s: %s %s, %s %s", r.what, r.hire.Harness, r.hire.Model, knob, r.hire.Effort)
	}
	b.WriteString("\n\n" + placementLine + "\n\n" + floorLine(floor))
	if status != "" {
		b.WriteString("\n\n" + status)
	}
	if extra = strings.TrimSpace(extra); extra != "" {
		b.WriteString("\n\n" + extra)
	}
	return b.String()
}
