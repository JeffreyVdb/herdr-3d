package notify

// H3D-1 (Kaneo): what a needs-you episode is, and the Questions only mode.
//
// An episode is named by what it is about, not by when the worker's status
// last changed: an ask by its tool_use_id, a follow-up by its turn, a
// report request by its text, a wrap-up by when it was armed, an
// orchestrator over its review-pass cap by its pass, a bare blocked status
// by its blocked spell (its status_since), done by when it started. So the
// same unresolved question, seen again with a new status_since, a new
// activity line or a redraw, does not notify again, in either mode. A
// screen menu is named by the decision it asks for (Menu.Decision: its
// operation without its blocked spell) and the native call it is for, a
// call known later adopted, another one a new decision (menuEpisode). An
// episode its worker still shows is never forgotten (tracker.know).
//
// A question waits (parked by the cooldown or the send budget, queued,
// paced by the destination, between two attempts, between two of its
// cards); what it may be and how is decided at the last moment, after
// every wait, right before each send (goes): switched off, its event off
// or the channel not ready, it is dropped; replies or the mode changed, it
// goes back to the loop (handBack) and goes as they say now (its cards,
// its text, or the broader mode's alert). A card set stopped after its
// first card (it rang: the question went) ends there: switched off, the
// rest is not sent; replies off, the rest goes as one text (From); the
// mode changed, the rest of the set goes on, quiet as it was.
//
// Under Questions only, a worker notifies only for a question you can
// answer: an ask, a follow-up, a permission or folder-trust menu its screen
// shows (named by the decision it asks for: its operation without its
// blocked spell, and its native call), or a report request whose
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
// (questions: that mode). menu is its screen menu's episode id ("": no
// valid menu; menuEpisode's). A screen menu is an episode of its own under
// Questions only, and in the broader mode for a worker whose needs-you is
// not its blocked status (a report request, a cap, a wrap-up: else its
// menu's card would wait for an alert that never comes); a bare block's
// menu stays in its blocked spell's episode (#88: its card follows the
// spell's alert).
func episode(w Worker, v Verdict, questions bool, menu string) (id, about string, question bool) {
	switch {
	case v.Reason == ReasonQuestion:
		return "ask|" + w.Ask.ToolUseID, aboutAsk, true
	case v.Reason == ReasonFollowup:
		return "followup|" + w.Followup.TurnID, aboutFollowup, true
	}
	id, about, question = needs(w, v, questions)
	if menu != "" && (questions || about != aboutBlocked) {
		return menu, aboutMenu, true
	}
	return id, about, question
}

// needs is episode's for a worker that asks no ask or follow-up, its menu
// aside.
func needs(w Worker, v Verdict, questions bool) (id, about string, question bool) {
	switch {
	case isFreelancer(v.Role) && reportAsks(w.Report) && (questions || v.Reason == ReasonReport):
		return reportID(w.Report), aboutReport, strings.TrimSpace(w.Report.Request) != ""
	case v.Reason == ReasonWrapUp:
		return wrapUpID(w), aboutWrapUp, false
	case v.Role == "orch" && overCap(w):
		return crewID(w), aboutCrew, false
	}
	return "blocked|" + strconv.FormatInt(v.Since, 10), aboutBlocked, false
}

// wrapUpID is a wrap-up's episode id: when it was armed.
func wrapUpID(w Worker) string { return "wrapup|" + strconv.FormatInt(w.WrapUpArmedAt, 10) }

// crewID is an orchestrator over its review-pass cap's episode id: its
// pass.
func crewID(w Worker) string {
	pass := "over"
	if w.Pass != nil {
		pass = strconv.Itoa(*w.Pass)
	}
	return "crew|" + pass
}

// live is every needs-you episode worker w (awake, its verdict v) shows
// now, besides the one it is in (key's): what it asks, its report request,
// its stuck wrap-up, its cap, its menu (menu's id). The tracker never
// forgets a live one (H3D-1: a request still shown under many menus stays
// known).
func live(w Worker, v Verdict, menu string) []string {
	var ids []string
	if validAsk(w.Ask) {
		ids = append(ids, "ask|"+w.Ask.ToolUseID)
	}
	if validFollowup(w.Followup) {
		ids = append(ids, "followup|"+w.Followup.TurnID)
	}
	if isFreelancer(v.Role) && reportAsks(w.Report) {
		ids = append(ids, reportID(w.Report))
	}
	if w.WrapUpState == "needs_you" {
		ids = append(ids, wrapUpID(w))
	}
	if v.Role == "orch" && overCap(w) {
		ids = append(ids, crewID(w))
	}
	if menu != "" {
		ids = append(ids, menu)
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = episodeKey(KindNeedsYou, id)
	}
	return keys
}

// menuDecision names the decision a menu asks for across blocked spells
// (H3D-1): its Decision, else its operation (menuID).
func menuDecision(m *Menu) string {
	if m.Decision != "" {
		return m.Decision
	}
	return menuID(m)
}

// menuEp is a menu episode of a decision as the loop knows it (H3D-1):
// the native call it is for ("": none known yet), its id.
type menuEp struct{ native, id string }

// menuEpisode is worker id's menu m's episode id (the loop's): its
// decision and the native call it was first known for. The same decision
// seen again (another status_since, a redraw, a working spell between,
// other menus between) is the same episode; a native call known later is
// adopted (the same id: one prompt rings once); another native call than
// the one known replaces it (#106 row 4: a new decision, a new id). A
// worker's decisions are kept while the tracker holds their episode (its
// latest known, those it shows), so the bound is the tracker's.
func (s *Service) menuEpisode(id string, m *Menu) string {
	d := menuDecision(m)
	eps := s.menuEps[id]
	if eps == nil {
		eps = map[string]menuEp{}
		s.menuEps[id] = eps
	}
	e, ok := eps[d]
	switch {
	case !ok || (e.native != "" && m.Native != "" && m.Native != e.native):
		e = menuEp{native: m.Native, id: "menu|" + d + "|" + m.Native}
	case e.native == "":
		e.native = m.Native
	}
	eps[d] = e
	for x, o := range eps {
		if x != d && !s.tr.holds(id, episodeKey(KindNeedsYou, o.id)) {
			delete(eps, x)
		}
	}
	return e.id
}

// form is alert a as it goes under the settings now (H3D-1): a question
// (Asks) under Questions only is the message, as its cards (Ring) while it
// can have them, else as its text (Body); anything else is an alert. The
// rest of a stopped card set (From) is its text in either mode. Wherever
// a question waited it is formed again (goes), so replies or the mode
// changed meanwhile hold.
func (s *Service) form(a Alert) Alert {
	a.Question, a.Ring, a.Body = a.Asks && (s.questionsOnly() || a.From > 0), false, ""
	if a.Question {
		if s.cardable(a) {
			a.Ring = true
		} else {
			on, _ := s.listening()
			a.Body = questionText(a, on)
		}
	}
	return a
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
// on, and cards it can have (the rest of a stopped set has none).
func (s *Service) cardable(a Alert) bool {
	if on, _ := s.listening(); !on || a.From > 0 {
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
// under its head (Notification.Text): the questions with their options
// (from a.From on, numbered in the whole set), then where to answer it
// (replies: on). A secret ask's says only that a question waits.
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
		for i := min(a.From, n); i < n; i++ {
			q := a.Ask.Questions[i]
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
		for i := min(a.From, n); i < n; i++ {
			q := a.Followup.Questions[i]
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
