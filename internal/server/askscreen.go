package server

// #57: where an agent's question dialog is, read from its screen (`pane read
// --source visible` text), so worker.answer_ask presses a key only when the
// dialog is where it expects. Checked against screens captured from Claude
// Code 2.1.285 and codex-cli 0.159.2 under herdr 0.9.0
// (testdata/screens/claude-ask-*, codex-ask-*).

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/JeffreyVdb/herdr-3d/internal/proto"
)

var (
	// Claude's header line: the one question's "☐ Drink", or the tabs of
	// several (and of a multi-select one): "←  ☐ Color  ☒ Extras  ✔ Submit  →".
	claudeHeaderRe = regexp.MustCompile(`^\s*(?:←\s+)?[☐☒]\s+\S`)
	claudeTabRe    = regexp.MustCompile(`([☐☒✔])\s+(\S(?:.*?\S)?)(?:\s{2,}|\s*→|\s*$)`)
	// A numbered row: "❯ 1. Tea", "  2. [✔] Metrics", "❯ 1. Compact      ┌──…" (a preview box beside it).
	claudeRowRe = regexp.MustCompile(`^\s*(❯\s*)?(\d{1,2})\.\s+(?:\[([ ✔])\]\s+)?(.*)$`)
	// The unnumbered row that ends a multi-select question: Submit on the
	// last question, Next on one before.
	claudeSubmitRe = regexp.MustCompile(`^\s*(❯)?\s+(?:Submit|Next)\s*$`)

	codexIndexRe = regexp.MustCompile(`^\s*Question (\d+)/(\d+)\b`)
	codexRowRe   = regexp.MustCompile(`^\s*(›\s*)?(\d{1,2})\.\s+(.*)$`)
)

const (
	claudeTypeRow   = "Type something" // the Other row, "Type something." on a single-select question
	claudeChatRow   = "Chat about this"
	claudeReview    = "Review your answers"
	claudeSubmitAll = "Submit answers"
)

// dialogRow is one numbered row of a dialog.
type dialogRow struct {
	n      int
	label  string
	box    int // 0: no checkbox, 1: [ ], 2: [✔]
	cursor bool
}

// claudeDialog is Claude Code's AskUserQuestion dialog as the screen shows it.
type claudeDialog struct {
	ok     bool     // a dialog is on the screen
	tabs   []string // the header's tabs, "Submit" included (one question alone: its header)
	review bool     // the review of the answers ("Submit answers" / "Cancel")
	// question is the question shown (its lines joined, the "│" of a long one
	// dropped); rows its numbered rows (options, Type something, Chat about
	// this, or on the review Submit answers and Cancel).
	question  string
	rows      []dialogRow
	submitRow bool // the unnumbered Submit row of a multi-select question
	submitCur bool // the cursor is on it
	// reviewed: on the review, the questions it lists ("● Which color?",
	// its lines joined, a cut one's "…" dropped), the answer under each
	// ("→ Blue") left out.
	reviewed []string
}

func screenLines(screen string) []string {
	lines := strings.Split(strings.ReplaceAll(screen, "\r", ""), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRightFunc(l, unicode.IsSpace)
	}
	return lines
}

// collapse is s with every run of space one space, trimmed: text as a
// screen wraps it compares with text as the transcript has it.
func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

// sameQuestion reports whether a screen shows question q: the same words,
// or (a long one cut by the screen) one starts with the other.
func sameQuestion(screen, q string) bool {
	a, b := collapse(screen), collapse(q)
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	return len(a) >= 24 && len(b) >= 24 && (strings.HasPrefix(a, b) || strings.HasPrefix(b, a))
}

