package world

// M6 runs: the write-code run details of a workspace beyond its role and
// run (round, ticket, the orchestrator's phase and pass, the report).

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits of the run details taken from tokens and labels.
const (
	MaxTicketLen = 32
	MaxPhaseLen  = 32
	maxRound     = 1_000_000
	maxPass      = 1_000_000
)

var labelRoundRe = regexp.MustCompile(`^r([1-9][0-9]{0,6})$`)

// Run is what a workspace's h3d_* tokens and label say about its place in
// a write-code run, beyond RoleRun.
type Run struct {
	// Round is the h3d_round token, else the label's trailing `|r<N>`; 0
	// when unknown.
	Round int
	// Ticket is the h3d_ticket token, else the label's ticket field
	// (`CODE|descr|<ticket>|r<N>`, likewise REVIEW and UX); at most
	// MaxTicketLen bytes, else unknown.
	Ticket string
	// Phase and Pass are an orchestrator's h3d_phase / h3d_pass tokens
	// (Phase cut to MaxPhaseLen bytes; Pass nil when unknown).
	Phase string
	Pass  *int
	// Report is the h3d_report token: the file name of the worker's report
	// in its run directory.
	Report string
}

// RunOf derives a workspace's run details from its tokens, falling back to
// the write-code label convention for the round and the ticket.
func RunOf(label string, tokens map[string]string) Run {
	var r Run
	var parts []string
	role := ""
	if m := labelRole.FindStringSubmatch(label); m != nil {
		role, parts = m[1], strings.Split(m[2], "|")
	}
	if n, ok := atoiIn(tokens["h3d_round"], 1, maxRound); ok {
		r.Round = n
	} else if len(parts) >= 2 {
		if m := labelRoundRe.FindStringSubmatch(parts[len(parts)-1]); m != nil {
			r.Round, _ = strconv.Atoi(m[1])
		}
	}
	if t := tokens["h3d_ticket"]; t != "" {
		r.Ticket = t
	} else if (role == "CODE" || role == "REVIEW" || role == "UX") && len(parts) == 3 && labelRoundRe.MatchString(parts[2]) {
		r.Ticket = parts[1]
	}
	if len(r.Ticket) > MaxTicketLen {
		r.Ticket = ""
	}
	r.Phase = CutUTF8(tokens["h3d_phase"], MaxPhaseLen)
	if n, ok := atoiIn(tokens["h3d_pass"], 0, maxPass); ok {
		r.Pass = &n
	}
	r.Report = tokens["h3d_report"]
	return r
}

func atoiIn(s string, lo, hi int) (int, bool) {
	n, err := strconv.Atoi(s)
	if err != nil || n < lo || n > hi || strings.HasPrefix(s, "+") {
		return 0, false
	}
	return n, true
}

// IssueNumber is the issue number a ticket names (`7`, `#7`), else 0.
func IssueNumber(ticket string) int {
	digits := strings.TrimPrefix(ticket, "#")
	n, ok := atoiIn(digits, 1, 1<<31-1)
	if !ok || digits[0] == '0' {
		return 0
	}
	return n
}

// CutUTF8 returns s cut to at most n bytes without splitting a character.
func CutUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// Freelancer reports whether a role is one of write-code's short-lived
// workers (code, review, ux, ground); the orchestrator is an employee.
func Freelancer(role string) bool {
	switch role {
	case "code", "review", "ux", "ground":
		return true
	}
	return false
}
