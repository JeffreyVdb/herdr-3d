package cmdrequest

import (
	"regexp"
	"strings"
)

// Band is the lower classifier band (#213): a reply that scores at least
// Band but under Threshold still reaches extraction when Candidate finds a
// shell command the reply asks for. The classifier scored the missed
// `sudo -k …` reply 0.52; see docs/decisions/manual-processes.md for the
// numbers behind both values.
const Band = 0.35

// The candidate rules.
const (
	RuleFence  = "fence"  // a shell or untagged fenced block after an ask
	RulePrompt = "prompt" // a `$ ` command line after an ask
)

// shellTags are the fence info strings of shell commands ("": untagged).
var shellTags = map[string]bool{"": true, "sh": true, "bash": true, "shell": true, "zsh": true, "fish": true,
	"console": true, "shell-session": true, "shellsession": true, "terminal": true, "cmd": true, "powershell": true, "ps1": true}

// askRE is an imperative ask to run something; leadRE is what makes an ask
// a report or an aside instead (the agent's own run, an example, an
// alternative).
var (
	askRE  = regexp.MustCompile(`(?i)\b(run|re-?run|launch|execute|paste|type|start|restart|invoke)\b`)
	leadRE = regexp.MustCompile(`(?i)\b(i|we)('ve| have| had)? (ran|run|executed|launched|started|tried|tested|verified)\b|\b(example|e\.g\.|for instance|alternatively|alternative|optionally|output|returned|printed|shows?)\b`)
)

// askWindow is how much prose before a command is read for the ask.
const askWindow = 320

// Candidate reports the deterministic rule a reply meets ("": none): a
// fenced block tagged as shell (or untagged) whose preceding prose, the
// paragraph right before it, asks to run, launch, execute, paste, type or
// start something and is not a report of what the agent ran, an example or
// an alternative; or a `$ ` command line under the same condition. It only
// admits a reply to extraction, whose prompt and validation stay as they
// are: it never makes a command by itself.
func Candidate(reply string) string {
	lines := strings.Split(reply, "\n")
	var prose strings.Builder // the paragraph before the current line
	inFence, fenceShell, fenceAsk := false, false, false
	fenceBody := 0
	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t\r")
		trim := strings.TrimLeft(line, " \t>")
		if strings.HasPrefix(trim, "```") || strings.HasPrefix(trim, "~~~") {
			if inFence {
				if fenceShell && fenceAsk && fenceBody > 0 {
					return RuleFence
				}
				inFence = false
				prose.Reset()
				continue
			}
			tag := strings.ToLower(strings.TrimSpace(strings.Trim(trim, "`~")))
			if i := strings.IndexAny(tag, " {"); i >= 0 {
				tag = tag[:i]
			}
			inFence, fenceShell, fenceAsk, fenceBody = true, shellTags[tag], asks(prose.String()), 0
			continue
		}
		if inFence {
			if strings.TrimSpace(line) != "" {
				fenceBody++
			}
			if strings.HasPrefix(trim, "$ ") && len(trim) > 2 && fenceAsk {
				return RulePrompt
			}
			continue
		}
		if strings.HasPrefix(trim, "$ ") && len(strings.TrimSpace(trim[2:])) > 0 && asks(prose.String()) {
			return RulePrompt
		}
		if strings.TrimSpace(line) == "" {
			if prose.Len() > 0 {
				prose.WriteByte('\n')
			}
			continue
		}
		prose.WriteString(line)
		prose.WriteByte('\n')
	}
	return ""
}

// asks reports whether the prose right before a command asks for it: the
// last paragraph (up to askWindow bytes) has an ask and no lead that makes
// it a report, an example or an alternative.
func asks(prose string) bool {
	prose = strings.TrimRight(prose, "\n")
	if i := strings.LastIndex(prose, "\n\n"); i >= 0 {
		prose = prose[i+2:]
	}
	if len(prose) > askWindow {
		prose = prose[len(prose)-askWindow:]
	}
	return askRE.MatchString(prose) && !leadRE.MatchString(prose)
}
