package notify

// H3D-1 (Kaneo): what a needs-you episode is, and the Questions only mode.
//
// An episode is named by what it is about, not by when the worker's status
// last changed: an ask by its tool_use_id, a follow-up by its turn, a
// report request by its text, a wrap-up by when it was armed, an
// orchestrator over its review-pass cap by its pass, a bare blocked status
// by its blocked spell (its status_since), done by when it started. So the
// same unresolved question, seen again with a new status_since, a new
// activity line or a redraw, does not notify again, in either mode.
//
// Under Questions only, a worker notifies only for a question you can
// answer: an ask, a follow-up, a permission or folder-trust menu its screen
// shows (named by its operation, as its card is), or a report request whose
// text the message shows. The question is the message: with replies on,
// its cards (the first rings); else its text, ending in where to answer it.
// No alert goes before it; done, wrap-up, review-pass-cap and bare blocked
// episodes send nothing.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"strings"
)

// Modes of the notifications (Settings.Mode).
const (
	// ModeEverything: every needs-you episode notifies, done with its
	// switch (the default, and what a setting saved before H3D-1 is).
	ModeEverything = "everything"
	// ModeQuestions: only a worker's pending question notifies.
	ModeQuestions = "questions"
)

// What an episode is about (the notify.send row's about).
const (
	aboutAsk      = "ask"
	aboutFollowup = "followup"
	aboutMenu     = "menu"
	aboutReport   = "report"
	aboutWrapUp   = "wrapup"
	aboutCrew     = "review_cap"
	aboutBlocked  = "blocked"
	aboutDone     = "done"
)

// How a notify.send row's message went (sendAudit.Via; "": an alert).
const (
	viaCards    = "cards"    // its cards were the message
	viaQuestion = "question" // the message was the question's text
)

// What a question's own message ends with: where to answer it.
const (
	// QuestionReplyText: with replies on (a question with no cards: a
	// report request, a follow-up of more than MaxCards questions).
	QuestionReplyText = "Answer it in the game, or reply to this message: your reply is typed into the worker."
	// QuestionSecretText is all a secret ask's message says of it.
	QuestionSecretText = "A question waits in the game (its answer is secret)."
	// reportMax is the most runes of a report request a message keeps.
	reportMax = 1500
)

// episode is what a needs-you sighting's episode is (its id, without the
// kind) and what it is about, from the worker awake and the rule's
// verdict of it; question: a pending question Questions only lets through
// (questions: that mode).
func episode(w Worker, v Verdict, questions bool) (id, about string, question bool) {
	switch {
	case v.Reason == ReasonQuestion:
		return "ask|" + w.Ask.ToolUseID, aboutAsk, true
	case v.Reason == ReasonFollowup:
		return "followup|" + w.Followup.TurnID, aboutFollowup, true
	case questions && validMenu(w):
		return "menu|" + menuID(w.Menu), aboutMenu, true
	case isFreelancer(v.Role) && reportAsks(w.Report) && (questions || v.Reason == ReasonReport):
		return reportID(w.Report), aboutReport, strings.TrimSpace(w.Report.Request) != ""
	case v.Reason == ReasonWrapUp:
		return "wrapup|" + strconv.FormatInt(w.WrapUpArmedAt, 10), aboutWrapUp, false
	case v.Role == "orch" && overCap(w):
		pass := "over"
		if w.Pass != nil {
			pass = strconv.Itoa(*w.Pass)
		}
		return "crew|" + pass, aboutCrew, false
	}
	return "blocked|" + strconv.FormatInt(v.Since, 10), aboutBlocked, false
}

// reportID is a report request's episode id: its text's (r.InputRequired
// set), so a request seen again under another status_since is the same.
func reportID(r *Report) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(*r.InputRequired)))
	return "report|" + hex.EncodeToString(sum[:8])
}

// head is what a message says why: the rule's reason, a menu's kind
// (Permission, Trust folder) for a Questions only menu.
func (a Alert) head() string {
	if a.Question && a.Menu != nil {
		if h := menuHeads[a.Menu.Kind]; h != "" {
			return h
		}
	}
	return a.Reason
}