// rowLabel is a row's text without a preview box beside it (three spaces
// or more, then the box).
func rowLabel(s string) string {
	if i := strings.Index(s, "   "); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// parseClaudeDialog finds the AskUserQuestion dialog on a screen: its
// header (the last one near the bottom), then the question and its rows
// down to the key hints.
func parseClaudeDialog(screen string) claudeDialog {
	lines := screenLines(screen)
	head := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if claudeHeaderRe.MatchString(lines[i]) {
			head = i
			break
		}
	}
	var d claudeDialog
	if head < 0 {
		return d
	}
	for _, m := range claudeTabRe.FindAllStringSubmatch(lines[head], -1) {
		d.tabs = append(d.tabs, m[2])
	}
	var question []string
	hinted := false
	answer := false // on the review: in an answer's lines
	for _, l := range lines[head+1:] {
		t := strings.TrimSpace(l)
		switch {
		case t == "":
			continue
		case strings.Contains(t, "Esc to cancel") || strings.HasPrefix(t, "Ready to submit your answers?"):
			hinted = true
			continue
		case t == claudeReview:
			d.review = true
			continue
		case isRule(t):
			continue
		}
		if m := claudeRowRe.FindStringSubmatch(l); m != nil {
			n, _ := strconv.Atoi(m[2])
			r := dialogRow{n: n, label: rowLabel(m[4]), cursor: m[1] != ""}
			switch m[3] {
			case " ":
				r.box = 1
			case "✔":
				r.box = 2
			}
			d.rows = append(d.rows, r)
			continue
		}
		if m := claudeSubmitRe.FindStringSubmatch(l); m != nil && len(d.rows) > 0 {
			d.submitRow, d.submitCur = true, m[1] != ""
			continue
		}
		switch {
		case len(d.rows) > 0:
		case !d.review:
			question = append(question, strings.TrimSpace(strings.TrimPrefix(t, "│")))
		default:
			switch s, ok := strings.CutPrefix(t, "●"); {
			case ok:
				d.reviewed, answer = append(d.reviewed, strings.TrimSpace(s)), false
			case strings.HasPrefix(t, "→"):
				answer = true
			case !answer && len(d.reviewed) > 0: // a long question's next line
				d.reviewed[len(d.reviewed)-1] += " " + t
			}
		}
	}
	if d.review {
		for i, q := range d.reviewed {
			d.reviewed[i] = strings.TrimSuffix(collapse(q), "…")
		}
		// The review's rows are Submit answers and Cancel; the lines above them list the answers.
		d.ok = hinted && len(d.rows) > 0 && d.rows[0].label == claudeSubmitAll
		return d
	}
	d.question = collapse(strings.Join(question, " "))
	d.ok = hinted && len(d.rows) > 0 && d.question != ""
	return d
}

// row is numbered row n, if it is there.
func (d claudeDialog) row(n int) (dialogRow, bool) {
	for _, r := range d.rows {
		if r.n == n {
			return r, true
		}
	}
	return dialogRow{}, false
}

// cursor is the numbered row the cursor is on (0: none, the Submit row).
func (d claudeDialog) cursor() int {
	for _, r := range d.rows {
		if r.cursor {
			return r.n
		}
	}
	return 0
}

// codexDialog is Codex's request_user_input overlay as the screen shows it.
type codexDialog struct {
	ok           bool
	index, count int // "Question 2/3": 2, 3
	question     string
	rows         []dialogRow
	// notes: the notes composer is open (Other's text, or notes on an
	// option); notesText what it holds ("" while it shows its placeholder).
	notes     bool
	notesText string
}

