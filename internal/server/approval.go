package server

// #106: what a permission or trust menu is about, read off the screen as
// its operation: the dialog's lines from its top, whole, without the lines
// that only say how long something has run. Its hash is what worker.answer
// checks (questionHash); its key (opKey) is what keeps one Telegram card
// for one approval through redraws, a rewrap and a failed read.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/JeffreyVdb/herdr-3d/internal/digest"
	"github.com/JeffreyVdb/herdr-3d/internal/notify"
	"github.com/JeffreyVdb/herdr-3d/internal/proto"
	"github.com/JeffreyVdb/herdr-3d/internal/transcript"
)

// maxOpLines bounds the lines of a dialog read as its operation (a screen
// has fewer; a pane read is never that tall).
const maxOpLines = 400

var (
	// opHeadRe is the first line of a dialog that asks above what it is
	// about (Codex's approvals and trust dialog), trimmed.
	opHeadRe = regexp.MustCompile(`(?i)^(would you like to\b|folder access$)`)
	// incidentalRe are lines a dialog or the screen around it may show that
	// say how long something has run or that it still runs, never what is
	// asked (TestIncidentalLines): Claude Code's background task line, a
	// spinner's status, an elapsed time or a countdown on its own.
	incidentalRe = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^\d*\s*background (tasks?|shells?|commands?) running( for)?( \d+(\.\d+)?\s?(ms|s|m|h))*\.?$`),
		regexp.MustCompile(`^[✻✶✳✢·✽*] \S.*\(\d+(\.\d+)?s\b[^)]*\)$`),
		regexp.MustCompile(`(?i)\besc to interrupt\b`),
		regexp.MustCompile(`(?i)^\(?\d+(\.\d+)?\s?(ms|s|m|h)( \d+s)?\)?$`),
		regexp.MustCompile(`^\d{1,2}:\d{2}(:\d{2})?$`),
		regexp.MustCompile(`(?i)^(auto-?)?(deny|denies|denied|declines?|rejects?|cancels?|times? out)\b.*\bin \d+(:\d{2})?\s?(s|secs?|seconds?|m|mins?|minutes?)?\.?$`),
	}
)

// isIncidental reports whether a trimmed line only says how long something
// has run (incidentalRe).
func isIncidental(t string) bool {
	for _, re := range incidentalRe {
		if re.MatchString(t) {
			return true
		}
	}
	return false
}

// onlyIncidental reports whether lines are empty or incidental, every one.
func onlyIncidental(lines []string) bool {
	for _, l := range lines {
		if t := strings.TrimSpace(l); t != "" && !isIncidental(t) {
			return false
		}
	}
	return true
}

// menuOp is what a permission or trust menu is about, as its screen shows
// it.
type menuOp struct {
	// lines are the operation's: the dialog's lines from its top down to
	// its question (Claude's dialog asks below them) or to its first choice
	// (Codex's asks above them), trimmed, whole (never clipped), without a
	// rule or an incidental line.
	lines []string
	// complete: the dialog's top is on the screen, so nothing of it is
	// above. Else lines are what the screen shows of its end.
	complete bool
	// key names the operation through a redraw: its kind, the blocked
	// spell, its choices' count and its lines joined without whitespace (a
	// rewrap or a resize moves only that).
	key string
}

// isLeftRule reports whether l, untrimmed, is a solid rule from the
// screen's left edge: Claude Code's dialog top. A rule inside a command is
// indented under the dialog's head.
func isLeftRule(l string) bool {
	if l == "" || l[0] == ' ' || l[0] == '\t' {
		return false
	}
	t := strings.TrimSpace(l)
	return isRule(t) && !strings.ContainsAny(t, "╌╍┄┅┈┉")
}

// opOf reads the operation of a permission or trust menu whose first choice
// is on line first and whose question is on line qline (-1: none found). A
// Claude dialog's top is its rule at the left edge, a Codex dialog's its
// first line (opHeadRe); a harness not known takes whichever comes first
// going up. Looked for up to the screen's top: not found, the operation is
// the questionReach lines above the menu, and not complete.
func opOf(harness string, q proto.Question, lines []string, first, qline int, since int64) *menuOp {
	top, head := -1, false
	for i := first - 1; i >= 0 && first-i <= maxOpLines; i-- {
		t := strings.TrimSpace(lines[i])
		if harness != transcript.Codex && isLeftRule(lines[i]) {
			top = i
			break
		}
		if harness != transcript.Claude && opHeadRe.MatchString(t) {
			top, head = i, true
			break
		}
	}
	op := &menuOp{complete: top >= 0}
	from, to := top+1, first
	switch {
	case top < 0:
		from = max(0, first-questionReach)
	case head:
		from = top // Codex: its first line asks, and what follows is what it asks about
	case qline > top && qline < first && onlyIncidental(lines[qline+1:first]):
		to = qline // Claude: its question is right above the choices, what it is about above it
	}
	var bare strings.Builder
	for i := from; i < to; i++ {
		t := strings.TrimSpace(lines[i])
		if t == "" || isRule(t) || isIncidental(t) {
			continue
		}
		op.lines = append(op.lines, t)
		for _, r := range t {
			if !unicode.IsSpace(r) {
				bare.WriteRune(r)
			}
		}
	}
	h := sha256.New()
	fmt.Fprintf(h, "%s\x00%d\x00%d\x00%t\x00%s", q.Kind, since, len(q.Choices), op.complete, bare.String())
	op.key = hex.EncodeToString(h.Sum(nil))[:16]
	return op
}

// hashLines are what questionHash folds in of the operation: its lines,
// and whether its top was on the screen.
func (op *menuOp) hashLines() []string {
	out := append([]string(nil), op.lines...)
	if !op.complete {
		out = append(out, "\x01partial")
	}
	return out
}

// plainLine is t without control characters, for a line that leaves the
// bridge.
func plainLine(t string) string {
	if !utf8.ValidString(t) {
		t = strings.ToValidUTF8(t, "�")
	}
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, t)
}

// Bounds of what a menu's card shows of its operation.
const (
	aboutLineMax  = 300  // runes of one line
	aboutLinesMax = 24   // lines
	aboutMax      = 1800 // runes in all
)

// What a menu's card says of what it could not show.
const (
	aboutPartial = "⚠ Its start is off the screen: only its end is shown."
	aboutCut     = "… (%d more lines not shown)"
)

// redactions are what a line of an operation loses before it leaves the
// bridge, on top of digest.Scrub's tokens (TestRedactLine): a password
// given to curl and the like, an auth header's value, a secret-looking
// assignment or option's value, a MySQL or sshpass password.
var redactions = []struct {
	re   *regexp.Regexp
	with string
}{
	{regexp.MustCompile(`(?i)((?:^|[\s;|&(])(?:-u|--user|-U|--proxy-user)(?:\s+|=)?['"]?[^\s:'"]*:)[^\s'"]+`), "${1}[key]"},
	{regexp.MustCompile(`(?i)\b((?:proxy-)?authorization|x-api-key|api-key|x-auth-token|private-token|cookie)(\s*:\s*)[^'"\n]+`), "${1}${2}[key]"},
	{regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?|auth))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s'";|&]+)`), "${1}${2}[key]"},
	{regexp.MustCompile(`(?i)(--[a-z0-9-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?)(?:\s+|=))("[^"]*"|'[^']*'|[^\s'";|&-][^\s'";|&]*)`), "${1}[key]"},
	{regexp.MustCompile(`(?i)(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;|&\n]*?\s-p)([^\s'";|&]+)`), "${1}[key]"},
	{regexp.MustCompile(`(?i)(\bsshpass\s+-p\s*)([^\s'";|&]+)`), "${1}[key]"},
}

// redactLine is a line of an operation as it may leave the bridge: what
// looks like a secret removed, no control character.
func redactLine(s string) string {
	s = plainLine(s)
	for _, r := range redactions {
		s = r.re.ReplaceAllString(s, r.with)
	}
	return digest.Scrub(s)
}

// aboutLines is what a menu's card shows of lines (an operation's, the
// screen's or its native call's): each redacted and cut to aboutLineMax,
// at most aboutLinesMax of them and aboutMax runes in all, the rest said.
func aboutLines(lines []string) []string {
	var out []string
	total := 0
	for i, l := range lines {
		l = redactLine(l)
		if utf8.RuneCountInString(l) > aboutLineMax {
			l = string([]rune(l)[:aboutLineMax-1]) + "…"
		}
		n := utf8.RuneCountInString(l)
		if len(out) == aboutLinesMax || total+n > aboutMax {
			out = append(out, fmt.Sprintf(aboutCut, len(lines)-i))
			break
		}
		out = append(out, l)
		total += n
	}
	return out
}

// menuFacts adds to a menu's facts what its operation tells (#106): its
// key, what its card shows (redacted and bounded), and for a permission
// whose dialog's top is off the screen, its approving choices withheld:
// what the card shows of it is not all of it, so no tap approves it.
func menuFacts(m *notify.Menu, op *menuOp) {
	if m == nil || op == nil {
		return
	}
	m.Op, m.Source = op.key, "screen"
	m.About = aboutLines(op.lines)
	if op.complete {
		return
	}
	m.About = append([]string{aboutPartial}, m.About...)
	if m.Kind != proto.QuestionPermission {
		return
	}
	for i := range m.Choices {
		if approves(m.Choices[i].Label) {
			m.Choices[i].Withheld = true
		}
	}
}

// approves reports whether a permission menu's choice label approves (a
// Yes, as Claude Code and Codex write them).
func approves(label string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(label)), "yes")
}