// cardable reports whether a Questions only alert goes as its cards: replies
// on, and cards it can have.
func (s *Service) cardable(a Alert) bool {
	if on, _ := s.listening(); !on {
		return false
	}
	n := 0
	switch {
	case a.Ask != nil:
		n = len(a.Ask.Questions)
		if (Worker{Ask: a.Ask}).Secret() {
			n = 1
		}
	case a.Followup != nil:
		n = len(a.Followup.Questions)
	case a.Menu != nil:
		n = 1
	}
	return n > 0 && n <= MaxCards
}

// questionText is a Questions only alert's question as its message's text,
// under its head (Notification.Text): the questions with their options,
// then where to answer it (replies: on). A secret ask's says only that a
// question waits.
func questionText(a Alert, replies bool) string {
	end := CardOffText
	if replies {
		end = QuestionReplyText
	}
	var parts []string
	switch {
	case a.Ask != nil && (Worker{Ask: a.Ask}).Secret():
		return QuestionSecretText
	case a.Ask != nil:
		n := len(a.Ask.Questions)
		for i, q := range a.Ask.Questions {
			var b strings.Builder
			label := OneLine(q.Header, cardLabelMax)
			if n > 1 {
				label = strings.TrimSuffix(fmt.Sprintf("%d of %d · %s", i+1, n, label), " · ")
			}
			if label != "" {
				b.WriteString(label + "\n")
			}
			b.WriteString(clipRunes(strings.TrimSpace(q.Question), cardQuestionMax))
			for o, opt := range q.Options {
				fmt.Fprintf(&b, "\n%d. %s", o+1, OneLine(opt.Label, cardLabelMax))
				if d := OneLine(opt.Description, cardDescMax); d != "" {
					b.WriteString(": " + d)
				}
			}
			if q.Multi {
				b.WriteString("\nOne or more.")
			}
			parts = append(parts, b.String())
		}
	case a.Followup != nil:
		n := len(a.Followup.Questions)
		for i, q := range a.Followup.Questions {
			var b strings.Builder
			if n > 1 {
				fmt.Fprintf(&b, "%d of %d\n", i+1, n)
			}
			if q.Label != "" {
				b.WriteString(OneLine(q.Label, cardLabelMax) + " ")
			}
			b.WriteString(clipRunes(strings.TrimSpace(q.Question), cardQuestionMax))
			if c := clipRunes(strings.TrimSpace(q.Context), cardContextMax); c != "" {
				b.WriteString("\n" + c)
			}
			if t := clipRunes(strings.TrimSpace(a.Followup.Tail), cardTailMax); t != "" && n == 1 && q.Kind == "open" {
				b.WriteString("\n" + t)
			}
			switch q.Kind {
			case "yes_no":
				b.WriteString("\nYes or no.")
			case "choice":
				for o, c := range q.Choices {
					fmt.Fprintf(&b, "\n%d. %s", o+1, OneLine(c, cardLabelMax))
				}
			}
			if r := OneLine(q.Recommendation, cardRecMax); r != "" {
				b.WriteString("\nRecommended: " + r)
			}
			parts = append(parts, b.String())
		}
	case a.Menu != nil:
		var b strings.Builder
		b.WriteString(menuAsks[a.Menu.Kind])
		if len(a.Menu.About) > 0 {
			b.WriteString("\n" + strings.Join(a.Menu.About, "\n"))
		} else {
			b.WriteString("\n" + CardMenuAboutText)
		}
		for _, c := range a.Menu.Choices {
			fmt.Fprintf(&b, "\n%d. %s", c.N, OneLine(c.Label, cardLabelMax))
		}
		parts = append(parts, b.String())
	default:
		parts = append(parts, clipRunes(a.Report, reportMax))
	}
	head := a.Name + " · " + a.head() + "\n"
	room := max(CardTextMax-len16(head)-len16("\n\n"+end), 200)
	return clip16(strings.Join(parts, "\n\n"), room) + "\n\n" + end
}