// parseCodexDialog finds the overlay: its last "Question i/n" line, the
// question, the numbered rows and the notes composer under them.
func parseCodexDialog(screen string) codexDialog {
	lines := screenLines(screen)
	at := -1
	var d codexDialog
	for i := len(lines) - 1; i >= 0; i-- {
		if m := codexIndexRe.FindStringSubmatch(lines[i]); m != nil {
			at = i
			d.index, _ = strconv.Atoi(m[1])
			d.count, _ = strconv.Atoi(m[2])
			break
		}
	}
	if at < 0 {
		return codexDialog{}
	}
	var question []string
	hinted := false
	for _, l := range lines[at+1:] {
		t := strings.TrimSpace(l)
		switch {
		case t == "":
			continue
		case strings.Contains(t, "enter to submit") || strings.Contains(t, "esc to interrupt") || strings.Contains(t, "clear notes"):
			hinted = true
			if strings.Contains(t, "clear notes") {
				d.notes = true
			}
			continue
		}
		if m := codexRowRe.FindStringSubmatch(l); m != nil && !d.notes {
			n, _ := strconv.Atoi(m[2])
			label := m[3]
			if i := strings.Index(label, "  "); i >= 0 { // the description's column
				label = label[:i]
			}
			d.rows = append(d.rows, dialogRow{n: n, label: strings.TrimSpace(label), cursor: m[1] != ""})
			continue
		}
		if len(d.rows) > 0 {
			// Under the rows: the notes composer ("› Add notes", or what is typed in it).
			if s, ok := strings.CutPrefix(t, "›"); ok {
				d.notes = true
				if s = strings.TrimSpace(s); s != "Add notes" {
					d.notesText = s
				}
			}
			continue
		}
		question = append(question, t)
	}
	d.question = collapse(strings.Join(question, " "))
	d.ok = hinted && len(d.rows) > 0 && d.question != ""
	return d
}

func (d codexDialog) cursor() int {
	for _, r := range d.rows {
		if r.cursor {
			return r.n
		}
	}
	return 0
}

// optionsShown reports whether a dialog's numbered rows are the question's
// options: every option row it shows (a short screen may scroll some off)
// has that option's label, and it shows one at least.
func optionsShown(rows []dialogRow, opts []proto.AskOption) bool {
	seen := 0
	for _, r := range rows {
		if r.n < 1 || r.n > len(opts) {
			continue
		}
		if !labelIs(r.label, opts[r.n-1].Label) {
			return false
		}
		seen++
	}
	return seen > 0
}

// headerIs reports whether a tab shows a question's header: the same
// words, or a cut one ("Observabil…") its start. A header the call left
// empty is not checked.
func headerIs(tab, header string) bool {
	a, b := collapse(tab), collapse(header)
	if b == "" || a == b {
		return true
	}
	cut, ok := strings.CutSuffix(a, "…")
	return ok && cut != "" && strings.HasPrefix(b, cut)
}

// showsQuestion reports whether a Claude dialog shows question q (not the
// review): its text and its options.
func (d claudeDialog) showsQuestion(q proto.AskQuestion) bool {
	return d.ok && !d.review && sameQuestion(d.question, q.Question) && optionsShown(d.rows, q.Options)
}

// showsAsk reports whether a Claude dialog is ask's: one of its questions,
// or its review with a tab per question header and each question listed,
// in order (a review cut too short to tell, or one listing fewer, is not).
func (d claudeDialog) showsAsk(ask *proto.Ask) bool {
	if !d.ok {
		return false
	}
	if !d.review {
		return slices.ContainsFunc(ask.Questions, d.showsQuestion)
	}
	tabs := d.tabs
	if n := len(tabs); n == len(ask.Questions)+1 && tabs[n-1] == "Submit" {
		tabs = tabs[:n-1]
	}
	if len(tabs) != len(ask.Questions) || len(d.reviewed) != len(ask.Questions) {
		return false
	}
	for i, t := range tabs {
		if !headerIs(t, ask.Questions[i].Header) || !sameQuestion(d.reviewed[i], ask.Questions[i].Question) {
			return false
		}
	}
	return true
}

// showsQuestion reports whether Codex's overlay shows question i (0-based)
// of an ask of n questions: its place, its text and its options.
func (d codexDialog) showsQuestion(i, n int, q proto.AskQuestion) bool {
	return d.ok && d.index == i+1 && d.count == n && sameQuestion(d.question, q.Question) && optionsShown(d.rows, q.Options)
}

// showsAsk reports whether Codex's overlay is on one of ask's questions.
func (d codexDialog) showsAsk(ask *proto.Ask) bool {
	i := d.index - 1
	return i >= 0 && i < len(ask.Questions) && d.showsQuestion(i, len(ask.Questions), ask.Questions[i])
}
