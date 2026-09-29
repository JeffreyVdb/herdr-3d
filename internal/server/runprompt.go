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

// RunPrompt composes an orchestrator's first prompt: the write-code skill
// invoked the harness's way (claude /write-code, codex $write-code) on the
// ticket (an issue URL, or free text, trimmed), the team of the preset,
// and the extra instructions (trimmed; with the blank line before them
// left out when empty).
func RunPrompt(orchHarness, ticket string, roles proto.PresetRoles, extra string) string {
	skill := "/write-code"
	if orchHarness == "codex" {
		skill = "$write-code"
	}
	var b strings.Builder
	b.WriteString(skill + " " + strings.TrimSpace(ticket) + "\n\nTeam:")
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
	if extra = strings.TrimSpace(extra); extra != "" {
		b.WriteString("\n\n" + extra)
	}
	return b.String()
}
